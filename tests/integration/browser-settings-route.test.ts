import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import puppeteer from 'puppeteer-core'

import { startApiServer } from '../../server/api-server.js'
import { handleBrowserRoutes } from '../../server/routes/browser-settings.js'
import { BrowserManager } from '../../domains/browser/browser-manager.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { BrowserFaviconService } from '../../services/browser-favicon-service.js'
import { BrowserSettingsService } from '../../services/browser-settings-service.js'

test('registry-backed HTTP routes preserve unavailable Browser and default YouTube settings', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tool-settings-api-')))
  const server = await startApiServer({
    store: new FileSystemRunStore(root),
    launcher: {
      async startRun(request) {
        return { launched: true, pid: 1, cwd: request.cwd }
      },
    },
    toolModuleOptions: {
      youtube: { settingsOptions: { environment: {} } },
    },
  })

  try {
    const browserSettings = await fetch(`${server.url}/settings/browser`)
    assert.equal(browserSettings.status, 503)
    assert.deepEqual(await browserSettings.json(), {
      error: 'Browser settings are unavailable',
    })

    const activity = await fetch(
      `${server.url}/sessions/session-browser/browser-activity`,
    )
    assert.equal(activity.status, 200)
    assert.deepEqual(await activity.json(), { activities: [] })

    const youtubeSettings = await fetch(`${server.url}/settings/youtube`)
    assert.equal(youtubeSettings.status, 200)
    assert.equal(
      (await youtubeSettings.json() as { source: string }).source,
      'default',
    )
  } finally {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('browser settings and empty activity routes expose bounded no-store HTTP contracts', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-settings-route-')))
  const manager = new BrowserManager({ profilePath: path.join(root, 'profile') })
  const settings = new BrowserSettingsService(manager, path.join(root, 'settings.json'))
  const server = http.createServer((req, res) => {
    void handleBrowserRoutes({
      req,
      res,
      url: new URL(req.url ?? '/', 'http://127.0.0.1'),
      settings,
    }).then((handled) => {
      if (!handled && !res.writableEnded) {
        res.statusCode = 404
        res.end()
      }
    }).catch(() => {
      if (!res.writableEnded) {
        res.statusCode = 500
        res.end()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}`

  try {
    const initial = await fetch(`${url}/settings/browser`)
    assert.equal(initial.status, 200)
    assert.equal(initial.headers.get('cache-control'), 'no-store')
    assert.equal((await initial.json() as { mode: string }).mode, 'headed')

    const changed = await fetch(`${url}/settings/browser`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'headless', ignored: true }),
    })
    assert.equal(changed.status, 200)
    assert.equal((await changed.json() as { mode: string }).mode, 'headless')
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')), {
      version: 1,
      mode: 'headless',
    })

    const invalidMode = await fetch(`${url}/settings/browser`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'background' }),
    })
    assert.equal(invalidMode.status, 400)
    assert.deepEqual(await invalidMode.json(), {
      error: 'Browser mode is invalid',
    })

    for (const body of [{}, { mode: 1 }, { mode: true }]) {
      const invalid = await fetch(`${url}/settings/browser`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      assert.equal(invalid.status, 400)
      assert.deepEqual(await invalid.json(), {
        error: 'Browser mode is invalid',
      })
    }

    const nullBody = await fetch(`${url}/settings/browser`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: 'null',
    })
    assert.equal(nullBody.status, 500)
    assert.equal(await nullBody.text(), '')

    const invalidJson = await fetch(`${url}/settings/browser`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    assert.equal(invalidJson.status, 400)
    assert.deepEqual(await invalidJson.json(), {
      error: 'Browser settings request is invalid',
    })

    const unsupported = await fetch(`${url}/settings/browser`, { method: 'DELETE' })
    assert.equal(unsupported.status, 405)
    assert.equal(unsupported.headers.get('allow'), 'GET, PUT')
    assert.deepEqual(await unsupported.json(), { error: 'Method not allowed' })

    const activity = await fetch(`${url}/sessions/session-browser/browser-activity`)
    assert.equal(activity.status, 200)
    assert.equal(activity.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await activity.json(), { activities: [] })
  } finally {
    await manager.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('API startup hydrates the persisted Browser mode before any browser request', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-startup-')))
  const workspacePath = path.join(root, 'workspace')
  fs.mkdirSync(workspacePath)
  fs.writeFileSync(
    path.join(root, 'browser-settings.json'),
    JSON.stringify({ version: 1, mode: 'headless' }),
  )
  const manager = new BrowserManager({ profilePath: path.join(root, 'profile') })
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined
  try {
    server = await startApiServer({
      store: new FileSystemRunStore(workspacePath),
      launcher: {
        async startRun(request) {
          return { launched: true, pid: 1, cwd: request.cwd }
        },
      },
      workspacePath,
      browserManager: manager,
    })

    assert.equal((await manager.status()).mode, 'headless')
  } finally {
    if (server) await server.close()
    else await manager.close()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('settings hydration reconnects a real orphaned managed Chrome profile', { timeout: 30_000 }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-recovery-')))
  const profilePath = path.join(root, 'profile')
  const storagePath = path.join(root, 'browser-settings.json')
  const probe = new BrowserManager({ profilePath })
  const executablePath = (await probe.status()).executablePath
  await probe.close()
  if (!executablePath) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    t.skip('A supported local Chrome installation is required for recovery coverage.')
    return
  }

  let browserWSEndpoint: string | undefined
  let orphanedProcess: ChildProcess | null = null
  let recoveredManager: BrowserManager | undefined
  try {
    const orphanedBrowser = await puppeteer.launch({
      executablePath,
      headless: true,
      userDataDir: profilePath,
      args: ['--no-first-run', '--no-default-browser-check'],
    })
    browserWSEndpoint = orphanedBrowser.wsEndpoint()
    orphanedProcess = orphanedBrowser.process()
    orphanedBrowser.disconnect()
    fs.writeFileSync(storagePath, JSON.stringify({ version: 1, mode: 'headless' }))

    recoveredManager = new BrowserManager({ profilePath })
    const settings = new BrowserSettingsService(recoveredManager, storagePath)
    await settings.hydrateRuntime()

    assert.equal((await settings.snapshot()).status, 'running')
    assert.equal((await settings.snapshot()).mode, 'headless')
  } finally {
    await recoveredManager?.close()
    if (browserWSEndpoint) {
      const cleanupBrowser = await puppeteer.connect({ browserWSEndpoint }).catch(() => undefined)
      await cleanupBrowser?.close().catch(() => undefined)
    }
    if (
      orphanedProcess &&
      orphanedProcess.exitCode === null &&
      orphanedProcess.signalCode === null
    ) {
      await once(orphanedProcess, 'exit')
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('favicon route serves an authorized origin over the real loopback transport', async () => {
  const icon = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  )
  const iconServer = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(icon)
      return
    }
    res.writeHead(404)
    res.end()
  })
  const iconOrigin = await listenOnLoopback(iconServer)

  const favicons = new BrowserFaviconService({
    listSessionUrls: async (sessionId) =>
      sessionId === 'session-1' ? [`${iconOrigin}/visited-page`] : [],
    allowHttpLocalhost: true,
  })
  const server = http.createServer((req, res) => {
    void handleBrowserRoutes({
      req,
      res,
      url: new URL(req.url ?? '/', 'http://127.0.0.1'),
      favicons,
    }).then((handled) => {
      if (!handled && !res.writableEnded) {
        res.statusCode = 404
        res.end()
      }
    })
  })
  const base = await listenOnLoopback(server)

  try {
    const served = await fetch(
      `${base}/sessions/session-1/browser-activity/favicon?origin=${encodeURIComponent(iconOrigin)}`,
    )
    assert.equal(served.status, 200)
    assert.equal(served.headers.get('content-type'), 'image/png')
    assert.equal(served.headers.get('cache-control'), 'private, max-age=86400')
    assert.deepEqual(new Uint8Array(await served.arrayBuffer()), new Uint8Array(icon))

    const unauthorized = await fetch(
      `${base}/sessions/session-1/browser-activity/favicon?origin=${encodeURIComponent('https://never-visited.example')}`,
    )
    assert.equal(unauthorized.status, 404)
    assert.equal(unauthorized.headers.get('cache-control'), 'private, max-age=3600')

    const otherSession = await fetch(
      `${base}/sessions/session-2/browser-activity/favicon?origin=${encodeURIComponent(iconOrigin)}`,
    )
    assert.equal(otherSession.status, 404)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await new Promise<void>((resolve) => iconServer.close(() => resolve()))
  }
})

async function listenOnLoopback(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Server address is unavailable')
  return `http://localhost:${address.port}`
}
