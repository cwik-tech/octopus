import { expect, test as base, type ElectronApplication, type Page } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { launchDesktop } from './support/desktop-launch.js'

const test = base.extend<{ journey: { app: ElectronApplication; page: Page } }>({
  journey: [async ({}, use, info) => {
    // A saved delivery is the starting condition. The filesystem store,
    // artifact, local API, theme storage and native windows are real.
    const userDataPath = info.outputPath('user')
    const workspacePath = info.outputPath('workspace')
    const store = new FileSystemSessionStore(workspacePath)
    const session = await store.createSession({ title: 'Canvas theme' })
    await store.appendChatMessage(session.id, {
      id: 'theme-delivery', role: 'assistant', text: 'The theme document is ready.',
      createdAt: '2026-10-18T00:00:00.000Z',
      delivery: { taskId: 'theme-task', artifacts: [{ runId: 'theme-run', path: 'files/theme.md', role: 'final' }] },
    })
    const filesPath = path.join(workspacePath, 'assignments', 'theme-run', 'files')
    await fs.mkdir(filesPath, { recursive: true })
    await fs.writeFile(path.join(filesPath, 'theme.md'), '# Theme document\n\nShared window theme.')
    const app = await launchDesktop({ userDataPath, workspacePath })
    try {
      const page = await app.firstWindow()
      await page.locator(`[data-session-id="${session.id}"]`).getByRole('button').first().click()
      await page.getByRole('region', { name: 'Run chat', exact: true }).getByRole('button', { name: 'Open full view', exact: true }).click()
      await expect(page.getByRole('region', { name: 'Canvas workspace', exact: true }).getByRole('heading', { name: 'Theme document', exact: true })).toBeVisible()
      await use({ app, page })
    } finally { await app.close() }
  }, { timeout: 60_000 }],
})

test('detached Canvas follows theme changes and newly opened Canvas inherits light mode', async ({ journey }, info) => {
  const { app, page } = journey
  await page.getByRole('button', { name: 'Use dark mode', exact: true }).click()
  const source = page.getByRole('region', { name: 'Canvas workspace', exact: true })
  const opening = app.waitForEvent('window')
  await source.getByRole('button', { name: 'Open Canvas in new window', exact: true }).click()
  const detached = await opening
  await expect(detached.getByRole('heading', { name: 'Theme document', exact: true })).toBeVisible()
  await expect(detached.locator('html')).toHaveAttribute('data-theme', 'dark')

  await page.getByRole('button', { name: 'Use light mode', exact: true }).click()

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(detached.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(detached.locator('html')).not.toHaveClass(/\bdark\b/)
  await detached.screenshot({ path: info.outputPath('canvas-light.png'), animations: 'disabled' })

  await page.getByRole('button', { name: 'Use dark mode', exact: true }).click()
  await expect(detached.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('button', { name: 'Use light mode', exact: true }).click()
  await expect(detached.locator('html')).toHaveAttribute('data-theme', 'light')
  await detached.close()

  await expect(source.getByRole('button', { name: 'Open Canvas in new window', exact: true })).toBeVisible()
  const reopening = app.waitForEvent('window')
  await source.getByRole('button', { name: 'Open Canvas in new window', exact: true }).click()
  const reopened = await reopening
  await expect(reopened.getByRole('heading', { name: 'Theme document', exact: true })).toBeVisible()
  await expect(reopened.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(reopened.locator('html')).not.toHaveClass(/\bdark\b/)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
})
