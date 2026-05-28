import { Router, Request, Response } from 'express'
import { getDb } from '../db'
import {
  workuaTest, workuaDictionaries, workuaAvailablePublications,
  workuaCreateJob, workuaUpdateJob, workuaCloseJob, workuaListResponses,
  workuaListMyJobs,
  WorkuaCreds, WorkuaDicts,
} from '../lib/workua'
import { buildWorkuaPayload } from '../lib/workua-map'

const router = Router()

// ─── Settings helpers ───────────────────────────────────────────────────────
function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}
function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}

export function getWorkuaCreds(): WorkuaCreds | null {
  const login = getSetting('workua_login')
  const password = getSetting('workua_password')
  return login && password ? { login, password } : null
}

function getCachedDicts(): WorkuaDicts | null {
  const raw = getSetting('workua_dictionaries')
  if (!raw) return null
  try { return JSON.parse(raw) as WorkuaDicts } catch { return null }
}

// Pick the cheapest available publication type with at least one in stock.
function pickPublicationType(pubs: { id: string; total: number }[]): string | null {
  const stocked = pubs.filter(p => p.total > 0)
  if (stocked.length === 0) return null
  // Prefer something that looks free / "standart" if present.
  const cheap = stocked.find(p => /standart|free/i.test(p.id))
  return (cheap || stocked[0]).id
}

// ─── Sync one Farmasoft job to work.ua (publish | update | close) ───────────
export async function syncJobToWorkua(
  jobId: number, action: 'publish' | 'update' | 'close',
): Promise<{ ok: boolean; error?: string }> {
  const creds = getWorkuaCreds()
  if (!creds) return { ok: false, error: 'Work.ua non connecté' }
  const db = getDb()
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined
  if (!job) return { ok: false, error: 'Job introuvable' }

  const dicts = getCachedDicts()
  if (!dicts) return { ok: false, error: 'Dictionnaires work.ua non chargés' }

  const workuaJobId = job.workua_job_id as number | null

  if (action === 'close') {
    if (!workuaJobId) return { ok: true }   // never published — nothing to close
    const r = await workuaCloseJob(creds, workuaJobId)
    if (r.ok) db.prepare("UPDATE jobs SET workua_state = 'closed', workua_error = NULL WHERE id = ?").run(jobId)
    else      db.prepare('UPDATE jobs SET workua_error = ? WHERE id = ?').run(r.error || null, jobId)
    return r
  }

  // publish or update — need the payload and a publication type
  const pubs = await workuaAvailablePublications(creds)
  const pubType = pickPublicationType(pubs)
  const { payload } = buildWorkuaPayload(job as never, dicts, pubType)

  if (workuaJobId && action === 'update') {
    const r = await workuaUpdateJob(creds, workuaJobId, payload)
    if (r.ok) db.prepare("UPDATE jobs SET workua_state = 'active', workua_error = NULL WHERE id = ?").run(jobId)
    else      db.prepare('UPDATE jobs SET workua_error = ? WHERE id = ?').run(r.error || null, jobId)
    return r
  }

  // create or re-publish
  const created = await workuaCreateJob(creds, payload)
  if (!created.ok) {
    db.prepare('UPDATE jobs SET workua_error = ? WHERE id = ?').run(created.error, jobId)
    return { ok: false, error: created.error }
  }
  db.prepare("UPDATE jobs SET workua_job_id = ?, workua_state = 'active', workua_error = NULL WHERE id = ?")
    .run(created.jobId ?? null, jobId)
  return { ok: true }
}

// ─── Auto-connect on startup ────────────────────────────────────────────────
// Alena lands on a pre-connected instance. Defaults are Alena's account; env
// vars (WORKUA_LOGIN / WORKUA_PASSWORD) override so the password can be
// rotated via Render config without redeploying.
const DEFAULT_WORKUA_LOGIN    = 'alena.pryhodko@farmasoft.ua'
const DEFAULT_WORKUA_PASSWORD = '5858183'

