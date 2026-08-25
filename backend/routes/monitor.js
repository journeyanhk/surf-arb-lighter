const { Router } = require('express')
const { dbQuery } = require('../db')
const { getSnapshot, getHealth, commonMarkets } = require('../lib/runner')
const { getFundingMap, bestCarry, carryBpsHr } = require('../lib/funding')
const oppTracker = require('../lib/oppTracker')
const { sendServerChan } = require('../lib/alerts')
const { openFundingTask } = require('../lib/engine')
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
    const map = await getFundingMap(s)
    if (!map.bySymbol.size && map.errors.length) {
      return res.status(502).json({ error: map.errors.join(' | ') })
    }
    const enter = Number(s.funding_enter_bps_hr) || 0
    const exit = Number(s.funding_exit_bps_hr) || 0
    const wl = new Set(
      String(s.funding_symbols || '')
        .split(/[,\s]+/)
        .map((x) => x.trim().toUpperCase())
        .filter(Boolean)
    )
    const rows = []
    for (const [sym, pair] of map.bySymbol) {
      const bc = bestCarry(pair)
      if (!bc) continue
      rows.push({
        symbol: sym,
        lighter_bps_hr: bc.lighter_bps_hr,
        rblighter_bps_hr: bc.rblighter_bps_hr,
        diff_bps_hr: bc.diff_bps_hr,
        short_venue: bc.short_venue,
        long_venue: bc.long_venue,
        daily_pct: (bc.diff_bps_hr / 100) * 24,
        apr_pct: (bc.diff_bps_hr / 100) * 24 * 365,
        in_whitelist: wl.size ? wl.has(sym) : true,
        tradeable: bc.diff_bps_hr >= enter && (!wl.size || wl.has(sym)),
      })
    }
    rows.sort((a, b) => b.diff_bps_hr - a.diff_bps_hr)
    const payload = {
      rows,
      count: rows.length,
      interval_hours: 1,
      enter_bps_hr: enter,
      exit_bps_hr: exit,
      funding_auto_execute: !!s.funding_auto_execute,
      venue_errors: map.errors,
      venue_warnings: map.warnings || [],
      updated_at: new Date().toISOString(),
    }
    fundingCache = { at: Date.now(), data: payload }
    res.json(payload)
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

// Manually open ONE funding-carry position for a symbol (view -> act button).
// Determines short/long venue from the CURRENT rates, then hedges. Honors the
// same dry-run / live gating as every other order path.
router.post('/funding/open', async (req, res) => {
  try {
    const symbol = String(req.body?.symbol || '').trim().toUpperCase()
    if (!symbol) return res.status(400).json({ error: '缺少 symbol' })
    const s = await loadSettings()
    // Guard: one active funding position per symbol.
    const { rows: ex } = await dbQuery(
      `SELECT id FROM arb_tasks WHERE symbol=$1 AND strategy='funding'
       AND state IN ('ENTERING','RECONCILING','HOLDING','EXITING','PAUSED') LIMIT 1`,
      [symbol]
    )
    if (ex.length) return res.status(409).json({ error: `${symbol} 已有进行中的资金费仓位` })
    const map = await getFundingMap(s)
    const pair = map.bySymbol.get(symbol)
    if (!pair) return res.status(404).json({ error: `${symbol} 未在两所同时上架，无法配对` })
    const common = await commonMarkets(s)
    const ids = common.find((m) => String(m.symbol).toUpperCase() === symbol)
    if (!ids) return res.status(404).json({ error: `找不到 ${symbol} 的市场索引` })
    const r = await openFundingTask(symbol, s, pair, ids)
    if (!r.ok) return res.status(400).json(r)
    fundingCache = { at: 0, data: null } // let the panel reflect the new position promptly
    res.json(r)
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

module.exports = router

// ---- Cross-venue opportunity monitor (Lighter / RBLighter / Extended / …) ----
// Serves the background tracker's latest snapshot: every symbol on >= 2 venues,
// its best funding-carry (short highest-funding venue, long lowest) ranked by
// APR, plus max price-basis, plus how long the edge has persisted. Read-only.
router.get('/opportunities', async (_req, res) => {
  try {
    let snap = oppTracker.getLatest()
    if (!snap) {
      // Cold start (runner hasn't sampled yet): do one inline refresh.
      const s = await loadSettings()
      snap = await oppTracker.refresh(s)
    }
    if (!snap) {
      return res.status(503).json({ error: oppTracker.getError() || '监控尚未就绪，请稍候' })
    }
    res.json(snap)
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

// Send a test Server酱 push using the saved SendKey (or one passed in the body),
// so the user can confirm alerts are wired up before relying on them.
router.post('/alert-test', async (req, res) => {
  try {
    const s = await loadSettings()
    const key = (req.body && req.body.sendkey) || s.serverchan_sendkey
    if (!key) return res.status(400).json({ error: '未填写 Server酱 SendKey，请先在设置里保存' })
    const r = await sendServerChan(
      key,
      '✅ 跨所监控告警测试',
      '这是一条测试推送。如果你收到了它，说明 Server酱告警已接通。\n\n> 之后当有币种的资金费差年化与持续时长同时达标时，你会自动收到通知。'
    )
    res.json({ ok: true, ...r })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})
