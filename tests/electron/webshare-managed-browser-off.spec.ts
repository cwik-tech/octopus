import { _electron as electron, expect, test } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { startOpenAiToolLoopFixture } from '../support/openai-tool-loop-fixture.js'
import {
  closeSettings,
  configureModelProvider,
  createWebResearcherProject,
  openWebshareSettings,
  readSettledAcquisitions,
  seedAcquisitionSettings,
  selectWebResearcher,
  sendToWebResearcher,
  withoutWebshareEnvironment,
  type AcquisitionRecord,
} from '../support/webshare-electron-fixture.js'
import {
  startAuthenticatingProxy,
  startThreeWayOrigin,
} from './support/webshare-loopback-network.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const prompt = 'Conduct for me online research on ice creams in Ann Arbor.'

const PROXY_USER = 'loopback-webshare-user'
const PROXY_PASSWORD = 'loopback-webshare-password'

/**
 * With the Webshare switch off, managed Chrome stays exactly what it was.
 *
 * The required outcome is not merely that the proxy was left alone. Managed
 * Chrome must still acquire the source directly and produce usable evidence,
 * because the point of the switch is that turning it off costs nothing.
 *
 * This journey fails if the implementation globally proxies the managed
 * browser, reuses a proxied context while the switch is off, or disables the
 * ordinary managed-browser rung. The proxy is fully configured and running
 * throughout, so "never contacted" is a real observation rather than the
 * absence of an opportunity.
 */
test('after the Webshare switch is turned off, managed Chrome still acquires a source directly and the proxy is not contacted', async ({}, testInfo) => {
  test.setTimeout(300_000)
  const modelProvider = await startOpenAiToolLoopFixture(repoRoot)
  const braveSecret = `brave-webshare-off-${Date.now()}`
  const proxy = await startAuthenticatingProxy({
    username: PROXY_USER,
    password: PROXY_PASSWORD,
  })
  const origin = await startThreeWayOrigin({
    braveSecret,
    // The control: the direct read is still insufficient, so the browser rung
    // runs, but unproxied Chrome reads the page perfectly well.
    chromeAnswer: 'usable-without-the-proxy',
    proxyLocalPorts: proxy.proxyLocalPorts,
  })

  const projectRoot = testInfo.outputPath('webshare-off-project')
  const userDataPath = testInfo.outputPath('webshare-off-user-data')
  const workspacePath = testInfo.outputPath('webshare-off-workspace')
  const modelSecret = `webshare-off-model-${Date.now()}`

  await Promise.all([
    createWebResearcherProject(repoRoot, projectRoot),
    seedAcquisitionSettings(userDataPath),
    fs.mkdir(workspacePath, { recursive: true }),
  ])
  await fs.writeFile(
    path.join(userDataPath, 'browser-settings.json'),
    JSON.stringify({ version: 1, mode: 'headless' }),
    'utf8',
  )

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...fixtureDesktopEnvironment(withoutWebshareEnvironment(process.env)),
      NODE_ENV: 'test',
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRoot,
      PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
      PIPELINE_DESKTOP_E2E_BRAVE_ENDPOINT: `${origin.url}/res/v1/web/search`,
      OPENAI_API_KEY: modelSecret,
      OPENAI_BASE_URL: `${modelProvider.url}/v1`,
      BRAVE_SEARCH_API_KEY: braveSecret,
    },
  })

  try {
    const page = await app.firstWindow()
    await configureModelProvider(page, modelProvider.url, modelSecret)

    // Configure the proxy fully and turn it on, then turn it back off and save
    // again. Ending at "off" after a real "on" is what proves the stored off
    // state gates routing, rather than the proxy simply never being set up.
    await openWebshareSettings(page)
    const webshareSwitch = page.getByRole('switch', { name: 'Use Webshare proxy' })
    await expect(webshareSwitch).toBeEnabled()
    await page.getByRole('button', { name: 'Username and password' }).click()
    await page.getByLabel('Proxy host').fill('127.0.0.1')
    await page.getByLabel('Proxy port').fill(String(proxy.port))
    await page.getByLabel('Username').fill(PROXY_USER)
    await page.getByLabel('Password').fill(PROXY_PASSWORD)
    await webshareSwitch.click()
    await expect(webshareSwitch).toBeChecked()
    await page.getByRole('button', { name: 'Save settings' }).click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 30_000 })

    await webshareSwitch.click()
    await expect(webshareSwitch).not.toBeChecked()
    await page.getByRole('button', { name: 'Save settings' }).click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 30_000 })
    await closeSettings(page)

    await selectWebResearcher(page)
    await sendToWebResearcher(page, prompt)

    const acquired = await pollAcquisition(workspacePath, `${origin.url}/source/contested-1`)
    expect(acquired.attempts?.map((attempt) => attempt.method)).toEqual([
      'direct-http',
      'managed-browser',
    ])
    expect(acquired.attempts?.map((attempt) => attempt.outcome)).toEqual([
      'insufficient',
      'usable',
    ])
    // The usable receipt is the point: direct managed Chrome still works.
    expect(acquired.observationReceipt?.method).toBe('managed-browser')

    expect(origin.proxiedRequests).toEqual([])
    expect(proxy.connections).toBe(0)
    expect(proxy.challenges).toBe(0)

    await expect(
      page.locator('.group.is-assistant').filter({ hasText: 'BRAVE_PATH_CONFIRMED' }).last(),
    ).toBeVisible({ timeout: 180_000 })
  } finally {
    await Promise.allSettled([
      app.close(),
      modelProvider.close(),
      origin.close(),
      proxy.close(),
    ])
  }
})

async function pollAcquisition(
  workspacePath: string,
  requestedUrl: string,
): Promise<AcquisitionRecord> {
  let last: AcquisitionRecord | undefined
  await expect.poll(async () => {
    const settled = await readSettledAcquisitions(workspacePath)
    last = settled.find((row) => row.requestedUrl === requestedUrl)
    return last !== undefined
  }, { timeout: 180_000, intervals: [500] }).toBe(true)
  if (!last) throw new Error(`No settled acquisition recorded for ${requestedUrl}`)
  return last
}
