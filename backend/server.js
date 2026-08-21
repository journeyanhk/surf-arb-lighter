const { createServer } = require('@surf-ai/sdk/server')

// Self-hosted path: when DATABASE_URL is set, provision the LOCAL Postgres
// schema ourselves before serving. (The SDK's own Surf-managed schema sync still
// runs inside createServer().start() but is a harmless no-op/warning when the
// Surf DB isn't used.) When DATABASE_URL is unset (studio), the SDK manages it.
async function main() {
  if (process.env.DATABASE_URL) {
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
