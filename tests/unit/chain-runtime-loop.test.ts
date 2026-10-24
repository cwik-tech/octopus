import test, { mock } from 'node:test'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'
import { parseMarkdownArtifact } from '../../domains/runtime/artifacts.js'
import { approveResearchPlan } from '../../domains/deep-research/deep-research-approval.js'
import { createDeepResearchQualityVerdictOutputSchema } from '../../domains/deep-research/deep-research-quality-output-schema.js'

type MockDispatchResult =
  | { text: string; skipped?: boolean }
  | Error

let queuedResults: MockDispatchResult[] = []
let observedUserMessages: string[] = []
let observedOutputSchemas: Array<Readonly<Record<string, unknown>> | undefined> = []

mock.module('../../domains/agent-execution/failure-policy.js', {
  namedExports: {
    DispatchResultValidationError: class DispatchResultValidationError extends Error {
      retryInstruction?: string

      constructor(message: string, _category: string, retryInstruction?: string) {
        super(message)
        this.name = 'DispatchResultValidationError'
        if (retryInstruction !== undefined) {
          this.retryInstruction = retryInstruction
        }
      }
    },
    HaltError: class HaltError extends Error {
      agentName: string
      originalError: string

      constructor(agentName: string, originalError: string) {
        super(originalError)
        this.name = 'HaltError'
        this.agentName = agentName
        this.originalError = originalError
      }
    },
    resolveFailurePolicy: () => ({ policy: 'retry', maxRetries: 1 }),
    dispatchWithFailurePolicy: mock.fn(async (options: {
      validateResult?: (text: string) => string
      userMessage: string
      outputSchema?: Readonly<Record<string, unknown>>
    }) => {
      observedUserMessages.push(options.userMessage)
      observedOutputSchemas.push(options.outputSchema)
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const next = queuedResults.shift()
        if (!next) throw new Error('No mocked chain dispatch result queued.')
        if (next instanceof Error) throw next
        try {
          return {
            text: options.validateResult ? options.validateResult(next.text) : next.text,
            skipped: next.skipped ?? false,
            cost: 0,
            durationMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            contextTokens: 0,
            model: 'mock-model',
          }
        } catch (error) {
          if ((error as Error).name !== 'DispatchResultValidationError' || attempt === 1) {
            throw error
          }
        }
      }
      throw new Error('Mocked validation retry loop exhausted unexpectedly.')
    }),
  },
})

const { createChainTool, isChainComplete } = await import('../../engines/chain.js')
const { isLevelReadyForGate } = await import('../../team-runtime/level-lifecycle.js')

function makeLevels() {
  return [
    {
      id: 'brief',
      name: 'Brief',
      order: 0,
      stage: {
        type: 'discussion',
        coordinator: 'editor',
        participants: ['editor'],
        config: {
          output: {
            format: 'brief.md',
            user_review: false,
          },
        },
      },
    },
    {
      id: 'draft-chain',
      name: 'Draft Chain',
      order: 1,
      stage: {
        type: 'chain',
        coordinator: 'editor',
        sequence: ['writer', 'editor'],
        config: {
          output: {
            format: 'draft-package.md',
            user_review: false,
          },
        },
      },
    },
  ] as any
}

