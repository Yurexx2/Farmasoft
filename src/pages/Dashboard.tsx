import { useEffect, useState } from 'react'
import { api, KPIs, Interview, SourceStat, RejectionStat } from '../api/client'
import { useAppStore } from '../store/useAppStore'
import { T } from '../i18n'
import { useIsMobile } from '../hooks/useIsMobile'

function isToday(s: string) {
  const d = new Date(s), n = new Date()
  return d.getDate() === n.getDate() && d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear()
}
function isUpcoming(s: string) { return new Date(s) >= new Date() }

function KpiCard({ value, label, sub, subColor }: {
  value: string | number; label: string; sub: string; subColor?: string
}) {
  return (
    <div style={{
      background: 'var(--surface)', borderRadius: 16, padding: '22px 22px 20px',
      boxShadow: 'var(--shadow)',
    }}>
      <div style={{ fontSize: 36, fontWeight: 600, letterSpacing: '-0.04em', lineHeight: 1, marginBottom: 8 }}>
        {value}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-2)', fontWeight: 500, marginBottom: 12 }}>{label}</div>
      {sub && (
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px',
          borderRadius: 20, fontSize: 11, fontWeight: 500,
          background: subColor ? subColor + '14' : 'var(--surface-2)',
          color: subColor || 'var(--text-3)',
        }}>{sub}</div>
      )}
    </div>
  )
}

