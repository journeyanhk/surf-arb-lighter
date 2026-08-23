const path = require('node:path')
const fs = require('node:fs')
const express = require('express')
const { createServer } = require('@surf-ai/sdk/server')
const { USE_LOCAL } = require('./db')

// Self-hosted path: when a local DB is configured (DATABASE_URL for a Postgres
// server, or LOCAL_DB_PATH for embedded PGlite), provision its schema ourselves
// before serving. With neither set (studio), the SDK manages the DB.
async function main() {
  if (USE_LOCAL) {
    try {
      await require('./db/migrate-local').migrate()
    } catch (e) {
      console.error('[db] local migration failed:', e.message || e)
      process.exit(1)
    }
  }

  const server = createServer()

  // ---- Auth gate (public-internet safety) ----
  // API routes are registered INSIDE createServer(), so a plain app.use() here
  // would run AFTER them and never guard them. Instead we add the middleware,
  // then move its Layer to the front of the router stack (right after Express's
  // own init layer) so it runs before every route. No-op unless APP_PASSWORD is
  // set. Guards all /api/* except /api/auth/* and /api/health.
  const { requireAuth, authEnabled } = require('./lib/auth')
  server.app.use(requireAuth)
  try {
    const stack = server.app._router.stack
    const layer = stack.pop() // the requireAuth layer we just appended
    const initIdx = stack.findIndex((l) => l.name === 'expressInit')
    stack.splice(initIdx >= 0 ? initIdx + 1 : 0, 0, layer)
    console.log(`[auth] 登录鉴权 ${authEnabled() ? '已启用（APP_PASSWORD 已配置）' : '未启用（未设置 APP_PASSWORD）'}`)
  } catch (e) {
    console.error('[auth] 无法前置鉴权中间件：', e.message || e)
  }

  // Single-service deploy: serve the built frontend from THIS same process, so
  // one Node/Bun process serves both /api/* and the SPA. Caddy then only needs
  // to reverse_proxy to this one port. API routes are already registered inside
  // createServer(), so they take precedence; everything else falls back to the
  // SPA's index.html (except /api, which 404s normally).
  // Vite builds the static client bundle into dist/client (dist/server is the
  // unused SSR bundle), so that's the folder we serve.
  const distDir =
    process.env.FRONTEND_DIST ||
    [
      path.join(__dirname, '..', 'frontend', 'dist', 'client'),
      path.join(__dirname, '..', 'frontend', 'dist'),
    ].find((d) => fs.existsSync(path.join(d, 'index.html'))) ||
    path.join(__dirname, '..', 'frontend', 'dist', 'client')
  if (fs.existsSync(path.join(distDir, 'index.html'))) {
    server.app.use(express.static(distDir))
    server.app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next()
      res.sendFile(path.join(distDir, 'index.html'))
    })
    console.log(`[web] serving frontend from ${distDir}`)
  } else {
    console.log('[web] no frontend build found (dev mode) — API only')
  }

  await server.start()

  // Start the background sampler + task engine so sampling and arbitrage tasks
  // run continuously in the backend, even when no page is open.
  require('./lib/runner').start()
}

main().catch((e) => {
  console.error('startup failed:', e.message || e)
  process.exit(1)
})
