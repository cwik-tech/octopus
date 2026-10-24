import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import { promises as dns } from 'node:dns'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

import type { AcquisitionSettingsUpdate } from '../../domains/acquisition/acquisition-settings.js'
import type { WebshareProxyPort } from '../../domains/acquisition/acquisition-proxy.js'
import { MCP_RUNTIME_CONTRACT_VERSION } from '../../domains/mcp/mcp-runtime.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { DirectHttpAcquirer } from '../../domains/acquisition/direct-http-acquirer.js'
import { BrowserManager } from '../../domains/browser/browser-manager.js'
import { resolveBrowserExecutablePath } from '../../domains/browser/browser-executable.js'
import { resolveWebshareProxy } from '../../domains/proxy/webshare-proxy.js'
import { AcquisitionSettingsService } from '../../services/acquisition-settings-service.js'
import { ResearchWebToolService } from '../../services/research-web-tool-service.js'

/**
 * The loopback origin, forward proxy, managed reader and service fixture that
 * the Webshare acquisition-retry suites are built from.
 *
 * It lives here rather than inside one suite because two integration files now
 * drive the same three actors - the direct acquirer, unproxied Chrome, and
 * Chrome behind an authenticating proxy - and a second copy of the origin's
 * routing table would let the two suites disagree about what a fixture path
 * means.
 */

export interface OriginServer {
  readonly url: string
  readonly directRequests: readonly string[]
  readonly proxiedRequests: readonly string[]
  /**
   * Credential-bearing headers the origin was handed, which must stay empty.
   *
   * `Proxy-Authorization` is addressed to the proxy and must stop there, so an
   * origin that sees one is looking at a relay that leaked it.
   */
  readonly credentialHeadersSeen: readonly string[]
  /** Resolves once a proxied request has reached one of the hanging paths. */
  readonly proxiedRequestReceived: Promise<void>
  /**
   * Resolves once unproxied Chrome has reached the hanging path.
   *
   * The read is held open from that moment, so a test can withdraw while the
   * ordinary managed-Chrome attempt is genuinely still in flight.
   */
  readonly chromeRequestReceived: Promise<void>
  /**
   * Resolves once the client tore a held proxied request down.
   *
   * Closing a page cancels the request it was loading, which travels back
   * through the proxy and closes this response. It is therefore an observable
   * completion signal for "the browser released that page", and lets a test
   * wait for cleanup instead of guessing how long it takes.
   */
  readonly proxiedRequestAborted: Promise<void>
  close(): Promise<void>
}

export interface ForwardProxy {
  readonly port: number
  /** The `host:port` authority of each CONNECT tunnel, in order. */
  readonly tunnelledAuthorities: readonly string[]
  /** The absolute-form URL of each plain-HTTP request this proxy forwarded. */
  readonly forwardedUrls: readonly string[]
  /** Local ports of the sockets this proxy opened towards an origin. */
  readonly proxyLocalPorts: ReadonlySet<number>
  /** Tunnels opened plus plain-HTTP requests forwarded. */
  readonly connections: number
  /** How many times the proxy answered `407 Proxy Authentication Required`. */
  readonly challenges: number
  /** Every `Proxy-Authorization` header the proxy accepted, in order. */
  readonly acceptedAuthorizations: readonly string[]
  close(): Promise<void>
}

export function isChrome(request: http.IncomingMessage): boolean {
  return !String(request.headers['user-agent'] ?? '').includes('Pipeline-Deep-Research')
}

export const USABLE_BODY = `<!doctype html><html><head><title>Primary evidence</title></head><body><main>
<h1>Primary evidence</h1><p>${'This page carries enough readable prose to clear the acquisition quality threshold without any browser rendering. '.repeat(6)}</p>
</main></body></html>`

/**
 * A body that clears the quality threshold and names its own vantage point.
 *
 * The proxied and unproxied answers must be distinguishable in the persisted
 * evidence, or a test cannot tell a routed read from a direct one that happened
 * to succeed.
 */
export function usableBodyFrom(vantage: string): string {
  return `<!doctype html><html><head><title>Primary evidence from ${vantage}</title></head><body><main>
<h1>Primary evidence from ${vantage}</h1><p>${'This page carries enough readable prose to clear the acquisition quality threshold without any browser rendering. '.repeat(6)}</p>
</main></body></html>`
}

