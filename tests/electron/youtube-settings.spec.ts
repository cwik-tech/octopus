import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { withoutWebshareEnvironment } from '../support/webshare-electron-fixture.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('desktop settings reject an invalid Gemini key before persistence and remain unconfigured after restart', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const userDataPath = testInfo.outputPath('youtube-settings-user-data')
  await fs.mkdir(userDataPath, { recursive: true })
  const app = await launchDesktop(userDataPath)
  const page = await app.firstWindow()
  try {
    await openYoutubeSettings(page)
    const key = page.getByLabel('Google AI Studio API key')
    await expect(key).toHaveAttribute('type', 'password')
    await expect(page.getByRole('button', { name: 'Gemini model' })).toContainText(
      'gemini-3.6-flash',
    )
    const rollingHelp = page.getByRole('button', {
      name: 'About rolling 24-hour video limit',
    })
    await rollingHelp.hover()
    await expect(page.getByText(
      'not a Google API quota',
      { exact: false },
    )).toBeVisible()
    const thresholdHelp = page.getByRole('button', {
      name: 'About long-video confirmation threshold',
    })
    await thresholdHelp.hover()
    await expect(page.getByText(
      'A single video longer than this value requires confirmation',
      { exact: false },
    )).toBeVisible()
    await key.fill('invalid-e2e-gemini-key')
    await page.getByRole('button', { name: 'Save and validate' }).click()
    await expect(page.getByRole('alert')).toContainText(
      'Gemini model validation failed.',
      { timeout: 30_000 },
    )
    await expect(key).toHaveValue('invalid-e2e-gemini-key')
    await expect(page.getByTestId('research-acquisition-settings').getByText(
      'Not configured', { exact: true },
    )).toBeVisible()
  } finally {
    await app.close()
  }

  const persistedPath = path.join(userDataPath, 'youtube-settings.json')
  const persisted = await fs.readFile(persistedPath, 'utf8').catch(() => '')
  expect(persisted).not.toContain('invalid-e2e-gemini-key')
  if (persisted) {
    expect(JSON.parse(persisted).encryptedGeminiApiKey).toBeUndefined()
  }

  const restarted = await launchDesktop(userDataPath)
  const restartedPage = await restarted.firstWindow()
  try {
    await openYoutubeSettings(restartedPage)
    await expect(restartedPage.getByLabel('Google AI Studio API key')).toHaveAttribute(
      'placeholder',
      /Paste your Gemini API key/,
    )
    await expect(restartedPage.getByTestId('research-acquisition-settings').getByText(
      'Not configured', { exact: true },
    )).toBeVisible()
  } finally {
    await restarted.close()
  }
})

test('desktop retains videos by default and persists the delete-after-extraction switch', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const userDataPath = testInfo.outputPath('youtube-retention-settings-user-data')
  await fs.mkdir(userDataPath, { recursive: true })
  const app = await launchDesktop(userDataPath)
  const page = await app.firstWindow()
  try {
    await openYoutubeSettings(page)
    const retention = page.getByRole('switch', {
      name: 'Delete videos after info extraction',
    })
    await expect(retention).not.toBeChecked()
    await retention.click()
    await expect(retention).toBeChecked()
    await expect.poll(async () => {
      const persisted = JSON.parse(await fs.readFile(
        path.join(userDataPath, 'youtube-settings.json'),
        'utf8',
      ))
      return persisted.deleteVideosAfterInfoExtraction
    }).toBe(true)
  } finally {
    await app.close()
  }

  const restarted = await launchDesktop(userDataPath)
  const restartedPage = await restarted.firstWindow()
  try {
    await openYoutubeSettings(restartedPage)
    await expect(restartedPage.getByRole('switch', {
      name: 'Delete videos after info extraction',
    })).toBeChecked()
  } finally {
    await restarted.close()
  }
})

async function launchDesktop(userDataPath: string): Promise<ElectronApplication> {
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

async function openYoutubeSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Research & Acquisition', exact: true })
    .click()
  await expect(page.getByRole('heading', { name: 'YouTube video analysis' })).toBeVisible()
}
