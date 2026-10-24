import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { setFrontMatterFields } from '../support/config-rewrite.js'
import { startOpenAiToolLoopFixture } from '../support/openai-tool-loop-fixture.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const prompt = 'Conduct for me online research on ice creams in Ann Arbor.'
const sessionTitle = 'Ann Arbor research activity journey'

/**
 * One research disclosure for a `research_web` turn: live, then settled, then
 * restored.
 *
 * The user outcome this journey owns is visibility: while Web Researcher is
 * researching, the turn shows a single running disclosure that names the search
 * provider and the page currently being read; when the answer lands, that same
 * disclosure settles into the answer rather than being joined by a second one;
 * and a restart brings it back. Which fields the projection carries, how the
 * two journals are merged, and how a mixed-source turn is grouped are proved at
 * their own layers.
 *
 * The pre-terminal state is held at the source-page boundary rather than the
 * model boundary: the Brave fixture is an in-process server this spec owns,
 * while the provider fixture is a separate process with no hold API.
 */
test('a Web Researcher research turn shows one research disclosure live, settled, and after a restart', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const modelProvider = await startOpenAiToolLoopFixture(repoRoot)
  // The paid model boundary is local. Hold its final answer to observe the
  // otherwise brief gap after research finishes but before text arrives.
  const model = createHeldModelFixture(modelProvider.url)
  const modelUrl = await listen(model.server)
  const braveSecret = `brave-activity-${Date.now()}`
  const brave = createHeldBraveSearchFixture(braveSecret)
  const braveBaseUrl = await listen(brave.server)
  const projectRoot = testInfo.outputPath('research-activity-project')
  const userDataPath = testInfo.outputPath('research-activity-user-data')
  const workspacePath = testInfo.outputPath('research-activity-workspace')
  const modelSecret = `research-activity-model-${Date.now()}`

  await Promise.all([
    createWebResearcherProject(projectRoot),
    seedAcquisitionSettings(userDataPath),
    fs.mkdir(workspacePath, { recursive: true }),
  ])

  const launch = (): Promise<ElectronApplication> => electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...fixtureDesktopEnvironment(),
      NODE_ENV: 'test',
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRoot,
      PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
      PIPELINE_DESKTOP_E2E_BRAVE_ENDPOINT: `${braveBaseUrl}/res/v1/web/search`,
      OPENAI_API_KEY: modelSecret,
      OPENAI_BASE_URL: `${modelUrl}/v1`,
      BRAVE_SEARCH_API_KEY: braveSecret,
    },
  })

  const first = await launch()
  try {
    const page = await first.firstWindow()
    await configureModelProvider(page, modelUrl, modelSecret)
    await page.getByRole('tab', { name: 'Run' }).click()
    await page.getByRole('button', { name: 'Search Agents' }).click()
    const search = page.getByRole('searchbox', { name: 'Search Agents' })
    await search.fill('web-researcher')
    await page.getByRole('button', { name: /^Web Researcher/i }).click()

    const composer = page.getByPlaceholder('Send a message to the selected agents...')
    await composer.fill(prompt)
    await page.getByRole('button', { name: 'Send message' }).click()

    // The second source is held open, so the turn is observably mid-research:
    // the search and the first read are done and the second read is in flight.
    await brave.heldRequestReceived

    const running = page.getByRole('button', { name: /^Running research activity/ })
    await expect(running).toHaveCount(1, { timeout: 60_000 })
    const disclosure = page.getByLabel('Web research activity')
    await expect(disclosure).toHaveCount(1)
    await expect(disclosure.getByText('Searched Brave')).toBeVisible()
    await expect(disclosure.getByText('3 results')).toBeVisible()
    await expect(
      disclosure.getByText(`Reading ${brave.heldHost}`, { exact: false }),
    ).toBeVisible()
    const busy = page.getByRole('status', { name: 'Web Researcher is responding' })
    await expect(busy).toHaveText('Researching…')

    brave.releaseHeldRequest()
    await model.finalAnswerReady
    await expect(busy).toHaveText('Preparing a response…')
    await page.screenshot({ path: testInfo.outputPath('research-preparing-response.png') })
    model.releaseFinalAnswer()

    const answer = page.locator('.group.is-assistant').filter({
      hasText: 'BRAVE_PATH_CONFIRMED',
    }).last()
    await expect(answer).toBeVisible({ timeout: 60_000 })
    await expect(busy).toHaveCount(0)

    // One disclosure, attached to the answer. The in-flight group is
    // reconciled into the assistant message rather than left beside it.
    await expect(
      page.getByRole('button', { name: /^Research activity/ }),
    ).toHaveCount(1, { timeout: 30_000 })
    await expect(
      page.getByRole('button', { name: /^Running research activity/ }),
    ).toHaveCount(0)
    await expect(answer.getByLabel('Web research activity')).toHaveCount(1)

    // Renamed so the restart reopens this exact session by a name the test
    // chose, rather than whichever row the sidebar happens to list first.
    await page.getByRole('button', { name: 'Edit session title' }).click()
    const titleField = page.getByRole('textbox', { name: 'Session title' })
    await titleField.fill(sessionTitle)
    await page.getByRole('button', { name: 'Save session title' }).click()
    await expect(
      page.getByRole('button', { name: 'Edit session title' }),
    ).toContainText(sessionTitle, { timeout: 30_000 })
  } catch (error) {
    brave.releaseHeldRequest()
    model.releaseFinalAnswer()
    await Promise.allSettled([
      modelProvider.close(),
      new Promise<void>((resolve) => model.server.close(() => resolve())),
      new Promise<void>((resolve) => brave.server.close(() => resolve())),
    ])
    throw error
  } finally {
    brave.releaseHeldRequest()
    model.releaseFinalAnswer()
    await first.close()
  }

  // Restart against the same workspace: the settled disclosure is rebuilt from
  // persisted activity, not from anything the previous process still held.
  const second = await launch()
  try {
    const page = await second.firstWindow()
    await page.getByRole('tab', { name: 'Run' }).click()
    const primaryNavigation = page.getByRole('complementary', {
      name: 'Primary navigation',
    })
    const priorSession = primaryNavigation.getByRole('button', {
      name: new RegExp(`^${escapeRegExp(sessionTitle)}`),
    }).first()
    await expect(priorSession).toBeVisible({ timeout: 60_000 })
    await priorSession.click()

    const restored = page.getByRole('button', { name: /^Research activity/ })
    await expect(restored).toHaveCount(1, { timeout: 60_000 })
    await restored.click()
    const disclosure = page.getByLabel('Web research activity')
    await expect(disclosure.getByText('Searched Brave')).toBeVisible()
    await expect(
      disclosure.getByRole('button', { name: /^Open http.*ann-arbor-ice-cream$/ }),
    ).toBeVisible()
    await expect(
      disclosure.getByRole('button', { name: /^Open http.*washtenaw-dairy$/ }),
    ).toBeVisible()
  } finally {
    await Promise.allSettled([
      second.close(),
      modelProvider.close(),
      new Promise<void>((resolve) => model.server.close(() => resolve())),
      new Promise<void>((resolve) => brave.server.close(() => resolve())),
    ])
  }
})