export async function bootstrapWorkuaFromEnv(): Promise<void> {
  if (getWorkuaCreds()) return  // already connected (UI or earlier boot)
  const login    = process.env.WORKUA_LOGIN    || DEFAULT_WORKUA_LOGIN
  const password = process.env.WORKUA_PASSWORD || DEFAULT_WORKUA_PASSWORD

  const test = await workuaTest({ login, password })
  if (!test.ok) { console.error('[workua bootstrap] auth failed:', test.error); return }

  setSetting('workua_login', login)
  setSetting('workua_password', password)
  const dicts = await workuaDictionaries({ login, password })
  if (dicts) setSetting('workua_dictionaries', JSON.stringify(dicts))
  console.log(`[workua bootstrap] connected as ${login}`)
}

// ─── Import work.ua vacancies → Farmasoft jobs ──────────────────────────────
// Bidirectional sync, mirrors the robota.ua side. Without this, vacancies
// Alena published directly on work.ua never surface as Farmasoft jobs, and
// their candidates land with job_id NULL.
export async function importWorkuaJobs(): Promise<void> {
  const creds = getWorkuaCreds()
  if (!creds) return
  const db = getDb()

  const vacancies = await workuaListMyJobs(creds)
  if (vacancies.length === 0) return

  let created = 0
  let updated = 0
  let relinked = 0

  for (const v of vacancies) {
    try {
      const workuaJobId = typeof v.id === 'string' ? parseInt(v.id, 10) : v.id
      if (!workuaJobId || Number.isNaN(workuaJobId)) continue

      const title    = (v.name || `Vacancy ${workuaJobId}`).trim()
      const isActive = v.active === 1 && v.blocked !== 1 ? 1 : 0
      const state    = v.blocked === 1 ? 'blocked' : (v.active === 1 ? 'active' : 'closed')

      const existing = db.prepare('SELECT id, deleted FROM jobs WHERE workua_job_id = ?')
        .get(workuaJobId) as { id: number; deleted: number } | undefined

      // User deleted it in Farmasoft — never resurrect.
      if (existing?.deleted === 1) continue

      let farmasoftJobId: number
      if (existing) {
        db.prepare(`
          UPDATE jobs SET title = ?, is_active = ?, workua_state = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(title, isActive, state, existing.id)
        farmasoftJobId = existing.id
        updated++
      } else {
        const r = db.prepare(`
          INSERT INTO jobs (title, salary_currency, is_active, workua_job_id, workua_state)
          VALUES (?, 'UAH', ?, ?, ?)
        `).run(title, isActive, workuaJobId, state)
        farmasoftJobId = r.lastInsertRowid as number
        created++
      }

      // Back-fill any candidates that came in earlier with job_id NULL.
      const upd = db.prepare(`
        UPDATE candidates SET job_id = ?
        WHERE job_id IS NULL AND workua_source_job_id = ?
      `).run(farmasoftJobId, workuaJobId)
      relinked += (upd.changes as number)
    } catch (e) {
      console.error(`[workua import job ${v.id}]`, (e as Error).message)
    }
  }

  if (created || updated || relinked) {
    console.log(`[workua import] ${created} created, ${updated} updated, ${relinked} candidate(s) relinked`)
  }
}

// ─── Import responses → candidates ──────────────────────────────────────────
// Work.ua's global /jobs/responses caps at 50 items and ignores pagination
// params (last_id / offset / page all return the same set). The only way to
// reach the historical pool is to call /jobs/{jobId}/responses for every
// employer vacancy. With ~60 vacancies that lifts the ceiling from 50 to
// ~3000 candidates without any extra moving part.
export async function runFullSyncWorkua(): Promise<void> {
  const creds = getWorkuaCreds()
  if (!creds) return

  // Import vacancies first so the candidate insert below can attach them.
  await importWorkuaJobs()

  const db = getDb()
  const vacancies = await workuaListMyJobs(creds)

  let imported = 0
  let relinked = 0
  let skipped = 0

  for (const v of vacancies) {
    const workuaJobId = typeof v.id === 'string' ? parseInt(v.id, 10) : v.id
    if (!workuaJobId || Number.isNaN(workuaJobId)) continue

    const farmasoftJob = db.prepare('SELECT id FROM jobs WHERE workua_job_id = ?')
      .get(workuaJobId) as { id: number } | undefined

    // Paginate backwards with before_id until the API 404s (no older pages).
    // Cap at 50 pages (= 2500 responses) per vacancy as a safety net.
    let beforeId: number | undefined
    let pageError = false
    for (let page = 0; page < 50; page++) {
      const { items, error } = await workuaListResponses(creds, {
        jobId: workuaJobId, limit: 50, beforeId,
      })
      if (error) { pageError = true; break }
      if (items.length === 0) break

      for (const r of items) {
        try {
          const exists = db.prepare('SELECT id, job_id FROM candidates WHERE workua_response_id = ?')
            .get(r.id) as { id: number; job_id: number | null } | undefined
          if (exists) {
            if (exists.job_id == null && farmasoftJob?.id) {
              db.prepare(`
                UPDATE candidates SET job_id = ?, workua_source_job_id = ?
                WHERE id = ?
              `).run(farmasoftJob.id, workuaJobId, exists.id)
              relinked++
            }
            continue
          }
          const fullName = (r.fio || '').trim()
          const initials = fullName.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w.charAt(0).toUpperCase()).join('') || '?'
          db.prepare(`
            INSERT INTO candidates (
              job_id, initials, full_name, role, source_platform, source_type,
              email, phone, profile_url, workua_response_id, workua_candidate_id,
              workua_source_job_id, photo_url
            ) VALUES (?, ?, ?, ?, 'work.ua', 'scraped', ?, ?, '', ?, ?, ?, ?)
          `).run(
            farmasoftJob?.id ?? null, initials, fullName || null, null,
            r.email || null, r.phone || null,
            r.id, r.candidate_id ?? null, workuaJobId, r.photo || null,
          )
          imported++
        } catch (e) {
          console.error('[workua candidate insert]', (e as Error).message)
        }
      }

      // The last item is the oldest of this page (items are sorted id-DESC).
      // Use it as the pivot for the next call so we walk strictly older.
      beforeId = items[items.length - 1].id
      if (items.length < 50) break

      // 50 ms between pages — stays well under work.ua's 50 req/sec limit.
      await new Promise(r => setTimeout(r, 50))
    }
    if (pageError) skipped++
  }

  if (imported || relinked || skipped) {
    console.log(`[workua sync] ${imported} imported, ${relinked} relinked, ${skipped} vacancies skipped`)
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────
router.get('/config', async (_req: Request, res: Response) => {
  const creds = getWorkuaCreds()
  if (!creds) return res.json({ data: { connected: false } })
  const pubs = await workuaAvailablePublications(creds)
  res.json({ data: { connected: true, login: creds.login, publications: pubs } })
})

router.post('/auth', async (req: Request, res: Response) => {
  const { login, password } = req.body as { login: string; password: string }
  if (!login || !password) return res.json({ error: 'Login et mot de passe requis' })
  const test = await workuaTest({ login, password })
  if (!test.ok) return res.json({ error: test.error })
  setSetting('workua_login', login)
  setSetting('workua_password', password)
  // Cache dictionaries on connect.
  const dicts = await workuaDictionaries({ login, password })
  if (dicts) setSetting('workua_dictionaries', JSON.stringify(dicts))
  // Pull existing responses in the background.
  runFullSyncWorkua().catch(e => console.error('[workua initial sync]', (e as Error).message))
  res.json({ data: { ok: true } })
})

router.post('/disconnect', (_req: Request, res: Response) => {
  const db = getDb()
  for (const k of ['workua_login', 'workua_password', 'workua_dictionaries']) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(k)
  }
  res.json({ data: { ok: true } })
})

router.post('/full-sync', async (_req: Request, res: Response) => {
  runFullSyncWorkua().catch(e => console.error('[workua full-sync]', (e as Error).message))
  res.json({ data: { started: true } })
})

router.post('/refresh-dictionaries', async (_req: Request, res: Response) => {
  const creds = getWorkuaCreds()
  if (!creds) return res.json({ error: 'Work.ua non connecté' })
  const dicts = await workuaDictionaries(creds)
  if (!dicts) return res.json({ error: 'Impossible de récupérer les dictionnaires' })
  setSetting('workua_dictionaries', JSON.stringify(dicts))
  res.json({ data: { ok: true } })
})

export default router
