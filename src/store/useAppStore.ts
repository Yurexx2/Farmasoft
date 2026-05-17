import { create } from 'zustand'
import { Lang } from '../i18n'

export type Page = 'dashboard' | 'jobs' | 'telegram'

interface AppStore {
  currentPage: Page
  apiKeyConfigured: boolean
  uiLang: Lang
  sidebarOpen: boolean
  setPage: (page: Page) => void
  setApiKeyConfigured: (v: boolean) => void
  setUiLang: (lang: Lang) => void
  toggleSidebar: () => void
  setSidebarOpen: (v: boolean) => void
}

export const useAppStore = create<AppStore>((set) => ({
  currentPage: 'dashboard',
  apiKeyConfigured: false,
  uiLang: 'ua',
  sidebarOpen: true,
  setPage: (currentPage) => set({ currentPage }),
  setApiKeyConfigured: (apiKeyConfigured) => set({ apiKeyConfigured }),
  setUiLang: (uiLang) => set({ uiLang }),
  toggleSidebar: () => set(s => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
}))
