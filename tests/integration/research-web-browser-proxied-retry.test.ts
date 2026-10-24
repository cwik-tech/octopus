import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as net from 'node:net'
import * as path from 'node:path'
import test from 'node:test'

import { Agent } from 'undici'

import { SOURCE_OBSERVATION_RECEIPT_VERSION } from '../../domains/acquisition/acquisition-types.js'
import {
  LOOPBACK_PROXY_PASSWORD,
  LOOPBACK_PROXY_USERNAME,
  chromeSkipReason,
  createFixture,
  readerEnabledSettings,
  startForwardProxy,
  startOriginServer,
  startReaderServer,
  webshareProxyPort,
} from '../support/research-web-proxy-fixture.js'

/**
 * The managed-browser half of the Webshare retry.
 *
 * Every journey here runs the three-way origin: the direct acquirer is answered
 * with a page too short to be evidence, unproxied Chrome is denied, and Chrome
 * behind the proxy gets the answer under test. The direct answer is
 * deliberately `insufficient` rather than a denial, because a denial there is
 * terminal and host-scoped and would be recovered by the already-shipped
 * `direct-http-proxied` rung — which would make every assertion below pass with
 * no managed-browser proxying implemented at all. Each journey therefore also
 * asserts that no `direct-http-proxied` attempt appears.
 */

const authenticatingProxy = () =>
  startForwardProxy({
    requireAuth: {
      username: LOOPBACK_PROXY_USERNAME,
      password: LOOPBACK_PROXY_PASSWORD,
    },
  })

test(
  'a browser denial is retried once through the proxy and the recovered page keeps the host reachable',
  { skip: chromeSkipReason() },
  async (context) => {
    const proxy = await authenticatingProxy()
    context.after(() => proxy.close())
    const origin = await startOriginServer(proxy.proxyLocalPorts)
    context.after(() => origin.close())
    const fixture = await createFixture(context, {
      chrome: true,
      proxyPort: webshareProxyPort(proxy.port),
      settings: readerEnabledSettings(),
    })
    context.after(() => fixture.closeBrowser())

    const result = await fixture.service.execute(
      fixture.requestContext,
      'call-browser-denied',
      {
        action: 'acquire',
        url: `${origin.url}/insufficient-then-denied-until-proxied`,
      },
    )

    // The recovered page is what the caller receives, from the proxied rung.
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.method, 'managed-browser-proxied')
    assert.deepEqual(
      result.attempts?.map((attempt) => attempt.method),
      ['direct-http', 'managed-browser', 'managed-browser-proxied'],
      JSON.stringify(result),
    )
    assert.deepEqual(
      result.attempts?.map((attempt) => attempt.outcome),
      ['insufficient', 'access-denied', 'usable'],
      JSON.stringify(result),
    )
    assert.equal(
      result.attempts?.some((attempt) => attempt.method === 'direct-http-proxied'),
      false,
      'the direct rung was never terminal, so its proxied retry must not have run',
    )

    // The evidence came from the proxy's vantage point, not the house one.
    assert.match(String(result.title), /from the proxy/u)

    // The receipt an operator reads names the transport that produced it.
    assert.ok(result.observationReceipt)
    const receipt = JSON.parse(
      await fs.readFile(
        path.join(fixture.assignmentPath, result.observationReceipt.relativePath),
        'utf8',
      ),
    ) as { schemaVersion: number; method: string; quality: string }
    assert.equal(receipt.method, 'managed-browser-proxied')
    assert.equal(receipt.schemaVersion, SOURCE_OBSERVATION_RECEIPT_VERSION)
    assert.equal(receipt.quality, 'usable')

    // The proxied rung names the egress it used, without naming the endpoint.
    const proxiedAttempt = result.attempts?.at(-1)
    assert.equal(proxiedAttempt?.method, 'managed-browser-proxied')
    assert.deepEqual(proxiedAttempt?.proxyRuntime, {
      provider: 'webshare',
      mode: 'rotating',
      tier: 'unknown',
    })
    assert.equal(proxiedAttempt?.browserRuntime?.driver, 'puppeteer-core')
    assert.equal(proxiedAttempt?.browserRuntime?.launchProfile, 'stock')
    assert.doesNotMatch(
      JSON.stringify(result.attempts),
      new RegExp(`${LOOPBACK_PROXY_USERNAME}|${LOOPBACK_PROXY_PASSWORD}|${proxy.port}`, 'u'),
      'no proxy credential or endpoint may reach the attempt trail',
    )

    // The retry actually left the machine through the authenticating proxy.
    // Chrome opens more than one connection per navigation and asks for a
    // favicon, so the honest unit is the origin's own view of the page.
    assert.equal(
      origin.proxiedRequests.filter(
        (request) => request === '/insufficient-then-denied-until-proxied',
      ).length,
      1,
      'the page was read through the proxy exactly once',
    )
    assert.ok(proxy.challenges >= 1, 'Chrome answered the proxy 407 challenge')
    assert.deepEqual(
      origin.credentialHeadersSeen,
      [],
      'the proxy credential is addressed to the proxy and must stop there',
    )

    // A recovered denial leaves the rest of the host available to the lane.
    const laterUrlOnSameHost = await fixture.service.execute(
      fixture.requestContext,
      'call-later',
      { action: 'acquire', url: `${origin.url}/plain`, allowBrowserFallback: false },
    )
    assert.equal(laterUrlOnSameHost.ok, true, JSON.stringify(laterUrlOnSameHost))
  },
)

