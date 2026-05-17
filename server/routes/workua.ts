import { Router, Request, Response } from 'express'
import {
  workuaStartLogin, workuaLoginState, workuaCheckSession, workuaHasSession,
  workuaClearSession, workuaOpenContext,
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

// ─── GET /workua/status — is a work.ua session connected & valid ─────────────
router.get('/status', async (_req: Request, res: Response) => {
  try {
    if (!workuaHasSession()) return res.json({ data: { connected: false } })
    const check = await workuaCheckSession()
    res.json({ data: { connected: check.valid, identity: check.identity } })
  } catch (e: unknown) {
    res.json({ error: (e as Error).message })
  }
})

// ─── POST /workua/login — open a Chromium window and auto-fill credentials ───
// Non-blocking: launches the browser, auto-submits the login form, returns
// immediately. The frontend polls /workua/login-state to follow progress.
// Credentials fall back to the last saved pair when omitted.
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

// ─── GET /workua/login-state — poll the in-progress login flow ───────────────
router.get('/login-state', (_req: Request, res: Response) => {
  res.json({ data: workuaLoginState() })
})

// ─── POST /workua/disconnect ─────────────────────────────────────────────────
router.post('/disconnect', (_req: Request, res: Response) => {
  workuaClearSession()
  res.json({ data: { ok: true } })
})

// ─── GET /workua/diagnose — dump employer dashboard HTML for selector tuning ─
// Temporary endpoint: lets us inspect the real work.ua DOM once a session
// exists, so the scraper selectors can be written against actual markup.
router.get('/diagnose', async (_req: Request, res: Response) => {
  const opened = await workuaOpenContext()
  if (!opened) return res.json({ error: 'Pas de session work.ua' })
  const { browser, context } = opened
  try {
    const page = await context.newPage()
    const target = 'https://www.work.ua/employer/'
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(2000)
    const url = page.url()
    const title = await page.title()
    const html = await page.content()
    await browser.close()
    res.json({ data: { url, title, htmlLength: html.length, html: html.slice(0, 60000) } })
  } catch (e: unknown) {
    try { await browser.close() } catch { /* ignore */ }
    res.json({ error: (e as Error).message })
  }
})

export default router