function createHeldModelFixture(upstream: string) {
  let announceFinal: (() => void) | undefined
  const finalAnswerReady = new Promise<void>((resolve) => { announceFinal = resolve })
  let release: (() => void) | undefined
  const released = new Promise<void>((resolve) => { release = resolve })
  const server = http.createServer((request, response) => {
    // Request handling is asynchronous; failures are returned to the client.
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const method = request.method ?? 'GET'
      const result = await fetch(new URL(request.url ?? '/', upstream), {
        method,
        headers: { 'content-type': 'application/json' },
        ...(method === 'GET' ? {} : { body: Buffer.concat(chunks) }),
        signal: AbortSignal.timeout(60_000),
      })
      const body = await result.text()
      if (body.includes('BRAVE_PATH_CONFIRMED')) {
        announceFinal?.()
        await released
      }
      response.writeHead(result.status, {
        'content-type': result.headers.get('content-type') ?? 'application/json',
      })
      response.end(body)
    })().catch((error: unknown) => {
      response.writeHead(502)
      response.end(String(error))
    })
  })
  return { server, finalAnswerReady, releaseFinalAnswer: () => release?.() }
}

/**
 * The Brave fixture, with the second source page held until released.
 *
 * Holding a response rather than sleeping is what makes the running state
 * deterministic: the test knows the read is in flight because the fixture is
 * still inside its handler.
 */
