import { Router, Request, Response } from 'express'
import axios from 'axios'
import https from 'https'
import nodemailer from 'nodemailer'
import { getDb } from '../db'
import { callLLM } from '../lib/llm'

const router = Router()

// robota.ua uses a certificate chain not trusted by Node's default CA bundle
const httpsAgent = new https.Agent({ rejectUnauthorized: false })
axios.defaults.httpsAgent = httpsAgent

const AUTH_URL = 'https://auth-api.robota.ua'
const API_URL  = 'https://employer-api.robota.ua'
const TURBOSMS_URL = 'https://api.turbosms.ua/message/send.json'

// robota.ua city IDs
const CITY_MAP: Record<string, number> = {
  'Kyiv': 1, 'Kharkiv': 2, 'Lviv': 3, 'Odesa': 4, 'Dnipro': 7,
  'Zaporizhzhia': 8, 'Vinnytsia': 10, 'Poltava': 16, 'Cherkasy': 18, 'Zhytomyr': 24,
  'Київ': 1, 'Харків': 2, 'Львів': 3, 'Одеса': 4, 'Дніпро': 7,
}

// robota.ua experience mapping (derived from years)
function expYearsToId(years: number): number {
  if (!years || years <= 0) return 0           // Без досвіду
  if (years === 1) return 1                    // До 1 року
  if (years === 2) return 2                    // Від 1 до 2 років
  if (years <= 5) return 3                     // Від 2 до 5 років
  return 4                                     // Понад 5 років
}

interface RobotaApply {
  id: number
  resumeId?: number
  eMail?: string
  email?: string
  name?: string
  speciality?: string
  cityId?: number
  cityName?: string
  experienceYears?: number
  salary?: number
  profileUrl?: string
  phones?: { value: string }[]
  phone?: string
  photo?: string
  birthDate?: string
  skillsSummary?: string
  experiences?: Array<{ position?: string; company?: string; description?: string; dateFrom?: string; dateTo?: string }>
  isHaveNoExperience?: boolean
  fileName?: string
}

// Reverse city map: cityId → cityName — loaded from stable cache, or fetched from robota.ua on first run
const CITY_ID_TO_NAME: Record<number, string> = {}
import * as fsMod from 'fs'
import * as pathMod from 'path'
import * as osMod from 'os'

const CITIES_CACHE_DIR = process.env.FARMASOFT_DATA_DIR
  ? process.env.FARMASOFT_DATA_DIR
  : process.env.APPDATA
    ? pathMod.join(process.env.APPDATA, 'Farmasoft', 'data')
    : pathMod.join(osMod.homedir(), '.farmasoft', 'data')
const CITIES_CACHE_PATH = pathMod.join(CITIES_CACHE_DIR, 'cities.json')

function loadCitiesIntoMap(arr: Array<{ id: number; nameUkr?: string; name?: string }>) {
  for (const c of arr) {
    if (c.id) CITY_ID_TO_NAME[c.id] = c.nameUkr || c.name || ''
  }
}

// Try cache first
try {
  if (fsMod.existsSync(CITIES_CACHE_PATH)) {
    const arr = JSON.parse(fsMod.readFileSync(CITIES_CACHE_PATH, 'utf8')) as Array<{ id: number; nameUkr?: string; name?: string }>
    loadCitiesIntoMap(arr)
    console.log(`[robota] Loaded ${arr.length} cities from cache`)
  } else {
    // Legacy fallback
    const legacyPath = pathMod.join(process.cwd(), 'data', 'cities.json')
    if (fsMod.existsSync(legacyPath)) {
      const arr = JSON.parse(fsMod.readFileSync(legacyPath, 'utf8')) as Array<{ id: number; nameUkr?: string; name?: string }>
      loadCitiesIntoMap(arr)
      fsMod.mkdirSync(CITIES_CACHE_DIR, { recursive: true })
      fsMod.copyFileSync(legacyPath, CITIES_CACHE_PATH)
      console.log(`[robota] Migrated cities cache → ${CITIES_CACHE_PATH}`)
    }
  }
} catch (e) {
  console.warn('[robota] cities cache not loaded:', (e as Error).message)
}

// Async fetch cities from robota.ua if cache missing — runs once first sync
async function ensureCitiesCache(token: string): Promise<void> {
  if (Object.keys(CITY_ID_TO_NAME).length > 100) return
  try {
    const { data } = await axios.get(`${API_URL}/values/citylist`, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
    })
    const arr = data as Array<{ id: number; nameUkr?: string; name?: string }>
    loadCitiesIntoMap(arr)
    fsMod.mkdirSync(CITIES_CACHE_DIR, { recursive: true })
    fsMod.writeFileSync(CITIES_CACHE_PATH, JSON.stringify(arr), 'utf8')
    console.log(`[robota] Fetched ${arr.length} cities from robota.ua, cached at ${CITIES_CACHE_PATH}`)
  } catch (e) {
    console.warn('[robota] cities fetch failed:', (e as Error).message)
  }
}

function computeExperienceYears(experiences?: RobotaApply['experiences'], isHaveNoExperience?: boolean): number {
  if (isHaveNoExperience) return 0
  if (!experiences || experiences.length === 0) return 0
  // First try precise calculation from dates if available
  let totalDays = 0
  let hasDates = false
  for (const exp of experiences) {
    if (!exp.dateFrom) continue
    hasDates = true
    const from = new Date(exp.dateFrom)
    const to = exp.dateTo && exp.dateTo !== '0001-01-01T00:00:00' ? new Date(exp.dateTo) : new Date()
    if (!isNaN(from.getTime()) && !isNaN(to.getTime()) && to > from) {
      totalDays += (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)
    }
  }
  if (hasDates && totalDays > 0) return Math.round(totalDays / 365)
  // Fallback: estimate ~2 years per experience entry
  return Math.max(1, experiences.length * 2)
}

interface RobotaVacancy {
  id: number
  name: string
  state: string
  cityName?: string
  salaryRange?: { amountFrom?: number; amountTo?: number }
  description?: string
}

// ─── In-memory full-sync progress (reset on restart, that's fine) ─────────────
interface SyncProgress {
  status: 'idle' | 'running' | 'done' | 'error'
  vacanciesTotal: number
  vacanciesDone: number
  candidatesImported: number
  candidatesOutreached: number
  currentVacancy: string
  startedAt: string | null
  finishedAt: string | null
  error?: string
}
let fullSyncProgress: SyncProgress = {
  status: 'idle', vacanciesTotal: 0, vacanciesDone: 0,
  candidatesImported: 0, candidatesOutreached: 0,
  currentVacancy: '', startedAt: null, finishedAt: null,
}

// ─── List all employer vacancies via confirmed POST /vacancy/list ──────────────
async function fetchEmployerVacancies(token: string): Promise<RobotaVacancy[]> {
  const headers = { Authorization: `Bearer ${token}` }
  const all: RobotaVacancy[] = []
  let page = 0

  while (true) {
    const { data } = await axios.post(
      `${API_URL}/vacancy/list`,
      { page },
      { headers, timeout: 15000 },
    )
    // API returns array directly or wrapped in a field
    const list: unknown[] = Array.isArray(data) ? data
      : (data as Record<string, unknown>)?.vacancies as unknown[]
        || (data as Record<string, unknown>)?.items as unknown[]
        || (data as Record<string, unknown>)?.data as unknown[]
        || []

    if (!Array.isArray(list) || list.length === 0) break

    for (const v of list) {
      const vv = v as Record<string, unknown>
      const id = (vv.id ?? vv.vacancyId) as number
      if (!id) continue
      all.push({
        id,
        name:        (vv.name ?? vv.title ?? vv.vacancyName ?? '') as string,
        state:       (vv.state ?? vv.status ?? 'Unknown') as string,
        cityName:    (vv.cityName ?? vv.city) as string | undefined,
        salaryRange: vv.salaryRange as RobotaVacancy['salaryRange'],
        description: (vv.description ?? vv.shortDescription) as string | undefined,
      })
    }

    if (list.length < 20) break
    page++
  }

  return all
}

// ─── DB helpers ───────────────────────────────────────────────────────────────
function getSetting(db: ReturnType<typeof getDb>, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value || null
}
function saveSetting(db: ReturnType<typeof getDb>, key: string, value: string) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}
function generateInitials(name?: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/)
    if (parts.length >= 2) return `${parts[0][0]}.${parts[1][0]}.`
    if (parts[0]?.length >= 1) return `${parts[0][0]}.`
  }
  return `${String.fromCharCode(65 + Math.floor(Math.random() * 26))}.${String.fromCharCode(65 + Math.floor(Math.random() * 26))}.`
}
function extractFirstName(name?: string | null): string {
  if (!name) return ''
  return name.trim().split(/\s+/)[1] || name.trim().split(/\s+/)[0] || ''
}

// ─── robota.ua token ──────────────────────────────────────────────────────────
async function getToken(db: ReturnType<typeof getDb>): Promise<string> {
  const cached  = getSetting(db, 'robota_token')
  const expires = getSetting(db, 'robota_token_expires')
  if (cached && expires && new Date(expires) > new Date()) return cached

  const email    = getSetting(db, 'robota_email')
  const password = getSetting(db, 'robota_password')
  if (!email || !password) throw new Error('Identifiants robota.ua non configurés')

  const { data } = await axios.post(`${AUTH_URL}/Login`, { username: email, password, remember: true }, { timeout: 10000 })
  const token = data?.token || data?.access_token || (typeof data === 'string' ? data : null)
  if (!token) throw new Error('Réponse token invalide de robota.ua')

  saveSetting(db, 'robota_token', token)
  saveSetting(db, 'robota_token_expires', new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString())
  return token
}

