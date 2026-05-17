import { getDb } from '../../db'
import { whatsappSend, whatsappTest, WhatsAppCreds } from './whatsapp'
import { viberSend, viberTest, ViberCreds } from './viber'
import { telegramSend, telegramReloadFromSession, telegramIsConnected, TelegramCreds } from './telegram'
import { startConversation } from '../telegram-bot/bot'

export type Channel = 'telegram' | 'whatsapp' | 'viber' | 'email'
export type ChannelStatus = 'connected' | 'disconnected'

function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value || null
}

function saveSetting(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}

function deleteSettings(keys: string[]): void {
  const stmt = getDb().prepare('DELETE FROM settings WHERE key = ?')
  for (const k of keys) stmt.run(k)
}

// ─── Credentials accessors ──────────────────────────────────────────────────
export function getWhatsAppCreds(): WhatsAppCreds | null {
  const sid    = getSetting('whatsapp_account_sid')
  const token  = getSetting('whatsapp_auth_token')
  const fromN  = getSetting('whatsapp_from')
  if (!sid || !token || !fromN) return null
  return { accountSid: sid, authToken: token, fromNumber: fromN }
}
export function saveWhatsAppCreds(c: WhatsAppCreds): void {
  saveSetting('whatsapp_account_sid', c.accountSid)
  saveSetting('whatsapp_auth_token', c.authToken)
  saveSetting('whatsapp_from', c.fromNumber)
}
export function clearWhatsAppCreds(): void {
  deleteSettings(['whatsapp_account_sid', 'whatsapp_auth_token', 'whatsapp_from'])
}

export function getViberCreds(): ViberCreds | null {
  const token = getSetting('viber_token')
  const sender = getSetting('viber_sender')
  if (!token || !sender) return null
  return { token, senderName: sender }
}
export function saveViberCreds(c: ViberCreds): void {
  saveSetting('viber_token', c.token)
  saveSetting('viber_sender', c.senderName)
}
export function clearViberCreds(): void {
  deleteSettings(['viber_token', 'viber_sender'])
}

export function getTelegramCreds(): TelegramCreds | null {
  const apiId = getSetting('telegram_api_id')
  const apiHash = getSetting('telegram_api_hash')
  const phone = getSetting('telegram_phone')
  const session = getSetting('telegram_session')
  if (!apiId || !apiHash || !phone) return null
  return { apiId: parseInt(apiId), apiHash, phoneNumber: phone, session: session || undefined }
}
export function saveTelegramCreds(c: TelegramCreds): void {
  saveSetting('telegram_api_id', String(c.apiId))
  saveSetting('telegram_api_hash', c.apiHash)
  saveSetting('telegram_phone', c.phoneNumber)
  if (c.session) saveSetting('telegram_session', c.session)
}
export function clearTelegramCreds(): void {
  deleteSettings(['telegram_api_id', 'telegram_api_hash', 'telegram_phone', 'telegram_session'])
}

// ─── Status of each channel ─────────────────────────────────────────────────
export async function channelsStatus(): Promise<Record<Channel, { configured: boolean; connected?: boolean; identity?: string; error?: string }>> {
  const wa = getWhatsAppCreds()
  const vb = getViberCreds()
  const tg = getTelegramCreds()

  const out = {
    whatsapp: { configured: !!wa, connected: !!wa, identity: wa?.fromNumber },
    viber:    { configured: !!vb, connected: !!vb, identity: vb?.senderName },
    telegram: { configured: !!tg, connected: telegramIsConnected(), identity: tg?.phoneNumber },
    email:    { configured: !!getSetting('smtp_user'), connected: !!getSetting('smtp_user'), identity: getSetting('smtp_user') || undefined },
  } as Record<Channel, { configured: boolean; connected?: boolean; identity?: string; error?: string }>
  return out
}

// ─── Auto-reload Telegram session at server startup ─────────────────────────
export async function reloadTelegramSession(): Promise<void> {
  const creds = getTelegramCreds()
  if (!creds || !creds.session) { console.log('[telegram] No saved session'); return }
  console.log('[telegram] Reloading saved session…')
  const result = await telegramReloadFromSession(creds)
  if (result.ok) {
    console.log(`[telegram] Reconnected as ${result.me?.firstName} (@${result.me?.username || creds.phoneNumber})`)
  } else {
    console.warn('[telegram] Session reload failed:', result.error)
  }
}

// ─── Unified send: tries multiple channels in priority order ─────────────────
export interface SendResult {
  channel: Channel
  ok: boolean
  id?: string
  error?: string
}

