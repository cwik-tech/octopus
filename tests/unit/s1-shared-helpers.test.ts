/**
 * S1 Sprint Tests — Extracted foundation modules
 *
 * Tests for:
 *   - core/verdict-parser.ts  (T2)
 *   - domains/runtime/template.ts (T1)
 *   - core/stage-helpers.ts     (T1)
 *   - domains/runtime/runtime-context.ts (T1)
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalizeReviewFeedback, parseTaggedVerdict, parseVerdict } from '../../core/verdict-parser.js'
import { substituteTemplateVars } from '../../domains/runtime/template.js'
import {
  getParticipantNames,
  getCoordinatorName,
  getConstraintSummary,
  getCurrentConstraints,
  getOutputFormat,
  resolveEntryLevelIndex,
} from '../../core/stage-helpers.js'
import {
  buildPersistedRuntimeState,
  createRuntimeContext,
  restorePersistedRuntimeState,
} from '../../domains/runtime/runtime-context.js'
import type { LevelConfig } from '../../core/types.js'
import { STAGE_TYPE, LEVEL_STATUS, STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'

// ─── parseVerdict ────────────────────────────────────────────────────────────

test('parseVerdict returns matching allowed value (case-insensitive)', () => {
  const result = parseVerdict('PASS\nsome other text', ['PASS', 'FAIL'] as const)
  assert.equal(result, 'PASS')
})

test('parseVerdict matches lowercase input to uppercase allowed', () => {
  const result = parseVerdict('pass', ['PASS', 'FAIL'] as const)
  assert.equal(result, 'PASS')
})

test('parseVerdict skips leading empty lines', () => {
  const result = parseVerdict('\n\n  FAIL\n', ['PASS', 'FAIL'] as const)
  assert.equal(result, 'FAIL')
})

test('parseVerdict returns null when no match', () => {
  const result = parseVerdict('UNKNOWN', ['PASS', 'FAIL'] as const)
  assert.equal(result, null)
})

test('parseVerdict returns null for empty string', () => {
  const result = parseVerdict('', ['PASS', 'FAIL'] as const)
  assert.equal(result, null)
})

test('parseVerdict returns null for whitespace-only string', () => {
  const result = parseVerdict('   \n  ', ['PASS', 'FAIL'] as const)
  assert.equal(result, null)
})

test('parseVerdict works with mixed-case in text', () => {
  const result = parseVerdict('Approved', ['APPROVED', 'REJECTED'] as const)
  assert.equal(result, 'APPROVED')
})

test('parseVerdict rejects verdicts that are not on the first non-empty line', () => {
  const result = parseVerdict('# Editorial Review\nAPPROVE', ['APPROVE', 'REVISE'] as const)
  assert.equal(result, null)
})

test('parseVerdict rejects prefixed verdict labels on the first non-empty line', () => {
  const result = parseVerdict('Verdict: APPROVE\nLooks good.', ['APPROVE', 'REVISE'] as const)
  assert.equal(result, null)
})

test('parseTaggedVerdict extracts a tagged verdict from anywhere in the response', () => {
  const result = parseTaggedVerdict(
    'Progress note.\n<review_decision>APPROVE</review_decision>\nLooks good.',
    ['APPROVE', 'REVISE'] as const,
    'review_decision',
  )
  assert.equal(result, 'APPROVE')
})

test('parseTaggedVerdict rejects multiple valid tagged verdicts', () => {
  const result = parseTaggedVerdict(
    '<review_decision>REVISE</review_decision>\nCorrection\n<review_decision>APPROVE</review_decision>',
    ['APPROVE', 'REVISE'] as const,
    'review_decision',
  )
  assert.equal(result, null)
})

test('parseTaggedVerdict rejects invalid tagged verdict values', () => {
  const result = parseTaggedVerdict(
    '<review_decision>MAYBE</review_decision>\nLooks good.',
    ['APPROVE', 'REVISE'] as const,
    'review_decision',
  )
  assert.equal(result, null)
})

test('canonicalizeReviewFeedback strips reviewer chatter before a valid decision tag', () => {
  const result = canonicalizeReviewFeedback(
    'Checking files first.\n<review_decision>APPROVE</review_decision>\nLooks good.',
    ['APPROVE', 'REVISE'] as const,
    'review_decision',
  )
  assert.equal(result, '<review_decision>APPROVE</review_decision>\nLooks good.')
})

test('canonicalizeReviewFeedback preserves invalid multi-tag output for diagnostics', () => {
  const input =
    '<review_decision>REVISE</review_decision>\nNeed changes.\n' +
    '<review_decision>APPROVE</review_decision>\nActually approved.'
  const result = canonicalizeReviewFeedback(
    input,
    ['APPROVE', 'REVISE'] as const,
    'review_decision',
  )
  assert.equal(result, input)
})

// ─── substituteTemplateVars ──────────────────────────────────────────────────

test('substituteTemplateVars replaces a single variable', () => {
  const result = substituteTemplateVars('Hello {{NAME}}!', { NAME: 'World' })
  assert.equal(result, 'Hello World!')
})

test('substituteTemplateVars replaces multiple occurrences', () => {
  const result = substituteTemplateVars('{{X}} and {{X}}', { X: 'foo' })
  assert.equal(result, 'foo and foo')
})

test('substituteTemplateVars replaces multiple different variables', () => {
  const result = substituteTemplateVars('{{A}} + {{B}}', { A: '1', B: '2' })
  assert.equal(result, '1 + 2')
})

test('substituteTemplateVars leaves unknown placeholders untouched', () => {
  const result = substituteTemplateVars('{{UNKNOWN}}', { OTHER: 'val' })
  assert.equal(result, '{{UNKNOWN}}')
})

test('substituteTemplateVars returns template unchanged if vars is empty', () => {
  const template = 'No placeholders here'
  assert.equal(substituteTemplateVars(template, {}), template)
})

test('substituteTemplateVars handles empty string template', () => {
  assert.equal(substituteTemplateVars('', { A: 'val' }), '')
})

// ─── getParticipantNames ─────────────────────────────────────────────────────

function makeDiscussionLevel(): LevelConfig {
  return {
    id: 'l1',
    name: 'Level 1',
    order: 0,
    stage: {
      type: STAGE_TYPE.DISCUSSION,
      coordinator: 'alpha',
      participants: ['alpha', 'beta'],
      config: {
        mode: 'deliberate',
        min_rounds: 1,
        max_rounds: 3,
        constraints: { max_time_minutes: 30, max_budget_usd: 5 },
        output: { format: 'report.md' },
      },
    },
    gates: [],
  } as unknown as LevelConfig
}

function makeReviewLevel(): LevelConfig {
  return {
    id: 'l2',
    name: 'Level 2',
    order: 1,
    stage: {
      type: STAGE_TYPE.REVIEW,
      coordinator: 'alpha',
      producer: 'alpha',
      reviewer: 'beta',
      config: {
        max_rounds: 2,
        constraints: { max_time_minutes: 20, max_budget_usd: 3 },
        output: { format: 'review.md' },
      },
    },
    gates: [],
  } as unknown as LevelConfig
}

test('getParticipantNames returns discussion participants', () => {
  const names = getParticipantNames(makeDiscussionLevel())
  assert.deepEqual(names, ['alpha', 'beta'])
})

test('getParticipantNames returns [producer, reviewer] for review stage', () => {
  const names = getParticipantNames(makeReviewLevel())
  assert.deepEqual(names, ['alpha', 'beta'])
})

test('getParticipantNames returns empty array for undefined level', () => {
  assert.deepEqual(getParticipantNames(undefined), [])
})

// ─── getCoordinatorName ──────────────────────────────────────────────────────

test('getCoordinatorName returns coordinator from discussion stage', () => {
  assert.equal(getCoordinatorName(makeDiscussionLevel()), 'alpha')
})

test('getCoordinatorName returns coordinator from review stage', () => {
  assert.equal(getCoordinatorName(makeReviewLevel()), 'alpha')
})

// ─── getConstraintSummary ────────────────────────────────────────────────────

test('getConstraintSummary returns formatted string', () => {
  // Pinned exactly, so wording drift in a string that reaches a system prompt
  // is a deliberate edit rather than an accident. The advisory qualifier is part
  // of the contract now — see the D2 test at the end of this file.
  const summary = getConstraintSummary(makeDiscussionLevel())
  assert.equal(
    summary,
    'Time: 30 min; Advisory budget guidance: $5 (budget not runtime-enforced)',
  )
})

test('getConstraintSummary returns fallback for undefined level', () => {
  assert.equal(getConstraintSummary(undefined), 'No constraints configured')
})

test('getConstraintSummary returns fallback when no constraints on config', () => {
  const level = {
    id: 'l3',
    name: 'L3',
    order: 2,
    stage: {
      type: STAGE_TYPE.PIPELINE,
      coordinator: 'alpha',
      participants: ['alpha'],
      config: {},
    },
    gates: [],
  } as unknown as LevelConfig
  assert.equal(getConstraintSummary(level), 'No constraints configured')
})

// ─── getCurrentConstraints ───────────────────────────────────────────────────

test('getCurrentConstraints returns numeric values', () => {
  const c = getCurrentConstraints(makeDiscussionLevel())
  assert.deepEqual(c, { maxTime: 30, maxBudget: 5 })
})

test('getCurrentConstraints returns null for undefined level', () => {
  assert.equal(getCurrentConstraints(undefined), null)
})

// ─── getOutputFormat ─────────────────────────────────────────────────────────

test('getOutputFormat returns configured format for discussion stage', () => {
  assert.equal(getOutputFormat(makeDiscussionLevel()), 'report.md')
})

test('getOutputFormat returns report.md fallback for undefined level', () => {
  assert.equal(getOutputFormat(undefined), 'report.md')
})

test('getOutputFormat returns report.md for pipeline stage (no single output)', () => {
  const pipelineLevel = {
    id: 'l4',
    name: 'L4',
    order: 3,
    stage: {
      type: STAGE_TYPE.PIPELINE,
      coordinator: 'alpha',
      participants: ['alpha'],
      config: {},
    },
    gates: [],
  } as unknown as LevelConfig
  assert.equal(getOutputFormat(pipelineLevel), 'report.md')
})

// ─── createRuntimeContext ────────────────────────────────────────────────────

test('resolveEntryLevelIndex selects a declared entry after the first level', () => {
  assert.equal(
    resolveEntryLevelIndex(
      [{ id: 'warmup' }, { id: 'deliberation' }],
      'deliberation',
    ),
    1,
  )
})

test('resolveEntryLevelIndex defaults to the first level when no entry is declared', () => {
  assert.equal(resolveEntryLevelIndex([{ id: 'warmup' }, { id: 'run' }]), 0)
})

test('resolveEntryLevelIndex defensively defaults to the first level for an unknown entry', () => {
  assert.equal(
    resolveEntryLevelIndex([{ id: 'warmup' }, { id: 'run' }], 'missing'),
    0,
  )
})

test('createRuntimeContext returns valid initial state', () => {
  // Mock minimal ExtensionAPI
  const mockPi = {} as any
  const ctx = createRuntimeContext(mockPi)

  assert.equal(ctx.teamConfig, null)
  assert.equal(ctx.teamRoot, '')
  assert.equal(ctx.inputFilesContent, '')
  assert.ok(ctx.agents instanceof Map)
  assert.ok(ctx.rosterEntries instanceof Map)
  assert.equal(ctx.coordinatorRunId, 0)
  assert.equal(ctx.setupMode, false)
  assert.equal(ctx.lastCtx, null)
  assert.equal(ctx.refreshTimer, null)
  assert.equal(ctx.pi, mockPi)
  assert.ok(ctx.ENGINE_TOOLS instanceof Set)
})

test('createRuntimeContext ENGINE_TOOLS contains expected tool names', () => {
  const ctx = createRuntimeContext({} as any)
  const expectedTools = ['converse', 'broadcast', 'handoff', 'dispatch', 'submit_for_review']
  for (const tool of expectedTools) {
    assert.ok(ctx.ENGINE_TOOLS.has(tool), `Expected ENGINE_TOOLS to contain '${tool}'`)
  }
})

test('createRuntimeContext initial state has sessionId empty string', () => {
  const ctx = createRuntimeContext({} as any)
  assert.equal(ctx.state.sessionId, '')
  assert.equal(ctx.state.currentLevelIndex, 0)
  assert.equal(ctx.state.totalCost, 0)
})

test('buildPersistedRuntimeState includes session lineage fields for resume/fork compatibility', () => {
  const ctx = createRuntimeContext({} as any)
  ctx.state.sessionId = 'session-123'
  ctx.state.rootSessionId = 'root-123'
  ctx.state.parentSessionId = 'parent-123'
  ctx.state.currentLevelIndex = 2

  const snapshot = buildPersistedRuntimeState(ctx.state)

  assert.equal(snapshot.sessionId, 'session-123')
  assert.equal(snapshot.rootSessionId, 'root-123')
  assert.equal(snapshot.parentSessionId, 'parent-123')
  assert.equal(snapshot.currentLevelIndex, 2)
})

test('restorePersistedRuntimeState restores session lineage without clobbering unrelated levels', () => {
  const ctx = createRuntimeContext({} as any)
  ctx.state.levelStates.set('level-1', {
    status: LEVEL_STATUS.ACTIVE,
    stageStatus: STAGE_LIFECYCLE_STATUS.READY,
    engineState: null,
    loopbackCount: 0,
  })

  restorePersistedRuntimeState(ctx.state, {
    sessionId: 'session-456',
    rootSessionId: 'root-456',
    parentSessionId: 'parent-456',
    currentLevelIndex: 1,
    levelStates: {
      'level-1': {
        status: LEVEL_STATUS.COMPLETED,
        stageStatus: STAGE_LIFECYCLE_STATUS.COMPLETED,
        loopbackCount: 3,
      },
      'missing-level': {
        status: LEVEL_STATUS.ACTIVE,
        stageStatus: STAGE_LIFECYCLE_STATUS.RUNNING,
        loopbackCount: 9,
      },
    },
  })

  assert.equal(ctx.state.sessionId, 'session-456')
  assert.equal(ctx.state.rootSessionId, 'root-456')
  assert.equal(ctx.state.parentSessionId, 'parent-456')
  assert.equal(ctx.state.currentLevelIndex, 1)
  assert.equal(ctx.state.levelStates.get('level-1')?.status, LEVEL_STATUS.COMPLETED)
  assert.equal(ctx.state.levelStates.get('level-1')?.stageStatus, STAGE_LIFECYCLE_STATUS.COMPLETED)
  assert.equal(ctx.state.levelStates.get('level-1')?.loopbackCount, 3)
  assert.equal(ctx.state.levelStates.has('missing-level'), false)
})

/**
 * One authoritative recovery snapshot.
 *
 * Startup has two restore sources — the disk checkpoint and the Pi session
 * journal — and the second used to be applied unconditionally over the first,
 * overwriting nine of the same fields plus every level's status. The flag that
 * records "an authoritative snapshot was accepted" was assigned and never read.
 *
 * This matters more now than it did: the checkpoint carries the host's entry
 * admission and the session entry does not, so a session entry that moved the
 * level index would leave that admission describing a level the run is no
 * longer on. The checkpoint owns everything it carries; `tenantId` is the one
 * field it does not, so that is the one field the session entry may still
 * supply.
 */