// ─── Build robota.ua vacancy payload from a Farmasoft job record ─────────────
function buildVacancyPayload(job: Record<string, unknown>, db: ReturnType<typeof getDb>) {
  const skills: string[] = (() => { try { return JSON.parse(job.skills as string || '[]') } catch { return [] } })()
  const employmentTypes: string[] = (() => { try { return JSON.parse(job.employment_types as string || '["FullTime"]') } catch { return ['FullTime'] } })()
  const workTypes: string[] = (() => { try { return JSON.parse(job.work_types as string || '["Office"]') } catch { return ['Office'] } })()
  const branchIds: number[] = (() => { try { return JSON.parse(job.branch_ids as string || '[]') } catch { return [] } })()
  const languages: Array<{ id: number; level: number }> = (() => { try { return JSON.parse(job.languages as string || '[]') } catch { return [] } })()

  const cityId = (job.city_id as number) || CITY_MAP[job.location as string] || 1
  const expYears = (job.experience_years as number) || 0

  const rawDesc = [job.description, job.requirements, skills.length ? `Навички: ${skills.join(', ')}` : '']
    .filter(Boolean).join('\n\n')
  const minDesc = rawDesc.length >= 150 ? rawDesc
    : `${rawDesc}\n\nКомпанія Farmasoft UA запрошує кандидатів на посаду "${job.title as string}". Ми пропонуємо конкурентну заробітну плату, офіційне оформлення та комфортні умови праці. Надсилайте своє резюме — ми розглянемо кожну заявку.`.substring(0, Math.max(rawDesc.length + 300, 300))

  const salaryAvg = (job.salary_min && job.salary_max)
    ? Math.round(((job.salary_min as number) + (job.salary_max as number)) / 2)
    : ((job.salary_min as number) || 0)

  return {
    id: (job.robota_vacancy_id as number) || 0,
    cityId,
    name: job.title,
    description: minDesc,
    salary: salaryAvg,
    salaryRange: (job.salary_min && job.salary_max)
      ? { amountFrom: job.salary_min, amountTo: job.salary_max } : undefined,
    currencyId: 1,
    experienceId: (job.experience_id as number) ?? expYearsToId(expYears),
    educationId: (job.education_id as number) ?? 0,
    scheduleId: (job.schedule_id as number) || 1,
    publishType: (job.publish_type as string) || getSetting(db, 'robota_publish_type') || 'Anonym',
    sendResumeType: '1',
    contactEMail: (job.contact_email as string) || getSetting(db, 'robota_email') || '',
    contactPerson: (job.contact_person as string) || getSetting(db, 'robota_contact_person') || 'HR Farmasoft UA',
    employmentTypes,
    workTypes,
    branchIds: branchIds.length ? branchIds : undefined,
    languages: languages.length ? languages : undefined,
    endingType: 'CloseAndNotify',
  }
}

// ─── Sync a Farmasoft job to robota.ua (publish/update/close) ────────────────
export async function syncJobToRobota(
  jobId: number,
  action: 'publish' | 'update' | 'close',
): Promise<{ vacancyId?: number; state?: string; error?: string }> {
  const db = getDb()
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined
  if (!job) return { error: 'Poste introuvable' }

  let token: string
  try { token = await getToken(db) } catch (e) { return { error: `Non connecté à robota.ua: ${(e as Error).message}` } }

  try {
    if (action === 'close') {
      const robotaId = job.robota_vacancy_id as number | null
      if (!robotaId) return { error: 'Aucune vacancy robota.ua liée' }
      const { data } = await axios.post(`${API_URL}/vacancy/state/${robotaId}?state=Closed`, {},
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 })
      if (data?.success === false) return { error: (data?.message || 'Échec fermeture').replace('[CUSTOM ERROR] ', '') }
      db.prepare("UPDATE jobs SET robota_state = 'Closed' WHERE id = ?").run(jobId)
      return { vacancyId: robotaId, state: 'Closed' }
    }

    // publish or update — upsert vacancy
    const payload = buildVacancyPayload(job, db)
    const { data: createResp } = await axios.post(`${API_URL}/vacancy/add`, payload, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
    })
    if (createResp?.success === false) {
      const msg = (createResp.error || createResp.message || 'Publication refusée').replace('[CUSTOM ERROR] ', '')
      return { error: msg }
    }
    const vacancyId = (createResp?.vacancyId as number) || (createResp?.id as number) || (job.robota_vacancy_id as number)
    if (!vacancyId) return { error: 'ID vacancy non retourné par robota.ua' }

    // Set state to Publicated
    const { data: stateResp } = await axios.post(
      `${API_URL}/vacancy/state/${vacancyId}?state=Publicated`, {},
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 },
    )
    if (stateResp?.success === false) {
      // Vacancy was created/updated but couldn't go live — save the link for retry
      db.prepare("UPDATE jobs SET robota_vacancy_id = ?, robota_state = 'NotPublicated' WHERE id = ?").run(vacancyId, jobId)
      const msg = (stateResp.message || 'Publication refusée').replace('[CUSTOM ERROR] ', '')
      return { vacancyId, state: 'NotPublicated', error: msg }
    }

    db.prepare("UPDATE jobs SET robota_vacancy_id = ?, robota_state = 'Publicated' WHERE id = ?").run(vacancyId, jobId)
    db.prepare('INSERT INTO events (type, job_id, metadata) VALUES (?, ?, ?)').run(
      action === 'publish' ? 'vacancy_published' : 'vacancy_updated', jobId,
      JSON.stringify({ robota_vacancy_id: vacancyId, action }),
    )
    return { vacancyId, state: 'Publicated' }
  } catch (err: unknown) {
    const status = (err as { response?: { status: number } }).response?.status
    if (status === 401) return { error: 'Token expiré — reconnectez-vous' }
    return { error: (err as Error).message }
  }
}

// ─── Update apply folder on robota.ua (Invited, Uninteresting…) ───────────────
async function updateApplyFolder(applyId: number, folderId: number, token: string): Promise<void> {
  try {
    await axios.post(
      `${API_URL}/apply/folder`,
      { id: applyId, folderId },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 },
    )
  } catch { /* non-critical — swallow */ }
}

// ─── TurboSMS ─────────────────────────────────────────────────────────────────
async function sendSMS(phone: string, message: string, db: ReturnType<typeof getDb>): Promise<void> {
  const token  = getSetting(db, 'turbosms_token')
  const sender = getSetting(db, 'turbosms_sender') || 'Farmasoft'
  if (!token) throw new Error('TurboSMS token non configuré')

  const normalised = phone.replace(/\D/g, '').replace(/^0/, '380').replace(/^(?!380)/, '380')

  await axios.post(
    TURBOSMS_URL,
    { recipients: [normalised], sms: { sender, text: message } },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10000 },
  )
}

// ─── AI message generation (Ukrainian) ───────────────────────────────────────
async function generateOutreachMessages(
  firstName: string,
  role: string,
  jobTitle: string,
  calendlyUrl: string,
  isFollowUp = false,
): Promise<{ sms: string; email: string; subject: string }> {
  const followUpNote = isFollowUp ? ' Це повторне повідомлення.' : ''

  const prompt = `Ти HR-спеціаліст компанії Farmasoft UA. Напиши персоналізоване звернення до кандидата.${followUpNote}

Кандидат: ${firstName || 'кандидат'}
Їх посада в резюме: ${role}
Вакансія яку пропонуємо: ${jobTitle}
Посилання для запису на зустріч: ${calendlyUrl}

Напиши ДВА варіанти повідомлення у форматі JSON:
1. SMS — максимум 60 символів кирилицею, коротко, з посиланням на зустріч
2. Email — 3-4 речення, тепло, персоналізовано, із запрошенням на дзвінок, посилання наприкінці
3. Subject — тема email, до 50 символів

Відповідай ТІЛЬКИ JSON без markdown:
{"sms": "...", "email": "...", "subject": "..."}`

  try {
    const text = await callLLM(prompt, { jsonMode: true, timeoutMs: 20000 })
    const parsed = JSON.parse(text) as { sms: string; email: string; subject: string }
    return parsed
  } catch {
    // Fallback Ukrainian messages
    const smsText = `${firstName ? firstName + ', ' : ''}вас запрошують на вакансію ${jobTitle}. Запишіться: ${calendlyUrl}`
    return {
      sms: smsText.slice(0, 160),
      email: `Вітаємо${firstName ? ', ' + firstName : ''}!\n\nМи переглянули ваше резюме і хотіли б запросити вас на коротку розмову щодо вакансії "${jobTitle}" у компанії Farmasoft UA.\n\nЗапишіться на зручний для вас час тут: ${calendlyUrl}\n\nЧекаємо на вас!`,
      subject: `Запрошення на розмову — ${jobTitle}`,
    }
  }
}

