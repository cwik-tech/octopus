import { _electron as electron, expect, test } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as net from 'node:net'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { startOpenAiToolLoopFixture } from '../support/openai-tool-loop-fixture.js'
import {
  closeSettings,
  configureModelProvider,
  createWebResearcherProject,
  openWebshareSettings,
  readSettledAcquisitions,
  seedAcquisitionSettings,
  selectWebResearcher,
  sendToWebResearcher,
  withoutWebshareEnvironment,
  type AcquisitionRecord,
} from '../support/webshare-electron-fixture.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const prompt = 'Conduct for me online research on ice creams in Ann Arbor.'

const PROXY_USER = 'loopback-webshare-user'
const PROXY_PASSWORD = 'loopback-webshare-password'
const PROXY_COUNTRY = 'us'
/**
 * Webshare encodes country targeting into the username, and the app does the
 * same: `targetedUsername` (`domains/proxy/webshare-proxy.ts`) turns the
 * configured name into `<user>-<country>-rotate`. The fixture expects the
 * transformed name, so a change to that rule fails here rather than silently
 * falling through to the next rung.
 */
const EXPECTED_PROXY_USER = `${PROXY_USER}-${PROXY_COUNTRY}-rotate`

/**
 * The Webshare switch decides whether a denied source is retried through the
 * proxy.
 *
 * The user outcome is routing, not a stored flag: with the switch on, a source
 * that denies the ordinary read is recovered through the proxy; with it off,
 * the proxy is never contacted and the read fails the way it does today.
 *
 * The evidence is the persisted acquisition journal and its observation
 * receipt, because the research disclosure deliberately carries no attempt
 * methods (`domains/acquisition/research-activity-projection.ts:87-105,142-180`).
 * A component-level assertion on the switch cannot see any of this.
 *
 * Direct and proxied reads are told apart by destination rather than by request
 * order: the denying origin answers 403 to every read of a `denied` path, and
 * the CONNECT proxy tunnels to a *separate* upstream that answers the same path
 * with usable content. Nothing depends on which request arrives first.
 *
 * The proxy stands in for Webshare. That substitution is deliberate — the real
 * service is credentialed and its egress is nondeterministic — and it is the
 * only one: the app, the settings save, the origin, and the proxy transport are
 * all real. `tests/electron/webshare-proxy-research.live.spec.ts` replays the
 * same journey against the real service when credentials are present.
 */
