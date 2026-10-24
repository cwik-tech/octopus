/**
 * Every Team engine records its accepted answers as durable chat messages.
 *
 * The defect that motivated this suite was mode-shaped: discussion recorded a
 * message and every other engine did not, so a Team that finished its work
 * still left the reader with placeholders. The matrix is therefore the point —
 * one mode passing says nothing about the next.
 *
 * Real engines, real failure policy, real agent runner, real filesystem, real
 * HTTP to a local model server. Only the model itself is local and scripted,
 * which is what makes an assertion about "the answer the agent gave" possible.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import type { ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent'

import { STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'
import type {
  AgentFailurePolicy,
  BroadcastStageConfig,
  ChainStageConfig,
  DiscussionStageConfig,
  LoadedAgent,
  PipelineStageConfig,
  ReviewStageConfig,
  RuntimeState,
  TeamConfig,
} from '../../core/types.js'
import { createBroadcastTool } from '../../engines/broadcast.js'
import { createChainTool } from '../../engines/chain.js'
import { createDiscussionTool } from '../../engines/discussion.js'
import { createBriefTool, createSetRosterTool } from '../../engines/discussion-tools.js'
import { createPipelineTool } from '../../engines/pipeline.js'
import { createReviewTool } from '../../engines/review.js'
import { globalCircuitBreaker } from '../../domains/runtime/circuit-breaker.js'
import { initProviders } from '../../providers/index.js'
import { readTeamChatMessages } from '../../domains/runtime/team-chat-messages.js'
import type { TeamChatMessagePayload } from '../../contracts/team-chat-messages.js'
import { startDeterministicOpenAiServer } from '../electron/support/deterministic-openai-server.js'

/**
 * Long enough to clear the review engine's near-empty draft guard, which
 * refuses a producer answer under 25 words before a reviewer ever sees it.
 */
const MAKER_DRAFT = [
  'Maker drafts the retooling recommendation.',
  'The assembly line moves to a phased rollout across three quarters,',
  'starting with the two cells that already run the newer tooling,',
  'so the transition never removes more than a third of capacity at once,',
  'and the supplier contract is renegotiated before the second phase begins.',
].join(' ')

/** The tool interface needs an extension context; no engine tool reads it. */
const UNUSED_EXTENSION_CONTEXT: ExtensionToolContext = Object.create(null)

interface ProviderHandle {
  readonly baseUrl: string
  readonly close: () => Promise<void>
}

async function startScriptedModel(
  matchers: ReadonlyArray<{ readonly match: string; readonly text: string }>,
): Promise<ProviderHandle> {
  initProviders()
  // Each case starts from a closed circuit: one case's provider failure must
  // not decide the next case's dispatch before it is attempted.
  globalCircuitBreaker.resetAll()
  const server = await startDeterministicOpenAiServer({ matchers })
  process.env.OPENAI_API_KEY = 'team-chat-durable-messages-key'
  process.env.OPENAI_BASE_URL = server.baseUrl
  return { baseUrl: server.baseUrl, close: server.close }
}

interface ReplayableModel extends ProviderHandle {
  /** Every request from now on gets the `replay` answer. */
  readonly startReplay: () => void
  /** The `match` of every answer served since `startReplay`, in arrival order. */
  readonly replayedMatches: () => readonly string[]
}

/**
 * A model that can tell a replayed request from the first pass. A request that
 * reaches it after `startReplay` is what shows the replay re-executed the
 * dispatch instead of short-circuiting on the stage's own completion record.
 */
async function startReplayableModel(
  answers: ReadonlyArray<{
    readonly match: string
    readonly first: string
    readonly replay: string
  }>,
): Promise<ReplayableModel> {
  initProviders()
  globalCircuitBreaker.resetAll()
  let replaying = false
  const replayed: string[] = []
  const server = await startDeterministicOpenAiServer({
    resolveTurn: (requestBody) => {
      const answer = answers.find((candidate) => requestBody.includes(candidate.match))
      if (!answer) return undefined
      if (!replaying) return { text: answer.first }
      replayed.push(answer.match)
      return { text: answer.replay }
    },
  })
  process.env.OPENAI_API_KEY = 'team-chat-durable-messages-key'
  process.env.OPENAI_BASE_URL = server.baseUrl
  return {
    baseUrl: server.baseUrl,
    close: server.close,
    startReplay: () => {
      replaying = true
    },
    replayedMatches: () => [...replayed],
  }
}

function makeAssignment(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `team-chat-${label}-`))
}

/**
 * An agent whose provider does not exist, so its dispatch fails for a reason
 * the runtime raises itself rather than one a scripted model has to fake.
 */
