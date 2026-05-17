import { useState, useEffect, useRef } from 'react'
import { useAppStore, Page } from '../../store/useAppStore'
import { T } from '../../i18n'
import { api, RobotaConfig, messagingApi, MessagingStatus } from '../../api/client'
import { useIsMobile } from '../../hooks/useIsMobile'

interface NavItem { id: Page; label: string; icon: JSX.Element }

// Derive a display name + initials from the connected robota.ua account email.
// e.g. "alena.pryhodko@farmasoft.ua" → { name: "Alena Pryhodko", initials: "AP" }
function identityFromEmail(email?: string): { name: string; initials: string } {
  if (!email) return { name: 'User', initials: 'U' }
  const local = email.split('@')[0]
  const parts = local.split(/[._-]+/).filter(Boolean)
  if (parts.length === 0) return { name: 'User', initials: 'U' }
  const name = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
  const initials = parts.slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('')
  return { name, initials: initials || 'U' }
}

const iconDashboard = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2" width="5.5" height="5.5" rx="1.5" />
    <rect x="8.5" y="2" width="5.5" height="5.5" rx="1.5" />
    <rect x="2" y="8.5" width="5.5" height="5.5" rx="1.5" />
    <rect x="8.5" y="8.5" width="5.5" height="5.5" rx="1.5" />
  </svg>
)
const iconFile = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5l-3-3z" />
    <path d="M10 2v3h3" /><line x1="5.5" y1="8" x2="10.5" y2="8" /><line x1="5.5" y1="10.5" x2="8.5" y2="10.5" />
  </svg>
)

// ─────────────────────────────────────────────────────────────────────────
// Profile Menu — large modal with all connections (robota.ua, channels, calendly)
// ─────────────────────────────────────────────────────────────────────────
function ProfileMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { uiLang } = useAppStore()
  const tc = T[uiLang].connections
  const [robotaConfig, setRobotaConfig] = useState<RobotaConfig | null>(null)
  const [channelStatus, setChannelStatus] = useState<MessagingStatus | null>(null)
  const [activeChannel, setActiveChannel] = useState<'robota' | 'telegram' | 'calendly' | 'email' | null>(null)

  async function refresh() {
    const [r1, r2] = await Promise.all([api.robota.config(), messagingApi.status()])
    if (r1.data) setRobotaConfig(r1.data)
    if (r2.data) setChannelStatus(r2.data)
  }

  useEffect(() => { if (open) refresh() }, [open])

  if (!open) return null

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.55)', backdropFilter: 'blur(4px)',
      zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--surface)', borderRadius: 18,
        width: 520, maxWidth: '95vw', maxHeight: '88vh',
        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '20px 24px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: -0.2 }}>{tc.title}</h2>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-3)' }}>
              {tc.subtitle}
            </p>
          </div>
          <button onClick={onClose} style={{
            background: 'var(--surface-2)', border: 'none', cursor: 'pointer',
            width: 32, height: 32, borderRadius: '50%', color: 'var(--text-2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
            transition: 'background 120ms',
          }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--border)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface-2)' }}
          >×</button>
        </div>

        {/* Body — scrollable */}
        <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1 }}>
          <SectionTitle>{tc.sourceAccount}</SectionTitle>
          <Card
            icon={iconRobota} brandColor="#1A4A8A"
            name="robota.ua"
            subtitle={tc.robotaSubtitle}
            status={robotaConfig?.robota_configured ? 'connected' : 'disconnected'}
            identity={robotaConfig?.robota_email || undefined}
            onConnect={() => setActiveChannel('robota')}
            onDisconnect={async () => {
              if (!confirm(tc.confirmRobota)) return
              await api.robota.disconnect()
              await refresh()
            }}
          />

          <SectionTitle style={{ marginTop: 24 }}>{tc.sendingChannels}</SectionTitle>
          <Card
            icon={iconTelegram} brandColor="#229ED9"
            name="Telegram"
            subtitle={tc.telegramSubtitle}
            status={channelStatus?.telegram?.connected ? 'connected' : 'disconnected'}
            identity={channelStatus?.telegram?.identity}
            onConnect={() => setActiveChannel('telegram')}
            onDisconnect={async () => {
              if (!confirm(tc.confirmTelegram)) return
              await messagingApi.telegram.disconnect()
              await refresh()
            }}
          />
          <Card
            icon={iconViber} brandColor="#7360F2"
            name="Viber"
            subtitle={tc.viberSubtitle}
            status="disconnected"
            comingSoon
          />
          <Card
            icon={iconEmail} brandColor="#0078D4"
            name="Email"
            subtitle={tc.emailSubtitle}
            status={channelStatus?.email?.configured ? 'connected' : 'disconnected'}
            identity={channelStatus?.email?.identity}
            onConnect={() => setActiveChannel('email')}
            onDisconnect={async () => {
              if (!confirm(tc.confirmEmail)) return
              await api.robota.smtpDisconnect()
              await refresh()
            }}
          />

          <SectionTitle style={{ marginTop: 24 }}>{tc.meetingScheduling}</SectionTitle>
          <Card
            icon={iconCalendly} brandColor="#006BFF"
            name="Calendly"
            subtitle={tc.calendlySubtitle}
            status={robotaConfig?.calendly_url ? 'connected' : 'disconnected'}
            identity={robotaConfig?.calendly_url || undefined}
            onConnect={() => setActiveChannel('calendly')}
            onDisconnect={async () => {
              if (!confirm(tc.confirmCalendly)) return
              await api.robota.saveConfig({ calendly_url: '' })
              await refresh()
            }}
          />
        </div>
      </div>

      {activeChannel === 'robota'   && <RobotaConnectModal   onClose={() => { setActiveChannel(null); refresh() }} />}
      {activeChannel === 'telegram' && <TelegramConnectModal onClose={() => { setActiveChannel(null); refresh() }} />}
      {activeChannel === 'calendly' && <CalendlyConnectModal initial={robotaConfig?.calendly_url || ''} onClose={() => { setActiveChannel(null); refresh() }} />}
      {activeChannel === 'email'    && <EmailConnectModal    onClose={() => { setActiveChannel(null); refresh() }} />}
    </div>
  )
}

