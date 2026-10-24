import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import test from 'node:test'

import { SOURCE_OBSERVATION_RECEIPT_VERSION } from '../../domains/acquisition/acquisition-types.js'
import {
  chromeSkipReason,
  createFixture,
  readerEnabledSettings,
  startForwardProxy,
  startOriginServer,
  startReaderServer,
  webshareProxyPort,
} from '../support/research-web-proxy-fixture.js'


test(
  'a denied direct read retries once through the configured proxy, records both attempts, and leaves the host available to later rungs',
  async (context) => {
    const proxy = await startForwardProxy()
    context.after(() => proxy.close())
    const origin = await startOriginServer(proxy.proxyLocalPorts)
    context.after(() => origin.close())
    const fixture = await createFixture(context, {
      proxyPort: webshareProxyPort(proxy.port),
    })

    const denied = await fixture.service.execute(
      fixture.requestContext,
      'call-denied',
      { action: 'acquire', url: `${origin.url}/denied-unless-proxied`, allowBrowserFallback: false },
    )

    assert.equal(denied.ok, true, JSON.stringify(denied))
    assert.equal(denied.method, 'direct-http-proxied')
    assert.deepEqual(
      denied.attempts?.map((attempt) => attempt.method),
      ['direct-http', 'direct-http-proxied'],
    )
    assert.deepEqual(
      denied.attempts?.map((attempt) => attempt.outcome),
      ['access-denied', 'usable'],
    )
    assert.equal(origin.directRequests.length, 1)
    assert.deepEqual(origin.proxiedRequests, ['/denied-unless-proxied'])
    assert.equal(proxy.connections, 1, 'exactly one tunnel, so exactly one retry')
    assert.deepEqual(
      proxy.tunnelledAuthorities,
      [new URL(origin.url).host],
    )

    const laterUrlOnSameHost = await fixture.service.execute(
      fixture.requestContext,
      'call-later',
      { action: 'acquire', url: `${origin.url}/plain`, allowBrowserFallback: false },
    )

    assert.equal(laterUrlOnSameHost.ok, true, JSON.stringify(laterUrlOnSameHost))
    assert.equal(laterUrlOnSameHost.method, 'direct-http')
    assert.equal(laterUrlOnSameHost.error, undefined)
  },
)

// ---------------------------------------------------------------------------
// Loops 16-17 — the proxied method reaches every surface that actually records
// it, and the engine classifies the recovered trail correctly.
// ---------------------------------------------------------------------------

test(
  'a proxied recovery is recorded as direct-http-proxied in the output, the current receipt, the journal, and the engine event',
  async (context) => {
    const proxy = await startForwardProxy()
    context.after(() => proxy.close())
    const origin = await startOriginServer(proxy.proxyLocalPorts)
    context.after(() => origin.close())
    const fixture = await createFixture(context, {
      proxyPort: webshareProxyPort(proxy.port),
    })

    const result = await fixture.service.execute(
      fixture.requestContext,
      'call-recovered',
      { action: 'acquire', url: `${origin.url}/denied-unless-proxied`, allowBrowserFallback: false },
    )

    // 1. The service output.
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.method, 'direct-http-proxied')
    assert.ok(result.observationReceipt)

    // 2. The observation receipt on disk.
    const receipt = JSON.parse(
      await fs.readFile(
        path.join(fixture.assignmentPath, result.observationReceipt.relativePath),
        'utf8',
      ),
    ) as { schemaVersion: number; method: string; quality: string }
    assert.equal(receipt.method, 'direct-http-proxied')
    assert.equal(
      receipt.schemaVersion,
      SOURCE_OBSERVATION_RECEIPT_VERSION,
      'a new receipt is written at the current schema version',
    )
    assert.equal(receipt.quality, 'usable')

    // 3. The persisted acquisition journal records both attempts by method.
    const journal = JSON.parse(
      await fs.readFile(
        path.join(fixture.workspacePath, 'sessions', fixture.requestContext.sessionId, 'research-acquisition.json'),
        'utf8',
      ),
    ) as Array<{
      toolCallId?: string
      attempts?: Array<{ method?: string; outcome?: string }>
    }>
    const journalled = journal.find(
      (record) => record.toolCallId === 'call-recovered',
    )
    assert.ok(journalled, JSON.stringify(journal))
    assert.deepEqual(
      journalled.attempts?.map((attempt) => attempt.method),
      ['direct-http', 'direct-http-proxied'],
    )
    assert.deepEqual(
      journalled.attempts?.map((attempt) => attempt.outcome),
      ['access-denied', 'usable'],
    )

    // 4. The engine event.
    const events = (await fs.readFile(
      path.join(fixture.assignmentPath, 'logs', 'engine-events.jsonl'),
      'utf8',
    ))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
      .filter((event) => event.type === 'research.acquisition.completed')
    const event = events.find((entry) => entry.payload.tool_call_id === 'call-recovered')
    assert.ok(event, JSON.stringify(events))
    assert.equal(event.payload.usable, true)
    assert.deepEqual(
      event.payload.attempt_methods,
      ['direct-http', 'direct-http-proxied'],
      'the engine event names which transport produced the evidence',
    )
    assert.deepEqual(event.payload.attempt_outcomes, ['access-denied', 'usable'])
    // The classification logic is unchanged and already calls this recovered.
    assert.equal(event.payload.issue_kind, 'recovered')
  },
)

