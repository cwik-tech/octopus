import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  hashUnapprovedResearchPlan,
  isResearchPlanApprovalValid,
} from '../../domains/deep-research/deep-research-approval.js'
import type { ResearchPlan } from '../../contracts/deep-research.js'
import { enforceDeepResearchPlanReadiness } from '../../domains/run-orchestrator/deep-research.js'
import {
  createRunPlanService,
  selectRunPlanWorkflowService,
} from '../../services/run-orchestrator-service.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import type { SessionTask } from '../../contracts/sessions.js'
import {
  replaceYamlFields,
  setFrontMatterFields,
} from '../support/config-rewrite.js'
import { startOpenAiToolLoopFixture } from '../support/openai-tool-loop-fixture.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

const terminalTaskStatuses = new Set(['done', 'failed', 'blocked', 'cancelled'])
const providerModel = 'fixture/deep-research'
const providerSecret = 'deep-research-plan-electron-e2e-secret'

test('Deep Research plans and launches from the center journey workspace in Electron', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const providerFixture = await startOpenAiToolLoopFixture(repoRoot)
  const workspacePath = testInfo.outputPath('deep-research-workspace')
  const projectRootPath = testInfo.outputPath('deep-research-project')
  const userDataPath = testInfo.outputPath('deep-research-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(projectRootPath, { recursive: true }),
    fs.mkdir(userDataPath, { recursive: true }),
  ])

  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Deep Research approval E2E' })
  const initial = await createRunPlanService({
    sessionId: session.id,
    sessionStore,
    repoRootPath: repoRoot,
    workflowsRegistryPath: path.join(repoRoot, 'workflows', 'registry.yaml'),
    goal: 'Research official evidence for a launch decision.',
    workflowId: 'deep-research-report',
  })
  // The user's own selection, through the service that records its provenance.
  // The workspace deliberately does not open for a Coordinator proposal, so a
  // plan saved without that provenance no longer models this journey.
  const selected = await selectRunPlanWorkflowService({
    sessionId: session.id,
    sessionStore,
    repoRootPath: repoRoot,
    workflowsRegistryPath: path.join(repoRoot, 'workflows', 'registry.yaml'),
    workflowId: 'deep-research-report',
    expectedPlanId: initial.id,
  })
  expect(selected.selectedWorkflow?.selectionSource).toBe('user')
  const researchPlan = proposedResearchPlan()
  // The fixture plan has exactly one worker lane, so this never throws.
  const [firstWorker] = researchPlan.workerSpecs
  if (!firstWorker) throw new Error('The proposed research plan has no worker lane.')
  const proposalHash = hashUnapprovedResearchPlan(researchPlan)
  const proposal = enforceDeepResearchPlanReadiness({
    ...selected,
    deepResearchIntakeComplete: true,
    researchPlan,
    researchPlanProposalHash: proposalHash,
  })
  expect(proposal.deepResearchIntakeComplete).toBe(true)
  expect(proposal.status).toBe('needs_input')
  expect(await sessionStore.saveRunPlan(session.id, proposal)).toBe(true)

  const executablePath = process.env.PIPELINE_DESKTOP_EXECUTABLE
    ? path.resolve(repoRoot, process.env.PIPELINE_DESKTOP_EXECUTABLE)
    : undefined
  const app = await electron.launch({
    args: executablePath ? [] : ['.'],
    cwd: repoRoot,
    ...(executablePath ? { executablePath } : {}),
    env: {
      ...fixtureDesktopEnvironment(),
      NODE_ENV: 'test',
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      OPENAI_API_KEY: providerSecret,
      OPENAI_BASE_URL: `${providerFixture.url}/v1`,
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
    },
  })
  let apiBaseUrl: string | null = null
  let launchedTask: SessionTask | null = null

  try {
    const page = await app.firstWindow()
    // The first window is the startup page, painted before the desktop seeds
    // the project (electron/main.ts boot()). The renderer receives its API URL
    // only after seeding and the API start, so that handover is the point from
    // which the seeded personas exist and can be routed.
    const readyApiBaseUrl = await desktopApiBaseUrl(page)
    apiBaseUrl = readyApiBaseUrl
    await routeSeededDeepResearchProject(projectRootPath)
    let researchActivityAvailable = false
    let researchActivityRunId = ''
    let researchActivityAssignmentId = ''
    // Browser tool timing is nondeterministic in Electron. Intercept only the
    // local activity boundary so this regression deterministically exercises an
    // empty initial read followed by activity from the running workflow.
    await page.route(
      `**/sessions/${session.id}/research-activity`,
      async (route) => {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            activities: researchActivityAvailable
              ? [{
                  activityId: 'delayed-research-activity',
                  source: 'browser',
                  sessionId: session.id,
                  runId: researchActivityRunId,
                  assignmentId: researchActivityAssignmentId,
                  activityScopeId: firstWorker.laneId,
                  agentPath: 'agents/web-researcher',
                  toolCallId: 'delayed-research-tool-call',
                  action: 'open',
                  kind: 'page',
                  state: 'running',
                  createdAt: '2026-08-17T18:00:00.000Z',
                  updatedAt: '2026-08-17T18:00:00.000Z',
                  url: 'https://example.com/delayed-research',
                  title: 'Delayed research source',
                }]
              : [],
          }),
        })
      },
    )
    await page.getByRole('tab', { name: 'Run' }).click()
    const sessionButtons = page.getByRole('button', {
      name: /^Deep Research approval E2E\b/,
    })
    await expect(sessionButtons).toHaveCount(2)
    await sessionButtons.first().click()

    const workspace = page.getByTestId('deep-research-workspace')
    const journeyRail = workspace.getByRole('complementary', {
      name: 'Deep Research Journey',
    })
    const queueOverview = page.getByRole('button', { name: /^Queue overview\b/ })
    await expect(workspace).toBeVisible()
    await expect(journeyRail).toBeVisible()
    await expect(queueOverview).toBeVisible()

    const [journeyBox, sidebarBox] = await Promise.all([
      journeyRail.boundingBox(),
      queueOverview.boundingBox(),
    ])
    expect(journeyBox).not.toBeNull()
    expect(sidebarBox).not.toBeNull()
    expect(journeyBox!.x).toBeGreaterThan(sidebarBox!.x)

    await expect(journeyRail.getByText('Discuss & Plan', { exact: true })).toBeVisible()
    await expect(journeyRail.getByText('Research', { exact: true })).toBeVisible()
    await expect(journeyRail.getByText('Editorial Review', { exact: true })).toBeVisible()
    await expect(journeyRail.getByText('Final Documentation', { exact: true })).toBeVisible()
    await expect(workspace.getByText('Attention Required', { exact: true })).toHaveCount(0)
    await expect(workspace.getByRole('button', { name: /^(advance|continue)\b/i })).toHaveCount(0)

    const planningBlock = workspace.getByTestId('deep-research-planning-block')
    await expect(planningBlock.getByText('Canonical Research Brief', { exact: true })).toBeVisible()
    await expect(planningBlock.getByText('Proposed Research Plan', { exact: true })).toBeVisible()
    const questionText = planningBlock.getByText(researchPlan.request.question, { exact: true })
    await expect(questionText).toHaveCount(1)
    await expect(questionText.first()).toBeVisible()
    await expect(
      planningBlock.getByRole('button', {
        name: 'Task 1. Collect official product evidence',
      }),
    ).toBeVisible()
    await expect(
      planningBlock.getByText('Product Evidence Analyst', { exact: true }),
    ).toBeVisible()
    await expect(planningBlock.getByText('general-research-v1', { exact: true })).toHaveCount(0)
    await expect(planningBlock.getByText('Independent', { exact: true })).toHaveCount(0)
    await expect(
      planningBlock.getByRole('button', { name: 'Inspect assignment details' }),
    ).toHaveCount(0)
    await planningBlock.getByRole('button', { name: 'Execution policy' }).click()
    const executionPolicy = planningBlock.getByTestId(
      'deep-research-execution-policy',
    )
    await expect(executionPolicy).toBeVisible()
    await expect(executionPolicy.getByText('Adaptive execution policy')).toBeVisible()
    await expect(executionPolicy.getByText('$12.00')).toBeVisible()
    await expect(
      executionPolicy.getByText(/Section dossiers · up to 2 parallel drafts/),
    ).toBeVisible()
    await expect(
      executionPolicy.getByText(/Information gain ≥ 40\/100 · max 2 correction waves/),
    ).toBeVisible()

    const approvalResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith(`/sessions/${session.id}/run-plan/research-plan/approve`),
    )
    const taskResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith(`/sessions/${session.id}/tasks`),
    )
    await planningBlock.getByRole('button', {
      name: 'Approve & start research',
      exact: true,
    }).click()
    expect((await approvalResponse).status()).toBe(200)
    const launchedResponse = await taskResponse
    expect(launchedResponse.status()).toBe(202)
    const startedTask = await launchedResponse.json() as SessionTask
    launchedTask = startedTask
    expect(launchedTask.workflowId).toBe('deep-research-report')

    researchActivityRunId = launchedTask.runId
    await expect.poll(async () => {
      researchActivityAssignmentId = await researchAssignmentId(
        readyApiBaseUrl,
        startedTask,
      ) ?? ''
      return researchActivityAssignmentId
    }, {
      message: 'Expected the durable Research assignment to start',
      timeout: 20_000,
    }).not.toBe('')
    researchActivityAvailable = true

    const planningActivityResponse = page.waitForResponse((response) =>
      response.request().method() === 'GET' &&
      response.url().endsWith(`/sessions/${session.id}/research-activity`),
    )
    await journeyRail.getByText('Discuss & Plan', { exact: true }).click()
    expect((await planningActivityResponse).status()).toBe(200)
    await expect(workspace.getByLabel('Web research activity')).toHaveCount(0)
    await workspace.getByRole('button', { name: 'Return to live' }).click()

    const persisted = await sessionStore.getRunPlan(session.id)
    expect(isResearchPlanApprovalValid(persisted?.researchPlan)).toBe(true)
    expect(persisted?.researchPlanProposalHash).toBe(proposalHash)

    await expect(workspace.getByText('Research in Progress', { exact: true })).toBeVisible({
      timeout: 20_000,
    })
    await workspace.getByRole('button', {
      name: /^View research activity for Task 1\./,
    }).click()
    const activitySheetTitle = page.getByRole('heading', {
      name: 'Product Evidence Analyst research activity',
    })
    await expect(activitySheetTitle).toBeVisible()
    await expect(page.getByLabel('Web research activity')).toBeVisible()
    // A step still running shows what it is doing, not the page title it has
    // not finished reading. The title becomes the label only once the step is
    // terminal, so asserting it here would assert a state this fixture is
    // deliberately not in.
    await expect(page.getByText('Opening example.com')).toBeVisible()
    await expect(workspace.getByText('Attention Required', { exact: true })).toHaveCount(0)
    await expect(workspace.getByRole('button', { name: /^(advance|continue)\b/i })).toHaveCount(0)
    const leftActions = page.getByRole('group', { name: 'Left window actions' })
    const showSidebar = leftActions.getByRole('button', { name: 'Show sidebar' })
    await expect(showSidebar).toBeVisible()
    await expect(queueOverview).toHaveCount(0)
    await showSidebar.click()
    await expect(queueOverview).toBeVisible()
  } finally {
    if (apiBaseUrl && launchedTask) {
      await cancelIfNonTerminal(apiBaseUrl, launchedTask)
    }
    await Promise.allSettled([app.close(), providerFixture.close()])
  }
})