export async function sendToCandidate(opts: {
  candidateId: number
  message: string
  ctaUrl?: string
  channels: Channel[]   // priority order
  stopOnFirstSuccess?: boolean
}): Promise<SendResult[]> {
  const db = getDb()
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(opts.candidateId) as Record<string, unknown> | undefined
  if (!candidate) return [{ channel: opts.channels[0] || 'email', ok: false, error: 'Candidat introuvable' }]

  const results: SendResult[] = []
  const phone = candidate.phone as string | null
  const email = candidate.email as string | null

  for (const channel of opts.channels) {
    let r: SendResult = { channel, ok: false, error: 'Canal non configuré' }

    try {
      if (channel === 'telegram') {
        if (!telegramIsConnected()) r = { channel, ok: false, error: 'Telegram non connecté' }
        else if (!phone) r = { channel, ok: false, error: 'Pas de numéro pour le candidat' }
        else {
          const send = await telegramSend(phone, opts.message)
          r = { channel, ok: send.ok, id: send.messageId ? String(send.messageId) : undefined, error: send.error }
          // Open a bot conversation thread so the chatbot can take over the
          // moment the candidate replies.
          if (send.ok && send.peerId && send.messageId) {
            try {
              startConversation({
                candidateId: opts.candidateId,
                jobId: (candidate.job_id as number) ?? null,
                peerId: send.peerId,
                peerPhone: phone,
                firstMessage: opts.message,
                tgMessageId: send.messageId,
              })
            } catch (e) { console.error('[tg-bot startConversation]', (e as Error).message) }
          }
        }
      } else if (channel === 'whatsapp') {
        const creds = getWhatsAppCreds()
        if (!creds) r = { channel, ok: false, error: 'WhatsApp non configuré' }
        else if (!phone) r = { channel, ok: false, error: 'Pas de numéro pour le candidat' }
        else {
          const send = await whatsappSend(creds, phone, opts.message)
          r = { channel, ok: send.ok, id: send.sid, error: send.error }
        }
      } else if (channel === 'viber') {
        const creds = getViberCreds()
        if (!creds) r = { channel, ok: false, error: 'Viber non configuré' }
        else if (!phone) r = { channel, ok: false, error: 'Pas de numéro pour le candidat' }
        else {
          const send = await viberSend(creds, phone, opts.message, opts.ctaUrl)
          r = { channel, ok: send.ok, id: send.id, error: send.error }
        }
      } else if (channel === 'email') {
        if (!email) r = { channel, ok: false, error: 'Pas d\'email pour le candidat' }
        else r = await sendEmail(candidate, opts.message, opts.ctaUrl)
      }
    } catch (e: unknown) {
      r = { channel, ok: false, error: (e as Error).message }
    }

    results.push(r)
    db.prepare('INSERT INTO events (type, candidate_id, metadata) VALUES (?, ?, ?)').run(
      'message_sent', opts.candidateId,
      JSON.stringify({ channel, ok: r.ok, error: r.error, id: r.id }),
    )

    if (r.ok && opts.stopOnFirstSuccess) break
    if (r.ok) await new Promise(res => setTimeout(res, 5000)) // delay between channels to avoid spam
  }

  if (results.some(r => r.ok)) {
    db.prepare('UPDATE candidates SET status = ?, contacted_at = CURRENT_TIMESTAMP, outreach_count = COALESCE(outreach_count,0) + 1 WHERE id = ?')
      .run('contacted', opts.candidateId)
  }
  return results
}

async function sendEmail(candidate: Record<string, unknown>, body: string, ctaUrl?: string): Promise<SendResult> {
  const db = getDb()
  const host = getSetting('smtp_host')
  const port = parseInt(getSetting('smtp_port') || '587')
  const user = getSetting('smtp_user')
  const pass = getSetting('smtp_pass')
  const from = getSetting('smtp_from') || user
  if (!host || !user || !pass) return { channel: 'email', ok: false, error: 'SMTP non configuré' }

  const nodemailer = await import('nodemailer')
  const transporter = nodemailer.createTransport({
    host, port, secure: port === 465, auth: { user, pass },
  })
  const subject = (candidate.role as string) ? `Запрошення на розмову — ${candidate.role}` : 'Запрошення на розмову'
  const html = `${body.replace(/\n/g, '<br>')}${ctaUrl ? `<br><br><a href="${ctaUrl}">Записатися на зустріч</a>` : ''}`

  try {
    const info = await transporter.sendMail({ from: from!, to: candidate.email as string, subject, text: body, html })
    db.prepare('INSERT INTO events (type, candidate_id, metadata) VALUES (?, ?, ?)').run(
      'email_sent', candidate.id as number, JSON.stringify({ messageId: info.messageId }),
    )
    return { channel: 'email', ok: true, id: info.messageId }
  } catch (e: unknown) {
    return { channel: 'email', ok: false, error: (e as Error).message }
  }
}
