import assert from 'node:assert/strict'
import * as http from 'node:http'
import test from 'node:test'

import puppeteer, { type Browser } from 'puppeteer-core'

import { BrowserUseSessionClient } from '../../domains/browser/browser-use-session-client.js'
import { BrowserNetworkPolicy } from '../../domains/browser/browser-network-policy.js'
import {
  CloudBrowserAcquirer,
  guardReportExpression,
  parseGuardReport,
} from '../../domains/browser/cloud-browser-acquirer.js'
import { resolveBrowserExecutablePath } from '../../domains/browser/browser-executable.js'
import type { BrowserAgentPolicy } from '../../domains/browser/browser-policy.js'
import {
  activeSession,
  startBrowserUseApiFixture,
  type BrowserUseApiFixture,
} from '../support/browser-use-api-fixture.js'

/**
 * The cloud acquisition path, driven against a real Chrome over real CDP.
 *
 * A locally launched Chrome with a debugging port is exactly the shape the
 * provider hands back — a websocket URL to a browser this process did not
 * start — so the whole path is provable with no account, no key, and no
 * billable call. Only the identity of the remote host is left for the live gate.
 */

const LOCAL_POLICY: BrowserAgentPolicy = {
  enabled: true,
  restrictDomains: false,
  domains: [],
}

