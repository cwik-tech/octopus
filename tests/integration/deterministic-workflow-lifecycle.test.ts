import { describe, it, mock, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { requiredValue } from '../../core/required-value.js'

import { parseTeamConfig } from '../../parsers/team-config.js'
import { STAGE_TYPE } from '../../core/constants.js'
import type { ReviewStageConfig } from '../../core/types.js'
import { requireTeamRuntimeCapabilityIdentity } from '../../team-runtime/runtime-capability-context.js'

mock.module('../../team-runtime/experience-reflections.js', {
  namedExports: { runExperienceReflections: mock.fn(async () => {}) },
})
mock.module('../../domains/agent-execution/minutes.js', {
  namedExports: { generateMinutes: mock.fn(async () => {}) },
})

const { activatePendingStageEntry, tryAdvanceLevel } = await import('../../team-runtime/level-lifecycle.js')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..', '..')

function makeCallbacks() {
  return {
    registerLevelTools: mock.fn(),
    // These fixtures assert that the destination is armed at advance time, so
    // they exercise the runtime-owned branch. The host-managed branch, where
    // arming waits for the turn that enters the stage, is covered by I-13 in
    // tests/integration/routing-table-integration.test.ts.
    runtimeOwnsLevel: mock.fn(() => true),
    prepareHostForActiveLevel: mock.fn(async () => true),
    startActiveLevel: mock.fn(async () => false),
    persistState: mock.fn(),
    updateDashboard: mock.fn(),
  }
}

function makeExtCtx() {
  return { ui: { notify: mock.fn() } }
}

function buildCtx(teamConfig: any, currentLevelIndex: number, levelStates: Map<string, any>) {
  const sendUserMessage = mock.fn()
  const ctx = {
    teamConfig,
    teamRoot: repoRoot,
    inputFilesContent: '',
    agents: new Map(),
    rosterEntries: new Map(),
    teamRegistry: new Map(),
    bootEntry: null,
    state: {
      sessionId: 'integration-session',
      currentLevelIndex,
      levelStates,
      totalCost: 0,
      startTime: 0,
      timerStarted: false,
      endTime: null,
      spawnDepth: 0,
    },
    agentMetrics: new Map(),
    coordinatorRunId: 0,
    levelAdvancedCoordinatorRunId: null,
    activeSpawnCount: 0,
    setupMode: false,
    configErrors: [],
    lastCtx: null,
    refreshTimer: null,
    activeDelegations: new Map(),
    blockedToolCallIds: new Set(),
    usedLevelToolsThisCoordinatorTurn: new Set(),
    toolFailureFollowUpRunIds: new Set(),
    delegatedAutostartOwnsStage: false,
    pendingStageEntryLevelId: null,
    currentRegisteredTools: [],
    currentToolDefinitions: new Map(),
    pendingFollowUps: [],
    pendingFollowUpTimer: null,
    pi: { sendUserMessage },
    ENGINE_TOOLS: new Set(),
    shutdownController: new AbortController(),
    budgetLedger: undefined,
  }

  return { ctx, sendUserMessage }
}

/**
 * The shape a scheduled single-agent target is generated with: one chain level
 * and no gates at all (`services/scheduled-agent-target.ts`).
 */
function makeGatelessChainTeam(workspacePath: string) {
  return {
    team: { name: 'scheduled-single-agent', description: 'test', version: '1.0.0' },
    workspace: { path: workspacePath, watch: false },
    models: {},
    agents: [],
    levels: [
      {
        id: 'run',
        name: 'Run',
        order: 0,
        stage: {
          type: STAGE_TYPE.CHAIN,
          sequence: ['web-researcher'],
          config: { output: { format: 'result.md', user_review: false } },
        },
      },
    ],
    gates: [],
  }
}

function makeLevelStates(teamConfig: any, activeIndex: number, activeEngineState: any) {
  return new Map<string, any>(teamConfig.levels.map((level: any, index: number) => [
    level.id,
    {
      status: index === activeIndex ? 'active' : index < activeIndex ? 'completed' : 'pending',
      stageStatus: index === activeIndex ? 'running' : index < activeIndex ? 'completed' : 'not_started',
      engineState: index === activeIndex ? activeEngineState : null,
      loopbackCount: 0,
    },
  ]))
}

describe('deterministic workflow lifecycle integration', () => {
  let tmpDir: string

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deterministic-workflow-'))
  })

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.mkdirSync(tmpDir, { recursive: true })
  })

  it('advances a blocked chain when its non-blocking completion artifact was committed before timeout', async () => {
    const parsed = parseTeamConfig(path.join(repoRoot, 'teams', 'writing-team', 'team.yaml'))
    assert.equal(parsed.errors.length, 0)
    assert.ok(parsed.config)

    const teamConfig = parsed.config!
    teamConfig.workspace.path = path.join(tmpDir, 'workspace')
    const assignmentPath = path.join(teamConfig.workspace.path, 'assignments', 'integration-session')
    fs.mkdirSync(assignmentPath, { recursive: true })
    fs.writeFileSync(
      path.join(assignmentPath, 'draft-package.md'),
      '# Completed Draft\n\nThe writer committed this draft before its response timed out.\n',
    )

    const levelStates = makeLevelStates(teamConfig, 0, {
      type: STAGE_TYPE.CHAIN,
      currentStep: 2,
      totalSteps: 2,
      outputs: [{ agent: 'brief-builder', text: 'brief' }],
    })
    levelStates.get('brief-and-draft')!.stageStatus = 'blocked'
    const { ctx } = buildCtx(teamConfig, 0, levelStates)
    const extCtx = makeExtCtx()
    const callbacks = makeCallbacks()
    ;(callbacks.startActiveLevel as ReturnType<typeof mock.fn>).mock.mockImplementation(async () => true)

    await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

    assert.equal(ctx.state.levelStates.get('brief-and-draft')?.status, 'completed')
    assert.equal(ctx.state.levelStates.get('brief-and-draft')?.stageStatus, 'completed')
    assert.equal(ctx.state.currentLevelIndex, 1)
    assert.equal((callbacks.startActiveLevel as ReturnType<typeof mock.fn>).mock.calls.length, 1)
  })

  it('writing-team chain gate writes boundary artifacts and autostarts the runtime-owned review stage inline', async () => {
    const parsed = parseTeamConfig(path.join(repoRoot, 'teams', 'writing-team', 'team.yaml'))
    assert.equal(parsed.errors.length, 0)
    assert.ok(parsed.config)

    const teamConfig = parsed.config!
    teamConfig.workspace.path = path.join(tmpDir, 'workspace')

    const assignmentPath = path.join(teamConfig.workspace.path, 'assignments', 'integration-session')
    fs.mkdirSync(assignmentPath, { recursive: true })
    fs.writeFileSync(path.join(assignmentPath, 'draft-package.md'), '# Draft package')

    const levelStates = new Map(teamConfig.levels.map((level, index) => {
      const engineState =
        index === 0
          ? { type: STAGE_TYPE.CHAIN, currentStep: 2, totalSteps: 2, outputs: [{ agent: 'brief-builder', text: 'brief' }, { agent: 'writer', text: 'draft' }] }
          : null
      return [level.id, {
        status: index === 0 ? 'active' : 'pending',
        stageStatus: index === 0 ? 'running' : 'not_started',
        engineState,
        loopbackCount: 0,
      }]
    }))

    const sendUserMessage = mock.fn()
    const ctx = {
      teamConfig,
      teamRoot: repoRoot,
      inputFilesContent: '',
      agents: new Map(),
      rosterEntries: new Map(),
      teamRegistry: new Map(),
      bootEntry: null,
      state: {
        sessionId: 'integration-session',
        currentLevelIndex: 0,
        levelStates,
        totalCost: 0,
        startTime: 0,
        timerStarted: false,
        endTime: null,
        spawnDepth: 0,
      },
      agentMetrics: new Map(),
      coordinatorRunId: 0,
      levelAdvancedCoordinatorRunId: null,
      activeSpawnCount: 0,
      setupMode: false,
      configErrors: [],
      lastCtx: null,
      refreshTimer: null,
      activeDelegations: new Map(),
      blockedToolCallIds: new Set(),
      usedLevelToolsThisCoordinatorTurn: new Set(),
      toolFailureFollowUpRunIds: new Set(),
      pendingStageEntryLevelId: null,
      currentRegisteredTools: [],
      currentToolDefinitions: new Map(),
      pendingFollowUps: [],
      pendingFollowUpTimer: null,
      pi: { sendUserMessage },
      ENGINE_TOOLS: new Set(),
      shutdownController: new AbortController(),
      budgetLedger: undefined,
    }

    const extCtx = makeExtCtx()
    const callbacks = makeCallbacks()
    ;(callbacks.startActiveLevel as ReturnType<typeof mock.fn>).mock.mockImplementation(async () => true)

    await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

    assert.equal(ctx.state.currentLevelIndex, 1)
    assert.equal(ctx.state.levelStates.get('brief-and-draft')?.status, 'completed')
    assert.equal(ctx.state.levelStates.get('editorial-review')?.status, 'active')
    assert.equal(ctx.state.levelStates.get('editorial-review')?.stageStatus, 'ready')
    assert.equal(ctx.pendingStageEntryLevelId, null)
    assert.equal((callbacks.registerLevelTools as ReturnType<typeof mock.fn>).mock.calls.length, 1)
    assert.equal((callbacks.startActiveLevel as ReturnType<typeof mock.fn>).mock.calls.length, 1)
    assert.equal((sendUserMessage as ReturnType<typeof mock.fn>).mock.calls.length, 0)
    assert.equal((callbacks.persistState as ReturnType<typeof mock.fn>).mock.calls.length, 1)

    const gateReportPath = path.join(assignmentPath, 'gate-checks', 'gate-0-brief-and-draft-to-editorial-review.md')
    const boundaryPath = path.join(assignmentPath, 'gate-checks', 'boundary-0-brief-and-draft-to-editorial-review.md')
    assert.ok(fs.existsSync(gateReportPath))
    assert.ok(fs.existsSync(boundaryPath))
    assert.match(fs.readFileSync(gateReportPath, 'utf8'), /## Boundary Contract/)
    assert.match(fs.readFileSync(boundaryPath, 'utf8'), /draft-package\.md/)
  })

  it('autostarts a runtime-owned follow-up stage inline when the next level has no coordinator', async () => {
    const parsed = parseTeamConfig(path.join(repoRoot, 'teams', 'writing-team', 'team.yaml'))
    assert.equal(parsed.errors.length, 0)
    assert.ok(parsed.config)

    const teamConfig = requiredValue(parsed.config, 'parsed writing team config')
    teamConfig.workspace.path = path.join(tmpDir, 'workspace')
    const secondLevel = requiredValue(teamConfig.levels[1], 'writing review level')
    const reviewStage = secondLevel.stage
    assert.equal(reviewStage.type, STAGE_TYPE.REVIEW)
    teamConfig.levels[1] = {
      ...secondLevel,
      stage: {
        type: STAGE_TYPE.REVIEW,
        producer: 'writer',
        reviewer: 'editor',
        config: {
          ...reviewStage.config,
        },
      },
    }

    const assignmentPath = path.join(teamConfig.workspace.path, 'assignments', 'integration-session')
    fs.mkdirSync(assignmentPath, { recursive: true })
    fs.writeFileSync(path.join(assignmentPath, 'draft-package.md'), '# Draft package')

    const levelStates = new Map(teamConfig.levels.map((level, index) => {
      const engineState =
        index === 0
          ? { type: STAGE_TYPE.CHAIN, currentStep: 2, totalSteps: 2, outputs: [{ agent: 'brief-builder', text: 'brief' }, { agent: 'writer', text: 'draft' }] }
          : null
      return [level.id, {
        status: index === 0 ? 'active' : 'pending',
        stageStatus: index === 0 ? 'running' : 'not_started',
        engineState,
        loopbackCount: 0,
      }]
    }))

    const sendUserMessage = mock.fn()
    const ctx = {
      teamConfig,
      teamRoot: repoRoot,
      inputFilesContent: '',
      agents: new Map(),
      rosterEntries: new Map(),
      teamRegistry: new Map(),
      bootEntry: null,
      state: {
        sessionId: 'integration-session',
        currentLevelIndex: 0,
        levelStates,
        totalCost: 0,
        startTime: 0,
        timerStarted: false,
        endTime: null,
        spawnDepth: 0,
      },
      agentMetrics: new Map(),
      coordinatorRunId: 0,
      levelAdvancedCoordinatorRunId: null,
      activeSpawnCount: 0,
      setupMode: false,
      configErrors: [],
      lastCtx: null,
      refreshTimer: null,
      activeDelegations: new Map(),
      blockedToolCallIds: new Set(),
      usedLevelToolsThisCoordinatorTurn: new Set(),
      toolFailureFollowUpRunIds: new Set(),
      pendingStageEntryLevelId: null,
      currentRegisteredTools: [],
      pendingFollowUps: [],
      pi: { sendUserMessage },
      ENGINE_TOOLS: new Set(),
      shutdownController: new AbortController(),
      budgetLedger: undefined,
    }

    const extCtx = makeExtCtx()
    const callbacks = makeCallbacks()
    ;(callbacks.startActiveLevel as ReturnType<typeof mock.fn>).mock.mockImplementation(async () => true)

    await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

    assert.equal(ctx.state.currentLevelIndex, 1)
    assert.equal(ctx.pendingStageEntryLevelId, null)
    assert.equal((callbacks.registerLevelTools as ReturnType<typeof mock.fn>).mock.calls.length, 1)
    assert.equal((callbacks.startActiveLevel as ReturnType<typeof mock.fn>).mock.calls.length, 1)
    assert.equal((callbacks.persistState as ReturnType<typeof mock.fn>).mock.calls.length, 1)
    assert.equal((sendUserMessage as ReturnType<typeof mock.fn>).mock.calls.length, 0)
  })

  it('writing-team completion gate marks the workflow complete through the real lifecycle path', async () => {
    const parsed = parseTeamConfig(path.join(repoRoot, 'teams', 'writing-team', 'team.yaml'))
    assert.equal(parsed.errors.length, 0)
    assert.ok(parsed.config)

    const teamConfig = parsed.config!
    teamConfig.workspace.path = path.join(tmpDir, 'workspace')

    const assignmentPath = path.join(teamConfig.workspace.path, 'assignments', 'integration-session')
    fs.mkdirSync(assignmentPath, { recursive: true })
    fs.writeFileSync(path.join(assignmentPath, 'final-draft.md'), '# Final draft')

    const levelStates = new Map(teamConfig.levels.map((level, index) => {
      const engineState =
        index === 1
          ? { type: STAGE_TYPE.REVIEW, iteration: 1, maxIterations: 3, lastVerdict: 'approve', lastFeedback: '' }
          : null
      return [level.id, {
        status: index === 1 ? 'active' : 'completed',
        stageStatus: index === 1 ? 'running' : 'completed',
        engineState,
        loopbackCount: 0,
      }]
    }))

    const sendUserMessage = mock.fn()
    const ctx = {
      teamConfig,
      teamRoot: repoRoot,
      inputFilesContent: '',
      agents: new Map(),
      rosterEntries: new Map(),
      teamRegistry: new Map(),
      bootEntry: null,
      state: {
        sessionId: 'integration-session',
        currentLevelIndex: 1,
        levelStates,
        totalCost: 0,
        startTime: 0,
        timerStarted: false,
        endTime: null,
        spawnDepth: 0,
      },
      agentMetrics: new Map(),
      coordinatorRunId: 0,
      levelAdvancedCoordinatorRunId: null,
      activeSpawnCount: 0,
      setupMode: false,
      configErrors: [],
      lastCtx: null,
      refreshTimer: null,
      activeDelegations: new Map(),
      blockedToolCallIds: new Set(),
      usedLevelToolsThisCoordinatorTurn: new Set(),
      toolFailureFollowUpRunIds: new Set(),
      pendingStageEntryLevelId: null,
      currentRegisteredTools: [],
      currentToolDefinitions: new Map(),
      pendingFollowUps: [],
      pendingFollowUpTimer: null,
      pi: { sendUserMessage },
      ENGINE_TOOLS: new Set(),
      shutdownController: new AbortController(),
      budgetLedger: undefined,
    }

    const extCtx = makeExtCtx()
    const callbacks = makeCallbacks()

    await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

    assert.equal(ctx.state.levelStates.get('editorial-review')?.status, 'completed')
    assert.equal(ctx.state.levelStates.get('editorial-review')?.stageStatus, 'completed')
    assert.ok(ctx.state.endTime)
    assert.equal((callbacks.persistState as ReturnType<typeof mock.fn>).mock.calls.length, 1)
    assert.equal((sendUserMessage as ReturnType<typeof mock.fn>).mock.calls.length, 0)
  })

  it('writing-team blocked review completion gate does not enqueue a runtime notice for coordinator-less deterministic stages', async () => {
    const parsed = parseTeamConfig(path.join(repoRoot, 'teams', 'writing-team', 'team.yaml'))
    assert.equal(parsed.errors.length, 0)
    assert.ok(parsed.config)

    const teamConfig = parsed.config!
    teamConfig.workspace.path = path.join(tmpDir, 'workspace')

    const assignmentPath = path.join(teamConfig.workspace.path, 'assignments', 'integration-session')
    fs.mkdirSync(assignmentPath, { recursive: true })

    const levelStates = new Map(teamConfig.levels.map((level, index) => {
      const engineState =
        index === 1
          ? { type: STAGE_TYPE.REVIEW, iteration: 3, maxIterations: 3, lastVerdict: 'revise', lastFeedback: 'REVISE' }
          : null
      return [level.id, {
        status: index === 1 ? 'active' : 'completed',
        stageStatus: index === 1 ? 'blocked' : 'completed',
        engineState,
        loopbackCount: 0,
      }]
    }))

    const sendUserMessage = mock.fn()
    const ctx = {
      teamConfig,
      teamRoot: repoRoot,
      inputFilesContent: '',
      agents: new Map(),
      rosterEntries: new Map(),
      teamRegistry: new Map(),
      bootEntry: null,
      state: {
        sessionId: 'integration-session',
        currentLevelIndex: 1,
        levelStates,
        totalCost: 0,
        startTime: 0,
        timerStarted: false,
        endTime: null,
        spawnDepth: 0,
      },
      agentMetrics: new Map(),
      coordinatorRunId: 0,
      levelAdvancedCoordinatorRunId: null,
      activeSpawnCount: 0,
      setupMode: false,
      configErrors: [],
      lastCtx: null,
      refreshTimer: null,
      activeDelegations: new Map(),
      blockedToolCallIds: new Set(),
      currentRegisteredTools: [],
      currentToolDefinitions: new Map(),
      pendingFollowUps: [],
      pendingFollowUpTimer: null,
      pi: { sendUserMessage },
      ENGINE_TOOLS: new Set(),
      shutdownController: new AbortController(),
      budgetLedger: undefined,
    }

    const extCtx = makeExtCtx()
    const callbacks = makeCallbacks()

    await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

    assert.equal(ctx.state.levelStates.get('editorial-review')?.status, 'active')
    assert.equal(ctx.state.levelStates.get('editorial-review')?.stageStatus, 'blocked')
    assert.equal((sendUserMessage as ReturnType<typeof mock.fn>).mock.calls.length, 0)
    const notifyCalls = (extCtx.ui.notify as ReturnType<typeof mock.fn>).mock.calls
    assert.ok(
      notifyCalls.some((c) => String(c.arguments[0]).includes("expected output artifact 'final-draft.md' was not produced")),
      `Expected blocked-stage warning, got: ${JSON.stringify(notifyCalls.map((c) => c.arguments[0]))}`,
    )
  })

  it('pipeline gate autostarts a runtime-owned follow-up review stage inline', async () => {
    const workspacePath = path.join(tmpDir, 'workspace')
    const assignmentPath = path.join(workspacePath, 'assignments', 'integration-session')
    const runtimePlanPath = path.join(assignmentPath, '.runtime', 'pipeline', 'build-plan', 'plan.md')
    fs.mkdirSync(path.dirname(runtimePlanPath), { recursive: true })
    fs.writeFileSync(runtimePlanPath, `
# Plan: Pipeline Integration
**Status:** completed

### S1: Done
#### T1: Finalize pipeline output
- **Agent:** writer
- **Status:** completed
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** pipeline-output.md
`)
    fs.writeFileSync(path.join(assignmentPath, 'pipeline-output.md'), '# Pipeline output')

    const teamConfig = {
      team: { name: 'pipeline-test', description: 'test', version: '1.0.0' },
      workspace: { path: workspacePath, watch: false },
      models: {},
      agents: [],
      levels: [
        {
          id: 'build-plan',
          name: 'Build Plan',
          order: 0,
          stage: {
            type: STAGE_TYPE.PIPELINE,
            config: {
              output: { format: 'pipeline-output.md', user_review: false },
            },
          },
        },
        {
          id: 'review-plan',
          name: 'Review Plan',
          order: 1,
          stage: {
            type: STAGE_TYPE.REVIEW,
            producer: 'writer',
            reviewer: 'editor',
            config: {
              max_iterations: 2,
              output: { format: 'final-draft.md', user_review: false },
            },
          },
        },
      ],
      gates: [
        {
          from: 'build-plan',
          to: 'review-plan',
          condition: { type: 'artifact_exists', artifact: 'pipeline-output.md' },
        },
      ],
    }

    const levelStates = makeLevelStates(teamConfig, 0, {
      type: STAGE_TYPE.PIPELINE,
      planPath: runtimePlanPath,
      completedSprintIds: ['S1'],
      activeTaskIds: [],
    })
    const { ctx, sendUserMessage } = buildCtx(teamConfig, 0, levelStates)
    const extCtx = makeExtCtx()
    const callbacks = makeCallbacks()
    ;(callbacks.startActiveLevel as ReturnType<typeof mock.fn>).mock.mockImplementation(async () => true)

    await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

    assert.equal(ctx.state.currentLevelIndex, 1)
    assert.equal(ctx.pendingStageEntryLevelId, null)
    assert.equal((callbacks.registerLevelTools as ReturnType<typeof mock.fn>).mock.calls.length, 1)
    assert.equal((callbacks.startActiveLevel as ReturnType<typeof mock.fn>).mock.calls.length, 1)
    assert.equal((sendUserMessage as ReturnType<typeof mock.fn>).mock.calls.length, 0)
  })

  it('broadcast gate autostarts a runtime-owned follow-up review stage inline', async () => {
    const workspacePath = path.join(tmpDir, 'workspace')
    const assignmentPath = path.join(workspacePath, 'assignments', 'integration-session')
    fs.mkdirSync(assignmentPath, { recursive: true })
    fs.writeFileSync(path.join(assignmentPath, 'broadcast-output.md'), '# Broadcast output')

    const teamConfig = {
      team: { name: 'broadcast-test', description: 'test', version: '1.0.0' },
      workspace: { path: workspacePath, watch: false },
      models: {},
      agents: [],
      levels: [
        {
          id: 'fan-out',
          name: 'Fan Out',
          order: 0,
          stage: {
            type: STAGE_TYPE.BROADCAST,
            fan_out: ['alpha'],
            config: {
              aggregation: 'merge',
              output: { format: 'broadcast-output.md', user_review: false },
            },
          },
        },
        {
          id: 'editorial-review',
          name: 'Editorial Review',
          order: 1,
          stage: {
            type: STAGE_TYPE.REVIEW,
            producer: 'writer',
            reviewer: 'editor',
            config: {
              max_iterations: 2,
              output: { format: 'final-draft.md', user_review: false },
            },
          },
        },
      ],
      gates: [
        {
          from: 'fan-out',
          to: 'editorial-review',
          condition: { type: 'artifact_exists', artifact: 'broadcast-output.md' },
        },
      ],
    }

    const levelStates = makeLevelStates(teamConfig, 0, {
      type: STAGE_TYPE.BROADCAST,
      responses: [],
      aggregatedResult: 'Merged result',
    })
    const { ctx, sendUserMessage } = buildCtx(teamConfig, 0, levelStates)
    const extCtx = makeExtCtx()
    const callbacks = makeCallbacks()
    ;(callbacks.startActiveLevel as ReturnType<typeof mock.fn>).mock.mockImplementation(async () => true)

    await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

    assert.equal(ctx.state.currentLevelIndex, 1)
    assert.equal(ctx.pendingStageEntryLevelId, null)
    assert.equal((callbacks.registerLevelTools as ReturnType<typeof mock.fn>).mock.calls.length, 1)
    assert.equal((callbacks.startActiveLevel as ReturnType<typeof mock.fn>).mock.calls.length, 1)
    assert.equal((sendUserMessage as ReturnType<typeof mock.fn>).mock.calls.length, 0)
  })

  it('autostarts a runtime-owned stage with a configured coordinator instead of handing it to a host model', async () => {
    const parsed = parseTeamConfig(path.join(process.cwd(), 'teams', 'writing-team', 'team.yaml'))
    assert.equal(parsed.errors.length, 0)
    assert.ok(parsed.config)

    const teamConfig = parsed.config!
    teamConfig.workspace.path = path.join(tmpDir, 'workspace')
    const reviewLevel = requiredValue(teamConfig.levels[1], 'Expected the editorial review level')
    ;(reviewLevel.stage as ReviewStageConfig).coordinator = 'editor'
    ;(reviewLevel.stage as ReviewStageConfig).config.output.user_review = false

    const assignmentPath = path.join(teamConfig.workspace.path, 'assignments', 'integration-session')
    fs.mkdirSync(assignmentPath, { recursive: true })
    fs.writeFileSync(path.join(assignmentPath, 'draft-package.md'), '# Draft package')

    const levelStates = makeLevelStates(teamConfig, 0, {
      type: STAGE_TYPE.CHAIN,
      currentStep: 2,
      totalSteps: 2,
      outputs: [{ agent: 'brief-builder', text: 'brief' }, { agent: 'writer', text: 'draft' }],
    })
    const { ctx } = buildCtx(teamConfig, 0, levelStates)
    const extCtx = makeExtCtx()
    const callbacks = makeCallbacks()
    ;(callbacks.startActiveLevel as ReturnType<typeof mock.fn>).mock.mockImplementation(async () => true)

    await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

    assert.equal(ctx.state.currentLevelIndex, 1)
    assert.equal(ctx.pendingStageEntryLevelId, null)
    assert.equal((callbacks.registerLevelTools as ReturnType<typeof mock.fn>).mock.calls.length, 1)
    assert.equal((callbacks.startActiveLevel as ReturnType<typeof mock.fn>).mock.calls.length, 1)
    assert.equal(ctx.pendingFollowUps.length, 0)
  })

  it('autostarts a later discussion through its ordinary-provider lead instead of handing it to a host model', async () => {
    const workspacePath = path.join(tmpDir, 'workspace')
    const assignmentPath = path.join(workspacePath, 'assignments', 'integration-session')
    fs.mkdirSync(assignmentPath, { recursive: true })
    fs.writeFileSync(path.join(assignmentPath, 'draft.md'), '# Draft')

    const teamConfig = {
      team: { name: 'discussion-transition', description: 'test', version: '1.0.0' },
      workspace: { path: workspacePath, watch: false },
      models: {},
      agents: [],
      levels: [
        {
          id: 'draft',
          name: 'Draft',
          order: 0,
          stage: {
            type: STAGE_TYPE.CHAIN,
            sequence: ['writer'],
            config: {
              output: { format: 'draft.md', user_review: false },
            },
          },
        },
        {
          id: 'discussion',
          name: 'Discussion',
          order: 1,
          stage: {
            type: STAGE_TYPE.DISCUSSION,
            coordinator: 'lead',
            participants: ['reviewer'],
            config: {
              mode: 'deliberate',
              min_rounds: 1,
              max_rounds: 2,
              output: { format: 'discussion.md', user_review: false },
            },
          },
        },
      ],
      gates: [
        {
          from: 'draft',
          to: 'discussion',
          condition: { type: 'artifact_exists', artifact: 'draft.md' },
        },
      ],
    }
    const levelStates = makeLevelStates(teamConfig, 0, {
      type: STAGE_TYPE.CHAIN,
      currentStep: 1,
      totalSteps: 1,
      outputs: [{ agent: 'writer', text: 'draft' }],
    })
    const { ctx, sendUserMessage } = buildCtx(teamConfig, 0, levelStates)
    const extCtx = makeExtCtx()
    const callbacks = makeCallbacks()
    ;(callbacks.startActiveLevel as ReturnType<typeof mock.fn>).mock.mockImplementation(async () => true)

    await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

    assert.equal(ctx.state.currentLevelIndex, 1)
    assert.equal(ctx.pendingStageEntryLevelId, null)
    assert.equal((callbacks.registerLevelTools as ReturnType<typeof mock.fn>).mock.calls.length, 1)
    assert.equal((callbacks.startActiveLevel as ReturnType<typeof mock.fn>).mock.calls.length, 1)
    assert.equal((sendUserMessage as ReturnType<typeof mock.fn>).mock.calls.length, 0)
    assert.equal(ctx.pendingFollowUps.length, 0)
  })

  it('advances a completed Team-chat discussion through its outgoing gate instead of ending the whole run', async () => {
    const workspacePath = path.join(tmpDir, 'workspace')
    const assignmentPath = path.join(workspacePath, 'assignments', 'integration-session')
    fs.mkdirSync(assignmentPath, { recursive: true })
    fs.writeFileSync(path.join(assignmentPath, 'discussion.md'), '# Accepted synthesis')
    const teamConfig = {
      team: { name: 'discussion-to-draft', description: 'test', version: '1.0.0' },
      workspace: { path: workspacePath, watch: false },
      models: {},
      agents: [],
      levels: [
        {
          id: 'discussion',
          name: 'Discussion',
          order: 0,
          stage: {
            type: STAGE_TYPE.DISCUSSION,
            coordinator: 'lead',
            participants: ['reviewer'],
            config: {
              mode: 'deliberate',
              min_rounds: 1,
              max_rounds: 1,
              output: { format: 'discussion.md', user_review: false },
            },
          },
        },
        {
          id: 'draft',
          name: 'Draft',
          order: 1,
          stage: {
            type: STAGE_TYPE.CHAIN,
            sequence: ['writer'],
            config: { output: { format: 'draft.md', user_review: false } },
          },
        },
      ],
      gates: [{
        from: 'discussion',
        to: 'draft',
        condition: { type: 'artifact_exists', artifact: 'discussion.md' },
      }],
    }
    const levelStates = makeLevelStates(teamConfig, 0, {
      type: STAGE_TYPE.DISCUSSION,
      round: 1,
      messages: [],
      outputPath: assignmentPath,
      approvedRoster: ['reviewer'],
      rosterAnnounced: true,
    })
    const discussionState = levelStates.get('discussion')
    assert.ok(discussionState)
    discussionState.stageStatus = 'completed'
    const { ctx } = buildCtx(teamConfig, 0, levelStates)
    const extCtx = makeExtCtx()
    const requestRunCompletion = mock.fn()
    const callbacks = {
      ...makeCallbacks(),
      teamChatMode: true,
      requestRunCompletion,
    }
    ;(callbacks.startActiveLevel as ReturnType<typeof mock.fn>).mock.mockImplementation(async () => true)

    await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

    assert.equal(ctx.state.currentLevelIndex, 1)
    assert.equal(ctx.state.endTime, null)
    assert.equal(requestRunCompletion.mock.calls.length, 0)
    assert.equal((callbacks.startActiveLevel as ReturnType<typeof mock.fn>).mock.calls.length, 1)
  })

  it('keeps a deferred stage pending when capability authority is unavailable at entry', () => {
    const state = {
      pendingStageEntryLevelId: 'editorial-review',
      levelAdvancedCoordinatorRunId: 4,
      usedLevelToolsThisCoordinatorTurn: new Set(['handoff']),
    }
    const clearInvocationAdmissions = mock.fn()
    const registerLevelTools = mock.fn(() => {
      requireTeamRuntimeCapabilityIdentity({
        location: undefined,
        runtimeSessionId: 'managed-session',
        environment: {},
      })
    })

    assert.throws(
      () => activatePendingStageEntry({
        state,
        currentLevelId: 'editorial-review',
        clearInvocationAdmissions,
        registerLevelTools,
      }),
      /Managed Team Runtime capability authority is unavailable/,
    )

    assert.equal(state.pendingStageEntryLevelId, 'editorial-review')
    assert.equal(registerLevelTools.mock.calls.length, 1)
    assert.equal(clearInvocationAdmissions.mock.calls.length, 1)
  })

  it('keeps a user-review output stage runtime-owned instead of handing it to a host model', async () => {
    const parsed = parseTeamConfig(path.join(process.cwd(), 'teams', 'writing-team', 'team.yaml'))
    assert.equal(parsed.errors.length, 0)
    assert.ok(parsed.config)

    const teamConfig = parsed.config!
    teamConfig.workspace.path = path.join(tmpDir, 'workspace')
    ;(teamConfig.levels[1]!.stage as ReviewStageConfig).config.output.user_review = true

    const assignmentPath = path.join(teamConfig.workspace.path, 'assignments', 'integration-session')
    fs.mkdirSync(assignmentPath, { recursive: true })
    fs.writeFileSync(path.join(assignmentPath, 'draft-package.md'), '# Draft package')

    const levelStates = makeLevelStates(teamConfig, 0, {
      type: STAGE_TYPE.CHAIN,
      currentStep: 2,
      totalSteps: 2,
      outputs: [{ agent: 'brief-builder', text: 'brief' }, { agent: 'writer', text: 'draft' }],
    })
    const { ctx } = buildCtx(teamConfig, 0, levelStates)
    ctx.delegatedAutostartOwnsStage = true
    const extCtx = makeExtCtx()
    const callbacks = makeCallbacks()
    ;(callbacks.startActiveLevel as ReturnType<typeof mock.fn>).mock.mockImplementation(async () => true)

    await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

    assert.equal(ctx.state.currentLevelIndex, 1)
    assert.equal(ctx.pendingStageEntryLevelId, null)
    assert.equal((callbacks.registerLevelTools as ReturnType<typeof mock.fn>).mock.calls.length, 1)
    assert.equal((callbacks.startActiveLevel as ReturnType<typeof mock.fn>).mock.calls.length, 1)
    assert.equal(ctx.pendingFollowUps.length, 0)
  })

  it('finishes a gate-less team once its final stage has produced its output', async () => {
    const workspacePath = path.join(tmpDir, 'workspace')
    const assignmentPath = path.join(workspacePath, 'assignments', 'integration-session')
    fs.mkdirSync(assignmentPath, { recursive: true })
    fs.writeFileSync(path.join(assignmentPath, 'result.md'), '# Research result')
    const teamConfig = makeGatelessChainTeam(workspacePath)
    const levelStates = makeLevelStates(teamConfig, 0, {
      type: STAGE_TYPE.CHAIN,
      currentStep: 1,
      totalSteps: 1,
      outputs: [{ agent: 'web-researcher', text: 'result' }],
    })
    const { ctx } = buildCtx(teamConfig, 0, levelStates)
    const extCtx = makeExtCtx()
    const requestRunCompletion = mock.fn()
    const callbacks = { ...makeCallbacks(), requestRunCompletion }

    await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

    assert.deepEqual(
      requestRunCompletion.mock.calls.map((call) => (call.arguments[0] as { levelId: string }).levelId),
      ['run'],
    )
    assert.equal(ctx.state.levelStates.get('run')?.status, 'completed')
    assert.equal(ctx.state.levelStates.get('run')?.stageStatus, 'completed')
  })

  it('leaves a gate-less team running while its final stage still has work left', async () => {
    const workspacePath = path.join(tmpDir, 'workspace')
    const assignmentPath = path.join(workspacePath, 'assignments', 'integration-session')
    fs.mkdirSync(assignmentPath, { recursive: true })
    const teamConfig = makeGatelessChainTeam(workspacePath)
    const levelStates = makeLevelStates(teamConfig, 0, {
      type: STAGE_TYPE.CHAIN,
      currentStep: 1,
      totalSteps: 2,
      outputs: [{ agent: 'web-researcher', text: 'partial' }],
    })
    const { ctx } = buildCtx(teamConfig, 0, levelStates)
    const extCtx = makeExtCtx()
    const requestRunCompletion = mock.fn()
    const callbacks = { ...makeCallbacks(), requestRunCompletion }

    await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

    assert.equal(requestRunCompletion.mock.calls.length, 0)
    assert.equal(ctx.state.levelStates.get('run')?.status, 'active')
    assert.equal(ctx.state.levelStates.get('run')?.stageStatus, 'running')
  })

  it('gives every level a loopback re-enters a new visit, not just the gate target', async () => {
    // Dispatch identities are keyed by visit, so a level that re-runs without a
    // new one republishes under its first visit's identities and the durable
    // message boundary drops it as a duplicate. `loopbackCount` cannot serve:
    // it counts only loopbacks that TARGETED a level, because it also bounds
    // `max_loopbacks`.
    const workspacePath = path.join(tmpDir, 'workspace')
    const assignmentPath = path.join(workspacePath, 'assignments', 'integration-session')
    fs.mkdirSync(assignmentPath, { recursive: true })
    fs.writeFileSync(path.join(assignmentPath, 'audit.md'), 'verdict: REVISE')
    const chainStage = (format: string) => ({
      type: STAGE_TYPE.CHAIN,
      sequence: ['writer'],
      config: { output: { format, user_review: false } },
    })
    const teamConfig = {
      team: { name: 'loopback-visits', description: 'test', version: '1.0.0' },
      workspace: { path: workspacePath, watch: false },
      models: {},
      agents: [],
      levels: [
        { id: 'draft', name: 'Draft', order: 0, stage: chainStage('draft.md') },
        { id: 'middle', name: 'Middle', order: 1, stage: chainStage('middle.md') },
        { id: 'audit', name: 'Audit', order: 2, stage: chainStage('audit.md') },
      ],
      gates: [{
        from: 'audit',
        to: 'draft',
        reset_scope: 'target_through_source',
        condition: { type: 'artifact_exists', artifact: 'audit.md' },
      }],
    }
    const levelStates = makeLevelStates(teamConfig, 2, {
      type: STAGE_TYPE.CHAIN,
      currentStep: 1,
      totalSteps: 1,
      outputs: [{ agent: 'writer', text: 'audit' }],
    })
    const { ctx } = buildCtx(teamConfig, 2, levelStates)
    const extCtx = makeExtCtx()
    const callbacks = makeCallbacks()
    ;(callbacks.startActiveLevel as ReturnType<typeof mock.fn>).mock.mockImplementation(async () => true)

    await tryAdvanceLevel(extCtx as never, ctx as never, callbacks as never)

    assert.equal(ctx.state.currentLevelIndex, 0)
    // Every level the loopback re-enters starts a new visit ...
    for (const levelId of ['draft', 'middle', 'audit']) {
      assert.equal(
        ctx.state.levelStates.get(levelId)?.visitCount,
        1,
        `${levelId} should have started a second visit`,
      )
    }
    // ... while only the gate's target spends a loopback against its limit.
    assert.equal(ctx.state.levelStates.get('draft')?.loopbackCount, 1)
    assert.equal(ctx.state.levelStates.get('middle')?.loopbackCount, 0)
    assert.equal(ctx.state.levelStates.get('audit')?.loopbackCount, 0)
  })
})
