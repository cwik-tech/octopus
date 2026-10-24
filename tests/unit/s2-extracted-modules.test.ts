/**
 * S2 Sprint Tests — Extracted modules
 *
 * Tests for:
 *   - dashboard.ts       (T4a) — renderProgressBar, getCurrentRound, renderAgentCard
 *   - level-lifecycle.ts (T5)  — assertActive
 *   - prompt-builder.ts  (T6)  — buildCoordinatorPrompt (template substitution)
 *   - commands.ts        (T4a) — registerCommands (smoke test for import)
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// NOTE: top-level files are included via tests/tsconfig.test.json `../*.ts`
import {
  renderProgressBar,
  getCurrentRound,
  renderAgentCard,
  renderGrid,
} from '../../team-runtime/dashboard.js'
import { assertActive } from '../../team-runtime/level-lifecycle.js'
import { buildCoordinatorPrompt } from '../../team-runtime/prompt-builder.js'
import { createRuntimeContext } from '../../domains/runtime/runtime-context.js'
import { AGENT_STATE, STAGE_TYPE, LEVEL_STATUS, STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'
import type {
  AgentMetrics,
  DelegationStatusSnapshot,
  LevelConfig,
  LevelState,
  LoadedAgent,
  TeamConfig,
} from '../../core/types.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal theme stub for renderProgressBar (only fg() is used). */
const stubTheme = {
  fg: (_style: string, text: string) => text,
}

/** Minimal ExtensionAPI stub for createRuntimeContext. */
const stubPi = {
  registerCommand: () => {},
  appendEntry: async () => {},
  setStatusBar: () => {},
  setWidget: () => {},
} as any

/** Build a minimal RuntimeContext with defaults and optional overrides. */
function makeCtx(overrides: Partial<ReturnType<typeof createRuntimeContext>> = {}) {
  const ctx = createRuntimeContext(stubPi)
  return Object.assign(ctx, overrides)
}

// ─── renderProgressBar ────────────────────────────────────────────────────────

test('renderProgressBar: BUDGET label renders dollar amounts', () => {
  const result = renderProgressBar('BUDGET', 1.5, 10, 60, stubTheme)
  assert.match(result, /\$1\.50/)
  assert.match(result, /\$10/)
})

test('renderProgressBar: non-BUDGET label renders minutes', () => {
  const result = renderProgressBar('TIME', 30, 120, 60, stubTheme)
  assert.match(result, /30\.0 min/)
  assert.match(result, /120 min/)
})

test('renderProgressBar: ratio clamped at 1 (over budget)', () => {
  // Should not throw even when current > max
  const result = renderProgressBar('BUDGET', 999, 10, 60, stubTheme)
  assert.ok(typeof result === 'string')
})

test('renderProgressBar: ratio 0 when current is 0', () => {
  const result = renderProgressBar('BUDGET', 0, 10, 60, stubTheme)
  assert.match(result, /\$0\.00/)
})

test('renderProgressBar: returns a non-empty string', () => {
  const result = renderProgressBar('TIME', 5, 60, 80, stubTheme)
  assert.ok(result.length > 0)
})

// ─── getCurrentRound ──────────────────────────────────────────────────────────

test('getCurrentRound: returns 0 when teamConfig is null', () => {
  const ctx = makeCtx({ teamConfig: null })
  assert.equal(getCurrentRound(ctx), 0)
})

test('getCurrentRound: returns 0 when currentLevelIndex is out of range', () => {
  const ctx = makeCtx({
    teamConfig: { levels: [], team: { name: 'T', description: '' }, agents: [] } as any,
  })
  ctx.state.currentLevelIndex = 99
  assert.equal(getCurrentRound(ctx), 0)
})

test('getCurrentRound: returns 0 when level has no engineState', () => {
  const ls: LevelState = {
    status: LEVEL_STATUS.ACTIVE,
    stageStatus: STAGE_LIFECYCLE_STATUS.READY,
    engineState: null,
    loopbackCount: 0,
  }
  const ctx = makeCtx({
    teamConfig: {
      levels: [{ id: 'level-1', stage: { type: STAGE_TYPE.DISCUSSION } }],
      team: { name: 'T', description: '' },
      agents: [],
    } as any,
  })
  ctx.state.levelStates.set('level-1', ls)
  ctx.state.currentLevelIndex = 0
  assert.equal(getCurrentRound(ctx), 0)
})

