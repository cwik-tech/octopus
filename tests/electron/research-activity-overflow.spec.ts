import { _electron as electron, expect, test, type Locator } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import type { BrowserActivityView } from '../../services/browser-tool-service.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const longTitle = 'Research findings about materials, manufacturing, durability, and environmental performance. '.repeat(12)
const longHost = `${'research-source-'.repeat(12)}example.invalid`
const longUrl = `http://127.0.0.1:1/${'detailed-research-source-'.repeat(24)}`
const attachmentName = `${'research-screenshot-'.repeat(24)}.png`

test('running research abbreviates long text without horizontal scrolling', async ({}, testInfo) => {
  const workspacePath = testInfo.outputPath('workspace')
  const userDataPath = testInfo.outputPath('user-data')
  const projectRoot = testInfo.outputPath('project')
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(projectRoot, { recursive: true }),
  ])
  const sessions = new FileSystemSessionStore(workspacePath)
  const session = await sessions.createSession({ title: 'Long research text' })
  await sessions.appendChatMessage(session.id, {
    id: 'research-question',
    role: 'user',
    text: 'Research these sources.',
    createdAt: '2026-09-19T12:00:00.000Z',
  })
  const activity = (overrides: Partial<BrowserActivityView>): BrowserActivityView => ({
    activityId: 'long-title',
    sessionId: session.id,
    runId: 'research-run',
    assignmentId: 'research-assignment',
    agentPath: 'agents/web-researcher/web-researcher.md',
    toolCallId: 'research-call',
    action: 'open',
    argumentNames: ['url'],
    state: 'completed',
    createdAt: '2026-09-19T12:00:01.000Z',
    updatedAt: '2026-09-19T12:00:01.000Z',
    ...overrides,
  })
  // Real persisted activity feeds the real API and renderer; no provider call is needed.
  await fs.writeFile(path.join(workspacePath, 'sessions', session.id, 'browser-activity.json'), JSON.stringify([
    activity({ title: longTitle, url: 'http://127.0.0.1:1/source' }),
    activity({ activityId: 'long-url', url: longUrl }),
    activity({ activityId: 'long-host', state: 'running', url: `https://${longHost}/source` }),
    activity({
      activityId: 'long-attachment',
      action: 'screenshot',
      title: 'Source screenshot',
      attachment: {
        id: 'screenshot', kind: 'screenshot', name: attachmentName,
        relativePath: 'screenshot.png', mimeType: 'image/png', sizeBytes: 1,
      },
    }),
  ]))

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...fixtureDesktopEnvironment(),
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRoot,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
    },
  })
  try {
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('complementary', { name: 'Primary navigation' })
      .getByRole('button', { name: /^Long research text/ }).click()
    const research = page.getByLabel('Web research activity')
    await expect(research.getByRole('button', { name: /^Running research activity/ })).toBeVisible()
    await expect(research.getByRole('row', { name: /^Research activity/ })).toHaveCount(4)

    const tableContainer = research.locator('[data-slot="table-container"]')
    await expectNoHorizontalScroll(tableContainer)
    await expectEllipsis(research.getByText(longTitle, { exact: true }))
    await expectEllipsis(research.getByRole('button', { name: `Open ${longUrl}`, exact: true }).locator('span'))
    await expectEllipsis(research.getByText(`Opening ${longHost}`, { exact: true }))
    await expectEllipsis(research.getByText(longHost, { exact: true }))
    await expectEllipsis(research.getByText(attachmentName, { exact: true }))
    await page.screenshot({ path: testInfo.outputPath('research-ellipsis.png') })

    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('Research window is unavailable')
      window.setSize(1000, 760)
    })
    await expectNoHorizontalScroll(tableContainer)
    await expectNoHorizontalScroll(research)
    await expectNoHorizontalScroll(page.getByRole('region', { name: 'Run chat' }))
    await expectEllipsis(research.getByText(longTitle, { exact: true }))
    await page.screenshot({ path: testInfo.outputPath('research-ellipsis-narrow.png') })
  } finally {
    await app.close()
  }
})

async function expectNoHorizontalScroll(container: Locator): Promise<void> {
  await expect(container).toBeVisible()
  expect(await container.evaluate((element) => element.scrollWidth - element.clientWidth),
    'Research must fit without horizontal scrolling').toBeLessThanOrEqual(1)
}

async function expectEllipsis(text: Locator): Promise<void> {
  await expect(text).toBeVisible()
  await expect(text).toHaveCSS('text-overflow', 'ellipsis')
  expect(await text.evaluate((element) => element.scrollWidth > element.clientWidth),
    'Long research text must be abbreviated within its available width').toBe(true)
}