test('cloud acquisition reads a page and always releases its session', {
  timeout: 120_000,
}, async (t) => {
  const executablePath = resolveBrowserExecutablePath()
  if (!executablePath) {
    t.skip('No supported Chrome installation was found.')
    return
  }

  const origin = await startOriginServer()
  const trap = await startTrapServer()
  const chrome = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      // Makes the trap host genuinely reachable from inside Chrome, so "the
      // trap was never hit" reports an authorization decision rather than a
      // hostname that simply does not resolve.
      `--host-resolver-rules=MAP trap.internal:80 127.0.0.1:${trap.port}`,
    ],
  })
  const fixture = await startBrowserUseApiFixture()

  t.after(async () => {
    await fixture.close()
    await chrome.close().catch(() => undefined)
    await origin.close()
    await trap.close()
  })

  const acquirer = acquirerFor(fixture, chrome)

  await t.test('a reachable page becomes evidence and the session is stopped', async () => {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: chrome.wsEndpoint() }) })

    const result = await acquirer.acquire(`${origin.url}/article`, LOCAL_POLICY)

    assert.equal(result.failure, undefined)
    assert.equal(result.evidence?.finalUrl, `${origin.url}/article`)
    assert.equal(result.evidence?.httpStatus, 200)
    assert.match(result.evidence?.renderedHtml ?? '', /Independent evidence/u)
    assert.match(result.evidence?.text ?? '', /Independent evidence/u)
    assert.equal(result.cleanup.stopped, true)
    assert.ok(
      fixture.requests.some((request) => request.method === 'PATCH'),
      'the provider session must be released even on the happy path',
    )
  })

  await t.test('a URL the policy refuses never reaches the provider', async () => {
    const before = fixture.requests.length
    const result = await acquirer.acquire('http://10.0.0.5/secrets', LOCAL_POLICY)

    assert.equal(result.failure?.code, 'policy_denied')
    assert.equal(result.evidence, undefined)
    assert.equal(
      fixture.requests.length,
      before,
      'sending the URL to a third party is itself the egress the policy forbids',
    )
  })

  await t.test('a redirect out of the allowed set is blocked mid-navigation', async () => {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: chrome.wsEndpoint() }) })
    const restricted: BrowserAgentPolicy = {
      enabled: true,
      restrictDomains: true,
      domains: ['127.0.0.1'],
    }

    // Authorizing only the starting URL would let this hop through and have the
    // remote browser fetch a host we never approved.
    const result = await acquirer.acquire(`${origin.url}/redirect-out`, restricted)

    assert.equal(result.evidence, undefined)
    // Specifically a policy decision, not the generic read failure a stalled
    // navigation would also produce — otherwise this test would pass even if
    // the request were never authorized at all.
    assert.equal(result.failure?.code, 'policy_denied')
    assert.equal(result.cleanup.stopped, true)
  })

  await t.test('the trap subresource is reachable when nothing authorizes it', async () => {
    // The control for the next test. Without it, a zero-hit result would prove
    // only that the fixture never worked.
    trap.reset()
    const page = await chrome.newPage()
    try {
      await page.goto(`${origin.url}/with-subresource`, { waitUntil: 'networkidle2' })
    } finally {
      await page.close()
    }

    assert.equal(trap.hits, 1)
  })

  await t.test('a blocked subresource never reaches its origin', async () => {
    trap.reset()
    fixture.respondToCreate({ body: activeSession({ cdpUrl: chrome.wsEndpoint() }) })

    const result = await acquirer.acquire(`${origin.url}/with-subresource`, LOCAL_POLICY)

    assert.equal(trap.hits, 0, 'the remote browser must not fetch what the policy refuses')
    assert.ok(result.evidence, 'the page itself is still usable evidence')
  })

  await t.test('a popup cannot fetch through the remote browser unwatched', async () => {
    trap.reset()
    fixture.respondToCreate({ body: activeSession({ cdpUrl: chrome.wsEndpoint() }) })

    const result = await acquirer.acquire(`${origin.url}/popup`, LOCAL_POLICY)

    assert.equal(
      trap.hits,
      0,
      'a popup is a target with no interceptor, so it must not survive to fetch',
    )
    assert.ok(result.evidence)
  })

  await t.test('a target=_blank link cannot reach the network', async () => {
    trap.reset()
    fixture.respondToCreate({ body: activeSession({ cdpUrl: chrome.wsEndpoint() }) })

    // A new browsing context is created before this process can attach an
    // interceptor to it, so the context is prevented rather than policed.
    const result = await acquirer.acquire(`${origin.url}/target-blank`, LOCAL_POLICY)

    assert.equal(trap.hits, 0)
    assert.ok(result.evidence, 'the page itself is still read normally')
  })

  await t.test('a form targeting a new context cannot reach the network', async () => {
    trap.reset()
    fixture.respondToCreate({ body: activeSession({ cdpUrl: chrome.wsEndpoint() }) })

    const result = await acquirer.acquire(`${origin.url}/target-form`, LOCAL_POLICY)

    assert.equal(trap.hits, 0)
    assert.ok(result.evidence)
  })

  await t.test('a base target=_blank cannot reach the network', async () => {
    trap.reset()
    fixture.respondToCreate({ body: activeSession({ cdpUrl: chrome.wsEndpoint() }) })

    const result = await acquirer.acquire(`${origin.url}/base-target`, LOCAL_POLICY)

    assert.equal(trap.hits, 0)
    assert.ok(result.evidence)
  })

  await t.test('a second base element carrying the target cannot reach the network', async () => {
    trap.reset()
    fixture.respondToCreate({ body: activeSession({ cdpUrl: chrome.wsEndpoint() }) })

    const result = await acquirer.acquire(`${origin.url}/second-base`, LOCAL_POLICY)

    assert.equal(trap.hits, 0)
    assert.ok(result.evidence)
  })

  await t.test('a submit button overriding the form target cannot reach the network', async () => {
    trap.reset()
    fixture.respondToCreate({ body: activeSession({ cdpUrl: chrome.wsEndpoint() }) })

    const result = await acquirer.acquire(`${origin.url}/formtarget-button`, LOCAL_POLICY)

    assert.equal(trap.hits, 0)
    assert.ok(result.evidence)
  })

  for (const probe of [
    { path: '/worker-fetch', label: 'a dedicated Worker' },
    { path: '/service-worker', label: 'a ServiceWorker' },
    { path: '/websocket', label: 'a WebSocket handshake' },
    { path: '/worker-socket', label: 'a WebSocket opened inside a Worker' },
    { path: '/shared-worker', label: 'a SharedWorker' },
  ]) {
    await t.test(`${probe.label} cannot reach the network`, async () => {
      trap.reset()
      fixture.respondToCreate({ body: activeSession({ cdpUrl: chrome.wsEndpoint() }) })

      // Request interception is installed on the page. These three network
      // paths do not obviously travel through it, and an unauthorized fetch by
      // any of them is the same egress the policy forbids.
      const result = await acquirer.acquire(`${origin.url}${probe.path}`, LOCAL_POLICY)
      // Give a late worker or handshake a chance to reach the trap before the
      // count is read, so a pass cannot come from finishing first.
      await new Promise((resolve) => setTimeout(resolve, 750))

      assert.equal(trap.hits, 0, `${probe.label} reached the trap`)
      assert.ok(result.evidence)
    })
  }

  await t.test('the guard probe is not fooled by a non-configurable native getter', async () => {
    // The failure this reproduces: `serviceWorker` lives on Navigator.prototype
    // as an accessor that may already be non-configurable, so the guard's
    // `defineProperty` throws, is caught, and leaves a working ServiceWorker
    // container in place — while a descriptor-only probe happily reports it
    // locked, and the acquisition proceeds believing it is protected.
    const page = await chrome.newPage()
    try {
      await page.evaluateOnNewDocument(
        'Object.defineProperty(Navigator.prototype, "serviceWorker", {' +
          'get: function () { return { register: function () {} } },' +
          'configurable: false });',
      )
      await page.goto('about:blank')
      const report = parseGuardReport(await page.evaluate(guardReportExpression()))
      const serviceWorker = report.find((entry) => entry.name === 'serviceWorker')

      assert.equal(
        serviceWorker?.locked,
        false,
        'a usable ServiceWorker container must never be reported as locked',
      )
    } finally {
      await page.close()
    }
  })

  await t.test('the guard probe reports an unguarded page as unguarded', async () => {
    // A check that can only ever say "installed" is not a check. This runs the
    // probe against a page the guard was never applied to, which is also the
    // shape of the failure it exists to catch: a `defineProperty` that threw and
    // was swallowed, leaving the real API in place.
    const bare = await chrome.newPage()
    try {
      const report = parseGuardReport(await bare.evaluate(guardReportExpression()))
      const unlocked = report.filter((entry) => !entry.locked).map((entry) => entry.name)

      assert.ok(
        unlocked.includes('serviceWorker'),
        'a native ServiceWorker container must not be reported as locked',
      )
      assert.ok(unlocked.includes('WebSocket'))
      assert.ok(unlocked.includes('open'))
      assert.ok(unlocked.includes('HTMLFormElement.submit'))
    } finally {
      await bare.close()
    }
  })

  await t.test('the guard probe reports every guarded entry on a guarded page', async () => {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: chrome.wsEndpoint() }) })

    // The acquisition only reaches evidence if the probe passed, so a usable
    // result is itself the assertion that every entry reported locked.
    const result = await acquirer.acquire(`${origin.url}/article`, LOCAL_POLICY)

    assert.ok(result.evidence)
  })

  await t.test('an ordinary same-page link is left alone', async () => {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: chrome.wsEndpoint() }) })

    // The guard must be narrow. A page whose own script clicks a same-page link
    // — which is what a provider's CAPTCHA solver does — has to keep working.
    const result = await acquirer.acquire(`${origin.url}/same-page-click`, LOCAL_POLICY)

    assert.match(result.evidence?.finalUrl ?? '', /\/article$/u)
    assert.match(result.evidence?.text ?? '', /Independent evidence/u)
  })

  await t.test('an oversized page is truncated rather than carried whole', async () => {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: chrome.wsEndpoint() }) })
    const acquirerWithCap = acquirerFor(fixture, chrome, {
      maxHtmlBytes: 2_048,
      maxTextBytes: 1_024,
    })

    const result = await acquirerWithCap.acquire(`${origin.url}/huge`, LOCAL_POLICY)

    assert.equal(result.evidence?.renderedHtmlTruncated, true)
    assert.ok(Buffer.byteLength(result.evidence?.renderedHtml ?? '', 'utf8') <= 2_048)
    assert.ok(Buffer.byteLength(result.evidence?.text ?? '', 'utf8') <= 1_024)
  })

  await t.test('a caller who withdraws while the page settles gets no evidence', async () => {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: chrome.wsEndpoint() }) })
    const controller = new AbortController()
    const slowSettle = acquirerFor(fixture, chrome, { settleMs: 30_000 })

    const requested = origin.firstRequestTo('/settle-article')
    const running = slowSettle.acquire(
      `${origin.url}/settle-article`,
      LOCAL_POLICY,
      controller.signal,
    )
    // Withdraw only once the remote browser has actually asked for the page, so
    // the abort lands during the settle window rather than before the read.
    await requested
    controller.abort()
    const result = await running

    assert.equal(result.evidence, undefined, 'a withdrawn read must not be reported as evidence')
    assert.equal(result.failure?.code, 'cancelled')
    assert.equal(result.cleanup.stopped, true)
  })

  await t.test('a caller who withdraws mid-navigation gets no evidence', async () => {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: chrome.wsEndpoint() }) })
    const controller = new AbortController()
    const requested = origin.firstRequestTo('/slow-article')

    const running = acquirer.acquire(
      `${origin.url}/slow-article`,
      LOCAL_POLICY,
      controller.signal,
    )
    // The origin holds this response open, so the abort lands while the page is
    // still loading rather than after it settled.
    await requested
    controller.abort()
    const result = await running

    assert.equal(result.evidence, undefined)
    assert.equal(result.failure?.code, 'cancelled')
    assert.equal(result.cleanup.stopped, true)
  })

  await t.test('a multibyte page is cut on a character boundary', async () => {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: chrome.wsEndpoint() }) })
    // 401 is deliberately not a multiple of four, so a byte-blind cut lands
    // inside a four-byte code point.
    const capped = acquirerFor(fixture, chrome, { maxHtmlBytes: 401, maxTextBytes: 401 })

    const result = await capped.acquire(`${origin.url}/multibyte`, LOCAL_POLICY)

    const text = result.evidence?.text ?? ''
    assert.ok(Buffer.byteLength(text, 'utf8') <= 401)
    assert.equal(
      text.includes('\uFFFD'),
      false,
      'a cut that ignores UTF-8 boundaries leaves a replacement character behind',
    )
    assert.equal(result.evidence?.renderedHtmlTruncated, true)
  })

  await t.test('an authorization that cannot be decided fails closed', async () => {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: chrome.wsEndpoint() }) })
    const rejections: unknown[] = []
    const record = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', record)
    try {
      const result = await acquirerFor(fixture, chrome, {
        networkPolicy: new ExplodingNetworkPolicy(),
      }).acquire(`${origin.url}/article`, LOCAL_POLICY)

      assert.equal(result.evidence, undefined)
      await new Promise((resolve) => setImmediate(resolve))
      assert.deepEqual(rejections, [], 'a failed decision must not escape as an unhandled rejection')
    } finally {
      process.off('unhandledRejection', record)
    }
  })

  await t.test('an already-cancelled caller spends nothing', async () => {
    const before = fixture.requests.length
    const controller = new AbortController()
    controller.abort()

    const result = await acquirer.acquire(
      `${origin.url}/article`,
      LOCAL_POLICY,
      controller.signal,
    )

    assert.equal(result.failure?.code, 'cancelled')
    assert.equal(fixture.requests.length, before)
  })
})

