import { _electron as electron, expect, test } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { cliFixtureSettings, createCliDiscoveryFixture } from '../support/cli-discovery-fixture.js'
import { desktopEnvironment, repoRoot } from './support/model-selection-fixture.js'

test('first launch shows saved chat models and Settings before discovery finishes, then updates both', async ({}, testInfo) => {
  const root = testInfo.outputPath('startup')
  const projectRoot = path.join(root, 'project')
  const workspacePath = path.join(root, 'workspace')
  const userDataPath = path.join(root, 'user-data')
  await fs.cp(path.join(repoRoot, 'tests/fixtures/packaged-workflow-smoke'), projectRoot, { recursive: true })
  await fs.mkdir(userDataPath, { recursive: true })
  const storagePath = path.join(userDataPath, 'provider-settings.json')
  await fs.writeFile(storagePath, JSON.stringify(cliFixtureSettings()))
  await new FileSystemSessionStore(workspacePath).createSession({ title: 'Saved startup chat' })
  const fixture = await createCliDiscoveryFixture(root)
  try {
    const originalPath = process.env.PATH
    const originalFallback = process.env.PIPELINE_CLI_PATH_FALLBACK
    try {
      process.env.PATH = fixture.bin
      process.env.PIPELINE_CLI_PATH_FALLBACK = '0'
      await new ProviderSettingsService({ storagePath }).snapshot(true)
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      if (originalFallback === undefined) delete process.env.PIPELINE_CLI_PATH_FALLBACK
      else process.env.PIPELINE_CLI_PATH_FALLBACK = originalFallback
    }
    const started = fixture.hold()
    const environment = desktopEnvironment({ projectRoot, workspacePath, userDataPath })
    // Only our fixture CLI is added to the sanitized desktop environment.
    environment.PATH = `${fixture.bin}${path.delimiter}${environment.PATH ?? ''}`
    const app = await electron.launch({ args: ['.'], cwd: repoRoot, env: environment })
    try {
      const page = await app.firstWindow()
      const model = page.getByRole('button', { name: 'Run chat model', exact: true })
      await expect(model).toContainText('saved-model')
      await expect(page.getByRole('button', { name: /Saved startup chat/ }).first()).toBeVisible()
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Default model', exact: true })).toContainText('saved-model')
      await page.getByRole('button', { name: /^Qwen Code/ }).click()
      await expect(page.getByRole('switch', { name: 'Enable saved-model', exact: true })).toBeVisible()
      await started
      await page.screenshot({ path: testInfo.outputPath('saved-models-before-discovery.png') })

      fixture.release('new-model')

      await expect(page.getByRole('switch', { name: 'Enable new-model', exact: true })).toBeVisible()
      await expect(page.getByRole('switch', { name: 'Enable saved-model', exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: 'Close', exact: true }).click()
      await model.click()
      await expect(page.getByRole('option', { name: /new-model/ })).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath('refreshed-chat-models.png') })
    } finally {
      fixture.release()
      await app.close()
    }
  } finally {
    fixture.release()
    await fixture.close()
  }
})
