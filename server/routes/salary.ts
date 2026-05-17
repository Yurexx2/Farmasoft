import { Router, Request, Response } from 'express'
import axios from 'axios'
import https from 'https'
import { getDb } from '../db'

const router = Router()

const httpsAgent = new https.Agent({ rejectUnauthorized: false })
const API_URL = 'https://employer-api.robota.ua'

// ─── Auth helper (same as robota route) ──────────────────────────────────────
async function getRobotaToken(): Promise<string> {
  const db = getDb()
  const row = db.prepare("SELECT value FROM settings WHERE key = 'robota_token'").get() as { value: string } | undefined
  if (row?.value) return row.value
  const emailRow = db.prepare("SELECT value FROM settings WHERE key = 'robota_email'").get() as { value: string } | undefined
  const passRow  = db.prepare("SELECT value FROM settings WHERE key = 'robota_password'").get() as { value: string } | undefined
  if (!emailRow || !passRow) throw new Error('robota.ua non connecté')
  const { data } = await axios.post(
    'https://auth-api.robota.ua/Login',
    { username: emailRow.value, password: passRow.value, remember: true },
    { timeout: 10000, httpsAgent },
  )
  const token = (data?.token || data) as string
  if (typeof token !== 'string') throw new Error('Login robota échoué')
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('robota_token', token)
  return token
}

// ─── Statistics helpers ──────────────────────────────────────────────────────
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

interface Stats { count: number; min: number; max: number; median: number; p25: number; p75: number; mean: number }

