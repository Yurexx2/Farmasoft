import { Router, Request, Response } from 'express'
import {
  workuaStartLogin, workuaFlowState, workuaCheckSession, workuaHasProfile,
  workuaClearProfile, workuaScrapeVacancies, workuaInspect, WorkuaVacancy,
} from '../lib/workua/browser'
import { getDb } from '../db'

const router = Router()

function saveSetting(key: string, value: string) {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}
function getSetting(key: string): string {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value || ''
}

// ─── Background operation result store ───────────────────────────────────────
let lastVacancies: WorkuaVacancy[] = []
let lastInspect: unknown = null

// ─── GET /workua/status ──────────────────────────────────────────────────────
router.get('/status', async (_req: Request, res: Response) => {
  try {
    if (!workuaHasProfile()) return res.json({ data: { connected: false } })
    const check = await workuaCheckSession()
    res.json({ data: check })
  } catch (e: unknown) {
    res.json({ error: (e as Error).message })
  }
})

// ─── GET /workua/flow-state — poll any in-progress login/sync ────────────────
router.get('/flow-state', (_req: Request, res: Response) => {
  res.json({ data: workuaFlowState() })
})

// ─── POST /workua/login — open Chromium, auto-fill, human solves reCAPTCHA ───
router.post('/login', (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string }
  const useEmail = email || getSetting('workua_email')
  const usePass  = password || getSetting('workua_password')
  if (email && password) {
    saveSetting('workua_email', email)
    saveSetting('workua_password', password)
  }
  const r = workuaStartLogin(useEmail || undefined, usePass || undefined)
  if (!r.ok) return res.json({ error: r.error })
  res.json({ data: { started: true } })
})

// ─── POST /workua/sync — scrape employer vacancies (semi-manual) ─────────────
// Non-blocking: starts the scrape; the recruiter solves Cloudflare if prompted.
// Poll /flow-state for progress, then GET /sync-result for the data.
router.post('/sync', (_req: Request, res: Response) => {
  const state = workuaFlowState().state
  if (state === 'working' || state === 'awaiting_human') {
    return res.json({ error: 'Opération work.ua déjà en cours' })
  }
  void (async () => {
    try {
      lastVacancies = await workuaScrapeVacancies()
    } catch { /* flow state already reflects the failure */ }
  })()
  res.json({ data: { started: true } })
})

router.get('/sync-result', (_req: Request, res: Response) => {
  res.json({ data: { vacancies: lastVacancies } })
})

// ─── POST /workua/disconnect ─────────────────────────────────────────────────
router.post('/disconnect', (_req: Request, res: Response) => {
  workuaClearProfile()
  res.json({ data: { ok: true } })
})

// ─── Inspection endpoints (selector tuning) ──────────────────────────────────
router.post('/inspect', (req: Request, res: Response) => {
  const url = (req.body?.url as string) || 'https://www.work.ua/employer/my/jobs/'
  const state = workuaFlowState().state
  if (state === 'working' || state === 'awaiting_human') {
    return res.json({ error: 'Opération work.ua déjà en cours' })
  }
  void (async () => {
    try { lastInspect = await workuaInspect(url) }
    catch (e) { lastInspect = { error: (e as Error).message } }
  })()
  res.json({ data: { started: true } })
})

router.get('/inspect-result', (_req: Request, res: Response) => {
  res.json({ data: lastInspect })
})

export default router
