// Alert engine — pushes cross-venue funding-carry opportunities to Server酱
// (ServerChan Turbo) when they clear BOTH the APR bar and the persistence bar.
//
// Design: persistence is the anti-noise gate. We never notify a fresh spike;
// only an edge that has held above threshold for `alert_min_persist_min` minutes
// qualifies. A per-opportunity cooldown (keyed by symbol+direction, stored in
// arb_alert_log so it survives restarts) prevents re-notifying the same edge on
// every 45s refresh. Multiple qualifying opps are batched into ONE push.

const { dbQuery } = require('../db')
const { normSymbol } = require('./venues')

// Server酱 Turbo: POST https://sctapi.ftqq.com/<SendKey>.send  (form: title, desp)
// Success => JSON { code: 0, ... }. SendKeys starting with "sctp" use a
// per-key host (<id>.push.ftqq.com); we detect that and route accordingly.
async function sendServerChan(sendkey, title, desp) {
  const key = String(sendkey || '').trim()
  if (!key) throw new Error('未填写 Server酱 SendKey')
  const m = key.match(/^sctp(\d+)t/)
  const url = m
    ? `https://${m[1]}.push.ftqq.com/${key}.send`
    : `https://sctapi.ftqq.com/${key}.send`
  const body = new URLSearchParams({ title: title.slice(0, 100), desp }).toString()
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 12000)
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: ctrl.signal,
    })
    let j = {}
    try {
      j = await r.json()
    } catch (_) {
      /* some gateways return non-JSON on error */
    }
    if (!r.ok || (j.code !== undefined && j.code !== 0)) {
      throw new Error(j.message || j.info || `HTTP ${r.status}`)
    }
    return { ok: true, pushid: j.data?.pushid }
  } finally {
    clearTimeout(t)
  }
}

const aprLine = (r) =>
  `- **${r.symbol}**：年化 ${Math.round(r.funding.apr_pct)}%（费差 ${r.funding.diff_bps_hr.toFixed(2)} bps/时）` +
  `，做空 ${r.funding.short_venue} / 做多 ${r.funding.long_venue}，已持续 ${r.persistence_min || 0} 分`

// Evaluate the latest opportunity snapshot and push if anything newly qualifies.
// Never throws into the caller — returns a small status object.
async function evaluateAlerts(latest, s) {
  try {
    if (!s.alert_enabled) return { ok: false, skipped: 'disabled' }
    if (!s.serverchan_sendkey) return { ok: false, skipped: 'no-key' }
    const rows = (latest && latest.rows) || []
    const wl = new Set(
      String(s.alert_symbols || '')
        .split(/[,\s]+/)
        .map((x) => normSymbol(x))
        .filter(Boolean)
    )
    const minApr = Number(s.alert_min_apr) || 0
    const minPersist = Number(s.alert_min_persist_min) || 0
    const cooldownMs = (Number(s.alert_cooldown_min) || 60) * 60000

    const candidates = rows.filter(
      (r) =>
        r.funding &&
        (!wl.size || wl.has(r.symbol)) &&
        r.funding.apr_pct >= minApr &&
        (r.persistence_min || 0) >= minPersist
    )
    if (!candidates.length) return { ok: true, sent: 0 }

    // Cooldown filter (DB-backed, survives restarts).
    const toSend = []
    for (const r of candidates) {
      const akey = `${r.symbol}|${r.funding.short_venue}>${r.funding.long_venue}`
      const { rows: last } = await dbQuery(
        `SELECT at FROM arb_alert_log WHERE akey = $1 ORDER BY at DESC LIMIT 1`,
        [akey]
      )
      if (last.length && Date.now() - new Date(last[0].at).getTime() < cooldownMs) continue
      toSend.push({ r, akey })
    }
    if (!toSend.length) return { ok: true, sent: 0 }

    toSend.sort((a, b) => b.r.funding.apr_pct - a.r.funding.apr_pct)
    const topApr = Math.round(toSend[0].r.funding.apr_pct)
    const title = `套利机会 ${toSend.length} 个｜最高年化 ${topApr}%`
    const desp = [
      toSend.map(({ r }) => aprLine(r)).join('\n'),
      '',
      `> 阈值：APR ≥ ${minApr}% 且持续 ≥ ${minPersist} 分。数据来源：Lighter / RBLighter / Extended。`,
    ].join('\n')

    await sendServerChan(s.serverchan_sendkey, title, desp)

    for (const { r, akey } of toSend) {
      await dbQuery(
        `INSERT INTO arb_alert_log (akey, symbol, apr_pct, diff_bps_hr, persistence_min)
         VALUES ($1,$2,$3,$4,$5)`,
        [akey, r.symbol, r.funding.apr_pct, r.funding.diff_bps_hr, r.persistence_min || 0]
      )
    }
    return { ok: true, sent: toSend.length }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
}

module.exports = { evaluateAlerts, sendServerChan }
