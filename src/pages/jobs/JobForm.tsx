import { useState } from 'react'
import { api, Job } from '../../api/client'
import { useAppStore } from '../../store/useAppStore'
import { T } from '../../i18n'
import {
  EMPTY_JOB, EXPERIENCE_LEVELS, EDUCATION_LEVELS, SCHEDULE_TYPES,
  EMPLOYMENT_TYPES, WORK_TYPES_OPTS, PUBLISH_TYPES, LANGUAGES, LANGUAGE_LEVELS,
} from './constants'
import { iconClose, iconSparkle } from './icons'

export { EMPTY_JOB }

const POPULAR_CITIES = [
  { id: 1,  name: 'Київ' },     { id: 2,  name: 'Харків' }, { id: 21, name: 'Львів' },
  { id: 3,  name: 'Одеса' },    { id: 4,  name: 'Дніпро' }, { id: 9,  name: 'Запоріжжя' },
  { id: 10, name: 'Вінниця' },  { id: 16, name: 'Полтава' }, { id: 6, name: 'Донецьк' },
]

const BRANCHES = [
  { id: 1,  label: 'Промисловість' },     { id: 2,  label: 'Медицина / Фармація' },
  { id: 3,  label: 'Торгівля' },          { id: 4,  label: 'IT' },
  { id: 5,  label: 'Фінанси' },           { id: 6,  label: 'Логістика' },
  { id: 7,  label: 'Маркетинг' },         { id: 8,  label: 'Будівництво' },
]

function parseJSON<T>(s: string | undefined | null, fallback: T): T {
  try { return s ? JSON.parse(s) as T : fallback } catch { return fallback }
}

