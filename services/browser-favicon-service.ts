import { promises as dns } from 'node:dns'
import { isIP } from 'node:net'

import { Agent, fetch } from 'undici'

import { isPublicWebHost } from '../domains/browser/browser-policy.js'

/**
 * Site icons for research results, fetched on a renderer's behalf.
 *
 * The renderer cannot load these itself: the desktop CSP allows images only
 * from 'self', data: and blob:, while the API lives on a loopback origin. So
 * the app fetches the icon and the renderer turns it into a blob.
 *
 * That makes this the one place the app fetches a third-party asset because a
 * renderer asked it to, so authorization is deliberately narrow. The requested
 * origin must be one the session actually visited, compared exactly after
 * normalization. `www` stays part of the identity, and so do the scheme and the
 * effective port. The fetch target is always `<origin>/favicon.ico`; the caller
 * never supplies a path, and a redirect may not leave that origin.
 */
export interface FaviconResponse {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: Uint8Array
}

export type FaviconFetch = (
  url: string,
  signal: AbortSignal,
) => Promise<FaviconResponse>

export interface FaviconIcon {
  readonly data: Uint8Array
  readonly mimeType: string
}

export interface ResolvedHostAddress {
  readonly address: string
  readonly family: number
}

/**
 * Just the resolver call this service makes.
 *
 * Narrower than `typeof dns.lookup`, whose overloads describe calls this never
 * makes and which a test double would have to satisfy for no benefit.
 */
export type HostLookup = (
  hostname: string,
  options: { all: true; verbatim: boolean },
) => Promise<readonly ResolvedHostAddress[]>

export interface BrowserFaviconServiceOptions {
  /** Every URL this session recorded, the sole source of authorized origins. */
  readonly listSessionUrls: (sessionId: string) => Promise<readonly string[]>
  readonly fetchIcon?: FaviconFetch
  readonly now?: () => number
  readonly allowHttpLocalhost?: boolean
  readonly cacheLimit?: number
  readonly timeoutMs?: number
  readonly maximumBytes?: number
  readonly lookup?: HostLookup
}

const MAX_REDIRECTS = 3
const DEFAULT_TIMEOUT_MS = 3_000
const DEFAULT_MAXIMUM_BYTES = 64 * 1_024
const DEFAULT_CACHE_LIMIT = 200
const HIT_TTL_MS = 24 * 60 * 60 * 1_000
/** A miss is cached far more briefly, so a site that adds an icon is picked up the same day. */
const MISS_TTL_MS = 60 * 60 * 1_000

interface CacheEntry {
  readonly icon: FaviconIcon | null
  readonly expiresAt: number
}

interface InFlightFetch {
  promise: Promise<FaviconIcon | null>
  readonly controller: AbortController
  waiters: number
}

/** Raster types only. SVG is an active document format and is not worth the risk. */
const ALLOWED_ICON_TYPES = new Set([
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/png',
  'image/gif',
  'image/jpeg',
  'image/webp',
])

export class BrowserFaviconService {
  private readonly fetchIcon: FaviconFetch
  /** Insertion-ordered, so the first key is always the least recently read. */
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, InFlightFetch>()

  constructor(private readonly options: BrowserFaviconServiceOptions) {
    this.fetchIcon = options.fetchIcon ?? createNetworkFaviconFetch(options)
  }

  async read(
    sessionId: string,
    requestedOrigin: string,
    signal?: AbortSignal,
  ): Promise<FaviconIcon | null> {
    const origin = normalizeOrigin(requestedOrigin)
    if (!origin) return null
    // Authorization runs before anything else, including the cache, so one
    // session can never be served an origin only another session visited.
    if (!(await this.isAuthorized(sessionId, origin))) return null
    if (!this.isFetchableOrigin(origin)) return null
    return await this.load(origin, signal)
  }

  private async load(
    origin: string,
    signal?: AbortSignal,
  ): Promise<FaviconIcon | null> {
    const cached = this.readCache(origin)
    if (cached) return cached.icon

    const entry = this.inFlight.get(origin) ?? this.startFetch(origin)
    entry.waiters += 1
    try {
      return await settleWithAbort(entry.promise, signal)
    } finally {
      entry.waiters -= 1
      // Only the last caller to leave may cancel the shared request. Handing a
      // caller's own signal to the fetch would let the first to walk away
      // cancel an icon everyone else is still waiting for.
      if (entry.waiters === 0 && this.inFlight.get(origin) === entry) {
        entry.controller.abort()
      }
    }
  }

