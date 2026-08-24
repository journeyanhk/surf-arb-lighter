// Account-equity tracking — the GROUND TRUTH behind "why is my balance moving?".
//
// The dashboard's per-position trading PnL resets to 0 the moment a position is
// fully closed (the venue stops itemizing a flat position), so a bot that churns
// round-trips can look "flat/green" while the balance quietly bleeds. The only
// number that never lies is total account equity. We snapshot BOTH venues'
// total_asset_value periodically; the delta between the first and latest snapshot
// is the true net P&L (trading + funding + slippage + everything), because no
// deposits/withdrawals happen during operation.

const { dbQuery } = require('../db')
const sidecar = require('./sidecar')

function num(x) {
  const n = Number(x)
  return Number.isFinite(n) ? n : null
}

// Pull a live snapshot from the sidecar and persist it. Best-effort: returns
// { ok, ... } and never throws into the caller's loop.
async function recordEquitySnapshot() {
  if (!sidecar.configured()) return { ok: false, error: 'sidecar 未配置' }
  const h = await sidecar.health()
  if (!h || !h.ok) return { ok: false, error: (h && h.error) || '边车未就绪' }
  const v = h.venues || {}
  const la = v.lighter && v.lighter.account
  const ra = v.rblighter && v.rblighter.account
  const lEq = la && !la.error ? num(la.total_asset_value) : null
  const rEq = ra && !ra.error ? num(ra.total_asset_value) : null
  const lAv = la && !la.error ? num(la.available_balance) : null
  const rAv = ra && !ra.error ? num(ra.available_balance) : null
  // Need at least one venue's equity to record a meaningful total.
  if (lEq == null && rEq == null) return { ok: false, error: '两所权益均不可读' }
  const total = (lEq || 0) + (rEq || 0)
  await dbQuery(
    `INSERT INTO arb_equity_snapshots
       (lighter_equity, rblighter_equity, total_equity, lighter_available, rblighter_available)
     VALUES ($1,$2,$3,$4,$5)`,
    [lEq, rEq, total, lAv, rAv]
  )
  return { ok: true, total_equity: total, lighter_equity: lEq, rblighter_equity: rEq }
}

// Summary for the panel: baseline (earliest), latest, and the deltas that equal
// true net P&L over the window / last 24h. Returns null when we have no snapshots.
async function getEquitySummary() {
  const { rows: firstRows } = await dbQuery(
    `SELECT at, total_equity FROM arb_equity_snapshots ORDER BY at ASC LIMIT 1`
  )
  if (!firstRows.length) return null
  const { rows: lastRows } = await dbQuery(
    `SELECT at, total_equity FROM arb_equity_snapshots ORDER BY at DESC LIMIT 1`
  )
  // Snapshot closest to 24h ago (fallback to earliest if we don't have a full day).
  const { rows: dayRows } = await dbQuery(
    `SELECT total_equity FROM arb_equity_snapshots
     WHERE at <= now() - interval '24 hours' ORDER BY at DESC LIMIT 1`
  )
  const first = firstRows[0]
  const last = lastRows[0]
  const base = Number(first.total_equity) || 0
  const cur = Number(last.total_equity) || 0
  const day = dayRows.length ? Number(dayRows[0].total_equity) : null
  return {
    baseline_equity: base,
    baseline_at: first.at,
    current_equity: cur,
    current_at: last.at,
    net_since_start_usd: cur - base,
    net_24h_usd: day == null ? null : cur - day,
  }
}

module.exports = { recordEquitySnapshot, getEquitySummary }
