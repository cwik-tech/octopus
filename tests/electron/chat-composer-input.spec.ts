import { _electron as electron, expect, test } from '@playwright/test'
import * as fs from 'node:fs/promises'

import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import {
  APP_DEFAULT_MODEL,
  desktopEnvironment,
  repoRoot,
  seedProviderSettings,
} from './support/model-selection-fixture.js'

test('clicking unused space in the Run composer focuses the message input and keeps its controls usable', async ({}, testInfo) => {
  // Replace only the paid model's HTTP boundary; the desktop and stores are real.
  const provider = await startFakeChatCompletionsServer({ script: [{ content: 'OK' }] })
  try {
    const workspacePath = testInfo.outputPath('workspace')
    const projectRoot = testInfo.outputPath('project')
    const userDataPath = testInfo.outputPath('user-data')
    await fs.mkdir(workspacePath, { recursive: true })
    await fs.mkdir(projectRoot, { recursive: true })
    await seedProviderSettings({ userDataPath, baseUrl: provider.url, defaultModel: APP_DEFAULT_MODEL })
    await new FileSystemSessionStore(workspacePath).createSession({ title: 'Composer input' })
    const app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }),
    })
    try {
      const page = await app.firstWindow()
      await page.getByRole('tab', { name: 'Run', exact: true }).click()
      await page.locator('[data-slot="workspace-sidebar"][data-side="left"]')
        .getByRole('button', { name: /^Composer input\b/ }).click()

      const input = page.getByPlaceholder('Send a message...')
      await input.click({ timeout: 5_000 })
      await expect(input).toBeFocused()
      await input.pressSequentially('Draft message')
      await expect(input).toHaveValue('Draft message')

      await page.getByRole('button', { name: 'Add files or MCP resources' }).click()
      await expect(page.getByRole('menuitem', { name: 'Add Files' })).toBeVisible()
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Run chat model', exact: true }).click()
      await expect(page.getByPlaceholder('Search models...')).toBeVisible()
    } finally {
      await app.close()
    }
  } finally {
    await provider.close()
  }
})