const UNREACHABLE_PROVIDER = 'no-such-provider'

function makeAgent(
  name: string,
  directory: string,
  provider = 'openai',
): LoadedAgent {
  return {
    agentDir: directory,
    color: 1,
    experienceContent: '',
    experienceEnabled: false,
    knowledgeContent: '',
    selection: null,
    model: 'gpt-5.4-mini',
    name,
    provider,
    skillsContent: '',
    systemPrompt: `You are ${name} in a durable Team chat test. Answer briefly.`,
    thinking: 'low',
    tools: [],
  }
}

function makeRuntimeState(levelId: string): RuntimeState {
  return {
    currentLevelIndex: 0,
    endTime: null,
    levelStates: new Map([
      [levelId, {
        engineState: null,
        loopbackCount: 0,
        stageStatus: STAGE_LIFECYCLE_STATUS.READY,
        status: 'active',
        // A level state is created by the runtime shell; only the fields the
        // engines read matter here.
      }],
    ]),
    rootSessionId: 'root-run',
    sessionId: 'team-chat-run',
    spawnDepth: 0,
    startTime: Date.now(),
    timerStarted: true,
    totalCost: 0,
  } as unknown as RuntimeState
}

function makeTeamConfig(levelId: string, stage: unknown): TeamConfig {
  return {
    agents: [],
    gates: [],
    levels: [{ id: levelId, name: levelId, order: 0, stage }],
    models: {},
    team: { description: 'durable message matrix', name: 'matrix-team', version: '0.1.0' },
    workflow: { entry_level: levelId },
    workspace: { path: '.', watch: false },
  } as unknown as TeamConfig
}

interface EngineHarness {
  readonly assignmentPath: string
  readonly context: Record<string, unknown>
  readonly state: RuntimeState
}

function makeEngineHarness(input: {
  readonly agentNames: readonly string[]
  readonly chatMode: boolean
  readonly failurePolicies?: Readonly<Record<string, AgentFailurePolicy>>
  readonly label: string
  readonly levelId: string
  readonly stage: unknown
  readonly unreachableAgents?: readonly string[]
}): EngineHarness {
  const assignmentPath = makeAssignment(input.label)
  const unreachable = new Set(input.unreachableAgents ?? [])
  const state = makeRuntimeState(input.levelId)
  const agents = new Map(
    input.agentNames.map((name) => [
      name,
      makeAgent(
        name,
        assignmentPath,
        unreachable.has(name) ? UNREACHABLE_PROVIDER : 'openai',
      ),
    ]),
  )
  return {
    assignmentPath,
    context: {
      agentMetrics: new Map(
        input.agentNames.map((name) => [name, {
          name,
          state: 'idle',
          rounds: 0,
          totalCost: 0,
          failureCount: 0,
        }]),
      ),
      agents,
      chatMode: input.chatMode,
      config: input.stage,
      getCurrentCoordinatorRunId: () => 1,
      inputFilesContent: '',
      levelId: input.levelId,
      outputPath: assignmentPath,
      rosterEntries: new Map(
        input.agentNames.map((name) => [name, {
          name,
          type: 'agent',
          ...(input.failurePolicies?.[name]
            ? { on_failure: input.failurePolicies[name] }
            : {}),
        }]),
      ),
      state,
      teamConfig: makeTeamConfig(input.levelId, input.stage),
      teamName: 'matrix-team',
      teamRootPath: assignmentPath,
      workspacePath: assignmentPath,
    },
    state,
  }
}

/**
 * Put the level back where it stood before the engine first ran, at the same
 * visit. This is what a replacement process sees when the engine's progress
 * was lost after its messages were already published.
 */
function rewindLevelToBeforeFirstRun(harness: EngineHarness, levelId: string): void {
  const levelState = harness.state.levelStates.get(levelId)
  assert.ok(levelState, `the harness has a level state for ${levelId}`)
  levelState.engineState = null
  levelState.stageStatus = STAGE_LIFECYCLE_STATUS.READY
}

function teamMessageEvents(assignmentPath: string): string[] {
  return announcedEvents(assignmentPath)
    .filter((event) => event.type === 'team.message')
    .map((event) => event.agentName ?? '')
}


function runTool(
  tool: ToolDefinition,
  toolCallId: string,
  params: Record<string, unknown>,
): ReturnType<ToolDefinition['execute']> {
  return tool.execute(
    toolCallId,
    params,
    undefined,
    undefined,
    UNUSED_EXTENSION_CONTEXT,
  )
}

function speakers(messages: readonly TeamChatMessagePayload[]): string[] {
  return messages.map((message) => message.agent_name)
}