  private startFetch(origin: string): InFlightFetch {
    const controller = new AbortController()
    const entry: InFlightFetch = {
      controller,
      waiters: 0,
      promise: Promise.resolve(null),
    }
    // Always the shared controller, never a caller's signal.
    entry.promise = this.fetchChain(origin, controller.signal)
      .then((icon) => {
        this.writeCache(origin, icon)
        return icon
      })
      .catch(() => null)
      .finally(() => {
        if (this.inFlight.get(origin) === entry) this.inFlight.delete(origin)
      })
    this.inFlight.set(origin, entry)
    return entry
  }

  private readCache(origin: string): CacheEntry | null {
    const entry = this.cache.get(origin)
    if (!entry) return null
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(origin)
      return null
    }
    // Re-insert so the freshly read key moves to the young end of the map.
    this.cache.delete(origin)
    this.cache.set(origin, entry)
    return entry
  }

  private writeCache(origin: string, icon: FaviconIcon | null): void {
    const limit = this.options.cacheLimit ?? DEFAULT_CACHE_LIMIT
    this.cache.delete(origin)
    if (this.cache.size >= limit) {
      const oldest = this.cache.keys().next()
      if (!oldest.done) this.cache.delete(oldest.value)
    }
    this.cache.set(origin, {
      icon,
      expiresAt: this.now() + (icon ? HIT_TTL_MS : MISS_TTL_MS),
    })
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private async isAuthorized(sessionId: string, origin: string): Promise<boolean> {
    const urls = await this.options.listSessionUrls(sessionId)
    for (const url of urls) {
      if (normalizeOrigin(url) === origin) return true
    }
    return false
  }

  private isFetchableOrigin(origin: string): boolean {
    const url = new URL(origin)
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    if (isPublicWebHost(hostname)) return true
    return isAllowedTestLocalhost(url, this.options.allowHttpLocalhost)
  }

  private async fetchChain(
    origin: string,
    signal?: AbortSignal,
  ): Promise<FaviconIcon | null> {
    let target = `${origin}/favicon.ico`
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await this.fetchIcon(target, signal ?? neverAborts())
      const location = response.headers.location ?? response.headers.Location
      if (isRedirect(response.status) && location) {
        const next = resolveRedirect(target, location)
        // A hop off this origin would escape the membership check that is this
        // route's whole authorization model, so it is refused rather than
        // re-authorized against a host the session may never have visited.
        if (!next || normalizeOrigin(next) !== origin) return null
        target = next
        continue
      }
      if (response.status !== 200) return null
      const mimeType = mediaType(response.headers['content-type'] ?? response.headers['Content-Type'])
      if (!mimeType || !ALLOWED_ICON_TYPES.has(mimeType)) return null
      if (response.body.byteLength === 0) return null
      return { data: response.body, mimeType }
    }
    return null
  }
}

/**
 * A normalized origin, or null when the value cannot be one.
 *
 * `URL.origin` already lowercases the host and drops a default port, but it
 * keeps a trailing dot and hides credentials rather than rejecting them, so
 * both are handled here. Two spellings of one origin must normalize to the same
 * string on both sides of the comparison or the exact-match rule is worthless.
 */
export function normalizeOrigin(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  // `URL` already lowercases the hostname for http(s), but it keeps a trailing
  // dot, which would make two spellings of one origin compare as different.
  const hostname = url.hostname.replace(/\.$/, '')
  if (!hostname) return null
  try {
    return new URL(`${url.protocol}//${hostname}${url.port ? `:${url.port}` : ''}`).origin
  } catch {
    return null
  }
}

/**
 * Wait for a shared result, but stop waiting if this caller goes away.
 *
 * The shared promise is never cancelled here — only this caller's interest in
 * it ends, resolving to no icon.
 */
