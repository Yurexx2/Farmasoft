import { useState } from 'react'
import { api, Candidate, Job, SalaryAnalysis } from '../../api/client'
import { iconStar, iconTrash } from './icons'
import { parseProfile } from './helpers'
import { computeSalaryBand, fmtFullUAH } from './salaryBand'
import { useAppStore } from '../../store/useAppStore'
import { T } from '../../i18n'

const STAGE_STRIPE: Record<string, string> = {
  new:        'var(--text-3)',
  interview:  '#D9780A',
  decision:   '#2E9460',
}

export function PipelineCard({ candidate, job: _job, salary, onDelete, onClick, onUpdate }: {
  candidate: Candidate
  job: Job
  salary?: SalaryAnalysis
  onDelete: (id: number) => void
  onClick: () => void
  onStageAdvance?: (id: number, newStage: string) => void
  onUpdate?: (c: Candidate) => void
}) {
  const profile = parseProfile(candidate.profile_data)
  const band = computeSalaryBand(candidate.salary_expectation, salary)
  const { uiLang } = useAppStore()
  const ts = T[uiLang].salary
  const [showNotes, setShowNotes] = useState(false)
  const [opening, setOpening] = useState(false)
  const scoreColor = candidate.qualification_score == null ? 'var(--text-3)'
    : candidate.qualification_score >= 70 ? 'var(--ok)'
    : candidate.qualification_score >= 40 ? '#d97706'
    : 'var(--err)'

  const stripeColor = STAGE_STRIPE[candidate.stage] || 'var(--text-3)'

  // Detect anonymous (sourced but not yet opened) candidate from robota.ua CV DB
  const resumeIdMatch = candidate.profile_url?.match(/\/cv\/(\d+)/)
  const isLocked = !!resumeIdMatch && !candidate.full_name && !candidate.email && !candidate.phone

  async function unlockCv(e: React.MouseEvent) {
    e.stopPropagation()
    if (!resumeIdMatch) return
    if (!confirm('Open full CV? This will use 1 credit from your robota.ua quota.')) return
    setOpening(true)
    const r = await api.robota.openCv(parseInt(resumeIdMatch[1]), candidate.job_id || undefined)
    setOpening(false)
    if (r.error) { alert('Error: ' + r.error); return }
    if (r.data && onUpdate) onUpdate(r.data)
  }

  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--surface)', borderRadius: 16, boxShadow: 'var(--shadow-sm)',
        padding: '12px 14px', cursor: 'pointer', position: 'relative',
        transition: 'box-shadow 150ms ease',
        display: 'flex', flexDirection: 'column', gap: 8,
        borderTop: `3px solid ${stripeColor}`,
      }}
      onMouseEnter={e => (e.currentTarget.style.boxShadow = 'var(--shadow)')}
      onMouseLeave={e => (e.currentTarget.style.boxShadow = 'var(--shadow-sm)')}
    >
      {/* Top row: avatar + name + score */}
      <div className="flex items-center justify-between" style={{ gap: 8, overflow: 'hidden' }}>
        <div className="flex items-center gap-8" style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
          {candidate.photo_url ? (
            <img
              src={candidate.photo_url}
              alt=""
              style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
              onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
            />
          ) : (
            <div style={{
              width: 32, height: 32, borderRadius: '50%', background: 'var(--surface-2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 600, color: 'var(--text-1)', flexShrink: 0,
            }}>
              {candidate.initials || '?'}
            </div>
          )}
          <div style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
            <div className="t-12 medium truncate">{candidate.full_name || candidate.role}</div>
            <div className="t-11 c-3 truncate">
              {candidate.full_name ? candidate.role : candidate.location || '—'}
            </div>
          </div>
        </div>

        {/* Score badge with notes tooltip */}
        {candidate.qualification_score != null ? (
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 3,
                background: scoreColor + '18', color: scoreColor,
                fontSize: 12, fontWeight: 700,
                padding: '3px 8px', borderRadius: 8, cursor: candidate.qualification_notes ? 'help' : 'default',
              }}
              onMouseEnter={() => candidate.qualification_notes && setShowNotes(true)}
              onMouseLeave={() => setShowNotes(false)}
            >
              {iconStar} {candidate.qualification_score}
            </div>
            {showNotes && candidate.qualification_notes && (
              <div style={{
                position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 20,
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 10, padding: '8px 12px', boxShadow: 'var(--shadow)',
                fontSize: 11, color: 'var(--text-2)', lineHeight: 1.5,
                width: 220, whiteSpace: 'pre-wrap', pointerEvents: 'none',
              }}>
                {candidate.qualification_notes}
              </div>
            )}
          </div>
        ) : null}
      </div>

      {/* Salary expectation vs market */}
      {candidate.salary_expectation && candidate.salary_expectation > 0 && (
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '3px 8px', borderRadius: 6, fontSize: 10, fontWeight: 500,
          width: 'fit-content',
          background: band?.bgColor ?? 'var(--surface-2)',
          color:      band?.color   ?? 'var(--text-2)',
        }} title={band
          ? ts.chipTooltip(ts[band.verdictKey], fmtFullUAH(band.median), band.percentile)
          : ts.askTooltip(fmtFullUAH(candidate.salary_expectation))}>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M8 1v14M5 4h4.5a2.5 2.5 0 0 1 0 5H6a2.5 2.5 0 0 0 0 5h5" />
          </svg>
          {Math.round(candidate.salary_expectation / 1000).toLocaleString('en-US')}k ₴
          {band && <span style={{ fontWeight: 400, opacity: 0.85 }}>· p{band.percentile}</span>}
        </div>
      )}

      {/* Contact info — visible directly on the card */}
      {(candidate.email || candidate.phone) && (
        <div className="flex flex-wrap gap-4" style={{ fontSize: 10, color: 'var(--text-2)' }}>
          {candidate.email && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2.5 4l5.5 4 5.5-4"/>
              </svg>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{candidate.email}</span>
            </span>
          )}
          {candidate.phone && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 2h2.5l1.5 4-2 1c.8 1.7 2.1 3 3.8 3.8l1-2 4 1.5V13a1.5 1.5 0 0 1-1.5 1.5C6.6 14.5 1.5 9.4 1.5 3.5A1.5 1.5 0 0 1 3 2z"/>
              </svg>
              {candidate.phone}
            </span>
          )}
        </div>
      )}

      {/* Skills preview */}
      {profile?.skills?.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {(profile.skills as string[]).slice(0, 3).map((s: string, i: number) => (
            <span key={i} style={{ fontSize: 9, padding: '1px 5px', background: 'var(--surface-2)', borderRadius: 3, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>{s}</span>
          ))}
        </div>
      )}

      {/* Unlock CV — subtle button matching platform style (only for sourced candidates) */}
      {isLocked && (
        <div onClick={e => e.stopPropagation()}>
          <button
            onClick={unlockCv}
            disabled={opening}
            style={{
              width: '100%', padding: '7px 10px', borderRadius: 8, fontWeight: 500, fontSize: 11,
              background: 'transparent',
              color: 'var(--accent)',
              border: '1px solid var(--accent)',
              cursor: opening ? 'wait' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              transition: 'background 120ms, color 120ms',
            }}
            onMouseEnter={e => { if (!opening) { e.currentTarget.style.background = 'var(--accent)'; e.currentTarget.style.color = '#fff' } }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--accent)' }}
          >
            {opening ? (
              <><span className="spinner" style={{ width: 11, height: 11 }} /> Unlocking…</>
            ) : (
              <>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="4" y="11" width="16" height="11" rx="2"/>
                  <path d="M8 11V7a4 4 0 0 1 8 0"/>
                </svg>
                Unlock full profile · 1 credit
              </>
            )}
          </button>
        </div>
      )}

      {/* Bottom row: actions only */}
      <div className="flex items-center justify-end" style={{ marginTop: 'auto' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-4">
          <button
            onClick={() => onDelete(candidate.id)}
            title="Delete"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: '2px 4px', display: 'flex', alignItems: 'center' }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--err)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-3)')}>
            {iconTrash}
          </button>
        </div>
      </div>
    </div>
  )
}
