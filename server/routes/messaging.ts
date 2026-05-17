import { Router, Request, Response } from 'express'
import {
  channelsStatus,
  getWhatsAppCreds, saveWhatsAppCreds, clearWhatsAppCreds,
  getViberCreds,    saveViberCreds,    clearViberCreds,
  saveTelegramCreds, clearTelegramCreds, getTelegramCreds,
  sendToCandidate, Channel, reloadTelegramSession,
} from '../lib/messaging'
import { whatsappTest, whatsappSend } from '../lib/messaging/whatsapp'
import { viberTest, viberSend } from '../lib/messaging/viber'
import {
  telegramStartAuth, telegramSubmitCode, telegramSubmitPassword,
  telegramDisconnect, telegramSend, telegramIsConnected, telegramResendCode,
} from '../lib/messaging/telegram'

const router = Router()

// ─── GET /messaging/status — état des 4 canaux ────────────────────────────
router.get('/status', async (_req: Request, res: Response) => {
  try { res.json({ data: await channelsStatus() }) }
  catch (e: unknown) { res.json({ error: (e as Error).message }) }
})

// ─── WHATSAPP ──────────────────────────────────────────────────────────────
router.post('/whatsapp/connect', async (req: Request, res: Response) => {
  const { accountSid, authToken, fromNumber } = req.body as { accountSid: string; authToken: string; fromNumber: string }
  if (!accountSid || !authToken || !fromNumber) return res.json({ error: 'Tous les champs sont requis' })
  const test = await whatsappTest({ accountSid, authToken, fromNumber })
  if (!test.ok) return res.json({ error: test.error })
  saveWhatsAppCreds({ accountSid, authToken, fromNumber })
  res.json({ data: { ok: true, account: test.account } })
})

router.post('/whatsapp/test-send', async (req: Request, res: Response) => {
  const creds = getWhatsAppCreds()
  if (!creds) return res.json({ error: 'WhatsApp non configuré' })
  const { to, body } = req.body as { to: string; body: string }
  const r = await whatsappSend(creds, to, body || 'Test Farmasoft 👋')
  res.json(r.ok ? { data: r } : { error: r.error })
})

router.post('/whatsapp/disconnect', (_req: Request, res: Response) => {
  clearWhatsAppCreds()
  res.json({ data: { ok: true } })
})

// ─── VIBER ──────────────────────────────────────────────────────────────────
router.post('/viber/connect', async (req: Request, res: Response) => {
  const { token, senderName } = req.body as { token: string; senderName: string }
  if (!token || !senderName) return res.json({ error: 'Token + nom sender requis' })
  const test = await viberTest({ token, senderName })
  if (!test.ok) return res.json({ error: test.error })
  saveViberCreds({ token, senderName })
  res.json({ data: { ok: true } })
})

router.post('/viber/test-send', async (req: Request, res: Response) => {
  const creds = getViberCreds()
  if (!creds) return res.json({ error: 'Viber non configuré' })
  const { to, body } = req.body as { to: string; body: string }
  const r = await viberSend(creds, to, body || 'Test Farmasoft 👋')
  res.json(r.ok ? { data: r } : { error: r.error })
})

router.post('/viber/disconnect', (_req: Request, res: Response) => {
  clearViberCreds()
  res.json({ data: { ok: true } })
})

// ─── TELEGRAM (compte personnel via GramJS) ────────────────────────────────
// Saved api_id / api_hash / phone (no session) — lets the connect modal
// pre-fill so re-authentication only needs the login code.
router.get('/telegram/creds', (_req: Request, res: Response) => {
  const c = getTelegramCreds()
  if (!c) return res.json({ data: null })
  res.json({ data: { apiId: c.apiId, apiHash: c.apiHash, phone: c.phoneNumber } })
})

router.post('/telegram/start', async (req: Request, res: Response) => {
  const { apiId, apiHash, phone } = req.body as { apiId: number | string; apiHash: string; phone: string }
  if (!apiId || !apiHash || !phone) return res.json({ error: 'api_id, api_hash et numéro requis' })
  const r = await telegramStartAuth(parseInt(String(apiId)), apiHash, phone)
  if (!r.ok) return res.json({ error: r.error })
  // Save api creds (without session yet) so they survive reload during auth
  saveTelegramCreds({ apiId: parseInt(String(apiId)), apiHash, phoneNumber: phone })
  res.json({ data: { ok: true, message: 'Code envoyé via Telegram. Saisissez-le.', deliveryType: r.deliveryType, nextType: r.nextType, timeout: r.timeout } })
})

router.post('/telegram/resend', async (_req: Request, res: Response) => {
  const r = await telegramResendCode()
  if (!r.ok) return res.json({ error: r.error })
  res.json({ data: { ok: true, deliveryType: r.deliveryType, nextType: r.nextType } })
})

router.post('/telegram/code', async (req: Request, res: Response) => {
  const { code } = req.body as { code: string }
  if (!code) return res.json({ error: 'Code requis' })
  const r = await telegramSubmitCode(code)
  if (r.needsPassword) return res.json({ data: { needsPassword: true } })
  if (!r.ok) return res.json({ error: r.error })
  // Save session
  if (r.session) {
    const existing = req.body as Record<string, unknown>
    void existing
    const { saveTelegramCreds: save, getTelegramCreds: get } = await import('../lib/messaging')
    const cur = get()
    if (cur) save({ ...cur, session: r.session })
  }
  res.json({ data: { ok: true, identity: r.me } })
})

router.post('/telegram/password', async (req: Request, res: Response) => {
  const { password } = req.body as { password: string }
  if (!password) return res.json({ error: 'Mot de passe requis' })
  const r = await telegramSubmitPassword(password)
  if (!r.ok) return res.json({ error: r.error })
  if (r.session) {
    const { saveTelegramCreds: save, getTelegramCreds: get } = await import('../lib/messaging')
    const cur = get()
    if (cur) save({ ...cur, session: r.session })
  }
  res.json({ data: { ok: true, identity: r.me } })
})

router.post('/telegram/test-send', async (req: Request, res: Response) => {
  if (!telegramIsConnected()) return res.json({ error: 'Telegram non connecté' })
  const { to, body } = req.body as { to: string; body: string }
  const r = await telegramSend(to, body || 'Test Farmasoft 👋')
  res.json(r.ok ? { data: r } : { error: r.error })
})

router.post('/telegram/disconnect', async (_req: Request, res: Response) => {
  await telegramDisconnect()
  clearTelegramCreds()
  res.json({ data: { ok: true } })
})

// Re-establish the live GramJS connection from the saved session — no code
// needed. The connection is in-memory and is lost on every server restart.
router.post('/telegram/reload', async (_req: Request, res: Response) => {
  try {
    await reloadTelegramSession()
    res.json({ data: { connected: telegramIsConnected() } })
  } catch (e: unknown) {
    res.json({ error: (e as Error).message })
  }
})

// ─── UNIFIED SEND ──────────────────────────────────────────────────────────
router.post('/send/:candidateId', async (req: Request, res: Response) => {
  const candidateId = parseInt(req.params.candidateId)
  const { message, ctaUrl, channels, stopOnFirstSuccess } = req.body as {
    message: string; ctaUrl?: string; channels: Channel[]; stopOnFirstSuccess?: boolean
  }
  if (!candidateId || !message || !channels?.length) return res.json({ error: 'candidateId, message et channels requis' })
  const results = await sendToCandidate({ candidateId, message, ctaUrl, channels, stopOnFirstSuccess })
  res.json({ data: results })
})

export default router
