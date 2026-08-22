// Shared funding-rate data + carry math, used by BOTH the /monitor/funding view
// and the funding-carry execution engine so they always agree on numbers.
//
// Each venue's /api/v1/funding-rates returns an aggregated list spanning several
// exchanges; we keep only the venue's own native rows (exchange == 'lighter').
//   rate: decimal fraction PER 1-HOUR interval (0.0001 = 1bp). +rate => longs pay shorts.
//
// Carry mechanic (delta-neutral): you SHORT the higher-funding venue (shorts
// receive) and LONG the lower-funding venue (longs pay the smaller rate). Net
// hourly carry = rate[short_venue] - rate[long_venue]  (positive => you earn).

const { fundingRates } = require('./exchange')

let cache = { at: 0, data: null }

// Returns { at, bySymbol: Map(SYMBOL -> { lighter, rblighter }), errors: [] }.
// Cached ~25s: funding changes slowly, no need to hammer the venues each tick.
async function getFundingMap(s, { maxAgeMs = 25000 } = {}) {
  if (cache.data && Date.now() - cache.at < maxAgeMs) return cache.data
  const [lr, rr] = await Promise.allSettled([
    fundingRates(s.lighter_base_url, s.proxy_url),
    fundingRates(s.rblighter_base_url, s.proxy_url),
  ])
  const errors = []
  if (lr.status === 'rejected') errors.push(`Lighter: ${String(lr.reason?.message || lr.reason)}`)
  if (rr.status === 'rejected') errors.push(`RBLighter: ${String(rr.reason?.message || rr.reason)}`)
  const lf = lr.status === 'fulfilled' ? lr.value : new Map()
  const rf = rr.status === 'fulfilled' ? rr.value : new Map()
  const bySymbol = new Map()
  for (const [sym, l] of lf) {
    const r = rf.get(sym)
    if (!r) continue // only symbols on BOTH venues form a tradeable pair
    bySymbol.set(sym, { lighter: l.rate, rblighter: r.rate })
  }
  const data = { at: Date.now(), bySymbol, errors }
  // Only overwrite the cache when at least one venue answered — otherwise keep
  // the previous good snapshot so a transient blip doesn't blank the engine.
  if (bySymbol.size || !cache.data) cache = { at: Date.now(), data }
  return data
}

// Signed hourly carry (in bps) for a position that is SHORT `shortVenue` and
// LONG `longVenue`, given a { lighter, rblighter } rate pair. Positive = earning.
function carryBpsHr(pair, shortVenue, longVenue) {
  if (!pair) return null
  const rateOf = (v) => (String(v).toLowerCase().startsWith('rb') ? pair.rblighter : pair.lighter)
  const short = rateOf(shortVenue)
  const long = rateOf(longVenue)
  if (!Number.isFinite(short) || !Number.isFinite(long)) return null
  return (short - long) * 10000
}

// Best delta-neutral opportunity for a symbol RIGHT NOW: which venue to short,
// which to long, and the current hourly carry (always >= 0 by construction).
function bestCarry(pair) {
  if (!pair) return null
  const shortHigher = pair.lighter > pair.rblighter
  const shortVenue = shortHigher ? 'Lighter' : 'RBLighter'
  const longVenue = shortHigher ? 'RBLighter' : 'Lighter'
  return {
    short_venue: shortVenue,
    long_venue: longVenue,
    diff_bps_hr: Math.abs(pair.lighter - pair.rblighter) * 10000,
    lighter_bps_hr: pair.lighter * 10000,
    rblighter_bps_hr: pair.rblighter * 10000,
  }
}

module.exports = { getFundingMap, carryBpsHr, bestCarry }