/** The events the reader's transcript is actually rebuilt from. */
function announcedEvents(
  assignmentPath: string,
): Array<{ type: string; agentName?: string }> {
  const logPath = path.join(assignmentPath, 'logs', 'engine-events.jsonl')
  if (!fs.existsSync(logPath)) return []
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .flatMap((line) => {
      if (!line.trim()) return []
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
      const envelope: Record<string, unknown> = { ...parsed }
      if (typeof envelope.type !== 'string') return []
      const payload = envelope.payload
      const agentName =
        payload && typeof payload === 'object' && !Array.isArray(payload) &&
          typeof Reflect.get(payload, 'agent_name') === 'string'
          ? String(Reflect.get(payload, 'agent_name'))
          : undefined
      return [{
        type: envelope.type,
        ...(agentName === undefined ? {} : { agentName }),
      }]
    })
}

function chainStage(sequence: string[]): ChainStageConfig {
  return {
    config: {
      constraints: { agent_timeout_minutes: 1, max_budget_usd: 1, max_time_minutes: 2 },
      handoff_format: 'markdown',
      output: { format: 'chain-result.md', user_review: false },
    },
    coordinator: 'coordinator',
    sequence,
    type: 'chain',
  } as ChainStageConfig
}

function discussionStage(participants: string[]): DiscussionStageConfig {
  return {
    config: {
      constraints: { agent_timeout_minutes: 1, max_budget_usd: 1, max_time_minutes: 2 },
      max_rounds: 1,
      min_rounds: 1,
      mode: 'debate',
      output: { format: 'discussion-result.md', user_review: false },
    },
    coordinator: 'coordinator',
    participants,
    type: 'discussion',
  } as DiscussionStageConfig
}

function broadcastStage(fanOut: string[]): BroadcastStageConfig {
  return {
    config: {
      aggregation: 'merge',
      constraints: { agent_timeout_minutes: 1, max_budget_usd: 1, max_time_minutes: 2 },
      output: { format: 'broadcast-result.md', user_review: false },
    },
    coordinator: 'coordinator',
    fan_out: fanOut,
    type: 'broadcast',
  } as BroadcastStageConfig
}

function pipelineStage(): PipelineStageConfig {
  return {
    config: {
      constraints: { agent_timeout_minutes: 1, max_budget_usd: 1, max_time_minutes: 2 },
      gate: { strictness: 'soft', type: 'all_tasks_terminal' },
      parallel: false,
      persist_result: true,
      plan_file: 'plan.md',
      run_owned_plan: true,
    },
    coordinator: 'coordinator',
    type: 'pipeline',
  } as PipelineStageConfig
}

function reviewStage(producer: string, reviewer: string): ReviewStageConfig {
  return {
    config: {
      constraints: { agent_timeout_minutes: 1, max_budget_usd: 1, max_time_minutes: 2 },
      max_iterations: 1,
      on_max_iterations: 'block',
      output: { format: 'review-result.md', user_review: false },
    },
    coordinator: 'coordinator',
    producer,
    reviewer,
    type: 'review',
  } as ReviewStageConfig
}

function writePlan(assignmentPath: string, agentName: string): void {
  fs.writeFileSync(
    path.join(assignmentPath, 'plan.md'),
    [
      '# Plan: Durable message matrix',
      '**Status:** approved',
      '',
      '### S1: Summarize',
      '#### T1: Draft the summary',
      `- **Agent:** ${agentName}`,
      '- **Status:** pending',
      '- **Validate:** false',
      '- **Depends on:** none',
      '- **Gate:** false',
      '- **Result file:** t1-result.md',
      '',
    ].join('\n'),
  )
}

test('a chain publishes one attributed message per accepted step', async () => {
  const provider = await startScriptedModel([
    { match: 'You are chain-one', text: 'Chain one proposes a phased rollout.' },
    { match: 'You are chain-two', text: 'Chain two adds a supplier contingency.' },
  ])
  const harness = makeEngineHarness({
    agentNames: ['chain-one', 'chain-two'],
    chatMode: true,
    label: 'chain',
    levelId: 'run',
    stage: chainStage(['chain-one', 'chain-two']),
  })

  try {
    await runTool(createChainTool(harness.context as never), 'chain-call', {
      message: 'Summarize the tradeoffs.',
    })

    const messages = readTeamChatMessages(harness.assignmentPath)
    assert.deepEqual(speakers(messages), ['chain-one', 'chain-two'])
    assert.equal(messages[0]?.text, 'Chain one proposes a phased rollout.')
    assert.equal(messages[1]?.text, 'Chain two adds a supplier contingency.')
    assert.equal(messages[0]?.stage_id, 'run')
    assert.notEqual(messages[0]?.dispatch_id, messages[1]?.dispatch_id)
  } finally {
    await provider.close()
    fs.rmSync(harness.assignmentPath, { recursive: true, force: true })
  }
})

