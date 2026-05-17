import { chromium, BrowserContext, Browser } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'

// work.ua blocks programmatic login behind an invisible Google reCAPTCHA, so we
// cannot reverse-engineer a JSON auth endpoint the way we did for robota.ua.
// Instead we drive a real Chromium window: the recruiter logs in by hand (the
// invisible reCAPTCHA passes silently for a genuine browser session), and we
// persist the authenticated storageState. All later scraping reuses that state
// headlessly — reCAPTCHA only guards the login form, not page navigation.

const DATA_DIR = process.env.FARMASOFT_DATA_DIR
  ? process.env.FARMASOFT_DATA_DIR
  : process.env.APPDATA
    ? path.join(process.env.APPDATA, 'Farmasoft', 'data')
    : path.join(os.homedir(), '.farmasoft', 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

const SESSION_PATH = path.join(DATA_DIR, 'workua-session.json')

const LOGIN_URL     = 'https://www.work.ua/employer/login/'
const EMPLOYER_HOME = 'https://www.work.ua/employer/'

// ─── Async login state (the login flow runs in the background, not blocking) ─
export type WorkuaLoginState = 'idle' | 'waiting' | 'success' | 'failed'
let loginState: WorkuaLoginState = 'idle'
let loginError = ''
let loginStartedAt = 0

export function workuaLoginState(): { state: WorkuaLoginState; error: string; elapsedSec: number } {
  return {
    state: loginState,
    error: loginError,
    elapsedSec: loginStartedAt ? Math.round((Date.now() - loginStartedAt) / 1000) : 0,
  }
}

export function workuaHasSession(): boolean {
  return fs.existsSync(SESSION_PATH)
}

export function workuaClearSession(): void {
  try { if (fs.existsSync(SESSION_PATH)) fs.unlinkSync(SESSION_PATH) } catch { /* ignore */ }
  loginState = 'idle'
  loginError = ''
}

// Kick off the visible-browser login flow. Returns immediately; progress is
// tracked via workuaLoginState(). When email/password are provided the form is
// auto-filled and submitted — the invisible reCAPTCHA usually passes silently;
// if it raises a challenge, the window stays open for the recruiter to solve it.
export function workuaStartLogin(email?: string, password?: string): { ok: boolean; error?: string } {
  if (loginState === 'waiting') {
    return { ok: false, error: 'Connexion déjà en cours — terminez-la dans la fenêtre ouverte' }
  }
  loginState = 'waiting'
  loginError = ''
  loginStartedAt = Date.now()
  void runLoginFlow(email, password)
  return { ok: true }
}

async function runLoginFlow(email?: string, password?: string): Promise<void> {
  let browser: Browser | null = null
  try {
    console.log('[workua] launching headful Chromium for login…')
    browser = await chromium.launch({ headless: false })
    const context = await browser.newContext({
      viewport: { width: 1280, height: 860 },
      locale: 'uk-UA',
    })
    // Mask the most obvious automation tell so the invisible reCAPTCHA scores us
    // as a genuine browser session.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })
    const page = await context.newPage()
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
    console.log('[workua] login page opened')

    // Auto-fill + submit when credentials are supplied
    if (email && password) {
      try {
        await page.fill('#user-login', email, { timeout: 10000 })
        await page.fill('#password', password, { timeout: 10000 })
        await page.click('button[type="submit"]', { timeout: 10000 })
        console.log('[workua] credentials submitted — waiting for login or captcha')
      } catch (e) {
        console.log('[workua] auto-fill failed, falling back to manual login:', (e as Error).message)
      }
    } else {
      console.log('[workua] no credentials — waiting for manual sign-in')
    }

    const deadline = Date.now() + 5 * 60 * 1000
    let success = false
    while (Date.now() < deadline) {
      if (page.isClosed()) { console.log('[workua] login window closed by user'); break }
      await page.waitForTimeout(1000)
      let url = ''
      try { url = page.url() } catch { break }
      if (url.includes('work.ua') && !/\/login/i.test(url)) {
        success = true
        break
      }
    }

    if (success) {
      await page.waitForTimeout(1500)
      await context.storageState({ path: SESSION_PATH })
      loginState = 'success'
      console.log('[workua] login captured — session saved')
    } else {
      loginState = 'failed'
      loginError = 'Connexion non détectée (délai de 5 min dépassé ou fenêtre fermée)'
      console.log('[workua] login not detected')
    }
    await browser.close()
    browser = null
  } catch (e: unknown) {
    loginState = 'failed'
    loginError = (e as Error).message
    console.error('[workua] login flow error:', loginError)
  } finally {
    if (browser) { try { await browser.close() } catch { /* ignore */ } }
  }
}

// Open a headless context backed by the saved session. Caller must close the browser.
export async function workuaOpenContext(): Promise<{ browser: Browser; context: BrowserContext } | null> {
  if (!workuaHasSession()) return null
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    storageState: SESSION_PATH,
    locale: 'uk-UA',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  })
  return { browser, context }
}

// Verify the saved session is still authenticated (work.ua hasn't expired it).
export async function workuaCheckSession(): Promise<{ valid: boolean; identity?: string }> {
  const opened = await workuaOpenContext()
  if (!opened) return { valid: false }
  const { browser, context } = opened
  try {
    const page = await context.newPage()
    await page.goto(EMPLOYER_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 })
    const valid = !/\/login/i.test(page.url())
    let identity: string | undefined
    if (valid) {
      identity = await page.locator('.account-name, [class*="user-name"], .header-user').first()
        .textContent({ timeout: 3000 }).then(t => t?.trim() || undefined).catch(() => undefined)
    }
    await browser.close()
    return { valid, identity }
  } catch {
    try { await browser.close() } catch { /* ignore */ }
    return { valid: false }
  }
}
