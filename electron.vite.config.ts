import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    // The main process builds as an ES module: @mariozechner/pi-ai is
    // ESM-only (no "require" export in its package.json), so a CommonJS
    // main crashes at startup with ERR_PACKAGE_PATH_NOT_EXPORTED when it
    // tries to load it from the packaged app. As ESM, pi-ai and its whole
    // dependency tree load natively. Entry is index.mjs (package.json
    // "main" points at it); the preload stays CommonJS as required.
    build: { rollupOptions: { output: { format: 'es', entryFileNames: 'index.mjs' } } },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: { resolve: { alias: { '@shared': resolve('src/shared') } } },
  renderer: {
    plugins: [react()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  }
})
