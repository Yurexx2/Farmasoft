import { useEffect, useState, useCallback } from 'react'
import { api, calendarApi, Interview } from '../api/client'
import { useAppStore } from '../store/useAppStore'
import { T } from '../i18n'

// Working-hours grid: rows 09:00 → 18:00.
const START_HOUR = 9
const END_HOUR = 18
const ROW_H = 58 // px per hour

function mondayOf(weekOffset: number): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  const dow = (d.getDay() + 6) % 7 // 0 = Monday
  d.setDate(d.getDate() - dow + weekOffset * 7)
  return d
}
function addDays(base: Date, n: number): Date {
  const d = new Date(base)
  d.setDate(d.getDate() + n)
  return d
}
function parseDate(s: string): Date {
  return new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z')
}
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()

export function CalendarPage() {
  const { uiLang } = useAppStore()
  const t = T[uiLang].calendar
  const locale = T[uiLang].locale

  const [interviews, setInterviews] = useState<Interview[]>([])
  const [weekOffset, setWeekOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [connected, setConnected] = useState(false)
  const [syncing, setSyncing] = useState(false)

  const load = useCallback(async () => {
    const r = await api.interviews.list()
    if (r.data) setInterviews(r.data)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    calendarApi.status().then(r => { if (r.data) setConnected(r.data.connected) })
  }, [load])

  async function sync() {
    setSyncing(true)
    await calendarApi.sync()
    await load()
    setSyncing(false)
  }

  const weekStart = mondayOf(weekOffset)
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  const hours = Array.from({ length: END_HOUR - START_HOUR }, (_, i) => START_HOUR + i)
  const today = new Date()

  // Events of the displayed week, grouped per day.
  const weekEnd = addDays(weekStart, 7)
  const weekEvents = interviews
    .map(iv => ({ iv, date: parseDate(iv.scheduled_at) }))
    .filter(e => e.date >= weekStart && e.date < weekEnd)

  const weekLabel = `${weekStart.toLocaleDateString(locale, { day: '2-digit', month: 'short' })} – ${addDays(weekStart, 6).toLocaleDateString(locale, { day: '2-digit', month: 'short' })}`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* header */}
      <div style={{ padding: '20px 24px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: -0.3 }}>{t.title}</h1>
            <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-3)' }}>{t.desc}</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setWeekOffset(w => w - 1)}>←</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setWeekOffset(0)}>{t.today}</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setWeekOffset(w => w + 1)}>→</button>
            <span style={{ fontSize: 12.5, color: 'var(--text-2)', fontWeight: 600, minWidth: 130, textAlign: 'center' }}>{weekLabel}</span>
            {connected && (
              <button className="btn btn-ghost btn-sm" disabled={syncing} onClick={sync}>
                {syncing ? `⏳ ${t.syncing}` : `🔄 ${t.sync}`}
              </button>
            )}
          </div>
        </div>
        {!connected && (
          <div style={{
            marginTop: 10, padding: '9px 14px', borderRadius: 9, fontSize: 12.5,
            background: '#FEF3C7', border: '1px solid #FDE68A', color: '#92400E',
          }}>{t.notConnected}</div>
        )}
      </div>

      {/* week grid */}
      <div style={{ flex: 1, overflow: 'auto', padding: '0 24px 24px' }}>
        {loading ? (
          <div style={{ padding: 32, color: 'var(--text-3)', fontSize: 13 }}>{T[uiLang].dashboard.loading}</div>
        ) : (
          <div style={{ display: 'flex', minWidth: 720 }}>
            {/* hour gutter */}
            <div style={{ width: 48, flexShrink: 0, paddingTop: 44 }}>
              {hours.map(h => (
                <div key={h} style={{ height: ROW_H, fontSize: 10.5, color: 'var(--text-3)', textAlign: 'right', paddingRight: 6, transform: 'translateY(-6px)' }}>
                  {String(h).padStart(2, '0')}:00
                </div>
              ))}
            </div>
            {/* day columns */}
            {days.map((day, di) => {
              const isToday = sameDay(day, today)
              const dayEvents = weekEvents.filter(e => sameDay(e.date, day))
              return (
                <div key={di} style={{ flex: 1, minWidth: 92, borderLeft: '1px solid var(--border)' }}>
                  {/* day header */}
                  <div style={{
                    height: 44, display: 'flex', flexDirection: 'column', alignItems: 'center',
                    justifyContent: 'center', borderBottom: '1px solid var(--border)',
                    background: isToday ? 'rgba(34,139,86,0.08)' : 'transparent',
                  }}>
                    <span style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'capitalize' }}>
                      {day.toLocaleDateString(locale, { weekday: 'short' })}
                    </span>
                    <span style={{ fontSize: 15, fontWeight: 700, color: isToday ? 'var(--accent)' : 'var(--text-1)' }}>
                      {day.getDate()}
                    </span>
                  </div>
                  {/* hour cells + events */}
                  <div style={{ position: 'relative', background: isToday ? 'rgba(34,139,86,0.04)' : 'transparent' }}>
                    {hours.map(h => (
                      <div key={h} style={{ height: ROW_H, borderBottom: '1px solid var(--border)' }} />
                    ))}
                    {dayEvents.map(({ iv, date }) => {
                      const hour = date.getHours() + date.getMinutes() / 60
                      const top = Math.max(0, Math.min(hours.length - 0.75, hour - START_HOUR)) * ROW_H
                      const fromCalendly = !!iv.calendly_event_uri
                      const who = iv.full_name || iv.role || (iv.notes || '').replace(/^Calendly — /, '') || '—'
                      return (
                        <div key={iv.id} title={`${who} · ${iv.job_title || ''}`} style={{
                          position: 'absolute', top, left: 3, right: 3, minHeight: ROW_H * 0.82,
                          background: fromCalendly ? '#229ED9' : 'var(--accent)', color: '#fff',
                          borderRadius: 7, padding: '4px 7px', fontSize: 11, lineHeight: 1.3,
                          boxShadow: '0 1px 3px rgba(0,0,0,0.15)', overflow: 'hidden',
                        }}>
                          <div style={{ fontWeight: 700 }}>
                            {date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
                          </div>
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{who}</div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {!loading && weekEvents.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>{t.noEvents}</div>
        )}
      </div>
    </div>
  )
}
