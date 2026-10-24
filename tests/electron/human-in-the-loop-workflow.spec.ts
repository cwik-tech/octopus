import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { FileSystemWorkflowStateStore } from '../../workflows/workflow-state-store.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

interface SessionTask {
  id: string
  assignmentPath: string
  status: string
}

interface SessionMessageTurn {
  plan: {
    selectedWorkflow?: { id: string }
    status: string
  }
}

const builderWorkflowTestTitle = 'a Visual Builder-created human-in-the-loop Workflow runs to completion'

// The model the deterministic server advertises, offered through a provider
// connection so the Coordinator's planning turn has a fixture to run on.
const FIXTURE_CONNECTION_ID = 'human-input-builder-fixture'
const FIXTURE_MODEL_ID = 'gpt-5.4-mini'

async function pinSmokeWorkerModel(projectRoot: string): Promise<void> {
  const agentFile = path.join(projectRoot, 'agents/packaged-smoke-worker/packaged-smoke-worker.md')
  const prompt = await fs.readFile(agentFile, 'utf8')
  // The copied fixture predates explicit agent model selection.
  await fs.writeFile(agentFile, `---\nprovider: openai\nmodel: ${FIXTURE_MODEL_ID}\nthinking: low\n---\n${prompt}`)
}

test.afterEach(async ({}, testInfo) => {
  if (
    testInfo.title !== builderWorkflowTestTitle ||
    testInfo.status !== testInfo.expectedStatus
  ) return

  await expect(
    fs.access(testInfo.outputPath('human-input-builder-project')),
  ).rejects.toThrow()
})

