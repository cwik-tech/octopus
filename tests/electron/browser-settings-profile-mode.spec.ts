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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

interface BrowserSettingsResponse {
  error?: string
  mode: 'headed' | 'headless'
  status: 'running' | 'stopped' | 'unavailable'
}

test('opening the authenticated profile preserves the selected headless research mode', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const userDataPath = testInfo.outputPath('browser-profile-mode-user-data')
  await fs.mkdir(userDataPath, { recursive: true })
  await fs.writeFile(
    path.join(userDataPath, 'browser-settings.json'),
    JSON.stringify({ version: 1, mode: 'headless' }),
    'utf8',
  )

  const app = await launchDesktop(userDataPath)
  const page = await app.firstWindow()

  try {
    const apiBaseUrl = await desktopApiBaseUrl(page)
    const initial = await readBrowserSettings(apiBaseUrl)
    expect(initial.mode).toBe('headless')
    expect(
      initial.status,
      `Electron browser runtime is unavailable: ${initial.error ?? 'Chrome was not found'}`,
    ).not.toBe('unavailable')

    await page.getByLabel('Settings', { exact: true }).click()
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Research & Acquisition', exact: true })
      .click()

    const browserMode = page.getByRole('group', { name: 'Browser mode' })
    const headlessMode = browserMode.getByRole('button', { name: 'Headless' })
    await expect(headlessMode).toHaveAttribute('aria-pressed', 'true')

    await page.getByRole('button', { name: 'Open authenticated profile' }).click()
    await expect.poll(async () => readBrowserSettings(apiBaseUrl)).toMatchObject({
      mode: 'headless',
      status: 'running',
    })
    await expect(headlessMode).toHaveAttribute('aria-pressed', 'true')

    await page.getByRole('button', { name: 'Stop browser' }).click()
    await expect.poll(async () => readBrowserSettings(apiBaseUrl)).toMatchObject({
      mode: 'headless',
      status: 'stopped',
    })
  } finally {
    await app.close()
  }
})

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
      ...fixtureDesktopEnvironment(),
      PIPELINE_DESKTOP_E2E: '1',
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
    },
  })
}

async function desktopApiBaseUrl(page: Page): Promise<string> {
  await page.waitForURL((url) => url.hash.includes('pipeline-api-base-url='))
  const baseUrl = await page.evaluate(() =>
    new URLSearchParams(window.location.hash.slice(1)).get('pipeline-api-base-url'),
  )
  if (!baseUrl) throw new Error('Desktop API URL is unavailable')
  return baseUrl
}

async function readBrowserSettings(apiBaseUrl: string): Promise<BrowserSettingsResponse> {
  const response = await fetch(`${apiBaseUrl}/settings/browser`)
  const body: unknown = await response.json()
  if (!response.ok || !isBrowserSettingsResponse(body)) {
    throw new Error(`Browser settings returned an invalid ${response.status} response.`)
  }
  return body
}

function isBrowserSettingsResponse(value: unknown): value is BrowserSettingsResponse {
  if (!isRecord(value)) return false
  return (
    (value.mode === 'headed' || value.mode === 'headless') &&
    (value.status === 'running' || value.status === 'stopped' || value.status === 'unavailable') &&
    (value.error === undefined || typeof value.error === 'string')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
