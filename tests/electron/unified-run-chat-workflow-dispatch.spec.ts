import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod/v4'
import { buildChatMessage } from '../../services/session-service.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startDeterministicOpenAiServer } from './support/deterministic-openai-server.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

// The model the deterministic server advertises, offered through a provider
// connection so the composer's model catalog contains it.
const FIXTURE_CONNECTION_ID = 'unified-workflow-dispatch-fixture'
const FIXTURE_MODEL_ID = 'gpt-5.4-mini'

/**
 * Selecting a Workflow, refining it, and launching it once — all in one chat.
 *
 * The launch card is the part that needs a real desktop run: it depends on
 * persisted selection provenance, plan readiness, and task state together, and
 * on none of them being the sidebar tab. A component test can assert the rule
 * but not that the rule is wired to what the user actually sees.
 */
test('Run Chat offers Begin for a user-selected Workflow and launches it once', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const userDataPath = testInfo.outputPath('unified-workflow-user-data')
  const workspacePath = testInfo.outputPath('unified-workflow-workspace')
  const projectRoot = testInfo.outputPath('unified-workflow-project')
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
  ])
  await fs.cp(
    path.join(repoRoot, 'tests', 'fixtures', 'packaged-workflow-smoke'),
    projectRoot,
    { recursive: true },
  )
  // Written before launch so desktop seeding keeps it: the seed copies only
  // files the project root does not already have, and the shipped persona
  // runs the Codex CLI on the developer's own account.
  await writeFrontDoorFixture(projectRoot)

  // A stable title so the conversation can be opened by name; a relative
  // timestamp label re-renders and never settles for a click.
  const sessionStore = new FileSystemSessionStore(workspacePath)
  await sessionStore.createSession({ title: 'Unified workflow dispatch E2E' })

  // Each answer is matched on its own prompt, so request order cannot hand
  // the General Agent the Coordinator's decision or the other way round.
  const generalAgentReply =
    'GENERAL-AGENT-REPLY: a board overview needs recent sources and a word limit.'
  const deterministicOpenAi = await startDeterministicOpenAiServer({
    matchers: [
      {
        match: 'Run Orchestrator contract:',
        text: JSON.stringify({
          message: 'Packaged smoke fits; use Begin workflow when you are ready.',
          selectionAction: 'select',
          workflowId: 'packaged-smoke',
          launchIntent: 'none',
          deepResearchPlanAction: 'keep',
          deepResearchMissingInputs: [],
        }),
      },
      { match: 'Fixture persona: general-agent.', text: generalAgentReply },
    ],
  })
  await writeFixtureConnection(userDataPath, deterministicOpenAi.baseUrl)
  let app: ElectronApplication | undefined
  try {
    app = await launchDesktop({
      userDataPath,
      workspacePath,
      projectRoot,
      openAiBaseUrl: deterministicOpenAi.baseUrl,
    })
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    const apiBaseUrl = await rendererApiBaseUrl(page)
    await page
      .getByRole('button', { name: /^Unified workflow dispatch E2E\b/ })
      .first()
      .click()

    // Arrange: an ordinary conversation. Nothing is selected, so the General
    // Agent answers it. It may name a Workflow in prose, but nothing it says
    // may select one or offer to launch it.
    await sendComposerMessage(
      page,
      'Write a two-page market overview of the EU electric-vehicle charging ' +
        'sector for our board, so they can decide whether to enter that market ' +
        'in 2027. Use public sources from 2025 onward and keep it under 1200 words.',
    )
    // Wait for the answer itself. Asserting before the reply lands would pass
    // for the wrong reason.
    await expect
      .poll(async () => (await readTranscript(apiBaseUrl)).at(-1)?.role, {
        timeout: 60_000,
      })
      .toBe('assistant')
    const frontDoorReply = (await readTranscript(apiBaseUrl)).at(-1)
    expect(frontDoorReply?.speaker?.name).toBe('General Agent')
    expect(frontDoorReply?.text).toContain(generalAgentReply)
    await expect(
      page
        .getByRole('region', { name: 'Run chat' })
        .getByText(generalAgentReply)
        .first(),
    ).toBeVisible({ timeout: 30_000 })
    expect((await readPlan(apiBaseUrl))?.selectedWorkflow).toBeUndefined()
    await expect(
      page.getByRole('button', { name: 'Begin workflow' }),
      'an answer from the General Agent must not offer to launch anything',
    ).toHaveCount(0)

    // Act: the user picks the Workflow themselves. The target sidebar starts
    // collapsed in this window size, so open it first.
    const showInspector = page.getByRole('button', { name: 'Show inspector' })
    if (await showInspector.isVisible()) await showInspector.click()
    const workflowsTab = page.getByRole('tab', { name: 'Workflows', exact: true })
    await expect(workflowsTab).toBeVisible({ timeout: 30_000 })
    await workflowsTab.click()
    await page.getByRole('button', { name: /packaged[ -]smoke/i }).first().click()

    // Act: refine the brief in chat, without re-picking anything. There is no
    // plan for the pick to be written against yet, so this turn carries it as
    // a Workflow target and the Coordinator answers against it.
    await sendComposerMessage(
      page,
      'Focus it on public fast-charging networks in Germany and France.',
    )

    // Assert: the click is what makes this a user selection. Polling on
    // provenance rather than on the workflow id matters here: the Coordinator
    // names this same Workflow, and only the user's pick may launch it.
    await expect
      .poll(
        async () =>
          (await readPlan(apiBaseUrl))?.selectedWorkflow?.selectionSource,
        { timeout: 60_000 },
      )
      .toBe('user')
    const selectedPlan = await readPlan(apiBaseUrl)
    expect(selectedPlan?.selectedWorkflow?.id).toBe('packaged-smoke')
    expect(selectedPlan?.status).toBe('ready')

    // The refinement did not clear or replace the user's choice: the same
    // Workflow still governs, still recorded as theirs.
    await expect
      .poll(
        async () => {
          const plan = await readPlan(apiBaseUrl)
          return `${plan?.selectedWorkflow?.id}:${plan?.selectedWorkflow?.selectionSource}`
        },
        { timeout: 60_000 },
      )
      .toBe('packaged-smoke:user')
    await expect
      .poll(
        async () =>
          (await readTranscript(apiBaseUrl)).filter(
            (message) => message.role === 'user',
          ).length,
        { timeout: 60_000 },
      )
      .toBe(2)

    const beginButton = page.getByRole('button', { name: 'Begin workflow' })
    await expect(beginButton).toHaveCount(1, { timeout: 30_000 })
    // Begin is withheld while the Coordinator is still revising the plan, so
    // wait for the turn to settle rather than racing it.
    await expect(beginButton).toBeEnabled({ timeout: 60_000 })

    // Act: launch it once.
    await beginButton.click()

    // Assert: one task, in the same conversation, and the card is spent.
    await expect
      .poll(async () => (await readTasks(apiBaseUrl)).length, { timeout: 90_000 })
      .toBe(1)
    const tasks = await readTasks(apiBaseUrl)
    expect(tasks[0]?.workflowId).toBe('packaged-smoke')
    await expect(
      page.getByRole('button', { name: 'Begin workflow' }),
    ).toHaveCount(0, { timeout: 30_000 })
  } finally {
    await app?.close().catch(() => undefined)
    await deterministicOpenAi.close().catch(() => undefined)
  }
})

