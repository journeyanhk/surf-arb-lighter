// Arbitrage task lifecycle engine — a faithful port of the original tool's
// execution logic, WITHOUT the referral-verification gate and WITHOUT real
// private-key order signing (which needs the native Lighter lib). Legs are
// simulated in DRY_RUN and driven by the live spread snapshot each scan tick.
//
// One state transition per tick so the lifecycle is observable in the UI:
//   ENTERING -> RECONCILING -> HOLDING -> EXITING -> CLOSED
//   ERROR   : both legs failed to fill
//   PAUSED  : ambiguous state recovered after a restart (no blind re-entry)

const { dbQuery } = require('@surf-ai/sdk/db')

const ACTIVE_STATES = ['ENTERING', 'RECONCILING', 'HOLDING', 'EXITING', 'PAUSED']
const eps = 1e-9

let restored = false

// On first tick after (re)start, recover saved tasks. Transient states can't be
// trusted, so they are PAUSED rather than blindly resumed (matches the original).
async function restoreTasks() {
  if (restored) return
  restored = true
  await dbQuery(
    `UPDATE arb_tasks SET state='PAUSED', note=coalesce(note,'') || ' | 重启恢复：状态不明确，已暂停', updated_at=now()
     WHERE state IN ('ENTERING','RECONCILING','EXITING')`
  )
}

// Simulate IOC fills for both legs. Occasionally exercise partial / single-leg
// paths so the reconciliation + compensation flow is real, not decorative.
function simulateFills(size) {
  const r = Math.random()
  if (r < 0.05) return { buy: size, sell: 0 } // single-leg fill
  if (r < 0.2) return { buy: size, sell: +(size * 0.9).toFixed(8) } // partial
  return { buy: size, sell: size } // clean two-leg fill
}

function currentNetBps(task, row, s) {
  if (!row) return null
  const dirBps = task.direction === 'buy_lighter' ? row.buy_lighter_bps : row.buy_rblighter_bps
  if (!Number.isFinite(dirBps)) return null
  return dirBps - (s.max_slippage_bps || 0)
}

async function openTask(r, s) {
  const price = r.best.buy_price
  if (!Number.isFinite(price) || price <= 0) return
  const size = (s.order_notional_usd || 0) / price
  await dbQuery(
    `INSERT INTO arb_tasks
       (symbol, direction, state, buy_venue, sell_venue, buy_price, sell_price,
        size, entry_spread_bps, dry_run, note)
     VALUES ($1,$2,'ENTERING',$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      r.symbol,
      r.best.direction,
      r.best.buy_venue,
      r.best.sell_venue,
      r.best.buy_price,
      r.best.sell_price,
      size,
      r.net_bps,
      s.dry_run,
      `IOC 双腿开仓：买 ${r.best.buy_venue} / 卖 ${r.best.sell_venue}`,
    ]
  )
}

async function advance(t, row, s) {
  const set = (fields, params) =>
    dbQuery(`UPDATE arb_tasks SET ${fields}, updated_at=now() WHERE id=$${params.length + 1}`, [
      ...params,
      t.id,
    ])

  if (t.state === 'ENTERING') {
    const f = simulateFills(t.size)
    await set(`state='RECONCILING', filled_buy=$1, filled_sell=$2, note=$3`, [
      f.buy,
      f.sell,
      `成交回报：买腿 ${f.buy.toFixed(6)} / 卖腿 ${f.sell.toFixed(6)}`,
    ])
    return
  }

  if (t.state === 'RECONCILING') {
    const matched = Math.min(t.filled_buy, t.filled_sell)
    const excess = Math.abs(t.filled_buy - t.filled_sell)
    if (matched <= eps) {
      // Both legs empty (or only opposite side) -> no position created.
      const filled = Math.max(t.filled_buy, t.filled_sell)
      if (filled > eps) {
        // Single-leg fill: unwind immediately with reduce-only, no naked position.
        const notional = filled * t.buy_price
        const pnl = -(notional * (s.max_slippage_bps || 0)) / 10000
        await set(
          `state='CLOSED', matched_size=0, pnl_usd=$1, closed_at=now(), note=$2`,
          [pnl, '单腿成交：reduce-only 平掉，未留敞口']
        )
      } else {
        await set(`state='ERROR', matched_size=0, pnl_usd=0, closed_at=now(), note=$1`, [
          '两腿均未成交，任务作废',
        ])
      }
      return
    }
    const note =
      excess > eps
        ? `部分成交对账：撮合 ${matched.toFixed(6)}，多余腿 ${excess.toFixed(6)} 已 reduce-only 补偿`
        : `双腿对账完成：${matched.toFixed(6)}`
    await set(`state='HOLDING', matched_size=$1, note=$2`, [matched, note])
    return
  }

  if (t.state === 'HOLDING') {
    const cur = currentNetBps(t, row, s)
    const ticks = t.hold_ticks + 1
    const converged = cur != null && cur <= s.exit_spread_bps
    const timeout = ticks >= s.max_hold_ticks
    if (converged || timeout) {
      await set(`state='EXITING', hold_ticks=$1, exit_spread_bps=$2, note=$3`, [
        ticks,
        cur,
        converged ? `价差收敛至 ${fmt(cur)}bps，触发平仓` : `持仓超时(${ticks} ticks)，reduce-only 退出`,
      ])
    } else {
      await set(`hold_ticks=$1`, [ticks])
    }
    return
  }

  if (t.state === 'EXITING') {
    const notional = t.matched_size * t.buy_price
    // Spread captured at entry is locked for the delta-neutral pair.
    const pnl = (notional * t.entry_spread_bps) / 10000
    await set(`state='CLOSED', pnl_usd=$1, closed_at=now(), note=$2`, [
      pnl,
      `已平仓：撮合名义 ${notional.toFixed(2)} USD，锁定 ${fmt(t.entry_spread_bps)}bps`,
    ])
    return
  }
}

function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(1) : '-'
}

// Advance existing tasks, then open new ones from fired signals.
async function stepEngine(rows, s) {
  await restoreTasks()
  if (!s.auto_execute) return summary()

  const bySymbol = new Map(rows.map((r) => [r.symbol, r]))

  const { rows: active } = await dbQuery(
    `SELECT * FROM arb_tasks WHERE state IN ('ENTERING','RECONCILING','HOLDING','EXITING') ORDER BY id`
  )
  for (const t of active) {
    try {
      await advance(t, bySymbol.get(t.symbol), s)
    } catch (_) {
      /* keep other tasks moving */
    }
  }

  for (const r of rows) {
    if (!r.signal) continue
    const { rows: ex } = await dbQuery(
      `SELECT id FROM arb_tasks WHERE symbol=$1 AND state = ANY($2) LIMIT 1`,
      [r.symbol, ACTIVE_STATES]
    )
    if (ex.length) continue // one active task per symbol
    await openTask(r, s)
  }

  return summary()
}

async function summary() {
  const { rows } = await dbQuery(
    `SELECT
        count(*) FILTER (WHERE state IN ('ENTERING','RECONCILING','HOLDING','EXITING'))::int AS open,
        count(*) FILTER (WHERE state='HOLDING')::int AS holding,
        count(*) FILTER (WHERE state='CLOSED')::int AS closed,
        count(*) FILTER (WHERE state='PAUSED')::int AS paused,
        count(*) FILTER (WHERE state='ERROR')::int AS error,
        coalesce(sum(pnl_usd) FILTER (WHERE state='CLOSED'),0) AS realized_pnl
     FROM arb_tasks`
  )
  return rows[0]
}

module.exports = { stepEngine, summary, ACTIVE_STATES }