function stats(values: number[]): Stats {
  if (values.length === 0) return { count: 0, min: 0, max: 0, median: 0, p25: 0, p75: 0, mean: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((a, b) => a + b, 0)
  return {
    count:  sorted.length,
    min:    sorted[0],
    max:    sorted[sorted.length - 1],
    median: percentile(sorted, 0.5),
    p25:    percentile(sorted, 0.25),
    p75:    percentile(sorted, 0.75),
    mean:   Math.round(sum / sorted.length),
  }
}

// IQR-based outlier removal — uses 3×IQR (loose, keeps almost all data) for minimum bias
function iqrFilter(values: number[]): { keep: boolean[]; lower: number; upper: number } {
  if (values.length < 4) return { keep: values.map(() => true), lower: 0, upper: Infinity }
  const sorted = [...values].sort((a, b) => a - b)
  const q1 = percentile(sorted, 0.25)
  const q3 = percentile(sorted, 0.75)
  const iqr = q3 - q1
  const lower = q1 - 3 * iqr
  const upper = q3 + 3 * iqr
  return { keep: values.map(v => v >= lower && v <= upper), lower, upper }
}

function experienceLevel(years: number): 'junior' | 'middle' | 'senior' | 'lead' {
  if (years < 2)  return 'junior'
  if (years < 5)  return 'middle'
  if (years < 10) return 'senior'
  return 'lead'
}

interface CvRecord {
  resumeId: number
  salary: number
  experienceYears: number
  cityName: string
  speciality: string
  age?: number
  sex?: number
  lastUpdate?: string
  level: 'junior' | 'middle' | 'senior' | 'lead'
}

function extractCv(doc: Record<string, unknown>): CvRecord | null {
  const resumeId = doc.resumeId as number
  if (!resumeId) return null

  const salaryRaw = doc.salary
  const salary = typeof salaryRaw === 'number' ? salaryRaw
               : typeof salaryRaw === 'string' ? parseInt(salaryRaw.replace(/\D/g, ''), 10) || 0
               : 0
  const expArr = Array.isArray(doc.experience) ? doc.experience as Array<Record<string, unknown>> : []
  let expYears = 0
  for (const e of expArr) {
    const d  = e.dateFrom as string | undefined
    const dt = e.dateTo   as string | undefined
    if (d) {
      const from = new Date(d).getTime()
      const to   = dt ? new Date(dt).getTime() : Date.now()
      if (!isNaN(from) && !isNaN(to)) expYears += (to - from) / (365.25 * 24 * 3600 * 1000)
    }
  }
  if (expYears === 0) expYears = expArr.length
  expYears = Math.round(expYears * 10) / 10

  return {
    resumeId, salary,
    experienceYears: expYears,
    cityName: (doc.cityName as string) || '',
    speciality: (doc.speciality as string) || (doc.position as string) || '',
    age: doc.age as number | undefined,
    sex: doc.sex as number | undefined,
    lastUpdate: doc.lastUpdate as string | undefined,
    level: experienceLevel(expYears),
  }
}

// ─── Core analysis (reusable, returns full SalaryAnalysis object) ────────────
export interface SalaryAnalysis {
  query:      { keywords: string; cityId?: number; experienceId?: number; maxRecords: number; activeWithinDays: number }
  collection: {
    totalAvailableOnRobota: number; collected: number; activeCvs: number; discardedInactive: number
    withoutDeclaredSalary: number; withDeclaredSalary: number; sanityRejected: number; outliersRemoved: number
    finalSampleSize: number
    sanityBounds: { floor: number; ceiling: number }; iqrBounds: { lower: number; upper: number }
  }
  overall:   Stats
  byLevel:   Record<string, Stats>
  byCity:    Record<string, Stats>
  byAgeBand: Record<string, Stats>
  bySex:     Record<string, Stats>
}

async function runAnalysis(opts: {
  keywords: string; cityId?: number; experienceId?: number; maxRecords?: number; activeWithinDays?: number
}): Promise<SalaryAnalysis> {
  const { keywords, cityId, experienceId } = opts
  if (!keywords?.trim()) throw new Error('Mots-clés requis')

  const token = await getRobotaToken()
  const cap = Math.min(Math.max(opts.maxRecords ?? 500, 50), 2000)
  const activeWithinDays = opts.activeWithinDays ?? 90
  const activeCutoff = Date.now() - activeWithinDays * 24 * 3600 * 1000

  const allDocs: Record<string, unknown>[] = []
  const pageSize = 50
  let totalAvailable = 0
  let totalDiscardedInactive = 0

  for (let page = 0; allDocs.length < cap; page++) {
    const payload: Record<string, unknown> = { keyWords: keywords.trim(), page, count: pageSize }
    if (cityId) payload.cityId = cityId
    if (experienceId !== undefined) payload.experienceId = experienceId

    try {
      const { data } = await axios.post(`${API_URL}/cvdb/resumes`, payload, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 20000, httpsAgent,
      })
      const documents = (data?.documents ?? []) as Record<string, unknown>[]
      totalAvailable = (data?.total as number) ?? totalAvailable
      if (documents.length === 0) break
      for (const doc of documents) allDocs.push(doc)
      if (documents.length < pageSize) break
    } catch (e: unknown) {
      const status = (e as { response?: { status: number } }).response?.status
      console.error(`[salary] cvdb page=${page} keywords="${keywords}" → ${status}`)
      if (status === 500 && allDocs.length > 0) break
      throw e
    }
  }

  const records: CvRecord[] = []
  for (const doc of allDocs) {
    const cv = extractCv(doc)
    if (!cv) continue
    const last = cv.lastUpdate ? new Date(cv.lastUpdate).getTime() : 0
    if (last && last < activeCutoff) { totalDiscardedInactive++; continue }
    records.push(cv)
  }

  const SANITY_FLOOR = 8000
  const SANITY_CEILING = 1_000_000
  const withDeclared = records.filter(r => r.salary > 0)
  const withinSanity = withDeclared.filter(r => r.salary >= SANITY_FLOOR && r.salary <= SANITY_CEILING)
  const sanityRejected = withDeclared.length - withinSanity.length

  const salariesRaw = withinSanity.map(r => r.salary)
  const { keep, lower, upper } = iqrFilter(salariesRaw)
  const cleanRecords = withinSanity.filter((_, i) => keep[i])
  const salaries = cleanRecords.map(r => r.salary)
  const outlierCount = salariesRaw.length - salaries.length

  const byLevel: Record<string, Stats> = {}
  for (const lvl of ['junior', 'middle', 'senior', 'lead'] as const) {
    const subset = cleanRecords.filter(r => r.level === lvl).map(r => r.salary)
    if (subset.length > 0) byLevel[lvl] = stats(subset)
  }

  const byCity: Record<string, Stats> = {}
  const cityGroups: Record<string, number[]> = {}
  for (const r of cleanRecords) {
    if (!r.cityName) continue
    cityGroups[r.cityName] ??= []
    cityGroups[r.cityName].push(r.salary)
  }
  for (const [city, vals] of Object.entries(cityGroups)) {
    if (vals.length >= 3) byCity[city] = stats(vals)
  }

  const bySex: Record<string, Stats> = {}
  const sexLabels: Record<number, string> = { 1: 'male', 2: 'female' }
  for (const sx of [1, 2]) {
    const subset = cleanRecords.filter(r => r.sex === sx).map(r => r.salary)
    if (subset.length >= 3) bySex[sexLabels[sx]] = stats(subset)
  }

  const byAgeBand: Record<string, Stats> = {}
  const bands: [string, number, number][] = [['<25', 0, 25], ['25-34', 25, 35], ['35-44', 35, 45], ['45-54', 45, 55], ['55+', 55, 200]]
  for (const [label, lo, hi] of bands) {
    const subset = cleanRecords.filter(r => typeof r.age === 'number' && r.age >= lo && r.age < hi).map(r => r.salary)
    if (subset.length >= 3) byAgeBand[label] = stats(subset)
  }

  return {
    query: { keywords, cityId, experienceId, maxRecords: cap, activeWithinDays },
    collection: {
      totalAvailableOnRobota: totalAvailable,
      collected: allDocs.length,
      activeCvs: records.length,
      discardedInactive: totalDiscardedInactive,
      withoutDeclaredSalary: records.length - withDeclared.length,
      withDeclaredSalary: withDeclared.length,
      sanityRejected,
      outliersRemoved: outlierCount,
      finalSampleSize: salaries.length,
      sanityBounds: { floor: SANITY_FLOOR, ceiling: SANITY_CEILING },
      iqrBounds:    { lower: Math.round(lower), upper: Math.round(upper) },
    },
    overall: stats(salaries),
    byLevel, byCity, byAgeBand, bySex,
  }
}