test('a disconnect that rejects cannot lose the acquisition', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({
      body: activeSession({ cdpUrl: 'wss://cdp.browser-use.com/session/abc' }),
    })
    const acquirer = new CloudBrowserAcquirer({
      sessionClient: new BrowserUseSessionClient({
        apiKey: 'bu_test_key_never_leaks',
        endpoint: fixture.url,
        perCallBudgetMs: 60_000,
      }),
      networkPolicy: new BrowserNetworkPolicy({}),
      connect: async () => ({
        newPage: async () => {
          throw new Error('the page could not be opened')
        },
        // Puppeteer's disconnect is async, so a rejection here would otherwise
        // escape as an unhandled promise long after the call returned.
        disconnect: async () => {
          throw new Error('the socket was already gone')
        },
      }),
    })

    const rejections: unknown[] = []
    const record = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', record)
    try {
      const result = await acquirer.acquire('https://example.com/report', {
        enabled: true,
        restrictDomains: true,
        domains: ['example.com'],
      })

      assert.equal(result.failure?.code, 'provider_session_failed')
      assert.equal(result.cleanup.stopped, true)
      await new Promise((resolve) => setImmediate(resolve))
      assert.deepEqual(rejections, [])
    } finally {
      process.off('unhandledRejection', record)
    }
  } finally {
    await fixture.close()
  }
})

