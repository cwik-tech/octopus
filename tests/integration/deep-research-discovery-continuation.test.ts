/**
 * Regression for the failed sushi session
 * (`6e73a2c1-9a6e-468a-a181-745c4cfe02fb`, run `19c96f87-…`, assignment
 * `a2e14ddf-…`).
 *
 * The persisted acquisition settings were schema version 3 with Brave and
 * Browser Use connected. Five `research.web` searches failed with `internal`
 * before any provider ran, while the worker's own managed browser rendered
 * search-result pages and reached real sources through them. Both lanes
 * returned accepted evidence packets — and the pipeline still rewrote them as
 * failed and published a report claiming every search was `not_configured`.
 *
 * The contract: a run that had a working discovery path keeps its accepted
 * evidence and continues.
 */
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { ACQUISITION_SETTINGS_SCHEMA_VERSION } from '../../domains/acquisition/acquisition-settings.js'
import { approveResearchPlan } from '../../domains/deep-research/deep-research-approval.js'
import { hashResearchValue } from '../../domains/deep-research/deep-research-worker-policy.js'
import { createPipelineTool } from '../../engines/pipeline.js'
import { parsePlan } from '../../parsers/plan-parser.js'
import { parseTeamConfig } from '../../parsers/team-config.js'
import { registerProvider } from '../../providers/index.js'
import type { ProviderResult } from '../../providers/types.js'
import { AcquisitionSettingsService } from '../../services/acquisition-settings-service.js'
import { STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'

const REPO_ROOT = process.cwd()
const RESEARCH_TEAM_ROOT = path.join(REPO_ROOT, 'teams', 'research-team')
const EVIDENCE_PROVIDER = 'deep-research-discovery-continuation-fixture'

const SESSION_ID = 'discovery-session'
const RUN_ID = 'discovery-run'
const ASSIGNMENT_ID = 'discovery-assignment'
const LANES = ['downtown-detroit-sushi-evidence', 'downtown-detroit-sushi-quality'] as const
const TASK_IDS = ['T1', 'T2'] as const

test('a run whose searches failed with an internal fault keeps its accepted evidence when the managed browser reached the web', async () => {
  const workspacePath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-discovery-')),
  )
  const assignmentPath = path.join(
    workspacePath,
    'sessions',
    SESSION_ID,
    'runs',
    RUN_ID,
    'assignments',
    ASSIGNMENT_ID,
  )
  try {
    fs.mkdirSync(assignmentPath, { recursive: true })

    // ── Arrange: the settings the failed session actually had on disk ────────
    // Schema version 3 with Brave and Browser Use connected. Before the cloud
    // rung merged, reading this file threw and every search failed `internal`.
    const settingsPath = path.join(workspacePath, 'research-acquisition-settings.json')
    fs.writeFileSync(settingsPath, JSON.stringify(persistedSchemaV3Settings()))
    const settings = await new AcquisitionSettingsService({
      storagePath: settingsPath,
    }).snapshot()
    assert.equal(settings.source, 'persisted', 'the v3 settings file is readable')
    assert.equal(settings.providers.brave.enabled, true)
    assert.equal(settings.providers['browser-use'].enabled, true)
    assert.equal(settings.providers['browser-use'].status, 'connected')

    // ── Arrange: the journals the failed session left behind ─────────────────
    writeSessionJournal(workspacePath, 'research-acquisition.json', [
      ...LANES.flatMap((laneId, laneIndex) =>
        Array.from({ length: laneIndex === 0 ? 2 : 3 }, (_unused, index) =>
          failedSearch({ laneId, index: laneIndex * 10 + index }),
        ),
      ),
      ...LANES.map((laneId, index) =>
        completedDirectAcquisition({ laneId, index }),
      ),
    ])
    writeSessionJournal(workspacePath, 'browser-activity.json',
      LANES.map((laneId, index) => renderedSearchPage({ laneId, index })),
    )

    // ── Arrange: an approved two-lane plan that requires discovery ───────────
    const bindings = writeApprovedResearchPlan(assignmentPath)
    writeRuntimeLimits(assignmentPath)
    writePipelinePlan(assignmentPath)

    const packets = new Map(
      TASK_IDS.map((taskId, index) => {
        const binding = bindings.get(taskId)!
        return [taskId, receiptBackedPacket({
          assignmentPath,
          taskId,
          laneId: binding.assignmentId,
          workerSpecHash: binding.workerSpecHash,
          index,
        })]
      }),
    )
    registerProvider({
      name: EVIDENCE_PROVIDER,
      execute: async (options) => {
        const taskId = TASK_IDS.find((candidate) =>
          options.userMessage.includes(candidate),
        )
        assert.ok(taskId, 'the research dispatch names the task it is executing')
        return providerResult(JSON.stringify(packets.get(taskId)))
      },
    })

    // ── Act: run the real Collect Evidence stage ─────────────────────────────
    const level = collectEvidenceLevel()
    const state = runtimeState(level.id)
    const result = await createPipelineTool({
      teamName: 'research-team',
      teamConfig: level.teamConfig,
      teamRootPath: RESEARCH_TEAM_ROOT,
      levelId: level.id,
      config: level.stage,
      agents: new Map([
        ['web-researcher', {
          name: 'web-researcher',
          systemPrompt: 'FIXTURE_ROLE:web-researcher',
          agentDir: assignmentPath,
          experienceEnabled: false,
          model: 'fixture-model',
          thinking: 'low',
          tools: [],
          provider: EVIDENCE_PROVIDER,
        }],
      ]),
      rosterEntries: new Map([['web-researcher', level.rosterEntry]]),
      state,
      workspacePath,
      outputPath: assignmentPath,
      inputFilesContent: '',
      agentMetrics: new Map(),
    } as never).execute(
      'collect-evidence',
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    )

    // ── Assert: the accepted lanes survive ───────────────────────────────────
    const text = toolText(result)
    const executablePlan = parsePlan(
      path.join(assignmentPath, '.runtime', 'pipeline', level.id, 'plan.md'),
    )
    for (const taskId of TASK_IDS) {
      assert.equal(
        executablePlan?.tasks.get(taskId)?.status,
        'completed',
        `${taskId} kept the evidence packet the runtime already validated`,
      )
      const persisted = JSON.parse(fs.readFileSync(
        path.join(assignmentPath, 'research', 'evidence', 'wave-0', `${taskId}.json`),
        'utf8',
      )) as { taskId: string; sources: unknown[] }
      assert.equal(persisted.taskId, taskId)
      assert.equal(persisted.sources.length, 1)
    }

    assert.doesNotMatch(
      text,
      /Search capability absent/i,
      'the managed browser reached the web, so no discovery path was absent',
    )
    assert.doesNotMatch(
      text,
      /not_configured/,
      'the journal recorded `internal`, never a missing credential',
    )
    assert.equal(
      fs.existsSync(path.join(assignmentPath, 'research-package.md')),
      false,
      'a continuing run publishes no terminal blocker report',
    )
    assert.notEqual(
      state.levelStates.get(level.id)?.stageStatus,
      STAGE_LIFECYCLE_STATUS.FAILED,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

// ── Fixtures ────────────────────────────────────────────────────────────────

function persistedSchemaV3Settings(): Record<string, unknown> {
  return {
    schemaVersion: ACQUISITION_SETTINGS_SCHEMA_VERSION,
    providerPriority: ['brave', 'exa'],
    providers: {
      exa: { enabled: false, status: 'unknown' },
      brave: {
        enabled: true,
        status: 'connected',
        encryptedApiKey: 'fixture-brave-key',
        lastCheckedAt: '2026-08-28T18:25:53.416Z',
      },
      firecrawl: { enabled: false, status: 'unknown' },
      'browser-use': {
        enabled: true,
        status: 'connected',
        encryptedApiKey: 'fixture-browser-use-key',
        lastCheckedAt: '2026-08-30T22:54:49.777Z',
      },
    },
    budgets: {
      maximumSearchCalls: 20,
      maximumBrowserFallbacks: 10,
      maximumManagedReaderCalls: 5,
      maximumModelExtractions: 20,
      maximumCloudBrowserCalls: 20,
      maximumCloudBrowserCostMicros: 100_000_000,
    },
    extractionModel: null,
  }
}

function writeSessionJournal(
  workspacePath: string,
  fileName: string,
  entries: readonly unknown[],
): void {
  const directory = path.join(workspacePath, 'sessions', SESSION_ID)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, fileName), JSON.stringify(entries))
}

function journalScope(laneId: string, index: number): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    runId: RUN_ID,
    assignmentId: ASSIGNMENT_ID,
    activityScopeId: laneId,
    agentPath: 'agents/web-researcher',
    toolCallId: `call-${laneId}-${index}`,
    createdAt: '2026-08-31T17:47:14.912Z',
    updatedAt: '2026-08-31T17:47:15.912Z',
  }
}

