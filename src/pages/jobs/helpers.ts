export function parseProfile(raw: string | null) {
  try { return raw ? JSON.parse(raw) : null } catch { return null }
}

export function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : raw.split(',').map(s => s.trim()).filter(Boolean)
  } catch {
    return raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : []
  }
}

// Convert robota.ua HTML strings (<br>, <ul>, <li>, <p>, &nbsp;, &Vcy;…) to clean text with bullets.
// robota.ua encodes Cyrillic in some fields as HTML5/MathML named entities (&Vcy; → В, &icy; → и, …),
// which React renders literally because we output via {…} as text. We decode them through a
// detached <textarea> so the browser's HTML parser handles every named entity natively.
export function stripHtmlToText(raw: string | null | undefined): string {
  if (!raw) return ''
  let s = raw
    .replace(/<\/?(p|div)[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?ul[^>]*>/gi, '\n')
    .replace(/<\/?ol[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '')
    .replace(/<[^>]+>/g, '')

  if (typeof document !== 'undefined' && s.includes('&')) {
    const ta = document.createElement('textarea')
    ta.innerHTML = s
    s = ta.value
  }

  return s
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
