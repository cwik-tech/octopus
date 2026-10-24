import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'

import { STAGE_LIFECYCLE_STATUS, STAGE_TYPE } from '../../core/constants.js'
import type { DiscussionState, LevelState } from '../../core/types.js'

type MockDispatchResult =
  | { text: string; skipped?: boolean; agentName?: string; dispatchId?: string }
  | Error

let queuedResults: MockDispatchResult[] = []
let dispatchedAgentNames: string[] = []
let dispatchedUserMessages: string[] = []
let dispatchedSystemPrompts: string[] = []
const UNUSED_EXTENSION_CONTEXT: ExtensionToolContext = Object.create(null)

class MockHaltError extends Error {
  agentName: string
  originalError: string

  constructor(agentName: string, originalError: string) {
    super(originalError)
    this.name = 'HaltError'
    this.agentName = agentName
    this.originalError = originalError
  }
}

mock.module('../../domains/agent-execution/failure-policy.js', {
  namedExports: {
    HaltError: MockHaltError,
    resolveFailurePolicy: () => ({ policy: 'skip', maxRetries: 0 }),
    dispatchWithFailurePolicy: mock.fn(async (options: { agent: { name: string }; finalPrompt: string; userMessage: string }) => {
      dispatchedAgentNames.push(options.agent.name)
      dispatchedUserMessages.push(options.userMessage)
      dispatchedSystemPrompts.push(options.finalPrompt)
      const next = queuedResults.shift()
      if (!next) throw new Error('No mocked discussion dispatch result queued.')
      if (next instanceof Error) throw next
      return {
        text: next.text,
        skipped: next.skipped ?? false,
        ...(next.agentName ? { agentName: next.agentName } : {}),
        ...(next.dispatchId ? { dispatchId: next.dispatchId } : {}),
        cost: 0,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        contextTokens: 0,
        model: 'mock-model',
      }
    }),
  },
})

const { createDiscussionTool } = await import('../../engines/discussion.js')

