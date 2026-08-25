// Multi-venue market-data adapters for the cross-exchange monitor.
//
// Each adapter turns ONE venue's public API into a uniform snapshot:
//   Map(SYMBOL_UPPER -> { funding, bid, ask, mark, market_id })
//     funding : hourly funding rate as a decimal fraction (0.0001 = 1bp/hr).
//               +funding => longs pay shorts (short side EARNS).
//     bid/ask : best bid / best ask price (null if the venue has no cheap ticker).
//     mark    : mark/last price, used for cross-venue price-basis when a real
//               top-of-book isn't cheaply available.
//
// Design goal: adding a new DEX = adding ONE adapter here. The opportunity
// engine, routes, filters and alerts all work off this uniform shape, so they
// need zero changes when the venue list grows.
//
// Rate-limit posture: every adapter makes at most a couple of whole-market calls
// per refresh (never per-symbol), so N venues stay well under any 429 ceiling.

const { fetchJson } = require('./exchange')

// Fetch public market data with proxy-then-direct resilience. On the VPS the
// proxy is needed for geo access; in other environments (or when the proxy is
// slow/broken) the DIRECT call still works because this data is fully public.
// So we try the proxy first, and on ANY failure fall back to a direct call.
async function fetchPublic(url, proxyUrl, opts = {}) {
  const merged = { retries: 4, timeoutMs: 15000, ...opts }
  if (!proxyUrl) return fetchJson(url, merged)
  try {
    // Proxy attempt fails FAST (1 try, short timeout) so a slow/broken proxy
    // doesn't stall the whole refresh — we drop to direct almost immediately.
    return await fetchJson(url, { ...merged, proxyUrl, retries: 1, timeoutMs: 8000 })
  } catch (e) {
    return fetchJson(url, merged) // direct fallback, full retries
  }
}

// Normalize a venue's symbol into a common key so the same asset lines up across
// exchanges. Extended uses "ENA-USD"/"BTC-USD"; Lighter uses bare "ENA"/"BTC".
// We strip a trailing -USD/-USDC/-PERP quote and uppercase.
function normSymbol(raw) {
  let s = String(raw || '').toUpperCase().trim()
  s = s.replace(/[-_/](USDC|USDT|USD|PERP)$/i, '')
  return s
}

const num = (x) => {
  const n = Number(x)
  return Number.isFinite(n) ? n : null
}

// ---- Lighter-family adapter (Lighter + RBLighter share the same API shape) ----
// Two whole-market calls: funding-rates (funding, one row per symbol) +
// orderBookDetails (mark/last price). Merge on symbol. No per-symbol requests.
async function lighterFamilySnapshot(baseUrl, proxyUrl) {
  const [frRes, bookRes] = await Promise.allSettled([
    fetchPublic(`${baseUrl}/api/v1/funding-rates`, proxyUrl, { retries: 6 }),
    fetchPublic(`${baseUrl}/api/v1/orderBookDetails`, proxyUrl, { retries: 4 }),
  ])
  const out = new Map()
  // Funding: the aggregated list spans several exchanges keyed by symbol; keep
  // only THIS venue's native rows (exchange == 'lighter').
  if (frRes.status === 'fulfilled') {
    for (const f of frRes.value.funding_rates || []) {
      if (String(f.exchange || '').toLowerCase() !== 'lighter') continue
      const rate = num(f.rate)
      if (rate == null) continue
      const key = normSymbol(f.symbol)
      out.set(key, { funding: rate, bid: null, ask: null, mark: null, market_id: f.market_id })
    }
  }
  // Prices: mark/last per perp market. Merge into existing rows (or create).
  if (bookRes.status === 'fulfilled') {
    for (const d of bookRes.value.order_book_details || []) {
      if (d.market_type !== 'perp' || d.status !== 'active') continue
      const key = normSymbol(d.symbol)
      const mark = num(d.mark_price) ?? num(d.last_trade_price)
      const prev = out.get(key) || { funding: null, bid: null, ask: null, mark: null, market_id: d.market_id }
      prev.mark = mark
      if (prev.market_id == null) prev.market_id = d.market_id
      out.set(key, prev)
    }
  }
  if (frRes.status === 'rejected' && bookRes.status === 'rejected') {
    throw new Error(String(frRes.reason?.message || frRes.reason))
  }
  return out
}

// ---- Extended adapter ----
// ONE call to /api/v1/info/markets returns funding + bid/ask + mark for every
// market. Cleanest of all — no rate-limit worries.
async function extendedSnapshot(baseUrl, proxyUrl) {
  const j = await fetchPublic(`${baseUrl}/api/v1/info/markets`, proxyUrl, { retries: 4 })
  const out = new Map()
  for (const m of j.data || []) {
    if (m.type !== 'PERPETUAL' || m.status !== 'ACTIVE') continue
    const st = m.marketStats || {}
    const key = normSymbol(m.name)
    out.set(key, {
      funding: num(st.fundingRate),
      bid: num(st.bidPrice),
      ask: num(st.askPrice),
      mark: num(st.markPrice) ?? num(st.lastPrice),
      market_id: m.name,
    })
  }
  return out
}

// Registry: the single source of truth for "which venues exist". Each entry
// resolves its base URL from settings and knows how to snapshot itself.
// `enabledKey` (optional) lets a venue be toggled off via settings later.
const REGISTRY = [
  { id: 'lighter', name: 'Lighter', urlKey: 'lighter_base_url', snapshot: lighterFamilySnapshot },
  { id: 'rblighter', name: 'RBLighter', urlKey: 'rblighter_base_url', snapshot: lighterFamilySnapshot },
  { id: 'extended', name: 'Extended', urlKey: 'extended_base_url', snapshot: extendedSnapshot },
]

// Fetch every venue's snapshot in parallel. Returns:
//   { venues: [{id,name,ok,count,error}], byVenue: Map(id -> Map(SYMBOL->quote)), errors:[] }
async function snapshotAll(s) {
  const results = await Promise.allSettled(
    REGISTRY.map((v) => v.snapshot(s[v.urlKey], s.proxy_url))
  )
  const byVenue = new Map()
  const venues = []
  const errors = []
  results.forEach((r, i) => {
    const v = REGISTRY[i]
    if (r.status === 'fulfilled') {
      byVenue.set(v.id, r.value)
      venues.push({ id: v.id, name: v.name, ok: true, count: r.value.size })
    } else {
      const err = String(r.reason?.message || r.reason)
      venues.push({ id: v.id, name: v.name, ok: false, count: 0, error: err })
      errors.push(`${v.name}: ${err}`)
    }
  })
  return { venues, byVenue, errors }
}

module.exports = { REGISTRY, snapshotAll, normSymbol }
