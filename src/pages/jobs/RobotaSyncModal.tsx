import { useState, useEffect, useCallback, useRef } from 'react'
import { api, Job, RobotaConfig, VacancyStatus, EmployerVacancy, FullSyncProgress } from '../../api/client'

interface Props {
  job: Job
  onClose: () => void
  onImported: () => void
}

type Tab = 'sync' | 'annonces' | 'automation' | 'robota-auth' | 'smtp'

const TAB_LABELS: Record<Tab, string> = {
  sync: 'Sync',
  annonces: 'Mes annonces',
  automation: 'Automatisation',
  'robota-auth': 'robota.ua',
  smtp: 'Email SMTP',
}

const STATE_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  Publicated: { label: 'Active', color: '#2E9460', bg: '#D0F0E4' },
  Paused:     { label: 'En pause', color: '#92400E', bg: '#FFF8EE' },
  Closed:     { label: 'Fermée', color: '#6B7280', bg: '#F3F4F6' },
  Deleted:    { label: 'Supprimée', color: '#C0392B', bg: '#FFE5E5' },
  Unknown:    { label: 'Inconnu', color: '#6B7280', bg: '#F3F4F6' },
}

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 20, fontSize: 11,
      background: ok ? '#D0F0E4' : '#FFE5E5',
      color: ok ? '#2E9460' : '#C0392B',
    }}>{label}</span>
  )
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--text-2)' }}>{label}</label>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>{hint}</div>}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 8, fontSize: 13,
  border: '1px solid var(--border)', background: 'var(--surface-2)', boxSizing: 'border-box',
}