test('getCurrentRound: returns discussion round', () => {
  const ctx = makeCtx({
    teamConfig: {
      levels: [{ id: 'level-1', stage: { type: STAGE_TYPE.DISCUSSION } }],
      team: { name: 'T', description: '' },
      agents: [],
    } as any,
  })
  ctx.state.levelStates.set('level-1', {
    status: LEVEL_STATUS.ACTIVE,
    stageStatus: STAGE_LIFECYCLE_STATUS.RUNNING,
    engineState: { type: STAGE_TYPE.DISCUSSION, round: 3, messages: [], outputPath: '', approvedRoster: [] },
    loopbackCount: 0,
  })
  ctx.state.currentLevelIndex = 0
  assert.equal(getCurrentRound(ctx), 3)
})

test('getCurrentRound: returns review iteration', () => {
  const ctx = makeCtx({
    teamConfig: {
      levels: [{ id: 'level-1', stage: { type: STAGE_TYPE.REVIEW } }],
      team: { name: 'T', description: '' },
      agents: [],
    } as any,
  })
  ctx.state.levelStates.set('level-1', {
    status: LEVEL_STATUS.ACTIVE,
    stageStatus: STAGE_LIFECYCLE_STATUS.WAITING_ON_VALIDATOR,
    engineState: { type: STAGE_TYPE.REVIEW, iteration: 7, maxIterations: 5, lastVerdict: null, lastFeedback: '', lastDraft: '' },
    loopbackCount: 0,
  })
  ctx.state.currentLevelIndex = 0
  assert.equal(getCurrentRound(ctx), 7)
})

test('getCurrentRound: returns chain currentStep', () => {
  const ctx = makeCtx({
    teamConfig: {
      levels: [{ id: 'level-1', stage: { type: STAGE_TYPE.CHAIN } }],
      team: { name: 'T', description: '' },
      agents: [],
    } as any,
  })
  ctx.state.levelStates.set('level-1', {
    status: LEVEL_STATUS.ACTIVE,
    stageStatus: STAGE_LIFECYCLE_STATUS.RUNNING,
    engineState: { type: STAGE_TYPE.CHAIN, currentStep: 2, totalSteps: 5, outputs: [] },
    loopbackCount: 0,
  })
  ctx.state.currentLevelIndex = 0
  assert.equal(getCurrentRound(ctx), 2)
})

test('getCurrentRound: returns 0 for broadcast (no round field)', () => {
  const ctx = makeCtx({
    teamConfig: {
      levels: [{ id: 'level-1', stage: { type: STAGE_TYPE.BROADCAST } }],
      team: { name: 'T', description: '' },
      agents: [],
    } as any,
  })
  ctx.state.levelStates.set('level-1', {
    status: LEVEL_STATUS.ACTIVE,
    stageStatus: STAGE_LIFECYCLE_STATUS.RUNNING,
    engineState: { type: STAGE_TYPE.BROADCAST, responses: [], aggregatedResult: null },
    loopbackCount: 0,
  })
  ctx.state.currentLevelIndex = 0
  assert.equal(getCurrentRound(ctx), 0)
})

// ─── renderAgentCard ──────────────────────────────────────────────────────────

test('renderAgentCard: includes agent name in output', () => {
  const metrics = {
    status: 'idle' as const,
    totalCost: 0,
    totalTokens: 0,
    startTime: null,
    lastActivity: null,
    model: null,
    runCount: 0,
  }
  const result = renderAgentCard('alice', metrics as any, 40)
  assert.match(result.join('\n'), /alice/i)
})

test('renderAgentCard: returns a string (non-empty)', () => {
  const metrics = {
    status: 'working' as const,
    totalCost: 1.23,
    totalTokens: 500,
    startTime: Date.now() - 5000,
    lastActivity: Date.now(),
    model: 'claude-3-5-sonnet',
    runCount: 2,
  }
  const result = renderAgentCard('bob', metrics as any, 50)
  assert.ok(Array.isArray(result))
  assert.ok(result.length > 0)
})

