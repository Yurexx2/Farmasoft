// import.meta.env.BASE_URL is the Vite `base` (e.g. '/' or '/farmasoft/hr/'),
// so the API lives at <base>api — works at the domain root and under a sub-path.
const env = (import.meta as unknown as { env: Record<string, string> }).env
const BASE = `${env.BASE_URL || '/'}api`
// In production the server injects window.__FARMASOFT_API_KEY__ into index.html;
// in local dev (Vite serves the front) we fall back to the build-time env var.
const API_KEY = (window as unknown as { __FARMASOFT_API_KEY__?: string }).__FARMASOFT_API_KEY__
  || env.VITE_API_SECRET

async function req<T>(url: string, options?: RequestInit): Promise<{ data?: T; error?: string }> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (API_KEY) headers['x-api-key'] = API_KEY
    // no-store — API responses must never be served from the browser cache,
    // otherwise a stale (or transiently empty) response keeps coming back.
    const res = await fetch(`${BASE}${url}`, {
      headers,
      cache: 'no-store',
      ...options,
    })
    // Read as text first — during a redeploy the server can return an HTML
    // page, which would otherwise throw a cryptic "Unexpected token '<'".
    const text = await res.text()
    let json: { data?: T; error?: string }
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      return { error: res.ok ? 'Réponse inattendue du serveur, réessayez' : `Serveur indisponible (HTTP ${res.status})` }
    }
    if (!res.ok) return { error: json.error || `HTTP ${res.status}` }
    return json
  } catch (err) {
    return { error: (err as Error).message }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (data: any) => ({ body: JSON.stringify(data) })

// Publish endpoints can return a `publication_failure` payload alongside `error`,
// describing why publication was rejected (insufficient credits, incomplete profile…).
// The UI uses this to render specific recovery actions (buy credits, fix profile).
export interface PublicationFailure {
  kind: 'insufficient_credits' | 'profile_incomplete' | 'other'
  publicationType?: string
  robota_vacancy_id?: number
  raw_message?: string
}
async function reqPublish(
  url: string,
  options?: RequestInit,
): Promise<{ data?: { success: boolean; robota_vacancy_id: number }; error?: string; publication_failure?: PublicationFailure }> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (API_KEY) headers['x-api-key'] = API_KEY
    const res = await fetch(`${BASE}${url}`, { headers, cache: 'no-store', ...options })
    const text = await res.text()
    let json: { data?: { success: boolean; robota_vacancy_id: number }; error?: string; publication_failure?: PublicationFailure }
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      return { error: res.ok ? 'Réponse inattendue du serveur, réessayez' : `Serveur indisponible (HTTP ${res.status})` }
    }
    if (!res.ok) return { error: json.error || `HTTP ${res.status}`, publication_failure: json.publication_failure }
    return json
  } catch (err) {
    return { error: (err as Error).message }
  }
}