/**
 * HTML that is well-formed, non-empty, and still too short to be evidence.
 *
 * `evaluateAcquisitionQuality` rejects HTML under 160 normalized characters
 * with no structured representations as `insufficient`, and `insufficient` is
 * deliberately **non-terminal** on all three of its branches
 * (`domains/acquisition/acquisition-quality.ts`). That is what keeps a fixture
 * built on this body out of the already-shipped `direct-http-proxied` rung,
 * whose trigger needs a terminal, host-scoped direct outcome.
 */
export const INSUFFICIENT_BODY =
  '<!doctype html><html><head><title>Notice</title></head><body><main><p>Short notice.</p></main></body></html>'

const DENIED_BODY = '<html><body>Forbidden</body></html>'
const MISSING_BODY =
  '<html><head><title>Missing</title></head><body>No such page.</body></html>'

/** The credentials `webshareProxyPort` presents, for a proxy that demands them. */
export const LOOPBACK_PROXY_USERNAME = 'loopback-user'
export const LOOPBACK_PROXY_PASSWORD = 'loopback-password'

/** One-line HTML answer, so the routing table above reads as a routing table. */
function respond(
  response: http.ServerResponse,
  status: number,
  body: string,
): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  response.end(body)
}

export async function startOriginServer(
  proxyLocalPorts: ReadonlySet<number> = new Set(),
  options: { readonly onProxiedReadFinished?: () => void } = {},
): Promise<OriginServer> {
  const directRequests: string[] = []
  const proxiedRequests: string[] = []
  const credentialHeadersSeen: string[] = []
  const held: http.ServerResponse[] = []
  let announceProxiedRequest = (): void => undefined
  const proxiedRequestReceived = new Promise<void>((resolve) => {
    announceProxiedRequest = resolve
  })
  let announceProxiedAbort = (): void => undefined
  const proxiedRequestAborted = new Promise<void>((resolve) => {
    announceProxiedAbort = resolve
  })
  let announceChromeRequest = (): void => undefined
  const chromeRequestReceived = new Promise<void>((resolve) => {
    announceChromeRequest = resolve
  })
  /** Holds a response open and reports when the client gives up on it. */
  const hold = (response: http.ServerResponse): void => {
    held.push(response)
    response.on('close', () => announceProxiedAbort())
    announceProxiedRequest()
  }
  const server = http.createServer((request, response) => {
    const proxied = proxyLocalPorts.has(request.socket.remotePort ?? -1)
    const url = request.url ?? '/'
    if (proxied) proxiedRequests.push(url)
    else directRequests.push(url)
    for (const header of ['proxy-authorization', 'authorization'] as const) {
      if (request.headers[header] !== undefined) credentialHeadersSeen.push(header)
    }

    // -----------------------------------------------------------------
    // Three-way paths: the direct acquirer, unproxied Chrome, and Chrome
    // behind the proxy each get their own answer.
    //
    // The direct answer is deliberately `insufficient` rather than a denial.
    // A denial there is terminal and host-scoped, which is the trigger for the
    // already-shipped `direct-http-proxied` rung, and that rung would then
    // recover the page without any managed-browser proxying existing at all.
    // `insufficient` fails that trigger on both conjuncts, so only a proxied
    // managed-browser retry can turn these paths into usable evidence.
    // -----------------------------------------------------------------
    if (url.startsWith('/insufficient-then-denied-until-proxied')) {
      if (!isChrome(request)) return respond(response, 200, INSUFFICIENT_BODY)
      if (proxied) return respond(response, 200, usableBodyFrom('the proxy'))
      return respond(response, 403, DENIED_BODY)
    }
    if (url.startsWith('/insufficient-then-denied-everywhere')) {
      if (!isChrome(request)) return respond(response, 200, INSUFFICIENT_BODY)
      return respond(response, 403, DENIED_BODY)
    }
    if (url.startsWith('/insufficient-then-denied-then-missing')) {
      if (!isChrome(request)) return respond(response, 200, INSUFFICIENT_BODY)
      if (proxied) return respond(response, 404, MISSING_BODY)
      return respond(response, 403, DENIED_BODY)
    }
    if (url.startsWith('/insufficient-then-hangs-in-chrome')) {
      if (!isChrome(request)) return respond(response, 200, INSUFFICIENT_BODY)
      if (proxied) {
        // Nothing should ever reach here. Answering usable rather than hanging
        // makes a stray proxied read show up as an attempt in the trail.
        return respond(response, 200, usableBodyFrom('the proxy'))
      }
      held.push(response)
      response.on('close', () => announceProxiedAbort())
      announceChromeRequest()
      return
    }
    if (url.startsWith('/insufficient-then-denied-then-hangs-when-proxied')) {
      if (!isChrome(request)) return respond(response, 200, INSUFFICIENT_BODY)
      if (!proxied) return respond(response, 403, DENIED_BODY)
      // Answer nothing. The caller's abort is what ends this request, and the
      // announcement is what lets a test fire it at exactly this moment
      // instead of guessing at a delay.
      hold(response)
      return
    }
    if (url.startsWith('/insufficient-then-usable-in-chrome')) {
      if (!isChrome(request)) return respond(response, 200, INSUFFICIENT_BODY)
      // A proxied read of this path is the failure the off-state journey is
      // watching for, so it answers with a body the test can name.
      if (proxied) return respond(response, 200, usableBodyFrom('the proxy'))
      return respond(response, 200, usableBodyFrom('the house connection'))
    }
    if (url.startsWith('/denied-then-abort-before-browser')) {
      if (proxied) response.on('finish', () => options.onProxiedReadFinished?.())
      response.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><body>Forbidden</body></html>')
      return
    }
    if (url.startsWith('/hangs-when-proxied')) {
      if (!proxied) {
        response.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
        response.end('<html><body>Forbidden</body></html>')
        return
      }
      // Answer nothing, so the caller's abort is what ends the request.
      hold(response)
      return
    }
    if (url.startsWith('/denied-until-chrome')) {
      if (isChrome(request)) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(USABLE_BODY)
        return
      }
      response.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><body>Forbidden</body></html>')
      return
    }
    if (url.startsWith('/denied-then-chrome-404')) {
      if (isChrome(request)) {
        response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
        response.end('<html><head><title>Missing</title></head><body>No such page.</body></html>')
        return
      }
      response.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><body>Forbidden</body></html>')
      return
    }
    if (url.startsWith('/denied-everywhere')) {
      response.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><body>Forbidden</body></html>')
      return
    }
    if (url.startsWith('/proxied-redirect-to-private')) {
      if (proxied) {
        response.writeHead(302, { location: 'https://internal.example.com/evidence' }).end()
        return
      }
      response.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><body>Forbidden</body></html>')
      return
    }
    if (url.startsWith('/proxied-redirect-to-ip')) {
      if (proxied) {
        response.writeHead(302, { location: 'https://93.184.216.34/evidence' }).end()
        return
      }
      response.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><body>Forbidden</body></html>')
      return
    }
    if (url.startsWith('/reset-direct-then-404')) {
      // The direct acquirer announces itself; Chrome does not. That is the
      // only discriminator this fixture needs, and it is a real one.
      if (String(request.headers['user-agent'] ?? '').includes('Pipeline-Deep-Research')) {
        request.socket.destroy()
        return
      }
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><head><title>Missing</title></head><body>No such page.</body></html>')
      return
    }
    if (url.startsWith('/missing')) {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><head><title>Missing</title></head><body>No such page.</body></html>')
      return
    }
    if (url.startsWith('/denied-unless-proxied')) {
      if (!proxied) {
        response.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
        response.end('<html><body>Forbidden</body></html>')
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(USABLE_BODY)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(USABLE_BODY)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    url: `http://127.0.0.1:${address.port}`,
    directRequests,
    proxiedRequests,
    credentialHeadersSeen,
    proxiedRequestReceived,
    proxiedRequestAborted,
    chromeRequestReceived,
    close: () => shutDown(server, () => {
      for (const response of held) response.destroy()
    }),
  }
}

/**
 * Headers a proxy may pass on to an origin.
 *
 * `Proxy-Authorization` is addressed to the proxy and stops there. Relaying it
 * would hand the origin the very credential this fixture exists to keep off the
 * wire beyond the proxy, and the other hop-by-hop headers describe a connection
 * the origin is not part of.
 */
const PROXY_ONLY_HEADERS: ReadonlySet<string> = new Set([
  'proxy-authorization',
  'proxy-authenticate',
  'proxy-connection',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function forwardableHeaders(
  headers: http.IncomingHttpHeaders,
): http.IncomingHttpHeaders {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !PROXY_ONLY_HEADERS.has(name.toLowerCase()),
    ),
  )
}

/**
 * A real forward proxy: a CONNECT tunnel for undici, an absolute-form relay for
 * Chrome, and optional Basic authentication in front of both.
 *
 * undici's `ProxyAgent` defaults to `proxyTunnel: true`, so it opens a CONNECT
 * tunnel even for an `http:` target. Chrome does not: for an `http:` target it
 * sends an ordinary request whose URL is absolute and expects the proxy to
 * relay it. Both are answered here, because the same proxy now serves both
 * callers in one acquisition.
 *
 * A tunnel is blind, so it cannot stamp a marker header; instead the proxy
 * records the local port of each socket it opens to the origin, and the origin
 * attributes an inbound request to the proxy by matching `remotePort`. The port
 * is recorded when the socket connects, before any byte is written, so the
 * origin can never observe a request the proxy has not yet claimed.
 */
export async function startForwardProxy(
  options: {
    /** When set, the proxy answers 407 until a request carries these Basic credentials. */
    readonly requireAuth?: {
      readonly username: string
      readonly password: string
    }
    /**
     * A set to record upstream local ports into, shared with other proxies.
     *
     * An origin recognises a proxied request by matching `remotePort` against a
     * live set. Two proxies aimed at one origin therefore have to record into
     * the same set, because a union built at start-up would be a snapshot of
     * two empty ones.
     */
    readonly localPorts?: Set<number>
  } = {},
): Promise<ForwardProxy> {
  const tunnelledAuthorities: string[] = []
  const forwardedUrls: string[] = []
  const acceptedAuthorizations: string[] = []
  const proxyLocalPorts = options.localPorts ?? new Set<number>()
  let connections = 0
  let challenges = 0
  const sockets = new Set<net.Socket>()
  const expected = options.requireAuth
    ? `Basic ${Buffer.from(
        `${options.requireAuth.username}:${options.requireAuth.password}`,
      ).toString('base64')}`
    : undefined

  /** True once the request may proceed; records the challenge otherwise. */
  const authorized = (request: http.IncomingMessage): boolean => {
    if (!expected) return true
    const offered = String(request.headers['proxy-authorization'] ?? '')
    if (offered === expected) {
      acceptedAuthorizations.push(offered)
      return true
    }
    challenges += 1
    return false
  }

  const server = http.createServer((request, response) => {
    if (!authorized(request)) {
      response.writeHead(407, { 'proxy-authenticate': 'Basic realm="loopback"' }).end()
      return
    }
    let target: URL
    try {
      target = new URL(request.url ?? '')
    } catch {
      // A relative URL is a direct request to the proxy itself, not a relay.
      response.writeHead(405).end()
      return
    }
    connections += 1
    forwardedUrls.push(target.toString())
    const failRelay = (): void => {
      if (response.destroyed || response.writableEnded) return
      if (response.headersSent) {
        response.destroy()
        return
      }
      response.writeHead(502)
      response.end()
    }
    // The upstream socket is opened first and its local port recorded in the
    // connect callback, so the origin can attribute the request before the
    // relayed bytes reach it.
    const upstream = net.connect(
      { host: target.hostname, port: Number(target.port || 80) },
      () => proxyLocalPorts.add(upstream.localPort ?? 0),
    )
    // The raw socket remains independently observable after `http.request`
    // adopts it. Chrome may reset that connection after navigation, and a
    // fixture must contain the reset instead of raising an uncaught exception.
    upstream.on('error', failRelay)
    sockets.add(upstream)
    const relayed = http.request(
      {
        createConnection: () => upstream,
        method: request.method ?? 'GET',
        path: `${target.pathname}${target.search}`,
        headers: { ...forwardableHeaders(request.headers), host: target.host },
      },
      (upstreamResponse) => {
        upstreamResponse.on('error', failRelay)
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
        upstreamResponse.pipe(response)
      },
    )
    relayed.on('error', failRelay)
    // A real proxy stops reading upstream when its client disconnects. Without
    // this the origin would never learn that an in-flight read was abandoned.
    response.on('close', () => upstream.destroy())
    request.pipe(relayed)
  })

  server.on('connect', (request, clientSocket: net.Socket, head: Buffer) => {
    if (!authorized(request)) {
      // CONNECT hands socket ownership to this listener even when authentication
      // fails. A browser may reset the rejected tunnel instead of reading EOF.
      sockets.add(clientSocket)
      clientSocket.on('error', () => clientSocket.destroy())
      clientSocket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n',
      )
      return
    }
    connections += 1
    tunnelledAuthorities.push(request.url ?? '')
    const [host, port] = (request.url ?? '').split(':')
    const upstream = net.connect(
      { host: host || '127.0.0.1', port: Number(port) },
      () => {
        proxyLocalPorts.add(upstream.localPort ?? 0)
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) upstream.write(head)
        upstream.pipe(clientSocket)
        clientSocket.pipe(upstream)
      },
    )
    sockets.add(upstream)
    sockets.add(clientSocket)
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    port: address.port,
    tunnelledAuthorities,
    forwardedUrls,
    acceptedAuthorizations,
    proxyLocalPorts,
    get connections() {
      return connections
    },
    get challenges() {
      return challenges
    },
    close: () => shutDown(server, () => {
      for (const socket of sockets) socket.destroy()
    }),
  }
}

export interface ReaderServer {
  readonly url: string
  readonly calls: number
  close(): Promise<void>
}

/** A loopback stand-in for the Firecrawl scrape endpoint, wired by URL. */
export async function startReaderServer(
  options: { readonly denyAccess?: boolean } = {},
): Promise<ReaderServer> {
  let calls = 0
  const server = http.createServer((request, response) => {
    calls += 1
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
    })
    request.on('end', () => {
      const requested = (() => {
        try {
          return String((JSON.parse(body) as { url?: unknown }).url ?? '')
        } catch {
          return ''
        }
      })()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        success: true,
        data: {
          markdown: options.denyAccess
            ? '# Access denied\n\nAccess denied. You must sign in to view this page.'
            : `# Reader evidence\n\n${'The managed reader produced independently readable evidence for this source. '.repeat(6)}`,
          metadata: { sourceURL: requested, title: options.denyAccess ? 'Access denied' : 'Reader evidence' },
        },
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    url: `http://127.0.0.1:${address.port}`,
    get calls() {
      return calls
    },
    close: () => shutDown(server),
  }
}

/**
 * Shuts a fixture server down without waiting on anyone still holding it open.
 *
 * `server.close` resolves only once every connection has ended, and a headless
 * Chrome keeps its sockets alive well past the read that opened them. A test
 * whose assertion failed would then hang in teardown instead of reporting the
 * failure, which is how a red run turns into a stuck suite.
 */
async function shutDown(
  server: http.Server,
  destroyTracked?: () => void,
): Promise<void> {
  destroyTracked?.()
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())))
}