async function desktopApiBaseUrl(page: Page): Promise<string> {
  await page.waitForURL((url) => url.hash.includes('pipeline-api-base-url='))
  const baseUrl = await page.evaluate(() =>
    new URLSearchParams(window.location.hash.slice(1)).get('pipeline-api-base-url'),
  )
  if (!baseUrl) throw new Error('Desktop API URL is unavailable')
  return baseUrl
}

async function researchAssignmentId(
  apiBaseUrl: string,
  task: SessionTask,
): Promise<string | null> {
  const response = await fetch(
    `${apiBaseUrl}/sessions/${task.sessionId}/tasks/${task.id}/deep-research`,
  )
  if (!response.ok) return null
  const payload: unknown = await response.json()
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const workflow = Reflect.get(payload, 'workflow')
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return null
  const steps = Reflect.get(workflow, 'steps')
  if (!Array.isArray(steps)) return null
  for (const step of steps) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) continue
    if (Reflect.get(step, 'id') !== 'research') continue
    const runId = Reflect.get(step, 'runId')
    return typeof runId === 'string' ? runId : null
  }
  return null
}

async function cancelIfNonTerminal(apiBaseUrl: string, task: SessionTask): Promise<void> {
  const response = await fetch(
    `${apiBaseUrl}/sessions/${task.sessionId}/tasks/${task.id}`,
  ).catch(() => null)
  if (!response?.ok) return
  const current = await response.json() as SessionTask
  if (terminalTaskStatuses.has(current.status)) return
  await fetch(`${apiBaseUrl}/sessions/${task.sessionId}/tasks/${task.id}`, {
    method: 'DELETE',
  }).catch(() => undefined)
}