// ─── Brand icons ─────────────────────────────────────────────────────────
const iconRobota = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="7" width="18" height="13" rx="2" />
    <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
)
const iconTelegram = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/>
  </svg>
)
const iconWhatsApp = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
  </svg>
)
const iconViber = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <path d="M11.4 0C9.473.028 5.333.344 3.02 2.467 1.302 4.187.696 6.7.633 9.817.57 12.933.488 18.776 6.121 20.36h.005l-.005 2.416s-.034.97.61 1.17c.778.244 1.232-.495 1.974-1.295.408-.43.965-1.077 1.387-1.55 3.852.32 6.815-.418 7.15-.527.78-.252 5.184-.812 5.9-6.638.736-6.013-.36-9.812-2.34-11.532l-.012-.005c-.595-.546-2.987-2.292-8.32-2.31 0 0-.39-.026-1.072-.022zm.06 1.717c.578-.004.93.018.93.018 4.518.014 6.673 1.382 7.18 1.84 1.674 1.434 2.534 4.864 1.913 9.85-.61 4.864-4.18 5.17-4.836 5.38-.282.092-2.875.732-6.146.534 0 0-2.443 2.946-3.207 3.708-.117.123-.255.166-.347.142-.13-.034-.166-.187-.165-.413l.022-4.014c-4.762-1.32-4.484-6.282-4.43-8.882.052-2.601.541-4.732 1.99-6.166 1.953-1.787 5.477-2.04 7.115-2.046zm.31 2.498a.41.41 0 00-.41.41.41.41 0 00.41.41c1.246-.01 2.276.404 3.087 1.21.81.81 1.224 1.82 1.214 3.066a.41.41 0 00.41.412.41.41 0 00.412-.41c.01-1.45-.483-2.694-1.435-3.65-.954-.953-2.198-1.448-3.65-1.438a.41.41 0 00-.038 0zm-3.55.625a.94.94 0 00-.444.085L6.62 5.61c-.582.343-.92 1.018-.692 1.644 0 .013.01.024.012.034l.71 1.604c.342.748.846 1.426 1.495 2.07a8.04 8.04 0 002.07 1.493l1.605.71c.013.005.024.013.038.018.625.227 1.3-.113 1.643-.694l.685-1.052a.94.94 0 00-.207-1.247l-1.246-.886a.625.625 0 00-.84.092l-.51.652c-.26.323-.732.28-.732.28-1.745-.446-2.21-2.213-2.21-2.213s-.043-.473.28-.733l.65-.51a.625.625 0 00.092-.84L8.83 4.84a.94.94 0 00-.61-.34zm3.49 1.35a.41.41 0 00-.41.41.41.41 0 00.41.41c.685-.01 1.187.198 1.555.572.366.374.572.872.562 1.557a.41.41 0 00.41.41.41.41 0 00.412-.41c.012-.886-.275-1.642-.793-2.166-.518-.524-1.275-.815-2.16-.802a.41.41 0 00-.014 0zm.18 1.314a.41.41 0 00-.018.823c.31.01.54.108.692.262.152.155.244.387.247.687a.41.41 0 00.41.41.41.41 0 00.412-.412c-.005-.435-.146-.85-.484-1.198-.337-.348-.762-.495-1.197-.5z"/>
  </svg>
)
const iconEmail = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="M2 6l10 7 10-7" />
  </svg>
)
const iconCalendly = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="17" rx="2" />
    <path d="M3 10h18M8 2v4M16 2v4" />
    <circle cx="12" cy="15" r="2" fill="currentColor" stroke="none" />
  </svg>
)

