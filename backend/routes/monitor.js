const { Router } = require('express')
const { dbQuery } = require('../db')
const { getSnapshot, getHealth } = require('../lib/runner')
const { fundingRates } = require('../lib/exchange')
const { loadSettings } = require('./settings')

const router = Router()

// Returns the latest snapshot produced by the background runner. If the runner
// hasn't produced one yet (or it's stale because background sampling is off and
// this is the only driver), getSnapshot runs a single inline tick.
router.get('/scan', async (_req, res) => {
  try {
    const snap = await getSnapshot()
    if (!snap) return res.json({ rows: [], updated_at: null, warming_up: true })
    res.json(snap)
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

router.get('/health', (_req, res) => {
  try {
    res.json(getHealth())
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

router.get('/signals', async (_req, res) => {
  try {
    const { rows } = await dbQuery(
      `SELECT * FROM arb_signals ORDER BY created_at DESC LIMIT 50`
    )
    res.json({ signals: rows })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

// Live-execution sidecar status: whether the Python signing service is
// configured and both venues are ready. Lets the panel confirm the wiring
// before enabling live trading.
router.get('/sidecar', async (_req, res) => {
  try {
    const sidecar = require('../lib/sidecar')
    if (!sidecar.configured()) {
      return res.json({ configured: false, note: '未配置执行边车（ARB_SIDECAR_TOKEN 未设置）—— 当前为纯模拟' })
    }
    const h = await sidecar.health()
    res.json({ configured: true, ...h })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

// Funding-rate carry monitor (VIEW ONLY — no orders). Reads each venue's own
// funding rate and reports the per-market differential = the delta-neutral carry
// you'd earn by SHORTING the higher-funding venue and LONGING the lower one.
// rate is a fraction per 1-hour interval (0.0001 = 1bp). Cached 30s: funding
// changes slowly, no need to hammer the venues.
let fundingCache = { at: 0, data: null }
router.get('/funding', async (_req, res) => {
  try {
    if (fundingCache.data && Date.now() - fundingCache.at < 30000) return res.json(fundingCache.data)
    const s = await loadSettings()
    const [lf, rf] = await Promise.all([
      fundingRates(s.lighter_base_url, s.proxy_url),
      fundingRates(s.rblighter_base_url, s.proxy_url),
    ])
    const rows = []
    for (const [sym, l] of lf) {
      const r = rf.get(sym)
      if (!r) continue // only symbols listed on BOTH venues are tradeable as a pair
      const lighter = l.rate
      const rblighter = r.rate
      const diffBpsHr = Math.abs(lighter - rblighter) * 10000 // hourly carry, bps
      // Earn funding: short the higher-rate leg (shorts receive), long the lower.
      const shortHigher = lighter > rblighter
      rows.push({
        symbol: sym,
        lighter_bps_hr: lighter * 10000,
        rblighter_bps_hr: rblighter * 10000,
        diff_bps_hr: diffBpsHr,
        short_venue: shortHigher ? 'Lighter' : 'RBLighter',
        long_venue: shortHigher ? 'RBLighter' : 'Lighter',
        daily_pct: (diffBpsHr / 100) * 24, // bps/hr -> %/day
        apr_pct: (diffBpsHr / 100) * 24 * 365, // -> %/year (simple, no compounding)
      })
    }
    rows.sort((a, b) => b.diff_bps_hr - a.diff_bps_hr)
    const payload = { rows, count: rows.length, interval_hours: 1, updated_at: new Date().toISOString() }
    fundingCache = { at: Date.now(), data: payload }
    res.json(payload)
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

module.exports = router
