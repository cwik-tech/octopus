import { whenDefined } from '../../core/optional-properties.js'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCoordinatorPrompt,
  resolveHostWorkflowPrompt,
  shouldRuntimeAutostartLevel,
} from '../../team-runtime/prompt-builder.js'
import { STAGE_TYPE } from '../../core/constants.js'
import type { LevelConfig, LoadedAgent, RuntimeState, TeamConfig } from '../../core/types.js'
import type { RuntimeContext } from '../../domains/runtime/runtime-context.js'

function makeLoadedAgent(name: string, tools?: string[]): LoadedAgent {
  return {
    name,
    model: 'gpt-5.4-mini',
    thinking: 'medium',
    ...whenDefined(tools, (definedTools) => ({ tools: definedTools })),
    systemPrompt: `You are ${name}.`,
    experienceContent: '',
    experienceEnabled: true,
    skillsContent: '',
    knowledgeContent: '',
    selection: null,
    agentDir: '/tmp',
    color: 36,
    provider: 'codex',
    providerConfig: {},
  }
}

function makeLevel(type: LevelConfig['stage']['type']): LevelConfig {
  switch (type) {
    case STAGE_TYPE.ROUTING:
      return {
        id: 'intake',
        name: 'Intake',
        order: 0,
        permissions: { spawn_teams: true },
        stage: {
          type,
          coordinator: 'editor',
          config: {
            output: { format: 'routing-decision.md', user_review: false },
          },
        },
      }
    case STAGE_TYPE.DISCUSSION:
      return {
        id: 'intake',
        name: 'Intake',
        order: 0,
        permissions: { spawn_teams: true },
        stage: {
          type,
          coordinator: 'editor',
          participants: ['writer'],
          config: {
            mode: 'deliberate',
            min_rounds: 1,
            max_rounds: 2,
            constraints: {
              max_time_minutes: 10,
              max_budget_usd: 10,
            },
            output: { format: 'routing-decision.md', user_review: false },
          },
        },
      }
    case STAGE_TYPE.PIPELINE:
      return {
        id: 'pipeline-level',
        name: 'Pipeline',
        order: 0,
        stage: {
          type,
          config: {
            parallel: false,
            gate: { type: 'all_tasks_terminal', strictness: 'hard' },
          },
        },
      }
    case STAGE_TYPE.REVIEW:
      return {
        id: 'review-level',
        name: 'Review',
        order: 0,
        stage: {
          type,
          coordinator: 'editor',
          producer: 'writer',
          reviewer: 'editor',
          config: {
            max_iterations: 3,
            output: { format: 'report.md', user_review: false },
          },
        },
      }
    default:
      throw new Error(`Unsupported test stage type: ${type}`)
  }
}

function makeTeamConfig(level: LevelConfig): TeamConfig {
  return {
    team: { name: 'test-team', description: 'Test team', version: '1.0.0' },
    workspace: { path: '/tmp/workspace', watch: false },
    levels: [level],
    gates: [],
    agents: [
      { name: 'editor', type: 'agent', role: 'Editor', tier: 'orchestration', agent_file: 'agents/editor.md' },
      { name: 'writer', type: 'agent', role: 'Writer', tier: 'execution', agent_file: 'agents/writer.md' },
    ],
  }
}

function makeRuntimeContext(level: LevelConfig): RuntimeContext {
  const state: RuntimeState = {
    sessionId: 'session-1',
    currentLevelIndex: 0,
    levelStates: new Map(),
    totalCost: 0,
    startTime: 0,
    timerStarted: false,
    endTime: null,
    spawnDepth: 0,
  }

  return {
    teamConfig: makeTeamConfig(level),
    teamRoot: '/tmp/team-root',
    inputFilesContent: '',
    agents: new Map([
      ['editor', makeLoadedAgent('editor', ['submit_for_review'])],
      ['writer', makeLoadedAgent('writer')],
    ]),
    rosterEntries: new Map(),
    teamRegistry: new Map(),
    workflowRegistry: new Map(),
    bootEntry: null,
    state,
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
    coordinatorToolCallsThisRun: 0,
    outerTurnOwner: null,
    pendingStageEntryLevelId: null,
    currentRegisteredTools: [],
    currentToolInvokers: new Map(),
    delegatedAutostartOwnsStage: false,
    pendingFollowUps: [],
    pendingFollowUpTimer: null,
    pi: {} as RuntimeContext['pi'],
    
    ENGINE_TOOLS: new Set(['dispatch', 'submit_for_review', 'spawn_team', 'spawn_workflow']),
    shutdownController: new AbortController(),
    
  }
}

