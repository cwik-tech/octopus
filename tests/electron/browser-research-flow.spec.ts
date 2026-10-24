import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { setFrontMatterFields } from '../support/config-rewrite.js'
import { startOpenAiToolLoopFixture } from '../support/openai-tool-loop-fixture.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('web researcher pivots from CAPTCHA, answers directly, orders activity, and survives restart', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const providerFixture = await startOpenAiToolLoopFixture(repoRoot)
  const website = createResearchWebsite()
  const sourceBaseUrl = await listen(website)
  const fallbackBaseUrl = sourceBaseUrl.replace('127.0.0.1', 'localhost')
  const userDataPath = testInfo.outputPath('browser-research-user-data')
  const projectRoot = testInfo.outputPath('browser-research-project')
  const providerSecret = `browser-research-secret-${Date.now()}`
  await Promise.all([
    createWebResearcher(projectRoot),
    fs.mkdir(userDataPath, { recursive: true }),
  ])
  await fs.writeFile(
    path.join(userDataPath, 'browser-settings.json'),
    JSON.stringify({ version: 1, mode: 'headless' }),
    'utf8',
  )

  let app = await launchDesktop({
    projectRoot,
    providerSecret,
    providerUrl: providerFixture.url,
    userDataPath,
  })
  let page = await app.firstWindow()

  try {
    await configureProvider(page, providerFixture.url, providerSecret)
    await sendResearchQuestion(page, sourceBaseUrl, fallbackBaseUrl)

    const answer = page.locator('.group.is-assistant').filter({
      hasText: 'Verified answer: E2E_REPORT_CODE_ORBITAL_742',
    }).last()
    // The answer is the turn's completion signal. A first turn creates its
    // session on send, so sendResearchQuestion can return before it starts.
    await expect(answer).toBeVisible({ timeout: 30_000 })
    await expect(answer.getByText('Web Researcher')).toBeVisible()
    await expect(answer.getByLabel('Web research activity')).toBeVisible()
    const researchTrigger = answer.getByRole('button', { name: /Research activity: 3 steps/ })
    await expect(researchTrigger).toHaveAttribute('aria-expanded', 'false')
    await researchTrigger.click()
    // A CAPTCHA no longer bans the host, so the repeat visit meets the same challenge.
    await expect(answer.getByRole('row', { name: 'Research activity open access_challenge' })).toHaveCount(2)
    await expect(answer.getByRole('row', { name: 'Research activity open completed' })).toBeVisible()
    await expect(page.getByText('browser · open')).toHaveCount(0)
    await expect(answer).toContainText(`Source: ${fallbackBaseUrl}/good`)
    await expect(answer.getByRole('button', { name: 'Used 1 sources' })).toBeVisible()
    await expect(page.getByText(/Open Questions:|Next Step:/)).toHaveCount(0)
    await expect(page.getByText(/If you want|Would you like|Let me know/i)).toHaveCount(0)

    expect(await page.evaluate(() => {
      const user = [...document.querySelectorAll<HTMLElement>('.group.is-user')].at(-1)
      const answer = [...document.querySelectorAll<HTMLElement>('.group.is-assistant')].at(-1)
      const research = answer?.querySelector<HTMLElement>('[aria-label="Web research activity"]')
      if (!user || !answer || !research) return false
      return Boolean(user.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        answer.contains(research)
    })).toBe(true)

    // Address the session by its durable id rather than by a title. A chat
    // session is deliberately left untitled when no title model produced one
    // (`domains/sessions/session-title.ts`), so every row reads "Untitled
    // session" and a title match would either find nothing or pick whichever
    // duplicate happened to sort first. The id is resolved from the one message
    // this journey persisted, then given a unique title so the restored window
    // can be pointed at that exact session.
    const restoredTitle = `Browser research restart ${Date.now()}`
    await renameSessionOwningMessage(page, `${sourceBaseUrl}/challenge`, restoredTitle)

    await app.close()
    app = await launchDesktop({
      projectRoot,
      providerSecret,
      providerUrl: providerFixture.url,
      userDataPath,
    })
    page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run' }).click()
    // The row's accessible name is its title followed by relative-time meta,
    // so this anchors on the title rather than demanding an exact match.
    const restoredSessionButton = page.getByRole('tabpanel', { name: 'Run' })
      .getByRole('button', { name: new RegExp(`^${restoredTitle}\\b`) })
    // The title is unique to this run, so exactly one row may carry it. Taking
    // the first of several would hide a second session answering to it.
    await expect(restoredSessionButton).toHaveCount(1)
    await restoredSessionButton.evaluate((button: HTMLButtonElement) => button.click())
    const restoredAnswer = page.locator('.group.is-assistant').filter({
      hasText: 'Verified answer: E2E_REPORT_CODE_ORBITAL_742',
    }).last()
    await expect(restoredAnswer).toBeVisible()
    await expect(restoredAnswer.getByLabel('Web research activity')).toBeVisible()
    await expect(restoredAnswer.getByRole('button', { name: /Research activity: 3 steps/ }))
      .toHaveAttribute('aria-expanded', 'false')
  } finally {
    await Promise.allSettled([
      app.close(),
      providerFixture.close(),
      new Promise<void>((resolve) => website.close(() => resolve())),
    ])
  }
})