function makeContext(dir: string) {
  return {
    config: {
      type: STAGE_TYPE.DISCUSSION,
      coordinator: 'editor',
      participants: ['agent-a', 'agent-b'],
      config: {
        mode: 'deliberate',
        min_rounds: 1,
        max_rounds: 2,
        min_successful_participants: 1,
        constraints: { max_budget_usd: 10, max_time_minutes: 30 },
        output: { format: 'report.md', user_review: false, path: '' },
      },
    },
    teamConfig: {
      team: { name: 'discussion-team', description: 'test', version: '0.1.0' },
      workspace: { path: dir, watch: false },
      models: {},
      agents: [],
      levels: [
        {
          id: 'brief',
          name: 'Brief',
          order: 0,
          stage: {
            type: 'chain',
            sequence: ['writer'],
            config: { output: { format: 'brief.md', user_review: false } },
          },
        },
        {
          id: 'discussion',
          name: 'Discussion',
          order: 1,
          stage: {
            type: 'discussion',
            coordinator: 'editor',
            participants: ['agent-a', 'agent-b'],
            config: {
              mode: 'deliberate',
              min_rounds: 1,
              max_rounds: 2,
              min_successful_participants: 1,
              constraints: { max_budget_usd: 10, max_time_minutes: 30 },
              output: { format: 'report.md', user_review: false, path: '' },
            },
          },
        },
      ],
      gates: [],
    } as any,
    teamName: 'discussion-team',
    levelId: 'discussion',
    agents: new Map([
      ['agent-a', { name: 'agent-a', systemPrompt: 'A', agentDir: dir, experienceEnabled: false }],
      ['agent-b', { name: 'agent-b', systemPrompt: 'B', agentDir: dir, experienceEnabled: false }],
    ]),
    rosterEntries: new Map([
      ['agent-a', { name: 'agent-a', type: 'agent' }],
      ['agent-b', { name: 'agent-b', type: 'agent' }],
    ]),
    state: {
      sessionId: 'discussion-session',
      currentLevelIndex: 1,
      levelStates: new Map([
        ['discussion', {
          status: 'active',
          stageStatus: STAGE_LIFECYCLE_STATUS.READY,
          loopbackCount: 0,
          engineState: {
            type: STAGE_TYPE.DISCUSSION,
            round: 0,
            messages: [],
            outputPath: dir,
            approvedRoster: ['agent-a', 'agent-b'],
          },
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
    getCurrentCoordinatorRunId: () => 1,
    onDashboardUpdate: undefined,
  } as any
}

/**
 * Stand in for the `create_brief` announcement a chat run publishes before it
 * converses, for tests that drive `converse` on its own.
 */
function markRosterAnnounced(
  levelStates: Map<string, LevelState>,
  levelId: string,
): void {
  const engineState = requireDiscussionState(levelStates, levelId)
  engineState.rosterAnnounced = true
}

function requireDiscussionState(
  levelStates: Map<string, LevelState>,
  levelId: string,
): DiscussionState {
  const engineState = levelStates.get(levelId)?.engineState
  if (engineState?.type !== STAGE_TYPE.DISCUSSION) {
    throw new Error(`Level '${levelId}' holds no discussion state`)
  }
  return engineState
}

function readTextResult(result: any): string {
  return (result.content?.[0] as { text?: string } | undefined)?.text ?? ''
}

test('converse bootstraps from the previous-stage artifact and completes bounded rounds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), 'Discuss the market entry strategy.')
    queuedResults = [
      { text: 'Agent A round 1' },
      { text: 'Agent B round 1' },
      { text: 'Agent A round 2' },
      { text: 'Agent B round 2' },
    ]

    const ctx = makeContext(dir)
    const tool = createDiscussionTool(ctx)
    const result = await tool.execute('call-1', undefined as any, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(result)

    assert.match(text, /## Round 1/)
    assert.match(text, /## Round 2/)
    assert.ok(fs.existsSync(path.join(dir, 'report.md')))
    assert.equal(ctx.state.levelStates.get('discussion')?.stageStatus, STAGE_LIFECYCLE_STATUS.COMPLETED)
    assert.equal((ctx.state.levelStates.get('discussion')?.engineState as any).round, 2)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a recovered specialist pass skips replies already accepted in that same pass', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-pass-recovery-'))
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), 'Review the teaching material.')
    queuedResults = [{
      text: 'Fallback reviewer recovered response',
      agentName: 'fallback-reviewer',
      dispatchId: 'dispatch-agent-b-fallback',
    }]
    dispatchedAgentNames = []
    dispatchedUserMessages = []
    dispatchedSystemPrompts = []

    const ctx = makeContext(dir)
    ctx.chatMode = true
    ctx.config.config.min_successful_participants = 2
    const levelState = ctx.state.levelStates.get('discussion')
    assert.equal(levelState?.engineState?.type, STAGE_TYPE.DISCUSSION)
    if (levelState?.engineState?.type !== STAGE_TYPE.DISCUSSION) return
    levelState.engineState.round = 1
    levelState.engineState.rosterAnnounced = true
    levelState.engineState.messages.push({
      from: 'agent-a',
      to: 'all',
      round: 1,
      timestamp: new Date(0).toISOString(),
      type: 'position',
      message: 'Agent A accepted response',
      dispatchId: 'discussion:discussion:1:agent-a#1#agent-a',
    })
    levelState.engineState.continuation = {
      phase: 'running_specialist_pass',
      startedAtMs: 1_000,
      passNumber: 1,
      attemptNumber: 1,
      completedTargets: ['agent-a'],
      successfulTargets: ['agent-a'],
    }

    const tool = createDiscussionTool(ctx)
    await tool.execute(
      'discussion-pass:discussion:1',
      {},
      undefined,
      undefined,
      UNUSED_EXTENSION_CONTEXT,
    )

    assert.deepEqual(dispatchedAgentNames, ['agent-b'])
    assert.equal(levelState.engineState.round, 1)
    assert.deepEqual(
      levelState.engineState.messages.at(-1),
      {
        from: 'fallback-reviewer',
        target: 'agent-b',
        to: 'all',
        round: 1,
        timestamp: levelState.engineState.messages.at(-1)?.timestamp,
        type: 'position',
        message: 'Fallback reviewer recovered response',
        dispatchId: 'dispatch-agent-b-fallback',
      },
    )
    assert.deepEqual(
      levelState.engineState.continuation?.phase === 'running_specialist_pass'
        ? levelState.engineState.continuation.successfulTargets
        : [],
      ['agent-a', 'agent-b'],
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Team chat performs one lead-directed specialist pass per call without changing workflow limits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), 'Compare the desktop runtimes.')
    queuedResults = [
      { text: 'Agent A chat reply' },
      { text: 'Agent B chat reply' },
    ]
    dispatchedAgentNames = []
    dispatchedUserMessages = []
    dispatchedSystemPrompts = []

    const ctx = makeContext(dir)
    ctx.chatMode = true
    // This test drives `converse` directly, so it stands in for the
    // set_roster/create_brief handshake that publishes the roster.
    markRosterAnnounced(ctx.state.levelStates, 'discussion')
    const discussion = requireDiscussionState(ctx.state.levelStates, 'discussion')
    ctx.inputFilesContent = [
      '# Current user message',
      '',
      'What Michigan mining risks matter?',
      '',
      '# Conversation continuity',
      '',
      'Previous user message: Which mining thesis is strongest?',
    ].join('\n')
    ctx.agents.get('agent-a').systemPrompt = 'Task context:\n{{TASK_CONTENT}}'
    const tool = createDiscussionTool(ctx)
    const guidelines = tool.promptGuidelines?.join(' ') ?? ''
    assert.match(guidelines, /one specialist pass per call/i)
    assert.match(guidelines, /target specific members for follow-ups/i)
    const result = await tool.execute(
      'chat-turn',
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.match(readTextResult(result), /Agent A chat reply/)
    assert.match(readTextResult(result), /Agent B chat reply/)
    assert.equal(result.terminate, undefined)
    assert.deepEqual(dispatchedAgentNames, ['agent-a', 'agent-b'])
    assert.match(dispatchedSystemPrompts[0] ?? '', /What Michigan mining risks matter\?/)
    assert.match(dispatchedSystemPrompts[0] ?? '', /Which mining thesis is strongest\?/)
    assert.doesNotMatch(dispatchedSystemPrompts[0] ?? '', /\{\{TASK_CONTENT\}\}/)
    assert.equal(ctx.config.config.max_rounds, 2)
    assert.equal(discussion.round, 1)
    assert.equal(
      ctx.state.levelStates.get('discussion')?.stageStatus,
      STAGE_LIFECYCLE_STATUS.RUNNING,
    )
    assert.equal(fs.existsSync(path.join(dir, 'report.md')), false)
    assert.doesNotMatch(readTextResult(result), /Output path|MUST use the `write` tool/i)

    queuedResults = [
      { text: 'Agent A follow-up reply' },
      { text: 'Agent B follow-up reply' },
    ]
    const followUp = await tool.execute(
      'follow-up-chat-turn',
      { to: 'all', message: 'Challenge the first-pass recommendation.' },
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.match(readTextResult(followUp), /Agent A follow-up reply/)
    assert.match(readTextResult(followUp), /Agent B follow-up reply/)
    assert.deepEqual(dispatchedAgentNames, [
      'agent-a',
      'agent-b',
      'agent-a',
      'agent-b',
    ])
    assert.match(dispatchedUserMessages[2] ?? '', /Challenge the first-pass recommendation\./)
    assert.equal(discussion.round, 2)
    assert.equal(
      ctx.state.levelStates.get('discussion')?.stageStatus,
      STAGE_LIFECYCLE_STATUS.RUNNING,
    )
  } finally {
    queuedResults = []
    dispatchedAgentNames = []
    dispatchedUserMessages = []
    dispatchedSystemPrompts = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('direct human feedback invokes only addressed participants with their source and message', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), 'Discuss the market entry strategy.')
    queuedResults = [{ text: 'Agent A addresses the feedback.' }]
    dispatchedAgentNames = []
    dispatchedUserMessages = []

    const ctx = makeContext(dir)
    ctx.config.config.max_rounds = 1
    ctx.inputFilesContent = 'Round one source evidence.'
    ctx.humanInputRouting = {
      interactionId: 'human-feedback-1',
      source: 'Round one source evidence.',
      messages: [{
        id: 'message-1',
        text: '@agent-a quantify rollout risk.',
        recipients: ['agent-a'],
      }],
    }
    const tool = createDiscussionTool(ctx)
    const result = await tool.execute('call-1', undefined as any, undefined as any, undefined as any, undefined as any)

    assert.match(readTextResult(result), /Agent A addresses the feedback/)
    assert.deepEqual(dispatchedAgentNames, ['agent-a'])
    assert.match(dispatchedUserMessages[0] ?? '', /Round one source evidence\./)
    assert.match(dispatchedUserMessages[0] ?? '', /@agent-a quantify rollout risk\./)
  } finally {
    queuedResults = []
    dispatchedAgentNames = []
    dispatchedUserMessages = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('direct human feedback cannot add an addressed agent outside the locked roster', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), 'Discuss the market entry strategy.')
    queuedResults = [{ text: 'Agent A addresses the feedback.' }]
    dispatchedAgentNames = []

    const ctx = makeContext(dir)
    ctx.config.config.max_rounds = 1
    ctx.agents.set('agent-c', {
      name: 'agent-c',
      systemPrompt: 'C',
      agentDir: dir,
      experienceEnabled: false,
    })
    ctx.humanInputRouting = {
      interactionId: 'human-feedback-outside-roster',
      source: 'Round one source evidence.',
      messages: [{
        id: 'message-1',
        text: '@agent-a assess the evidence; @agent-c challenge it.',
        recipients: ['agent-a', 'agent-c'],
      }],
    }

    const tool = createDiscussionTool(ctx)
    await tool.execute(
      'call-1',
      {},
      undefined,
      undefined,
      UNUSED_EXTENSION_CONTEXT,
    )

    assert.deepEqual(dispatchedAgentNames, ['agent-a'])
  } finally {
    queuedResults = []
    dispatchedAgentNames = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('direct feedback targets only the first round and scales quorum to that round', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), 'Discuss the market entry strategy.')
    queuedResults = [
      { text: 'Agent A addresses the feedback.' },
      { text: 'Agent A continues the discussion.' },
      { text: 'Agent B continues the discussion.' },
    ]
    dispatchedAgentNames = []
    dispatchedUserMessages = []

    const ctx = makeContext(dir)
    ctx.config.config.max_rounds = 2
    ctx.config.config.min_successful_participants = 2
    ctx.teamConfig.levels[1].stage.config.max_rounds = 2
    ctx.teamConfig.levels[1].stage.config.min_successful_participants = 2
    ctx.inputFilesContent = 'Reviewed source evidence.'
    ctx.humanInputRouting = {
      interactionId: 'human-feedback-1',
      source: 'Reviewed source evidence.',
      messages: [{
        id: 'message-1',
        text: '@agent-a quantify rollout risk.',
        recipients: ['agent-a'],
      }],
    }

    const tool = createDiscussionTool(ctx)
    const result = await tool.execute('call-1', undefined as any, undefined as any, undefined as any, undefined as any)

    assert.match(readTextResult(result), /## Round 2/)
    assert.equal(ctx.state.levelStates.get('discussion')?.stageStatus, STAGE_LIFECYCLE_STATUS.COMPLETED)
    assert.deepEqual(dispatchedAgentNames, ['agent-a', 'agent-a', 'agent-b'])
    assert.equal(
      dispatchedUserMessages[0]?.match(/Reviewed source evidence\./g)?.length,
      1,
    )
    assert.match(
      dispatchedUserMessages[0] ?? '',
      /- @agent-a quantify rollout risk\.\n\*\*Conversation so far:\*\*/,
    )
  } finally {
    queuedResults = []
    dispatchedAgentNames = []
    dispatchedUserMessages = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('converse returns a clear bootstrap error when no discussion input exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-runtime-loop-'))
  try {
    const ctx = makeContext(dir)
    const tool = createDiscussionTool(ctx)
    const result = await tool.execute('call-1', undefined as any, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(result)

    assert.match(text, /Discussion bootstrap failed:/)
    assert.equal(fs.existsSync(path.join(dir, 'report.md')), false)
    assert.equal(ctx.state.levelStates.get('discussion')?.stageStatus, STAGE_LIFECYCLE_STATUS.BLOCKED)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('converse blocks and does not write an artifact when all approved participants fail to respond', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), 'Discuss the market entry strategy.')
    queuedResults = [
      { text: 'Agent A skipped', skipped: true },
      { text: 'Agent B skipped', skipped: true },
    ]

    const ctx = makeContext(dir)
    const tool = createDiscussionTool(ctx)
    const result = await tool.execute('call-1', undefined as any, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(result)

    assert.match(text, /only 0 approved participants produced a response/i)
    assert.equal(fs.existsSync(path.join(dir, 'report.md')), false)
    assert.equal(ctx.state.levelStates.get('discussion')?.stageStatus, STAGE_LIFECYCLE_STATUS.BLOCKED)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('converse blocks when the round does not reach the configured minimum successful participants', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), 'Discuss the market entry strategy.')
    queuedResults = [
      { text: 'Agent A round 1' },
      { text: 'Agent B skipped', skipped: true },
    ]

    const ctx = makeContext(dir)
    ctx.config.config.min_successful_participants = 2
    ctx.teamConfig.levels[1].stage.config.min_successful_participants = 2
    const tool = createDiscussionTool(ctx)
    const result = await tool.execute('call-1', undefined as any, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(result)

    assert.match(text, /only 1 approved participant produced a response, but 2 were required/i)
    assert.equal(fs.existsSync(path.join(dir, 'report.md')), false)
    assert.equal(ctx.state.levelStates.get('discussion')?.stageStatus, STAGE_LIFECYCLE_STATUS.BLOCKED)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('converse fails on a HaltError even when earlier responses already satisfy quorum', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), 'Discuss the market entry strategy.')
    queuedResults = [
      { text: 'Agent A round 1' },
      new MockHaltError('agent-b', 'provider credentials rejected'),
    ]

    const ctx = makeContext(dir)
    const tool = createDiscussionTool(ctx)
    const result = await tool.execute('call-1', undefined as any, undefined as any, undefined as any, undefined as any)

    assert.match(readTextResult(result), /Discussion halted in round 1/)
    assert.equal(fs.existsSync(path.join(dir, 'report.md')), false)
    assert.equal(ctx.state.levelStates.get('discussion')?.stageStatus, STAGE_LIFECYCLE_STATUS.FAILED)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