export const api = {
  jobs: {
    list: () => req<Job[]>('/jobs'),
    withCounts: () => req<(Job & { candidate_count: number })[]>('/jobs/with-counts'),
    get: (id: number) => req<Job>(`/jobs/${id}`),
    create: (job: Partial<Job>) => req<Job>('/jobs', { method: 'POST', ...body(job) }),
    update: (id: number, job: Partial<Job>) => req<Job>(`/jobs/${id}`, { method: 'PUT', ...body(job) }),
    remove: (id: number) => req<{ success: boolean }>(`/jobs/${id}`, { method: 'DELETE' }),
  },
  candidates: {
    list: (jobId?: number) => req<Candidate[]>(`/candidates${jobId ? `?jobId=${jobId}` : ''}`),
    get: (id: number) => req<Candidate>(`/candidates/${id}`),
    updateStatus: (id: number, status: string) =>
      req<Candidate>(`/candidates/${id}/status`, { method: 'PUT', ...body({ status }) }),
    updateStage: (id: number, stage: string) =>
      req<Candidate>(`/candidates/${id}/stage`, { method: 'PUT', ...body({ stage }) }),
    setKanban: (id: number, column: string) =>
      req<Candidate>(`/candidates/${id}/kanban`, { method: 'PUT', ...body({ column }) }),
    updateRejectionReason: (id: number, rejection_reason: string) =>
      req<Candidate>(`/candidates/${id}/rejection-reason`, { method: 'PUT', ...body({ rejection_reason }) }),
    qualify: (id: number) =>
      req<Candidate>(`/candidates/${id}/qualify`, { method: 'POST' }),
    remove: (id: number) => req<{ success: boolean }>(`/candidates/${id}`, { method: 'DELETE' }),
  },
  interviews: {
    list: (jobId?: number) => req<Interview[]>(`/interviews${jobId ? `?jobId=${jobId}` : ''}`),
    create: (interview: Partial<Interview>) => req<Interview>('/interviews', { method: 'POST', ...body(interview) }),
    update: (id: number, interview: Partial<Interview>) =>
      req<Interview>(`/interviews/${id}`, { method: 'PUT', ...body(interview) }),
    remove: (id: number) => req<{ success: boolean }>(`/interviews/${id}`, { method: 'DELETE' }),
  },
  messages: {
    list: (jobId?: number) => req<Message[]>(`/messages${jobId ? `?jobId=${jobId}` : ''}`),
    create: (msg: Partial<Message>) => req<Message>('/messages', { method: 'POST', ...body(msg) }),
    update: (id: number, msg: Partial<Message>) => req<Message>(`/messages/${id}`, { method: 'PUT', ...body(msg) }),
    remove: (id: number) => req<{ success: boolean }>(`/messages/${id}`, { method: 'DELETE' }),
  },
  cv: {
    parse: (filename: string, content: string, mimeType: string, jobId?: number) =>
      req<Candidate>('/cv/parse', { method: 'POST', ...body({ filename, content, mimeType, jobId }) }),
  },
  scraper: {
    search: (params: SearchParams) =>
      req<Candidate[]>('/scraper/search', { method: 'POST', ...body(params) }),
  },
  ai: {
    generateJob: (title: string) =>
      req<Partial<Job>>('/ai/generate-job', { method: 'POST', ...body({ title }) }),
    generateMessage: (job: Partial<Job>, candidate: Candidate, language: string, channel?: 'whatsapp' | 'telegram' | 'viber' | 'email', calendlyUrl?: string) =>
      req<string>('/ai/generate-message', { method: 'POST', ...body({ job, candidate, language, channel, calendlyUrl }) }),
  },
  analytics: {
    kpis: () => req<KPIs>('/analytics/kpis'),
    weekly: () => req<WeeklyData[]>('/analytics/weekly'),
    recent: () => req<RecentEvent[]>('/analytics/recent'),
    searches: () => req<SearchHistory[]>('/analytics/searches'),
    sources: () => req<SourceStat[]>('/analytics/sources'),
    rejections: () => req<RejectionStat[]>('/analytics/rejections'),
    candidateMessages: (candidateId: number) => req<CandidateMessageEvent[]>(`/analytics/candidate-messages/${candidateId}`),
    log: (type: string, metadata?: Record<string, unknown>) =>
      req<{ success: boolean }>('/analytics/log', { method: 'POST', ...body({ type, metadata }) }),
  },
  settings: {
    get: (key: string) => req<string>(`/settings/${key}`),
    set: (key: string, value: string) =>
      req<{ success: boolean }>(`/settings/${key}`, { method: 'PUT', ...body({ value }) }),
  },
  robota: {
    config: () => req<RobotaConfig>('/robota/config'),
    saveConfig: (cfg: { turbosms_token?: string; turbosms_sender?: string; calendly_url?: string; auto_outreach?: string; outreach_score_threshold?: number | string; followup_days?: number | string }) =>
      req<{ success: boolean }>('/robota/config', { method: 'POST', ...body(cfg) }),
    auth: (email: string, password: string) =>
      req<{ success: boolean }>('/robota/auth', { method: 'POST', ...body({ email, password }) }),
    disconnect: () =>
      req<{ success: boolean }>('/robota/disconnect', { method: 'POST' }),
    smtpConfig: (cfg: SmtpConfig) =>
      req<{ success: boolean }>('/robota/smtp-config', { method: 'POST', ...body(cfg) }),
    smtpDisconnect: () =>
      req<{ success: boolean }>('/robota/smtp-disconnect', { method: 'POST' }),
    sync: (jobId: number, params: { robota_vacancy_id?: number; auto_qualify?: boolean }) =>
      req<{ imported: number; outreached: number }>(`/robota/sync/${jobId}`, { method: 'POST', ...body(params) }),
    outreach: (candidateId: number, isFollowUp?: boolean) =>
      req<{ smsSent: boolean; emailSent: boolean }>(`/robota/outreach/${candidateId}`, { method: 'POST', ...body({ is_follow_up: isFollowUp }) }),
    sendEmail: (candidateId: number, subject: string, emailBody: string) =>
      req<Candidate>(`/robota/send-email/${candidateId}`, { method: 'POST', ...body({ subject, body: emailBody }) }),
    publishVacancy: (jobId: number, params: { publish_type?: string; contact_email?: string; work_types?: string[]; employment_types?: string[] }) =>
      reqPublish(`/robota/publish-vacancy/${jobId}`, { method: 'POST', ...body(params) }),
    retryPublish: (jobId: number) =>
      reqPublish(`/robota/retry-publish/${jobId}`, { method: 'POST' }),
    myVacancies: () => req<VacancyStatus[]>('/robota/my-vacancies'),
    vacancyState: (robotaVacancyId: number, state: string) =>
      req<{ success: boolean; state: string }>(`/robota/vacancy-state/${robotaVacancyId}`, { method: 'POST', ...body({ state }) }),
    updateVacancy: (jobId: number) =>
      req<{ success: boolean; robota_vacancy_id: number }>(`/robota/vacancy/${jobId}`, { method: 'PUT' }),
    deleteVacancy: (robotaVacancyId: number) =>
      req<{ success: boolean }>(`/robota/vacancy/${robotaVacancyId}`, { method: 'DELETE' }),
    employerVacancies: () => req<EmployerVacancy[]>('/robota/employer-vacancies'),
    fullSync: () => req<{ started: boolean }>('/robota/full-sync', { method: 'POST' }),
    fullSyncStatus: () => req<FullSyncProgress>('/robota/full-sync/status'),
    cvdbSearch: (params: { keywords: string; cityId?: number; salaryFrom?: number; salaryTo?: number; experienceId?: number; page?: number; count?: number; jobId?: number }) =>
      req<{ candidates: Candidate[]; total: number }>('/robota/cvdb/search', { method: 'POST', ...body(params) }),
    credits: () => req<CreditsInfo>('/robota/credits'),
    openCv: (resumeId: number, jobId?: number) =>
      req<Candidate>(`/robota/cvdb/open/${resumeId}`, { method: 'POST', ...body({ jobId }) }),
  },
  salary: {
    analyze: (params: { keywords: string; cityId?: number; experienceId?: number; maxRecords?: number; activeWithinDays?: number }) =>
      req<SalaryAnalysis>('/salary/analyze', { method: 'POST', ...body(params) }),
    forJob: (jobId: number) =>
      req<{ analysis: SalaryAnalysis; meta: SalaryCacheMeta } | null>(`/salary/job/${jobId}`),
    refreshJob: (jobId: number, keywords?: string) =>
      req<{ analysis: SalaryAnalysis; meta: SalaryCacheMeta }>(`/salary/job/${jobId}/refresh`, { method: 'POST', ...body({ keywords }) }),
    jobsSummary: () => req<SalaryJobSummary[]>('/salary/jobs-summary'),
  },
}

