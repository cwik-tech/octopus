import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { version } from '../package.json'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(version),
  },
  build: {
    rolldownOptions: {
      input: {
        app: path.resolve(__dirname, 'index.html'),
        startup: path.resolve(__dirname, 'startup.html'),
      },
    },
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
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API_TARGET ?? 'http://127.0.0.1:3001',
        changeOrigin: true,
        rewrite: (value) => value.replace(/^\/api/, ''),
      },
    },
  },
})