test('an accepted authoritative snapshot is not overwritten by a session entry', () => {
  const ctx = createRuntimeContext({} as any)
  ctx.state.sessionId = 'from-checkpoint'
  ctx.state.currentLevelIndex = 1
  ctx.state.totalCost = 12
  ctx.state.timerStarted = true
  ctx.state.endTime = null
  ctx.state.levelStates.set('level-1', {
    status: LEVEL_STATUS.COMPLETED,
    stageStatus: STAGE_LIFECYCLE_STATUS.COMPLETED,
    engineState: null,
    loopbackCount: 0,
    visitCount: 2,
  })

  restorePersistedRuntimeState(
    ctx.state,
    {
      sessionId: 'from-session-entry',
      currentLevelIndex: 0,
      totalCost: 0,
      timerStarted: false,
      endTime: 1,
      rootSessionId: 'stale-root',
      parentSessionId: 'stale-parent',
      levelStates: {
        'level-1': {
          status: LEVEL_STATUS.ACTIVE,
          stageStatus: STAGE_LIFECYCLE_STATUS.READY,
          loopbackCount: 7,
          visitCount: 0,
        },
      },
    },
    { authoritativeSnapshotAccepted: true },
  )

  assert.equal(ctx.state.sessionId, 'from-checkpoint')
  assert.equal(ctx.state.currentLevelIndex, 1)
  assert.equal(ctx.state.totalCost, 12)
  assert.equal(ctx.state.timerStarted, true)
  assert.equal(ctx.state.endTime, null)
  assert.equal(ctx.state.rootSessionId, undefined)
  assert.equal(ctx.state.parentSessionId, undefined)
  assert.equal(ctx.state.levelStates.get('level-1')?.status, LEVEL_STATUS.COMPLETED)
  assert.equal(
    ctx.state.levelStates.get('level-1')?.stageStatus,
    STAGE_LIFECYCLE_STATUS.COMPLETED,
  )
  assert.equal(ctx.state.levelStates.get('level-1')?.loopbackCount, 0)
  assert.equal(ctx.state.levelStates.get('level-1')?.visitCount, 2)
})

