import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import puppeteer, { type Browser, type BrowserContext } from 'puppeteer-core'

import {
  BrowserManager,
  BrowserRuntimeError,
  type BrowserExecutionScope,
} from '../../domains/browser/browser-manager.js'
import {
  LOOPBACK_PROXY_PASSWORD,
  LOOPBACK_PROXY_USERNAME,
  chromeSkipReason,
  startForwardProxy,
  startOriginServer,
  type ForwardProxy,
} from '../support/research-web-proxy-fixture.js'

/**
 * The managed-browser side of the Webshare retry, one context at a time.
 *
 * These are the rules the acceptance journey cannot reveal. A stale endpoint
 * still returns a page, and a leaked context still lets the next call succeed,
 * so both are checked directly against a real Chrome and a real proxy.
 */

const PAGE = '/insufficient-then-denied-until-proxied'

test(
  'a proxied context reads through the proxy while the same manager reads the page directly, and closing the assignment reclaims both',
  { skip: chromeSkipReason(), timeout: 90_000 },
  async (context) => {
    const proxy = await authenticatingProxy()
    context.after(() => proxy.close())
    const origin = await startOriginServer(proxy.proxyLocalPorts)
    context.after(() => origin.close())
    const managed = await createManager(context)

    const baseline = await managed.contextCount()

    const proxied = await managed.manager.acquireEvidence(
      { ...managed.scope, proxy: endpointFor(proxy) },
      `${origin.url}${PAGE}`,
    )
    assert.match(String(proxied.title), /from the proxy/u)
    assert.equal(pageReads(origin.proxiedRequests), 1)
    assert.ok(proxy.challenges >= 1, 'Chrome answered the proxy 407 challenge')

    // The same manager, same assignment, no proxy field: an ordinary read that
    // the proxy must never see.
    await assert.rejects(
      managed.manager.acquireEvidence(managed.scope, `${origin.url}${PAGE}`),
      (error: unknown) =>
        error instanceof BrowserRuntimeError && error.code === 'access_denied',
      'the unproxied context is denied by the origin, which is what proves it went direct',
    )
    assert.equal(
      pageReads(origin.proxiedRequests),
      1,
      'the ordinary context must not travel through the proxy',
    )
    assert.equal(pageReads(origin.directRequests), 1)

    assert.equal(
      await managed.contextCount(),
      baseline + 2,
      'the assignment holds its ordinary context and one proxied context',
    )

    // `releaseAssignment` hands a scope with no proxy field, exactly as
    // production does, so a proxied context is only found by key prefix.
    await managed.manager.closeAssignment(managed.scope)
    assert.equal(
      await managed.contextCount(),
      baseline,
      'closing the assignment reclaims the proxied context as well as the ordinary one',
    )
  },
)

test(
  'a proxied page without credentials fails instead of reading the source',
  { skip: chromeSkipReason(), timeout: 90_000 },
  async (context) => {
    const proxy = await authenticatingProxy()
    context.after(() => proxy.close())
    const origin = await startOriginServer(proxy.proxyLocalPorts)
    context.after(() => origin.close())
    const managed = await createManager(context)

    await assert.rejects(
      managed.manager.acquireEvidence(
        {
          ...managed.scope,
          proxy: { ...endpointFor(proxy), password: 'not-the-password' },
        },
        `${origin.url}${PAGE}`,
      ),
      (error: unknown) => error instanceof Error,
    )
    assert.ok(proxy.challenges >= 1, 'the proxy did challenge the read')
    assert.deepEqual(
      origin.proxiedRequests,
      [],
      'a rejected challenge means nothing reached the origin through the proxy',
    )
    assert.deepEqual(
      origin.directRequests,
      [],
      'and a rejected challenge must not fall back to reading the source directly',
    )
  },
)