test('the Webshare switch routes a denied research source through the proxy, and turning it off stops the retry', async ({}, testInfo) => {
  test.setTimeout(240_000)
  const modelProvider = await startOpenAiToolLoopFixture(repoRoot)
  const braveSecret = `brave-webshare-${Date.now()}`

  const upstream = await startUsableUpstream()
  const proxy = await startAuthenticatingConnectProxy(upstream.port)
  const origin = await startDenyingOrigin(braveSecret)

  const projectRoot = testInfo.outputPath('webshare-project')
  const userDataPath = testInfo.outputPath('webshare-user-data')
  const workspacePath = testInfo.outputPath('webshare-workspace')
  const modelSecret = `webshare-model-${Date.now()}`

  await Promise.all([
    createWebResearcherProject(repoRoot, projectRoot),
    seedAcquisitionSettings(userDataPath),
    fs.mkdir(workspacePath, { recursive: true }),
  ])

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...fixtureDesktopEnvironment(withoutWebshareEnvironment(process.env)),
      NODE_ENV: 'test',
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRoot,
      PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
      PIPELINE_DESKTOP_E2E_BRAVE_ENDPOINT: `${origin.url}/res/v1/web/search`,
      OPENAI_API_KEY: modelSecret,
      OPENAI_BASE_URL: `${modelProvider.url}/v1`,
      BRAVE_SEARCH_API_KEY: braveSecret,
    },
  })

  try {
    const page = await app.firstWindow()
    await configureModelProvider(page, modelProvider.url, modelSecret)

    // --- The switch on ------------------------------------------------------
    await openWebshareSettings(page)
    const webshareSwitch = page.getByRole('switch', { name: 'Use Webshare proxy' })
    await expect(webshareSwitch).not.toBeChecked()
    await expect(webshareSwitch).toBeEnabled()

    await page.getByRole('button', { name: 'Username and password' }).click()
    await page.getByLabel('Proxy host').fill('127.0.0.1')
    await page.getByLabel('Proxy port').fill(String(proxy.port))
    await page.getByLabel('Country codes').fill(PROXY_COUNTRY)
    await page.getByLabel('Username').fill(PROXY_USER)
    await page.getByLabel('Password').fill(PROXY_PASSWORD)
    await webshareSwitch.click()
    await expect(webshareSwitch).toBeChecked()
    await page.getByRole('button', { name: 'Save settings' }).click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 30_000 })
    await closeSettings(page)

    await selectWebResearcher(page)
    await sendToWebResearcher(page, prompt)

    // The routing evidence settles well before the answer does, so it is
    // asserted first: a routing regression then reports the exact methods and
    // outcomes it produced, instead of timing out on a missing answer.
    const recovered = await pollAcquisition(workspacePath, `${origin.url}/source/denied-1`)
    expect(recovered.attempts?.map((attempt) => attempt.method)).toEqual([
      'direct-http',
      'direct-http-proxied',
    ])
    expect(recovered.attempts?.map((attempt) => attempt.outcome)).toEqual([
      'access-denied',
      'usable',
    ])
    expect(recovered.observationReceipt?.method).toBe('direct-http-proxied')
    expect(proxy.tunnelledAuthorities).toContain(new URL(origin.url).host)
    expect(proxy.rejectedCredentials).toEqual([])
    // Country targeting travels in the credential, so assert the exact header
    // rather than only that some tunnel was authorised.
    expect(proxy.acceptedAuthorizations[0]).toBe(proxy.expectedAuthorization)
    expect(
      Buffer.from(
        String(proxy.acceptedAuthorizations[0]).replace(/^Basic /u, ''),
        'base64',
      ).toString('utf8'),
    ).toBe(`${EXPECTED_PROXY_USER}:${PROXY_PASSWORD}`)

    // The recovered source still reaches the user as a cited answer.
    await expect(
      page.locator('.group.is-assistant').filter({ hasText: 'BRAVE_PATH_CONFIRMED' }).last(),
    ).toBeVisible({ timeout: 120_000 })

    // --- The switch off -----------------------------------------------------
    const tunnelsBefore = proxy.tunnelledAuthorities.length
    await openWebshareSettings(page)
    await expect(webshareSwitch).toBeChecked()
    await webshareSwitch.click()
    await expect(webshareSwitch).not.toBeChecked()
    await page.getByRole('button', { name: 'Save settings' }).click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 30_000 })
    await closeSettings(page)

    // A second, distinct URL: the first is held in the observation cache and
    // its host may be lane-banned, either of which would make this assertion
    // pass without proving anything.
    //
    // The turn itself ends in error, because the provider fixture requires two
    // citable sources and this source can no longer be recovered. The evidence
    // this journey owns is the persisted attempt trail, which is written either
    // way, so it is polled rather than read off the answer.
    await sendToWebResearcher(page, prompt)
    const denied = await pollAcquisition(workspacePath, `${origin.url}/source/denied-2`)
    expect(denied.attempts?.map((attempt) => attempt.method)).toEqual(['direct-http'])
    expect(denied.attempts?.at(-1)?.outcome).toBe('access-denied')
    expect(denied.observationReceipt).toBeUndefined()
    expect(proxy.tunnelledAuthorities.length).toBe(tunnelsBefore)
  } finally {
    await Promise.allSettled([
      app.close(),
      modelProvider.close(),
      origin.close(),
      proxy.close(),
      upstream.close(),
    ])
  }
})

// ---------------------------------------------------------------------------
// Local network boundaries
// ---------------------------------------------------------------------------

