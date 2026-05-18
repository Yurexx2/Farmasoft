import { Router, Request, Response } from 'express'
import { getDb } from '../db'
import { telegramIsConnected } from '../lib/messaging/telegram'
import {
  getBotSettings, saveBotSettings,
  generateDraft, approveDraft, discardDraft, sendBotMessage,
  getKnowledgeText, saveKnowledgeText,
  importAllDialogs, getDialogSyncProgress,
} from '../lib/telegram-bot/bot'

const router = Router()

// ─── GET /telegram/settings — bot config + connection state ──────────────────
router.get('/settings', (_req: Request, res: Response) => {
  try {
    res.json({ data: { ...getBotSettings(), connected: telegramIsConnected() } })
  } catch (e: unknown) {
    res.json({ error: (e as Error).message })
  }
})

router.post('/settings', (req: Request, res: Response) => {
  try {
    const { mode, calendlyUrl } = req.body as { mode?: 'review' | 'auto'; calendlyUrl?: string }
    saveBotSettings({ mode, calendlyUrl })
    res.json({ data: getBotSettings() })
  } catch (e: unknown) {
    res.json({ error: (e as Error).message })
  }
})

// ─── Knowledge base — editable by Alena ──────────────────────────────────────
router.get('/knowledge', (_req: Request, res: Response) => {
  try {
    res.json({ data: { text: getKnowledgeText() } })
  } catch (e: unknown) {
    res.json({ error: (e as Error).message })
  }
})

router.post('/knowledge', (req: Request, res: Response) => {
  try {
    const { text } = req.body as { text: string }
    saveKnowledgeText(text ?? '')
    res.json({ data: { text: getKnowledgeText() } })
  } catch (e: unknown) {
    res.json({ error: (e as Error).message })
  }
})

// ─── GET /telegram/conversations — list with last message + draft flag ───────
router.get('/conversations', (_req: Request, res: Response) => {
  try {
    const db = getDb()
    const rows = db.prepare(`
      SELECT
        c.id, c.candidate_id, c.job_id, c.status, c.bot_enabled,
        c.turn_count, c.created_at, c.updated_at, c.peer_name, c.unread,
        cand.full_name AS candidate_name, cand.full_name AS candidate_full_name,
        cand.role AS candidate_role, cand.photo_url AS candidate_photo,
        j.title AS job_title,
        (SELECT text FROM tg_messages m WHERE m.conversation_id = c.id AND m.status = 'sent'
          ORDER BY m.id DESC LIMIT 1) AS last_text,
        (SELECT direction FROM tg_messages m WHERE m.conversation_id = c.id AND m.status = 'sent'
          ORDER BY m.id DESC LIMIT 1) AS last_direction,
        (SELECT created_at FROM tg_messages m WHERE m.conversation_id = c.id AND m.status = 'sent'
          ORDER BY m.id DESC LIMIT 1) AS last_at,
        (SELECT COUNT(*) FROM tg_messages m WHERE m.conversation_id = c.id AND m.status = 'pending_review') AS draft_count
      FROM tg_conversations c
      LEFT JOIN candidates cand ON cand.id = c.candidate_id
      LEFT JOIN jobs j ON j.id = c.job_id
      ORDER BY c.updated_at DESC
    `).all()
    res.json({ data: rows })
  } catch (e: unknown) {
    res.json({ error: (e as Error).message })
  }
})

// ─── Import existing Telegram dialogs ────────────────────────────────────────
router.post('/sync-dialogs', (_req: Request, res: Response) => {
  try {
    importAllDialogs().catch(e => console.error('[tg sync-dialogs]', (e as Error).message))
    res.json({ data: { started: true } })
  } catch (e: unknown) {
    res.json({ error: (e as Error).message })
  }
})

router.get('/sync-dialogs/status', (_req: Request, res: Response) => {
  try {
    res.json({ data: getDialogSyncProgress() })
  } catch (e: unknown) {
    res.json({ error: (e as Error).message })
  }
})

// ─── GET /telegram/conversations/:id — full thread ───────────────────────────
router.get('/conversations/:id', (req: Request, res: Response) => {
  try {
    const db = getDb()
    const id = parseInt(req.params.id)
    const conv = db.prepare(`
      SELECT c.*, cand.full_name AS candidate_name, cand.full_name AS candidate_full_name,
             cand.role AS candidate_role, cand.phone AS candidate_phone,
             cand.photo_url AS candidate_photo, j.title AS job_title
      FROM tg_conversations c
      LEFT JOIN candidates cand ON cand.id = c.candidate_id
      LEFT JOIN jobs j ON j.id = c.job_id
      WHERE c.id = ?
    `).get(id)
    if (!conv) return res.json({ error: 'Conversation introuvable' })
    // Opening the thread marks it read.
    db.prepare('UPDATE tg_conversations SET unread = 0 WHERE id = ?').run(id)
    const messages = db.prepare(`
      SELECT id, direction, sender, text, status, tg_message_id, created_at
      FROM tg_messages
      WHERE conversation_id = ? AND status != 'discarded'
      ORDER BY id ASC
    `).all(id)
    res.json({ data: { conversation: conv, messages } })
  } catch (e: unknown) {
    res.json({ error: (e as Error).message })
  }
})

// ─── POST /telegram/conversations/:id/send — Alena replies manually ──────────
router.post('/conversations/:id/send', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id)
    const { text } = req.body as { text: string }
    if (!text?.trim()) return res.json({ error: 'Message vide' })
    const r = await sendBotMessage(id, text.trim(), 'alena')
    res.json(r.ok ? { data: { ok: true } } : { error: r.error })
  } catch (e: unknown) {
    res.json({ error: (e as Error).message })
  }
})

// ─── POST /telegram/conversations/:id/draft — regenerate a bot draft ─────────
router.post('/conversations/:id/draft', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id)
    await generateDraft(id)
    res.json({ data: { ok: true } })
  } catch (e: unknown) {
    res.json({ error: (e as Error).message })
  }
})

// ─── DELETE /telegram/conversations/:id ──────────────────────────────────────
router.delete('/conversations/:id', (req: Request, res: Response) => {
  try {
    const db = getDb()
    const id = parseInt(req.params.id)
    db.prepare('DELETE FROM tg_messages WHERE conversation_id = ?').run(id)
    db.prepare('DELETE FROM tg_conversations WHERE id = ?').run(id)
    res.json({ data: { ok: true } })
  } catch (e: unknown) {
    res.json({ error: (e as Error).message })
  }
})

// ─── Draft review actions ────────────────────────────────────────────────────
router.post('/messages/:id/approve', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id)
    const { text } = req.body as { text?: string }
    const r = await approveDraft(id, text)
    res.json(r.ok ? { data: { ok: true } } : { error: r.error })
  } catch (e: unknown) {
    res.json({ error: (e as Error).message })
  }
})

router.post('/messages/:id/discard', (req: Request, res: Response) => {
  try {
    discardDraft(parseInt(req.params.id))
    res.json({ data: { ok: true } })
  } catch (e: unknown) {
    res.json({ error: (e as Error).message })
  }
})

export default router
