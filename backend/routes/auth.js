// Login / logout / status for the simple single-user gate. Mounted at /api/auth.
// These paths are exempt from requireAuth (see backend/lib/auth.js) so the login
// page can reach them while unauthenticated.
const { Router } = require('express')
const auth = require('../lib/auth')

const router = Router()

// Whether auth is on, and whether THIS request is already authenticated.
router.get('/status', (req, res) => {
  const enabled = auth.authEnabled()
  const tok = auth.parseCookies(req)[auth.COOKIE]
  res.json({ enabled, authed: !enabled || auth.verifyToken(tok), username: auth.username() })
})

router.post('/login', (req, res) => {
  if (!auth.authEnabled()) return res.json({ ok: true, authed: true }) // auth off → always in
  const { username, password } = req.body || {}
  if (!auth.checkCredentials(username, password)) {
    return res.status(401).json({ ok: false, error: '用户名或密码错误' })
  }
  auth.setSessionCookie(req, res)
  res.json({ ok: true, authed: true })
})

router.post('/logout', (req, res) => {
  auth.clearSessionCookie(res)
  res.json({ ok: true })
})

module.exports = router
