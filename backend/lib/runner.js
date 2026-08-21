// Background runner — drives sampling + the task engine continuously inside the
// backend process, independent of whether any page is open. A single writer
// (overlap-guarded) so opening multiple tabs never multiplies load.

const { dbQuery } = require('../db')
const { loadSettings } = require('../routes/settings')
const { listOrderBooks, topOfBook, computeSpread } = require('./exchange')
const { stepEngine } = require('./engine')

const SCAN_INTERVAL_MS = 8000
const SCAN_LIMIT = 24 // fallback bounds if settings unavailable

let latest = null // last snapshot served to the UI
let running = false // overlap guard
let timer = null

// Background health, surfaced to the UI.
const health = {
  started_at: null,
  last_run_at: null,
  last_duration_ms: null,
  last_status: null, // 'ok' | 'error'
  last_error: null,
  ticks: 0,
  interval_sec: SCAN_INTERVAL_MS / 1000,
  scan_market_limit: SCAN_LIMIT,
  background_enabled: null,
}

async function pool(items, size, worker) {
  const out = []
  let idx = 0
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (idx < items.length) {
      const cur = idx++
      out[cur] = await worker(items[cur])
    }
  })
  await Promise.all(runners)
  return out
}

let marketCache = { at: 0, data: null }
async function commonMarkets(s) {
  if (marketCache.data && Date.now() - marketCache.at < 60_000) return marketCache.data
  const [lighter, rblighter] = await Promise.all([
    listOrderBooks(s.lighter_base_url, s.proxy_url),
    listOrderBooks(s.rblighter_base_url, s.proxy_url),
  ])
  const rbBySymbol = new Map()
  for (const m of rblighter) {
    if (m.market_type === 'perp' && m.status === 'active') rbBySymbol.set(m.symbol, m)
  }
  const common = []
  for (const m of lighter) {
    if (m.market_type !== 'perp' || m.status !== 'active') continue
    const rb = rbBySymbol.get(m.symbol)
    if (rb) common.push({ symbol: m.symbol, lighter_market_id: m.market_id, rblighter_market_id: rb.market_id })
  }
  common.sort((a, b) => a.symbol.localeCompare(b.symbol))
  marketCache = { at: Date.now(), data: common }
  return common
}

