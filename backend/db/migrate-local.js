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
     reduce_only boolean NOT NULL DEFAULT true,
     ioc_orders boolean NOT NULL DEFAULT true,
     exit_spread_bps double precision NOT NULL DEFAULT 1,
     max_hold_ticks integer NOT NULL DEFAULT 20,
     auto_execute boolean NOT NULL DEFAULT true,
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
  `ALTER TABLE arb_tasks      ADD COLUMN IF NOT EXISTS exec_mode text NOT NULL DEFAULT 'sim'`,
  `ALTER TABLE arb_tasks      ADD COLUMN IF NOT EXISTS buy_market_index integer`,
  `ALTER TABLE arb_tasks      ADD COLUMN IF NOT EXISTS sell_market_index integer`,
  `ALTER TABLE arb_tasks      ADD COLUMN IF NOT EXISTS pre_buy_pos double precision`,
  `ALTER TABLE arb_tasks      ADD COLUMN IF NOT EXISTS pre_sell_pos double precision`,
  `ALTER TABLE arb_tasks      ADD COLUMN IF NOT EXISTS buy_ack text`,
  `ALTER TABLE arb_tasks      ADD COLUMN IF NOT EXISTS sell_ack text`,

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
