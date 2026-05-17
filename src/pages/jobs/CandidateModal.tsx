import { useEffect, useRef, useState } from 'react'
import { api, Candidate, CandidateMessageEvent, Job, messagingApi, MessagingStatus, SalaryAnalysis, SalaryCacheMeta } from '../../api/client'
import { useAppStore } from '../../store/useAppStore'
import { T } from '../../i18n'
import { iconClose, iconSparkle, iconStar, iconTrash } from './icons'
import { parseProfile, parseTags, stripHtmlToText } from './helpers'
import { computeSalaryBand, fmtFullUAH, fmtUAH } from './salaryBand'

export function CandidateModal({ candidate: initial, job, salary, salaryMeta, onClose, onUpdate, onDelete }: {
  candidate: Candidate
  job: Job | null
  salary?: SalaryAnalysis
  salaryMeta?: SalaryCacheMeta
  onClose: () => void
  onUpdate: (c: Candidate) => void
  onDelete: (id: number) => void
}) {
  const { uiLang } = useAppStore()
  const tm = T[uiLang].jobs.modal
  const tc = T[uiLang].jobs.candidate
  const [candidate, setCandidate] = useState(initial)
  const [tab, setTab] = useState<'profile' | 'message'>('profile')
  const [qualifying, setQualifying] = useState(false)
  const [qualError, setQualError] = useState('')
  const [messages, setMessages] = useState<Record<string, string>>({})
  const [generating, setGenerating] = useState(false)
  const [msgLang, setMsgLang] = useState('uk')
  const [copied, setCopied] = useState(false)
  const [genError, setGenError] = useState('')
  const [showSchedule, setShowSchedule] = useState(false)
  const [channel, setChannel] = useState<'telegram' | 'email' | 'viber'>('telegram')
  const [unlocking, setUnlocking] = useState(false)
  const [unlockError, setUnlockError] = useState('')
  const message = messages[channel] || ''
  const setMessage = (val: string) => setMessages(m => ({ ...m, [channel]: val }))
  const [calendlyUrl, setCalendlyUrl] = useState('')
  const [sending, setSending] = useState(false)
  const [sendResult, setSendResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const [channelStatus, setChannelStatus] = useState<MessagingStatus | null>(null)
  const [rejectionReason, setRejectionReason] = useState(initial.rejection_reason || '')
  const [savingReason, setSavingReason] = useState(false)
  const [messageHistory, setMessageHistory] = useState<CandidateMessageEvent[]>([])
  const viewedRef = useRef(false)

  // Mark as viewed on first open
  useEffect(() => {
    if (viewedRef.current) return
    viewedRef.current = true
    if (initial.status === 'new') {
      api.candidates.updateStatus(initial.id, 'viewed').then(r => {
        if (r.data) { setCandidate(r.data); onUpdate(r.data) }
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (tab === 'message') {
      api.analytics.candidateMessages(candidate.id).then(r => {
        if (r.data) setMessageHistory(r.data)
      })
      messagingApi.status().then(r => { if (r.data) setChannelStatus(r.data) })
      api.robota.config().then(r => { if (r.data?.calendly_url) setCalendlyUrl(r.data.calendly_url) })
    }
  }, [tab, candidate.id, job?.id])

  const profile = parseProfile(candidate.profile_data)

  async function qualify() {
    setQualifying(true); setQualError('')
    const res = await api.candidates.qualify(candidate.id)
    if (res.error) { setQualError(res.error); setQualifying(false); return }
    if (res.data) { setCandidate(res.data); onUpdate(res.data) }
    setQualifying(false)
  }

  // Detect locked candidate (sourced from robota.ua CV DB but not yet opened)
  const resumeIdMatch = candidate.profile_url?.match(/\/cv\/(\d+)/)
  const isLocked = !!resumeIdMatch && !candidate.full_name && !candidate.email && !candidate.phone

  async function unlockProfile() {
    if (!resumeIdMatch) return
    if (!confirm('Open full CV? This will use 1 credit from your robota.ua quota.')) return
    setUnlocking(true); setUnlockError('')
    const r = await api.robota.openCv(parseInt(resumeIdMatch[1]), candidate.job_id || undefined)
    setUnlocking(false)
    if (r.error) { setUnlockError(r.error); return }
    if (r.data) { setCandidate(r.data); onUpdate(r.data) }
  }

  async function generateMessage() {
    if (!job) { setGenError('No position linked to this candidate.'); return }
    setGenerating(true); setGenError('')
    const res = await api.ai.generateMessage(job, candidate, msgLang, channel, calendlyUrl || undefined)
    if (res.error) { setGenError(res.error); setGenerating(false); return }
    if (res.data) setMessage(res.data)
    setGenerating(false)
  }

  async function sendOnChannel() {
    if (!message) return
    setSending(true); setSendResult(null)
    const r = await messagingApi.send(candidate.id, {
      message,
      ctaUrl: calendlyUrl || undefined,
      channels: [channel],
      stopOnFirstSuccess: true,
    })
    setSending(false)
    if (r.error) { setSendResult({ ok: false, error: r.error }); return }
    const result = r.data?.[0]
    setSendResult(result?.ok ? { ok: true } : { ok: false, error: result?.error || 'Échec' })
    if (result?.ok) {
      const u = await api.candidates.updateStatus(candidate.id, 'contacted')
      if (u.data) { setCandidate(u.data); onUpdate(u.data) }
    }
    api.analytics.candidateMessages(candidate.id).then(r2 => {
      if (r2.data) setMessageHistory(r2.data)
    })
  }

  async function copyMessage() {
    await navigator.clipboard.writeText(message)
    setCopied(true); setTimeout(() => setCopied(false), 2000)
    const r = await api.candidates.updateStatus(candidate.id, 'contacted')
    if (r.data) { setCandidate(r.data); onUpdate(r.data) }
    api.analytics.log('message_copied', {
      candidateId: candidate.id,
      jobId: candidate.job_id,
      preview: message.substring(0, 100),
    })
    // Refresh message history
    api.analytics.candidateMessages(candidate.id).then(r2 => {
      if (r2.data) setMessageHistory(r2.data)
    })
  }

  async function saveRejectionReason() {
    setSavingReason(true)
    const r = await api.candidates.updateRejectionReason(candidate.id, rejectionReason)
    if (r.data) { setCandidate(r.data); onUpdate(r.data) }
    setSavingReason(false)
  }

  const scoreColor = candidate.qualification_score == null ? 'var(--text-3)'
    : candidate.qualification_score >= 70 ? 'var(--ok)'
    : candidate.qualification_score >= 40 ? '#d97706'
    : 'var(--err)'

  const tags = parseTags(candidate.tags || '[]')

  return (
    <>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" onClick={e => e.stopPropagation()}
          style={{ width: 680, padding: 0, overflow: 'hidden', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>

          {/* Header */}
          <div style={{ padding: '20px 24px 0', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
              <div className="flex items-center gap-14">
                {candidate.photo_url ? (
                  <img
                    src={candidate.photo_url}
                    alt=""
                    style={{ width: 44, height: 44, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
                    onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                  />
                ) : (
                  <div style={{
                    width: 44, height: 44, borderRadius: '50%', background: 'var(--surface-2)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 14, fontWeight: 600, color: 'var(--text-1)', flexShrink: 0,
                  }}>
                    {candidate.initials || '?'}
                  </div>
                )}
                <div>
                  <div className="t-15 medium">{candidate.full_name || candidate.role}</div>
                  <div className="t-11 c-2 mt-4">
                    {candidate.full_name ? `${candidate.role} · ` : ''}
                    {candidate.location}
                    {candidate.experience_years > 0 ? ` · ${tm.years(candidate.experience_years)}` : ''}
                  </div>
                </div>
              </div>
              <div className="flex gap-8 items-center">
                {candidate.qualification_score != null && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: scoreColor, fontWeight: 600, fontSize: 13 }}>
                    {iconStar} {candidate.qualification_score}/100
                  </div>
                )}
                <button onClick={() => { onDelete(candidate.id); onClose() }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: 4 }}
                  onMouseEnter={e => (e.currentTarget.style.color = 'var(--err)')}
                  onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-3)')}>
                  {iconTrash}
                </button>
                <button onClick={onClose}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: 4 }}>
                  {iconClose}
                </button>
              </div>
            </div>

            {/* Tabs */}
            <div style={{ display: 'flex', gap: 0, marginBottom: -1 }}>
              {(['profile', 'message'] as const).map(t => (
                <button key={t} onClick={() => setTab(t)} style={{
                  background: 'none', border: 'none', cursor: 'pointer', padding: '8px 16px',
                  fontSize: 12, fontWeight: 500, borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
                  color: tab === t ? 'var(--accent)' : 'var(--text-2)',
                }}>
                  {t === 'profile' ? tm.tabProfile : tm.tabMessage}
                </button>
              ))}
            </div>
          </div>

          {/* Body */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>

            {tab === 'profile' && (
              <div>
                {/* Unlock banner — minimal style, matches platform */}
                {isLocked && (
                  <div style={{
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border)',
                    borderRadius: 12, padding: '14px 16px', marginBottom: 14,
                    display: 'flex', alignItems: 'center', gap: 12,
                  }}>
                    <div style={{
                      width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="4" y="11" width="16" height="11" rx="2"/>
                        <path d="M8 11V7a4 4 0 0 1 8 0v4"/>
                      </svg>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)', marginBottom: 2 }}>
                        Profile locked
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.4 }}>
                        Unlock to access contacts, education and work history, and to send messages.
                      </div>
                      {unlockError && (
                        <div style={{ fontSize: 11, color: 'var(--err)', marginTop: 4 }}>{unlockError}</div>
                      )}
                    </div>
                    <button
                      onClick={unlockProfile}
                      disabled={unlocking}
                      style={{
                        background: 'var(--accent)', color: '#fff', border: 'none',
                        borderRadius: 8, padding: '8px 14px', fontSize: 12, fontWeight: 500,
                        cursor: unlocking ? 'wait' : 'pointer', flexShrink: 0,
                        display: 'flex', alignItems: 'center', gap: 5,
                        transition: 'opacity 120ms',
                      }}
                      onMouseEnter={e => { if (!unlocking) e.currentTarget.style.opacity = '0.85' }}
                      onMouseLeave={e => { e.currentTarget.style.opacity = '1' }}
                    >
                      {unlocking ? (
                        <><span className="spinner" style={{ width: 11, height: 11 }} /> Unlocking…</>
                      ) : (
                        <>Unlock · 1 credit</>
                      )}
                    </button>
                  </div>
                )}

                {/* Identity card */}
                <div style={{
                  background: 'var(--surface-2)', borderRadius: 12, padding: 16, marginBottom: 14,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 600 }}>{candidate.full_name || candidate.role}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>
                      {candidate.role}{candidate.location ? ` · ${candidate.location}` : ''}
                      {candidate.experience_years > 0 && ` · ${tm.years(candidate.experience_years)}`}
                      {candidate.salary_expectation > 0 && ` · ${candidate.salary_expectation.toLocaleString()} UAH`}
                    </div>
                    {candidate.birth_date && candidate.birth_date !== '0001-01-01T00:00:00' && (
                      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>
                        Born {new Date(candidate.birth_date).toLocaleDateString()}
                        {' '}({Math.floor((Date.now() - new Date(candidate.birth_date).getTime()) / (365.25 * 24 * 3600 * 1000))} y/o)
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 12, flexWrap: 'wrap' }}>
                      {candidate.email && (
                        <a href={`mailto:${candidate.email}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{candidate.email}</a>
                      )}
                      {candidate.phone && (
                        <a href={`tel:${candidate.phone}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{candidate.phone}</a>
                      )}
                    </div>
                  </div>
                </div>

                {/* Market salary context */}
                <SalaryContextSection candidate={candidate} salary={salary} salaryMeta={salaryMeta} />

                {/* Timestamps + decision */}
                {(candidate.viewed_at || candidate.contacted_at || (candidate.decision && candidate.decision !== 'pending')) && (
                  <div className="flex flex-wrap gap-8" style={{ marginBottom: 16 }}>
                    {candidate.viewed_at && (
                      <span style={{ fontSize: 10, color: 'var(--text-3)', padding: '3px 10px', background: 'var(--surface-2)', borderRadius: 20 }}>
                        {tm.viewedAt}: {new Date(candidate.viewed_at).toLocaleDateString(T[uiLang].locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                    {candidate.contacted_at && (
                      <span style={{ fontSize: 10, color: 'var(--text-3)', padding: '3px 10px', background: 'var(--surface-2)', borderRadius: 20 }}>
                        {tm.contactedAt}: {new Date(candidate.contacted_at).toLocaleDateString(T[uiLang].locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                    {candidate.decision && candidate.decision !== 'pending' && (
                      <span style={{
                        fontSize: 10, fontWeight: 600, padding: '3px 10px', borderRadius: 20,
                        background: candidate.decision === 'hire' ? '#D0F0E4' : '#FDDDD8',
                        color: candidate.decision === 'hire' ? '#2E9460' : '#D94040',
                      }}>
                        {tm.interviewDecision}: {candidate.decision === 'hire' ? tc.hired : tc.rejected}
                      </span>
                    )}
                  </div>
                )}

                {/* Outreach history banner */}
                {candidate.outreach_count > 0 && (
                  <div style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 10, padding: '10px 14px', marginBottom: 14, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#2563EB" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
                      <circle cx="8" cy="8" r="7"/><line x1="8" y1="5" x2="8" y2="8"/><circle cx="8" cy="11" r="0.5" fill="#2563EB"/>
                    </svg>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#1D4ED8' }}>
                        {candidate.outreach_count === 1 ? 'Contacté automatiquement 1 fois' : `Contacté automatiquement ${candidate.outreach_count} fois`}
                        {candidate.outreach_count >= 2 && ' — limite atteinte'}
                      </div>
                      {candidate.contacted_at && (
                        <div style={{ fontSize: 11, color: '#3B82F6', marginTop: 2 }}>
                          Dernier envoi : {new Date(candidate.contacted_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
                        SMS + email en ukrainien avec lien Calendly. Tout nouvel envoi automatique est bloqué.
                      </div>
                    </div>
                  </div>
                )}

                {/* Rejection reason — only when rejected */}
                {(candidate.decision === 'reject' || candidate.status === 'rejected') && (
                  <div style={{ background: '#FFF4F2', borderRadius: 12, padding: '14px 16px', marginBottom: 16, border: '1px solid #FDDDD8' }}>
                    <div className="t-11 medium" style={{ color: '#D94040', marginBottom: 8 }}>{tc.rejectionReason}</div>
                    <textarea
                      className="input"
                      style={{ width: '100%', minHeight: 64, fontSize: 12, resize: 'vertical', boxSizing: 'border-box' }}
                      placeholder={tc.rejectionReasonPlaceholder}
                      value={rejectionReason}
                      onChange={e => setRejectionReason(e.target.value)}
                    />
                    <button
                      className="btn btn-secondary"
                      style={{ marginTop: 8, fontSize: 11 }}
                      onClick={saveRejectionReason}
                      disabled={savingReason}
                    >
                      {savingReason ? tc.saving : tc.save}
                    </button>
                  </div>
                )}

                {/* Qualification */}
                <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: '16px 18px', marginBottom: 16 }}>
                  <div className="flex items-center justify-between mb-12">
                    <span className="t-12 medium">{tm.aiScore}</span>
                    <button className="btn" onClick={qualify} disabled={qualifying} style={{ fontSize: 11, padding: '5px 12px' }}>
                      {qualifying ? <span className="spinner" style={{ width: 12, height: 12 }} /> : iconSparkle}
                      {qualifying ? tm.analyzing : candidate.qualification_score != null ? tm.reanalyze : tm.qualify}
                    </button>
                  </div>
                  {qualError && <p style={{ color: 'var(--err)', fontSize: 11, marginBottom: 8 }}>{qualError}</p>}
                  {candidate.qualification_score != null ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{
                        width: 48, height: 48, borderRadius: '50%', border: `3px solid ${scoreColor}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 15, fontWeight: 700, color: scoreColor, flexShrink: 0,
                      }}>
                        {candidate.qualification_score}
                      </div>
                      <div className="t-12 c-2" style={{ lineHeight: 1.5 }}>{candidate.qualification_notes}</div>
                    </div>
                  ) : (
                    <p className="t-11 c-3">{tm.noScore}</p>
                  )}
                </div>

                {/* Profile details */}
                {profile && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                    {profile.skills?.length > 0 && (
                      <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: '12px 14px' }}>
                        <div className="t-11 c-3 mb-8">{tm.skills}</div>
                        <div className="flex flex-wrap gap-4">
                          {(profile.skills as string[]).map((s: string, i: number) => (
                            <span key={i} style={{ fontSize: 10, padding: '2px 7px', background: 'var(--surface-3)', borderRadius: 4, color: 'var(--text-2)' }}>{s}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    {profile.education && (
                      <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: '12px 14px' }}>
                        <div className="t-11 c-3 mb-4">{tm.education}</div>
                        <div className="t-12">{profile.education}</div>
                      </div>
                    )}
                    {profile.languages?.length > 0 && (
                      <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: '12px 14px' }}>
                        <div className="t-11 c-3 mb-4">{tm.languages}</div>
                        <div className="t-12">{(profile.languages as string[]).join(', ')}</div>
                      </div>
                    )}
                    {profile.availability && (
                      <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: '12px 14px' }}>
                        <div className="t-11 c-3 mb-4">{tm.availability}</div>
                        <div className="t-12">{profile.availability}</div>
                      </div>
                    )}
                  </div>
                )}

                {profile?.summary && (
                  <p className="t-12 c-2" style={{ lineHeight: 1.6, marginBottom: 12 }}>{profile.summary}</p>
                )}

                {tags.length > 0 && (
                  <div className="flex flex-wrap gap-4">
                    {tags.map((t, i) => <span key={i} className="chip t-11">{t}</span>)}
                  </div>
                )}

                {/* Skills summary */}
                {(() => {
                  let pd: Record<string, unknown> | null = null
                  try { pd = candidate.profile_data ? JSON.parse(candidate.profile_data as string) : null } catch { pd = null }
                  const cleanSkills = stripHtmlToText(pd?.skillsSummary as string)
                  return cleanSkills ? (
                    <div style={{ marginTop: 18 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                        Key skills
                      </div>
                      <div style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text-1)', whiteSpace: 'pre-wrap' }}>
                        {cleanSkills}
                      </div>
                    </div>
                  ) : null
                })()}

                {/* Work experience */}
                {candidate.experience_text && (
                  <div style={{ marginTop: 18 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                      Work experience
                    </div>
                    <div style={{
                      background: 'var(--surface-2)', borderRadius: 10, padding: 14,
                      fontSize: 12, lineHeight: 1.7, color: 'var(--text-1)',
                      whiteSpace: 'pre-wrap', maxHeight: 400, overflowY: 'auto',
                    }}>
                      {stripHtmlToText(candidate.experience_text)}
                    </div>
                  </div>
                )}

                {/* External link to robota.ua employer view */}
                {(candidate.robota_apply_id && job?.robota_vacancy_id) || candidate.profile_url ? (
                  <div style={{ marginTop: 18, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                    <a
                      href={
                        (candidate.robota_apply_id && job?.robota_vacancy_id)
                          ? `https://robota.ua/my/vacancies/${job.robota_vacancy_id}/candidates?id=${candidate.robota_apply_id}-prof`
                          : candidate.profile_url || '#'
                      }
                      target="_blank" rel="noopener noreferrer"
                      onClick={() => api.candidates.updateStatus(candidate.id, 'viewed')}
                      style={{
                        fontSize: 12, color: 'var(--accent)', textDecoration: 'none',
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                      }}>
                      View full profile →
                    </a>
                  </div>
                ) : null}
              </div>
            )}

            {tab === 'message' && isLocked && (
              <div style={{
                padding: '40px 24px', textAlign: 'center',
                background: 'var(--surface-2)',
                border: '1px solid var(--border)', borderRadius: 12,
              }}>
                <div style={{
                  width: 48, height: 48, borderRadius: 12,
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px',
                }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--text-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="4" y="11" width="16" height="11" rx="2"/>
                    <path d="M8 11V7a4 4 0 0 1 8 0v4"/>
                  </svg>
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-1)', marginBottom: 4 }}>
                  Profile locked
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 18, lineHeight: 1.5, maxWidth: 360, margin: '0 auto 18px' }}>
                  Unlock the candidate's full profile to access contact channels and send messages.
                </div>
                {unlockError && (
                  <div style={{ fontSize: 12, color: 'var(--err)', marginBottom: 12 }}>{unlockError}</div>
                )}
                <button
                  onClick={unlockProfile}
                  disabled={unlocking}
                  style={{
                    background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8,
                    padding: '10px 20px', fontSize: 13, fontWeight: 500,
                    cursor: unlocking ? 'wait' : 'pointer',
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    transition: 'opacity 120ms',
                  }}
                  onMouseEnter={e => { if (!unlocking) e.currentTarget.style.opacity = '0.85' }}
                  onMouseLeave={e => { e.currentTarget.style.opacity = '1' }}
                >
                  {unlocking ? (
                    <><span className="spinner" /> Unlocking…</>
                  ) : (
                    <>Unlock profile · 1 credit</>
                  )}
                </button>
              </div>
            )}

            {tab === 'message' && !isLocked && (
              <div>
                {/* Channel selector */}
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: 'block', marginBottom: 8, fontSize: 11, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    Channel
                  </label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                    {(['telegram', 'email', 'viber'] as const).map(ch => {
                      const info = { telegram: { label: 'Telegram' }, email: { label: 'Email' }, viber: { label: 'Viber' } }[ch]
                      const isComingSoon = ch === 'viber'
                      const isConnected = !isComingSoon && (
                        ch === 'email'
                          ? channelStatus?.email?.configured
                          : channelStatus?.telegram?.connected
                      )
                      const isActive = !isComingSoon && channel === ch
                      return (
                        <button
                          key={ch}
                          onClick={() => { if (!isComingSoon) setChannel(ch) }}
                          disabled={isComingSoon}
                          style={{
                            padding: '10px 6px', borderRadius: 10, fontSize: 12, fontWeight: 500,
                            border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
                            background: isActive ? 'var(--surface)' : 'var(--surface-2)',
                            color: isActive ? 'var(--text-1)' : 'var(--text-2)',
                            cursor: isComingSoon ? 'not-allowed' : 'pointer',
                            opacity: isComingSoon ? 0.55 : 1,
                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                            transition: 'all 120ms',
                          }}>
                          <span>{info.label}</span>
                          {isComingSoon ? (
                            <span style={{ fontSize: 9, fontWeight: 500, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                              {T[uiLang].channels.comingSoon}
                            </span>
                          ) : (
                            <span style={{
                              width: 5, height: 5, borderRadius: '50%',
                              background: isConnected ? '#16A34A' : 'var(--text-3)',
                              opacity: isConnected ? 1 : 0.4,
                            }} />
                          )}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* Language + Calendly status — inline row */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 12 }}>
                  <div className="flex items-center gap-8">
                    <span style={{ fontSize: 11, color: 'var(--text-3)' }}>Language</span>
                    <div style={{ display: 'flex', background: 'var(--surface-2)', borderRadius: 8, padding: 2, gap: 2 }}>
                      {T[uiLang].messageLangs.map(([v, l]) => (
                        <button key={v} onClick={() => setMsgLang(v)} style={{
                          background: msgLang === v ? 'var(--surface)' : 'transparent',
                          color: msgLang === v ? 'var(--text-1)' : 'var(--text-3)',
                          border: 'none', borderRadius: 6, padding: '3px 10px', fontSize: 11, fontWeight: 500,
                          cursor: 'pointer',
                          boxShadow: msgLang === v ? 'var(--shadow-sm)' : 'none',
                        }}>{l}</button>
                      ))}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: calendlyUrl ? 'var(--text-3)' : 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 5 }}>
                    {calendlyUrl ? (
                      <>
                        <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#16A34A' }} />
                        Booking link active
                      </>
                    ) : (
                      <>
                        <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--text-3)' }} />
                        No booking link · set in profile menu
                      </>
                    )}
                  </div>
                </div>

                {!message && (
                  <button className="btn btn-primary" onClick={generateMessage} disabled={generating} style={{ marginBottom: 14, width: '100%' }}>
                    {generating ? <span className="spinner" /> : iconSparkle}
                    {generating ? tm.generating : `Generate for ${channel === 'telegram' ? 'Telegram' : channel === 'viber' ? 'Viber' : 'Email'}`}
                  </button>
                )}

                {genError && <p style={{ color: 'var(--err)', fontSize: 12, marginBottom: 12 }}>{genError}</p>}

                {message && (() => {
                  const channelLabel = channel === 'telegram' ? 'Telegram' : channel === 'viber' ? 'Viber' : 'Email'
                  return (
                  <div>
                    {/* Preview — neutral platform style */}
                    <div style={{
                      padding: 14, borderRadius: 12, marginBottom: 10,
                      background: 'var(--surface-2)', border: '1px solid var(--border)',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                          {channelLabel} · {message.length} chars
                        </span>
                        <button
                          onClick={generateMessage}
                          disabled={generating}
                          style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            fontSize: 11, color: 'var(--accent)', fontWeight: 500,
                            display: 'flex', alignItems: 'center', gap: 4,
                          }}>
                          {generating ? <span className="spinner" style={{ width: 11, height: 11 }} /> : null}
                          {generating ? 'Regenerating…' : 'Regenerate'}
                        </button>
                      </div>
                      <textarea
                        value={message}
                        onChange={e => setMessage(e.target.value)}
                        style={{
                          width: '100%', minHeight: 160, fontSize: 13, lineHeight: 1.6,
                          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
                          outline: 'none', resize: 'vertical', padding: 10,
                          fontFamily: 'inherit', color: 'var(--text-1)', boxSizing: 'border-box',
                        }}
                      />
                    </div>

                    <div className="flex gap-8">
                      <button className="btn btn-ghost btn-sm" onClick={copyMessage}>
                        {copied ? tm.copied : tm.copyMessage}
                      </button>
                      <button
                        className="btn btn-primary btn-sm" style={{ flex: 1 }}
                        onClick={sendOnChannel}
                        disabled={sending || !channelStatus?.[channel]?.connected}
                      >
                        {sending ? <span className="spinner" /> : null}
                        {sending
                          ? 'Sending…'
                          : !channelStatus?.[channel]?.connected
                            ? `${channelLabel} not connected`
                            : `Send via ${channelLabel}`}
                      </button>
                    </div>

                    {sendResult && (
                      <div style={{
                        marginTop: 10, padding: '8px 12px', borderRadius: 8, fontSize: 12,
                        background: sendResult.ok ? '#DCFCE7' : '#FEE2E2',
                        color:      sendResult.ok ? '#15803D' : '#B91C1C',
                      }}>
                        {sendResult.ok ? 'Message sent successfully' : `Error: ${sendResult.error}`}
                      </div>
                    )}
                  </div>
                  )
                })()}

                {!message && !generating && (
                  <p className="t-12 c-3">{tm.messageHint}</p>
                )}

                {/* Message history */}
                {messageHistory.length > 0 && (
                  <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
                    <div className="t-11 c-3 medium" style={{ marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {tc.messageHistory}
                    </div>
                    {messageHistory.map(ev => {
                      const meta = (() => { try { return JSON.parse(ev.metadata) } catch { return {} } })()
                      return (
                        <div key={ev.id} style={{ padding: '8px 12px', background: 'var(--surface-2)', borderRadius: 8, marginBottom: 6 }}>
                          <div className="t-11 c-3">{new Date(ev.created_at).toLocaleDateString(T[uiLang].locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
                          {meta.preview && <div className="t-11 c-2 mt-4" style={{ fontStyle: 'italic' }}>"{meta.preview}…"</div>}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

          </div>
        </div>
      </div>
    </>
  )
}

// ─── Market salary context — shows candidate's expectation vs job benchmark ──
function SalaryContextSection({ candidate, salary, salaryMeta }: {
  candidate: Candidate
  salary?: SalaryAnalysis
  salaryMeta?: SalaryCacheMeta
}) {
  const { uiLang } = useAppStore()
  const ts = T[uiLang].salary
  if (!salary) return null
  const o = salary.overall
  const ask = candidate.salary_expectation && candidate.salary_expectation > 0 ? candidate.salary_expectation : null
  const band = ask ? computeSalaryBand(ask, salary) : null

  const levelKey: 'junior' | 'middle' | 'senior' | 'lead' =
    !candidate.experience_years || candidate.experience_years < 2 ? 'junior'
      : candidate.experience_years < 5 ? 'middle'
      : candidate.experience_years < 10 ? 'senior' : 'lead'
  const levelLabelKey = (
    { junior: 'levelJunior', middle: 'levelMiddle', senior: 'levelSenior', lead: 'levelLead' } as const
  )[levelKey]
  const levelStats = salary.byLevel[levelKey]

  const chartMax = Math.max(o.max, ask ?? 0) * 1.05
  const xpct = (v: number) => `${(v / chartMax) * 100}%`

  return (
    <div style={{
      background: 'var(--surface-2)', borderRadius: 12, padding: 14, marginBottom: 14,
      border: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-1)' }}>
          {ts.contextTitle}
        </div>
        {salaryMeta && (
          <div style={{ fontSize: 10, color: 'var(--text-3)' }}>
            {ts.activeCvs(salary.collection.finalSampleSize)} · {salaryMeta.keywords_used}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
        {ask && (
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{ts.candidateAsks}</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-1)' }}>{fmtFullUAH(ask)}</div>
          </div>
        )}
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{ts.marketMedian}</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-1)' }}>{fmtFullUAH(o.median)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{ts.recommendedBand}</div>
          <div style={{ fontSize: 13, color: 'var(--text-2)' }}>{fmtUAH(o.p25)} — {fmtUAH(o.p75)}</div>
        </div>
        {levelStats && (
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{ts.forLevel(ts[levelLabelKey], levelStats.count)}</div>
            <div style={{ fontSize: 13, color: 'var(--text-2)' }}>{fmtFullUAH(levelStats.median)}</div>
          </div>
        )}
      </div>

      <div style={{ position: 'relative', marginBottom: 8 }}>
        <div style={{
          position: 'relative', height: 14, background: 'var(--surface)',
          border: '1px solid var(--border)', borderRadius: 7,
        }}>
          <div style={{
            position: 'absolute', left: xpct(o.p25), width: xpct(o.p75 - o.p25),
            top: 0, bottom: 0, background: 'rgba(34, 139, 86, 0.25)',
          }} />
          <div style={{
            position: 'absolute', left: `calc(${xpct(o.median)} - 1px)`, width: 2, top: -3, bottom: -3,
            background: 'var(--accent)',
          }} />
          {ask && (
            <div style={{
              position: 'absolute', left: `calc(${xpct(ask)} - 6px)`, width: 12, height: 20, top: -3,
              borderRadius: 3, background: band?.color ?? 'var(--text-2)',
              border: '2px solid var(--surface)', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            }} title={ts.candidateMarkerTitle(fmtFullUAH(ask))} />
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 10, color: 'var(--text-3)' }}>
          <span>{fmtUAH(o.min)}</span>
          <span>{fmtUAH(o.p25)}</span>
          <span style={{ fontWeight: 600, color: 'var(--text-2)' }}>{ts.scaleMedianLabel(fmtUAH(o.median))}</span>
          <span>{fmtUAH(o.p75)}</span>
          <span>{fmtUAH(o.max)}</span>
        </div>
      </div>

      {band ? (
        <div style={{
          marginTop: 10, padding: '8px 12px', borderRadius: 8,
          background: band.bgColor, color: band.color, fontSize: 12, fontWeight: 500,
        }}>
          <strong>p{band.percentile}</strong> — {ts[band.verdictKey]}
        </div>
      ) : (
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-3)', fontStyle: 'italic' }}>
          {ts.noExpectation}
        </div>
      )}
    </div>
  )
}