// ─── Send outreach to a candidate (SMS + email) ───────────────────────────────
export async function sendOutreach(
  candidateId: number,
  db: ReturnType<typeof getDb>,
  isFollowUp = false,
): Promise<{ smsSent: boolean; emailSent: boolean; error?: string }> {
  // Always re-read from DB to get the freshest outreach_count — never trust a cached value
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId) as Record<string, unknown> | undefined
  if (!candidate) return { smsSent: false, emailSent: false, error: 'Candidat introuvable' }

  const currentCount = (candidate.outreach_count as number) || 0

  // Hard block: initial outreach only once
  if (!isFollowUp && currentCount >= 1) {
    console.log(`[outreach] Blocked candidate ${candidateId}: already contacted (count=${currentCount})`)
    return { smsSent: false, emailSent: false, error: 'Déjà contacté — envoi bloqué' }
  }
  // Hard block: max 2 follow-ups total (outreach_count includes the initial contact)
  if (isFollowUp && currentCount >= 2) {
    console.log(`[outreach] Blocked candidate ${candidateId}: max follow-ups reached (count=${currentCount})`)
    return { smsSent: false, emailSent: false, error: 'Limite de relances atteinte' }
  }

  const job = candidate.job_id
    ? db.prepare('SELECT * FROM jobs WHERE id = ?').get(candidate.job_id) as Record<string, unknown> | null
    : null

  const calendlyUrl = getSetting(db, 'calendly_url') || 'https://calendly.com'
  const firstName   = extractFirstName(candidate.initials as string)
  const role        = (candidate.role as string) || 'кандидат'
  const jobTitle    = (job?.title as string) || 'вакансія'

  const messages = await generateOutreachMessages(firstName, role, jobTitle, calendlyUrl, isFollowUp)

  let smsSent = false
  let emailSent = false

  // Send SMS
  const phone = candidate.phone as string | null
  if (phone) {
    try {
      await sendSMS(phone, messages.sms, db)
      smsSent = true
    } catch (e) {
      console.error(`[outreach] SMS failed for candidate ${candidateId}:`, (e as Error).message)
    }
  }

  // Send email
  const email = candidate.email as string | null
  if (email) {
    try {
      const smtpHost = getSetting(db, 'smtp_host')
      const smtpPort = parseInt(getSetting(db, 'smtp_port') || '587')
      const smtpUser = getSetting(db, 'smtp_user')
      const smtpPass = getSetting(db, 'smtp_pass')
      const smtpFrom = getSetting(db, 'smtp_from') || smtpUser

      if (smtpHost && smtpUser && smtpPass) {
        const transporter = nodemailer.createTransport({
          host: smtpHost, port: smtpPort, secure: smtpPort === 465,
          auth: { user: smtpUser, pass: smtpPass },
        })
        await transporter.sendMail({
          from: smtpFrom!, to: email,
          subject: messages.subject,
          text: messages.email,
          html: messages.email.replace(/\n/g, '<br>'),
        })
        emailSent = true
      }
    } catch (e) {
      console.error(`[outreach] Email failed for candidate ${candidateId}:`, (e as Error).message)
    }
  }

  if (smsSent || emailSent) {
    const outreachCount = ((candidate.outreach_count as number) || 0) + 1
    db.prepare('UPDATE candidates SET status = ?, contacted_at = CURRENT_TIMESTAMP, outreach_count = ? WHERE id = ?')
      .run('contacted', outreachCount, candidateId)
    db.prepare('INSERT INTO events (type, candidate_id, job_id, metadata) VALUES (?, ?, ?, ?)')
      .run(
        isFollowUp ? 'follow_up_sent' : 'outreach_sent',
        candidateId,
        candidate.job_id,
        JSON.stringify({ smsSent, emailSent, isFollowUp }),
      )
  }

  return { smsSent, emailSent }
}

// ─── Core sync + qualify + outreach for one job ───────────────────────────────
export async function runJobSync(jobId: number, opts: { skipQualification?: boolean } = {}): Promise<{ imported: number; outreached: number }> {
  const db = getDb()
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined
  if (!job) return { imported: 0, outreached: 0 }

  const vacancyId = job.robota_vacancy_id as number | null
  if (!vacancyId) return { imported: 0, outreached: 0 }

  let token: string
  try { token = await getToken(db) } catch { return { imported: 0, outreached: 0 } }

  // ── 1. Fetch all applications ──────────────────────────────────────────────
  let page = 0
  const allApplies: RobotaApply[] = []
  while (true) {
    try {
      const { data } = await axios.post(
        `${API_URL}/apply/list`,
        { vacancyId, folderId: 0, page, filter: '', candidateTypes: ['Application', 'ApplicationWithResume', 'ApplicationWithFile', 'VacancyInteraction'] },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 },
      )
      const applies: RobotaApply[] = data?.applies ?? []
      allApplies.push(...applies)
      if (applies.length < 20) break
      page++
    } catch { break }
  }

  // ── 2. Dedup ───────────────────────────────────────────────────────────────
  const existingByApplyId = new Map<string, number>() // apply_id → candidate_id
  const existingRows = db.prepare(
    'SELECT id, robota_apply_id FROM candidates WHERE job_id = ? AND robota_apply_id IS NOT NULL'
  ).all(jobId) as { id: number; robota_apply_id: string }[]
  for (const row of existingRows) existingByApplyId.set(row.robota_apply_id, row.id)
  const newApplies = allApplies.filter(a => !existingByApplyId.has(String(a.id)))
  const existingApplies = allApplies.filter(a => existingByApplyId.has(String(a.id)))

  // ── 3. Import new candidates ───────────────────────────────────────────────
  // Note: apply/list already contains all candidate data we need —
  // apply/view returns 204 (empty) so we don't call it.
  const insertedIds: number[] = []
  const applyIdMap = new Map<number, number>() // candidateId → robota applyId

  for (const apply of newApplies) {
    try {
      const email      = apply.eMail || apply.email || null
      const phone      = apply.phones?.[0]?.value || apply.phone || null
      const name       = apply.name || null
      const role       = apply.speciality || 'Кандидат'
      const location   = apply.cityName || (apply.cityId ? CITY_ID_TO_NAME[apply.cityId] : null) || null
      const expYears   = apply.experienceYears ?? computeExperienceYears(apply.experiences, apply.isHaveNoExperience) ?? 0
      const salary     = apply.salary ?? 0
      const profileUrl = apply.resumeId ? `https://robota.ua/ua/cv/${apply.resumeId}` : null
      const photoUrl   = apply.photo && !apply.photo.includes('non-photo') ? apply.photo : null
      const birthDate  = apply.birthDate && apply.birthDate !== '0001-01-01T00:00:00' ? apply.birthDate : null

      // Build experience text from experiences array
      const experienceText = (apply.experiences || []).map(e => {
        const desc = (e.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        const dates = e.dateFrom ? `${e.dateFrom.substring(0,7)}${e.dateTo && e.dateTo !== '0001-01-01T00:00:00' ? '–' + e.dateTo.substring(0,7) : '–тепер'}` : ''
        return [`${e.position || ''} @ ${e.company || ''}`.trim(), dates, desc].filter(Boolean).join('\n')
      }).join('\n\n').slice(0, 8000) || null

      // Profile data: skills summary + extra fields
      const profileData = JSON.stringify({
        skillsSummary: apply.skillsSummary || '',
        experiencesCount: apply.experiences?.length || 0,
        isHaveNoExperience: apply.isHaveNoExperience || false,
      })

      const r = db.prepare(`
        INSERT INTO candidates
          (job_id, initials, full_name, role, location, salary_expectation, experience_years,
           source_platform, profile_url, photo_url, birth_date, tags, status, stage,
           robota_apply_id, email, phone, experience_text, profile_data, cv_filename)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'robota.ua', ?, ?, ?, '[]', 'new', 'new', ?, ?, ?, ?, ?, ?)
      `).run(jobId, generateInitials(name), name, role, location, salary, expYears,
             profileUrl, photoUrl, birthDate, String(apply.id), email, phone,
             experienceText, profileData, apply.fileName || null)

      const candidateId = r.lastInsertRowid as number
      insertedIds.push(candidateId)
      applyIdMap.set(candidateId, apply.id)
    } catch { /* skip — UNIQUE constraint or other */ }
  }

  // ── 3b. UPDATE existing candidates with latest robota.ua data ─────────────
  // (preserves stage / status / qualification_score / decision / rejection_reason)
  for (const apply of existingApplies) {
    try {
      const candidateId = existingByApplyId.get(String(apply.id))!
      const existing = db.prepare('SELECT full_name, photo_url, location FROM candidates WHERE id = ?').get(candidateId) as { full_name: string | null; photo_url: string | null; location: string | null } | undefined

      // Only update fields that are missing or have richer data on robota.ua
      const updates: string[] = []
      const values: unknown[] = []

      if (!existing?.full_name && apply.name) { updates.push('full_name = ?'); values.push(apply.name) }
      if (!existing?.photo_url && apply.photo && !apply.photo.includes('non-photo')) { updates.push('photo_url = ?'); values.push(apply.photo) }
      if (apply.birthDate && apply.birthDate !== '0001-01-01T00:00:00') { updates.push('birth_date = ?'); values.push(apply.birthDate) }
      if (!existing?.location && (apply.cityName || apply.cityId)) {
        updates.push('location = ?')
        values.push(apply.cityName || (apply.cityId ? CITY_ID_TO_NAME[apply.cityId] : null))
      }
      if (apply.eMail || apply.email) { updates.push('email = COALESCE(email, ?)'); values.push(apply.eMail || apply.email) }
      if (apply.phones?.[0]?.value || apply.phone) { updates.push('phone = COALESCE(phone, ?)'); values.push(apply.phones?.[0]?.value || apply.phone) }
      if (apply.resumeId) { updates.push('profile_url = COALESCE(profile_url, ?)'); values.push(`https://robota.ua/ua/cv/${apply.resumeId}`) }
      if (apply.experiences?.length) {
        const expText = apply.experiences.map(e => {
          const desc = (e.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
          const dates = e.dateFrom ? `${e.dateFrom.substring(0,7)}${e.dateTo && e.dateTo !== '0001-01-01T00:00:00' ? '–' + e.dateTo.substring(0,7) : '–тепер'}` : ''
          return [`${e.position || ''} @ ${e.company || ''}`.trim(), dates, desc].filter(Boolean).join('\n')
        }).join('\n\n').slice(0, 8000)
        updates.push('experience_text = COALESCE(experience_text, ?)')
        values.push(expText)
        const computedYears = computeExperienceYears(apply.experiences)
        if (computedYears > 0) { updates.push('experience_years = CASE WHEN experience_years > 0 THEN experience_years ELSE ? END'); values.push(computedYears) }
      }

      if (updates.length > 0) {
        values.push(candidateId)
        db.prepare(`UPDATE candidates SET ${updates.join(', ')} WHERE id = ?`).run(...values as never[])
      }
    } catch { /* skip */ }
  }

  if (insertedIds.length === 0) return { imported: 0, outreached: 0 }

  db.prepare('INSERT INTO events (type, job_id, metadata) VALUES (?, ?, ?)').run(
    'robota_sync', jobId,
    JSON.stringify({ imported: insertedIds.length, total: allApplies.length, vacancyId }),
  )

  // ── 4. Qualify all new candidates (can be skipped during full sync) ──────
  if (!opts.skipQualification) {
    await qualifyCandidates(insertedIds, jobId, db)
  }

  // ── 5. Auto-outreach for score ≥ 70 (only if qualification ran) ──────────
  const scoreThreshold = parseInt(getSetting(db, 'outreach_score_threshold') || '70')
  const autoOutreach   = getSetting(db, 'auto_outreach') !== 'false' && !opts.skipQualification
  let outreached = 0

  if (autoOutreach) {
    for (const candidateId of insertedIds) {
      // Re-read from DB after qualification — score and status are now fresh
      const c = db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId) as Record<string, unknown> | undefined
      if (!c) continue

      const score = c.qualification_score as number | null
      const alreadyContacted = (c.outreach_count as number || 0) >= 1

      if (score == null || score < scoreThreshold) {
        const applyId = applyIdMap.get(candidateId)
        if (applyId) await updateApplyFolder(applyId, 5, token) // 5 = Uninteresting
        continue
      }

      // Skip if already contacted — handles race condition with a concurrent sync
      if (alreadyContacted) {
        console.log(`[auto-sync] Skipping candidate ${candidateId}: already contacted`)
        continue
      }

      const { smsSent, emailSent } = await sendOutreach(candidateId, db)
      if (smsSent || emailSent) {
        outreached++
        const applyId = applyIdMap.get(candidateId)
        if (applyId) await updateApplyFolder(applyId, 6, token) // 6 = Invited
      }
      await new Promise(res => setTimeout(res, 500))
    }
  }

  console.log(`[auto-sync] Job ${jobId}: imported ${insertedIds.length}, outreached ${outreached}`)
  return { imported: insertedIds.length, outreached }
}