test('a withdrawal during the control handshake stops promptly and lets go', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({
      body: activeSession({ cdpUrl: 'wss://cdp.browser-use.com/session/abc' }),
    })
    let disconnected = 0
    let settleLateConnection = (): void => undefined
    const lateConnection = new Promise<void>((resolve) => {
      settleLateConnection = resolve
    })
    let announceConnectStarted = (): void => undefined
    const connectStarted = new Promise<void>((resolve) => {
      announceConnectStarted = resolve
    })
    const controller = new AbortController()

    const acquirer = new CloudBrowserAcquirer({
      sessionClient: new BrowserUseSessionClient({
        apiKey: 'bu_test_key_never_leaks',
        endpoint: fixture.url,
        perCallBudgetMs: 60_000,
      }),
      networkPolicy: new BrowserNetworkPolicy({}),
      // Far longer than this test will wait: the point is that withdrawal wins,
      // not that the connect bound eventually fires.
      connectTimeoutMs: 60_000,
      connect: async () => {
        announceConnectStarted()
        await lateConnection
        return {
          newPage: async () => {
            throw new Error('the page was never wanted')
          },
          disconnect: () => {
            disconnected += 1
          },
        }
      },
    })

    const running = acquirer.acquire(
      'https://example.com/report',
      { enabled: true, restrictDomains: true, domains: ['example.com'] },
      controller.signal,
    )
    // Withdraw once the handshake is genuinely under way. Aborting earlier is a
    // different case: the client would then never connect at all.
    await connectStarted
    controller.abort()
    const result = await running

    assert.equal(result.failure?.code, 'cancelled')
    // The withdrawal must have reached stop without waiting for the handshake.
    assert.ok(fixture.requests.some((request) => request.method === 'PATCH'))
    assert.equal(result.cleanup.stopped, true)

    settleLateConnection()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(disconnected, 1, 'the connection that arrives late must be released')
  } finally {
    await fixture.close()
  }
})

