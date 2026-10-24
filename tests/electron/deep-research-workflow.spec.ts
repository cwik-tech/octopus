import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  DEEP_RESEARCH_UNVALIDATED_SENTENCE,
  DEEP_RESEARCH_UNVALIDATED_URL,
} from '../fixtures/providers/deep-research-fixture-constants.mjs'
import type { BrowserSettingsSnapshot } from '../../services/browser-settings-service.js'
import { enforceDeepResearchPlanReadiness } from '../../domains/run-orchestrator/deep-research.js'
import { createRunPlanService } from '../../services/run-orchestrator-service.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import type { SessionTask } from '../../contracts/sessions.js'
import {
  replaceYamlFields,
  setFrontMatterFields,
} from '../support/config-rewrite.js'
import { startOpenAiToolLoopFixture } from '../support/openai-tool-loop-fixture.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const providerModel = 'fixture/deep-research'
const providerSecret = 'deep-research-electron-e2e-secret'
const terminalTaskStatuses = new Set(['done', 'failed', 'blocked', 'cancelled'])

test('Deep Research recovers a fenced quality verdict, executes an adaptive correction, and publishes Markdown plus DOCX in Electron', async ({}, testInfo) => {
  test.setTimeout(180_000)

  const userDataPath = testInfo.outputPath('deep-research-user-data')
  const workspacePath = path.join(userDataPath, 'workspace')
  const projectRootPath = testInfo.outputPath('deep-research-project')
  const providerFixture = await startOpenAiToolLoopFixture(
    repoRoot,
    'openai-tool-loop-server.mjs',
    {
      env: {
        PIPELINE_DEEP_RESEARCH_FIXTURE_SCENARIO: 'fenced-correction',
      },
    },
  )
  const evidenceSite = createEvidenceSite()
  const evidenceSiteUrl = await listen(evidenceSite)
  const sourceUrl = `${evidenceSiteUrl.replace('127.0.0.1', 'localhost')}/evidence`

  await Promise.all([
    fs.mkdir(projectRootPath, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(userDataPath, { recursive: true }),
  ])
  await fs.writeFile(
    path.join(userDataPath, 'browser-settings.json'),
    JSON.stringify({ version: 1, mode: 'headless' }),
    'utf8',
  )

  const app = await launchDesktop({
    projectRootPath,
    providerUrl: providerFixture.url,
    userDataPath,
    workspacePath,
  })
  let apiBaseUrl: string | null = null
  let launchedTask: SessionTask | null = null

  try {
    const page = await app.firstWindow()
    apiBaseUrl = await desktopApiBaseUrl(page)
    const browserSettings = await readJson<BrowserSettingsSnapshot>(`${apiBaseUrl}/settings/browser`)
    expect(browserSettings.mode).toBe('headless')
    expect(
      browserSettings.status,
      `Electron browser runtime is unavailable: ${browserSettings.error ?? 'Chrome was not found'}`,
    ).not.toBe('unavailable')
    await page.getByLabel('Settings', { exact: true }).click()
    const settingsNavigation = page.getByRole('navigation', { name: 'Settings sections' })
    await settingsNavigation
      .getByRole('button', { name: 'Research & Acquisition', exact: true })
      .click()
    const browserMode = page.getByRole('group', { name: 'Browser mode' })
    await expect(browserMode.getByRole('button', { name: 'Headless' }))
      .toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Open authenticated profile' }).click()
    await expect.poll(async () =>
      (await readJson<BrowserSettingsSnapshot>(`${apiBaseUrl}/settings/browser`)).mode,
    ).toBe('headless')
    await expect.poll(async () =>
      (await readJson<BrowserSettingsSnapshot>(`${apiBaseUrl}/settings/browser`)).status,
    ).toBe('running')
    await expect(browserMode.getByRole('button', { name: 'Headless' }))
      .toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Stop browser' }).click()
    await expect.poll(async () =>
      (await readJson<BrowserSettingsSnapshot>(`${apiBaseUrl}/settings/browser`)).status,
    ).toBe('stopped')

    await expect(browserMode.getByRole('button', { name: 'Headless' }))
      .toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Escape')
    // The launched app seeds these definitions. For a packaged executable this
    // verifies and exercises the assets inside the package, not the source checkout.
    await routeSeededDeepResearchProject(projectRootPath)
    const sessionStore = new FileSystemSessionStore(workspacePath)
    const session = await sessionStore.createSession({ title: 'Deep Research complete E2E' })
    const initialPlan = await createRunPlanService({
      sessionId: session.id,
      sessionStore,
      repoRootPath: projectRootPath,
      workflowsRegistryPath: path.join(projectRootPath, 'workflows', 'registry.yaml'),
      goal: [
        'Research the official evidence needed for a bounded product launch decision.',
        `Fixture source URL: ${sourceUrl}`,
      ].join(' '),
      workflowId: 'deep-research-report',
      selectionSource: 'user',
    })
    await page.reload()

    await page.getByRole('tab', { name: 'Run' }).click()
    const sessionButtons = page.getByRole('button', { name: /^Deep Research complete E2E\b/ })
    await expect(sessionButtons).toHaveCount(2)
    await sessionButtons.first().click()
    await page.getByRole('tab', { name: 'Workflows', exact: true }).click()

    const workspace = page.getByTestId('deep-research-workspace')
    await expect(workspace).toBeVisible()
    await expect(
      workspace.getByText('Canonical Research Brief', { exact: true }),
    ).toHaveCount(0)
    await expect(
      workspace.getByRole('button', { name: 'Generate research plan', exact: true }),
    ).toHaveCount(0)
    await expect(
      workspace.getByText('Attention Required', { exact: true }),
    ).toHaveCount(0)
    await expect(
      workspace.getByRole('button', { name: /^(advance|continue)\b/i }),
    ).toHaveCount(0)

    const intakeCompletePlan = enforceDeepResearchPlanReadiness({
      ...initialPlan,
      id: `${initialPlan.id}-intake-complete`,
      deepResearchIntakeComplete: true,
    })
    const intakeRevision = await sessionStore.reviseRunPlan(
      session.id,
      initialPlan.id,
      intakeCompletePlan,
    )
    expect(intakeRevision?.revised).toBe(true)
    expect(intakeRevision?.plan.deepResearchIntakeComplete).toBe(true)

    let generationRequestCount = 0
    let releaseGenerationResponse = () => {}
    const generationResponseReleased = new Promise<void>((resolve) => {
      releaseGenerationResponse = resolve
    })
    await page.route(
      `**/sessions/${session.id}/run-plan/research-plan`,
      async (route) => {
        if (route.request().method() !== 'POST') {
          await route.continue()
          return
        }
        generationRequestCount += 1
        const response = await route.fetch()
        await generationResponseReleased
        await route.fulfill({ response })
      },
    )
    const generationResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith(`/sessions/${session.id}/run-plan/research-plan`),
    )

    await page.reload()
    await page.getByRole('tab', { name: 'Run' }).click()
    const readySessionButtons = page.getByRole('button', {
      name: /^Deep Research complete E2E\b/,
    })
    await expect(readySessionButtons).toHaveCount(2)
    await readySessionButtons.first().click()
    await page.getByRole('tab', { name: 'Workflows', exact: true }).click()
    await expect(workspace).toBeVisible()
    await expect(
      workspace.getByText('Canonical Research Brief', { exact: true }),
    ).toHaveCount(0)
    try {
      await expect.poll(() => generationRequestCount, {
        message: 'Expected intake completion to start plan generation automatically',
        timeout: 10_000,
      }).toBe(1)
      await expect(
        workspace.getByTestId('deep-research-plan-generating'),
      ).toContainText(
        'Planning continues on the backend and reconnects when you return.',
      )
      await expect(
        workspace.getByRole('button', { name: 'Generate research plan', exact: true }),
      ).toHaveCount(0)
      await expect(
        workspace.getByRole('button', { name: 'Regenerate plan', exact: true }),
      ).toHaveCount(0)
    } finally {
      releaseGenerationResponse()
    }
    expect((await generationResponse).status()).toBe(202)
    expect(generationRequestCount).toBe(1)
    await expect(
      workspace.getByText('Canonical Research Brief', { exact: true }),
    ).toBeVisible({ timeout: 45_000 })
    await expect(
      workspace.getByText('Proposed Research Plan', { exact: true }),
    ).toBeVisible()
    await expect(
      workspace.getByText('Product Evidence Analyst', { exact: false }),
    ).toBeVisible()
    await workspace.getByRole('button', { name: 'Execution policy' }).click()
    const executionPolicy = workspace.getByTestId(
      'deep-research-execution-policy',
    )
    await expect(executionPolicy).toBeVisible()
    await expect(executionPolicy.getByText('$12.00')).toBeVisible()
    await expect(
      executionPolicy.getByText(/Section dossiers · up to 2 parallel drafts/),
    ).toBeVisible()
    await expect(
      workspace.getByRole('button', { name: 'Generate research plan', exact: true }),
    ).toHaveCount(0)
    await expect(
      workspace.getByRole('button', { name: 'Regenerate plan', exact: true }),
    ).toHaveCount(0)

    const approvalResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/sessions/${session.id}/run-plan/research-plan/approve`),
    )
    const taskResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/sessions/${session.id}/tasks`),
    )
    await workspace.getByRole('button', {
      name: 'Approve & start research',
      exact: true,
    }).click()
    expect((await approvalResponse).status()).toBe(200)
    const taskResponse = await taskResponsePromise
    const taskBody = await taskResponse.json()
    expect(taskResponse.status(), JSON.stringify(taskBody)).toBe(202)
    launchedTask = taskBody as SessionTask

    await expect(
      workspace.getByText('Research in Progress', { exact: true }),
    ).toBeVisible({ timeout: 20_000 })
    await expect(
      workspace.getByText('Attention Required', { exact: true }),
    ).toHaveCount(0)
    await expect(
      workspace.getByRole('button', { name: /^(advance|continue)\b/i }),
    ).toHaveCount(0)

    const taskBeforeReload = await readJson<SessionTask>(
      `${apiBaseUrl}/sessions/${session.id}/tasks/${launchedTask.id}`,
    )
    expect(terminalTaskStatuses.has(taskBeforeReload.status)).toBe(false)

    await page.reload()
    await page.getByRole('tab', { name: 'Run' }).click()
    const restoredSessionButtons = page.getByRole('button', {
      name: /^Deep Research complete E2E\b/,
    })
    await expect(restoredSessionButtons).toHaveCount(2)
    await restoredSessionButtons.first().click()
    await page.getByRole('tab', { name: 'Workflows', exact: true }).click()
    await expect(workspace).toBeVisible({ timeout: 20_000 })
    await expect(
      workspace.locator('[data-testid^="deep-research-stage-"]'),
    ).toBeVisible({ timeout: 20_000 })
    await expect(
      workspace.getByRole('button', { name: /^(advance|continue)\b/i }),
    ).toHaveCount(0)

    const completedTask = await waitForTerminalTask(apiBaseUrl, launchedTask)
    expect(completedTask.status, completedTask.error).toBe('done')
    expect(completedTask.runPath).toEqual(expect.any(String))
    const completedBrowserSettings = await readJson<BrowserSettingsSnapshot>(
      `${apiBaseUrl}/settings/browser`,
    )
    expect(completedBrowserSettings.mode).toBe('headless')
    expect(completedBrowserSettings.status).toBe('running')

    const deliveryStage = workspace.getByTestId(
      'deep-research-stage-final-documentation',
    )
    await expect(deliveryStage).toBeVisible({ timeout: 20_000 })
    await expect(
      workspace.getByRole('heading', { name: 'Inspectable Run Files' }),
    ).toBeVisible()
    await expect(
      workspace.getByRole('tree').getByText('final-report.md', { exact: true }),
    ).toBeVisible()
    await expect(
      workspace.getByRole('tree').getByText('publication-audit.json', {
        exact: true,
      }),
    ).toBeVisible()
    const journey = await readJson<{
      artifacts: Array<{ kind: string; relativePath: string }>
    }>(
      `${apiBaseUrl}/sessions/${session.id}/tasks/${completedTask.id}/deep-research`,
    )
    expect(journey.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'adaptive_decision',
        relativePath: 'research/adaptive/decision-wave-0.json',
      }),
      expect.objectContaining({
        kind: 'amendment',
        relativePath: 'research/amendments/amendment-wave-1.json',
      }),
      expect.objectContaining({
        kind: 'evidence',
        relativePath: 'research/evidence/wave-1/T1.json',
      }),
    ]))

    const runActivity = page.getByLabel('Run activity')
    const runSummary = runActivity.getByLabel('Run summary')
    await expect(runSummary).toBeVisible()
    await expect(
      runSummary.getByText('Deep Research complete E2E', { exact: true }),
    ).toBeVisible()
    // The summary learns completion from the run's event stream, one hop
    // behind the task API this test just read, so it gets the same bound as
    // the other post-run projections above.
    await expect(
      runSummary.getByText('Complete', { exact: true }),
    ).toBeVisible({ timeout: 20_000 })
    await expect(
      runActivity.getByLabel('Workflow stages'),
    ).toHaveCount(0)
    await expect(
      runActivity.getByRole('tablist', { name: 'Task history' }),
    ).toHaveCount(0)

    const processTimeline = page.getByRole('region', {
      name: 'Process timeline',
      exact: true,
    })
    await expect(processTimeline).toBeVisible()
    const agentFilter = processTimeline.getByRole('combobox', {
      name: 'Filter events by agent',
    })
    await agentFilter.click()
    await page
      .getByRole('option', { name: 'Product Evidence Analyst' })
      .click()
    await expect(agentFilter).toContainText('Product Evidence Analyst')
    await expect(
      processTimeline.getByLabel('Agent: Product Evidence Analyst').first(),
    ).toBeVisible()
    const workflowStartedEvents = processTimeline.getByLabel(
      'Workflow run started',
      { exact: true },
    )
    await expect(workflowStartedEvents).toHaveCount(0)
    await agentFilter.click()
    await page.getByRole('option', { name: 'All agents' }).click()
    await expect.poll(() => workflowStartedEvents.count()).toBeGreaterThan(0)

    const finalMarkdownButton = deliveryStage.getByRole('button', {
      name: 'Open report',
    })
    await expect(finalMarkdownButton).toBeVisible()
    await finalMarkdownButton.click()
    await expect(page.getByRole('heading', { name: 'Deep Research Launch Report' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Primary launch evidence' }))
      .toHaveAttribute('href', sourceUrl)
    await page.keyboard.press('Escape')

    const docxLink = deliveryStage.getByRole('button', { name: 'Download' })
    await expect(docxLink).toBeVisible()
    const downloadedDocx = await docxLink.evaluate(async (link: HTMLAnchorElement) => {
      const response = await fetch(link.href)
      const bytes = new Uint8Array(await response.arrayBuffer())
      return {
        contentDisposition: response.headers.get('content-disposition'),
        contentType: response.headers.get('content-type'),
        ok: response.ok,
        prefix: Array.from(bytes.slice(0, 2)),
      }
    })
    expect(downloadedDocx).toEqual({
      contentDisposition: expect.stringContaining('attachment'),
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ok: true,
      prefix: [0x50, 0x4b],
    })

    await assertCompleteResearchRun({
      runPath: completedTask.runPath!,
      sessionId: session.id,
      sourceUrl,
      workspacePath,
    })
  } finally {
    if (apiBaseUrl && launchedTask) {
      await cancelIfNonTerminal(apiBaseUrl, launchedTask)
    }
    await Promise.allSettled([
      app.close(),
      providerFixture.close(),
      new Promise<void>((resolve) => evidenceSite.close(() => resolve())),
    ])
  }
})

