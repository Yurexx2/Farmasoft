import { useState } from 'react'
import { api, Job, PublicationFailure } from '../../api/client'

interface Props {
  job: Job
  onClose: () => void
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 8, fontSize: 13,
  border: '1px solid var(--border)', background: 'var(--surface-2)', boxSizing: 'border-box',
}

export function PublishModal({ job, onClose }: Props) {
  const [publishType, setPublishType] = useState('Business')
  const [workTypes, setWorkTypes] = useState<string[]>(['Office'])
  const [employmentTypes, setEmploymentTypes] = useState<string[]>(['FullTime'])
  const [contactEmail, setContactEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ success: boolean; robota_vacancy_id?: number } | null>(null)
  const [error, setError] = useState('')
  const [failure, setFailure] = useState<PublicationFailure | null>(null)

  function toggleArr(arr: string[], val: string, set: (v: string[]) => void) {
    set(arr.includes(val) ? arr.filter(x => x !== val) : [...arr, val])
  }

  async function handlePublish() {
    setLoading(true); setError(''); setFailure(null)
    const r = await api.robota.publishVacancy(job.id, {
      publish_type: publishType,
      contact_email: contactEmail || undefined,
      work_types: workTypes,
      employment_types: employmentTypes,
    })
    setLoading(false)
    if (r.publication_failure) setFailure(r.publication_failure)
    if (r.error) { setError(r.error); return }
    if (r.data) setResult(r.data)
  }

  async function handleRetry() {
    setLoading(true); setError(''); setFailure(null)
    const r = await api.robota.retryPublish(job.id)
    setLoading(false)
    if (r.publication_failure) setFailure(r.publication_failure)
    if (r.error) { setError(r.error); return }
    if (r.data) setResult(r.data)
  }

  function openBuyCreditsTab() {
    window.open('https://employer.robota.ua/my/services', '_blank', 'noopener,noreferrer')
  }

  const WORK_TYPES   = [{ id: 'Office', label: 'Bureau' }, { id: 'Remote', label: 'Télétravail' }, { id: 'Hybrid', label: 'Hybride' }]
  const EMP_TYPES    = [{ id: 'FullTime', label: 'Plein temps' }, { id: 'PartTime', label: 'Partiel' }, { id: 'ProjectBased', label: 'Projet' }]
  const PUB_TYPES    = ['Business', 'Optimum', 'Professional', 'Anonym']

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--surface)', borderRadius: 16, padding: '28px 32px', width: 460, maxWidth: '95vw', boxShadow: '0 8px 40px rgba(0,0,0,0.18)' }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Publier sur robota.ua</div>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>{job.title}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--text-3)' }}>✕</button>
        </div>

        {result ? (
          <div>
            <div style={{ padding: '16px', borderRadius: 10, background: '#D0F0E4', color: '#2E9460', textAlign: 'center', marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>Publié avec succès !</div>
              <div style={{ fontSize: 12 }}>ID robota.ua : <strong>{result.robota_vacancy_id}</strong></div>
              <div style={{ fontSize: 11, marginTop: 4, color: '#2E9460' }}>
                Le sync automatique est maintenant actif pour ce poste.
              </div>
            </div>
            <button onClick={onClose} style={{
              width: '100%', padding: '10px', borderRadius: 10, background: 'var(--accent)',
              color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600,
            }}>Fermer</button>
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--text-2)' }}>Type de publication</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {PUB_TYPES.map(t => (
                  <button key={t} onClick={() => setPublishType(t)} style={{
                    flex: 1, padding: '6px 4px', borderRadius: 8, fontSize: 11, fontWeight: 500,
                    border: `1.5px solid ${publishType === t ? 'var(--accent)' : 'var(--border)'}`,
                    background: publishType === t ? 'var(--accent-bg, #EBF3FF)' : 'var(--surface-2)',
                    color: publishType === t ? 'var(--accent)' : 'var(--text-2)',
                    cursor: 'pointer',
                  }}>{t}</button>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--text-2)' }}>Mode de travail</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {WORK_TYPES.map(t => (
                  <button key={t.id} onClick={() => toggleArr(workTypes, t.id, setWorkTypes)} style={{
                    flex: 1, padding: '6px 4px', borderRadius: 8, fontSize: 11, fontWeight: 500,
                    border: `1.5px solid ${workTypes.includes(t.id) ? 'var(--accent)' : 'var(--border)'}`,
                    background: workTypes.includes(t.id) ? 'var(--accent-bg, #EBF3FF)' : 'var(--surface-2)',
                    color: workTypes.includes(t.id) ? 'var(--accent)' : 'var(--text-2)',
                    cursor: 'pointer',
                  }}>{t.label}</button>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--text-2)' }}>Type d'emploi</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {EMP_TYPES.map(t => (
                  <button key={t.id} onClick={() => toggleArr(employmentTypes, t.id, setEmploymentTypes)} style={{
                    flex: 1, padding: '6px 4px', borderRadius: 8, fontSize: 11, fontWeight: 500,
                    border: `1.5px solid ${employmentTypes.includes(t.id) ? 'var(--accent)' : 'var(--border)'}`,
                    background: employmentTypes.includes(t.id) ? 'var(--accent-bg, #EBF3FF)' : 'var(--surface-2)',
                    color: employmentTypes.includes(t.id) ? 'var(--accent)' : 'var(--text-2)',
                    cursor: 'pointer',
                  }}>{t.label}</button>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 18 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--text-2)' }}>
                Email de réception des candidatures (optionnel)
              </label>
              <input value={contactEmail} onChange={e => setContactEmail(e.target.value)}
                placeholder="hr@votrecompany.com (utilise le compte robota.ua par défaut)"
                style={inputStyle} />
            </div>

            {failure?.kind === 'insufficient_credits' ? (
              <div style={{
                padding: '12px 14px', borderRadius: 10, background: '#FEF3C7',
                border: '1px solid #FCD34D', marginBottom: 12,
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#78350F', marginBottom: 4 }}>
                  Pas assez de crédits sur robota.ua
                </div>
                <div style={{ fontSize: 12, color: '#92400E', lineHeight: 1.5, marginBottom: 10 }}>
                  Votre compte robota.ua n'a plus d'unités de publication
                  {failure.publicationType ? <> de type « <strong>{failure.publicationType}</strong> »</> : null}.
                  L'annonce <strong>est créée</strong> côté robota
                  {failure.robota_vacancy_id ? <> (ID {failure.robota_vacancy_id})</> : null}
                  {' '}— il suffit de recharger puis de cliquer Retry, pas besoin de tout refaire.
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={openBuyCreditsTab} style={{
                    flex: 1, padding: '9px 12px', borderRadius: 8,
                    background: '#0E7C57', color: '#fff',
                    border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 12,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  }}>
                    Recharger sur robota.ua
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M6 3h7v7M13 3L5 11M3 6v7h7" />
                    </svg>
                  </button>
                  <button onClick={handleRetry} disabled={loading} style={{
                    flex: 1, padding: '9px 12px', borderRadius: 8,
                    background: 'var(--surface-2)', color: 'var(--text-1)',
                    border: '1px solid var(--border)', cursor: loading ? 'wait' : 'pointer', fontWeight: 600, fontSize: 12,
                  }}>
                    {loading ? 'Retry…' : 'Retry publication'}
                  </button>
                </div>
              </div>
            ) : error ? (
              <div style={{ padding: '8px 12px', borderRadius: 8, background: '#FFE5E5', color: '#C0392B', fontSize: 12, marginBottom: 12 }}>{error}</div>
            ) : null}

            <button onClick={handlePublish} disabled={loading} style={{
              width: '100%', padding: '11px', borderRadius: 10, background: 'var(--accent)',
              color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13,
            }}>
              {loading ? 'Publication en cours...' : 'Publier sur robota.ua'}
            </button>

            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-3)', textAlign: 'center' }}>
              Le titre, la description et le salaire sont synchronisés depuis Farmasoft.
              Après publication, le sync automatique démarre.
            </div>
          </>
        )}
      </div>
    </div>
  )
}
