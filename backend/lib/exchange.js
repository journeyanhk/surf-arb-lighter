// Public order-book access for Lighter and RBLighter + spread math.
// Mirrors the original tool: read both books, compute the two executable
// directions, express spread in basis points. All requests can be routed
// through an optional proxy (configured in the settings panel).

const { ProxyAgent } = require('undici')

// Cache one ProxyAgent per proxy URL so we don't rebuild pools each request.
const agents = new Map()
function dispatcherFor(proxyUrl) {
  if (!proxyUrl) return undefined
  let a = agents.get(proxyUrl)
  if (!a) {
    a = new ProxyAgent(proxyUrl)
    agents.set(proxyUrl, a)
  }
  return a
}

// Bun's fetch ignores undici's `dispatcher` and uses a native `proxy` option;
// Node's fetch (undici) uses `dispatcher`. Support both.
const IS_BUN = typeof globalThis.Bun !== 'undefined'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Fetch JSON with backoff on rate limits / transient server errors. RBLighter
// (rh.lighter.xyz) rate-limits aggressively, so on HTTP 429/5xx we wait and
// retry a few times, honoring the `Retry-After` header when present, with
// exponential backoff + jitter. Only after exhausting retries do we throw.
async function fetchJson(url, { proxyUrl, timeoutMs = 10000, retries = 3 } = {}) {
  let attempt = 0
  for (;;) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const opts = { signal: ctrl.signal }
      if (proxyUrl) {
        if (IS_BUN) opts.proxy = proxyUrl
        else opts.dispatcher = dispatcherFor(proxyUrl)
      }
      const r = await fetch(url, opts)
      if (r.status === 429 || r.status >= 500) {
        if (attempt >= retries) throw new Error(`HTTP ${r.status} for ${url}`)
        const ra = parseInt(r.headers.get('retry-after') || '', 10)
        const backoff = Number.isFinite(ra)
          ? ra * 1000
          : Math.min(500 * 2 ** attempt, 8000) + Math.floor(Math.random() * 400)
        attempt++
        clearTimeout(t)
        await sleep(backoff)
        continue
      }
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`)
      return await r.json()
    } catch (e) {
      // Network/abort errors: retry with backoff too, then give up.
      const retriable = e.name === 'AbortError' || /fetch failed|network|ECONN|ETIMEDOUT/i.test(String(e.message || e))
      if (retriable && attempt < retries) {
        attempt++
        clearTimeout(t)
        await sleep(Math.min(500 * 2 ** attempt, 8000) + Math.floor(Math.random() * 400))
        continue
      }
      throw e
    } finally {
      clearTimeout(t)
    }
  }
}

async function listOrderBooks(baseUrl, proxyUrl) {
  const j = await fetchJson(`${baseUrl}/api/v1/orderBooks`, { proxyUrl })
  return (j.order_books || []).map((o) => ({
    symbol: o.symbol,
    market_id: o.market_id,
    market_type: o.market_type,
    status: o.status,
  }))
}

// Best bid (highest) / best ask (lowest) for one market, with a short cache
// so repeated scan ticks don't hammer the venue and trip HTTP 429.
const tobCache = new Map()
const TOB_TTL = 6000
// Aggregate resting base within this many bps of the top of book, so we know
// how much size an IOC taker can actually fill near the touch (depth guard).
const DEPTH_BAND_BPS = 10

async function topOfBook(baseUrl, marketId, proxyUrl) {
  const key = `${baseUrl}#${marketId}`
  const hit = tobCache.get(key)
  if (hit && Date.now() - hit.at < TOB_TTL) return hit.val
  const j = await fetchJson(
    `${baseUrl}/api/v1/orderBookOrders?market_id=${marketId}&limit=50`,
    { proxyUrl }
  )
  const asks = (j.asks || [])
    .map((a) => ({ price: parseFloat(a.price), base: parseFloat(a.remaining_base_amount) }))
    .filter((o) => Number.isFinite(o.price) && Number.isFinite(o.base))
  const bids = (j.bids || [])
    .map((b) => ({ price: parseFloat(b.price), base: parseFloat(b.remaining_base_amount) }))
    .filter((o) => Number.isFinite(o.price) && Number.isFinite(o.base))
  if (!asks.length || !bids.length) return null
  const bestAsk = Math.min(...asks.map((a) => a.price))
  const bestBid = Math.max(...bids.map((b) => b.price))
  // Depth a taker can sweep within DEPTH_BAND_BPS of the touch.
  const askCap = bestAsk * (1 + DEPTH_BAND_BPS / 10000)
  const bidFloor = bestBid * (1 - DEPTH_BAND_BPS / 10000)
  const askDepthBase = asks.filter((a) => a.price <= askCap).reduce((s, a) => s + a.base, 0)
  const bidDepthBase = bids.filter((b) => b.price >= bidFloor).reduce((s, b) => s + b.base, 0)
  const val = { bestAsk, bestBid, askDepthBase, bidDepthBase }
  tobCache.set(key, { at: Date.now(), val })
  return val
}

// Given both venues' top-of-book, compute the two executable spreads.
function computeSpread(lighter, rblighter) {
  // buy_lighter: buy on Lighter ask, sell on RBLighter bid
  const buyLighter = ((rblighter.bestBid - lighter.bestAsk) / lighter.bestAsk) * 10000
  // buy_rblighter: buy on RBLighter ask, sell on Lighter bid
  const buyRblighter = ((lighter.bestBid - rblighter.bestAsk) / rblighter.bestAsk) * 10000

  const best =
    buyLighter >= buyRblighter
      ? {
          direction: 'buy_lighter',
          spread_bps: buyLighter,
          buy_venue: 'Lighter',
          sell_venue: 'RBLighter',
          buy_price: lighter.bestAsk,
          sell_price: rblighter.bestBid,
          // depth the taker sweeps: buy leg hits Lighter asks, sell leg hits RB bids
          buy_depth_base: lighter.askDepthBase,
          sell_depth_base: rblighter.bidDepthBase,
        }
      : {
          direction: 'buy_rblighter',
          spread_bps: buyRblighter,
          buy_venue: 'RBLighter',
          sell_venue: 'Lighter',
          buy_price: rblighter.bestAsk,
          sell_price: lighter.bestBid,
          buy_depth_base: rblighter.askDepthBase,
          sell_depth_base: lighter.bidDepthBase,
        }
  return { buyLighter, buyRblighter, best }
}

module.exports = { fetchJson, listOrderBooks, topOfBook, computeSpread, fundingRates }

// Current funding rate per market for ONE venue. The /funding-rates endpoint on
// each base URL returns an aggregated list spanning several exchanges (binance/
// bybit/hyperliquid/lighter) keyed by the same symbol space, so we filter to the
// venue's own rows (exchange == 'lighter') to get THIS venue's native rate.
//   rate: decimal fraction PER 1-HOUR interval (0.0001 = 1bp). +rate => longs pay shorts.
// Returns Map(symbolUpper -> { rate, market_id }).
async function fundingRates(baseUrl, proxyUrl) {
  const j = await fetchJson(`${baseUrl}/api/v1/funding-rates`, { proxyUrl })
  const map = new Map()
  for (const f of j.funding_rates || []) {
    if (String(f.exchange || '').toLowerCase() !== 'lighter') continue
    const rate = Number(f.rate)
    if (!Number.isFinite(rate)) continue
    map.set(String(f.symbol || '').toUpperCase(), { rate, market_id: f.market_id })
  }
  return map
}