/** Documented environmental prerequisite: the managed-browser rungs need Chrome. */
export function chromeSkipReason(): string | false {
  return resolveBrowserExecutablePath()
    ? false
    : 'No local Chrome installation was found for the managed-browser rung.'
}

export function readerEnabledSettings(): AcquisitionSettingsUpdate {
  return {
    providerPriority: ['exa', 'brave'],
    providers: {
      exa: { enabled: false },
      brave: { enabled: false },
      firecrawl: { enabled: true },
      'browser-use': { enabled: false },
    },
    budgets: {
      maximumSearchCalls: 1,
      maximumBrowserFallbacks: 2,
      maximumManagedReaderCalls: 2,
      maximumModelExtractions: 1,
      maximumCloudBrowserCalls: 0,
      maximumCloudBrowserCostMicros: 0,
    },
    extractionModel: null,
  }
}

/** A resolver that answers the named hosts privately and defers otherwise. */
export function testLookup(
  names: Readonly<Record<string, string>>,
): typeof dns.lookup {
  // The acquirer only ever calls `lookup(host, { all: true, verbatim: true })`,
  // so this answers that one shape and defers everything else to real DNS.
  const lookup = async (
    hostname: string,
    options: { all: true; verbatim: boolean },
  ): Promise<readonly { address: string; family: number }[]> => {
    const mapped = names[hostname]
    if (mapped) return [{ address: mapped, family: 4 }]
    return dns.lookup(hostname, options)
  }
  return lookup as unknown as typeof dns.lookup
}