// ---------------------------------------------------------------------------
// Loops 3-7a — the enhanced ladder, reached only through the trigger.
// ---------------------------------------------------------------------------

test(
  'a proxied denial hands the read to the managed browser and does not ban the host on the way',
  { skip: chromeSkipReason() },
  async (context) => {
    const proxy = await startForwardProxy()
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
      'call-denied-until-chrome',
      { action: 'acquire', url: `${origin.url}/denied-until-chrome` },
    )

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.method, 'managed-browser')
    assert.deepEqual(
      result.attempts?.map((attempt) => attempt.method),
      ['direct-http', 'direct-http-proxied', 'managed-browser'],
    )
    assert.equal(proxy.connections, 1, 'the retry runs at most once')

    const sameHostLater = await fixture.service.execute(
      fixture.requestContext,
      'call-same-host',
      { action: 'acquire', url: `${origin.url}/plain`, allowBrowserFallback: false },
    )
    assert.equal(sameHostLater.ok, true, 'a recovered read never bans its host')
  },
)

test(
  'a terminal browser result on the enhanced path still reaches an explicitly requested managed reader',
  { skip: chromeSkipReason() },
  async (context) => {
    const proxy = await startForwardProxy()
    context.after(() => proxy.close())
    const origin = await startOriginServer(proxy.proxyLocalPorts)
    context.after(() => origin.close())
    const reader = await startReaderServer()
    context.after(() => reader.close())
    const fixture = await createFixture(context, {
      chrome: true,
      proxyPort: webshareProxyPort(proxy.port),
      readerEndpoint: `${reader.url}/reader`,
      settings: readerEnabledSettings(),
    })
    context.after(() => fixture.closeBrowser())

    const result = await fixture.service.execute(
      fixture.requestContext,
      'call-reader-after-browser',
      {
        action: 'acquire',
        url: `${origin.url}/denied-then-chrome-404`,
        allowManagedReaderFallback: true,
      },
    )

    assert.equal(reader.calls, 1, 'the reader rung runs behind a terminal browser')
    assert.deepEqual(
      result.attempts?.map((attempt) => attempt.method),
      ['direct-http', 'direct-http-proxied', 'managed-browser', 'managed-reader'],
      JSON.stringify(result),
    )
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.method, 'managed-reader')
  },
)

test(
  'with no reader requested the browser failure is final and bans the host exactly once',
  { skip: chromeSkipReason() },
  async (context) => {
    const proxy = await startForwardProxy()
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
      { action: 'acquire', url: `${origin.url}/denied-everywhere` },
    )

    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'access_denied')
    // The browser denial is host-scoped, so it now earns one proxied browser
    // retry before the ladder gives up. The retry is denied too, which is what
    // keeps the ban.
    assert.deepEqual(
      result.attempts?.map((attempt) => attempt.method),
      ['direct-http', 'direct-http-proxied', 'managed-browser', 'managed-browser-proxied'],
      JSON.stringify(result),
    )

    const sameHostLater = await fixture.service.execute(
      fixture.requestContext,
      'call-same-host',
      { action: 'acquire', url: `${origin.url}/plain`, allowBrowserFallback: false },
    )
    assert.equal(sameHostLater.error?.code, 'access_denied')
  },
)

