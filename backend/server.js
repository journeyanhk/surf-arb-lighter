const { createServer } = require('@surf-ai/sdk/server')
createServer().start()

// Start the background sampler + task engine so sampling and arbitrage tasks
// run continuously in the backend, even when no page is open.
require('./lib/runner').start()