const USABLE_PAGE = (title: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>
  This Ann Arbor ice cream source carries enough directly observed evidence for Web Researcher to
  cite this exact source URL in its research result rather than relying on a search snippet.
  ${'It describes a local creamery, its frozen desserts, and its opening hours. '.repeat(4)}
  </p></main></body></html>`

/** Answers every `denied` read with 403, whichever transport asks. */
async function startDenyingOrigin(expectedSecret: string): Promise<{
  readonly url: string
  close(): Promise<void>
}> {
  let base = ''
  let round = 0
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', base || 'http://127.0.0.1')
    if (url.pathname === '/res/v1/web/search') {
      if (request.headers['x-subscription-token'] !== expectedSecret) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ message: 'Unauthorized Brave fixture request' }))
        return
      }
      // Each search hands out its own denied source, so the off-state run can
      // never be answered from the first run's cache.
      round += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        web: {
          results: [
            { title: `Denied Source ${round}`, url: `${base}/source/denied-${round}`, description: 'Ann Arbor ice cream guide.' },
            { title: `Open Source ${round}`, url: `${base}/source/plain-${round}`, description: 'Local creamery listing.' },
            { title: 'Ann Arbor Observer', url: 'https://annarborobserver.com/ice-cream/', description: 'Local ice cream guide.' },
          ],
        },
      }))
      return
    }
    if (url.pathname.startsWith('/source/denied-')) {
      response.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><body>Forbidden</body></html>')
      return
    }
    if (url.pathname.startsWith('/source/plain-')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(USABLE_PAGE('Washtenaw Dairy'))
      return
    }
    response.writeHead(404).end()
  })
  base = await listen(server)
  return { url: base, close: () => closeServer(server) }
}

/** The vantage point the proxy tunnels to: the same paths, but usable. */
async function startUsableUpstream(): Promise<{
  readonly port: number
  close(): Promise<void>
}> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname.startsWith('/source/denied-')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(USABLE_PAGE('Ann Arbor Ice Cream Source'))
      return
    }
    response.writeHead(404).end()
  })
  const base = await listen(server)
  return { port: Number(new URL(base).port), close: () => closeServer(server) }
}

/**
 * A real HTTP CONNECT proxy that requires Basic authentication.
 *
 * It tunnels to `upstreamPort` regardless of the authority it was asked for, so
 * a proxied read reaches a different server than the same URL read directly.
 * That is what makes the assertion independent of request order.
 */
async function startAuthenticatingConnectProxy(upstreamPort: number): Promise<{
  readonly port: number
  readonly tunnelledAuthorities: readonly string[]
  readonly rejectedCredentials: readonly string[]
  readonly acceptedAuthorizations: readonly string[]
  readonly expectedAuthorization: string
  close(): Promise<void>
}> {
  const expected = `Basic ${Buffer.from(`${EXPECTED_PROXY_USER}:${PROXY_PASSWORD}`).toString('base64')}`
  const tunnelledAuthorities: string[] = []
  const rejectedCredentials: string[] = []
  const acceptedAuthorizations: string[] = []
  const sockets = new Set<net.Socket>()
  const server = http.createServer((_request, response) => response.writeHead(405).end())
  server.on('connect', (request, clientSocket: net.Socket, head: Buffer) => {
    if (request.headers['proxy-authorization'] !== expected) {
      // Recorded so a credential mismatch is diagnosable from the failure
      // rather than looking like an unexplained transport error.
      rejectedCredentials.push(
        Buffer.from(
          String(request.headers['proxy-authorization'] ?? '').replace(/^Basic /u, ''),
          'base64',
        ).toString('utf8').split(':')[0] ?? '(none)',
      )
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n')
      return
    }
    acceptedAuthorizations.push(String(request.headers['proxy-authorization'] ?? ''))
    tunnelledAuthorities.push(request.url ?? '')
    const upstream = net.connect({ host: '127.0.0.1', port: upstreamPort }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    sockets.add(upstream)
    sockets.add(clientSocket)
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  const base = await listen(server)
  return {
    port: Number(new URL(base).port),
    tunnelledAuthorities,
    rejectedCredentials,
    acceptedAuthorizations,
    expectedAuthorization: expected,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await closeServer(server)
    },
  }
}

/** Reads the journal the app writes, which is the only place methods survive. */
async function pollAcquisition(
  workspacePath: string,
  requestedUrl: string,
): Promise<AcquisitionRecord> {
  let last: AcquisitionRecord | undefined
  await expect.poll(async () => {
    const settled = await readSettledAcquisitions(workspacePath)
    last = settled.find((row) => row.requestedUrl === requestedUrl)
    return last !== undefined
  }, { timeout: 120_000, intervals: [500] }).toBe(true)
  if (!last) throw new Error(`No settled acquisition recorded for ${requestedUrl}`)
  return last
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture address is unavailable')
  return `http://127.0.0.1:${address.port}`
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()))
}
