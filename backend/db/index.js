// Database access shim.
//
// Three backends, chosen at runtime by env (in priority order):
//   1. DATABASE_URL   -> LOCAL Postgres server via `pg` (if you run your own PG).
//   2. LOCAL_DB_PATH  -> EMBEDDED Postgres via PGlite (WASM, in-process, single
//      folder on disk). No server, no password, no setup — just works. This is
//      the easiest self-hosted path.
//   3. neither        -> Surf's managed Postgres via @surf-ai/sdk/db (studio).
//
// All three return pg-style results ({ rows, ... }) and speak real Postgres SQL,
// so every existing query ($1 placeholders, now()/interval, FILTER, ANY,
// RETURNING, ::int casts) is portable across all three — zero query rewrites.

const HAS_PG_SERVER = !!process.env.DATABASE_URL
const EMBED_PATH = process.env.LOCAL_DB_PATH || ''
const USE_LOCAL = HAS_PG_SERVER || !!EMBED_PATH

let _impl = null

function impl() {
  if (_impl) return _impl

  if (HAS_PG_SERVER) {
    const { Pool } = require('pg')
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PGPOOL_MAX || 8),
      idleTimeoutMillis: 30000,
    })
    pool.on('error', (e) => console.error('[db] pool error:', e.message || e))
    _impl = { dbQuery: (sql, params = []) => pool.query(sql, params) }
    console.log('[db] using LOCAL Postgres server (DATABASE_URL)')
    return _impl
  }

  if (EMBED_PATH) {
    const { PGlite } = require('@electric-sql/pglite')
    const db = new PGlite(EMBED_PATH) // persists to this folder
    _impl = { dbQuery: (sql, params) => db.query(sql, params) }
    console.log(`[db] using EMBEDDED Postgres (PGlite) at ${EMBED_PATH}`)
    return _impl
  }

  _impl = require('@surf-ai/sdk/db')
  console.log('[db] using Surf managed Postgres (@surf-ai/sdk/db)')
  return _impl
}

async function dbQuery(sql, params, options) {
  return impl().dbQuery(sql, params, options)
}

module.exports = { dbQuery, USE_LOCAL }