test('the tenant the checkpoint does not carry is still restored beside it', () => {
  const ctx = createRuntimeContext({} as any)
  ctx.state.tenantId = 'local'

  restorePersistedRuntimeState(
    ctx.state,
    { sessionId: 'from-session-entry', tenantId: 'acme' },
    { authoritativeSnapshotAccepted: true },
  )

  assert.equal(ctx.state.tenantId, 'acme')
  assert.equal(ctx.state.sessionId, '')
})

test('without an accepted snapshot the session entry still restores everything', () => {
  // The direct CLI resume path has no checkpoint of its own to defer to, and
  // this is its only restore. Making the checkpoint authoritative must not take
  // that away.
  const ctx = createRuntimeContext({} as any)
  ctx.state.levelStates.set('level-1', {
    status: LEVEL_STATUS.ACTIVE,
    stageStatus: STAGE_LIFECYCLE_STATUS.READY,
    engineState: null,
    loopbackCount: 0,
  })

  restorePersistedRuntimeState(ctx.state, {
    sessionId: 'session-789',
    currentLevelIndex: 3,
    levelStates: {
      'level-1': {
        status: LEVEL_STATUS.COMPLETED,
        stageStatus: STAGE_LIFECYCLE_STATUS.COMPLETED,
      },
    },
  })

  assert.equal(ctx.state.sessionId, 'session-789')
  assert.equal(ctx.state.currentLevelIndex, 3)
  assert.equal(ctx.state.levelStates.get('level-1')?.status, LEVEL_STATUS.COMPLETED)
})

