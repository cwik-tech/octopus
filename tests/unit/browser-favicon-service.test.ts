import assert from 'node:assert/strict'
import * as http from 'node:http'
import test from 'node:test'

import {
  BrowserFaviconService,
  type FaviconResponse,
} from '../../services/browser-favicon-service.js'

/**
 * The favicon route is the only place the app fetches a third-party asset on a
 * renderer's behalf, so its authorization is deliberately narrow: the requested
 * origin must be one this session actually visited. These tests pin that rule
 * and the transport policy that backs it.
 */

interface FetchCall {
  readonly url: string
}

/**
 * Let every already-queued microtask run.
 *
 * `setImmediate` fires after the microtask queue drains, so both concurrent
 * reads are guaranteed to have registered before the test acts. This is
 * ordering, not elapsed time — nothing here waits on the clock.
 */
function flushPendingWork(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve) })
}

/** A promise plus the handle that settles it, without a definite-assignment assertion. */
function createGate(): { gate: Promise<void>; open: () => void } {
  let open: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { open = resolve })
  // A Promise executor runs synchronously, so this is already assigned.
  if (!open) throw new Error('Gate was not initialized')
  return { gate, open }
}

function originAt(origins: readonly string[], index: number): string {
  const origin = origins[index]
  if (origin === undefined) throw new Error(`No test origin at index ${index}`)
  return origin
}

function serviceWith(params: {
  origins: readonly string[]
  fetchImpl?: (url: string, signal: AbortSignal) => Promise<{
    status: number
    headers: Record<string, string>
    body: Uint8Array
  }>
  calls?: FetchCall[]
  now?: () => number
  allowHttpLocalhost?: boolean
}): BrowserFaviconService {
  return new BrowserFaviconService({
    listSessionUrls: async () => params.origins.map((origin) => `${origin}/page`),
    fetchIcon: async (url, signal) => {
      params.calls?.push({ url })
      return params.fetchImpl
        ? await params.fetchImpl(url, signal)
        : {
            status: 200,
            headers: { 'content-type': 'image/png' },
            body: new Uint8Array([1, 2, 3]),
          }
    },
    ...(params.now ? { now: params.now } : {}),
    ...(params.allowHttpLocalhost !== undefined
      ? { allowHttpLocalhost: params.allowHttpLocalhost }
      : {}),
  })
}

test('favicon service refuses an origin the session never visited', async () => {
  const calls: FetchCall[] = []
  const service = serviceWith({ origins: ['https://visited.example'], calls })

  assert.equal(await service.read('session-1', 'https://other.example'), null)
  assert.deepEqual(calls, [])
})

test('favicon service keeps www distinct from the bare host', async () => {
  const service = serviceWith({ origins: ['https://www.example.com'] })

  assert.notEqual(await service.read('session-1', 'https://www.example.com'), null)
  assert.equal(await service.read('session-1', 'https://example.com'), null)
})

test('favicon service denies a different port and a different scheme', async () => {
  const service = serviceWith({ origins: ['https://example.com:8443'] })

  assert.notEqual(await service.read('session-1', 'https://example.com:8443'), null)
  assert.equal(await service.read('session-1', 'https://example.com'), null)
  assert.equal(await service.read('session-1', 'https://example.com:9443'), null)
  assert.equal(await service.read('session-1', 'http://example.com:8443'), null)
})

test('favicon service normalizes case, default ports, and one trailing dot', async () => {
  const service = serviceWith({ origins: ['https://example.com'] })

  assert.notEqual(await service.read('session-1', 'https://EXAMPLE.com'), null)
  assert.notEqual(await service.read('session-1', 'https://example.com:443'), null)
  assert.notEqual(await service.read('session-1', 'https://example.com.'), null)
})

test('favicon service rejects credentials and non-http origins', async () => {
  const service = serviceWith({ origins: ['https://example.com'] })

  assert.equal(await service.read('session-1', 'https://user:pw@example.com'), null)
  assert.equal(await service.read('session-1', 'ftp://example.com'), null)
  assert.equal(await service.read('session-1', 'not a url'), null)
})

test('favicon service refuses a private or reserved host', async () => {
  const calls: FetchCall[] = []
  const service = serviceWith({ origins: ['http://127.0.0.1:9000'], calls })

  assert.equal(await service.read('session-1', 'http://127.0.0.1:9000'), null)
  assert.deepEqual(calls, [])
})

