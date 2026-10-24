import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { mock } from 'node:test'

interface FakePage {
  readonly closeCalls: number
  setViewport(): Promise<void>
  goto(): Promise<undefined>
  waitForSelector(): Promise<void>
  evaluate(body: unknown, argument?: unknown): Promise<unknown>
  $(selector: string): Promise<{ screenshot(options: { readonly path: string }): Promise<void> } | null>
  close(): Promise<void>
}

interface FakeBrowserContext {
  readonly openedPages: readonly FakePage[]
  readonly closeCalls: number
  newPage(): Promise<FakePage>
  close(): Promise<void>
}

interface FakeBrowser {
  connected: boolean
  readonly isolatedContexts: readonly FakeBrowserContext[]
  close(): Promise<void>
  createBrowserContext(): Promise<FakeBrowserContext>
  defaultBrowserContext(): FakeBrowserContext
  once(event: string, listener: () => void): void
}

const launchQueue: FakeBrowser[] = []
const launchOptions: Readonly<Record<string, unknown>>[] = []

// Chrome is an external process and cannot run deterministically in the unit
// suite. Keep the replacement at Puppeteer's launch boundary.
mock.module('puppeteer-core', {
  // Node 22's experimental module-mock API exposes default exports through
  // `defaultExport`; the newer `exports.default` shape is ignored at runtime.
  defaultExport: {
    launch: async (options: Readonly<Record<string, unknown>>) => {
      launchOptions.push(options)
      const browser = launchQueue.shift()
      if (!browser) throw new Error('No fake browser was queued for launch.')
      return browser
    },
    connect: async () => {
      throw new Error('Unexpected fake browser connection.')
    },
  },
})

const { BrowserManager, youtubeBrowserFrameFileName } = await import(
  '../../domains/browser/browser-manager.js'
)

test.beforeEach(() => {
  launchQueue.length = 0
  launchOptions.length = 0
})

test('browser frame filenames reject step IDs that could escape the output directory', () => {
  assert.equal(youtubeBrowserFrameFileName(0, 'open-editor'), 'browser-001-open-editor.png')
  assert.throws(() => youtubeBrowserFrameFileName(0, '../../../outside'), /step ID is invalid/i)
  assert.throws(() => youtubeBrowserFrameFileName(0, 'nested/step'), /step ID is invalid/i)
})

test('YouTube frame capture screenshots the watch page in the signed-in profile context', async (context) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-browser-frames-')),
  )
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const browser = fakeBrowser()
  launchQueue.push(browser)
  const manager = new BrowserManager({
    profilePath: path.join(root, 'profile'),
    executablePath: process.execPath,
  })
  context.after(() => manager.close())

  const frames = await manager.captureYoutubeFrames({
    videoId: 'aspmNhKAFMc',
    outputDirectory: path.join(root, 'frames'),
    cues: [{
      stepId: 'first-step',
      timestampSeconds: 13,
      importance: 'required',
      caption: 'The signed-in watch page',
      altText: 'The signed-in watch page thirteen seconds in',
    }],
  })

  assert.equal(browser.isolatedContexts.length, 0)
  const profile = browser.defaultBrowserContext()
  assert.equal(profile.openedPages.length, 1)
  assert.equal(profile.openedPages[0]?.closeCalls, 1)
  assert.equal(profile.closeCalls, 0)
  assert.equal(frames.length, 1)
  assert.equal(frames[0]?.relativePath, 'frames/browser-001-first-step.png')
  assert.equal(frames[0]?.actualTimestampSeconds, 13)
})

function fakeBrowser(failFrames = false): FakeBrowser {
  const isolatedContexts: FakeBrowserContext[] = []
  const defaultContext = fakeBrowserContext(failFrames)
  let disconnected: (() => void) | undefined
  return {
    connected: true,
    isolatedContexts,
    async close() {
      this.connected = false
      disconnected?.()
    },
    async createBrowserContext() {
      const created = fakeBrowserContext()
      isolatedContexts.push(created)
      return created
    },
    defaultBrowserContext: () => defaultContext,
    once(_event, listener) {
      disconnected = listener
    },
  }
}