test(
  'on the enhanced path a terminal browser not-found leaves the host reachable',
  { skip: chromeSkipReason() },
  async (context) => {
    const proxy = await startForwardProxy()
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
      'call-chrome-404',
      { action: 'acquire', url: `${origin.url}/denied-then-chrome-404` },
    )
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'not_found')

    const sameHostLater = await fixture.service.execute(
      fixture.requestContext,
      'call-same-host',
      { action: 'acquire', url: `${origin.url}/plain`, allowBrowserFallback: false },
    )
    assert.equal(
      sameHostLater.ok,
      true,
      'a missing page is about the URL, not the host',
    )
  },
)

test(
  'when the managed reader is the last rung its host-scoped failure bans the host',
  { skip: chromeSkipReason() },
  async (context) => {
    const proxy = await startForwardProxy()
    context.after(() => proxy.close())
    const origin = await startOriginServer(proxy.proxyLocalPorts)
    context.after(() => origin.close())
    const reader = await startReaderServer({ denyAccess: true })
    context.after(() => reader.close())
    const fixture = await createFixture(context, {
      chrome: true,
      proxyPort: webshareProxyPort(proxy.port),
      readerEndpoint: `${reader.url}/reader`,
      settings: readerEnabledSettings(),
    })
    context.after(() => fixture.closeBrowser())

    const result = await fixture.service.execute(
      fixture.requestContext,
      'call-reader-denied',
      {
        action: 'acquire',
        url: `${origin.url}/denied-everywhere`,
        allowManagedReaderFallback: true,
      },
    )

    assert.equal(result.ok, false)
    assert.deepEqual(
      result.attempts?.map((attempt) => attempt.method),
      [
        'direct-http',
        'direct-http-proxied',
        'managed-browser',
        'managed-browser-proxied',
        'managed-reader',
      ],
      JSON.stringify(result),
    )
    assert.equal(result.attempts?.at(-1)?.outcome, 'access-denied')

    const sameHostLater = await fixture.service.execute(
      fixture.requestContext,
      'call-same-host',
      { action: 'acquire', url: `${origin.url}/plain`, allowBrowserFallback: false },
    )
    assert.equal(
      sameHostLater.error?.code,
      'access_denied',
      'the last attempted rung decides the lane ban',
    )
  },
)

// ---------------------------------------------------------------------------
// Cancellation and an unusable proxy with no fallback left. A cancelled call
// must stop the ladder; an unusable proxy must decide its own failure.
// ---------------------------------------------------------------------------

test(
  'aborting while the proxy session is opening cancels the call instead of falling through the ladder',
  { skip: chromeSkipReason() },
  async (context) => {
    const origin = await startOriginServer()
    context.after(() => origin.close())
    const reader = await startReaderServer()
    context.after(() => reader.close())
    const controller = new AbortController()
    const fixture = await createFixture(context, {
      chrome: true,
      readerEndpoint: `${reader.url}/reader`,
      settings: readerEnabledSettings(),
      proxyPort: {
        open: (signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError')))
            controller.abort()
          }),
      },
    })
    context.after(() => fixture.closeBrowser())

    const result = await fixture.service.execute(
      fixture.requestContext,
      'call-abort-open',
      {
        action: 'acquire',
        url: `${origin.url}/denied-unless-proxied`,
        allowManagedReaderFallback: true,
      },
      controller.signal,
    )

    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'cancelled', JSON.stringify(result))
    assert.equal(
      result.attempts?.filter((attempt) => attempt.method === 'managed-browser').length,
      0,
      'a cancelled call must not start the browser rung',
    )
    assert.equal(reader.calls, 0, 'a cancelled call must not start the reader rung')
    assert.equal(
      result.attempts?.at(-1)?.outcome,
      'cancelled',
      'the proxied attempt is recorded as cancelled, not as a proxy failure',
    )

    const sameHostLater = await fixture.service.execute(
      fixture.requestContext,
      'call-same-host',
      { action: 'acquire', url: `${origin.url}/plain`, allowBrowserFallback: false },
    )
    assert.equal(sameHostLater.ok, true, 'a cancelled call never bans its host')
  },
)