// ─── Messaging (WhatsApp / Telegram / Viber) ─────────────────────────────
export const messagingApi = {
  status: () => req<MessagingStatus>('/messaging/status'),

  whatsapp: {
    connect: (params: { accountSid: string; authToken: string; fromNumber: string }) =>
      req<{ ok: boolean }>('/messaging/whatsapp/connect', { method: 'POST', ...body(params) }),
    testSend: (to: string, text: string) =>
      req<{ ok: boolean; sid?: string }>('/messaging/whatsapp/test-send', { method: 'POST', ...body({ to, body: text }) }),
    disconnect: () => req<{ ok: boolean }>('/messaging/whatsapp/disconnect', { method: 'POST' }),
  },
  viber: {
    connect: (params: { token: string; senderName: string }) =>
      req<{ ok: boolean }>('/messaging/viber/connect', { method: 'POST', ...body(params) }),
    testSend: (to: string, text: string) =>
      req<{ ok: boolean }>('/messaging/viber/test-send', { method: 'POST', ...body({ to, body: text }) }),
    disconnect: () => req<{ ok: boolean }>('/messaging/viber/disconnect', { method: 'POST' }),
  },
  telegram: {
    creds: () => req<{ apiId: number; apiHash: string; phone: string } | null>('/messaging/telegram/creds'),
    start: (params: { apiId: number; apiHash: string; phone: string }) =>
      req<{ ok: boolean; message?: string }>('/messaging/telegram/start', { method: 'POST', ...body(params) }),
    code: (code: string) =>
      req<{ ok?: boolean; needsPassword?: boolean; identity?: { username?: string; firstName?: string } }>(
        '/messaging/telegram/code', { method: 'POST', ...body({ code }) }),
    password: (password: string) =>
      req<{ ok: boolean; identity?: { username?: string; firstName?: string } }>(
        '/messaging/telegram/password', { method: 'POST', ...body({ password }) }),
    testSend: (to: string, text: string) =>
      req<{ ok: boolean; messageId?: number }>('/messaging/telegram/test-send', { method: 'POST', ...body({ to, body: text }) }),
    disconnect: () => req<{ ok: boolean }>('/messaging/telegram/disconnect', { method: 'POST' }),
    reload: () => req<{ connected: boolean }>('/messaging/telegram/reload', { method: 'POST' }),
  },

  send: (candidateId: number, params: { message: string; ctaUrl?: string; channels: ('telegram'|'whatsapp'|'viber'|'email')[]; stopOnFirstSuccess?: boolean }) =>
    req<Array<{ channel: string; ok: boolean; id?: string; error?: string }>>(`/messaging/send/${candidateId}`, { method: 'POST', ...body(params) }),
}

