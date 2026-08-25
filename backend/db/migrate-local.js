// Local Postgres schema migration (self-hosted VPS path only).
//
// Runs on startup when DATABASE_URL is set. Idempotent: CREATE TABLE IF NOT
// EXISTS for the four tables, then ADD COLUMN IF NOT EXISTS for fields added in
// later versions, so upgrading an existing local DB is safe. Mirrors
// backend/db/schema.js exactly (that file remains the source of truth for the
// Surf-managed path).

const { dbQuery } = require('./index')

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS arb_settings (
     id integer PRIMARY KEY DEFAULT 1,
     dry_run boolean NOT NULL DEFAULT true,
     live_trading_ack boolean NOT NULL DEFAULT false,
     poc_verified boolean NOT NULL DEFAULT false,
     enable_real_market_streams boolean NOT NULL DEFAULT false,
     lighter_base_url text NOT NULL DEFAULT 'https://mainnet.zklighter.elliot.ai',
     lighter_ws_url text NOT NULL DEFAULT 'wss://mainnet.zklighter.elliot.ai/stream',
     lighter_account_index text DEFAULT '',
     lighter_api_key_index text DEFAULT '',
     lighter_api_private_key text DEFAULT '',
     rblighter_base_url text NOT NULL DEFAULT 'https://api.rh.lighter.xyz',
     rblighter_ws_url text NOT NULL DEFAULT 'wss://api.rh.lighter.xyz/stream',
     rblighter_account_index text DEFAULT '',
     rblighter_api_key_index text DEFAULT '',
     rblighter_api_private_key text DEFAULT '',
     telegram_bot_token text DEFAULT '',
     telegram_chat_id text DEFAULT '',
     spread_threshold_bps double precision NOT NULL DEFAULT 5,
     min_samples integer NOT NULL DEFAULT 30,
     max_slippage_bps double precision NOT NULL DEFAULT 3,
     order_notional_usd double precision NOT NULL DEFAULT 50,
     min_depth_ratio double precision NOT NULL DEFAULT 1,
     taker_fee_bps double precision NOT NULL DEFAULT 2,
     reduce_only boolean NOT NULL DEFAULT true,
     ioc_orders boolean NOT NULL DEFAULT true,
     maker_close boolean NOT NULL DEFAULT false,
     maker_close_wait_ticks integer NOT NULL DEFAULT 20,
     maker_open boolean NOT NULL DEFAULT false,
     maker_open_wait_ticks integer NOT NULL DEFAULT 20,
     exit_spread_bps double precision NOT NULL DEFAULT 1,
     max_hold_ticks integer NOT NULL DEFAULT 20,
     auto_execute boolean NOT NULL DEFAULT true,
     focus_symbol text NOT NULL DEFAULT '',
     scan_symbols text NOT NULL DEFAULT '',
     max_concurrent_tasks integer NOT NULL DEFAULT 1,
     background_enabled boolean NOT NULL DEFAULT true,
     scan_interval_sec integer NOT NULL DEFAULT 8,
     scan_market_limit integer NOT NULL DEFAULT 24,
     proxy_url text DEFAULT '',
     updated_at timestamp DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS arb_spread_samples (
     id serial PRIMARY KEY,
     symbol text NOT NULL,
     direction text NOT NULL,
     spread_bps double precision NOT NULL,
     created_at timestamp DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS arb_signals (
     id serial PRIMARY KEY,
     symbol text NOT NULL,
     direction text NOT NULL,
     spread_bps double precision NOT NULL,
     buy_venue text NOT NULL,
     sell_venue text NOT NULL,
     buy_price double precision,
     sell_price double precision,
     samples integer NOT NULL DEFAULT 0,
     dry_run boolean NOT NULL DEFAULT true,
     created_at timestamp DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS arb_tasks (
     id serial PRIMARY KEY,
     symbol text NOT NULL,
     direction text NOT NULL,
     state text NOT NULL DEFAULT 'ENTERING',
     buy_venue text NOT NULL,
     sell_venue text NOT NULL,
     buy_price double precision,
     sell_price double precision,
     size double precision NOT NULL DEFAULT 0,
     filled_buy double precision NOT NULL DEFAULT 0,
     filled_sell double precision NOT NULL DEFAULT 0,
     matched_size double precision NOT NULL DEFAULT 0,
     entry_spread_bps double precision NOT NULL DEFAULT 0,
     exit_spread_bps double precision,
     hold_ticks integer NOT NULL DEFAULT 0,
     pnl_usd double precision,
     note text DEFAULT '',
     dry_run boolean NOT NULL DEFAULT true,
     exec_mode text NOT NULL DEFAULT 'sim',
     buy_market_index integer,
     sell_market_index integer,
     pre_buy_pos double precision,
     pre_sell_pos double precision,
     buy_ack text,
     sell_ack text,
     entry_ticks integer NOT NULL DEFAULT 0,
     exit_ticks integer NOT NULL DEFAULT 0,
     created_at timestamp DEFAULT now(),
     updated_at timestamp DEFAULT now(),
     closed_at timestamp
   )`,

  // Upgrade safety: columns added after the first release.
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS proxy_url text DEFAULT ''`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS scan_interval_sec integer NOT NULL DEFAULT 8`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS scan_market_limit integer NOT NULL DEFAULT 24`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS background_enabled boolean NOT NULL DEFAULT true`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS min_depth_ratio double precision NOT NULL DEFAULT 1`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS taker_fee_bps double precision NOT NULL DEFAULT 2`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS maker_close boolean NOT NULL DEFAULT false`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS maker_close_wait_ticks integer NOT NULL DEFAULT 20`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS maker_open boolean NOT NULL DEFAULT false`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS maker_open_wait_ticks integer NOT NULL DEFAULT 20`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS focus_symbol text NOT NULL DEFAULT ''`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS scan_symbols text NOT NULL DEFAULT ''`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS max_concurrent_tasks integer NOT NULL DEFAULT 1`,
  `ALTER TABLE arb_tasks      ADD COLUMN IF NOT EXISTS exec_mode text NOT NULL DEFAULT 'sim'`,
  `ALTER TABLE arb_tasks      ADD COLUMN IF NOT EXISTS buy_market_index integer`,
  `ALTER TABLE arb_tasks      ADD COLUMN IF NOT EXISTS sell_market_index integer`,
  `ALTER TABLE arb_tasks      ADD COLUMN IF NOT EXISTS pre_buy_pos double precision`,
  `ALTER TABLE arb_tasks      ADD COLUMN IF NOT EXISTS pre_sell_pos double precision`,
  `ALTER TABLE arb_tasks      ADD COLUMN IF NOT EXISTS buy_ack text`,
  `ALTER TABLE arb_tasks      ADD COLUMN IF NOT EXISTS sell_ack text`,
  `ALTER TABLE arb_tasks      ADD COLUMN IF NOT EXISTS entry_ticks integer NOT NULL DEFAULT 0`,
  `ALTER TABLE arb_tasks      ADD COLUMN IF NOT EXISTS exit_ticks integer NOT NULL DEFAULT 0`,
  `ALTER TABLE arb_tasks      ADD COLUMN IF NOT EXISTS strategy text NOT NULL DEFAULT 'spread'`,
  `ALTER TABLE arb_tasks      ADD COLUMN IF NOT EXISTS entry_funding_bps_hr double precision`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS funding_auto_execute boolean NOT NULL DEFAULT false`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS funding_enter_bps_hr double precision NOT NULL DEFAULT 1.0`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS funding_exit_bps_hr double precision NOT NULL DEFAULT 0.2`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS funding_symbols text NOT NULL DEFAULT ''`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS funding_max_positions integer NOT NULL DEFAULT 1`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS funding_max_hold_hours double precision NOT NULL DEFAULT 72`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS funding_exit_confirm_hours double precision NOT NULL DEFAULT 2`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS funding_min_hold_hours double precision NOT NULL DEFAULT 2`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS extended_base_url text NOT NULL DEFAULT 'https://api.starknet.extended.exchange'`,
  `ALTER TABLE arb_tasks      ADD COLUMN IF NOT EXISTS soft_exit_since timestamp`,

  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS serverchan_sendkey text DEFAULT ''`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS alert_enabled boolean NOT NULL DEFAULT false`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS alert_symbols text NOT NULL DEFAULT 'BTC,ETH,SOL,CRCL,COIN,CRWV,BE,TSLA,AMD,AAPL,AMZN,MSFT,INTC,MU,PLTR'`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS alert_min_apr double precision NOT NULL DEFAULT 300`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS alert_min_persist_min double precision NOT NULL DEFAULT 30`,
  `ALTER TABLE arb_settings   ADD COLUMN IF NOT EXISTS alert_cooldown_min double precision NOT NULL DEFAULT 60`,

  `CREATE TABLE IF NOT EXISTS arb_equity_snapshots (
     id serial PRIMARY KEY,
     at timestamp DEFAULT now(),
     lighter_equity double precision,
     rblighter_equity double precision,
     total_equity double precision NOT NULL,
     lighter_available double precision,
     rblighter_available double precision
   )`,

  `CREATE TABLE IF NOT EXISTS arb_alert_log (
     id serial PRIMARY KEY,
     at timestamp DEFAULT now(),
     akey text NOT NULL,
     symbol text,
     apr_pct double precision,
     diff_bps_hr double precision,
     persistence_min double precision
   )`,


  // Ensure the single settings row exists.
  `INSERT INTO arb_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
]

async function migrate() {
  for (const sql of STATEMENTS) {
    await dbQuery(sql)
  }
  console.log('[db] local schema migration complete')
}

module.exports = { migrate }
