import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { mock } from 'node:test'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

interface FakePage {
  close(): Promise<void>
  createCDPSession(): Promise<{
    detach(): Promise<void>
    send(command: string): Promise<{ nodes: readonly unknown[] }>
  }>
  frames(): readonly FakeFrame[]
  goto(url: string): Promise<{ status(): number }>
  mainFrame(): FakeFrame
  on(event: string, listener: (value: never) => void): void
  once(event: string, listener: () => void): void
  setRequestInterception(enabled: boolean): Promise<void>
  url(): string
}

interface FakeFrame {
  evaluate(script: string): Promise<void>
  evaluateHandle(callback: unknown, input: unknown): Promise<{
    dispose(): Promise<void>
    getProperty(name: string): Promise<{
      dispose(): Promise<void>
      getProperties(): Promise<ReadonlyMap<string, never>>
      jsonValue(): Promise<unknown>
    }>
  }>
  url(): string
}

interface FakeContext {
  readonly closeCalls: number
  close(): Promise<void>
  newPage(): Promise<FakePage>
}

interface FakeBrowser {
  connected: boolean
  readonly createCalls: number
  close(): Promise<void>
  createBrowserContext(): Promise<FakeContext>
  defaultBrowserContext(): FakeContext
  once(event: string, listener: () => void): void
  waitForCreateCalls(expected: number): Promise<void>
}

const launchQueue: FakeBrowser[] = []

// Real Chrome is an unavailable and nondeterministic dependency in the unit
// suite, so replace Puppeteer only at its external process boundary.
mock.module('puppeteer-core', {
  // Node 22's experimental module-mock API exposes default exports through
  // `defaultExport`; the newer `exports.default` shape is ignored at runtime.
  defaultExport: {
    launch: async () => {
      const browser = launchQueue.shift()
      if (!browser) throw new Error('No fake browser was queued for launch.')
      return browser
    },
    connect: async () => {
      throw new Error('Unexpected fake browser connection.')
    },
  },
})

const { BrowserManager } = await import('../../domains/browser/browser-manager.js')
const executablePath = process.execPath

test('an old browser context completion cannot evict the new browser pending context', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-context-generation-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const oldCreation = deferred<FakeContext>()
  const newCreation = deferred<FakeContext>()
  const unexpectedCreation = deferred<FakeContext>()
  const oldBrowser = fakeBrowser([oldCreation])
  const newBrowser = fakeBrowser([newCreation, unexpectedCreation])
  launchQueue.push(oldBrowser, newBrowser)
  const manager = new BrowserManager({
    profilePath: path.join(directory, 'profile'),
    executablePath,
    allowHttpLocalhost: true,
  })
  context.after(() => manager.close())
  const scope = makeScope(directory)

  const oldOpen = manager.execute(scope, {
    action: 'open',
    url: 'http://127.0.0.1/fake',
    timeoutMs: 500,
  })
  await oldBrowser.waitForCreateCalls(1)
  await manager.stop()
  const firstNewOpen = manager.execute(scope, {
    action: 'open',
    url: 'http://127.0.0.1/fake',
    timeoutMs: 500,
  })
  await newBrowser.waitForCreateCalls(1)

  oldCreation.resolve(fakeContext())
  await Promise.allSettled([oldOpen])
  const secondNewOpen = manager.execute(scope, {
    action: 'open',
    url: 'http://127.0.0.1/fake',
    timeoutMs: 500,
  })
  await new Promise<void>((resolve) => setImmediate(resolve))

  newCreation.resolve(fakeContext())
  unexpectedCreation.resolve(fakeContext())
  const [firstNew, secondNew] = await Promise.all([firstNewOpen, secondNewOpen])
  assert.equal(newBrowser.createCalls, 1)
  assert.equal(firstNew.ok, true)
  assert.equal(secondNew.ok, true)
})

test('closing an assignment invalidates and closes its pending browser context', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-context-close-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const creation = deferred<FakeContext>()
  const browser = fakeBrowser([creation])
  launchQueue.push(browser)
  const manager = new BrowserManager({
    profilePath: path.join(directory, 'profile'),
    executablePath,
    allowHttpLocalhost: true,
  })
  context.after(() => manager.close())
  const scope = makeScope(directory)
  const pendingOpen = manager.execute(scope, {
    action: 'open',
    url: 'http://127.0.0.1/fake',
    timeoutMs: 500,
  })
  await browser.waitForCreateCalls(1)

  await manager.closeAssignment(scope)
  const created = fakeContext()
  creation.resolve(created)

  await assert.rejects(pendingOpen)
  assert.equal(created.closeCalls, 1)
})

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve(value) {
      if (!resolvePromise) throw new Error('Deferred resolver is unavailable.')
      resolvePromise(value)
    },
  }
}

function fakeBrowser(creations: readonly Deferred<FakeContext>[]): FakeBrowser {
  let createCalls = 0
  let disconnected: (() => void) | undefined
  const createWaiters = new Map<number, () => void>()
  const defaultContext = fakeContext()
  return {
    connected: true,
    get createCalls() {
      return createCalls
    },
    async createBrowserContext() {
      const creation = creations[createCalls]
      createCalls += 1
      for (const [expected, resolve] of createWaiters) {
        if (createCalls >= expected) {
          createWaiters.delete(expected)
          resolve()
        }
      }
      if (!creation) throw new Error('Unexpected browser context creation.')
      return creation.promise
    },
    defaultBrowserContext: () => defaultContext,
    once(event, listener) {
      if (event === 'disconnected') disconnected = listener
    },
    async waitForCreateCalls(expected) {
      if (createCalls >= expected) return
      await new Promise<void>((resolve) => createWaiters.set(expected, resolve))
    },
    async close() {
      this.connected = false
      disconnected?.()
    },
  }
}

function fakeContext(): FakeContext {
  let closeCalls = 0
  return {
    get closeCalls() {
      return closeCalls
    },
    async close() {
      closeCalls += 1
    },
    async newPage() {
      let currentUrl = 'about:blank'
      const frame: FakeFrame = {
        async evaluate() {},
        async evaluateHandle() {
          const payload = {
            title: 'Fake page',
            url: currentUrl,
            text: 'Fake browser page content.',
            elements: [],
            blocks: [],
            canvasCount: 0,
            unlabeledImageCount: 0,
          }
          return fakeHandle({ payload, nodes: [] })
        },
        url: () => currentUrl,
      }
      return {
        async close() {},
        async createCDPSession() {
          return {
            async detach() {},
            async send() {
              return { nodes: [] }
            },
          }
        },
        frames: () => [frame],
        async goto(url) {
          currentUrl = url
          return { status: () => 200 }
        },
        mainFrame: () => frame,
        on() {},
        once() {},
        async setRequestInterception() {},
        url: () => currentUrl,
      }
    },
  }
}

function fakeHandle(value: Readonly<Record<string, unknown>>) {
  return {
    async dispose() {},
    async getProperty(name: string) {
      return {
        async dispose() {},
        async getProperties() {
          return new Map<string, never>()
        },
        async jsonValue() {
          return value[name]
        },
      }
    },
  }
}

function makeScope(assignmentPath: string) {
  return {
    sessionId: 'session-browser-concurrency',
    runId: 'run-browser-concurrency',
    assignmentId: 'assignment-browser-concurrency',
    activityScopeId: 'lane-browser-concurrency',
    assignmentPath,
    policy: { enabled: true, restrictDomains: false, domains: [] },
  }
}
