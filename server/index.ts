import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import { getDb } from './db'
import jobsRouter from './routes/jobs'
import candidatesRouter from './routes/candidates'
import messagesRouter from './routes/messages'
import settingsRouter from './routes/settings'
import analyticsRouter from './routes/analytics'
import scraperRouter from './routes/scraper'
import aiRouter from './routes/ai'
import interviewsRouter from './routes/interviews'
import cvRouter from './routes/cv'
import robotaRouter, { runFollowUps, runFullSync } from './routes/robota'
import messagingRouter from './routes/messaging'
import salaryRouter from './routes/salary'
import adminRouter from './routes/admin'
import telegramBotRouter from './routes/telegram'
// work.ua integration disabled — their employer dashboard sits behind a
// Cloudflare bot-management challenge with no interactive element, which
// blocks any automated browser. Source kept dormant in routes/workua.ts +
// lib/workua/ in case work.ua ever drops the protection.
// import workuaRouter from './routes/workua'
import { reloadTelegramSession } from './lib/messaging'
import { telegramIsConnected, onTelegramInbound } from './lib/messaging/telegram'
import { handleInbound, recoverMissed } from './lib/telegram-bot/bot'
import { apiAuth } from './middleware/auth'

const app = express()
const PORT = process.env.PORT || 3001

// Farmasoft can be served at the domain root (default) or under a sub-path
// (BASE_PATH=/farmasoft/hr behind a reverse proxy). Empty → root.
const BASE_PATH = (process.env.BASE_PATH || '').trim().replace(/^\/+|\/+$/g, '')
const PREFIX = BASE_PATH ? `/${BASE_PATH}` : ''

app.use(cors({ origin: ['http://localhost:5173', 'http://localhost:3001'] }))
app.use(express.json({ strict: false, limit: '50mb' }))

// Always-on health check at the true root — Render hits this regardless of BASE_PATH.
app.get('/healthz', (_req, res) => res.json({ ok: true }))

// All API routes under <prefix>/api.
// The JSON Content-Type is scoped to the API router only — applying it globally
// would also tag the static HTML/JS/CSS as application/json (express.static and
// sendFile won't override an already-set Content-Type), so the browser would
// render index.html as raw text instead of a page.
const api = express.Router()
api.use((_req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  next()
})
api.use(apiAuth)
api.use('/jobs', jobsRouter)
api.use('/candidates', candidatesRouter)
api.use('/messages', messagesRouter)
api.use('/settings', settingsRouter)
api.use('/analytics', analyticsRouter)
api.use('/scraper', scraperRouter)
api.use('/ai', aiRouter)
api.use('/interviews', interviewsRouter)
api.use('/cv', cvRouter)
api.use('/robota', robotaRouter)
api.use('/messaging', messagingRouter)
api.use('/salary', salaryRouter)
api.use('/admin', adminRouter)
api.use('/telegram', telegramBotRouter)
// api.use('/workua', workuaRouter)  // disabled — see import note above
app.use(`${PREFIX}/api`, api)

if (process.env.NODE_ENV === 'production') {
  // Serve the built frontend under the same prefix the assets were built with.
  // index:false so express.static does NOT auto-serve index.html — every HTML
  // request must fall through to the route below, which injects the API key.
  app.use(PREFIX || '/', express.static(path.join(process.cwd(), 'dist'), { index: false }))

  // Inject the API key into index.html at request time. This makes the key a
  // runtime concern (the server is the single source of truth) instead of a
  // build-time one — so it never depends on VITE_API_SECRET being set during
  // the Docker build, and changing API_SECRET never needs a frontend rebuild.
  const indexPath = path.join(process.cwd(), 'dist', 'index.html')
  const rawIndex = fs.readFileSync(indexPath, 'utf8')
  app.get(`${PREFIX}/*`, (_req, res) => {
    const key = process.env.API_SECRET || ''
    const html = rawIndex.replace(
      '</head>',
      `<script>window.__FARMASOFT_API_KEY__=${JSON.stringify(key)}</script></head>`,
    )
    res.type('html').send(html)
  })
}

