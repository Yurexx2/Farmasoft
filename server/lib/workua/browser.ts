import { chromium, BrowserContext, Page } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'

// work.ua stacks two anti-bot layers:
//   1. invisible reCAPTCHA on /employer/login/  — passed during manual login
//   2. Cloudflare Turnstile on /employer/my/*   — does NOT pass for an automated
//      click, but DOES pass when a real human solves it with a genuine mouse.
//
// So the integration is semi-manual: we drive a *persistent* headful Chromium
// profile (cookies, cf_clearance and the login all live on disk in the profile
// dir). Automation handles navigation + scraping; the recruiter only solves the
// Cloudflare challenge by hand when it appears. cf_clearance then covers all
// subsequent requests for ~30 min, so the human is needed at most once per session.

const DATA_DIR = process.env.FARMASOFT_DATA_DIR
  ? process.env.FARMASOFT_DATA_DIR
  : process.env.APPDATA
    ? path.join(process.env.APPDATA, 'Farmasoft', 'data')
    : path.join(os.homedir(), '.farmasoft', 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

// Persistent browser profile — survives restarts, holds login + cf_clearance.
const PROFILE_DIR = path.join(DATA_DIR, 'workua-profile')

const LOGIN_URL     = 'https://www.work.ua/employer/login/'
const EMPLOYER_HOME = 'https://www.work.ua/employer/'
const JOBS_URL      = 'https://www.work.ua/employer/my/jobs/'

const CF_CHALLENGE_RE = /зачекайте|just a moment|перевірка надійності|attention required/i

// ─── Persistent context singleton ───────────────────────────────────────────
let context: BrowserContext | null = null

async function ensureContext(headless = false): Promise<BrowserContext> {
  if (context) return context
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1280, height: 880 },
    locale: 'uk-UA',
    args: ['--disable-blink-features=AutomationControlled'],
  })
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })
  return context
}

export async function workuaCloseContext(): Promise<void> {
  if (context) { try { await context.close() } catch { /* ignore */ } context = null }
}

export function workuaHasProfile(): boolean {
  return fs.existsSync(path.join(PROFILE_DIR, 'Default')) || fs.existsSync(path.join(PROFILE_DIR, 'Cookies'))
}

export function workuaClearProfile(): void {
  void workuaCloseContext()
  try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
}

// ─── Shared flow state (login + scrape both surface progress here) ───────────
export type WorkuaFlowState = 'idle' | 'working' | 'awaiting_human' | 'success' | 'failed'
let flowState: WorkuaFlowState = 'idle'
let flowMessage = ''
let flowStartedAt = 0

export function workuaFlowState(): { state: WorkuaFlowState; message: string; elapsedSec: number } {
  return {
    state: flowState,
    message: flowMessage,
    elapsedSec: flowStartedAt ? Math.round((Date.now() - flowStartedAt) / 1000) : 0,
  }
}

function setFlow(state: WorkuaFlowState, message = '') {
  flowState = state
  flowMessage = message
  console.log(`[workua] ${state}${message ? ' — ' + message : ''}`)
}

// ─── Login — auto-fills the form; human solves reCAPTCHA if it appears ───────
export function workuaStartLogin(email?: string, password?: string): { ok: boolean; error?: string } {
  if (flowState === 'working' || flowState === 'awaiting_human') {
    return { ok: false, error: 'Opération work.ua déjà en cours' }
  }
  flowStartedAt = Date.now()
  setFlow('working', 'Ouverture du navigateur…')
  void runLogin(email, password)
  return { ok: true }
}

async function runLogin(email?: string, password?: string): Promise<void> {
  try {
    const ctx = await ensureContext(false)
    const page = ctx.pages()[0] || await ctx.newPage()
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })

    // Already logged in? work.ua redirects away from /login.
    if (!/\/login/i.test(page.url())) { setFlow('success', 'Déjà connecté'); return }

    if (email && password) {
      try {
        await page.fill('#user-login', email, { timeout: 10000 })
        await page.fill('#password', password, { timeout: 10000 })
        await page.click('button[type="submit"]', { timeout: 10000 })
        setFlow('awaiting_human', 'Si un reCAPTCHA apparaît, résolvez-le dans la fenêtre')
      } catch {
        setFlow('awaiting_human', 'Connectez-vous manuellement dans la fenêtre')
      }
    } else {
      setFlow('awaiting_human', 'Connectez-vous dans la fenêtre')
    }

    // Wait for login to complete (URL leaves /login) — up to 5 minutes.
    const deadline = Date.now() + 5 * 60 * 1000
    while (Date.now() < deadline) {
      if (page.isClosed()) { setFlow('failed', 'Fenêtre fermée'); return }
      await page.waitForTimeout(1000)
      if (!/\/login/i.test(page.url())) {
        await page.waitForTimeout(1500)
        setFlow('success', 'Connecté à work.ua')
        return
      }
    }
    setFlow('failed', 'Délai de connexion dépassé')
  } catch (e: unknown) {
    setFlow('failed', (e as Error).message)
  }
}

