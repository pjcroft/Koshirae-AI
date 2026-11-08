import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Android/Capacitor web bundle: reuses the desktop renderer (src/renderer)
// with a browser-side implementation of window.api (mobile/api.ts).
export default defineConfig({
  root: resolve('mobile'),
  base: './',
  plugins: [react()],
  resolve: { alias: { '@shared': resolve('src/shared') } },
  build: { outDir: resolve('mobile/www'), emptyOutDir: true, target: 'es2022' }
})
