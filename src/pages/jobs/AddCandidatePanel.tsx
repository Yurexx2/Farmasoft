import { useEffect, useRef, useState } from 'react'
import { api, Candidate, CreditsInfo, Job } from '../../api/client'
import { useAppStore } from '../../store/useAppStore'
import { T } from '../../i18n'
import { iconClose, iconUpload } from './icons'
import { useIsMobile } from '../../hooks/useIsMobile'

const POPULAR_CITIES = [
  { id: 1,  name: 'Київ' },     { id: 2,  name: 'Харків' }, { id: 21, name: 'Львів' },
  { id: 3,  name: 'Одеса' },    { id: 4,  name: 'Дніпро' }, { id: 9,  name: 'Запоріжжя' },
  { id: 10, name: 'Вінниця' },  { id: 16, name: 'Полтава' },{ id: 6,  name: 'Донецьк' },
]


// Map job.experience_years to the closest robota.ua experienceId
function yearsToExperienceId(y: number | null | undefined): number | undefined {
  if (y == null || y < 0) return undefined
  if (y === 0) return 0
  if (y === 1) return 1
  if (y <= 2) return 2
  if (y <= 5) return 3
  return 3
}

export function AddCandidatePanel({ job, onAdd, onClose }: {
  job: Job
  onAdd: (candidates: Candidate[]) => void
  onClose: () => void
}) {
  const { uiLang } = useAppStore()
  const isMobile = useIsMobile()
  const tap = T[uiLang].jobs.addPanel
  const [mode, setMode] = useState<'cvSearch' | 'cvImport'>('cvSearch')

  const EXPERIENCE_OPTIONS = [
    { label: tap.expAny,  value: undefined },
    { label: tap.expNone, value: 0 },
    { label: tap.exp1,    value: 1 },
    { label: tap.exp2,    value: 2 },
    { label: tap.exp5,    value: 3 },
  ]

  // CV Search state — pre-filled from the position
  const [keywords, setKeywords] = useState(job.title || '')
  const [cityId, setCityId] = useState<number>(job.city_id || POPULAR_CITIES.find(c => c.name === job.location)?.id || 1)
  const [salaryFrom, setSalaryFrom] = useState<string>(job.salary_min ? String(job.salary_min) : '')
  const [salaryTo, setSalaryTo] = useState<string>(job.salary_max ? String(job.salary_max) : '')
  const [experienceId, setExperienceId] = useState<number | undefined>(yearsToExperienceId(job.experience_years))
  const [count, setCount] = useState(20)
  const [page, setPage] = useState(0)
  const [total, setTotal] = useState<number | null>(null)
  const [results, setResults] = useState<Candidate[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [credits, setCredits] = useState<CreditsInfo | null>(null)
  const [openingId, setOpeningId] = useState<number | null>(null)

  // CV Import (PDF) state
  const [dragging, setDragging] = useState(false)
  const [parsing, setParsing] = useState(false)
  const [parseError, setParseError] = useState('')
  const [parsedFile, setParsedFile] = useState<string>('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.robota.credits().then(r => { if (r.data) setCredits(r.data) })
  }, [])

  async function refreshCredits() {
    const r = await api.robota.credits()
    if (r.data) setCredits(r.data)
  }

  async function search(p = 0) {
    if (!keywords.trim()) { setSearchError(tap.keywordsRequired); return }
    setSearching(true); setSearchError(''); setPage(p)
    const r = await api.robota.cvdbSearch({
      keywords, cityId,
      salaryFrom: salaryFrom ? parseInt(salaryFrom) : undefined,
      salaryTo:   salaryTo   ? parseInt(salaryTo)   : undefined,
      experienceId, count, page: p, jobId: job.id,
    })
    setSearching(false)
    if (r.error) { setSearchError(r.error); return }
    if (r.data?.candidates) {
      const newList = p === 0 ? r.data.candidates : [...results, ...r.data.candidates]
      setResults(newList)
      setTotal(r.data.total ?? null)
      onAdd(r.data.candidates)
    }
  }

  async function openCv(c: Candidate) {
    const m = c.profile_url?.match(/\/cv\/(\d+)/)
    const resumeId = m ? parseInt(m[1]) : null
    if (!resumeId) { alert(tap.cvIdNotFound); return }
    if (!credits || credits.available <= 0) {
      alert(tap.noCredits)
      return
    }
    if (!confirm(tap.confirmOpenCv(credits.available - 1))) return

    setOpeningId(c.id)
    const r = await api.robota.openCv(resumeId, job.id)
    setOpeningId(null)
    if (r.error) { alert('Error: ' + r.error); return }
    if (r.data) {
      setResults(results.map(x => x.id === c.id ? r.data! : x))
      onAdd([r.data])
      await refreshCredits()
    }
  }

  async function handleFile(file: File) {
    if (!file) return
    setParsing(true); setParseError(''); setParsedFile(file.name)

    const mimeType = file.type || (file.name.endsWith('.pdf') ? 'application/pdf' : 'text/plain')

    const reader = new FileReader()
    reader.onload = async (e) => {
      try {
        let content: string
        if (mimeType === 'application/pdf') {
          const arr = e.target?.result as ArrayBuffer
          const bytes = new Uint8Array(arr)
          let binary = ''
          for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
          content = btoa(binary)
        } else {
          content = e.target?.result as string
        }

        const res = await api.cv.parse(file.name, content, mimeType, job.id)
        if (res.error) { setParseError(res.error); setParsing(false); return }
        if (res.data) { onAdd([res.data]); onClose() }
      } catch (err) {
        setParseError((err as Error).message)
      }
      setParsing(false)
    }

    if (mimeType === 'application/pdf') reader.readAsArrayBuffer(file)
    else reader.readAsText(file)
  }

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0,
      width: isMobile ? '100%' : 480,
      background: 'var(--surface)', boxShadow: 'var(--shadow-lg)',
      display: 'flex', flexDirection: 'column', zIndex: 100,
    }}>
      {/* Header */}
      <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div className="flex items-center justify-between mb-16">
          <h3 className="t-15 medium">{tap.title}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: 4 }}>{iconClose}</button>
        </div>
        <div style={{ display: 'flex', gap: 0, background: 'var(--surface-2)', borderRadius: 10, padding: 3 }}>
          {[['cvSearch', tap.modeSearchCv], ['cvImport', tap.modeCV]].map(([v, l]) => (
            <button key={v} onClick={() => setMode(v as 'cvSearch' | 'cvImport')} style={{
              flex: 1, background: mode === v ? 'var(--surface)' : 'none',
              border: 'none', borderRadius: 8, padding: '7px 0', fontSize: 12,
              fontWeight: 500, cursor: 'pointer', color: mode === v ? 'var(--text-1)' : 'var(--text-2)',
              boxShadow: mode === v ? 'var(--shadow-sm)' : 'none',
            }}>{l}</button>
          ))}
        </div>
        {credits && mode === 'cvSearch' && (
          <div style={{
            marginTop: 12, padding: '8px 12px', background: '#EFF6FF', border: '1px solid #BFDBFE',
            borderRadius: 8, fontSize: 11, color: '#1D4ED8',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>{tap.creditsAvailable(credits.available)}</span>
            {credits.expiresAt && (
              <span style={{ color: '#6B7280' }}>
                {tap.creditsExpires(new Date(credits.expiresAt).toLocaleDateString(T[uiLang].locale))}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>

        {mode === 'cvSearch' && (
          <div>
            <div style={{ marginBottom: 12 }}>
              <label className="form-label">{tap.keywords}</label>
              <input
                className="form-input"
                value={keywords}
                onChange={e => setKeywords(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && search(0)}
                placeholder={tap.keywordsPlaceholder}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
              <div>
                <label className="form-label">{tap.city}</label>
                <select className="form-input" value={cityId} onChange={e => setCityId(+e.target.value)}>
                  {POPULAR_CITIES.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="form-label">{tap.experience}</label>
                <select className="form-input" value={experienceId ?? ''} onChange={e => setExperienceId(e.target.value !== '' ? +e.target.value : undefined)}>
                  {EXPERIENCE_OPTIONS.map(o => (
                    <option key={String(o.value)} value={o.value ?? ''}>{o.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
              <div>
                <label className="form-label">{tap.salaryMin}</label>
                <input className="form-input" type="number" value={salaryFrom} onChange={e => setSalaryFrom(e.target.value)} placeholder="15000" />
              </div>
              <div>
                <label className="form-label">{tap.salaryMax}</label>
                <input className="form-input" type="number" value={salaryTo} onChange={e => setSalaryTo(e.target.value)} placeholder="40000" />
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label className="form-label">{tap.numResults}</label>
              <input
                className="form-input"
                type="number"
                min={1}
                max={500}
                value={count}
                onChange={e => {
                  const v = parseInt(e.target.value)
                  if (isNaN(v)) setCount(1)
                  else setCount(Math.min(Math.max(v, 1), 500))
                }}
                placeholder={tap.numResultsPlaceholder}
              />
            </div>

            {searchError && <p style={{ color: 'var(--err)', fontSize: 12, marginBottom: 12 }}>{searchError}</p>}

            <button
              className="btn btn-primary"
              onClick={() => search(0)}
              disabled={searching || !keywords}
              style={{ width: '100%' }}
            >
              {searching
                ? <span className="spinner" />
                : <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="6.5" cy="6.5" r="4.5"/><line x1="10.5" y1="10.5" x2="14" y2="14"/>
                  </svg>
              }
              {searching ? tap.searching : tap.searchCvBtn}
            </button>

            {results.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="flex items-center justify-between mb-12">
                  <p className="t-12 c-2" style={{ margin: 0 }}>
                    {total !== null
                      ? tap.shownOutOf(results.length, total.toLocaleString())
                      : tap.candidatesCount(results.length)}
                  </p>
                  {total !== null && results.length < total && (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => search(page + 1)}
                      disabled={searching}
                      style={{ fontSize: 11 }}
                    >
                      {searching ? '…' : tap.loadMore}
                    </button>
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {results.map(c => {
                    const isOpened = (() => {
                      try {
                        const pd = c.profile_data ? JSON.parse(c.profile_data) : null
                        return !!pd?.isFullyOpened
                      } catch { return false }
                    })()
                    return (
                      <div key={c.id} style={{
                        padding: 10, borderRadius: 10,
                        background: 'var(--surface)',
                        border: `1px solid ${isOpened ? '#86EFAC' : 'var(--border)'}`,
                        display: 'flex', gap: 10, alignItems: 'center',
                      }}>
                        {c.photo_url ? (
                          <img src={c.photo_url} alt=""
                            style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
                            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                        ) : (
                          <div style={{
                            width: 36, height: 36, borderRadius: '50%', background: 'var(--surface-2)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 11, fontWeight: 600, flexShrink: 0,
                          }}>{c.initials || '?'}</div>
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="t-12 medium truncate">{c.full_name || c.role}</div>
                          <div className="t-11 c-3 truncate">
                            {c.full_name ? c.role : c.location || '—'}
                            {c.salary_expectation > 0 && ` · ${c.salary_expectation.toLocaleString()} UAH`}
                            {c.experience_years > 0 && ` · ${c.experience_years} ${tap.yrShort}`}
                          </div>
                        </div>
                        {isOpened ? (
                          <span style={{
                            fontSize: 9, fontWeight: 700, padding: '3px 7px', borderRadius: 4,
                            background: '#DCFCE7', color: '#15803D', flexShrink: 0,
                          }}>{tap.opened}</span>
                        ) : (
                          <button
                            onClick={() => openCv(c)}
                            disabled={openingId === c.id || !credits || credits.available <= 0}
                            style={{
                              fontSize: 11, padding: '5px 10px', borderRadius: 6, fontWeight: 600,
                              background: 'var(--accent)', color: '#fff', border: 'none',
                              cursor: 'pointer', flexShrink: 0,
                              opacity: !credits || credits.available <= 0 ? 0.5 : 1,
                            }}>
                            {openingId === c.id ? '…' : tap.openOne}
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {mode === 'cvImport' && (
          <div>
            <p className="t-12 c-2 mb-20">{tap.cvImportHint}</p>

            <div
              onDragOver={e => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: `2px dashed ${dragging ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 12, padding: '40px 20px', textAlign: 'center', cursor: 'pointer',
                background: dragging ? 'var(--accent)11' : 'var(--surface-2)',
                transition: 'border-color 150ms ease, background 150ms ease',
                marginBottom: 16,
              }}>
              <div style={{ color: 'var(--text-3)', marginBottom: 8 }}>{iconUpload}</div>
              <div className="t-13 medium mb-4">{tap.dropCV}</div>
              <div className="t-11 c-3">{tap.orClick}</div>
              <div className="t-11 c-3 mt-8">{tap.pdfSupported}</div>
            </div>

            <input ref={fileInputRef} type="file" accept=".pdf,.txt" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />

            {parsing && (
              <div className="flex items-center gap-10">
                <span className="spinner" />
                <span className="t-12 c-2">{tap.parsing(parsedFile)}</span>
              </div>
            )}

            {parseError && <p style={{ color: 'var(--err)', fontSize: 12 }}>{parseError}</p>}
          </div>
        )}
      </div>

      <div style={{ padding: '12px 24px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        <p className="t-10 c-3">{tap.disclaimer}</p>
      </div>
    </div>
  )
}