function SectionTitle({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase',
      letterSpacing: 1, marginBottom: 12, ...style,
    }}>{children}</div>
  )
}

function Card({ icon, brandColor, name, subtitle, status, identity, onConnect, onDisconnect, readonly, comingSoon }: {
  icon?: React.ReactNode
  brandColor?: string
  name: string
  subtitle?: string
  status: 'connected' | 'disconnected'
  identity?: string
  onConnect?: () => void
  onDisconnect?: () => void
  readonly?: boolean
  comingSoon?: boolean
}) {
  const { uiLang } = useAppStore()
  const tc = T[uiLang].connections
  const ok = status === 'connected'
  return (
    <div style={{
      padding: 14, marginBottom: 8, borderRadius: 12,
      background: 'var(--surface)',
      border: `1px solid ${ok ? '#BBF7D0' : 'var(--border)'}`,
      display: 'flex', alignItems: 'center', gap: 14,
      transition: 'border-color 150ms, box-shadow 150ms',
      boxShadow: ok ? '0 1px 2px rgba(22, 163, 74, 0.06)' : 'none',
      opacity: comingSoon ? 0.6 : 1,
    }}>
      {icon && (
        <div style={{
          width: 40, height: 40, borderRadius: 10, flexShrink: 0,
          background: brandColor ? `${brandColor}14` : 'var(--surface-2)',
          color: brandColor || 'var(--text-2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{icon}</div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="flex items-center gap-8" style={{ marginBottom: 2 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-1)' }}>{name}</span>
          {!comingSoon && (
            <span style={{
              width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
              background: ok ? '#16A34A' : 'var(--text-3)',
            }} title={ok ? tc.connected : tc.notConnected} />
          )}
        </div>
        {identity ? (
          <div style={{ fontSize: 12, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {identity}
          </div>
        ) : subtitle ? (
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{subtitle}</div>
        ) : null}
      </div>
      {comingSoon ? (
        <span style={{
          fontSize: 11, padding: '5px 10px', borderRadius: 8, fontWeight: 500,
          background: 'var(--surface-2)', color: 'var(--text-3)',
          border: '1px solid var(--border)', flexShrink: 0,
        }}>{T[uiLang].channels.comingSoon}</span>
      ) : !readonly && (
        ok ? (
          <button onClick={onDisconnect} style={{
            fontSize: 12, padding: '7px 12px', borderRadius: 8, fontWeight: 500,
            background: 'transparent', color: 'var(--text-3)',
            border: '1px solid var(--border)', cursor: 'pointer', flexShrink: 0,
            transition: 'all 120ms',
          }}
            onMouseEnter={e => { e.currentTarget.style.background = '#FEF2F2'; e.currentTarget.style.color = '#DC2626'; e.currentTarget.style.borderColor = '#FCA5A5' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-3)'; e.currentTarget.style.borderColor = 'var(--border)' }}
          >{tc.disconnect}</button>
        ) : (
          <button onClick={onConnect} style={{
            fontSize: 12, padding: '7px 14px', borderRadius: 8, fontWeight: 600,
            background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer', flexShrink: 0,
            transition: 'opacity 120ms',
          }}
            onMouseEnter={e => { e.currentTarget.style.opacity = '0.9' }}
            onMouseLeave={e => { e.currentTarget.style.opacity = '1' }}
          >{tc.connect}</button>
        )
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Connect Modals
// ─────────────────────────────────────────────────────────────────────────
function ModalShell({ title, onClose, width = 460, children }: {
  title: string; onClose: () => void; width?: number; children: React.ReactNode
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1100,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        background: 'var(--surface)', borderRadius: 14, padding: 24, width, maxWidth: '95vw',
      }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-16">
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--text-3)' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

function Field({ label, value, onChange, placeholder, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--text-2)' }}>{label}</label>
      <input
        type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{
          width: '100%', padding: '8px 12px', borderRadius: 8, fontSize: 13,
          border: '1px solid var(--border)', background: 'var(--surface-2)', boxSizing: 'border-box',
        }} />
    </div>
  )
}

function RobotaConnectModal({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function connect() {
    if (!email || !password) return
    setLoading(true); setError('')
    const r = await api.robota.auth(email, password)
    setLoading(false)
    if (r.error) setError(r.error)
    else onClose()
  }

  return (
    <ModalShell title="Connect robota.ua" onClose={onClose}>
      <p style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 14 }}>
        Employer account credentials for robota.ua. Once connected, the account stays connected.
      </p>
      <Field label="Email" value={email} onChange={setEmail} placeholder="alena.pryhodko@farmasoft.ua" type="email" />
      <Field label="Password" value={password} onChange={setPassword} placeholder="••••••••" type="password" />
      {error && <p style={{ color: '#DC2626', fontSize: 12, marginTop: 4 }}>{error}</p>}
      <div className="flex gap-8 justify-end mt-16">
        <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary btn-sm" onClick={connect} disabled={loading || !email || !password}>
          {loading ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </ModalShell>
  )
}

function WhatsAppConnectModal({ onClose }: { onClose: () => void }) {
  const [accountSid, setAccountSid] = useState('')
  const [authToken, setAuthToken] = useState('')
  const [fromNumber, setFromNumber] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function connect() {
    setLoading(true); setError('')
    const r = await messagingApi.whatsapp.connect({ accountSid, authToken, fromNumber })
    setLoading(false)
    if (r.error) setError(r.error)
    else onClose()
  }

  return (
    <ModalShell title="Connect WhatsApp (Twilio)" onClose={onClose}>
      <p style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 14 }}>
        Get your credentials on <a href="https://console.twilio.com" target="_blank" rel="noopener">console.twilio.com</a>.
      </p>
      <Field label="Account SID" value={accountSid} onChange={setAccountSid} placeholder="ACxxxxxxxxxxxxxxxxxxxx" />
      <Field label="Auth Token" value={authToken} onChange={setAuthToken} type="password" />
      <Field label="WhatsApp number" value={fromNumber} onChange={setFromNumber} placeholder="+38050XXXXXXX" />
      {error && <p style={{ color: '#DC2626', fontSize: 12, marginTop: 4 }}>{error}</p>}
      <div className="flex gap-8 justify-end mt-16">
        <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary btn-sm" onClick={connect} disabled={loading || !accountSid || !authToken || !fromNumber}>
          {loading ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </ModalShell>
  )
}

function ViberConnectModal({ onClose }: { onClose: () => void }) {
  const [token, setToken] = useState('')
  const [senderName, setSenderName] = useState('Farmasoft')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function connect() {
    setLoading(true); setError('')
    const r = await messagingApi.viber.connect({ token, senderName })
    setLoading(false)
    if (r.error) setError(r.error)
    else onClose()
  }

  return (
    <ModalShell title="Connect Viber (TurboSMS)" onClose={onClose}>
      <p style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 14 }}>
        Sign up on <a href="https://turbosms.ua" target="_blank" rel="noopener">turbosms.ua</a> → API.
      </p>
      <Field label="API token" value={token} onChange={setToken} type="password" />
      <Field label="Sender name" value={senderName} onChange={setSenderName} placeholder="Farmasoft" />
      {error && <p style={{ color: '#DC2626', fontSize: 12, marginTop: 4 }}>{error}</p>}
      <div className="flex gap-8 justify-end mt-16">
        <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary btn-sm" onClick={connect} disabled={loading || !token || !senderName}>
          {loading ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </ModalShell>
  )
}

function TelegramConnectModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<'creds' | 'code' | 'password'>('creds')
  const [apiId, setApiId] = useState('')
  const [apiHash, setApiHash] = useState('')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function start() {
    setLoading(true); setError('')
    const r = await messagingApi.telegram.start({ apiId: parseInt(apiId), apiHash, phone })
    setLoading(false)
    if (r.error) setError(r.error)
    else setStep('code')
  }

  async function submitCode() {
    setLoading(true); setError('')
    const r = await messagingApi.telegram.code(code)
    setLoading(false)
    if (r.error) { setError(r.error); return }
    if (r.data?.needsPassword) { setStep('password'); return }
    onClose()
  }

  async function submitPassword() {
    setLoading(true); setError('')
    const r = await messagingApi.telegram.password(password)
    setLoading(false)
    if (r.error) { setError(r.error); return }
    onClose()
  }

  return (
    <ModalShell title="Connect Telegram (personal account)" onClose={onClose} width={520}>
      {step === 'creds' && (
        <>
          <p style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 14, lineHeight: 1.6 }}>
            Go to <a href="https://my.telegram.org/apps" target="_blank" rel="noopener">my.telegram.org/apps</a>, create an "App" and copy api_id + api_hash.
          </p>
          <Field label="api_id" value={apiId} onChange={setApiId} placeholder="12345678" />
          <Field label="api_hash" value={apiHash} onChange={setApiHash} type="password" />
          <Field label="Phone number" value={phone} onChange={setPhone} placeholder="+380XX XXX XX XX" />
          {error && <p style={{ color: '#DC2626', fontSize: 12, marginTop: 4 }}>{error}</p>}
          <div className="flex gap-8 justify-end mt-16">
            <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary btn-sm" onClick={start} disabled={loading || !apiId || !apiHash || !phone}>
              {loading ? 'Sending…' : 'Send code'}
            </button>
          </div>
        </>
      )}
      {step === 'code' && (
        <>
          <p style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 14 }}>
            A code was sent via your Telegram app. Enter it below:
          </p>
          <Field label="Code" value={code} onChange={setCode} placeholder="12345" />
          {error && <p style={{ color: '#DC2626', fontSize: 12, marginTop: 4 }}>{error}</p>}
          <div className="flex gap-8 justify-end mt-16">
            <button className="btn btn-ghost btn-sm" onClick={() => setStep('creds')}>Back</button>
            <button className="btn btn-primary btn-sm" onClick={submitCode} disabled={loading || !code}>
              {loading ? 'Verifying…' : 'Confirm'}
            </button>
          </div>
        </>
      )}
      {step === 'password' && (
        <>
          <p style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 14 }}>
            Two-factor authentication is enabled. Enter your Telegram password:
          </p>
          <Field label="Password" value={password} onChange={setPassword} type="password" />
          {error && <p style={{ color: '#DC2626', fontSize: 12, marginTop: 4 }}>{error}</p>}
          <div className="flex gap-8 justify-end mt-16">
            <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary btn-sm" onClick={submitPassword} disabled={loading || !password}>
              {loading ? 'Verifying…' : 'Confirm'}
            </button>
          </div>
        </>
      )}
    </ModalShell>
  )
}

