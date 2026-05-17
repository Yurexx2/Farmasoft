import { useAppStore } from '../../store/useAppStore'
import { Lang } from '../../i18n'

const SIDEBAR_WIDTH = 224
const SIDEBAR_COLLAPSED_WIDTH = 56

const iconMenu = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <line x1="2" y1="4" x2="14" y2="4" />
    <line x1="2" y1="8" x2="14" y2="8" />
    <line x1="2" y1="12" x2="14" y2="12" />
  </svg>
)

export function TopBar() {
  const { uiLang, setUiLang, sidebarOpen, toggleSidebar } = useAppStore()

  return (
    <div style={{
      height: 64, background: 'var(--surface)',
      borderBottom: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', flexShrink: 0,
    }}>
      {/* Logo zone */}
      <div style={{
        width: sidebarOpen ? SIDEBAR_WIDTH : SIDEBAR_COLLAPSED_WIDTH,
        minWidth: sidebarOpen ? SIDEBAR_WIDTH : SIDEBAR_COLLAPSED_WIDTH,
        height: '100%', display: 'flex', alignItems: 'center',
        padding: sidebarOpen ? '0 16px' : '0',
        justifyContent: sidebarOpen ? 'flex-start' : 'center',
        gap: 12,
        borderRight: '1px solid var(--border)',
        transition: 'width 200ms ease, min-width 200ms ease',
      }}>
        <button
          onClick={toggleSidebar}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text-2)', padding: 6, borderRadius: 8, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background 120ms, color 120ms',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface-2)'; e.currentTarget.style.color = 'var(--text-1)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--text-2)' }}
        >
          {iconMenu}
        </button>
        {sidebarOpen && (
          <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="Farmasoft" style={{ height: 34, width: 'auto', display: 'block' }} />
        )}
      </div>

      {/* Right zone */}
      <div style={{
        flex: 1, height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
        padding: '0 24px',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center',
          background: 'var(--surface-2)', borderRadius: 8, padding: 3, gap: 2,
        }}>
          {(['en', 'ua'] as Lang[]).map(lang => (
            <button
              key={lang}
              onClick={() => setUiLang(lang)}
              style={{
                padding: '4px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
                fontSize: 11, fontWeight: 600, letterSpacing: '0.04em',
                textTransform: 'uppercase',
                background: uiLang === lang ? 'var(--surface)' : 'transparent',
                color: uiLang === lang ? 'var(--text-1)' : 'var(--text-3)',
                boxShadow: uiLang === lang ? 'var(--shadow-sm)' : 'none',
                transition: 'all 120ms',
              }}
            >
              {lang === 'en' ? 'EN' : 'UA'}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
