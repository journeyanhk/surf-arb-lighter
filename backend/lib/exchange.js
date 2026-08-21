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

async function fetchJson(url, { proxyUrl, timeoutMs = 10000 } = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const opts = { signal: ctrl.signal }
    if (proxyUrl) {
      if (IS_BUN) opts.proxy = proxyUrl
      else opts.dispatcher = dispatcherFor(proxyUrl)
    }
    const r = await fetch(url, opts)
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`)
    return await r.json()
  } finally {
    clearTimeout(t)
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
const TOB_TTL = 4000

async function topOfBook(baseUrl, marketId, proxyUrl) {
  const key = `${baseUrl}#${marketId}`
  const hit = tobCache.get(key)
  if (hit && Date.now() - hit.at < TOB_TTL) return hit.val
  const j = await fetchJson(
    `${baseUrl}/api/v1/orderBookOrders?market_id=${marketId}&limit=1`,
    { proxyUrl }
  )
  const asks = (j.asks || [])
    .map((a) => parseFloat(a.price))
    .filter((n) => Number.isFinite(n))
  const bids = (j.bids || [])
    .map((b) => parseFloat(b.price))
    .filter((n) => Number.isFinite(n))
  if (!asks.length || !bids.length) return null
  const val = { bestAsk: Math.min(...asks), bestBid: Math.max(...bids) }
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
        }
      : {
          direction: 'buy_rblighter',
          spread_bps: buyRblighter,
          buy_venue: 'RBLighter',
          sell_venue: 'Lighter',
          buy_price: rblighter.bestAsk,
          sell_price: lighter.bestBid,
        }
  return { buyLighter, buyRblighter, best }
}

module.exports = { fetchJson, listOrderBooks, topOfBook, computeSpread }