test('renderAgentCard: includes the compact loaded model in brackets', () => {
  const metrics = {
    status: 'working' as const,
    totalCost: 0,
    totalTokens: 0,
    startTime: null,
    lastActivity: null,
    model: 'claude-sonnet-4-6',
    runCount: 0,
    state: 'idle',
    rounds: 0,
    contextTokens: 0,
    color: 36,
    failureCount: 0,
  }
  const result = renderAgentCard('alice', metrics as any, 80)
  assert.match(result.join('\n'), /\[sonnet-4-6\]/)
})

test('renderGrid: expands an active delegated team into live child agents from agent-runs log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-child-log-'))
  try {
    const childAssignmentPath = path.join(dir, 'workspace', 'assignments', 'child-session')
    fs.mkdirSync(path.join(childAssignmentPath, 'logs'), { recursive: true })
    fs.writeFileSync(
      path.join(childAssignmentPath, 'logs', 'agent-runs.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-04-13T02:38:49.349Z',
          event: 'start',
          session_id: 'child-session',
          assignment_path: childAssignmentPath,
          team: 'problem-thinking-board',
          agent_name: 'problem-decomposer',
          agent_type: 'agent',
          status: 'active',
          model: 'claude-sonnet-4-6',
        }),
        JSON.stringify({
          timestamp: '2026-04-13T02:40:03.436Z',
          event: 'start',
          session_id: 'child-session',
          assignment_path: childAssignmentPath,
          team: 'problem-thinking-board',
          agent_name: 'contrarian',
          agent_type: 'agent',
          status: 'active',
          model: 'claude-sonnet-4-6',
        }),
        JSON.stringify({
          timestamp: '2026-04-13T02:40:42.617Z',
          event: 'end',
          session_id: 'child-session',
          assignment_path: childAssignmentPath,
          team: 'problem-thinking-board',
          agent_name: 'futurist',
          agent_type: 'agent',
          status: 'completed',
          model: 'claude-sonnet-4-6',
        }),
      ].join('\n') + '\n',
    )

    const ctx = makeCtx({
      teamConfig: {
        team: { name: 'reception-desk', description: '', version: '0.1.0' },
        levels: [{
          id: 'intake',
          name: 'Intake',
          order: 0,
          permissions: { spawn_teams: true },
          stage: {
            type: STAGE_TYPE.ROUTING,
            coordinator: 'receptionist',
            config: {
              constraints: { max_time_minutes: 10, max_budget_usd: 10 },
              output: { format: 'routing-decision.md', user_review: false },
            },
          },
        }],
        agents: [],
      } as any,
    })

    ctx.state.currentLevelIndex = 0
    ctx.agentMetrics.set('receptionist', {
      state: 'active' as any,
      rounds: 0,
      totalCost: 0,
      contextTokens: 0,
      model: 'gpt-5.4-mini',
      color: 208,
      failureCount: 0,
    })
    ctx.agentMetrics.set('problem-thinking-board', {
      state: 'active' as any,
      rounds: 0,
      totalCost: 0,
      contextTokens: 0,
      model: 'team',
      color: 141,
      failureCount: 0,
    })
    ctx.agentMetrics.set('writing-team', {
      state: 'idle' as any,
      rounds: 0,
      totalCost: 0,
      contextTokens: 0,
      model: 'team',
      color: 118,
      failureCount: 0,
    })
    ctx.activeDelegations.set('delegation-1', {
      jobId: 'delegation-1',
      delegationId: 'delegation-1',
      fromTeam: 'reception-desk',
      fromLevel: 'intake',
      fromAgent: 'receptionist',
      toTeam: 'problem-thinking-board',
      requestedResultType: 'artifact:output/decomposition-plan.md',
      childAssignmentPath,
      startedAt: '2026-04-13T02:38:48.167Z',
      status: 'running',
    })

    const rendered = renderGrid(220, stubTheme, ctx).join('\n')
    assert.match(rendered, /\(3 active\)/)
    assert.match(rendered, /Problem Decomposer/)
    assert.match(rendered, /Contrarian/)
    assert.match(rendered, /Futurist/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * A parent running one delegation, whose child log lives at `childAssignmentPath`.
 *
 * The delegated Team carries a model of its own, which is the value the child
 * cards used to be labelled with.
 */
function delegatedChildContext(childAssignmentPath: string) {
  const teamConfig: TeamConfig = {
    team: { name: 'reception-desk', description: '', version: '0.1.0' },
    // No levels: these cases exercise how a delegated child's card reports its
    // model, and `renderGrid` reads the current level only for its header.
    levels: [],
    agents: [],
    gates: [],
    workspace: { path: 'workspace', watch: false },
  }
  const ctx = makeCtx({ teamConfig })
  ctx.state.currentLevelIndex = 0
  const receptionist: AgentMetrics = {
    state: AGENT_STATE.ACTIVE,
    rounds: 0,
    totalCost: 0,
    contextTokens: 0,
    model: 'gpt-5.4-mini',
    color: 208,
    failureCount: 0,
  }
  ctx.agentMetrics.set('receptionist', receptionist)
  const delegatedTeam: AgentMetrics = {
    state: AGENT_STATE.ACTIVE,
    rounds: 0,
    totalCost: 0,
    contextTokens: 0,
    model: 'gpt-parent-model',
    color: 141,
    failureCount: 0,
  }
  ctx.agentMetrics.set('problem-thinking-board', delegatedTeam)
  const delegation: DelegationStatusSnapshot = {
    jobId: 'delegation-1',
    delegationId: 'delegation-1',
    fromTeam: 'reception-desk',
    fromLevel: 'intake',
    fromAgent: 'receptionist',
    toTeam: 'problem-thinking-board',
    requestedResultType: 'artifact:output/decomposition-plan.md',
    childAssignmentPath,
    startedAt: '2026-04-13T02:38:48.167Z',
    status: 'running',
  }
  ctx.activeDelegations.set('delegation-1', delegation)
  return ctx
}

/**
 * A child agent whose own record names no model is not the parent's model.
 *
 * The dashboard filled a missing child model from `parentTeamMetrics.model`,
 * falling back to the delegated Team's name. So a child failure that recorded
 * no model — which its own event guard accepts as legitimate — was labelled
 * with the parent's model, and read as a fact about what the child ran on. It
 * is display-only misattribution rather than a dispatch fallback, but it
 * contradicts the same rule: an unknown history is reported as unknown.
 *
 * Driven through the public `renderGrid` with a real child log, because the
 * substitution happens while those metrics are being read from that file.
 */
test('renderGrid: a delegated child with no recorded model is not given the parent’s', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-child-unknown-model-'))
  try {
    const childAssignmentPath = path.join(dir, 'workspace', 'assignments', 'child-session')
    fs.mkdirSync(path.join(childAssignmentPath, 'logs'), { recursive: true })
    fs.writeFileSync(
      path.join(childAssignmentPath, 'logs', 'agent-runs.jsonl'),
      [
        // One child that recorded what it ran on, and one that did not.
        JSON.stringify({
          timestamp: '2026-04-13T02:38:49.349Z',
          event: 'start',
          session_id: 'child-session',
          assignment_path: childAssignmentPath,
          team: 'problem-thinking-board',
          agent_name: 'problem-decomposer',
          agent_type: 'agent',
          status: 'active',
          model: 'claude-sonnet-4-6',
        }),
        JSON.stringify({
          timestamp: '2026-04-13T02:40:42.617Z',
          event: 'fail',
          session_id: 'child-session',
          assignment_path: childAssignmentPath,
          team: 'problem-thinking-board',
          agent_name: 'contrarian',
          agent_type: 'agent',
          status: 'failed',
        }),
      ].join('\n') + '\n',
    )

    const rendered = renderGrid(
      220,
      stubTheme,
      delegatedChildContext(childAssignmentPath),
    ).join('\n')

    // Both children are on the grid.
    assert.match(rendered, /Problem Decomposer/)
    assert.match(rendered, /Contrarian/)
    // The one that recorded a model still shows it.
    assert.match(rendered, /Problem Decomposer[^\n]*\[sonnet-4-6\]/)
    // The one that did not is reported as unknown, not as the parent's model
    // and not as the delegated Team's name.
    assert.match(rendered, /Contrarian[^\n]*\[unknown\]/)
    assert.doesNotMatch(rendered, /Contrarian[^\n]*\[gpt-parent-model\]/)
    assert.doesNotMatch(rendered, /Contrarian[^\n]*\[problem-thinking-board\]/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * One attempt's model is not another attempt's.
 *
 * The card carried a model forward across every event with the same agent
 * name, so a retry that recorded none was labelled with the model the previous
 * attempt ran on. `dispatch_id` exists precisely to tell attempts apart
 * (`core/types.ts:624`), and a failed retry showing the earlier attempt's model
 * is a claim about what just failed that nothing recorded.
 *
 * Keeping a model across the same identified dispatch is legitimate — a start
 * and its own end are one attempt. Borrowing across a different one is not, and
 * where identity is missing there is nothing to match on, so nothing is
 * assumed.
 */
test('renderGrid: a retry with no recorded model does not borrow the previous attempt’s', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-child-retry-model-'))
  try {
    const childAssignmentPath = path.join(dir, 'workspace', 'assignments', 'child-session')
    fs.mkdirSync(path.join(childAssignmentPath, 'logs'), { recursive: true })
    const base = {
      session_id: 'child-session',
      assignment_path: childAssignmentPath,
      team: 'problem-thinking-board',
      agent_name: 'contrarian',
      agent_type: 'agent' as const,
    }
    fs.writeFileSync(
      path.join(childAssignmentPath, 'logs', 'agent-runs.jsonl'),
      [
        // Attempt A recorded what it ran on, across its own start and end.
        JSON.stringify({
          ...base,
          timestamp: '2026-04-13T02:38:49.349Z',
          event: 'start',
          status: 'active',
          dispatch_id: 'attempt-a',
          model: 'gpt-previous-attempt',
        }),
        JSON.stringify({
          ...base,
          timestamp: '2026-04-13T02:39:10.000Z',
          event: 'end',
          status: 'completed',
          dispatch_id: 'attempt-a',
        }),
        // Attempt B is a different dispatch, and recorded no model at all.
        JSON.stringify({
          ...base,
          timestamp: '2026-04-13T02:40:42.617Z',
          event: 'fail',
          status: 'failed',
          dispatch_id: 'attempt-b',
        }),
      ].join('\n') + '\n',
    )

    const rendered = renderGrid(220, stubTheme, delegatedChildContext(childAssignmentPath)).join('\n')

    assert.match(rendered, /Contrarian/)
    assert.match(rendered, /Contrarian[^\n]*\[unknown\]/)
    assert.doesNotMatch(rendered, /Contrarian[^\n]*\[gpt-previous-attempt\]/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * The other side of the same rule: one attempt keeps its own model.
 *
 * A start records what it dispatched and its own end usually does not repeat
 * it. Clearing the model there would report a completed attempt as unknown when
 * its model is on record, which is the over-correction the case above could
 * otherwise invite.
 */
test('renderGrid: a child keeps its own model across the same attempt’s end', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-child-same-attempt-'))
  try {
    const childAssignmentPath = path.join(dir, 'workspace', 'assignments', 'child-session')
    fs.mkdirSync(path.join(childAssignmentPath, 'logs'), { recursive: true })
    const base = {
      session_id: 'child-session',
      assignment_path: childAssignmentPath,
      team: 'problem-thinking-board',
      agent_name: 'contrarian',
      agent_type: 'agent' as const,
    }
    fs.writeFileSync(
      path.join(childAssignmentPath, 'logs', 'agent-runs.jsonl'),
      [
        JSON.stringify({
          ...base,
          timestamp: '2026-04-13T02:38:49.349Z',
          event: 'start',
          status: 'active',
          dispatch_id: 'attempt-a',
          model: 'claude-sonnet-4-6',
        }),
        JSON.stringify({
          ...base,
          timestamp: '2026-04-13T02:39:10.000Z',
          event: 'end',
          status: 'completed',
          dispatch_id: 'attempt-a',
        }),
      ].join('\n') + '\n',
    )

    const rendered = renderGrid(
      220,
      stubTheme,
      delegatedChildContext(childAssignmentPath),
    ).join('\n')

    assert.match(rendered, /Contrarian[^\n]*\[sonnet-4-6\]/)
    assert.doesNotMatch(rendered, /Contrarian[^\n]*\[unknown\]/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * A blank or wrong-typed identity is no identity.
 *
 * `isAgentRunEvent` does not check `dispatch_id`, so its declared type says
 * nothing about what is really in the file. If a malformed value could match
 * another malformed value, two unrelated attempts would look like one and the
 * borrowing this fix removes would come back through the JSON boundary.
 */
test('renderGrid: a malformed attempt identity never makes two events one attempt', () => {
  for (const [label, dispatchId] of [
    ['blank', ''],
    ['whitespace', '   '],
    ['not a string', 7],
    // Padded rather than empty. Trimming this to compare it would make
    // `attempt-a` and ` attempt-a ` one attempt, so it is refused instead.
    ['padded', ' attempt-a '],
  ] as const) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-child-bad-id-'))
    try {
      const childAssignmentPath = path.join(dir, 'workspace', 'assignments', 'child-session')
      fs.mkdirSync(path.join(childAssignmentPath, 'logs'), { recursive: true })
      const base = {
        session_id: 'child-session',
        assignment_path: childAssignmentPath,
        team: 'problem-thinking-board',
        agent_name: 'contrarian',
        agent_type: 'agent' as const,
      }
      fs.writeFileSync(
        path.join(childAssignmentPath, 'logs', 'agent-runs.jsonl'),
        [
          JSON.stringify({
            ...base,
            timestamp: '2026-04-13T02:38:49.349Z',
            event: 'start',
            status: 'active',
            dispatch_id: dispatchId,
            model: 'gpt-previous-attempt',
          }),
          JSON.stringify({
            ...base,
            timestamp: '2026-04-13T02:40:42.617Z',
            event: 'fail',
            status: 'failed',
            dispatch_id: dispatchId,
          }),
        ].join('\n') + '\n',
      )

      const rendered = renderGrid(
        220,
        stubTheme,
        delegatedChildContext(childAssignmentPath),
      ).join('\n')

      assert.match(rendered, /Contrarian[^\n]*\[unknown\]/, label)
      assert.doesNotMatch(rendered, /Contrarian[^\n]*\[gpt-previous-attempt\]/, label)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

/**
 * Two identities that differ are two identities.
 *
 * This value is compared, so normalizing it before the comparison would decide
 * that `attempt-a` and ` attempt-a ` are the same attempt — and the borrowing
 * the cases above remove would come back through the tidying. What is recorded
 * is what is compared.
 */
test('renderGrid: attempt identities that differ only by padding are not one attempt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-child-padded-id-'))
  try {
    const childAssignmentPath = path.join(dir, 'workspace', 'assignments', 'child-session')
    fs.mkdirSync(path.join(childAssignmentPath, 'logs'), { recursive: true })
    const base = {
      session_id: 'child-session',
      assignment_path: childAssignmentPath,
      team: 'problem-thinking-board',
      agent_name: 'contrarian',
      agent_type: 'agent' as const,
    }
    fs.writeFileSync(
      path.join(childAssignmentPath, 'logs', 'agent-runs.jsonl'),
      [
        JSON.stringify({
          ...base,
          timestamp: '2026-04-13T02:38:49.349Z',
          event: 'start',
          status: 'active',
          dispatch_id: 'attempt-a',
          model: 'gpt-previous-attempt',
        }),
        JSON.stringify({
          ...base,
          timestamp: '2026-04-13T02:40:42.617Z',
          event: 'fail',
          status: 'failed',
          dispatch_id: ' attempt-a ',
        }),
      ].join('\n') + '\n',
    )

    const rendered = renderGrid(
      220,
      stubTheme,
      delegatedChildContext(childAssignmentPath),
    ).join('\n')

    assert.match(rendered, /Contrarian[^\n]*\[unknown\]/)
    assert.doesNotMatch(rendered, /Contrarian[^\n]*\[gpt-previous-attempt\]/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ─── assertActive ─────────────────────────────────────────────────────────────

test('assertActive: throws if level state does not exist', () => {
  const ctx = makeCtx()
  assert.throws(
    () => assertActive(ctx, 'nonexistent-level'),
    /No level state for 'nonexistent-level'/,
  )
})

test('assertActive: throws if level is COMPLETED', () => {
  const ctx = makeCtx()
  ctx.state.levelStates.set('level-1', {
    status: LEVEL_STATUS.COMPLETED,
    stageStatus: STAGE_LIFECYCLE_STATUS.COMPLETED,
    engineState: null,
    loopbackCount: 0,
  })
  assert.throws(
    () => assertActive(ctx, 'level-1'),
    /expected active/,
  )
})

test('assertActive: throws if level is PENDING', () => {
  const ctx = makeCtx()
  ctx.state.levelStates.set('level-1', {
    status: LEVEL_STATUS.PENDING,
    stageStatus: STAGE_LIFECYCLE_STATUS.NOT_STARTED,
    engineState: null,
    loopbackCount: 0,
  })
  assert.throws(
    () => assertActive(ctx, 'level-1'),
    /expected active/,
  )
})

test('assertActive: returns LevelState when level is ACTIVE', () => {
  const ctx = makeCtx()
  const ls: LevelState = {
    status: LEVEL_STATUS.ACTIVE,
    stageStatus: STAGE_LIFECYCLE_STATUS.READY,
    engineState: null,
    loopbackCount: 0,
  }
  ctx.state.levelStates.set('level-1', ls)
  const result = assertActive(ctx, 'level-1')
  assert.equal(result, ls)
})

// ─── buildCoordinatorPrompt ────────────────────────────────────────────────────

function makeMinimalCtx() {
  const ctx = makeCtx()
  ctx.teamRoot = '/tmp/test-team'
  ctx.state.sessionId = 'sess-001'
  ctx.teamConfig = {
    team: { name: 'Test Team', description: 'A test team' },
    levels: [],
    agents: [
      { name: 'coordinator', role: 'Lead coordinator', agentDir: '/tmp/test-team/agents/coordinator' },
      { name: 'agent-a', role: 'Researcher', agentDir: '/tmp/test-team/agents/agent-a' },
    ],
    constraints: { maxBudget: 5, maxTime: 30 },
  } as any
  ctx.state.totalCost = 0.5
  ctx.state.startTime = Date.now() - 10000
  ctx.state.timerStarted = true
  ctx.inputFilesContent = 'brief content'
  const coord: LoadedAgent = {
    name: 'coordinator',
    role: 'Lead coordinator',
    agentDir: '/tmp/test-team/agents/coordinator',
    systemPrompt: 'You are a coordinator.',
    knowledgeContent: '',
    experienceContent: '',
    experienceEnabled: true,
    skillsContent: '',
  } as any
  ctx.agents.set('coordinator', coord)
  return { ctx, coord }
}

test('buildCoordinatorPrompt: substitutes SESSION_ID in coordinator systemPrompt', () => {
  const { ctx, coord } = makeMinimalCtx()
  coord.systemPrompt = 'Session: {{SESSION_ID}}'
  const result = buildCoordinatorPrompt('BASE', coord, undefined, ctx)
  assert.match(result, /Session: sess-001/)
})

test('buildCoordinatorPrompt: substitutes TEAM_NAME in coordinator systemPrompt', () => {
  const { ctx, coord } = makeMinimalCtx()
  coord.systemPrompt = 'Team: {{TEAM_NAME}}'
  const result = buildCoordinatorPrompt('BASE', coord, undefined, ctx)
  assert.match(result, /Team: Test Team/)
})

test('buildCoordinatorPrompt: includes eventSystemPrompt at the start', () => {
  const { ctx, coord } = makeMinimalCtx()
  const result = buildCoordinatorPrompt('MY_BASE_PROMPT', coord, undefined, ctx)
  assert.ok(result.startsWith('MY_BASE_PROMPT'))
})

test('buildCoordinatorPrompt: substitutes INPUT_FILES in coordinator systemPrompt', () => {
  const { ctx, coord } = makeMinimalCtx()
  coord.systemPrompt = 'Files: {{INPUT_FILES}}'
  ctx.inputFilesContent = 'brief content'
  const result = buildCoordinatorPrompt('BASE', coord, undefined, ctx)
  assert.match(result, /Files: brief content/)
})

test('buildCoordinatorPrompt: substitutes PARTICIPANTS for discussion stage', () => {
  const { ctx, coord } = makeMinimalCtx()
  coord.systemPrompt = 'Participants: {{PARTICIPANTS}}'
  // Use undefined level (no output.format issue); participants will be empty
  const result = buildCoordinatorPrompt('BASE', coord, undefined, ctx)
  // With no level, participantNames is [] so PARTICIPANTS is empty string
  assert.match(result, /Participants:/)
})

test('buildCoordinatorPrompt: returns a string even with unknown placeholders', () => {
  const { ctx, coord } = makeMinimalCtx()
  coord.systemPrompt = 'Hello {{UNKNOWN_VAR}} world'
  const result = buildCoordinatorPrompt('BASE', coord, undefined, ctx)
  // Unknown vars are left as-is by substituteTemplateVars
  assert.ok(typeof result === 'string')
  assert.ok(result.length > 0)
})

test('buildCoordinatorPrompt: no agentSelectionBlock for undefined level', () => {
  const { ctx, coord } = makeMinimalCtx()
  coord.systemPrompt = 'Hello'
  const result = buildCoordinatorPrompt('BASE', coord, undefined, ctx)
  assert.ok(!result.includes('Agent Selection Protocol'))
})

test('buildCoordinatorPrompt: uses canonical output artifact path when none exists yet', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-builder-'))
  try {
    const { ctx, coord } = makeMinimalCtx()
    ctx.teamRoot = tmpDir
    coord.agentDir = path.join(tmpDir, 'agents/coordinator')
    coord.systemPrompt = 'Output path: {{OUTPUT_PATH}}'

    const level: LevelConfig = {
      id: 'deliberation',
      name: 'Board Deliberation',
      order: 0,
      stage: {
        type: STAGE_TYPE.DISCUSSION,
        coordinator: 'coordinator',
        participants: ['agent-a'],
        config: {
          mode: 'deliberate' as any,
          min_rounds: 1,
          max_rounds: 3,
          constraints: { max_budget_usd: 10, max_time_minutes: 30 },
          output: { format: 'decomposition-plan.md', user_review: false },
        },
      },
    }

    const result = buildCoordinatorPrompt('BASE', coord, level, ctx)
    assert.match(result, /decomposition-plan\.md/)
    assert.doesNotMatch(result, /decomposition-plan-2\.md/)
    assert.ok(!result.includes('Existing Output Preservation'))
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('buildCoordinatorPrompt: versions discussion output path when canonical artifact already exists', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-builder-'))
  try {
    const { ctx, coord } = makeMinimalCtx()
    ctx.teamRoot = tmpDir
    coord.agentDir = path.join(tmpDir, 'agents/coordinator')
    coord.systemPrompt = 'Output path: {{OUTPUT_PATH}}\nMemo path: {{MEMO_PATH}}'

    const assignmentDir = path.join(tmpDir, 'workspace', 'assignments', ctx.state.sessionId)
    fs.mkdirSync(assignmentDir, { recursive: true })
    fs.writeFileSync(path.join(assignmentDir, 'decomposition-plan.md'), '# First pass')

    const level: LevelConfig = {
      id: 'deliberation',
      name: 'Board Deliberation',
      order: 0,
      stage: {
        type: STAGE_TYPE.DISCUSSION,
        coordinator: 'coordinator',
        participants: ['agent-a'],
        config: {
          mode: 'deliberate' as any,
          min_rounds: 1,
          max_rounds: 3,
          constraints: { max_budget_usd: 10, max_time_minutes: 30 },
          output: { format: 'decomposition-plan.md', user_review: false },
        },
      },
    }

    const result = buildCoordinatorPrompt('BASE', coord, level, ctx)
    assert.match(result, /decomposition-plan-2\.md/)
    assert.ok(result.includes('Do not overwrite or replace that file.'))
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
