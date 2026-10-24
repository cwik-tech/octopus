/**
 * The Deep Research journey a user actually walks: they pick Deep Research,
 * type a research request into Run chat, answer the intake questions, approve
 * the plan, and read the finished report.
 *
 * The approved plan uses `section_dossiers` over two sections, so this journey
 * exercises the section writer, the synthesis budget and the assignment-owned
 * quality review rather than collapsing into one single-pass draft. Only the
 * model provider and the researched web site are replaced, and both only at
 * the network boundary: the workflow, acquisition, drafting, synthesis,
 * quality, persistence and UI projection code all run for real, over the real
 * loopback API and the real filesystem stores.
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isSessionTask, type SessionTask } from '../../contracts/sessions.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import {
  startOpenAiToolLoopFixture,
  type OpenAiToolLoopFixture,
} from '../support/openai-tool-loop-fixture.js'
import {
  replaceYamlFields,
  setFrontMatterFields,
} from '../support/config-rewrite.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const providerModel = 'fixture/deep-research'
const providerSecret = 'deep-research-chat-journey-secret'
const connectionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const terminalTaskStatuses = new Set(['done', 'failed', 'blocked', 'cancelled'])

const RESEARCH_REQUEST = 'conduct deep research on sushi places in detroit downtown.'
const INTAKE_ANSWER = '1. yes. 2. for me.3.quality4. no'
const REPORT_TITLE = 'Downtown Detroit Sushi: Where One Diner Should Book'

/** One page per planned section, each stating its own citable sentence. */
const EVIDENCE_PAGES = [
  {
    route: '/sushi-quality',
    sectionTitle: 'Sushi quality and menus',
    title: 'Kaisen Omakase — downtown Detroit',
    sentence:
      'The downtown Detroit omakase counter serves eighteen nigiri courses nightly.',
  },
  {
    route: '/sushi-experience',
    sectionTitle: 'Room, service, and access',
    title: 'Kaisen Omakase — the room',
    sentence:
      'The downtown Detroit dining room seats twelve guests at one counter.',
  },
] as const

