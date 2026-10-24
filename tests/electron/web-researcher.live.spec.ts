/**
 * Real-provider Electron acceptance journeys for the production Web Researcher.
 *
 * Nothing in this file starts a model, search, website, or browser fixture. The
 * app receives copies of the user's encrypted settings in an isolated profile,
 * launches the production Codex-backed agent, and reaches public services over
 * their production endpoints. The ordinary journey disables the paid cloud
 * rung in its isolated copy; the Browser Use journey permits exactly one cloud
 * call so a failed test cannot create unbounded paid sessions.
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test'
import type { Dirent } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { developmentElectronLaunchOptions } from '../../services/development/development-electron-bundle.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const sourceUserDataPath = configuredSourceUserDataPath()
const desktopLaunch = await developmentElectronLaunchOptions(repoRoot)
const capabilities = await discoverCapabilities(sourceUserDataPath)

const REAL_RESEARCH_CAPABILITY = 'web-researcher-electron'
const BROWSER_USE_CAPABILITY = 'web-researcher-browser-use-electron'
const TURN_TIMEOUT_MS = 12 * 60_000
const TRIPADVISOR_PROBE =
  'https://www.tripadvisor.com/Attractions-g29556-Activities-c36-t133-Ann_Arbor_Michigan.html'

test('Web Researcher returns a sourced answer through real Electron, Codex, search, and public pages', async ({}, testInfo) => {
  requireCapability(REAL_RESEARCH_CAPABILITY, capabilities.researchReason)
  test.setTimeout(15 * 60_000)

  const paths = await preparePaths(testInfo.outputPath.bind(testInfo), 'real-research', 0)
  const session = await new FileSystemSessionStore(paths.workspacePath).createSession({
    title: 'Live Web Researcher journey',
  })
  const app = await launchDesktop(paths)

  try {
    await assertNoFixtureOverrides(app)
    const page = await app.firstWindow()
    await openSessionAndSelectWebResearcher(page, session.title)
    await sendMessage(page, [
      'Use research_web.search to confirm authoritative sources about HTTP 404.',
      'Then acquire and inspect exactly these two independent public pages:',
      'https://www.rfc-editor.org/rfc/rfc9110.html and',
      'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/404.',
      'Explain what 404 means and cite the exact observed URL from each page.',
      'Do not answer from memory or substitute another URL.',
    ].join(' '))

    const answer = await waitForTerminalAnswer(page)
    await expect(answer).not.toContainText("couldn't verify a reliable answer")
    await expect(answer.getByLabel('Web research activity')).toBeVisible()
    await expect(
      answer.getByRole('button', { name: /^Used (?:[2-9]|\d{2,}) sources$/ }),
    ).toBeVisible()
    await expect(answer).toContainText('RFC 9110')
    await expect(answer).toContainText('404 Not Found')
    await expect(answer).toContainText(
      'https://www.rfc-editor.org/rfc/rfc9110.html',
    )
    await expect(answer).toContainText(
      'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/404',
    )
    await expect(answer).toContainText(/https:\/\//u)

    const activityPath = path.join(
      paths.workspacePath,
      'sessions',
      session.id,
      'research-acquisition.json',
    )
    await expect.poll(async () => {
      const activity = await readAcquisitionActivity(activityPath)
      return activity.filter(isUsableAcquisition).length
    }, { timeout: TURN_TIMEOUT_MS }).toBeGreaterThanOrEqual(2)

    const activity = await readAcquisitionActivity(activityPath)
    const completedSearches = activity.filter((record) =>
      record.action === 'search' &&
      record.state === 'completed' &&
      (record.resultCount ?? 0) > 0,
    )
    expect(completedSearches.length).toBeGreaterThan(0)
    expect(
      completedSearches.some((record) => record.searchProviders?.includes('brave')),
    ).toBe(true)

    const acquiredHosts = new Set(
      activity
        .filter(isUsableAcquisition)
        .flatMap((record) => safePublicHost(record.canonicalUrl)),
    )
    expect(acquiredHosts.has('developer.mozilla.org')).toBe(true)
    expect(acquiredHosts.has('www.rfc-editor.org')).toBe(true)
    await expectRealCodexDiagnostics(paths.workspacePath)
  } finally {
    await app.close()
  }
})

test('Web Researcher escalates a denied public page through real Browser Use Cloud and shows the outcome', async ({}, testInfo) => {
  requireCapability(BROWSER_USE_CAPABILITY, capabilities.browserUseReason)
  test.setTimeout(15 * 60_000)

  const paths = await preparePaths(testInfo.outputPath.bind(testInfo), 'browser-use-research', 1)
  const session = await new FileSystemSessionStore(paths.workspacePath).createSession({
    title: 'Live Browser Use Web Researcher journey',
  })
  const app = await launchDesktop(paths)

  try {
    await assertNoFixtureOverrides(app)
    const page = await app.firstWindow()
    await openSessionAndSelectWebResearcher(page, session.title)
    await sendMessage(page, [
      `Use research_web.acquire on exactly this public URL: ${TRIPADVISOR_PROBE}`,
      'Set the source value to unique-primary and allow browser fallback.',
      'Do not search and do not open another URL. Report the observed page title',
      'and location when usable; otherwise state plainly that the page could not be verified.',
    ].join(' '))

    const answer = await waitForTerminalAnswer(page)
    await expect(answer.getByLabel('Web research activity')).toBeVisible()
    await expect(answer).not.toContainText('Response interrupted')

    const activityPath = path.join(
      paths.workspacePath,
      'sessions',
      session.id,
      'research-acquisition.json',
    )
    await expect.poll(async () => {
      const activity = await readAcquisitionActivity(activityPath)
      return cloudAttemptsForHost(activity, 'www.tripadvisor.com').length
    }, { timeout: TURN_TIMEOUT_MS }).toBeGreaterThan(0)

    const activity = await readAcquisitionActivity(activityPath)
    const cloudAttempts = cloudAttemptsForHost(activity, 'www.tripadvisor.com')
    expect(cloudAttempts).toHaveLength(1)
    const cloud = cloudAttempts[0]
    expect(cloud?.cloudBrowserRuntime?.provider).toBe('browser-use')
    expect(cloud?.cloudBrowserRuntime?.sessionStatus).toBe('stopped')
    expect(cloud?.cloudBrowserRuntime?.meterSource).toBe('stop-confirmed')
    await expectRealCodexDiagnostics(paths.workspacePath)
  } finally {
    await app.close()
  }
})

interface DesktopPaths {
  readonly projectRootPath: string
  readonly userDataPath: string
  readonly workspacePath: string
}

interface LiveCapabilities {
  readonly researchReason?: string
  readonly browserUseReason?: string
}

interface CloudRuntimeRecord {
  readonly provider?: string
  readonly sessionStatus?: string
  readonly meterSource?: string
}

interface AcquisitionAttemptRecord {
  readonly method?: string
  readonly outcome?: string
  readonly cloudBrowserRuntime?: CloudRuntimeRecord
}

interface AcquisitionActivityRecord {
  readonly action?: string
  readonly state?: string
  readonly requestedUrl?: string
  readonly canonicalUrl?: string
  readonly resultCount?: number
  readonly searchProviders?: readonly string[]
  readonly observationReceipt?: Readonly<Record<string, unknown>>
  readonly attempts: readonly AcquisitionAttemptRecord[]
}

async function discoverCapabilities(userDataPath: string): Promise<LiveCapabilities> {
  const providerPath = path.join(userDataPath, 'provider-settings.json')
  const acquisitionPath = path.join(userDataPath, 'research-acquisition-settings.json')
  try {
    const [providerRaw, acquisitionRaw, codexAvailable] = await Promise.all([
      readJson(providerPath),
      readJson(acquisitionPath),
      executableAvailable('codex'),
    ])
    const providerProblem = validateCodexSettings(providerRaw, codexAvailable)
    const braveProblem = validateAcquisitionProvider(acquisitionRaw, 'brave')
    const researchReason = providerProblem ?? braveProblem
    const browserUseProblem = validateAcquisitionProvider(acquisitionRaw, 'browser-use')
    const browserUseBudgetProblem = validateCloudBudget(acquisitionRaw)
    // Each validator returns a non-empty sentence or undefined, so this is
    // defined exactly when any of the three problems is.
    const browserUseReason = providerProblem ?? browserUseProblem ?? browserUseBudgetProblem
    return {
      ...(researchReason ? { researchReason } : {}),
      ...(browserUseReason === undefined ? {} : { browserUseReason }),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const reason = `Real Web Researcher settings are unavailable: ${detail}`
    return { researchReason: reason, browserUseReason: reason }
  }
}

function validateCodexSettings(value: unknown, codexAvailable: boolean): string | undefined {
  if (!codexAvailable) return 'The Codex CLI is not available on PATH.'
  if (!isRecord(value)) return 'Provider settings are not an object.'
  const cliEnabled = value.cliEnabled
  if (isRecord(cliEnabled) && cliEnabled.codex === false) {
    return 'The Codex CLI provider is disabled in saved settings.'
  }
  const cliModelEnabled = value.cliModelEnabled
  const codexModels = isRecord(cliModelEnabled) ? cliModelEnabled.codex : undefined
  if (!isRecord(codexModels) || codexModels['gpt-5.5'] !== true) {
    return "The production Web Researcher's Codex model gpt-5.5 is not enabled."
  }
  const defaultModel = value.defaultModel
  if (
    !isRecord(defaultModel) ||
    typeof defaultModel.provider !== 'string' ||
    typeof defaultModel.model !== 'string'
  ) {
    return 'No saved default chat model is available to the Electron composer.'
  }
  return undefined
}

function validateAcquisitionProvider(
  value: unknown,
  providerId: 'brave' | 'browser-use',
): string | undefined {
  if (!isRecord(value) || !isRecord(value.providers)) {
    return 'Research acquisition settings have no provider map.'
  }
  const provider = value.providers[providerId]
  if (!isRecord(provider)) return `The saved ${providerId} provider is missing.`
  if (provider.enabled !== true) return `The saved ${providerId} provider is disabled.`
  if (provider.status !== 'connected') return `The saved ${providerId} provider is not connected.`
  if (typeof provider.encryptedApiKey !== 'string' || provider.encryptedApiKey.length === 0) {
    return `The saved ${providerId} provider has no reusable encrypted key.`
  }
  return undefined
}

function validateCloudBudget(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.budgets)) {
    return 'Research acquisition settings have no budget record.'
  }
  return typeof value.budgets.maximumCloudBrowserCalls === 'number' &&
      value.budgets.maximumCloudBrowserCalls >= 0 &&
      typeof value.budgets.maximumCloudBrowserCostMicros === 'number' &&
      value.budgets.maximumCloudBrowserCostMicros >= 0
    ? undefined
    : 'The saved Browser Use call and cost limits must be nonnegative.'
}

function requireCapability(capability: string, reason: string | undefined): void {
  if (!reason) return
  const required = new Set(
    (process.env.PIPELINE_LIVE_REQUIRE ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  )
  if (required.has('all') || required.has(capability)) {
    throw new Error(`Required live capability '${capability}' is unavailable: ${reason}`)
  }
  test.skip(true, reason)
}

async function preparePaths(
  outputPath: (name: string) => string,
  prefix: string,
  maximumCloudBrowserCalls: 0 | 1,
): Promise<DesktopPaths> {
  const paths = {
    projectRootPath: outputPath(`${prefix}-project`),
    userDataPath: outputPath(`${prefix}-user-data`),
    workspacePath: outputPath(`${prefix}-workspace`),
  }
  const agentDirectory = path.join(paths.projectRootPath, 'agents', 'web-researcher')
  await Promise.all([
    fs.cp(path.join(repoRoot, 'agents', 'web-researcher'), agentDirectory, {
      recursive: true,
    }),
    fs.mkdir(path.join(paths.projectRootPath, 'workflows'), { recursive: true }),
    fs.mkdir(paths.userDataPath, { recursive: true }),
    fs.mkdir(paths.workspacePath, { recursive: true }),
  ])
  await Promise.all([
    fs.writeFile(path.join(paths.projectRootPath, 'teams.yaml'), '{}\n', 'utf8'),
    fs.writeFile(
      path.join(paths.projectRootPath, 'workflows', 'registry.yaml'),
      '{}\n',
      'utf8',
    ),
    fs.copyFile(
      path.join(sourceUserDataPath, 'provider-settings.json'),
      path.join(paths.userDataPath, 'provider-settings.json'),
    ),
    copyAcquisitionSettings(paths.userDataPath, maximumCloudBrowserCalls),
    fs.writeFile(
      path.join(paths.userDataPath, 'browser-settings.json'),
      JSON.stringify({ version: 1, mode: 'headless' }),
      'utf8',
    ),
  ])
  await fs.chmod(path.join(paths.userDataPath, 'provider-settings.json'), 0o600)
  return paths
}

async function copyAcquisitionSettings(
  targetUserDataPath: string,
  maximumCloudBrowserCalls: 0 | 1,
): Promise<void> {
  const sourcePath = path.join(sourceUserDataPath, 'research-acquisition-settings.json')
  const parsed = await readJson(sourcePath)
  if (!isRecord(parsed) || !isRecord(parsed.budgets)) {
    throw new Error('Research acquisition settings have no mutable budget record.')
  }
  if (!isRecord(parsed.providers) || !isRecord(parsed.providers['browser-use'])) {
    throw new Error('Research acquisition settings have no cloud provider record.')
  }
  const bounded = {
    ...parsed,
    // Zero is now unlimited, so the free journey must disable the provider.
    providers: {
      ...parsed.providers,
      'browser-use': { ...parsed.providers['browser-use'], enabled: maximumCloudBrowserCalls > 0 },
    },
    budgets: {
      ...parsed.budgets,
      maximumCloudBrowserCalls,
    },
  }
  await fs.writeFile(
    path.join(targetUserDataPath, 'research-acquisition-settings.json'),
    `${JSON.stringify(bounded, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

async function launchDesktop(paths: DesktopPaths): Promise<ElectronApplication> {
  return electron.launch({
    args: desktopLaunch.executablePath ? [desktopLaunch.electronCliPath] : ['.'],
    cwd: repoRoot,
    ...(desktopLaunch.executablePath
      ? { executablePath: desktopLaunch.executablePath }
      : {}),
    env: {
      ...realProviderEnvironment(process.env),
      NODE_ENV: 'test',
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: paths.projectRootPath,
      PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_USER_DATA: paths.userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: paths.workspacePath,
    },
  })
}

function realProviderEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source }
  for (const key of [
    'PIPELINE_DESKTOP_E2E_BRAVE_ENDPOINT',
    'PIPELINE_RESEARCH_WEB_TOOL_URL',
    'PIPELINE_BROWSER_TOOL_URL',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'BRAVE_SEARCH_API_KEY',
    'EXA_API_KEY',
    'FIRECRAWL_API_KEY',
    'BROWSER_USE_API_KEY',
  ]) {
    delete environment[key]
  }
  return environment
}

async function assertNoFixtureOverrides(app: ElectronApplication): Promise<void> {
  const overrides = await app.evaluate(() => ({
    braveEndpoint: process.env.PIPELINE_DESKTOP_E2E_BRAVE_ENDPOINT ?? null,
    browserToolUrl: process.env.PIPELINE_BROWSER_TOOL_URL ?? null,
    openAiBaseUrl: process.env.OPENAI_BASE_URL ?? null,
    researchWebToolUrl: process.env.PIPELINE_RESEARCH_WEB_TOOL_URL ?? null,
  }))
  expect(overrides).toEqual({
    braveEndpoint: null,
    browserToolUrl: null,
    openAiBaseUrl: null,
    researchWebToolUrl: null,
  })
}

async function openSessionAndSelectWebResearcher(page: Page, title: string): Promise<void> {
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await page
    .getByRole('button', { name: new RegExp(`^${escapeRegExp(title)}\\b`) })
    .first()
    .click()
  await page.getByRole('button', { name: 'Search Agents' }).click()
  await page.getByRole('searchbox', { name: 'Search Agents' }).fill('web-researcher')
  await page.getByRole('button', { name: /^Web Researcher/i }).click()
  await expect(
    page.getByRole('button', { name: 'Web Researcher Model: gpt-5.5' }),
  ).toHaveAttribute('aria-pressed', 'true')
}

async function sendMessage(page: Page, message: string): Promise<void> {
  const chat = page.getByRole('region', { name: 'Run chat' })
  const composer = chat.getByPlaceholder('Send a message to the selected agents...')
  await expect(composer).toBeEnabled()
  await composer.fill(message)
  await chat.getByRole('button', { name: 'Send message' }).click()
}

async function waitForTerminalAnswer(page: Page): Promise<Locator> {
  const chat = page.getByRole('region', { name: 'Run chat' })
  const send = chat.getByRole('button', { name: 'Send message' })
  await expect.poll(async () => {
    if (await chat.getByText('Response interrupted', { exact: true }).isVisible({ timeout: 0 })) {
      return 'interrupted'
    }
    const answer = chat.locator('.group.is-assistant').last()
    const settledResearch = answer.getByRole('button', { name: /^Research activity:/ })
    return (await send.isEnabled({ timeout: 0 })) &&
      (await settledResearch.isVisible({ timeout: 0 }))
      ? 'completed'
      : 'running'
  }, { timeout: TURN_TIMEOUT_MS }).toBe('completed')
  await expect(chat.getByText('Response interrupted', { exact: true })).toHaveCount(0)
  const answer = chat.locator('.group.is-assistant').last()
  await expect(answer).toBeVisible()
  await expect(answer.getByText('Web Researcher', { exact: true })).toBeVisible()
  return answer
}

async function readAcquisitionActivity(
  filePath: string,
): Promise<readonly AcquisitionActivityRecord[]> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return []
    throw error
  }
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error('Research acquisition activity is not an array.')
  return parsed.map(parseAcquisitionActivityRecord)
}

function parseAcquisitionActivityRecord(
  value: unknown,
  index: number,
): AcquisitionActivityRecord {
  if (!isRecord(value)) throw new Error(`Research activity ${index} is not an object.`)
  const attempts = value.attempts
  if (attempts !== undefined && !Array.isArray(attempts)) {
    throw new Error(`Research activity ${index} has invalid attempts.`)
  }
  const observationReceipt = value.observationReceipt
  if (observationReceipt !== undefined && !isRecord(observationReceipt)) {
    throw new Error(`Research activity ${index} has an invalid observation receipt.`)
  }
  return {
    ...optionalStringProperty(value, 'action'),
    ...optionalStringProperty(value, 'state'),
    ...optionalStringProperty(value, 'requestedUrl'),
    ...optionalStringProperty(value, 'canonicalUrl'),
    ...(typeof value.resultCount === 'number' ? { resultCount: value.resultCount } : {}),
    ...(Array.isArray(value.searchProviders) &&
      value.searchProviders.every((provider) => typeof provider === 'string')
      ? { searchProviders: value.searchProviders }
      : {}),
    ...(observationReceipt ? { observationReceipt } : {}),
    attempts: (attempts ?? []).map(parseAttempt),
  }
}

function parseAttempt(value: unknown, index: number): AcquisitionAttemptRecord {
  if (!isRecord(value)) throw new Error(`Acquisition attempt ${index} is not an object.`)
  const runtime = value.cloudBrowserRuntime
  if (runtime !== undefined && !isRecord(runtime)) {
    throw new Error(`Acquisition attempt ${index} has an invalid cloud runtime.`)
  }
  return {
    ...optionalStringProperty(value, 'method'),
    ...optionalStringProperty(value, 'outcome'),
    ...(runtime
      ? {
          cloudBrowserRuntime: {
            ...optionalStringProperty(runtime, 'provider'),
            ...optionalStringProperty(runtime, 'sessionStatus'),
            ...optionalStringProperty(runtime, 'meterSource'),
          },
        }
      : {}),
  }
}

function optionalStringProperty(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, string>> {
  const candidate = value[key]
  if (candidate === undefined) return {}
  if (typeof candidate !== 'string') throw new Error(`Field '${key}' is not a string.`)
  return { [key]: candidate }
}

function isUsableAcquisition(record: AcquisitionActivityRecord): boolean {
  return record.action === 'acquire' &&
    record.state === 'completed' &&
    record.observationReceipt !== undefined &&
    record.attempts.some((attempt) => attempt.outcome === 'usable')
}

function cloudAttemptsForHost(
  activity: readonly AcquisitionActivityRecord[],
  expectedHost: string,
): readonly AcquisitionAttemptRecord[] {
  return activity
    .filter((record) =>
      record.action === 'acquire' &&
      [record.requestedUrl, record.canonicalUrl].some(
        (candidate) => safeHost(candidate) === expectedHost,
      ),
    )
    .flatMap((record) => record.attempts)
    .filter((attempt) => attempt.method === 'cloud-browser')
}

async function expectRealCodexDiagnostics(workspacePath: string): Promise<void> {
  const matchesProviderTurn = (filePath: string): boolean =>
    filePath.endsWith('.jsonl') &&
    filePath.includes(`${path.sep}provider-turns${path.sep}`)
  await expect.poll(async () => {
    const files = await findFiles(workspacePath, matchesProviderTurn)
    return (await Promise.all(files.map((file) => fs.readFile(file, 'utf8')))).join('\n')
  }, { timeout: 30_000 }).toContain('"kind":"provider-process-started"')
  const files = await findFiles(workspacePath, matchesProviderTurn)
  const diagnostics = (await Promise.all(
    files.map((file) => fs.readFile(file, 'utf8')),
  )).join('\n')
  expect(diagnostics).toContain('"provider":"codex"')
  expect(diagnostics).not.toContain('fixture/')
}

async function findFiles(
  root: string,
  matches: (filePath: string) => boolean,
): Promise<readonly string[]> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return []
    throw error
  }
  const nested = await Promise.all(entries.map(async (entry) => {
    const candidate = path.join(root, entry.name)
    if (entry.isDirectory()) return findFiles(candidate, matches)
    return entry.isFile() && matches(candidate) ? [candidate] : []
  }))
  return nested.flat()
}

async function readJson(filePath: string): Promise<unknown> {
  const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'))
  return parsed
}

async function executableAvailable(command: string): Promise<boolean> {
  const pathValue = process.env.PATH ?? ''
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : ['']
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      try {
        await fs.access(path.join(directory, `${command}${extension}`))
        return true
      } catch {
        // Continue through the finite PATH candidate list.
      }
    }
  }
  return false
}

function safePublicHost(value: string | undefined): readonly string[] {
  const host = safeHost(value)
  return host && host !== 'localhost' && host !== '127.0.0.1' ? [host] : []
}

function safeHost(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' ? parsed.hostname : undefined
  } catch {
    return undefined
  }
}

function configuredSourceUserDataPath(): string {
  const override = process.env.PIPELINE_LIVE_WEB_RESEARCH_USER_DATA_PATH?.trim()
  if (override) return path.resolve(override)
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'pipeline-template',
    )
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim()
    return path.join(
      appData || path.join(os.homedir(), 'AppData', 'Roaming'),
      'pipeline-template',
    )
  }
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config')
  return path.join(configHome, 'pipeline-template')
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
