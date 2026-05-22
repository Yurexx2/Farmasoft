import { Job } from '../../api/client'

export const EMPTY_JOB: Partial<Job> = {
  title: '', location: 'Київ', salary_min: 0, salary_max: 0,
  salary_currency: 'UAH', experience_years: 0, skills: '[]',
  description: '', requirements: '', is_active: 0,
  city_id: 1, experience_id: 0, education_id: 0, schedule_id: 1,
  employment_types: '["FullTime"]', work_types: '["Office"]',
  branch_ids: '[]', publish_type: 'Anonym',
  // Default contact info — Alena (HR director). The form opens already valid
  // so a manual job can be saved without re-typing the contact every time.
  contact_person: 'Альона Приходько',
  contact_email: 'alena.pryhodko@farmasoft.ua',
  languages: '[]',
}

export const EXPERIENCE_LEVELS = [
  { id: 0, label: 'Aucune expérience' },
  { id: 1, label: 'Jusqu\'à 1 an' },
  { id: 2, label: '1 à 2 ans' },
  { id: 3, label: '2 à 5 ans' },
  { id: 4, label: 'Plus de 5 ans' },
]
export const EDUCATION_LEVELS = [
  { id: 0, label: 'Indifférent' },
  { id: 1, label: 'Secondaire' },
  { id: 2, label: 'Supérieur incomplet' },
  { id: 3, label: 'Supérieur' },
]
export const SCHEDULE_TYPES = [
  { id: 1, label: 'Temps plein' },
  { id: 2, label: 'Temps partiel' },
  { id: 3, label: 'À distance' },
  { id: 4, label: 'Travail à la maison' },
  { id: 5, label: 'Stage' },
]
export const EMPLOYMENT_TYPES = [
  { id: 'FullTime',     label: 'Plein temps' },
  { id: 'PartTime',     label: 'Partiel' },
  { id: 'ProjectBased', label: 'Projet' },
]
export const WORK_TYPES_OPTS = [
  { id: 'Office', label: 'Bureau' },
  { id: 'Remote', label: 'Télétravail' },
  { id: 'Hybrid', label: 'Hybride' },
]
export const PUBLISH_TYPES = [
  { id: 'Anonym',        label: 'Anonyme (gratuit)' },
  { id: 'Business',      label: 'Business (payant)' },
  { id: 'Optimum',       label: 'Optimum (payant)' },
  { id: 'Professional',  label: 'Professional (payant)' },
]
export const LANGUAGES = [
  { id: 1, label: 'Ukrainien' },
  { id: 2, label: 'Russe' },
  { id: 3, label: 'Anglais' },
  { id: 4, label: 'Allemand' },
  { id: 5, label: 'Polonais' },
]
export const LANGUAGE_LEVELS = [
  { id: 1, label: 'Notions' },
  { id: 2, label: 'Moyen' },
  { id: 3, label: 'Avancé' },
  { id: 4, label: 'Courant' },
  { id: 5, label: 'Natif' },
]

export const PLATFORMS = ['work.ua', 'robota.ua', 'hh.ua']
export const CITIES = ['Kyiv', 'Kharkiv', 'Lviv', 'Odesa', 'Dnipro', 'Zaporizhzhia', 'Vinnytsia', 'Poltava', 'Remote']

export const PLATFORM_COLOR: Record<string, string> = {
  'work.ua': '#1a6b3c',
  'robota.ua': '#1a4a8a',
  'djinni.co': '#6b3a8a',
  'hh.ua': '#c0392b',
  'cv_import': '#6b4a1a',
}

export const STAGE_LABELS: Record<string, string> = {
  new: 'Nouveau',
  interview: 'Entretien',
  decision: 'Décision',
}
export const STAGES = ['new', 'interview', 'decision'] as const
export type Stage = typeof STAGES[number]

export const STAGE_COLORS: Record<Stage, string> = {
  new: 'var(--text-3)',
  interview: '#d97706',
  decision: '#16a34a',
}

export const INTERVIEW_TYPES = [
  { value: 'phone', label: 'Téléphone' },
  { value: 'video', label: 'Visio' },
  { value: 'on-site', label: 'Présentiel' },
]
