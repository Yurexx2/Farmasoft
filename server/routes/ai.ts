import { Router, Request, Response } from 'express'
import { callLLM } from '../lib/llm'

const router = Router()

const FARMASOFT_CONTEXT = `
Tu travailles pour Farmasoft UA, entreprise ukrainienne spécialisée dans les logiciels
pour les secteurs pharmaceutique et agricole. L'entreprise est basée en Ukraine.
Les salaires sont en hryvnias ukrainiennes (UAH). Adapte toujours tes réponses
au contexte ukrainien : marché du travail local, plateformes Work.ua/Robota.ua,
culture professionnelle ukrainienne.
`

router.post('/generate-job', async (req: Request, res: Response) => {
  try {
    const { title } = req.body
    if (!title) return res.json({ error: 'Le titre est requis' })

    const prompt = `${FARMASOFT_CONTEXT}

Génère une fiche de poste complète et compatible robota.ua pour : "${title}"

IMPORTANT : Tout le contenu rédactionnel (title, skills, description, requirements) doit être OBLIGATOIREMENT en ukrainien (мова: українська).
La description doit faire MINIMUM 200 caractères (exigence robota.ua).

Réponds UNIQUEMENT en JSON valide, structure EXACTE :
{
  "title": "назва посади українською",
  "location": "ville en ukrainien (Київ par défaut)",
  "city_id": <int>,
  "salary_min": <int>, "salary_max": <int>,
  "experience_years": <int>,
  "experience_id": <int>,
  "education_id": <int>,
  "schedule_id": <int>,
  "employment_types": ["FullTime"],
  "work_types": ["Office"],
  "branch_ids": [<int>],
  "skills": ["навичка1", "навичка2", "навичка3", "навичка4", "навичка5"],
  "description": "опис посади українською (мінімум 200 символів)",
  "requirements": "детальні вимоги українською (список з • )"
}

Mapping ROBOTA.UA :
- city_id : 1=Київ, 2=Харків, 21=Львів, 3=Одеса, 4=Дніпро, 9=Запоріжжя, 10=Вінниця
- experience_id : 0=Aucune, 1=Jusqu'à 1an, 2=1-2 ans, 3=2-5 ans, 4=Plus de 5 ans
- education_id : 0=Indifférent, 1=Secondaire, 2=Bac+2, 3=Bac+3+
- schedule_id : 1=Temps plein, 2=Partiel, 3=À distance, 4=Maison, 5=Stage
- employment_types : combinaison de FullTime, PartTime, ProjectBased
- work_types : combinaison de Office, Remote, Hybrid
- branch_ids : 1=Industrie, 2=Médical/Pharma, 3=Commerce, 4=IT, 5=Finance, 6=Logistique, 7=Marketing, 8=Construction (devine selon le poste)

Salaires marché Ukraine 2025 :
- Chauffeur PL : 22 000–35 000 UAH
- Comptable : 20 000–40 000 UAH
- Pharmacien : 25 000–45 000 UAH
- Développeur junior : 30 000–50 000 UAH
- Développeur senior : 60 000–120 000 UAH
- RH/Recruteur : 25 000–45 000 UAH
- Logisticien : 22 000–38 000 UAH
- Technicien : 18 000–30 000 UAH
- Manager : 35 000–70 000 UAH`

    const text = await callLLM(prompt, { jsonMode: true, timeoutMs: 30000 })
    const parsed = JSON.parse(text)
    res.json({ data: parsed })
  } catch (err: unknown) {
    const msg = (err as Error).message
    if (msg.includes('JSON')) return res.json({ error: 'Réponse IA invalide. Réessayez.' })
    res.json({ error: `Erreur IA : ${msg}` })
  }
})