async function routeSeededDeepResearchProject(projectRootPath: string): Promise<void> {
  const agentNames = [
    'brief-builder',
    'deep-research-publication-editor',
    'deep-research-writer',
    'editor',
    'evidence-critic',
    'research-escalator',
    'research-planner',
    'research-plan-reviewer',
    'research-section-writer',
    'research-synthesizer',
    'web-researcher',
    'writer',
  ]
  const requiredSeededPaths = [
    path.join(projectRootPath, 'teams', 'research-team', 'team.yaml'),
    path.join(projectRootPath, 'teams', 'research-team', 'scripts', 'materialize-approved-plan.mjs'),
    path.join(projectRootPath, 'teams', 'research-team', 'scripts', 'adaptive-amendment.mjs'),
    path.join(projectRootPath, 'teams', 'research-team', 'scripts', 'prepare-correction-wave.mjs'),
    path.join(projectRootPath, 'teams', 'research-team', 'scripts', 'prepare-resynthesis-wave.mjs'),
    path.join(projectRootPath, 'teams', 'deep-research-publication-team', 'team.yaml'),
    path.join(projectRootPath, 'workflows', 'registry.yaml'),
    path.join(projectRootPath, 'workflows', 'templates', 'deep-research-to-document.yaml'),
    ...agentNames.map((agentName) =>
      path.join(projectRootPath, 'agents', agentName, `${agentName}.md`),
    ),
  ]
  await Promise.all(requiredSeededPaths.map((filePath) => fs.access(filePath)))

  // No team.yaml rewrite here. `TeamConfig` carries no top-level `provider` or
  // `model` (see `core/types.ts`), and the one provider field the schema still
  // accepts — `defaults.provider` — is documented there as retired and read
  // only so it can be reported as ignored. The rewrite that used to run here
  // matched nothing in any bundled team.yaml and could not have routed a
  // dispatch even if it had. What actually routes these journeys is the
  // persona front matter below and the teams.yaml host pair after it.
  for (const agentName of agentNames) {
    const agentPath = path.join(projectRootPath, 'agents', agentName, `${agentName}.md`)
    await fs.writeFile(
      agentPath,
      routeAgentToFixture(agentPath, await fs.readFile(agentPath, 'utf8')),
      'utf8',
    )
  }
  // Replaced, not set: every registry entry declares its host routing today,
  // and an entry that lost it has no unambiguous place to insert it back into.
  // A registry that stops declaring it is news, so this fails loudly.
  const teamsRegistryPath = path.join(projectRootPath, 'teams.yaml')
  await fs.writeFile(
    teamsRegistryPath,
    replaceYamlFields({
      fields: { host_model: providerModel, host_provider: 'openai' },
      file: teamsRegistryPath,
      source: await fs.readFile(teamsRegistryPath, 'utf8'),
    }),
    'utf8',
  )
}

