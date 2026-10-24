import * as http from 'node:http'
import * as net from 'node:net'

/**
 * The loopback network the managed-browser Webshare journeys run against.
 *
 * Three callers reach one origin and are answered differently: the direct HTTP
 * acquirer, unproxied managed Chrome, and managed Chrome behind an
 * authenticating proxy. That is what makes a routed read distinguishable from a
 * direct one in the persisted evidence.
 *
 * The direct answer is deliberately a page too short to be evidence rather than
 * a denial. A denial there is terminal and host-scoped, which is the trigger
 * for the already-shipped `direct-http-proxied` rung; that rung would then
 * recover the page and the journey would pass with no managed-browser proxying
 * implemented at all.
 *
 * These servers are written here rather than shared with the integration
 * fixture because `tests/electron` is compiled by Playwright, and the
 * integration fixture pulls in the production service and browser manager that
 * a desktop journey has no business loading.
 */

const USABLE_PAGE = (vantage: string): string =>
  `<!doctype html><html><head><title>Ann Arbor ice cream from ${vantage}</title></head><body><main>
  <h1>Ann Arbor ice cream from ${vantage}</h1><p>
  This Ann Arbor ice cream source carries enough directly observed evidence for Web Researcher to
  cite this exact source URL in its research result rather than relying on a search snippet.
  ${'It describes a local creamery, its frozen desserts, and its opening hours. '.repeat(4)}
  </p></main></body></html>`

/**
 * Well formed, non-empty, and still too short to be evidence.
 *
 * `evaluateAcquisitionQuality` rejects HTML under 160 normalized characters
 * with no structured representations as `insufficient`, which is non-terminal
 * on all three of its branches.
 */
const INSUFFICIENT_PAGE =
  '<!doctype html><html><head><title>Notice</title></head><body><main><p>Short notice.</p></main></body></html>'

const DENIED_PAGE = '<html><body>Forbidden</body></html>'

/** The direct acquirer announces itself; Chrome does not. */
function isChrome(request: http.IncomingMessage): boolean {
  return !String(request.headers['user-agent'] ?? '').includes('Pipeline-Deep-Research')
}

export interface ThreeWayOrigin {
  readonly url: string
  /** Paths read through the proxy, in order. */
  readonly proxiedRequests: readonly string[]
  /** Credential headers the origin was handed, which must stay empty. */
  readonly credentialHeadersSeen: readonly string[]
  close(): Promise<void>
}

export type ChromeAnswer = 'usable-only-through-the-proxy' | 'usable-without-the-proxy'

/**
 * The fixture origin, which also stands in for the Brave search endpoint.
 *
 * `chromeAnswer` decides what the first search result does: recover only from
 * the proxy's vantage point, or read perfectly well without it. Those are the
 * two journeys the Webshare switch chooses between.
 */
export async function startThreeWayOrigin(options: {
  readonly braveSecret: string
  readonly chromeAnswer: ChromeAnswer
  readonly proxyLocalPorts: ReadonlySet<number>
}): Promise<ThreeWayOrigin> {
  const proxiedRequests: string[] = []
  const credentialHeadersSeen: string[] = []
  let base = ''
  let round = 0
  const server = http.createServer((request, response) => {
    const proxied = options.proxyLocalPorts.has(request.socket.remotePort ?? -1)
    const url = new URL(request.url ?? '/', base || 'http://127.0.0.1')
    if (proxied) proxiedRequests.push(url.pathname)
    for (const header of ['proxy-authorization', 'authorization'] as const) {
      if (request.headers[header] !== undefined) credentialHeadersSeen.push(header)
    }

    if (url.pathname === '/res/v1/web/search') {
      if (request.headers['x-subscription-token'] !== options.braveSecret) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ message: 'Unauthorized Brave fixture request' }))
        return
      }
      // Each search hands out its own sources, so a later turn can never be
      // answered from an earlier turn's observation cache.
      round += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        web: {
          results: [
            {
              title: `Contested Source ${round}`,
              url: `${base}/source/contested-${round}`,
              description: 'Ann Arbor ice cream guide.',
            },
            {
              title: `Open Source ${round}`,
              url: `${base}/source/plain-${round}`,
              description: 'Local creamery listing.',
            },
            {
              title: 'Ann Arbor Observer',
              url: 'https://annarborobserver.com/ice-cream/',
              description: 'Local ice cream guide.',
            },
          ],
        },
      }))
      return
    }

    if (url.pathname.startsWith('/source/contested-')) {
      if (!isChrome(request)) return send(response, 200, INSUFFICIENT_PAGE)
      if (options.chromeAnswer === 'usable-without-the-proxy') {
        // A proxied read of this path is the failure the off-state journey
        // watches for, so it answers with a body the test can name.
        return send(response, 200, USABLE_PAGE(proxied ? 'the proxy' : 'the house connection'))
      }
      if (proxied) return send(response, 200, USABLE_PAGE('the proxy'))
      return send(response, 403, DENIED_PAGE)
    }
    if (url.pathname.startsWith('/source/plain-')) {
      return send(response, 200, USABLE_PAGE('Washtenaw Dairy'))
    }
    response.writeHead(404).end()
  })
  base = await listen(server)
  return {
    url: base,
    proxiedRequests,
    credentialHeadersSeen,
    close: () => closeServer(server),
  }
}

