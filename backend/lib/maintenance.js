// Database maintenance — the fix for the "stack depth limit exceeded" freeze.
//
// The default deployment uses embedded PGlite (WASM Postgres, in-process). PGlite
// has NO autovacuum background worker, so dead tuples are NEVER reclaimed on their
// own. The scanner churns arb_spread_samples hard (~40 INSERT + ~40 DELETE every
// 8s), so within hours the heap bloats to tens of MB of dead tuples even though
// only a few thousand rows are ever live. That bloat eventually overwhelms the
// in-process WASM instance and EVERY query starts failing with
// "stack depth limit exceeded" — which is why only a full service restart (a fresh
// WASM instance) clears it.
//
// Plain VACUUM does not reclaim space in PGlite; only VACUUM FULL rewrites the
// heap and frees it (verified: 24MB → 0.45MB). The tables here are tiny in LIVE
// rows, so the exclusive-lock rewrite is milliseconds. We run this on a timer AND
// on demand the instant a stack-depth error is observed, so the app self-heals
// without any manual restart.

const { dbQuery, DB_BACKEND } = require('../db')

let running = false
let lastRun = 0
let lastResult = null

// Rows no query ever needs again — prune at the source so tables stay small.
async function prune() {
  const jobs = [
    // Only the last ~10 min of samples feed the min-sample gate.
    `DELETE FROM arb_spread_samples WHERE created_at < now() - interval '15 minutes'`,
    // Signals are a view-only history feed; keep 3 days.
    `DELETE FROM arb_signals WHERE created_at < now() - interval '3 days'`,
    // Finished tasks: keep 14 days of history, drop older CLOSED/ERROR.
    `DELETE FROM arb_tasks WHERE state IN ('CLOSED','ERROR')
       AND coalesce(closed_at, updated_at, created_at) < now() - interval '14 days'`,
  ]
  for (const sql of jobs) {
    try { await dbQuery(sql) } catch (e) { console.warn('[maint] 清理跳过：', e.message || e) }
  }
}

// Reclaim dead-tuple bloat. Only PGlite needs this: it runs Postgres in-process
// (WASM) with NO autovacuum background worker, so dead tuples pile up forever and
// only VACUUM FULL rewrites the heap to free them (verified: 30MB → 0.5MB). A real
// Postgres server (pg-server) and Surf's managed DB both autovacuum on their own,
// so we skip the exclusive-lock rewrite there. VACUUM FULL must NOT run inside a
// transaction block — our dbQuery issues single statements, so it's fine.
async function compact() {
  if (DB_BACKEND !== 'pglite') return
  for (const tbl of ['arb_spread_samples', 'arb_signals', 'arb_tasks', 'arb_funding_ledger']) {
    try {
      await dbQuery(`VACUUM (FULL) ${tbl}`)
    } catch (e) {
      // Fall back to plain VACUUM if FULL is unavailable; never let it throw.
      try { await dbQuery(`VACUUM ${tbl}`) } catch (_) { /* ignore */ }
    }
  }
}

// force=true bypasses the throttle (used by the self-heal path).
async function runMaintenance(force = false) {
  if (running) return lastResult
  if (!force && Date.now() - lastRun < 60_000) return lastResult
  running = true
  const t0 = Date.now()
  try {
    await prune()
    await compact()
    lastResult = { ok: true, ms: Date.now() - t0, at: new Date().toISOString() }
  } catch (e) {
    lastResult = { ok: false, error: String(e.message || e), at: new Date().toISOString() }
    console.warn('[maint] 维护失败：', e.message || e)
  } finally {
    running = false
    lastRun = Date.now()
  }
  return lastResult
}

function isStackDepthError(e) {
  return /stack depth limit exceeded/i.test(String((e && e.message) || e || ''))
}

module.exports = { runMaintenance, isStackDepthError, getLastResult: () => lastResult }