test(
  'a denial that survives the proxy ends the lane for that host',
  { skip: chromeSkipReason() },
  async (context) => {
    const proxy = await authenticatingProxy()
    context.after(() => proxy.close())
    const origin = await startOriginServer(proxy.proxyLocalPorts)
    context.after(() => origin.close())
    const fixture = await createFixture(context, {
      chrome: true,
      proxyPort: webshareProxyPort(proxy.port),
      settings: readerEnabledSettings(),
    })
    context.after(() => fixture.closeBrowser())

    const result = await fixture.service.execute(
      fixture.requestContext,
      'call-denied-everywhere',
      {
        action: 'acquire',
        url: `${origin.url}/insufficient-then-denied-everywhere`,
      },
    )

    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.error?.code, 'access_denied')
    assert.deepEqual(
      result.attempts?.map((attempt) => attempt.method),
      ['direct-http', 'managed-browser', 'managed-browser-proxied'],
      JSON.stringify(result),
    )
    assert.deepEqual(
      result.attempts?.map((attempt) => attempt.outcome),
      ['insufficient', 'access-denied', 'access-denied'],
      JSON.stringify(result),
    )

    const laterUrlOnSameHost = await fixture.service.execute(
      fixture.requestContext,
      'call-later',
      { action: 'acquire', url: `${origin.url}/plain`, allowBrowserFallback: false },
    )
    assert.equal(
      laterUrlOnSameHost.error?.code,
      'access_denied',
      'a denial the proxy could not clear bans the host, and the ban says so',
    )
  },
)

test(
  'a missing page seen through the proxy leaves the host reachable',
  { skip: chromeSkipReason() },
  async (context) => {
    const proxy = await authenticatingProxy()
    context.after(() => proxy.close())
    const origin = await startOriginServer(proxy.proxyLocalPorts)
    context.after(() => origin.close())
    const fixture = await createFixture(context, {
      chrome: true,
      proxyPort: webshareProxyPort(proxy.port),
      settings: readerEnabledSettings(),
    })
    context.after(() => fixture.closeBrowser())

    const result = await fixture.service.execute(
      fixture.requestContext,
      'call-missing-through-proxy',
      {
        action: 'acquire',
        url: `${origin.url}/insufficient-then-denied-then-missing`,
      },
    )

    assert.equal(result.ok, false, JSON.stringify(result))
    assert.deepEqual(
      result.attempts?.map((attempt) => attempt.outcome),
      ['insufficient', 'access-denied', 'not-found'],
      JSON.stringify(result),
    )

    const laterUrlOnSameHost = await fixture.service.execute(
      fixture.requestContext,
      'call-later',
      { action: 'acquire', url: `${origin.url}/plain`, allowBrowserFallback: false },
    )
    assert.equal(
      laterUrlOnSameHost.ok,
      true,
      'the last rung reached found a missing page, which is about the URL rather than the host',
    )
  },
)