test('a blocked chain step is not published as an answer', async () => {
  const provider = await startScriptedModel([
    {
      match: 'You are chain-one',
      text: '**Status:** BLOCKED\n\n## Hard Gaps\n\nThe brief has no budget.',
    },
  ])
  const harness = makeEngineHarness({
    agentNames: ['chain-one'],
    chatMode: true,
    label: 'chain-blocked',
    levelId: 'run',
    stage: chainStage(['chain-one']),
  })

  try {
    await runTool(createChainTool(harness.context as never), 'chain-blocked-call', {
      message: 'Summarize the tradeoffs.',
    })

    assert.deepEqual(readTeamChatMessages(harness.assignmentPath), [])
  } finally {
    await provider.close()
    fs.rmSync(harness.assignmentPath, { recursive: true, force: true })
  }
})

test('a discussion publishes one attributed message per participant', async () => {
  const provider = await startScriptedModel([
    { match: 'You are talk-one', text: 'Talk one favors the retooling.' },
    { match: 'You are talk-two', text: 'Talk two wants a staged budget.' },
  ])
  const harness = makeEngineHarness({
    agentNames: ['talk-one', 'talk-two'],
    chatMode: true,
    label: 'discussion',
    levelId: 'deliberation',
    stage: discussionStage(['talk-one', 'talk-two']),
  })

  try {
    await runTool(
      createSetRosterTool(harness.context as never) as ToolDefinition,
      'roster-call',
      { agents: ['talk-one', 'talk-two'] },
    )
    await runTool(
      createBriefTool(harness.context as never) as ToolDefinition,
      'brief-call',
      {
        title: 'Retooling',
        inquiry: 'Which thesis is strongest?',
        objectives: ['Pick a thesis'],
        scope: 'One plant',
        roster_rationale: {
          'talk-one': 'Owns the capital model.',
          'talk-two': 'Knows the retooling risk.',
        },
        deliverables: ['An answer'],
      },
    )
    await runTool(createDiscussionTool(harness.context as never), 'converse-call', {
      message: 'Which thesis is strongest?',
      to: 'all',
    })

    // The coordinator's roster announcement leads, then one message per
    // participant it convened.
    const messages = readTeamChatMessages(harness.assignmentPath)
    assert.deepEqual(speakers(messages), ['coordinator', 'talk-one', 'talk-two'])
    assert.equal(messages[1]?.text, 'Talk one favors the retooling.')
    assert.equal(messages[2]?.text, 'Talk two wants a staged budget.')
  } finally {
    await provider.close()
    fs.rmSync(harness.assignmentPath, { recursive: true, force: true })
  }
})

test('a broadcast publishes one attributed message per participant that answered', async () => {
  const provider = await startScriptedModel([
    { match: 'You are wide-one', text: 'Wide one sees demand holding.' },
    { match: 'You are wide-two', text: 'Wide two sees margin pressure.' },
  ])
  const harness = makeEngineHarness({
    agentNames: ['wide-one', 'wide-two'],
    chatMode: true,
    label: 'broadcast',
    levelId: 'fan-out',
    stage: broadcastStage(['wide-one', 'wide-two']),
  })

  try {
    await runTool(createBroadcastTool(harness.context as never), 'broadcast-call', {
      message: 'Assess the manufacturing thesis.',
    })

    const messages = readTeamChatMessages(harness.assignmentPath)
    assert.deepEqual(speakers(messages).sort(), ['wide-one', 'wide-two'])
    assert.ok(
      messages.some((message) => message.text === 'Wide one sees demand holding.'),
    )
    assert.ok(
      messages.some((message) => message.text === 'Wide two sees margin pressure.'),
    )
  } finally {
    await provider.close()
    fs.rmSync(harness.assignmentPath, { recursive: true, force: true })
  }
})

test('a pipeline publishes the accepted task result under the agent that produced it', async () => {
  const provider = await startScriptedModel([
    { match: 'You are step-one', text: 'Step one summarizes the tradeoffs.' },
  ])
  const harness = makeEngineHarness({
    agentNames: ['step-one'],
    chatMode: true,
    label: 'pipeline',
    levelId: 'tasks',
    stage: pipelineStage(),
  })
  writePlan(harness.assignmentPath, 'step-one')

  try {
    await runTool(createPipelineTool(harness.context as never), 'pipeline-call', {
      action: 'dispatch',
    })

    const messages = readTeamChatMessages(harness.assignmentPath)
    assert.deepEqual(speakers(messages), ['step-one'])
    assert.equal(messages[0]?.text, 'Step one summarizes the tradeoffs.')
  } finally {
    await provider.close()
    fs.rmSync(harness.assignmentPath, { recursive: true, force: true })
  }
})