test(
  'a proxy endpoint changed mid-assignment routes the next read to the new proxy and closes the old context',
  { skip: chromeSkipReason(), timeout: 90_000 },
  async (context) => {
    // One origin reached through either proxy, so both record their upstream
    // ports into the same live set the origin reads.
    const localPorts = new Set<number>()
    const first = await authenticatingProxy(localPorts)
    context.after(() => first.close())
    const second = await authenticatingProxy(localPorts)
    context.after(() => second.close())
    const origin = await startOriginServer(localPorts)
    context.after(() => origin.close())
    const managed = await createManager(context)
    const baseline = await managed.contextCount()

    await managed.manager.acquireEvidence(
      { ...managed.scope, proxy: endpointFor(first) },
      `${origin.url}${PAGE}`,
    )
    assert.ok(first.connections >= 1)
    const firstPageReadsBefore = forwardedPageReads(first)

    const afterChange = await managed.manager.acquireEvidence(
      { ...managed.scope, proxy: endpointFor(second) },
      `${origin.url}${PAGE}`,
    )

    assert.match(String(afterChange.title), /from the proxy/u)
    assert.ok(
      forwardedPageReads(second) >= 1,
      'the changed endpoint is the one that served the read',
    )
    assert.equal(
      forwardedPageReads(first),
      firstPageReadsBefore,
      'the replaced endpoint did not serve the next page read',
    )
    assert.equal(
      await managed.contextCount(),
      baseline + 1,
      'the replaced proxied context was closed rather than orphaned',
    )
  },
)

test(
  'a read withdrawn while its proxied context is being created closes that context and rejects everyone waiting on it',
  { skip: chromeSkipReason(), timeout: 90_000 },
  async (context) => {
    const proxy = await authenticatingProxy()
    context.after(() => proxy.close())
    const origin = await startOriginServer(proxy.proxyLocalPorts)
    context.after(() => origin.close())
    // Chrome really creates the context; the barrier only decides when the
    // manager is handed it, which is what makes "the caller withdrew while it
    // was being built" a moment a test can name instead of guess at.
    const creation = heldContextCreation()
    const managed = await createManager(context, {
      createBrowserContext: creation.create,
    })
    const baseline = await managed.contextCount()

    const controller = new AbortController()
    const scope = { ...managed.scope, proxy: endpointFor(proxy) }
    // The second caller joins the first caller's in-flight creation, so both
    // have to survive the same withdrawal.
    const settled = Promise.allSettled([
      managed.manager.acquireEvidence(scope, `${origin.url}${PAGE}`, controller.signal),
      managed.manager.acquireEvidence(scope, `${origin.url}${PAGE}`, controller.signal),
    ])

    await creation.created
    assert.equal(
      await managed.contextCount(),
      baseline + 1,
      'Chrome has built the context that is about to be withdrawn from',
    )
    assert.equal(creation.calls, 1, 'the joined caller waits rather than creating a second')
    controller.abort()
    creation.release()

    for (const result of await settled) {
      assert.equal(result.status, 'rejected')
      const error: unknown = result.status === 'rejected' ? result.reason : undefined
      assert.ok(
        error instanceof BrowserRuntimeError && error.code === 'cancelled',
        `both callers are told the read was cancelled: ${String(error)}`,
      )
    }

    // The open action finishes its own cleanup before it reports back, so this
    // reads the settled state with nothing waited on.
    assert.equal(
      await managed.contextCount(),
      baseline,
      'a context created after the caller withdrew is closed and never cached',
    )
    assert.equal((await managed.manager.status()).pageCount, 0)
    assert.equal(proxy.connections, 0, 'and no read ever left through the proxy')
  },
)

test(
  'a read that was withdrawn before it began creates no context and no page',
  { skip: chromeSkipReason(), timeout: 90_000 },
  async (context) => {
    const proxy = await authenticatingProxy()
    context.after(() => proxy.close())
    const origin = await startOriginServer(proxy.proxyLocalPorts)
    context.after(() => origin.close())
    const managed = await createManager(context)
    const baseline = await managed.contextCount()

    const controller = new AbortController()
    controller.abort()

    await assert.rejects(
      managed.manager.acquireEvidence(
        { ...managed.scope, proxy: endpointFor(proxy) },
        `${origin.url}${PAGE}`,
        controller.signal,
      ),
      (error: unknown) =>
        error instanceof BrowserRuntimeError && error.code === 'cancelled',
    )

    assert.equal(await managed.contextCount(), baseline)
    assert.equal((await managed.manager.status()).pageCount, 0)
    assert.equal(proxy.connections, 0, 'and never reaches the proxy')
  },
)

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function authenticatingProxy(localPorts?: Set<number>): Promise<ForwardProxy> {
  return startForwardProxy({
    requireAuth: {
      username: LOOPBACK_PROXY_USERNAME,
      password: LOOPBACK_PROXY_PASSWORD,
    },
    ...(localPorts ? { localPorts } : {}),
  })
}

/**
 * Reads of the page under test, ignoring the favicon Chrome asks for.
 *
 * Chrome opens more than one connection per navigation, so the honest unit for
 * "read once through the proxy" is the origin's own view of the page path.
 */
