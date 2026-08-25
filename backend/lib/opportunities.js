// Cross-venue opportunity engine — the heart of the monitor.
//
// Given every venue's uniform snapshot (from venues.js), for each symbol that
// trades on >= 2 venues we compute the two kinds of edge:
//
//   1) FUNDING CARRY (the persistent edge): short the venue with the HIGHEST
//      funding, long the venue with the LOWEST. Net hourly carry (bps) =
//      (fundingHigh - fundingLow) * 10000. Annualize to APR for ranking.
//
//   2) PRICE BASIS (the fleeting edge): the max mark-price gap across venues,
//      in bps. buy the cheap venue, sell the rich one. Shown as secondary.
//
// Everything is venue-agnostic: it loops the byVenue map, so new DEXes light up
// automatically. No execution here — pure read + rank.

// bps helpers
const toBps = (frac) => frac * 10000

// Build per-symbol rows from the multi-venue snapshot.
//   byVenue: Map(venueId -> Map(SYMBOL -> { funding, bid, ask, mark }))
//   venueMeta: [{ id, name }]  (for labels)
function buildOpportunities(byVenue, venueMeta) {
  // Invert: symbol -> [{ venueId, name, funding, mark, bid, ask }]
  const bySymbol = new Map()
  const nameOf = new Map(venueMeta.map((v) => [v.id, v.name]))
  for (const [venueId, quotes] of byVenue) {
    for (const [sym, q] of quotes) {
      if (!bySymbol.has(sym)) bySymbol.set(sym, [])
      bySymbol.get(sym).push({ venueId, name: nameOf.get(venueId) || venueId, ...q })
    }
  }

  const rows = []
  for (const [sym, legs] of bySymbol) {
    if (legs.length < 2) continue // need at least two venues to arbitrage

    // ---- Funding carry: short highest funding, long lowest ----
    const withFunding = legs.filter((l) => Number.isFinite(l.funding))
    let funding = null
    if (withFunding.length >= 2) {
      let hi = withFunding[0]
      let lo = withFunding[0]
      for (const l of withFunding) {
        if (l.funding > hi.funding) hi = l
        if (l.funding < lo.funding) lo = l
      }
      const diffBpsHr = toBps(hi.funding - lo.funding)
      funding = {
        short_venue: hi.name,
        short_venue_id: hi.venueId,
        long_venue: lo.name,
        long_venue_id: lo.venueId,
        short_funding_bps_hr: toBps(hi.funding),
        long_funding_bps_hr: toBps(lo.funding),
        diff_bps_hr: diffBpsHr, // net hourly carry you collect
        daily_pct: (diffBpsHr / 100) * 24,
        apr_pct: (diffBpsHr / 100) * 24 * 365,
      }
    }

    // ---- Price basis: max mark gap across venues ----
    const withMark = legs.filter((l) => Number.isFinite(l.mark) && l.mark > 0)
    let basis = null
    if (withMark.length >= 2) {
      let cheap = withMark[0]
      let rich = withMark[0]
      for (const l of withMark) {
        if (l.mark < cheap.mark) cheap = l
        if (l.mark > rich.mark) rich = l
      }
      const mid = (rich.mark + cheap.mark) / 2
      basis = {
        buy_venue: cheap.name,
        buy_venue_id: cheap.venueId,
        sell_venue: rich.name,
        sell_venue_id: rich.venueId,
        buy_price: cheap.mark,
        sell_price: rich.mark,
        spread_bps: mid > 0 ? ((rich.mark - cheap.mark) / mid) * 10000 : 0,
      }
    }

    if (!funding && !basis) continue
    rows.push({
      symbol: sym,
      venues: legs.map((l) => ({
        id: l.venueId,
        name: l.name,
        funding_bps_hr: Number.isFinite(l.funding) ? toBps(l.funding) : null,
        mark: Number.isFinite(l.mark) ? l.mark : null,
        bid: Number.isFinite(l.bid) ? l.bid : null,
        ask: Number.isFinite(l.ask) ? l.ask : null,
      })),
      venue_count: legs.length,
      funding,
      basis,
      // Primary ranking key: annualized funding carry (the real edge).
      score_apr: funding ? funding.apr_pct : 0,
    })
  }

  rows.sort((a, b) => b.score_apr - a.score_apr)
  return rows
}

module.exports = { buildOpportunities }