test('a review publishes the producer draft and the reviewer verdict it accepted', async () => {
  const provider = await startScriptedModel([
    { match: 'You are maker', text: MAKER_DRAFT },
    { match: 'You are checker', text: 'APPROVE\n\nChecker accepts the draft.' },
  ])
  const harness = makeEngineHarness({
    agentNames: ['maker', 'checker'],
    chatMode: true,
    label: 'review',
    levelId: 'critique',
    stage: reviewStage('maker', 'checker'),
  })

  try {
    await runTool(createReviewTool(harness.context as never), 'review-call', {
      content: 'Draft the retooling recommendation.',
    })

    const messages = readTeamChatMessages(harness.assignmentPath)
    assert.deepEqual(speakers(messages), ['maker', 'checker'])
    assert.equal(messages[0]?.text, MAKER_DRAFT)
    assert.match(messages[1]?.text ?? '', /Checker accepts the draft\./)
  } finally {
    await provider.close()
    fs.rmSync(harness.assignmentPath, { recursive: true, force: true })
  }
})

test('a Team running outside chat keeps its existing output contract and records nothing', async () => {
  const provider = await startScriptedModel([
    { match: 'You are chain-one', text: 'Chain one proposes a phased rollout.' },
  ])
  const harness = makeEngineHarness({
    agentNames: ['chain-one'],
    chatMode: false,
    label: 'chain-workflow',
    levelId: 'run',
    stage: chainStage(['chain-one']),
  })

  try {
    await runTool(createChainTool(harness.context as never), 'chain-workflow-call', {
      message: 'Summarize the tradeoffs.',
    })

    assert.deepEqual(readTeamChatMessages(harness.assignmentPath), [])
  } finally {
    await provider.close()
    fs.rmSync(harness.assignmentPath, { recursive: true, force: true })
  }
})

test('a fallback publishes the agent that answered, not the one that failed', async () => {
  const provider = await startScriptedModel([
    { match: 'You are stand-in', text: 'Stand-in answers after the primary failed.' },
  ])
  const harness = makeEngineHarness({
    agentNames: ['first-choice', 'stand-in'],
    chatMode: true,
    failurePolicies: {
      'first-choice': {
        fallback_agent: 'stand-in',
        max_retries: 0,
        policy: 'fallback',
      },
    },
    label: 'chain-fallback',
    levelId: 'run',
    stage: chainStage(['first-choice']),
    unreachableAgents: ['first-choice'],
  })

  try {
    await runTool(createChainTool(harness.context as never), 'chain-fallback-call', {
      message: 'Summarize the tradeoffs.',
    })

    const messages = readTeamChatMessages(harness.assignmentPath)
    assert.deepEqual(speakers(messages), ['stand-in'])
    assert.equal(messages[0]?.text, 'Stand-in answers after the primary failed.')
  } finally {
    await provider.close()
    fs.rmSync(harness.assignmentPath, { recursive: true, force: true })
  }
})

test('a skipped broadcast participant leaves no message behind', async () => {
  const provider = await startScriptedModel([
    { match: 'You are present', text: 'Present answers for both of us.' },
  ])
  const harness = makeEngineHarness({
    agentNames: ['present', 'absent'],
    chatMode: true,
    failurePolicies: { absent: { max_retries: 0, policy: 'skip' } },
    label: 'broadcast-skip',
    levelId: 'fan-out',
    stage: broadcastStage(['present', 'absent']),
    unreachableAgents: ['absent'],
  })

  try {
    await runTool(createBroadcastTool(harness.context as never), 'broadcast-skip-call', {
      message: 'Assess the manufacturing thesis.',
    })

    assert.deepEqual(speakers(readTeamChatMessages(harness.assignmentPath)), [
      'present',
    ])
  } finally {
    await provider.close()
    fs.rmSync(harness.assignmentPath, { recursive: true, force: true })
  }
})

test('a failed chain step leaves no message behind', async () => {
  const provider = await startScriptedModel([])
  const harness = makeEngineHarness({
    agentNames: ['broken'],
    chatMode: true,
    failurePolicies: { broken: { max_retries: 0, policy: 'halt' } },
    label: 'chain-failed',
    levelId: 'run',
    stage: chainStage(['broken']),
    unreachableAgents: ['broken'],
  })

  try {
    await runTool(createChainTool(harness.context as never), 'chain-failed-call', {
      message: 'Summarize the tradeoffs.',
    })

    assert.deepEqual(readTeamChatMessages(harness.assignmentPath), [])
  } finally {
    await provider.close()
    fs.rmSync(harness.assignmentPath, { recursive: true, force: true })
  }
})

