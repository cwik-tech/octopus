import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'
import { parsePlan } from '../../parsers/plan-parser.js'
import { approveResearchPlan } from '../../domains/deep-research/deep-research-approval.js'
import { hashResearchValue } from '../../domains/deep-research/deep-research-worker-policy.js'

type MockDispatchResult =
  | {
      text: string
      skipped?: boolean
      onStart?: () => void
      waitFor?: Promise<void>
      beforeReturn?: () => void
    }
  | Error

let queuedResults: MockDispatchResult[] = []
let dispatchCalls = 0
/** Substituted system prompts, in dispatch order, as the dispatcher received them. */
let dispatchedSystemPrompts: string[] = []

class MockDispatchResultValidationError extends Error {
  constructor(
    message: string,
    readonly category: string,
  ) {
    super(message)
    this.name = 'DispatchResultValidationError'
  }
}

class MockHaltError extends Error {
  readonly agentName: string
  readonly originalError: string

  constructor(agentName: string, originalError: string) {
    super(originalError)
    this.name = 'HaltError'
    this.agentName = agentName
    this.originalError = originalError
  }
}

mock.module('../../domains/agent-execution/failure-policy.js', {
  namedExports: {
    DispatchResultValidationError: MockDispatchResultValidationError,
    HaltError: MockHaltError,
    resolveFailurePolicy: () => ({ policy: 'retry', maxRetries: 2 }),
    dispatchWithFailurePolicy: mock.fn(async (options: any) => {
      const maxAttempts = (options.policy?.maxRetries ?? 0) + 1
      dispatchedSystemPrompts.push(String(options.finalPrompt ?? ''))
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        dispatchCalls += 1
        const next = queuedResults.shift()
        if (!next) throw new Error('No mocked pipeline dispatch result queued.')
        if (next instanceof Error) throw next
        next.onStart?.()
        await next.waitFor
        next.beforeReturn?.()
        try {
          const text = options.validateResult
            ? options.validateResult(next.text)
            : next.text
          options.onAttemptRecord?.({
            agentName: options.agent.name,
            attempt,
            prompt: options.finalPrompt,
            userMessage: options.userMessage,
            responseText: next.text,
            error: undefined,
            attemptStartedAtMs: Date.now(),
            elapsedMs: 0,
          })
          return {
            text,
            skipped: next.skipped ?? false,
            cost: 0,
            durationMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            contextTokens: 0,
            model: 'mock-model',
          }
        } catch (error) {
          options.onAttemptRecord?.({
            agentName: options.agent.name,
            attempt,
            prompt: options.finalPrompt,
            userMessage: options.userMessage,
            responseText: next.text,
            error,
            attemptStartedAtMs: Date.now(),
            elapsedMs: 0,
          })
          options.onAttemptFailure?.(options.agent.name, error, attempt)
          if (attempt === maxAttempts || queuedResults.length === 0) {
            throw new MockHaltError(
              options.agent.name,
              error instanceof Error ? error.message : String(error),
            )
          }
        }
      }
      throw new Error('Mock dispatch exhausted unexpectedly.')
    }),
  },
})

const { createPipelineTool } = await import('../../engines/pipeline.js')

function writePlan(dir: string, content: string): string {
  const planDir = path.join(dir, '.pi-tasks')
  fs.mkdirSync(planDir, { recursive: true })
  const planPath = path.join(planDir, 'plan.md')
  fs.writeFileSync(planPath, content)
  return planPath
}

function runtimePlanPath(dir: string): string {
  return path.join(dir, '.runtime', 'pipeline', 'execution', 'plan.md')
}

function parsePlanStatus(
  planPath: string,
  taskId: string,
): string | undefined {
  return parsePlan(planPath)?.tasks.get(taskId)?.status
}

