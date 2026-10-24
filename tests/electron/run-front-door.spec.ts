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

import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

/**
 * The change this whole slice exists for.
 *
 * A user opens Run, selects nothing, and asks a question. Before, that turn
 * reached the Run Coordinator, whose persona forbids it from answering, so the
 * user was asked which workflow they wanted. The journey has to run in the real
 * desktop because the defect was never in one function: it was in who the
 * server hands an untargeted turn to.
 */
test('an untargeted question gets an answer, not a workflow interrogation', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const userDataPath = testInfo.outputPath('front-door-user-data')
  const workspacePath = testInfo.outputPath('front-door-workspace')
  const projectRoot = testInfo.outputPath('front-door-project')
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
  ])
  // Written before launch so desktop seeding keeps it: the seed copies only
  // files the project root does not already have, and the shipped persona
  // names a CLI provider this test has no server for.
  await writeFrontDoorFixture(projectRoot)

  const answer =
    'GENERAL-AGENT-REPLY: Run is where you start work. Pick an Agent, a Team, or a Workflow on the right, and Begin workflow is what actually starts one.'
  const provider = await startFakeChatCompletionsServer({
    script: [{ content: answer, deltas: [answer] }],
  })
  await writeProviderSettings(userDataPath, provider.url)
  let app: ElectronApplication | undefined
  try {
    app = await launchDesktop({ userDataPath, workspacePath, projectRoot })
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    const apiBaseUrl = await rendererApiBaseUrl(page)

    const messageResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/messages'),
      { timeout: 60_000 },
    )
    await sendComposerMessage(page, 'What does this app actually do?')

    // The server sent it to the front door, and the front door is an agent —
    // which is what gives the reply a tool loop and an assignment record.
    const dispatched = (await (await messageResponse).json()) as {
      dispatch?: { kind?: string; agentNames?: string[] }
    }
    expect(dispatched.dispatch?.kind).toBe('agents')
    expect(dispatched.dispatch?.agentNames).toEqual(['general-agent'])

    const sessionId = await onlySessionId(apiBaseUrl)
    await expect
      .poll(async () => (await readTranscript(apiBaseUrl, sessionId)).length, {
        timeout: 60_000,
      })
      .toBeGreaterThanOrEqual(2)

    const transcript = await readTranscript(apiBaseUrl, sessionId)
    const reply = transcript.at(-1)
    expect(reply?.role).toBe('assistant')
    expect(reply?.speaker?.id).toBe('general-agent')
    expect(reply?.speaker?.name).toBe('General Agent')
    expect(reply?.text).toContain('GENERAL-AGENT-REPLY')

    // Nothing was started, and no plan was written: a suggestion is prose.
    const planResponse = await fetch(
      `${apiBaseUrl}/sessions/${encodeURIComponent(sessionId)}/run-plan`,
    )
    expect(planResponse.status).toBe(200)
    const { plan } = (await planResponse.json()) as {
      plan: { selectedWorkflow?: unknown } | null
    }
    expect(plan?.selectedWorkflow).toBeUndefined()

    // On screen, under the front door's name.
    const conversation = page.getByRole('region', { name: 'Run chat' })
    await expect(
      conversation.getByText('General Agent', { exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      conversation.getByText(/GENERAL-AGENT-REPLY/).first(),
    ).toBeVisible({ timeout: 30_000 })
  } finally {
    await app?.close().catch(() => undefined)
    await provider.close().catch(() => undefined)
  }
})

/**
 * The other half of making the front door a real agent.
 *
 * Its persona is the user's, not the repository's. `ui_hidden` was one flag
 * meaning both "not a Run target" and "not listed in the library", so a hidden
 * agent had no editing surface at all; the `system` marker separates them, and
 * this is the journey that proves the separation reached the interface.
 */
test('the General Agent opens in Create and its persona saves', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const userDataPath = testInfo.outputPath('front-door-create-user-data')
  const workspacePath = testInfo.outputPath('front-door-create-workspace')
  const projectRoot = testInfo.outputPath('front-door-create-project')
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
  ])
  await writeFrontDoorFixture(projectRoot)
  const personaPath = path.join(
    projectRoot,
    'agents',
    'general-agent',
    'general-agent.md',
  )

  const provider = await startFakeChatCompletionsServer({ script: [] })
  await writeProviderSettings(userDataPath, provider.url)
  let app: ElectronApplication | undefined
  try {
    app = await launchDesktop({ userDataPath, workspacePath, projectRoot })
    const page = await app.firstWindow()

    await page.getByRole('tab', { name: 'Create', exact: true }).click()
    await page
      .getByLabel('Resource type')
      .getByRole('tab', { name: 'Agents', exact: true })
      .click()

    // Listed in Create, which is the point of the `system` marker.
    const row = page
      .locator('[data-slot="workspace-sidebar"][data-side="left"]')
      .getByRole('button', { name: /^General Agent/ })
    await expect(row).toBeVisible({ timeout: 30_000 })
    await row.click()

    const editor = page.getByRole('textbox', { name: 'Persona markdown' })
    await expect(editor).toBeVisible({ timeout: 30_000 })
    await expect(editor).toHaveValue(/general-agent/)

    const edited = `${await editor.inputValue()}\n\nEDITED-BY-JOURNEY\n`
    await editor.fill(edited)
    // Leaving the editor saves what was typed; there is no Save button.
    await editor.blur()

    await expect
      .poll(async () => fs.readFile(personaPath, 'utf8'), { timeout: 30_000 })
      .toContain('EDITED-BY-JOURNEY')
  } finally {
    await app?.close().catch(() => undefined)
    await provider.close().catch(() => undefined)
  }
})