/**
 * Pin a seeded persona to the fixture provider and model.
 *
 * Set, not replaced. A bundled persona may legitimately stop declaring
 * `provider:`, and a rewrite that quietly matched nothing would leave this
 * journey dispatching to the real application default under a name that says
 * it exercises the fixture. `setFrontMatterFields` throws instead when there
 * is no front matter to pin the values in.
 */
function routeAgentToFixture(file: string, source: string): string {
  return setFrontMatterFields({
    fields: { model: providerModel, provider: 'openai' },
    file,
    source,
  })
}

async function launchDesktop(params: {
  projectRootPath: string
  providerUrl: string
  userDataPath: string
  workspacePath: string
}): Promise<ElectronApplication> {
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
      NODE_ENV: 'test',
      OPENAI_API_KEY: providerSecret,
      OPENAI_BASE_URL: `${params.providerUrl}/v1`,
      // The fixture reports token usage but no cost, and this journey always
      // runs under a budget. Without a price the runtime appends its advisory
      // budget warning to every answer, which corrupts each stage whose output
      // is a machine contract before that contract can be read. A real
      // provider is priced; so is this one.
      TEAM_PROVIDER_PRICING_JSON: JSON.stringify({
        'openai:*': { inputPerMillion: 0, outputPerMillion: 0 },
      }),
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: params.projectRootPath,
      PIPELINE_DESKTOP_USER_DATA: params.userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: params.workspacePath,
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
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

async function waitForTerminalTask(apiBaseUrl: string, task: SessionTask): Promise<SessionTask> {
  let current = task
  await expect.poll(async () => {
    current = await readTask(apiBaseUrl, task)
    return current.status
  }, {
    message: `Timed out waiting for Deep Research task ${task.id}`,
    timeout: 120_000,
    intervals: [100, 250, 500, 1_000],
  }).toMatch(/^(done|failed|blocked|cancelled)$/)
  return current
}

async function readTask(
  apiBaseUrl: string,
  task: Pick<SessionTask, 'id' | 'sessionId'>,
): Promise<SessionTask> {
  return readJson<SessionTask>(`${apiBaseUrl}/sessions/${task.sessionId}/tasks/${task.id}`)
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  const body = await response.json()
  expect(response.status, JSON.stringify(body)).toBe(200)
  return body as T
}

async function cancelIfNonTerminal(apiBaseUrl: string, task: SessionTask): Promise<void> {
  const current = await readTask(apiBaseUrl, task).catch(() => null)
  if (!current || terminalTaskStatuses.has(current.status)) return
  await fetch(`${apiBaseUrl}/sessions/${task.sessionId}/tasks/${task.id}`, {
    method: 'DELETE',
  }).catch(() => undefined)
}

async function assertCompleteResearchRun(params: {
  runPath: string
  sessionId: string
  sourceUrl: string
  workspacePath: string
}): Promise<void> {
  const files = await walkFiles(params.runPath)
  const finalMarkdownPath = requireFile(files, 'final-report.md')
  const finalDocxPath = requireFile(files, 'final-report.docx')
  const researchPackagePath = requireFile(files, 'research-package.md')
  const finalDraftPath = requireFileBeside(
    files,
    'final-draft.md',
    'publication-audit-v1.json',
  )
  const evidencePacketPath = requireFile(files, path.join('research', 'evidence', 'wave-1', 'T1.json'))
  const qualityVerdictPath = requireFile(files, path.join('research', 'quality', 'current-verdict.json'))
  const evidenceGraphPath = requireFile(
    files,
    path.join('research', 'evidence-graph', 'current.json'),
  )
  const dossierPath = requireFile(
    files,
    path.join(
      'research',
      'sections',
      'launch-evidence',
      'dossier-wave-1.json',
    ),
  )
  const sectionDraftPath = requireFile(
    files,
    path.join(
      'research',
      'sections',
      'launch-evidence',
      'draft-wave-1.md',
    ),
  )
  const adaptiveDecisionPath = requireFile(
    files,
    path.join('research', 'adaptive', 'current-decision.json'),
  )
  const correctionDecisionPath = requireFile(
    files,
    path.join('research', 'adaptive', 'decision-wave-0.json'),
  )
  const amendmentPath = requireFile(
    files,
    path.join('research', 'amendments', 'amendment-wave-1.json'),
  )
  const publicationAuditPath = requireFileBeside(
    files,
    'publication-audit.json',
    'final-report.md',
  )
  const observationReceiptPath = files.find((filePath) =>
    filePath.includes(`${path.sep}research${path.sep}observations${path.sep}`) &&
    filePath.endsWith('.json'),
  )
  expect(observationReceiptPath, 'Expected a source observation receipt').toBeTruthy()

  const [
    finalMarkdown,
    researchPackage,
    finalDraft,
    evidencePacket,
    qualityVerdict,
    evidenceGraph,
    dossier,
    sectionDraft,
    adaptiveDecision,
    correctionDecision,
    amendment,
    publicationAudit,
    docx,
  ] =
    await Promise.all([
      fs.readFile(finalMarkdownPath, 'utf8'),
      fs.readFile(researchPackagePath, 'utf8'),
      fs.readFile(finalDraftPath, 'utf8'),
      fs.readFile(evidencePacketPath, 'utf8'),
      fs.readFile(qualityVerdictPath, 'utf8'),
      fs.readFile(evidenceGraphPath, 'utf8'),
      fs.readFile(dossierPath, 'utf8'),
      fs.readFile(sectionDraftPath, 'utf8'),
      fs.readFile(adaptiveDecisionPath, 'utf8'),
      fs.readFile(correctionDecisionPath, 'utf8'),
      fs.readFile(amendmentPath, 'utf8'),
      fs.readFile(publicationAuditPath, 'utf8'),
      fs.readFile(finalDocxPath),
    ])
  for (const artifact of [
    finalMarkdown,
    researchPackage,
    finalDraft,
    evidencePacket,
    evidenceGraph,
    dossier,
    sectionDraft,
  ]) {
    expect(artifact).toContain(params.sourceUrl)
  }

  // Citation canonicalization: the editorial draft invented one citation that
  // the evidence graph never validated. It must be repaired out of everything
  // that ships, while the draft itself stays intact for comparison.
  expect(finalDraft).toContain(DEEP_RESEARCH_UNVALIDATED_URL)
  expect(finalMarkdown).not.toContain(DEEP_RESEARCH_UNVALIDATED_URL)
  expect(finalMarkdown).toContain(`${DEEP_RESEARCH_UNVALIDATED_SENTENCE}.`)
  expect(finalMarkdown.match(/^## Sources$/gmu)).toHaveLength(1)
  expect(finalMarkdown).toContain(
    `- [Primary launch evidence](${params.sourceUrl})`,
  )
  expect(finalMarkdown.toLowerCase())
    .toContain('the source states that the launch evidence is verified and ready for a bounded decision')
  expect(JSON.parse(qualityVerdict)).toMatchObject({ decision: 'APPROVE' })
  expect(JSON.parse(evidenceGraph)).toMatchObject({
    correctionWave: 1,
    coverage: {
      supportedClaims: 1,
      totalClaims: 1,
    },
    gaps: [],
  })
  expect(JSON.parse(adaptiveDecision)).toMatchObject({
    correctionWave: 1,
    decision: 'not_applicable',
  })
  expect(JSON.parse(correctionDecision)).toMatchObject({
    correctionWave: 0,
    decision: 'continue',
    route: 'research',
  })
  expect(JSON.parse(amendment)).toMatchObject({
    fromWave: 0,
    toWave: 1,
    route: 'research',
    targetTaskIds: ['T1'],
    scopeChange: 'none',
  })
  expect(JSON.parse(publicationAudit)).toMatchObject({
    decision: 'APPROVE',
    graphCoverage: {
      requiredClaimSourceLinks: 1,
      preservedClaimSourceLinks: 1,
    },
    violations: [],
    // The repair is recorded, not silently applied.
    canonicalization: {
      graphUrlBaseline: [params.sourceUrl],
      publicationUrlInventory: [params.sourceUrl],
      generatedSourceCount: 1,
      removedSourceSectionHeadings: ['Sources'],
      removedUnknownUrls: [
        { url: DEEP_RESEARCH_UNVALIDATED_URL, kind: 'bare_url' },
      ],
    },
  })
  expect(docx.subarray(0, 2)).toEqual(Buffer.from([0x50, 0x4b]))
  const parsedDocx = parseDocx(finalDocxPath, params.workspacePath)
  expect(parsedDocx.toLowerCase())
    .toContain('the source states that the launch evidence is verified and ready for a bounded decision')
  // Word renders the label as visible text and the canonical URL as the link
  // destination; the DOCX parser recovers that destination as [label](url).
  expect(parsedDocx).toContain(params.sourceUrl)
  expect(parsedDocx).not.toContain(DEEP_RESEARCH_UNVALIDATED_URL)
  expect(parsedDocx).toContain('Primary launch evidence')

  const activityResponse = await fs.readFile(
    path.join(params.workspacePath, 'sessions', params.sessionId, 'browser-activity.json'),
    'utf8',
  )
  const activity = JSON.parse(activityResponse) as Array<Record<string, unknown>>
  expect(activity).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: 'open', state: 'completed' }),
  ]))
}