// ─── Smart salary proposal based on candidate expectation vs job range ──────
function computeProposedSalary(candidate: Record<string, unknown>, job: Record<string, unknown>): {
  strategy: 'match' | 'cap' | 'upgrade' | 'open'
  range: string
  hint: string
} {
  const expected = Number(candidate.salary_expectation) || 0
  const jobMin = Number(job.salary_min) || 0
  const jobMax = Number(job.salary_max) || 0
  const fmt = (n: number) => n.toLocaleString('uk-UA').replace(/\s/g, ' ')

  if (!jobMin && !jobMax) return { strategy: 'open', range: 'attractif', hint: 'salaire selon expérience' }

  if (!expected) {
    return {
      strategy: 'open',
      range: jobMin && jobMax ? `${fmt(jobMin)}–${fmt(jobMax)} UAH` : `до ${fmt(jobMax || jobMin)} UAH`,
      hint: 'Présenter la fourchette complète, en évoquant que c\'est selon expérience.',
    }
  }

  if (expected > jobMax && jobMax > 0) {
    return {
      strategy: 'cap',
      range: `${fmt(jobMin)}–${fmt(jobMax)} UAH`,
      hint: `Le candidat attend ${fmt(expected)} UAH, plafond ${fmt(jobMax)} UAH. Présenter honnêtement la fourchette mais préciser qu'avec son expérience une discussion est ouverte.`,
    }
  }

  if (expected < jobMin && jobMin > 0) {
    const proposed = Math.round((jobMin + jobMax) / 2)
    return {
      strategy: 'upgrade',
      range: `${fmt(jobMin)}–${fmt(jobMax)} UAH`,
      hint: `Le candidat attend ${fmt(expected)} UAH, mais nous proposons ${fmt(jobMin)}–${fmt(jobMax)} UAH. Mentionner POSITIVEMENT que notre fourchette dépasse son attente (cible ~${fmt(proposed)} UAH).`,
    }
  }

  // expected fits in range
  return {
    strategy: 'match',
    range: `${fmt(Math.max(expected, jobMin))}–${fmt(jobMax)} UAH`,
    hint: `Le candidat attend ${fmt(expected)} UAH, parfait dans notre fourchette. Confirmer qu'on correspond à ses attentes, marge supérieure possible jusqu'à ${fmt(jobMax)} UAH.`,
  }
}

const CHANNEL_RULES = {
  whatsapp: {
    maxChars: 900,
    tone: 'professionnel et chaleureux, naturel comme un message à un contact',
    formatting: 'Texte simple, 1-2 emojis modérés (👋 ou ✨), pas de markdown, lien Calendly à la fin si fourni',
    structure: '5-7 lignes max',
  },
  telegram: {
    maxChars: 2500,
    tone: 'décontracté mais pro, sans jargon, comme un échange direct',
    formatting: 'Markdown léger autorisé : *gras* pour le poste, lien cliquable [text](url) pour le Calendly',
    structure: '6-10 lignes',
  },
  viber: {
    maxChars: 500,
    tone: 'professionnel et concis',
    formatting: 'Texte simple sans markdown, NE PAS inclure le lien dans le texte (un bouton CTA séparé sera ajouté)',
    structure: '3-5 lignes courtes',
  },
  email: {
    maxChars: 4000,
    tone: 'formel mais cordial, structuré',
    formatting: 'Plain text avec retours à la ligne propres. Inclure le lien Calendly à la fin. Signature "Команда Farmasoft UA".',
    structure: 'Salutation + 3-4 paragraphes + appel à l\'action + signature',
  },
} as const