/**
 * Capability A of the assessment's continuation loop.
 *
 * A Team finishes, the user addresses a different specialist, and that
 * specialist can see what the Team concluded. Before this, a chat-only Team's
 * conclusions reached nobody: it publishes no artifact, no delivery card
 * follows, and its replies stay out of the shared transcript, so a follow-up
 * addressed to an Agent had only the brief.
 *
 * The real desktop because the handoff crosses every layer: the run's own
 * state, the result reference, the composer's selection, and the request.
 */
test('a finished Team result reaches the specialist the user asks next', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const userDataPath = testInfo.outputPath('handoff-user-data')
  const workspacePath = testInfo.outputPath('handoff-workspace')
  const projectRoot = testInfo.outputPath('handoff-project')
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
  ])
  await writeFrontDoorFixture(projectRoot)
  await writeSpecialistFixture(projectRoot, 'analyst')

  const provider = await startFakeChatCompletionsServer({
    script: [{ content: 'ANALYST-REPLY', deltas: ['ANALYST-REPLY'] }],
  })
  await writeProviderSettings(userDataPath, provider.url)
  let app: ElectronApplication | undefined
  try {
    // Seeded before the app opens, so nothing is running while it reads.
    const sessionId = await seedFinishedTeamSession(workspacePath)
    app = await launchDesktop({ userDataPath, workspacePath, projectRoot })
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    const apiBaseUrl = await rendererApiBaseUrl(page)
    const results = await readResults(apiBaseUrl, sessionId)
    expect(results).toHaveLength(1)
    expect(results[0]?.producer.kind).toBe('team')

    // Addressed to a specialist and carrying nothing, which is what the
    // composer now sends: the picker was removed, so the server decides.
    const response = await fetch(
      `${apiBaseUrl}/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'What did the board decide?',
          target: { kind: 'agents', agentNames: ['analyst'] },
        }),
      },
    )
    expect(response.status).toBe(201)

    // The prompts the specialist actually received carried the Team's words:
    // its buffered tool-capable round and the streamed tool-free request that
    // answers. Each whole message list is read, not only the first user
    // message, because history can come before the current question.
    const specialistRequests = provider.requests.filter(
      (request) => request.systemPrompt?.includes('# analyst') ?? false,
    )
    expect(
      specialistRequests.map(
        (request) => request.stream && request.body.tool_choice === 'none',
      ),
    ).toEqual([false, true])
    for (const request of specialistRequests) {
      expect(JSON.stringify(request.body.messages)).toContain('TEAM-CONCLUSION-SENTINEL')
    }

    // And exactly one Team task exists: carrying a result starts nothing.
    const tasksResponse = await fetch(
      `${apiBaseUrl}/sessions/${encodeURIComponent(sessionId)}/tasks`,
    )
    const { tasks } = (await tasksResponse.json()) as { tasks: unknown[] }
    expect(tasks).toHaveLength(1)
  } finally {
    await app?.close().catch(() => undefined)
    await provider.close().catch(() => undefined)
  }
})

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

interface ResultReferenceView {
  readonly id: string
  readonly producer: { readonly kind: string }
}

async function readResults(
  apiBaseUrl: string,
  sessionId: string,
): Promise<ResultReferenceView[]> {
  const response = await fetch(
    `${apiBaseUrl}/sessions/${encodeURIComponent(sessionId)}/results`,
  )
  expect(response.status).toBe(200)
  const payload = (await response.json()) as { results: ResultReferenceView[] }
  return payload.results
}

/** A specialist on the same fixture provider as the front door. */
async function writeSpecialistFixture(
  projectRoot: string,
  name: string,
): Promise<void> {
  const directory = path.join(projectRoot, 'agents', name)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, `${name}.md`),
    [
      '---',
      `name: ${name}`,
      `description: ${name} fixture.`,
      'tier: strategic',
      `provider: connection:${CONNECTION_ID}`,
      `model: ${MODEL_ID}`,
      'thinking: low',
      '---',
      '',
      `# ${name}`,
      '',
      'Answer the question.',
      '',
    ].join('\n'),
    'utf8',
  )
}