test('research activity announces that it is running and collapses when the answer arrives', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const providerFixture = await startOpenAiToolLoopFixture(repoRoot)
  const website = createResearchWebsite({ slowSourceMs: 6_000 })
  const sourceBaseUrl = await listen(website)
  const fallbackBaseUrl = sourceBaseUrl.replace('127.0.0.1', 'localhost')
  const userDataPath = testInfo.outputPath('research-running-user-data')
  const projectRoot = testInfo.outputPath('research-running-project')
  const providerSecret = `research-running-secret-${Date.now()}`
  await Promise.all([
    createWebResearcher(projectRoot),
    fs.mkdir(userDataPath, { recursive: true }),
  ])
  await fs.writeFile(
    path.join(userDataPath, 'browser-settings.json'),
    JSON.stringify({ version: 1, mode: 'headless' }),
    'utf8',
  )

  const app = await launchDesktop({
    projectRoot,
    providerSecret,
    providerUrl: providerFixture.url,
    userDataPath,
  })
  const page = await app.firstWindow()

  try {
    await configureProvider(page, providerFixture.url, providerSecret)
    await startResearchQuestion(page, sourceBaseUrl, fallbackBaseUrl)

    const runningTrigger = page.getByRole('button', { name: /Running research activity/ })
    await expect(runningTrigger).toBeVisible({ timeout: 60_000 })
    await expect(runningTrigger).toHaveAttribute('aria-expanded', 'true')

    await expect(page.getByRole('button', { name: 'Send message' }))
      .toBeEnabled({ timeout: 60_000 })

    const answer = page.locator('.group.is-assistant').filter({
      hasText: 'Verified answer: E2E_REPORT_CODE_ORBITAL_742',
    }).last()
    await expect(answer).toBeVisible()
    const settledTrigger = answer.getByRole('button', { name: /Research activity: / })
    await expect(settledTrigger).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('button', { name: /Running research activity/ }))
      .toHaveCount(0)
  } finally {
    await Promise.allSettled([
      app.close(),
      providerFixture.close(),
      new Promise<void>((resolve) => website.close(() => resolve())),
    ])
  }
})

test('research results read as a table of visited pages with site icons', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const providerFixture = await startOpenAiToolLoopFixture(repoRoot)
  const website = createResearchWebsite()
  const sourceBaseUrl = await listen(website)
  const fallbackBaseUrl = sourceBaseUrl.replace('127.0.0.1', 'localhost')
  const userDataPath = testInfo.outputPath('research-table-user-data')
  const projectRoot = testInfo.outputPath('research-table-project')
  const providerSecret = `research-table-secret-${Date.now()}`
  await Promise.all([
    createWebResearcher(projectRoot),
    fs.mkdir(userDataPath, { recursive: true }),
  ])
  await fs.writeFile(
    path.join(userDataPath, 'browser-settings.json'),
    JSON.stringify({ version: 1, mode: 'headless' }),
    'utf8',
  )

  const app = await launchDesktop({
    projectRoot,
    providerSecret,
    providerUrl: providerFixture.url,
    userDataPath,
  })
  const page = await app.firstWindow()

  try {
    await configureProvider(page, providerFixture.url, providerSecret)
    await sendResearchQuestion(page, sourceBaseUrl, fallbackBaseUrl)

    const answer = page.locator('.group.is-assistant').filter({
      hasText: 'Verified answer: E2E_REPORT_CODE_ORBITAL_742',
    }).last()
    await expect(answer).toBeVisible({ timeout: 30_000 })
    await answer.getByRole('button', { name: /research activity: /i }).click()

    // Steps read as table rows, keeping their existing accessible names.
    const openedRow = answer.getByRole('row', { name: 'Research activity open completed' })
    await expect(openedRow).toBeVisible()
    await expect(answer.getByRole('row', { name: 'Research activity open access_challenge' }))
      .toHaveCount(2)
    await expect(openedRow).toContainText('localhost')

    // The icon travelled over connect-src and became a blob, so the strict
    // img-src CSP is still intact. No component test can prove this.
    await expect(openedRow.locator('img')).toHaveAttribute('src', /^blob:/, {
      timeout: 30_000,
    })

    // Opening a result hands the exact page URL to the OS, rather than merely
    // failing to navigate the renderer.
    await app.evaluate(({ shell }) => {
      const state = globalThis as typeof globalThis & {
        __pipelineOpenedExternalUrls?: string[]
      }
      state.__pipelineOpenedExternalUrls = []
      shell.openExternal = async (url: string) => {
        state.__pipelineOpenedExternalUrls?.push(url)
      }
    })
    await openedRow.getByRole('button').first().click()
    await expect.poll(async () => app.evaluate(() => (
      globalThis as typeof globalThis & { __pipelineOpenedExternalUrls?: string[] }
    ).__pipelineOpenedExternalUrls ?? [])).toEqual([`${fallbackBaseUrl}/good`])
  } finally {
    await Promise.allSettled([
      app.close(),
      providerFixture.close(),
      new Promise<void>((resolve) => website.close(() => resolve())),
    ])
  }
})

