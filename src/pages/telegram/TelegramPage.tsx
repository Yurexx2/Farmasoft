import { useEffect, useLayoutEffect, useState, useRef, useCallback } from 'react'
import { telegramApi, messagingApi, TgConversation, TgConversationDetail, TgMessage, TgBotSettings, TgPeerState } from '../../api/client'
import { useAppStore } from '../../store/useAppStore'
import { T } from '../../i18n'
import { useIsMobile } from '../../hooks/useIsMobile'

// ─── helpers ─────────────────────────────────────────────────────────────────
function initialsOf(name?: string | null): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return parts.slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('')
}

// Telegram-style presence label for the thread header.
function presenceLabel(
  ps: TgPeerState | null, t: typeof T['ua']['tg'], locale: string,
): { text: string; online: boolean } | null {
  if (!ps || ps.presence === 'unknown') return null
  switch (ps.presence) {
    case 'online':       return { text: t.online, online: true }
    case 'recently':     return { text: t.seenRecently, online: false }
    case 'within_week':  return { text: t.seenWeek, online: false }
    case 'within_month': return { text: t.seenMonth, online: false }
    case 'offline': {
      if (!ps.lastSeen) return null
      const d = new Date(ps.lastSeen * 1000)
      const sameDay = new Date().toDateString() === d.toDateString()
      const when = sameDay
        ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' })
      return { text: `${t.seenPrefix} ${when}`, online: false }
    }
  }
  return null
}

function timeAgo(iso?: string | null, locale = 'uk-UA'): string {
  if (!iso) return ''
  const d = new Date(iso.includes('Z') || iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z')
  const diff = Date.now() - d.getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  return d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' })
}

// Telegram-style outlined trash icon.
const iconTrash = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </svg>
)

// ─── main page ───────────────────────────────────────────────────────────────
export function TelegramPage() {
  const { uiLang } = useAppStore()
  const t = T[uiLang].tg
  const locale = T[uiLang].locale
  const isMobile = useIsMobile()

  const [settings, setSettings] = useState<TgBotSettings | null>(null)
  const [conversations, setConversations] = useState<TgConversation[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const autoTried = useRef(false)

  const loadConversations = useCallback(async () => {
    const r = await telegramApi.conversations()
    if (r.data) setConversations(r.data)
    setLoading(false)
  }, [])

  const loadSettings = useCallback(async () => {
    const r = await telegramApi.settings()
    if (r.data) setSettings(r.data)
    return r.data
  }, [])

  // Re-establish the Telegram link from the saved session — no code needed.
  // The userbot connection lives in the server's memory and is dropped on
  // every redeploy/restart, so the deployed site must reload it.
  const reconnect = useCallback(async () => {
    await messagingApi.telegram.reload()
    await loadSettings()
  }, [loadSettings])

  useEffect(() => {
    loadConversations()
    loadSettings().then(s => {
      // First time we land on the page disconnected → try once automatically.
      if (s && !s.connected && !autoTried.current) {
        autoTried.current = true
        reconnect()
      }
    })
  }, [loadSettings, loadConversations, reconnect])

  // Poll the conversation list so new replies / drafts surface on their own.
  useEffect(() => {
    const id = setInterval(loadConversations, 8000)
    return () => clearInterval(id)
  }, [loadConversations])

  const selected = conversations.find(c => c.id === selectedId) || null
  const draftsTotal = conversations.reduce((s, c) => s + (c.draft_count || 0), 0)

  if (!settings) {
    return <div style={{ padding: 40, color: 'var(--text-3)' }}>{T[uiLang].dashboard.loading}</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <Header settings={settings} onChange={loadSettings} t={t} draftsTotal={draftsTotal} />

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', gap: 0 }}>
        {/* Conversation list */}
        {(!isMobile || selectedId === null) && (
          <div style={{
            width: isMobile ? '100%' : 340, flexShrink: 0, overflowY: 'auto',
            borderRight: isMobile ? 'none' : '1px solid var(--border)',
          }}>
            {loading ? (
              <div style={{ padding: 24, color: 'var(--text-3)', fontSize: 13 }}>{T[uiLang].dashboard.loading}</div>
            ) : conversations.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center' }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{t.noConversations}</div>
                <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 }}>{t.noConversationsHint}</div>
              </div>
            ) : (
              conversations.map(c => (
                <ConversationRow
                  key={c.id} conv={c} active={c.id === selectedId}
                  locale={locale} t={t}
                  onClick={() => {
                    setSelectedId(c.id)
                    // Clear the unread dot immediately (server clears it too).
                    setConversations(prev => prev.map(x => x.id === c.id ? { ...x, unread: 0 } : x))
                  }}
                />
              ))
            )}
          </div>
        )}

        {/* Thread */}
        {(!isMobile || selectedId !== null) && (
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {selected ? (
              <Thread
                key={selected.id} convId={selected.id} initialConv={selected}
                t={t} locale={locale} isMobile={isMobile}
                onBack={() => setSelectedId(null)}
                onChanged={loadConversations}
                onDeleted={() => { setSelectedId(null); loadConversations() }}
              />
            ) : (
              <div style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--text-3)', fontSize: 13,
              }}>{t.selectConversation}</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── header — title + global bot settings ──────────────────────────────────
function Header({ settings, onChange, t, draftsTotal }: {
  settings: TgBotSettings
  onChange: () => void
  t: typeof T['ua']['tg']
  draftsTotal: number
}) {
  const [showKnowledge, setShowKnowledge] = useState(false)

  async function save(patch: Partial<Pick<TgBotSettings, 'mode'>>) {
    await telegramApi.saveSettings(patch)
    onChange()
  }

  return (
    <div style={{ padding: '20px 24px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: -0.3 }}>{t.title}</h1>
          <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-3)' }}>
            {t.desc}
            {draftsTotal > 0 && (
              <span style={{ color: '#229ED9', fontWeight: 600 }}> · {t.draftsWaiting(draftsTotal)}</span>
            )}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowKnowledge(true)}>
            📖 {t.knowledge}
          </button>

          {/* Mode pills — the only bot control. The bot is always active. */}
          <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 9, overflow: 'hidden' }}>
            {(['review', 'auto'] as const).map(m => (
              <button
                key={m} onClick={() => save({ mode: m })}
                title={m === 'review' ? t.modeReviewHint : t.modeAutoHint}
                style={{
                  padding: '7px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: 'none',
                  background: settings.mode === m ? 'var(--accent)' : 'var(--surface)',
                  color: settings.mode === m ? '#fff' : 'var(--text-2)',
                }}
              >{m === 'review' ? t.modeReview : t.modeAuto}</button>
            ))}
          </div>
        </div>
      </div>

      {showKnowledge && <KnowledgeModal t={t} onClose={() => setShowKnowledge(false)} />}
    </div>
  )
}

