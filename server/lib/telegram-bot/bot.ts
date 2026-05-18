import fs from 'fs'
import path from 'path'
import { getDb } from '../../db'
import { callClaude, ChatTurn } from './claude'
import {
  telegramSendToPeer, telegramSetTyping, telegramMarkRead,
  telegramFetchSince, telegramFetchDialogs, telegramIsConnected, InboundTelegram,
} from '../messaging/telegram'

// ─── Settings ────────────────────────────────────────────────────────────────
function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}
function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}

export interface BotSettings {
  // review = the bot drafts a reply for Alena to edit/send;
  // auto    = the bot sends on its own. The bot is always active.
  mode: 'review' | 'auto'
  calendlyUrl: string
}
export function getBotSettings(): BotSettings {
  return {
    mode:        (getSetting('tg_bot_mode') as 'review' | 'auto') ?? 'review',
    // Reuse the Calendly link already configured for the rest of Farmasoft —
    // no separate setup needed for the bot.
    calendlyUrl: getSetting('calendly_url') ?? '',
  }
}
export function saveBotSettings(s: Partial<BotSettings>): void {
  if (s.mode)                      setSetting('tg_bot_mode', s.mode)
  if (s.calendlyUrl !== undefined) setSetting('calendly_url', s.calendlyUrl)
}

// ─── Knowledge base ──────────────────────────────────────────────────────────
// knowledge.md ships as the default; Alena can edit it anytime from the UI,
// in which case the edited text is stored in settings and takes precedence.
let fileKnowledgeCache: string | null = null
function fileKnowledge(): string {
  if (fileKnowledgeCache !== null) return fileKnowledgeCache
  try {
    fileKnowledgeCache = fs.readFileSync(path.join(__dirname, 'knowledge.md'), 'utf8')
  } catch {
    fileKnowledgeCache = ''
  }
  return fileKnowledgeCache
}
function loadKnowledge(): string {
  return getSetting('tg_knowledge') ?? fileKnowledge()
}
/** The current knowledge base text (edited override, or the shipped default). */
export function getKnowledgeText(): string {
  return loadKnowledge()
}
/** Save an edited knowledge base. Empty string reverts to the shipped file. */
export function saveKnowledgeText(text: string): void {
  if (text.trim()) setSetting('tg_knowledge', text)
  else getDb().prepare("DELETE FROM settings WHERE key = 'tg_knowledge'").run()
}

// ─── Types ───────────────────────────────────────────────────────────────────
interface ConvRow {
  id: number
  candidate_id: number | null
  job_id: number | null
  peer_id: string | null
  peer_access_hash: string | null
  peer_username: string | null
  peer_phone: string | null
  status: string
  bot_enabled: number
  last_seen_message_id: number
  turn_count: number
}

// ─── Conversation lifecycle ──────────────────────────────────────────────────

/**
 * Called right after Alena's first outreach message goes out over Telegram.
 * Creates the conversation thread and records that first message.
 */
