import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { version } from '../package.json'

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(version),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    css: false,
    // Pin the timezone so Intl-based date/time formatting (formatTimestamp,
    // etc.) is deterministic across machines and CI. Workflows are hidden in
    // shipped builds but stay under test here.
    env: { TZ: 'UTC', VITE_ENABLE_WORKFLOWS: '1' },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@contracts': path.resolve(__dirname, '../contracts'),
    },
  },
  server: {
    fs: {
      allow: [path.resolve(__dirname, '..')],
    },
  },
})
