import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { mock } from 'node:test'

interface FakeCookie {
  readonly name: string
  readonly value: string
  readonly domain: string
}

interface FakeBrowser {
  connected: boolean
  readonly closeCalls: number
  close(): Promise<void>
  defaultBrowserContext(): {
    cookies(): Promise<readonly FakeCookie[]>
  }
  once(event: string, listener: () => void): void
}

const launchQueue: FakeBrowser[] = []
const launchedHeadlessValues: boolean[] = []

// Chrome is an external process and cannot run deterministically in the unit
// suite. Keep the replacement at Puppeteer's launch boundary.
mock.module('puppeteer-core', {
  // Node 22's experimental module-mock API exposes default exports through
  // `defaultExport`; the newer `exports.default` shape is ignored at runtime.
  defaultExport: {
    launch: async (options: { readonly headless: boolean }) => {
      const browser = launchQueue.shift()
      if (!browser) throw new Error('No fake browser was queued for launch.')
      launchedHeadlessValues.push(options.headless)
      return browser
    },
    connect: async () => {
      throw new Error('Unexpected fake browser connection.')
    },
  },
})

const { BrowserManager } = await import('../../domains/browser/browser-manager.js')
const { BrowserSettingsService } = await import('../../services/browser-settings-service.js')

test.beforeEach(() => {
  launchQueue.length = 0
  launchedHeadlessValues.length = 0
})

test('opening the authenticated profile preserves headless research mode', async (context) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'browser-profile-mode-')),
  )
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const headedBrowser = fakeBrowser()
  const headlessBrowser = fakeBrowser()
  launchQueue.push(headedBrowser, headlessBrowser)
  const storagePath = path.join(root, 'browser-settings.json')
  const manager = new BrowserManager({
    profilePath: path.join(root, 'profile'),
    executablePath: process.execPath,
  })
  context.after(() => manager.close())
  const settings = new BrowserSettingsService(manager, storagePath)

  await settings.setMode('headless')

  const opened = await settings.openProfile()

  assert.equal(opened.status, 'running')
  assert.equal(opened.mode, 'headless')
  assert.deepEqual(launchedHeadlessValues, [false])
  assert.deepEqual(JSON.parse(await fs.readFile(storagePath, 'utf8')), {
    version: 1,
    mode: 'headless',
  })

  await manager.youtubeCookieHeader()

  // A cookie read takes the profile the operator opened as it is. Swapping it
  // into research mode would close the window they just signed in with, and
  // with it every page another assignment holds in that browser.
  assert.deepEqual(launchedHeadlessValues, [false])
  assert.equal(headedBrowser.closeCalls, 0)
  assert.equal((await settings.snapshot()).mode, 'headless')
})

test('a cookie read that forbids a launch takes the running browser as it is', async (context) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'browser-profile-download-cookies-')),
  )
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const headedBrowser = fakeBrowser([
    { name: 'SID', value: 'signed-in-session-value', domain: '.youtube.com' },
  ])
  launchQueue.push(headedBrowser)
  const manager = new BrowserManager({
    profilePath: path.join(root, 'profile'),
    executablePath: process.execPath,
  })
  context.after(() => manager.close())
  const settings = new BrowserSettingsService(manager, path.join(root, 'browser-settings.json'))
  await settings.setMode('headless')
  await settings.openProfile()

  const header = await manager.youtubeCookieHeader({ launch: false })

  assert.equal(header, 'SID=signed-in-session-value')
  assert.deepEqual(launchedHeadlessValues, [false])
  assert.equal(headedBrowser.closeCalls, 0)
})

test('a cookie read that allows a launch starts a stopped profile in the configured mode', async (context) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'browser-profile-launched-cookies-')),
  )
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  launchQueue.push(fakeBrowser([
    { name: 'SID', value: 'signed-in-session-value', domain: '.youtube.com' },
  ]))
  const manager = new BrowserManager({
    profilePath: path.join(root, 'profile'),
    executablePath: process.execPath,
  })
  context.after(() => manager.close())
  const settings = new BrowserSettingsService(manager, path.join(root, 'browser-settings.json'))
  await settings.setMode('headless')

  // Nothing opened the profile, which is what a manual build finds when it is
  // the first thing in the run to need the sign-in.
  const header = await manager.youtubeCookieHeader()

  assert.equal(header, 'SID=signed-in-session-value')
  assert.deepEqual(launchedHeadlessValues, [true])
})

test('a cookie read cancelled before the profile starts leaves it stopped', async (context) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'browser-profile-cancelled-cookies-')),
  )
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  launchQueue.push(fakeBrowser([
    { name: 'SID', value: 'signed-in-session-value', domain: '.youtube.com' },
  ]))
  const manager = new BrowserManager({
    profilePath: path.join(root, 'profile'),
    executablePath: process.execPath,
  })
  context.after(() => manager.close())
  const controller = new AbortController()
  controller.abort()

  const header = await manager.youtubeCookieHeader({ signal: controller.signal })

  assert.equal(header, undefined)
  assert.deepEqual(launchedHeadlessValues, [])
})

test('a cookie read that forbids a launch finds no sign-in when no browser is running', async (context) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'browser-profile-no-browser-')),
  )
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const manager = new BrowserManager({
    profilePath: path.join(root, 'profile'),
    executablePath: process.execPath,
  })
  context.after(() => manager.close())

  assert.equal(await manager.youtubeCookieHeader({ launch: false }), undefined)
  assert.deepEqual(launchedHeadlessValues, [])
})

test('a failed authenticated profile launch preserves headless research mode', async (context) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'browser-profile-failure-')),
  )
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const storagePath = path.join(root, 'browser-settings.json')
  const manager = new BrowserManager({
    profilePath: path.join(root, 'profile'),
    executablePath: process.execPath,
  })
  context.after(() => manager.close())
  const settings = new BrowserSettingsService(manager, storagePath)
  await settings.setMode('headless')

  await assert.rejects(settings.openProfile(), { name: 'BrowserRuntimeError' })

  assert.equal((await settings.snapshot()).mode, 'headless')
  assert.deepEqual(JSON.parse(await fs.readFile(storagePath, 'utf8')), {
    version: 1,
    mode: 'headless',
  })
})

function fakeBrowser(cookies: readonly FakeCookie[] = []): FakeBrowser {
  let closeCalls = 0
  let disconnected: (() => void) | undefined
  return {
    connected: true,
    get closeCalls() {
      return closeCalls
    },
    async close() {
      closeCalls += 1
      this.connected = false
      disconnected?.()
    },
    defaultBrowserContext: () => ({
      cookies: async () => cookies,
    }),
    once(_event, listener) {
      disconnected = listener
    },
  }
}
