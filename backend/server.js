const { createServer } = require('@surf-ai/sdk/server')
const { USE_LOCAL } = require('./db')

// Self-hosted path: when a local DB is configured (DATABASE_URL for a Postgres
// server, or LOCAL_DB_PATH for embedded PGlite), provision its schema ourselves
// before serving. (The SDK's own Surf-managed schema sync still runs inside
// createServer().start() but is a harmless no-op/warning when the Surf DB isn't
// used.) With neither env set (studio), the SDK manages the DB.
async function main() {
  if (USE_LOCAL) {
    try {
      await require('./db/migrate-local').migrate()
    } catch (e) {
      console.error('[db] local migration failed:', e.message || e)
      process.exit(1)
    }
  }

  await createServer().start()

  // Start the background sampler + task engine so sampling and arbitrage tasks
  // run continuously in the backend, even when no page is open.
  require('./lib/runner').start()
}

main().catch((e) => {
  console.error('startup failed:', e.message || e)
  process.exit(1)
})