// ─── Follow-up cron (called daily) ────────────────────────────────────────────
export async function runFollowUps(): Promise<void> {
  const db = getDb()
  const followUpDays = parseInt(getSetting(db, 'followup_days') || '3')
  const maxFollowUps = 2

  const cutoff = new Date(Date.now() - followUpDays * 24 * 60 * 60 * 1000).toISOString()

  const candidates = db.prepare(`
    SELECT * FROM candidates
    WHERE status = 'contacted'
      AND contacted_at < ?
      AND (outreach_count IS NULL OR outreach_count < ?)
      AND (email IS NOT NULL OR phone IS NOT NULL)
  `).all(cutoff, maxFollowUps) as Record<string, unknown>[]

  for (const c of candidates) {
    try {
      await sendOutreach(c.id as number, db, true)
      console.log(`[follow-up] Sent to candidate ${c.id}`)
      await new Promise(r => setTimeout(r, 500))
    } catch { /* skip */ }
  }
}

// ─── Background batch qualification of all unqualified candidates ────────────
async function qualifyAllUnqualified(db: ReturnType<typeof getDb>): Promise<void> {
  const rows = db.prepare(
    "SELECT id, job_id FROM candidates WHERE qualification_score IS NULL AND job_id IS NOT NULL ORDER BY job_id"
  ).all() as { id: number; job_id: number }[]
  if (rows.length === 0) return

  console.log(`[bg-qualify] Starting background qualification for ${rows.length} candidate(s)`)

  // Group by job for context efficiency
  const byJob = new Map<number, number[]>()
  for (const r of rows) {
    const arr = byJob.get(r.job_id) || []
    arr.push(r.id)
    byJob.set(r.job_id, arr)
  }

  for (const [jobId, ids] of byJob) {
    await qualifyCandidates(ids, jobId, db)
  }

  console.log(`[bg-qualify] Done — ${rows.length} candidate(s) qualified`)
}

// ─── Qualify candidates (Gemini) — concurrent execution with rate-limit guard ──
const QUALIFY_CONCURRENCY = 4         // 4 calls in flight at once
const QUALIFY_LAUNCH_DELAY_MS = 600   // 600ms between launches → ~6.6 RPS = ~400 RPM (safe on OpenAI Tier 1: 500 RPM gpt-4o-mini)

async function qualifyOne(id: number, job: Record<string, unknown>, db: ReturnType<typeof getDb>): Promise<void> {
  try {
    const c = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!c) return

    const prompt = `Експерт HR Farmasoft UA. Оціни кандидата від 0 до 100 для посади.
ВАКАНСІЯ: ${job.title}
Навички: ${job.skills ?? 'Не вказані'}
Мін. досвід: ${job.experience_years ?? 0} років

КАНДИДАТ:
- Посада: ${c.role ?? 'Не вказана'}
- Досвід: ${c.experience_years ?? 0} років
- Місто: ${c.location ?? 'Не вказано'}

Відповідай ТІЛЬКИ JSON: {"score": <0-100>, "notes": "<ключові моменти>"}`

    const text = await callLLM(prompt, { jsonMode: true, timeoutMs: 30000, maxTokens: 200 })
    const parsed = JSON.parse(text) as { score: number; notes: string }
    if (typeof parsed.score !== 'number') return
    db.prepare('UPDATE candidates SET qualification_score = ?, qualification_notes = ? WHERE id = ?')
      .run(parsed.score, parsed.notes, id)
  } catch { /* skip on error (rate-limit / timeout) — picked up on next bg-qualify run */ }
}

