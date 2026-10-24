import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { setFrontMatterFields } from '../support/config-rewrite.js'
import { startOpenAiToolLoopFixture } from '../support/openai-tool-loop-fixture.js'
import { INSUFFICIENT_WEB_RESEARCH_RESPONSE } from '../../domains/browser/web-research-evidence.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const prompt = 'Conduct for me online research on ice creams in Ann Arbor.'

test('Web Researcher returns an acquired Brave source as a clickable link', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const modelProvider = await startOpenAiToolLoopFixture(repoRoot)
  const braveRequests: string[] = []
  const braveSecret = `brave-e2e-${Date.now()}`
  const brave = createBraveSearchFixture(braveSecret, braveRequests)
  const braveBaseUrl = await listen(brave)
  const sourceUrl = `${braveBaseUrl}/source/ann-arbor-ice-cream`
  const secondSourceUrl = `${braveBaseUrl}/source/washtenaw-dairy`
  const projectRoot = testInfo.outputPath('web-researcher-project')
  const userDataPath = testInfo.outputPath('web-researcher-user-data')
  const workspacePath = testInfo.outputPath('web-researcher-workspace')
  const modelSecret = `web-researcher-model-${Date.now()}`

  await Promise.all([
    createWebResearcherProject(projectRoot),
    seedAcquisitionSettings(userDataPath),
    fs.mkdir(workspacePath, { recursive: true }),
  ])

  const app = await electron.launch({
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
      OPENAI_BASE_URL: `${modelProvider.url}/v1`,
      BRAVE_SEARCH_API_KEY: braveSecret,
    },
  })

  try {
    const page = await app.firstWindow()
    await configureModelProvider(page, modelProvider.url, modelSecret)
    await page.getByRole('tab', { name: 'Run' }).click()
    await page.getByRole('button', { name: 'Search Agents' }).click()
    const search = page.getByRole('searchbox', { name: 'Search Agents' })
    await search.fill('web-researcher')
    await page.getByRole('button', { name: /^Web Researcher/i }).click()

    const composer = page.getByPlaceholder('Send a message to the selected agents...')
    await composer.fill(prompt)
    await page.getByRole('button', { name: 'Send message' }).click()

    const answer = page.locator('.group.is-assistant').filter({
      hasText: 'BRAVE_PATH_CONFIRMED',
    }).last()
    await expect(answer).toBeVisible({ timeout: 45_000 })
    await expect(answer.getByText('Web Researcher')).toBeVisible()
    const sourceLink = answer.getByRole('button', {
      name: 'Ann Arbor Ice Cream Source',
    })
    await expect(sourceLink).toBeVisible()
    await sourceLink.click()
    await expect(page.getByText(sourceUrl, { exact: true })).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Open link', exact: true }),
    ).toBeVisible()
    expect(braveRequests).toEqual(['ice cream shops in Ann Arbor Michigan'])

    const dispatchEvents = await readJsonLinesBelow(
      workspacePath,
      'capability-dispatch-events.jsonl',
    )
    const researchEvents = dispatchEvents.filter(
      (event) => event.capabilityId === 'research.web',
    )
    expect(researchEvents.map((event) => event.type)).toEqual([
      'capability.dispatch.requested',
      'capability.dispatch.started',
      'capability.dispatch.completed',
      'capability.dispatch.requested',
      'capability.dispatch.started',
      'capability.dispatch.completed',
      'capability.dispatch.requested',
      'capability.dispatch.started',
      'capability.dispatch.completed',
    ])
    expect(researchEvents.some((event) => event.type === 'capability.dispatch.rejected'))
      .toBe(false)

    const activityFiles = await findFiles(workspacePath, 'research-acquisition.json')
    expect(activityFiles).toHaveLength(1)
    const activity = JSON.parse(await fs.readFile(activityFiles[0] ?? '', 'utf8')) as unknown
    expect(Array.isArray(activity)).toBe(true)
    expect(activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'search',
        state: 'completed',
        agentPath: 'agents/web-researcher',
        resultCount: 3,
      }),
      expect.objectContaining({
        action: 'acquire',
        state: 'completed',
        agentPath: 'agents/web-researcher',
        canonicalUrl: sourceUrl,
      }),
      expect.objectContaining({
        action: 'acquire',
        state: 'completed',
        agentPath: 'agents/web-researcher',
        canonicalUrl: secondSourceUrl,
      }),
    ]))

    // The reply that contained all of that is itself accounted for. The turn's
    // lifecycle and the search it caused share one assignment journal, so the
    // user-visible answer can be tied to the evidence behind it.
    // The visible answer arrives from the display stream, which runs ahead of
    // persistence on purpose, so the durable outcome is awaited rather than
    // assumed to be there the moment the text is.
    const journalBytes = await waitForJournalTerminal(workspacePath)
    const journalEvents = journalBytes
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as unknown)
      .filter(isRecord)

    const agentTurnEvents = journalEvents.filter(
      (event) => event.streamKind === 'agent.turn',
    )
    expect(agentTurnEvents.map((event) => event.type)).toEqual([
      'agent.turn.started',
      'agent.turn.prepared',
      'agent.turn.completed',
    ])
    expect(
      journalEvents.some((event) => event.streamKind === 'capability.dispatch'),
    ).toBe(true)
    const turnStreamIds = new Set(
      agentTurnEvents.map((event) => event.streamId),
    )
    expect(turnStreamIds.size).toBe(1)

    // The route it actually took, and the reply it actually kept.
    const prepared = agentTurnEvents.find(
      (event) => event.type === 'agent.turn.prepared',
    )
    const preparedPayload = isRecord(prepared?.payload) ? prepared.payload : {}
    expect(preparedPayload.outcome).toBe('success')
    expect(preparedPayload.route).toBe('mcp-native')
    expect(typeof preparedPayload.assistantMessageId).toBe('string')
    const completed = agentTurnEvents.find(
      (event) => event.type === 'agent.turn.completed',
    )
    const completedPayload = isRecord(completed?.payload) ? completed.payload : {}
    expect(completedPayload.assistantMessageId).toBe(
      preparedPayload.assistantMessageId,
    )

    // Nothing the journal must never hold.
    for (const forbidden of [braveSecret, modelSecret, prompt, 'x-subscription-token']) {
      expect(journalBytes).not.toContain(forbidden)
    }

    // Online research, not Deep Research: no plan was drafted and no worker
    // lane was opened for this turn.
    expect(await findFiles(workspacePath, 'deep-research-plan.json')).toEqual([])
  } finally {
    await Promise.allSettled([
      app.close(),
      modelProvider.close(),
      new Promise<void>((resolve) => brave.close(() => resolve())),
    ])
  }
})