test(
  'aborting during the proxied request cancels the call, closes the session, and stops the ladder',
  { skip: chromeSkipReason() },
  async (context) => {
    const proxy = await startForwardProxy()
    context.after(() => proxy.close())
    const origin = await startOriginServer(proxy.proxyLocalPorts)
    context.after(() => origin.close())
    const reader = await startReaderServer()
    context.after(() => reader.close())
    const controller = new AbortController()
    let opens = 0
    let closes = 0
    const fixture = await createFixture(context, {
      chrome: true,
      readerEndpoint: `${reader.url}/reader`,
      settings: readerEnabledSettings(),
      proxyPort: {
        open: async (signal) => {
          opens += 1
          const session = await webshareProxyPort(proxy.port).open(signal)
          assert.ok(session)
          return {
            dispatcher: session.dispatcher,
            close: async () => {
              closes += 1
              await session.close()
            },
          }
        },
      },
    })
    context.after(() => fixture.closeBrowser())

    // The origin never answers this path, so the abort lands mid-request.
    const pending = fixture.service.execute(
      fixture.requestContext,
      'call-abort-request',
      {
        action: 'acquire',
        url: `${origin.url}/hangs-when-proxied`,
        allowManagedReaderFallback: true,
      },
      controller.signal,
    )
    await origin.proxiedRequestReceived
    controller.abort()
    const result = await pending

    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'cancelled', JSON.stringify(result))
    assert.deepEqual(
      result.attempts?.map((attempt) => attempt.method),
      ['direct-http', 'direct-http-proxied'],
      'a cancelled proxied read must not continue to later rungs',
    )
    assert.equal(result.attempts?.at(-1)?.outcome, 'cancelled')
    assert.equal(reader.calls, 0)
    assert.deepEqual([opens, closes], [1, 1], 'the session is closed on cancellation')

    const sameHostLater = await fixture.service.execute(
      fixture.requestContext,
      'call-same-host',
      { action: 'acquire', url: `${origin.url}/plain`, allowBrowserFallback: false },
    )
    assert.equal(sameHostLater.ok, true, 'a cancelled call never bans its host')
  },
)