test(
  'with no proxy configured a browser denial keeps its existing terminal trail and lane ban',
  { skip: chromeSkipReason() },
  async (context) => {
    const origin = await startOriginServer()
    context.after(() => origin.close())
    const fixture = await createFixture(context, {
      chrome: true,
      settings: readerEnabledSettings(),
    })
    context.after(() => fixture.closeBrowser())

    const result = await fixture.service.execute(
      fixture.requestContext,
      'call-no-proxy',
      {
        action: 'acquire',
        url: `${origin.url}/insufficient-then-denied-until-proxied`,
      },
    )

    assert.equal(result.ok, false, JSON.stringify(result))
    assert.deepEqual(
      result.attempts?.map((attempt) => attempt.method),
      ['direct-http', 'managed-browser'],
      JSON.stringify(result),
    )
    assert.deepEqual(
      result.attempts?.map((attempt) => attempt.outcome),
      ['insufficient', 'access-denied'],
    )

    const laterUrlOnSameHost = await fixture.service.execute(
      fixture.requestContext,
      'call-later',
      { action: 'acquire', url: `${origin.url}/plain`, allowBrowserFallback: false },
    )
    assert.equal(
      laterUrlOnSameHost.error?.code,
      'access_denied',
      'without a proxy the legacy unconditional ban is untouched',
    )
  },
)

test(
  'with the proxy disabled managed Chrome still acquires directly and the proxy is never contacted',
  { skip: chromeSkipReason() },
  async (context) => {
    const proxy = await authenticatingProxy()
    context.after(() => proxy.close())
    const origin = await startOriginServer(proxy.proxyLocalPorts)
    context.after(() => origin.close())
    let opened = 0
    const fixture = await createFixture(context, {
      chrome: true,
      settings: readerEnabledSettings(),
      // A configured port that reports the proxy off, which is what the
      // Settings switch produces when a user turns it back off.
      proxyPort: {
        open: async () => {
          opened += 1
          return undefined
        },
      },
    })
    context.after(() => fixture.closeBrowser())

    const result = await fixture.service.execute(
      fixture.requestContext,
      'call-proxy-disabled',
      {
        action: 'acquire',
        url: `${origin.url}/insufficient-then-usable-in-chrome`,
      },
    )

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.method, 'managed-browser')
    assert.deepEqual(
      result.attempts?.map((attempt) => attempt.method),
      ['direct-http', 'managed-browser'],
      JSON.stringify(result),
    )
    assert.deepEqual(
      result.attempts?.map((attempt) => attempt.outcome),
      ['insufficient', 'usable'],
    )
    assert.match(
      String(result.title),
      /from the house connection/u,
      'the evidence came from the ordinary direct managed-Chrome read',
    )
    assert.equal(opened, 0, 'a non-host-scoped browser outcome never consults the port')
    assert.equal(proxy.connections, 0)
    assert.equal(proxy.challenges, 0)
    assert.deepEqual(origin.proxiedRequests, [])
  },
)

test(
  'the retry spends a browser-fallback slot and is skipped once the ceiling is reached',
  { skip: chromeSkipReason() },
  async (context) => {
    const proxy = await authenticatingProxy()
    context.after(() => proxy.close())
    const origin = await startOriginServer(proxy.proxyLocalPorts)
    context.after(() => origin.close())
    let opened = 0
    const fixture = await createFixture(context, {
      chrome: true,
      settings: {
        ...readerEnabledSettings(),
        budgets: {
          maximumSearchCalls: 1,
          // Exactly one browser rung, so the retry has no slot to spend.
          maximumBrowserFallbacks: 1,
          maximumManagedReaderCalls: 2,
          maximumModelExtractions: 1,
      maximumCloudBrowserCalls: 0,
      maximumCloudBrowserCostMicros: 0,
        },
      },
      proxyPort: {
        open: async (signal) => {
          opened += 1
          return webshareProxyPort(proxy.port).open(signal)
        },
      },
    })
    context.after(() => fixture.closeBrowser())

    const result = await fixture.service.execute(
      fixture.requestContext,
      'call-budget-exhausted',
      {
        action: 'acquire',
        url: `${origin.url}/insufficient-then-denied-until-proxied`,
      },
    )

    assert.equal(result.ok, false, JSON.stringify(result))
    assert.deepEqual(
      result.attempts?.map((attempt) => attempt.method),
      ['direct-http', 'managed-browser'],
      JSON.stringify(result),
    )
    assert.equal(opened, 0, 'a retry with no budget never opens a proxy session')
    assert.equal(proxy.connections, 0)
  },
)

