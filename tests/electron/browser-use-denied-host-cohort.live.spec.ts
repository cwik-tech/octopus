/**
 * Paid, fixture-free Browser Use measurement over every historically denied host.
 *
 * The ordinary Web Researcher Electron journey proves renderer-to-provider wiring.
 * This companion measurement deliberately starts at the cloud rung so a page that
 * happens to recover through direct HTTP or local Chrome cannot bypass the provider
 * being compared. It still runs inside Electron, decrypts the application's saved
 * credential with Electron safeStorage, and uses the production Browser Use API,
 * CDP reader, source representations, quality gate, and cleanup bracket.
 *
 * It is excluded unless PIPELINE_LIVE_BROWSER_USE_COHORT=1. Every target runs
 * sequentially in a fresh provider session. The report contains URLs and typed
 * outcomes only: no credential, CDP endpoint, provider session id, or page text.
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  isDeniedHostCohort,
  type DeniedHostEntry,
} from '../../scripts/extract-denied-browser-hosts.js'
import { developmentElectronLaunchOptions } from '../../services/development/development-electron-bundle.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const sourceUserDataPath = configuredSourceUserDataPath()
const desktopLaunch = await developmentElectronLaunchOptions(repoRoot)
const LIVE_ENABLE_ENV = 'PIPELINE_LIVE_BROWSER_USE_COHORT'
const LIVE_CAPABILITY = 'browser-use-denied-host-cohort'
const PER_TARGET_BUDGET_MS = 90_000
const TEST_OVERHEAD_MS = 5 * 60_000

test('Browser Use Cloud measures every historically denied host and stops every created session', async ({}, testInfo) => {
  const cohort = await readTrackedCohort()
  const targets = orderByHistoricalDenials(cohort.hosts)
  const capabilityProblem = await discoverCapabilityProblem(
    sourceUserDataPath,
    targets.length,
  )
  requireCapability(capabilityProblem)
  test.setTimeout(targets.length * PER_TARGET_BUDGET_MS + TEST_OVERHEAD_MS)

  const paths = await preparePaths(testInfo.outputPath.bind(testInfo))
  const reportPath = testInfo.outputPath('browser-use-denied-host-cohort-report.json')
  const app = await launchDesktop(paths)

  try {
    forwardElectronOutput(app)
    const report = await runCohortInElectron(app, {
      settingsPath: path.join(
        paths.userDataPath,
        'research-acquisition-settings.json',
      ),
      reportPath,
      targets: targets.map((entry) => ({
        host: entry.host,
        targetUrl: entry.probeUrl,
        historicalDeniedAttempts: entry.deniedAttempts,
        historicalSessions: entry.sessions,
      })),
      settingsModulePath: compiledModulePath(
        'services',
        'acquisition-settings-service.js',
      ),
      qualityModulePath: compiledModulePath(
        'domains',
        'acquisition',
        'acquisition-quality.js',
      ),
      representationsModulePath: compiledModulePath(
        'domains',
        'acquisition',
        'source-representations.js',
      ),
    })

    expect(report.schemaVersion).toBe(1)
    expect(report.records).toHaveLength(targets.length)
    expect(report.accounting.total).toBe(targets.length)
    expect(report.accounting.tested).toBe(targets.length)
    expect(report.accounting.untested).toBe(0)
    expect(report.accounting.cleanupUnconfirmed).toBe(0)
    expect(report.accounting.connected).toBeGreaterThan(0)
    expect(report.totalCostMicros).toBeLessThanOrEqual(report.costAlarmMicros)

    for (const target of targets) {
      const record = report.records.find(
        (candidate) => candidate.targetUrl === target.probeUrl,
      )
      expect(record, `${target.host} is missing from the cloud report`).toBeDefined()
      expect(record?.host).toBe(target.host)
      expect(record?.status).toBe('tested')
      expect(record?.provider).toBe('browser-use')
      expect(record?.cleanupStopped).toBe(true)
    }

    process.stdout.write(summarizeReport(report, reportPath))
  } finally {
    await app.close()
  }
})

interface DesktopPaths {
  readonly projectRootPath: string
  readonly userDataPath: string
  readonly workspacePath: string
}

interface CohortTarget {
  readonly host: string
  readonly targetUrl: string
  readonly historicalDeniedAttempts: number
  readonly historicalSessions: number
}

type CohortOutcome =
  | 'usable'
  | 'insufficient'
  | 'challenge'
  | 'access-denied'
  | 'rate-limited'
  | 'not-found'
  | 'unsupported'
  | 'policy-denied'
  | 'timeout'
  | 'cancelled'
  | 'failed'

interface CohortRecord {
  readonly host: string
  readonly targetUrl: string
  readonly historicalDeniedAttempts: number
  readonly historicalSessions: number
  readonly status: 'tested' | 'untested'
  readonly outcome: CohortOutcome | 'untested'
  readonly connected: boolean
  readonly cleanupStopped: boolean
  readonly provider: 'browser-use'
  readonly providerSessionStatus: 'stopped' | 'active' | 'unknown'
  readonly meterSource: 'stop-confirmed' | 'create-last-known' | 'unavailable'
  readonly browserCostMicros: number
  readonly proxyCostMicros: number
  readonly durationMs: number
  readonly httpStatus?: number
  readonly challengeType?: string
  readonly failureCode?: string
}

interface CohortReport {
  readonly schemaVersion: 1
  readonly startedAt: string
  readonly completedAt: string
  readonly costAlarmMicros: number
  readonly totalCostMicros: number
  readonly accounting: {
    readonly total: number
    readonly tested: number
    readonly untested: number
    readonly connected: number
    readonly usable: number
    readonly cleanupUnconfirmed: number
  }
  readonly records: readonly CohortRecord[]
}

interface CohortRunnerInput {
  readonly settingsPath: string
  readonly reportPath: string
  readonly targets: readonly CohortTarget[]
  readonly settingsModulePath: string
  readonly qualityModulePath: string
  readonly representationsModulePath: string
}

async function runCohortInElectron(
  app: ElectronApplication,
  input: CohortRunnerInput,
): Promise<CohortReport> {
  return app.evaluate(async ({ safeStorage }, payload): Promise<CohortReport> => {
    const fs = process.getBuiltinModule('node:fs').promises
    const moduleApi = process.getBuiltinModule('node:module')
    const requireFromBuild = moduleApi.createRequire(payload.settingsModulePath)
    const settingsModule = requireFromBuild(
      payload.settingsModulePath,
    ) as typeof import('../../services/acquisition-settings-service.js')
    const qualityModule = requireFromBuild(
      payload.qualityModulePath,
    ) as typeof import('../../domains/acquisition/acquisition-quality.js')
    const representationsModule = requireFromBuild(
      payload.representationsModulePath,
    ) as typeof import('../../domains/acquisition/source-representations.js')

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Electron secure credential storage is unavailable.')
    }

    const settings = new settingsModule.AcquisitionSettingsService({
      storagePath: payload.settingsPath,
      secretCodec: {
        encrypt(value: string): string {
          return safeStorage.encryptString(value).toString('base64')
        },
        decrypt(value: string): string {
          return safeStorage.decryptString(Buffer.from(value, 'base64'))
        },
      },
      environment: process.env,
    })
    const snapshot = await settings.snapshot()
    const costAlarmMicros = snapshot.budgets.maximumCloudBrowserCostMicros
    const acquirer = await settings.cloudBrowser()
    if (!acquirer) throw new Error('Saved Browser Use Cloud settings are unavailable.')

    const startedAt = new Date().toISOString()
    const records: CohortRecord[] = []
    let totalCostMicros = 0
    let halt = false

    const persist = async (): Promise<void> => {
      const report = buildReport(new Date().toISOString())
      await fs.writeFile(
        payload.reportPath,
        `${JSON.stringify(report, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
    }

    const buildReport = (completedAt: string): CohortReport => ({
      schemaVersion: 1,
      startedAt,
      completedAt,
      costAlarmMicros,
      totalCostMicros,
      accounting: {
        total: payload.targets.length,
        tested: records.filter((record) => record.status === 'tested').length,
        untested: records.filter((record) => record.status === 'untested').length,
        connected: records.filter((record) => record.connected).length,
        usable: records.filter((record) => record.outcome === 'usable').length,
        cleanupUnconfirmed: records.filter((record) => !record.cleanupStopped).length,
      },
      records,
    })

    for (const target of payload.targets) {
      if (halt || totalCostMicros >= costAlarmMicros) {
        records.push({
          ...target,
          status: 'untested',
          outcome: 'untested',
          connected: false,
          cleanupStopped: true,
          provider: 'browser-use',
          providerSessionStatus: 'unknown',
          meterSource: 'unavailable',
          browserCostMicros: 0,
          proxyCostMicros: 0,
          durationMs: 0,
        })
        await persist()
        continue
      }

      const started = Date.now()
      const result = await acquirer.acquire(target.targetUrl, {
        enabled: true,
        restrictDomains: false,
        domains: [],
      })
      const costMicros =
        result.runtime.browserCostMicros + result.runtime.proxyCostMicros
      totalCostMicros += costMicros

      const representations = result.evidence
        ? representationsModule.buildSourceRepresentations(
            result.evidence.renderedHtml,
            'text/html',
            result.evidence.finalUrl,
          )
        : undefined
      const quality = result.evidence && representations
        ? qualityModule.evaluateAcquisitionQuality({
            ...(result.evidence.title
              ? { title: result.evidence.title }
              : {}),
            url: result.evidence.finalUrl,
            text: representations.markdown || result.evidence.text,
            ...(result.evidence.httpStatus === undefined
              ? {}
              : { httpStatus: result.evidence.httpStatus }),
            mediaType: 'text/html',
            structuredRepresentationCount: representations.structured.filter(
              (representation) => representation.kind !== 'metadata',
            ).length,
            clientRenderedShell: representations.clientRenderedShell,
          })
        : undefined
      const outcome: CohortOutcome = quality
        ? quality.usable
          ? 'usable'
          : quality.outcome
        : result.failure?.code === 'cancelled'
          ? 'cancelled'
          : result.failure?.code === 'policy_denied'
            ? 'policy-denied'
            : 'failed'

      records.push({
        ...target,
        status: 'tested',
        outcome,
        connected: result.evidence !== undefined,
        cleanupStopped: result.cleanup.stopped,
        provider: result.runtime.provider,
        providerSessionStatus: result.runtime.sessionStatus,
        meterSource: result.runtime.meterSource,
        browserCostMicros: result.runtime.browserCostMicros,
        proxyCostMicros: result.runtime.proxyCostMicros,
        durationMs: Date.now() - started,
        ...(result.evidence?.httpStatus === undefined
          ? {}
          : { httpStatus: result.evidence.httpStatus }),
        ...(quality && !quality.usable && quality.challengeType
          ? { challengeType: quality.challengeType }
          : {}),
        ...(result.failure ? { failureCode: result.failure.code } : {}),
      })

      // The production lane stops spending when cleanup or metering is unknown.
      // The measurement keeps the same fence and explicitly accounts for the
      // remaining targets as untested instead of making a partial run look whole.
      halt = !result.cleanup.stopped ||
        result.runtime.meterSource !== 'stop-confirmed' ||
        totalCostMicros > costAlarmMicros
      await persist()
      console.log(
        `[browser-use-cohort] ${records.length}/${payload.targets.length} ${target.host} ${outcome} ${Date.now() - started}ms`,
      )
    }

    const report = buildReport(new Date().toISOString())
    await persist()
    return report
  }, input)
}

async function readTrackedCohort(): Promise<{
  readonly hosts: readonly DeniedHostEntry[]
}> {
  const fixturePath = path.join(
    repoRoot,
    'tests',
    'fixtures',
    'browser-denied-hosts.json',
  )
  const parsed: unknown = JSON.parse(await fs.readFile(fixturePath, 'utf8'))
  if (!isDeniedHostCohort(parsed)) {
    throw new Error('The tracked denied-host cohort is invalid.')
  }
  if (parsed.hosts.length === 0) {
    throw new Error('The tracked denied-host cohort is empty.')
  }
  return parsed
}

function orderByHistoricalDenials(
  entries: readonly DeniedHostEntry[],
): readonly DeniedHostEntry[] {
  return [...entries].sort((left, right) =>
    right.deniedAttempts - left.deniedAttempts ||
    (left.host < right.host ? -1 : left.host > right.host ? 1 : 0),
  )
}

async function discoverCapabilityProblem(
  userDataPath: string,
  targetCount: number,
): Promise<string | undefined> {
  if (process.env[LIVE_ENABLE_ENV] !== '1') {
    return `${LIVE_ENABLE_ENV} is not 1; this check creates ${targetCount} paid sessions.`
  }
  try {
    const parsed: unknown = JSON.parse(
      await fs.readFile(
        path.join(userDataPath, 'research-acquisition-settings.json'),
        'utf8',
      ),
    )
    if (!isRecord(parsed) || !isRecord(parsed.providers)) {
      return 'Research acquisition settings have no provider map.'
    }
    const provider = parsed.providers['browser-use']
    if (!isRecord(provider) || provider.enabled !== true) {
      return 'The saved Browser Use provider is disabled.'
    }
    if (
      typeof provider.encryptedApiKey !== 'string' ||
      provider.encryptedApiKey.length === 0
    ) {
      return 'The saved Browser Use provider has no encrypted credential.'
    }
    if (!isRecord(parsed.budgets)) {
      return 'Research acquisition settings have no budget record.'
    }
    const maximumCost = parsed.budgets.maximumCloudBrowserCostMicros
    if (typeof maximumCost !== 'number' || maximumCost <= 0) {
      return 'The saved Browser Use cost alarm must be positive.'
    }
    return undefined
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return `Saved Browser Use settings are unavailable: ${detail}`
  }
}

function requireCapability(problem: string | undefined): void {
  if (!problem) return
  const required = new Set(
    (process.env.PIPELINE_LIVE_REQUIRE ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  )
  if (required.has('all') || required.has(LIVE_CAPABILITY)) {
    throw new Error(`Required live capability '${LIVE_CAPABILITY}' is unavailable: ${problem}`)
  }
  test.skip(true, problem)
}

async function preparePaths(
  outputPath: (name: string) => string,
): Promise<DesktopPaths> {
  const paths = {
    projectRootPath: outputPath('browser-use-cohort-project'),
    userDataPath: outputPath('browser-use-cohort-user-data'),
    workspacePath: outputPath('browser-use-cohort-workspace'),
  }
  await Promise.all([
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
    copyAcquisitionSettings(paths.userDataPath),
  ])
  return paths
}

async function copyAcquisitionSettings(
  targetUserDataPath: string,
): Promise<void> {
  const parsed: unknown = JSON.parse(
    await fs.readFile(
      path.join(sourceUserDataPath, 'research-acquisition-settings.json'),
      'utf8',
    ),
  )
  if (!isRecord(parsed) || !isRecord(parsed.budgets)) {
    throw new Error('Research acquisition settings have no mutable budget record.')
  }
  await fs.writeFile(
    path.join(targetUserDataPath, 'research-acquisition-settings.json'),
    `${JSON.stringify(parsed, null, 2)}\n`,
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
      ...process.env,
      NODE_ENV: 'test',
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: paths.projectRootPath,
      PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_USER_DATA: paths.userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: paths.workspacePath,
    },
  })
}

function forwardElectronOutput(app: ElectronApplication): void {
  app.process().stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk)
  })
  app.process().stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk)
  })
}

function compiledModulePath(...segments: readonly string[]): string {
  return path.join(repoRoot, 'dist-electron', ...segments)
}

function summarizeReport(report: CohortReport, reportPath: string): string {
  const outcomeCounts = new Map<string, number>()
  for (const record of report.records) {
    outcomeCounts.set(record.outcome, (outcomeCounts.get(record.outcome) ?? 0) + 1)
  }
  return [
    '',
    '--- Browser Use denied-host cohort ---',
    `targets: ${report.accounting.total}`,
    `tested: ${report.accounting.tested}; untested: ${report.accounting.untested}`,
    `connected: ${report.accounting.connected}; usable: ${report.accounting.usable}`,
    `cleanup unconfirmed: ${report.accounting.cleanupUnconfirmed}`,
    `outcomes: ${JSON.stringify(Object.fromEntries(outcomeCounts))}`,
    `provider-reported cost: ${report.totalCostMicros} USD micros`,
    `artifact: ${reportPath}`,
    '',
  ].join('\n')
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