export function RobotaSyncModal({ job, onClose, onImported }: Props) {
  const [tab, setTab] = useState<Tab>('sync')
  const [config, setConfig] = useState<RobotaConfig | null>(null)

  // Sync tab
  const [vacancyId, setVacancyId] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<{ imported: number; outreached: number } | null>(null)
  const [syncError, setSyncError] = useState('')

  // Automation tab
  const [automCfg, setAutomCfg] = useState({ turbosms_token: '', turbosms_sender: 'Farmasoft', calendly_url: '', outreach_score_threshold: '70', followup_days: '3', auto_outreach: 'true' })
  const [automSaving, setAutomSaving] = useState(false)
  const [automMsg, setAutomMsg] = useState('')

  // robota auth
  const [robotaEmail, setRobotaEmail] = useState('')
  const [robotaPassword, setRobotaPassword] = useState('')
  const [authLoading, setAuthLoading] = useState(false)
  const [authMsg, setAuthMsg] = useState('')

  // Annonces tab — Farmasoft-linked vacancies
  const [vacancies, setVacancies] = useState<VacancyStatus[]>([])
  const [vacanciesLoading, setVacanciesLoading] = useState(false)
  const [vacancyAction, setVacancyAction] = useState<Record<number, string>>({})
  const [confirmDelete, setConfirmDelete] = useState<VacancyStatus | null>(null)
  const [confirmDeleteInput, setConfirmDeleteInput] = useState('')

  // Full account sync
  const [employerVacancies, setEmployerVacancies] = useState<EmployerVacancy[] | null>(null)
  const [evLoading, setEvLoading] = useState(false)
  const [evError, setEvError] = useState('')
  const [fullSync, setFullSync] = useState<FullSyncProgress | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // SMTP
  const [smtp, setSmtp] = useState({ host: '', port: '587', user: '', pass: '', from: '' })
  const [smtpSaving, setSmtpSaving] = useState(false)
  const [smtpMsg, setSmtpMsg] = useState('')

  const loadVacancies = useCallback(() => {
    setVacanciesLoading(true)
    api.robota.myVacancies().then(r => {
      if (r.data) setVacancies(r.data)
      setVacanciesLoading(false)
    })
  }, [])

  useEffect(() => {
    api.robota.config().then(r => {
      if (!r.data) return
      setConfig(r.data)
      setAutomCfg(prev => ({
        ...prev,
        calendly_url: r.data!.calendly_url || '',
        outreach_score_threshold: String(r.data!.outreach_score_threshold),
        followup_days: String(r.data!.followup_days),
        auto_outreach: String(r.data!.auto_outreach),
      }))
    })
  }, [])

  useEffect(() => {
    if (tab === 'annonces') {
      loadVacancies()
      // Also check if a full sync is already running
      api.robota.fullSyncStatus().then(r => { if (r.data && r.data.status === 'running') setFullSync(r.data) })
    }
  }, [tab, loadVacancies])

  useEffect(() => () => stopPoll(), [])

  function refreshConfig() {
    api.robota.config().then(r => { if (r.data) setConfig(r.data) })
  }

  function stopPoll() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  async function discoverVacancies() {
    setEvLoading(true); setEvError('')
    const r = await api.robota.employerVacancies()
    setEvLoading(false)
    if (r.error) { setEvError(r.error); return }
    if (r.data) setEmployerVacancies(r.data)
  }

  async function startFullSync() {
    stopPoll()
    setFullSync({ status: 'running', vacanciesTotal: 0, vacanciesDone: 0, candidatesImported: 0, candidatesOutreached: 0, currentVacancy: 'Démarrage...', startedAt: new Date().toISOString(), finishedAt: null })
    await api.robota.fullSync()
    pollRef.current = setInterval(async () => {
      const r = await api.robota.fullSyncStatus()
      if (!r.data) return
      setFullSync(r.data)
      if (r.data.status === 'done' || r.data.status === 'error') {
        stopPoll()
        if (r.data.status === 'done') {
          onImported()
          // Refresh both vacancy lists
          loadVacancies()
          discoverVacancies()
        }
      }
    }, 2000)
  }

  async function handleVacancyState(v: VacancyStatus, state: string) {
    setVacancyAction(prev => ({ ...prev, [v.robota_vacancy_id]: state }))
    const r = await api.robota.vacancyState(v.robota_vacancy_id, state)
    setVacancyAction(prev => ({ ...prev, [v.robota_vacancy_id]: '' }))
    if (r.error) { alert('Erreur : ' + r.error); return }
    loadVacancies()
  }

  async function handleUpdateVacancy(v: VacancyStatus) {
    setVacancyAction(prev => ({ ...prev, [v.robota_vacancy_id]: 'update' }))
    const r = await api.robota.updateVacancy(v.id)
    setVacancyAction(prev => ({ ...prev, [v.robota_vacancy_id]: '' }))
    if (r.error) { alert('Erreur : ' + r.error); return }
    loadVacancies()
  }

  async function handleDeleteVacancy() {
    if (!confirmDelete) return
    if (confirmDeleteInput !== confirmDelete.title) return
    setVacancyAction(prev => ({ ...prev, [confirmDelete.robota_vacancy_id]: 'delete' }))
    const r = await api.robota.deleteVacancy(confirmDelete.robota_vacancy_id)
    setVacancyAction(prev => ({ ...prev, [confirmDelete.robota_vacancy_id]: '' }))
    setConfirmDelete(null)
    setConfirmDeleteInput('')
    if (r.error) { alert('Erreur : ' + r.error); return }
    loadVacancies()
  }

  async function handleSync() {
    setSyncing(true); setSyncError(''); setSyncResult(null)
    const params: { robota_vacancy_id?: number; auto_qualify?: boolean } = {}
    if (vacancyId.trim()) params.robota_vacancy_id = parseInt(vacancyId)
    const r = await api.robota.sync(job.id, params)
    setSyncing(false)
    if (r.error) { setSyncError(r.error); return }
    if (r.data) { setSyncResult(r.data); if (r.data.imported > 0) onImported() }
  }

  async function handleSaveAutomation() {
    setAutomSaving(true); setAutomMsg('')
    const r = await api.robota.saveConfig(automCfg)
    setAutomSaving(false)
    if (r.error) { setAutomMsg('Erreur : ' + r.error); return }
    setAutomMsg('Sauvegardé !')
    refreshConfig()
  }

  async function handleAuth() {
    setAuthLoading(true); setAuthMsg('')
    const r = await api.robota.auth(robotaEmail, robotaPassword)
    setAuthLoading(false)
    if (r.error) { setAuthMsg('Erreur : ' + r.error); return }
    setAuthMsg('Connexion réussie !')
    refreshConfig()
  }

  async function handleSmtp() {
    setSmtpSaving(true); setSmtpMsg('')
    const r = await api.robota.smtpConfig(smtp)
    setSmtpSaving(false)
    if (r.error) { setSmtpMsg('Erreur : ' + r.error); return }
    setSmtpMsg('Sauvegardé !')
    refreshConfig()
  }

  const readyToSync = config?.robota_configured
  const fullyAutomated = config?.robota_configured && config?.calendly_configured && (config?.smtp_configured || config?.turbosms_configured)

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--surface)', borderRadius: 16, padding: '28px 32px', width: 540, maxWidth: '95vw', boxShadow: '0 8px 40px rgba(0,0,0,0.18)', maxHeight: '90vh', overflowY: 'auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>robota.ua — {job.title}</div>
            {config?.last_auto_sync && (
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                Dernier sync auto : {new Date(config.last_auto_sync).toLocaleString('fr-FR')}
              </div>
            )}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--text-3)', lineHeight: 1 }}>✕</button>
        </div>

        {/* Status badges */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
          <StatusBadge ok={!!config?.robota_configured} label={config?.robota_configured ? `robota.ua ✓` : 'robota.ua ✗'} />
          <StatusBadge ok={!!config?.smtp_configured} label={config?.smtp_configured ? 'Email ✓' : 'Email ✗'} />
          <StatusBadge ok={!!config?.turbosms_configured} label={config?.turbosms_configured ? 'SMS ✓' : 'SMS ✗'} />
          <StatusBadge ok={!!config?.calendly_configured} label={config?.calendly_configured ? 'Calendly ✓' : 'Calendly ✗'} />
          {fullyAutomated && <StatusBadge ok label="Machine à RDV active" />}
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border)', marginBottom: 20 }}>
          {(Object.keys(TAB_LABELS) as Tab[]).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '7px 12px',
              fontSize: 12, fontWeight: tab === t ? 600 : 400,
              color: tab === t ? 'var(--accent)' : 'var(--text-3)',
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -1,
            }}>{TAB_LABELS[t]}</button>
          ))}
        </div>

        {/* ── SYNC ── */}
        {tab === 'sync' && (
          <div>
            <Field label="ID de la vacancy robota.ua" hint="Visible dans l'URL robota.ua/vacancy/ID — laisser vide si déjà configuré">
              <input value={vacancyId} onChange={e => setVacancyId(e.target.value)} placeholder="Ex: 9557460" style={inputStyle} />
            </Field>

            {!readyToSync && (
              <div style={{ padding: '10px 14px', borderRadius: 8, background: '#FFF8EE', color: '#92400E', fontSize: 12, marginBottom: 12 }}>
                Configurez d'abord la connexion robota.ua dans l'onglet "robota.ua".
              </div>
            )}

            {syncError && (
              <div style={{ padding: '10px 14px', borderRadius: 8, background: '#FFE5E5', color: '#C0392B', fontSize: 12, marginBottom: 12 }}>{syncError}</div>
            )}

            {syncResult && (
              <div style={{ padding: '12px 14px', borderRadius: 8, background: '#D0F0E4', color: '#2E9460', fontSize: 13, marginBottom: 12 }}>
                {syncResult.imported === 0
                  ? 'Aucune nouvelle candidature.'
                  : <>
                    <strong>{syncResult.imported}</strong> candidat(s) importé(s) et scoré(s)
                    {syncResult.outreached > 0 && <> — <strong>{syncResult.outreached}</strong> contacté(s) automatiquement (score ≥ {config?.outreach_score_threshold})</>}
                    {fullyAutomated && '. Messages envoyés en ukrainien avec lien Calendly.'}
                  </>
                }
              </div>
            )}

            <button onClick={handleSync} disabled={syncing || !readyToSync} style={{
              width: '100%', padding: '11px', borderRadius: 10,
              background: readyToSync ? 'var(--accent)' : 'var(--surface-2)',
              color: readyToSync ? '#fff' : 'var(--text-3)',
              border: 'none', cursor: readyToSync ? 'pointer' : 'default', fontWeight: 600, fontSize: 13,
            }}>
              {syncing ? 'Import + scoring + envoi en cours...' : 'Lancer le sync'}
            </button>

            <div style={{ marginTop: 12, padding: '10px 14px', borderRadius: 8, background: 'var(--surface-2)', fontSize: 11, color: 'var(--text-3)' }}>
              Le sync automatique tourne toutes les <strong>15 min</strong> en arrière-plan pour tous les postes actifs liés à une vacancy robota.ua.
              {config?.auto_outreach && ' Les candidats score ≥ ' + config.outreach_score_threshold + ' reçoivent un message automatique.'}
            </div>
          </div>
        )}

        {/* ── ANNONCES ── */}
        {tab === 'annonces' && (
          <div>

            {/* ── Full sync section ── */}
            <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px', marginBottom: 18, background: 'var(--surface-2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>Sync complet du compte robota.ua</div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                    Découvre toutes vos vacancies, importe tous les candidats, score et contacte automatiquement.
                  </div>
                </div>
                <button
                  onClick={startFullSync}
                  disabled={fullSync?.status === 'running' || !config?.robota_configured}
                  style={{
                    padding: '7px 14px', borderRadius: 8, border: 'none', fontWeight: 600, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
                    background: fullSync?.status === 'running' ? 'var(--surface)' : 'var(--accent)',
                    color: fullSync?.status === 'running' ? 'var(--text-3)' : '#fff',
                  }}>
                  {fullSync?.status === 'running' ? 'En cours...' : 'Lancer'}
                </button>
              </div>

              {fullSync && fullSync.status !== 'idle' && (
                <div>
                  {/* Progress bar */}
                  {fullSync.status === 'running' && fullSync.vacanciesTotal > 0 && (
                    <div style={{ background: 'var(--border)', borderRadius: 4, height: 6, marginBottom: 8 }}>
                      <div style={{
                        background: 'var(--accent)', borderRadius: 4, height: 6,
                        width: `${Math.round((fullSync.vacanciesDone / fullSync.vacanciesTotal) * 100)}%`,
                        transition: 'width 0.4s ease',
                      }} />
                    </div>
                  )}
                  <div style={{ fontSize: 12, color: fullSync.status === 'error' ? '#C0392B' : fullSync.status === 'done' ? '#2E9460' : 'var(--text-2)' }}>
                    {fullSync.status === 'running' && (
                      <>
                        <strong>{fullSync.vacanciesDone}/{fullSync.vacanciesTotal}</strong> vacancies · <strong>{fullSync.candidatesImported}</strong> candidats importés
                        {fullSync.candidatesOutreached > 0 && <> · <strong>{fullSync.candidatesOutreached}</strong> contactés</>}
                        {fullSync.currentVacancy && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>En cours : {fullSync.currentVacancy}</div>}
                      </>
                    )}
                    {fullSync.status === 'done' && (
                      <>Sync terminé · <strong>{fullSync.vacanciesTotal}</strong> vacancies · <strong>{fullSync.candidatesImported}</strong> candidats importés{fullSync.candidatesOutreached > 0 && <> · <strong>{fullSync.candidatesOutreached}</strong> contactés</>}</>
                    )}
                    {fullSync.status === 'error' && <>Erreur : {fullSync.error}</>}
                  </div>
                </div>
              )}
            </div>

            {/* ── Discover all account vacancies ── */}
            <div style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>Toutes les vacancies du compte</div>
                <button onClick={discoverVacancies} disabled={evLoading || !config?.robota_configured}
                  style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 11, cursor: 'pointer', color: 'var(--text-2)', fontWeight: 500 }}>
                  {evLoading ? 'Chargement...' : employerVacancies ? 'Actualiser' : 'Découvrir'}
                </button>
              </div>

              {evError && (
                <div style={{ padding: '10px 12px', borderRadius: 8, background: '#FFE5E5', color: '#C0392B', fontSize: 11, marginBottom: 10 }}>
                  {evError}
                  <div style={{ marginTop: 4, fontStyle: 'italic' }}>Conseil : ouvrez les devtools de robota.ua (F12 → Network) pour identifier l'endpoint exact de liste des vacancies.</div>
                </div>
              )}

              {employerVacancies && employerVacancies.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {employerVacancies.map(v => {
                    const si = STATE_LABELS[v.state] || { label: v.state, color: '#6B7280', bg: '#F3F4F6' }
                    return (
                      <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface-2)' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</div>
                          <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 1 }}>
                            {v.cityName || '—'} · ID {v.id}
                            {v.linked && <span style={{ color: '#2E9460', marginLeft: 6 }}>✓ dans Farmasoft</span>}
                          </div>
                        </div>
                        <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 20, background: si.bg, color: si.color, whiteSpace: 'nowrap' }}>{si.label}</span>
                      </div>
                    )
                  })}
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                    {employerVacancies.filter(v => v.linked).length}/{employerVacancies.length} vacancies liées à Farmasoft. Le sync complet lie automatiquement les autres.
                  </div>
                </div>
              )}

              {employerVacancies && employerVacancies.length === 0 && !evLoading && (
                <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '8px 12px' }}>Aucune vacancy trouvée sur ce compte.</div>
              )}
            </div>

            {/* ── Vacancies managed by Farmasoft ── */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginBottom: 10 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>Gestion des annonces Farmasoft</div>

              {vacanciesLoading ? (
                <div style={{ textAlign: 'center', padding: 16, color: 'var(--text-3)', fontSize: 12 }}>Chargement...</div>
              ) : vacancies.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Aucune annonce publiée via Farmasoft pour l'instant.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {vacancies.map(v => {
                    const stateInfo = STATE_LABELS[v.robota_status || ''] || { label: v.robota_status || '—', color: '#6B7280', bg: '#F3F4F6' }
                    const busy = vacancyAction[v.robota_vacancy_id]
                    const isActive = v.robota_status === 'Publicated'
                    const isPaused = v.robota_status === 'Paused'
                    return (
                      <div key={v.robota_vacancy_id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', background: 'var(--surface-2)' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                          <div>
                            <div style={{ fontWeight: 600, fontSize: 13 }}>{v.robota_name || v.title}</div>
                            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{v.location} · ID {v.robota_vacancy_id}</div>
                          </div>
                          <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 20, whiteSpace: 'nowrap', background: stateInfo.bg, color: stateInfo.color }}>
                            {v.error ? 'Erreur' : stateInfo.label}
                          </span>
                        </div>
                        {v.error && <div style={{ fontSize: 11, color: '#C0392B', marginTop: 6 }}>{v.error}</div>}
                        <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                          {isActive && (
                            <button disabled={!!busy} onClick={() => { if (confirm(`Mettre en pause "${v.title}" sur robota.ua ?`)) handleVacancyState(v, 'Paused') }}
                              style={{ padding: '5px 10px', borderRadius: 7, fontSize: 11, fontWeight: 500, cursor: 'pointer', border: '1px solid var(--border)', background: '#FFF8EE', color: '#92400E' }}>
                              {busy === 'Paused' ? '...' : 'Mettre en pause'}
                            </button>
                          )}
                          {isPaused && (
                            <button disabled={!!busy} onClick={() => { if (confirm(`Republier "${v.title}" sur robota.ua ?`)) handleVacancyState(v, 'Publicated') }}
                              style={{ padding: '5px 10px', borderRadius: 7, fontSize: 11, fontWeight: 500, cursor: 'pointer', border: '1px solid var(--border)', background: '#D0F0E4', color: '#2E9460' }}>
                              {busy === 'Publicated' ? '...' : 'Republier'}
                            </button>
                          )}
                          <button disabled={!!busy} onClick={() => { if (confirm(`Mettre à jour "${v.title}" sur robota.ua ?`)) handleUpdateVacancy(v) }}
                            style={{ padding: '5px 10px', borderRadius: 7, fontSize: 11, fontWeight: 500, cursor: 'pointer', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-2)' }}>
                            {busy === 'update' ? '...' : 'Mettre à jour'}
                          </button>
                          <button disabled={!!busy} onClick={() => { setConfirmDelete(v); setConfirmDeleteInput('') }}
                            style={{ padding: '5px 10px', borderRadius: 7, fontSize: 11, fontWeight: 500, cursor: 'pointer', border: '1px solid #FFB3B3', background: '#FFE5E5', color: '#C0392B', marginLeft: 'auto' }}>
                            {busy === 'delete' ? '...' : 'Supprimer'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              <button onClick={loadVacancies} style={{ marginTop: 12, width: '100%', padding: '7px', borderRadius: 8, background: 'none', border: '1px solid var(--border)', cursor: 'pointer', fontSize: 11, color: 'var(--text-2)' }}>
                Actualiser
              </button>
            </div>

            {/* Delete confirmation modal */}
            {confirmDelete && (
              <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}>
                <div style={{ background: 'var(--surface)', borderRadius: 12, padding: '24px 28px', width: 380, maxWidth: '92vw', boxShadow: '0 8px 40px rgba(0,0,0,0.2)' }}>
                  <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8 }}>Supprimer l'annonce ?</div>
                  <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 16 }}>
                    Supprime définitivement <strong>"{confirmDelete.title}"</strong> (ID {confirmDelete.robota_vacancy_id}) sur robota.ua. Les candidats importés restent dans Farmasoft.
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 6 }}>Tapez le titre exact pour confirmer :</div>
                  <input value={confirmDeleteInput} onChange={e => setConfirmDeleteInput(e.target.value)} placeholder={confirmDelete.title} style={{ ...inputStyle, marginBottom: 14 }} />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => { setConfirmDelete(null); setConfirmDeleteInput('') }}
                      style={{ flex: 1, padding: '9px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', cursor: 'pointer', fontSize: 13 }}>
                      Annuler
                    </button>
                    <button disabled={confirmDeleteInput !== confirmDelete.title} onClick={handleDeleteVacancy}
                      style={{ flex: 1, padding: '9px', borderRadius: 8, border: 'none', background: confirmDeleteInput === confirmDelete.title ? '#C0392B' : '#FFB3B3', color: '#fff', cursor: confirmDeleteInput === confirmDelete.title ? 'pointer' : 'default', fontWeight: 600, fontSize: 13 }}>
                      Supprimer définitivement
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── AUTOMATION ── */}
        {tab === 'automation' && (
          <div>
            <Field label="Lien Calendly" hint="Inclus automatiquement dans chaque SMS et email envoyé">
              <input value={automCfg.calendly_url} onChange={e => setAutomCfg(p => ({ ...p, calendly_url: e.target.value }))}
                placeholder="https://calendly.com/votre-lien" style={inputStyle} />
            </Field>

            <Field label="TurboSMS — Token API" hint="Disponible sur turbosms.ua dans votre compte">
              <input type="password" value={automCfg.turbosms_token} onChange={e => setAutomCfg(p => ({ ...p, turbosms_token: e.target.value }))}
                placeholder="Token TurboSMS" style={inputStyle} />
            </Field>

            <Field label="Nom expéditeur SMS" hint="11 caractères max, alphanumérique (ex: Farmasoft)">
              <input value={automCfg.turbosms_sender} onChange={e => setAutomCfg(p => ({ ...p, turbosms_sender: e.target.value }))}
                placeholder="Farmasoft" style={inputStyle} />
            </Field>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Score minimum pour contact" hint="0–100">
                <input type="number" value={automCfg.outreach_score_threshold} onChange={e => setAutomCfg(p => ({ ...p, outreach_score_threshold: e.target.value }))}
                  min="0" max="100" style={inputStyle} />
              </Field>
              <Field label="Relance après (jours)" hint="Sans réponse">
                <input type="number" value={automCfg.followup_days} onChange={e => setAutomCfg(p => ({ ...p, followup_days: e.target.value }))}
                  min="1" max="14" style={inputStyle} />
              </Field>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', marginBottom: 16 }}>
              <input type="checkbox" checked={automCfg.auto_outreach === 'true'}
                onChange={e => setAutomCfg(p => ({ ...p, auto_outreach: e.target.checked ? 'true' : 'false' }))} />
              Envoi automatique activé (SMS + email au score ≥ seuil)
            </label>

            {automMsg && (
              <div style={{ padding: '8px 12px', borderRadius: 8, fontSize: 12, marginBottom: 10,
                background: automMsg.startsWith('Erreur') ? '#FFE5E5' : '#D0F0E4',
                color: automMsg.startsWith('Erreur') ? '#C0392B' : '#2E9460' }}>{automMsg}</div>
            )}

            <button onClick={handleSaveAutomation} disabled={automSaving} style={{
              width: '100%', padding: '10px', borderRadius: 10, background: 'var(--accent)',
              color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13,
            }}>
              {automSaving ? 'Sauvegarde...' : 'Sauvegarder'}
            </button>

            <div style={{ marginTop: 12, padding: '10px 14px', borderRadius: 8, background: 'var(--surface-2)', fontSize: 11, color: 'var(--text-3)' }}>
              Les messages sont générés en <strong>ukrainien</strong> par IA (Gemini) avec le prénom, le poste, et votre lien Calendly.
              SMS court (≤ 70 car. Cyrillique) + email personnalisé. Relance automatique x2 maximum.
            </div>
          </div>
        )}

        {/* ── ROBOTA AUTH ── */}
        {tab === 'robota-auth' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Field label="Email employeur robota.ua">
              <input type="email" value={robotaEmail} onChange={e => setRobotaEmail(e.target.value)} placeholder="email@example.com" style={inputStyle} />
            </Field>
            <Field label="Mot de passe">
              <input type="password" value={robotaPassword} onChange={e => setRobotaPassword(e.target.value)} placeholder="••••••••" style={inputStyle} />
            </Field>
            {authMsg && (
              <div style={{ padding: '8px 12px', borderRadius: 8, fontSize: 12,
                background: authMsg.startsWith('Erreur') ? '#FFE5E5' : '#D0F0E4',
                color: authMsg.startsWith('Erreur') ? '#C0392B' : '#2E9460' }}>{authMsg}</div>
            )}
            <button onClick={handleAuth} disabled={authLoading || !robotaEmail || !robotaPassword} style={{
              padding: '10px', borderRadius: 10, background: 'var(--accent)',
              color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13,
            }}>
              {authLoading ? 'Connexion...' : 'Se connecter'}
            </button>
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
              Le token est renouvelé automatiquement toutes les 23h.
            </div>
          </div>
        )}

        {/* ── SMTP ── */}
        {tab === 'smtp' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Field label="Serveur SMTP">
              <input value={smtp.host} onChange={e => setSmtp(s => ({ ...s, host: e.target.value }))} placeholder="smtp.gmail.com" style={inputStyle} />
            </Field>
            <Field label="Port">
              <input value={smtp.port} onChange={e => setSmtp(s => ({ ...s, port: e.target.value }))} placeholder="587" style={inputStyle} />
            </Field>
            <Field label="Email expéditeur">
              <input value={smtp.user} onChange={e => setSmtp(s => ({ ...s, user: e.target.value }))} placeholder="hr@votrecompany.com" style={inputStyle} />
            </Field>
            <Field label="Mot de passe / App password">
              <input type="password" value={smtp.pass} onChange={e => setSmtp(s => ({ ...s, pass: e.target.value }))} placeholder="••••••••" style={inputStyle} />
            </Field>
            <Field label="Nom affiché" hint="Ex: Farmasoft RH <hr@farmasoft.ua>">
              <input value={smtp.from} onChange={e => setSmtp(s => ({ ...s, from: e.target.value }))} placeholder="Farmasoft RH <hr@farmasoft.ua>" style={inputStyle} />
            </Field>
            {smtpMsg && (
              <div style={{ padding: '8px 12px', borderRadius: 8, fontSize: 12,
                background: smtpMsg.startsWith('Erreur') ? '#FFE5E5' : '#D0F0E4',
                color: smtpMsg.startsWith('Erreur') ? '#C0392B' : '#2E9460' }}>{smtpMsg}</div>
            )}
            <button onClick={handleSmtp} disabled={smtpSaving} style={{
              padding: '10px', borderRadius: 10, background: 'var(--accent)',
              color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13,
            }}>
              {smtpSaving ? 'Sauvegarde...' : 'Sauvegarder'}
            </button>
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
              Gmail : activez l'auth 2FA et créez un "App Password" dans les paramètres Google.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
