// Real account overview — both venues' balances + current trading P&L, pulled
// live from the signing sidecar (which reads each exchange account directly).
//
// This is the "真实盈亏" ground truth for the delta-neutral carry strategy:
//   trading_pnl = Σ(unrealized_pnl + realized_pnl) over open positions  (price/basis)
//   + funding (shown separately by the funding-income panel)            (funding)
// Balances (total_asset_value / available_balance / collateral) come from the same
// snapshot, so one call powers both the balance card and the P&L combination.
const { Router } = require('express')
const sidecar = require('../lib/sidecar')

const router = Router()

function shape(v) {
  const a = v && v.account
  if (!a || a.error) return { ok: false, error: (a && a.error) || '账户未就绪' }
  return {
    ok: true,
    account_index: a.account_index,
    status: a.status,
    total_asset_value: Number(a.total_asset_value) || 0,
    available_balance: Number(a.available_balance) || 0,
    collateral: Number(a.collateral) || 0,
    unrealized_pnl: Number(a.unrealized_pnl) || 0,
    realized_pnl: Number(a.realized_pnl) || 0,
    trading_pnl: Number(a.trading_pnl) || 0,
    open_positions: Number(a.open_positions) || 0,
    positions: Array.isArray(a.positions) ? a.positions : [],
  }
}

router.get('/', async (_req, res) => {
  try {
    if (!sidecar.configured()) {
      return res.json({ configured: false, note: '未配置签名边车，无法读取账户余额与盈亏' })
    }
    const h = await sidecar.health()
    if (!h || !h.ok) {
      return res.json({ configured: true, ok: false, error: (h && h.error) || '边车未就绪' })
    }
    const venues = h.venues || {}
    const lighter = shape(venues.lighter)
    const rblighter = shape(venues.rblighter)
    const equity =
      (lighter.ok ? lighter.total_asset_value : 0) + (rblighter.ok ? rblighter.total_asset_value : 0)
    const tradingPnl =
      (lighter.ok ? lighter.trading_pnl : 0) + (rblighter.ok ? rblighter.trading_pnl : 0)
    res.json({
      configured: true,
      ok: true,
      dry_run: h.dry_run,
      lighter,
      rblighter,
      total_equity_usd: equity,
      total_trading_pnl_usd: tradingPnl,
      updated_at: new Date().toISOString(),
    })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

module.exports = router