router.post('/generate-message', async (req: Request, res: Response) => {
  try {
    const { job, candidate, language = 'uk', channel = 'whatsapp', calendlyUrl } = req.body as {
      job: Record<string, unknown>
      candidate: Record<string, unknown>
      language?: string
      channel?: keyof typeof CHANNEL_RULES
      calendlyUrl?: string
    }

    if (!job || !candidate) return res.json({ error: 'job and candidate are required' })

    const rules = CHANNEL_RULES[channel] || CHANNEL_RULES.whatsapp
    const salary = computeProposedSalary(candidate, job)

    // Personalisation: get firstName from full_name
    const fullName = (candidate.full_name as string) || ''
    const firstName = fullName.split(/\s+/)[1] || fullName.split(/\s+/)[0] || ''  // "Прізвище Ім'я Сергіївна" → Ім'я

    // Strip HTML from experience_text + skillsSummary
    const stripHtml = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    const expText = candidate.experience_text ? stripHtml(candidate.experience_text as string).substring(0, 1500) : ''
    let profileSummary = ''
    try {
      const pd = typeof candidate.profile_data === 'string' ? JSON.parse(candidate.profile_data as string) : (candidate.profile_data as Record<string, unknown>)
      if (pd?.skillsSummary) profileSummary = stripHtml(pd.skillsSummary as string).substring(0, 600)
    } catch { /* ignore */ }

    const langInstr = language === 'uk'
      ? 'Écris le message UNIQUEMENT en ukrainien (мова: українська). Commence par "Вітаю!" ou "Доброго дня!".'
      : 'Write the message in English. Start with "Hello,".'

    const ctaInstr = calendlyUrl
      ? channel === 'viber'
        ? 'NE PAS inclure le lien dans le texte (un bouton CTA séparé l\'ajoutera).'
        : `Inclure ce lien Calendly pour prendre RDV : ${calendlyUrl}`
      : 'Inviter à un appel court (sans lien spécifique).'

    const prompt = `Tu es recruteur RH chez Farmasoft UA (entreprise ukrainienne, secteurs pharmaceutique et agricole).

Rédige un message de prospection à un candidat. Format adapté au canal ${channel.toUpperCase()}.

═══ CANAL ${channel.toUpperCase()} ═══
- Limite : ${rules.maxChars} caractères max
- Ton : ${rules.tone}
- Format : ${rules.formatting}
- Structure : ${rules.structure}

═══ CANDIDAT ═══
- Prénom : ${firstName || '(non spécifié — utiliser une formule générique sans prénom)'}
- Poste actuel : ${candidate.role || '(non spécifié)'}
- Ville : ${candidate.location || '(non spécifiée)'}
- Expérience : ${candidate.experience_years || 0} ans
- Salaire attendu : ${candidate.salary_expectation || 0} UAH/mois
${profileSummary ? `- Compétences : ${profileSummary}` : ''}
${expText ? `- Historique pro (extrait) :\n${expText}` : ''}

═══ POSTE PROPOSÉ ═══
- Titre : ${job.title}
- Ville : ${job.location}
- Fourchette salariale interne : ${job.salary_min}–${job.salary_max} UAH/mois

═══ STRATÉGIE SALAIRE PERSONNALISÉE ═══
Stratégie : ${salary.strategy}
Fourchette à présenter : ${salary.range}
Instruction : ${salary.hint}

═══ APPEL À L'ACTION ═══
${ctaInstr}

═══ RÈGLES STRICTES ═══
- ${langInstr}
- INTERDICTION ABSOLUE de placeholders : pas de [Ваше ім'я], [Your name], [Nom], <name>, <recruteur>, ni aucun [...] ou <...>. Si tu ne connais pas une info, OMETS-LA, n'ajoute jamais de crochets.
- Mentionner Farmasoft UA par son nom
- Référencer UN détail concret du parcours du candidat (poste actuel, ville, ou compétence) — pas générique
- Signer EXACTEMENT "Команда Farmasoft UA" sur la dernière ligne (pas de prénom, pas de [Ваше ім'я], juste "Команда Farmasoft UA")
- Ne jamais commencer par "Мене звати [...]" ou "Je m'appelle [...]" — utiliser une formule collective au nom de l'équipe
- Sonner humain et naturel, pas robotique
- Respecter STRICTEMENT la limite de caractères du canal
- Texte BRUT uniquement — aucun formatage markdown : pas d'astérisques *, pas de _, pas de # ni de **gras**

Réponds UNIQUEMENT avec le texte du message, rien d'autre. Si ta réponse contient un seul crochet [ ou < c'est un échec.`

    let text = await callLLM(prompt, { timeoutMs: 30000, maxTokens: 800 })
    // Safety net: strip any placeholder leftovers the LLM might have ignored
    text = text
      .replace(/[\[<][^\]>]*?(name|nom|ім'я|імя|recruiter|recruteur|HR)[^\]>]*?[\]>]/gi, '')
      .replace(/[\[<][^\]>]{1,40}[\]>]/g, '')
      .replace(/\*+/g, '')        // strip markdown emphasis asterisks (*bold*, **bold**)
      .replace(/\s{2,}/g, ' ')
      .replace(/^\s*\.\s*/gm, '')
      .trim()
    res.json({ data: text, salaryStrategy: salary })
  } catch (err: unknown) {
    res.json({ error: `AI error: ${(err as Error).message}` })
  }
})

export default router
