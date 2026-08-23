// Minimal single-user login for public-internet deploys.
//
// Credentials come from the environment (.env on the VPS):
//   APP_PASSWORD   — REQUIRED to turn auth on. If unset/empty, auth is DISABLED
//                    (handy for local dev; NEVER leave empty on a public VPS).
//   APP_USERNAME   — optional, defaults to "admin".
//   APP_AUTH_SECRET— optional signing secret; if unset we derive one from the
//                    password (so changing the password logs everyone out).
//
// On success we set a signed, httpOnly cookie (arb_session). Every /api request
// (except /api/auth/* and /api/health) must present a valid, unexpired cookie.
// No DB, no dependencies — just HMAC over a tiny payload.

const crypto = require('node:crypto')

const COOKIE = 'arb_session'
const TTL_SEC = 7 * 24 * 3600 // 7 days

function username() {
  return process.env.APP_USERNAME || 'admin'
}

function password() {
  return process.env.APP_PASSWORD || ''
}

// Auth is only enforced when a password is configured.
function authEnabled() {
  return password().length > 0
}

function secret() {
  return process.env.APP_AUTH_SECRET || `derived:${crypto.createHash('sha256').update(password()).digest('hex')}`
}

// Constant-time string compare (avoids timing leaks on the password).
function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

function checkCredentials(u, p) {
  return safeEqual(u || '', username()) && safeEqual(p || '', password())
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function sign(payloadB64) {
  return crypto.createHmac('sha256', secret()).update(payloadB64).digest('hex')
}

function issueToken() {
  const payload = { u: username(), exp: Math.floor(Date.now() / 1000) + TTL_SEC }
  const p = b64url(JSON.stringify(payload))
  return `${p}.${sign(p)}`
}

function verifyToken(tok) {
  if (!tok || typeof tok !== 'string' || !tok.includes('.')) return false
  const [p, sig] = tok.split('.')
  if (!p || !sig) return false
  if (!safeEqual(sig, sign(p))) return false
  try {
    const payload = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    if (!payload || typeof payload.exp !== 'number') return false
    if (payload.exp < Math.floor(Date.now() / 1000)) return false
    return true
  } catch (_) {
    return false
  }
}

function parseCookies(req) {
  const out = {}
  const raw = req.headers?.cookie
  if (!raw) return out
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function setSessionCookie(req, res) {
  const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https')
  const attrs = [
    `${COOKIE}=${issueToken()}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${TTL_SEC}`,
    secure ? 'Secure' : '',
  ].filter(Boolean)
  res.setHeader('Set-Cookie', attrs.join('; '))
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`)
}

// Express middleware: guard every /api route except the auth + health endpoints.
// Non-/api paths (the SPA shell & static assets) pass through so the login page
// can load; nothing sensitive is reachable without hitting a guarded /api route.
function requireAuth(req, res, next) {
  if (!authEnabled()) return next()
  if (req.method === 'OPTIONS') return next()
  const p = req.path || req.url || ''
  if (!p.startsWith('/api')) return next()
  if (p === '/api/health' || p.startsWith('/api/auth')) return next()
  const tok = parseCookies(req)[COOKIE]
  if (verifyToken(tok)) return next()
  return res.status(401).json({ error: 'unauthorized' })
}

module.exports = {
  authEnabled,
  username,
  checkCredentials,
  verifyToken,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  COOKIE,
}