export function startConversation(opts: {
  candidateId: number
  jobId: number | null
  peerId: string
  accessHash?: string | null
  peerPhone?: string | null
  firstMessage: string
  tgMessageId: number
}): number {
  const db = getDb()
  // One conversation per candidate — reuse if a thread already exists.
  const existing = db.prepare('SELECT id FROM tg_conversations WHERE candidate_id = ?').get(opts.candidateId) as { id: number } | undefined
  let convId: number
  if (existing) {
    convId = existing.id
    db.prepare('UPDATE tg_conversations SET peer_id = ?, peer_access_hash = ?, peer_phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(opts.peerId, opts.accessHash ?? null, opts.peerPhone ?? null, convId)
  } else {
    const r = db.prepare(`
      INSERT INTO tg_conversations (candidate_id, job_id, peer_id, peer_access_hash, peer_phone, status, bot_enabled)
      VALUES (?, ?, ?, ?, ?, 'awaiting_reply', 1)
    `).run(opts.candidateId, opts.jobId, opts.peerId, opts.accessHash ?? null, opts.peerPhone ?? null)
    convId = r.lastInsertRowid as number
  }
  insertMessage(convId, 'out', 'alena', opts.firstMessage, opts.tgMessageId, 'sent')
  return convId
}

function insertMessage(
  convId: number, direction: 'in' | 'out', sender: 'candidate' | 'bot' | 'alena',
  text: string, tgMessageId: number | null, status: 'sent' | 'pending_review' | 'discarded',
  createdAt?: string,
): number {
  const db = getDb()
  try {
    const r = createdAt
      ? db.prepare(`
          INSERT INTO tg_messages (conversation_id, direction, sender, text, tg_message_id, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(convId, direction, sender, text, tgMessageId, status, createdAt)
      : db.prepare(`
          INSERT INTO tg_messages (conversation_id, direction, sender, text, tg_message_id, status)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(convId, direction, sender, text, tgMessageId, status)
    db.prepare('UPDATE tg_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(convId)
    return r.lastInsertRowid as number
  } catch {
    // Unique index hit — this message was already stored.
    return 0
  }
}

// ─── Inbound handling ────────────────────────────────────────────────────────
const debounceTimers = new Map<number, NodeJS.Timeout>()

/** Registered as the global Telegram inbound callback (see index.ts). */
export function handleInbound(msg: InboundTelegram): void {
  try {
    const db = getDb()
    const conv = db.prepare('SELECT * FROM tg_conversations WHERE peer_id = ?').get(msg.peerId) as ConvRow | undefined
    if (!conv) return  // not a candidate we started a thread with — ignore

    const stored = insertMessage(conv.id, 'in', 'candidate', msg.text, msg.messageId, 'sent')
    if (!stored) return  // duplicate

    db.prepare('UPDATE tg_conversations SET last_seen_message_id = MAX(last_seen_message_id, ?), unread = 1 WHERE id = ?')
      .run(msg.messageId, conv.id)
    logEvent('tg_inbound', conv.candidate_id, { conversationId: conv.id })

    // The bot is always active on every conversation. Debounce: a candidate
    // often sends several messages in a row.
    const prev = debounceTimers.get(conv.id)
    if (prev) clearTimeout(prev)
    debounceTimers.set(conv.id, setTimeout(() => {
      debounceTimers.delete(conv.id)
      generateDraft(conv.id).catch(e => console.error('[tg-bot draft]', (e as Error).message))
    }, 5000))
  } catch (e) {
    console.error('[tg-bot handleInbound]', (e as Error).message)
  }
}

// ─── Draft generation ────────────────────────────────────────────────────────

/**
 * Build the Claude prompt from the conversation and produce the next reply.
 * In review mode the reply is stored as a pending_review draft; in auto mode
 * it is sent immediately.
 */
export async function generateDraft(convId: number): Promise<void> {
  const db = getDb()
  const conv = db.prepare('SELECT * FROM tg_conversations WHERE id = ?').get(convId) as ConvRow | undefined
  if (!conv) return

  const settings = getBotSettings()

  // Drop any earlier un-reviewed draft — the candidate has spoken since.
  db.prepare("UPDATE tg_messages SET status = 'discarded' WHERE conversation_id = ? AND status = 'pending_review'").run(convId)

  const candidate = conv.candidate_id
    ? db.prepare('SELECT full_name, role FROM candidates WHERE id = ?').get(conv.candidate_id) as Record<string, unknown> | undefined
    : undefined
  const job = conv.job_id
    ? db.prepare('SELECT title FROM jobs WHERE id = ?').get(conv.job_id) as { title: string } | undefined
    : undefined

  const history = db.prepare(`
    SELECT direction, sender, text FROM tg_messages
    WHERE conversation_id = ? AND status = 'sent'
    ORDER BY id ASC
  `).all(convId) as { direction: string; sender: string; text: string }[]

  const system = buildSystemPrompt({
    candidateName: (candidate?.full_name || '') as string,
    jobTitle: job?.title || '',
    firstMessage: history.find(h => h.direction === 'out')?.text || '',
    calendlyUrl: settings.calendlyUrl,
    turnCount: conv.turn_count,
  })

  // Claude needs a user-led, alternating transcript. The first outreach lives
  // in the system prompt, so the message list starts at the candidate's reply.
  const turns: ChatTurn[] = []
  let started = false
  for (const h of history) {
    if (!started) { if (h.direction === 'in') started = true; else continue }
    const role: ChatTurn['role'] = h.direction === 'in' ? 'user' : 'assistant'
    const last = turns[turns.length - 1]
    if (last && last.role === role) last.content += '\n' + h.text
    else turns.push({ role, content: h.text })
  }
  if (turns.length === 0 || turns[0].role !== 'user') return  // nothing to reply to

  let raw: string
  try {
    raw = await callClaude(system, turns, { maxTokens: 600, temperature: 0.7 })
  } catch (e) {
    console.error('[tg-bot claude]', (e as Error).message)
    return
  }

  const parsed = parseReply(raw)
  if (parsed.action === 'handoff') {
    db.prepare("UPDATE tg_conversations SET status = 'human' WHERE id = ?").run(convId)
    logEvent('tg_handoff', conv.candidate_id, { conversationId: convId, reason: parsed.message })
    return
  }
  const text = sanitize(parsed.message)
  if (!text) return

  if (settings.mode === 'auto') {
    await sendBotMessage(convId, text)
  } else {
    insertMessage(convId, 'out', 'bot', text, null, 'pending_review')
    logEvent('tg_draft_ready', conv.candidate_id, { conversationId: convId })
  }
}

/** Approve a pending draft (review mode) and send it. */
export async function approveDraft(messageId: number, overrideText?: string): Promise<{ ok: boolean; error?: string }> {
  const db = getDb()
  const msg = db.prepare("SELECT * FROM tg_messages WHERE id = ? AND status = 'pending_review'").get(messageId) as
    { id: number; conversation_id: number; text: string } | undefined
  if (!msg) return { ok: false, error: 'Brouillon introuvable' }
  const text = sanitize(overrideText ?? msg.text)
  if (!text) return { ok: false, error: 'Message vide' }
  db.prepare("UPDATE tg_messages SET status = 'discarded' WHERE id = ?").run(messageId)
  return sendBotMessage(msg.conversation_id, text)
}

/** Discard a pending draft without sending. */
export function discardDraft(messageId: number): void {
  getDb().prepare("UPDATE tg_messages SET status = 'discarded' WHERE id = ? AND status = 'pending_review'").run(messageId)
}

/**
 * Send a bot/Alena message to the candidate, simulating a human: mark the
 * chat read, show "typing…", pause proportionally to length, then send.
 */
export async function sendBotMessage(
  convId: number, text: string, sender: 'bot' | 'alena' = 'bot',
): Promise<{ ok: boolean; error?: string }> {
  const db = getDb()
  const conv = db.prepare('SELECT * FROM tg_conversations WHERE id = ?').get(convId) as ConvRow | undefined
  if (!conv?.peer_id) return { ok: false, error: 'Conversation sans destinataire' }
  if (!telegramIsConnected()) return { ok: false, error: 'Telegram non connecté' }

  await telegramMarkRead(conv.peer_id, conv.peer_access_hash)
  await telegramSetTyping(conv.peer_id, conv.peer_access_hash)
  // Human-like pause: ~45ms per character, clamped to 2–7s.
  const pause = Math.min(7000, Math.max(2000, text.length * 45))
  await new Promise(r => setTimeout(r, pause))

  const sent = await telegramSendToPeer(conv.peer_id, conv.peer_access_hash, text)
  if (!sent.ok) return { ok: false, error: sent.error }

  insertMessage(convId, 'out', sender, text, sent.messageId ?? null, 'sent')
  db.prepare('UPDATE tg_conversations SET turn_count = turn_count + 1, unread = 0 WHERE id = ?').run(convId)
  logEvent('tg_sent', conv.candidate_id, { conversationId: convId, sender })
  return { ok: true }
}

// ─── Recovery — fetch messages missed while offline ──────────────────────────
export async function recoverMissed(): Promise<void> {
  if (!telegramIsConnected()) return
  const db = getDb()
  const convs = db.prepare(`
    SELECT * FROM tg_conversations WHERE status NOT IN ('closed', 'booked') AND peer_id IS NOT NULL
  `).all() as unknown as ConvRow[]

  for (const conv of convs) {
    try {
      const missed = await telegramFetchSince(conv.peer_id!, conv.peer_access_hash, conv.last_seen_message_id)
      let newest = conv.last_seen_message_id
      let gotInbound = false
      for (const m of missed) {
        const stored = insertMessage(conv.id, 'in', 'candidate', m.text, m.messageId, 'sent')
        if (stored) gotInbound = true
        newest = Math.max(newest, m.messageId)
      }
      if (newest > conv.last_seen_message_id) {
        db.prepare('UPDATE tg_conversations SET last_seen_message_id = ? WHERE id = ?').run(newest, conv.id)
      }
      if (gotInbound) {
        db.prepare('UPDATE tg_conversations SET unread = 1 WHERE id = ?').run(conv.id)
        if (conv.status === 'awaiting_reply') {
          db.prepare("UPDATE tg_conversations SET status = 'bot_active' WHERE id = ?").run(conv.id)
        }
      }
    } catch (e) {
      console.error('[tg-bot recover]', conv.id, (e as Error).message)
    }
  }
  // Now draft replies for every thread left with an unanswered candidate
  // message — covers both freshly-recovered messages and any that arrived
  // while the bot was switched off.
  await processPendingConversations()
}

/**
 * Find every conversation whose last message is an unanswered candidate
 * message — with the bot enabled and no draft already waiting — and generate
 * a reply. Run on startup and whenever the bot is (re-)enabled, so no message
 * is ever left silently unanswered.
 */
export async function processPendingConversations(convId?: number): Promise<void> {
  const db = getDb()
  const convs = (convId
    ? db.prepare('SELECT * FROM tg_conversations WHERE id = ?').all(convId)
    : db.prepare('SELECT * FROM tg_conversations').all()
  ) as unknown as ConvRow[]

  for (const conv of convs) {
    try {
      const last = db.prepare(`
        SELECT direction FROM tg_messages WHERE conversation_id = ? AND status = 'sent'
        ORDER BY id DESC LIMIT 1
      `).get(conv.id) as { direction: string } | undefined
      if (last?.direction !== 'in') continue  // nothing waiting for a reply
      const hasDraft = db.prepare(
        "SELECT 1 FROM tg_messages WHERE conversation_id = ? AND status = 'pending_review' LIMIT 1",
      ).get(conv.id)
      if (hasDraft) continue
      await generateDraft(conv.id)
    } catch (e) {
      console.error('[tg-bot pending]', conv.id, (e as Error).message)
    }
  }
}

// ─── Dialog import — bring Alena's existing Telegram chats into the tab ──────
export interface DialogSyncProgress {
  status: 'idle' | 'running' | 'done' | 'error'
  total: number
  done: number
  newConversations: number
  error?: string
}
let dialogSync: DialogSyncProgress = { status: 'idle', total: 0, done: 0, newConversations: 0 }
export function getDialogSyncProgress(): DialogSyncProgress { return dialogSync }

function normPhone(p?: string | null): string {
  return (p || '').replace(/\D/g, '').slice(-9)  // last 9 digits — country-code agnostic
}

/**
 * Import every private conversation from the connected Telegram account into
 * the tab. Threads are matched to a Farmasoft candidate by phone when possible;
 * imported threads have the bot OFF (status 'human') so it never hijacks an
 * existing personal chat — Alena enables it per-thread if she wants.
 */
export async function importAllDialogs(): Promise<void> {
  if (dialogSync.status === 'running') return
  dialogSync = { status: 'running', total: 0, done: 0, newConversations: 0 }
  try {
    if (!telegramIsConnected()) throw new Error('Telegram non connecté')
    const dialogs = await telegramFetchDialogs(120, 30)
    dialogSync.total = dialogs.length
    const db = getDb()

    // Index known candidates by phone for matching.
    const cands = db.prepare(
      "SELECT id, phone, job_id FROM candidates WHERE phone IS NOT NULL AND phone != ''",
    ).all() as { id: number; phone: string; job_id: number | null }[]
    const byPhone = new Map<string, { id: number; job_id: number | null }>()
    for (const c of cands) {
      const k = normPhone(c.phone)
      if (k) byPhone.set(k, { id: c.id, job_id: c.job_id })
    }

    for (const dlg of dialogs) {
      try {
        const existing = db.prepare(
          'SELECT id, last_seen_message_id FROM tg_conversations WHERE peer_id = ?',
        ).get(dlg.peerId) as { id: number; last_seen_message_id: number } | undefined
        const match = dlg.phone ? byPhone.get(normPhone(dlg.phone)) : undefined

        let convId: number
        if (existing) {
          convId = existing.id
          db.prepare(`
            UPDATE tg_conversations SET peer_name = ?, peer_username = ?,
            peer_access_hash = COALESCE(?, peer_access_hash),
            peer_phone = COALESCE(peer_phone, ?) WHERE id = ?
          `).run(dlg.name, dlg.username ?? null, dlg.accessHash ?? null, dlg.phone ?? null, convId)
        } else {
          const r = db.prepare(`
            INSERT INTO tg_conversations
              (candidate_id, job_id, peer_id, peer_access_hash, peer_name, peer_username, peer_phone, status, bot_enabled)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'human', 0)
          `).run(match?.id ?? null, match?.job_id ?? null, dlg.peerId, dlg.accessHash ?? null, dlg.name,
                 dlg.username ?? null, dlg.phone ?? null)
          convId = r.lastInsertRowid as number
          dialogSync.newConversations++
        }

        let maxId = existing?.last_seen_message_id ?? 0
        for (const m of dlg.messages) {
          insertMessage(
            convId, m.out ? 'out' : 'in', m.out ? 'alena' : 'candidate',
            m.text, m.id, 'sent',
            m.date ? new Date(m.date * 1000).toISOString() : undefined,
          )
          if (m.id > maxId) maxId = m.id
        }
        db.prepare(
          'UPDATE tg_conversations SET last_seen_message_id = MAX(last_seen_message_id, ?) WHERE id = ?',
        ).run(maxId, convId)
      } catch (e) {
        console.error('[tg-bot import dialog]', (e as Error).message)
      }
      dialogSync.done++
    }
    dialogSync.status = 'done'
    console.log(`[tg-bot] dialog import done — ${dialogSync.total} threads, ${dialogSync.newConversations} new`)
  } catch (e) {
    dialogSync = { ...dialogSync, status: 'error', error: (e as Error).message }
    console.error('[tg-bot import]', (e as Error).message)
  }
}

// ─── Prompt building ─────────────────────────────────────────────────────────
function buildSystemPrompt(ctx: {
  candidateName: string
  jobTitle: string
  firstMessage: string
  calendlyUrl: string
  turnCount: number
}): string {
  const calendly = ctx.calendlyUrl
    ? `Посилання Calendly для запису на зустріч: ${ctx.calendlyUrl}\nНадсилай це посилання ЛИШЕ коли кандидат щиро зацікавлений — ніколи в першому-другому повідомленні.`
    : 'Посилання Calendly ще не налаштоване — якщо кандидат готовий до зустрічі, передай розмову Альоні (action: handoff).'

  return `${loadKnowledge()}

---

## Поточний контекст розмови

- Кандидат: ${ctx.candidateName || 'невідомо'}
- Вакансія: ${ctx.jobTitle || 'невідомо'}
- Перше повідомлення, яке Альона вже надіслала кандидату:
  «${ctx.firstMessage || '(невідомо)'}»

${calendly}

## Формат відповіді

Ти — Альона Приходько. Відповідай ВИКЛЮЧНО валідним JSON, без жодного тексту навколо:
{"action": "reply", "message": "<твоя відповідь кандидату українською>"}
або, якщо питання делікатне / поза скриптом / конфліктне:
{"action": "handoff", "message": "<коротка причина для Альони>"}

Повідомлення мають бути короткі, людяні, у стилі Telegram. Без зірочок, без markdown, без канцеляризмів.`
}

interface ParsedReply { action: 'reply' | 'handoff'; message: string }
function parseReply(raw: string): ParsedReply {
  try {
    const m = raw.match(/\{[\s\S]*\}/)
    if (m) {
      const obj = JSON.parse(m[0]) as Partial<ParsedReply>
      if (obj.action === 'handoff') return { action: 'handoff', message: obj.message || '' }
      if (obj.message) return { action: 'reply', message: obj.message }
    }
  } catch { /* fall through */ }
  // Claude answered in plain text — treat the whole thing as the reply.
  return { action: 'reply', message: raw }
}

/** Strip markdown emphasis Claude sometimes leaks into chat text. */
function sanitize(text: string): string {
  return (text || '')
    .replace(/\*+/g, '')
    .replace(/^#+\s*/gm, '')
    .trim()
}

function logEvent(type: string, candidateId: number | null, metadata: Record<string, unknown>): void {
  try {
    getDb().prepare('INSERT INTO events (type, candidate_id, metadata) VALUES (?, ?, ?)')
      .run(type, candidateId, JSON.stringify(metadata))
  } catch { /* events table optional */ }
}