test(
  'an unusable proxy with no fallback left returns its own failure and does not ban the host',
  async (context) => {
    const origin = await startOriginServer()
    context.after(() => origin.close())
    const fixture = await createFixture(context, {
      proxyPort: {
        open: () =>
          Promise.reject(
            new Error(
              'Webshare API token validation failed for hunter2 at http://user:hunter2@p.webshare.io:80',
            ),
          ),
      },
    })

    const result = await fixture.service.execute(
      fixture.requestContext,
      'call-open-failed',
      { action: 'acquire', url: `${origin.url}/denied-unless-proxied`, allowBrowserFallback: false },
    )

    assert.equal(result.ok, false)
    assert.deepEqual(
      result.attempts?.map((attempt) => attempt.method),
      ['direct-http', 'direct-http-proxied'],
    )
    assert.equal(result.attempts?.at(-1)?.outcome, 'failed')
    assert.notEqual(
      result.error?.code,
      'access_denied',
      'the last attempted rung decides the returned failure',
    )
    assert.match(String(result.error?.message), /Webshare/u)
    for (const secret of ['hunter2', 'p.webshare.io', 'user:']) {
      assert.doesNotMatch(JSON.stringify(result), new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
    }

    const sameHostLater = await fixture.service.execute(
      fixture.requestContext,
      'call-same-host',
      { action: 'acquire', url: `${origin.url}/plain`, allowBrowserFallback: false },
    )
    assert.equal(
      sameHostLater.ok,
      true,
      'a proxy that could not be opened says nothing about the host',
    )
  },
)

test(
  'aborting immediately before the managed-browser rung ends the call without asking the managed reader',
  { skip: chromeSkipReason() },
  async (context) => {
    const proxy = await startForwardProxy()
    context.after(() => proxy.close())
    let proxiedDenialFlushed = false
    const controller = new AbortController()
    const origin = await startOriginServer(proxy.proxyLocalPorts, {
      onProxiedReadFinished: () => {
        proxiedDenialFlushed = true
      },
    })
    context.after(() => origin.close())
    const reader = await startReaderServer()
    context.after(() => reader.close())
    let opens = 0
    let closes = 0
    // A fixed clock, and the ordering boundary. The ladder stamps each attempt
    // through this call, so the first stamp after the proxied denial has been
    // flushed is the moment between that rung finishing and the browser rung
    // starting. Withdrawing there needs no sleep and races nothing.
    let tick = 0
    const now = (): Date => {
      const stamp = new Date(Date.UTC(2026, 7, 28, 0, 0, 0) + tick * 1_000)
      tick += 1
      if (proxiedDenialFlushed) controller.abort()
      return stamp
    }
    const fixture = await createFixture(context, {
      chrome: true,
      readerEndpoint: `${reader.url}/reader`,
      settings: readerEnabledSettings(),
      now,
      proxyPort: {
        open: async (signal) => {
          opens += 1
          const session = await webshareProxyPort(proxy.port).open(signal)
          assert.ok(session)
          return {
            dispatcher: session.dispatcher,
            close: async () => {
              closes += 1
              await session.close()
            },
          }
        },
      },
    })
    context.after(() => fixture.closeBrowser())

    const result = await fixture.service.execute(
      fixture.requestContext,
      'call-abort-before-browser',
      {
        action: 'acquire',
        url: `${origin.url}/denied-then-abort-before-browser`,
        allowManagedReaderFallback: true,
      },
      controller.signal,
    )

    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'cancelled', JSON.stringify(result))
    // The real BrowserManager receives an already-aborted signal and refuses at
    // its entry guard, so the trail must end there. Asserting only on the
    // reader endpoint would be satisfied by an aborted fetch that never leaves
    // the process, so the trail is what proves the ladder stopped.
    assert.deepEqual(
      result.attempts?.map((attempt) => attempt.method),
      ['direct-http', 'direct-http-proxied', 'managed-browser'],
      JSON.stringify(result),
    )
    assert.equal(result.attempts?.at(-1)?.outcome, 'cancelled')
    assert.equal(
      reader.calls,
      0,
      'a withdrawn caller must not start the managed-reader rung',
    )
    assert.deepEqual([opens, closes], [1, 1], 'the proxy session is still closed')

    const sameHostLater = await fixture.service.execute(
      fixture.requestContext,
      'call-same-host',
      { action: 'acquire', url: `${origin.url}/plain`, allowBrowserFallback: false },
    )
    assert.equal(sameHostLater.ok, true, 'a cancelled call never bans its host')
  },
)

// ---------------------------------------------------------------------------
// Loops 8-13 — the unusable proxy, redaction, redirect revalidation, and the
// session lifetime.
// ---------------------------------------------------------------------------

test(
  'an enabled proxy that cannot be opened records a failed proxied attempt with a redacted reason and keeps going',
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
      { action: 'acquire', url: `${origin.url}/denied-until-chrome` },
    )

    const proxied = result.attempts?.find(
      (attempt) => attempt.method === 'direct-http-proxied',
    )
    assert.ok(proxied, JSON.stringify(result))
    assert.equal(proxied.outcome, 'failed')
    assert.match(String(proxied.reason), /Webshare API token/u)
    for (const secret of ['hunter2', 'p.webshare.io', 'rotate', 'user:']) {
      assert.doesNotMatch(
        JSON.stringify(result),
        new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
        `the attempt trail must not carry ${secret}`,
      )
    }
    assert.equal(result.ok, true, 'the browser rung still runs')
    assert.equal(result.method, 'managed-browser')
  },
)

