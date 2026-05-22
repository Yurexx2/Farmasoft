import { Router, Request, Response } from 'express'
import { getDb } from '../db'
import {
  workuaTest, workuaDictionaries, workuaAvailablePublications,
  workuaCreateJob, workuaUpdateJob, workuaCloseJob, workuaListResponses,
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

// ─── Auto-connect from env vars on startup ──────────────────────────────────
// If WORKUA_LOGIN + WORKUA_PASSWORD are set in the environment and no creds
// are saved yet, write them to the settings table and cache dictionaries.
// Lets Alena land on a pre-connected instance without touching the UI; the
// password never lives in git — Render holds it as an env var.
export async function bootstrapWorkuaFromEnv(): Promise<void> {
  if (getWorkuaCreds()) return  // already connected via UI
  const login = process.env.WORKUA_LOGIN
  const password = process.env.WORKUA_PASSWORD
  if (!login || !password) return

  const test = await workuaTest({ login, password })
  if (!test.ok) { console.error('[workua bootstrap] auth failed:', test.error); return }

  setSetting('workua_login', login)
  setSetting('workua_password', password)
  const dicts = await workuaDictionaries({ login, password })
  if (dicts) setSetting('workua_dictionaries', JSON.stringify(dicts))
  console.log(`[workua bootstrap] connected as ${login}`)
}

// ─── Import responses → candidates ──────────────────────────────────────────
export async function runFullSyncWorkua(): Promise<void> {
  const creds = getWorkuaCreds()
  if (!creds) return
  const db = getDb()

  let imported = 0
  let lastId: number | undefined
  for (let page = 0; page < 20; page++) {
    const { items, error } = await workuaListResponses(creds, { limit: 50, lastId })
    if (error) { console.error('[workua sync]', error); return }
    if (items.length === 0) break

    for (const r of items) {
      try {
        const exists = db.prepare('SELECT id FROM candidates WHERE workua_response_id = ?').get(r.id)
        if (exists) continue
        const job = r.job_id
          ? db.prepare('SELECT id FROM jobs WHERE workua_job_id = ?').get(r.job_id) as { id: number } | undefined
          : undefined
        const fullName = (r.fio || '').trim()
        const initials = fullName.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w.charAt(0).toUpperCase()).join('') || '?'
        db.prepare(`
          INSERT INTO candidates (
            job_id, initials, full_name, role, source_platform, source_type,
            email, phone, profile_url, workua_response_id, workua_candidate_id, photo_url
          ) VALUES (?, ?, ?, ?, 'work.ua', 'scraped', ?, ?, '', ?, ?, ?)
        `).run(
          job?.id ?? null, initials, fullName || null, null,
          r.email || null, r.phone || null,
          r.id, r.candidate_id ?? null, r.photo || null,
        )
        imported++
      } catch (e) {
        console.error('[workua candidate insert]', (e as Error).message)
      }
    }
    lastId = items[items.length - 1].id
    if (items.length < 50) break
  }
  if (imported > 0) console.log(`[workua sync] ${imported} new candidate(s) imported`)
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