test('a launched workflow pauses for human feedback, resumes in Electron, and completes', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const workspacePath = testInfo.outputPath('human-input-workspace')
  const projectRootPath = testInfo.outputPath('human-input-project')
  const userDataPath = testInfo.outputPath('human-input-user-data')
  const piStatePath = testInfo.outputPath('human-input-pi-state')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(piStatePath, { recursive: true }),
    fs.cp(
      path.join(repoRoot, 'tests', 'fixtures', 'packaged-workflow-smoke'),
      projectRootPath,
      { recursive: true },
    ),
  ])
  await pinSmokeWorkerModel(projectRootPath)
  await fs.writeFile(
    path.join(projectRootPath, 'workflows', 'templates', 'packaged-smoke.yaml'),
    `workflow:
  id: packaged-smoke
  description: Deterministic human-input Electron journey.
  input:
    artifact: incoming-request.md
  steps:
    - id: draft
      type: team
      team: packaged-smoke-team
      input_artifact: incoming-brief.md
      result_artifact: final.md
      recovery_policy: safe_retry
    - id: human-feedback
      type: human-in-the-loop
      prompt: Review the first round before finalization.
      input_artifact: review/round-one.md
      result_artifact: feedback/round-one.json
      handoff:
        from_step: draft
        from_artifact: final.md
        to_artifact: review/round-one.md
    - id: finalize
      type: agent
      team: packaged-smoke-team
      agent: packaged-smoke-worker
      stage_type: chain
      input_artifact: incoming-brief.md
      result_artifact: final.md
      recovery_policy: manual
      handoff:
        from_step: human-feedback
        from_artifact: feedback/round-one.json
        to_artifact: incoming-brief.md
  output:
    from_step: finalize
    artifact: final.md
  on_blocked: stop
  on_failed: stop
`,
  )

  const provider = await startDeterministicOpenAiServer()
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...fixtureDesktopEnvironment({ ...process.env, PATH: '/usr/bin:/bin' }),
      NODE_ENV: 'test',
      OPENAI_API_KEY: 'human-input-electron-key',
      OPENAI_BASE_URL: provider.baseUrl,
      PI_CODING_AGENT_DIR: piStatePath,
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath,
      PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
    },
  })
  let apiBaseUrl: string | null = null

  try {
    const page = await app.firstWindow()
    const activeApiBaseUrl = await desktopApiBaseUrl(page)
    apiBaseUrl = activeApiBaseUrl
    const sessionResponse = await fetch(`${apiBaseUrl}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Human input Electron E2E' }),
    })
    expect(sessionResponse.status).toBe(201)
    const session = await sessionResponse.json() as { id: string }
    const taskResponse = await fetch(`${apiBaseUrl}/sessions/${session.id}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workflowId: 'packaged-smoke',
        brief: 'Prepare a deterministic report for human review.',
      }),
    })
    const acceptedTask = await taskResponse.json() as SessionTask
    expect(taskResponse.status, JSON.stringify(acceptedTask)).toBe(202)

    await expect.poll(
      async () => (await readTask(activeApiBaseUrl, session.id, acceptedTask.id)).status,
      { timeout: 45_000 },
    ).toBe('awaiting_input')

    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    // The session list the user actually sees lives in Primary navigation. A
    // global match also finds the run panel's collapsed copy, which is clipped
    // to zero width and can never receive the click.
    await page
      .getByRole('complementary', { name: 'Primary navigation' })
      .getByRole('button', { name: /^Human input Electron E2E\b/ })
      .click()
    await page.getByRole('tab', { name: 'Workflows', exact: true }).click()
    const panel = page.getByRole('region', { name: 'Human input' })
    await expect(panel.getByRole('heading', { name: 'Human input required' })).toBeVisible()
    await panel.getByText('Reviewed source', { exact: true }).click()
    await expect(panel.locator('pre')).toContainText(
      'Deterministic final report with quantified delivery risk.',
    )

    await panel.getByRole('textbox', { name: 'Feedback message 1' }).fill(
      '@packaged-smoke-worker Quantify the delivery risk in the final report.',
    )
    const submission = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      response.url().includes('/human-in-the-loop/') &&
      response.url().endsWith('/submit'),
    )
    await panel.getByRole('button', { name: 'Continue workflow', exact: true }).click()
    expect((await submission).status()).toBe(202)

    await expect.poll(
      async () => (await readTask(activeApiBaseUrl, session.id, acceptedTask.id)).status,
      { timeout: 45_000 },
    ).toBe('done')
    const snapshot = await new FileSystemWorkflowStateStore(acceptedTask.assignmentPath).requireSnapshot()
    expect(snapshot.state.steps[1]?.humanInput?.status).toBe('consumed')
    expect(snapshot.state.steps[1]?.humanInput?.submission?.messages[0]?.recipients).toEqual([
      'packaged-smoke-worker',
    ])
    await fetch(`${apiBaseUrl}/sessions/${session.id}/tasks/${acceptedTask.id}`, {
      method: 'DELETE',
    })
  } finally {
    if (apiBaseUrl) await deleteAllSessions(apiBaseUrl)
    await app.close()
    await provider.close()
  }
})