function createHeldBraveSearchFixture(expectedSecret: string): {
  readonly server: http.Server
  readonly heldRequestReceived: Promise<void>
  readonly heldHost: string
  releaseHeldRequest(): void
} {
  let announceHeld: (() => void) | undefined
  const heldRequestReceived = new Promise<void>((resolve) => {
    announceHeld = resolve
  })
  let release: (() => void) | undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const server = http.createServer((request, response) => {
    const origin = `http://${request.headers.host ?? '127.0.0.1'}`
    const url = new URL(request.url ?? '/', origin)
    if (request.method === 'GET' && url.pathname === '/source/ann-arbor-ice-cream') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(sourcePage(
        'Ann Arbor Ice Cream Source',
        'This current Ann Arbor ice cream source describes a local creamery and its frozen desserts.',
      ))
      return
    }
    if (request.method === 'GET' && url.pathname === '/source/washtenaw-dairy') {
      announceHeld?.()
      void released.then(() => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(sourcePage(
          'Washtenaw Dairy',
          'This current Ann Arbor dairy serves ice cream and frozen desserts in Ann Arbor.',
        ))
      })
      return
    }
    if (
      request.method !== 'GET' ||
      url.pathname !== '/res/v1/web/search' ||
      request.headers['x-subscription-token'] !== expectedSecret
    ) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: 'Unauthorized Brave fixture request' }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      web: {
        results: [
          { title: 'Ann Arbor Ice Cream Source', url: `${origin}/source/ann-arbor-ice-cream`, description: 'Current Ann Arbor ice cream source.' },
          { title: 'Washtenaw Dairy', url: `${origin}/source/washtenaw-dairy`, description: 'Local ice cream and donuts.' },
          { title: 'Ann Arbor Observer', url: 'https://annarborobserver.com/ice-cream/', description: 'Local ice cream guide.' },
        ],
      },
    }))
  })
  return {
    server,
    heldRequestReceived,
    heldHost: '127.0.0.1',
    releaseHeldRequest: () => release?.(),
  }
}

function sourcePage(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title></head>
    <body><main><h1>${title}</h1><p>
    ${body} The page contains enough directly observed evidence for Web Researcher to
    cite this exact source URL in the research result without relying on a search snippet.
    </p></main></body></html>`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function createWebResearcherProject(projectRoot: string): Promise<void> {
  const agentDirectory = path.join(projectRoot, 'agents', 'web-researcher')
  const personaPath = path.join(
    repoRoot,
    'agents',
    'web-researcher',
    'web-researcher.md',
  )
  // Set, not replace: the bundled persona may legitimately stop declaring
  // either field, and this journey still has to dispatch to the fixture.
  const fixturePersona = setFrontMatterFields({
    fields: { model: 'fixture/research-web', provider: 'openai' },
    file: personaPath,
    source: await fs.readFile(personaPath, 'utf8'),
  })
  await fs.mkdir(agentDirectory, { recursive: true })
  await fs.writeFile(
    path.join(agentDirectory, 'web-researcher.md'),
    fixturePersona,
    'utf8',
  )
  await fs.cp(
    path.join(repoRoot, 'agents', 'web-researcher', 'skills', 'web-research'),
    path.join(agentDirectory, 'skills', 'web-research'),
    { recursive: true },
  )
}

async function seedAcquisitionSettings(userDataPath: string): Promise<void> {
  await fs.mkdir(userDataPath, { recursive: true })
  await fs.writeFile(
    path.join(userDataPath, 'research-acquisition-settings.json'),
    JSON.stringify({
      schemaVersion: 2,
      providerPriority: ['brave', 'exa'],
      providers: {
        exa: { enabled: false, status: 'unknown' },
        brave: { enabled: true, status: 'connected' },
        firecrawl: { enabled: false, status: 'unknown' },
      },
      budgets: {
        maximumSearchCalls: 20,
        maximumBrowserFallbacks: 10,
        maximumManagedReaderCalls: 5,
        maximumModelExtractions: 20,
      },
      extractionModel: null,
    }),
    'utf8',
  )
}

async function configureModelProvider(
  page: Page,
  providerUrl: string,
  providerSecret: string,
): Promise<void> {
  await page.getByLabel('Settings', { exact: true }).click()
  await page.getByRole('button', { name: 'Add' }).click()
  await page.getByLabel('Connection type').selectOption('openai-compatible')
  await page.getByLabel('Name').fill('Web Researcher Fixture')
  await page.getByLabel('Base URL').fill(`${providerUrl}/v1`)
  await page.getByRole('textbox', { name: 'API key', exact: true }).fill(providerSecret)
  await page.getByRole('button', { name: 'Save & Validate' }).click()
  await page.getByRole('button', { name: /^Web Researcher Fixture/ }).click()
  await page.getByRole('switch', { name: 'Enable fixture/research-web' }).click()
  await page.getByLabel('Default model').click()
  const modelDialog = page.getByRole('dialog', { name: 'Select model' })
  await modelDialog.getByPlaceholder('Search models...').fill('fixture/research-web')
  await modelDialog.getByText('fixture/research-web', { exact: true }).click()
  await page.getByRole('button', { name: 'Close' }).click()
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Brave fixture address is unavailable')
  return `http://127.0.0.1:${address.port}`
}