// ─── Calendar / Calendly ─────────────────────────────────────────────────
export const calendarApi = {
  status: () => req<{ connected: boolean; calendlyUrl: string }>('/calendar/status'),
  connect: (token: string) =>
    req<{ ok: boolean; name?: string }>('/calendar/connect', { method: 'POST', ...body({ token }) }),
  disconnect: () => req<{ ok: boolean }>('/calendar/disconnect', { method: 'POST' }),
  sync: () => req<{ ok: boolean }>('/calendar/sync', { method: 'POST' }),
}

// ─── Telegram recruiting bot ─────────────────────────────────────────────
export const telegramApi = {
  settings: () => req<TgBotSettings>('/telegram/settings'),
  saveSettings: (s: Partial<Pick<TgBotSettings, 'mode' | 'calendlyUrl'>>) =>
    req<TgBotSettings>('/telegram/settings', { method: 'POST', ...body(s) }),
  conversations: () => req<TgConversation[]>('/telegram/conversations'),
  conversation: (id: number) =>
    req<{ conversation: TgConversationDetail; messages: TgMessage[]; peerState: TgPeerState | null }>(`/telegram/conversations/${id}`),
  send: (id: number, text: string) =>
    req<{ ok: boolean }>(`/telegram/conversations/${id}/send`, { method: 'POST', ...body({ text }) }),
  regenerate: (id: number) =>
    req<{ ok: boolean }>(`/telegram/conversations/${id}/draft`, { method: 'POST' }),
  remove: (id: number) =>
    req<{ ok: boolean }>(`/telegram/conversations/${id}`, { method: 'DELETE' }),
  discardDraft: (msgId: number) =>
    req<{ ok: boolean }>(`/telegram/messages/${msgId}/discard`, { method: 'POST' }),
  deleteMessage: (msgId: number) =>
    req<{ ok: boolean }>(`/telegram/messages/${msgId}`, { method: 'DELETE' }),
  knowledge: () => req<{ text: string }>('/telegram/knowledge'),
  saveKnowledge: (text: string) =>
    req<{ text: string }>('/telegram/knowledge', { method: 'POST', ...body({ text }) }),
  syncDialogs: () => req<{ started: boolean }>('/telegram/sync-dialogs', { method: 'POST' }),
  syncStatus: () => req<DialogSyncProgress>('/telegram/sync-dialogs/status'),
}