test(
  'a proxied redirect to a privately resolving host is refused before the proxy is asked to reach it',
  async (context) => {
    const proxy = await startForwardProxy()
    context.after(() => proxy.close())
    const origin = await startOriginServer(proxy.proxyLocalPorts)
    context.after(() => origin.close())
    const fixture = await createFixture(context, {
      proxyPort: webshareProxyPort(proxy.port),
      privateDnsNames: { 'internal.example.com': '10.0.0.7' },
    })

    const result = await fixture.service.execute(
      fixture.requestContext,
      'call-private-redirect',
      {
        action: 'acquire',
        url: `${origin.url}/proxied-redirect-to-private`,
        allowBrowserFallback: false,
      },
    )

    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.error?.code, 'domain_denied', JSON.stringify(result))
    assert.deepEqual(
      result.attempts?.map((attempt) => attempt.method),
      ['direct-http', 'direct-http-proxied'],
    )
    assert.deepEqual(
      proxy.tunnelledAuthorities,
      [new URL(origin.url).host],
      'the privately resolving redirect target is never tunnelled',
    )
  },
)

test(
  'a proxied redirect to an IP literal is refused',
  async (context) => {
    const proxy = await startForwardProxy()
    context.after(() => proxy.close())
    const origin = await startOriginServer(proxy.proxyLocalPorts)
    context.after(() => origin.close())
    const fixture = await createFixture(context, {
      proxyPort: webshareProxyPort(proxy.port),
    })

    const result = await fixture.service.execute(
      fixture.requestContext,
      'call-ip-redirect',
      {
        action: 'acquire',
        url: `${origin.url}/proxied-redirect-to-ip`,
        allowBrowserFallback: false,
      },
    )

    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'domain_denied')
    assert.match(String(result.error?.message), /IP literal/u)
    assert.deepEqual(proxy.tunnelledAuthorities, [new URL(origin.url).host])
  },
)

test(
  'each acquisition opens at most one proxy session and always closes it',
  async (context) => {
    const proxy = await startForwardProxy()
    context.after(() => proxy.close())
    const origin = await startOriginServer(proxy.proxyLocalPorts)
    context.after(() => origin.close())
    let opens = 0
    let closes = 0
    const fixture = await createFixture(context, {
      proxyPort: {
        open: async (signal) => {
          opens += 1
          const session = await webshareProxyPort(proxy.port).open(signal)
          assert.ok(session)
          return {
            dispatcher: session.dispatcher,
            close: async () => {
              closes += 1
              await session.close()
            },
          }
        },
      },
    })

    const recovered = await fixture.service.execute(
      fixture.requestContext,
      'call-success',
      { action: 'acquire', url: `${origin.url}/denied-unless-proxied`, allowBrowserFallback: false },
    )
    assert.equal(recovered.ok, true, JSON.stringify(recovered))
    assert.deepEqual([opens, closes], [1, 1], 'closed after a success')

    const failed = await fixture.service.execute(
      fixture.requestContext,
      'call-failure',
      { action: 'acquire', url: `${origin.url}/denied-everywhere`, allowBrowserFallback: false },
    )
    assert.equal(failed.ok, false)
    assert.deepEqual([opens, closes], [2, 2], 'closed after a failure')

    const controller = new AbortController()
    const cancelled = fixture.service.execute(
      fixture.requestContext,
      'call-cancelled',
      { action: 'acquire', url: `${origin.url}/denied-everywhere`, allowBrowserFallback: false },
      controller.signal,
    )
    controller.abort()
    await cancelled.catch(() => undefined)
    assert.equal(closes, opens, 'closed after a cancellation')
  },
)

// ---------------------------------------------------------------------------
// Loop 1a / 1b / 1c / 7b — the untriggered cases. These pin current behaviour
// and must pass both before and after the enhanced ladder exists.
// ---------------------------------------------------------------------------

test(
  'without a proxy port a host-scoped direct denial still ends the call and bans the host',
  async (context) => {
    const origin = await startOriginServer()
    context.after(() => origin.close())
    const fixture = await createFixture(context, { unusableBrowser: true })

    const denied = await fixture.service.execute(
      fixture.requestContext,
      'call-denied',
      { action: 'acquire', url: `${origin.url}/denied-unless-proxied` },
    )

    assert.equal(denied.ok, false)
    assert.equal(denied.error?.code, 'access_denied')
    assert.deepEqual(denied.attempts?.map((attempt) => attempt.method), ['direct-http'])
    assert.equal(origin.directRequests.length, 1)

    const sameHostLater = await fixture.service.execute(
      fixture.requestContext,
      'call-same-host',
      { action: 'acquire', url: `${origin.url}/plain` },
    )
    assert.equal(sameHostLater.ok, false)
    assert.equal(sameHostLater.error?.code, 'access_denied')
  },
)