// The external model is scripted because real generations are nondeterministic.
// The renderer, loopback API, plan store and task admission remain real.
test('confirming a proposed Workflow in chat displays its admitted run', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const userDataPath = testInfo.outputPath('confirmed-user-data')
  const workspacePath = testInfo.outputPath('confirmed-workspace')
  const projectRoot = testInfo.outputPath('confirmed-project')
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
    fs.cp(path.join(repoRoot, 'tests', 'fixtures', 'packaged-workflow-smoke'), projectRoot, { recursive: true }),
  ])
  await writeFrontDoorFixture(projectRoot)
  const workerFile = path.join(projectRoot, 'agents', 'packaged-smoke-worker', 'packaged-smoke-worker.md')
  const workerBody = await fs.readFile(workerFile, 'utf8')
  // A saved Claude pin must not override the selected chat connection.
  await fs.writeFile(workerFile, `---\nprovider: claude\nmodel: opus\n---\n${workerBody}`, 'utf8')
  const store = new FileSystemSessionStore(workspacePath)
  const session = await store.createSession({ title: 'Chat-confirmed workflow E2E' })
  await store.appendChatMessage(session.id, buildChatMessage('user',
    'Return a detailed deterministic packaged workflow smoke result for the release review, covering the expected artifact and successful completion.'))
  await store.appendChatMessage(session.id, buildChatMessage('assistant',
    'packaged-smoke fits this request. Say the word and I will start it.'))
  const requestSchema = z.object({
    stream: z.boolean().optional(),
    messages: z.array(z.object({ role: z.string() })),
    tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
  })
  const provider = await startDeterministicOpenAiServer({
    blockRequestsMatching: ['You are the packaged runtime smoke worker.'],
    resolveTurn: (body) => {
      const request = requestSchema.safeParse(JSON.parse(body))
      if (!request.success) return { text: 'Chat-confirmed launch.' }
      const hasResult = request.data.messages.some((message) => message.role === 'tool')
      const hasLaunchTool = request.data.tools?.some((tool) => tool.function.name === 'start_workflow')
      if (!request.data.stream && hasLaunchTool && !hasResult) {
        return { toolName: 'start_workflow', arguments: { workflowId: 'packaged-smoke' } }
      }
      return { text: 'Started packaged-smoke.' }
    },
  })
  let app: ElectronApplication | undefined
  let releaseTranscript: (() => void) | undefined
  try {
    await writeFixtureConnection(userDataPath, provider.baseUrl)
    app = await launchDesktop({ userDataPath, workspacePath, projectRoot, openAiBaseUrl: provider.baseUrl })
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    const apiBaseUrl = await rendererApiBaseUrl(page)
    await page.getByRole('button', { name: /^Chat-confirmed workflow E2E\b/ }).first().click()
    const runChat = page.getByRole('region', { name: 'Run chat' })
    await expect(runChat.getByText('packaged-smoke fits this request.', { exact: false })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Begin workflow' })).toHaveCount(0)

    await sendComposerMessage(page, 'go for it')

    await expect.poll(async () => (await readTasks(apiBaseUrl)).length).toBe(1)
    expect((await readTasks(apiBaseUrl))[0]?.workflowId).toBe('packaged-smoke')
    await expect(runChat.getByText('Started packaged-smoke.', { exact: false }).first()).toBeVisible()
    await expect(runChat.getByRole('status').filter({ hasText: 'Packaged Smoke is running.' })).toBeVisible({ timeout: 30_000 })
    await provider.waitForBlockedRequest('You are the packaged runtime smoke worker.')
    const admitted = (await new FileSystemSessionStore(workspacePath).listTaskRecords(session.id))[0]
    expect(admitted?.workerModel).toEqual({ provider: `connection:${FIXTURE_CONNECTION_ID}`, model: FIXTURE_MODEL_ID })
    const stopRun = runChat.getByRole('button', { name: 'Stop workflow run', exact: true })
    await expect(stopRun).toBeVisible()
    await expect(page.getByRole('button', { name: 'Begin workflow' })).toHaveCount(0)
    // Hold only transcript delivery, keeping the real API and filesystem writes.
    // This reproduces a slow outcome fetch after a real worker has finished.
    const transcriptGate = new Promise<void>((resolve) => { releaseTranscript = resolve })
    await page.route(`${apiBaseUrl}/sessions/${session.id}/messages**`, async (route) => {
      if (route.request().method() === 'GET') await transcriptGate
      await route.continue()
    })
    provider.releaseBlockedResponses()
    await expect.poll(async () => (await readTasks(apiBaseUrl))[0]?.status, { timeout: 45_000 }).toBe('done')
    const finishing = runChat.getByRole('status', { name: 'Packaged Smoke Worker is finishing the workflow' })
    await expect(finishing.first()).toBeVisible()
    releaseTranscript?.()
    await expect(runChat.getByRole('button', { name: 'Open full view', exact: true }).first()).toBeVisible()
    await expect(finishing).toHaveCount(0)
    await page.unrouteAll({ behavior: 'wait' })
  } finally {
    releaseTranscript?.()
    await app?.close()
    await provider.close()
  }
})

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