test('Web Researcher enforced web evidence replaces an answer citing a discovery-only URL', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const modelProvider = await startOpenAiToolLoopFixture(repoRoot)
  const braveRequests: string[] = []
  const braveSecret = `brave-e2e-enforced-${Date.now()}`
  const brave = createBraveSearchFixture(braveSecret, braveRequests)
  const braveBaseUrl = await listen(brave)
  const sourceUrl = `${braveBaseUrl}/source/ann-arbor-ice-cream`
  const secondSourceUrl = `${braveBaseUrl}/source/washtenaw-dairy`
  // The third search candidate is never acquired, so the provider's citation of
  // it is the leak this journey proves closed.
  const discoveryOnlyUrl = 'https://annarborobserver.com/ice-cream/'
  const projectRoot = testInfo.outputPath('web-researcher-project')
  const userDataPath = testInfo.outputPath('web-researcher-user-data')
  const workspacePath = testInfo.outputPath('web-researcher-workspace')
  const modelSecret = `web-researcher-model-${Date.now()}`

  await Promise.all([
    createWebResearcherProject(projectRoot),
    seedAcquisitionSettings(userDataPath),
    fs.mkdir(workspacePath, { recursive: true }),
  ])

  const app = await electron.launch({
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
      PIPELINE_WEB_EVIDENCE_LINKS: 'enforce',
      OPENAI_API_KEY: modelSecret,
      OPENAI_BASE_URL: `${modelProvider.url}/v1`,
      BRAVE_SEARCH_API_KEY: braveSecret,
    },
  })

  try {
    const page = await app.firstWindow()
    await configureModelProvider(page, modelProvider.url, modelSecret)
    await page.getByRole('tab', { name: 'Run' }).click()
    await page.getByRole('button', { name: 'Search Agents' }).click()
    const search = page.getByRole('searchbox', { name: 'Search Agents' })
    await search.fill('web-researcher')
    await page.getByRole('button', { name: /^Web Researcher/i }).click()

    const composer = page.getByPlaceholder('Send a message to the selected agents...')
    await composer.fill(prompt)
    await page.getByRole('button', { name: 'Send message' }).click()

    // The provider cited all three search candidates, two acquired and one
    // discovery-only. Under enforcement the whole candidate fails closed: the
    // bubble holds the canonical insufficient-evidence response and nothing
    // from the unsafe answer.
    const answer = page.locator('.group.is-assistant').filter({
      hasText: "couldn't verify a reliable answer",
    }).last()
    await expect(answer).toBeVisible({ timeout: 45_000 })
    await expect(answer.getByText('Web Researcher')).toBeVisible()
    await expect(answer).toContainText(INSUFFICIENT_WEB_RESEARCH_RESPONSE)
    await expect(page.getByText('BRAVE_PATH_CONFIRMED')).toHaveCount(0)
    await expect(answer.getByText(discoveryOnlyUrl)).toHaveCount(0)
    await expect(answer.getByText(sourceUrl)).toHaveCount(0)
    // No raw structured data reaches the display.
    const displayedText = await answer.innerText()
    expect(displayedText).not.toContain('{')
    expect(displayedText).not.toContain('"canonicalUrl"')

    // The two acquired sources are still recorded even though the answer that
    // cited them was rejected.
    const activityFiles = await findFiles(workspacePath, 'research-acquisition.json')
    expect(activityFiles).toHaveLength(1)
    const activity = JSON.parse(await fs.readFile(activityFiles[0] ?? '', 'utf8')) as unknown
    expect(Array.isArray(activity)).toBe(true)
    expect(activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'acquire',
        state: 'completed',
        agentPath: 'agents/web-researcher',
        canonicalUrl: sourceUrl,
      }),
      expect.objectContaining({
        action: 'acquire',
        state: 'completed',
        agentPath: 'agents/web-researcher',
        canonicalUrl: secondSourceUrl,
      }),
    ]))

    // The durable outcome, awaited rather than assumed: the turn completed and
    // the persisted reply is the same canonical response the display showed —
    // not the candidate, and not structured data.
    const journalBytes = await waitForJournalTerminal(workspacePath)
    expect(journalBytes).toContain('"agent.turn.completed"')
    const chatFiles = await findFiles(workspacePath, 'chat.jsonl')
    expect(chatFiles.length).toBeGreaterThan(0)
    const chatMessages = (await Promise.all(
      chatFiles.map(async (file) =>
        (await fs.readFile(file, 'utf8'))
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as unknown)
          .filter(isRecord)),
    )).flat()
    const assistantReplies = chatMessages.filter(
      (message) =>
        message.role === 'assistant' &&
        isRecord(message.speaker) &&
        message.speaker.id === 'web-researcher',
    )
    expect(assistantReplies).toHaveLength(1)
    expect(assistantReplies[0]?.text).toBe(INSUFFICIENT_WEB_RESEARCH_RESPONSE)
  } finally {
    await Promise.allSettled([
      app.close(),
      modelProvider.close(),
      new Promise<void>((resolve) => brave.close(() => resolve())),
    ])
  }
})

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