test('a cancelled chain records nothing for the attempt it interrupted', async () => {
  const provider = await startScriptedModel([
    { match: 'You are chain-one', text: 'Chain one proposes a phased rollout.' },
  ])
  const harness = makeEngineHarness({
    agentNames: ['chain-one'],
    chatMode: true,
    label: 'chain-cancelled',
    levelId: 'run',
    stage: chainStage(['chain-one']),
  })
  const cancelled = AbortSignal.abort()

  try {
    await createChainTool(harness.context as never).execute(
      'chain-cancelled-call',
      { message: 'Summarize the tradeoffs.' },
      cancelled,
      undefined,
      UNUSED_EXTENSION_CONTEXT,
    ).catch(() => undefined)

    assert.deepEqual(readTeamChatMessages(harness.assignmentPath), [])
  } finally {
    await provider.close()
    fs.rmSync(harness.assignmentPath, { recursive: true, force: true })
  }
})

test('re-entering a completed chain adds no second copy of its messages', async () => {
  const provider = await startScriptedModel([
    { match: 'You are chain-one', text: 'Chain one proposes a phased rollout.' },
  ])
  const harness = makeEngineHarness({
    agentNames: ['chain-one'],
    chatMode: true,
    label: 'chain-replay',
    levelId: 'run',
    stage: chainStage(['chain-one']),
  })

  try {
    const tool = createChainTool(harness.context as never)
    await runTool(tool, 'chain-replay-call', { message: 'Summarize the tradeoffs.' })
    const afterFirstRun = readTeamChatMessages(harness.assignmentPath)

    // The coordinator calling `handoff` again — after a reconnect, or because
    // the model repeated itself — must not put the same answer in the
    // transcript twice.
    await runTool(tool, 'chain-replay-call-again', {
      message: 'Summarize the tradeoffs.',
    })

    assert.equal(afterFirstRun.length, 1)
    assert.deepEqual(readTeamChatMessages(harness.assignmentPath), afterFirstRun)
  } finally {
    await provider.close()
    fs.rmSync(harness.assignmentPath, { recursive: true, force: true })
  }
})

test('a chain re-run from before completion at the same visit adds no second copy of its messages', async () => {
  const provider = await startReplayableModel([
    {
      match: 'You are chain-one',
      first: 'Chain one proposes a phased rollout.',
      replay: 'Chain one, replayed, proposes a phased rollout.',
    },
    {
      match: 'You are chain-two',
      first: 'Chain two adds a supplier contingency.',
      replay: 'Chain two, replayed, adds a supplier contingency.',
    },
  ])
  const harness = makeEngineHarness({
    agentNames: ['chain-one', 'chain-two'],
    chatMode: true,
    label: 'chain-rerun',
    levelId: 'run',
    stage: chainStage(['chain-one', 'chain-two']),
  })

  try {
    const tool = createChainTool(harness.context as never)
    await runTool(tool, 'chain-rerun-call', { message: 'Summarize the tradeoffs.' })
    const afterFirstRun = readTeamChatMessages(harness.assignmentPath)
    const eventsAfterFirstRun = teamMessageEvents(harness.assignmentPath)

    rewindLevelToBeforeFirstRun(harness, 'run')
    provider.startReplay()
    await runTool(tool, 'chain-rerun-call-again', { message: 'Summarize the tradeoffs.' })

    // Both steps reached the model again, so the replay was not a short-circuit.
    assert.deepEqual(provider.replayedMatches(), ['You are chain-one', 'You are chain-two'])
    assert.deepEqual(speakers(afterFirstRun), ['chain-one', 'chain-two'])
    assert.deepEqual(readTeamChatMessages(harness.assignmentPath), afterFirstRun)
    assert.deepEqual(teamMessageEvents(harness.assignmentPath), eventsAfterFirstRun)
  } finally {
    await provider.close()
    fs.rmSync(harness.assignmentPath, { recursive: true, force: true })
  }
})