async function routeSeededDeepResearchProject(projectRootPath: string): Promise<void> {
  const agentNames = [
    'brief-builder',
    'editor',
    'evidence-critic',
    'deep-research-publication-editor',
    'deep-research-writer',
    'research-escalator',
    'research-planner',
    'research-section-writer',
    'research-synthesizer',
    'web-researcher',
    'writer',
  ]
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

function proposedResearchPlan(): ResearchPlan {
  const question = 'What official evidence supports the launch decision?'
  return {
    schemaVersion: 1,
    planId: 'electron-research-plan',
    requestId: 'electron-research-request',
    request: {
      schemaVersion: 1,
      requestId: 'electron-research-request',
      question,
      objective: 'Produce an evidence-backed launch recommendation.',
      audience: 'Product leadership',
      includedScope: ['Official current product evidence'],
      excludedScope: ['Unverified commentary'],
      desiredSections: ['Launch evidence'],
      jurisdictions: [],
      freshnessAsOf: '2026-07-16T12:00:00.000Z',
      authenticatedDomains: [],
      sourceRequirements: ['Prefer directly observed primary sources.'],
      maxDurationMinutes: 20,
      maxResearcherAgents: 2,
      outputFormats: ['markdown', 'docx'],
    },
    sections: [{
      schemaVersion: 1,
      id: 'launch-evidence',
      title: 'Launch evidence',
      objective: 'Establish the directly observed product evidence.',
      taskIds: ['T1'],
    }],
    tasks: [{
      schemaVersion: 1,
      id: 'T1',
      sectionId: 'launch-evidence',
      title: 'Collect official product evidence',
      question,
      purpose: 'evidence_acquisition',
      workerSpecId: 'launch-worker',
      dependsOn: [],
      correctionWave: 0,
    }],
    workerSpecs: [{
      schemaVersion: 1,
      id: 'launch-worker',
      laneId: 'launch-lane',
      sectionId: 'launch-evidence',
      baseAgent: 'web-researcher',
      displayRole: 'Product Evidence Analyst',
      domain: 'Product launch',
      lens: 'market',
      methodCardIds: ['general-research-v1'],
      specialistStance:
        'Approach this assignment as a product-launch evidence analyst. Separate verified readiness evidence from promotional claims.',
      question,
      decisionUse: 'Decide whether the product is ready to launch.',
      workingDefinitions: [
        'Treat launch readiness as established only when every approved acceptance criterion has direct source support.',
      ],
      dependencyClaimIds: [],
      sourceRequirements: {
        preferredTypes: ['primary'],
        requiredAuthorityTypes: ['primary'],
        queryHints: ['official product evidence'],
      },
      requiredMetrics: [],
      prohibitedAssumptions: ['Search snippets are evidence.'],
      stopRule: {
        minimumPrimarySources: 1,
        minimumIndependentSources: 1,
        maximumSources: 5,
      },
      limits: { deadlineMs: 10 * 60_000 },
    }],
    maxDurationMinutes: 20,
    maxResearcherAgents: 2,
    expectedPeakWorkers: 1,
    authenticatedDomains: [],
    executionPolicy: {
      schemaVersion: 1,
      complexity: 'complex',
      complexityRationale:
        'The launch report requires evidence-bound section drafting and publication validation.',
      searchBreadth: 'focused',
      maxCostUsd: 12,
      evidenceTargets: {
        minimumSupportedClaims: 1,
        minimumIndependentSourcesPerConsequentialClaim: 1,
        crossVerifyConsequentialClaims: true,
      },
      stopping: {
        minimumExpectedInformationGain: 40,
        maximumCorrectionWaves: 2,
      },
      synthesis: {
        mode: 'section_dossiers',
        maximumParallelSections: 2,
      },
    },
  }
}
