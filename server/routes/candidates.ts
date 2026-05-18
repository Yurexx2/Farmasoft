import { Router, Request, Response } from 'express'
import { getDb } from '../db'
import { callLLM } from '../lib/llm'

const router = Router()

const VALID_STATUSES = ['new', 'viewed', 'contacted', 'rejected']
const VALID_STAGES = ['new', 'interview', 'decision']

router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDb()
    const { jobId } = req.query
    const limit = Math.min(parseInt(req.query.limit as string) || 500, 1000)
    const offset = (Math.max(parseInt(req.query.page as string) || 1, 1) - 1) * limit

    const candidates = jobId
      ? db.prepare('SELECT * FROM candidates WHERE job_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(jobId, limit, offset)
      : db.prepare('SELECT * FROM candidates ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset)

    res.json({ data: candidates })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb()
    const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id)
    if (!candidate) return res.json({ error: 'Candidat introuvable' })
    res.json({ data: candidate })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

router.put('/:id/status', (req: Request, res: Response) => {
  try {
    const db = getDb()
    const { id } = req.params
    const { status } = req.body

    if (!VALID_STATUSES.includes(status)) {
      return res.json({ error: `Statut invalide. Valeurs acceptées : ${VALID_STATUSES.join(', ')}` })
    }

    let extra = ''
    const args: unknown[] = [status]

    if (status === 'viewed') {
      extra = ', viewed_at = CURRENT_TIMESTAMP'
    } else if (status === 'contacted') {
      extra = ', contacted_at = CURRENT_TIMESTAMP'
    }

    db.prepare(`UPDATE candidates SET status = ?${extra} WHERE id = ?`).run(...args, id)

    const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id)
    res.json({ data: candidate })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

router.delete('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb()
    db.prepare('DELETE FROM candidates WHERE id = ?').run(req.params.id)
    res.json({ success: true })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

router.put('/:id/stage', (req: Request, res: Response) => {
  try {
    const db = getDb()
    const { id } = req.params
    const { stage } = req.body

    if (!VALID_STAGES.includes(stage)) {
      return res.json({ error: `Stage invalide. Valeurs acceptées : ${VALID_STAGES.join(', ')}` })
    }

    db.prepare('UPDATE candidates SET stage = ? WHERE id = ?').run(stage, id)
    const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id)
    res.json({ data: candidate })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

// Move a candidate to a Kanban column — sets status/stage/decision in one go.
const KANBAN: Record<string, { status: string; stage: string; decision: string }> = {
  tocontact:   { status: 'viewed',    stage: 'new',      decision: 'pending' },
  contacted:   { status: 'contacted', stage: 'new',      decision: 'pending' },
  interviewed: { status: 'contacted', stage: 'interview', decision: 'pending' },
  accepted:    { status: 'contacted', stage: 'decision', decision: 'hire' },
  rejected:    { status: 'rejected',  stage: 'decision', decision: 'reject' },
}
router.put('/:id/kanban', (req: Request, res: Response) => {
  try {
    const db = getDb()
    const m = KANBAN[(req.body as { column: string }).column]
    if (!m) return res.json({ error: 'Colonne invalide' })
    db.prepare('UPDATE candidates SET status = ?, stage = ?, decision = ? WHERE id = ?')
      .run(m.status, m.stage, m.decision, req.params.id)
    res.json({ data: db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id) })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

router.put('/:id/rejection-reason', (req: Request, res: Response) => {
  try {
    const db = getDb()
    const { id } = req.params
    const { rejection_reason } = req.body
    db.prepare('UPDATE candidates SET rejection_reason = ? WHERE id = ?').run(rejection_reason || null, id)
    const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id)
    res.json({ data: candidate })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

router.post('/:id/qualify', async (req: Request, res: Response) => {
  try {
    const db = getDb()
    const { id } = req.params
    const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!candidate) return res.json({ error: 'Candidat introuvable' })

    const job = candidate.job_id
      ? db.prepare('SELECT * FROM jobs WHERE id = ?').get(candidate.job_id) as Record<string, unknown> | null
      : null

    const profile = (() => {
      try { return candidate.profile_data ? JSON.parse(candidate.profile_data as string) : null } catch { return null }
    })()

    const expYears = candidate.experience_years != null ? `${candidate.experience_years} ans` : null
    const expLine = [expYears, candidate.experience_text].filter(Boolean).join(' — ') || 'Non précisée'

    const candidateLines = [
      `- Titre du profil : ${candidate.role || 'Non précisé'}`,
      `- Expérience : ${expLine}`,
      `- Localisation : ${candidate.location || 'Non précisée'}`,
      `- Plateforme source : ${candidate.source_platform || 'inconnue'}`,
      profile?.skills?.length   ? `- Compétences : ${profile.skills.join(', ')}` : null,
      profile?.education        ? `- Formation : ${profile.education}` : null,
      profile?.languages?.length ? `- Langues : ${profile.languages.join(', ')}` : null,
      profile?.summary          ? `- Résumé : ${profile.summary}` : null,
      candidate.cv_text         ? `- Extrait CV : ${String(candidate.cv_text).substring(0, 2000)}` : null,
    ].filter(Boolean).join('\n')

    const prompt = `Tu es un expert RH chez Farmasoft UA. Évalue ce candidat par rapport au poste et donne un score de 0 à 100.
RÈGLE CRITIQUE : tu DOIS toujours répondre avec le JSON demandé, même si les informations sont limitées. Fais une estimation basée sur ce qui est disponible (titre du poste, expérience, plateforme).

POSTE RECHERCHÉ : ${job?.title ?? 'Non spécifié'}
Compétences requises : ${job?.skills ?? 'Non spécifiées'}
Expérience requise : ${job?.experience_years ?? 0} ans minimum
Description : ${job?.description ?? ''}
Exigences : ${job?.requirements ?? ''}

CANDIDAT :
${candidateLines}

Réponds UNIQUEMENT en JSON valide sans markdown, sans texte avant ou après :
{"score": <entier 0-100>, "notes": "<2-3 points clés concis sur l'adéquation au poste>"}`

    const text = await callLLM(prompt, { jsonMode: true, timeoutMs: 30000 })
    const parsed = JSON.parse(text) as { score: number; notes: string }
    if (typeof parsed.score !== 'number') throw new Error('Invalid score in AI response')

    db.prepare('UPDATE candidates SET qualification_score = ?, qualification_notes = ? WHERE id = ?')
      .run(parsed.score, parsed.notes, id)

    const updated = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id)
    res.json({ data: updated })
  } catch (err: unknown) {
    const msg = (err as Error).message
    if (msg.includes('JSON')) return res.json({ error: 'Réponse IA invalide. Réessayez.' })
    res.json({ error: `Erreur qualification : ${msg}` })
  }
})

export default router