type EmailPreset = 'gmail' | 'outlook' | 'custom'
const SMTP_PRESETS: Record<Exclude<EmailPreset, 'custom'>, { host: string; port: string; help: string }> = {
  gmail:   { host: 'smtp.gmail.com',     port: '465', help: 'Use a Gmail App Password (not your regular password). Create one at myaccount.google.com/apppasswords (2-step verification required).' },
  outlook: { host: 'smtp.office365.com', port: '587', help: 'Use your Microsoft 365 / Outlook email and password. If your account uses MFA, create an App Password in your Microsoft 365 security settings.' },
}

function EmailConnectModal({ onClose }: { onClose: () => void }) {
  const [preset, setPreset] = useState<EmailPreset>('outlook')
  const [host, setHost] = useState('smtp.office365.com')
  const [port, setPort] = useState('587')
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [from, setFrom] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  function setPresetAndDefaults(p: EmailPreset) {
    setPreset(p); setError('')
    if (p !== 'custom') {
      setHost(SMTP_PRESETS[p].host)
      setPort(SMTP_PRESETS[p].port)
    }
  }

  async function connect() {
    if (!host || !port || !user || !pass) { setError('All fields are required'); return }
    setLoading(true); setError('')
    const r = await api.robota.smtpConfig({ host, port, user, pass, from: from || user })
    setLoading(false)
    if (r.error) setError(r.error)
    else onClose()
  }

  return (
    <ModalShell title="Connect email (SMTP)" onClose={onClose} width={500}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {([
          ['gmail',   'Gmail'],
          ['outlook', 'Outlook 365'],
          ['custom',  'Custom SMTP'],
        ] as const).map(([id, label]) => (
          <button key={id} onClick={() => setPresetAndDefaults(id)} style={{
            flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 12, fontWeight: 500,
            border: `1px solid ${preset === id ? 'var(--accent)' : 'var(--border)'}`,
            background: preset === id ? 'var(--surface)' : 'var(--surface-2)',
            color: preset === id ? 'var(--text-1)' : 'var(--text-2)',
            cursor: 'pointer',
          }}>{label}</button>
        ))}
      </div>

      {preset !== 'custom' && (
        <p style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 14, lineHeight: 1.5 }}>
          {SMTP_PRESETS[preset].help}
        </p>
      )}

      <Field label="Email address" value={user} onChange={setUser} placeholder={preset === 'outlook' ? 'alena.pryhodko@farmasoft.ua' : 'you@example.com'} type="email" />
      <Field label="Password" value={pass} onChange={setPass} placeholder="••••••••••••••••" type="password" />
      {preset === 'custom' && (
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
          <Field label="SMTP host" value={host} onChange={setHost} placeholder="smtp.example.com" />
          <Field label="Port" value={port} onChange={setPort} placeholder="587" />
        </div>
      )}
      <Field label="Sender display address (optional)" value={from} onChange={setFrom} placeholder={user || 'leave empty to use the address above'} type="email" />

      {error && <p style={{ color: '#DC2626', fontSize: 12, marginTop: 4 }}>{error}</p>}

      <div className="flex gap-8 justify-end mt-16">
        <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary btn-sm" onClick={connect} disabled={loading || !user || !pass || !host || !port}>
          {loading ? 'Testing connection…' : 'Connect'}
        </button>
      </div>
    </ModalShell>
  )
}

