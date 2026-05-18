import { Router, Request, Response } from 'express'
import { getDb } from '../db'

const router = Router()

router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDb()
    const { jobId } = req.query
    const sql = jobId
      ? `SELECT i.*, c.initials, c.full_name, c.role, c.source_platform, j.title as job_title
         FROM interviews i
         LEFT JOIN candidates c ON c.id = i.candidate_id
         LEFT JOIN jobs j ON j.id = i.job_id
         WHERE i.job_id = ?
         ORDER BY i.scheduled_at ASC`
      : `SELECT i.*, c.initials, c.full_name, c.role, c.source_platform, j.title as job_title
         FROM interviews i
         LEFT JOIN candidates c ON c.id = i.candidate_id
         LEFT JOIN jobs j ON j.id = i.job_id
         ORDER BY i.scheduled_at ASC`
    const interviews = jobId ? db.prepare(sql).all(jobId) : db.prepare(sql).all()
    res.json({ data: interviews })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

router.post('/', (req: Request, res: Response) => {
  try {
    const db = getDb()
    const { candidate_id, job_id, scheduled_at, type = 'phone', interviewer, notes } = req.body
    if (!candidate_id || !scheduled_at) return res.json({ error: 'candidate_id et scheduled_at requis' })

    const result = db.prepare(`
      INSERT INTO interviews (candidate_id, job_id, scheduled_at, type, interviewer, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(candidate_id, job_id || null, scheduled_at, type, interviewer || '', notes || '')

    // Move candidate to interview stage
    db.prepare("UPDATE candidates SET stage = 'interview' WHERE id = ?").run(candidate_id)

    const interview = db.prepare(`
      SELECT i.*, c.initials, c.full_name, c.role, c.source_platform, j.title as job_title
      FROM interviews i
      LEFT JOIN candidates c ON c.id = i.candidate_id
      LEFT JOIN jobs j ON j.id = i.job_id
      WHERE i.id = ?
    `).get(result.lastInsertRowid)
    res.json({ data: interview })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

router.put('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb()
    const { id } = req.params
    const { scheduled_at, type, interviewer, notes, decision } = req.body

    db.prepare(`
      UPDATE interviews
      SET scheduled_at = COALESCE(?, scheduled_at),
          type = COALESCE(?, type),
          interviewer = COALESCE(?, interviewer),
          notes = COALESCE(?, notes),
          decision = COALESCE(?, decision),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(scheduled_at || null, type || null, interviewer ?? null, notes ?? null, decision || null, id)

    const interview = db.prepare(`
      SELECT i.*, c.initials, c.full_name, c.role, c.source_platform, j.title as job_title
      FROM interviews i
      LEFT JOIN candidates c ON c.id = i.candidate_id
      LEFT JOIN jobs j ON j.id = i.job_id
      WHERE i.id = ?
    `).get(id)
    res.json({ data: interview })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

router.delete('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb()
    db.prepare('DELETE FROM interviews WHERE id = ?').run(req.params.id)
    res.json({ success: true })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

export default router
