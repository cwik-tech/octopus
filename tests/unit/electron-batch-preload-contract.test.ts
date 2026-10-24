import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

test('Electron Batch bridge is an argument-free sandboxed preload included in the desktop build', async () => {
  const preload = await fs.readFile(path.join(process.cwd(), 'electron', 'preload.cts'), 'utf8')
  const main = await fs.readFile(path.join(process.cwd(), 'electron', 'main.ts'), 'utf8')
  const tsconfig = JSON.parse(await fs.readFile(path.join(process.cwd(), 'tsconfig.electron.json'), 'utf8')) as {
    include?: string[]
  }

  assert.match(preload, /contextBridge\.exposeInMainWorld/)
  assert.match(preload, /selectBatchFolder:\s*\(\)\s*=>\s*ipcRenderer\.invoke/)
  assert.doesNotMatch(preload, /require\(['"](?:node:|fs|path)/)
  assert.match(main, /preload:\s*fileURLToPath\(new URL\(['"]\.\/preload\.cjs['"]/)
  assert.match(main, /contextIsolation:\s*true/)
  assert.match(main, /nodeIntegration:\s*false/)
  assert.match(main, /sandbox:\s*true/)
  assert.match(main, /new AppWindowRegistry<BrowserWindow>/)
  assert.doesNotMatch(main, /getOwnerWindow:\s*\(\)\s*=>\s*BrowserWindow\.getAllWindows\(\)\[0\]/)
  assert.ok(tsconfig.include?.includes('electron/**/*.cts'))
})


test('sandboxed window calls use the same channels as the main process', async () => {
  const { OPEN_WINDOW_CHANNEL, REPORT_WINDOW_SESSION_CHANNEL, ANNOUNCE_SESSION_CHANGED_CHANNEL } = await import('../../electron/app-window-constants.js')
  const preload = await fs.readFile(path.join(process.cwd(), 'electron/preload.cts'), 'utf8')
  assert.ok(preload.includes(`openWindow: (request: unknown) => ipcRenderer.invoke('${OPEN_WINDOW_CHANNEL}', request)`))
  assert.ok(preload.includes(`reportWindowSession: (sessionId: unknown) => ipcRenderer.send('${REPORT_WINDOW_SESSION_CHANNEL}', sessionId)`))
  assert.ok(preload.includes(`announceSessionChanged: (sessionId: unknown) => ipcRenderer.send('${ANNOUNCE_SESSION_CHANGED_CHANNEL}', sessionId)`))
})
