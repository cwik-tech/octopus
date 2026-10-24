import { _electron as electron, expect, test, type Page } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadDotEnv } from '../../core/env-loader.js'
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
loadDotEnv(process.env.PIPELINE_LIVE_ENV_DIR?.trim() || repoRoot)

/**
 * No trace for this file.
 *
 * `playwright.electron.live.config.ts:13` retains a trace on failure, and a
 * trace records the value of every `fill`. This journey types a real Webshare
 * API token or password into the settings form, so a failed live run would
 * persist that credential to `trace.zip` on disk. The deterministic spec keeps
 * tracing, because its credentials are loopback fixtures.
 */
test.use({ trace: 'off' })

const capabilityId = 'webshare-research-electron'
const requiredCapabilities = new Set((process.env.PIPELINE_LIVE_REQUIRE ?? '')
  .split(',').map((value) => value.trim()).filter(Boolean))

/**
 * Public hosts a prior research run was denied by.
 *
 * Taken from persisted session evidence: the richest recorded run was denied by
 * five public Michigan travel-and-food hosts. The query itself is not
 * recoverable — a search record persists no query text — so this is a public
 * equivalent that targets the same public hosts.
 *
 * Two, not five: `fixture/research-web` acquires only the first two Brave
 * results (`tests/fixtures/providers/openai-tool-loop-server.mjs:267-285`), so a
 * longer list would never be read and each unreached host would burn the poll
 * window. These two denied most consistently in the recorded sessions. Reaching
 * all five needs a dedicated provider-fixture mode, not a longer list here.
 */
const deniedHosts = (process.env.PIPELINE_LIVE_WEBSHARE_HOSTS?.trim() ||
  'https://www.tripadvisor.com/,https://www.mlive.com/')
  .split(',').map((value) => value.trim()).filter(Boolean)

const ACQUIRABLE_TARGETS = 2

/** The three outcomes that mean this host refused this egress. */
const HOST_SCOPED_OUTCOMES: ReadonlySet<string> = new Set([
  'access-denied',
  'challenge',
  'rate-limited',
])

const credential = resolveWebshareCredential()

/**
 * The same journey as the deterministic spec, against the real service.
 *
 * It reports what the real hosts and the real proxy actually did. It asserts
 * only the contract that must hold whatever they do — a host-scoped direct
 * denial is followed by a proxied attempt — and never that a third-party site
 * still blocks, nor that Webshare clears it. Those are observations, not
 * promises, so the deterministic acceptance assertion is not weakened to
 * accommodate live drift. The name says "reports" for that reason: a pass here
 * is not evidence that a real retry recovered anything.
 */
test('reports what real previously-denied public sources do with Webshare enabled', async ({}, testInfo) => {
  requireOrSkipLiveCapability()
  test.setTimeout(15 * 60_000)

  const modelProvider = await startOpenAiToolLoopFixture(repoRoot)
  const braveSecret = `brave-webshare-live-${Date.now()}`
  const brave = await startBraveFixture(braveSecret, deniedHosts)
  const projectRoot = testInfo.outputPath('webshare-live-project')
  const userDataPath = testInfo.outputPath('webshare-live-user-data')
  const workspacePath = testInfo.outputPath('webshare-live-workspace')
  const modelSecret = `webshare-live-model-${Date.now()}`

  await Promise.all([
    createWebResearcherProject(repoRoot, projectRoot),
    seedAcquisitionSettings(userDataPath),
    fs.mkdir(workspacePath, { recursive: true }),
  ])

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      // The credential is typed into the UI, not exported: any WEBSHARE_*
      // variable would put the panel into its read-only environment mode.
      ...withoutWebshareEnvironment(process.env),
      NODE_ENV: 'test',
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRoot,
      PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
      PIPELINE_DESKTOP_E2E_BRAVE_ENDPOINT: `${brave.url}/res/v1/web/search`,
      OPENAI_API_KEY: modelSecret,
      OPENAI_BASE_URL: `${modelProvider.url}/v1`,
      BRAVE_SEARCH_API_KEY: braveSecret,
    },
  })

  try {
    const page = await app.firstWindow()
    await configureModelProvider(page, modelProvider.url, modelSecret)
    await openWebshareSettings(page)
    await configureRealWebshare(page, credential)

    await selectWebResearcher(page)
    await sendToWebResearcher(page, 'Conduct for me online research on visiting Ann Arbor, Michigan.')

    // The targets are read in one turn, so they are polled against a single
    // shared deadline rather than a fresh window each.
    const deadline = Date.now() + 240_000
    const targets = deniedHosts.slice(0, ACQUIRABLE_TARGETS)
    const records = await Promise.all(
      targets.map((target) => pollAcquisition(workspacePath, target, deadline)),
    )

    const analysis = analyseTrails(targets, records)
    const report = `${analysis.observed.join('\n')}\n\n${analysis.measurement}`
    await testInfo.attach('observed-acquisition-trails', {
      body: report,
      contentType: 'text/plain',
    })
    console.log(`\nWebshare live replay — observed trails:\n${report}\n`)

    // Two unconditional assertions, both reading values the analysis already
    // decided. Which of them runs never depends on what the live hosts did.
    expect(
      analysis.violations,
      `the proxied retry did not follow a host-scoped denial; observed:\n${report}`,
    ).toEqual([])
    // A run that acquired nothing proves nothing. Counting configured targets
    // would pass even then, so the settled records are what is required.
    expect(analysis.settled, `no target settled; observed:\n${report}`).toBeGreaterThan(0)
  } finally {
    await Promise.allSettled([app.close(), modelProvider.close(), brave.close()])
  }
})