// ─── knowledge base editor ──────────────────────────────────────────────────
function KnowledgeModal({ t, onClose }: { t: typeof T['ua']['tg']; onClose: () => void }) {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)

  useEffect(() => {
    telegramApi.knowledge().then(r => { setText(r.data?.text ?? ''); setLoading(false) })
  }, [])

  async function save(newText: string) {
    setBusy(true)
    const r = await telegramApi.saveKnowledge(newText)
    if (r.data) setText(r.data.text)
    setBusy(false)
    setSavedFlash(true)
    setTimeout(() => setSavedFlash(false), 1500)
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(4px)',
        zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--surface)', borderRadius: 16, width: 720, maxWidth: '96vw',
          height: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <div style={{
          padding: '18px 22px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
        }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{t.knowledge}</h2>
            <p style={{ margin: '5px 0 0', fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5, maxWidth: 540 }}>
              {t.knowledgeHint}
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--text-3)' }}>✕</button>
        </div>

        <div style={{ padding: 18, flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex' }}>
          {loading ? (
            <div style={{ color: 'var(--text-3)', fontSize: 13 }}>…</div>
          ) : (
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              spellCheck={false}
              style={{
                flex: 1, width: '100%', height: '100%', resize: 'none', overflowY: 'auto',
                padding: 14, borderRadius: 10, fontSize: 12.5,
                border: '1px solid var(--border)', background: 'var(--surface-2)',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: 1.6,
                boxSizing: 'border-box',
              }}
            />
          )}
        </div>

        <div style={{
          padding: '14px 22px', borderTop: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        }}>
          <button
            className="btn btn-ghost btn-sm" disabled={busy}
            onClick={() => { if (confirm(t.knowledgeResetConfirm)) save('') }}
          >{t.knowledgeReset}</button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={onClose}>{t.close}</button>
            <button className="btn btn-primary btn-sm" disabled={busy || loading} onClick={() => save(text)}>
              {savedFlash ? t.saved : t.save}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── conversation list row ──────────────────────────────────────────────────
function ConversationRow({ conv, active, locale, t, onClick }: {
  conv: TgConversation
  active: boolean
  locale: string
  t: typeof T['ua']['tg']
  onClick: () => void
}) {
  const name = conv.candidate_full_name || conv.candidate_name || conv.peer_name || '—'
  const preview = (conv.last_direction === 'out' ? '↪ ' : '') + (conv.last_text || '')
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex', gap: 11, padding: '12px 16px', cursor: 'pointer',
        borderBottom: '1px solid var(--border)',
        background: active ? 'var(--surface-2)' : 'transparent',
      }}
    >
      <Avatar name={name} photo={conv.candidate_photo} size={40} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
          <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{timeAgo(conv.last_at, locale)}</span>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
          {conv.candidate_role || conv.job_title || ''}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
          <span style={{ fontSize: 12, color: 'var(--text-2)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {preview}
          </span>
          {conv.draft_count > 0 && (
            <span style={{
              fontSize: 10, fontWeight: 700, color: '#fff', background: '#229ED9',
              padding: '1px 6px', borderRadius: 7,
            }}>{t.draftPending.split(' ')[0]}</span>
          )}
          {/* Unread dot — appears on a new candidate message, clears on open. */}
          {conv.unread === 1 && (
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#F59E0B', flexShrink: 0 }} />
          )}
        </div>
      </div>
    </div>
  )
}

function Avatar({ name, photo, size }: { name: string; photo?: string | null; size: number }) {
  if (photo) {
    return <img src={photo} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: '#229ED922', color: '#1B7FAE',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.36, fontWeight: 700,
    }}>{initialsOf(name)}</div>
  )
}