function settleWithAbort(
  promise: Promise<FaviconIcon | null>,
  signal?: AbortSignal,
): Promise<FaviconIcon | null> {
  if (!signal) return promise
  if (signal.aborted) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(null)
    signal.addEventListener('abort', onAbort, { once: true })
    // Deliberately not awaited: this settles the surrounding promise. Both
    // outcomes are handled, so the derived promise cannot reject unobserved.
    void promise.then(
      (icon) => {
        signal.removeEventListener('abort', onAbort)
        resolve(icon)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 ||
    status === 307 || status === 308
}

function resolveRedirect(from: string, location: string): string | null {
  try {
    return new URL(location, from).toString()
  } catch {
    return null
  }
}

function mediaType(header: string | undefined): string | null {
  if (!header) return null
  return header.split(';')[0]?.trim().toLowerCase() || null
}

function isAllowedTestLocalhost(url: URL, enabled: boolean | undefined): boolean {
  return Boolean(
    enabled &&
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname),
  )
}

function neverAborts(): AbortSignal {
  return new AbortController().signal
}

/**
 * The real network path: resolve first, refuse a private or mixed address set,
 * then pin the connection to the addresses that were checked so a second
 * lookup cannot answer differently.
 */
function createNetworkFaviconFetch(
  options: BrowserFaviconServiceOptions,
): FaviconFetch {
  const lookup = options.lookup ?? dns.lookup
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES
  return async (target, signal) => {
    const url = new URL(target)
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    // The installed `dns.lookup` typing accepts no signal, so resolution cannot
    // be cancelled from the inside. Bound it from the outside instead, or a
    // stalled resolver would hold the caller past every other budget here.
    const addresses = await withDeadline(
      resolveAllowedAddresses(url, host, lookup, options.allowHttpLocalhost),
      timeoutMs,
      'Timed out resolving the icon host.',
    )
    const dispatcher = createPinnedAgent(url.hostname, addresses, timeoutMs)
    let primaryError: unknown
    try {
      const response = await fetch(target, {
        dispatcher,
        method: 'GET',
        redirect: 'manual',
        signal,
      })
      const headers: Record<string, string> = {}
      for (const [key, value] of response.headers.entries()) headers[key] = value
      return {
        status: response.status,
        headers,
        body: await readBoundedBody(response.body, maximumBytes),
      }
    } catch (error) {
      primaryError = error
      throw error
    } finally {
      // Closing the pool must not mask why the request itself failed, and must
      // not pass silently when the request succeeded.
      try {
        await dispatcher.close()
      } catch (closeError) {
        if (primaryError === undefined) throw closeError
      }
    }
  }
}

/** Reject a promise that has no cancellation of its own once its budget is spent. */
async function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function resolveAllowedAddresses(
  url: URL,
  host: string,
  lookup: HostLookup,
  allowHttpLocalhost: boolean | undefined,
): Promise<readonly { address: string; family: number }[]> {
  if (isAllowedTestLocalhost(url, allowHttpLocalhost)) {
    if (isIP(host)) return [{ address: host, family: isIP(host) }]
    const answers = await lookup(host, { all: true, verbatim: true })
    if (answers.length === 0) throw new Error('The icon host did not resolve.')
    return answers
  }
  if (isIP(host)) {
    if (!isPublicWebHost(host)) {
      throw new Error('The icon host resolved to a private or reserved address.')
    }
    return [{ address: host, family: isIP(host) }]
  }
  const answers = await lookup(host, { all: true, verbatim: true })
  if (
    answers.length === 0 ||
    answers.some((answer) => !isPublicWebHost(answer.address))
  ) {
    throw new Error('The icon host resolved to a private, reserved, or mixed address set.')
  }
  return answers
}

function createPinnedAgent(
  hostname: string,
  addresses: readonly { address: string; family: number }[],
  timeoutMs: number,
): Agent {
  return new Agent({
    connect: {
      // undici 7 asks for `all`, so the callback takes the whole address list.
      // Handing back one address with the three-argument form fails with
      // "Invalid IP address: undefined". Verified against undici 7.29.0.
      lookup: (_hostname, _options, callback) => {
        callback(null, addresses.map((entry) => ({
          address: entry.address,
          family: entry.family,
        })))
      },
      servername: hostname,
      // Without this a host that accepts nothing holds the socket open well
      // past the header and body budgets, which only start once a connection
      // exists.
      timeout: timeoutMs,
    },
    connectTimeout: timeoutMs,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  })
}

/**
 * The body of an undici response.
 *
 * Taken from the installed client's own return type rather than asserted, so a
 * future undici that streams something other than bytes fails to compile here
 * instead of mis-reading at runtime.
 */
type UndiciResponseBody = Awaited<ReturnType<typeof fetch>>['body']

/** A chunk is usable only if it really is bytes, whatever the stream claims. */
function isByteChunk(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array
}

async function readBoundedBody(
  body: UndiciResponseBody,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!isByteChunk(value)) continue
      total += value.byteLength
      if (total > maximumBytes) throw new Error('The icon exceeded its size budget.')
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}