export function JobForm({ initial, onSave, onClose }: {
  initial: Partial<Job>
  onSave: (job: Job) => void
  onClose: () => void
}) {
  const { uiLang } = useAppStore()
  const tf = T[uiLang].jobs.form
  const [form, setForm] = useState<Partial<Job>>(initial)
  const [generating, setGenerating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const isEdit = Boolean((initial as Job).id)

  function set(key: keyof Job, value: unknown) {
    setForm(f => ({ ...f, [key]: value }))
  }

  function toggleArr<T>(arr: T[], val: T): T[] {
    return arr.includes(val) ? arr.filter(x => x !== val) : [...arr, val]
  }

  async function generate() {
    if (!form.title) return
    setGenerating(true); setError('')
    const res = await api.ai.generateJob(form.title)
    if (res.error) { setError(res.error); setGenerating(false); return }
    if (res.data) {
      const d = res.data as Record<string, unknown>
      setForm(f => ({
        ...f,
        title:           (d.title as string)        ?? f.title,
        location:        (d.location as string)     ?? f.location,
        city_id:         (d.city_id as number)      ?? f.city_id,
        salary_min:      (d.salary_min as number)   ?? f.salary_min,
        salary_max:      (d.salary_max as number)   ?? f.salary_max,
        experience_years: (d.experience_years as number) ?? f.experience_years,
        experience_id:   (d.experience_id as number) ?? f.experience_id,
        education_id:    (d.education_id as number) ?? f.education_id,
        schedule_id:     (d.schedule_id as number)  ?? f.schedule_id,
        employment_types: Array.isArray(d.employment_types) ? JSON.stringify(d.employment_types) : f.employment_types,
        work_types:      Array.isArray(d.work_types) ? JSON.stringify(d.work_types) : f.work_types,
        branch_ids:      Array.isArray(d.branch_ids) ? JSON.stringify(d.branch_ids) : f.branch_ids,
        skills:          Array.isArray(d.skills) ? JSON.stringify(d.skills) : f.skills,
        description:     (d.description as string)  ?? f.description,
        requirements:    (d.requirements as string) ?? f.requirements,
      }))
    }
    setGenerating(false)
  }

  async function save() {
    if (!form.title) { setError(tf.titleRequired); return }
    if (form.is_active && (form.description?.length ?? 0) < 150) {
      setError('La description doit faire au moins 150 caractères pour publier sur robota.ua.')
      return
    }
    setSaving(true); setError('')
    const res = isEdit
      ? await api.jobs.update((initial as Job).id, form)
      : await api.jobs.create(form)
    setSaving(false)
    if (res.error) { setError(res.error); return }
    if (res.data) onSave(res.data)
  }

  const skillsArr            = parseJSON<string[]>(form.skills, [])
  const employmentTypesArr   = parseJSON<string[]>(form.employment_types, ['FullTime'])
  const workTypesArr         = parseJSON<string[]>(form.work_types, ['Office'])
  const branchIdsArr         = parseJSON<number[]>(form.branch_ids, [])
  const languagesArr         = parseJSON<Array<{ id: number; level: number }>>(form.languages, [])

  const descLen = (form.description || '').length
  const descOk = descLen >= 150

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 720, maxWidth: '95vw', maxHeight: '92vh', overflowY: 'auto' }}>
        <div className="flex items-center justify-between mb-24">
          <h2 className="modal-title">{isEdit ? tf.editTitle : tf.newTitle}</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: 4 }}>{iconClose}</button>
        </div>

        {/* Title + AI */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <label className="form-label">{tf.jobTitle}</label>
            <input className="form-input" value={form.title || ''} onChange={e => set('title', e.target.value)} placeholder={tf.jobTitlePlaceholder} />
          </div>
          <div style={{ marginTop: 22 }}>
            <button className="btn btn-primary" onClick={generate} disabled={generating || !form.title} style={{ whiteSpace: 'nowrap' }}>
              {generating ? <span className="spinner" /> : iconSparkle}
              {generating ? 'Génération…' : 'Auto-remplir avec IA'}
            </button>
          </div>
        </div>

        {/* City + experience */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
          <div>
            <label className="form-label">Ville</label>
            <select className="form-input" value={form.city_id || 1}
              onChange={e => {
                const id = +e.target.value
                const city = POPULAR_CITIES.find(c => c.id === id)
                set('city_id', id)
                if (city) set('location', city.name)
              }}>
              {POPULAR_CITIES.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="form-label">Expérience requise</label>
            <select className="form-input" value={form.experience_id ?? 0} onChange={e => set('experience_id', +e.target.value)}>
              {EXPERIENCE_LEVELS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
        </div>

        {/* Salary range */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
          <div>
            <label className="form-label">{tf.salaryMin} (UAH)</label>
            <input className="form-input" type="number" min={0} value={form.salary_min ?? 0} onChange={e => set('salary_min', +e.target.value)} />
          </div>
          <div>
            <label className="form-label">{tf.salaryMax} (UAH)</label>
            <input className="form-input" type="number" min={0} value={form.salary_max ?? 0} onChange={e => set('salary_max', +e.target.value)} />
          </div>
        </div>

        {/* Education + schedule */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
          <div>
            <label className="form-label">Niveau d'études</label>
            <select className="form-input" value={form.education_id ?? 0} onChange={e => set('education_id', +e.target.value)}>
              {EDUCATION_LEVELS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className="form-label">Horaires</label>
            <select className="form-input" value={form.schedule_id ?? 1} onChange={e => set('schedule_id', +e.target.value)}>
              {SCHEDULE_TYPES.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
        </div>

        {/* Employment types + work types */}
        <div style={{ marginBottom: 14 }}>
          <label className="form-label">Type d'emploi</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {EMPLOYMENT_TYPES.map(et => {
              const active = employmentTypesArr.includes(et.id)
              return (
                <button key={et.id} type="button"
                  onClick={() => set('employment_types', JSON.stringify(toggleArr(employmentTypesArr, et.id)))}
                  style={{
                    padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 500,
                    border: `1.5px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                    background: active ? 'var(--accent-bg, #EBF3FF)' : 'var(--surface-2)',
                    color: active ? 'var(--accent)' : 'var(--text-2)', cursor: 'pointer',
                  }}>{et.label}</button>
              )
            })}
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label className="form-label">Mode de travail</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {WORK_TYPES_OPTS.map(wt => {
              const active = workTypesArr.includes(wt.id)
              return (
                <button key={wt.id} type="button"
                  onClick={() => set('work_types', JSON.stringify(toggleArr(workTypesArr, wt.id)))}
                  style={{
                    padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 500,
                    border: `1.5px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                    background: active ? 'var(--accent-bg, #EBF3FF)' : 'var(--surface-2)',
                    color: active ? 'var(--accent)' : 'var(--text-2)', cursor: 'pointer',
                  }}>{wt.label}</button>
              )
            })}
          </div>
        </div>

        {/* Industry */}
        <div style={{ marginBottom: 14 }}>
          <label className="form-label">Secteur d'activité</label>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {BRANCHES.map(b => {
              const active = branchIdsArr.includes(b.id)
              return (
                <button key={b.id} type="button"
                  onClick={() => set('branch_ids', JSON.stringify(toggleArr(branchIdsArr, b.id)))}
                  style={{
                    padding: '4px 10px', borderRadius: 14, fontSize: 11, fontWeight: 500,
                    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                    background: active ? 'var(--accent-bg, #EBF3FF)' : 'transparent',
                    color: active ? 'var(--accent)' : 'var(--text-2)', cursor: 'pointer',
                  }}>{b.label}</button>
              )
            })}
          </div>
        </div>

        {/* Languages */}
        <div style={{ marginBottom: 14 }}>
          <label className="form-label">Langues requises</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {LANGUAGES.map(l => {
              const existing = languagesArr.find(x => x.id === l.id)
              return (
                <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={!!existing}
                    onChange={e => {
                      const next = e.target.checked
                        ? [...languagesArr.filter(x => x.id !== l.id), { id: l.id, level: 2 }]
                        : languagesArr.filter(x => x.id !== l.id)
                      set('languages', JSON.stringify(next))
                    }} />
                  <span style={{ fontSize: 12, minWidth: 90 }}>{l.label}</span>
                  {existing && (
                    <select style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6 }}
                      value={existing.level}
                      onChange={e => {
                        const next = languagesArr.map(x => x.id === l.id ? { ...x, level: +e.target.value } : x)
                        set('languages', JSON.stringify(next))
                      }}>
                      {LANGUAGE_LEVELS.map(lv => <option key={lv.id} value={lv.id}>{lv.label}</option>)}
                    </select>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Skills */}
        {skillsArr.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <label className="form-label">{tf.skills}</label>
            <div className="flex flex-wrap gap-6">
              {skillsArr.map((s, i) => <span key={i} className="chip">{s}</span>)}
            </div>
          </div>
        )}

        {/* Description with char counter */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <label className="form-label">{tf.description}</label>
            <span style={{ fontSize: 11, color: descOk ? '#16A34A' : '#DC2626' }}>
              {descLen} / 150 caractères {descOk ? '✓' : 'minimum requis pour robota.ua'}
            </span>
          </div>
          <textarea className="form-input" rows={4} value={form.description || ''} onChange={e => set('description', e.target.value)} />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label className="form-label">{tf.requirements}</label>
          <textarea className="form-input" rows={3} value={form.requirements || ''} onChange={e => set('requirements', e.target.value)} />
        </div>

        {/* Publish settings */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: 10 }}>
            Publication robota.ua
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label className="form-label">Type de publication</label>
              <select className="form-input" value={form.publish_type || 'Anonym'} onChange={e => set('publish_type', e.target.value)}>
                {PUBLISH_TYPES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </div>
            <div>
              <label className="form-label">Personne de contact</label>
              <input className="form-input" value={form.contact_person || ''} onChange={e => set('contact_person', e.target.value)} placeholder="HR Farmasoft" />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">Email pour réception des candidatures</label>
              <input className="form-input" type="email" value={form.contact_email || ''} onChange={e => set('contact_email', e.target.value)} placeholder="alena.pryhodko@farmasoft.ua" />
            </div>
          </div>

          {/* Active toggle */}
          <div style={{
            padding: 12, background: form.is_active ? '#DCFCE7' : 'var(--surface-2)',
            border: `1.5px solid ${form.is_active ? '#86EFAC' : 'var(--border)'}`,
            borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: form.is_active ? '#15803D' : 'var(--text-2)' }}>
                {form.is_active ? '🟢 Annonce active sur robota.ua' : '⚫ Annonce désactivée (brouillon)'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                {form.is_active
                  ? 'Au save, l\'annonce sera publiée/republée sur robota.ua immédiatement.'
                  : 'Au save, l\'annonce sera fermée sur robota.ua si elle existe.'}
              </div>
            </div>
            <label style={{ position: 'relative', display: 'inline-block', width: 44, height: 24 }}>
              <input type="checkbox" checked={!!form.is_active} onChange={e => set('is_active', e.target.checked ? 1 : 0)}
                style={{ opacity: 0, width: 0, height: 0 }} />
              <span style={{
                position: 'absolute', cursor: 'pointer', inset: 0, borderRadius: 12,
                background: form.is_active ? '#16A34A' : 'var(--text-3)', transition: 'background 200ms',
              }}>
                <span style={{
                  position: 'absolute', top: 2, left: form.is_active ? 22 : 2,
                  width: 20, height: 20, borderRadius: '50%', background: '#fff',
                  transition: 'left 200ms', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                }} />
              </span>
            </label>
          </div>
        </div>

        {error && <p style={{ color: 'var(--err)', fontSize: 12, marginBottom: 12 }}>{error}</p>}
        <div className="flex gap-10 justify-end">
          <button className="btn btn-ghost" onClick={onClose}>{tf.cancel}</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? <span className="spinner" /> : null}
            {saving ? tf.saving : isEdit ? tf.save : tf.create}
          </button>
        </div>
      </div>
    </div>
  )
}