function parseDocx(docxPath: string, root: string): string {
  const outputPath = path.join(root, 'parsed-e2e-docx')
  fsSync.mkdirSync(outputPath, { recursive: true })
  const parseScript = [
    "import { parseDocx } from './parsers/docx.ts'",
    'const result = await parseDocx(process.argv[1], process.argv[2])',
    'console.log(JSON.stringify(result))',
  ].join(';')
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', parseScript, docxPath, outputPath],
    {
      cwd: path.join(repoRoot, 'file-parser'),
      encoding: 'utf8',
    },
  )
  expect(result.status, result.stderr).toBe(0)
  const parsed = JSON.parse(result.stdout.trim()) as {
    status: string
    outputs: { text?: string }
  }
  expect(parsed.status).toBe('success')
  expect(parsed.outputs.text).toEqual(expect.any(String))
  return fsSync.readFileSync(path.join(outputPath, parsed.outputs.text!), 'utf8')
}

async function walkFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(root, entry.name)
    return entry.isDirectory() ? walkFiles(entryPath) : [entryPath]
  }))
  return files.flat()
}

function requireFile(files: readonly string[], suffix: string): string {
  const normalizedSuffix = suffix.split(path.sep).join('/')
  const match = files.find((filePath) => filePath.split(path.sep).join('/').endsWith(normalizedSuffix))
  expect(match, `Expected run artifact ${normalizedSuffix}`).toBeTruthy()
  return match!
}

function requireFileBeside(
  files: readonly string[],
  suffix: string,
  sibling: string,
): string {
  const normalizedSuffix = suffix.split(path.sep).join('/')
  const match = files.find((filePath) =>
    filePath.split(path.sep).join('/').endsWith(normalizedSuffix) &&
    files.includes(path.join(path.dirname(filePath), sibling)),
  )
  if (!match) {
    throw new Error(
      `Expected run artifact ${normalizedSuffix} beside ${sibling}`,
    )
  }
  return match
}

function createEvidenceSite(): http.Server {
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/evidence') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end([
      '<!doctype html>',
      '<html><head><title>Primary launch evidence</title></head>',
      '<body><main><h1>Launch Evidence</h1>',
      '<p>Launch evidence is verified and ready for a bounded decision.</p>',
      '</main></body></html>',
    ].join(''))
  })
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Evidence fixture address is unavailable')
  return `http://127.0.0.1:${address.port}`
}
