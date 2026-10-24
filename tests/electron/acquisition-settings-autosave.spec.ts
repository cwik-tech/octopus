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
const browserUseKey = 'bu_e2e_autosave_secret'

interface AcquisitionSettingsResponse {
  readonly providers: {
    readonly 'browser-use': {
      readonly enabled: boolean
      readonly hasApiKey: boolean
    }
  }
  readonly budgets: {
    readonly maximumCloudBrowserCalls: number
  }
}

test('Browser Use settings autosave through Electron and return after restart', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const userDataPath = testInfo.outputPath('acquisition-autosave-user-data')
  await fs.mkdir(userDataPath, { recursive: true })

  let app = await launchDesktop(userDataPath)
  let page = await app.firstWindow()
  try {
    await openAcquisitionSettings(page)
    const apiBaseUrl = await desktopApiBaseUrl(page)
    const key = page.getByLabel('Browser Use API key')
    const enabled = page.getByRole('switch', { name: 'Enable Browser Use' })
    const callBudget = page.getByRole('spinbutton', { name: 'Cloud browser calls' })

    await expect(key).toHaveAttribute('type', 'password')
    await expect(enabled).toBeDisabled()
    await expect(callBudget).toHaveValue('0')

    await key.fill(browserUseKey)
    await key.press('Enter')
    await expect.poll(async () => {
      const settings = await readAcquisitionSettings(apiBaseUrl)
      return settings.providers['browser-use'].hasApiKey
    }).toBe(true)
    await expect(key).toHaveValue('')
    await expect(enabled).toBeEnabled()

    await enabled.click()
    await callBudget.fill('2')
    await callBudget.press('Enter')
    await expect.poll(async () => {
      const settings = await readAcquisitionSettings(apiBaseUrl)
      return {
        enabled: settings.providers['browser-use'].enabled,
        maximumCloudBrowserCalls: settings.budgets.maximumCloudBrowserCalls,
      }
    }).toEqual({ enabled: true, maximumCloudBrowserCalls: 2 })
    await expect(page.getByText('Acquisition settings saved.', { exact: true })).toBeVisible()
  } finally {
    await app.close()
  }

  const persisted = await fs.readFile(
    path.join(userDataPath, 'research-acquisition-settings.json'),
    'utf8',
  )
  expect(persisted).not.toContain(browserUseKey)

  app = await launchDesktop(userDataPath)
  page = await app.firstWindow()
  try {
    await openAcquisitionSettings(page)
    await expect(page.getByLabel('Browser Use API key')).toHaveAttribute(
      'placeholder',
      /key configured/u,
    )
    await expect(page.getByRole('switch', { name: 'Enable Browser Use' })).toBeChecked()
    await expect(page.getByRole('spinbutton', { name: 'Cloud browser calls' })).toHaveValue('2')
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

async function openAcquisitionSettings(page: Page): Promise<void> {
  await page.getByLabel('Settings', { exact: true }).click()
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Research & Acquisition', exact: true })
    .click()
  await expect(page.getByRole('heading', { name: 'Search and acquisition' })).toBeVisible()
}

async function desktopApiBaseUrl(page: Page): Promise<string> {
  const baseUrl = await page.evaluate(() =>
    new URLSearchParams(window.location.hash.slice(1)).get('pipeline-api-base-url'),
  )
  if (!baseUrl) throw new Error('Desktop API URL is unavailable')
  return baseUrl
}

async function readAcquisitionSettings(
  apiBaseUrl: string,
): Promise<AcquisitionSettingsResponse> {
  const response = await fetch(`${apiBaseUrl}/settings/research-acquisition`)
  const body: unknown = await response.json()
  if (!response.ok || !isAcquisitionSettingsResponse(body)) {
    throw new Error(`Acquisition settings returned an invalid ${response.status} response.`)
  }
  return body
}

function isAcquisitionSettingsResponse(
  value: unknown,
): value is AcquisitionSettingsResponse {
  if (!isRecord(value) || !isRecord(value.providers) || !isRecord(value.budgets)) {
    return false
  }
  const browserUse = value.providers['browser-use']
  return (
    isRecord(browserUse) &&
    typeof browserUse.enabled === 'boolean' &&
    typeof browserUse.hasApiKey === 'boolean' &&
    typeof value.budgets.maximumCloudBrowserCalls === 'number'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
