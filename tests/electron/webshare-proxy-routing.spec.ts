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
const PROXY_COUNTRY = 'us'
/**
 * Webshare encodes country targeting into the username, and the app does the
 * same: `targetedUsername` turns the configured name into
 * `<user>-<country>-rotate`. The proxy expects the transformed name, so a
 * change to that rule fails here rather than falling through to the next rung.
 */
const EXPECTED_PROXY_USER = `${PROXY_USER}-${PROXY_COUNTRY}-rotate`

/**
 * Turning the Webshare switch on makes a managed-Chrome denial retry from a
 * different egress.
 *
 * The user outcome is routing, not a stored flag, and the evidence is the
 * persisted acquisition journal: the research disclosure deliberately carries
 * no attempt methods, so nothing on screen can show which transport produced
 * the page.
 *
 * The proxy stands in for Webshare. That substitution is deliberate - the real
 * service is credentialed and its egress is nondeterministic - and it is the
 * only one. The app, the settings save, managed Chrome, the origin and the
 * proxy transport are all real, and no live network is used.
 */
test('with the Webshare switch on, a managed-Chrome denial is retried through the controlled proxy', async ({}, testInfo) => {
  test.setTimeout(300_000)
  const modelProvider = await startOpenAiToolLoopFixture(repoRoot)
  const braveSecret = `brave-webshare-browser-${Date.now()}`
  const proxy = await startAuthenticatingProxy({
    username: EXPECTED_PROXY_USER,
    password: PROXY_PASSWORD,
  })
  const origin = await startThreeWayOrigin({
    braveSecret,
    chromeAnswer: 'usable-only-through-the-proxy',
    proxyLocalPorts: proxy.proxyLocalPorts,
  })

  const projectRoot = testInfo.outputPath('webshare-browser-project')
  const userDataPath = testInfo.outputPath('webshare-browser-user-data')
  const workspacePath = testInfo.outputPath('webshare-browser-workspace')
  const modelSecret = `webshare-browser-model-${Date.now()}`

  await Promise.all([
    createWebResearcherProject(repoRoot, projectRoot),
    seedAcquisitionSettings(userDataPath),
    fs.mkdir(workspacePath, { recursive: true }),
  ])
  // Managed Chrome runs headless in this journey; the mode is a persisted
  // desktop setting, so it is seeded rather than clicked.
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

    await openWebshareSettings(page)
    const webshareSwitch = page.getByRole('switch', { name: 'Use Webshare proxy' })
    await expect(webshareSwitch).not.toBeChecked()
    await expect(webshareSwitch).toBeEnabled()
    await page.getByRole('button', { name: 'Username and password' }).click()
    await page.getByLabel('Proxy host').fill('127.0.0.1')
    await page.getByLabel('Proxy port').fill(String(proxy.port))
    await page.getByLabel('Country codes').fill(PROXY_COUNTRY)
    await page.getByLabel('Username').fill(PROXY_USER)
    await page.getByLabel('Password').fill(PROXY_PASSWORD)
    await webshareSwitch.click()
    await expect(webshareSwitch).toBeChecked()
    await page.getByRole('button', { name: 'Save settings' }).click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 30_000 })
    await closeSettings(page)

    await selectWebResearcher(page)
    await sendToWebResearcher(page, prompt)

    const recovered = await pollAcquisition(workspacePath, `${origin.url}/source/contested-1`)
    // The trail is the whole claim. `direct-http-proxied` is absent because the
    // direct read was insufficient rather than denied, so only the new rung can
    // have produced a usable page here.
    expect(recovered.attempts?.map((attempt) => attempt.method)).toEqual([
      'direct-http',
      'managed-browser',
      'managed-browser-proxied',
    ])
    expect(recovered.attempts?.map((attempt) => attempt.outcome)).toEqual([
      'insufficient',
      'access-denied',
      'usable',
    ])
    expect(recovered.observationReceipt?.method).toBe('managed-browser-proxied')

    // And the read really left through the proxy, under the country-targeted
    // credential the app derives.
    expect(origin.proxiedRequests).toContain('/source/contested-1')
    expect(proxy.challenges).toBeGreaterThan(0)
    expect(
      Buffer.from(
        String(proxy.acceptedAuthorizations[0]).replace(/^Basic /u, ''),
        'base64',
      ).toString('utf8'),
    ).toBe(`${EXPECTED_PROXY_USER}:${PROXY_PASSWORD}`)
    expect(origin.credentialHeadersSeen).toEqual([])

    // The recovered source still reaches the user as a cited answer.
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

/** Reads the journal the app writes, which is the only place methods survive. */
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
