import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer } from '../../server/api-server.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { createRunPlanService } from '../../services/run-orchestrator-service.js'
import {
  approveDeepResearchPlanService,
  generateDeepResearchPlanService,
} from '../../services/deep-research-plan-service.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { BrowserManager } from '../../domains/browser/browser-manager.js'
import {
  parseEvidencePacket,
  parseQualityVerdict,
} from '../../domains/deep-research/deep-research-validation.js'
import { applyDeepResearchIntakeDecision } from '../../domains/run-orchestrator/deep-research.js'
import {
  evaluateDeepResearchRunDirectory,
  loadDeepResearchEvaluationCorpus,
  loadDeepResearchEvaluationReport,
} from '../../services/deep-research-evaluation-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { AcquisitionSettingsService } from '../../services/acquisition-settings-service.js'
import { DEFAULT_ACQUISITION_BUDGETS } from '../../domains/acquisition/acquisition-settings.js'
import { isAcquisitionAttempt } from '../../domains/acquisition/acquisition-types.js'
import {
  browserUseLiveGate,
  hasObservedBrowserResearch,
} from '../support/browser-use-live-gate.js'
import { createLiveSecretCodec } from './live-provider-support.js'

const REPO_ROOT = process.cwd()
const WORKFLOW_ID = 'deep-research-report'
const LIVE_ENABLED = process.env.PIPELINE_LIVE_DEEP_RESEARCH === '1'
const LIVE_BROWSER_USE_ENABLED = process.env.PIPELINE_LIVE_BROWSER_USE === '1'
const DIRECT_API_CREDENTIALS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'CLAUDE_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
] as const
const LIVE_EXAMPLES = loadDeepResearchEvaluationCorpus(
  path.join(
    REPO_ROOT,
    'tests',
    'fixtures',
    'deep-research',
    'evaluation-corpus.json',
  ),
).cases
const REQUESTED_EXAMPLE_ID = process.env.PIPELINE_LIVE_DEEP_RESEARCH_EXAMPLE?.trim()
const SELECTED_LIVE_EXAMPLES = REQUESTED_EXAMPLE_ID
  ? LIVE_EXAMPLES.filter((example) => example.id === REQUESTED_EXAMPLE_ID)
  : LIVE_EXAMPLES

