const { Router } = require('express')
const { loadSettings } = require('./settings')
const { listOrderBooks } = require('../lib/exchange')

const router = Router()

// Cache the common-market intersection briefly to avoid hammering both venues.
let cache = { at: 0, data: null }

router.get('/', async (_req, res) => {
  try {
    if (cache.data && Date.now() - cache.at < 60_000) {
      return res.json(cache.data)
    }
    const s = await loadSettings()
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
      if (!rb) continue
      common.push({
        symbol: m.symbol,
        lighter_market_id: m.market_id,
        rblighter_market_id: rb.market_id,
      })
    }
    common.sort((a, b) => a.symbol.localeCompare(b.symbol))

    const data = { count: common.length, markets: common }
    cache = { at: Date.now(), data }
    res.json(data)
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

module.exports = router