async function launchDesktop(params: {
  projectRoot: string
  providerSecret: string
  providerUrl: string
  userDataPath: string
}): Promise<ElectronApplication> {
  const executablePath = process.env.PIPELINE_DESKTOP_EXECUTABLE
    ? path.resolve(repoRoot, process.env.PIPELINE_DESKTOP_EXECUTABLE)
    : null
  return electron.launch({
    args: executablePath ? [] : ['.'],
    cwd: repoRoot,
    ...(executablePath ? { executablePath } : {}),
    env: {
      ...fixtureDesktopEnvironment(),
      NODE_ENV: 'test',
      PIPELINE_DESKTOP_E2E: '1',
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
      PIPELINE_DESKTOP_PROJECT_ROOT: params.projectRoot,
      PIPELINE_DESKTOP_USER_DATA: params.userDataPath,
      OPENAI_API_KEY: params.providerSecret,
      OPENAI_BASE_URL: `${params.providerUrl}/v1`,
    },
  })
}

async function configureProvider(
  page: Page,
  providerUrl: string,
  providerSecret: string,
): Promise<void> {
  await page.getByLabel('Settings', { exact: true }).click()
  await expect(page.getByRole('heading', { name: 'AI Providers' })).toBeVisible()
  await page.getByRole('button', { name: 'Add' }).click()
  await page.getByLabel('Connection type').selectOption('openai-compatible')
  await page.getByLabel('Name').fill('Browser Research Fixture')
  await page.getByLabel('Base URL').fill(`${providerUrl}/v1`)
  await page.getByRole('textbox', { name: 'API key', exact: true }).fill(providerSecret)
  await page.getByRole('button', { name: 'Save & Validate' }).click()
  await page.getByRole('button', { name: /^Browser Research Fixture/ }).click()
  await page.getByRole('switch', {
    name: 'Enable fixture/browser-research',
    exact: true,
  }).click()
  await page.getByRole('button', { name: 'Close' }).click()
}

async function sendResearchQuestion(
  page: Page,
  sourceBaseUrl: string,
  fallbackBaseUrl: string,
): Promise<void> {
  await page.getByRole('tab', { name: 'Run' }).click()
  await page.getByRole('button', { name: 'Search Agents' }).click()
  const search = page.getByRole('searchbox', { name: 'Search Agents' })
  await search.fill('web-researcher')
  await page.getByRole('button', { name: /^Web Researcher/i }).click()
  const input = page.getByPlaceholder('Send a message to the selected agents...')
  await expect(input).toBeEnabled()
  await input.fill([
    `Challenge URL: ${sourceBaseUrl}/challenge`,
    `Good URL: ${fallbackBaseUrl}/good`,
  ].join('\n'))
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByRole('button', { name: 'Send message' }))
    .toBeEnabled({ timeout: 30_000 })
}

/** Send the question without waiting for the turn, so the run can be observed mid-flight. */
async function startResearchQuestion(
  page: Page,
  sourceBaseUrl: string,
  fallbackBaseUrl: string,
): Promise<void> {
  await page.getByRole('tab', { name: 'Run' }).click()
  await page.getByRole('button', { name: 'Search Agents' }).click()
  const search = page.getByRole('searchbox', { name: 'Search Agents' })
  await search.fill('web-researcher')
  await page.getByRole('button', { name: /^Web Researcher/i }).click()
  const input = page.getByPlaceholder('Send a message to the selected agents...')
  await expect(input).toBeEnabled()
  await input.fill([
    `Challenge URL: ${sourceBaseUrl}/challenge`,
    `Good URL: ${fallbackBaseUrl}/good`,
  ].join('\n'))
  await page.getByRole('button', { name: 'Send message' }).click()
}

