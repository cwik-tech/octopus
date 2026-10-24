import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { RuntimeState, LoadedAgent } from '../../core/types.js'
import { AGENT_STATE, STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'

let shouldDispatchThrow = false
let failingAgentNames: string[] = []
/** Substituted system prompts, in dispatch order, as the dispatcher received them. */
let dispatchedSystemPrompts: string[] = []

mock.module('../../domains/agent-execution/agent-runner.js', {
  namedExports: {
    dispatchToAgentOrTeam: mock.fn(async (opts: any) => {
      const agentName = opts.agent?.name ?? 'unknown'
      dispatchedSystemPrompts.push(String(opts.finalPrompt ?? ''))
      if (shouldDispatchThrow || failingAgentNames.includes(agentName)) {
        throw new Error('Simulated dispatch failure')
      }
      return { text: `Response from ${agentName}`, cost: 0.001 }
    }),
    // `isLevelReadyForGate` pulls in gate-checker and experience-reflections,
    // which import these. A module mock replaces the whole module, so they have
    // to be present or the import graph fails to link.
    runAgent: mock.fn(async () => ({ text: '', cost: 0 })),
    runTeam: mock.fn(async () => ({ text: '', cost: 0, succeeded: true, status: 'completed' })),
  },
})

const { createBroadcastTool } = await import('../../engines/broadcast.js')
const { serializeCheckpoint, restoreLevelStatesFromCheckpoint } = await import('../../domains/runtime/checkpoint.js')
const { isLevelReadyForGate } = await import('../../team-runtime/level-lifecycle.js')

function makeRuntimeState(): RuntimeState {
  return {
    sessionId: 'test-session',
    currentLevelIndex: 1,
    levelStates: new Map([['l1', {
      status: 'active' as any,
      stageStatus: STAGE_LIFECYCLE_STATUS.READY,
      engineState: null,
      loopbackCount: 0,
    }]]),
    totalCost: 0,
    startTime: Date.now(),
    timerStarted: false,
    endTime: null,
    spawnDepth: 0,
  }
}

function makeLoadedAgent(name: string): LoadedAgent {
  return {
    name,
    model: 'test-model',
    thinking: 'low' as any,
    systemPrompt: `You are ${name}.`,
    experienceContent: '',
    experienceEnabled: true,
    skillsContent: '',
    knowledgeContent: '',
    selection: null,
    agentDir: '/tmp',
    color: 0,
    provider: 'pi',
  }
}

function makeContext(
  outputPath: string,
  options: { readonly stageFailureOverride?: string } = {},
): any {
  const state = makeRuntimeState()
  const agents = new Map<string, LoadedAgent>()
  const agentMetrics = new Map<string, any>()
  const rosterEntries = new Map<string, any>()
  const agentNames = ['agent-a', 'agent-b']

  for (const name of agentNames) {
    agents.set(name, makeLoadedAgent(name))
    agentMetrics.set(name, {
      state: AGENT_STATE.IDLE,
      rounds: 0,
      totalCost: 0,
      contextTokens: 0,
      model: 'test-model',
      color: 0,
      failureCount: 0,
    })
    rosterEntries.set(name, { type: 'agent' })
  }

  return {
    teamName: 'broadcast-team',
    teamConfig: {
      team: { name: 'broadcast-team', description: 'test', version: '0.1.0' },
      workspace: { path: outputPath, watch: false },
      models: {},
      agents: [],
      levels: [
        {
          id: 'l0',
          name: 'Brief',
          order: 0,
          stage: {
            type: 'discussion',
            coordinator: 'agent-a',
            participants: ['agent-a'],
            config: { output: { format: 'brief.md', user_review: false } },
          },
        },
        {
          id: 'l1',
          name: 'Broadcast',
          order: 1,
          stage: {
            type: 'broadcast',
            coordinator: 'agent-a',
            fan_out: agentNames,
            config: {
              aggregation: 'merge',
              output: { format: 'output.md', user_review: false, path: '' },
              constraints: { max_time_minutes: 10, max_budget_usd: 100 },
            },
          },
        },
      ],
      gates: [],
    } as any,
    config: {
      type: 'broadcast',
      coordinator: 'agent-a',
      fan_out: agentNames,
      config: {
        aggregation: 'merge',
        output: { format: 'output.md', user_review: false, path: '' },
        constraints: { max_time_minutes: 10, max_budget_usd: 100 },
      },
    },
    levelId: 'l1',
    teamRootPath: outputPath,
    agents,
    rosterEntries,
    state,
    workspacePath: outputPath,
    outputPath,
    inputFilesContent: '',
    agentMetrics,
    onDashboardUpdate: undefined,
    rateLimiter: undefined,
    // Drives the real policy resolution in `resolveFailurePolicy`, which is how
    // a stage's `on_agent_failure` reaches the dispatcher.
    ...(options.stageFailureOverride
      ? { stageFailureOverride: options.stageFailureOverride }
      : {}),
  }
}

/**
 * Read the text a tool result carries, without asserting its shape blindly.
 *
 * The broadcast tool returns a content array; narrowing it here keeps the new
 * assertions free of `any` and fails with a useful message if the shape moves.
 */
function toolResultText(result: unknown): string {
  if (
    typeof result === 'object' && result !== null &&
    'content' in result && Array.isArray(result.content)
  ) {
    const [first] = result.content
    if (
      typeof first === 'object' && first !== null &&
      'text' in first && typeof first.text === 'string'
    ) {
      return first.text
    }
  }
  return assert.fail('the tool result did not carry text content')
}

const noopSignal = undefined as any
const noopUpdate = undefined as any
const noopExt = undefined as any

test('broadcast bootstraps from the previous-stage artifact with no arguments', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcast-runtime-test-'))
  try {
    shouldDispatchThrow = false
    fs.writeFileSync(path.join(tmpDir, 'brief.md'), 'Incoming broadcast brief')
    const ctx = makeContext(tmpDir)
    const tool = createBroadcastTool(ctx)

    const result = await tool.execute('tc1', undefined as any, noopSignal, noopUpdate, noopExt)
    const text = (result.content[0] as any).text as string

    assert.match(text, /Broadcast Complete/)
    assert.ok(text.includes('Response from agent-a'))
    assert.ok(fs.existsSync(path.join(tmpDir, 'output.md')))
    assert.equal(ctx.state.levelStates.get('l1')?.stageStatus, STAGE_LIFECYCLE_STATUS.COMPLETED)
  } finally {
    shouldDispatchThrow = false
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('broadcast returns a clear bootstrap error when no input artifact or message exists', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcast-runtime-test-'))
  try {
    shouldDispatchThrow = false
    const ctx = makeContext(tmpDir)
    const tool = createBroadcastTool(ctx)

    const result = await tool.execute('tc1', undefined as any, noopSignal, noopUpdate, noopExt)
    const text = (result.content[0] as any).text as string

    assert.match(text, /Broadcast bootstrap failed:/)
    assert.equal(fs.existsSync(path.join(tmpDir, 'output.md')), false)
    assert.equal(ctx.state.levelStates.get('l1')?.stageStatus, STAGE_LIFECYCLE_STATUS.BLOCKED)
  } finally {
    shouldDispatchThrow = false
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('broadcast propagates aborts instead of reporting a completed stage', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcast-runtime-test-'))
  try {
    shouldDispatchThrow = true
    fs.writeFileSync(path.join(tmpDir, 'brief.md'), 'Incoming broadcast brief')
    const ctx = makeContext(tmpDir)
    const tool = createBroadcastTool(ctx)

    await assert.rejects(
      tool.execute('tc1', undefined as any, AbortSignal.abort(), noopUpdate, noopExt),
      /abort/i,
    )
    assert.equal(fs.existsSync(path.join(tmpDir, 'output.md')), false)
    assert.notEqual(ctx.state.levelStates.get('l1')?.stageStatus, STAGE_LIFECYCLE_STATUS.COMPLETED)
  } finally {
    shouldDispatchThrow = false
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})


test('broadcast whose participants all failed does not complete, writes no result artifact, and leaves the gate closed', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcast-runtime-test-'))
  try {
    shouldDispatchThrow = true
    fs.writeFileSync(path.join(tmpDir, 'brief.md'), 'Incoming broadcast brief')
    const ctx = makeContext(tmpDir)
    const tool = createBroadcastTool(ctx)

    const result = await tool.execute('tc1', {}, noopSignal, noopUpdate, noopExt)
    const text = toolResultText(result)

    assert.doesNotMatch(text, /Broadcast Complete/)
    assert.match(text, /Do not treat this stage as complete/i)
    assert.equal(ctx.state.levelStates.get('l1')?.stageStatus, STAGE_LIFECYCLE_STATUS.BLOCKED)

    // The *configured result* artifact specifically. `brief.md` is written before
    // fan-out by design, so asserting an empty assignment would be wrong.
    assert.equal(fs.existsSync(path.join(tmpDir, 'output.md')), false)
    assert.equal(fs.existsSync(path.join(tmpDir, 'brief.md')), true)

    // Suppressing the artifact is not enough on its own: gate readiness also
    // accepts a stored engine state whose aggregate is non-null, so the real
    // gate has to be asked rather than inferred from the missing file.
    assert.equal(isLevelReadyForGate(ctx.teamConfig.levels[1], tmpDir, ctx), false)
  } finally {
    shouldDispatchThrow = false
    failingAgentNames = []
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('broadcast with one surviving participant still completes and opens the gate', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcast-runtime-test-'))
  try {
    shouldDispatchThrow = false
    failingAgentNames = ['agent-b']
    fs.writeFileSync(path.join(tmpDir, 'brief.md'), 'Incoming broadcast brief')
    const ctx = makeContext(tmpDir)
    const tool = createBroadcastTool(ctx)

    const result = await tool.execute('tc1', {}, noopSignal, noopUpdate, noopExt)
    const text = toolResultText(result)

    // A partial fan-out is still a usable broadcast. Guarding "no successes"
    // must not become "any failure blocks the stage".
    assert.match(text, /Broadcast Complete/)
    assert.ok(text.includes('Response from agent-a'))
    assert.equal(ctx.state.levelStates.get('l1')?.stageStatus, STAGE_LIFECYCLE_STATUS.COMPLETED)
    assert.equal(fs.existsSync(path.join(tmpDir, 'output.md')), true)
    assert.equal(isLevelReadyForGate(ctx.teamConfig.levels[1], tmpDir, ctx), true)
  } finally {
    shouldDispatchThrow = false
    failingAgentNames = []
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})


test('a broadcast whose every agent halted fails the stage rather than blocking it', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcast-runtime-test-'))
  try {
    // A halt and a starved fan-out are different facts and must stay
    // distinguishable downstream, matching the split engines/discussion.ts uses:
    // a halt is FAILED, no successful participant is BLOCKED. The success-count
    // threshold cannot tell them apart, so it needs its own case.
    shouldDispatchThrow = true
    fs.writeFileSync(path.join(tmpDir, 'brief.md'), 'Incoming broadcast brief')
    const ctx = makeContext(tmpDir, { stageFailureOverride: 'halt' })
    const tool = createBroadcastTool(ctx)

    const result = await tool.execute('tc1', {}, noopSignal, noopUpdate, noopExt)
    const text = toolResultText(result)

    assert.doesNotMatch(text, /Broadcast Complete/)
    assert.match(text, /Do not treat this stage as complete/i)
    assert.match(text, /halted/i)
    assert.equal(ctx.state.levelStates.get('l1')?.stageStatus, STAGE_LIFECYCLE_STATUS.FAILED)

    assert.equal(fs.existsSync(path.join(tmpDir, 'output.md')), false)
    assert.equal(ctx.state.levelStates.get('l1')?.engineState?.aggregatedResult, null)
    assert.equal(isLevelReadyForGate(ctx.teamConfig.levels[1], tmpDir, ctx), false)
  } finally {
    shouldDispatchThrow = false
    failingAgentNames = []
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('a broadcast dispatch substitutes the concrete broadcast question into each agent system prompt', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcast-task-content-'))
  try {
    shouldDispatchThrow = false
    dispatchedSystemPrompts = []
    // Matches the shape the shipped agents use: `{{TASK_CONTENT}}` under a
    // `## Context` heading in the system prompt.
    fs.writeFileSync(
      path.join(tmpDir, 'brief.md'),
      'Which Michigan copper tailings risks matter?',
    )
    const ctx = makeContext(tmpDir)
    for (const name of ['agent-a', 'agent-b']) {
      ctx.agents.get(name).systemPrompt = `You are ${name}.\n\n## Context\n\n{{TASK_CONTENT}}`
    }
    const tool = createBroadcastTool(ctx)

    await tool.execute('tc-task-content', {}, noopSignal, noopUpdate, noopExt)

    // Every fan-out agent is dispatched, so every fan-out prompt must be clean —
    // asserting only the first would miss a per-agent regression.
    assert.equal(dispatchedSystemPrompts.length, 2)
    for (const prompt of dispatchedSystemPrompts) {
      assert.doesNotMatch(prompt, /\{\{TASK_CONTENT\}\}/)
      assert.match(prompt, /Which Michigan copper tailings risks matter\?/)
    }
  } finally {
    shouldDispatchThrow = false
    dispatchedSystemPrompts = []
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

test('a checkpoint taken during a broadcast stores each fan-out answer exactly once', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcast-runtime-test-'))
  try {
    shouldDispatchThrow = false
    failingAgentNames = []
    fs.writeFileSync(path.join(tmpDir, 'brief.md'), 'Incoming broadcast brief')
    const ctx = makeContext(tmpDir)
    const snapshots: string[] = []
    ctx.onStateCheckpoint = () => { snapshots.push(JSON.stringify(serializeCheckpoint(ctx.state))) }
    const tool = createBroadcastTool(ctx)

    await tool.execute('tc1', undefined as any, noopSignal, noopUpdate, noopExt)

    const carrying = snapshots.filter((snapshot) => snapshot.includes('Response from agent-a'))
    assert.ok(carrying.length > 0, 'No checkpoint captured the fan-out answer')
    for (const snapshot of carrying) {
      assert.equal(occurrences(snapshot, 'Response from agent-a'), 1,
        'A broadcast checkpoint must store each answer once')
    }
  } finally {
    shouldDispatchThrow = false
    failingAgentNames = []
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('a broadcast resumed from a checkpoint that carries both collections keeps one copy and does not redispatch a settled agent', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcast-runtime-test-'))
  try {
    shouldDispatchThrow = false
    failingAgentNames = []
    dispatchedSystemPrompts = []
    fs.writeFileSync(path.join(tmpDir, 'brief.md'), 'Incoming broadcast brief')
    const ctx = makeContext(tmpDir)
    // The shape a build before this change wrote while a fan-out was paused:
    // the same answer in both collections.
    const settled = { slot: 0, agent: 'agent-a', text: 'Response from agent-a', cost: 0.001, halted: false, succeeded: true }
    ctx.state.levelStates.get('l1').engineState = {
      type: 'broadcast',
      responses: [{ agent: settled.agent, text: settled.text, cost: settled.cost }],
      aggregatedResult: null,
      settledSlots: [settled],
    }
    const checkpoint = JSON.parse(JSON.stringify(serializeCheckpoint(ctx.state)))
    ctx.state.levelStates = restoreLevelStatesFromCheckpoint(checkpoint)
    const snapshots: string[] = []
    ctx.onStateCheckpoint = () => { snapshots.push(JSON.stringify(serializeCheckpoint(ctx.state))) }
    const tool = createBroadcastTool(ctx)

    const result = await tool.execute('tc1', undefined as any, noopSignal, noopUpdate, noopExt)

    const inFlight = snapshots.filter((snapshot) => snapshot.includes('Response from agent-a'))
    assert.ok(inFlight.length > 0, 'No checkpoint carried the inherited answer')
    for (const snapshot of inFlight) {
      assert.equal(occurrences(snapshot, 'Response from agent-a'), 1,
        'A resumed broadcast must not keep the inherited duplicate')
    }
    assert.deepEqual(dispatchedSystemPrompts.filter((prompt) => prompt.includes('You are agent-a.')), [],
      'A settled participant must not be dispatched again')
    assert.match((result.content[0] as any).text as string, /Broadcast Complete/)
  } finally {
    shouldDispatchThrow = false
    failingAgentNames = []
    dispatchedSystemPrompts = []
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
