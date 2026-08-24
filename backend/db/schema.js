const {
  pgTable,
  serial,
  text,
  boolean,
  integer,
  doublePrecision,
  timestamp,
  bigint,
  uniqueIndex,
} = require('drizzle-orm/pg-core')

// Single-row (id=1) configuration mirroring the original .env surface.
exports.settings = pgTable('arb_settings', {
  id: integer('id').primaryKey().default(1),

  // ---- Safety switches (original .env defaults) ----
  dry_run: boolean('dry_run').notNull().default(true),
  live_trading_ack: boolean('live_trading_ack').notNull().default(false),
  poc_verified: boolean('poc_verified').notNull().default(false),
  enable_real_market_streams: boolean('enable_real_market_streams').notNull().default(false),

  // ---- Lighter account ----
  lighter_base_url: text('lighter_base_url').notNull().default('https://mainnet.zklighter.elliot.ai'),
  lighter_ws_url: text('lighter_ws_url').notNull().default('wss://mainnet.zklighter.elliot.ai/stream'),
  lighter_account_index: text('lighter_account_index').default(''),
  lighter_api_key_index: text('lighter_api_key_index').default(''),
  lighter_api_private_key: text('lighter_api_private_key').default(''),

  // ---- RBLighter account ----
  rblighter_base_url: text('rblighter_base_url').notNull().default('https://api.rh.lighter.xyz'),
  rblighter_ws_url: text('rblighter_ws_url').notNull().default('wss://api.rh.lighter.xyz/stream'),
  rblighter_account_index: text('rblighter_account_index').default(''),
  rblighter_api_key_index: text('rblighter_api_key_index').default(''),
  rblighter_api_private_key: text('rblighter_api_private_key').default(''),
  // NOTE: referral verification service intentionally removed from this build.

  // ---- Optional notifications ----
  telegram_bot_token: text('telegram_bot_token').default(''),
  telegram_chat_id: text('telegram_chat_id').default(''),

  // ---- Strategy parameters ----
  spread_threshold_bps: doublePrecision('spread_threshold_bps').notNull().default(5),
  min_samples: integer('min_samples').notNull().default(30),
  max_slippage_bps: doublePrecision('max_slippage_bps').notNull().default(3),
  order_notional_usd: doublePrecision('order_notional_usd').notNull().default(50),
  min_depth_ratio: doublePrecision('min_depth_ratio').notNull().default(1),
  taker_fee_bps: doublePrecision('taker_fee_bps').notNull().default(2),
  reduce_only: boolean('reduce_only').notNull().default(true),
  ioc_orders: boolean('ioc_orders').notNull().default(true),
  // Maker close-out: rest reduce-only post-only orders (0 fee) instead of taker
  // IOC when unwinding a hedged position. Falls back to taker after the wait window.
  maker_close: boolean('maker_close').notNull().default(false),
  maker_close_wait_ticks: integer('maker_close_wait_ticks').notNull().default(20),
  // ---- Maker open: rest a passive post-only quote on the buy leg (0 fee), taker-hedge
  // the sell leg on fill. Cuts open cost from 2 taker legs to 1.
  maker_open: boolean('maker_open').notNull().default(true),
  maker_open_wait_ticks: integer('maker_open_wait_ticks').notNull().default(20),
  exit_spread_bps: doublePrecision('exit_spread_bps').notNull().default(1),
  max_hold_ticks: integer('max_hold_ticks').notNull().default(20),
  auto_execute: boolean('auto_execute').notNull().default(true),

  // ---- Funding-carry strategy (Route A) ----
  // Delta-neutral funding arbitrage: hold a hedged pair to collect the hourly
  // funding-rate differential; exit only when the edge collapses. Low churn.
  funding_auto_execute: boolean('funding_auto_execute').notNull().default(false),
  funding_enter_bps_hr: doublePrecision('funding_enter_bps_hr').notNull().default(1.0), // open when carry ≥ this (bps/hr)
  funding_exit_bps_hr: doublePrecision('funding_exit_bps_hr').notNull().default(0.2), // close when carry ≤ this (bps/hr)
  funding_symbols: text('funding_symbols').notNull().default(''), // whitelist, e.g. "BTC,ETH,SOL"; empty = any paired
  funding_max_positions: integer('funding_max_positions').notNull().default(1),
  funding_max_hold_hours: doublePrecision('funding_max_hold_hours').notNull().default(72), // safety cap
  // Exit de-noising: the instantaneous per-hour funding differential is very
  // jumpy (both venues' predicted rates oscillate each update). Don't exit on a
  // single reading — require the carry to stay ≤ exit threshold continuously for
  // this many HOURS before actually closing (hysteresis confirm). And never exit
  // (barring the hard max-hold safety) before a minimum hold, so a position has
  // time to collect enough funding to beat its round-trip cost.
  funding_exit_confirm_hours: doublePrecision('funding_exit_confirm_hours').notNull().default(2),
  funding_min_hold_hours: doublePrecision('funding_min_hold_hours').notNull().default(2),

  // Start-simple controls: trade only one market, hold at most N positions at once.
  focus_symbol: text('focus_symbol').notNull().default(''),
  // Optional scan whitelist (comma/space separated symbols, e.g. "BTC,ETH"). When
  // set, ONLY these markets are scanned/sampled — far fewer requests per round, so
  // rounds finish fast and the min-sample gate is actually reachable. Empty = all.
  scan_symbols: text('scan_symbols').notNull().default(''),
  max_concurrent_tasks: integer('max_concurrent_tasks').notNull().default(1),
  background_enabled: boolean('background_enabled').notNull().default(true),
  scan_interval_sec: integer('scan_interval_sec').notNull().default(8),
  scan_market_limit: integer('scan_market_limit').notNull().default(24),

  // ---- Network ----
  // Optional HTTP/HTTPS/SOCKS proxy for all exchange API calls.
  // e.g. http://user:pass@host:port  or  socks5://host:1080
  proxy_url: text('proxy_url').default(''),

  updated_at: timestamp('updated_at').defaultNow(),
})

