const { Router } = require('express')
const { dbQuery } = require('../db')

const router = Router()

// Fields whose values must never be echoed back to the client in cleartext.
const SECRET_FIELDS = [
  'lighter_api_private_key',
  'rblighter_api_private_key',
  'telegram_bot_token',
]

const DEFAULTS = {
  dry_run: true,
  live_trading_ack: false,
  poc_verified: false,
  enable_real_market_streams: false,
  lighter_base_url: 'https://mainnet.zklighter.elliot.ai',
  lighter_ws_url: 'wss://mainnet.zklighter.elliot.ai/stream',
  lighter_account_index: '',
  lighter_api_key_index: '',
  lighter_api_private_key: '',
  rblighter_base_url: 'https://api.rh.lighter.xyz',
  rblighter_ws_url: 'wss://api.rh.lighter.xyz/stream',
  rblighter_account_index: '',
  rblighter_api_key_index: '',
  rblighter_api_private_key: '',
  telegram_bot_token: '',
  telegram_chat_id: '',
  spread_threshold_bps: 5,
  min_samples: 30,
  max_slippage_bps: 3,
  order_notional_usd: 50,
  reduce_only: true,
  ioc_orders: true,
  exit_spread_bps: 1,
  max_hold_ticks: 20,
  auto_execute: true,
  background_enabled: true,
  scan_interval_sec: 8,
  scan_market_limit: 24,
  proxy_url: '',
}

async function ensureRow() {
  const { rows } = await dbQuery('SELECT * FROM arb_settings WHERE id = 1')
  if (rows.length) return rows[0]
  const { rows: inserted } = await dbQuery(
    'INSERT INTO arb_settings (id) VALUES (1) RETURNING *'
  )
  return inserted[0]
}

// Return config with secrets masked so the UI can show "已设置" without leaking keys.
function maskForClient(row) {
  const out = { ...row }
  // Referral-verification feature removed from this build.
  delete out.rblighter_referral_verification_url
  for (const f of SECRET_FIELDS) {
    out[`${f}__set`] = !!(row[f] && String(row[f]).length)
    out[f] = ''
  }
  return out
}

router.get('/', async (_req, res) => {
  try {
    const row = await ensureRow()
    res.json(maskForClient(row))
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

router.put('/', async (req, res) => {
  try {
    await ensureRow()
    const body = req.body || {}
    const cols = []
    const vals = []
    let i = 1
    for (const key of Object.keys(DEFAULTS)) {
      if (!(key in body)) continue
      let value = body[key]
      // Secret fields: empty string means "leave unchanged".
      if (SECRET_FIELDS.includes(key) && (value === '' || value == null)) continue
      cols.push(`${key} = $${i++}`)
      vals.push(value)
    }
    if (!cols.length) {
      const row = await ensureRow()
      return res.json(maskForClient(row))
    }
    cols.push(`updated_at = now()`)
    const { rows } = await dbQuery(
      `UPDATE arb_settings SET ${cols.join(', ')} WHERE id = 1 RETURNING *`,
      vals
    )
    res.json(maskForClient(rows[0]))
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

// Internal helper for other routes that need the full (unmasked) config.
async function loadSettings() {
  return ensureRow()
}

// Connectivity test: hit both venues (through the saved proxy, if any) and
// report reachability + latency so the panel can validate proxy settings.
router.get('/test', async (_req, res) => {
  try {
    const s = await ensureRow()
    const { listOrderBooks } = require('../lib/exchange')
    const probe = async (name, base) => {
      const t0 = Date.now()
      try {
        const books = await listOrderBooks(base, s.proxy_url)
        return { name, ok: true, ms: Date.now() - t0, markets: books.length }
      } catch (e) {
        return { name, ok: false, ms: Date.now() - t0, error: String(e.message || e) }
      }
    }
    const [lighter, rblighter] = await Promise.all([
      probe('Lighter', s.lighter_base_url),
      probe('RBLighter', s.rblighter_base_url),
    ])
    res.json({ proxy_enabled: !!s.proxy_url, lighter, rblighter })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

module.exports = router
module.exports.loadSettings = loadSettings