function failedSearch(input: {
  readonly laneId: string
  readonly index: number
}): Record<string, unknown> {
  return {
    activityId: `search-${input.laneId}-${input.index}`,
    ...journalScope(input.laneId, input.index),
    action: 'search',
    state: 'failed',
    attempts: [],
    error: {
      code: 'internal',
      message: 'Acquisition settings file is invalid.',
      retryable: true,
    },
  }
}

function completedDirectAcquisition(input: {
  readonly laneId: string
  readonly index: number
}): Record<string, unknown> {
  return {
    activityId: `acquire-${input.laneId}-${input.index}`,
    ...journalScope(input.laneId, input.index),
    action: 'acquire',
    state: 'completed',
    attempts: [{ method: 'direct-http', outcome: 'usable' }],
    requestedUrl: `https://example.com/${input.laneId}`,
    observationReceipt: {
      schemaVersion: 5,
      receiptId: `direct-${input.index}`,
      activityId: `direct-${input.index}`,
      activityScopeId: input.laneId,
      relativePath: `research/observations/${input.laneId}/direct-${input.index}.json`,
      method: 'direct-http',
      requestedUrl: `https://example.com/${input.laneId}`,
      finalUrl: `https://example.com/${input.laneId}`,
      canonicalUrl: `https://example.com/${input.laneId}`,
      observedAt: '2026-08-31T17:47:36.552Z',
    },
  }
}