test('buildCoordinatorPrompt frames deterministic review stages as runtime-owned supervision', () => {
  const level = makeLevel(STAGE_TYPE.REVIEW)
  const ctx = makeRuntimeContext(level)
  const coordinator = ctx.agents.get('editor')!

  const prompt = buildCoordinatorPrompt('BASE', coordinator, level, ctx)

  assert.match(prompt, /Routine review looping is runtime-owned\./)
  assert.match(prompt, /Call `submit_for_review\(\)` at most once when explicitly directed/)
  assert.match(prompt, /Do not call chain tools here/)
  assert.match(prompt, /You may only use these tools: submit_for_review\./)
  assert.doesNotMatch(prompt, /handoff/)
})

test('buildCoordinatorPrompt makes routing turns terminal after a routing tool call', () => {
  const level = makeLevel(STAGE_TYPE.ROUTING)
  const ctx = makeRuntimeContext(level)
  const coordinator = makeLoadedAgent('editor', ['spawn_team'])
  ctx.agents.set('editor', coordinator)

  const prompt = buildCoordinatorPrompt('BASE', coordinator, level, ctx)

  assert.match(prompt, /If the request is already clear, call `spawn_team` or `spawn_workflow` directly and stop\./)
  assert.match(prompt, /Once either routing tool returns, the routing decision is complete for this turn\./)
  assert.match(prompt, /Never claim the request was routed successfully after a routing-tool error\./)
})

test('buildCoordinatorPrompt includes active stage tools in the coordinator tool policy', () => {
  const level = makeLevel(STAGE_TYPE.DISCUSSION)
  const ctx = makeRuntimeContext(level)
  const coordinator = makeLoadedAgent('editor', ['spawn_team'])

  const prompt = buildCoordinatorPrompt('BASE', coordinator, level, ctx)

  assert.match(prompt, /You may only use these tools: set_roster, create_brief, converse, spawn_team\./)
})

test('the tool policy a coordinator is told matches the one it is judged by', () => {
  // A governed file tool is granted by the persona's `tools:` list and nothing
  // else, and authorization honours that grant past the level ceiling. The
  // prompt has to say the same thing: told "any other tool call will be
  // blocked", a coordinator that was granted `write` and not told so will not
  // use the only tool it has for producing its stage's artifact.
  const level = makeLevel(STAGE_TYPE.ROUTING)
  const ctx = makeRuntimeContext(level)
  const coordinator = makeLoadedAgent('editor', ['spawn_team', 'write'])

  const prompt = buildCoordinatorPrompt('BASE', coordinator, level, ctx)

  assert.match(prompt, /You may only use these tools: [^\n]*\bwrite\b/)
})

test('a tool the persona never granted stays absent from its tool policy', () => {
  const level = makeLevel(STAGE_TYPE.ROUTING)
  const ctx = makeRuntimeContext(level)
  const coordinator = makeLoadedAgent('editor', ['spawn_team', 'write'])

  const prompt = buildCoordinatorPrompt('BASE', coordinator, level, ctx)

  assert.doesNotMatch(prompt, /You may only use these tools: [^\n]*\bbash\b/)
})

test('resolveHostWorkflowPrompt falls back to a runtime workflow prompt when no coordinator exists', () => {
  const level = makeLevel(STAGE_TYPE.PIPELINE)
  const ctx = makeRuntimeContext(level)

  const prompt = resolveHostWorkflowPrompt('BASE', undefined, level, ctx)

  assert.ok(prompt, 'Expected a runtime workflow prompt')
  assert.match(prompt!, /This active level is runtime-controlled\./)
  assert.match(prompt!, /Workflow progression is owned by the runtime/)
  assert.match(prompt!, /Use `dispatch` only when the active runtime instruction or a recovery path explicitly tells you to do so\./)
})