export interface DialogSyncProgress {
  status: 'idle' | 'running' | 'done' | 'error'
  total: number
  done: number
  newConversations: number
  error?: string
}

export interface TgBotSettings {
  mode: 'review' | 'auto'
  calendlyUrl: string
  connected?: boolean
}

export interface TgConversation {
  id: number
  candidate_id: number | null
  job_id: number | null
  status: string
  bot_enabled: number
  turn_count: number
  created_at: string
  updated_at: string
  candidate_name: string | null
  candidate_full_name: string | null
  candidate_role: string | null
  candidate_photo: string | null
  peer_name: string | null
  unread: number
  job_title: string | null
  last_text: string | null
  last_direction: 'in' | 'out' | null
  last_at: string | null
  draft_count: number
}

export interface TgConversationDetail extends TgConversation {
  peer_id: string | null
  peer_phone: string | null
  candidate_phone: string | null
  last_seen_message_id: number
}

export interface TgPeerState {
  presence: 'online' | 'recently' | 'within_week' | 'within_month' | 'offline' | 'unknown'
  lastSeen?: number
  readOutboxMaxId: number
}

export interface TgMessage {
  id: number
  direction: 'in' | 'out'
  sender: 'candidate' | 'bot' | 'alena'
  text: string
  status: 'sent' | 'pending_review' | 'discarded'
  tg_message_id: number | null
  created_at: string
}

export interface MessagingStatus {
  whatsapp: { configured: boolean; connected?: boolean; identity?: string; error?: string }
  viber:    { configured: boolean; connected?: boolean; identity?: string; error?: string }
  telegram: { configured: boolean; connected?: boolean; identity?: string; error?: string }
  email:    { configured: boolean; connected?: boolean; identity?: string; error?: string }
}

export interface CreditsInfo {
  available: number
  totalAllocated: number
  totalUsed: number
  expiresAt: string | null
  packs: Array<{ name: string; allocated: number; used: number; expiresAt: string | null }>
}

// Shared types
export interface Job {
  id: number
  title: string
  location: string
  salary_min: number
  salary_max: number
  salary_currency: string
  experience_years: number
  skills: string
  description: string
  requirements: string
  is_active: number
  created_at: string
  updated_at: string
  // Robota.ua-aligned fields
  robota_vacancy_id?: number | null
  city_id?: number | null
  experience_id?: number
  education_id?: number
  schedule_id?: number
  employment_types?: string
  work_types?: string
  branch_ids?: string
  publish_type?: string
  contact_person?: string | null
  contact_email?: string | null
  languages?: string
  robota_state?: string | null
  robota_error?: string | null
}

export interface Candidate {
  id: number
  job_id: number | null
  initials: string
  full_name: string | null
  photo_url: string | null
  birth_date: string | null
  role: string
  location: string
  experience_years: number
  experience_text: string
  salary_expectation: number
  source_platform: string
  profile_url: string
  tags: string
  profile_data: string | null
  status: 'new' | 'viewed' | 'contacted' | 'rejected'
  source_type: 'scraped' | 'upload'
  stage: 'new' | 'interview' | 'decision'
  qualification_score: number | null
  qualification_notes: string | null
  cv_filename: string | null
  cv_text: string | null
  rejection_reason: string | null
  decision: 'pending' | 'hire' | 'reject' | null
  robota_apply_id: string | null
  email: string | null
  phone: string | null
  outreach_count: number
  viewed_at: string | null
  contacted_at: string | null
  created_at: string
}