test('Deep Research answers a typed sushi request with a two-section report a reload still shows', async ({}, testInfo) => {
  test.setTimeout(300_000)

  const userDataPath = testInfo.outputPath('sushi-user-data')
  const workspacePath = path.join(userDataPath, 'workspace')
  const projectRootPath = testInfo.outputPath('sushi-project')
  const evidenceSite = createEvidenceSite()
  let providerFixture: OpenAiToolLoopFixture | undefined
  let app: ElectronApplication | undefined
  let apiBaseUrl: string | null = null
  let launchedTask: SessionTask | null = null

  try {
    const evidenceSiteUrl = await listen(evidenceSite)
    const sourceUrls = EVIDENCE_PAGES.map(
      (page) => `${evidenceSiteUrl.replace('127.0.0.1', 'localhost')}${page.route}`,
    )

    // Replaced only at the process boundary: a real model provider is paid and
    // non-deterministic, and this journey must assert an exact report.
    providerFixture = await startOpenAiToolLoopFixture(
      repoRoot,
      'openai-tool-loop-server.mjs',
      {
        env: {
          PIPELINE_DEEP_RESEARCH_FIXTURE_SCENARIO: 'sushi-section-dossiers',
          PIPELINE_DEEP_RESEARCH_FIXTURE_SOURCE_URLS: JSON.stringify(sourceUrls),
        },
      },
    )

    await Promise.all([
      fs.mkdir(projectRootPath, { recursive: true }),
      fs.mkdir(workspacePath, { recursive: true }),
      fs.mkdir(userDataPath, { recursive: true }),
    ])
    await Promise.all([
      fs.writeFile(
        path.join(userDataPath, 'browser-settings.json'),
        JSON.stringify({ version: 1, mode: 'headless' }),
        'utf8',
      ),
      seedRunChatProvider(userDataPath, providerFixture.url),
      // Before launch, so desktop seeding keeps it: the shipped General Agent
      // names a CLI provider, and every untargeted turn would reach it.
      writeFrontDoorFixture(projectRootPath),
    ])

    // Setup, not a journey step: the app lists this session on its first render,
    // so the test never has to reload the window mid-conversation.
    const session = await new FileSystemSessionStore(workspacePath).createSession({
      title: 'Detroit sushi research',
    })

    app = await launchDesktop({
      projectRootPath,
      providerUrl: providerFixture.url,
      userDataPath,
      workspacePath,
    })
    const page = await app.firstWindow()
    apiBaseUrl = await desktopApiBaseUrl(page)
    await routeSeededDeepResearchProject(projectRootPath)

    await openSession(page, session.title)

    // ── The user commits to Deep Research ───────────────────────────────────
    // An untargeted turn belongs to the General Agent, which answers it and
    // starts nothing. Deep Research intake is the Coordinator's, and it runs
    // only under a Workflow the user chose, so the user picks it first and the
    // request they type carries that choice.
    await openWorkflowsPane(page)
    // Exact: the row's own "Preview workflow …" control shares the name.
    await page.getByRole('button', { name: 'Deep Research Report', exact: true })
      .click()

    // ── The user asks for the research ──────────────────────────────────────
    const composer = page.getByRole('textbox').last()
    await composer.click()
    await composer.fill(RESEARCH_REQUEST)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('log').first().getByText(RESEARCH_REQUEST))
      .toBeVisible({ timeout: 30_000 })

    // ── The app asks the Deep Research clarification questions ──────────────
    await expect(
      page.getByRole('log').first().getByText('Who is this report for?'),
    ).toBeVisible({ timeout: 60_000 })
    await expect(
      page.getByRole('log').first()
        .getByText('Rank on food quality, price, or both?'),
    ).toBeVisible()
    // The same conversation continues inside the workspace the choice opened.
    const workspace = page.getByTestId('deep-research-workspace')
    await expect(workspace).toBeVisible({ timeout: 30_000 })

    // ── The user answers, and planning starts on its own ────────────────────
    const planningComposer = page.getByRole('textbox').last()
    await planningComposer.click()
    await planningComposer.fill(INTAKE_ANSWER)
    await page.keyboard.press('Enter')
    await expect(
      page.getByRole('log').first().getByText(/Intake is complete/),
    ).toBeVisible({ timeout: 60_000 })

    // Real planning runs on its own, then the proposal the user approves.
    await expect(
      workspace.getByText('Canonical Research Brief', { exact: true }),
    ).toBeVisible({ timeout: 120_000 })
    await expect(
      workspace.getByText('Proposed Research Plan', { exact: true }),
    ).toBeVisible()
    await workspace.getByRole('button', { name: 'Execution policy' }).click()
    await expect(
      workspace
        .getByTestId('deep-research-execution-policy')
        .getByText(/Section dossiers · up to 2 parallel drafts/),
    ).toBeVisible()

    // ── The user approves and the run starts ────────────────────────────────
    const taskResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/sessions/${session.id}/tasks`),
    )
    await workspace.getByRole('button', {
      name: 'Approve & start research',
      exact: true,
    }).click()
    const taskResponse = await taskResponsePromise
    const taskBody: unknown = await taskResponse.json()
    expect(taskResponse.status(), JSON.stringify(taskBody)).toBe(202)
    launchedTask = requireSessionTask(taskBody, 'Task creation response')

    await expect(
      workspace.getByText('Research in Progress', { exact: true }),
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      workspace.getByText('Attention Required', { exact: true }),
    ).toHaveCount(0)

    const completedTask = await waitForTerminalTask(apiBaseUrl, launchedTask)
    expect(completedTask.status, completedTask.error).toBe('done')
    const completedRunPath = requireTaskRunPath(completedTask)

    // ── A reload still shows the finished report ────────────────────────────
    await page.reload()
    await openSession(page, session.title)
    await expect(workspace).toBeVisible({ timeout: 30_000 })
    const deliveryStage = workspace.getByTestId(
      'deep-research-stage-final-documentation',
    )
    await expect(deliveryStage).toBeVisible({ timeout: 30_000 })
    await expect(
      workspace.getByRole('tree').getByText('final-report.md', { exact: true }),
    ).toBeVisible()

    // ── The delivered result is the research report, not a blocker ──────────
    await expect(workspace.getByText('Deep Research Blocked')).toHaveCount(0)
    await deliveryStage.getByRole('button', { name: 'Open report' }).click()
    await expect(
      page.getByRole('heading', { name: REPORT_TITLE }),
    ).toBeVisible({ timeout: 30_000 })
    // By href, not by label: publication legitimately rewrites a source label
    // to the page's own title, and the link the reader can follow is the
    // contract.
    for (const sourceUrl of sourceUrls) {
      await expect(
        page.getByRole('link').and(page.locator(`[href="${sourceUrl}"]`)).first(),
      ).toBeVisible()
    }
    await page.keyboard.press('Escape')

    // The requested publication output travels the normal artifact path.
    const downloadedDocx = await deliveryStage
      .getByRole('button', { name: 'Download' })
      .evaluate(async (link: HTMLAnchorElement) => {
        const response = await fetch(link.href)
        const bytes = new Uint8Array(await response.arrayBuffer())
        return {
          contentType: response.headers.get('content-type'),
          ok: response.ok,
          prefix: Array.from(bytes.slice(0, 2)),
        }
      })
    expect(downloadedDocx).toEqual({
      contentType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ok: true,
      prefix: [0x50, 0x4b],
    })

    // ── The persisted primary artifact agrees with the screen ───────────────
    const files = await walkFiles(completedRunPath)
    const finalReport = await fs.readFile(
      requireFile(files, 'final-report.md'),
      'utf8',
    )
    expect(finalReport).toContain(REPORT_TITLE)
    expect(finalReport).not.toContain('Deep Research Blocked')
    expect(finalReport).not.toMatch(/I (cannot|can't|am unable)/i)
    // Exactly once: a synthesis pass that repeated every section produced a
    // report that still contained every sentence a `toContain` check wanted.
    for (const evidencePage of EVIDENCE_PAGES) {
      expect(
        occurrences(finalReport, evidencePage.sentence),
        `"${evidencePage.sentence}" should appear once in the report`,
      ).toBe(1)
      expect(occurrences(finalReport, `\n## ${evidencePage.sectionTitle}\n`))
        .toBe(1)
      expect(finalReport).toContain(sourceUrls[EVIDENCE_PAGES.indexOf(evidencePage)])
    }
    requireFile(files, 'final-report.docx')

    // Both sections went through the repaired section-dossier route.
    for (const sectionId of ['sushi-quality', 'sushi-experience']) {
      requireFile(files, path.join('research', 'sections', sectionId, 'dossier-wave-0.json'))
      const draft = await fs.readFile(
        requireFile(files, path.join('research', 'sections', sectionId, 'draft-wave-0.md')),
        'utf8',
      )
      expect(draft).not.toMatch(/section_complete/)
      expect(draft).not.toMatch(/I (cannot|can't|am unable)/i)
    }
    requireFile(files, path.join('research', 'quality', 'current-verdict.json'))
  } finally {
    try {
      if (apiBaseUrl && launchedTask) {
        await cancelIfNonTerminal(apiBaseUrl, launchedTask)
      }
    } finally {
      const cleanupOperations: Promise<unknown>[] = [closeServer(evidenceSite)]
      if (app) cleanupOperations.push(app.close())
      if (providerFixture) cleanupOperations.push(providerFixture.close())
      await Promise.allSettled(cleanupOperations)
    }
  }
})