// ---------------------------------------------------------------------------

/** Each rung and the proxied retry a host-scoped denial from it must produce. */
const PROXIED_RETRY_BY_RUNG: readonly (readonly [string, string])[] = [
  ['direct-http', 'direct-http-proxied'],
  ['managed-browser', 'managed-browser-proxied'],
]

const PROXIED_METHODS: ReadonlySet<string> = new Set(
  PROXIED_RETRY_BY_RUNG.map(([, retry]) => retry),
)

interface TrailAnalysis {
  /** One human-readable line per configured target. */
  readonly observed: readonly string[]
  /** Contracts the run broke. Empty is the only acceptable result. */
  readonly violations: readonly string[]
  /** Targets that produced a settled acquisition record. */
  readonly settled: number
  /** The recovery rate, phrased for the attached report. */
  readonly measurement: string
}

/**
 * Reads the persisted trails and reports what they show.
 *
 * It decides nothing about which assertions run — it returns the violations and
 * the caller asserts, unconditionally, that there are none. Branching over live
 * results inside the assertions would mean a run against drifted third-party
 * behaviour silently checked less than the one before it.
 *
 * That drift is the reason the two are separated at all. A host that has
 * stopped denying is not a violation: these are real sites and what they do
 * changes. The contract is narrower and does not drift — *if* a rung was denied
 * in a way that means this host refused this egress, the proxied retry for that
 * rung must appear.
 */
function analyseTrails(
  targets: readonly string[],
  records: readonly (AcquisitionRecord | undefined)[],
): TrailAnalysis {
  const observed: string[] = []
  const violations: string[] = []
  let settled = 0
  let proxiedRetries = 0
  let proxiedRecoveries = 0

  for (const [index, target] of targets.entries()) {
    const record = records[index]
    if (!record) {
      observed.push(`${target} -> (not acquired in this run)`)
      continue
    }
    settled += 1
    const attempts = record.attempts ?? []
    const methods = attempts.map((attempt) => attempt.method)
    observed.push(`${target} -> ${attempts
      .map((attempt) => `${attempt.method}/${attempt.outcome}`)
      .join(' -> ')}`)

    for (const [rung, retry] of PROXIED_RETRY_BY_RUNG) {
      const denied = attempts.some(
        (attempt) =>
          attempt.method === rung &&
          HOST_SCOPED_OUTCOMES.has(String(attempt.outcome)),
      )
      if (denied && !methods.includes(retry)) {
        violations.push(`${target}: ${rung} was denied but ${retry} did not follow`)
      }
    }

    for (const attempt of attempts) {
      if (!PROXIED_METHODS.has(String(attempt.method))) continue
      proxiedRetries += 1
      if (attempt.outcome === 'usable') proxiedRecoveries += 1
    }
  }

  // The recovery rate is the question a loopback fixture cannot answer, so it
  // is reported and never asserted: a residential address clears a
  // datacenter-reputation block and does nothing for a fingerprint block or a
  // CAPTCHA served to every visitor. A run that recovers nothing is a real
  // answer and must not fail this replay.
  const measurement = proxiedRetries === 0
    ? 'proxied recovery: no proxied retry fired in this run'
    : `proxied recovery: ${proxiedRecoveries}/${proxiedRetries} retries produced usable evidence`

  return { observed, violations, settled, measurement }
}