test(
  'a proxy port that reports the proxy disabled leaves the direct denial exactly as it is',
  async (context) => {
    const proxy = await startForwardProxy()
    context.after(() => proxy.close())
    const origin = await startOriginServer(proxy.proxyLocalPorts)
    context.after(() => origin.close())
    const fixture = await createFixture(context, {
      unusableBrowser: true,
      proxyPort: { open: async () => undefined },
    })

    const denied = await fixture.service.execute(
      fixture.requestContext,
      'call-denied',
      { action: 'acquire', url: `${origin.url}/denied-unless-proxied` },
    )

    assert.equal(denied.ok, false)
    assert.equal(denied.error?.code, 'access_denied')
    assert.deepEqual(denied.attempts?.map((attempt) => attempt.method), ['direct-http'])
    assert.equal(proxy.connections, 0)

    const sameHostLater = await fixture.service.execute(
      fixture.requestContext,
      'call-same-host',
      { action: 'acquire', url: `${origin.url}/plain` },
    )
    assert.equal(sameHostLater.error?.code, 'access_denied')
  },
)

test(
  'without a proxy a non-terminal direct failure that reaches a terminal browser never reaches the managed reader',
  { skip: chromeSkipReason() },
  async (context) => {
    const origin = await startOriginServer()
    context.after(() => origin.close())
    const reader = await startReaderServer()
    context.after(() => reader.close())
    const fixture = await createFixture(context, {
      chrome: true,
      readerEndpoint: `${reader.url}/reader`,
      settings: readerEnabledSettings(),
    })
    context.after(() => fixture.closeBrowser())

    const result = await fixture.service.execute(
      fixture.requestContext,
      'call-direct-reset-browser-404',
      {
        action: 'acquire',
        url: `${origin.url}/reset-direct-then-404`,
        allowManagedReaderFallback: true,
      },
    )

    assert.deepEqual(
      result.attempts?.map((attempt) => attempt.method),
      ['direct-http', 'managed-browser'],
      JSON.stringify(result),
    )
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'not_found')
    assert.equal(reader.calls, 0, 'the managed reader must not run on the legacy path')

    const sameHostLater = await fixture.service.execute(
      fixture.requestContext,
      'call-same-host',
      { action: 'acquire', url: `${origin.url}/plain` },
    )
    assert.equal(
      sameHostLater.error?.code,
      'not_found',
      'a terminal browser result bans the host on the legacy path, naming its cause',
    )
  },
)

test(
  'a terminal direct result that is not host-scoped never consults the proxy port',
  async (context) => {
    const proxy = await startForwardProxy()
    context.after(() => proxy.close())
    const origin = await startOriginServer(proxy.proxyLocalPorts)
    context.after(() => origin.close())
    let opened = 0
    const fixture = await createFixture(context, {
      unusableBrowser: true,
      proxyPort: {
        open: async (signal) => {
          opened += 1
          return webshareProxyPort(proxy.port).open(signal)
        },
      },
    })

    const missing = await fixture.service.execute(
      fixture.requestContext,
      'call-missing',
      { action: 'acquire', url: `${origin.url}/missing`, allowBrowserFallback: false },
    )

    assert.equal(missing.ok, false)
    assert.equal(missing.error?.code, 'not_found')
    assert.deepEqual(missing.attempts?.map((attempt) => attempt.method), ['direct-http'])
    assert.equal(opened, 0, 'the port is consulted only for a host-scoped denial')
    assert.equal(proxy.connections, 0)

    const sameHostLater = await fixture.service.execute(
      fixture.requestContext,
      'call-same-host',
      { action: 'acquire', url: `${origin.url}/plain`, allowBrowserFallback: false },
    )
    assert.equal(sameHostLater.ok, true, 'a missing page does not ban its host')
  },
)