test(
  'a caller who withdraws while the ordinary managed-Chrome read is loading never consults the proxy at all',
  { skip: chromeSkipReason() },
  async (context) => {
    const proxy = await authenticatingProxy()
    context.after(() => proxy.close())
    const origin = await startOriginServer(proxy.proxyLocalPorts)
    context.after(() => origin.close())
    const reader = await startReaderServer()
    context.after(() => reader.close())
    let opened = 0
    const controller = new AbortController()
    const fixture = await createFixture(context, {
      chrome: true,
      readerEndpoint: `${reader.url}/reader`,
      settings: readerEnabledSettings(),
      proxyPort: {
        open: async (signal) => {
          opened += 1
          return webshareProxyPort(proxy.port).open(signal)
        },
      },
    })
    context.after(() => fixture.closeBrowser())

    // The origin announces the unproxied Chrome read and then answers nothing,
    // so the withdrawal lands while that rung is genuinely in flight.
    const pending = fixture.service.execute(
      fixture.requestContext,
      'call-withdrawn-in-chrome',
      {
        action: 'acquire',
        url: `${origin.url}/insufficient-then-hangs-in-chrome`,
        allowManagedReaderFallback: true,
      },
      controller.signal,
    )
    await origin.chromeRequestReceived
    controller.abort()
    const result = await pending

    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.error?.code, 'cancelled')
    // `cancelled` is the caller withdrawing, not the host refusing this egress,
    // so the retry has nothing to answer and never runs.
    assert.deepEqual(
      result.attempts?.map((attempt) => `${attempt.method}:${attempt.outcome}`),
      ['direct-http:insufficient', 'managed-browser:cancelled'],
      JSON.stringify(result),
    )
    assert.equal(opened, 0, 'a withdrawn caller never opens a proxy session')
    assert.equal(proxy.connections, 0)
    assert.equal(reader.calls, 0, 'and never starts the reader rung')

    const laterUrlOnSameHost = await fixture.service.execute(
      fixture.requestContext,
      'call-later',
      { action: 'acquire', url: `${origin.url}/plain`, allowBrowserFallback: false },
    )
    assert.equal(laterUrlOnSameHost.ok, true, 'a cancelled call never bans its host')
  },
)

test(
  'a proxy that is enabled but unusable records a redacted failed retry and leaves the host reachable',
  { skip: chromeSkipReason() },
  async (context) => {
    const origin = await startOriginServer()
    context.after(() => origin.close())
    const fixture = await createFixture(context, {
      chrome: true,
      settings: readerEnabledSettings(),
      proxyPort: {
        open: () =>
          Promise.reject(
            new Error(
              'Webshare API token validation failed for user hunter2-rotate at http://user:hunter2@p.webshare.io:80',
            ),
          ),
      },
    })
    context.after(() => fixture.closeBrowser())

    const result = await fixture.service.execute(
      fixture.requestContext,
      'call-unusable-proxy',
      {
        action: 'acquire',
        url: `${origin.url}/insufficient-then-denied-until-proxied`,
      },
    )

    const retry = result.attempts?.find(
      (attempt) => attempt.method === 'managed-browser-proxied',
    )
    assert.ok(retry, JSON.stringify(result))
    assert.equal(retry.outcome, 'failed')
    for (const secret of ['hunter2', 'p.webshare.io', 'rotate', 'user:', '://']) {
      assert.doesNotMatch(
        String(retry.reason),
        new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
        `the reason must not carry ${secret}`,
      )
    }

    const laterUrlOnSameHost = await fixture.service.execute(
      fixture.requestContext,
      'call-later',
      { action: 'acquire', url: `${origin.url}/plain`, allowBrowserFallback: false },
    )
    assert.equal(
      laterUrlOnSameHost.ok,
      true,
      'a proxy that would not open says nothing about the source, so the host stays reachable',
    )
  },
)

