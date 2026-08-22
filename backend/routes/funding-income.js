// Real accumulated funding income across delta-neutral funding-carry positions.
// The engine writes one ledger row per position per hourly settlement (see
// arb_funding_ledger). This route aggregates that ledger so the UI can show a
// true running tally instead of only the midpoint estimate — no per-account auth
// needed, and consistent with the live carry the funding panel already displays.
const { Router } = require('express')
const { dbQuery } = require('../db')

const router = Router()

router.get('/', async (_req, res) => {
  try {
    // Per-position rollup joined to the task so we can show symbol, venues, state.
    const { rows: positions } = await dbQuery(
      `SELECT
         l.task_id,
         l.symbol,
         t.state,
         t.buy_venue,
         t.sell_venue,
         t.created_at,
         t.closed_at,
         count(*)::int              AS settlements,
         sum(l.amount_usd)          AS total_usd,
         avg(l.net_bps_hr)          AS avg_bps_hr,
         max(l.notional_usd)        AS notional_usd,
         min(l.settled_hour)        AS first_hour,
         max(l.settled_hour)        AS last_hour
       FROM arb_funding_ledger l
       JOIN arb_tasks t ON t.id = l.task_id
       GROUP BY l.task_id, l.symbol, t.state, t.buy_venue, t.sell_venue, t.created_at, t.closed_at
       ORDER BY max(l.settled_hour) DESC`
    )

    const openStates = new Set(['ENTERING', 'RECONCILING', 'HOLDING', 'EXITING', 'PAUSED'])
    let grand = 0
    let openTotal = 0
    let closedTotal = 0
    let settlements = 0
    for (const p of positions) {
      const amt = Number(p.total_usd) || 0
      grand += amt
      settlements += Number(p.settlements) || 0
      if (openStates.has(p.state)) openTotal += amt
      else closedTotal += amt
    }

    res.json({
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
        first_hour: Number(p.first_hour) || 0,
        last_hour: Number(p.last_hour) || 0,
      })),
    })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

module.exports = router
