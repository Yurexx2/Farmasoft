import axios from 'axios'
import https from 'https'

// Calendly API v2 client — authenticated with a Personal Access Token.
const API = 'https://api.calendly.com'
// Some corporate networks intercept TLS — accept the chain (same as lib/llm.ts).
const httpsAgent = new https.Agent({ rejectUnauthorized: false })

export interface CalendlyEvent {
  uri: string
  name: string
  start: string          // ISO 8601
  end: string
  status: string         // 'active' | 'canceled'
  inviteeName?: string
  inviteeEmail?: string
}

/** Verify a token and return the account name. */
export async function calendlyTest(token: string): Promise<{ ok: boolean; name?: string; error?: string }> {
  try {
    const { data } = await axios.get(`${API}/users/me`, {
      headers: { Authorization: `Bearer ${token}` }, httpsAgent, timeout: 15000,
    })
    return { ok: true, name: data?.resource?.name }
  } catch (e: unknown) {
    const status = (e as { response?: { status: number } }).response?.status
    if (status === 401) return { ok: false, error: 'Clé API Calendly invalide' }
    return { ok: false, error: (e as Error).message }
  }
}

/** List the account's scheduled events in a time window, with invitee details. */
export async function calendlyListEvents(
  token: string, fromIso: string, toIso: string,
): Promise<CalendlyEvent[]> {
  const headers = { Authorization: `Bearer ${token}` }
  const { data: me } = await axios.get(`${API}/users/me`, { headers, httpsAgent, timeout: 15000 })
  const userUri = me?.resource?.uri as string | undefined
  if (!userUri) return []

  const { data } = await axios.get(`${API}/scheduled_events`, {
    headers, httpsAgent, timeout: 20000,
    params: {
      user: userUri,
      min_start_time: fromIso,
      max_start_time: toIso,
      count: 100,
      sort: 'start_time:asc',
    },
  })
  const events = (data?.collection ?? []) as Array<{
    uri: string; name: string; start_time: string; end_time: string; status: string
  }>

  const out: CalendlyEvent[] = []
  for (const ev of events) {
    let inviteeName: string | undefined
    let inviteeEmail: string | undefined
    try {
      const { data: inv } = await axios.get(`${ev.uri}/invitees`, { headers, httpsAgent, timeout: 15000 })
      const first = inv?.collection?.[0] as { name?: string; email?: string } | undefined
      if (first) { inviteeName = first.name; inviteeEmail = first.email }
    } catch { /* invitee lookup failed — keep the event anyway */ }
    out.push({
      uri: ev.uri, name: ev.name,
      start: ev.start_time, end: ev.end_time, status: ev.status,
      inviteeName, inviteeEmail,
    })
  }
  return out
}