// Horizontal-bar list used for "Candidate sources" and "Rejection reasons".
function StatList({ title, items, empty, accent }: {
  title: string
  items: { label: string; count: number; percent?: number }[]
  empty: string
  accent: string
}) {
  const max = items.reduce((m, it) => Math.max(m, it.count), 0) || 1
  return (
    <div style={{ background: 'var(--surface)', borderRadius: 16, padding: '22px 24px', boxShadow: 'var(--shadow)' }}>
      <div style={{ fontWeight: 600, fontSize: 14, paddingBottom: 14, borderBottom: '1px solid var(--border)', marginBottom: 14 }}>
        {title}
      </div>
      {items.length === 0 ? (
        <div style={{ padding: '8px 0', color: 'var(--text-3)', fontSize: 12, textAlign: 'center' }}>{empty}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map((it, i) => (
            <div key={i}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>{it.label}</span>
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                  <strong style={{ color: 'var(--text-2)' }}>{it.count}</strong>
                  {it.percent != null && ` · ${it.percent}%`}
                </span>
              </div>
              <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ width: `${(it.count / max) * 100}%`, height: '100%', background: accent, transition: 'width 200ms' }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function Dashboard() {
  const { setPage, uiLang } = useAppStore()
  const isMobile = useIsMobile()
  const t = T[uiLang]
  const d = t.dashboard
  const k = d.kpi

  const [kpis, setKpis] = useState<KPIs | null>(null)
  const [interviews, setInterviews] = useState<Interview[]>([])
  const [pendingCVs, setPendingCVs] = useState(0)
  const [sources, setSources] = useState<SourceStat[]>([])
  const [rejections, setRejections] = useState<RejectionStat[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      api.analytics.kpis(),
      api.interviews.list(),
      api.candidates.list(),
      api.analytics.sources(),
      api.analytics.rejections(),
    ]).then(([kp, iv, cands, src, rej]) => {
      if (kp.data) setKpis(kp.data)
      if (iv.data) {
        const upcoming = iv.data.filter(i => isUpcoming(i.scheduled_at))
          .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime())
        setInterviews(upcoming)
      }
      if (cands.data) {
        setPendingCVs(cands.data.filter(c => c.source_type === 'upload' && c.stage === 'new').length)
      }
      if (src.data) setSources(src.data)
      if (rej.data) setRejections(rej.data)
      setLoading(false)
    })
  }, [])

  const todayInterviews = interviews.filter(i => isToday(i.scheduled_at))
  const nextInterviews  = interviews.filter(i => !isToday(i.scheduled_at)).slice(0, 5)

  const activeJobs   = kpis?.activeJobs ?? 0
  const applicants   = kpis?.applicantsCount ?? 0
  const sourced      = kpis?.sourcedCount ?? 0
  const avgDays      = kpis?.avgDaysToFill ?? null

  const dateLabel = new Date().toLocaleDateString(t.locale, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })

  const typeLabel: Record<string, string> = {
    phone: t.interviewTypes.phone,
    video: t.interviewTypes.video,
    'on-site': t.interviewTypes['on-site'],
  }

  if (loading) {
    return (
      <div className="page" style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 100 }}>
        <span className="spinner" /><span className="c-2">{d.loading}</span>
      </div>
    )
  }

  const allGood = pendingCVs === 0 && todayInterviews.length === 0

  return (
    <div style={{
      padding: isMobile ? '16px 16px 24px' : '28px 52px 28px', maxWidth: 1100, margin: '0 auto',
      minHeight: '100%', boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column',
      overflow: 'auto',
    }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, flexShrink: 0 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.025em' }}>{d.title}</h1>
          <p style={{ color: 'var(--text-2)', marginTop: 5, fontSize: 13, textTransform: 'capitalize' }}>{dateLabel}</p>
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '9px 18px',
          background: 'var(--surface)', borderRadius: 100, boxShadow: 'var(--shadow-sm)',
          border: '1px solid var(--border)',
        }}>
          <div style={{
            width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
            background: allGood ? 'var(--ok)' : 'var(--warn)',
          }} />
          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-1)', whiteSpace: 'nowrap' }}>
            {allGood
              ? d.allGood
              : [
                  todayInterviews.length > 0 && d.interviewsToday(todayInterviews.length),
                  pendingCVs > 0 && d.cvsToReview(pendingCVs),
                ].filter(Boolean).join(' · ')
            }
          </span>
        </div>
      </div>

      {/* ── KPI row ── */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2,1fr)' : 'repeat(4,1fr)', gap: isMobile ? 10 : 14, marginBottom: 16, flexShrink: 0 }}>
        <KpiCard
          value={activeJobs} label={k.activeJobs}
          sub={activeJobs > 0 ? k.active : k.noJob}
          subColor={activeJobs > 0 ? 'var(--ok)' : undefined}
        />
        <KpiCard
          value={applicants} label={k.applicants}
          sub={k.viaRobota}
          subColor={applicants > 0 ? 'var(--accent)' : undefined}
        />
        <KpiCard
          value={sourced} label={k.sourced}
          sub={k.handPicked}
          subColor={sourced > 0 ? '#2563EB' : undefined}
        />
        <KpiCard
          value={avgDays != null ? `${avgDays} ${k.days}` : '—'} label={k.timeToFill}
          sub={avgDays != null ? '' : k.notEnoughData}
          subColor={avgDays != null ? 'var(--ok)' : undefined}
        />
      </div>

      {/* ── Sources + Rejections ── */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 14, marginBottom: 16 }}>
        <StatList title={d.sources} items={sources.map(s => ({ label: s.source, count: s.count, percent: s.percent }))} empty={d.noSources} accent="var(--accent)" />
        <StatList title={d.rejections} items={rejections.map(r => ({ label: r.reason || d.noRejectionReason, count: r.count }))} empty={d.noRejections} accent="var(--err)" />
      </div>

      {/* ── Middle row ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? '1fr' : '1fr 280px',
        gap: 14,
        flex: isMobile ? 'none' : 1,
        minHeight: 0,
      }}>

        {/* Today's interviews */}
        <div style={{ background: 'var(--surface)', borderRadius: 16, padding: '22px 26px', boxShadow: 'var(--shadow)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 16, borderBottom: '1px solid var(--border)', marginBottom: 20 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{d.todayInterviews}</span>
            <button onClick={() => setPage('calendar')} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 12, color: 'var(--accent)', fontWeight: 500,
            }}>
              {d.viewAll}
            </button>
          </div>

          {todayInterviews.length === 0 ? (
            <div style={{ padding: '28px 0', textAlign: 'center', color: 'var(--text-3)' }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 10, opacity: 0.4 }}>
                <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
              </svg>
              <p style={{ fontSize: 13, color: 'var(--text-2)' }}>{d.noTodayInterviews}</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {todayInterviews.map(iv => (
                <div key={iv.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: 'var(--surface-2)', borderRadius: 12 }}>
                  <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, flexShrink: 0 }}>
                    {iv.initials || '?'}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{iv.role || 'Candidate'}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>
                      {new Date(iv.scheduled_at).toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit' })} · {typeLabel[iv.type] || iv.type}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {nextInterviews.length > 0 && (
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>{d.upcoming}</div>
              {nextInterviews.map(iv => (
                <div key={iv.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} />
                    <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>{iv.role || iv.initials}</span>
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--text-3)', flexShrink: 0, marginLeft: 8 }}>
                    {new Date(iv.scheduled_at).toLocaleDateString(t.locale, { weekday: 'short', day: 'numeric', month: 'short' })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Candidates per position */}
        <div style={{ background: 'var(--surface)', borderRadius: 16, padding: '22px 22px', boxShadow: 'var(--shadow)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontWeight: 600, fontSize: 14, paddingBottom: 16, borderBottom: '1px solid var(--border)', marginBottom: 16 }}>
            {d.candidatesPerJob}
          </div>

          {kpis?.byJob && kpis.byJob.length > 0 ? (
            <div style={{ flex: 1 }}>
              {kpis.byJob.slice(0, 5).map(row => (
                <div key={row.title} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>{row.title}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', flexShrink: 0 }}>{row.count}</span>
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 3, display: 'flex', gap: 8 }}>
                    <span><strong style={{ color: 'var(--accent)' }}>{row.applicants}</strong> {d.perJobApplicants}</span>
                    <span><strong style={{ color: 'var(--text-2)' }}>{row.sourced}</strong> {d.perJobSourced}</span>
                    {row.rejected > 0 && (
                      <span><strong style={{ color: 'var(--err)' }}>{row.rejected}</strong> {d.perJobRejected}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', textAlign: 'center', padding: '16px 0' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 8, opacity: 0.35 }}>
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
              </svg>
              <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-2)' }}>{d.createPositions}</p>
            </div>
          )}

          <button onClick={() => setPage('jobs')} style={{
            marginTop: 16, width: '100%',
            background: 'var(--text-1)', color: '#fff',
            border: 'none', borderRadius: 12, padding: '12px 0',
            fontSize: 13, fontWeight: 600, cursor: 'pointer', transition: 'opacity 150ms',
          }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.78')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
            {d.managePositions}
          </button>
        </div>
      </div>

    </div>
  )
}
