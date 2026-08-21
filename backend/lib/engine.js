// Arbitrage task lifecycle engine.
//
// Two execution modes per task, chosen at open time:
//   'sim'  — simulated fills (Math.random). Runs when live gating is off or the
//            Python signing sidecar isn't configured. This keeps the app fully
//            usable with zero risk.
//   'live' — REAL orders routed through the Python sidecar (official lighter-sdk):
//            snapshot positions -> place two IOC legs -> reconcile from real
//            position deltas -> reduce-only single-leg protection -> reduce-only
//            exit. Only engages when EVERY gate is true (see liveEnabled()).
//
// State machine (identical for both modes):
//   ENTERING -> RECONCILING -> HOLDING -> EXITING -> CLOSED
//   ERROR   : both legs failed / no position created
//   PAUSED  : ambiguous state (restart, or a live-path error) -> needs human eyes

const { dbQuery } = require('../db')
const sidecar = require('./sidecar')

const ACTIVE_STATES = ['ENTERING', 'RECONCILING', 'HOLDING', 'EXITING', 'PAUSED']
const eps = 1e-9

let restored = false

async function restoreTasks() {
  if (restored) return
  restored = true
  await dbQuery(
    `UPDATE arb_tasks SET state='PAUSED', note=coalesce(note,'') || ' | 重启恢复：状态不明确，已暂停', updated_at=now()
     WHERE state IN ('ENTERING','RECONCILING','EXITING')`
  )
}

// ---- venue / market helpers ----
function venueTag(name) {
  return String(name || '').toLowerCase().startsWith('rb') ? 'rblighter' : 'lighter'
}
function marketIndexFor(row, venueName) {
  return venueTag(venueName) === 'lighter' ? row.lighter_market_id : row.rblighter_market_id
}
// Current top-of-book for a venue from the live scan row ('ask' | 'bid').
function bookPrice(row, venueName, side) {
  if (!row) return null
  const tag = venueTag(venueName)
  if (side === 'ask') return tag === 'lighter' ? row.lighter_ask : row.rblighter_ask
  return tag === 'lighter' ? row.lighter_bid : row.rblighter_bid
}

// Every gate must be true before a single real order can be placed.
function liveEnabled(s) {
  return (
    !s.dry_run &&
    s.live_trading_ack &&
    s.poc_verified &&
    s.enable_real_market_streams &&
    sidecar.configured()
  )
}

// IOC limit prices are set slightly across the book so the taker leg is
// marketable; the limit is a slippage CAP, not the executed price.
function crossBuffer(s) {
  const bps = Math.max(Number(s.max_slippage_bps) || 0, 2)
  return bps / 10000
}

