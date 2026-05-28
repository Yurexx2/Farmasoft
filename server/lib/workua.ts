import axios, { AxiosError, AxiosRequestConfig } from 'axios'
import https from 'https'

// Work.ua API v1 client — HTTP Basic Auth (login + password), REST + JSON,
// rate-limit 50 req/sec. Some endpoints want application/x-www-form-urlencoded
// with PHP-style nested keys (category[][id]=1).
const API = 'https://api.work.ua'
const httpsAgent = new https.Agent({ rejectUnauthorized: false })

export interface WorkuaCreds { login: string; password: string }

function authConfig(creds: WorkuaCreds, extra: AxiosRequestConfig = {}): AxiosRequestConfig {
  return {
    auth: { username: creds.login, password: creds.password },
    headers: {
      'User-Agent': `Farmasoft (${creds.login})`,
      'X-Locale': 'uk_UA',
      ...(extra.headers || {}),
    },
    httpsAgent,
    timeout: 20000,
    ...extra,
  }
}

// PHP-style flattener: { category: [{id:1},{id:2}], languages:[{languageId:41,levelId:22836}] }
// → category[0][id]=1&category[1][id]=2&languages[0][languageId]=41&languages[0][levelId]=22836
export function urlEncodeNested(obj: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue
    const key = prefix ? `${prefix}[${k}]` : k
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        const subKey = `${key}[${i}]`
        if (item != null && typeof item === 'object') {
          parts.push(urlEncodeNested(item as Record<string, unknown>, subKey))
        } else {
          parts.push(`${encodeURIComponent(subKey)}=${encodeURIComponent(String(item))}`)
        }
      })
    } else if (typeof v === 'object') {
      parts.push(urlEncodeNested(v as Record<string, unknown>, key))
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`)
    }
  }
  return parts.filter(Boolean).join('&')
}

function explain(e: unknown): string {
  const err = e as AxiosError<{ status?: string; errors?: Array<{ id: string; message: string }> }>
  const status = err.response?.status
  if (status === 401) return 'Login ou mot de passe Work.ua invalide'
  if (status === 403) return 'Compte Work.ua bloqué'
  if (status === 429) return 'Work.ua : trop de requêtes, ressayez dans 1 min'
  const errs = err.response?.data?.errors
  if (Array.isArray(errs) && errs.length) return errs.map(x => x.message).join(' ; ')
  return (e as Error).message
}

// ─── Auth / connection test ──────────────────────────────────────────────────
export async function workuaTest(creds: WorkuaCreds): Promise<{ ok: boolean; error?: string }> {
  try {
    await axios.get(`${API}/jobs/my`, authConfig(creds))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: explain(e) }
  }
}

// ─── Dictionaries (one fetch, then cached by the caller) ─────────────────────
export interface DictItem { id: number; name: string }
export type WorkuaDicts = Record<string, DictItem[]>

export async function workuaDictionaries(creds: WorkuaCreds): Promise<WorkuaDicts | null> {
  try {
    const { data } = await axios.get(`${API}/dictionaries`, authConfig(creds))
    return data as WorkuaDicts
  } catch (e) {
    console.error('[workua dictionaries]', explain(e))
    return null
  }
}

// ─── Publications quota ──────────────────────────────────────────────────────
export interface AvailablePublication { id: string; total: number }

export async function workuaAvailablePublications(creds: WorkuaCreds): Promise<AvailablePublication[]> {
  try {
    const { data } = await axios.get(`${API}/available-publications`, authConfig(creds))
    return Array.isArray(data) ? data : []
  } catch (e) {
    console.error('[workua publications]', explain(e))
    return []
  }
}

// ─── Job CRUD ────────────────────────────────────────────────────────────────
export async function workuaCreateJob(
  creds: WorkuaCreds, payload: Record<string, unknown>,
): Promise<{ ok: true; jobId: number | null } | { ok: false; error: string }> {
  try {
    const body = urlEncodeNested(payload)
    const res = await axios.post(`${API}/jobs`, body, authConfig(creds, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }))
    // 201 Created with Location: /jobs/<id>
    const loc = res.headers?.location || ''
    const m = loc.match(/jobs\/(\d+)/)
    return { ok: true, jobId: m ? parseInt(m[1], 10) : null }
  } catch (e) {
    return { ok: false, error: explain(e) }
  }
}

export async function workuaUpdateJob(
  creds: WorkuaCreds, jobId: number, payload: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const body = urlEncodeNested(payload)
    await axios.put(`${API}/jobs/${jobId}`, body, authConfig(creds, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: explain(e) }
  }
}

export async function workuaCloseJob(
  creds: WorkuaCreds, jobId: number,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await axios.put(`${API}/jobs/${jobId}/close`, '', authConfig(creds, {
      headers: { 'Content-Length': '0' },
    }))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: explain(e) }
  }
}

export async function workuaDeleteJob(
  creds: WorkuaCreds, jobId: number,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await axios.delete(`${API}/jobs/${jobId}`, authConfig(creds))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: explain(e) }
  }
}

// ─── Employer's own vacancies ───────────────────────────────────────────────
// GET /jobs/my returns the authenticated employer's job list. Observed shape
// (May 2026): { status: "ok", items: [{ id: "10599" (string!), name, date,
// date_expire, region, active: 0|1, blocked: 0|1, publication }] }.
// There is no description/salary in the list and GET /jobs/{id} returns 501.
export interface WorkuaMyJob {
  id: string | number
  name?: string
  region?: number
  active?: number               // 1 = published, 0 = closed/expired
  blocked?: number
  date?: string
}

export async function workuaListMyJobs(creds: WorkuaCreds): Promise<WorkuaMyJob[]> {
  try {
    const { data } = await axios.get(`${API}/jobs/my`, authConfig(creds))
    const items = Array.isArray(data) ? data : (data?.items ?? data?.jobs ?? [])
    return items as WorkuaMyJob[]
  } catch (e) {
    console.error('[workua /jobs/my]', explain(e))
    return []
  }
}

// ─── Responses (incoming applications) ───────────────────────────────────────
export interface WorkuaResponse {
  id: number; job_id?: number; candidate_id?: number
  date: string; fio?: string; email?: string; phone?: string
  type?: 'resume' | 'file' | 'easy'; with_file?: number
  text?: string; cover?: string; photo?: string
}

export async function workuaListResponses(
  creds: WorkuaCreds,
  opts: { jobId?: number; lastId?: number; beforeId?: number; limit?: number } = {},
): Promise<{ items: WorkuaResponse[]; error?: string }> {
  try {
    const limit = Math.min(opts.limit ?? 50, 50)
    const path = opts.jobId ? `/jobs/${opts.jobId}/responses` : '/jobs/responses'
    const params: Record<string, unknown> = { limit }
    if (opts.lastId) params.last_id = opts.lastId        // incremental — id > lastId
    if (opts.beforeId) params.before_id = opts.beforeId  // historical — id < beforeId
    const { data } = await axios.get(`${API}${path}`, authConfig(creds, { params }))
    return { items: (data?.items ?? []) as WorkuaResponse[] }
  } catch (e) {
    const err = e as AxiosError
    if (err.response?.status === 404) return { items: [] }   // no more pages — normal
    return { items: [], error: explain(e) }
  }
}