test('a policy that cannot answer fails closed before any provider request', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    const acquirer = new CloudBrowserAcquirer({
      sessionClient: new BrowserUseSessionClient({
        apiKey: 'bu_test_key_never_leaks',
        endpoint: fixture.url,
        perCallBudgetMs: 60_000,
      }),
      networkPolicy: new ExplodingNetworkPolicy({ failFirst: true }),
    })

    const result = await acquirer.acquire('https://example.com/report', {
      enabled: true,
      restrictDomains: true,
      domains: ['example.com'],
    })

    assert.equal(result.failure?.code, 'policy_denied')
    assert.deepEqual(fixture.requests, [], 'an undecided policy must not spend money')
  } finally {
    await fixture.close()
  }
})

test('a control connection that never completes is bounded and released', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({
      body: activeSession({ cdpUrl: 'wss://cdp.browser-use.com/session/abc' }),
    })
    let disconnected = 0
    let settleLateConnection = (): void => undefined
    const lateConnection = new Promise<void>((resolve) => {
      settleLateConnection = resolve
    })

    const acquirer = new CloudBrowserAcquirer({
      sessionClient: new BrowserUseSessionClient({
        apiKey: 'bu_test_key_never_leaks',
        endpoint: fixture.url,
        perCallBudgetMs: 60_000,
      }),
      networkPolicy: new BrowserNetworkPolicy({}),
      connectTimeoutMs: 100,
      // Puppeteer 25.3 bounds its commands but not the websocket handshake, so
      // a provider that accepts a socket and goes quiet would hang here.
      connect: async () => {
        await lateConnection
        return {
          newPage: async () => {
            throw new Error('the page was never wanted')
          },
          disconnect: () => {
            disconnected += 1
          },
        }
      },
    })

    const result = await acquirer.acquire('https://example.com/report', {
      enabled: true,
      restrictDomains: true,
      domains: ['example.com'],
    })

    assert.equal(result.evidence, undefined)
    assert.equal(result.failure?.code, 'provider_session_failed')
    assert.equal(result.cleanup.stopped, true)

    // The handshake that lost the race must not be left holding a socket.
    settleLateConnection()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(disconnected, 1, 'the late connection must be disconnected, not abandoned')
  } finally {
    await fixture.close()
  }
})