// ---- simulated fills (unchanged behaviour) ----
function simulateFills(size) {
  const r = Math.random()
  if (r < 0.05) return { buy: size, sell: 0 }
  if (r < 0.2) return { buy: size, sell: +(size * 0.9).toFixed(8) }
  return { buy: size, sell: size }
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
  const notional = Number(s.order_notional_usd)
  if (!Number.isFinite(notional) || notional <= 0) {
    // Misconfigured notional would produce a 0-size order the venue rejects.
    // Skip silently rather than spawn a task that's guaranteed to fail.
    console.warn(`[engine] 跳过开仓 ${r.symbol}：单笔名义金额无效 (order_notional_usd=${s.order_notional_usd})`)
    return
  }
  const size = notional / price
  if (!Number.isFinite(size) || size <= 0) return
  const buyIdx = marketIndexFor(r, r.best.buy_venue)
  const sellIdx = marketIndexFor(r, r.best.sell_venue)
  const live = liveEnabled(s) && Number.isFinite(buyIdx) && Number.isFinite(sellIdx)
  const execMode = live ? 'live' : 'sim'

  // Depth guard (live only): if either leg's resting size near the touch can't
  // cover our order, an IOC would fill little/nothing and the task voids. Skip
  // opening so we don't churn on thin books. Sim mode is unaffected (demo).
  if (live) {
    const buyDepth = Number(r.best.buy_depth_base)
    const sellDepth = Number(r.best.sell_depth_base)
    const need = size * (Number(s.min_depth_ratio) > 0 ? Number(s.min_depth_ratio) : 1)
    if (!Number.isFinite(buyDepth) || !Number.isFinite(sellDepth) || buyDepth < need || sellDepth < need) {
      console.warn(
        `[engine] 跳过实盘开仓 ${r.symbol}：盘口深度不足（需 ${need.toFixed(6)}，买腿 ${Number.isFinite(buyDepth) ? buyDepth.toFixed(6) : 'NA'} / 卖腿 ${Number.isFinite(sellDepth) ? sellDepth.toFixed(6) : 'NA'}）`
      )
      return
    }
  }
  await dbQuery(
    `INSERT INTO arb_tasks
       (symbol, direction, state, buy_venue, sell_venue, buy_price, sell_price,
        size, entry_spread_bps, dry_run, exec_mode, buy_market_index, sell_market_index, note)
     VALUES ($1,$2,'ENTERING',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
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
      execMode,
      buyIdx ?? null,
      sellIdx ?? null,
      `${execMode === 'live' ? '实盘' : '模拟'} IOC 双腿开仓：买 ${r.best.buy_venue} / 卖 ${r.best.sell_venue}`,
    ]
  )
}

function setter(id) {
  return (fields, params) =>
    dbQuery(`UPDATE arb_tasks SET ${fields}, updated_at=now() WHERE id=$${params.length + 1}`, [
      ...params,
      id,
    ])
}

// ============================ SIMULATED PATH ============================
async function advanceSim(t, row, s, set) {
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
    await reconcileClose(t, s, set, t.filled_buy, t.filled_sell, false)
    return
  }
  if (t.state === 'HOLDING') {
    await holding(t, row, s, set)
    return
  }
  if (t.state === 'EXITING') {
    const { pnl, note } = realizedPnl(t, s)
    await set(`state='CLOSED', pnl_usd=$1, closed_at=now(), note=$2`, [pnl, `已平仓：${note}`])
    return
  }
}

// ============================ LIVE PATH ============================
async function advanceLive(t, row, s, set) {
  try {
    if (t.state === 'ENTERING') return await enterLive(t, row, s, set)
    if (t.state === 'RECONCILING') return await reconcileLive(t, row, s, set)
    if (t.state === 'HOLDING') return await holding(t, row, s, set)
    if (t.state === 'EXITING') return await exitLive(t, row, s, set)
  } catch (e) {
    // Never leave a live task silently stuck: pause it for manual review.
    await set(`state='PAUSED', note=$1`, [
      `实盘执行异常，已暂停待人工检查：${String(e.message || e).slice(0, 180)}`,
    ])
  }
}

async function enterLive(t, row, s, set) {
  if (s.maker_open) return enterLiveMakerOpen(t, row, s, set)
  const buyV = venueTag(t.buy_venue)
  const sellV = venueTag(t.sell_venue)
  // 1) snapshot real positions so reconciliation can measure the delta
  const [pbuy, psell] = await Promise.all([sidecar.positions(buyV), sidecar.positions(sellV)])
  if (!pbuy || !psell) {
    await set(`state='PAUSED', note=$1`, ['无法读取实盘持仓，开仓中止（请检查 sidecar/网络）'])
    return
  }
  const preBuy = pbuy[t.buy_market_index] || 0
  const preSell = psell[t.sell_market_index] || 0
  // 2) place both IOC legs, marketable across the book
  const buf = crossBuffer(s)
  const buyPx = (bookPrice(row, t.buy_venue, 'ask') || t.buy_price) * (1 + buf)
  const sellPx = (bookPrice(row, t.sell_venue, 'bid') || t.sell_price) * (1 - buf)
  const [ba, sa] = await Promise.all([
    sidecar.placeOrder({ venue: buyV, market_index: t.buy_market_index, side: 'buy', size: t.size, price: buyPx, reduce_only: false, client_order_index: t.id * 10 + 1 }),
    sidecar.placeOrder({ venue: sellV, market_index: t.sell_market_index, side: 'sell', size: t.size, price: sellPx, reduce_only: false, client_order_index: t.id * 10 + 2 }),
  ])
  // If BOTH legs were rejected before ever hitting the book (sidecar 400/409:
  // notional cap, size < min, unknown market, venue not ready…), no position
  // was opened — surface the REAL reason instead of the misleading "IOC 未撮合".
  if (!ba.ok && !sa.ok) {
    const reason = `买腿:${ba.error || 'fail'} ｜ 卖腿:${sa.error || 'fail'}`
    await set(
      `state='ERROR', pre_buy_pos=$1, pre_sell_pos=$2, buy_ack=$3, sell_ack=$4, matched_size=0, pnl_usd=0, closed_at=now(), note=$5`,
      [
        preBuy,
        preSell,
        JSON.stringify(ba).slice(0, 500),
        JSON.stringify(sa).slice(0, 500),
        `实盘下单被拒（两腿均未提交成功）：${reason}`.slice(0, 300),
      ]
    )
    return
  }
  const legErr = !ba.ok ? `买腿被拒:${ba.error}` : !sa.ok ? `卖腿被拒:${sa.error}` : ''
  await set(
    `state='RECONCILING', pre_buy_pos=$1, pre_sell_pos=$2, buy_ack=$3, sell_ack=$4, note=$5`,
    [
      preBuy,
      preSell,
      JSON.stringify(ba).slice(0, 500),
      JSON.stringify(sa).slice(0, 500),
      (`已提交实盘双腿 IOC：买 ${ba.ok ? 'ok' : 'fail'} / 卖 ${sa.ok ? 'ok' : 'fail'}` +
        (legErr ? ` ｜ ${legErr}` : '')).slice(0, 300),
    ]
  )
}

// MAKER-OPEN: rest a passive post-only quote on the BUY leg (no position yet ->
// zero risk while it sits), and the instant it fills, taker-hedge the SELL leg for
// exactly the filled base. Re-quote at the touch each tick; cancel-replace to chase.
// Only opening fee paid is 1 taker (the hedge) instead of 2 — the maker leg is 0.
//   ENTERING (maker): snapshot -> quote -> [hedge fills + requote]* -> RECONCILING
// Handing off to reconcileLive at the end reuses the tested single-leg/imbalance
// protection (it flattens any hedge shortfall via reduce_only). Safe by construction.
async function enterLiveMakerOpen(t, row, s, set) {
  const buyV = venueTag(t.buy_venue)
  const sellV = venueTag(t.sell_venue)
  const [pbuy, psell] = await Promise.all([sidecar.positions(buyV), sidecar.positions(sellV)])
  if (!pbuy || !psell) {
    await set(`state='PAUSED', note=$1`, ['maker 开仓无法读取持仓，已暂停待人工检查'])
    return
  }
  const ticks = (t.entry_ticks || 0) + 1

  // First tick: record the baseline snapshot and post the first passive quote.
  if (t.pre_buy_pos == null || t.pre_sell_pos == null) {
    const preBuy = pbuy[t.buy_market_index] || 0
    const preSell = psell[t.sell_market_index] || 0
    const bidPx = bookPrice(row, t.buy_venue, 'bid') || t.buy_price
    const q = await sidecar.placeOrder({ venue: buyV, market_index: t.buy_market_index, side: 'buy', size: t.size, price: bidPx, reduce_only: false, tif: 'post_only', client_order_index: t.id * 10 + 1 })
    await set(`pre_buy_pos=$1, pre_sell_pos=$2, entry_ticks=$3, buy_ack=$4, note=$5`, [
      preBuy, preSell, ticks, JSON.stringify(q).slice(0, 500),
      `maker 开仓挂单：买 ${t.buy_venue} @ ${bidPx.toFixed(6)}${q.ok ? '' : ` ｜ 挂单失败:${q.error}`}`,
    ])
    return
  }

  const filledBuy = Math.max(0, (pbuy[t.buy_market_index] || 0) - (t.pre_buy_pos || 0))
  const hedged = Math.max(0, (t.pre_sell_pos || 0) - (psell[t.sell_market_index] || 0))
  const unhedged = filledBuy - hedged
  const buf = crossBuffer(s)

  // Hedge whatever the maker leg newly filled — taker sell for the exact delta.
  if (unhedged > eps) {
    const px = (bookPrice(row, t.sell_venue, 'bid') || t.sell_price) * (1 - buf)
    await sidecar.placeOrder({ venue: sellV, market_index: t.sell_market_index, side: 'sell', size: unhedged, price: px, reduce_only: false, tif: 'ioc', client_order_index: t.id * 10 + 2 })
  }

  const filledEnough = filledBuy >= t.size * (1 - 1e-4)
  const deadline = Math.max(1, Number(s.maker_open_wait_ticks) || 20)

  // Done, or patience exhausted: cancel the resting quote and hand off to reconcile.
  if (filledEnough || ticks >= deadline) {
    await sidecar.cancelOrders(buyV, t.buy_market_index)
    if (filledBuy <= eps) {
      await set(`state='ERROR', entry_ticks=$1, matched_size=0, pnl_usd=0, closed_at=now(), note=$2`, [
        ticks, 'maker 开仓超时未成交，已撤单，无持仓',
      ])
      return
    }
    await set(`state='RECONCILING', entry_ticks=$1, note=$2`, [
      ticks,
      filledEnough
        ? `maker 开仓成交 ${filledBuy.toFixed(6)}，转对账`
        : `maker 开仓超时，部分成交 ${filledBuy.toFixed(6)}/${t.size}，转对账`,
    ])
    return
  }

  // Re-quote the remaining size at the current bid (cancel old first — non-reduce
  // orders must never stack, or we could over-fill).
  await sidecar.cancelOrders(buyV, t.buy_market_index)
  const remaining = Math.max(0, t.size - filledBuy)
  if (remaining > eps) {
    const bidPx = bookPrice(row, t.buy_venue, 'bid') || t.buy_price
    await sidecar.placeOrder({ venue: buyV, market_index: t.buy_market_index, side: 'buy', size: remaining, price: bidPx, reduce_only: false, tif: 'post_only', client_order_index: t.id * 10 + 1 })
  }
  await set(`entry_ticks=$1, note=$2`, [
    ticks,
    `maker 开仓挂单中(${ticks}/${deadline})：已成交 ${filledBuy.toFixed(6)}/${t.size}`,
  ])
}

async function reconcileLive(t, row, s, set) {
  const buyV = venueTag(t.buy_venue)
  const sellV = venueTag(t.sell_venue)
  const [pbuy, psell] = await Promise.all([sidecar.positions(buyV), sidecar.positions(sellV)])
  if (!pbuy || !psell) {
    await set(`state='PAUSED', note=$1`, ['对账失败：无法读取持仓，已暂停待人工检查'])
    return
  }
  const curBuy = pbuy[t.buy_market_index] || 0
  const curSell = psell[t.sell_market_index] || 0
  const filledBuy = Math.abs(curBuy - (t.pre_buy_pos || 0))
  const filledSell = Math.abs(curSell - (t.pre_sell_pos || 0))
  const matched = Math.min(filledBuy, filledSell)
  const excess = Math.abs(filledBuy - filledSell)
  const buf = crossBuffer(s)

  // Single-leg protection: reduce-only flatten the un-hedged excess immediately.
  if (excess > eps) {
    if (filledBuy > filledSell) {
      const px = (bookPrice(row, t.buy_venue, 'bid') || t.buy_price) * (1 - buf)
      await sidecar.placeOrder({ venue: buyV, market_index: t.buy_market_index, side: 'sell', size: excess, price: px, reduce_only: true, client_order_index: t.id * 10 + 3 })
    } else {
      const px = (bookPrice(row, t.sell_venue, 'ask') || t.sell_price) * (1 + buf)
      await sidecar.placeOrder({ venue: sellV, market_index: t.sell_market_index, side: 'buy', size: excess, price: px, reduce_only: true, client_order_index: t.id * 10 + 4 })
    }
  }

  await dbQuery(`UPDATE arb_tasks SET filled_buy=$1, filled_sell=$2 WHERE id=$3`, [filledBuy, filledSell, t.id])

  if (matched <= eps) {
    const filled = Math.max(filledBuy, filledSell)
    if (filled > eps) {
      await set(`state='CLOSED', matched_size=0, pnl_usd=0, closed_at=now(), note=$1`, [
        `单腿成交 ${filled.toFixed(6)}，已 reduce-only 平掉，未留敞口`,
      ])
    } else {
      await set(`state='ERROR', matched_size=0, pnl_usd=0, closed_at=now(), note=$1`, [
        '两腿均未成交（IOC 未撮合），任务作废',
      ])
    }
    return
  }
  const note =
    excess > eps
      ? `实盘对账：撮合 ${matched.toFixed(6)}，多余腿 ${excess.toFixed(6)} 已 reduce-only 补偿`
      : `实盘双腿对账完成：${matched.toFixed(6)}`
  await set(`state='HOLDING', matched_size=$1, note=$2`, [matched, note])
}

async function exitLive(t, row, s, set) {
  if (s.maker_close) return exitLiveMaker(t, row, s, set)
  const buyV = venueTag(t.buy_venue)
  const sellV = venueTag(t.sell_venue)
  const buf = crossBuffer(s)
  // buy leg opened long -> close by selling; sell leg opened short -> close by buying.
  const closeSellPx = (bookPrice(row, t.buy_venue, 'bid') || t.buy_price) * (1 - buf)
  const closeBuyPx = (bookPrice(row, t.sell_venue, 'ask') || t.sell_price) * (1 + buf)
  await Promise.all([
    sidecar.placeOrder({ venue: buyV, market_index: t.buy_market_index, side: 'sell', size: t.matched_size, price: closeSellPx, reduce_only: true, tif: 'ioc', client_order_index: t.id * 10 + 5 }),
    sidecar.placeOrder({ venue: sellV, market_index: t.sell_market_index, side: 'buy', size: t.matched_size, price: closeBuyPx, reduce_only: true, tif: 'ioc', client_order_index: t.id * 10 + 6 }),
  ])
  const { pnl, note } = realizedPnl(t, s, true)
  await set(`state='CLOSED', pnl_usd=$1, closed_at=now(), note=$2`, [
    pnl,
    `已提交实盘 reduce-only 双腿平仓：${note}`,
  ])
}

// Maker close-out. Key insight: while BOTH legs are still open the position is
// delta-neutral, so we can rest reduce-only POST-ONLY orders at the touch and wait
// as long as we like (0 fee) — patience is nearly free. The ONLY danger is going
// single-legged when one maker leg fills before the other; that leaves a directional
// exposure. So each tick we:
//   1) taker-hedge just the IMBALANCE (excess = |remLong-remShort|) to restore neutral,
//   2) keep the still-hedged remainder resting as maker, re-quoted at the touch,
//   3) only after maker_close_wait_ticks give up and taker-cross the balanced rest.
// reduce_only can't flip a position, so stale resting orders are harmless no-ops.
async function exitLiveMaker(t, row, s, set) {
  const buyV = venueTag(t.buy_venue)
  const sellV = venueTag(t.sell_venue)
  const [pbuy, psell] = await Promise.all([sidecar.positions(buyV), sidecar.positions(sellV)])
  if (!pbuy || !psell) {
    await set(`state='PAUSED', note=$1`, ['maker 平仓对账失败：无法读取持仓，已暂停待人工检查'])
    return
  }
  const remLong = Math.max(0, (pbuy[t.buy_market_index] || 0) - (t.pre_buy_pos || 0))
  const remShort = Math.max(0, (t.pre_sell_pos || 0) - (psell[t.sell_market_index] || 0))
  const ticks = (t.exit_ticks || 0) + 1
  const buf = crossBuffer(s)

  // Fully unwound -> closed at maker (0 close fee).
  if (remLong <= eps && remShort <= eps) {
    const { pnl, note } = realizedPnl(t, s, false)
    await set(`state='CLOSED', exit_ticks=$1, pnl_usd=$2, closed_at=now(), note=$3`, [
      ticks, pnl, `maker 挂单平仓全部成交：${note}`,
    ])
    return
  }

  // (1) Imbalance = net directional exposure from one maker leg filling first.
  //     Taker-hedge it back to neutral IMMEDIATELY — never sit single-legged.
  const excess = Math.abs(remLong - remShort)
  if (excess > eps) {
    if (remLong > remShort) {
      const px = (bookPrice(row, t.buy_venue, 'bid') || t.buy_price) * (1 - buf)
      await sidecar.placeOrder({ venue: buyV, market_index: t.buy_market_index, side: 'sell', size: excess, price: px, reduce_only: true, tif: 'ioc', client_order_index: t.id * 10 + 5 })
    } else {
      const px = (bookPrice(row, t.sell_venue, 'ask') || t.sell_price) * (1 + buf)
      await sidecar.placeOrder({ venue: sellV, market_index: t.sell_market_index, side: 'buy', size: excess, price: px, reduce_only: true, tif: 'ioc', client_order_index: t.id * 10 + 6 })
    }
  }

  const balanced = Math.min(remLong, remShort) // still-hedged remainder (safe to wait)
  if (balanced <= eps) {
    // Only imbalance was left; the taker hedge above flattens it. Re-check next tick.
    await set(`exit_ticks=$1, note=$2`, [ticks, `maker 平仓：已 taker 补平不对冲的 ${excess.toFixed(6)}，等待确认`])
    return
  }

  const deadline = Math.max(1, Number(s.maker_close_wait_ticks) || 20)
  if (ticks >= deadline) {
    // Patience exhausted: cross the hedged remainder with taker IOC on both legs.
    const pxSell = (bookPrice(row, t.buy_venue, 'bid') || t.buy_price) * (1 - buf)
    const pxBuy = (bookPrice(row, t.sell_venue, 'ask') || t.sell_price) * (1 + buf)
    await Promise.all([
      sidecar.placeOrder({ venue: buyV, market_index: t.buy_market_index, side: 'sell', size: balanced, price: pxSell, reduce_only: true, tif: 'ioc', client_order_index: t.id * 10 + 7 }),
      sidecar.placeOrder({ venue: sellV, market_index: t.sell_market_index, side: 'buy', size: balanced, price: pxBuy, reduce_only: true, tif: 'ioc', client_order_index: t.id * 10 + 8 }),
    ])
    const { pnl, note } = realizedPnl(t, s, true)
    await set(`state='CLOSED', exit_ticks=$1, pnl_usd=$2, closed_at=now(), note=$3`, [
      ticks, pnl, `maker 平仓超时(${ticks} ticks)，剩余 taker 补平：${note}`,
    ])
    return
  }

  // (2) Re-quote passive reduce-only maker orders at the touch for the hedged rest.
  //     Sell the long at the ask, buy back the short at the bid — neither crosses.
  const pxSell = bookPrice(row, t.buy_venue, 'ask') || t.buy_price
  const pxBuy = bookPrice(row, t.sell_venue, 'bid') || t.sell_price
  await Promise.all([
    sidecar.placeOrder({ venue: buyV, market_index: t.buy_market_index, side: 'sell', size: balanced, price: pxSell, reduce_only: true, tif: 'post_only', client_order_index: t.id * 100000 + ticks * 10 + 1 }),
    sidecar.placeOrder({ venue: sellV, market_index: t.sell_market_index, side: 'buy', size: balanced, price: pxBuy, reduce_only: true, tif: 'post_only', client_order_index: t.id * 100000 + ticks * 10 + 2 }),
  ])
  await set(`exit_ticks=$1, note=$2`, [
    ticks,
    `maker 挂单平仓中(${ticks}/${deadline})：对冲挂单 ${balanced.toFixed(6)}${excess > eps ? `，taker 补平不平衡 ${excess.toFixed(6)}` : ''}`,
  ])
}

// ---- shared: RECONCILING close (sim) + HOLDING (both) ----
async function reconcileClose(t, s, set, filledBuy, filledSell, _live) {
  const matched = Math.min(filledBuy, filledSell)
  const excess = Math.abs(filledBuy - filledSell)
  if (matched <= eps) {
    const filled = Math.max(filledBuy, filledSell)
    if (filled > eps) {
      const notional = filled * t.buy_price
      const pnl = -(notional * (s.max_slippage_bps || 0)) / 10000
      await set(`state='CLOSED', matched_size=0, pnl_usd=$1, closed_at=now(), note=$2`, [
        pnl,
        '单腿成交：reduce-only 平掉，未留敞口',
      ])
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
}

async function holding(t, row, s, set) {
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
}

function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(1) : '-'
}

// Realistic realized-PnL estimate.
//   gross convergence capture = entry_spread − exit_spread   (bps on notional)
//   minus fees:
//     open  = 1 × taker_fee_bps if maker_open (only the hedge leg is taker), else 2
//     close = 2 × taker_fee_bps if taker IOC, else 0 (maker post-only, 0 fee)
// Still an ESTIMATE from intended spreads, not authed fills.
function realizedPnl(t, s, closeTaker = !s.maker_close) {
  const notional = (Number(t.matched_size) || 0) * (Number(t.buy_price) || 0)
  const grossBps = (Number(t.entry_spread_bps) || 0) - (Number(t.exit_spread_bps) || 0)
  const takerFee = Number(s.taker_fee_bps) || 0
  const openFee = takerFee * (s.maker_open ? 1 : 2)
  const closeFee = closeTaker ? takerFee * 2 : 0
  const feeBps = openFee + closeFee
  const netBps = grossBps - feeBps
  const note = `名义 ${notional.toFixed(2)} USD，净 ${fmt(netBps)}bps（毛 ${fmt(grossBps)} − 手续费 ${fmt(feeBps)}${s.maker_open || !closeTaker ? '，含 maker 0 费腿' : ''}）`
  return { pnl: (notional * netBps) / 10000, note }
}

async function advance(t, row, s) {
  const set = setter(t.id)
  if (t.exec_mode === 'live') return advanceLive(t, row, s, set)
  return advanceSim(t, row, s, set)
}

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

  // Opening gates for "start simple" operation:
  //   focus_symbol        — if set, only ever open this one market (single-coin mode)
  //   max_concurrent_tasks — hard cap on simultaneous open positions (default 1)
  // Count PAUSED too: it may still hold real exposure, so it occupies a slot.
  const cap = Math.max(1, Number(s.max_concurrent_tasks) || 1)
  const focus = String(s.focus_symbol || '').trim().toUpperCase()
  // Re-count after advancing (some may have closed / a leg may have paused).
  const { rows: cnt } = await dbQuery(
    `SELECT count(*)::int AS n FROM arb_tasks WHERE state = ANY($1)`,
    [ACTIVE_STATES]
  )
  let activeCount = cnt[0].n

  for (const r of rows) {
    if (activeCount >= cap) break
    if (!r.signal) continue
    if (focus && String(r.symbol).toUpperCase() !== focus) continue
    const { rows: ex } = await dbQuery(
      `SELECT id FROM arb_tasks WHERE symbol=$1 AND state = ANY($2) LIMIT 1`,
      [r.symbol, ACTIVE_STATES]
    )
    if (ex.length) continue
    await openTask(r, s)
    activeCount++
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
        count(*) FILTER (WHERE exec_mode='live' AND state IN ('ENTERING','RECONCILING','HOLDING','EXITING'))::int AS live_open,
        coalesce(sum(pnl_usd) FILTER (WHERE state='CLOSED'),0) AS realized_pnl
     FROM arb_tasks`
  )
  return rows[0]
}

module.exports = { stepEngine, summary, ACTIVE_STATES }