// ─── thread view ────────────────────────────────────────────────────────────
function Thread({ convId, initialConv, t, locale, isMobile, onBack, onChanged, onDeleted }: {
  convId: number
  initialConv: TgConversation
  t: typeof T['ua']['tg']
  locale: string
  isMobile: boolean
  onBack: () => void
  onChanged: () => void
  onDeleted: () => void
}) {
  // Seed from the list row so the header renders instantly; the full detail
  // (messages, phone) fills in on the first fetch.
  const [conv, setConv] = useState<TgConversationDetail | null>(initialConv as unknown as TgConversationDetail)
  const [messages, setMessages] = useState<TgMessage[]>([])
  const [peerState, setPeerState] = useState<TgPeerState | null>(null)
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const loadedDraftRef = useRef<number | null>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)

  // Composer auto-grows with its content up to 3 lines, then scrolls.
  const COMPOSER_MAX = 88
  const autoGrow = useCallback(() => {
    const el = composerRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, COMPOSER_MAX) + 'px'
  }, [])

  const load = useCallback(async () => {
    const r = await telegramApi.conversation(convId)
    if (r.data) {
      setConv(r.data.conversation)
      setMessages(r.data.messages)
      setPeerState(r.data.peerState)
    }
  }, [convId])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const id = setInterval(load, 6000)
    return () => clearInterval(id)
  }, [load])

  // Stick to the bottom as messages come in.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages.length])

  // Resize the composer whenever its text changes — typing or a loaded draft.
  // useLayoutEffect runs before paint, so the box never jumps a frame.
  useLayoutEffect(() => { autoGrow() }, [reply, autoGrow])

  // In review mode the bot's suggested reply is loaded straight into the
  // composer for Alena to edit or send. Each draft is loaded only once, so
  // clearing the box keeps it cleared.
  const draft = messages.find(m => m.status === 'pending_review')
  useEffect(() => {
    if (draft && loadedDraftRef.current !== draft.id) {
      loadedDraftRef.current = draft.id
      setReply(draft.text)
    }
  }, [draft])

  if (!conv) return <div style={{ padding: 24, color: 'var(--text-3)' }}>{T['ua'].dashboard.loading}</div>

  const name = conv.candidate_full_name || conv.candidate_name || conv.peer_name || '—'
  const presence = presenceLabel(peerState, t, locale)
  const readMax = peerState?.readOutboxMaxId ?? 0
  const visible = messages.filter(m => m.status !== 'pending_review' && m.status !== 'discarded')

  // Runs an action and surfaces any API error to the user (the send/approve
  // endpoints return { error } rather than throwing).
  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    setErr('')
    const r = await fn()
    if (r && typeof r === 'object' && 'error' in r && (r as { error?: string }).error) {
      setErr(String((r as { error?: string }).error))
    }
    await load()
    onChanged()
    setBusy(false)
  }

  // Send the typed message; keep the text in the box if the send failed so
  // nothing is lost. A pending bot suggestion is consumed once sent.
  async function doSend() {
    const text = reply.trim()
    if (!text) return
    const pending = messages.find(m => m.status === 'pending_review')
    await act(async () => {
      const r = await telegramApi.send(convId, text)
      if (!r.error) {
        setReply('')
        if (pending) await telegramApi.discardDraft(pending.id)
      }
      return r
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* thread header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        {isMobile && (
          <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--text-2)' }}>←</button>
        )}
        <Avatar name={name} photo={conv.candidate_photo} size={36} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 5, overflow: 'hidden', whiteSpace: 'nowrap' }}>
            {presence && (
              <span style={{ color: presence.online ? '#16A34A' : 'var(--text-3)', fontWeight: presence.online ? 600 : 400 }}>
                {presence.text}
              </span>
            )}
            {presence && (conv.candidate_role || conv.job_title) && <span>·</span>}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {conv.candidate_role || conv.job_title || ''}
            </span>
          </div>
        </div>
        <button
          title={t.delete} disabled={busy}
          onClick={() => { if (confirm(t.deleteConfirm)) act(async () => { await telegramApi.remove(convId); onDeleted() }) }}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)',
            padding: 4, lineHeight: 0, flexShrink: 0,
          }}
        >{iconTrash}</button>
      </div>

      {/* messages */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '16px', background: 'var(--surface-2)' }}>
        {visible.map(m => (
          <Bubble
            key={m.id} msg={m} locale={locale} t={t} readMax={readMax}
            onDelete={() => { if (confirm(t.deleteMsgConfirm)) act(() => telegramApi.deleteMessage(m.id)) }}
          />
        ))}
      </div>

      {/* composer */}
      {err && (
        <div style={{
          padding: '8px 16px', background: '#FEF2F2', color: '#DC2626', fontSize: 12,
          borderTop: '1px solid #FCA5A5', flexShrink: 0,
        }}>⚠ {err}</div>
      )}
      <div style={{ display: 'flex', gap: 8, padding: '12px 16px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        <textarea
          ref={composerRef}
          value={reply}
          onChange={e => setReply(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (reply.trim()) doSend()
            }
          }}
          placeholder={t.writeMessage}
          rows={1}
          style={{
            flex: 1, resize: 'none', padding: '9px 12px', borderRadius: 9, fontSize: 13,
            lineHeight: 1.45,
            border: '1px solid var(--border)', background: 'var(--surface-2)', fontFamily: 'inherit',
            boxSizing: 'border-box', maxHeight: COMPOSER_MAX, overflowY: 'auto',
          }}
        />
        <button
          className="btn btn-primary btn-sm" disabled={busy || !reply.trim()}
          onClick={doSend}
        >{t.send}</button>
      </div>
    </div>
  )
}