test('resolveHostWorkflowPrompt uses the runtime workflow prompt for review stages without a coordinator', () => {
  const level = makeLevel(STAGE_TYPE.REVIEW)
  delete (level.stage as { coordinator?: string }).coordinator
  const ctx = makeRuntimeContext(level)

  const prompt = resolveHostWorkflowPrompt('BASE', undefined, level, ctx)

  assert.ok(prompt, 'Expected a runtime workflow prompt')
  assert.match(prompt!, /This active level is runtime-controlled\./)
  assert.match(prompt!, /Only use stage tools when the active runtime follow-up or an explicit recovery instruction tells you to do so\./)
  assert.match(prompt!, /Call `submit_for_review\(\)` at most once when explicitly directed/)
  assert.doesNotMatch(prompt!, /You are editor\./)
})

/**
 * The NOOP prompt is only correct while the runtime genuinely owns stage
 * execution. It is keyed on `delegatedAutostartOwnsStage`, a fact
 * `startActiveLevel` establishes, rather than on `TEAM_DELEGATED_AUTOSTART`,
 * which only says a delegated run was *intended*. A delegated run whose
 * autostart never started the stage must fall back to the coordinator, or the
 * child ends idle with no artifact and no way to recover.
 */
function withDelegatedAutostartEnv<T>(run: () => T): T {
  const previous = process.env.TEAM_DELEGATED_AUTOSTART
  process.env.TEAM_DELEGATED_AUTOSTART = '1'
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env.TEAM_DELEGATED_AUTOSTART
    else process.env.TEAM_DELEGATED_AUTOSTART = previous
  }
}

function withRecoveryEnv<T>(run: () => T): T {
  const previous = process.env.TEAM_RUNTIME_RECOVERY
  process.env.TEAM_RUNTIME_RECOVERY = '1'
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env.TEAM_RUNTIME_RECOVERY
    else process.env.TEAM_RUNTIME_RECOVERY = previous
  }
}

test('resolveHostWorkflowPrompt returns a NOOP prompt when runtime autostart owns the stage', () => {
  withDelegatedAutostartEnv(() => {
    const level = makeLevel(STAGE_TYPE.REVIEW)
    delete (level.stage as { coordinator?: string }).coordinator
    const ctx = makeRuntimeContext(level)
    ctx.delegatedAutostartOwnsStage = true

    const prompt = resolveHostWorkflowPrompt('BASE', undefined, level, ctx)

    assert.ok(prompt, 'Expected a delegated-autostart NOOP prompt')
    assert.match(prompt!, /Delegated child runtime autostart is active for this session\./)
    assert.match(prompt!, /Reply with exactly NOOP\./)
    assert.doesNotMatch(prompt!, /Only use stage tools when the active runtime follow-up/)
  })
})

test('resolveHostWorkflowPrompt returns a NOOP prompt for owned coordinator stages', () => {
  withDelegatedAutostartEnv(() => {
    const level = makeLevel(STAGE_TYPE.ROUTING)
    const ctx = makeRuntimeContext(level)
    ctx.delegatedAutostartOwnsStage = true
    const coordinator = makeLoadedAgent('editor', ['spawn_team'])

    const prompt = resolveHostWorkflowPrompt('BASE', coordinator, level, ctx)

    assert.ok(prompt, 'Expected a delegated-autostart NOOP prompt')
    assert.match(prompt!, /runtime, not the host model, owns stage execution/i)
    assert.doesNotMatch(prompt!, /call `spawn_team`/i)
  })
})

test('resolveHostWorkflowPrompt hands a delegated discussion back to the coordinator when autostart did not own the stage', () => {
  withDelegatedAutostartEnv(() => {
    const level = makeLevel(STAGE_TYPE.DISCUSSION)
    const ctx = makeRuntimeContext(level)
    ctx.delegatedAutostartOwnsStage = false
    ctx.state.parentSessionId = 'parent-session-1'
    const coordinator = makeLoadedAgent('editor', ['spawn_team'])

    const prompt = resolveHostWorkflowPrompt('BASE', coordinator, level, ctx)

    assert.ok(prompt, 'Expected a coordinator prompt')
    assert.doesNotMatch(prompt!, /Reply with exactly NOOP\./)
    assert.match(prompt!, /You may only use these tools: set_roster, create_brief, converse, spawn_team\./)
    // The delegated-child protocol, previously unreachable dead code.
    assert.match(prompt!, /Delegated Child Team Protocol/)
    assert.match(prompt!, /Call `set_roster\(agents=\[\.\.\.\]\)` without asking for external approval\./)
  })
})

