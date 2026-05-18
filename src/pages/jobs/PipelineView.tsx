import { useEffect, useRef, useState } from 'react'
import { api, Candidate, Job } from '../../api/client'
import { useAppStore } from '../../store/useAppStore'
import { T } from '../../i18n'
import { iconChevronLeft } from './icons'
import { PipelineCard } from './PipelineCard'
import { KanbanView } from './KanbanView'
import { CandidateModal } from './CandidateModal'
import { AddCandidatePanel } from './AddCandidatePanel'
import { RobotaSyncModal } from './RobotaSyncModal'
import { SalaryBanner, useJobSalary } from './SalaryBanner'
import { useIsMobile } from '../../hooks/useIsMobile'


export function PipelineView({ job, onBack }: { job: Job; onBack: () => void }) {
  const { uiLang } = useAppStore()
  const tj = T[uiLang].jobs
  const tp = T[uiLang].jobs.pipeline
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [selectedCandidate, setSelectedCandidate] = useState<Candidate | null>(null)
  const [search, setSearch] = useState('')
  const [sourceTab, setSourceTab] = useState<'applicants' | 'sourced'>('applicants')
  const [viewMode, setViewMode] = useState<'grid' | 'kanban'>(
    () => (localStorage.getItem('farmasoft_pipeline_view') as 'grid' | 'kanban') || 'grid',
  )
  function setView(m: 'grid' | 'kanban') {
    setViewMode(m)
    localStorage.setItem('farmasoft_pipeline_view', m)
  }
  const [batchQualifying, setBatchQualifying] = useState(false)
  const [qualifyProgress, setQualifyProgress] = useState<{ done: number; total: number } | null>(null)
  const [showRobotaSync, setShowRobotaSync] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const salary = useJobSalary(job.id)
  const isMobile = useIsMobile()
  const sectionGap = isMobile ? 8 : 12

  useEffect(() => {
    api.candidates.list(job.id).then(r => {
      if (r.data) setCandidates(r.data)
      setLoading(false)
    })
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [job.id])

  async function deleteCandidate(id: number) {
    await api.candidates.remove(id)
    setCandidates(prev => prev.filter(c => c.id !== id))
  }

  async function advanceStage(id: number, newStage: string) {
    const res = await api.candidates.updateStage(id, newStage)
    if (res.data) setCandidates(prev => prev.map(c => c.id === id ? res.data! : c))
  }

  async function batchQualify() {
    const unscored = candidates.filter(c => c.qualification_score == null)
    if (unscored.length === 0) return
    setBatchQualifying(true)
    setQualifyProgress({ done: 0, total: unscored.length })
    for (let i = 0; i < unscored.length; i++) {
      const res = await api.candidates.qualify(unscored[i].id)
      if (res.data) setCandidates(prev => prev.map(c => c.id === res.data!.id ? res.data! : c))
      setQualifyProgress({ done: i + 1, total: unscored.length })
    }
    setBatchQualifying(false)
    setQualifyProgress(null)
  }

  function addCandidates(newOnes: Candidate[]) {
    setCandidates(prev => {
      const existing = new Set(prev.map(c => c.profile_url || c.id.toString()))
      const toAdd = newOnes.filter(c => !existing.has(c.profile_url || c.id.toString()))
      return [...toAdd, ...prev]
    })
    if (pollRef.current) clearInterval(pollRef.current)
    let attempts = 0
    pollRef.current = setInterval(async () => {
      attempts++
      if (attempts > 20) { clearInterval(pollRef.current!); pollRef.current = null; return }
      const r = await api.candidates.list(job.id)
      if (!r.data) return
      setCandidates(r.data)
      const allScored = newOnes.every(c => r.data!.find(x => x.id === c.id)?.qualification_score != null)
      if (allScored) { clearInterval(pollRef.current!); pollRef.current = null }
    }, 1500)
  }

  function exportCSV() {
    // Use semicolon as separator (Excel default in EU) and CRLF for compatibility
    const SEP = ';'
    const NL  = '\r\n'
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v)
      // Quote if contains separator, quote, newline, or starts with risky char (formula injection)
      if (/[";\r\n,]/.test(s) || /^[=+\-@]/.test(s)) return `"${s.replace(/"/g, '""')}"`
      return s
    }

    const headers = tp.csvHeaders
    const rows = candidates.map(c => [
      c.id,
      c.full_name || c.initials || '',
      c.role || '',
      c.location || '',
      c.email || '',
      c.phone || '',
      c.experience_years ?? '',
      c.salary_expectation || '',
      c.stage,
      c.status,
      c.qualification_score ?? '',
      c.qualification_notes || '',
      c.profile_url || '',
      c.created_at || '',
    ].map(esc))

    const csv = [headers.map(esc).join(SEP), ...rows.map(r => r.join(SEP))].join(NL)
    // UTF-8 BOM so Excel detects the encoding correctly (Cyrillic readable)
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const safeName = job.title.replace(/[^a-zA-Z0-9Ѐ-ӿ_]/g, '_').replace(/_+/g, '_')
    a.download = `${safeName}_candidates_${new Date().toISOString().slice(0,10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const unscoredCount = candidates.filter(c => c.qualification_score == null).length

  // Split candidates into two groups: applicants (postulated) vs sourced (found by us)
  const applicants = candidates.filter(c => !!c.robota_apply_id)
  const sourced    = candidates.filter(c => !c.robota_apply_id)

  const visibleSet = sourceTab === 'applicants' ? applicants : sourced

  const filtered = visibleSet.filter(c => {
    if (!search) return true
    const q = search.toLowerCase().trim()
    return (
      c.full_name?.toLowerCase().includes(q) ||
      c.role?.toLowerCase().includes(q) ||
      c.location?.toLowerCase().includes(q) ||
      c.email?.toLowerCase().includes(q) ||
      c.phone?.toLowerCase().includes(q) ||
      c.initials?.toLowerCase().includes(q)
    )
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div className="page-header" style={{ paddingBottom: 12, flexShrink: 0 }}>
        <div className="flex items-center justify-between" style={{ marginBottom: sectionGap, flexWrap: 'wrap', gap: 10 }}>
          <div className="flex items-center gap-16">
            <button onClick={onBack} style={{
              background: 'var(--surface-2)', border: 'none', borderRadius: 10,
              padding: '7px 14px', cursor: 'pointer', color: 'var(--text-2)',
              display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 500,
            }}>
              {iconChevronLeft} {tj.back}
            </button>
            <div>
              <h1 className="page-title" style={{ marginBottom: 2 }}>{job.title}</h1>
              <p className="t-11 c-3">
                {[
                  job.location,
                  (job.salary_min || job.salary_max)
                    ? (job.salary_min === job.salary_max
                        ? `${job.salary_min?.toLocaleString()} UAH`
                        : `${(job.salary_min || 0).toLocaleString()}–${(job.salary_max || 0).toLocaleString()} UAH`)
                    : null,
                  tp.totalCount(candidates.length),
                ].filter(Boolean).join(' · ')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-8">
            <button className="btn btn-secondary" onClick={exportCSV} style={{ fontSize: 11 }}>
              {tj.exportCSV}
            </button>
            {sourceTab === 'sourced' && (
              <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
                {tj.addCandidate}
              </button>
            )}
          </div>
        </div>

        {/* Salary intelligence banner */}
        <div style={{ marginBottom: sectionGap }}>
          <SalaryBanner jobId={job.id} state={salary} />
        </div>

        {/* Source tabs + view-mode toggle */}
        <div style={{
          display: 'flex', gap: 0, marginBottom: sectionGap, alignItems: 'flex-end',
          borderBottom: '1px solid var(--border)',
        }}>
          {([
            ['applicants', tp.applicants, applicants.length],
            ['sourced',    tp.sourced,    sourced.length],
          ] as const).map(([id, label, n]) => (
            <button
              key={id}
              onClick={() => setSourceTab(id)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                padding: '8px 18px', fontSize: 13, fontWeight: 500,
                color: sourceTab === id ? 'var(--accent)' : 'var(--text-3)',
                borderBottom: sourceTab === id ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: -1, display: 'flex', alignItems: 'center', gap: 6,
                transition: 'color 120ms',
              }}>
              {label}
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 10,
                background: sourceTab === id ? 'var(--accent)' : 'var(--surface-2)',
                color:      sourceTab === id ? '#fff' : 'var(--text-3)',
              }}>{n}</span>
            </button>
          ))}
          {/* view-mode toggle — Grid / Kanban */}
          <div style={{
            marginLeft: 'auto', marginBottom: 6, display: 'flex',
            border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden',
          }}>
            {(['grid', 'kanban'] as const).map(m => (
              <button
                key={m} onClick={() => setView(m)}
                style={{
                  padding: '5px 12px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
                  background: viewMode === m ? 'var(--accent)' : 'var(--surface)',
                  color: viewMode === m ? '#fff' : 'var(--text-2)',
                }}
              >{m === 'grid' ? T[uiLang].kanban.grid : T[uiLang].kanban.board}</button>
            ))}
          </div>
        </div>

        {/* Search bar */}
        <div className="flex items-center gap-12" style={{ flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', width: 360, maxWidth: '100%' }}>
            <svg
              width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
              strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
              style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)', pointerEvents: 'none' }}
            >
              <circle cx="7" cy="7" r="5" /><path d="M11 11l3 3" />
            </svg>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={tp.searchPlaceholder}
              style={{
                width: '100%', padding: '9px 36px 9px 36px', fontSize: 13,
                borderRadius: 22, border: '1px solid var(--border)',
                background: 'var(--surface)', outline: 'none', boxSizing: 'border-box',
                transition: 'border-color 150ms, box-shadow 150ms',
              }}
              onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(34, 139, 86, 0.12)' }}
              onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.boxShadow = 'none' }}
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                title="Effacer"
                style={{
                  position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                  background: 'var(--surface-2)', border: 'none', borderRadius: '50%',
                  width: 20, height: 20, cursor: 'pointer', color: 'var(--text-2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12,
                }}
              >×</button>
            )}
          </div>
          {search && (
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
              {filtered.length} / {candidates.length}
            </span>
          )}
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center gap-8" style={{ padding: 32 }}>
          <span className="spinner" /><span className="c-2">{tj.loading}</span>
        </div>
      ) : candidates.length === 0 ? (
        <div className="empty-state">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3, marginBottom: 4 }}>
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
          </svg>
          <p className="t-13 c-2">{tj.noCandidates}</p>
          <p className="t-12 c-3">{tj.noCandidatesHint}</p>
        </div>
      ) : viewMode === 'kanban' ? (
        /* ── Kanban view ── */
        <KanbanView
          candidates={filtered}
          t={T[uiLang].kanban}
          onCardClick={setSelectedCandidate}
          onMoved={updated => setCandidates(prev => prev.map(x => x.id === updated.id ? updated : x))}
        />
      ) : filtered.length === 0 ? (
        <div className="empty-state"><p className="t-13 c-2">{tp.noMatch}</p></div>
      ) : (
        /* ── Grid view ── */
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12,
          overflowY: 'auto', paddingBottom: 8,
        }}>
          {filtered.map(c => (
            <PipelineCard
              key={c.id}
              candidate={c}
              job={job}
              salary={salary.analysis ?? undefined}
              onDelete={deleteCandidate}
              onClick={() => setSelectedCandidate(c)}
              onStageAdvance={advanceStage}
              onUpdate={updated => setCandidates(prev => prev.map(x => x.id === updated.id ? updated : x))}
            />
          ))}
        </div>
      )}

      {showAdd && (
        <AddCandidatePanel
          job={job}
          onAdd={newOnes => { addCandidates(newOnes) }}
          onClose={() => setShowAdd(false)}
        />
      )}

      {showRobotaSync && (
        <RobotaSyncModal
          job={job}
          onClose={() => setShowRobotaSync(false)}
          onImported={() => {
            api.candidates.list(job.id).then(r => { if (r.data) setCandidates(r.data) })
          }}
        />
      )}

      {selectedCandidate && (
        <CandidateModal
          candidate={selectedCandidate}
          job={job}
          salary={salary.analysis ?? undefined}
          salaryMeta={salary.meta ?? undefined}
          onClose={() => setSelectedCandidate(null)}
          onUpdate={updated => {
            setCandidates(prev => prev.map(c => c.id === updated.id ? updated : c))
            setSelectedCandidate(updated)
          }}
          onDelete={id => { deleteCandidate(id); setSelectedCandidate(null) }}
        />
      )}
    </div>
  )
}