/** A port backed by the real `resolveWebshareProxy`, aimed at the loopback proxy. */
export function webshareProxyPort(port: number): WebshareProxyPort {
  return {
    open: (signal) =>
      resolveWebshareProxy(
        {
          proxyEnabled: true,
          credentialMode: 'username-password',
          proxyHost: '127.0.0.1',
          proxyPort: port,
          countries: [],
          username: 'loopback-user',
          password: 'loopback-password',
        },
        signal,
      ),
  }
}

export interface ResearchFixture {
  readonly service: ResearchWebToolService
  /** The real manager the service drives, for leak assertions. */
  readonly browserManager?: BrowserManager
  readonly settings: AcquisitionSettingsService
  readonly assignmentPath: string
  readonly workspacePath: string
  closeBrowser(): Promise<void>
  readonly requestContext: {
    readonly contractVersion: typeof MCP_RUNTIME_CONTRACT_VERSION
    readonly requestId: string
    readonly leaseId: string
    readonly sessionId: string
    readonly runId: string
    readonly assignmentId: string
    readonly activityScopeId: string
    readonly agentPath: string
  }
}

export async function createFixture(
  context: { after(callback: () => Promise<unknown> | unknown): unknown },
  options: {
    readonly proxyPort?: WebshareProxyPort
    readonly readerEndpoint?: string
    readonly settings?: AcquisitionSettingsUpdate
    /** Launches real Chrome for the managed-browser rung. */
    readonly chrome?: boolean
    /**
     * Configures a manager that cannot start Chrome.
     *
     * Reaching the browser rung then leaves a `managed-browser` attempt in the
     * trail, so "the rung never ran" is observable without paying for a launch.
     */
    readonly unusableBrowser?: boolean
    /**
     * Names this run's DNS should answer privately.
     *
     * Supplied to the real `DirectHttpAcquirer` through its existing `lookup`
     * option, so the production resolution and rejection path is exercised
     * rather than replaced.
     */
    readonly privateDnsNames?: Readonly<Record<string, string>>
    /**
     * The service's own clock option.
     *
     * Used as a deterministic ordering boundary: the ladder calls it to stamp
     * each attempt, so a test can act exactly between two rungs without a
     * sleep and without replacing any module.
     */
    readonly now?: () => Date
  } = {},
): Promise<ResearchFixture> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'research-web-proxied-retry-')),
  )
  const workspacePath = path.join(root, 'workspace')
  const repoRootPath = path.join(root, 'repo')
  const agentPath = 'agents/web-researcher'
  await fs.mkdir(path.join(repoRootPath, agentPath), { recursive: true })
  await fs.writeFile(
    path.join(repoRootPath, agentPath, 'web-researcher.md'),
    ['---', 'name: web-researcher', 'tools: read, research_web, browser', '---', '', '# Web Researcher', ''].join('\n'),
  )
  const requestContext = {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-proxied-retry',
    leaseId: 'lease-proxied-retry',
    sessionId: 'session-proxied-retry',
    runId: 'run-proxied-retry',
    assignmentId: 'assignment-proxied-retry',
    activityScopeId: 'lane-proxied-retry',
    agentPath,
  }
  const location = buildSessionRunAssignmentLocation(workspacePath, requestContext)
  assert.ok(location)
  await fs.mkdir(location.assignmentPath, { recursive: true })
  const settings = new AcquisitionSettingsService({
    storagePath: path.join(root, 'settings.json'),
    environment: { FIRECRAWL_API_KEY: 'test-firecrawl-key' },
    ...(options.readerEndpoint
      ? { providerEndpoints: { firecrawl: options.readerEndpoint } }
      : {}),
  })
  if (options.settings) await settings.update(options.settings)
  const browserManager = options.chrome
    ? new BrowserManager({
        profilePath: path.join(root, 'browser-profile'),
        allowHttpLocalhost: true,
        mode: 'headless',
      })
    : options.unusableBrowser
      ? new BrowserManager({
          profilePath: path.join(root, 'browser-profile'),
          allowHttpLocalhost: true,
          mode: 'headless',
          executablePath: path.join(root, 'no-such-chrome'),
        })
      : undefined
  context.after(async () => {
    await browserManager?.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  return {
    settings,
    requestContext,
    assignmentPath: location.assignmentPath,
    workspacePath,
    ...(browserManager ? { browserManager } : {}),
    closeBrowser: () => browserManager?.close() ?? Promise.resolve(),
    service: new ResearchWebToolService({
      workspacePath,
      repoRootPath,
      settings,
      allowHttpLocalhost: true,
      ...(browserManager ? { browserManager } : {}),
      ...(options.proxyPort ? { webshareProxy: options.proxyPort } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.privateDnsNames
        ? {
            directAcquirer: new DirectHttpAcquirer({
              allowHttpLocalhost: true,
              lookup: testLookup(options.privateDnsNames),
            }),
          }
        : {}),
    }),
  }
}