function createBraveSearchFixture(
  expectedSecret: string,
  requests: string[],
): http.Server {
  return http.createServer((request, response) => {
    const origin = `http://${request.headers.host ?? '127.0.0.1'}`
    const url = new URL(request.url ?? '/', origin)
    if (request.method === 'GET' && url.pathname === '/source/ann-arbor-ice-cream') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><head><title>Ann Arbor Ice Cream Source</title></head>
        <body><main><h1>Ann Arbor Ice Cream Source</h1><p>
        This current Ann Arbor ice cream source describes a local creamery and its frozen
        desserts. The page contains enough directly observed evidence for Web Researcher to
        cite this exact source URL in the research result without relying on a search snippet.
        </p></main></body></html>`)
      return
    }
    if (request.method === 'GET' && url.pathname === '/source/washtenaw-dairy') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><head><title>Washtenaw Dairy</title></head>
        <body><main><h1>Washtenaw Dairy</h1><p>
        This current Ann Arbor dairy serves ice cream and frozen desserts in Ann Arbor.
        The page contains enough directly observed evidence for Web Researcher to cite this
        exact source URL in the research result without relying on a search snippet.
        </p></main></body></html>`)
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
    requests.push(url.searchParams.get('q') ?? '')
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

async function readJsonLinesBelow(
  root: string,
  basename: string,
): Promise<Readonly<Record<string, unknown>>[]> {
  const files = await findFiles(root, basename)
  const events: Readonly<Record<string, unknown>>[] = []
  for (const file of files) {
    const contents = await fs.readFile(file, 'utf8')
    for (const line of contents.split('\n').filter(Boolean)) {
      const value: unknown = JSON.parse(line)
      if (isRecord(value)) events.push(value)
    }
  }
  return events
}

/**
 * The assignment journal, once the turn's terminal has actually landed.
 *
 * The reply becomes visible from the ephemeral text stream, which is published
 * before the message is stored and before the terminal is appended. Reading
 * the file the instant the text appears would therefore be reading mid-turn.
 *
 * A workspace holds more than one journal: the conversation activity keeps its
 * own, under the same `journal.jsonl` name. The one to read is therefore chosen
 * by the scope its events declare, never by where the directory walk reached it
 * first. Waiting for the walk to return exactly one file instead would wait for
 * something that never happens, and reporting the turn as having no terminal.
 */
async function waitForJournalTerminal(workspacePath: string): Promise<string> {
  const deadline = Date.now() + 30_000
  let latest = ''
  while (Date.now() < deadline) {
    const assignments = await findAssignmentJournals(workspacePath)
    // Two would mean the run produced assignments this test cannot tell apart,
    // and picking either one would decide the assertion by directory order.
    if (assignments.length > 1) {
      throw new Error(
        `Expected one assignment journal, found ${assignments.length}:\n${assignments
          .map((assignment) => assignment.filePath)
          .join('\n')}`,
      )
    }
    const assignment = assignments[0]
    if (assignment) {
      latest = assignment.contents
      if (/"agent\.turn\.(?:completed|failed|cancelled)"/.test(latest)) {
        return latest
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(
    `The agent turn never reached a terminal event. Journal so far:\n${latest}`,
  )
}

/**
 * Every journal below the workspace whose own events declare the assignment
 * scope. A journal whose first line has not landed yet declares nothing, so it
 * is not ready rather than a rival candidate.
 */
async function findAssignmentJournals(
  workspacePath: string,
): Promise<{ readonly filePath: string; readonly contents: string }[]> {
  const assignments: { filePath: string; contents: string }[] = []
  for (const filePath of await findFiles(workspacePath, 'journal.jsonl')) {
    const contents = await fs.readFile(filePath, 'utf8')
    if (declaredScopeKind(contents) === 'assignment') {
      assignments.push({ filePath, contents })
    }
  }
  return assignments
}

/**
 * The scope a journal claims for itself, read from its first complete event.
 * Every event in one journal carries the same scope, and the trailing line may
 * still be mid-write while the turn runs.
 */
function declaredScopeKind(contents: string): string | undefined {
  for (const line of contents.split('\n')) {
    if (!line) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (isRecord(event) && typeof event.scopeKind === 'string') {
      return event.scopeKind
    }
  }
  return undefined
}

async function findFiles(root: string, basename: string): Promise<string[]> {
  const matches: string[] = []
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) matches.push(...await findFiles(target, basename))
    else if (entry.isFile() && entry.name === basename) matches.push(target)
  }
  return matches
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