function makeContext(dir: string) {
  const levels = makeLevels()
  return {
    teamName: 'writing-team',
    teamConfig: {
      team: { name: 'writing-team', description: 'test', version: '0.1.0' },
      workspace: { path: dir, watch: false },
      workflow: {
        entry_level: 'draft-chain',
        input_contract: {
          artifacts: [
            { path: 'incoming-brief.md', required: true },
          ],
        },
      },
      models: {},
      agents: [],
      levels,
      gates: [],
    } as any,
    teamRootPath: dir,
    levelId: 'draft-chain',
    config: levels[1]!.stage,
    agents: new Map([
      ['writer', { name: 'writer', systemPrompt: 'Write.', agentDir: dir, experienceEnabled: false }],
      ['editor', { name: 'editor', systemPrompt: 'Edit.', agentDir: dir, experienceEnabled: false }],
    ]),
    rosterEntries: new Map([
      ['writer', { name: 'writer', type: 'agent' }],
      ['editor', { name: 'editor', type: 'agent' }],
    ]),
    state: {
      sessionId: 'chain-session',
      currentLevelIndex: 1,
      levelStates: new Map([
        ['draft-chain', {
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
    workspacePath: dir,
    outputPath: dir,
    inputFilesContent: '',
    agentMetrics: new Map(),
    stageFailureOverride: undefined,
    shutdownSignal: undefined,
    budgetLedger: undefined,
    onDashboardUpdate: undefined,
    getCurrentCoordinatorRunId: () => 1,
    coordinatorName: 'editor',
  } as any
}

function readTextResult(result: any): string {
  return (result.content?.[0] as { text?: string } | undefined)?.text ?? ''
}

type ChainToolExecute = ReturnType<typeof createChainTool>['execute']

/**
 * `signal` and `onUpdate` are declared optional, so they take a real
 * `undefined`. The chain tool never reads the extension context — it accepts
 * one only to satisfy the agent SDK's tool interface — so an empty one carries
 * everything this harness needs.
 */
const UNUSED_EXTENSION_CONTEXT: ExtensionToolContext = Object.create(null)

function runHandoff(
  ctx: ReturnType<typeof makeContext>,
  toolCallId: string,
  message: string,
): ReturnType<ChainToolExecute> {
  return createChainTool(ctx).execute(
    toolCallId,
    { message },
    undefined,
    undefined,
    UNUSED_EXTENSION_CONTEXT,
  )
}

function writeQualityRuntimeArtifacts(dir: string): void {
  const approvedPlan = approveResearchPlan({
    schemaVersion: 1,
    planId: 'plan-one',
    requestId: 'request-one',
    request: {
      schemaVersion: 1,
      requestId: 'request-one',
      question: 'What does the evidence establish?',
      objective: 'Establish the evidence for the report.',
      audience: 'Decision makers',
      includedScope: ['Example evidence'],
      excludedScope: [],
      desiredSections: ['Evidence'],
      jurisdictions: [],
      freshnessAsOf: '2026-07-16T12:00:00.000Z',
      authenticatedDomains: [],
      sourceRequirements: [],
      maxDurationMinutes: 20,
      maxResearcherAgents: 1,
      outputFormats: ['markdown', 'docx'],
    },
    sections: [{
      schemaVersion: 1,
      id: 'section-one',
      title: 'Evidence',
      objective: 'Establish the evidence.',
      taskIds: ['T1'],
    }],
    tasks: [{
      schemaVersion: 1,
      id: 'T1',
      sectionId: 'section-one',
      title: 'Research',
      question: 'What does the evidence establish?',
      purpose: 'evidence_acquisition',
      workerSpecId: 'worker-one',
      dependsOn: [],
      correctionWave: 0,
    }],
    workerSpecs: [{
      schemaVersion: 1,
      id: 'worker-one',
      laneId: 'lane-one',
      sectionId: 'section-one',
      baseAgent: 'web-researcher',
      displayRole: 'Evidence analyst',
      domain: 'example',
      lens: 'foundational',
      methodCardIds: ['general-research-v1'],
      specialistStance:
        'Approach this assignment as an evidence verification analyst. Separate observed facts from inference.',
      question: 'What does the evidence establish?',
      decisionUse: 'Support the report.',
      workingDefinitions: [],
      dependencyClaimIds: [],
      sourceRequirements: {
        preferredTypes: ['primary'],
        requiredAuthorityTypes: ['primary'],
        queryHints: [],
      },
      requiredMetrics: [],
      prohibitedAssumptions: [],
      stopRule: {
        minimumPrimarySources: 0,
        minimumIndependentSources: 1,
        maximumSources: 5,
      },
      limits: { deadlineMs: 60_000 },
    }],
    maxDurationMinutes: 20,
    maxResearcherAgents: 1,
    expectedPeakWorkers: 1,
    authenticatedDomains: [],
  }, '2026-07-16T12:00:00.000Z')
  fs.mkdirSync(path.join(dir, 'research', 'quality'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'research', 'approved-plan.json'), JSON.stringify(approvedPlan))
  fs.writeFileSync(path.join(dir, 'research', 'quality', 'current-packet.json'), JSON.stringify({
    schemaVersion: 1,
    planId: 'plan-one',
    synthesis: { claims: [], sources: [] },
  }))
  fs.writeFileSync(path.join(dir, 'research', 'quality', 'deterministic-verdict.json'), JSON.stringify({
    schemaVersion: 1,
    verdictId: 'deterministic-zero',
    correctionWave: 0,
    decision: 'APPROVE',
    findings: [],
    correctionRequests: [],
    reviewedAt: '2026-07-16T12:00:00.000Z',
  }))
}

test('a chain step reports a declared timeout that can never fire', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-level-timeout-'))
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), 'Incoming brief content')
    writeQualityRuntimeArtifacts(dir)
    writeRuntimeLimits(dir, 20)
    queuedResults = [{ text: 'Writer draft' }, { text: 'Editor polished draft' }]

    const ctx = makeContext(dir)
    ctx.config.config.deadline_artifact = 'research/runtime-limits.json'
    ctx.config.config.constraints = { agent_timeout_minutes: 20 }
    const result = await createChainTool(ctx).execute(
      'call-level-timeout',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.match(
      readTextResult(result),
      /Level timeout clamped/,
      'a chain stage clamped silently reads as a safety control providing none',
    )
    assert.match(readTextResult(result), /never fire/)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a chain step declaring a timeout below the plan budget reports nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-level-timeout-ok-'))
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), 'Incoming brief content')
    writeQualityRuntimeArtifacts(dir)
    writeRuntimeLimits(dir, 20)
    queuedResults = [{ text: 'Writer draft' }, { text: 'Editor polished draft' }]

    const ctx = makeContext(dir)
    ctx.config.config.deadline_artifact = 'research/runtime-limits.json'
    ctx.config.config.constraints = { agent_timeout_minutes: 8 }
    const result = await createChainTool(ctx).execute(
      'call-level-timeout-ok',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.doesNotMatch(readTextResult(result), /Level timeout clamped/)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function writeRuntimeLimits(dir: string, maxDurationMinutes: number): void {
  const startedAt = new Date()
  fs.mkdirSync(path.join(dir, 'research'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'research', 'runtime-limits.json'),
    JSON.stringify({
      schemaVersion: 1,
      planId: 'plan-one',
      maxDurationMinutes,
      startedAt: startedAt.toISOString(),
      deadlineAt: new Date(
        startedAt.getTime() + maxDurationMinutes * 60_000,
      ).toISOString(),
    }),
  )
}

test('handoff bootstraps from the previous-stage artifact with no arguments', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), 'Incoming brief content')
    queuedResults = [
      { text: 'Writer draft' },
      { text: 'Editor polished draft' },
    ]

    const ctx = makeContext(dir)
    const tool = createChainTool(ctx)
    const result = await tool.execute('call-1', undefined as any, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(result)

    assert.match(text, /Chain Complete/)
    assert.equal(
      fs.readFileSync(path.join(dir, 'draft-package.md'), 'utf8').includes('Editor polished draft'),
      true,
    )
    assert.equal(ctx.state.levelStates.get('draft-chain')?.stageStatus, STAGE_LIFECYCLE_STATUS.COMPLETED)
    assert.equal(ctx.state.levelStates.get('draft-chain')?.engineState?.currentStep, 2)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('handoff can preserve the immutable initial artifact for later chain steps', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-preserved-input-'))
  try {
    const authoritativeUrl = 'https://evidence.example/exact-observed-path'
    fs.writeFileSync(
      path.join(dir, 'incoming-brief.md'),
      `# Evidence package\n\nUse [the exact source](${authoritativeUrl}).\n`,
    )
    queuedResults = [
      { text: '# Writing brief\n\nPreserve the source register exactly.' },
      { text: `# Draft\n\n[Source](${authoritativeUrl})` },
    ]
    observedUserMessages = []
    const ctx = makeContext(dir)
    ctx.config.config.preserve_initial_input = true

    await createChainTool(ctx).execute(
      'preserve-initial',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.equal(observedUserMessages.length, 2)
    assert.doesNotMatch(observedUserMessages[0]!, /Authoritative Initial Input/)
    assert.match(observedUserMessages[1]!, /Authoritative Initial Input/)
    assert.match(observedUserMessages[1]!, new RegExp(authoritativeUrl))
    assert.match(observedUserMessages[1]!, /Preserve the source register exactly/)
  } finally {
    queuedResults = []
    observedUserMessages = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('structured quality handoff writes canonical raw and immutable versioned JSON', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-quality-verdict-'))
  try {
    writeQualityRuntimeArtifacts(dir)
    const ctx = makeContext(dir)
    const stage = {
      type: 'chain',
      sequence: ['editor'],
      config: {
        handoff_format: 'json',
        structured_output: 'deep_research_quality_verdict',
        output: { path: 'research/quality', format: 'current-verdict.json', user_review: false },
      },
    }
    ctx.config = stage
    ctx.teamConfig.levels[1].stage = stage
    queuedResults = [{ text: JSON.stringify({
      schemaVersion: 1,
      verdictId: 'critic-zero',
      correctionWave: 0,
      decision: 'APPROVE',
      findings: [],
      correctionRequests: [],
      reviewedAt: '2026-07-16T12:01:00.000Z',
    }) }]

    const result = await createChainTool(ctx).execute(
      'quality-verdict',
      { message: 'Audit the current research package.' } as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )
    const currentPath = path.join(dir, 'research', 'quality', 'current-verdict.json')
    const versionPath = path.join(dir, 'research', 'quality', 'verdict-wave-0.json')
    const current = fs.readFileSync(currentPath, 'utf8')

    assert.match(readTextResult(result), /Chain Complete/)
    assert.doesNotMatch(current, /^---/)
    assert.equal(JSON.parse(current).decision, 'APPROVE')
    assert.deepEqual(JSON.parse(fs.readFileSync(versionPath, 'utf8')), JSON.parse(current))
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('structured quality handoff repairs one invalid critic contract before persistence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-quality-repair-'))
  try {
    writeQualityRuntimeArtifacts(dir)
    const ctx = makeContext(dir)
    const stage = {
      type: 'chain',
      sequence: ['editor'],
      config: {
        handoff_format: 'json',
        structured_output: 'deep_research_quality_verdict',
        output: { path: 'research/quality', format: 'current-verdict.json', user_review: false },
      },
    }
    ctx.config = stage
    ctx.teamConfig.levels[1].stage = stage
    const verdict = {
      schemaVersion: 1,
      verdictId: 'critic-revise-zero',
      correctionWave: 0,
      decision: 'REVISE',
      findings: [{
        code: 'decision_not_supported',
        severity: 'blocking',
        message: 'The section conclusion requires a bounded resynthesis.',
        taskIds: ['T1'],
        sectionIds: ['section-one'],
        claimIds: [],
        sourceIds: [],
      }],
      correctionRequests: [{
        schemaVersion: 1,
        id: 'resynthesize-section-one',
        type: 'resynthesize',
        claimIds: [],
        taskIds: ['T1'],
        sectionIds: ['section-one'],
        acceptanceCriteria: ['Remove the unsupported section conclusion.'],
        impactScope: 'section',
      }],
      correctionRoute: 'synthesis',
      reviewedAt: '2026-07-16T12:01:00.000Z',
    }
    queuedResults = [
      { text: JSON.stringify(verdict) },
      { text: JSON.stringify({
        ...verdict,
        correctionRequests: verdict.correctionRequests.map((request) => ({
          ...request,
          impactScope: 'local',
        })),
      }) },
    ]

    const result = await createChainTool(ctx).execute(
      'quality-repair',
      { message: 'Audit and repair the contract if required.' } as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )
    const persisted = JSON.parse(fs.readFileSync(
      path.join(dir, 'research', 'quality', 'current-verdict.json'),
      'utf8',
    ))

    assert.match(readTextResult(result), /Chain Complete/)
    assert.equal(persisted.decision, 'REVISE')
    assert.equal(persisted.correctionRequests[0]?.impactScope, 'local')
    assert.equal(queuedResults.length, 0)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function fencedQualityApproval(verdictId: string): string {
  return `\`\`\`json\n${JSON.stringify({
    schemaVersion: 1,
    verdictId,
    correctionWave: 0,
    decision: 'APPROVE',
    findings: [],
    correctionRequests: [],
    reviewedAt: '2026-07-16T12:01:00.000Z',
  })}\n\`\`\``
}

test('structured quality handoff completes on one fenced valid verdict', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-quality-fenced-'))
  try {
    writeQualityRuntimeArtifacts(dir)
    const ctx = makeContext(dir)
    const stage = {
      type: 'chain',
      sequence: ['editor'],
      config: {
        handoff_format: 'json',
        structured_output: 'deep_research_quality_verdict',
        output: { path: 'research/quality', format: 'current-verdict.json', user_review: false },
      },
    }
    ctx.config = stage
    ctx.teamConfig.levels[1].stage = stage
    queuedResults = [{ text: fencedQualityApproval('critic-fenced-zero') }]

    const result = await runHandoff(ctx, 'quality-fenced', 'Audit.')
    const current = fs.readFileSync(
      path.join(dir, 'research', 'quality', 'current-verdict.json'),
      'utf8',
    )

    assert.match(readTextResult(result), /Chain Complete/)
    assert.doesNotMatch(current, /```/)
    assert.equal(JSON.parse(current).decision, 'APPROVE')
    assert.deepEqual(
      JSON.parse(fs.readFileSync(
        path.join(dir, 'research', 'quality', 'verdict-wave-0.json'),
        'utf8',
      )),
      JSON.parse(current),
    )
    assert.equal(queuedResults.length, 0)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('structured quality handoff escalates safely on two distinct fenced verdicts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-quality-ambiguous-'))
  try {
    writeQualityRuntimeArtifacts(dir)
    const ctx = makeContext(dir)
    const stage = {
      type: 'chain',
      sequence: ['editor'],
      config: {
        structured_output: 'deep_research_quality_verdict',
        output: { path: 'research/quality', format: 'current-verdict.json', user_review: false },
      },
    }
    ctx.config = stage
    ctx.teamConfig.levels[1].stage = stage
    const ambiguous =
      `${fencedQualityApproval('critic-first')}\n\n${fencedQualityApproval('critic-second')}`
    queuedResults = [{ text: ambiguous }, { text: ambiguous }]

    const result = await runHandoff(ctx, 'quality-ambiguous', 'Audit.')

    assert.match(readTextResult(result), /deterministic escalation saved/)
    assert.equal(
      JSON.parse(fs.readFileSync(
        path.join(dir, 'research', 'quality', 'current-verdict.json'),
        'utf8',
      )).decision,
      'ESCALATE',
    )
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('structured quality handoff escalates safely on malformed fenced model output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-quality-invalid-'))
  try {
    writeQualityRuntimeArtifacts(dir)
    const ctx = makeContext(dir)
    const stage = {
      type: 'chain',
      sequence: ['editor'],
      config: {
        structured_output: 'deep_research_quality_verdict',
        output: { path: 'research/quality', format: 'current-verdict.json', user_review: false },
      },
    }
    ctx.config = stage
    ctx.teamConfig.levels[1].stage = stage
    queuedResults = [
      { text: '```json\n{"decision":"APPROVE"}\n```' },
      { text: '```json\n{"decision":"APPROVE"}\n```' },
    ]

    const result = await createChainTool(ctx).execute(
      'quality-invalid',
      { message: 'Audit.' } as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.match(readTextResult(result), /deterministic escalation saved/)
    const fallback = JSON.parse(fs.readFileSync(
      path.join(dir, 'research', 'quality', 'current-verdict.json'),
      'utf8',
    ))
    assert.equal(fallback.decision, 'ESCALATE')
    assert.equal(fallback.correctionWave, 0)
    assert.ok(fallback.findings.some(
      (finding: { message?: string }) =>
        finding.message?.includes('adversarial quality review did not complete'),
    ))
    const escalation = parseMarkdownArtifact(fs.readFileSync(
      path.join(dir, 'research', 'quality', 'escalation.md'),
      'utf8',
    ))
    const blockedReport = parseMarkdownArtifact(fs.readFileSync(
      path.join(dir, 'research-package.md'),
      'utf8',
    ))
    assert.equal(escalation.metadata.status, 'blocked')
    assert.equal(blockedReport.metadata.status, 'blocked')
    const state = ctx.state.levelStates.get('draft-chain')?.engineState
    assert.equal(JSON.parse(state?.outputs[0]?.text ?? '{}').decision, 'ESCALATE')
    assert.equal(ctx.state.levelStates.get('draft-chain')?.stageStatus, STAGE_LIFECYCLE_STATUS.COMPLETED)
    assert.equal(isChainComplete(state), true)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('structured quality handoff escalates safely after reviewer dispatch failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-quality-dispatch-failure-'))
  try {
    writeQualityRuntimeArtifacts(dir)
    const ctx = makeContext(dir)
    const stage = {
      type: 'chain',
      sequence: ['editor'],
      config: {
        structured_output: 'deep_research_quality_verdict',
        output: { path: 'research/quality', format: 'current-verdict.json', user_review: false },
      },
    }
    ctx.config = stage
    ctx.teamConfig.levels[1].stage = stage
    queuedResults = [new Error('reviewer exhausted its bounded timeout')]

    const result = await createChainTool(ctx).execute(
      'quality-dispatch-failure',
      { message: 'Audit.' } as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )
    const fallback = JSON.parse(fs.readFileSync(
      path.join(dir, 'research', 'quality', 'current-verdict.json'),
      'utf8',
    ))

    assert.match(readTextResult(result), /Quality reviewer unavailable/)
    assert.equal(fallback.decision, 'ESCALATE')
    assert.equal(ctx.state.levelStates.get('draft-chain')?.stageStatus, STAGE_LIFECYCLE_STATUS.COMPLETED)
    assert.equal(isChainComplete(ctx.state.levelStates.get('draft-chain')?.engineState), true)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('structured quality handoff blocks publication when deterministic escalation cannot be persisted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-quality-emergency-blocker-'))
  try {
    writeQualityRuntimeArtifacts(dir)
    fs.mkdirSync(path.join(dir, 'research', 'corrections'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'research', 'corrections', 'current.json'),
      JSON.stringify({ wave: 1 }),
    )
    fs.writeFileSync(
      path.join(dir, 'research-package.md'),
      '# Provisional Research Package\n\nThis report has not passed quality review.\n',
    )
    const ctx = makeContext(dir)
    const stage = {
      type: 'chain',
      sequence: ['editor'],
      config: {
        structured_output: 'deep_research_quality_verdict',
        output: { path: 'research/quality', format: 'current-verdict.json', user_review: false },
      },
    }
    ctx.config = stage
    ctx.teamConfig.levels[1].stage = stage
    queuedResults = [new Error('reviewer provider unavailable')]

    const result = await createChainTool(ctx).execute(
      'quality-emergency-blocker',
      { message: 'Audit.' } as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )
    const escalation = parseMarkdownArtifact(fs.readFileSync(
      path.join(dir, 'research', 'quality', 'escalation.md'),
      'utf8',
    ))
    const blockedReport = parseMarkdownArtifact(fs.readFileSync(
      path.join(dir, 'research-package.md'),
      'utf8',
    ))

    assert.match(readTextResult(result), /Chain Blocked/)
    assert.match(readTextResult(result), /stale for the current correction wave/)
    assert.equal(escalation.metadata.status, 'blocked')
    assert.equal(blockedReport.metadata.status, 'blocked')
    assert.match(blockedReport.body, /quality review could not be completed or safely persisted/)
    assert.doesNotMatch(blockedReport.body, /Provisional Research Package/)
    assert.equal(
      fs.existsSync(path.join(dir, 'research', 'quality', 'current-verdict.json')),
      false,
    )
    assert.equal(
      ctx.state.levelStates.get('draft-chain')?.stageStatus,
      STAGE_LIFECYCLE_STATUS.BLOCKED,
    )
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('structured quality handoff rejects a multi-agent critic sequence before dispatch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-quality-sequence-'))
  try {
    const ctx = makeContext(dir)
    const stage = {
      type: 'chain',
      sequence: ['writer', 'editor'],
      config: {
        structured_output: 'deep_research_quality_verdict',
        output: { path: 'research/quality', format: 'current-verdict.json', user_review: false },
      },
    }
    ctx.config = stage
    ctx.teamConfig.levels[1].stage = stage

    const result = await createChainTool(ctx).execute(
      'quality-invalid-sequence',
      { message: 'Audit.' } as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )
    const blockedReport = parseMarkdownArtifact(fs.readFileSync(
      path.join(dir, 'research-package.md'),
      'utf8',
    ))

    assert.match(readTextResult(result), /must contain exactly one critic step/)
    assert.equal(blockedReport.metadata.status, 'blocked')
    assert.equal(
      ctx.state.levelStates.get('draft-chain')?.stageStatus,
      STAGE_LIFECYCLE_STATUS.BLOCKED,
    )
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('structured quality handoff preserves explicit cancellation without escalation artifacts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-quality-cancelled-'))
  try {
    writeQualityRuntimeArtifacts(dir)
    const ctx = makeContext(dir)
    const stage = {
      type: 'chain',
      sequence: ['editor'],
      config: {
        structured_output: 'deep_research_quality_verdict',
        output: { path: 'research/quality', format: 'current-verdict.json', user_review: false },
      },
    }
    ctx.config = stage
    ctx.teamConfig.levels[1].stage = stage
    queuedResults = [new Error('cancelled by caller')]
    const controller = new AbortController()
    controller.abort(new DOMException('cancelled by caller', 'AbortError'))

    await assert.rejects(
      createChainTool(ctx).execute(
        'quality-cancelled',
        { message: 'Audit.' } as any,
        controller.signal as any,
        undefined as any,
        undefined as any,
      ),
      /cancelled by caller/,
    )
    assert.equal(fs.existsSync(path.join(dir, 'research', 'quality', 'current-verdict.json')), false)
    assert.equal(fs.existsSync(path.join(dir, 'research', 'quality', 'escalation.md')), false)
    assert.equal(fs.existsSync(path.join(dir, 'research-package.md')), false)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('handoff bootstraps from workflow-level entry input artifacts for the entry chain level', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'incoming-brief.md'), 'Delegated entry brief content')
    queuedResults = [
      { text: 'Writer draft' },
      { text: 'Editor polished draft' },
    ]

    const ctx = makeContext(dir)
    ctx.state.currentLevelIndex = 0
    ctx.levelId = 'draft-chain'
    const tool = createChainTool(ctx)
    const result = await tool.execute('call-entry', undefined as any, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(result)

    assert.match(text, /Chain Complete/)
    assert.equal(
      fs.readFileSync(path.join(dir, 'draft-package.md'), 'utf8').includes('Editor polished draft'),
      true,
    )
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('handoff returns a clear bootstrap error when no input artifact or message exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-runtime-loop-'))
  try {
    const ctx = makeContext(dir)
    const tool = createChainTool(ctx)
    const result = await tool.execute('call-1', undefined as any, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(result)

    assert.match(text, /Chain bootstrap failed:/)
    assert.equal(fs.existsSync(path.join(dir, 'draft-package.md')), false)
    assert.equal(ctx.state.levelStates.get('draft-chain')?.stageStatus, STAGE_LIFECYCLE_STATUS.BLOCKED)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('handoff fails the stage and does not write final output when a step fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), 'Incoming brief content')
    queuedResults = [
      { text: 'Writer draft' },
      new Error('editor failed hard'),
    ]

    const ctx = makeContext(dir)
    const tool = createChainTool(ctx)
    const result = await tool.execute('call-1', undefined as any, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(result)

    assert.match(text, /Chain Blocked/)
    assert.match(text, /editor failed hard/)
    assert.equal(fs.existsSync(path.join(dir, 'draft-package.md')), false)
    assert.equal(ctx.state.levelStates.get('draft-chain')?.stageStatus, STAGE_LIFECYCLE_STATUS.BLOCKED)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('handoff resumes from the failed step without re-running completed steps', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), 'Incoming brief content')
    queuedResults = [{ text: 'Writer draft' }, new Error('editor failed hard')]
    const ctx = makeContext(dir)
    const tool = createChainTool(ctx)

    await tool.execute('call-1', undefined as any, undefined as any, undefined as any, undefined as any)
    assert.equal(ctx.state.levelStates.get('draft-chain')?.stageStatus, STAGE_LIFECYCLE_STATUS.BLOCKED)

    queuedResults = [{ text: 'Editor polished draft' }]
    const resumed = await tool.execute('call-2', { action: 'resume' } as any, undefined as any, undefined as any, undefined as any)

    assert.match(readTextResult(resumed), /Chain Complete/)
    assert.equal(queuedResults.length, 0, 'only the previously failed editor step should run')
    assert.equal(ctx.state.levelStates.get('draft-chain')?.stageStatus, STAGE_LIFECYCLE_STATUS.COMPLETED)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('handoff blocks the chain when a step returns a BLOCKED brief artifact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), 'Incoming brief content')
    queuedResults = [
      {
        text:
          '# Writing Brief\n\n' +
          '**Status:** BLOCKED\n\n' +
          '## Hard Gaps\n' +
          '1. Missing source transcript.\n',
      },
    ]

    const ctx = makeContext(dir)
    const tool = createChainTool(ctx)
    const result = await tool.execute('call-blocked', undefined as any, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(result)

    assert.match(text, /Chain Blocked/)
    assert.match(text, /BLOCKED handoff/)
    assert.match(text, /Missing source transcript/)
    assert.equal(fs.existsSync(path.join(dir, 'draft-package.md')), false)
    assert.equal(ctx.state.levelStates.get('draft-chain')?.stageStatus, STAGE_LIFECYCLE_STATUS.BLOCKED)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('blocked final handoff persists the canonical blocker without completing the chain', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-blocked-output-'))
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), 'Escalate exhausted corrections.')
    queuedResults = [{
      text:
        '**Status:** BLOCKED\n\n' +
        '## Hard Gaps\n' +
        '- T1 still lacks the required primary authority after two correction waves.\n',
    }]

    const ctx = makeContext(dir)
    const stage = {
      type: 'chain',
      sequence: ['writer'],
      config: {
        handoff_format: 'markdown',
        output: {
          path: 'research/quality',
          format: 'escalation.md',
          user_review: false,
        },
        output_contract: {
          artifacts: [{ path: 'research/quality/escalation.md', required: true }],
          completion_artifact: 'research/quality/escalation.md',
        },
      },
    }
    ctx.config = stage
    ctx.teamConfig.levels[1].stage = stage
    ctx.teamConfig.workflow.output_contract = {
      artifacts: [{ path: 'research-package.md', required: true }],
      completion_artifact: 'research-package.md',
    }

    const tool = createChainTool(ctx)
    const result = await tool.execute(
      'blocked-escalation',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )
    const escalationPath = path.join(dir, 'research', 'quality', 'escalation.md')
    const escalation = fs.readFileSync(escalationPath, 'utf8')
    const workflowOutput = fs.readFileSync(path.join(dir, 'research-package.md'), 'utf8')

    assert.match(readTextResult(result), /Chain Blocked/)
    assert.match(escalation, /status: "blocked"/)
    assert.match(escalation, /T1 still lacks the required primary authority/)
    assert.match(workflowOutput, /status: "blocked"/)
    assert.match(workflowOutput, /T1 still lacks the required primary authority/)
    assert.equal(ctx.state.levelStates.get('draft-chain')?.stageStatus, STAGE_LIFECYCLE_STATUS.BLOCKED)
    assert.equal(ctx.state.levelStates.get('draft-chain')?.engineState?.outputs.length, 0)
    assert.equal(isChainComplete(ctx.state.levelStates.get('draft-chain')?.engineState), false)
    assert.equal(
      isLevelReadyForGate(
        { id: 'draft-chain', stage } as any,
        dir,
        ctx,
      ),
      false,
    )

    const secondCall = await tool.execute(
      'do-not-complete',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )
    assert.doesNotMatch(readTextResult(secondCall), /Chain already complete/)
    assert.match(readTextResult(secondCall), /Chain already started/)
    assert.equal(ctx.state.levelStates.get('draft-chain')?.stageStatus, STAGE_LIFECYCLE_STATUS.BLOCKED)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a committed non-blocking chain output remains gate-ready after an agent timeout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-timeout-output-'))
  try {
    const ctx = makeContext(dir)
    const levelState = ctx.state.levelStates.get('draft-chain')!
    levelState.stageStatus = STAGE_LIFECYCLE_STATUS.BLOCKED
    levelState.engineState = {
      type: 'chain',
      currentStep: 2,
      totalSteps: 2,
      outputs: [{ agent: 'writer', text: 'Draft completed before timeout.' }],
    }
    fs.writeFileSync(
      path.join(dir, 'draft-package.md'),
      '# Completed Draft\n\nThe agent committed this output before its response timed out.\n',
    )

    assert.equal(
      isLevelReadyForGate(
        { id: 'draft-chain', stage: ctx.config } as any,
        dir,
        ctx,
      ),
      true,
    )

    levelState.stageStatus = STAGE_LIFECYCLE_STATUS.FAILED
    assert.equal(
      isLevelReadyForGate(
        { id: 'draft-chain', stage: ctx.config } as any,
        dir,
        ctx,
      ),
      false,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('handoff status reports progress after a completed runtime-owned run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), 'Incoming brief content')
    queuedResults = [
      { text: 'Writer draft' },
      { text: 'Editor polished draft' },
    ]

    const ctx = makeContext(dir)
    const tool = createChainTool(ctx)
    await tool.execute('call-1', undefined as any, undefined as any, undefined as any, undefined as any)
    const status = await tool.execute('call-2', { action: 'status' } as any, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(status)

    assert.match(text, /Step 2\/2/)
    assert.match(text, /writer: Writer draft/)
    assert.match(text, /editor: Editor polished draft/)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('handoff prefers the content written to the declared output path over raw agent narration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), 'Incoming brief content')
    fs.writeFileSync(path.join(dir, 'draft-package.md'), '# Canonical draft from file\n\nReal deliverable body')
    queuedResults = [
      { text: 'Writer status update' },
      { text: 'Editor progress report instead of the deliverable' },
    ]

    const ctx = makeContext(dir)
    const tool = createChainTool(ctx)
    const finalOutputPath = path.join(dir, 'draft-package.md')
    await tool.execute('call-1', undefined as any, undefined as any, undefined as any, undefined as any)

    const finalBody = fs.readFileSync(finalOutputPath, 'utf8')
    assert.match(finalBody, /Real deliverable body/)
    assert.doesNotMatch(finalBody, /Editor progress report instead of the deliverable/)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('handoff allows a status probe before the real chain start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), 'Incoming brief content')
    queuedResults = [
      { text: 'Writer draft' },
      { text: 'Editor polished draft' },
    ]

    const ctx = makeContext(dir)
    const tool = createChainTool(ctx)

    const status = await tool.execute('call-1', { action: 'status' } as any, undefined as any, undefined as any, undefined as any)
    assert.match(readTextResult(status), /Chain not started yet/)

    const started = await tool.execute('call-2', undefined as any, undefined as any, undefined as any, undefined as any)
    assert.match(readTextResult(started), /Chain Complete/)
    assert.equal(fs.existsSync(path.join(dir, 'draft-package.md')), true)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('handoff refuses to restart an already-started chain', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), 'Incoming brief content')
    queuedResults = [
      { text: 'Writer draft' },
      { text: 'Editor polished draft' },
    ]

    const ctx = makeContext(dir)
    const tool = createChainTool(ctx)

    const chainState = {
      type: 'chain',
      currentStep: 1,
      totalSteps: 2,
      outputs: [{ agent: 'writer', text: 'Writer draft' }],
    }
    ctx.state.levelStates.get('draft-chain')!.engineState = chainState as any
    ctx.state.levelStates.get('draft-chain')!.stageStatus = STAGE_LIFECYCLE_STATUS.RUNNING

    const result = await tool.execute('call-2', undefined as any, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(result)

    assert.match(text, /Chain already started for this level/)
    assert.equal(queuedResults.length, 2)
    assert.equal(fs.existsSync(path.join(dir, 'draft-package.md')), false)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a structured quality chain sends the quality output schema on every attempt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-quality-schema-'))
  try {
    writeQualityRuntimeArtifacts(dir)
    const ctx = makeContext(dir)
    const stage = {
      type: 'chain',
      sequence: ['editor'],
      config: {
        handoff_format: 'json',
        structured_output: 'deep_research_quality_verdict',
        output: { path: 'research/quality', format: 'current-verdict.json', user_review: false },
      },
    }
    ctx.config = stage
    ctx.teamConfig.levels[1].stage = stage
    observedOutputSchemas = []
    queuedResults = [{ text: fencedQualityApproval('critic-schema-zero') }]

    await runHandoff(ctx, 'quality-schema', 'Audit.')

    assert.equal(observedOutputSchemas.length, 1)
    assert.deepEqual(
      observedOutputSchemas[0],
      createDeepResearchQualityVerdictOutputSchema(),
      'the quality chain must send the quality verdict schema itself',
    )
  } finally {
    observedOutputSchemas = []
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an ordinary chain step sends no provider output schema', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-no-schema-'))
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), 'Incoming brief content')
    const ctx = makeContext(dir)
    observedOutputSchemas = []
    queuedResults = [{ text: 'Writer draft' }, { text: 'Editor polished draft' }]

    await runHandoff(ctx, 'no-schema', 'Draft the package.')

    assert.equal(observedOutputSchemas.length, 2)
    assert.deepEqual(observedOutputSchemas, [undefined, undefined])
  } finally {
    observedOutputSchemas = []
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