// One full scan: read books, record samples, gate signals, step the engine.
async function scanTick(preloaded) {
  if (running) return latest
  running = true
  const t0 = Date.now()
  try {
    const s = preloaded || (await loadSettings())
    const limit = Math.min(Math.max(parseInt(s.scan_market_limit, 10) || SCAN_LIMIT, 1), 40)
    const all = await commonMarkets(s)
    const markets = all.slice(0, limit)

    const rows = await pool(markets, 2, async (m) => {
      try {
        const [l, r] = await Promise.all([
          topOfBook(s.lighter_base_url, m.lighter_market_id, s.proxy_url),
          topOfBook(s.rblighter_base_url, m.rblighter_market_id, s.proxy_url),
        ])
        if (!l || !r) return { symbol: m.symbol, error: 'no book' }
        const { buyLighter, buyRblighter, best } = computeSpread(l, r)
        return {
          symbol: m.symbol,
          lighter_market_id: m.lighter_market_id,
          rblighter_market_id: m.rblighter_market_id,
          lighter_bid: l.bestBid,
          lighter_ask: l.bestAsk,
          rblighter_bid: r.bestBid,
          rblighter_ask: r.bestAsk,
          buy_lighter_bps: buyLighter,
          buy_rblighter_bps: buyRblighter,
          best,
        }
      } catch (e) {
        return { symbol: m.symbol, error: String(e.message || e) }
      }
    })

    const valid = rows.filter((x) => x && !x.error)

    if (valid.length) {
      const values = []
      const params = []
      let i = 1
      for (const v of valid) {
        values.push(`($${i++}, $${i++}, $${i++})`)
        params.push(v.symbol, v.best.direction, v.best.spread_bps)
      }
      await dbQuery(
        `INSERT INTO arb_spread_samples (symbol, direction, spread_bps) VALUES ${values.join(', ')}`,
        params
      )
      await dbQuery(`DELETE FROM arb_spread_samples WHERE created_at < now() - interval '10 minutes'`)
    }

    const net = (bps) => bps - (s.max_slippage_bps || 0)
    const opportunities = []
    for (const v of valid) {
      const { rows: cnt } = await dbQuery(
        `SELECT count(*)::int AS n FROM arb_spread_samples
         WHERE symbol = $1 AND direction = $2 AND created_at > now() - interval '10 minutes'`,
        [v.symbol, v.best.direction]
      )
      const samples = cnt[0]?.n || 0
      v.samples = samples
      v.net_bps = net(v.best.spread_bps)
      v.armed = samples >= s.min_samples
      v.signal = v.armed && v.net_bps >= s.spread_threshold_bps
      if (v.signal) {
        opportunities.push(v)
        await dbQuery(
          `INSERT INTO arb_signals (symbol, direction, spread_bps, buy_venue, sell_venue, buy_price, sell_price, samples, dry_run)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [v.symbol, v.best.direction, v.best.spread_bps, v.best.buy_venue, v.best.sell_venue, v.best.buy_price, v.best.sell_price, samples, s.dry_run]
        )
      }
    }

    valid.sort((a, b) => b.best.spread_bps - a.best.spread_bps)

    let engine = null
    try {
      engine = await stepEngine(valid, s)
    } catch (e) {
      engine = { error: String(e.message || e) }
    }

    latest = {
      scanned: markets.length,
      total_common: all.length,
      threshold_bps: s.spread_threshold_bps,
      min_samples: s.min_samples,
      max_slippage_bps: s.max_slippage_bps,
      dry_run: s.dry_run,
      auto_execute: s.auto_execute,
      focus_symbol: s.focus_symbol || '',
      max_concurrent_tasks: s.max_concurrent_tasks,
      background_enabled: s.background_enabled,
      scan_interval_sec: s.scan_interval_sec,
      scan_market_limit: limit,
      live_ready: !s.dry_run && s.live_trading_ack && s.poc_verified && s.enable_real_market_streams,
      opportunities_count: opportunities.length,
      engine,
      rows: valid,
      updated_at: new Date().toISOString(),
    }
    health.last_status = 'ok'
    health.last_error = null
    return latest
  } catch (e) {
    health.last_status = 'error'
    health.last_error = String(e.message || e)
    throw e
  } finally {
    running = false
    health.last_run_at = new Date().toISOString()
    health.last_duration_ms = Date.now() - t0
    health.ticks += 1
  }
}

function getLatest() {
  return latest
}

function getHealth() {
  const now = Date.now()
  return {
    ...health,
    uptime_sec: health.started_at ? Math.round((now - Date.parse(health.started_at)) / 1000) : 0,
    seconds_since_last_run:
      health.last_run_at != null ? Math.round((now - Date.parse(health.last_run_at)) / 1000) : null,
  }
}

// Serve the UI: return the cached snapshot; only run inline if it's missing or
// stale (e.g. background disabled but a page is open).
async function getSnapshot() {
  const staleMs = Date.now() - (latest ? Date.parse(latest.updated_at) : 0)
  if (!latest || staleMs > 20000) {
    try {
      await scanTick()
    } catch (e) {
      if (!latest) return { error: String(e.message || e) }
    }
  }
  return latest
}

function start() {
  if (timer) return
  health.started_at = new Date().toISOString()
  let stopped = false
  // Self-scheduling loop so the interval can change live from settings.
  const loop = async () => {
    let intervalMs = SCAN_INTERVAL_MS
    try {
      const s = await loadSettings()
      health.background_enabled = s.background_enabled
      health.interval_sec = s.scan_interval_sec
      health.scan_market_limit = s.scan_market_limit
      intervalMs = Math.min(Math.max(parseInt(s.scan_interval_sec, 10) || 8, 3), 3600) * 1000
      if (s.background_enabled) await scanTick(s)
    } catch (e) {
      console.error('[runner] tick failed:', e.message || e)
    } finally {
      if (!stopped) timer = setTimeout(loop, intervalMs)
    }
  }
  timer = setTimeout(loop, 2000)
  console.log('[runner] background sampler started')
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
  }
}

module.exports = { start, scanTick, getLatest, getSnapshot, getHealth }