// Rolling window of observed spreads used to enforce the min-sample gate.
exports.spread_samples = pgTable('arb_spread_samples', {
  id: serial('id').primaryKey(),
  symbol: text('symbol').notNull(),
  direction: text('direction').notNull(), // 'buy_lighter' | 'buy_rblighter'
  spread_bps: doublePrecision('spread_bps').notNull(),
  created_at: timestamp('created_at').defaultNow(),
})

// Entry signals emitted when spread exceeds threshold after min samples.
exports.signals = pgTable('arb_signals', {
  id: serial('id').primaryKey(),
  symbol: text('symbol').notNull(),
  direction: text('direction').notNull(),
  spread_bps: doublePrecision('spread_bps').notNull(),
  buy_venue: text('buy_venue').notNull(),
  sell_venue: text('sell_venue').notNull(),
  buy_price: doublePrecision('buy_price'),
  sell_price: doublePrecision('sell_price'),
  samples: integer('samples').notNull().default(0),
  dry_run: boolean('dry_run').notNull().default(true),
  created_at: timestamp('created_at').defaultNow(),
})

// Arbitrage task lifecycle (simulated two-leg execution, DRY_RUN).
// States: ENTERING -> RECONCILING -> HOLDING -> EXITING -> CLOSED
//         plus ERROR (both legs failed), PAUSED (ambiguous after restart)
exports.tasks = pgTable('arb_tasks', {
  id: serial('id').primaryKey(),
  symbol: text('symbol').notNull(),
  direction: text('direction').notNull(),
  state: text('state').notNull().default('ENTERING'),
  buy_venue: text('buy_venue').notNull(),
  sell_venue: text('sell_venue').notNull(),
  buy_price: doublePrecision('buy_price'),
  sell_price: doublePrecision('sell_price'),
  size: doublePrecision('size').notNull().default(0),
  filled_buy: doublePrecision('filled_buy').notNull().default(0),
  filled_sell: doublePrecision('filled_sell').notNull().default(0),
  matched_size: doublePrecision('matched_size').notNull().default(0),
  entry_spread_bps: doublePrecision('entry_spread_bps').notNull().default(0),
  exit_spread_bps: doublePrecision('exit_spread_bps'),
  hold_ticks: integer('hold_ticks').notNull().default(0),
  pnl_usd: doublePrecision('pnl_usd'),
  note: text('note').default(''),
  dry_run: boolean('dry_run').notNull().default(true),

  // ---- Real-execution fields (populated only when routed through the sidecar) ----
  exec_mode: text('exec_mode').notNull().default('sim'), // 'sim' | 'live'
  buy_market_index: integer('buy_market_index'),
  sell_market_index: integer('sell_market_index'),
  pre_buy_pos: doublePrecision('pre_buy_pos'),   // buy-venue position snapshot before entry
  pre_sell_pos: doublePrecision('pre_sell_pos'), // sell-venue position snapshot before entry
  buy_ack: text('buy_ack'),   // sidecar order response for the buy leg
  sell_ack: text('sell_ack'), // sidecar order response for the sell leg
  entry_ticks: integer('entry_ticks').notNull().default(0), // maker open-quote poll counter
  exit_ticks: integer('exit_ticks').notNull().default(0), // maker close-out poll counter

  // ---- Strategy tag + funding-carry fields ----
  strategy: text('strategy').notNull().default('spread'), // 'spread' | 'funding'
  entry_funding_bps_hr: doublePrecision('entry_funding_bps_hr'), // hourly carry captured at open (funding tasks)
  // Timestamp when the live carry first dropped ≤ exit threshold. Cleared the
  // moment carry recovers above it. Exit only fires once this has persisted for
  // funding_exit_confirm_hours — de-noises the jumpy hourly differential.
  soft_exit_since: timestamp('soft_exit_since'),


  created_at: timestamp('created_at').defaultNow(),
  updated_at: timestamp('updated_at').defaultNow(),
  closed_at: timestamp('closed_at'),
})

