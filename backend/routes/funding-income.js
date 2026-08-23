// Real accumulated funding income across delta-neutral funding-carry positions.
//
// PRIMARY SOURCE (source:'account'): the exchange account's OWN funding
// settlements, pulled through the signing sidecar (GET /api/v1/positionFunding).
// This is the exact data behind the venue's "funding CSV" export — real money
// credited/debited per hourly settlement — so it covers ALL history (including
// trades made before this feature existed) and needs no in-app bookkeeping.
//
// FALLBACK (source:'ledger'): when the sidecar isn't configured, we fall back to
// the engine-recorded ledger (arb_funding_ledger), which only accumulates
// forward from deploy time.
const { Router } = require('express')
const { dbQuery } = require('../db')
const { loadSettings } = require('./settings')
const sidecar = require('../lib/sidecar')

const router = Router()

router.get('/', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(180, Number(req.query.days) || 30))
    const startTs = Math.floor(Date.now() / 1000) - days * 86400

    // ---- Preferred: real per-account funding settlements via the sidecar ----
    if (sidecar.configured()) {
      const [lRows, rRows] = await Promise.all([
        sidecar.accountFunding('lighter', { start: startTs }).catch(() => null),
        sidecar.accountFunding('rblighter', { start: startTs }).catch(() => null),
      ])
      if (lRows || rRows) {
        const bySymbol = new Map() // sym -> { symbol, lighter, rblighter, total, count }
        const add = (venue, rows) => {
          for (const f of rows || []) {
            const sym = (f.symbol || `mkt${f.market_id}`).replace(/[-/].*$/, '').toUpperCase()
            const amt = Number(f.change) || 0
            let e = bySymbol.get(sym)
            if (!e) {
              e = { symbol: sym, lighter: 0, rblighter: 0, total: 0, count: 0 }
              bySymbol.set(sym, e)
            }
            e[venue] += amt
            e.total += amt
            e.count += 1
          }
        }
        add('lighter', lRows)
        add('rblighter', rRows)

        const symbols = [...bySymbol.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
        const total = symbols.reduce((a, s) => a + s.total, 0)
        const lTotal = (lRows || []).reduce((a, f) => a + (Number(f.change) || 0), 0)
        const rTotal = (rRows || []).reduce((a, f) => a + (Number(f.change) || 0), 0)
        const settlements = (lRows?.length || 0) + (rRows?.length || 0)

        // Most recent settlements across both venues for a live feed.
        const recent = [...(lRows || []).map((f) => ({ ...f, venue: 'Lighter' })),
                        ...(rRows || []).map((f) => ({ ...f, venue: 'RBLighter' }))]
          .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
          .slice(0, 40)
          .map((f) => ({
            timestamp: f.timestamp,
            venue: f.venue,
            symbol: (f.symbol || `mkt${f.market_id}`).replace(/[-/].*$/, '').toUpperCase(),
            change: Number(f.change) || 0,
            side: f.position_side || null,
          }))

        return res.json({
          source: 'account',
          days,
          grand_total_usd: total,
          lighter_total_usd: lTotal,
          rblighter_total_usd: rTotal,
          settlements,
          by_symbol: symbols,
          recent,
          venue_errors: [
            lRows == null ? 'Lighter 资金费读取失败（边车未就绪或超时）' : null,
            rRows == null ? 'RBLighter 资金费读取失败（边车未就绪或超时）' : null,
          ].filter(Boolean),
        })
      }
      // both null -> fall through to ledger
    }

    // ---- Fallback: engine-recorded ledger (forward-only) ----
    const { rows: positions } = await dbQuery(
      `SELECT
         l.task_id, l.symbol, t.state, t.buy_venue, t.sell_venue,
         count(*)::int       AS settlements,
         sum(l.amount_usd)   AS total_usd,
         avg(l.net_bps_hr)   AS avg_bps_hr,
         max(l.notional_usd) AS notional_usd
       FROM arb_funding_ledger l
       JOIN arb_tasks t ON t.id = l.task_id
       GROUP BY l.task_id, l.symbol, t.state, t.buy_venue, t.sell_venue
       ORDER BY max(l.settled_hour) DESC`
    )
    const openStates = new Set(['ENTERING', 'RECONCILING', 'HOLDING', 'EXITING', 'PAUSED'])
    let grand = 0, openTotal = 0, closedTotal = 0, settlements = 0
    for (const p of positions) {
      const amt = Number(p.total_usd) || 0
      grand += amt
      settlements += Number(p.settlements) || 0
      if (openStates.has(p.state)) openTotal += amt
      else closedTotal += amt
    }
    res.json({
      source: 'ledger',
      grand_total_usd: grand,
      open_total_usd: openTotal,
      closed_total_usd: closedTotal,
      settlements,
      positions: positions.map((p) => ({
        task_id: p.task_id,
        symbol: p.symbol,
        state: p.state,
        is_open: openStates.has(p.state),
        short_venue: p.sell_venue,
        long_venue: p.buy_venue,
        settlements: Number(p.settlements) || 0,
        total_usd: Number(p.total_usd) || 0,
        avg_bps_hr: Number(p.avg_bps_hr) || 0,
        notional_usd: Number(p.notional_usd) || 0,
      })),
    })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

module.exports = router