// ─── Keyword auto-derivation from job title ──────────────────────────────────
// Strategy: take the first 1-2 significant Cyrillic/Latin words, lowercased.
// Stop-words are punctuation/connectors, kept short for predictability.
const KEYWORD_STOP = new Set(['та','і','з','для','по','на','до','в','у','the','of','for','and','/','-','—','(',')',',', ';'])
export function keywordsFromJobTitle(title: string): string {
  const cleaned = title
    .toLowerCase()
    .replace(/[,/().;:—–-]/g, ' ')
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length >= 3 && !KEYWORD_STOP.has(w))
  return cleaned.slice(0, 1).join(' ') // single primary word for broadest match
}

// ─── Cache helpers ───────────────────────────────────────────────────────────
const CACHE_TTL_DAYS = 7

interface CachedAnalysis {
  job_id: number; keywords_used: string; sample_size: number
  result_json: string; computed_at: string
}

function getCached(jobId: number): { analysis: SalaryAnalysis; meta: { computed_at: string; keywords_used: string; sample_size: number; ageHours: number; stale: boolean } } | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM salary_analyses WHERE job_id = ?').get(jobId) as CachedAnalysis | undefined
  if (!row) return null
  const computedAt = new Date(row.computed_at.replace(' ', 'T') + 'Z').getTime()
  const ageHours = (Date.now() - computedAt) / (3600 * 1000)
  return {
    analysis: JSON.parse(row.result_json) as SalaryAnalysis,
    meta: {
      computed_at: row.computed_at,
      keywords_used: row.keywords_used,
      sample_size: row.sample_size,
      ageHours,
      stale: ageHours > CACHE_TTL_DAYS * 24,
    },
  }
}