interface WebshareCredential {
  readonly mode: 'api-token' | 'username-password'
  readonly apiToken?: string
  readonly username?: string
  readonly password?: string
  readonly host: string
  readonly port: string
  readonly countries: string
}

function resolveWebshareCredential(): WebshareCredential | undefined {
  const host = process.env.WEBSHARE_PROXY_HOST?.trim() || 'p.webshare.io'
  const port = process.env.WEBSHARE_PROXY_PORT?.trim() || '80'
  const countries = process.env.WEBSHARE_PROXY_COUNTRIES?.trim() || 'us'
  const apiToken = process.env.WEBSHARE_API_KEY?.trim()
  if (apiToken) return { mode: 'api-token', apiToken, host, port, countries }
  const username = process.env.WEBSHARE_USERNAME?.trim()
  const password = process.env.WEBSHARE_PASSWORD?.trim()
  if (username && password) {
    return { mode: 'username-password', username, password, host, port, countries }
  }
  return undefined
}

function requireOrSkipLiveCapability(): void {
  if (credential) return
  const reason =
    'Set WEBSHARE_API_KEY, or WEBSHARE_USERNAME and WEBSHARE_PASSWORD, to run the Webshare live replay.'
  if (requiredCapabilities.has('all') || requiredCapabilities.has(capabilityId)) {
    throw new Error(`Required live capability '${capabilityId}' is unavailable: ${reason}`)
  }
  test.skip(true, reason)
}

async function configureRealWebshare(
  page: Page,
  webshare: WebshareCredential | undefined,
): Promise<void> {
  if (!webshare) throw new Error('Webshare credential is unavailable')
  await page.getByRole('button', {
    name: webshare.mode === 'api-token' ? 'API token' : 'Username and password',
    exact: true,
  }).click()
  await page.getByLabel('Proxy host').fill(webshare.host)
  await page.getByLabel('Proxy port').fill(webshare.port)
  await page.getByLabel('Country codes').fill(webshare.countries)
  if (webshare.mode === 'api-token') {
    await page.getByLabel('API token').fill(webshare.apiToken ?? '')
  } else {
    await page.getByLabel('Username').fill(webshare.username ?? '')
    await page.getByLabel('Password').fill(webshare.password ?? '')
  }
  // Isolated user data plus a scrubbed environment guarantee the switch starts
  // off, so this asserts the starting state rather than tolerating it. A
  // conditional click would let the journey silently skip the very user action
  // it claims to exercise.
  const control = page.getByRole('switch', { name: 'Use Webshare proxy' })
  await expect(control).not.toBeChecked()
  await control.click()
  await expect(control).toBeChecked()
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 60_000 })
  await closeSettings(page)
}

async function startBraveFixture(
  expectedSecret: string,
  targets: readonly string[],
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/res/v1/web/search') {
      response.writeHead(404).end()
      return
    }
    if (request.headers['x-subscription-token'] !== expectedSecret) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: 'Unauthorized Brave fixture request' }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      web: {
        results: targets.map((target, index) => ({
          title: `Ann Arbor visitor source ${index + 1}`,
          url: target,
          description: 'Public Michigan travel and food source recorded in a prior run.',
        })),
      },
    }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Brave fixture address is unavailable')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function pollAcquisition(
  workspacePath: string,
  target: string,
  deadline: number,
): Promise<AcquisitionRecord | undefined> {
  while (Date.now() < deadline) {
    const settled = await readSettledAcquisitions(workspacePath)
    const found = settled.find((row) =>
      [row.requestedUrl, row.canonicalUrl].some((value) =>
        typeof value === 'string' && sameTarget(value, target)))
    if (found) return found
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000))
  }
  return undefined
}

function sameTarget(value: string, target: string): boolean {
  try {
    return new URL(value).host === new URL(target).host
  } catch {
    return false
  }
}