interface PlanView {
  readonly id: string
  readonly status: string
  readonly selectedWorkflow?: {
    readonly id: string
    readonly selectionSource?: string
  }
}

interface TaskView {
  readonly status: string
  readonly id: string
  readonly workflowId: string
}

interface TranscriptMessage {
  readonly role: string
  readonly text: string
  readonly speaker?: { readonly name?: string }
}

async function sendComposerMessage(page: Page, text: string): Promise<void> {
  const composer = page.getByRole('textbox').last()
  await composer.click()
  await composer.fill(text)
  await page.keyboard.press('Enter')
}

async function rendererApiBaseUrl(page: Page): Promise<string> {
  const hash = await page.evaluate(() => window.location.hash.slice(1))
  const value = new URLSearchParams(hash).get('pipeline-api-base-url')
  if (!value) throw new Error('Desktop renderer did not expose its API base URL.')
  return value
}

async function onlySessionId(apiBaseUrl: string): Promise<string> {
  const response = await fetch(`${apiBaseUrl}/sessions`)
  expect(response.status).toBe(200)
  const payload = (await response.json()) as { sessions: Array<{ id: string }> }
  const session = payload.sessions[0]
  if (!session) throw new Error('The desktop created no session.')
  return session.id
}

async function readPlan(apiBaseUrl: string): Promise<PlanView | null> {
  const sessionId = await onlySessionId(apiBaseUrl)
  const response = await fetch(
    `${apiBaseUrl}/sessions/${encodeURIComponent(sessionId)}/run-plan`,
  )
  expect(response.status).toBe(200)
  const payload = (await response.json()) as { plan: PlanView | null }
  return payload.plan
}