test(
  'a proxy Chrome cannot reach records a redacted failed retry that quotes no address',
  { skip: chromeSkipReason() },
  async (context) => {
    const origin = await startOriginServer()
    context.after(() => origin.close())
    // A port nothing is listening on, so Chrome fails in transport and reports
    // the address it could not reach.
    const unreachable = await unusedLoopbackPort()
    const fixture = await createFixture(context, {
      chrome: true,
      settings: readerEnabledSettings(),
      proxyPort: {
        open: async () => ({
          dispatcher: new Agent(),
          browserEndpoint: {
            server: `http://127.0.0.1:${unreachable}`,
            username: 'loopback-user',
            password: 'loopback-password',
          },
          close: async () => undefined,
        }),
      },
    })
    context.after(() => fixture.closeBrowser())

    const result = await fixture.service.execute(
      fixture.requestContext,
      'call-unreachable-proxy',
      {
        action: 'acquire',
        url: `${origin.url}/insufficient-then-denied-until-proxied`,
      },
    )

    const retry = result.attempts?.find(
      (attempt) => attempt.method === 'managed-browser-proxied',
    )
    assert.ok(retry, JSON.stringify(result))
    assert.equal(retry.outcome, 'failed')
    // The address Chrome quotes is dropped, but the fact that the *proxy hop*
    // failed is kept. Without it a Webshare-side refusal and a denial by the
    // source are the same line in the journal.
    assert.match(String(retry.reason), /Webshare proxy refused|could not be reached/u)
    assert.match(
      String(retry.reason),
      /net::ERR_[A-Z0-9_]+/u,
      'the Chrome error class is a fixed token and is worth keeping',
    )
    assert.equal(
      retry.httpStatus,
      undefined,
      'a read that never reached the source has no status of its own',
    )
    assert.doesNotMatch(
      String(retry.reason),
      /:\/\/|127\.0\.0\.1|loopback-password|loopback-user/u,
      'no address and no credential reach the agent-readable trail',
    )

    const laterUrlOnSameHost = await fixture.service.execute(
      fixture.requestContext,
      'call-later',
      { action: 'acquire', url: `${origin.url}/plain`, allowBrowserFallback: false },
    )
    assert.equal(
      laterUrlOnSameHost.ok,
      true,
      'a proxy that would not connect says nothing about the source',
    )
  },
)

test(
  'a denial that came from the source through the proxy keeps its status and says so',
  { skip: chromeSkipReason() },
  async (context) => {
    const proxy = await authenticatingProxy()
    context.after(() => proxy.close())
    const origin = await startOriginServer(proxy.proxyLocalPorts)
    context.after(() => origin.close())
    const fixture = await createFixture(context, {
      chrome: true,
      proxyPort: webshareProxyPort(proxy.port),
      settings: readerEnabledSettings(),
    })
    context.after(() => fixture.closeBrowser())

    const result = await fixture.service.execute(
      fixture.requestContext,
      'call-denied-through-proxy',
      {
        action: 'acquire',
        url: `${origin.url}/insufficient-then-denied-everywhere`,
      },
    )

    const retry = result.attempts?.find(
      (attempt) => attempt.method === 'managed-browser-proxied',
    )
    assert.ok(retry, JSON.stringify(result))
    assert.equal(retry.outcome, 'access-denied')
    // An operator has to be able to tell a proxy that refused the host from a
    // source that refused the read. The status and the provenance are both
    // credential-free, so both are kept.
    assert.equal(retry.httpStatus, 403)
    assert.match(String(retry.reason), /HTTP 403/u)
    assert.match(String(retry.reason), /source denied/u)
    assert.doesNotMatch(
      String(retry.reason),
      /Webshare proxy refused|could not be reached/u,
      'this denial came from the source, not from the proxy hop',
    )
    assert.doesNotMatch(
      String(retry.reason),
      /:\/\/|127\.0\.0\.1|loopback-password|loopback-user/u,
    )
  },
)

