import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Farmasoft can be served either at the domain root (local dev, default) or
// under a sub-path (e.g. /farmasoft/hr behind a reverse proxy). BASE_PATH drives
// both — Vite bakes it into asset URLs and exposes it as import.meta.env.BASE_URL.
const raw = process.env.BASE_PATH?.trim().replace(/^\/+|\/+$/g, '')
const basePath = raw ? `/${raw}/` : '/'

export default defineConfig({
  base: basePath,
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 5173,
    proxy: {
      [`${basePath}api`]: {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
