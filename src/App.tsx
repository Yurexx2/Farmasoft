import { useEffect } from 'react'
import { Sidebar } from './components/layout/Sidebar'
import { TopBar } from './components/layout/TopBar'
import { Dashboard } from './pages/Dashboard'
import { JobDescriptions } from './pages/JobDescriptions'
import { TelegramPage } from './pages/telegram/TelegramPage'
import { CalendarPage } from './pages/Calendar'
import { useAppStore } from './store/useAppStore'
import { useIsMobile } from './hooks/useIsMobile'

export default function App() {
  const { currentPage, sidebarOpen, setSidebarOpen } = useAppStore()
  const isMobile = useIsMobile()

  // On mobile the sidebar is a slide-over drawer — start it closed whenever the
  // viewport switches to mobile so it doesn't cover the screen on load.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false)
  }, [isMobile, setSidebarOpen])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <TopBar />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Sidebar />
        {isMobile && sidebarOpen && (
          <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
        )}
        <main className="main-content">
          <div style={{ display: currentPage === 'dashboard' ? 'contents' : 'none' }}><Dashboard /></div>
          <div style={{ display: currentPage === 'jobs'      ? 'contents' : 'none' }}><JobDescriptions /></div>
          <div style={{ display: currentPage === 'telegram'  ? 'contents' : 'none' }}><TelegramPage /></div>
          <div style={{ display: currentPage === 'calendar'  ? 'contents' : 'none' }}><CalendarPage /></div>
        </main>
      </div>
    </div>
  )
}