async function qualifyCandidates(ids: number[], jobId: number, db: ReturnType<typeof getDb>) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Record<string, unknown> | null
  if (!job || ids.length === 0) return

  const queue = [...ids]
  const inFlight = new Set<Promise<void>>()

  while (queue.length > 0 || inFlight.size > 0) {
    while (inFlight.size < QUALIFY_CONCURRENCY && queue.length > 0) {
      const id = queue.shift()!
      const p = qualifyOne(id, job, db).finally(() => inFlight.delete(p))
      inFlight.add(p)
      if (queue.length > 0) await new Promise(r => setTimeout(r, QUALIFY_LAUNCH_DELAY_MS))
    }
    if (inFlight.size > 0) await Promise.race(inFlight)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Auth ─────────────────────────────────────────────────────────────────────
router.post('/auth', async (req: Request, res: Response) => {
  try {
    const db = getDb()
    const { email, password } = req.body as { email: string; password: string }
    if (!email || !password) return res.json({ error: 'Email et mot de passe requis' })

    const { data } = await axios.post(`${AUTH_URL}/Login`, { username: email, password, remember: true }, { timeout: 10000 })
    const token = data?.token || data?.access_token || (typeof data === 'string' ? data : null)
    if (!token) return res.json({ error: 'Réponse token invalide' })

    saveSetting(db, 'robota_email', email)
    saveSetting(db, 'robota_password', password)
    saveSetting(db, 'robota_token', token)
    saveSetting(db, 'robota_token_expires', new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString())
    res.json({ data: { success: true } })

    // Fire-and-forget full sync after successful login
    console.log('[auth] Triggering automatic full sync after login')
    runFullSync().catch(e => console.error('[auth full-sync]', (e as Error).message))
  } catch (err: unknown) {
    const status = (err as { response?: { status: number } }).response?.status
    if (status === 401) return res.json({ error: 'Identifiants invalides' })
    res.json({ error: (err as Error).message })
  }
})

// ─── Disconnect (clear robota.ua credentials and token) ──────────────────────
router.post('/disconnect', (_req: Request, res: Response) => {
  try {
    const db = getDb()
    db.prepare("DELETE FROM settings WHERE key IN ('robota_email','robota_password','robota_token','robota_token_expires')").run()
    res.json({ data: { success: true } })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

// ─── Config status ────────────────────────────────────────────────────────────
router.get('/config', (_req: Request, res: Response) => {
  try {
    const db = getDb()
    res.json({
      data: {
        robota_configured:  !!getSetting(db, 'robota_email'),
        smtp_configured:    !!(getSetting(db, 'smtp_host') && getSetting(db, 'smtp_user') && getSetting(db, 'smtp_pass')),
        turbosms_configured: !!getSetting(db, 'turbosms_token'),
        calendly_configured: !!getSetting(db, 'calendly_url'),
        auto_outreach:       getSetting(db, 'auto_outreach') !== 'false',
        robota_email:        getSetting(db, 'robota_email'),
        smtp_from:           getSetting(db, 'smtp_from'),
        calendly_url:        getSetting(db, 'calendly_url'),
        outreach_score_threshold: parseInt(getSetting(db, 'outreach_score_threshold') || '70'),
        followup_days:       parseInt(getSetting(db, 'followup_days') || '3'),
        last_auto_sync:      getSetting(db, 'last_auto_sync'),
      },
    })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

// ─── Save automation config ────────────────────────────────────────────────────
router.post('/config', (req: Request, res: Response) => {
  try {
    const db = getDb()
    const fields: Record<string, string> = {
      turbosms_token:           req.body.turbosms_token,
      turbosms_sender:          req.body.turbosms_sender,
      calendly_url:             req.body.calendly_url,
      auto_outreach:            req.body.auto_outreach,
      outreach_score_threshold: req.body.outreach_score_threshold,
      followup_days:            req.body.followup_days,
    }
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null && v !== '') saveSetting(db, k, String(v))
    }
    res.json({ data: { success: true } })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

// ─── Save SMTP ────────────────────────────────────────────────────────────────
router.post('/smtp-config', async (req: Request, res: Response) => {
  try {
    const db = getDb()
    const { host, port, user, pass, from } = req.body as Record<string, string>
    if (!host || !port || !user || !pass) return res.json({ error: 'host, port, user, pass required' })

    // Test connection before saving
    const nodemailer = await import('nodemailer')
    const transporter = nodemailer.createTransport({
      host, port: parseInt(port), secure: parseInt(port) === 465,
      auth: { user, pass },
      tls: { rejectUnauthorized: false },
    })
    try {
      await transporter.verify()
    } catch (e) {
      return res.json({ error: 'SMTP connection failed: ' + (e as Error).message })
    }

    saveSetting(db, 'smtp_host', host)
    saveSetting(db, 'smtp_port', port)
    saveSetting(db, 'smtp_user', user)
    saveSetting(db, 'smtp_pass', pass)
    saveSetting(db, 'smtp_from', from || user)
    res.json({ data: { success: true } })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

router.post('/smtp-disconnect', (_req: Request, res: Response) => {
  try {
    const db = getDb()
    db.prepare("DELETE FROM settings WHERE key IN ('smtp_host','smtp_port','smtp_user','smtp_pass','smtp_from')").run()
    res.json({ data: { success: true } })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

// ─── Manual sync for one job ──────────────────────────────────────────────────
router.post('/sync/:jobId', async (req: Request, res: Response) => {
  try {
    const db = getDb()
    const jobId = parseInt(req.params.jobId)
    const { robota_vacancy_id, auto_qualify } = req.body as { robota_vacancy_id?: number; auto_qualify?: boolean }

    if (robota_vacancy_id) {
      db.prepare('UPDATE jobs SET robota_vacancy_id = ? WHERE id = ?').run(robota_vacancy_id, jobId)
    }

    // If auto_qualify is explicitly false, use old simple flow
    if (auto_qualify === false) {
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined
      if (!job) return res.json({ error: 'Poste introuvable' })
      const vacancyId = robota_vacancy_id ?? (job.robota_vacancy_id as number | null)
      if (!vacancyId) return res.json({ error: 'robota_vacancy_id non configuré' })

      const token = await getToken(db)
      let page = 0; const allApplies: RobotaApply[] = []
      while (true) {
        const { data } = await axios.post(`${API_URL}/apply/list`, { vacancyId, folderId: 0, page, filter: '', candidateTypes: ['Application', 'ApplicationWithResume', 'ApplicationWithFile', 'VacancyInteraction'] },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 })
        const applies: RobotaApply[] = data?.applies ?? []
        allApplies.push(...applies)
        if (applies.length < 20) break
        page++
      }
      const existingIds = new Set((db.prepare('SELECT robota_apply_id FROM candidates WHERE job_id = ? AND robota_apply_id IS NOT NULL').all(jobId) as { robota_apply_id: string }[]).map(r => r.robota_apply_id))
      const newApplies = allApplies.filter(a => !existingIds.has(String(a.id)))
      let imported = 0
      for (const apply of newApplies) {
        try {
          const { data: detail } = await axios.post(`${API_URL}/apply/view/${apply.id}?resumeType=Notepad`, {}, { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 })
          db.prepare(`INSERT INTO candidates (job_id, initials, role, location, salary_expectation, experience_years, source_platform, profile_url, tags, status, stage, robota_apply_id, email, phone) VALUES (?, ?, ?, ?, ?, ?, 'robota.ua', ?, '[]', 'new', 'new', ?, ?, ?)`)
            .run(jobId, generateInitials(detail?.name), detail?.title || apply.speciality || 'Кандидат', detail?.cityName || null, detail?.salary || 0, detail?.experienceYears || 0, detail?.resumeUrl || null, String(apply.id), detail?.email || null, detail?.phones?.[0]?.value || null)
          imported++
          await new Promise(r => setTimeout(r, 150))
        } catch { /* skip */ }
      }
      return res.json({ data: { imported, total: allApplies.length } })
    }

    // Full auto flow
    const result = await runJobSync(jobId)
    res.json({ data: result })
  } catch (err: unknown) {
    const status = (err as { response?: { status: number } }).response?.status
    if (status === 401) return res.json({ error: 'Token expiré — reconnectez-vous' })
    res.json({ error: (err as Error).message })
  }
})

// ─── Manual outreach trigger for one candidate ────────────────────────────────
router.post('/outreach/:candidateId', async (req: Request, res: Response) => {
  try {
    const db = getDb()
    const candidateId = parseInt(req.params.candidateId)
    const { is_follow_up } = req.body as { is_follow_up?: boolean }
    const result = await sendOutreach(candidateId, db, is_follow_up)
    res.json({ data: result })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

// ─── Send email to a candidate (manual) ──────────────────────────────────────
router.post('/send-email/:candidateId', async (req: Request, res: Response) => {
  try {
    const db = getDb()
    const candidateId = parseInt(req.params.candidateId)
    const { subject, body: emailBody } = req.body as { subject: string; body: string }

    const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId) as Record<string, unknown> | undefined
    if (!candidate) return res.json({ error: 'Candidat introuvable' })
    if (!candidate.email) return res.json({ error: 'Pas d\'email pour ce candidat' })

    const smtpHost = getSetting(db, 'smtp_host'); const smtpPort = parseInt(getSetting(db, 'smtp_port') || '587')
    const smtpUser = getSetting(db, 'smtp_user'); const smtpPass = getSetting(db, 'smtp_pass')
    const smtpFrom = getSetting(db, 'smtp_from') || smtpUser
    if (!smtpHost || !smtpUser || !smtpPass) return res.json({ error: 'SMTP non configuré' })

    const transporter = nodemailer.createTransport({ host: smtpHost, port: smtpPort, secure: smtpPort === 465, auth: { user: smtpUser, pass: smtpPass } })
    await transporter.sendMail({ from: smtpFrom!, to: candidate.email as string, subject, text: emailBody, html: emailBody.replace(/\n/g, '<br>') })
    db.prepare('UPDATE candidates SET status = ?, contacted_at = CURRENT_TIMESTAMP WHERE id = ?').run('contacted', candidateId)
    const updated = db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId)
    res.json({ data: updated })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

// ─── List Farmasoft vacancies with their robota.ua status ────────────────────
router.get('/my-vacancies', async (_req: Request, res: Response) => {
  try {
    const db = getDb()
    const jobs = db.prepare(
      'SELECT id, title, location, robota_vacancy_id FROM jobs WHERE robota_vacancy_id IS NOT NULL ORDER BY id DESC'
    ).all() as { id: number; title: string; location: string; robota_vacancy_id: number }[]

    if (jobs.length === 0) return res.json({ data: [] })

    let token: string | null = null
    try { token = await getToken(db) } catch { /* not authenticated, return without status */ }

    const result = await Promise.all(jobs.map(async job => {
      if (!token) return { ...job, robota_status: null, error: 'Non connecté à robota.ua' }
      try {
        const { data } = await axios.get(
          `${API_URL}/vacancy/get/${job.robota_vacancy_id}`,
          { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 },
        )
        return {
          ...job,
          robota_status: data?.state || data?.status || 'Unknown',
          robota_name: data?.name || data?.title || null,
        }
      } catch {
        return { ...job, robota_status: null, error: 'Impossible de récupérer le statut' }
      }
    }))

    res.json({ data: result })
  } catch (err: unknown) {
    res.json({ error: (err as Error).message })
  }
})

// ─── Change vacancy state (Publicated / Paused / Closed) ─────────────────────
router.post('/vacancy-state/:robotaVacancyId', async (req: Request, res: Response) => {
  try {
    const db = getDb()
    const robotaVacancyId = parseInt(req.params.robotaVacancyId)
    const { state } = req.body as { state: string }

    const ALLOWED = ['Publicated', 'Paused', 'Closed']
    if (!ALLOWED.includes(state)) return res.json({ error: `État non autorisé. Valeurs acceptées : ${ALLOWED.join(', ')}` })

    // Safety: vacancy must belong to a Farmasoft job
    const job = db.prepare('SELECT id, title FROM jobs WHERE robota_vacancy_id = ?').get(robotaVacancyId) as { id: number; title: string } | undefined
    if (!job) return res.json({ error: 'Cette vacancy ne fait pas partie de Farmasoft — action refusée' })

    const token = await getToken(db)
    await axios.post(
      `${API_URL}/vacancy/state/${robotaVacancyId}?state=${state}`,
      {},
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 },
    )

    db.prepare('INSERT INTO events (type, job_id, metadata) VALUES (?, ?, ?)').run(
      'vacancy_state_changed', job.id, JSON.stringify({ robota_vacancy_id: robotaVacancyId, state }),
    )

    res.json({ data: { success: true, state } })
  } catch (err: unknown) {
    const status = (err as { response?: { status: number } }).response?.status
    if (status === 401) return res.json({ error: 'Token expiré — reconnectez-vous' })
    res.json({ error: (err as Error).message })
  }
})

// ─── Update vacancy content from Farmasoft job data ──────────────────────────
router.put('/vacancy/:jobId', async (req: Request, res: Response) => {
  try {
    const db = getDb()
    const jobId = parseInt(req.params.jobId)

    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined
    if (!job) return res.json({ error: 'Poste introuvable' })
    if (!job.robota_vacancy_id) return res.json({ error: 'Ce poste n\'a pas de vacancy robota.ua associée' })

    const token = await getToken(db)
    const cityId = CITY_MAP[job.location as string] || 1
    const skills: string[] = (() => { try { return JSON.parse(job.skills as string || '[]') } catch { return [] } })()

    const rawDescU = [job.description, job.requirements, skills.length ? `Навички: ${skills.join(', ')}` : ''].filter(Boolean).join('\n\n')
    const minDescU = rawDescU.length >= 150 ? rawDescU
      : `${rawDescU}\n\nКомпанія Farmasoft UA запрошує кандидатів на посаду "${job.title as string}". Ми пропонуємо конкурентну заробітну плату, офіційне оформлення та комфортні умови праці. Надсилайте своє резюме — ми розглянемо кожну заявку.`.substring(0, Math.max(rawDescU.length + 300, 300))

    const payload = {
      id: job.robota_vacancy_id,
      cityId,
      name: job.title,
      description: minDescU,
      salaryRange: (job.salary_min && job.salary_max)
        ? { amountFrom: job.salary_min, amountTo: job.salary_max }
        : undefined,
      publishType: getSetting(db, 'robota_publish_type') || 'Business',
      sendResumeType: '1',
      contactEMail: getSetting(db, 'robota_email') || '',
    }

    await axios.post(`${API_URL}/vacancy/add`, payload, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
    })

    db.prepare('INSERT INTO events (type, job_id, metadata) VALUES (?, ?, ?)').run(
      'vacancy_updated', jobId, JSON.stringify({ robota_vacancy_id: job.robota_vacancy_id }),
    )

    res.json({ data: { success: true, robota_vacancy_id: job.robota_vacancy_id as number } })
  } catch (err: unknown) {
    const status = (err as { response?: { status: number } }).response?.status
    if (status === 401) return res.json({ error: 'Token expiré — reconnectez-vous' })
    res.json({ error: (err as Error).message })
  }
})

// ─── Delete vacancy on robota.ua ──────────────────────────────────────────────
router.delete('/vacancy/:robotaVacancyId', async (req: Request, res: Response) => {
  try {
    const db = getDb()
    const robotaVacancyId = parseInt(req.params.robotaVacancyId)

    // Safety: must belong to a Farmasoft job
    const job = db.prepare('SELECT id, title FROM jobs WHERE robota_vacancy_id = ?').get(robotaVacancyId) as { id: number; title: string } | undefined
    if (!job) return res.json({ error: 'Cette vacancy ne fait pas partie de Farmasoft — action refusée' })

    const token = await getToken(db)

    // Close first, then delete via Deleted state
    try {
      await axios.post(`${API_URL}/vacancy/state/${robotaVacancyId}?state=Closed`, {},
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 })
    } catch { /* continue even if close fails */ }

    await axios.post(`${API_URL}/vacancy/state/${robotaVacancyId}?state=Deleted`, {},
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 })

    // Remove link in Farmasoft DB (keep the job itself)
    db.prepare('UPDATE jobs SET robota_vacancy_id = NULL WHERE id = ?').run(job.id)

    db.prepare('INSERT INTO events (type, job_id, metadata) VALUES (?, ?, ?)').run(
      'vacancy_deleted', job.id, JSON.stringify({ robota_vacancy_id: robotaVacancyId }),
    )

    res.json({ data: { success: true } })
  } catch (err: unknown) {
    const status = (err as { response?: { status: number } }).response?.status
    if (status === 401) return res.json({ error: 'Token expiré — reconnectez-vous' })
    res.json({ error: (err as Error).message })
  }
})

// ─── Classify robota.ua publication errors into actionable categories ───────
// Returns kind=insufficient_credits + the publication type quoted in the message,
// so the UI can deep-link to the right top-up flow on robota.ua. Falls back to
// kind=other when the message doesn't match a known pattern.
type PublicationFailureKind = 'insufficient_credits' | 'profile_incomplete' | 'other'
function detectPublicationFailure(msg: string): { kind: PublicationFailureKind; publicationType?: string } {
  const m = msg.toLowerCase()
  const isCredits = /не\s*вистачає\s*одиниць|недостатньо\s*одиниць|не\s*хватает\s*единиц|insufficient\s+(placement|publication)\s+units/i.test(msg)
  if (isCredits) {
    const quoted = msg.match(/["«'„](.+?)["»'"]/)?.[1]
    return { kind: 'insufficient_credits', publicationType: quoted }
  }
  if (/профіль|profile|заповніть|обов'язков/i.test(m)) return { kind: 'profile_incomplete' }
  return { kind: 'other' }
}

// ─── Retry publication of a vacancy that's already been created on robota.ua ─
router.post('/retry-publish/:jobId', async (req: Request, res: Response) => {
  try {
    const db = getDb()
    const jobId = parseInt(req.params.jobId)
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined
    if (!job) return res.json({ error: 'Poste introuvable' })
    const vacancyId = job.robota_vacancy_id as number | null
    if (!vacancyId) return res.json({ error: 'Aucune annonce robota.ua à republier — utilisez Publish d\'abord' })

    const token = await getToken(db)
    const stateResp = await axios.post(`${API_URL}/vacancy/state/${vacancyId}?state=Publicated`, {}, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 10000,
    })
    if (stateResp.data?.success === false) {
      const msg = (stateResp.data?.message as string)?.replace('[CUSTOM ERROR] ', '') || 'Publication refusée par robota.ua'
      const failure = detectPublicationFailure(msg)
      return res.json({
        error: msg,
        publication_failure: { ...failure, robota_vacancy_id: vacancyId, raw_message: msg },
      })
    }
    db.prepare("UPDATE jobs SET robota_state = 'Publicated' WHERE id = ?").run(jobId)
    db.prepare('INSERT INTO events (type, job_id, metadata) VALUES (?, ?, ?)').run(
      'vacancy_republished', jobId, JSON.stringify({ robota_vacancy_id: vacancyId }),
    )
    res.json({ data: { success: true, robota_vacancy_id: vacancyId } })
  } catch (err: unknown) {
    const status = (err as { response?: { status: number } }).response?.status
    if (status === 401) return res.json({ error: 'Token expiré — reconnectez-vous' })
    res.json({ error: (err as Error).message })
  }
})

// ─── Publish vacancy to robota.ua ─────────────────────────────────────────────
router.post('/publish-vacancy/:jobId', async (req: Request, res: Response) => {
  try {
    const db = getDb()
    const jobId = parseInt(req.params.jobId)
    const { publish_type, contact_email, work_types, employment_types } = req.body as {
      publish_type?: string
      contact_email?: string
      work_types?: string[]
      employment_types?: string[]
    }

    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined
    if (!job) return res.json({ error: 'Poste introuvable' })

    const token = await getToken(db)

    const cityId = CITY_MAP[job.location as string] || 1
    const skills: string[] = (() => { try { return JSON.parse(job.skills as string || '[]') } catch { return [] } })()
    const existingVacancyId = job.robota_vacancy_id as number | null

    const rawDescP = [job.description, job.requirements, skills.length ? `Навички: ${skills.join(', ')}` : ''].filter(Boolean).join('\n\n')
    const minDescP = rawDescP.length >= 150 ? rawDescP
      : `${rawDescP}\n\nКомпанія Farmasoft UA запрошує кандидатів на посаду "${job.title as string}". Ми пропонуємо конкурентну заробітну плату, офіційне оформлення та комфортні умови праці. Надсилайте своє резюме — ми розглянемо кожну заявку.`.substring(0, Math.max(rawDescP.length + 300, 300))

    const expYears   = (job.experience_years as number) || 0
    const salaryAvg  = (job.salary_min && job.salary_max) ? Math.round(((job.salary_min as number) + (job.salary_max as number)) / 2) : ((job.salary_min as number) || 0)

    const payload = {
      id: existingVacancyId || 0,
      cityId,
      name: job.title,
      description: minDescP,
      salary: salaryAvg,
      salaryRange: (job.salary_min && job.salary_max)
        ? { amountFrom: job.salary_min, amountTo: job.salary_max }
        : undefined,
      currencyId: 1, // UAH
      experienceId: expYearsToId(expYears),
      educationId: 0,
      scheduleId: 1, // Full-time
      publishType: publish_type || getSetting(db, 'robota_publish_type') || 'Business',
      sendResumeType: '1',
      contactEMail: contact_email || getSetting(db, 'robota_email') || '',
      contactPerson: getSetting(db, 'robota_contact_person') || 'HR Farmasoft UA',
      employmentTypes: employment_types || ['FullTime'],
      workTypes: work_types || ['Office'],
      endingType: 'CloseAndNotify',
    }

    const { data: createResp } = await axios.post(`${API_URL}/vacancy/add`, payload, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
    })

    // robota.ua returns { vacancyId, error, success } — check success first
    if (createResp?.success === false) {
      return res.json({ error: `robota.ua: ${createResp.error || 'publication refusée'}` })
    }

    const newVacancyId = createResp?.vacancyId || createResp?.id || existingVacancyId
    if (!newVacancyId) return res.json({ error: 'ID de vacancy non retourné par robota.ua' })

    // Publish it — capture the response so we can surface profile-completion errors
    const stateResp = await axios.post(`${API_URL}/vacancy/state/${newVacancyId}?state=Publicated`, {}, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 10000,
    })
    if (stateResp.data?.success === false) {
      db.prepare("UPDATE jobs SET robota_vacancy_id = ?, robota_state = 'NotPublicated' WHERE id = ?").run(newVacancyId, jobId)
      const msg = (stateResp.data?.message as string)?.replace('[CUSTOM ERROR] ', '') || 'Publication refusée par robota.ua'
      const failure = detectPublicationFailure(msg)
      return res.json({
        error: `Annonce créée (ID ${newVacancyId}) mais non publiée — ${msg}`,
        publication_failure: { ...failure, robota_vacancy_id: newVacancyId, raw_message: msg },
      })
    }

    // Save vacancy ID
    db.prepare('UPDATE jobs SET robota_vacancy_id = ? WHERE id = ?').run(newVacancyId, jobId)
    if (publish_type) saveSetting(db, 'robota_publish_type', publish_type)

    db.prepare('INSERT INTO events (type, job_id, metadata) VALUES (?, ?, ?)').run(
      'vacancy_published', jobId, JSON.stringify({ robota_vacancy_id: newVacancyId }),
    )

    res.json({ data: { success: true, robota_vacancy_id: newVacancyId } })
  } catch (err: unknown) {
    const status = (err as { response?: { status: number } }).response?.status
    if (status === 401) return res.json({ error: 'Token expiré — reconnectez-vous' })
    res.json({ error: (err as Error).message })
  }
})

// ─── Discover all employer vacancies from robota.ua ──────────────────────────
router.get('/employer-vacancies', async (_req: Request, res: Response) => {
  try {
    const db = getDb()
    const token = await getToken(db)
    const vacancies = await fetchEmployerVacancies(token)

    // Enrich with whether they're already in Farmasoft
    const linked = db.prepare('SELECT robota_vacancy_id, id, title FROM jobs WHERE robota_vacancy_id IS NOT NULL').all() as { robota_vacancy_id: number; id: number; title: string }[]
    const linkedMap = new Map(linked.map(j => [j.robota_vacancy_id, j]))

    const result = vacancies.map(v => ({
      ...v,
      farmasoft_job_id:    linkedMap.get(v.id)?.id ?? null,
      farmasoft_job_title: linkedMap.get(v.id)?.title ?? null,
      linked:              linkedMap.has(v.id),
    }))

    res.json({ data: result })
  } catch (err: unknown) {
    const status = (err as { response?: { status: number } }).response?.status
    if (status === 401) return res.json({ error: 'Token expiré — reconnectez-vous' })
    res.json({ error: (err as Error).message })
  }
})

// ─── CV database search ───────────────────────────────────────────────────────
router.post('/cvdb/search', async (req: Request, res: Response) => {
  try {
    const db = getDb()
    const { keywords, cityId, salaryFrom, salaryTo, experienceId, page, count, jobId } = req.body as {
      keywords: string
      cityId?: number
      salaryFrom?: number
      salaryTo?: number
      experienceId?: number
      page?: number
      count?: number
      jobId?: number
    }
    if (!keywords?.trim()) return res.json({ error: 'Mots-clés requis' })

    const token = await getToken(db)

    const payload: Record<string, unknown> = {
      keyWords: keywords.trim(),
      page: page ?? 0,
      count: Math.min(count ?? 20, 50),
    }
    if (cityId) payload.cityId = cityId
    if (salaryFrom) payload.salaryFrom = salaryFrom
    if (salaryTo) payload.salaryTo = salaryTo
    if (experienceId !== undefined) payload.experienceId = experienceId

    const { data } = await axios.post(`${API_URL}/cvdb/resumes`, payload, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
    })

    const documents = (data?.documents ?? []) as Record<string, unknown>[]
    if (documents.length === 0) return res.json({ data: { candidates: [], total: 0 } })

    // Import as candidates — link to current job, even if already in DB under another job
    const imported: number[] = []
    for (const doc of documents) {
      const resumeId = doc.resumeId as number
      const profileUrl = `https://robota.ua/ua/cv/${resumeId}`

      const name     = (doc.displayName ?? doc.fullName ?? '') as string
      const role     = (doc.speciality ?? '') as string
      const city     = (doc.cityName ?? '') as string
      const salary   = parseInt(String(doc.salary ?? '0').replace(/\D/g, '')) || 0
      const expYears = Array.isArray(doc.experience) ? doc.experience.length : 0

      // 1. Already linked to THIS job? → reuse
      if (jobId) {
        const existingForJob = db.prepare(
          'SELECT id FROM candidates WHERE profile_url = ? AND job_id = ?'
        ).get(profileUrl, jobId) as { id: number } | undefined
        if (existingForJob) { imported.push(existingForJob.id); continue }
      }

      // 2. Orphan (no job_id) with same profile_url? → adopt
      const orphan = db.prepare(
        'SELECT id FROM candidates WHERE profile_url = ? AND job_id IS NULL'
      ).get(profileUrl) as { id: number } | undefined
      if (orphan && jobId) {
        db.prepare('UPDATE candidates SET job_id = ? WHERE id = ?').run(jobId, orphan.id)
        imported.push(orphan.id)
        continue
      }

      // 3. Insert new row for this job (allowing same candidate under multiple jobs)
      const r = db.prepare(`
        INSERT INTO candidates (job_id, initials, role, location, salary_expectation, experience_years,
          source_platform, profile_url, tags, status, stage, source_type)
        VALUES (?, ?, ?, ?, ?, ?, 'robota.ua', ?, '[]', 'new', 'new', 'scraped')
      `).run(jobId ?? null, generateInitials(name), role, city, salary, expYears, profileUrl)

      imported.push(r.lastInsertRowid as number)
    }

    const candidates = db.prepare(
      `SELECT * FROM candidates WHERE id IN (${imported.map(() => '?').join(',')}) ORDER BY created_at DESC`
    ).all(...imported)

    db.prepare('INSERT INTO events (type, job_id, metadata) VALUES (?, ?, ?)').run(
      'cvdb_search', jobId ?? null,
      JSON.stringify({ keywords, count: imported.length, total: data?.total ?? 0 }),
    )

    res.json({ data: { candidates, total: data?.total ?? 0 } })
  } catch (err: unknown) {
    const status = (err as { response?: { status: number } }).response?.status
    if (status === 401) return res.json({ error: 'Token expiré — reconnectez-vous' })
    res.json({ error: (err as Error).message })
  }
})

// ─── CV credits info (how many "open contacts" available) ───────────────────
router.get('/credits', async (_req: Request, res: Response) => {
  try {
    const db = getDb()
    const token = await getToken(db)
    const [count, services] = await Promise.all([
      axios.get(`${API_URL}/resume/open-contacts-count`, { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }),
      axios.get(`${API_URL}/api/service/cvdb`, { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }),
    ])
    const packs = (Array.isArray(services.data) ? services.data : []) as Array<Record<string, unknown>>
    const totalAllocated = packs.reduce((sum, p) => sum + ((p.openContactCount as number) || 0), 0)
    const totalUsed = packs.reduce((sum, p) => sum + ((p.usedContactCount as number) || 0), 0)
    const earliestExpiry = packs
      .map(p => p.activationEndDate as string)
      .filter(d => d && d !== '0001-01-01T00:00:00')
      .sort()[0] || null

    res.json({
      data: {
        available: count.data?.availableContacts || 0,
        totalAllocated,
        totalUsed,
        expiresAt: earliestExpiry,
        packs: packs.map(p => ({
          name:    p.serviceTypeNameUkr || p.serviceTypeName,
          allocated: p.openContactCount,
          used:    p.usedContactCount,
          expiresAt: p.activationEndDate,
        })),
      },
    })
  } catch (err: unknown) {
    const status = (err as { response?: { status: number } }).response?.status
    if (status === 401) return res.json({ error: 'Token expiré — reconnectez-vous' })
    res.json({ error: (err as Error).message })
  }
})

// ─── Open a CV (consumes 1 credit, fetches full structured data) ─────────────
router.post('/cvdb/open/:resumeId', async (req: Request, res: Response) => {
  try {
    const db = getDb()
    const resumeId = parseInt(req.params.resumeId)
    const { jobId } = req.body as { jobId?: number }
    if (!resumeId) return res.json({ error: 'resumeId requis' })

    const token = await getToken(db)

    // Step 1: open the resume (consumes 1 credit)
    try {
      await axios.post(`${API_URL}/resume/open/${resumeId}`, {}, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 10000,
      })
    } catch (e: unknown) {
      const status = (e as { response?: { status: number; data?: unknown } }).response?.status
      if (status === 402 || status === 403) return res.json({ error: 'Plus de crédits disponibles' })
      // 200/204 may also reach here if already opened — continue
    }

    // Step 2: fetch the full resume
    const { data: resume } = await axios.get(`${API_URL}/resume/${resumeId}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, timeout: 10000,
    })
    if (!resume || !resume.resumeId) return res.json({ error: 'CV introuvable après ouverture' })

    const r = resume as Record<string, unknown>
    const fullName = [r.surname, r.name, r.fatherName].filter(Boolean).join(' ').trim() || null
    const profileUrl = `https://robota.ua/ua/cv/${resumeId}`

    // Upsert candidate (link to existing if same profile_url, else insert new)
    const existing = db.prepare('SELECT id FROM candidates WHERE profile_url = ?').get(profileUrl) as { id: number } | undefined
    const profileData = JSON.stringify({
      surname: r.surname, fatherName: r.fatherName,
      sex: r.sex, age: r.age,
      educationId: r.educationId, profLevelId: r.profLevelId,
      branchIds: r.branchIds, language: r.language, skype: r.skype,
      diiaCertificate: r.diiaCertificate,
      isFullyOpened: true,
      openedAt: new Date().toISOString(),
    })

    let candidateId: number
    if (existing) {
      db.prepare(`
        UPDATE candidates SET full_name = COALESCE(?, full_name),
          email = COALESCE(?, email), phone = COALESCE(?, phone),
          photo_url = COALESCE(?, photo_url), birth_date = COALESCE(?, birth_date),
          location = COALESCE(?, location), salary_expectation = COALESCE(?, salary_expectation),
          role = COALESCE(?, role), profile_data = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        fullName, r.email || null, r.phone || null,
        r.photo || null, r.birthDate || null,
        CITY_ID_TO_NAME[r.cityId as number] || null,
        parseInt(String(r.salary || '0').replace(/\D/g, '')) || null,
        r.speciality || null, profileData, existing.id,
      )
      candidateId = existing.id
    } else {
      const result = db.prepare(`
        INSERT INTO candidates (job_id, initials, full_name, role, location, salary_expectation,
          source_platform, profile_url, photo_url, birth_date, tags, status, stage, source_type,
          email, phone, profile_data)
        VALUES (?, ?, ?, ?, ?, ?, 'robota.ua', ?, ?, ?, '[]', 'new', 'new', 'scraped', ?, ?, ?)
      `).run(
        jobId ?? null, generateInitials(fullName as string), fullName,
        r.speciality || 'Кандидат', CITY_ID_TO_NAME[r.cityId as number] || null,
        parseInt(String(r.salary || '0').replace(/\D/g, '')) || 0,
        profileUrl, r.photo || null, r.birthDate || null,
        r.email || null, r.phone || null, profileData,
      )
      candidateId = result.lastInsertRowid as number
    }

    db.prepare('INSERT INTO events (type, candidate_id, metadata) VALUES (?, ?, ?)').run(
      'cv_opened', candidateId, JSON.stringify({ resumeId, fullName }),
    )

    const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId)
    res.json({ data: candidate })
  } catch (err: unknown) {
    const status = (err as { response?: { status: number } }).response?.status
    if (status === 401) return res.json({ error: 'Token expiré — reconnectez-vous' })
    res.json({ error: (err as Error).message })
  }
})

// ─── Full sync status ─────────────────────────────────────────────────────────
router.get('/full-sync/status', (_req: Request, res: Response) => {
  res.json({ data: fullSyncProgress })
})

// ─── Internal full-sync runner (used by route, post-login, and startup) ──────
export async function runFullSync(): Promise<void> {
  if (fullSyncProgress.status === 'running') return

  const db = getDb()

  fullSyncProgress = {
    status: 'running', vacanciesTotal: 0, vacanciesDone: 0,
    candidatesImported: 0, candidatesOutreached: 0,
    currentVacancy: 'Authentification...', startedAt: new Date().toISOString(), finishedAt: null,
  }

  try {
    const token = await getToken(db)

    // Ensure cities cache (auto-fetched on first run, persists across restarts)
    await ensureCitiesCache(token)

    // ── STEP 1: Farmasoft → robota.ua (publish active jobs not yet on robota.ua) ──
    fullSyncProgress.currentVacancy = 'Publication des postes Farmasoft...'
    const unpublishedJobs = db.prepare(
      'SELECT * FROM jobs WHERE is_active = 1 AND robota_vacancy_id IS NULL'
    ).all() as Record<string, unknown>[]

    for (const job of unpublishedJobs) {
      try {
        fullSyncProgress.currentVacancy = `Publication: ${job.title as string}`
        const cityId = CITY_MAP[job.location as string] || 1
        const skills: string[] = (() => { try { return JSON.parse(job.skills as string || '[]') } catch { return [] } })()
        const rawDesc = [job.description, job.requirements, skills.length ? `Навички: ${skills.join(', ')}` : ''].filter(Boolean).join('\n\n')
        const minDesc = rawDesc.length >= 150 ? rawDesc
          : `${rawDesc}\n\nКомпанія Farmasoft UA запрошує кандидатів на посаду "${job.title as string}". Ми пропонуємо конкурентну заробітну плату, офіційне оформлення та комфортні умови праці. Надсилайте своє резюме — ми розглянемо кожну заявку.`.substring(0, Math.max(rawDesc.length + 300, 300))

        const expYears  = (job.experience_years as number) || 0
        const salaryAvg = (job.salary_min && job.salary_max) ? Math.round(((job.salary_min as number) + (job.salary_max as number)) / 2) : ((job.salary_min as number) || 0)

        const payload = {
          id: 0,
          cityId,
          name: job.title,
          description: minDesc,
          salary: salaryAvg,
          salaryRange: (job.salary_min && job.salary_max) ? { amountFrom: job.salary_min, amountTo: job.salary_max } : undefined,
          currencyId: 1,
          experienceId: expYearsToId(expYears),
          educationId: 0,
          scheduleId: 1,
          publishType: getSetting(db, 'robota_publish_type') || 'Business',
          sendResumeType: '1',
          contactEMail: getSetting(db, 'robota_email') || '',
          contactPerson: getSetting(db, 'robota_contact_person') || 'HR Farmasoft UA',
          employmentTypes: ['FullTime'],
          workTypes: ['Office'],
          endingType: 'CloseAndNotify',
        }
        const { data: createResp } = await axios.post(`${API_URL}/vacancy/add`, payload, {
          headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
        })
        if (createResp?.success === false) continue
        const newVacancyId = createResp?.vacancyId || createResp?.id
        if (newVacancyId) {
          await axios.post(`${API_URL}/vacancy/state/${newVacancyId}?state=Publicated`, {},
            { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 })
          db.prepare('UPDATE jobs SET robota_vacancy_id = ? WHERE id = ?').run(newVacancyId, job.id)
          db.prepare('INSERT INTO events (type, job_id, metadata) VALUES (?, ?, ?)').run(
            'vacancy_published', job.id, JSON.stringify({ robota_vacancy_id: newVacancyId, source: 'full_sync' }),
          )
        }
        await new Promise(r => setTimeout(r, 500))
      } catch { /* skip this job, don't block the rest */ }
    }

    // ── STEP 2: robota.ua → Farmasoft (import vacancies not in Farmasoft) ──
    fullSyncProgress.currentVacancy = 'Découverte des vacancies robota.ua...'
    const vacancies = await fetchEmployerVacancies(token)
    fullSyncProgress.vacanciesTotal = vacancies.length

    for (const v of vacancies) {
      fullSyncProgress.currentVacancy = v.name || `Vacancy ${v.id}`

      // Always fetch full vacancy details from robota.ua (needed for both create and update)
      let detail: Record<string, unknown> = {}
      try {
        const { data } = await axios.get(`${API_URL}/vacancy/get/${v.id}`, {
          headers: { Authorization: `Bearer ${token}` }, timeout: 10000,
        })
        detail = data as Record<string, unknown>
      } catch { detail = {} }

      const title       = (detail.vacancyName ?? detail.name ?? detail.title ?? v.name ?? `Vacancy ${v.id}`) as string
      const location    = (detail.cityName ?? v.cityName ?? '') as string
      const salaryMin   = ((detail.salaryRange as Record<string, unknown>)?.amountFrom ?? (v.salaryRange?.amountFrom) ?? 0) as number
      const salaryMax   = ((detail.salaryRange as Record<string, unknown>)?.amountTo   ?? (v.salaryRange?.amountTo)   ?? 0) as number
      const description = (detail.description ?? v.description ?? '') as string
      const state       = (detail.state ?? v.state ?? '') as string

      // Find or create+update the linked Farmasoft job
      let job = db.prepare('SELECT * FROM jobs WHERE robota_vacancy_id = ?').get(v.id) as Record<string, unknown> | undefined

      // is_active reflects the current state on robota.ua
      const isActive = ['Publicated', 'Waiting'].includes(state) ? 1 : 0

      if (!job) {
        const r = db.prepare(`
          INSERT INTO jobs (title, location, salary_min, salary_max, salary_currency, description, is_active, robota_vacancy_id)
          VALUES (?, ?, ?, ?, 'UAH', ?, ?, ?)
        `).run(title, location, salaryMin, salaryMax, description, isActive, v.id)

        job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(r.lastInsertRowid) as Record<string, unknown>

        db.prepare('INSERT INTO events (type, job_id, metadata) VALUES (?, ?, ?)').run(
          'job_imported_from_robota', r.lastInsertRowid,
          JSON.stringify({ robota_vacancy_id: v.id, title, state }),
        )
      } else {
        // Update existing Farmasoft job with latest robota.ua data
        db.prepare(`
          UPDATE jobs SET title = ?, location = ?, salary_min = ?, salary_max = ?,
          description = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(title, location, salaryMin, salaryMax, description, isActive, job.id)

        db.prepare('INSERT INTO events (type, job_id, metadata) VALUES (?, ?, ?)').run(
          'job_updated_from_robota', job.id,
          JSON.stringify({ robota_vacancy_id: v.id, title, state }),
        )
      }

      // Sync candidates for this vacancy — skip AI qualification (runs after, in background)
      try {
        const result = await runJobSync(job.id as number, { skipQualification: true })
        fullSyncProgress.candidatesImported  += result.imported
        fullSyncProgress.candidatesOutreached += result.outreached
      } catch { /* skip this vacancy */ }

      fullSyncProgress.vacanciesDone++
    }

    fullSyncProgress.status     = 'done'
    fullSyncProgress.finishedAt = new Date().toISOString()
    fullSyncProgress.currentVacancy = ''

    saveSetting(db, 'last_full_sync', new Date().toISOString())
    console.log(`[full-sync] Done — ${fullSyncProgress.vacanciesDone} vacancies, ${fullSyncProgress.candidatesImported} candidates imported`)

    // Kick off background qualification for all unqualified candidates (non-blocking)
    qualifyAllUnqualified(db).catch(e => console.error('[bg-qualify]', (e as Error).message))
  } catch (err: unknown) {
    fullSyncProgress.status = 'error'
    fullSyncProgress.error  = (err as Error).message
    fullSyncProgress.finishedAt = new Date().toISOString()
    console.error('[full-sync] Error:', (err as Error).message)
  }
}

// HTTP route — kept for explicit retriggering, but auto-triggered on login & startup
router.post('/full-sync', async (_req: Request, res: Response) => {
  if (fullSyncProgress.status === 'running') {
    return res.json({ error: 'Un sync complet est déjà en cours' })
  }
  res.json({ data: { started: true } })
  runFullSync().catch(e => console.error('[full-sync route]', (e as Error).message))
})

export default router