test(builderWorkflowTestTitle, async ({}, testInfo) => {
  test.setTimeout(180_000)
  const projectRootPath = testInfo.outputPath('human-input-builder-project')
  const userDataPath = testInfo.outputPath('human-input-builder-user-data')
  const workspacePath = testInfo.outputPath('human-input-builder-workspace')
  const piStatePath = testInfo.outputPath('human-input-builder-pi-state')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(piStatePath, { recursive: true }),
    fs.cp(
      path.join(repoRoot, 'tests', 'fixtures', 'packaged-workflow-smoke'),
      projectRootPath,
      { recursive: true },
    ),
  ])
  await pinSmokeWorkerModel(projectRootPath)
  const session = await new FileSystemSessionStore(workspacePath).createSession({
    title: 'Builder-created human-in-the-loop E2E',
  })

  const provider = await startDeterministicOpenAiServer()
  // A Coordinator turn that names no provider falls back to the Codex CLI on
  // the developer's own account, so the planning turn names this connection.
  await writeFixtureConnection(userDataPath, provider.baseUrl)
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...fixtureDesktopEnvironment({ ...process.env, PATH: '/usr/bin:/bin' }),
      NODE_ENV: 'test',
      OPENAI_API_KEY: 'human-input-builder-key',
      OPENAI_BASE_URL: provider.baseUrl,
      PI_CODING_AGENT_DIR: piStatePath,
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath,
      PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
    },
  })
  let apiBaseUrl: string | null = null
  let launchedTask: SessionTask | null = null
  let completedSuccessfully = false

  try {
    const page = await app.firstWindow()
    apiBaseUrl = await desktopApiBaseUrl(page)
    await page.getByRole('tab', { name: 'Create', exact: true }).click()
    const showSidebar = page.getByRole('button', { name: 'Show sidebar' })
    if (await showSidebar.isVisible()) await showSidebar.click()

    const navigation = page.getByRole('complementary', { name: 'Primary navigation' })
    await navigation.getByRole('button', { name: 'Packaged Smoke', exact: true }).click()

    const humanInTheLoopStageType = page.getByRole('button', {
      name: 'Set Step 2 type to human-in-the-loop',
    })
    await expect(humanInTheLoopStageType).toBeVisible()
    await humanInTheLoopStageType.click()
    await expect(page.getByText('Human-in-the-loop boundary', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Human-in-the-loop prompt')).toBeVisible()
    const workflowTitle = page.getByLabel('Workflow title')
    await expect(workflowTitle).toHaveValue('Packaged Smoke')
    await workflowTitle.fill('Builder feedback report')
    await workflowTitle.blur()
    await expect(workflowTitle).toHaveValue('Builder Feedback Report')
    await page.getByRole('button', { name: 'Save Workflow', exact: true }).click()
    await expect(page.getByText('Workflow saved', { exact: true })).toBeVisible()
    await expect(
      navigation.getByText('Builder Feedback Report', { exact: true }),
    ).toBeVisible()
    await page.getByRole('tab', { name: 'YAML', exact: true }).click()
    await expect.poll(async () => {
      const workflowYaml = await fs.readFile(
        path.join(projectRootPath, 'workflows', 'templates', 'packaged-smoke.yaml'),
        'utf8',
      )
      return workflowYaml.includes('id: builder-feedback-report') &&
        workflowYaml.includes('id: finalize\n      type: human-in-the-loop') &&
        workflowYaml.includes('id: step-3\n      type: team')
    }).toBe(true)

    const planResponse = await fetch(`${apiBaseUrl}/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: [
          'Use the Builder Feedback Report workflow to evaluate a software release proposal',
          'for operations leaders. Return a Markdown report that incorporates human feedback,',
          'quantifies delivery risk, and excludes unrelated market analysis.',
        ].join(' '),
        // An untargeted turn goes to the General Agent, which answers and
        // plans nothing. Naming the Workflow sends the turn to the
        // Coordinator, which plans against it; no plan exists yet to revise.
        target: {
          kind: 'workflow',
          workflowId: 'builder-feedback-report',
          expectedPlanId: null,
        },
        provider: `connection:${FIXTURE_CONNECTION_ID}`,
        model: FIXTURE_MODEL_ID,
      }),
    })
    const planTurn = await planResponse.json() as SessionMessageTurn
    expect(planResponse.status, JSON.stringify(planTurn)).toBe(201)
    expect(planTurn.plan).toMatchObject({
      selectedWorkflow: { id: 'builder-feedback-report' },
      status: 'ready',
    })

    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('button', {
      name: /^Builder-created human-in-the-loop E2E\b/,
    }).first().click()
    await page.getByRole('tab', { name: 'Workflows', exact: true }).click()
    const runChat = page.getByRole('region', { name: 'Run chat' })
    const confirmation = runChat.getByTestId('workflow-launch-confirmation')
    await expect(confirmation).toBeVisible()
    await expect(confirmation).toContainText('builder-feedback-report')

    const taskResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith(`/sessions/${session.id}/tasks`),
    )
    const workflowRequestsBeforeLaunch = provider.workflowRequestCount()
    provider.blockWorkflowResponses()
    await confirmation.getByRole('button', { name: 'Begin workflow' }).click()
    const startedResponse = await taskResponse
    expect(startedResponse.status()).toBe(202)
    launchedTask = await startedResponse.json() as SessionTask

    const showInspector = page.getByRole('button', { name: 'Show inspector' })
    if (await showInspector.isVisible()) await showInspector.click()
    await expect.poll(
      provider.workflowRequestCount,
      { timeout: 45_000 },
    ).toBeGreaterThan(workflowRequestsBeforeLaunch)
    provider.releaseBlockedWorkflowResponses()

    const panel = page.getByRole('region', { name: 'Human input' })
    await expect(
      panel.getByRole('heading', { name: 'Human input required' }),
    ).toBeVisible({ timeout: 45_000 })
    await panel.getByRole('textbox', { name: 'Feedback message 1' }).fill(
      'Include the human feedback in the final report.',
    )
    const submission = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      response.url().includes('/human-in-the-loop/') &&
      response.url().endsWith('/submit'),
    )
    await panel.getByRole('button', { name: 'Continue workflow', exact: true }).click()
    expect((await submission).status()).toBe(202)

    await expect.poll(
      async () => (await readTask(apiBaseUrl!, session.id, launchedTask!.id)).status,
      { timeout: 45_000 },
    ).toBe('done')
    const runActivity = page.getByRole('region', { name: 'Run activity' })
    await expect(
      runActivity.getByText('Human feedback submitted · 1 message', { exact: true }),
    ).toBeVisible({ timeout: 45_000 })
    await expect(
      runChat.locator(`#workflow-delivery-${launchedTask.id}`),
    ).toBeVisible({ timeout: 45_000 })
    const snapshot = await new FileSystemWorkflowStateStore(launchedTask.assignmentPath).requireSnapshot()
    expect(snapshot.state.steps[1]?.humanInput?.status).toBe('consumed')
    expect(snapshot.state.steps[1]?.humanInput?.submission?.messages[0]?.recipients).toBe('all')
    await expect.poll(
      async () => fs.readFile(
        path.join(launchedTask!.assignmentPath, 'workflow-builder-feedback-report-result.md'),
        'utf8',
      ).catch(() => ''),
      { timeout: 45_000 },
    ).toContain('Deterministic final report with quantified delivery risk.')
    completedSuccessfully = true
  } finally {
    if (apiBaseUrl && launchedTask) {
      await fetch(`${apiBaseUrl}/sessions/${session.id}/tasks/${launchedTask.id}`, {
        method: 'DELETE',
      }).catch(() => undefined)
    }
    if (apiBaseUrl) await deleteAllSessions(apiBaseUrl)
    await Promise.allSettled([app.close(), provider.close()])
    if (completedSuccessfully) {
      await fs.rm(projectRootPath, { recursive: true, force: true })
    }
  }
})