function acquirerFor(
  fixture: BrowserUseApiFixture,
  chrome: Browser,
  overrides: Partial<{
    settleMs: number
    maxHtmlBytes: number
    maxTextBytes: number
    networkPolicy: BrowserNetworkPolicy
  }> = {},
): CloudBrowserAcquirer {
  return new CloudBrowserAcquirer({
    sessionClient: new BrowserUseSessionClient({
      apiKey: 'bu_test_key_never_leaks',
      endpoint: fixture.url,
      perCallBudgetMs: 60_000,
      cdpHostAllowlist: [new URL(chrome.wsEndpoint()).hostname],
    }),
    networkPolicy: new BrowserNetworkPolicy({ allowHttpLocalhost: true }),
    navigationTimeoutMs: 20_000,
    settleMs: 50,
    ...overrides,
  })
}

/**
 * A policy that answers the first question and then fails.
 *
 * The first answer lets the acquisition reach a live page; every decision after
 * it is undecidable, which is the case that must fail closed rather than leave
 * a request hanging or crash the process.
 */
class ExplodingNetworkPolicy extends BrowserNetworkPolicy {
  private answered = false
  private readonly failFirst: boolean

  constructor(options: { readonly failFirst?: boolean } = {}) {
    super({})
    this.failFirst = options.failFirst === true
  }

  override async allows(): Promise<boolean> {
    if (this.failFirst || this.answered) throw new Error('the resolver is down')
    this.answered = true
    return true
  }

  override async allowsSubresource(): Promise<boolean> {
    throw new Error('the resolver is down')
  }
}

interface TrapServer {
  readonly port: number
  readonly hits: number
  reset(): void
  close(): Promise<void>
}