test('buildPersistedRuntimeState includes explicit stage lifecycle state', () => {
  const ctx = createRuntimeContext({} as any)
  ctx.state.levelStates.set('level-1', {
    status: LEVEL_STATUS.ACTIVE,
    stageStatus: STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER,
    engineState: null,
    loopbackCount: 1,
  })

  const snapshot = buildPersistedRuntimeState(ctx.state)

  assert.equal(snapshot.levelStates?.['level-1']?.status, LEVEL_STATUS.ACTIVE)
  assert.equal(snapshot.levelStates?.['level-1']?.stageStatus, STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER)
  assert.equal(snapshot.levelStates?.['level-1']?.loopbackCount, 1)
})

// ─── D2: the stage budget is advisory; the stage time is not ─────────────────

test('getConstraintSummary marks only the budget advisory, never the routing timeout', () => {
  // Post-review regression. An earlier D2 draft called the whole summary
  // "not enforced by the runtime". That is false for time:
  // team-runtime/index.ts:1590-1593 passes `max_time_minutes` to runAgent as
  // `timeoutMinutes` for the delegated routing coordinator, and
  // core/constraints.ts:25 and :86 use it for the time-remaining warning. Only
  // `max_budget_usd` has no enforcement path anywhere.
  const summary = getConstraintSummary(makeDiscussionLevel())

  assert.match(summary, /Time: 30 min/)
  assert.match(summary, /\$5/)
  // The advisory qualifier must be scoped to budget...
  assert.match(summary, /budget not runtime-enforced/i)
  // ...and must not be a blanket claim that covers time.
  assert.doesNotMatch(summary, /not enforced by the runtime/i)
})