/**
 * Give the session that persisted `messageNeedle` a known title, addressing it
 * by id.
 *
 * The renderer publishes its API base on the location hash, which is how other
 * Electron specs reach the same API. Ownership is established by the message
 * this journey actually sent, so no display name is ever matched.
 */
async function renameSessionOwningMessage(
  page: Page,
  messageNeedle: string,
  title: string,
): Promise<string> {
  const apiBaseUrl = await page.evaluate(() =>
    new URLSearchParams(window.location.hash.slice(1)).get('pipeline-api-base-url'))
  if (apiBaseUrl === null) {
    throw new Error('The renderer published no pipeline-api-base-url on its hash')
  }

  const lookup = await page.evaluate(async ({ base, needle }) => {
    const listed = await fetch(`${base}/sessions`)
    if (!listed.ok) return { error: `GET /sessions returned ${listed.status}` }
    const { sessions } = (await listed.json()) as { sessions: { id: string }[] }
    const searched: string[] = []
    for (const session of sessions) {
      const response = await fetch(`${base}/sessions/${encodeURIComponent(session.id)}/messages`)
      if (!response.ok) {
        return { error: `GET messages for ${session.id} returned ${response.status}` }
      }
      searched.push(session.id)
      const { messages } = (await response.json()) as { messages: { text?: string }[] }
      if (messages.some((message) => (message.text ?? '').includes(needle))) {
        return { sessionId: session.id }
      }
    }
    return { error: `no session among [${searched.join(', ')}] persisted the research question` }
  }, { base: apiBaseUrl, needle: messageNeedle })
  if (!('sessionId' in lookup) || lookup.sessionId === undefined) {
    throw new Error(`Could not resolve the research session: ${lookup.error ?? 'unknown reason'}`)
  }
  const sessionId = lookup.sessionId

  const renamed = await page.evaluate(async ({ base, id, nextTitle }) => {
    const response = await fetch(`${base}/sessions/${encodeURIComponent(id)}`, {
      body: JSON.stringify({ title: nextTitle }),
      headers: { 'content-type': 'application/json' },
      method: 'PATCH',
    })
    return { body: await response.text(), status: response.status }
  }, { base: apiBaseUrl, id: sessionId, nextTitle: title })
  expect(renamed.status, `PATCH /sessions/${sessionId} said: ${renamed.body}`).toBe(200)

  return sessionId
}

async function createWebResearcher(projectRoot: string): Promise<void> {
  const directory = path.join(projectRoot, 'agents', 'web-researcher')
  const personaPath = path.join(
    repoRoot,
    'agents',
    'web-researcher',
    'web-researcher.md',
  )
  // Set, not replace: the bundled persona may legitimately stop declaring
  // either field, and this journey still has to dispatch to the fixture.
  const fixturePersona = setFrontMatterFields({
    fields: { model: 'fixture/browser-research', provider: 'openai' },
    file: personaPath,
    source: await fs.readFile(personaPath, 'utf8'),
  })
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, 'web-researcher.md'),
    fixturePersona,
    'utf8',
  )
}

/** A 1x1 PNG, enough for the renderer to turn into a blob URL. */
const FIXTURE_ICON = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

function createResearchWebsite(options: { slowSourceMs?: number } = {}): http.Server {
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/favicon.ico') {
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(FIXTURE_ICON.byteLength),
      })
      response.end(FIXTURE_ICON)
      return
    }
    const send = (): void => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(url.pathname === '/challenge'
        ? '<!doctype html><html><body><h1>Unusual traffic from your computer network</h1><p>Complete the CAPTCHA to continue.</p></body></html>'
        : '<!doctype html><html><body><main><h1>Independent research source</h1><p>E2E_REPORT_CODE_ORBITAL_742</p></main></body></html>')
    }
    // Hold the good source open so the turn stays in flight long enough for a
    // test to observe the running disclosure before the answer replaces it.
    if (options.slowSourceMs && url.pathname === '/good') {
      setTimeout(send, options.slowSourceMs)
      return
    }
    send()
  })
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Research fixture address is unavailable')
  return `http://127.0.0.1:${address.port}`
}
