import { useEffect, useState, useRef } from 'react'
import { api, Job, FullSyncProgress } from '../api/client'
import { useAppStore } from '../store/useAppStore'
import { T } from '../i18n'
import { EMPTY_JOB } from './jobs/constants'
import { iconTrash } from './jobs/icons'
import { JobForm } from './jobs/JobForm'
import { PipelineView } from './jobs/PipelineView'
import { PublishModal } from './jobs/PublishModal'

export function JobDescriptions() {
  const { uiLang } = useAppStore()
  const tj = T[uiLang].jobs
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedJob, setSelectedJob] = useState<Job | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editingJob, setEditingJob] = useState<Job | null>(null)
  const [candidateCounts, setCandidateCounts] = useState<Record<number, number>>({})
  const [publishingJob, setPublishingJob] = useState<Job | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncProgress, setSyncProgress] = useState<FullSyncProgress | null>(null)
  const [syncError, setSyncError] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    api.jobs.withCounts().then(r => {
      if (r.data) {
        setJobs(r.data)
        const counts: Record<number, number> = {}
        r.data.forEach(j => { counts[j.id] = (j as typeof j & { candidate_count: number }).candidate_count })
        setCandidateCounts(counts)
      }
      setLoading(false)
    })
  }, [])

  async function deleteJob(id: number) {
    if (!confirm(tj.deleteConfirm)) return
    await api.jobs.remove(id)
    setJobs(prev => prev.filter(j => j.id !== id))
  }

  // Flip a posting active ↔ inactive (also publishes/closes it on robota.ua).
  async function toggleActive(job: Job) {
    const next = job.is_active ? 0 : 1
    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, is_active: next } : j))
    const r = await api.jobs.update(job.id, { is_active: next })
    if (r.data) setJobs(prev => prev.map(j => j.id === job.id ? r.data! : j))
  }

  async function reloadJobs() {
    const r = await api.jobs.withCounts()
    if (r.data) {
      setJobs(r.data)
      const counts: Record<number, number> = {}
      r.data.forEach(j => { counts[j.id] = (j as typeof j & { candidate_count: number }).candidate_count })
      setCandidateCounts(counts)
    }
  }

  // Auto-detect a running full sync (triggered automatically by login/startup) and show progress banner
  useEffect(() => {
    let active = true
    async function poll() {
      const s = await api.robota.fullSyncStatus()
      if (!active || !s.data) return
      setSyncProgress(s.data)
      if (s.data.status === 'running') {
        setSyncing(true)
      } else if (syncing && (s.data.status === 'done' || s.data.status === 'error')) {
        setSyncing(false)
        if (s.data.status === 'error') setSyncError(s.data.error || 'Erreur de sync')
        await reloadJobs()
      }
    }
    poll()
    pollRef.current = setInterval(poll, 2000)
    return () => { active = false; if (pollRef.current) clearInterval(pollRef.current) }
  }, [syncing])

  if (selectedJob) {
    return (
      <div className="page-pipeline">
        <PipelineView job={selectedJob} onBack={() => setSelectedJob(null)} />
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page-header">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="page-title">{tj.title}</h1>
            <p className="page-desc">{tj.desc}</p>
          </div>
          <button className="btn btn-primary" onClick={() => { setEditingJob(null); setShowForm(true) }}>
            {tj.newJob}
          </button>
        </div>
        {syncProgress && syncProgress.status === 'running' && (
          <div style={{
            marginTop: 16, padding: '12px 16px', background: '#EFF6FF',
            border: '1px solid #BFDBFE', borderRadius: 10,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#1D4ED8' }}>
                {syncProgress.currentVacancy || 'Synchronisation robota.ua…'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                {syncProgress.vacanciesDone} / {syncProgress.vacanciesTotal} vacancies
              </div>
            </div>
            {syncProgress.vacanciesTotal > 0 && (
              <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 4, overflow: 'hidden', marginBottom: 8 }}>
                <div style={{
                  height: '100%', width: `${(syncProgress.vacanciesDone / syncProgress.vacanciesTotal) * 100}%`,
                  background: '#1D4ED8', transition: 'width 300ms ease',
                }} />
              </div>
            )}
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
              {syncProgress.candidatesImported} candidats importés · {syncProgress.candidatesOutreached} contactés
            </div>
          </div>
        )}
        {syncError && !syncing && (
          <div style={{ marginTop: 12, padding: '8px 12px', background: '#FEF2F2', border: '1px solid #FECACA', color: '#DC2626', borderRadius: 8, fontSize: 12 }}>
            {syncError}
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-8">
          <span className="spinner" /><span className="c-2">{tj.loading}</span>
        </div>
      ) : jobs.length === 0 ? (
        <div className="empty-state">
          <p>{tj.noJobs}</p>
          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => setShowForm(true)}>{tj.createJob}</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
          {jobs.map(job => {
            const count = candidateCounts[job.id] ?? 0
            const skills = (() => { try { return JSON.parse(job.skills || '[]') as string[] } catch { return [] } })()
            return (
              <div
                key={job.id}
                onClick={() => setSelectedJob(job)}
                style={{
                  background: 'var(--surface)', borderRadius: 16, boxShadow: 'var(--shadow-sm)',
                  padding: '20px 22px', cursor: 'pointer', transition: 'box-shadow 150ms ease',
                }}
                onMouseEnter={e => (e.currentTarget.style.boxShadow = 'var(--shadow)')}
                onMouseLeave={e => (e.currentTarget.style.boxShadow = 'var(--shadow-sm)')}
              >
                <div className="flex items-start justify-between mb-10">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="t-14 medium" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{
                        width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                        background: job.is_active ? '#16A34A' : '#DC2626',
                      }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.title}</span>
                    </div>
                    <div className="t-11 c-3 mt-4">{job.location}</div>
                  </div>
                  <div className="flex items-center gap-6" onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => setPublishingJob(job)}
                      title="Publier sur robota.ua"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: 4, display: 'flex', alignItems: 'center' }}
                      onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent)')}
                      onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-3)')}>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M8 2v8M5 5l3-3 3 3"/><path d="M3 11v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2"/>
                      </svg>
                    </button>
                    <button
                      onClick={() => { setEditingJob(job); setShowForm(true) }}
                      style={{ background: 'var(--surface-2)', border: 'none', borderRadius: 8, cursor: 'pointer', color: 'var(--text-2)', padding: '5px 10px', fontSize: 11, fontWeight: 500 }}>
                      {tj.edit}
                    </button>
                    <button
                      onClick={() => deleteJob(job.id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: 4, display: 'flex', alignItems: 'center' }}
                      onMouseEnter={e => (e.currentTarget.style.color = 'var(--err)')}
                      onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-3)')}>
                      {iconTrash}
                    </button>
                  </div>
                </div>

                {(() => {
                  const hasSalary = job.salary_min || job.salary_max
                  const hasExp = job.experience_years && job.experience_years > 0
                  if (!hasSalary && !hasExp) return null
                  return (
                    <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                      {hasSalary && (
                        <span className="t-11 c-2">
                          {job.salary_min === job.salary_max
                            ? `${job.salary_min?.toLocaleString()} UAH`
                            : `${(job.salary_min || 0).toLocaleString()}–${(job.salary_max || 0).toLocaleString()} UAH`}
                        </span>
                      )}
                      {hasSalary && hasExp && <span className="t-11 c-3">·</span>}
                      {hasExp && <span className="t-11 c-2">{tj.expYears(job.experience_years)}</span>}
                    </div>
                  )
                })()}

                {skills.length > 0 && (
                  <div className="flex flex-wrap gap-4" style={{ marginBottom: 12 }}>
                    {skills.slice(0, 4).map((s, i) => (
                      <span key={i} style={{ fontSize: 10, padding: '2px 6px', background: 'var(--surface-2)', borderRadius: 4, color: 'var(--text-3)' }}>{s}</span>
                    ))}
                    {skills.length > 4 && <span style={{ fontSize: 10, color: 'var(--text-3)' }}>+{skills.length - 4}</span>}
                  </div>
                )}

                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div className="flex items-center gap-8">
                    <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                      {tj.candidates(count)}
                    </span>
                    <PlatformDot
                      label="R"
                      published={!!job.robota_vacancy_id}
                      error={job.robota_error || undefined}
                      title={job.robota_vacancy_id ? `robota.ua · ID ${job.robota_vacancy_id}` : 'robota.ua — non publié'}
                    />
                    <PlatformDot
                      label="W"
                      published={!!job.workua_job_id}
                      error={job.workua_error || undefined}
                      title={job.workua_job_id ? `work.ua · ID ${job.workua_job_id}` : 'work.ua — non publié'}
                    />
                  </div>
                  <span
                    onClick={e => { e.stopPropagation(); toggleActive(job) }}
                    style={{
                      fontSize: 10, fontWeight: 700, padding: '4px 11px', borderRadius: 20,
                      background: job.is_active ? '#DCFCE7' : '#FEE2E2',
                      color:      job.is_active ? '#15803D' : '#B91C1C',
                      border: `1px solid ${job.is_active ? '#86EFAC' : '#FCA5A5'}`,
                      textTransform: 'uppercase', letterSpacing: 0.4, cursor: 'pointer',
                      userSelect: 'none',
                    }}
                    title={[
                      job.robota_error && `Erreur robota.ua : ${job.robota_error}`,
                      job.workua_error && `Erreur work.ua : ${job.workua_error}`,
                    ].filter(Boolean).join('\n') || tj.toggleStatus}
                  >
                    {job.is_active ? tj.active : tj.inactive}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {showForm && (
        <JobForm
          initial={editingJob || EMPTY_JOB}
          onSave={saved => {
            setJobs(prev => editingJob ? prev.map(j => j.id === saved.id ? saved : j) : [saved, ...prev])
            setShowForm(false)
          }}
          onClose={() => setShowForm(false)}
        />
      )}

      {publishingJob && (
        <PublishModal
          job={publishingJob}
          onClose={() => setPublishingJob(null)}
        />
      )}
    </div>
  )
}

function PlatformDot({ label, published, error, title }: {
  label: string; published: boolean; error?: string; title: string
}) {
  const color = error ? '#DC2626' : published ? '#15803D' : 'var(--text-3)'
  const bg    = error ? '#FEE2E2' : published ? '#DCFCE7' : 'var(--surface-2)'
  return (
    <span
      title={error ? `${title}\n${error}` : title}
      style={{
        fontSize: 9, fontWeight: 700, width: 16, height: 16, borderRadius: '50%',
        background: bg, color, display: 'inline-flex', alignItems: 'center',
        justifyContent: 'center', letterSpacing: 0, lineHeight: 1,
      }}
    >{label}</span>
  )
}