function saveCached(jobId: number, analysis: SalaryAnalysis) {
  const db = getDb()
  db.prepare(`
    INSERT INTO salary_analyses (job_id, keywords_used, sample_size, result_json, computed_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(job_id) DO UPDATE SET
      keywords_used = excluded.keywords_used,
      sample_size   = excluded.sample_size,
      result_json   = excluded.result_json,
      computed_at   = CURRENT_TIMESTAMP
  `).run(jobId, analysis.query.keywords, analysis.collection.finalSampleSize, JSON.stringify(analysis))
}

// ─── POST /api/salary/analyze (ad-hoc, no cache) ─────────────────────────────
router.post('/analyze', async (req: Request, res: Response) => {
  try {
    const analysis = await runAnalysis(req.body)
    res.json({ data: analysis })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

// ─── GET /api/salary/job/:jobId — returns cached analysis if any ─────────────
router.get('/job/:jobId', (req: Request, res: Response) => {
  try {
    const jobId = parseInt(String(req.params.jobId), 10)
    if (!jobId) return res.json({ error: 'jobId requis' })
    const cached = getCached(jobId)
    if (!cached) return res.json({ data: null })
    res.json({ data: cached })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

// ─── POST /api/salary/job/:jobId/refresh — force re-compute + cache ─────────
router.post('/job/:jobId/refresh', async (req: Request, res: Response) => {
  try {
    const jobId = parseInt(String(req.params.jobId), 10)
    if (!jobId) return res.json({ error: 'jobId requis' })

    const db = getDb()
    const job = db.prepare('SELECT id, title, location, city_id FROM jobs WHERE id = ?').get(jobId) as
      { id: number; title: string; location?: string; city_id?: number } | undefined
    if (!job) return res.json({ error: 'Job introuvable' })

    // Allow override of keywords via body; otherwise auto-derive from job title.
    const overrideKw = (req.body?.keywords as string | undefined)?.trim()
    const keywords = overrideKw || keywordsFromJobTitle(job.title)
    if (!keywords) return res.json({ error: `Impossible de dériver des mots-clés depuis "${job.title}"` })

    const analysis = await runAnalysis({
      keywords,
      cityId: job.city_id || 1,  // default Kyiv if unknown
      maxRecords: 500,
      activeWithinDays: 90,
    })
    saveCached(jobId, analysis)
    const cached = getCached(jobId)!
    res.json({ data: cached })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

// ─── GET /api/salary/jobs-summary — list of (job, median) for dashboard ──────
router.get('/jobs-summary', (_req: Request, res: Response) => {
  try {
    const db = getDb()
    const rows = db.prepare(`
      SELECT j.id, j.title, j.is_active, sa.sample_size, sa.computed_at, sa.result_json
      FROM jobs j
      LEFT JOIN salary_analyses sa ON sa.job_id = j.id
      ORDER BY j.is_active DESC, j.title ASC
    `).all() as Array<{ id: number; title: string; is_active: number; sample_size?: number; computed_at?: string; result_json?: string }>
    const summary = rows.map(r => {
      const parsed = r.result_json ? JSON.parse(r.result_json) as SalaryAnalysis : null
      return {
        job_id: r.id,
        title: r.title,
        is_active: !!r.is_active,
        sample_size: r.sample_size ?? null,
        computed_at: r.computed_at ?? null,
        median:   parsed?.overall.median ?? null,
        p25:      parsed?.overall.p25 ?? null,
        p75:      parsed?.overall.p75 ?? null,
        keywords: parsed?.query.keywords ?? null,
      }
    })
    res.json({ data: summary })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

export default router