// ─── Session validity check ──────────────────────────────────────────────────
export async function workuaCheckSession(): Promise<{ connected: boolean; identity?: string }> {
  if (!workuaHasProfile()) return { connected: false }
  try {
    const ctx = await ensureContext(true)
    const page = await ctx.newPage()
    await page.goto(EMPLOYER_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(1500)
    const connected = !/\/login/i.test(page.url())
    let identity: string | undefined
    if (connected) {
      identity = await page.locator('a[href="/employer/my/"]').first()
        .textContent({ timeout: 3000 }).then(t => t?.trim() || undefined).catch(() => undefined)
    }
    await page.close()
    return { connected, identity }
  } catch {
    return { connected: false }
  }
}

// Detect a Cloudflare interstitial via both <title> and body text — the title
// alone isn't reliable right after navigation (it renders a beat later).
async function isCloudflareChallenge(page: Page): Promise<boolean> {
  try {
    const title = await page.title().catch(() => '')
    if (CF_CHALLENGE_RE.test(title)) return true
    const body = await page.evaluate(() => document.body?.innerText?.slice(0, 600) || '').catch(() => '')
    return CF_CHALLENGE_RE.test(body) || /cloudflare ray id/i.test(body)
  } catch { return false }
}

// Navigate to a page, pausing for the human if Cloudflare challenges.
// Returns the live Page once it's past Cloudflare, or throws on timeout.
async function gotoPastCloudflare(url: string, humanWaitMs = 4 * 60 * 1000): Promise<Page> {
  const ctx = await ensureContext(false)
  const page = ctx.pages()[0] || await ctx.newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(2500)  // let the challenge page render its title/body

  if (!(await isCloudflareChallenge(page))) return page

  // Cloudflare challenge up — bring window forward, ask the human to solve it.
  setFlow('awaiting_human', 'Résolvez le contrôle Cloudflare dans la fenêtre work.ua')
  await page.bringToFront().catch(() => { /* ignore */ })
  const deadline = Date.now() + humanWaitMs
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error('Fenêtre fermée pendant le contrôle Cloudflare')
    await page.waitForTimeout(2000)
    if (!(await isCloudflareChallenge(page))) {
      await page.waitForTimeout(1500)
      setFlow('working', 'Contrôle Cloudflare passé — lecture en cours')
      return page
    }
  }
  throw new Error('Contrôle Cloudflare non résolu (délai dépassé)')
}

// ─── Scrape the employer vacancy list ────────────────────────────────────────
export interface WorkuaVacancy {
  id: string
  title: string
  url: string
  status?: string
  applyCount?: number
}

export async function workuaScrapeVacancies(): Promise<WorkuaVacancy[]> {
  const page = await gotoPastCloudflare(JOBS_URL)
  setFlow('working', 'Lecture des vacancies…')
  await page.waitForTimeout(1500)

  const vacancies = await page.evaluate(() => {
    const out: Array<{ id: string; title: string; url: string; status?: string; applyCount?: number }> = []
    // work.ua job links look like /jobs/1234567/ — collect unique ones with a title.
    const seen = new Set<string>()
    document.querySelectorAll('a[href*="/jobs/"]').forEach(a => {
      const href = (a as HTMLAnchorElement).getAttribute('href') || ''
      const m = href.match(/\/jobs\/(\d+)/)
      const title = (a.textContent || '').trim()
      if (m && title.length > 3 && !seen.has(m[1])) {
        seen.add(m[1])
        out.push({ id: m[1], title, url: 'https://www.work.ua' + href })
      }
    })
    return out
  })

  return vacancies
}

// ─── Raw page inspection (selector tuning) ───────────────────────────────────
export async function workuaInspect(url: string): Promise<{ url: string; title: string; cleared: boolean; links: Array<{ text: string; href: string }>; bodyText: string; html: string }> {
  const page = await gotoPastCloudflare(url)
  await page.waitForTimeout(1500)
  const data = await page.evaluate(() => ({
    links: Array.from(document.querySelectorAll('a[href]'))
      .map(a => ({ text: (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60), href: (a as HTMLAnchorElement).getAttribute('href') || '' }))
      .filter(l => l.href && !l.href.startsWith('#')),
    bodyText: document.body.innerText.slice(0, 3000),
    html: document.documentElement.outerHTML.slice(0, 150000),
  }))
  return { url: page.url(), title: await page.title(), cleared: true, ...data }
}