/** The alternate discovery path: the managed browser rendered a results page. */
function renderedSearchPage(input: {
  readonly laneId: string
  readonly index: number
}): Record<string, unknown> {
  const receiptId = `browser-${input.index}`
  return {
    activityId: receiptId,
    ...journalScope(input.laneId, input.index),
    action: 'open',
    argumentNames: ['action', 'url'],
    state: 'completed',
    pageId: `page-${input.index}`,
    url: 'https://www.bing.com/search',
    title: 'downtown Detroit sushi restaurant official menu prices address - Search',
    observationReceipt: {
      schemaVersion: 5,
      receiptId,
      activityId: receiptId,
      activityScopeId: input.laneId,
      relativePath: `research/observations/${input.laneId}/${receiptId}.json`,
      method: 'managed-browser',
      requestedUrl: 'https://www.bing.com/search?q=downtown+Detroit+sushi',
      finalUrl: 'https://www.bing.com/search',
      canonicalUrl: 'https://www.bing.com/search',
      observedAt: '2026-08-31T17:47:36.552Z',
    },
  }
}

function writeApprovedResearchPlan(
  assignmentPath: string,
): Map<string, { assignmentId: string; workerSpecHash: string }> {
  const workers = TASK_IDS.map((taskId, index) => ({
    schemaVersion: 1 as const,
    id: `worker-${taskId}`,
    laneId: LANES[index]!,
    sectionId: 'downtown-sushi',
    baseAgent: 'web-researcher' as const,
    displayRole: `Sushi Evidence Analyst ${index + 1}`,
    domain: 'downtown Detroit restaurants',
    lens: 'foundational' as const,
    methodCardIds: ['general-research-v1'] as const,
    specialistStance:
      'Approach this assignment as a restaurant evidence analyst. Separate directly observed facts from inference.',
    question: `Research question ${taskId}`,
    decisionUse: 'Support the sushi recommendation report.',
    workingDefinitions: [],
    dependencyClaimIds: [],
    sourceRequirements: {
      preferredTypes: ['primary' as const],
      requiredAuthorityTypes: ['primary' as const],
      queryHints: ['downtown Detroit sushi menu prices'],
    },
    coverageRequirements: [{
      schemaVersion: 2 as const,
      id: 'observed-sushi-menu',
      label: 'A directly observed downtown Detroit sushi menu',
      kind: 'fact' as const,
      validation: 'claim_support' as const,
      required: true,
    }],
    prohibitedAssumptions: ['Search snippets are evidence.'],
    stopRule: {
      minimumPrimarySources: 0,
      minimumIndependentSources: 1,
      maximumSources: 5,
    },
    limits: { deadlineMs: 600_000 },
  }))
  const plan = approveResearchPlan({
    schemaVersion: 1,
    planId: 'sushi-plan',
    requestId: 'sushi-request',
    request: {
      schemaVersion: 1,
      requestId: 'sushi-request',
      question: 'Which downtown Detroit sushi restaurants are worth a visit?',
      objective: 'Recommend downtown Detroit sushi restaurants.',
      audience: 'One diner',
      includedScope: ['Downtown Detroit sushi restaurants'],
      excludedScope: [],
      desiredSections: ['Downtown sushi'],
      jurisdictions: ['Detroit, Michigan'],
      freshnessAsOf: '2026-08-31T12:00:00.000Z',
      authenticatedDomains: [],
      sourceRequirements: [],
      maxDurationMinutes: 30,
      maxResearcherAgents: 4,
      outputFormats: ['markdown', 'docx'],
    },
    sections: [{
      schemaVersion: 1,
      id: 'downtown-sushi',
      title: 'Downtown sushi',
      objective: 'Establish the observed downtown Detroit sushi evidence.',
      taskIds: [...TASK_IDS],
    }],
    tasks: TASK_IDS.map((taskId) => ({
      schemaVersion: 1,
      id: taskId,
      sectionId: 'downtown-sushi',
      title: `Task ${taskId}`,
      question: `Research question ${taskId}`,
      purpose: 'evidence_acquisition',
      workerSpecId: `worker-${taskId}`,
      dependsOn: [],
      correctionWave: 0,
    })),
    workerSpecs: workers,
    maxDurationMinutes: 30,
    maxResearcherAgents: 4,
    expectedPeakWorkers: 2,
    authenticatedDomains: [],
  }, '2026-08-31T12:00:00.000Z')
  const artifactPath = path.join(assignmentPath, 'research', 'approved-plan.json')
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
  fs.writeFileSync(artifactPath, JSON.stringify(plan))
  return new Map(workers.map((worker) => [
    worker.id.replace('worker-', ''),
    { assignmentId: worker.laneId, workerSpecHash: hashResearchValue(worker) },
  ]))
}

