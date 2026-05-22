import { Router, Request, Response } from 'express'
import { getDb } from '../db'
import { syncJobToRobota } from './robota'
import { syncJobToWorkua, getWorkuaCreds } from './workua'

const router = Router()

const JOB_FIELDS = [
  'title', 'location', 'salary_min', 'salary_max', 'salary_currency',
  'experience_years', 'skills', 'description', 'requirements', 'is_active',
  'city_id', 'experience_id', 'education_id', 'schedule_id',
  'employment_types', 'work_types', 'branch_ids', 'publish_type',
  'contact_person', 'contact_email', 'languages',
] as const

function normalize(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of JOB_FIELDS) {
    let v = body[k]
    if (v === undefined) continue
    // Stringify arrays/objects
    if (typeof v === 'object' && v !== null) v = JSON.stringify(v)
    out[k] = v
  }
  return out
}

router.get('/', (_req: Request, res: Response) => {
  try {
    const db = getDb()
    const jobs = db.prepare('SELECT * FROM jobs WHERE is_active = 1 AND deleted = 0 ORDER BY created_at DESC').all()
    res.json({ data: jobs })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

router.get('/with-counts', (_req: Request, res: Response) => {
  try {
    const db = getDb()
    const jobs = db.prepare(`
      SELECT j.*, COUNT(c.id) as candidate_count
      FROM jobs j
      LEFT JOIN candidates c ON c.job_id = j.id
      WHERE j.deleted = 0
      GROUP BY j.id
      ORDER BY j.is_active DESC, j.created_at DESC
    `).all()
    res.json({ data: jobs })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb()
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id)
    if (!job) return res.json({ error: 'Poste introuvable' })
    res.json({ data: job })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

router.post('/', async (req: Request, res: Response) => {
  try {
    const db = getDb()
    if (!req.body.title) return res.json({ error: 'Le titre est requis' })

    const data = normalize(req.body)
    const cols = Object.keys(data)
    const placeholders = cols.map(() => '?').join(', ')

    const result = db.prepare(`INSERT INTO jobs (${cols.join(', ')}) VALUES (${placeholders})`).run(...Object.values(data) as never[])

    // If is_active was set, push to robota.ua and work.ua in parallel.
    const wantsActive = data.is_active == 1 || data.is_active === '1' || data.is_active === true
    if (wantsActive) {
      const newId = result.lastInsertRowid as number
      await Promise.all([
        syncJobToRobota(newId, 'publish').then(r => {
          if (r.error) db.prepare('UPDATE jobs SET robota_error = ? WHERE id = ?').run(r.error, newId)
        }),
        getWorkuaCreds() ? syncJobToWorkua(newId, 'publish') : Promise.resolve({ ok: true }),
      ])
    }

    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(result.lastInsertRowid)
    res.json({ data: job })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb()
    const { id } = req.params

    const before = db.prepare('SELECT is_active, robota_vacancy_id, workua_job_id FROM jobs WHERE id = ?').get(id) as { is_active: number; robota_vacancy_id: number | null; workua_job_id: number | null } | undefined
    if (!before) return res.json({ error: 'Poste introuvable' })

    const data = normalize(req.body)
    if (Object.keys(data).length === 0) {
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)
      return res.json({ data: job })
    }

    const setClause = Object.keys(data).map(k => `${k} = ?`).join(', ')
    db.prepare(`UPDATE jobs SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(...Object.values(data) as never[], id)

    // Determine if we need to push to robota.ua
    const wantsActive = data.is_active === undefined ? before.is_active === 1
      : (data.is_active == 1 || data.is_active === '1' || data.is_active === true)
    const wasActive = before.is_active === 1

    // Pick the action for each platform based on the active-state transition.
    let action: 'publish' | 'update' | 'close' | null = null
    if (wantsActive && !wasActive) action = 'publish'
    else if (!wantsActive && wasActive) action = 'close'
    else if (wantsActive && wasActive)  action = 'update'

    let robotaResult: { ok: boolean; error?: string } = { ok: true }
    let workuaResult: { ok: boolean; error?: string } = { ok: true }

    if (action) {
      const jobIdN = parseInt(id)
      const workConnected = !!getWorkuaCreds()
      const robotaSkip = (action === 'close' || action === 'update') && !before.robota_vacancy_id
      const workuaSkip = (action === 'close' || action === 'update') && !before.workua_job_id

      ;[robotaResult, workuaResult] = await Promise.all([
        robotaSkip ? Promise.resolve({ ok: true })
                   : syncJobToRobota(jobIdN, action).then(r => r.error ? { ok: false, error: r.error } : { ok: true }),
        !workConnected || workuaSkip ? Promise.resolve({ ok: true })
                                     : syncJobToWorkua(jobIdN, action).then(r => r.error ? { ok: false, error: r.error } : { ok: true }),
      ])
    }

    if (!robotaResult.ok) db.prepare('UPDATE jobs SET robota_error = ? WHERE id = ?').run(robotaResult.error || null, id)
    else                  db.prepare('UPDATE jobs SET robota_error = NULL WHERE id = ?').run(id)
    if (!workuaResult.ok) db.prepare('UPDATE jobs SET workua_error = ? WHERE id = ?').run(workuaResult.error || null, id)
    else                  db.prepare('UPDATE jobs SET workua_error = NULL WHERE id = ?').run(id)

    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)
    res.json({ data: job, robotaError: robotaResult.error, workuaError: workuaResult.error })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb()
    const { id } = req.params
    const job = db.prepare('SELECT robota_vacancy_id, workua_job_id FROM jobs WHERE id = ?').get(id) as { robota_vacancy_id: number | null; workua_job_id: number | null } | undefined

    // Close on both external platforms (best-effort).
    await Promise.all([
      job?.robota_vacancy_id ? syncJobToRobota(parseInt(id), 'close').catch(() => null) : Promise.resolve(),
      job?.workua_job_id && getWorkuaCreds() ? syncJobToWorkua(parseInt(id), 'close').catch(() => null) : Promise.resolve(),
    ])

    // Hard delete — mark deleted=1 so list queries exclude it permanently and
    // the robota sync never resurrects it (a plain is_active=0 reappeared on
    // reload because /with-counts returned inactive jobs too).
    db.prepare('UPDATE jobs SET is_active = 0, deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id)
    res.json({ data: { success: true } })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

export default router