test(
  'selected Deep Research examples complete with subscription agents, observed evidence, quality approval, writing, Markdown, and DOCX',
  {
    skip: LIVE_ENABLED
      ? false
      : 'Set PIPELINE_LIVE_DEEP_RESEARCH=1 to run the live release gate.',
    timeout: 90 * 60_000,
  },
  async () => {
    assert.ok(
      SELECTED_LIVE_EXAMPLES.length > 0,
      `Unknown PIPELINE_LIVE_DEEP_RESEARCH_EXAMPLE '${REQUESTED_EXAMPLE_ID}'.`,
    )
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-live-'))
    const workspacePath = path.join(root, 'workspace')
    const browserManager = new BrowserManager({
      profilePath: path.join(root, 'browser-profile'),
      mode: 'headless',
    })
    const originalCredentials = Object.fromEntries(
      DIRECT_API_CREDENTIALS.map((name) => [name, process.env[name]]),
    )
    const retentionRoot = path.join(
      path.resolve(
        process.env.PIPELINE_DEEP_RESEARCH_EVALUATION_OUTPUT?.trim() ||
        path.join(REPO_ROOT, 'test-results', 'deep-research-evaluation'),
      ),
      new Date().toISOString().replace(/[:.]/gu, '-'),
    )
    fs.mkdirSync(retentionRoot, { recursive: true })
    for (const name of DIRECT_API_CREDENTIALS) process.env[name] = ''

    let server: Awaited<ReturnType<typeof startApiServer>> | undefined
    let browserUseAlarmMicros: number | undefined
    let observedBrowserUseCostMicros = 0
    const keepWorkspace = process.env.PIPELINE_KEEP_LIVE_WORKSPACE === '1'
    try {
      const browserStatus = await browserManager.status()
      if (browserStatus.status === 'unavailable') {
        throw new Error(
          'PIPELINE_LIVE_DEEP_RESEARCH=1 requires a supported local Chrome installation; browser research cannot be skipped in the live release gate.',
        )
      }

      const providerSettingsService = new ProviderSettingsService({
        storagePath: path.join(root, 'provider-settings.json'),
      })
      const codex = (await providerSettingsService.listCliAgents(true)).find(
        (candidate) => candidate.id === 'codex',
      )
      assert.equal(codex?.available, true, codex?.error)
      assert.equal(codex?.mcpBridge.supported, true, codex?.error)
      for (const model of ['gpt-5.5', 'gpt-5.6-terra']) {
        assert.ok(
          codex?.models.some((candidate) => candidate.id === model),
          `Codex CLI did not advertise required Deep Research model '${model}'.`,
        )
        await providerSettingsService.setCliModelEnabled('codex', model, true)
      }

      let acquisitionSettingsService: AcquisitionSettingsService | undefined
      if (LIVE_BROWSER_USE_ENABLED) {
        const gate = browserUseLiveGate(process.env)
        assert.equal(
          gate.kind,
          'run',
          gate.kind === 'skip' ? gate.reason : undefined,
        )
        if (gate.kind !== 'run') {
          throw new Error('Browser Use live gate was not authorized.')
        }
        browserUseAlarmMicros = gate.alarmMicros
        acquisitionSettingsService = new AcquisitionSettingsService({
          storagePath: path.join(root, 'research-acquisition-settings.json'),
          secretCodec: createLiveSecretCodec(),
          environment: {},
        })
        const acquisitionSettings = await acquisitionSettingsService.update({
          providerPriority: ['exa', 'brave'],
          providers: {
            exa: { enabled: false },
            brave: { enabled: false },
            firecrawl: { enabled: false },
            'browser-use': { enabled: true, apiKey: gate.apiKey },
          },
          budgets: {
            ...DEFAULT_ACQUISITION_BUDGETS,
            maximumCloudBrowserCalls: 20,
            maximumCloudBrowserCostMicros: gate.alarmMicros,
          },
          extractionModel: null,
        })
        assert.equal(acquisitionSettings.providers['browser-use'].enabled, true)
        assert.equal(acquisitionSettings.budgets.maximumCloudBrowserCalls, 20)
      }

      const sessionStore = new FileSystemSessionStore(workspacePath)
      server = await startApiServer({
        store: new FileSystemRunStore(workspacePath),
        launcher: new PiRunLauncher(),
        sessionStore,
        repoRootPath: REPO_ROOT,
        workflowsRegistryPath: path.join(REPO_ROOT, 'workflows', 'registry.yaml'),
        workspacePath,
        browserManager,
        providerSettingsService,
        ...(acquisitionSettingsService
          ? {
              toolModuleOptions: {
                'research-web': {
                  settingsService: acquisitionSettingsService,
                },
              },
            }
          : {}),
        recoverInterruptedTasks: true,
      })

      for (const example of SELECTED_LIVE_EXAMPLES) {
        const session = await sessionStore.createSession({ title: `Deep Research live gate: ${example.title}` })
        const initial = await createRunPlanService({
          sessionId: session.id,
          sessionStore,
          repoRootPath: REPO_ROOT,
          workflowsRegistryPath: path.join(REPO_ROOT, 'workflows', 'registry.yaml'),
          goal: example.brief,
          workflowId: WORKFLOW_ID,
        })
        assert.equal(initial.status, 'needs_input')
        const intakeReady = applyDeepResearchIntakeDecision(initial, [])
        assert.equal(await sessionStore.saveRunPlan(session.id, intakeReady), true)

        const generated = await generateDeepResearchPlanService({
          sessionId: session.id,
          sessionStore,
          repoRootPath: REPO_ROOT,
          expectedPlanId: intakeReady.id,
          settings: {
            snapshot: async () => ({
              maxDurationMinutes: 35,
              maxResearcherAgents: 2,
            }),
          },
        })
        const approved = await approveDeepResearchPlanService({
          sessionId: session.id,
          sessionStore,
          expectedPlanId: generated.id,
          expectedResearchPlanHash: generated.researchPlanProposalHash!,
        })
        assert.equal(approved.status, 'ready')
        assert.ok(approved.researchPlan)
        const synthesisMode =
          approved.researchPlan.executionPolicy?.synthesis.mode ?? 'single_pass'
        const approvedTaskCount = approved.researchPlan.tasks.length

        const launchResponse: globalThis.Response = await fetch(`${server.url}/sessions/${session.id}/tasks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workflowId: WORKFLOW_ID }),
        })
        const responseBody = await launchResponse.text()
        assert.equal(launchResponse.status, 202, responseBody)
        const launched = JSON.parse(responseBody) as { id: string }
        const task = await waitForTerminalTask(sessionStore, session.id, launched.id)
        assert.equal(task.status, 'done', `${example.id}: ${task.error ?? 'run did not complete'}`)
        assert.ok(task.runPath)

        const markdownPath = findUniqueFile(task.runPath, 'final-report.md')
        const docxPath = findUniqueFile(task.runPath, 'final-report.docx')
        const editorialPath = path.join(path.dirname(markdownPath), 'final-draft.md')
        assert.ok(
          fs.existsSync(editorialPath),
          `${example.id}: published final-draft.md is missing beside final-report.md.`,
        )
        const qualityVerdictPath = findUniqueFile(task.runPath, 'current-verdict.json')
        const markdown = fs.readFileSync(markdownPath, 'utf8')
        const editorial = fs.readFileSync(editorialPath, 'utf8')
        const qualityVerdict = parseQualityVerdict(JSON.parse(
          fs.readFileSync(qualityVerdictPath, 'utf8'),
        ))
        assert.equal(qualityVerdict.decision, 'APPROVE')
        assert.ok(editorial.length > 1_000, `${example.id}: editorial draft is unexpectedly short.`)
        assert.ok(markdown.length > 1_000, `${example.id}: final Markdown report is unexpectedly short.`)
        assert.match(markdown, /https:\/\//)
        assert.equal(fs.readFileSync(docxPath).subarray(0, 2).toString('ascii'), 'PK')

        const evidenceManifestPath = findUniqueFile(task.runPath, 'current-manifest.json')
        const evidenceManifest = JSON.parse(
          fs.readFileSync(evidenceManifestPath, 'utf8'),
        ) as { latestByTask?: Record<string, string> }
        assert.ok(evidenceManifest.latestByTask)
        const assignmentPath = path.resolve(path.dirname(evidenceManifestPath), '..', '..')
        const researchPackagePath = path.join(assignmentPath, 'research-package.md')
        assert.ok(
          fs.existsSync(researchPackagePath),
          `${example.id}: canonical research package is missing from the research assignment.`,
        )
        const researchPackage = fs.readFileSync(researchPackagePath, 'utf8')
        assert.ok(researchPackage.length > 1_000, `${example.id}: research package is unexpectedly short.`)
        assert.doesNotMatch(researchPackage, /\*\*Status:\*\*\s*BLOCKED/u)
        const evidenceFiles = Object.values(evidenceManifest.latestByTask).map(
          (relativePath) => path.resolve(assignmentPath, relativePath),
        )
        assert.equal(evidenceFiles.length, approvedTaskCount)
        let usableObservedSources = 0
        let supportedClaims = 0
        for (const evidenceFile of evidenceFiles) {
          assert.match(evidenceFile, /research[\\/]evidence[\\/]wave-\d+[\\/]T\d+\.json$/)
          const packet = parseEvidencePacket(JSON.parse(fs.readFileSync(evidenceFile, 'utf8')))
          // Every usable source counts, `web.search` included. Excluding the
          // discovery method made the gate blind to the defect it exists to
          // catch: a run that guessed every URL from model memory and never
          // searched at all passed this assertion.
          const observed = packet.sources.filter(
            (source) => source.status === 'usable',
          )
          assert.ok(observed.length > 0)
          usableObservedSources += observed.length
          supportedClaims += packet.findings.filter((claim) => claim.status === 'supported').length
        }

        // Source discovery must actually have happened. The run needs no
        // search API key — discovery falls back to the managed browser — so
        // this asserts the outcome rather than the configuration.
        const acquisitionActivityPath = path.join(
          workspacePath,
          'sessions',
          session.id,
          'research-acquisition.json',
        )
        assert.ok(
          fs.existsSync(acquisitionActivityPath),
          `${example.id}: no research acquisition activity was journalled at all.`,
        )
        const acquisitionActivity = JSON.parse(
          fs.readFileSync(acquisitionActivityPath, 'utf8'),
        ) as Array<{
          action: string
          state: string
          resultCount?: number
          error?: { code?: string }
          attempts?: readonly unknown[]
        }>
        const completedSearches = acquisitionActivity.filter(
          (activity) =>
            activity.action === 'search' &&
            activity.state === 'completed' &&
            (activity.resultCount ?? 0) > 0,
        )
        assert.ok(
          completedSearches.length > 0,
          `${example.id}: no search returned results, so every source URL was ` +
            `supplied by the model rather than discovered.`,
        )
        assert.equal(
          acquisitionActivity.filter(
            (activity) =>
              activity.action === 'search' &&
              activity.error?.code === 'not_configured',
          ).length,
          0,
          `${example.id}: a search found no discovery path — neither a search ` +
            `provider key nor the managed browser was available.`,
        )
        const cloudAttempts = acquisitionActivity.flatMap((activity) =>
          (activity.attempts ?? [])
            .filter(isAcquisitionAttempt)
            .filter((attempt) => attempt.method === 'cloud-browser'),
        )
        if (LIVE_BROWSER_USE_ENABLED) {
          assert.ok(
            cloudAttempts.length > 0,
            `${example.id}: Browser Use was enabled but no cloud-browser rung ran.`,
          )
          for (const attempt of cloudAttempts) {
            assert.equal(
              attempt.cloudBrowserRuntime?.sessionStatus,
              'stopped',
              `${example.id}: Browser Use did not confirm session cleanup.`,
            )
            observedBrowserUseCostMicros +=
              (attempt.cloudBrowserRuntime?.browserCostMicros ?? 0) +
              (attempt.cloudBrowserRuntime?.proxyCostMicros ?? 0)
          }
        }

        const browserActivityPath = path.join(
          workspacePath,
          'sessions',
          session.id,
          'browser-activity.json',
        )
        const browserActivity = fs.existsSync(browserActivityPath)
          ? JSON.parse(fs.readFileSync(browserActivityPath, 'utf8')) as Array<{
              action: string
              state: string
              agentPath: string
            }>
          : []
        assert.ok(
          hasObservedBrowserResearch({
            localActivities: browserActivity,
            cloudAttempts,
          }),
          `${example.id}: neither the local managed browser nor Browser Use ` +
            'cloud produced a usable web-research observation.',
        )

        const logs = walkFiles(task.runPath)
          .filter((filePath) => /(?:host|provider)-events\.jsonl$/.test(filePath))
          .map((filePath) => fs.readFileSync(filePath, 'utf8'))
          .join('\n')
        assert.match(logs, /"resolved_host_provider":"openai-codex"/)
        assert.match(logs, /"provider":"codex"/)
        assert.doesNotMatch(logs, /openai-responses-api|invalid_api_key|\b401\b/)

        const parsedDocx = parseDocx(docxPath, path.join(root, example.id))
        for (const term of example.expectedTerms) {
          assert.ok(
            containsExpectedTerm(markdown, term),
            `${example.id}: Markdown is missing expected term '${term}'.`,
          )
          assert.ok(
            containsExpectedTerm(parsedDocx, term),
            `${example.id}: DOCX is missing expected term '${term}'.`,
          )
        }
        const baselineDirectory =
          process.env.PIPELINE_DEEP_RESEARCH_BASELINE_DIR?.trim()
        const baselinePath = baselineDirectory
          ? path.join(path.resolve(baselineDirectory), `${example.id}.json`)
          : undefined
        if (baselinePath) {
          assert.ok(
            fs.existsSync(baselinePath),
            `${example.id}: baseline report is missing at ${baselinePath}.`,
          )
        }
        const evaluationReportPath = path.join(
          retentionRoot,
          `${example.id}.json`,
        )
        const evaluation = evaluateDeepResearchRunDirectory({
          runPath: task.runPath,
          evaluationCase: example,
          ...(baselinePath
            ? {
                baseline:
                  loadDeepResearchEvaluationReport(baselinePath),
              }
            : {}),
          outputPath: evaluationReportPath,
        })
        assert.equal(
          evaluation.decision,
          'PASS',
          `${example.id}: ${evaluation.blockingReasons.join(' ')}`,
        )
        const retainedRunPath = path.join(retentionRoot, example.id)
        fs.cpSync(task.runPath, retainedRunPath, {
          recursive: true,
          errorOnExist: true,
          force: false,
        })
        process.stderr.write(`${JSON.stringify({
          example: example.id,
          sessionId: session.id,
          taskId: launched.id,
          approvedTasks: approvedTaskCount,
          synthesisMode,
          qualityDecision: qualityVerdict.decision,
          qualityWarnings: qualityVerdict.findings.filter((finding) => finding.severity === 'warning').length,
          usableObservedSources,
          supportedClaims,
          researchCharacters: researchPackage.length,
          editorialCharacters: editorial.length,
          finalCharacters: markdown.length,
          docxBytes: fs.statSync(docxPath).size,
          evaluationDecision: evaluation.decision,
          compositeScore: evaluation.compositeScore,
          evaluationReportPath,
          retainedRunPath,
        })}\n`)
      }
      if (browserUseAlarmMicros !== undefined) {
        assert.ok(
          observedBrowserUseCostMicros <= browserUseAlarmMicros,
          `Browser Use cost ${observedBrowserUseCostMicros} micros exceeded ` +
            `the ${browserUseAlarmMicros} micros live-run alarm.`,
        )
      }
      process.stderr.write(
        `Retained Deep Research evaluation artifacts: ${retentionRoot}\n`,
      )
    } finally {
      await server?.close().catch(() => undefined)
      await browserManager.close().catch(() => undefined)
      for (const name of DIRECT_API_CREDENTIALS) {
        const value = originalCredentials[name]
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      if (keepWorkspace) {
        process.stderr.write(`Preserved live Deep Research workspace: ${root}\n`)
      } else {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  },
)

async function waitForTerminalTask(
  store: FileSystemSessionStore,
  sessionId: string,
  taskId: string,
) {
  const deadline = Date.now() + 40 * 60_000
  while (Date.now() < deadline) {
    const task = await store.getTaskRecord(sessionId, taskId)
    if (task && ['done', 'failed', 'blocked', 'cancelled'].includes(task.status)) {
      return task
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  throw new Error(`Timed out waiting for live Deep Research task '${taskId}'.`)
}

function findUniqueFile(rootPath: string, filename: string): string {
  const matches = walkFiles(rootPath).filter(
    (filePath) => path.basename(filePath) === filename,
  )
  assert.equal(matches.length, 1, `Expected exactly one ${filename}, found ${matches.length}.`)
  return matches[0]!
}

function walkFiles(rootPath: string): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = path.join(rootPath, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(entryPath))
    else if (entry.isFile()) files.push(entryPath)
  }
  return files
}

function parseDocx(docxPath: string, root: string): string {
  const outputPath = path.join(root, 'parsed-docx')
  fs.mkdirSync(outputPath, { recursive: true })
  const parseScript = [
    "import { parseDocx } from './parsers/docx.ts'",
    'const result = await parseDocx(process.argv[1], process.argv[2])',
    'console.log(JSON.stringify(result))',
  ].join(';')
  const parsed = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', parseScript, docxPath, outputPath],
    { cwd: path.join(REPO_ROOT, 'file-parser'), encoding: 'utf8' },
  )
  assert.equal(parsed.status, 0, parsed.stderr)
  const result = JSON.parse(parsed.stdout.trim()) as {
    status: string
    outputs: { text?: string }
  }
  assert.equal(result.status, 'success')
  assert.ok(result.outputs.text)
  return fs.readFileSync(path.join(outputPath, result.outputs.text), 'utf8')
}

function containsExpectedTerm(value: string, term: string): boolean {
  const normalize = (candidate: string) =>
    candidate
      .normalize('NFKD')
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
  return normalize(value).includes(normalize(term))
}
