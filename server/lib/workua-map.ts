import { DictItem, WorkuaDicts } from './workua'

// Plain text → minimal HTML accepted by Work.ua (<p>, <b>, <ul>, <ol>, <li>, <h3>, <a>).
export function textToWorkuaHtml(text: string): string {
  if (!text) return ''
  const paragraphs = text.split(/\n{2,}/)
  return paragraphs.map(p => {
    const lines = p.split(/\n/).map(l => l.trim()).filter(Boolean)
    if (lines.length === 0) return ''
    const bullets = lines.every(l => l.startsWith('•') || l.startsWith('-'))
    if (bullets) {
      const items = lines.map(l => `<li>${escapeHtml(l.replace(/^[-•]\s*/, ''))}</li>`).join('')
      return `<ul>${items}</ul>`
    }
    return `<p>${escapeHtml(lines.join(' '))}</p>`
  }).filter(Boolean).join('')
}
function escapeHtml(s: string): string {
  return s.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' } as Record<string, string>)[c]!)
}

// Best-effort name lookup: case-insensitive, trimmed, partial allowed (haystack
// contains needle). Returns the first match or null.
function findByName(items: DictItem[] | undefined, needle: string): DictItem | null {
  if (!items?.length || !needle) return null
  const n = needle.toLowerCase().trim()
  return items.find(i => (i.name || '').toLowerCase().trim() === n)
      || items.find(i => (i.name || '').toLowerCase().includes(n))
      || null
}

// Map Farmasoft enum values → Work.ua dict entries by name. These translations
// are the bridge between robota.ua-shaped IDs (what Farmasoft stores) and the
// work.ua dictionaries we just downloaded.
const EMPLOYMENT_NAMES: Record<string, string> = {
  FullTime:     'повна',
  PartTime:     'неповна',
  ProjectBased: 'проект',
}
// experience_id 0-4 → keyword to look up in work.ua's "experience" dict
const EXPERIENCE_NAMES: Record<number, string> = {
  0: 'без',         // без досвіду
  1: 'до 1',        // до 1 року
  2: '1',           // від 1 до 2 років
  3: '2',           // від 2 років
  4: '5',           // понад 5 років
}
const EDUCATION_NAMES: Record<number, string> = {
  0: 'не має значення',
  1: 'середн',  // середня
  2: 'неповн',  // неповна вища
  3: 'вищ',     // вища
}

export interface JobLike {
  title?: string | null
  location?: string | null
  description?: string | null
  requirements?: string | null
  salary_min?: number | null
  salary_max?: number | null
  experience_id?: number | null
  education_id?: number | null
  employment_types?: string | null   // JSON string
  skills?: string | null              // JSON string
  languages?: string | null           // JSON string
  contact_email?: string | null
}

export interface WorkuaPayloadResult {
  payload: Record<string, unknown>
  problems: string[]   // non-blocking warnings (e.g. unmapped fields)
}

export function buildWorkuaPayload(
  job: JobLike, dicts: WorkuaDicts, publicationType: string | null,
): WorkuaPayloadResult {
  const problems: string[] = []
  const parseJson = <T>(s?: string | null, fb: T = ([] as unknown as T)): T => {
    try { return s ? JSON.parse(s) as T : fb } catch { return fb }
  }

  // 1) City — name match (default Київ)
  const town = findByName(dicts.town, job.location || 'Київ')
            || findByName(dicts.town, 'Київ')
  if (!town) problems.push('town not resolved')

  // 2) Employment types (max 3) → jobtype dict
  const empTypes = parseJson<string[]>(job.employment_types, ['FullTime'])
  const jobtype = empTypes.slice(0, 3)
    .map(et => findByName(dicts.jobtype, EMPLOYMENT_NAMES[et] || et))
    .filter((x): x is DictItem => x != null)
    .map(d => ({ id: d.id }))
  if (jobtype.length === 0) {
    const fallback = findByName(dicts.jobtype, 'повна')
    if (fallback) jobtype.push({ id: fallback.id })
  }

  // 3) Category — pick something sensible. Farmasoft is pharma logistics so
  //    we look for a pharma or logistics category and fall back to whichever
  //    keyword matches the title.
  const titleLc = (job.title || '').toLowerCase()
  const categoryCandidates: string[] = ['Медицина', 'фармац', 'логіст', 'склад']
  if (titleLc.includes('бухгалт')) categoryCandidates.unshift('бухгалтерія')
  if (titleLc.includes('водій'))   categoryCandidates.unshift('водій')
  if (titleLc.includes('IT') || titleLc.includes('розробник')) categoryCandidates.unshift('IT')
  const category: Array<{ id: number }> = []
  for (const kw of categoryCandidates) {
    const c = findByName(dicts.category, kw)
    if (c && !category.find(x => x.id === c.id)) category.push({ id: c.id })
    if (category.length >= 3) break
  }
  if (category.length === 0 && dicts.category?.length) {
    category.push({ id: dicts.category[0].id })
    problems.push('category fell back to the first dict entry')
  }

  // 4) Experience (required by work.ua)
  const expKw = EXPERIENCE_NAMES[job.experience_id ?? 0] || 'без'
  const experience = findByName(dicts.experience, expKw) || dicts.experience?.[0] || null
  if (!experience) problems.push('experience not resolved')

  // 5) Education (optional)
  const eduKw = EDUCATION_NAMES[job.education_id ?? 0]
  const education = eduKw ? findByName(dicts.education, eduKw) : null

  // 6) Languages
  const langArr = parseJson<Array<{ id: number; level: number }>>(job.languages, [])
  const languages = langArr
    .map(l => ({ languageId: l.id, levelId: l.level }))   // assume work.ua IDs match
    .filter(l => l.languageId && l.levelId)

  // 7) Skills (work.ua wants an array of strings)
  const skills = parseJson<string[]>(job.skills, [])

  // 8) Description as HTML (plain text → simple <p> / <ul><li>)
  const fullText = [job.description, job.requirements].filter(Boolean).join('\n\n')
  const description = textToWorkuaHtml(fullText)

  const payload: Record<string, unknown> = {
    name: job.title,
    description,
    'region': { id: town?.id ?? 1 },
    category,
    jobtype,
    experience: { id: experience?.id ?? 0 },
  }
  if (education?.id) payload.education = { id: education.id }
  if ((job.salary_min ?? 0) > 0) {
    payload.salary = { value: job.salary_min, ...(job.salary_max ? { value_max: job.salary_max } : {}) }
  }
  if (languages.length) payload.languages = languages
  if (skills.length)    payload.skills = skills.map(name => ({ name }))
  if (job.contact_email) payload.contact = { email: job.contact_email }
  if (publicationType)  payload.publication = publicationType
  return { payload, problems }
}