// Real funding settlements accrued while holding a delta-neutral funding-carry
// position. One row per (task, hourly-settlement). Written by the engine at each
// top-of-hour boundary using the SAME live net-carry the panel displays, so the
// running tally is internally consistent with the rest of the app (no per-account
// auth needed). amount_usd = net_bps_hr / 10000 * notional_usd  (signed).
exports.funding_ledger = pgTable(
  'arb_funding_ledger',
  {
    id: serial('id').primaryKey(),
    task_id: integer('task_id').notNull(),
    symbol: text('symbol').notNull(),
    settled_hour: bigint('settled_hour', { mode: 'number' }).notNull(), // unix seconds of the settled hour boundary
    net_bps_hr: doublePrecision('net_bps_hr').notNull(), // live net carry captured at settlement (bps/hr)
    notional_usd: doublePrecision('notional_usd').notNull(),
    amount_usd: doublePrecision('amount_usd').notNull(), // signed funding for this hour
    created_at: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    // Never double-count the same hour for the same position.
    uniq: uniqueIndex('arb_funding_ledger_task_hour').on(t.task_id, t.settled_hour),
  })
)

// Periodic snapshots of BOTH venues' account equity (total_asset_value), written
// by the background runner from the sidecar. The delta between the earliest and
// the latest snapshot is the TRUE net P&L (trading + funding + everything), which
// is exactly what the account balance reflects — so the dashboard can finally
// show "why the balance moves" instead of only open-position PnL that resets on
// close. No deposits/withdrawals are assumed during operation.
exports.equity_snapshots = pgTable('arb_equity_snapshots', {
  id: serial('id').primaryKey(),
  at: timestamp('at').defaultNow(),
  lighter_equity: doublePrecision('lighter_equity'),
  rblighter_equity: doublePrecision('rblighter_equity'),
  total_equity: doublePrecision('total_equity').notNull(),
  lighter_available: doublePrecision('lighter_available'),
  rblighter_available: doublePrecision('rblighter_available'),
})