function pageReads(requests: readonly string[]): number {
  return requests.filter((request) => request === PAGE).length
}

/** Page reads relayed by one proxy, excluding Chrome's incidental requests. */
function forwardedPageReads(proxy: ForwardProxy): number {
  return proxy.forwardedUrls.filter(
    (request) => new URL(request).pathname === PAGE,
  ).length
}

function endpointFor(proxy: ForwardProxy) {
  return {
    server: `http://127.0.0.1:${proxy.port}`,
    username: LOOPBACK_PROXY_USERNAME,
    password: LOOPBACK_PROXY_PASSWORD,
  }
}

interface HeldContextCreation {
  readonly create: (
    browser: Browser,
    options?: Parameters<Browser['createBrowserContext']>[0],
  ) => Promise<BrowserContext>
  /** Resolves once Chrome has finished creating the first context. */
  readonly created: Promise<void>
  /** Lets that creation be handed back to the manager. */
  release(): void
  readonly calls: number
}

/**
 * A real context creation the test can hold open.
 *
 * Only the first creation is held: later ones pass straight through, so a
 * fixture cannot deadlock a test that goes on to open more contexts.
 */
function heldContextCreation(): HeldContextCreation {
  let announceCreated = (): void => undefined
  const created = new Promise<void>((resolve) => {
    announceCreated = resolve
  })
  let release = (): void => undefined
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  return {
    created,
    release: () => release(),
    get calls() {
      return calls
    },
    create: async (browser, options) => {
      calls += 1
      const context = await browser.createBrowserContext(options)
      if (calls > 1) return context
      announceCreated()
      await barrier
      return context
    },
  }
}

interface ManagedFixture {
  readonly manager: BrowserManager
  readonly scope: BrowserExecutionScope
  /** Browser contexts the running Chrome holds, read over a second CDP client. */
  contextCount(): Promise<number>
}

async function createManager(
  context: { after(callback: () => Promise<unknown> | unknown): unknown },
  options: {
    readonly createBrowserContext?: HeldContextCreation['create']
  } = {},
): Promise<ManagedFixture> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'browser-proxied-context-')),
  )
  const profilePath = path.join(root, 'profile')
  const assignmentPath = path.join(root, 'assignment')
  await fs.mkdir(assignmentPath, { recursive: true })
  const manager = new BrowserManager({
    profilePath,
    mode: 'headless',
    allowHttpLocalhost: true,
    ...(options.createBrowserContext
      ? { createBrowserContext: options.createBrowserContext }
      : {}),
  })
  // Registered before Chrome is started, so a failed launch still tears down.
  // Chrome must finish before its profile is removed: separate hooks can run in
  // registration order while Chrome is still writing cache metadata.
  context.after(async () => {
    try {
      await manager.close()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
  // Chrome must be running before any context is counted: the count is read
  // over its own DevTools endpoint, which does not exist until it launches.
  const status = await manager.openProfile()
  assert.equal(
    status.status,
    'running',
    `the fixture needs a running Chrome: ${JSON.stringify(status)}`,
  )
  return {
    manager,
    scope: {
      sessionId: 'session-proxied-context',
      runId: 'run-proxied-context',
      assignmentId: 'assignment-proxied-context',
      activityScopeId: 'lane-proxied-context',
      assignmentPath,
      policy: { enabled: true, restrictDomains: false, domains: [] },
    },
    // A fresh client each time: a CDP connection enumerates browser contexts
    // when it attaches, and is not told about contexts another client created
    // afterwards, so a retained inspector would report a stale count.
    contextCount: async () => {
      const inspector = await puppeteer.connect({
        browserWSEndpoint: await readBrowserEndpoint(profilePath),
      })
      try {
        return inspector.browserContexts().length
      } finally {
        await inspector.disconnect().catch(() => undefined)
      }
    },
  }
}

/** The endpoint Chrome advertises in its own profile, so no production seam is widened. */
async function readBrowserEndpoint(profilePath: string): Promise<string> {
  const contents = await fs.readFile(
    path.join(profilePath, 'DevToolsActivePort'),
    'utf8',
  )
  const [port, endpointPath] = contents.trim().split(/\r?\n/, 2)
  assert.ok(port && endpointPath, 'Chrome has not published a DevTools endpoint')
  return `ws://127.0.0.1:${port}${endpointPath}`
}