async function startTrapServer(): Promise<TrapServer> {
  let hits = 0
  const server = http.createServer((_request, response) => {
    hits += 1
    response.writeHead(200, { 'content-type': 'image/png' })
    response.end()
  })
  // A websocket handshake is an HTTP upgrade, and Node routes it here rather
  // than to the request handler. Counting it separately is the only way to see
  // whether `ws://` egress escapes request interception.
  server.on('upgrade', (_request, socket) => {
    hits += 1
    socket.destroy()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('The trap fixture did not bind a port.')
  }
  return {
    port: address.port,
    get hits() {
      return hits
    },
    reset() {
      hits = 0
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

interface OriginServer {
  readonly url: string
  /**
   * A promise resolving the next time the browser asks for `path`.
   *
   * Created per call, so one test's navigation can never satisfy another's
   * wait — which is exactly how an abort test can end up aborting before the
   * read it meant to interrupt has even started.
   */
  firstRequestTo(path: string): Promise<void>
  close(): Promise<void>
}

async function startOriginServer(): Promise<OriginServer> {
  const waiters = new Map<string, Array<() => void>>()
  const announce = (path: string): void => {
    for (const resolve of waiters.get(path) ?? []) resolve()
    waiters.delete(path)
  }
  const server = http.createServer((request, response) => {
    if (request.url === '/redirect-out') {
      response.writeHead(302, { location: 'http://blocked.example/elsewhere' })
      response.end()
      return
    }
    if (request.url === '/with-subresource') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        '<!doctype html><html><body><h1>Independent evidence</h1>' +
          '<img src="http://trap.internal/trap.png" alt="trap">' +
          '</body></html>',
      )
      return
    }
    if (request.url === '/huge') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        `<!doctype html><html><body><p>${'evidence '.repeat(20_000)}</p></body></html>`,
      )
      return
    }
    announce(request.url ?? '')
    if (request.url === '/slow-article') {
      // Held open so a caller can withdraw while the navigation is genuinely
      // still in flight.
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end('<!doctype html><html><body><p>late</p></body></html>')
      }, 30_000).unref()
      return
    }
    if (request.url === '/target-blank') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      // Never calls window.open, and tries to unpick the guard first.
      response.end(
        '<!doctype html><html><body><h1>Independent evidence</h1>' +
          '<a id="out" href="http://trap.internal/blank.png" target="_blank">go</a>' +
          '<script>' +
          // Attacks every native the handler could still have read at call
          // time, not only the ones it captures obviously.
          'try { delete Element.prototype.getAttribute } catch (error) {}' +
          'try { EventTarget.prototype.addEventListener = function () {} } catch (error) {}' +
          'try { Event.prototype.composedPath = function () { return [] } } catch (error) {}' +
          'try { Event.prototype.preventDefault = function () {} } catch (error) {}' +
          'try { Array.prototype.indexOf = function () { return -1 } } catch (error) {}' +
          'try { window.String = function () { return "_self" } } catch (error) {}' +
          'try { Function.prototype.apply = function () {} } catch (error) {}' +
          'try { Function.prototype.call = function () {} } catch (error) {}' +
          'try { String.prototype.toLowerCase = function () { return "_self" } } catch (error) {}' +
          'try { String.prototype.toUpperCase = function () { return "SPAN" } } catch (error) {}' +
          'document.getElementById("out").click();' +
          '</script>' +
          '</body></html>',
      )
      return
    }
    if (request.url === '/base-target') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      // No target on the anchor at all: the new context comes from <base>.
      response.end(
        '<!doctype html><html><head><base target="_blank"></head>' +
          '<body><h1>Independent evidence</h1>' +
          '<a id="out" href="http://trap.internal/base.png">go</a>' +
          '<script>document.getElementById("out").click()</script>' +
          '</body></html>',
      )
      return
    }
    if (request.url === '/sw.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      response.end(
        'self.addEventListener("install", function () {' +
          'fetch("http://trap.internal/sw.png").catch(function () {})' +
          '});',
      )
      return
    }
    if (request.url === '/worker-fetch') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        '<!doctype html><html><body><h1>Independent evidence</h1><script>' +
          'var src = \'fetch("http://trap.internal/worker.png").catch(function(){})\';' +
          'try { new Worker(URL.createObjectURL(new Blob([src], {type: "text/javascript"}))) }' +
          'catch (error) {}' +
          '</script></body></html>',
      )
      return
    }
    if (request.url === '/worker-socket') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      // The guard runs in Window. A worker has its own global scope, where
      // WebSocket may still be present even though its fetch is intercepted.
      response.end(
        '<!doctype html><html><body><h1>Independent evidence</h1><script>' +
          'var src = \'try { new WebSocket("ws://trap.internal/worker-socket") } catch (e) {}\';' +
          'try { new Worker(URL.createObjectURL(new Blob([src], {type: "text/javascript"}))) }' +
          'catch (error) {}' +
          '</script></body></html>',
      )
      return
    }
    if (request.url === '/shared-worker') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        '<!doctype html><html><body><h1>Independent evidence</h1><script>' +
          'var src = \'fetch("http://trap.internal/shared.png").catch(function(){});\' +' +
          '\'try { new WebSocket("ws://trap.internal/shared-socket") } catch (e) {}\';' +
          'try { new SharedWorker(URL.createObjectURL(new Blob([src], {type: "text/javascript"}))) }' +
          'catch (error) {}' +
          '</script></body></html>',
      )
      return
    }
    if (request.url === '/service-worker') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        '<!doctype html><html><body><h1>Independent evidence</h1><script>' +
          'try { navigator.serviceWorker.register("/sw.js") } catch (error) {}' +
          '</script></body></html>',
      )
      return
    }
    if (request.url === '/websocket') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        '<!doctype html><html><body><h1>Independent evidence</h1><script>' +
          'try { new WebSocket("ws://trap.internal/socket") } catch (error) {}' +
          '</script></body></html>',
      )
      return
    }
    if (request.url === '/second-base') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      // HTML resolves the target from the first base *carrying a target*, so a
      // leading href-only base must not hide the one after it.
      response.end(
        '<!doctype html><html><head><base href="/"><base target="_blank"></head>' +
          '<body><h1>Independent evidence</h1>' +
          '<a id="out" href="http://trap.internal/second.png">go</a>' +
          '<script>document.getElementById("out").click()</script>' +
          '</body></html>',
      )
      return
    }
    if (request.url === '/formtarget-button') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      // The form targets itself; the submit button overrides it.
      response.end(
        '<!doctype html><html><body><h1>Independent evidence</h1>' +
          '<form id="f" action="http://trap.internal/button.png" target="_self">' +
          '<button id="b" type="submit" formtarget="_blank">send</button></form>' +
          '<script>' +
          'var b = document.getElementById("b");' +
          'b.click();' +
          'try { document.getElementById("f").requestSubmit(b) } catch (error) {}' +
          '</script>' +
          '</body></html>',
      )
      return
    }
    if (request.url === '/target-form') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        '<!doctype html><html><body><h1>Independent evidence</h1>' +
          '<form id="f" action="http://trap.internal/form.png" target="_blank"></form>' +
          '<script>' +
          'var f = document.getElementById("f");' +
          'try { f.submit() } catch (error) {}' +
          'try { f.requestSubmit() } catch (error) {}' +
          '</script>' +
          '</body></html>',
      )
      return
    }
    if (request.url === '/same-page-click') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        '<!doctype html><html><body><h1>Placeholder</h1>' +
          '<a id="go" href="/article">continue</a>' +
          '<script>document.getElementById("go").click()</script>' +
          '</body></html>',
      )
      return
    }
    if (request.url === '/popup') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        '<!doctype html><html><body><h1>Independent evidence</h1>' +
          // Tries to remove the guard first, so the test proves the boundary
        // rather than a page that politely leaves it alone.
        '<script>' +
        'try { delete window.open } catch (error) {}' +
        'try { window.open = function (u) { return null } } catch (error) {}' +
        'try { Object.defineProperty(window, "open", { value: function () {} }) }' +
        'catch (error) {}' +
        'window.open("http://trap.internal/popup.png");' +
        '</script>' +
          '</body></html>',
      )
      return
    }
    if (request.url === '/multibyte') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      // Four-byte code points, so any cut that ignores UTF-8 boundaries splits
      // one and the decoded result carries a replacement character.
      response.end(`<!doctype html><html><body><p>${'\u{1F9EA}'.repeat(400)}</p></body></html>`)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(
      '<!doctype html><html><head><title>Report</title></head>' +
        '<body><main><h1>Independent evidence</h1>' +
        '<p>A page with enough usable content to be worth citing.</p>' +
        '</main></body></html>',
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('The origin fixture did not bind a port.')
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    firstRequestTo(path) {
      return new Promise<void>((resolve) => {
        waiters.set(path, [...(waiters.get(path) ?? []), resolve])
      })
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
