import { Router, Request, Response } from 'express'
import { getDb } from '../db'
import { calendlyTest, calendlyListEvents } from '../lib/calendly'

const router = Router()

function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}
function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}

// ─── Calendly sync — bookings become Farmasoft interviews ────────────────────
// For every active Calendly booking: find the candidate by invitee e-mail,
// create/update an `interviews` row and move the candidate to the interview
// stage. Canceled bookings drop their interview row.
export async function syncCalendly(): Promise<void> {
  const token = getSetting('calendly_token')
  if (!token) return
  const db = getDb()
  const from = new Date(Date.now() - 24 * 3600 * 1000)            // include today
  const to   = new Date(Date.now() + 60 * 24 * 3600 * 1000)       // next 60 days

  let events
  try {
    events = await calendlyListEvents(token, from.toISOString(), to.toISOString())
  } catch (e) {
    console.error('[calendly sync]', (e as Error).message)
    return
  }

  for (const ev of events) {
    try {
      if (ev.status !== 'active') {
        db.prepare('DELETE FROM interviews WHERE calendly_event_uri = ?').run(ev.uri)
        continue
      }
      const cand = ev.inviteeEmail
        ? db.prepare('SELECT id, job_id, stage FROM candidates WHERE lower(email) = lower(?)')
            .get(ev.inviteeEmail) as { id: number; job_id: number | null; stage: string } | undefined
        : undefined

      const existing = db.prepare('SELECT id FROM interviews WHERE calendly_event_uri = ?')
        .get(ev.uri) as { id: number } | undefined
      if (existing) {
        db.prepare('UPDATE interviews SET scheduled_at = ?, updated_at = CURRENT_TIMESTAMP WHERE calendly_event_uri = ?')
          .run(ev.start, ev.uri)
      } else {
        db.prepare(`
          INSERT INTO interviews (candidate_id, job_id, scheduled_at, type, interviewer, notes, calendly_event_uri)
          VALUES (?, ?, ?, 'video', '', ?, ?)
        `).run(cand?.id ?? null, cand?.job_id ?? null, ev.start,
               ev.inviteeName ? `Calendly — ${ev.inviteeName}` : 'Calendly', ev.uri)
      }
      // Booking a meeting moves the candidate to the interview stage.
      if (cand && cand.stage === 'new') {
        db.prepare("UPDATE candidates SET stage = 'interview' WHERE id = ?").run(cand.id)
      }
    } catch (e) {
      console.error('[calendly sync event]', (e as Error).message)
    }
  }
}

// ─── GET /calendar/status ────────────────────────────────────────────────────
router.get('/status', (_req: Request, res: Response) => {
  try {
    res.json({ data: { connected: !!getSetting('calendly_token'), calendlyUrl: getSetting('calendly_url') || '' } })
  } catch (e: unknown) {
    res.json({ error: (e as Error).message })
  }
})

// ─── POST /calendar/connect — save + test the Calendly API token ─────────────
router.post('/connect', async (req: Request, res: Response) => {
  try {
    const { token } = req.body as { token: string }
    if (!token?.trim()) return res.json({ error: 'Clé API requise' })
    const test = await calendlyTest(token.trim())
    if (!test.ok) return res.json({ error: test.error })
    setSetting('calendly_token', token.trim())
    syncCalendly().catch(e => console.error('[calendly connect-sync]', (e as Error).message))
    res.json({ data: { ok: true, name: test.name } })
  } catch (e: unknown) {
    res.json({ error: (e as Error).message })
  }
})

router.post('/disconnect', (_req: Request, res: Response) => {
  try {
    getDb().prepare("DELETE FROM settings WHERE key = 'calendly_token'").run()
    res.json({ data: { ok: true } })
  } catch (e: unknown) {
    res.json({ error: (e as Error).message })
  }
})

// ─── POST /calendar/sync — trigger a sync on demand ──────────────────────────
router.post('/sync', async (_req: Request, res: Response) => {
  try {
    await syncCalendly()
    res.json({ data: { ok: true } })
  } catch (e: unknown) {
    res.json({ error: (e as Error).message })
  }
})

export default router