/**
 * Reveal the run inspector's Workflows pane.
 *
 * The inspector starts collapsed until the run workspace has settled, so this
 * waits on the pane itself rather than on the toggle that may not exist yet.
 */
async function openWorkflowsPane(page: Page): Promise<void> {
  const workflowsTab = page.getByRole('tab', { name: 'Workflows', exact: true })
  await expect.poll(async () => {
    if (await workflowsTab.isVisible().catch(() => false)) return 'ready'
    const toggle = page.getByRole('button', { name: 'Show inspector' })
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click().catch(() => undefined)
    }
    return 'waiting'
  }, { timeout: 60_000, intervals: [250, 500, 1_000] }).toBe('ready')
  await workflowsTab.click()
}

async function openSession(page: Page, title: string): Promise<void> {
  await page.getByRole('tab', { name: 'Run' }).click()
  const sessionButtons = page.getByRole('button', {
    name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
  })
  await expect(sessionButtons.first()).toBeVisible({ timeout: 30_000 })
  await sessionButtons.first().click()
}

/**
 * Point Run chat at the fixture. The receptionist reads the global default
 * model, and only a catalogued connection can be that default — a bare
 * provider name is replaced by whatever the catalogue happens to list first.
 */
async function seedRunChatProvider(
  userDataPath: string,
  baseUrl: string,
): Promise<void> {
  await fs.writeFile(
    path.join(userDataPath, 'provider-settings.json'),
    JSON.stringify({
      version: 1,
      connections: [{
        id: connectionId,
        kind: 'openai-compatible',
        name: 'Deep Research fixture',
        baseUrl: `${baseUrl}/v1`,
        enabled: true,
        status: 'connected',
        models: [{
          id: providerModel,
          name: 'Deep Research fixture',
          enabled: true,
          capabilities: ['chat'],
        }],
      }],
      cliEnabled: {},
      cliModelEnabled: {},
      defaultModel: { provider: `connection:${connectionId}`, model: providerModel },
    }),
    'utf8',
  )
}