test(
  'a caller who withdraws while the retry is opening its session records the retry as cancelled and stops the ladder',
  { skip: chromeSkipReason() },
  async (context) => {
    const proxy = await authenticatingProxy()
    context.after(() => proxy.close())
    const origin = await startOriginServer(proxy.proxyLocalPorts)
    context.after(() => origin.close())
    const reader = await startReaderServer()
    context.after(() => reader.close())
    const controller = new AbortController()
    const fixture = await createFixture(context, {
      chrome: true,
      readerEndpoint: `${reader.url}/reader`,
      settings: readerEnabledSettings(),
      proxyPort: {
        // The caller withdraws exactly while the session is being opened, which
        // is the one window the browser rung's own guards cannot see.
        open: async () => {
          controller.abort()
          throw new Error('The proxy session open was interrupted.')
        },
      },
    })
    context.after(() => fixture.closeBrowser())

    const result = await fixture.service.execute(
      fixture.requestContext,
      'call-withdrawn-during-open',
      {
        action: 'acquire',
        url: `${origin.url}/insufficient-then-denied-until-proxied`,
        allowManagedReaderFallback: true,
      },
      controller.signal,
    )

    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.error?.code, 'cancelled')
    assert.deepEqual(
      result.attempts?.map((attempt) => `${attempt.method}:${attempt.outcome}`),
      [
        'direct-http:insufficient',
        'managed-browser:access-denied',
        'managed-browser-proxied:cancelled',
      ],
      JSON.stringify(result),
    )
    assert.equal(reader.calls, 0, 'a withdrawn caller never starts the reader rung')

    const laterUrlOnSameHost = await fixture.service.execute(
      fixture.requestContext,
      'call-later',
      { action: 'acquire', url: `${origin.url}/plain`, allowBrowserFallback: false },
    )
    assert.equal(laterUrlOnSameHost.ok, true, 'a cancelled call never bans its host')
  },
)

test(
  'a caller who withdraws while the proxied page is loading ends the call and leaves no page behind',
  { skip: chromeSkipReason() },
  async (context) => {
    const proxy = await authenticatingProxy()
    context.after(() => proxy.close())
    const origin = await startOriginServer(proxy.proxyLocalPorts)
    context.after(() => origin.close())
    const reader = await startReaderServer()
    context.after(() => reader.close())
    const controller = new AbortController()
    const fixture = await createFixture(context, {
      chrome: true,
      readerEndpoint: `${reader.url}/reader`,
      settings: readerEnabledSettings(),
      proxyPort: webshareProxyPort(proxy.port),
    })
    context.after(() => fixture.closeBrowser())

    // The origin announces the moment the proxied read reaches it and then
    // answers nothing, so the abort lands during navigation rather than at a
    // guessed delay. The open action owns the withdrawal from there: it drops
    // its page, closes the tab, and only then reports back, so the result below
    // arrives after the cleanup rather than racing it.
    const pending = fixture.service.execute(
      fixture.requestContext,
      'call-withdrawn-during-navigation',
      {
        action: 'acquire',
        url: `${origin.url}/insufficient-then-denied-then-hangs-when-proxied`,
        allowManagedReaderFallback: true,
      },
      controller.signal,
    )
    await origin.proxiedRequestReceived
    controller.abort()
    const result = await pending

    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.error?.code, 'cancelled')
    assert.deepEqual(
      result.attempts?.map((attempt) => `${attempt.method}:${attempt.outcome}`),
      [
        'direct-http:insufficient',
        'managed-browser:access-denied',
        'managed-browser-proxied:cancelled',
      ],
      JSON.stringify(result),
    )
    assert.equal(reader.calls, 0, 'a withdrawn caller never starts the reader rung')

    // The abandoned page is the leak this journey exists for. The caller never
    // learned its id, so nothing outside the manager can reclaim it, and this
    // runs before any release or teardown that would hide it. The origin
    // already announced the held read, so the page provably existed: an
    // implementation that does not reclaim it reports one here rather than
    // leaving the test waiting for a teardown that never comes.
    assert.ok(fixture.browserManager)
    assert.equal(
      (await fixture.browserManager.status()).pageCount,
      0,
      'no page outlives the acquisition that opened it',
    )
    // And the reclaimed page is a real one: the origin sees the held read torn
    // down, which only happens when Chrome actually closed the tab.
    await origin.proxiedRequestAborted

    const laterUrlOnSameHost = await fixture.service.execute(
      fixture.requestContext,
      'call-later',
      { action: 'acquire', url: `${origin.url}/plain`, allowBrowserFallback: false },
    )
    assert.equal(laterUrlOnSameHost.ok, true, 'a cancelled call never bans its host')
  },
)

/** A loopback port that is free, so a connection to it is refused rather than served. */
async function unusedLoopbackPort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())))
  return port
}