function makeContext(
  dir: string,
  options: {
    recoveryMode?: boolean
    executionMode?: 'serial' | 'bounded_parallel'
    maxConcurrency?: number
    assignmentScope?: 'stage' | 'task'
    planArtifact?: string
    workspacePath?: string
    deadlineArtifact?: string
  } = {},
) {
  return {
    teamName: 'pipeline-team',
    teamRootPath: dir,
    levelId: 'execution',
    config: {
      type: 'pipeline',
      coordinator: 'editor',
      participants: ['writer', 'editor'],
      config: {
        plan_file: '.pi-tasks/plan.md',
        execution_mode: options.executionMode ?? 'serial',
        max_concurrency: options.maxConcurrency,
        assignment_scope: options.assignmentScope ?? 'stage',
        plan_artifact: options.planArtifact,
        deadline_artifact: options.deadlineArtifact,
        parallel: true,
        output: { format: 'unused.md', user_review: false },
      },
    },
    agents: new Map([
      ['writer', { name: 'writer', systemPrompt: 'Write.', agentDir: dir, experienceEnabled: false }],
      ['editor', { name: 'editor', systemPrompt: 'Edit.', agentDir: dir, experienceEnabled: false }],
      ['web-researcher', { name: 'web-researcher', systemPrompt: 'Research.', agentDir: dir, experienceEnabled: false }],
    ]),
    rosterEntries: new Map([
      ['writer', { name: 'writer', type: 'agent' }],
      ['editor', { name: 'editor', type: 'agent' }],
      ['web-researcher', { name: 'web-researcher', type: 'agent' }],
    ]),
    state: {
      sessionId: 'pipeline-session',
      currentLevelIndex: 0,
      levelStates: new Map([
        ['execution', {
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
      rootSessionId: 'root-session',
      parentSessionId: undefined,
    },
    workspacePath: options.workspacePath ?? dir,
    outputPath: dir,
    inputFilesContent: '',
    agentMetrics: new Map(),
    stageFailureOverride: undefined,
    shutdownSignal: undefined,
    budgetLedger: undefined,
    recoveryMode: options.recoveryMode,
    onDashboardUpdate: undefined,
  } as any
}

function writeApprovedResearchPlan(
  dir: string,
  taskIds: readonly string[],
  maxResearchers = 8,
  dependencies: Readonly<Record<string, readonly string[]>> = {},
) {
  const workers = taskIds.map((taskId, index) => ({
    schemaVersion: 1 as const,
    id: `worker-${taskId}`,
    laneId: `lane-${index + 1}`,
    sectionId: 'section-one',
    baseAgent: 'web-researcher' as const,
    displayRole: `Evidence Analyst ${index + 1}`,
    domain: 'software markets',
    lens: 'foundational' as const,
    methodCardIds: ['general-research-v1'] as const,
    specialistStance:
      'Approach this assignment as a software-market evidence analyst. Separate directly observed facts from inference.',
    question: `Research question ${taskId}`,
    decisionUse: 'Support the final report.',
    workingDefinitions: [],
    dependencyClaimIds: [],
    sourceRequirements: {
      preferredTypes: ['primary' as const],
      requiredAuthorityTypes: ['primary' as const],
      queryHints: [`query ${taskId}`],
    },
    requiredMetrics: [],
    prohibitedAssumptions: ['Search snippets are evidence.'],
    stopRule: {
      minimumPrimarySources: 0,
      minimumIndependentSources: 1,
      maximumSources: 5,
    },
    limits: { deadlineMs: 60_000 },
  }))
  const plan = approveResearchPlan({
    schemaVersion: 1,
    planId: 'plan-one',
    requestId: 'request-one',
    request: {
      schemaVersion: 1,
      requestId: 'request-one',
      question: 'What does the evidence establish?',
      objective: 'Collect decision-useful evidence.',
      audience: 'Decision makers',
      includedScope: ['Approved research tasks'],
      excludedScope: [],
      desiredSections: ['Evidence'],
      jurisdictions: [],
      freshnessAsOf: '2026-07-16T12:00:00.000Z',
      authenticatedDomains: [],
      sourceRequirements: [],
      maxDurationMinutes: 20,
      maxResearcherAgents: maxResearchers,
      outputFormats: ['markdown', 'docx'],
    },
    sections: [{
      schemaVersion: 1,
      id: 'section-one',
      title: 'Evidence',
      objective: 'Collect decision-useful evidence.',
      taskIds,
    }],
    tasks: taskIds.map((taskId) => ({
      schemaVersion: 1,
      id: taskId,
      sectionId: 'section-one',
      title: `Task ${taskId}`,
      question: `Research question ${taskId}`,
      purpose: 'evidence_acquisition',
      workerSpecId: `worker-${taskId}`,
      dependsOn: [...(dependencies[taskId] ?? [])],
      correctionWave: 0,
    })),
    workerSpecs: workers,
    maxDurationMinutes: 20,
    maxResearcherAgents: maxResearchers,
    expectedPeakWorkers: Math.min(taskIds.length, maxResearchers),
    authenticatedDomains: [],
  }, '2026-07-16T12:00:00.000Z')
  const artifactPath = path.join(dir, 'research', 'plan.json')
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
  fs.writeFileSync(artifactPath, JSON.stringify(plan))
  return new Map(workers.map((worker) => [worker.id.replace('worker-', ''), {
    assignmentId: worker.laneId,
    workerSpecHash: hashResearchValue(worker),
  }]))
}

function researchEvidenceResult(input: {
  taskId: string
  assignmentId: string
  workerSpecHash: string
}): string {
  return JSON.stringify({
    schemaVersion: 1,
    ...input,
    question: `Research question ${input.taskId}`,
    shortAnswer: `Evidence answer ${input.taskId}`,
    findings: [],
    sources: [],
    contradictions: [],
    unresolvedQuestions: [],
    stopReason: 'decision_useful',
  })
}

/**
 * A packet the runtime accepts whose finding names a section the approved plan
 * does not contain. Wave finalization rejects it, which is how these tests
 * reach the finalization failure path without a fabricated throw.
 */
function unknownSectionEvidenceResult(input: {
  taskId: string
  assignmentId: string
  workerSpecHash: string
}): string {
  const packet = JSON.parse(researchEvidenceResult(input)) as Record<string, unknown>
  packet.findings = [{
    schemaVersion: 1,
    claimId: `claim-${input.taskId}`,
    taskId: input.taskId,
    sectionId: 'coverage-requirement-id',
    statement: 'The remaining evidence gap is explicit.',
    kind: 'uncertainty',
    evidenceStandard: 'single',
    sourceIds: [],
    evidenceLinks: [],
    confidence: 'low',
    status: 'unsupported',
    applicableScope: [],
  }]
  return JSON.stringify(packet)
}

function readTextResult(result: any): string {
  return (result.content?.[0] as { text?: string } | undefined)?.text ?? ''
}

/**
 * Assert the shape a finalization failure owes the operator in `text`: the
 * cause as one response, and the blocker persistence failure as the response
 * after it. Bold does not span the blank line joining two responses, so a
 * nested one renders as literal asterisks.
 *
 * A substring match cannot see a dropped push — the three sites that report
 * this emit identical text, so one surviving pair satisfies it for all of
 * them. Checking every reported cause for its own follow-up does see it, given
 * a test per site: the serial path reaches two of them, the bounded-parallel
 * drain the third.
 *
 * A dropped CAUSE push is caught only where a test drives one site by itself.
 * The serial run reaches two sites, so either pair reads as the other's.
 */
function assertFinalizationFailureReportedInPairs(text: string, cause: string): void {
  assert.doesNotMatch(
    text,
    /\*\*Research evidence finalization blocked: /,
    'a bold span left open across the blank line renders as literal asterisks',
  )
  const responses = text.split('\n\n')
  const reportIndexes = responses.flatMap((response, index) => (
    response.startsWith('**Research evidence finalization blocked:**') ? [index] : []
  ))
  assert.ok(reportIndexes.length > 0, 'the finalization failure reaches the operator')
  for (const index of reportIndexes) {
    assert.equal(responses[index], `**Research evidence finalization blocked:** ${cause}`)
    assert.match(
      responses[index + 1] ?? '',
      /^\*\*Deep Research finalization blocker persistence failed: [^\n*]+\*\*$/,
    )
  }
}

/** Every file under `root` carrying `needle`, as paths relative to `root`. */
function filesContainingText(root: string, needle: string): string[] {
  const matches: string[] = []
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(entryPath)
        continue
      }
      if (!entry.isFile()) continue
      if (fs.readFileSync(entryPath, 'utf8').includes(needle)) {
        matches.push(path.relative(root, entryPath))
      }
    }
  }
  visit(root)
  return matches
}

/**
 * The assignment a correction wave leaves behind when its only lane cannot
 * run. `teams/research-team/scripts/prepare-correction-wave.mjs` writes all
 * three: the executable plan for wave `wave`, whose tasks resolve to
 * `research/evidence/wave-<wave>/`; the correction context that says the wave
 * is in flight; and — untouched, because the wave that removes it has not
 * finalized — the report the wave before it published.
 *
 * Returns that report, which is what the archive must end up holding.
 */
function writeFailedCorrectionWave(dir: string, wave: number): string {
  writePlan(dir, `
# Plan: Deep Research Correction Wave ${wave}
**Status:** draft

### S1: Targeted Corrections Wave ${wave}

#### T1: Unavailable lane
- **Agent:** missing-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/evidence/wave-${wave}/T1.json
`)
  writeApprovedResearchPlan(dir, ['T1'])
  const correctionPath = path.join(dir, 'research', 'corrections', 'current.json')
  fs.mkdirSync(path.dirname(correctionPath), { recursive: true })
  fs.writeFileSync(correctionPath, JSON.stringify({ schemaVersion: 1, wave }))
  const priorReport = [
    '# Research Report',
    '',
    '**Status:** completed',
    '',
    `Wave ${wave - 1} verified and published this report.`,
    '',
  ].join('\n')
  fs.writeFileSync(path.join(dir, 'research-package.md'), priorReport)
  return priorReport
}

/** Drain the correction wave written above, and return the stage response. */
async function runFailedCorrectionLane(dir: string): Promise<string> {
  const ctx = makeContext(dir, {
    executionMode: 'bounded_parallel',
    maxConcurrency: 2,
    assignmentScope: 'task',
    planArtifact: 'research/plan.json',
  })
  const result = await createPipelineTool(ctx).execute(
    'failed-correction-lane',
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  )
  return readTextResult(result)
}

test('dispatch defaults to auto and drains ready tasks through the task graph', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-runtime-loop-'))
  try {
    writePlan(dir, `
# Plan: Sample
**Status:** draft

### S1: Sprint

#### T1: First task
- **Agent:** writer
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** t1.md

#### T2: Second task
- **Agent:** editor
- **Status:** pending
- **Validate:** false
- **Depends on:** T1
- **Gate:** false
- **Result file:** t2.md
`)
    queuedResults = [
      { text: 'Writer completed T1' },
      { text: 'Editor completed T2' },
    ]

    const ctx = makeContext(dir)
    const tool = createPipelineTool(ctx)
    const result = await tool.execute('call-1', undefined as any, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(result)
    const plan = fs.readFileSync(runtimePlanPath(dir), 'utf8')
    const sourcePlan = fs.readFileSync(path.join(dir, '.pi-tasks', 'plan.md'), 'utf8')

    assert.match(text, /\*\*T1 dispatched to writer:/)
    assert.match(text, /\*\*T2 dispatched to editor:/)
    assert.match(text, /\*\*Pipeline complete:/)
    assert.match(plan, /#### T1:[\s\S]*?- \*\*Status:\*\* completed/)
    assert.match(plan, /#### T2:[\s\S]*?- \*\*Status:\*\* completed/)
    assert.match(sourcePlan, /#### T1:[\s\S]*?- \*\*Status:\*\* pending/)
    assert.match(sourcePlan, /#### T2:[\s\S]*?- \*\*Status:\*\* pending/)
    assert.equal(ctx.state.levelStates.get('execution')?.stageStatus, STAGE_LIFECYCLE_STATUS.COMPLETED)
    assert.deepEqual(ctx.state.levelStates.get('execution')?.engineState?.completedSprintIds, ['S1'])
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('bounded_parallel dispatches one ready wave up to the cap before dependent work', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-runtime-parallel-'))
  try {
    writePlan(dir, `
# Plan: Parallel research
**Status:** draft

### S1: Research

#### T1: Market evidence
- **Agent:** writer
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/T1/report.md

#### T2: Technical evidence
- **Agent:** writer
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/T2/report.md

#### T3: Synthesis
- **Agent:** editor
- **Status:** pending
- **Validate:** false
- **Depends on:** T1, T2
- **Gate:** false
- **Result file:** synthesis/report.md
`)

    let releaseWave!: () => void
    const waveBarrier = new Promise<void>((resolve) => { releaseWave = resolve })
    let waveStarts = 0
    let active = 0
    let maxActive = 0
    let resolveBothStarted!: () => void
    const bothStarted = new Promise<void>((resolve) => { resolveBothStarted = resolve })
    const onStart = () => {
      waveStarts += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      if (waveStarts === 2) resolveBothStarted()
    }
    const onComplete = () => { active -= 1 }
    queuedResults = [
      { text: 'Market complete', onStart, waitFor: waveBarrier, beforeReturn: onComplete },
      { text: 'Technical complete', onStart, waitFor: waveBarrier, beforeReturn: onComplete },
      { text: 'Synthesis complete' },
    ]

    const ctx = makeContext(dir, {
      executionMode: 'bounded_parallel',
      maxConcurrency: 2,
      assignmentScope: 'task',
    })
    const execution = createPipelineTool(ctx).execute(
      'parallel-wave',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    await bothStarted
    assert.equal(maxActive, 2)
    assert.equal(parsePlanStatus(runtimePlanPath(dir), 'T3'), 'pending')
    releaseWave()

    const result = await execution
    assert.match(readTextResult(result), /T3 dispatched to editor/)
    assert.equal(parsePlanStatus(runtimePlanPath(dir), 'T1'), 'completed')
    assert.equal(parsePlanStatus(runtimePlanPath(dir), 'T2'), 'completed')
    assert.equal(parsePlanStatus(runtimePlanPath(dir), 'T3'), 'completed')
    assert.equal(fs.existsSync(path.join(dir, 'research', 'T1')), true)
    assert.equal(fs.existsSync(path.join(dir, 'research', 'T2')), true)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('deep research commits only validated evidence to the declared result artifact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-research-evidence-'))
  try {
    writePlan(dir, `
# Plan: Research evidence
**Status:** draft

### S1: Research

#### T1: Task T1
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/tasks/T1/evidence.json
`)
    const binding = writeApprovedResearchPlan(dir, ['T1']).get('T1')!
    queuedResults = [{ text: researchEvidenceResult({ taskId: 'T1', ...binding }) }]

    const ctx = makeContext(dir, {
      assignmentScope: 'task',
      planArtifact: 'research/plan.json',
    })
    const result = await createPipelineTool(ctx).execute(
      'research-evidence',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )
    const artifactPath = path.join(dir, 'research', 'tasks', 'T1', 'evidence.json')
    const artifactText = fs.readFileSync(artifactPath, 'utf8')

    assert.match(readTextResult(result), /Evidence packet validated and saved/)
    assert.doesNotMatch(readTextResult(result), /Evidence answer T1/)
    assert.equal(parsePlanStatus(runtimePlanPath(dir), 'T1'), 'completed')
    assert.equal(artifactText.endsWith('\n'), true)
    assert.deepEqual(JSON.parse(artifactText), JSON.parse(researchEvidenceResult({ taskId: 'T1', ...binding })))
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('deep research resolves its generated plan from the run assignment rather than the shared team workspace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-research-owned-plan-'))
  const workspacePath = path.join(root, 'shared-workspace')
  const assignmentPath = path.join(root, 'run-assignment')
  try {
    fs.mkdirSync(workspacePath, { recursive: true })
    fs.mkdirSync(assignmentPath, { recursive: true })
    writePlan(assignmentPath, `
# Plan: Run-owned research evidence
**Status:** draft

### S1: Research

#### T1: Task T1
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/tasks/T1/evidence.json
`)
    const binding = writeApprovedResearchPlan(assignmentPath, ['T1']).get('T1')!
    queuedResults = [{ text: researchEvidenceResult({ taskId: 'T1', ...binding }) }]

    const result = await createPipelineTool(makeContext(assignmentPath, {
      assignmentScope: 'task',
      planArtifact: 'research/plan.json',
      workspacePath,
    })).execute(
      'run-owned-research-plan',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.match(readTextResult(result), /Evidence packet validated and saved/)
    assert.equal(
      parsePlanStatus(runtimePlanPath(assignmentPath), 'T1'),
      'completed',
    )
    assert.equal(
      fs.existsSync(path.join(workspacePath, '.pi-tasks', 'plan.md')),
      false,
    )
  } finally {
    queuedResults = []
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('deep research persists one attributed worker summary per lane, accepted or rejected', async () => {
  const validDispatch = async (taskId: string, dir: string) => {
    const binding = writeApprovedResearchPlan(dir, [taskId]).get(taskId)!
    queuedResults = [{ text: researchEvidenceResult({ taskId, ...binding }) }]
    await createPipelineTool(makeContext(dir, {
      assignmentScope: 'task',
      planArtifact: 'research/plan.json',
    })).execute(
      `summary-${taskId}`,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )
  }

  const acceptedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-summary-accepted-'))
  try {
    writePlan(acceptedDir, `
# Plan: Accepted research summary
**Status:** draft

### S1: Research

#### T1: Task T1
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/evidence/wave-0/T1.json
`)
    await validDispatch('T1', acceptedDir)

    const acceptedSummaryPath = path.join(
      acceptedDir,
      'research',
      'evidence',
      'wave-0',
      'T1--lane-1.md',
    )
    const acceptedSummary = fs.readFileSync(acceptedSummaryPath, 'utf8')
    assert.match(acceptedSummary, /# T1 — Evidence Analyst 1 \(web-researcher · lane lane-1\)/)
    assert.match(acceptedSummary, /status: "completed"/)
    assert.match(acceptedSummary, /## Findings/)
  } finally {
    queuedResults = []
    fs.rmSync(acceptedDir, { recursive: true, force: true })
  }

  const rejectedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-summary-rejected-'))
  try {
    writePlan(rejectedDir, `
# Plan: Rejected research summary
**Status:** draft

### S1: Research

#### T1: Task T1
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/evidence/wave-0/T1.json
`)
    const binding = writeApprovedResearchPlan(rejectedDir, ['T1']).get('T1')!
    const valid = researchEvidenceResult({ taskId: 'T1', ...binding })
    queuedResults = [
      { text: JSON.stringify({ ...JSON.parse(valid), assignmentId: 'other-lane' }) },
      { text: JSON.stringify({ ...JSON.parse(valid), assignmentId: 'other-lane' }) },
    ]
    await createPipelineTool(makeContext(rejectedDir, {
      assignmentScope: 'task',
      planArtifact: 'research/plan.json',
    })).execute(
      'summary-rejected',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    const rejectedSummaryPath = path.join(
      rejectedDir,
      'research',
      'evidence',
      'wave-0',
      'T1--lane-1.md',
    )
    const rejectedSummary = fs.readFileSync(rejectedSummaryPath, 'utf8')
    assert.match(rejectedSummary, /status: "rejected"/)
    assert.match(rejectedSummary, /rejected after 2 attempts/)
    assert.match(rejectedSummary, /other-lane|assignment/)
    // The private attempt records back the public rejected summary.
    const outcome = JSON.parse(fs.readFileSync(
      path.join(rejectedDir, '.runtime', 'worker-logs', 'lane-1', 'T1-attempt-2', 'outcome.json'),
      'utf8',
    )) as Record<string, unknown>
    assert.equal(outcome.outcome, 'rejected')
    const validationLog = fs.readFileSync(
      path.join(rejectedDir, '.runtime', 'worker-logs', 'lane-1', 'validation.jsonl'),
      'utf8',
    )
    assert.match(validationLog, /"attempt_dir":"T1-attempt-1"/)
    assert.match(validationLog, /"attempt_dir":"T1-attempt-2"/)
  } finally {
    queuedResults = []
    fs.rmSync(rejectedDir, { recursive: true, force: true })
  }
})

test('a failed lane summary never fails a task whose evidence is already persisted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-summary-guard-'))
  try {
    writePlan(dir, `
# Plan: Summary write guard
**Status:** draft

### S1: Research

#### T1: Task T1
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/evidence/wave-0/T1.json
`)
    const binding = writeApprovedResearchPlan(dir, ['T1']).get('T1')!
    queuedResults = [{ text: researchEvidenceResult({ taskId: 'T1', ...binding }) }]
    // Occupy the summary path with a directory so writing it must fail.
    fs.mkdirSync(
      path.join(dir, 'research', 'evidence', 'wave-0', 'T1--lane-1.md'),
      { recursive: true },
    )

    const result = await createPipelineTool(makeContext(dir, {
      assignmentScope: 'task',
      planArtifact: 'research/plan.json',
    })).execute(
      'summary-guard',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    const text = (result.content[0] as { text: string }).text
    assert.match(text, /Evidence packet validated and saved/)
    assert.doesNotMatch(text, /failed/)
    assert.equal(parsePlanStatus(runtimePlanPath(dir), 'T1'), 'completed')
    assert.ok(fs.existsSync(path.join(dir, 'research', 'evidence', 'wave-0', 'T1.json')))
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('deep research rejects mismatched or non-JSON evidence without committing an artifact', async () => {
  for (const [name, category, mutate] of [
    ['wrong assignment', 'binding_invalid', (text: string) => JSON.stringify({ ...JSON.parse(text), assignmentId: 'other-lane' })],
    ['markdown fence', 'response_schema_invalid', (text: string) => `\`\`\`json\n${text}\n\`\`\``],
  ] as const) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-research-invalid-'))
    try {
      writePlan(dir, `
# Plan: Invalid research evidence
**Status:** draft

### S1: Research

#### T1: Task T1
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/tasks/T1/evidence.json
`)
      const binding = writeApprovedResearchPlan(dir, ['T1']).get('T1')!
      queuedResults = [{
        text: mutate(researchEvidenceResult({ taskId: 'T1', ...binding })),
      }]

      const result = await createPipelineTool(makeContext(dir, {
        assignmentScope: 'task',
        planArtifact: 'research/plan.json',
      })).execute(
        `invalid-${name}`,
        undefined as any,
        undefined as any,
        undefined as any,
        undefined as any,
      )

      assert.match(readTextResult(result), /\*\*T1 HALTED:\*\* Deep Research worker/)
      assert.equal(parsePlanStatus(runtimePlanPath(dir), 'T1'), 'failed')
      assert.equal(fs.existsSync(path.join(dir, 'research', 'tasks', 'T1', 'evidence.json')), false)
      const validationLog = fs.readFileSync(
        path.join(dir, '.runtime', 'worker-logs', 'lane-1', 'validation.jsonl'),
        'utf8',
      )
      assert.match(validationLog, new RegExp(`"category":"${category}"`))
      assert.doesNotMatch(validationLog, /other-lane|```json/)
      assert.match(
        fs.readFileSync(path.join(dir, 'research', 'quality', 'escalation.md'), 'utf8'),
        /status: "blocked"[\s\S]*?`T1` \(failed\)/,
      )
      assert.match(
        fs.readFileSync(path.join(dir, 'research-package.md'), 'utf8'),
        /status: "blocked"[\s\S]*?No verified research report can be published/,
      )
    } finally {
      queuedResults = []
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('deep research retries an invalid EvidencePacket and commits only the repaired packet', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-research-repair-'))
  try {
    writePlan(dir, `
# Plan: Repaired research evidence
**Status:** draft

### S1: Research

#### T1: Task T1
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/tasks/T1/evidence.json
`)
    const binding = writeApprovedResearchPlan(dir, ['T1']).get('T1')!
    const valid = researchEvidenceResult({ taskId: 'T1', ...binding })
    queuedResults = [
      { text: `\`\`\`json\n${valid}\n\`\`\`` },
      { text: valid },
    ]
    const callsBefore = dispatchCalls

    const result = await createPipelineTool(makeContext(dir, {
      assignmentScope: 'task',
      planArtifact: 'research/plan.json',
    })).execute(
      'repair-invalid-evidence',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.match(readTextResult(result), /Evidence packet validated and saved/)
    assert.equal(dispatchCalls - callsBefore, 2)
    assert.equal(parsePlanStatus(runtimePlanPath(dir), 'T1'), 'completed')
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(dir, 'research/tasks/T1/evidence.json'), 'utf8')),
      JSON.parse(valid),
    )
    const validationLog = fs.readFileSync(
      path.join(dir, '.runtime', 'worker-logs', 'lane-1', 'validation.jsonl'),
      'utf8',
    )
    assert.match(validationLog, /"category":"response_schema_invalid"/)
    assert.doesNotMatch(validationLog, /```json/)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('parallel research tasks commit distinct validated evidence packets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-research-parallel-'))
  try {
    writePlan(dir, `
# Plan: Parallel evidence
**Status:** draft

### S1: Research

#### T1: Task T1
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/tasks/T1/evidence.json

#### T2: Task T2
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/tasks/T2/evidence.json
`)
    const bindings = writeApprovedResearchPlan(dir, ['T1', 'T2'])
    queuedResults = ['T1', 'T2'].map((taskId) => ({
      text: researchEvidenceResult({ taskId, ...bindings.get(taskId)! }),
    }))

    await createPipelineTool(makeContext(dir, {
      executionMode: 'bounded_parallel',
      maxConcurrency: 2,
      assignmentScope: 'task',
      planArtifact: 'research/plan.json',
    })).execute(
      'parallel-research',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    for (const taskId of ['T1', 'T2']) {
      const packet = JSON.parse(fs.readFileSync(
        path.join(dir, 'research', 'tasks', taskId, 'evidence.json'),
        'utf8',
      ))
      assert.equal(packet.taskId, taskId)
      assert.equal(packet.assignmentId, bindings.get(taskId)!.assignmentId)
      assert.equal(parsePlanStatus(runtimePlanPath(dir), taskId), 'completed')
    }
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('deep research fan-in dispatches after three verbose dependency packets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-research-fan-in-'))
  try {
    writePlan(dir, `
# Plan: Fan-in evidence
**Status:** draft

### S1: Research

#### T1: Evidence one
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/tasks/T1/evidence.json

#### T2: Evidence two
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/tasks/T2/evidence.json

#### T3: Evidence three
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/tasks/T3/evidence.json

#### T4: Synthesize evidence
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** T1, T2, T3
- **Gate:** false
- **Result file:** research/tasks/T4/evidence.json
`)
    const bindings = writeApprovedResearchPlan(
      dir,
      ['T1', 'T2', 'T3', 'T4'],
      4,
      { T4: ['T1', 'T2', 'T3'] },
    )
    queuedResults = ['T1', 'T2', 'T3'].map((taskId) => {
      const packet = JSON.parse(researchEvidenceResult({ taskId, ...bindings.get(taskId)! }))
      return {
        text: JSON.stringify({
          ...packet,
          shortAnswer: `${taskId} ${'verbose dependency evidence '.repeat(100)}`,
          unresolvedQuestions: [`${taskId} ${'unresolved detail '.repeat(80)}`],
          stopReason: 'insufficient_evidence',
        }),
      }
    })
    queuedResults.push({
      text: researchEvidenceResult({ taskId: 'T4', ...bindings.get('T4')! }),
    })
    const callsBefore = dispatchCalls

    const result = await createPipelineTool(makeContext(dir, {
      executionMode: 'bounded_parallel',
      maxConcurrency: 4,
      assignmentScope: 'task',
      planArtifact: 'research/plan.json',
    })).execute(
      'fan-in-research',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.equal(dispatchCalls - callsBefore, 4)
    assert.equal(parsePlanStatus(runtimePlanPath(dir), 'T4'), 'completed')
    assert.match(readTextResult(result), /Pipeline complete/)
    assert.doesNotMatch(readTextResult(result), /dependencyDigest|blocked/)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('deep research persists a terminal blocker when a task overlay is unauthorized', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-research-overlay-block-'))
  try {
    writePlan(dir, `
# Plan: Unauthorized research overlay
**Status:** draft

### S1: Research

#### T1: Evidence one
- **Agent:** writer
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/tasks/T1/evidence.json
`)
    writeApprovedResearchPlan(dir, ['T1'])
    const callsBefore = dispatchCalls
    const ctx = makeContext(dir, {
      executionMode: 'bounded_parallel',
      assignmentScope: 'task',
      planArtifact: 'research/plan.json',
    })

    const result = await createPipelineTool(ctx).execute(
      'unauthorized-research-overlay',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.equal(dispatchCalls - callsBefore, 0)
    assert.equal(parsePlanStatus(runtimePlanPath(dir), 'T1'), 'blocked')
    assert.match(readTextResult(result), /T1 blocked:.*must dispatch through 'web-researcher'/)
    assert.match(
      fs.readFileSync(path.join(dir, 'research-package.md'), 'utf8'),
      /status: "blocked"[\s\S]*?`T1` \(blocked\)/,
    )
    assert.equal(
      ctx.state.levelStates.get('execution')?.stageStatus,
      STAGE_LIFECYCLE_STATUS.FAILED,
    )
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('deep research persists the exact finalization failure in its blocked output artifact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-research-finalization-block-'))
  try {
    writePlan(dir, `
# Plan: Completed evidence collection
**Status:** completed

### S1: Research

#### T1: Evidence one
- **Agent:** web-researcher
- **Status:** completed
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/evidence/wave-0/T1.json
`)
    const bindings = writeApprovedResearchPlan(dir, ['T1'])
    const binding = bindings.get('T1')
    assert.ok(binding)
    const packet = JSON.parse(researchEvidenceResult({ taskId: 'T1', ...binding })) as Record<string, unknown>
    packet.findings = [{
      schemaVersion: 1,
      claimId: 'claim-one',
      taskId: 'T1',
      sectionId: 'coverage-requirement-id',
      statement: 'The remaining evidence gap is explicit.',
      kind: 'uncertainty',
      evidenceStandard: 'single',
      sourceIds: [],
      evidenceLinks: [],
      confidence: 'low',
      status: 'unsupported',
      applicableScope: [],
    }]
    const evidencePath = path.join(dir, 'research', 'evidence', 'wave-0', 'T1.json')
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true })
    fs.writeFileSync(evidencePath, JSON.stringify(packet))
    const ctx = makeContext(dir, { planArtifact: 'research/plan.json' })

    const result = await createPipelineTool(ctx).execute(
      'finalization-block',
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    )

    assert.equal(
      ctx.state.levelStates.get('execution')?.stageStatus,
      STAGE_LIFECYCLE_STATUS.BLOCKED,
    )
    assert.match(
      readTextResult(result),
      /Research evidence finalization blocked: Research synthesis packet references unknown plan work/,
    )
    const blockedArtifact = fs.readFileSync(path.join(dir, 'research-package.md'), 'utf8')
    assert.match(blockedArtifact, /status: "blocked"/)
    assert.match(
      blockedArtifact,
      /Research synthesis packet references unknown plan work/,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a correction wave keeps the verified report published by the wave before it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-research-report-survival-'))
  try {
    writePlan(dir, `
# Plan: Corrected evidence collection
**Status:** completed

### S1: Research

#### T1: Evidence one
- **Agent:** web-researcher
- **Status:** completed
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/evidence/wave-1/T1.json
`)
    const binding = writeApprovedResearchPlan(dir, ['T1']).get('T1')
    assert.ok(binding)
    const evidencePath = path.join(dir, 'research', 'evidence', 'wave-1', 'T1.json')
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true })
    fs.writeFileSync(evidencePath, unknownSectionEvidenceResult({ taskId: 'T1', ...binding }))
    const correctionPath = path.join(dir, 'research', 'corrections', 'current.json')
    fs.mkdirSync(path.dirname(correctionPath), { recursive: true })
    fs.writeFileSync(correctionPath, JSON.stringify({ schemaVersion: 1, wave: 1 }))
    const verifiedReport = [
      '# Research Report',
      '',
      '**Status:** completed',
      '',
      'The first wave verified and published this report.',
      '',
    ].join('\n')
    fs.writeFileSync(path.join(dir, 'research-package.md'), verifiedReport)
    const ctx = makeContext(dir, { planArtifact: 'research/plan.json' })

    const result = await createPipelineTool(ctx).execute(
      'finalization-block-after-correction',
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    )

    assert.match(
      readTextResult(result),
      /Research evidence finalization blocked: Research synthesis packet references unknown plan work/,
    )
    assert.equal(
      fs.readFileSync(path.join(dir, 'research-package.md'), 'utf8'),
      verifiedReport,
    )
    assert.deepEqual(
      filesContainingText(dir, 'No verified research report was published.'),
      [],
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a terminal blocker archives the report under the wave that published it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-terminal-report-archive-'))
  try {
    const priorReport = writeFailedCorrectionWave(dir, 1)

    const text = await runFailedCorrectionLane(dir)

    assert.match(
      fs.readFileSync(path.join(dir, 'research-package.md'), 'utf8'),
      /No verified research report can be published/,
    )
    // Wave 1 is running, so the report it publishes over is wave 0's, and
    // `report-wave-0.md` is the slot the correction gate and engines/chain.ts
    // both put it in. `report-wave-1.md` belongs to the report wave 1 would
    // have published had it finished.
    assert.equal(
      fs.readFileSync(path.join(dir, 'research', 'reports', 'report-wave-0.md'), 'utf8'),
      priorReport,
    )
    assert.equal(
      fs.existsSync(path.join(dir, 'research', 'reports', 'report-wave-1.md')),
      false,
    )
    assert.doesNotMatch(text, /blocker persistence failed/)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a second correction wave archives the report the first one published', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-terminal-report-archive-two-'))
  try {
    // The same shape one wave later. The slot has to move with it: a label
    // fixed at 0 would overwrite the archive wave 1 was preserved under.
    const priorReport = writeFailedCorrectionWave(dir, 2)

    await runFailedCorrectionLane(dir)

    assert.equal(
      fs.readFileSync(path.join(dir, 'research', 'reports', 'report-wave-1.md'), 'utf8'),
      priorReport,
    )
    assert.equal(
      fs.existsSync(path.join(dir, 'research', 'reports', 'report-wave-2.md')),
      false,
    )
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a terminal blocker leaves the archive the correction gate already wrote', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-terminal-report-archived-'))
  try {
    writeFailedCorrectionWave(dir, 1)
    // `prepare-correction-wave.mjs` archives the report before the wave starts
    // and writes that slot immutably: it hard-fails the next correction gate if
    // the bytes ever change. Whatever it left there is the copy that stands.
    const gateArchive = 'The correction gate archived the wave 0 report here.\n'
    const archivePath = path.join(dir, 'research', 'reports', 'report-wave-0.md')
    fs.mkdirSync(path.dirname(archivePath), { recursive: true })
    fs.writeFileSync(archivePath, gateArchive)

    await runFailedCorrectionLane(dir)

    assert.equal(fs.readFileSync(archivePath, 'utf8'), gateArchive)
    assert.equal(
      fs.existsSync(path.join(dir, 'research', 'reports', 'report-wave-1.md')),
      false,
    )
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a terminal blocker publishes its escalation when the report cannot be archived', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-terminal-archive-refused-'))
  try {
    const priorReport = writeFailedCorrectionWave(dir, 1)
    // A regular file where the archive directory belongs: resolving the
    // archive path refuses a non-directory parent component, so preserving the
    // report throws. The blocker the operator is owed must still be published,
    // and the report it could not archive must still be there.
    fs.writeFileSync(path.join(dir, 'research', 'reports'), 'not a directory')

    const text = await runFailedCorrectionLane(dir)

    assert.match(
      fs.readFileSync(path.join(dir, 'research', 'quality', 'escalation.md'), 'utf8'),
      /No verified research report can be published/,
    )
    assert.equal(
      fs.readFileSync(path.join(dir, 'research-package.md'), 'utf8'),
      priorReport,
    )
    assert.match(
      text,
      /Deep Research blocker persistence failed: .*non-directory parent component/,
    )
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty research package never suppresses the finalization blocker', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-empty-report-'))
  try {
    writePlan(dir, `
# Plan: Empty published package
**Status:** completed

### S1: Research

#### T1: Evidence one
- **Agent:** web-researcher
- **Status:** completed
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/evidence/wave-0/T1.json
`)
    const binding = writeApprovedResearchPlan(dir, ['T1']).get('T1')
    assert.ok(binding)
    const evidencePath = path.join(dir, 'research', 'evidence', 'wave-0', 'T1.json')
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true })
    fs.writeFileSync(evidencePath, unknownSectionEvidenceResult({ taskId: 'T1', ...binding }))
    fs.writeFileSync(path.join(dir, 'research-package.md'), '')
    const ctx = makeContext(dir, { planArtifact: 'research/plan.json' })

    await createPipelineTool(ctx).execute(
      'finalization-block-over-empty-package',
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    )

    assert.match(
      fs.readFileSync(path.join(dir, 'research-package.md'), 'utf8'),
      /No verified research report was published\./,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a finalization blocker that cannot persist is reported as its own response', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-research-blocker-report-'))
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-external-report-'))
  try {
    writePlan(dir, `
# Plan: Reported finalization failure
**Status:** draft

### S1: Research

#### T1: Evidence one
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/tasks/T1/evidence.json

#### T2: Evidence two
- **Agent:** web-researcher
- **Status:** completed
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/evidence/wave-0/T2.json
`)
    const bindings = writeApprovedResearchPlan(dir, ['T1', 'T2'])
    const firstBinding = bindings.get('T1')
    const secondBinding = bindings.get('T2')
    assert.ok(firstBinding)
    assert.ok(secondBinding)
    const evidencePath = path.join(dir, 'research', 'evidence', 'wave-0', 'T2.json')
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true })
    fs.writeFileSync(evidencePath, unknownSectionEvidenceResult({ taskId: 'T2', ...secondBinding }))
    const externalReportPath = path.join(externalDir, 'report.md')
    fs.writeFileSync(externalReportPath, 'external data')
    fs.symlinkSync(externalReportPath, path.join(dir, 'research-package.md'))
    queuedResults = [{ text: researchEvidenceResult({ taskId: 'T1', ...firstBinding }) }]
    const ctx = makeContext(dir, {
      assignmentScope: 'task',
      planArtifact: 'research/plan.json',
    })

    const result = await createPipelineTool(ctx).execute(
      'finalization-block-with-persistence-failure',
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    )

    assertFinalizationFailureReportedInPairs(
      readTextResult(result),
      'Research synthesis packet references unknown plan work.',
    )
    assert.equal(fs.readFileSync(externalReportPath, 'utf8'), 'external data')
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(externalDir, { recursive: true, force: true })
  }
})

// The drain finalizes a plan whose tasks are already terminal without
// dispatching anything, which is the one arrangement that reaches its
// finalization report on its own. Leave a task pending and the dispatch it
// drains finalizes first, through the single-task path, and reports the same
// pair before the drain does.
test('a bounded-parallel drain reports a finalization blocker it cannot persist as its own response', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-parallel-blocker-report-'))
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-external-parallel-report-'))
  try {
    writePlan(dir, `
# Plan: Reported parallel finalization failure
**Status:** completed

### S1: Research

#### T1: Evidence one
- **Agent:** web-researcher
- **Status:** completed
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/evidence/wave-0/T1.json
`)
    const binding = writeApprovedResearchPlan(dir, ['T1']).get('T1')
    assert.ok(binding)
    const evidencePath = path.join(dir, 'research', 'evidence', 'wave-0', 'T1.json')
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true })
    fs.writeFileSync(evidencePath, unknownSectionEvidenceResult({ taskId: 'T1', ...binding }))
    const externalReportPath = path.join(externalDir, 'report.md')
    fs.writeFileSync(externalReportPath, 'external data')
    fs.symlinkSync(externalReportPath, path.join(dir, 'research-package.md'))
    const ctx = makeContext(dir, {
      executionMode: 'bounded_parallel',
      planArtifact: 'research/plan.json',
    })

    const result = await createPipelineTool(ctx).execute(
      'parallel-finalization-block-with-persistence-failure',
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    )

    assertFinalizationFailureReportedInPairs(
      readTextResult(result),
      'Research synthesis packet references unknown plan work.',
    )
    assert.equal(fs.readFileSync(externalReportPath, 'utf8'), 'external data')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(externalDir, { recursive: true, force: true })
  }
})

test('deep research refuses dispatch when the remainder cannot cover the shutdown reserve', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-reserve-'))
  try {
    writePlan(dir, `
# Plan: Reserve-bound research
**Status:** draft

### S1: Research

#### T1: Evidence one
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/tasks/T1/evidence.json
`)
    writeApprovedResearchPlan(dir, ['T1'])
    // The plan interval must match maxDurationMinutes exactly, so anchor the
    // window in the past: only 10s of the 20-minute budget remains, which is
    // below the 30s shutdown reserve.
    const deadlineAt = new Date(Date.now() + 10_000)
    fs.mkdirSync(path.join(dir, 'research'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'research', 'runtime-limits.json'),
      JSON.stringify({
        schemaVersion: 1,
        planId: 'plan-one',
        maxDurationMinutes: 20,
        startedAt: new Date(deadlineAt.getTime() - 20 * 60_000).toISOString(),
        deadlineAt: deadlineAt.toISOString(),
      }),
    )

    const ctx = makeContext(dir, {
      executionMode: 'serial',
      assignmentScope: 'task',
      planArtifact: 'research/plan.json',
      deadlineArtifact: 'research/runtime-limits.json',
    })
    const result = await createPipelineTool(ctx).execute(
      'reserve-refusal',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.equal(parsePlanStatus(runtimePlanPath(dir), 'T1'), 'failed')
    const text = readTextResult(result)
    assert.match(
      text,
      /Insufficient remaining execution budget/,
      'the reserve refusal is reported rather than starting doomed work',
    )
    assert.match(text, /30s shutdown reserve/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('deep research fails a completed lane when search capability was absent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-search-capability-'))
  const assignmentPath = path.join(
    root,
    'sessions',
    'pipeline-session',
    'runs',
    'run-capability',
    'assignments',
    'assignment-capability',
  )
  try {
    fs.mkdirSync(assignmentPath, { recursive: true })
    writePlan(assignmentPath, `
# Plan: Capability-blocked research
**Status:** draft

### S1: Research

#### T1: Evidence one
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/tasks/T1/evidence.json
`)
    const bindings = writeApprovedResearchPlan(assignmentPath, ['T1'])
    fs.mkdirSync(path.join(root, 'sessions', 'pipeline-session'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(root, 'sessions', 'pipeline-session', 'research-acquisition.json'),
      JSON.stringify([{
        activityId: 'activity-0',
        sessionId: 'pipeline-session',
        runId: 'run-capability',
        assignmentId: 'assignment-capability',
        activityScopeId: 'lane-1',
        agentPath: 'agents/web-researcher',
        toolCallId: 'call-0',
        action: 'search',
        state: 'failed',
        createdAt: '2026-08-18T17:44:42.000Z',
        updatedAt: '2026-08-18T17:44:43.000Z',
        attempts: [],
        error: {
          code: 'not_configured',
          message: 'No enabled research search provider has an API key.',
        },
        searchProviderPriority: ['exa', 'brave'],
      }]),
    )
    queuedResults = [{
      text: researchEvidenceResult({ taskId: 'T1', ...bindings.get('T1')! }),
    }]

    const ctx = makeContext(assignmentPath, {
      executionMode: 'serial',
      assignmentScope: 'task',
      planArtifact: 'research/plan.json',
      workspacePath: root,
    })
    const result = await createPipelineTool(ctx).execute(
      'search-capability-block',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.equal(parsePlanStatus(runtimePlanPath(assignmentPath), 'T1'), 'failed')
    assert.match(
      readTextResult(result),
      /search capability/i,
      'the run-level capability blocker is reported, not a per-source failure',
    )
    assert.match(
      fs.readFileSync(path.join(assignmentPath, 'research-package.md'), 'utf8'),
      /Search Capability Absent[\s\S]*exa, brave/,
    )
    const engineEvents = fs.readFileSync(
      path.join(assignmentPath, 'logs', 'engine-events.jsonl'),
      'utf8',
    )
    assert.match(engineEvents, /research\.search_capability\.blocked/)
    const blockedEvent = engineEvents
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type?: string; payload?: Record<string, unknown> })
      .find((event) => event.type === 'research.search_capability.blocked')
    assert.deepEqual(
      blockedEvent?.payload?.failure_codes,
      ['not_configured'],
      'the operator-facing event names the cause the journal recorded',
    )
    assert.equal(
      ctx.state.levelStates.get('execution')?.stageStatus,
      STAGE_LIFECYCLE_STATUS.FAILED,
    )
  } finally {
    queuedResults = []
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a run blocked by a runtime fault is never published as a missing key', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-internal-capability-'))
  const assignmentPath = path.join(
    root,
    'sessions',
    'pipeline-session',
    'runs',
    'run-capability',
    'assignments',
    'assignment-capability',
  )
  try {
    fs.mkdirSync(assignmentPath, { recursive: true })
    writePlan(assignmentPath, `
# Plan: Capability-blocked research
**Status:** draft

### S1: Research

#### T1: Evidence one
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/tasks/T1/evidence.json
`)
    const bindings = writeApprovedResearchPlan(assignmentPath, ['T1'])
    fs.mkdirSync(path.join(root, 'sessions', 'pipeline-session'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(root, 'sessions', 'pipeline-session', 'research-acquisition.json'),
      JSON.stringify([{
        activityId: 'activity-0',
        sessionId: 'pipeline-session',
        runId: 'run-capability',
        assignmentId: 'assignment-capability',
        activityScopeId: 'lane-1',
        agentPath: 'agents/web-researcher',
        toolCallId: 'call-0',
        action: 'search',
        state: 'failed',
        createdAt: '2026-08-18T17:44:42.000Z',
        updatedAt: '2026-08-18T17:44:43.000Z',
        attempts: [],
        error: { code: 'internal', message: 'Acquisition settings file is invalid.' },
      }]),
    )
    const binding = bindings.get('T1')
    assert.ok(binding)
    queuedResults = [{
      text: researchEvidenceResult({ taskId: 'T1', ...binding }),
    }]

    const ctx = makeContext(assignmentPath, {
      executionMode: 'serial',
      assignmentScope: 'task',
      planArtifact: 'research/plan.json',
      workspacePath: root,
    })
    const result = await createPipelineTool(ctx).execute(
      'internal-capability-block',
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    )

    const text = readTextResult(result)
    assert.doesNotMatch(
      text,
      /not_configured/,
      'the journal recorded `internal`, and nothing may rename it',
    )
    const blockedEvent = fs
      .readFileSync(path.join(assignmentPath, 'logs', 'engine-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type?: string; payload?: Record<string, unknown> })
      .find((event) => event.type === 'research.search_capability.blocked')
    assert.deepEqual(blockedEvent?.payload?.failure_codes, ['internal'])
    assert.doesNotMatch(
      String(blockedEvent?.payload?.remediation),
      /Exa or Brave Search API key/i,
    )
  } finally {
    queuedResults = []
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a pipeline stage with only a deadline artifact is still clamped and reported', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-deadline-only-'))
  try {
    writePlan(dir, `
# Plan: Section drafting
**Status:** draft

### S1: Draft

#### T1: Draft one
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/sections/T1.md
`)
    // No plan_artifact: this is the shape of `draft-sections`, which consumes
    // the same run budget as the research it follows but declares no plan
    // overlay, so it received no clamp, no reserve and no diagnostic.
    writeApprovedResearchPlan(dir, ['T1'])
    fs.copyFileSync(
      path.join(dir, 'research', 'plan.json'),
      path.join(dir, 'research', 'approved-plan.json'),
    )
    const startedAt = new Date()
    fs.writeFileSync(
      path.join(dir, 'research', 'runtime-limits.json'),
      JSON.stringify({
        schemaVersion: 1,
        planId: 'plan-one',
        maxDurationMinutes: 20,
        startedAt: startedAt.toISOString(),
        deadlineAt: new Date(startedAt.getTime() + 20 * 60_000).toISOString(),
      }),
    )
    queuedResults = [{ text: 'Drafted section body.' }]

    const ctx = makeContext(dir, {
      executionMode: 'bounded_parallel',
      assignmentScope: 'stage',
      deadlineArtifact: 'research/runtime-limits.json',
    })
    ctx.config.config.constraints = { agent_timeout_minutes: 20 }
    const result = await createPipelineTool(ctx).execute(
      'deadline-only-clamp',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.match(
      readTextResult(result),
      /Level timeout clamped/,
      'a stage declaring a timeout at the plan budget is diagnosed, not silent',
    )
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a deadline-only pipeline stage refuses dispatch once the budget is spent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-deadline-only-spent-'))
  try {
    writePlan(dir, `
# Plan: Section drafting
**Status:** draft

### S1: Draft

#### T1: Draft one
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/sections/T1.md
`)
    writeApprovedResearchPlan(dir, ['T1'])
    fs.copyFileSync(
      path.join(dir, 'research', 'plan.json'),
      path.join(dir, 'research', 'approved-plan.json'),
    )
    const deadlineAt = new Date(Date.now() + 10_000)
    fs.writeFileSync(
      path.join(dir, 'research', 'runtime-limits.json'),
      JSON.stringify({
        schemaVersion: 1,
        planId: 'plan-one',
        maxDurationMinutes: 20,
        startedAt: new Date(deadlineAt.getTime() - 20 * 60_000).toISOString(),
        deadlineAt: deadlineAt.toISOString(),
      }),
    )
    queuedResults = [{ text: 'Drafted section body.' }]

    const ctx = makeContext(dir, {
      executionMode: 'bounded_parallel',
      assignmentScope: 'stage',
      deadlineArtifact: 'research/runtime-limits.json',
    })
    ctx.config.config.constraints = { agent_timeout_minutes: 8 }
    const result = await createPipelineTool(ctx).execute(
      'deadline-only-refusal',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.equal(parsePlanStatus(runtimePlanPath(dir), 'T1'), 'failed')
    assert.match(readTextResult(result), /Insufficient remaining execution budget/)
    assert.match(readTextResult(result), /30s shutdown reserve/)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a clamp notice seeded at admission survives a later terminal failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-clamp-notice-'))
  try {
    writePlan(dir, `
# Plan: Clamped research
**Status:** draft

### S1: Research

#### T1: Evidence one
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/tasks/T1/evidence.json
`)
    const bindings = writeApprovedResearchPlan(dir, ['T1'])
    // The plan becomes unreadable after admission, so the drain's next read
    // fails on the one path that used to return without the clamp notice.
    queuedResults = [{
      text: researchEvidenceResult({ taskId: 'T1', ...bindings.get('T1')! }),
      beforeReturn: () => fs.rmSync(runtimePlanPath(dir), { force: true }),
    }]

    const ctx = makeContext(dir, {
      executionMode: 'bounded_parallel',
      assignmentScope: 'task',
      planArtifact: 'research/plan.json',
    })
    ctx.config.config.constraints = { agent_timeout_minutes: 20 }
    const result = await createPipelineTool(ctx).execute(
      'clamp-notice-survives',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    const text = readTextResult(result)
    assert.match(text, /Pipeline halted/, 'the run ended terminally')
    assert.match(
      text,
      /Level timeout clamped/,
      'a diagnostic already produced is not discarded by a later failure — ' +
        'the terminal path is where the operator most needs the whole picture',
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a deadline-only stage without a budget artifact runs unclamped and says so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-missing-deadline-'))
  try {
    writePlan(dir, `
# Plan: Section drafting
**Status:** draft

### S1: Draft

#### T1: Draft one
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/sections/T1.md
`)
    queuedResults = [{ text: 'Drafted section body.' }]

    const ctx = makeContext(dir, {
      executionMode: 'bounded_parallel',
      assignmentScope: 'stage',
      deadlineArtifact: 'research/runtime-limits.json',
    })
    const result = await createPipelineTool(ctx).execute(
      'missing-deadline',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    // A budget artifact is a budget, not a contract: failing a whole drafting
    // stage because one is absent is harsher than the rule it enforces.
    assert.equal(parsePlanStatus(runtimePlanPath(dir), 'T1'), 'completed')
    assert.match(readTextResult(result), /budget unavailable/i)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a lane skipped by failure policy still publishes the search capability blocker', async () => {
  const fixture = makeCapabilityFixture('pipeline-capability-skip-')
  try {
    queuedResults = [{
      text: researchEvidenceResult({ taskId: 'T1', ...fixture.bindings.get('T1')! }),
      skipped: true,
    }]
    const result = await createPipelineTool(fixture.ctx).execute(
      'capability-skip',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.match(
      fs.readFileSync(
        path.join(fixture.assignmentPath, 'logs', 'engine-events.jsonl'),
        'utf8',
      ),
      /research\.search_capability\.blocked/,
      'a skipped lane hides the same capability absence as a completed one',
    )
    assert.match(readTextResult(result), /discovery path|search capability/i)
  } finally {
    queuedResults = []
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('a halted lane still publishes the search capability blocker', async () => {
  const fixture = makeCapabilityFixture('pipeline-capability-halt-')
  try {
    queuedResults = [new MockHaltError('web-researcher', 'provider terminated')]
    const result = await createPipelineTool(fixture.ctx).execute(
      'capability-halt',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.match(
      fs.readFileSync(
        path.join(fixture.assignmentPath, 'logs', 'engine-events.jsonl'),
        'utf8',
      ),
      /research\.search_capability\.blocked/,
      'a halt must not swallow the reason the lane had nothing to work with',
    )
    assert.match(readTextResult(result), /discovery path|search capability/i)
  } finally {
    queuedResults = []
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

function makeCapabilityFixture(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const assignmentPath = path.join(
    root,
    'sessions',
    'pipeline-session',
    'runs',
    'run-capability',
    'assignments',
    'assignment-capability',
  )
  fs.mkdirSync(assignmentPath, { recursive: true })
  writePlan(assignmentPath, `
# Plan: Capability-blocked research
**Status:** draft

### S1: Research

#### T1: Evidence one
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/tasks/T1/evidence.json
`)
  const bindings = writeApprovedResearchPlan(assignmentPath, ['T1'])
  fs.mkdirSync(path.join(root, 'sessions', 'pipeline-session'), {
    recursive: true,
  })
  fs.writeFileSync(
    path.join(root, 'sessions', 'pipeline-session', 'research-acquisition.json'),
    JSON.stringify([{
      activityId: 'activity-0',
      sessionId: 'pipeline-session',
      runId: 'run-capability',
      assignmentId: 'assignment-capability',
      activityScopeId: 'lane-1',
      agentPath: 'agents/web-researcher',
      toolCallId: 'call-0',
      action: 'search',
      state: 'failed',
      createdAt: '2026-08-18T17:44:42.000Z',
      updatedAt: '2026-08-18T17:44:43.000Z',
      attempts: [],
      error: {
        code: 'not_configured',
        message: 'No research discovery path is available.',
      },
      searchProviderPriority: ['exa', 'brave'],
    }]),
  )
  const ctx = makeContext(assignmentPath, {
    executionMode: 'serial',
    assignmentScope: 'task',
    planArtifact: 'research/plan.json',
    workspacePath: root,
  })
  return { root, assignmentPath, bindings, ctx }
}

test('approved researcher limit caps a wider stage concurrency setting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-research-cap-'))
  try {
    writePlan(dir, `
# Plan: Capped evidence
**Status:** draft

### S1: Research

#### T1: Task T1
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/tasks/T1/evidence.json

#### T2: Task T2
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/tasks/T2/evidence.json
`)
    const bindings = writeApprovedResearchPlan(dir, ['T1', 'T2'], 1)
    let releaseFirst!: () => void
    const firstBarrier = new Promise<void>((resolve) => { releaseFirst = resolve })
    let resolveFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => { resolveFirstStarted = resolve })
    let starts = 0
    let active = 0
    let peak = 0
    const start = () => {
      starts += 1
      active += 1
      peak = Math.max(peak, active)
      if (starts === 1) resolveFirstStarted()
    }
    queuedResults = [
      {
        text: researchEvidenceResult({ taskId: 'T1', ...bindings.get('T1')! }),
        onStart: start,
        waitFor: firstBarrier,
        beforeReturn: () => { active -= 1 },
      },
      {
        text: researchEvidenceResult({ taskId: 'T2', ...bindings.get('T2')! }),
        onStart: start,
        beforeReturn: () => { active -= 1 },
      },
    ]

    const execution = createPipelineTool(makeContext(dir, {
      executionMode: 'bounded_parallel',
      maxConcurrency: 8,
      assignmentScope: 'task',
      planArtifact: 'research/plan.json',
    })).execute(
      'capped-research',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )
    await firstStarted
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(starts, 1)
    assert.equal(peak, 1)
    releaseFirst()
    await execution
    assert.equal(starts, 2)
    assert.equal(peak, 1)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('dispatch fails closed when the pending task cannot be durably claimed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-runtime-claim-'))
  try {
    const sourcePlanPath = writePlan(dir, `
# Plan: Claim failure
**Status:** draft

### S1: Sprint

#### T1: Must not run
- **Agent:** writer
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** t1.md
`)
    const ownedPlanPath = runtimePlanPath(dir)
    fs.mkdirSync(path.dirname(ownedPlanPath), { recursive: true })
    fs.symlinkSync(sourcePlanPath, ownedPlanPath)
    queuedResults = [{ text: 'This result must remain queued.' }]
    const callsBefore = dispatchCalls

    const ctx = makeContext(dir)
    const result = await createPipelineTool(ctx).execute(
      'claim-failure',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.match(readTextResult(result), /Could not durably persist status 'in_progress'/)
    assert.equal(dispatchCalls - callsBefore, 0)
    assert.equal(queuedResults.length, 1)
    assert.equal(parsePlanStatus(sourcePlanPath, 'T1'), 'pending')
    assert.equal(fs.existsSync(path.join(dir, 'brief.md')), false)
    assert.equal(
      ctx.state.levelStates.get('execution')?.stageStatus,
      STAGE_LIFECYCLE_STATUS.BLOCKED,
    )
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('auto dispatch halts without replay when terminal status persistence fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-runtime-terminal-'))
  try {
    const sourcePlanPath = writePlan(dir, `
# Plan: Terminal persistence failure
**Status:** draft

### S1: Sprint

#### T1: Run once
- **Agent:** writer
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** t1.md
`)
    const ownedPlanPath = runtimePlanPath(dir)
    const claimedPlanBackup = `${ownedPlanPath}.claimed`
    queuedResults = [
      {
        text: 'The first execution completed.',
        beforeReturn() {
          fs.renameSync(ownedPlanPath, claimedPlanBackup)
          fs.symlinkSync(sourcePlanPath, ownedPlanPath)
        },
      },
      { text: 'A duplicate execution must not run.' },
    ]
    const callsBefore = dispatchCalls

    const ctx = makeContext(dir)
    const result = await createPipelineTool(ctx).execute(
      'terminal-failure',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )
    const text = readTextResult(result)

    assert.match(text, /Could not durably persist status 'completed'/)
    assert.doesNotMatch(text, /dispatched to writer/)
    assert.equal(dispatchCalls - callsBefore, 1)
    assert.equal(queuedResults.length, 1)
    assert.equal(parsePlanStatus(claimedPlanBackup, 'T1'), 'in_progress')
    assert.equal(parsePlanStatus(sourcePlanPath, 'T1'), 'pending')
    assert.equal(
      ctx.state.levelStates.get('execution')?.stageStatus,
      STAGE_LIFECYCLE_STATUS.BLOCKED,
    )
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an authorized replacement resets and resumes one interrupted pipeline claim', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-runtime-recovery-'))
  try {
    writePlan(dir, `
# Plan: Recovery
**Status:** executing

### S1: Sprint

#### T1: Resume once
- **Agent:** writer
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** t1.md
`)
    const ownedPlanPath = runtimePlanPath(dir)
    fs.mkdirSync(path.dirname(ownedPlanPath), { recursive: true })
    fs.writeFileSync(
      ownedPlanPath,
      fs.readFileSync(path.join(dir, '.pi-tasks', 'plan.md'), 'utf8')
        .replace('- **Status:** pending', '- **Status:** in_progress'),
    )
    fs.writeFileSync(path.join(dir, 't1.md'), 'partial uncommitted output')
    queuedResults = [{ text: 'Recovered execution completed.' }]
    const callsBefore = dispatchCalls

    const ctx = makeContext(dir, { recoveryMode: true })
    const result = await createPipelineTool(ctx).execute(
      'recover-pipeline',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.match(readTextResult(result), /T1 dispatched to writer/)
    assert.equal(dispatchCalls - callsBefore, 1)
    assert.equal(parsePlanStatus(ownedPlanPath, 'T1'), 'completed')
    assert.equal(fs.existsSync(path.join(dir, 't1.md')), false)
    assert.equal(queuedResults.length, 0)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pipeline recovery cannot delete a result declared inside private runtime state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-runtime-private-'))
  try {
    writePlan(dir, `
# Plan: Private result rejection
**Status:** executing

### S1: Sprint

#### T1: Unsafe result
- **Agent:** writer
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** .runtime/workflow-state.json
`)
    const ownedPlanPath = runtimePlanPath(dir)
    fs.mkdirSync(path.dirname(ownedPlanPath), { recursive: true })
    fs.writeFileSync(
      ownedPlanPath,
      fs.readFileSync(path.join(dir, '.pi-tasks', 'plan.md'), 'utf8')
        .replace('- **Status:** pending', '- **Status:** in_progress'),
    )
    const privateStatePath = path.join(dir, '.runtime', 'workflow-state.json')
    fs.writeFileSync(privateStatePath, 'durable private state')
    queuedResults = [{ text: 'Unsafe dispatch must not run.' }]
    const callsBefore = dispatchCalls

    const result = await createPipelineTool(
      makeContext(dir, { recoveryMode: true }),
    ).execute(
      'private-recovery',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.match(readTextResult(result), /reserved private runtime path/)
    assert.equal(dispatchCalls - callsBefore, 0)
    assert.equal(fs.readFileSync(privateStatePath, 'utf8'), 'durable private state')
    assert.equal(parsePlanStatus(ownedPlanPath, 'T1'), 'in_progress')
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pipeline recovery rejects a symlinked result parent without deleting outside the run', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-runtime-link-'))
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-external-'))
  try {
    writePlan(dir, `
# Plan: Symlink result rejection
**Status:** executing

### S1: Sprint

#### T1: Unsafe parent
- **Agent:** writer
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** reports/out.md
`)
    const ownedPlanPath = runtimePlanPath(dir)
    fs.mkdirSync(path.dirname(ownedPlanPath), { recursive: true })
    fs.writeFileSync(
      ownedPlanPath,
      fs.readFileSync(path.join(dir, '.pi-tasks', 'plan.md'), 'utf8')
        .replace('- **Status:** pending', '- **Status:** in_progress'),
    )
    const externalResultPath = path.join(externalDir, 'out.md')
    fs.writeFileSync(externalResultPath, 'external data')
    fs.symlinkSync(externalDir, path.join(dir, 'reports'))
    queuedResults = [{ text: 'Unsafe dispatch must not run.' }]
    const callsBefore = dispatchCalls

    const result = await createPipelineTool(
      makeContext(dir, { recoveryMode: true }),
    ).execute(
      'symlink-recovery',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.match(readTextResult(result), /symbolic-link component/)
    assert.equal(dispatchCalls - callsBefore, 0)
    assert.equal(fs.readFileSync(externalResultPath, 'utf8'), 'external data')
    assert.equal(parsePlanStatus(ownedPlanPath, 'T1'), 'in_progress')
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(externalDir, { recursive: true, force: true })
  }
})

test('dispatch in auto mode blocks cleanly when no tasks are ready', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-runtime-loop-'))
  try {
    writePlan(dir, `
# Plan: Blocked
**Status:** draft

### S1: Sprint

#### T1: Waiting task
- **Agent:** writer
- **Status:** pending
- **Validate:** false
- **Depends on:** T9
- **Gate:** false
- **Result file:** t1.md
`)

    const ctx = makeContext(dir)
    const tool = createPipelineTool(ctx)
    const result = await tool.execute('call-1', undefined as any, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(result)

    assert.match(text, /No tasks ready to dispatch/)
    assert.equal(ctx.state.levelStates.get('execution')?.stageStatus, STAGE_LIFECYCLE_STATUS.BLOCKED)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('dispatch skips all transitive dependents when a task agent is unavailable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-runtime-loop-'))
  try {
    writePlan(dir, `
# Plan: Failed agent
**Status:** draft

### S1: Sprint

#### T1: Missing agent task
- **Agent:** missing-agent
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** t1.md

#### T2: Direct dependent
- **Agent:** writer
- **Status:** pending
- **Validate:** false
- **Depends on:** T1
- **Gate:** false
- **Result file:** t2.md

#### T3: Transitive dependent
- **Agent:** editor
- **Status:** pending
- **Validate:** false
- **Depends on:** T2
- **Gate:** false
- **Result file:** t3.md
`)

    const ctx = makeContext(dir)
    const tool = createPipelineTool(ctx)
    const result = await tool.execute('call-1', undefined as any, undefined as any, undefined as any, undefined as any)
    const plan = fs.readFileSync(runtimePlanPath(dir), 'utf8')

    assert.match(readTextResult(result), /Auto-skipping dependents: T2, T3/)
    assert.match(plan, /#### T1:[\s\S]*?- \*\*Status:\*\* failed/)
    assert.match(plan, /#### T2:[\s\S]*?- \*\*Status:\*\* skipped/)
    assert.match(plan, /#### T3:[\s\S]*?- \*\*Status:\*\* skipped/)
    assert.equal(ctx.state.levelStates.get('execution')?.stageStatus, STAGE_LIFECYCLE_STATUS.FAILED)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('bounded parallel failure remains terminal failed and never transitions to completed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-runtime-failed-lane-'))
  try {
    writePlan(dir, `
# Plan: Failed research lane
**Status:** draft

### S1: Research wave

#### T1: Unavailable lane
- **Agent:** missing-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/evidence/T1.json
`)
    writeApprovedResearchPlan(dir, ['T1'])

    const ctx = makeContext(dir, {
      executionMode: 'bounded_parallel',
      maxConcurrency: 2,
      assignmentScope: 'task',
      planArtifact: 'research/plan.json',
    })
    const tool = createPipelineTool(ctx)
    const first = await tool.execute(
      'failed-lane',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.match(readTextResult(first), /T1 failed:\*\* Agent 'missing-researcher' not found/)
    assert.doesNotMatch(readTextResult(first), /Pipeline complete/)
    assert.equal(parsePlanStatus(runtimePlanPath(dir), 'T1'), 'failed')
    assert.match(
      fs.readFileSync(path.join(dir, 'research', 'quality', 'escalation.md'), 'utf8'),
      /status: "blocked"[\s\S]*?`T1` \(failed\)/,
    )
    assert.match(
      fs.readFileSync(path.join(dir, 'research-package.md'), 'utf8'),
      /status: "blocked"[\s\S]*?No verified research report can be published/,
    )
    assert.equal(
      ctx.state.levelStates.get('execution')?.stageStatus,
      STAGE_LIFECYCLE_STATUS.FAILED,
    )

    const second = await tool.execute(
      'failed-lane-recheck',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )
    assert.match(readTextResult(second), /Pipeline failed:/)
    assert.doesNotMatch(readTextResult(second), /Pipeline complete/)
    assert.equal(
      ctx.state.levelStates.get('execution')?.stageStatus,
      STAGE_LIFECYCLE_STATUS.FAILED,
    )
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('dispatch status reports persisted pipeline progress after runtime-owned execution', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-runtime-loop-'))
  try {
    writePlan(dir, `
# Plan: Sample
**Status:** draft

### S1: Sprint

#### T1: First task
- **Agent:** writer
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** t1.md
`)
    queuedResults = [
      { text: 'Writer completed T1' },
    ]

    const ctx = makeContext(dir)
    const tool = createPipelineTool(ctx)
    await tool.execute('call-1', undefined as any, undefined as any, undefined as any, undefined as any)
    const status = await tool.execute('call-2', { task_id: 'status' } as any, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(status)

    assert.match(text, /Plan Status: Sample/)
    assert.match(text, /T1: First task \[writer\] — completed/)
    assert.deepEqual(ctx.state.levelStates.get('execution')?.engineState?.activeTaskIds, [])
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the reviewer summary index is never written while a lane lacks a validated packet', async () => {
  // §5.1 constraint 2 rests on this: wave finalization refuses to run until
  // every approved task has a validated evidence artifact, so the one summary
  // path the quality-audit contract declares can never link a rejected lane.
  const { finalizeDeepResearchEvidenceWave } = await import(
    '../../domains/deep-research/deep-research-pipeline-adapter.js'
  )
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-summary-index-'))
  try {
    writePlan(dir, `
# Plan: Summary index invariant
**Status:** draft

### S1: Research

#### T1: Task T1
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/evidence/wave-0/T1.json
`)
    writeApprovedResearchPlan(dir, ['T1'])
    const executablePlan = parsePlan(path.join(dir, '.pi-tasks', 'plan.md'))
    assert.ok(executablePlan)

    assert.throws(
      () => finalizeDeepResearchEvidenceWave({
        assignmentPath: dir,
        planArtifact: 'research/plan.json',
        executablePlan,
      }),
      /has no current evidence artifact|is not complete/,
    )
    assert.equal(
      fs.existsSync(path.join(dir, 'research', 'evidence', 'current-summary.md')),
      false,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * B1 — an aborted bounded-parallel drain must propagate the abort.
 *
 * The drain converts every `Promise.allSettled` rejection into a blocked task
 * and a successful-looking stage result, without testing either signal. Every
 * other engine guards this: `engines/broadcast.ts` says "Shutdown must
 * propagate — never report an aborted fan-out as a completed stage result",
 * and chain and review carry the same check.
 *
 * The consequence is that a cancelled run is recorded as work that failed on
 * its merits rather than work that was stopped.
 */
test('an aborted bounded-parallel wave propagates the abort instead of reporting a stage result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-runtime-abort-'))
  try {
    writePlan(dir, `
# Plan: Parallel research
**Status:** draft

### S1: Research

#### T1: Market evidence
- **Agent:** writer
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/T1/report.md

#### T2: Technical evidence
- **Agent:** writer
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/T2/report.md
`)

    const controller = new AbortController()
    let releaseWave!: () => void
    const waveBarrier = new Promise<void>((resolve) => { releaseWave = resolve })
    let started = 0
    let resolveBothStarted!: () => void
    const bothStarted = new Promise<void>((resolve) => { resolveBothStarted = resolve })
    const abortMidFlight = () => {
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      throw error
    }
    const onStart = () => {
      started += 1
      if (started === 2) resolveBothStarted()
    }
    queuedResults = [
      { text: 'unused', onStart, waitFor: waveBarrier, beforeReturn: abortMidFlight },
      { text: 'unused', onStart, waitFor: waveBarrier, beforeReturn: abortMidFlight },
    ]

    const ctx = makeContext(dir, {
      executionMode: 'bounded_parallel',
      maxConcurrency: 2,
      assignmentScope: 'task',
    })
    const execution = createPipelineTool(ctx).execute(
      'aborted-wave',
      undefined as never,
      controller.signal,
      undefined as never,
      undefined as never,
    )

    await bothStarted
    controller.abort()
    releaseWave()

    await assert.rejects(
      execution,
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.name, 'AbortError')
        return true
      },
      'a cancelled wave must not resolve as a stage result',
    )
    assert.notEqual(
      ctx.state.levelStates.get('l1')?.stageStatus,
      STAGE_LIFECYCLE_STATUS.COMPLETED,
    )
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * The second half of the same guard: no new wave may start after cancellation.
 *
 * The rejection check only covers a wave that was already in flight. Without a
 * check at the top of the drain loop, a run cancelled between waves still
 * dispatches the next one.
 */
test('an abort between waves stops the drain instead of dispatching the next wave', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-runtime-abort-wave-'))
  try {
    writePlan(dir, `
# Plan: Parallel research
**Status:** draft

### S1: Research

#### T1: Market evidence
- **Agent:** writer
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/T1/report.md

#### T2: Technical evidence
- **Agent:** writer
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/T2/report.md

#### T3: Synthesis
- **Agent:** editor
- **Status:** pending
- **Validate:** false
- **Depends on:** T1, T2
- **Gate:** false
- **Result file:** synthesis/report.md
`)

    const controller = new AbortController()
    let completed = 0
    // Cancel once the first wave has finished but before the loop picks up T3.
    const cancelAfterFirstWave = () => {
      completed += 1
      if (completed === 2) controller.abort()
    }
    queuedResults = [
      { text: 'Market complete', beforeReturn: cancelAfterFirstWave },
      { text: 'Technical complete', beforeReturn: cancelAfterFirstWave },
      // Deliberately no third result: if the guard fails to stop the drain, the
      // mock runs dry and the failure is a mocking error rather than an abort.
    ]

    const ctx = makeContext(dir, {
      executionMode: 'bounded_parallel',
      maxConcurrency: 2,
      assignmentScope: 'task',
    })

    await assert.rejects(
      createPipelineTool(ctx).execute(
        'aborted-between-waves',
        undefined as never,
        controller.signal,
        undefined as never,
        undefined as never,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.name, 'AbortError')
        return true
      },
      'a drain cancelled between waves must not dispatch the next wave',
    )
    assert.equal(parsePlanStatus(runtimePlanPath(dir), 'T3'), 'pending')
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * B1, third acceptance item: an abort must not be written into the research
 * evidence trail as a merits-based rejection.
 *
 * The non-Halt catch writes a rejected lane summary with
 * `fallbackCategory: 'dispatch_failed'` before rethrowing. On a cancelled run
 * that records the lane as having failed on its own output, which is a
 * different fact from the run having been stopped, and it survives in the
 * evidence the operator later reads.
 */
test('an aborted research dispatch writes no dispatch_failed rejected lane summary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-research-abort-'))
  try {
    writePlan(dir, `
# Plan: Research evidence
**Status:** draft

### S1: Research

#### T1: Task T1
- **Agent:** web-researcher
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/tasks/T1/evidence.json
`)
    writeApprovedResearchPlan(dir, ['T1'])

    const controller = new AbortController()
    // The lane must have recorded an attempt before the abort, or the summary
    // writer early-returns on `attempts === 0` and the test would pass without
    // ever reaching the behaviour under test.
    queuedResults = [
      { text: 'not a valid evidence packet' },
      {
        text: 'unused',
        beforeReturn: () => {
          controller.abort()
          const error = new Error('The operation was aborted')
          error.name = 'AbortError'
          throw error
        },
      },
    ]

    const ctx = makeContext(dir, {
      assignmentScope: 'task',
      planArtifact: 'research/plan.json',
    })

    await assert.rejects(
      createPipelineTool(ctx).execute(
        'aborted-research-dispatch',
        undefined as never,
        controller.signal,
        undefined as never,
        undefined as never,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.name, 'AbortError')
        return true
      },
    )

    const walk = (directory: string): string[] => fs.existsSync(directory)
      ? fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(path.join(directory, entry.name))
          : [path.join(directory, entry.name)])
      : []
    const rejectionRecords = walk(path.join(dir, 'research', 'evidence'))
      .filter((file) => {
        const text = fs.readFileSync(file, 'utf8')
        return text.includes('status: "rejected"') || text.includes('dispatch_failed')
      })

    assert.deepEqual(
      rejectionRecords.map((file) => path.relative(dir, file)),
      [],
      'a cancelled run must not leave a rejected lane record in the evidence trail',
    )
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a pipeline dispatch substitutes the concrete task content into the agent system prompt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-task-content-'))
  try {
    // The shipped Deep Research agents put `{{TASK_CONTENT}}` under a
    // `## Context` heading (agents/web-researcher/web-researcher.md:140,
    // agents/research-section-writer/research-section-writer.md:41), so the
    // fixture reproduces that shape rather than an invented one.
    writePlan(dir, `
# Plan: Sample
**Status:** draft

### S1: Sprint

#### T1: Summarise the Michigan copper tailings survey
- **Agent:** writer
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** t1.md
`)
    queuedResults = [{ text: 'Writer completed T1' }]
    dispatchedSystemPrompts = []

    const ctx = makeContext(dir)
    ctx.agents.get('writer').systemPrompt = 'Write.\n\n## Context\n\n{{TASK_CONTENT}}'
    const tool = createPipelineTool(ctx)
    // `signal` and `onUpdate` are declared optional, so they take a real
    // `undefined`. Only `ctx: ExtensionContext` is required and genuinely
    // unavailable in a unit harness, so the assertion is confined to it.
    await tool.execute('call-1', {}, undefined, undefined, undefined as never)

    const prompt = dispatchedSystemPrompts[0] ?? ''
    // The requirement, stated twice: the placeholder must not survive, and the
    // agent's own task must be what replaced it. Asserting only the first would
    // pass on an empty string.
    assert.doesNotMatch(prompt, /\{\{TASK_CONTENT\}\}/)
    assert.match(prompt, /Summarise the Michigan copper tailings survey/)
  } finally {
    queuedResults = []
    dispatchedSystemPrompts = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
