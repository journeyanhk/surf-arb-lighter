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
const { topOfBook } = require('./exchange')
const { getFundingMap, carryBpsHr, bestCarry } = require('./funding')

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

// ============================ FUNDING-CARRY OPEN ============================
// Open a delta-neutral funding-carry position: LONG the lower-funding venue,
// SHORT the higher-funding venue, to collect the hourly funding differential.
// Reuses the SAME live open/reconcile/hold/exit path (strategy='funding' only
// changes the entry trigger + the HOLDING exit condition). Fetches its own fresh
// books so it never depends on the price-spread scan row.
//   ids: { symbol, lighter_market_id, rblighter_market_id }
async function openFundingTask(symbol, s, pair, ids) {
  const bc = bestCarry(pair)
  if (!bc || !(bc.diff_bps_hr > 0)) return { ok: false, error: '当前无有效费差' }
  const longV = bc.long_venue
  const shortV = bc.short_venue
  const longTag = venueTag(longV)
  const shortTag = venueTag(shortV)
  const longBase = longTag === 'lighter' ? s.lighter_base_url : s.rblighter_base_url
  const shortBase = shortTag === 'lighter' ? s.lighter_base_url : s.rblighter_base_url
  const longMkt = longTag === 'lighter' ? ids.lighter_market_id : ids.rblighter_market_id
  const shortMkt = shortTag === 'lighter' ? ids.lighter_market_id : ids.rblighter_market_id
  if (!Number.isFinite(longMkt) || !Number.isFinite(shortMkt)) {
    return { ok: false, error: '找不到该币种的市场索引' }
  }
  const [lb, sb] = await Promise.all([
    topOfBook(longBase, longMkt, s.proxy_url),
    topOfBook(shortBase, shortMkt, s.proxy_url),
  ])
  if (!lb || !sb) return { ok: false, error: '读取盘口失败（无法定价）' }
  const buyPrice = lb.bestAsk // LONG leg buys at the ask
  const sellPrice = sb.bestBid // SHORT leg sells at the bid
  const notional = Number(s.order_notional_usd)
  if (!Number.isFinite(notional) || notional <= 0) return { ok: false, error: '单笔名义金额无效' }
  if (!Number.isFinite(buyPrice) || buyPrice <= 0) return { ok: false, error: '盘口价格无效' }
  const size = notional / buyPrice
  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: '下单量无效' }
  const live = liveEnabled(s)
  const execMode = live ? 'live' : 'sim'
  // Depth guard (live only): both legs' near-touch book must cover size × ratio.
  if (live) {
    const need = size * (Number(s.min_depth_ratio) > 0 ? Number(s.min_depth_ratio) : 1)
    const buyDepth = Number(lb.askDepthBase)
    const sellDepth = Number(sb.bidDepthBase)
    if (!Number.isFinite(buyDepth) || !Number.isFinite(sellDepth) || buyDepth < need || sellDepth < need) {
      return {
        ok: false,
        error: `盘口深度不足（需 ${need.toFixed(6)}，多腿 ${Number.isFinite(buyDepth) ? buyDepth.toFixed(4) : 'NA'} / 空腿 ${Number.isFinite(sellDepth) ? sellDepth.toFixed(4) : 'NA'}）`,
      }
    }
  }
  const { rows } = await dbQuery(
    `INSERT INTO arb_tasks
       (symbol, direction, strategy, state, buy_venue, sell_venue, buy_price, sell_price,
        size, entry_spread_bps, entry_funding_bps_hr, dry_run, exec_mode,
        buy_market_index, sell_market_index, note)
     VALUES ($1,'funding','funding','ENTERING',$2,$3,$4,$5,$6,0,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [
      symbol,
      longV,
      shortV,
      buyPrice,
      sellPrice,
      size,
      bc.diff_bps_hr,
      s.dry_run,
      execMode,
      longMkt,
      shortMkt,
      `${execMode === 'live' ? '实盘' : '模拟'}资金费对冲开仓：做多 ${longV} / 做空 ${shortV}，入场费差 ${bc.diff_bps_hr.toFixed(2)} bps/时`,
    ]
  )
  return { ok: true, id: rows[0].id, exec_mode: execMode, short_venue: shortV, long_venue: longV, diff_bps_hr: bc.diff_bps_hr }
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

  // "Enough filled" must tolerate the venue's size step: our target size is a raw
  // notional/price float (e.g. 0.164259…), but the exchange rounds order size to a
  // lot, so the last sub-lot tail (e.g. 0.00026) can NEVER fill. Treat ≥99% as done
  // instead of 99.99%, so a fully-established position isn't stuck "quoting" chasing
  // an unplaceable remainder until timeout.
  const dust = t.size * 0.01
  const filledEnough = filledBuy >= t.size - dust
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
        : `maker 开仓超时，部分成交 ${filledBuy.toFixed(6)}/${t.size.toFixed(6)}，转对账`,
    ])
    return
  }

  // Re-quote the remaining size at the current bid (cancel old first — non-reduce
  // orders must never stack, or we could over-fill). Skip if only unplaceable dust
  // is left, so we don't churn cancel/repost on a sub-lot tail.
  await sidecar.cancelOrders(buyV, t.buy_market_index)
  const remaining = Math.max(0, t.size - filledBuy)
  if (remaining > dust) {
    const bidPx = bookPrice(row, t.buy_venue, 'bid') || t.buy_price
    await sidecar.placeOrder({ venue: buyV, market_index: t.buy_market_index, side: 'buy', size: remaining, price: bidPx, reduce_only: false, tif: 'post_only', client_order_index: t.id * 10 + 1 })
  }
  await set(`entry_ticks=$1, note=$2`, [
    ticks,
    `maker 开仓挂单中(${ticks}/${deadline})：已成交 ${filledBuy.toFixed(6)}/${t.size.toFixed(6)}`,
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
      // Single-leg fill: opened one taker leg then reduce-only closed it. Zero fee,
      // but we crossed the book twice (buy at ask / sell at bid) -> a small spread+
      // slippage cost. Record it honestly (~2× the cross buffer) so the dashboard
      // total matches the venue's trade history instead of showing a fake 0.
      const legPx = filledBuy > filledSell ? (t.buy_price || 0) : (t.sell_price || 0)
      const roundTripBps = 2 * Math.max(Number(s.max_slippage_bps) || 0, 2)
      const cost = -(filled * legPx * roundTripBps) / 10000
      await set(`state='CLOSED', matched_size=0, pnl_usd=$1, closed_at=now(), note=$2`, [
        cost,
        `单腿成交 ${filled.toFixed(6)}，已 reduce-only 平掉，未留敞口（跨价成本约 ${fmt(cost, 4)}）`,
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

// TAKER close-out. THE naked-leg bug fix: we must NEVER mark a task CLOSED until
// BOTH legs are confirmed flat against real positions. The old code fired two IOC
// closes and immediately set state=CLOSED — if one IOC missed the book, that leg
// stayed naked and got flattened much later at a terrible price (the ANTHROPIC
// -0.18 loss in the trade export). Now we poll each tick and re-cross whatever is
// still open with reduce_only IOC (which can't flip a position, so re-firing an
// already-filled leg is a harmless no-op) until the position is genuinely gone.
async function exitLive(t, row, s, set) {
  if (s.maker_close) return exitLiveMaker(t, row, s, set)
  const buyV = venueTag(t.buy_venue)
  const sellV = venueTag(t.sell_venue)
  const [pbuy, psell] = await Promise.all([sidecar.positions(buyV), sidecar.positions(sellV)])
  if (!pbuy || !psell) {
    await set(`state='PAUSED', note=$1`, ['平仓对账失败：无法读取持仓，已暂停待人工检查'])
    return
  }
  const remLong = Math.max(0, (pbuy[t.buy_market_index] || 0) - (t.pre_buy_pos || 0))
  const remShort = Math.max(0, (t.pre_sell_pos || 0) - (psell[t.sell_market_index] || 0))
  const ticks = (t.exit_ticks || 0) + 1
  const buf = crossBuffer(s)

  // Both legs confirmed flat against real positions -> ONLY now mark CLOSED.
  if (remLong <= eps && remShort <= eps) {
    const { pnl, note } = realizedPnl(t, s, true)
    await set(`state='CLOSED', exit_ticks=$1, pnl_usd=$2, closed_at=now(), note=$3`, [
      ticks, pnl, `双腿 reduce-only 平仓已确认全部成交：${note}`,
    ])
    return
  }

  // Re-cross whichever leg is still open, marketable across the book. Unique
  // per-tick client_order_index so no venue-side dedupe can drop a retry.
  const jobs = []
  if (remLong > eps) {
    const px = (bookPrice(row, t.buy_venue, 'bid') || t.buy_price) * (1 - buf)
    jobs.push(sidecar.placeOrder({ venue: buyV, market_index: t.buy_market_index, side: 'sell', size: remLong, price: px, reduce_only: true, tif: 'ioc', client_order_index: t.id * 100000 + ticks * 10 + 5 }))
  }
  if (remShort > eps) {
    const px = (bookPrice(row, t.sell_venue, 'ask') || t.sell_price) * (1 + buf)
    jobs.push(sidecar.placeOrder({ venue: sellV, market_index: t.sell_market_index, side: 'buy', size: remShort, price: px, reduce_only: true, tif: 'ioc', client_order_index: t.id * 100000 + ticks * 10 + 6 }))
  }
  await Promise.all(jobs)

  await set(`exit_ticks=$1, note=$2`, [
    ticks,
    `平仓补平中(${ticks})：剩余多腿 ${remLong.toFixed(6)} / 空腿 ${remShort.toFixed(6)}，reduce-only IOC 重挂直到归零`,
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
  if (t.strategy === 'funding') return holdingFunding(t, s, set)
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

// Funding-carry HOLDING: we WANT to hold and collect funding. The instantaneous
// hourly carry is NOISY (both venues' predicted rates jump each update), so we do
// NOT exit on a single reading. Instead we track soft_exit_since — the moment the
// live carry first fell ≤ exit threshold — and only exit once it has STAYED there
// continuously for funding_exit_confirm_hours (hysteresis). We also never exit
// before funding_min_hold_hours (barring the hard max-hold safety), so a position
// has time to earn enough funding to beat its round-trip cost. Any recovery of the
// carry back above the exit line resets the confirm timer.
async function holdingFunding(t, s, set) {
  const ticks = t.hold_ticks + 1
  let carry = null
  try {
    const map = await getFundingMap(s)
    carry = carryBpsHr(map.bySymbol.get(String(t.symbol).toUpperCase()), t.sell_venue, t.buy_venue)
  } catch (_) {
    /* funding read failed this tick — hold, retry next tick */
  }
  const hoursHeld = t.created_at ? (Date.now() - Date.parse(t.created_at)) / 3.6e6 : 0
  const maxHours = Number(s.funding_max_hold_hours) || 72
  const exitThresh = Number(s.funding_exit_bps_hr) || 0
  const confirmHours = Math.max(0, Number(s.funding_exit_confirm_hours) || 0)
  const minHold = Math.max(0, Number(s.funding_min_hold_hours) || 0)
  const avgCarry = Math.max(0, ((Number(t.entry_funding_bps_hr) || 0) + exitThresh) / 2)
  const notional = (Number(t.matched_size) || 0) * (Number(t.buy_price) || 0)
  try {
    await recordFundingSettlement(t, carry, notional)
  } catch (_) {
    /* ledger write is best-effort; never block the hold loop */
  }
  const accrued = (notional * avgCarry * hoursHeld) / 10000
  const takerFee = Number(s.taker_fee_bps) || 0
  const roundTripFee = (notional * (takerFee * (s.maker_open ? 1 : 2) + takerFee * 2)) / 10000
  const feesCovered = accrued >= roundTripFee

  // ---- confirm-timer bookkeeping (only when we actually have a fresh reading) ----
  const belowExit = carry != null && carry <= exitThresh
  let softSince = t.soft_exit_since ? Date.parse(t.soft_exit_since) : null
  let softField = '' // extra SQL fragment to persist a change to soft_exit_since
  let softParam = null
  if (carry != null) {
    if (belowExit && softSince == null) {
      softSince = Date.now()
      softField = ', soft_exit_since=now()'
    } else if (!belowExit && softSince != null) {
      softSince = null
      softField = ', soft_exit_since=NULL'
    }
  }
  const confirmedHrs = softSince != null ? (Date.now() - softSince) / 3.6e6 : 0
  const confirmed = softSince != null && confirmedHrs >= confirmHours

  const timeout = hoursHeld >= maxHours
  const beforeMinHold = hoursHeld < minHold
  // Confirmed edge-collapse: carry has stayed ≤ exit line for the confirm window
  // AND accrued funding already covers the round-trip fee → lock in the profit.
  const confirmedCollapse = belowExit && confirmed && feesCovered
  // Confirmed reversal: now PAYING funding, and it has persisted below the line
  // for the confirm window → stop-loss (holding longer only bleeds more).
  const confirmedReversal = carry != null && carry < 0 && confirmed

  const doExit = timeout || (!beforeMinHold && (confirmedCollapse || confirmedReversal))

  if (doExit) {
    const reason = timeout
      ? `资金费持仓超时（${hoursHeld.toFixed(1)}h ≥ ${maxHours}h），平仓退出`
      : confirmedReversal
        ? `费差已连续 ${confirmedHrs.toFixed(1)}h 转为倒付（当前 ${fmt2(carry)} bps/时），确认后止损平仓`
        : `费差已连续 ${confirmedHrs.toFixed(1)}h ≤ 出场线且累计资金费覆盖手续费，落袋平仓`
    await set(`state='EXITING', hold_ticks=$1, note=$2${softField}`, [ticks, reason])
    return
  }

  // Not exiting — persist any soft-timer change and a human-readable status note.
  const carryTxt = carry == null ? '读取中' : fmt2(carry) + ' bps/时'
  let note
  if (beforeMinHold) {
    note = `资金费持仓中（最小持有 ${minHold}h 保护内，已持 ${hoursHeld.toFixed(1)}h）：当前费差 ${carryTxt}，预估累计 ${accrued >= 0 ? '+' : ''}${accrued.toFixed(3)} USD`
  } else if (belowExit) {
    note = `费差已收敛(${carryTxt})，确认计时 ${confirmedHrs.toFixed(1)}/${confirmHours}h${feesCovered ? '' : `，累计资金费 ${accrued.toFixed(3)} 未覆盖手续费 ${roundTripFee.toFixed(3)}`}（已持 ${hoursHeld.toFixed(1)}h）`
  } else {
    note = `资金费对冲持仓中：当前费差 ${carryTxt}，已持 ${hoursHeld.toFixed(1)}h，预估累计 ${accrued >= 0 ? '+' : ''}${accrued.toFixed(3)} USD`
  }
  await set(`hold_ticks=$1, note=$2${softField}`, [ticks, note])
}

function fmt2(n) {
  return Number.isFinite(n) ? n.toFixed(2) : '-'
}

// Record the funding settled for a delta-neutral position at the most recent
// top-of-hour boundary. Funding is credited to whoever holds the position AT the
// hour mark, so we only settle a boundary that (a) is in the past and (b) is
// strictly after entry. The unique (task_id, settled_hour) index makes this
// idempotent — re-running within the same hour is a no-op. We record only the
// single most-recent boundary (never backfill old hours with the current rate)
// so every stored amount reflects the rate that was actually live at that hour.
async function recordFundingSettlement(t, carry, notional) {
  if (carry == null || !Number.isFinite(carry)) return
  if (!Number.isFinite(notional) || notional <= 0) return
  const entrySec = t.created_at ? Math.floor(Date.parse(t.created_at) / 1000) : null
  if (!entrySec) return
  const boundary = Math.floor(Date.now() / 1000 / 3600) * 3600
  if (boundary <= entrySec) return // no full hour held across a settlement yet
  const amount = (carry / 10000) * notional
  await dbQuery(
    `INSERT INTO arb_funding_ledger
       (task_id, symbol, settled_hour, net_bps_hr, notional_usd, amount_usd)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (task_id, settled_hour) DO NOTHING`,
    [t.id, t.symbol, boundary, carry, notional, amount]
  )
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
  if (t.strategy === 'funding') return realizedFundingPnl(t, s, closeTaker)
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

// Funding-carry realized PnL: accrued funding (conservative midpoint estimate)
// minus the round-trip taker fees. Real funding settles on-venue; this is the
// dashboard's indicative number.
function realizedFundingPnl(t, s, closeTaker) {
  const notional = (Number(t.matched_size) || 0) * (Number(t.buy_price) || 0)
  const hoursHeld = t.created_at ? (Date.now() - Date.parse(t.created_at)) / 3.6e6 : 0
  const exitThresh = Number(s.funding_exit_bps_hr) || 0
  const avgCarry = Math.max(0, ((Number(t.entry_funding_bps_hr) || 0) + exitThresh) / 2)
  const accrued = (notional * avgCarry * hoursHeld) / 10000
  const takerFee = Number(s.taker_fee_bps) || 0
  const openFee = takerFee * (s.maker_open ? 1 : 2)
  const closeFee = closeTaker ? takerFee * 2 : 0
  const fees = (notional * (openFee + closeFee)) / 10000
  const pnl = accrued - fees
  const note = `名义 ${notional.toFixed(2)} USD，持 ${hoursHeld.toFixed(1)}h，预估累计资金费 ${accrued.toFixed(3)} − 手续费 ${fees.toFixed(3)} = ${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)} USD`
  return { pnl, note }
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

  // Funding-carry auto-open (Route A main engine). Independent of the price-spread
  // loop above: its own cap (funding_max_positions) and whitelist. Off by default.
  if (s.funding_auto_execute) {
    try {
      await stepFundingOpen(s)
    } catch (e) {
      console.warn('[engine] 资金费自动开仓异常：', e.message || e)
    }
  }

  return summary()
}

// Scan the funding differential and open hedged carry positions for symbols whose
// current hourly carry ≥ funding_enter_bps_hr, up to funding_max_positions. One
// position per symbol; respects the funding whitelist. Called only when
// funding_auto_execute is on.
async function stepFundingOpen(s) {
  const cap = Math.max(1, Number(s.funding_max_positions) || 1)
  const { rows: cnt } = await dbQuery(
    `SELECT count(*)::int AS n FROM arb_tasks WHERE strategy='funding' AND state = ANY($1)`,
    [ACTIVE_STATES]
  )
  let n = cnt[0].n
  if (n >= cap) return
  const map = await getFundingMap(s)
  if (!map.bySymbol.size) return
  const wl = new Set(
    String(s.funding_symbols || '')
      .split(/[,\s]+/)
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean)
  )
  const enter = Number(s.funding_enter_bps_hr) || 0
  const cands = []
  for (const [sym, pair] of map.bySymbol) {
    if (wl.size && !wl.has(sym)) continue
    const bc = bestCarry(pair)
    if (!bc || bc.diff_bps_hr < enter) continue
    cands.push({ sym, pair, diff: bc.diff_bps_hr })
  }
  cands.sort((a, b) => b.diff - a.diff)
  if (!cands.length) return
  // Market indices from the (cached) common-market list. Lazy require avoids the
  // engine⇄runner circular import at module load.
  const { commonMarkets } = require('./runner')
  const common = await commonMarkets(s)
  const idsBy = new Map(common.map((m) => [String(m.symbol).toUpperCase(), m]))
  for (const c of cands) {
    if (n >= cap) break
    const { rows: ex } = await dbQuery(
      `SELECT id FROM arb_tasks WHERE symbol=$1 AND strategy='funding' AND state = ANY($2) LIMIT 1`,
      [c.sym, ACTIVE_STATES]
    )
    if (ex.length) continue
    const ids = idsBy.get(c.sym)
    if (!ids) continue
    const r = await openFundingTask(c.sym, s, c.pair, ids)
    if (r.ok) n++
  }
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

module.exports = { stepEngine, summary, ACTIVE_STATES, openFundingTask }