function CalendlyConnectModal({ initial, onClose }: { initial: string; onClose: () => void }) {
  const [url, setUrl] = useState(initial)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function save() {
    if (!url.trim()) return
    if (!url.startsWith('https://calendly.com/') && !url.startsWith('http')) {
      setError('L\'URL doit commencer par https://calendly.com/...'); return
    }
    setLoading(true); setError('')
    const r = await api.robota.saveConfig({ calendly_url: url.trim() })
    setLoading(false)
    if (r.error) setError(r.error)
    else onClose()
  }

  return (
    <ModalShell title="Configure Calendly" onClose={onClose}>
      <p style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 14 }}>
        Calendly link used for booking interviews. Automatically added to generated messages (except Viber, which uses a separate CTA button).
      </p>
      <Field label="Calendly URL" value={url} onChange={setUrl} placeholder="https://calendly.com/yourname/30min" />
      {error && <p style={{ color: '#DC2626', fontSize: 12, marginTop: 4 }}>{error}</p>}
      <div className="flex gap-8 justify-end mt-16">
        <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={loading || !url.trim()}>
          {loading ? 'Saving…' : 'Save'}
        </button>
      </div>
    </ModalShell>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Sidebar
// ─────────────────────────────────────────────────────────────────────────
export function Sidebar() {
  const { currentPage, setPage, uiLang, sidebarOpen, setSidebarOpen } = useAppStore()
  const t = T[uiLang]
  const isMobile = useIsMobile()
  const [menuOpen, setMenuOpen] = useState(false)
  const [connected, setConnected] = useState(false)
  const [robotaEmail, setRobotaEmail] = useState('')
  const refreshRef = useRef(0)

  // On mobile a nav tap should also dismiss the slide-over drawer.
  const goToPage = (id: Page) => { setPage(id); if (isMobile) setSidebarOpen(false) }

  useEffect(() => {
    api.robota.config().then(r => {
      setConnected(!!r.data?.robota_configured)
      setRobotaEmail(r.data?.robota_email || '')
    })
  }, [menuOpen, refreshRef.current])

  const identity = identityFromEmail(robotaEmail)

  const navItems: NavItem[] = [
    { id: 'dashboard', label: t.nav.dashboard, icon: iconDashboard },
    { id: 'jobs',      label: t.nav.jobs,      icon: iconFile },
  ]

  // Desktop collapsed rail — never used on mobile (mobile uses the drawer below).
  if (!sidebarOpen && !isMobile) {
    return (
      <aside className="sidebar-collapsed" style={{ position: 'relative' }}>
        <nav className="sidebar-nav">
          {navItems.map(item => (
            <div
              key={item.id}
              className={`nav-item-icon${currentPage === item.id ? ' active' : ''}`}
              onClick={() => goToPage(item.id)}
              title={item.label}
            >
              {item.icon}
            </div>
          ))}
        </nav>
        <div style={{ marginTop: 'auto', position: 'relative' }}>
          <div
            onClick={() => setMenuOpen(true)}
            title="Connections"
            style={{
              width: 32, height: 32, borderRadius: '50%',
              background: 'var(--accent)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: '#fff', fontSize: 12, fontWeight: 600,
              lineHeight: '1', margin: '0 auto', cursor: 'pointer', position: 'relative',
            }}>
            {identity.initials}
            {connected && (
              <span style={{
                position: 'absolute', bottom: -2, right: -2, width: 10, height: 10,
                borderRadius: '50%', background: '#16A34A', border: '2px solid var(--surface)',
              }} />
            )}
          </div>
        </div>
        <ProfileMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
      </aside>
    )
  }

  return (
    <aside
      className={`sidebar${isMobile && sidebarOpen ? ' sidebar-mobile-open' : ''}`}
      style={{ position: 'relative' }}
    >
      <nav className="sidebar-nav">
        {navItems.map(item => (
          <div
            key={item.id}
            className={`nav-item${currentPage === item.id ? ' active' : ''}`}
            onClick={() => goToPage(item.id)}
          >
            {item.icon}
            {item.label}
          </div>
        ))}
      </nav>

      <div style={{ marginTop: 'auto', paddingTop: 16 }}>
        <div
          onClick={() => setMenuOpen(true)}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '10px 10px',
            background: 'var(--surface-2)', borderRadius: 12, cursor: 'pointer',
            transition: 'background 120ms ease',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--border)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface-2)' }}
        >
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <div style={{
              width: 32, height: 32, borderRadius: '50%',
              background: 'var(--accent)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: '#fff', fontSize: 12, fontWeight: 600,
              lineHeight: '1',
            }}>{identity.initials}</div>
            {connected && (
              <span style={{
                position: 'absolute', bottom: 0, right: 0, width: 10, height: 10,
                borderRadius: '50%', background: '#16A34A', border: '2px solid var(--surface-2)',
              }} />
            )}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{identity.name}</div>
            <div style={{ fontSize: 10, color: connected ? '#16A34A' : 'var(--text-3)', fontWeight: 500 }}>
              {connected ? t.connections.connected : t.connections.clickToConnect}
            </div>
          </div>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--text-3)', opacity: 0.6 }}>
            <path d="M4 6l4 4 4-4" />
          </svg>
        </div>
      </div>
      <ProfileMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
    </aside>
  )
}