test('a broadcast re-run from before completion at the same visit adds no second copy of its messages', async () => {
  const provider = await startReplayableModel([
    {
      match: 'You are wide-one',
      first: 'Wide one sees demand holding.',
      replay: 'Wide one, replayed, sees demand holding.',
    },
    {
      match: 'You are wide-two',
      first: 'Wide two sees margin pressure.',
      replay: 'Wide two, replayed, sees margin pressure.',
    },
  ])
  const harness = makeEngineHarness({
    agentNames: ['wide-one', 'wide-two'],
    chatMode: true,
    label: 'broadcast-rerun',
    levelId: 'fan-out',
    stage: broadcastStage(['wide-one', 'wide-two']),
  })

  try {
    const tool = createBroadcastTool(harness.context as never)
    await runTool(tool, 'broadcast-rerun-call', { message: 'Assess the manufacturing thesis.' })
    const afterFirstRun = readTeamChatMessages(harness.assignmentPath)
    const eventsAfterFirstRun = teamMessageEvents(harness.assignmentPath)

    rewindLevelToBeforeFirstRun(harness, 'fan-out')
    provider.startReplay()
    await runTool(tool, 'broadcast-rerun-call-again', {
      message: 'Assess the manufacturing thesis.',
    })

    assert.deepEqual(
      [...provider.replayedMatches()].sort(),
      ['You are wide-one', 'You are wide-two'],
    )
    assert.deepEqual(speakers(afterFirstRun).sort(), ['wide-one', 'wide-two'])
    assert.deepEqual(readTeamChatMessages(harness.assignmentPath), afterFirstRun)
    assert.deepEqual(teamMessageEvents(harness.assignmentPath), eventsAfterFirstRun)
  } finally {
    await provider.close()
    fs.rmSync(harness.assignmentPath, { recursive: true, force: true })
  }
})

test('a pipeline task re-run from before completion at the same visit adds no second copy of its message', async () => {
  const provider = await startReplayableModel([
    {
      match: 'You are step-one',
      first: 'Step one summarizes the tradeoffs.',
      replay: 'Step one, replayed, summarizes the tradeoffs.',
    },
  ])
  const harness = makeEngineHarness({
    agentNames: ['step-one'],
    chatMode: true,
    label: 'pipeline-rerun',
    levelId: 'tasks',
    stage: pipelineStage(),
  })
  writePlan(harness.assignmentPath, 'step-one')

  try {
    const tool = createPipelineTool(harness.context as never)
    await runTool(tool, 'pipeline-rerun-call', { action: 'dispatch' })
    const afterFirstRun = readTeamChatMessages(harness.assignmentPath)
    const eventsAfterFirstRun = teamMessageEvents(harness.assignmentPath)

    // Task progress lives in the run's own copy of the plan; removing it makes
    // the engine copy the untouched source plan again, with T1 still pending.
    fs.rmSync(path.join(harness.assignmentPath, '.runtime', 'pipeline', 'tasks', 'plan.md'))
    rewindLevelToBeforeFirstRun(harness, 'tasks')
    provider.startReplay()
    await runTool(tool, 'pipeline-rerun-call-again', { action: 'dispatch' })

    assert.deepEqual(provider.replayedMatches(), ['You are step-one'])
    assert.deepEqual(speakers(afterFirstRun), ['step-one'])
    assert.deepEqual(readTeamChatMessages(harness.assignmentPath), afterFirstRun)
    assert.deepEqual(teamMessageEvents(harness.assignmentPath), eventsAfterFirstRun)
  } finally {
    await provider.close()
    fs.rmSync(harness.assignmentPath, { recursive: true, force: true })
  }
})

test('a discussion re-run from before completion at the same visit adds no second copy of its messages', async () => {
  const provider = await startReplayableModel([
    {
      match: 'You are talk-one',
      first: 'Talk one favors the retooling.',
      replay: 'Talk one, replayed, favors the retooling.',
    },
    {
      match: 'You are talk-two',
      first: 'Talk two wants a staged budget.',
      replay: 'Talk two, replayed, wants a staged budget.',
    },
  ])
  const harness = makeEngineHarness({
    agentNames: ['talk-one', 'talk-two'],
    chatMode: true,
    label: 'discussion-rerun',
    levelId: 'deliberation',
    stage: discussionStage(['talk-one', 'talk-two']),
  })
  const convene = async (suffix: string): Promise<void> => {
    await runTool(
      createSetRosterTool(harness.context as never) as ToolDefinition,
      `roster-call${suffix}`,
      { agents: ['talk-one', 'talk-two'] },
    )
    await runTool(
      createBriefTool(harness.context as never) as ToolDefinition,
      `brief-call${suffix}`,
      {
        title: 'Retooling',
        inquiry: 'Which thesis is strongest?',
        objectives: ['Pick a thesis'],
        scope: 'One plant',
        roster_rationale: {
          'talk-one': 'Owns the capital model.',
          'talk-two': 'Knows the retooling risk.',
        },
        deliverables: ['An answer'],
      },
    )
    await runTool(createDiscussionTool(harness.context as never), `converse-call${suffix}`, {
      message: 'Which thesis is strongest?',
      to: 'all',
    })
  }

  try {
    await convene('')
    const afterFirstRun = readTeamChatMessages(harness.assignmentPath)
    const eventsAfterFirstRun = teamMessageEvents(harness.assignmentPath)

    rewindLevelToBeforeFirstRun(harness, 'deliberation')
    provider.startReplay()
    await convene('-again')

    assert.deepEqual(provider.replayedMatches(), ['You are talk-one', 'You are talk-two'])
    assert.deepEqual(speakers(afterFirstRun), ['coordinator', 'talk-one', 'talk-two'])
    assert.deepEqual(readTeamChatMessages(harness.assignmentPath), afterFirstRun)
    assert.deepEqual(teamMessageEvents(harness.assignmentPath), eventsAfterFirstRun)
  } finally {
    await provider.close()
    fs.rmSync(harness.assignmentPath, { recursive: true, force: true })
  }
})

