const { Router } = require('express')
const { dbQuery } = require('../db')
const { getSnapshot, getHealth } = require('../lib/runner')

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

module.exports = router