/**
 * The General Agent, on the connection `seedRunChatProvider` catalogues.
 *
 * A provider outside the catalogue is not a fixture: the composer falls back
 * to whatever model is available, and on a developer machine that can be a
 * real CLI agent.
 */
async function writeFrontDoorFixture(projectRootPath: string): Promise<void> {
  const directory = path.join(projectRootPath, 'agents', 'general-agent')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, 'general-agent.md'),
    [
      '---',
      'name: general-agent',
      'description: General Agent — the Run front door.',
      'tier: orchestration',
      `provider: connection:${connectionId}`,
      `model: ${providerModel}`,
      'thinking: low',
      'system: true',
      '---',
      '',
      '# General Agent',
      '',
      'Answer the question.',
      '',
    ].join('\n'),
    'utf8',
  )
}

function createEvidenceSite(): http.Server {
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const page = EVIDENCE_PAGES.find((candidate) => candidate.route === url.pathname)
    if (!page) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end([
      '<!doctype html>',
      `<html><head><title>${page.title}</title></head>`,
      `<body><main><h1>${page.title}</h1>`,
      `<p>EVIDENCE: ${page.sentence}</p>`,
      '</main></body></html>',
    ].join(''))
  })
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Evidence fixture address is unavailable')
  }
  return `http://127.0.0.1:${address.port}`
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

async function routeSeededDeepResearchProject(projectRootPath: string): Promise<void> {
  const agentNames = [
    'brief-builder',
    'deep-research-publication-editor',
    'deep-research-writer',
    'editor',
    'evidence-critic',
    'quick-scout',
    'research-escalator',
    'research-planner',
    'research-plan-reviewer',
    'research-section-writer',
    'research-synthesizer',
    'web-researcher',
    'writer',
  ]
  // No team.yaml rewrite here. `TeamConfig` carries no top-level `provider` or
  // `model` (see `core/types.ts`), and the one provider field the schema still
  // accepts — `defaults.provider` — is documented there as retired and read
  // only so it can be reported as ignored. The rewrite that used to run here
  // matched nothing in any bundled team.yaml and could not have routed a
  // dispatch even if it had. What actually routes these journeys is the
  // persona front matter below and the teams.yaml host pair after it.
  for (const agentName of agentNames) {
    const agentPath = path.join(projectRootPath, 'agents', agentName, `${agentName}.md`)
    const source = await fs.readFile(agentPath, 'utf8').catch(() => null)
    if (source === null) continue
    await fs.writeFile(agentPath, routeAgentToFixture(agentPath, source), 'utf8')
  }
  // Replaced, not set: every registry entry declares its host routing today,
  // and an entry that lost it has no unambiguous place to insert it back into.
  // A registry that stops declaring it is news, so this fails loudly.
  const teamsRegistryPath = path.join(projectRootPath, 'teams.yaml')
  await fs.writeFile(
    teamsRegistryPath,
    replaceYamlFields({
      fields: { host_model: providerModel, host_provider: 'openai' },
      file: teamsRegistryPath,
      source: await fs.readFile(teamsRegistryPath, 'utf8'),
    }),
    'utf8',
  )
}

/**
 * Pin a seeded persona to the fixture provider and model.
 *
 * Set, not replaced. A bundled persona may legitimately stop declaring
 * `provider:`, and a rewrite that quietly matched nothing would leave this
 * journey dispatching to the real application default under a name that says
 * it exercises the fixture. `setFrontMatterFields` throws instead when there
 * is no front matter to pin the values in.
 */