test('favicon service allows loopback only under the test allowance', async () => {
  const service = serviceWith({
    origins: ['http://localhost:9000'],
    allowHttpLocalhost: true,
  })

  assert.notEqual(await service.read('session-1', 'http://localhost:9000'), null)
})

test('favicon service fetches favicon.ico from the exact authorized origin', async () => {
  const calls: FetchCall[] = []
  const service = serviceWith({ origins: ['https://example.com:8443'], calls })

  await service.read('session-1', 'https://example.com:8443')

  assert.deepEqual(calls.map((call) => call.url), [
    'https://example.com:8443/favicon.ico',
  ])
})

test('favicon service rejects a non-image response', async () => {
  const service = serviceWith({
    origins: ['https://example.com'],
    fetchImpl: async () => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: new Uint8Array([1]),
    }),
  })

  assert.equal(await service.read('session-1', 'https://example.com'), null)
})

test('favicon service rejects an svg icon', async () => {
  const service = serviceWith({
    origins: ['https://example.com'],
    fetchImpl: async () => ({
      status: 200,
      headers: { 'content-type': 'image/svg+xml' },
      body: new Uint8Array([1]),
    }),
  })

  assert.equal(await service.read('session-1', 'https://example.com'), null)
})

test('favicon service serves a second read inside the TTL without fetching again', async () => {
  const calls: FetchCall[] = []
  let clock = 0
  const service = serviceWith({
    origins: ['https://example.com'],
    calls,
    now: () => clock,
  })

  await service.read('session-1', 'https://example.com')
  await service.read('session-1', 'https://example.com')
  assert.equal(calls.length, 1)

  clock += 25 * 60 * 60 * 1_000
  await service.read('session-1', 'https://example.com')
  assert.equal(calls.length, 2)
})

test('favicon service coalesces concurrent reads, and one waiter aborting leaves the other served', { timeout: 5_000 }, async () => {
  const calls: FetchCall[] = []
  const { gate, open: release } = createGate()
  // The gate is opened before anything is awaited below, so this settles
  // whether or not the service coalesces.
  const service = serviceWith({
    origins: ['https://example.com'],
    calls,
    fetchImpl: async () => {
      await gate
      return {
        status: 200,
        headers: { 'content-type': 'image/png' },
        body: new Uint8Array([7]),
      }
    },
  })

  const abandoned = new AbortController()
  const first = service.read('session-1', 'https://example.com', abandoned.signal)
  const second = service.read('session-1', 'https://example.com')
  await flushPendingWork()

  abandoned.abort()
  release()

  assert.equal(await first, null)
  // The survivor must still get its icon: a shared fetch that took the first
  // caller's signal would have been cancelled out from under this one.
  assert.notEqual(await second, null)
  assert.equal(calls.length, 1)
})

test('favicon service aborts the shared fetch once every waiter has abandoned it', { timeout: 5_000 }, async () => {
  let observed: AbortSignal | undefined
  const service = serviceWith({
    origins: ['https://example.com'],
    // This fake settles only when its signal aborts. Both the current and the
    // intended implementation abort it in the same turn, so the test is
    // deterministic and never waits on the clock.
    fetchImpl: async (_url, signal) => await new Promise<FaviconResponse>((_resolve, reject) => {
      observed = signal
      if (signal.aborted) {
        reject(new Error('aborted'))
        return
      }
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }),
  })

  const only = new AbortController()
  const pending = service.read('session-1', 'https://example.com', only.signal)
  await flushPendingWork()
  only.abort()
  const settled = await pending.catch((error: unknown) => error)

  // The outbound fetch must never take a caller's signal directly, or one
  // caller leaving would cancel a fetch other callers are still waiting on.
  assert.notEqual(observed, only.signal)
  assert.equal(observed?.aborted, true)
  assert.equal(settled, null)
})

