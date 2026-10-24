import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SessionTask } from '../../contracts/sessions.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { createRunPlanService } from '../../services/run-orchestrator-service.js'
import { startDeterministicOpenAiServer } from './support/deterministic-openai-server.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

test('a generic workflow launches once and retains its disabled Stop control after cancellation', async ({}, testInfo) => {
  test.setTimeout(60_000)
  const workspacePath = testInfo.outputPath('workflow-launch-workspace')
  const projectRootPath = testInfo.outputPath('workflow-launch-project')
  const userDataPath = testInfo.outputPath('workflow-launch-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(userDataPath, { recursive: true }),
    fs.cp(
      path.join(repoRoot, 'tests', 'fixtures', 'packaged-workflow-smoke'),
      projectRootPath,
      { recursive: true },
    ),
  ])

  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({
    title: 'Workflow launch confirmation E2E',
  })
  const plan = await createRunPlanService({
    sessionId: session.id,
    sessionStore,
    repoRootPath: projectRootPath,
    workflowsRegistryPath: path.join(
      projectRootPath,
      'workflows',
      'registry.yaml',
    ),
    goal: 'Return the deterministic packaged workflow smoke result.',
    workflowId: 'packaged-smoke',
    // The journey starts from a workflow the user chose. Begin is offered only
    // for a user selection, so the seeded plan records that it was one.
    selectionSource: 'user',
  })
  expect(plan.status).toBe('ready')
  const provider = await startDeterministicOpenAiServer({
    blockResponsesStartingAt: 1,
  })

  const executablePath = process.env.PIPELINE_DESKTOP_EXECUTABLE
    ? path.resolve(repoRoot, process.env.PIPELINE_DESKTOP_EXECUTABLE)
    : undefined
  const app = await electron.launch({
    args: executablePath ? [] : ['.'],
    cwd: repoRoot,
    ...(executablePath ? { executablePath } : {}),
    env: {
      ...fixtureDesktopEnvironment(),
      NODE_ENV: 'test',
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      OPENAI_API_KEY: 'workflow-launch-electron-e2e-secret',
      OPENAI_BASE_URL: provider.baseUrl,
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
    },
  }).catch(async (error: unknown) => {
    await provider.close()
    throw error
  })
  let apiBaseUrl: string | null = null
  let launchedTask: SessionTask | null = null

  try {
    const page = await app.firstWindow()
    apiBaseUrl = await desktopApiBaseUrl(page)
    await page.getByRole('tab', { name: 'Run' }).click()
    await page.getByRole('button', {
      name: /^Workflow launch confirmation E2E\b/,
    }).first().click()
    await page.getByRole('tab', { name: 'Workflows', exact: true }).click()

    const runChat = page.getByRole('region', { name: 'Run chat' })
    const runActivity = page.getByRole('region', { name: 'Run activity' })
    const confirmation = runChat.getByTestId('workflow-launch-confirmation')
    const beginButton = confirmation.getByRole('button', {
      name: 'Begin workflow',
    })
    await expect(confirmation).toBeVisible()
    await expect(confirmation).toContainText('packaged-smoke')
    await expect(beginButton).toBeEnabled()
    await expect(
      runActivity.getByRole('button', { name: 'Start', exact: true }),
    ).toHaveCount(0)
    await expect(
      runActivity.getByRole('button', { name: 'Begin workflow', exact: true }),
    ).toHaveCount(0)

    let releaseReceptionist: (() => void) | undefined
    const receptionistGate = new Promise<void>((resolve) => {
      releaseReceptionist = resolve
    })
    await page.route(`**/sessions/${session.id}/messages`, async (route) => {
      await receptionistGate
      const now = new Date().toISOString()
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: 'button-only-user',
            role: 'user',
            text: 'Keep this plan ready.',
            createdAt: now,
          },
          assistant: {
            id: 'button-only-receptionist',
            role: 'assistant',
            text: 'The plan remains ready. Use Begin workflow to start.',
            createdAt: now,
          },
          plan,
          meta: { model: 'electron-fixture', fallback: false },
        }),
      })
    })
    await runChat.getByPlaceholder('Send a message...').fill('Keep this plan ready.')
    await runChat.getByRole('button', { name: 'Send message' }).click()
    await expect(beginButton).toBeDisabled()
    releaseReceptionist?.()
    await expect(beginButton).toBeEnabled()
    await page.unroute(`**/sessions/${session.id}/messages`)

    const taskPath = `/sessions/${session.id}/tasks`
    let taskPostCount = 0
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        new URL(request.url()).pathname.endsWith(taskPath)
      ) {
        taskPostCount += 1
      }
    })
    const taskResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith(taskPath),
    )
    await beginButton.evaluate((button: HTMLElement) => {
      button.click()
      button.click()
    })

    const response = await taskResponse
    expect(response.status()).toBe(202)
    launchedTask = await response.json() as SessionTask
    expect(launchedTask.workflowId).toBe('packaged-smoke')
    await expect.poll(() => taskPostCount).toBe(1)
    await expect(confirmation).toHaveCount(0)
    await page.getByRole('button', { name: 'Show inspector' }).click()

    const stopButton = runActivity.getByRole('button', {
      name: 'Stop workflow',
      exact: true,
    })
    await expect(stopButton).toBeEnabled()
    const cancellationResponse = page.waitForResponse((candidate) =>
      candidate.request().method() === 'DELETE' &&
      new URL(candidate.url()).pathname.endsWith(
        `${taskPath}/${launchedTask!.id}`,
      ),
    )
    await stopButton.click()
    expect((await cancellationResponse).status()).toBe(200)
    await expect(stopButton).toBeVisible()
    await expect(stopButton).toBeDisabled()
    await expect(runActivity.getByText('Cancelled', { exact: true })).toBeVisible()
    launchedTask = null
  } finally {
    if (apiBaseUrl && launchedTask) {
      await fetch(
        `${apiBaseUrl}/sessions/${launchedTask.sessionId}/tasks/${launchedTask.id}`,
        { method: 'DELETE' },
      ).catch(() => undefined)
    }
    await Promise.allSettled([app.close(), provider.close()])
  }
})

async function desktopApiBaseUrl(page: Page): Promise<string> {
  await page.waitForURL((url) => url.hash.includes('pipeline-api-base-url='))
  const baseUrl = await page.evaluate(() =>
    new URLSearchParams(window.location.hash.slice(1)).get(
      'pipeline-api-base-url',
    ),
  )
  if (!baseUrl) throw new Error('Desktop API URL is unavailable')
  return baseUrl
}