async function readTask(baseUrl: string, sessionId: string, taskId: string): Promise<SessionTask> {
  const response = await fetch(`${baseUrl}/sessions/${sessionId}/tasks/${taskId}`)
  if (!response.ok) throw new Error(`Task read failed with ${response.status}`)
  return await response.json() as SessionTask
}

async function desktopApiBaseUrl(page: Page): Promise<string> {
  // Electron firstWindow may still be the startup document. Observe the real
  // renderer becoming usable instead of coupling readiness to a load event.
  await page.getByRole('tab', { name: 'Run', exact: true }).waitFor({ state: 'visible' })
  const baseUrl = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('pipeline-api-base-url')
  if (!baseUrl) throw new Error('Desktop API URL is unavailable')
  return baseUrl
}

async function deleteAllSessions(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/sessions`).catch(() => null)
  if (!response?.ok) return
  const payload = await response.json() as { sessions?: Array<{ id: string }> }
  for (const session of payload.sessions ?? []) {
    await fetch(`${baseUrl}/sessions/${session.id}`, { method: 'DELETE' })
      .catch(() => undefined)
  }
}

/** The fixture connection, written before launch so the desktop loads it. */
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
          kind: 'openai-compatible',
          name: 'Human input builder fixture',
          baseUrl,
          enabled: true,
          status: 'connected',
          models: [
            {
              id: FIXTURE_MODEL_ID,
              name: 'Human Input Builder Fixture',
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

async function startDeterministicOpenAiServer(): Promise<{
  baseUrl: string
  blockWorkflowResponses(): void
  close(): Promise<void>
  releaseBlockedWorkflowResponses(): void
  workflowRequestCount(): number
}> {
  let requests = 0
  let workflowRequests = 0
  let workflowResponsesBlocked = false
  const blockedWorkflowResponses = new Set<() => void>()
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: [{ id: 'gpt-5.4-mini' }] }))
      return
    }
    // The Coordinator runs on the fixture connection, which speaks Chat
    // Completions; Team steps use the Responses API.
    if (request.method !== 'POST' || (
      request.url !== '/v1/responses' && request.url !== '/v1/chat/completions'
    )) {
      response.writeHead(404).end('not found')
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      requests += 1
      const requestNumber = requests
      const requestBody = Buffer.concat(chunks).toString('utf8')
      const body = JSON.parse(requestBody) as {
        model?: string
        stream?: boolean
      }
      const isReceptionistTurn = requestBody.includes('Run Orchestrator contract:')
      if (!isReceptionistTurn) workflowRequests += 1
      const text = isReceptionistTurn
        ? JSON.stringify({
            message: 'Builder feedback report is ready for review.',
            selectionAction: 'select',
            workflowId: 'builder-feedback-report',
            launchIntent: 'none',
            deepResearchPlanAction: 'keep',
            deepResearchMissingInputs: [],
          })
        : workflowRequests === 1
          ? 'Deterministic first-round evidence.'
          : 'Deterministic final report with quantified delivery risk.'
      const responseId = `resp_${requestNumber}`
      const sendResponse = () => {
        blockedWorkflowResponses.delete(sendResponse)
        if (response.destroyed || response.writableEnded) return
        if (request.url === '/v1/chat/completions') {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({
            id: `chatcmpl_${requestNumber}`,
            object: 'chat.completion',
            model: body.model ?? 'gpt-5.4-mini',
            choices: [{
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: text },
            }],
            usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
          }))
          return
        }
        const message = {
          id: `msg_${requestNumber}`,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        }
        if (!body.stream) {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({
            id: responseId,
            model: body.model ?? 'gpt-5.4-mini',
            status: 'completed',
            output: [message],
            output_text: text,
            usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
          }))
          return
        }
        const events = [
          { type: 'response.created', response: { id: responseId } },
          { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
          { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
          { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
          { type: 'response.output_item.done', output_index: 0, item: message },
          {
            type: 'response.completed',
            response: {
              id: responseId,
              status: 'completed',
              output: [message],
              usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
            },
          },
        ]
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        })
        for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
        response.end('data: [DONE]\n\n')
      }
      if (!isReceptionistTurn && workflowResponsesBlocked) {
        blockedWorkflowResponses.add(sendResponse)
        response.once('close', () => blockedWorkflowResponses.delete(sendResponse))
        return
      }
      sendResponse()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Provider address unavailable')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    blockWorkflowResponses: () => {
      workflowResponsesBlocked = true
    },
    workflowRequestCount: () => workflowRequests,
    releaseBlockedWorkflowResponses: () => {
      workflowResponsesBlocked = false
      for (const sendResponse of [...blockedWorkflowResponses]) sendResponse()
    },
    close: () => new Promise<void>((resolve, reject) => {
      for (const sendResponse of [...blockedWorkflowResponses]) sendResponse()
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    }),
  }
}
