import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  closeSettings,
  openWebshareSettings,
  withoutWebshareEnvironment,
} from '../support/webshare-electron-fixture.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The Webshare switch is a stored decision, not a screen state.
 *
 * A component test can prove the panel calls its client. It cannot prove that
 * the renderer reached the settings API, that the main process wrote the file,
 * or that a reopened dialog reads what is on disk rather than surviving on
 * React state. Only a real desktop journey can, and only a restart exercises
 * the read the main process performs when it starts.
 *
 * Routing is a separate outcome with its own journeys, so it is not asserted
 * here: `webshare-proxy-routing.spec.ts` proves the switch changes what
 * acquisition does, and `webshare-managed-browser-off.spec.ts` proves turning
 * it off leaves managed Chrome working directly.
 */
test('the Webshare switch survives closing the settings dialog and restarting the desktop app', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const userDataPath = testInfo.outputPath('webshare-switch-user-data')
  await fs.mkdir(userDataPath, { recursive: true })

  const app = await launchDesktop(userDataPath)
  const page = await app.firstWindow()
  try {
    await openWebshareSettings(page)
    const webshareSwitch = page.getByRole('switch', { name: 'Use Webshare proxy' })
    await expect(webshareSwitch).not.toBeChecked()
    // A developer's own Webshare variables would put the panel in its
    // read-only environment mode and disable every control. The launch
    // scrubs them; this turns a machine where that failed into a clear
    // failure rather than a confusing one.
    await expect(webshareSwitch).toBeEnabled()

    await page.getByRole('button', { name: 'Username and password' }).click()
    await page.getByLabel('Proxy host').fill('127.0.0.1')
    await page.getByLabel('Proxy port').fill('18080')
    await page.getByLabel('Username').fill('switch-journey-user')
    await page.getByLabel('Password').fill('switch-journey-password')
    await webshareSwitch.click()
    await expect(webshareSwitch).toBeChecked()
    await page.getByRole('button', { name: 'Save settings' }).click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 30_000 })

    // Reopening the dialog in the same app proves the panel re-reads persisted
    // state instead of showing what the user just clicked.
    await closeSettings(page)
    await openWebshareSettings(page)
    await expect(page.getByRole('switch', { name: 'Use Webshare proxy' })).toBeChecked()

    await expect.poll(async () => {
      const persisted: unknown = JSON.parse(
        await fs.readFile(path.join(userDataPath, 'youtube-settings.json'), 'utf8'),
      )
      return isRecord(persisted) ? persisted.proxyEnabled : undefined
    }, { timeout: 30_000 }).toBe(true)
  } finally {
    await app.close()
  }

  // The store is a file the main process reads when it is constructed, so a
  // restart is the honest proof that the decision outlived the session.
  const restarted = await launchDesktop(userDataPath)
  const restartedPage = await restarted.firstWindow()
  try {
    await openWebshareSettings(restartedPage)
    await expect(
      restartedPage.getByRole('switch', { name: 'Use Webshare proxy' }),
    ).toBeChecked()
    await expect(restartedPage.getByLabel('Proxy host')).toHaveValue('127.0.0.1')
  } finally {
    await restarted.close()
  }
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function launchDesktop(userDataPath: string): Promise<ElectronApplication> {
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
      ...fixtureDesktopEnvironment(withoutWebshareEnvironment(process.env)),
      PIPELINE_DESKTOP_E2E: '1',
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
    },
  })
}