test('favicon service evicts the least recently read origin past its cache limit', async () => {
  const calls: FetchCall[] = []
  const origins = Array.from({ length: 201 }, (_, index) => `https://host${index}.example`)
  const service = serviceWith({ origins, calls })

  for (const origin of origins.slice(0, 200)) {
    await service.read('session-1', origin)
  }
  assert.equal(calls.length, 200)

  // Re-read the oldest so it is no longer the least recently used.
  await service.read('session-1', originAt(origins, 0))
  assert.equal(calls.length, 200)

  // Entry 201 evicts host1, the least recently read, not host0.
  await service.read('session-1', originAt(origins, 200))
  assert.equal(calls.length, 201)

  await service.read('session-1', originAt(origins, 0))
  assert.equal(calls.length, 201, 'host0 was refreshed and should still be cached')

  await service.read('session-1', originAt(origins, 1))
  assert.equal(calls.length, 202, 'host1 was the least recently read and should be gone')
})

/**
 * A public hostname is not proof of a public destination.
 *
 * These exercise the real transport with only the resolver replaced, because
 * the address check lives there; an injected `fetchIcon` would skip it. The
 * resolver points at a server this test actually runs, so "refused" is proved
 * by that server never being contacted — not by an unroutable address failing
 * to connect, which would pass whether or not the rule exists.
 */
async function reachabilityProbe(): Promise<{
  origin: (hostname: string) => string
  hits: () => number
  close: () => Promise<void>
}> {
  let hits = 0
  const server = http.createServer((_req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(Buffer.from([1, 2, 3]))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Probe address is unavailable')
  return {
    origin: (hostname) => `http://${hostname}:${address.port}`,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test('favicon service refuses a public hostname that resolves only to a private address', async () => {
  const probe = await reachabilityProbe()
  const origin = probe.origin('intranet.example')
  try {
    const service = new BrowserFaviconService({
      listSessionUrls: async () => [`${origin}/page`],
      // Loopback is reachable from this test, so a bypassed rule would connect.
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    })

    assert.equal(await service.read('session-1', origin), null)
    assert.equal(probe.hits(), 0, 'the private address must never be contacted')
  } finally {
    await probe.close()
  }
})

test('favicon service refuses a mixed public and private address set', async () => {
  const probe = await reachabilityProbe()
  const origin = probe.origin('split.example')
  try {
    const service = new BrowserFaviconService({
      listSessionUrls: async () => [`${origin}/page`],
      // A resolver answering with one internal address alongside a routable one
      // cannot be trusted to hand the same choice to the connection.
      lookup: async () => [
        { address: '127.0.0.1', family: 4 },
        { address: '93.184.216.34', family: 4 },
      ],
    })

    assert.equal(await service.read('session-1', origin), null)
    assert.equal(probe.hits(), 0, 'a mixed answer must not be partially trusted')
  } finally {
    await probe.close()
  }
})

test('favicon service gives up on a resolver that never answers', { timeout: 5_000 }, async () => {
  const { gate: stalled, open: releaseLookup } = createGate()
  const service = new BrowserFaviconService({
    listSessionUrls: async () => ['https://example.com/page'],
    timeoutMs: 20,
    // The installed dns.lookup type accepts no signal, so a stalled resolver
    // can only be bounded from outside. Without that bound this never settles.
    lookup: async () => {
      await stalled
      return [{ address: '93.184.216.34', family: 4 }]
    },
  })

  assert.equal(await service.read('session-1', 'https://example.com'), null)
  releaseLookup()
})

test('favicon service follows a same-origin redirect and refuses a cross-host one', async () => {
  const sameOriginCalls: FetchCall[] = []
  const sameOrigin = serviceWith({
    origins: ['https://example.com'],
    calls: sameOriginCalls,
    fetchImpl: async (url) => (url.endsWith('/favicon.ico')
      ? { status: 302, headers: { location: '/static/icon.png' }, body: new Uint8Array() }
      : { status: 200, headers: { 'content-type': 'image/png' }, body: new Uint8Array([9]) }),
  })
  assert.notEqual(await sameOrigin.read('session-1', 'https://example.com'), null)
  assert.deepEqual(sameOriginCalls.map((call) => call.url), [
    'https://example.com/favicon.ico',
    'https://example.com/static/icon.png',
  ])

  const crossHost = serviceWith({
    origins: ['https://example.com'],
    fetchImpl: async () => ({
      status: 302,
      headers: { location: 'https://cdn.other.example/icon.png' },
      body: new Uint8Array(),
    }),
  })
  assert.equal(await crossHost.read('session-1', 'https://example.com'), null)
})