const db = getDb()

// Purge candidates older than 6 months (data retention policy)
function purgeExpiredCandidates() {
  const result = db.prepare(
    `DELETE FROM candidates WHERE created_at < datetime('now', '-6 months')`
  ).run()
  if ((result.changes as number) > 0) {
    console.log(`[retention] ${result.changes} candidate(s) purged (> 6 months)`)
  }
}

purgeExpiredCandidates()
setInterval(purgeExpiredCandidates, 24 * 60 * 60 * 1000)

// Remove candidates saved with a search-page URL (contains '?') instead of an individual profile URL
const stale = db.prepare(
  `DELETE FROM candidates WHERE profile_url LIKE '%?%' OR (profile_url IS NOT NULL AND profile_url != '' AND profile_url NOT LIKE '%work.ua%' AND profile_url NOT LIKE '%robota.ua%' AND profile_url NOT LIKE '%hh.ua%' AND source_type = 'scraped')`
).run()
if ((stale.changes as number) > 0) {
  console.log(`[cleanup] ${stale.changes} candidate(s) with invalid profile URL removed`)
}

app.listen(PORT, () => {
  console.log(`Farmasoft RH server running on http://localhost:${PORT}`)
  startCron()

  // Auto-trigger full sync on startup if robota.ua is connected
  const robotaConnected = db.prepare("SELECT value FROM settings WHERE key = 'robota_email'").get() as { value: string } | undefined
  if (robotaConnected?.value) {
    console.log('[startup] robota.ua connected — triggering automatic full sync')
    runFullSync().catch(e => console.error('[startup full-sync]', (e as Error).message))
  }

  // Route every inbound Telegram private message into the recruiting bot.
  onTelegramInbound(handleInbound)

  // Reload Telegram session if previously authenticated, then recover any
  // candidate replies that arrived while the server was offline.
  reloadTelegramSession()
    .then(() => recoverMissed())
    .catch(e => console.error('[startup telegram]', (e as Error).message))
})

function startCron() {
  // Full bidirectional sync every 15 min — discovers:
  //  • new vacancies on robota.ua → imports as Farmasoft jobs
  //  • new active Farmasoft jobs → publishes to robota.ua
  //  • new candidates for any linked vacancy → imports + scores
  //  • updates to existing vacancies (state changes, content edits)
  setInterval(async () => {
    try {
      const robotaConnected = db.prepare("SELECT value FROM settings WHERE key = 'robota_email'").get() as { value: string } | undefined
      if (!robotaConnected?.value) return

      console.log('[cron] Running full bidirectional sync')
      await runFullSync().catch(e => console.error('[cron full-sync]', (e as Error).message))
    } catch (e) {
      console.error('[cron] Auto-sync error:', (e as Error).message)
    }
  }, 15 * 60 * 1000)

  // Follow-up check every 6 hours
  setInterval(async () => {
    try {
      await runFollowUps()
    } catch (e) {
      console.error('[cron] Follow-up error:', (e as Error).message)
    }
  }, 6 * 60 * 60 * 1000)

  // Telegram self-heal every 5 min — the GramJS socket lives in memory and
  // drops on restart/network blips; reconnect from the saved session (no code).
  setInterval(async () => {
    try {
      const tg = db.prepare("SELECT value FROM settings WHERE key = 'telegram_session'").get() as { value: string } | undefined
      if (tg?.value && !telegramIsConnected()) {
        console.log('[cron] Telegram disconnected — reloading saved session')
        await reloadTelegramSession().catch(e => console.error('[cron telegram]', (e as Error).message))
      }
      // Safety net: even when the socket is healthy, sweep for inbound
      // messages the live event handler may have missed (network blips).
      if (telegramIsConnected()) {
        await recoverMissed().catch(e => console.error('[cron tg-recover]', (e as Error).message))
      }
    } catch (e) {
      console.error('[cron] Telegram health error:', (e as Error).message)
    }
  }, 5 * 60 * 1000)
}