test('a review re-run from before completion at the same visit adds no second copy of its messages', async () => {
  const replayedDraft = `${MAKER_DRAFT} Replayed.`
  const provider = await startReplayableModel([
    { match: 'You are maker', first: MAKER_DRAFT, replay: replayedDraft },
    {
      match: 'You are checker',
      first: 'APPROVE\n\nChecker accepts the draft.',
      replay: 'APPROVE\n\nChecker, replayed, accepts the draft.',
    },
  ])
  const harness = makeEngineHarness({
    agentNames: ['maker', 'checker'],
    chatMode: true,
    label: 'review-rerun',
    levelId: 'critique',
    stage: reviewStage('maker', 'checker'),
  })

  try {
    const tool = createReviewTool(harness.context as never)
    await runTool(tool, 'review-rerun-call', {
      content: 'Draft the retooling recommendation.',
    })
    const afterFirstRun = readTeamChatMessages(harness.assignmentPath)
    const eventsAfterFirstRun = teamMessageEvents(harness.assignmentPath)

    rewindLevelToBeforeFirstRun(harness, 'critique')
    provider.startReplay()
    await runTool(tool, 'review-rerun-call-again', {
      content: 'Draft the retooling recommendation.',
    })

    assert.deepEqual(provider.replayedMatches(), ['You are maker', 'You are checker'])
    assert.deepEqual(speakers(afterFirstRun), ['maker', 'checker'])
    assert.deepEqual(readTeamChatMessages(harness.assignmentPath), afterFirstRun)
    assert.deepEqual(teamMessageEvents(harness.assignmentPath), eventsAfterFirstRun)
  } finally {
    await provider.close()
    fs.rmSync(harness.assignmentPath, { recursive: true, force: true })
  }
})

test('a Team chat discussion announces its reply once, in the Team family', async () => {
  // The control the whole suppression rule rests on: in chat the reply is a
  // `team.message` and nothing else, so the reader never sees it twice. The
  // replay and unrecordable halves are at the seam, in
  // discussion-team-chat-message.test.ts.
  const provider = await startScriptedModel([
    { match: 'You are talk-one', text: 'Talk one favors the retooling.' },
  ])
  const harness = makeEngineHarness({
    agentNames: ['talk-one'],
    chatMode: true,
    label: 'discussion-family',
    levelId: 'deliberation',
    stage: discussionStage(['talk-one']),
  })

  try {
    await runTool(
      createSetRosterTool(harness.context as never) as ToolDefinition,
      'roster-call',
      { agents: ['talk-one'] },
    )
    await runTool(
      createBriefTool(harness.context as never) as ToolDefinition,
      'brief-call',
      {
        title: 'Retooling',
        inquiry: 'Which thesis is strongest?',
        objectives: ['Pick a thesis'],
        scope: 'One plant',
        roster_rationale: { 'talk-one': 'Owns the capital model.' },
        deliverables: ['An answer'],
      },
    )
    await runTool(createDiscussionTool(harness.context as never), 'converse-call', {
      message: 'Which thesis is strongest?',
      to: 'all',
    })

    const contentByTalkOne = announcedEvents(harness.assignmentPath).filter(
      (event) =>
        event.agentName === 'talk-one' &&
        (event.type === 'team.message' || event.type === 'discussion.message'),
    )
    assert.deepEqual(
      contentByTalkOne.map((event) => event.type),
      ['team.message'],
    )
  } finally {
    await provider.close()
    fs.rmSync(harness.assignmentPath, { recursive: true, force: true })
  }
})
