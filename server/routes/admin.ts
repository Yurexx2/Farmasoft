import { Router, Request, Response } from 'express'
import express from 'express'
import fs from 'fs'
import path from 'path'
import { DATA_DIR } from '../db'

const router = Router()

// ─── POST /api/admin/import-db ───────────────────────────────────────────────
// Accepts a raw SQLite file and stores it as farmasoft.db.import. On the next
// service start, db.ts swaps it in — restoring a full local database (settings,
// channel sessions, candidates…) onto a fresh deployment. Auth: API_SECRET.
router.post('/import-db', express.raw({ type: '*/*', limit: '200mb' }), (req: Request, res: Response) => {
  try {
    const body = req.body as Buffer
    if (!Buffer.isBuffer(body) || body.length < 100) {
      return res.json({ error: 'Upload vide ou trop petit' })
    }
    // SQLite files begin with the magic string "SQLite format 3\0".
    if (body.subarray(0, 15).toString('latin1') !== 'SQLite format 3') {
      return res.json({ error: 'Le fichier n’est pas une base SQLite valide' })
    }
    fs.writeFileSync(path.join(DATA_DIR, 'farmasoft.db.import'), body)
    res.json({
      data: {
        ok: true,
        bytes: body.length,
        note: 'Base reçue. Redémarrez le service pour l’appliquer.',
      },
    })
  } catch (e: unknown) {
    res.json({ error: (e as Error).message })
  }
})

export default router
