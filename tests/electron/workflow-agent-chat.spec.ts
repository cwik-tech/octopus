import { _electron as electron, expect, test } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { logConversationMessage, logRuntimeEvent } from '../../domains/runtime/logger.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

test('workflow agent responses restore in chat while Process Timeline stays activity-only', async ({}, testInfo) => {
  const workspacePath = testInfo.outputPath('workflow-chat-workspace')
  const projectRootPath = testInfo.outputPath('workflow-chat-project')
  const userDataPath = testInfo.outputPath('workflow-chat-user-data')
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
    title: 'Workflow agent chat E2E',
  })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'packaged-workflow-smoke',
    brief: 'Evaluate the proposal.',
  })
  expect(task).not.toBeNull()
  if (!task?.assignmentPath) throw new Error('Task assignment was not created')

  logRuntimeEvent(task.assignmentPath, {
    timestamp: '2026-07-21T12:00:00.000Z',
    event: 'agent.start',
    session_id: 'discussion-child-run',
    root_session_id: task.runId,
    stage_type: 'discussion',
    agent_name: 'Contrarian',
    status: 'active',
    model: 'fixture-model',
  })
  logRuntimeEvent(task.assignmentPath, {
    timestamp: '2026-07-21T12:00:05.000Z',
    event: 'agent.end',
    session_id: 'discussion-child-run',
    root_session_id: task.runId,
    stage_type: 'discussion',
    agent_name: 'Contrarian',
    status: 'completed',
    duration_ms: 5_000,
    model: 'fixture-model',
  })
  logConversationMessage(
    task.assignmentPath,
    {
      from: 'Contrarian',
      to: 'all',
      round: 1,
      timestamp: '2026-07-21T12:00:05.001Z',
      type: 'position',
      message: 'The proposal needs stronger evidence for its market assumptions.',
    },
    task.runId,
    {
      sessionId: 'discussion-child-run',
      stageType: 'discussion',
      team: 'review-team',
    },
  )
  logRuntimeEvent(task.assignmentPath, {
    timestamp: '2026-07-21T12:00:06.000Z',
    event: 'run.completed',
    session_id: task.runId,
    root_session_id: task.runId,
    status: 'completed',
  })
  await sessionStore.updateTaskRecord(session.id, task.id, {
    status: 'done',
    completedAt: '2026-07-21T12:00:06.000Z',
  })

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...fixtureDesktopEnvironment(),
      NODE_ENV: 'test',
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath,
      PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
    },
  })

  try {
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('button', { name: /^Workflow agent chat E2E\b/ }).first().click()
    await page.getByRole('tab', { name: 'Workflows', exact: true }).click()

    const chat = page.getByRole('region', { name: 'Run chat' })
    await expect(
      chat.getByRole('log').getByText('Contrarian', { exact: true }),
    ).toBeVisible()
    await expect(
      chat.getByText('The proposal needs stronger evidence for its market assumptions.'),
    ).toBeVisible()

    const activity = page.getByRole('region', { name: 'Run activity' })
    await expect(
      activity.getByRole('region', { name: 'Process timeline', exact: true }),
    ).toBeVisible()
    const completedAgentEvent = activity.getByText(
      'Contrarian finished · 5s · fixture-model',
    )
    await completedAgentEvent.scrollIntoViewIfNeeded()
    await expect(completedAgentEvent).toBeVisible()
    await expect(
      activity.getByRole('button', { name: 'Runtime diagnostics' }),
    ).toHaveCount(0)
    await expect(
      activity.getByText('The proposal needs stronger evidence for its market assumptions.'),
    ).toHaveCount(0)

    await page.reload()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    const restoredSession = page.getByRole('button', {
      name: /^Workflow agent chat E2E\b/,
    }).first()
    await expect(restoredSession).toBeVisible()
    const restoredSessionResponse = page.waitForResponse((response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname.endsWith(`/sessions/${session.id}`),
    )
    await restoredSession.click()
    await page.getByRole('tab', { name: 'Workflows', exact: true }).click()
    expect((await restoredSessionResponse).ok()).toBe(true)
    await expect(
      page.getByRole('region', { name: 'Run chat' }).getByText(
        'The proposal needs stronger evidence for its market assumptions.',
      ),
    ).toBeVisible({ timeout: 15_000 })
  } finally {
    await app.close()
  }
})
