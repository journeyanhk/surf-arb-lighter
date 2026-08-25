// Opportunity tracker — owns the latest cross-venue snapshot AND measures how
// long each funding-carry opportunity has PERSISTED above a reference threshold.
//
// Persistence is the whole point of the monitor: a funding diff that just spiked
// for one refresh is noise; one that has held for 30-60 min is a real, harvestable
// edge. We keep an in-memory streak map keyed by symbol+direction: the moment a
// pair's diff crosses the reference threshold we stamp `since`; while it stays
// above we keep that stamp (so age grows); when it drops below we clear it.
//
// Runs on a fixed cadence from the background runner so the clock is steady even
// when no page is open — which is also exactly what the future alert hook needs.

const { snapshotAll } = require('./venues')
const { buildOpportunities } = require('./opportunities')

// key -> { since: ms, lastDiff: bps }
const streaks = new Map()
let latest = null // { rows, venues, errors, updated_at }
let lastError = null

const keyOf = (r) =>
  r.funding ? `${r.symbol}|${r.funding.short_venue_id}>${r.funding.long_venue_id}` : null

// Reference threshold for "is this opportunity live": use the configured enter
// threshold, with a small floor so near-zero noise doesn't start a streak.
function refThreshold(s) {
  const t = Number(s.funding_enter_bps_hr)
  return Number.isFinite(t) && t > 0 ? t : 1.0
}

// Pull a fresh multi-venue snapshot, rebuild opportunities, update streaks, and
// annotate each row with persistence (minutes it's been above threshold). Never
// throws — records lastError and keeps the previous good snapshot on failure.
async function refresh(s) {
  try {
    const { venues, byVenue, errors } = await snapshotAll(s)
    const rows = buildOpportunities(byVenue, venues)
    const ref = refThreshold(s)
    const now = Date.now()
    const seen = new Set()

    for (const r of rows) {
      const k = keyOf(r)
      if (!k) continue
      const live = r.funding && r.funding.diff_bps_hr >= ref
      if (live) {
        seen.add(k)
        const prev = streaks.get(k)
        if (prev) prev.lastDiff = r.funding.diff_bps_hr
        else streaks.set(k, { since: now, lastDiff: r.funding.diff_bps_hr })
        const since = streaks.get(k).since
        r.persistence_min = Math.round((now - since) / 60000)
        r.persistence_since = new Date(since).toISOString()
      } else {
        r.persistence_min = 0
        r.persistence_since = null
      }
    }
    // Drop streaks whose direction is no longer live (fell below threshold or
    // flipped), so age resets correctly next time it reappears.
    for (const k of [...streaks.keys()]) if (!seen.has(k)) streaks.delete(k)

    latest = { rows, venues, errors, ref_bps_hr: ref, updated_at: new Date().toISOString() }
    lastError = null
    return latest
  } catch (e) {
    lastError = String(e.message || e)
    return latest // keep last good
  }
}

function getLatest() {
  return latest
}
function getError() {
  return lastError
}

module.exports = { refresh, getLatest, getError }
