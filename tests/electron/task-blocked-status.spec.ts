import { _electron as electron, expect, test } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

test('a durable blocked task is presented as Blocked in the Electron run summary', async ({}, testInfo) => {
  const workspacePath = testInfo.outputPath('blocked-status-workspace')
  const userDataPath = testInfo.outputPath('blocked-status-user-data')
  const projectRootPath = testInfo.outputPath('blocked-status-project')
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
  const session = await sessionStore.createSession({ title: 'Premiere pending E2E' })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'packaged-workflow-smoke',
    brief: 'Extract an upcoming YouTube premiere.',
  })
  expect(task).not.toBeNull()
  if (!task) throw new Error('Blocked task fixture was not created.')
  await sessionStore.updateTaskRecord(session.id, task.id, {
    status: 'blocked',
    completedAt: '2026-08-14T16:00:00.000Z',
    error: 'Run this workflow again after the premiere is available.',
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
    await page.getByRole('button', { name: /^Premiere pending E2E\b/ }).first().click()
    await page.getByRole('tab', { name: 'Workflows', exact: true }).click()

    const summary = page.getByLabel('Run summary')
    await expect(summary.getByText('Blocked', { exact: true })).toBeVisible()
    await expect(summary.getByText('Error', { exact: true })).toHaveCount(0)
  } finally {
    await app.close()
  }
})