export interface AuthenticatingProxy {
  readonly port: number
  /** Local ports of the sockets this proxy opened towards the origin. */
  readonly proxyLocalPorts: ReadonlySet<number>
  /** CONNECT tunnels opened plus plain-HTTP requests relayed. */
  readonly connections: number
  /** How many times the proxy answered `407 Proxy Authentication Required`. */
  readonly challenges: number
  /** Every `Proxy-Authorization` header the proxy accepted, in order. */
  readonly acceptedAuthorizations: readonly string[]
  close(): Promise<void>
}

/**
 * Headers a proxy may pass on to an origin.
 *
 * `Proxy-Authorization` is addressed to the proxy and stops there; the rest
 * describe a connection the origin is not part of.
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

/**
 * A real forward proxy that demands Basic authentication.
 *
 * undici opens a CONNECT tunnel even for an `http:` target; Chrome instead
 * sends an ordinary request with an absolute URL and expects a relay. Both are
 * answered, because one acquisition now uses both callers. A tunnel is blind,
 * so the proxy records the local port of every socket it opens to the origin
 * and the origin attributes an inbound request by matching `remotePort`.
 */
export async function startAuthenticatingProxy(credentials: {
  readonly username: string
  readonly password: string
}): Promise<AuthenticatingProxy> {
  const expected = `Basic ${Buffer.from(
    `${credentials.username}:${credentials.password}`,
  ).toString('base64')}`
  const proxyLocalPorts = new Set<number>()
  const acceptedAuthorizations: string[] = []
  const sockets = new Set<net.Socket>()
  let connections = 0
  let challenges = 0

  const authorized = (request: http.IncomingMessage): boolean => {
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
      response.writeHead(405).end()
      return
    }
    connections += 1
    // The upstream socket is opened first and its local port recorded when it
    // connects, so the origin can attribute the request before any relayed byte
    // reaches it.
    const upstream = net.connect(
      { host: target.hostname, port: Number(target.port || 80) },
      () => proxyLocalPorts.add(upstream.localPort ?? 0),
    )
    sockets.add(upstream)
    const relayed = http.request(
      {
        createConnection: () => upstream,
        method: request.method ?? 'GET',
        path: `${target.pathname}${target.search}`,
        headers: {
          ...Object.fromEntries(
            Object.entries(request.headers).filter(
              ([name]) => !PROXY_ONLY_HEADERS.has(name.toLowerCase()),
            ),
          ),
          host: target.host,
        },
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
        upstreamResponse.pipe(response)
      },
    )
    relayed.on('error', () => {
      if (!response.headersSent) response.writeHead(502)
      response.end()
    })
    response.on('close', () => upstream.destroy())
    request.pipe(relayed)
  })

  server.on('connect', (request, clientSocket: net.Socket, head: Buffer) => {
    if (!authorized(request)) {
      clientSocket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n',
      )
      return
    }
    connections += 1
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

  const base = await listen(server)
  return {
    port: Number(new URL(base).port),
    proxyLocalPorts,
    acceptedAuthorizations,
    get connections() {
      return connections
    },
    get challenges() {
      return challenges
    },
    close: () => closeServer(server, () => {
      for (const socket of sockets) socket.destroy()
    }),
  }
}

function send(response: http.ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  response.end(body)
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Fixture address is unavailable')
  }
  return `http://127.0.0.1:${address.port}`
}

/**
 * Shuts a fixture server down without waiting on anyone still holding it open.
 *
 * `server.close` resolves only once every connection has ended, and a headless
 * Chrome keeps its sockets alive past the read that opened them, so a journey
 * that failed would hang in teardown rather than report the failure.
 */
function closeServer(
  server: http.Server,
  destroyTracked?: () => void,
): Promise<void> {
  destroyTracked?.()
  server.closeAllConnections()
  return new Promise<void>((resolve) => server.close(() => resolve()))
}