function Bubble({ msg, locale, t, readMax, onDelete }: {
  msg: TgMessage; locale: string; t: typeof T['ua']['tg']; readMax: number; onDelete: () => void
}) {
  const [hover, setHover] = useState(false)
  const incoming = msg.direction === 'in'
  const senderLabel = msg.sender === 'bot' ? t.senderBot : msg.sender === 'alena' ? t.senderAlena : t.senderCandidate
  // Read ticks for our messages: ✓✓ once the candidate has read it, else ✓.
  const sentTg = !incoming && msg.tg_message_id != null
  const read = sentTg && (msg.tg_message_id as number) <= readMax
  // A media placeholder like "[стікер 👋]" — shown as a discreet label, no brackets.
  const mediaMatch = msg.text.trim().match(/^\[(.+)\]$/)
  const media = mediaMatch ? mediaMatch[1].charAt(0).toUpperCase() + mediaMatch[1].slice(1) : null
  const delBtn = (
    <button
      onClick={onDelete} title={t.delete}
      style={{
        background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)',
        padding: 4, flexShrink: 0, lineHeight: 0,
        opacity: hover ? 0.85 : 0, transition: 'opacity 120ms',
      }}
    >{iconTrash}</button>
  )
  return (
    <div
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', marginBottom: 8, justifyContent: incoming ? 'flex-start' : 'flex-end' }}
    >
      <div style={{ maxWidth: '78%' }}>
        <div style={{
          fontSize: 10, color: 'var(--text-3)', marginBottom: 2,
          textAlign: incoming ? 'left' : 'right',
        }}>
          {senderLabel} · {timeAgo(msg.created_at, locale)}
          {sentTg && (
            <span style={{ marginLeft: 4, color: read ? '#229ED9' : 'var(--text-3)', fontWeight: 700 }}>
              {read ? '✓✓' : '✓'}
            </span>
          )}
        </div>
        {/* bubble + trash on one row → the trash is centred on the bubble */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4,
                      flexDirection: incoming ? 'row' : 'row-reverse' }}>
          {media ? (
            /* media message (sticker, photo…) — rendered as a discreet label */
            <div style={{
              padding: '7px 12px', borderRadius: 12, fontSize: 12.5, fontStyle: 'italic',
              background: 'var(--surface-2)', color: 'var(--text-3)',
              border: '1px dashed var(--border)',
            }}>{media}</div>
          ) : (
            <div style={{
              padding: '8px 12px', borderRadius: 12, fontSize: 13, lineHeight: 1.45, whiteSpace: 'pre-wrap',
              background: incoming ? 'var(--surface)' : (msg.sender === 'bot' ? '#229ED9' : 'var(--accent)'),
              color: incoming ? 'var(--text-1)' : '#fff',
              border: incoming ? '1px solid var(--border)' : 'none',
              borderBottomLeftRadius: incoming ? 3 : 12,
              borderBottomRightRadius: incoming ? 12 : 3,
            }}>{msg.text}</div>
          )}
          {delBtn}
        </div>
      </div>
    </div>
  )
}