function writeRuntimeLimits(assignmentPath: string): void {
  const startedAt = new Date()
  const limitsPath = path.join(assignmentPath, 'research', 'runtime-limits.json')
  fs.mkdirSync(path.dirname(limitsPath), { recursive: true })
  fs.writeFileSync(limitsPath, JSON.stringify({
    schemaVersion: 1,
    planId: 'sushi-plan',
    maxDurationMinutes: 30,
    startedAt: startedAt.toISOString(),
    deadlineAt: new Date(startedAt.getTime() + 30 * 60_000).toISOString(),
  }))
}

function writePipelinePlan(assignmentPath: string): void {
  const planPath = path.join(assignmentPath, 'research', 'plan.md')
  fs.mkdirSync(path.dirname(planPath), { recursive: true })
  fs.writeFileSync(planPath, [
    '# Plan: Downtown Detroit sushi evidence',
    '**Status:** draft',
    '',
    '### S1: Collect evidence',
    '',
    ...TASK_IDS.flatMap((taskId) => [
      `#### ${taskId}: Evidence ${taskId}`,
      '- **Agent:** web-researcher',
      '- **Status:** pending',
      '- **Validate:** false',
      '- **Depends on:** none',
      '- **Gate:** false',
      `- **Result file:** research/evidence/wave-0/${taskId}.json`,
      '',
    ]),
  ].join('\n'))
}