export interface RobotaConfig {
  robota_configured: boolean
  smtp_configured: boolean
  turbosms_configured: boolean
  calendly_configured: boolean
  auto_outreach: boolean
  robota_email: string | null
  smtp_from: string | null
  calendly_url: string | null
  outreach_score_threshold: number
  followup_days: number
  last_auto_sync: string | null
}

export interface SmtpConfig {
  host?: string
  port?: string
  user?: string
  pass?: string
  from?: string
}

export interface Interview {
  id: number
  candidate_id: number
  job_id: number | null
  scheduled_at: string
  type: 'phone' | 'video' | 'on-site'
  interviewer: string
  notes: string
  decision: 'pending' | 'hire' | 'reject'
  created_at: string
  updated_at: string
  calendly_event_uri?: string | null
  // Joined fields
  initials?: string
  full_name?: string | null
  role?: string
  source_platform?: string
  job_title?: string
}

export interface Message {
  id: number
  job_id: number | null
  name: string
  subject: string
  body: string
  language: string
  ai_generated: number
  created_at: string
  updated_at: string
}

export interface SearchParams {
  query: string
  location: string
  count: number
  platforms: string[]
  jobId?: number
  salaryMin?: number
  salaryMax?: number
  experienceMin?: number
  skills?: string
}

export interface KPIs {
  totalSearches: number
  weekSearches: number
  totalViewed: number
  todayViewed: number
  totalContacted: number
  contactRate: number
  activeJobs: number
  applicantsCount: number
  sourcedCount: number
  rejectedCount: number
  avgDaysToFill: number | null
  byJob: { title: string; count: number; applicants: number; sourced: number; rejected: number }[]
}

export interface SourceStat { source: string; count: number; percent: number }
export interface RejectionStat { reason: string | null; count: number }

export interface WeeklyData {
  week: string
  week_start: string
  count: number
}

export interface RecentEvent {
  id: number
  type: string
  candidate_id: number | null
  job_id: number | null
  metadata: string
  created_at: string
  initials: string | null
  role: string | null
  source_platform: string | null
  job_title: string | null
}

export interface SearchHistory {
  id: number
  job_id: number | null
  job_title: string | null
  location: string
  platforms: string
  candidates_found: number
  created_at: string
}

export interface VacancyStatus {
  id: number
  title: string
  location: string
  robota_vacancy_id: number
  robota_status: string | null
  robota_name?: string
  error?: string
}

export interface EmployerVacancy {
  id: number
  name: string
  state: string
  cityName?: string
  salaryRange?: { amountFrom?: number; amountTo?: number }
  linked: boolean
  farmasoft_job_id: number | null
  farmasoft_job_title: string | null
}

export interface FullSyncProgress {
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

export interface CandidateMessageEvent {
  id: number
  metadata: string
  created_at: string
}

export interface SalaryCacheMeta {
  computed_at: string
  keywords_used: string
  sample_size: number
  ageHours: number
  stale: boolean
}

export interface SalaryJobSummary {
  job_id: number
  title: string
  is_active: boolean
  sample_size: number | null
  computed_at: string | null
  median: number | null
  p25: number | null
  p75: number | null
  keywords: string | null
}

export interface SalaryStats {
  count: number
  min: number
  max: number
  median: number
  p25: number
  p75: number
  mean: number
}

export interface SalaryAnalysis {
  query: { keywords: string; cityId?: number; experienceId?: number; maxRecords: number; activeWithinDays: number }
  collection: {
    totalAvailableOnRobota: number
    collected: number
    activeCvs: number
    discardedInactive: number
    withoutDeclaredSalary: number
    withDeclaredSalary: number
    sanityRejected: number
    outliersRemoved: number
    finalSampleSize: number
    sanityBounds: { floor: number; ceiling: number }
    iqrBounds: { lower: number; upper: number }
  }
  overall: SalaryStats
  byLevel: Record<string, SalaryStats>
  byCity: Record<string, SalaryStats>
  byAgeBand: Record<string, SalaryStats>
  bySex: Record<string, SalaryStats>
}
