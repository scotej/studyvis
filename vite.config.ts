/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { mirrorOfflinePlugin } from './scripts/mirror-offline.ts'

const pkg = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'package.json'), 'utf-8')
) as { version: string }

export default defineConfig({
  plugins: [react(), tailwindcss(), mirrorOfflinePlugin()],
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  // Standalone HTML entries for the two transient Tauri windows. Their
  // WebviewWindow URLs resolve to these build artifacts in production and
  // directly to the matching root HTML files on the Vite dev server.
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, 'index.html'),
        mirror: path.resolve(import.meta.dirname, 'mirror.html'),
        ai_dialog: path.resolve(import.meta.dirname, 'ai-dialog.html'),
        session_overlay: path.resolve(
          import.meta.dirname,
          'session-overlay.html'
        ),
      },
    },
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
})