function routeAgentToFixture(file: string, source: string): string {
  return setFrontMatterFields({
    fields: { model: providerModel, provider: 'openai' },
    file,
    source,
  })
}

async function launchDesktop(params: {
  projectRootPath: string
  providerUrl: string
  userDataPath: string
  workspacePath: string
}): Promise<ElectronApplication> {
  const executablePath = process.env.PIPELINE_DESKTOP_EXECUTABLE
    ? path.resolve(repoRoot, process.env.PIPELINE_DESKTOP_EXECUTABLE)
    : null
  return electron.launch({
    args: executablePath
      ? ['--disable-gpu', '--no-sandbox']
      : ['.', '--disable-gpu', '--no-sandbox'],
    cwd: repoRoot,
    ...(executablePath ? { executablePath } : {}),
    env: {
      ...fixtureDesktopEnvironment(),
      NODE_ENV: 'test',
      OPENAI_API_KEY: providerSecret,
      OPENAI_BASE_URL: `${params.providerUrl}/v1`,
      // The fixture reports token usage but no cost. Without a price the
      // runtime appends a budget warning to every answer, corrupting each
      // stage whose output is a machine contract. A real provider is priced.
      TEAM_PROVIDER_PRICING_JSON: JSON.stringify({
        'openai:*': { inputPerMillion: 0, outputPerMillion: 0 },
      }),
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: params.projectRootPath,
      PIPELINE_DESKTOP_USER_DATA: params.userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: params.workspacePath,
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
    },
  })
}

async function desktopApiBaseUrl(page: Page): Promise<string> {
  await page.waitForURL((url) => url.hash.includes('pipeline-api-base-url='))
  const baseUrl = await page.evaluate(() =>
    new URLSearchParams(window.location.hash.slice(1)).get('pipeline-api-base-url'),
  )
  if (!baseUrl) throw new Error('Desktop API URL is unavailable')
  return baseUrl
}

async function waitForTerminalTask(
  apiBaseUrl: string,
  task: SessionTask,
): Promise<SessionTask> {
  let current = task
  await expect.poll(async () => {
    current = await readTask(apiBaseUrl, task)
    return current.status
  }, {
    message: `Timed out waiting for Deep Research task ${task.id}`,
    timeout: 200_000,
    intervals: [250, 500, 1_000],
  }).toMatch(/^(done|failed|blocked|cancelled)$/)
  return current
}

async function readTask(
  apiBaseUrl: string,
  task: Pick<SessionTask, 'id' | 'sessionId'>,
): Promise<SessionTask> {
  const url = `${apiBaseUrl}/sessions/${task.sessionId}/tasks/${task.id}`
  const response = await fetch(url)
  const body: unknown = await response.json()
  expect(response.status, JSON.stringify(body)).toBe(200)
  return requireSessionTask(body, 'Task status response')
}

async function cancelIfNonTerminal(
  apiBaseUrl: string,
  task: SessionTask,
): Promise<void> {
  const current = await readTask(apiBaseUrl, task).catch(() => null)
  if (!current || terminalTaskStatuses.has(current.status)) return
  await fetch(`${apiBaseUrl}/sessions/${task.sessionId}/tasks/${task.id}`, {
    method: 'DELETE',
  }).catch(() => undefined)
}

async function walkFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(root, entry.name)
    return entry.isDirectory() ? walkFiles(entryPath) : [entryPath]
  }))
  return files.flat()
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function requireFile(files: readonly string[], suffix: string): string {
  const normalizedSuffix = suffix.split(path.sep).join('/')
  const match = files.find((filePath) =>
    filePath.split(path.sep).join('/').endsWith(normalizedSuffix),
  )
  if (match === undefined) {
    throw new Error(`Expected run artifact ${normalizedSuffix}`)
  }
  return match
}

function requireSessionTask(value: unknown, source: string): SessionTask {
  if (!isSessionTask(value)) {
    throw new Error(`${source} did not contain a valid session task`)
  }
  return value
}

function requireTaskRunPath(task: SessionTask): string {
  if (typeof task.runPath !== 'string' || task.runPath.length === 0) {
    throw new Error(`Completed task ${task.id} has no run path`)
  }
  return task.runPath
}
