// Database access shim.
//
// Two backends, chosen at runtime:
//   • DATABASE_URL set  -> connect to a LOCAL Postgres (self-hosted VPS). No Surf
//     key needed for data storage. This is the self-contained deployment path.
//   • DATABASE_URL unset -> delegate to Surf's managed Postgres via @surf-ai/sdk/db
//     (the studio default). Keeps the app working unchanged inside the studio.
//
// Both return pg-style results ({ rows, rowCount, fields }), so callers are
// identical regardless of backend. All existing SQL uses standard Postgres
// ($1 placeholders, now(), interval, FILTER, ANY) — portable across both.

const USE_LOCAL = !!process.env.DATABASE_URL

let _impl = null

function impl() {
  if (_impl) return _impl
  if (USE_LOCAL) {
    const { Pool } = require('pg')
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PGPOOL_MAX || 8),
      idleTimeoutMillis: 30000,
    })
    pool.on('error', (e) => console.error('[db] pool error:', e.message || e))
    _impl = {
      dbQuery: (sql, params = [], _options) => pool.query(sql, params),
      pool,
    }
    console.log('[db] using LOCAL Postgres (DATABASE_URL)')
  } else {
    _impl = require('@surf-ai/sdk/db')
    console.log('[db] using Surf managed Postgres (@surf-ai/sdk/db)')
  }
  return _impl
}

async function dbQuery(sql, params, options) {
  return impl().dbQuery(sql, params, options)
}

module.exports = { dbQuery, USE_LOCAL }