/**
 * A session holding one completed chat-only Team run, seeded before launch.
 *
 * Written straight into the workspace rather than started through the API. A
 * real launch runs the board with whatever models this machine has, and the
 * live run's own terminal write would race the `done` this fixture needs — an
 * intermittently red test that also makes real provider calls. What the
 * journey is about is what a finished Team's output can reach, not how it
 * finished.
 */
async function seedFinishedTeamSession(workspacePath: string): Promise<string> {
  const store = new FileSystemSessionStore(workspacePath)
  const session = await store.createSession({ title: 'Handoff' })
  const task = await store.createTaskRecord(session.id, {
    workflowId: 'chat-team-problem-thinking-board',
    teamId: 'problem-thinking-board',
    targetKind: 'team-chat',
    brief: 'Decompose the launch decision.',
  })
  if (!task) throw new Error('The fixture could not create a task record.')

  // The Team's accepted messages, where the runtime records them: no artifact,
  // no delivery card, nothing in the shared transcript.
  const assignmentPath =
    task.assignmentPath ?? path.join(workspacePath, 'assignments', task.runId)
  const logsPath = path.join(assignmentPath, 'logs')
  await fs.mkdir(logsPath, { recursive: true })
  await fs.writeFile(
    path.join(logsPath, 'engine-events.jsonl'),
    `${JSON.stringify({
      type: 'team.message',
      run_id: task.runId,
      payload: {
        agent_name: 'contrarian',
        text: 'TEAM-CONCLUSION-SENTINEL: option B, on cost.',
      },
    })}\n`,
    'utf8',
  )

  await store.updateTaskRecord(session.id, task.id, {
    status: 'done',
    completedAt: new Date().toISOString(),
  })
  return session.id
}

interface TranscriptMessage {
  readonly role: string
  readonly text: string
  readonly speaker?: { readonly id?: string; readonly name?: string }
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
  const payload = (await response.json()) as {
    sessions: Array<{ id: string }>
  }
  const sessionId = payload.sessions[0]?.id
  if (!sessionId) throw new Error('The desktop created no session.')
  return sessionId
}

async function readTranscript(
  apiBaseUrl: string,
  sessionId: string,
): Promise<TranscriptMessage[]> {
  const response = await fetch(
    `${apiBaseUrl}/sessions/${encodeURIComponent(sessionId)}/messages`,
  )
  expect(response.status).toBe(200)
  const payload = (await response.json()) as { messages: TranscriptMessage[] }
  return payload.messages
}

const CONNECTION_ID = 'front-door-fixture'
const MODEL_ID = 'front-door/fixture-model'

/** The shipped front door's shape, on a provider this test can answer for. */
async function writeFrontDoorFixture(projectRoot: string): Promise<void> {
  const directory = path.join(projectRoot, 'agents', 'general-agent')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, 'general-agent.md'),
    [
      '---',
      'name: general-agent',
      'description: General Agent — the Run front door.',
      'tier: orchestration',
      `provider: connection:${CONNECTION_ID}`,
      `model: ${MODEL_ID}`,
      'thinking: low',
      'system: true',
      '---',
      '',
      '# General Agent',
      '',
      'Answer the question. Never ask which workflow the user wants.',
      '',
    ].join('\n'),
    'utf8',
  )
}

/**
 * The fixture model, in the catalog and stored as the default.
 *
 * Both halves matter. The composer's model control falls back to the first
 * available model when the one it was given is not in the catalog, so a
 * persona naming a model nobody enabled is answered by whatever real provider
 * this machine happens to have — which is what the first run of this journey
 * did.
 */
async function writeProviderSettings(
  userDataPath: string,
  baseUrl: string,
): Promise<void> {
  await fs.mkdir(userDataPath, { recursive: true })
  await fs.writeFile(
    path.join(userDataPath, 'provider-settings.json'),
    JSON.stringify({
      version: 1,
      connections: [
        {
          id: CONNECTION_ID,
          // Keyless, so not `openai-compatible`: the native tool route an
          // Agent chat turn takes refuses that kind without a key.
          kind: 'lm-studio',
          name: 'Front door fixture',
          baseUrl: `${baseUrl}/v1`,
          enabled: true,
          status: 'connected',
          models: [
            {
              id: MODEL_ID,
              name: 'Front Door Fixture',
              enabled: true,
              capabilities: ['chat'],
            },
          ],
        },
      ],
      cliEnabled: {},
      cliModelEnabled: {},
      defaultModel: { provider: `connection:${CONNECTION_ID}`, model: MODEL_ID },
    }),
    'utf8',
  )
}

async function launchDesktop(options: {
  readonly userDataPath: string
  readonly workspacePath: string
  readonly projectRoot: string
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
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: options.projectRoot,
      PIPELINE_DESKTOP_USER_DATA: options.userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: options.workspacePath,
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
    },
  })
}
