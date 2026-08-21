const { Router } = require('express')
const { dbQuery } = require('../db')
const { summary } = require('../lib/engine')

const router = Router()

router.get('/', async (_req, res) => {
  try {
    const { rows } = await dbQuery(
      `SELECT * FROM arb_tasks ORDER BY
         (state IN ('ENTERING','RECONCILING','HOLDING','EXITING','PAUSED')) DESC,
         id DESC
       LIMIT 60`
    )
    res.json({ tasks: rows, summary: await summary() })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

// Manual controls mirroring the original's pause / resume / force-close.
router.post('/:id/pause', async (req, res) => {
  try {
    await dbQuery(
      `UPDATE arb_tasks SET state='PAUSED', note=coalesce(note,'') || ' | 手动暂停', updated_at=now()
       WHERE id=$1 AND state IN ('HOLDING','ENTERING','RECONCILING')`,
      [req.params.id]
    )
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

router.post('/:id/resume', async (req, res) => {
  try {
    await dbQuery(
      `UPDATE arb_tasks SET state='HOLDING', note=coalesce(note,'') || ' | 手动恢复', updated_at=now()
       WHERE id=$1 AND state='PAUSED'`,
      [req.params.id]
    )
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

router.post('/:id/close', async (req, res) => {
  try {
    // Route to EXITING so the engine settles PnL on the next tick (reduce-only).
    await dbQuery(
      `UPDATE arb_tasks SET state='EXITING', note=coalesce(note,'') || ' | 手动平仓', updated_at=now()
       WHERE id=$1 AND state IN ('HOLDING','PAUSED')`,
      [req.params.id]
    )
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

router.delete('/history', async (_req, res) => {
  try {
    await dbQuery(`DELETE FROM arb_tasks WHERE state IN ('CLOSED','ERROR')`)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

module.exports = router
