import axios from 'axios'
import https from 'https'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-sonnet-4-6'

// Some corporate networks intercept TLS — accept the chain (same as lib/llm.ts).
const httpsAgent = new https.Agent({ rejectUnauthorized: false })

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

/**
 * One call to Claude. `system` is the persona + knowledge base, `messages` is
 * the running conversation (candidate = user, bot = assistant).
 */
export async function callClaude(
  system: string,
  messages: ChatTurn[],
  opts: { maxTokens?: number; temperature?: number; timeoutMs?: number } = {},
): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY not configured')

  const { data } = await axios.post(
    ANTHROPIC_URL,
    {
      model: MODEL,
      max_tokens: opts.maxTokens ?? 600,
      temperature: opts.temperature ?? 0.7,
      system,
      messages,
    },
    {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: opts.timeoutMs ?? 40000,
      httpsAgent,
    },
  )

  const blocks = (data?.content ?? []) as Array<{ type: string; text?: string }>
  return blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('').trim()
}