async function readTranscript(
  apiBaseUrl: string,
): Promise<TranscriptMessage[]> {
  const sessionId = await onlySessionId(apiBaseUrl)
  const response = await fetch(
    `${apiBaseUrl}/sessions/${encodeURIComponent(sessionId)}/messages`,
  )
  expect(response.status).toBe(200)
  const payload = (await response.json()) as { messages: TranscriptMessage[] }
  return payload.messages
}

async function readTasks(apiBaseUrl: string): Promise<TaskView[]> {
  const sessionId = await onlySessionId(apiBaseUrl)
  const response = await fetch(
    `${apiBaseUrl}/sessions/${encodeURIComponent(sessionId)}/tasks`,
  )
  expect(response.status).toBe(200)
  const payload = (await response.json()) as { tasks: TaskView[] }
  return payload.tasks
}

/**
 * The General Agent, on the fixture connection.
 *
 * A persona model the catalog does not list was answered by the Codex CLI on
 * the developer's own account, so it names the connection the catalog offers.
 */
async function writeFrontDoorFixture(projectRoot: string): Promise<void> {
  const directory = path.join(projectRoot, 'agents', 'general-agent')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, 'general-agent.md'),
    [
      '---',
      'name: general-agent',
      'description: Deterministic front door fixture.',
      'tier: orchestration',
      `provider: connection:${FIXTURE_CONNECTION_ID}`,
      `model: ${FIXTURE_MODEL_ID}`,
      'thinking: low',
      'system: true',
      '---',
      '',
      '# general-agent',
      '',
      'Answer the question in one sentence.',
      // Names the persona inside its own prompt, which is what the fixture
      // server matches on.
      'Fixture persona: general-agent.',
      '',
    ].join('\n'),
    'utf8',
  )
}

/**
 * The fixture connection, stored as the user's default before launch.
 *
 * The composer sends its default model on every turn, and both the General
 * Agent and the Coordinator honour it, so the default has to be the fixture.
 */
async function writeFixtureConnection(
  userDataPath: string,
  baseUrl: string,
): Promise<void> {
  await fs.writeFile(
    path.join(userDataPath, 'provider-settings.json'),
    JSON.stringify({
      version: 1,
      connections: [
        {
          id: FIXTURE_CONNECTION_ID,
          // Keyless LM Studio: the native tool route every Agent chat turn
          // takes refuses a keyless OpenAI-compatible connection.
          kind: 'lm-studio',
          name: 'Unified workflow dispatch fixture',
          baseUrl,
          enabled: true,
          status: 'connected',
          models: [
            {
              id: FIXTURE_MODEL_ID,
              name: 'Unified Workflow Dispatch Fixture',
              enabled: true,
              capabilities: ['chat'],
            },
          ],
        },
      ],
      cliEnabled: {},
      cliModelEnabled: {},
      defaultModel: {
        provider: `connection:${FIXTURE_CONNECTION_ID}`,
        model: FIXTURE_MODEL_ID,
      },
    }),
    'utf8',
  )
}

async function launchDesktop(options: {
  readonly userDataPath: string
  readonly workspacePath: string
  readonly projectRoot: string
  readonly openAiBaseUrl: string
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
      OPENAI_API_KEY: 'unified-dispatch-test-key',
      OPENAI_BASE_URL: options.openAiBaseUrl,
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: options.projectRoot,
      PIPELINE_DESKTOP_USER_DATA: options.userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: options.workspacePath,
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
    },
  })
}
