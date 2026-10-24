import { _electron as electron, expect, test } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { logConversationMessage } from '../../domains/runtime/logger.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const paragraph = 'Learning objectives should explain what the learner can do after completing the tutorial. State the prerequisites before introducing the first command, give a concrete example, and show how the learner can check the result. This sentence should flow across the available reading area instead of staying inside the narrow chat column.'
const response = [
  '# CLI tutorial assessment',
  paragraph,
  ...Array.from({ length: 14 }, (_, index) => `## Lesson ${index + 1}\n\n${paragraph}`),
  'Final recommendation: verify the result with a practical exercise.',
].join('\n\n')

test('a chat response opens at nearly full-screen width and closes back to the transcript', async ({}, testInfo) => {
  const workspacePath = testInfo.outputPath('workspace')
  const projectRootPath = testInfo.outputPath('project')
  const userDataPath = testInfo.outputPath('user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(userDataPath, { recursive: true }),
    fs.cp(path.join(repoRoot, 'tests/fixtures/packaged-workflow-smoke'), projectRootPath, { recursive: true }),
  ])
  const store = new FileSystemSessionStore(workspacePath)
  const session = await store.createSession({ title: 'Message reading journey' })
  await store.appendChatMessage(session.id, {
    id: 'tutorial-question',
    role: 'user', text: 'Review the CLI tutorial.',
    createdAt: '2026-09-05T11:59:00.000Z',
  })
  await store.appendChatMessage(session.id, {
    id: 'tutorial-answer',
    role: 'assistant', text: 'The tutorial should start with a working example.',
    createdAt: '2026-09-05T11:59:01.000Z',
    speaker: { type: 'assistant', id: 'tutor', name: 'Tutorial Assistant' },
  })
  const task = await store.createTaskRecord(session.id, {
    workflowId: 'packaged-workflow-smoke',
    brief: 'Review the CLI tutorial.',
  })
  if (!task?.assignmentPath) throw new Error('The fixture task needs an assignment')
  logConversationMessage(task.assignmentPath, {
    from: 'Teaching Specialist', to: 'all', round: 1,
    timestamp: '2026-09-05T12:00:00.000Z', type: 'position', message: response,
  }, task.runId, { sessionId: 'reading-discussion', stageType: 'discussion', team: 'review-team' })
  await store.updateTaskRecord(session.id, task.id, {
    status: 'done', completedAt: '2026-09-05T12:00:01.000Z',
  })
  const app = await electron.launch({
    args: ['.'], cwd: repoRoot,
    env: {
      ...fixtureDesktopEnvironment(), NODE_ENV: 'test', PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath,
      PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
    },
  })
  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole('button', { name: 'Use dark mode', exact: true }).click()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('button', { name: /^Message reading journey\b/ }).first().click()
    const chat = page.getByRole('region', { name: 'Run chat' })
    const heading = chat.getByRole('heading', { name: 'CLI tutorial assessment', exact: true })
    await expect(heading).toBeVisible()
    const messageCard = chat.locator('section').filter({
      has: page.getByRole('heading', { name: 'CLI tutorial assessment', exact: true }),
    })
    const maximize = messageCard.getByRole('button', { name: 'Maximize message' })
    await expect(maximize).toBeVisible()
    await maximize.click()

    const dialog = page.getByRole('dialog', { name: 'Teaching Specialist', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('heading', { name: 'CLI tutorial assessment' })).toBeVisible()
    // Finish the opening animation before measuring the dialog's reading width.
    await page.screenshot({ path: testInfo.outputPath('maximized-message.png'), animations: 'disabled' })
    const dialogBounds = await dialog.boundingBox()
    if (!dialogBounds) throw new Error('The reading dialog must have visible bounds')
    expect(dialogBounds.width).toBeGreaterThan(1440 * 0.9)
    expect(dialogBounds.height).toBeGreaterThan(1000 * 0.9)
    const paragraphBounds = await dialog.getByText(paragraph, { exact: true }).first().boundingBox()
    if (!paragraphBounds) throw new Error('The message paragraph must have visible bounds')
    expect(paragraphBounds.width).toBeGreaterThan(dialogBounds.width * 0.9)

    const finalParagraph = dialog.getByText('Final recommendation: verify the result with a practical exercise.', { exact: true })
    await finalParagraph.scrollIntoViewIfNeeded()
    await expect(finalParagraph).toBeInViewport()
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeInViewport()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(maximize).toBeFocused()

    await maximize.click()
    await expect(dialog).toBeVisible()
    await page.mouse.click(5, 500)
    await expect(dialog).toHaveCount(0)
    await expect(maximize).toBeFocused()

    await maximize.click()
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(heading).toBeVisible()

    const messageButtons = chat.getByRole('button', { name: 'Maximize message' })
    await expect(messageButtons).toHaveCount(2)
    await messageButtons.nth(0).click()
    const replyDialog = page.getByRole('dialog', { name: 'Tutorial Assistant', exact: true })
    await expect(replyDialog).toContainText('The tutorial should start with a working example.')
    await expect(replyDialog).not.toContainText('CLI tutorial assessment')
    await replyDialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(replyDialog).toHaveCount(0)
  } finally {
    await app.close()
  }
})
