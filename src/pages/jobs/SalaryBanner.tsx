import { useEffect, useState, useCallback } from 'react'
import { api, SalaryAnalysis, SalaryCacheMeta } from '../../api/client'
import { useAppStore } from '../../store/useAppStore'
import { T } from '../../i18n'
import { useIsMobile } from '../../hooks/useIsMobile'

export interface JobSalaryState {
  analysis: SalaryAnalysis | null
  meta: SalaryCacheMeta | null
  loading: boolean
  refreshing: boolean
  error: string
  refresh: () => Promise<void>
}

export function useJobSalary(jobId: number): JobSalaryState {
  const [analysis, setAnalysis] = useState<SalaryAnalysis | null>(null)
  const [meta, setMeta] = useState<SalaryCacheMeta | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')

  const fetchCached = useCallback(async () => {
    setLoading(true); setError('')
    const r = await api.salary.forJob(jobId)
    setLoading(false)
    if (r.error) { setError(r.error); return }
    if (r.data) { setAnalysis(r.data.analysis); setMeta(r.data.meta) }
    else { setAnalysis(null); setMeta(null) }
  }, [jobId])

  const refresh = useCallback(async () => {
    setRefreshing(true); setError('')
    const r = await api.salary.refreshJob(jobId)
    setRefreshing(false)
    if (r.error) { setError(r.error); return }
    if (r.data) { setAnalysis(r.data.analysis); setMeta(r.data.meta) }
  }, [jobId])

  useEffect(() => { fetchCached() }, [fetchCached])

  return { analysis, meta, loading, refreshing, error, refresh }
}

const fmtUAH = (n: number) =>
  n >= 1000 ? `${Math.round(n / 1000).toLocaleString('en-US')}k ₴` : `${Math.round(n)} ₴`
const fmtFull = (n: number) => `${Math.round(n).toLocaleString('en-US')} ₴`

function timeAgo(iso: string, ts: typeof T.en.salary): string {
  const t = new Date(iso.replace(' ', 'T') + 'Z').getTime()
  const h = (Date.now() - t) / (3600 * 1000)
  if (h < 1) return ts.justNow
  if (h < 24) return ts.hoursAgo(Math.round(h))
  const d = Math.round(h / 24)
  return d === 1 ? ts.yesterday : ts.daysAgo(d)
}

interface Props { jobId: number; state?: JobSalaryState }

export function SalaryBanner({ jobId, state: stateProp }: Props) {
  const { uiLang } = useAppStore()
  const ts = T[uiLang].salary
  const isMobile = useIsMobile()
  const ownState = useJobSalary(jobId)
  const state = stateProp ?? ownState
  const { analysis, meta, loading, refreshing, error, refresh } = state

  if (loading) {
    return (
      <div style={{
        padding: '10px 14px', background: 'var(--surface)', borderRadius: 10,
        border: '1px solid var(--border)', fontSize: 12, color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span className="spinner" style={{ width: 10, height: 10 }} /> {ts.loading}
      </div>
    )
  }

  if (!analysis || !meta) {
    return (
      <div style={{
        padding: '10px 14px', background: 'var(--surface)', borderRadius: 10,
        border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
          {ts.notAnalyzed}
        </div>
        <button onClick={refresh} disabled={refreshing} style={{
          fontSize: 11, fontWeight: 500, padding: '6px 12px',
          background: refreshing ? 'var(--surface-2)' : 'var(--accent)',
          color: refreshing ? 'var(--text-3)' : '#fff',
          border: 'none', borderRadius: 8, cursor: refreshing ? 'wait' : 'pointer',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          {refreshing ? <><span className="spinner" style={{ width: 10, height: 10 }} /> {ts.analyzing}</> : ts.analyzeBtn}
        </button>
        {error && <div style={{ width: '100%', fontSize: 11, color: '#DC2626' }}>{error}</div>}
      </div>
    )
  }

  const o = analysis.overall
  const c = analysis.collection

  // Compact single-row variant for mobile — keeps the candidate list visible.
  if (isMobile) {
    return (
      <div style={{
        padding: '8px 12px', background: 'var(--surface)', borderRadius: 10,
        border: `1px solid ${meta.stale ? '#FCD34D' : 'var(--border)'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
      }}>
        <div style={{ fontSize: 12, color: 'var(--text-2)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ color: 'var(--text-3)' }}>{ts.marketMedian}: </span>
          <strong style={{ color: 'var(--text-1)' }}>{fmtFull(o.median)}</strong>
          <span style={{ color: 'var(--text-3)' }}> · {fmtUAH(o.p25)}–{fmtUAH(o.p75)}</span>
        </div>
        <button onClick={refresh} disabled={refreshing} title={meta.stale ? ts.tooltipStale : ts.tooltipFresh} style={{
          fontSize: 11, fontWeight: 500, padding: '4px 9px', flexShrink: 0,
          background: meta.stale ? '#FCD34D' : 'var(--surface-2)',
          color: meta.stale ? '#78350F' : 'var(--text-2)',
          border: 'none', borderRadius: 7, cursor: refreshing ? 'wait' : 'pointer',
          display: 'flex', alignItems: 'center', gap: 5,
        }}>
          {refreshing ? <span className="spinner" style={{ width: 10, height: 10 }} /> : ts.refresh}
        </button>
      </div>
    )
  }

  return (
    <div style={{
      padding: '10px 14px', background: 'var(--surface)', borderRadius: 10,
      border: `1px solid ${meta.stale ? '#FCD34D' : 'var(--border)'}`,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 }}>{ts.marketMedian}</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-1)', lineHeight: 1 }}>{fmtFull(o.median)}</div>
        </div>
        <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--border)' }} />
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 }}>{ts.typicalRange}</div>
          <div style={{ fontSize: 13, color: 'var(--text-2)' }}>{fmtUAH(o.p25)} — {fmtUAH(o.p75)}</div>
        </div>
        <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--border)' }} />
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 }}>{ts.sample}</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{ts.activeCvs(c.finalSampleSize)} · {timeAgo(meta.computed_at, ts)}</div>
        </div>
      </div>
      <button onClick={refresh} disabled={refreshing} title={meta.stale ? ts.tooltipStale : ts.tooltipFresh} style={{
        fontSize: 11, fontWeight: 500, padding: '5px 10px',
        background: meta.stale ? '#FCD34D' : 'var(--surface-2)',
        color: meta.stale ? '#78350F' : 'var(--text-2)',
        border: 'none', borderRadius: 8, cursor: refreshing ? 'wait' : 'pointer',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        {refreshing ? <><span className="spinner" style={{ width: 10, height: 10 }} /> {ts.refreshing}</> : (meta.stale ? ts.refreshStale : ts.refresh)}
      </button>
      {error && <div style={{ width: '100%', fontSize: 11, color: '#DC2626' }}>{error}</div>}
    </div>
  )
}