function fakeBrowserContext(failFrames = false): FakeBrowserContext {
  const openedPages: FakePage[] = []
  let closeCalls = 0
  return {
    openedPages,
    get closeCalls() {
      return closeCalls
    },
    async newPage() {
      const page = fakePage(failFrames)
      openedPages.push(page)
      return page
    },
    async close() {
      closeCalls += 1
    },
  }
}

function fakePage(failFrames = false): FakePage {
  let closeCalls = 0
  return {
    get closeCalls() {
      return closeCalls
    },
    setViewport: async () => undefined,
    goto: async () => { if (failFrames) throw new Error('Primary browser video playback was denied.'); return undefined },
    waitForSelector: async () => undefined,
    // The seek evaluation reports the timestamp it reached; the styling
    // evaluation ignores what it returns.
    evaluate: async (_body, argument) => argument,
    $: async (selector) => selector === 'video'
      ? { screenshot: async ({ path: filePath }) => fs.writeFile(filePath, Buffer.from('frame')) }
      : null,
    async close() {
      closeCalls += 1
    },
  }
}


test('a failed YouTube frame capture recovers in an isolated headed browser without stopping existing work', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-headed-recovery-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const primary = fakeBrowser(true)
  const recovery = fakeBrowser()
  launchQueue.push(primary, recovery)
  const manager = new BrowserManager({ profilePath: path.join(root, 'profile'), executablePath: process.execPath, mode: 'headless' })
  context.after(() => manager.close())

  const frames = await manager.captureYoutubeFrames({
    videoId: 'OLqP8jxJ0Wc', outputDirectory: path.join(root, 'frames'),
    cues: [{ stepId: 'open', timestampSeconds: 60, importance: 'required', caption: 'Open', altText: 'Open' }],
  })

  assert.equal(frames[0]?.actualTimestampSeconds, 60)
  assert.equal(primary.connected, true, 'Other work in the application browser must keep running.')
  assert.equal(recovery.connected, false, 'The dedicated recovery browser must close after capture.')
  assert.equal(frames[0]?.selectionReason, 'headed_browser_fallback')
  const recoveryProfile = launchOptions[1]?.userDataDir
  assert.equal(typeof recoveryProfile, 'string')
  if (typeof recoveryProfile !== 'string') throw new Error('The recovery browser must have a private profile.')
  await assert.rejects(fs.access(recoveryProfile))
  assert.equal(launchOptions[1]?.headless, false)
  assert.notEqual(launchOptions[1]?.userDataDir, launchOptions[0]?.userDataDir)
  assert.deepEqual(launchOptions[1]?.args, ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'])
})


test('a failed headed recovery stops after two browsers and removes its temporary profile', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-headed-failure-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const primary = fakeBrowser(true)
  const recovery = fakeBrowser(true)
  launchQueue.push(primary, recovery)
  const manager = new BrowserManager({ profilePath: path.join(root, 'profile'), executablePath: process.execPath, mode: 'headless' })
  context.after(() => manager.close())

  await assert.rejects(manager.captureYoutubeFrames({
    videoId: 'OLqP8jxJ0Wc', outputDirectory: path.join(root, 'frames'),
    cues: [{ stepId: 'open', timestampSeconds: 60, importance: 'required', caption: 'Open', altText: 'Open' }],
  }), /either the application browser or its headed recovery browser/)

  assert.equal(launchOptions.length, 2)
  assert.equal(primary.connected, true)
  assert.equal(recovery.connected, false)
  const recoveryProfile = launchOptions[1]?.userDataDir
  if (typeof recoveryProfile !== 'string') throw new Error('The recovery browser must have a private profile.')
  await assert.rejects(fs.access(recoveryProfile))
})