/** A receipt-backed evidence packet, exactly as an accepted lane returns one. */
function receiptBackedPacket(input: {
  readonly assignmentPath: string
  readonly taskId: string
  readonly laneId: string
  readonly workerSpecHash: string
  readonly index: number
}): Record<string, unknown> {
  const receiptId = `receipt-${input.taskId}`
  const canonicalUrl = `https://sushi-${input.index}.example.com/menu`
  const observedExcerpt = `Observed omakase pricing for restaurant ${input.index}.`
  const contentRelativePath =
    `research/acquisitions/${input.laneId}/${receiptId}/content.md`
  const content = Buffer.from(
    `Menu\n\n${observedExcerpt}\nThe menu lists eighteen nigiri courses.\n`,
    'utf8',
  )
  const contentSha256 = crypto.createHash('sha256').update(content).digest('hex')
  const contentPath = path.join(input.assignmentPath, contentRelativePath)
  const receiptPath = path.join(
    input.assignmentPath,
    'research',
    'observations',
    input.laneId,
    `${receiptId}.json`,
  )
  fs.mkdirSync(path.dirname(contentPath), { recursive: true })
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true })
  fs.writeFileSync(contentPath, content)
  fs.writeFileSync(receiptPath, JSON.stringify({
    schemaVersion: 1,
    receiptId,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    assignmentId: ASSIGNMENT_ID,
    activityScopeId: input.laneId,
    activityId: receiptId,
    agentPath: 'agents/web-researcher',
    agentDisplayName: 'Sushi Evidence Analyst',
    method: 'managed-browser',
    requestedUrl: canonicalUrl,
    finalUrl: canonicalUrl,
    canonicalUrl,
    title: `Sushi menu ${input.index}`,
    mediaType: 'text/html',
    observedAt: '2026-08-31T17:47:36.552Z',
    contentRelativePath,
    contentSha256,
    contentBytes: content.byteLength,
    quality: 'usable',
    attempts: [{
      method: 'managed-browser',
      outcome: 'usable',
      startedAt: '2026-08-31T17:47:35.552Z',
      durationMs: 1_000,
      contentBytes: content.byteLength,
    }],
  }))
  return {
    schemaVersion: 1,
    assignmentId: input.laneId,
    taskId: input.taskId,
    workerSpecHash: input.workerSpecHash,
    question: `Research question ${input.taskId}`,
    shortAnswer: `Observed sushi evidence for ${input.taskId}.`,
    findings: [{
      schemaVersion: 1,
      claimId: `claim-${input.taskId}`,
      taskId: input.taskId,
      sectionId: 'downtown-sushi',
      statement: `Restaurant ${input.index} publishes an omakase menu.`,
      kind: 'fact',
      evidenceStandard: 'single',
      sourceIds: [`source-${input.taskId}`],
      evidenceLinks: [{
        sourceId: `source-${input.taskId}`,
        observationReceiptId: receiptId,
        observedExcerpt,
        locator: 'Menu, omakase paragraph',
        relationship: 'supports',
      }],
      confidence: 'high',
      status: 'supported',
      applicableScope: ['Downtown Detroit'],
    }],
    sources: [{
      schemaVersion: 1,
      sourceId: `source-${input.taskId}`,
      assignmentId: input.laneId,
      canonicalUrl,
      title: `Sushi menu ${input.index}`,
      publisher: `Sushi ${input.index}`,
      independenceKey: `sushi-${input.index}`,
      sourceType: 'primary',
      accessMethod: 'managed-browser',
      observationReceiptId: receiptId,
      observedAt: '2026-08-31T17:47:36.552Z',
      contentSha256,
      status: 'usable',
    }],
    contradictions: [],
    unresolvedQuestions: [],
    coverage: [{
      schemaVersion: 2,
      requirementId: 'observed-sushi-menu',
      status: 'satisfied',
      claimIds: [`claim-${input.taskId}`],
      sourceIds: [`source-${input.taskId}`],
      asOf: '2026-08-31T17:47:36.552Z',
      scope: ['Downtown Detroit'],
    }],
    stopReason: 'decision_useful',
  }
}

function collectEvidenceLevel() {
  const parsed = parseTeamConfig(path.join(RESEARCH_TEAM_ROOT, 'team.yaml'))
  assert.deepEqual(parsed.errors, [])
  assert.ok(parsed.config)
  const level = parsed.config.levels.find(
    (candidate) => candidate.id === 'collect-evidence',
  )
  assert.ok(level)
  assert.equal(level.stage.type, 'pipeline')
  const rosterEntry = parsed.config.agents.find(
    (candidate) => candidate.name === 'web-researcher',
  )
  assert.ok(rosterEntry)
  return {
    id: level.id,
    stage: level.stage,
    teamConfig: parsed.config,
    rosterEntry,
  }
}

function runtimeState(levelId: string) {
  return {
    sessionId: SESSION_ID,
    currentLevelIndex: 0,
    levelStates: new Map([
      [levelId, {
        status: 'active',
        stageStatus: STAGE_LIFECYCLE_STATUS.READY,
        loopbackCount: 0,
        engineState: null,
      }],
    ]),
    totalCost: 0,
    startTime: Date.now(),
    timerStarted: true,
    endTime: null,
    spawnDepth: 0,
    rootSessionId: RUN_ID,
    parentSessionId: SESSION_ID,
  }
}

function providerResult(text: string): ProviderResult {
  return {
    text,
    cost: 0,
    durationMs: 1,
    inputTokens: 0,
    outputTokens: 0,
    contextTokens: 0,
    model: 'fixture-model',
    costTracked: true,
    costSource: 'zero_cost',
  }
}

function toolText(result: unknown): string {
  return (
    result as { content?: Array<{ text?: string }> }
  ).content?.[0]?.text ?? ''
}
