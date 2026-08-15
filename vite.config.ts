import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'web',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: false,
  },
  server: {
    host: '127.0.0.1',
    port: 4173,
  },
})