test('resolveHostWorkflowPrompt hands a delegated runtime-controlled stage back when autostart did not own it', () => {
  withDelegatedAutostartEnv(() => {
    const level = makeLevel(STAGE_TYPE.REVIEW)
    delete (level.stage as { coordinator?: string }).coordinator
    const ctx = makeRuntimeContext(level)
    ctx.delegatedAutostartOwnsStage = false

    const prompt = resolveHostWorkflowPrompt('BASE', undefined, level, ctx)

    assert.ok(prompt, 'Expected a runtime workflow prompt')
    assert.doesNotMatch(prompt!, /Reply with exactly NOOP\./)
    assert.match(prompt!, /This active level is runtime-controlled\./)
  })
})

test('resolveHostWorkflowPrompt never NOOPs a recovery attempt, even when autostart claims the stage', () => {
  withDelegatedAutostartEnv(() => {
    withRecoveryEnv(() => {
      const level = makeLevel(STAGE_TYPE.DISCUSSION)
      const ctx = makeRuntimeContext(level)
      // The recovery attempt exists because the previous one produced nothing.
      // Ownership must not be able to silence it a second time.
      ctx.delegatedAutostartOwnsStage = true
      ctx.state.parentSessionId = 'parent-session-1'
      const coordinator = makeLoadedAgent('editor', ['spawn_team'])

      const prompt = resolveHostWorkflowPrompt('BASE', coordinator, level, ctx)

      assert.ok(prompt, 'Expected a coordinator prompt')
      assert.doesNotMatch(prompt!, /Reply with exactly NOOP\./)
      assert.match(prompt!, /Delegated Child Team Protocol/)
    })
  })
})

test('resolveHostWorkflowPrompt lets a direct-chat discussion coordinator select its roster', () => {
  const previousAutostart = process.env.TEAM_DELEGATED_AUTOSTART
  const previousChatMode = process.env.TEAM_CHAT_MODE
  process.env.TEAM_DELEGATED_AUTOSTART = '1'
  process.env.TEAM_CHAT_MODE = '1'

  try {
    const level = makeLevel(STAGE_TYPE.DISCUSSION)
    const ctx = makeRuntimeContext(level)
    ctx.state.parentSessionId = 'parent-run'
    ctx.inputFilesContent = [
      '# Current user message',
      'What Michigan mining risks matter?',
      '# Conversation continuity',
      'Previous user message: Which mining thesis is strongest?',
    ].join('\n')
    const coordinator = makeLoadedAgent('editor', [
      'set_roster',
      'create_brief',
      'converse',
    ])
    coordinator.systemPrompt = 'Task:\n{{TASK_CONTENT}}'

    const prompt = resolveHostWorkflowPrompt('BASE', coordinator, level, ctx)

    assert.ok(prompt, 'Expected the discussion coordinator prompt')
    assert.match(prompt, /Select the smallest appropriate roster yourself/i)
    assert.match(prompt, /call `set_roster\(agents=\[\.\.\.\]\)` without asking/i)
    assert.match(prompt, /prefer previous responders whose expertise remains relevant/i)
    assert.match(prompt, /include valid agents explicitly mentioned with @/i)
    assert.match(prompt, /default to exactly 3 participants/i)
    assert.match(prompt, /expand to a maximum of 5/i)
    assert.match(prompt, /explicitly requests a participant count.*honor that count.*greater than 5/i)
    assert.match(prompt, /fewer than 3.*select all/i)
    assert.match(prompt, /do not create or promise a file/i)
    assert.match(prompt, /Task:\n# Current user message\nWhat Michigan mining risks matter\?/)
    assert.match(prompt, /Previous user message: Which mining thesis is strongest\?/)
    assert.doesNotMatch(prompt, /Reply with exactly NOOP/i)
  } finally {
    if (previousAutostart === undefined) delete process.env.TEAM_DELEGATED_AUTOSTART
    else process.env.TEAM_DELEGATED_AUTOSTART = previousAutostart
    if (previousChatMode === undefined) delete process.env.TEAM_CHAT_MODE
    else process.env.TEAM_CHAT_MODE = previousChatMode
  }
})

test('delegated direct Team chat gives discussion execution to the runtime', () => {
  const level = makeLevel(STAGE_TYPE.DISCUSSION)

  const ownsDiscussion = shouldRuntimeAutostartLevel(level, {
    TEAM_DELEGATED_AUTOSTART: '1',
    TEAM_CHAT_MODE: '1',
  })

  assert.equal(ownsDiscussion, true)
})
