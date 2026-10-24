/**
 * Integration tests for context management:
 *   Tests 1–5:  buildConversationContext (full / recent_N / rolling_summary)
 *   Tests 6–10: maybeCompressHistory (trigger conditions, state mutations, cost)
 *
 * Uses node:test with mock.module for compressConversation.
 * Run via `npm run test:unit` — do NOT run node --test directly.
 */

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import type {
  ConversationMessage,
  DiscussionState,
  DiscussionStageConfig,
  RuntimeState,
} from '../../core/types.js'
import { STAGE_TYPE } from '../../core/constants.js'

// ─── Mock compressConversation BEFORE importing engines/discussion.ts ─────────
// mock.module must be called before any module that imports context-compressor
// is loaded. Dynamic import of discussion.ts happens below after the mock is set.

/** Tracks every call to compressConversation so tests can assert call count. */
let compressionCalls: Array<{
  messages: ConversationMessage[]
  currentRound: number
  existingSummary?: string
}> = []

/** Controls what the mock returns; tests may override per-test. */
let compressionResult = {
  summary: 'Mock compressed summary',
  inputTokensEstimate: 100,
  cost: 0.005,
}

mock.module('../../domains/agent-execution/context-compressor.js', {
  namedExports: {
    compressConversation: mock.fn(async (input: any) => {
      compressionCalls.push(input)
      return {
        ...compressionResult,
        // compressedUpToRound mirrors what the real implementation returns
        compressedUpToRound: input.currentRound - 1,
      }
    }),
  },
})

// Dynamic import AFTER mock is registered so that engines/discussion.js picks
// up the mocked context-compressor module.
const { buildConversationContext, maybeCompressHistory } = await import(
  '../../engines/discussion.js'
)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMsg(
  from: string,
  to: string,
  round: number,
  message: string,
): ConversationMessage {
  return {
    from,
    to,
    round,
    timestamp: new Date().toISOString(),
    type: 'position',
    message,
  }
}

function makeDiscussionState(
  round: number,
  messages: ConversationMessage[],
  opts: { compressedSummary?: string; compressedUpToRound?: number } = {},
): DiscussionState {
  const state: DiscussionState = {
    type: STAGE_TYPE.DISCUSSION,
    round,
    messages,
    outputPath: '/tmp',
    approvedRoster: ['agent-a'],
  }
  if (opts.compressedSummary !== undefined) state.compressedSummary = opts.compressedSummary
  if (opts.compressedUpToRound !== undefined) state.compressedUpToRound = opts.compressedUpToRound
  return state
}

/**
 * Minimal DiscussionContext for maybeCompressHistory tests.
 * Only includes the fields that function actually reads.
 */
function makeMinimalCtx(
  summarizeAfterRounds: number = 3,
  initialCost: number = 0,
): any {
  const state: RuntimeState = {
    sessionId: 'test-session',
    currentLevelIndex: 0,
    levelStates: new Map(),
    totalCost: initialCost,
    startTime: Date.now(),
    timerStarted: false,
    endTime: null,
    spawnDepth: 0,
  }

  return {
    config: {
      type: STAGE_TYPE.DISCUSSION,
      coordinator: 'coordinator',
      participants: ['agent-a'],
      config: {
        mode: 'deliberate',
        min_rounds: 1,
        max_rounds: 10,
        constraints: { max_time_minutes: 10, max_budget_usd: 10 },
        output: { format: 'output.md', user_review: false, path: '' },
        context_strategy: 'rolling_summary' as const,
        summarize_after_rounds: summarizeAfterRounds,
      },
    } as DiscussionStageConfig,
    teamName: 'Test Team',
    levelId: 'l1',
    agents: new Map(),
    rosterEntries: new Map(),
    state,
    workspacePath: '/tmp',
    outputPath: '/tmp',
    inputFilesContent: '',
    agentMetrics: new Map(),
    onDashboardUpdate: undefined,
    getCurrentCoordinatorRunId: () => 1,
    rateLimiter: undefined,
  }
}

// ─── Tests 1–5: buildConversationContext ──────────────────────────────────────

test('buildConversationContext with full strategy — all messages included', () => {
  const messages = [
    makeMsg('agent-a', 'all', 1, 'Round 1 message from A'),
    makeMsg('agent-b', 'all', 1, 'Round 1 message from B'),
    makeMsg('coordinator', 'all', 2, 'Round 2 coordinator message'),
    makeMsg('agent-a', 'all', 2, 'Round 2 message from A'),
  ]
  const discussion = makeDiscussionState(2, messages)

  const result = buildConversationContext(discussion, 'full', 2)

  assert.ok(result.includes('Round 1 message from A'), 'full: should include round-1 A message')
  assert.ok(result.includes('Round 1 message from B'), 'full: should include round-1 B message')
  assert.ok(result.includes('Round 2 coordinator message'), 'full: should include round-2 coord message')
  assert.ok(result.includes('Round 2 message from A'), 'full: should include round-2 A message')
  assert.ok(result.includes('[Round 1]'), 'full: should include [Round 1] label')
  assert.ok(result.includes('[Round 2]'), 'full: should include [Round 2] label')
})

test('buildConversationContext with recent_N (N=2) and 5 rounds — only rounds 4-5 included', () => {
  const messages = [
    makeMsg('agent-a', 'all', 1, 'Round 1 message'),
    makeMsg('agent-b', 'all', 2, 'Round 2 message'),
    makeMsg('agent-a', 'all', 3, 'Round 3 message'),
    makeMsg('agent-b', 'all', 4, 'Round 4 message'),
    makeMsg('agent-a', 'all', 5, 'Round 5 message'),
  ]
  // round=5, windowRounds=2 → cutoff = 5-2 = 3 → keep round > 3 (i.e. 4 and 5)
  const discussion = makeDiscussionState(5, messages)

  const result = buildConversationContext(discussion, 'recent_N', 2)

  assert.ok(result.includes('Round 4 message'), 'recent_N: should include round 4')
  assert.ok(result.includes('Round 5 message'), 'recent_N: should include round 5')
  assert.ok(!result.includes('Round 1 message'), 'recent_N: should exclude round 1')
  assert.ok(!result.includes('Round 2 message'), 'recent_N: should exclude round 2')
  assert.ok(!result.includes('Round 3 message'), 'recent_N: should exclude round 3')
})

test('buildConversationContext with recent_N and fewer rounds than N — all messages included', () => {
  const messages = [
    makeMsg('agent-a', 'all', 1, 'Only round 1 message A'),
    makeMsg('agent-b', 'all', 2, 'Only round 2 message B'),
  ]
  // round=2, windowRounds=5 → cutoff = 2-5 = -3 → all rounds > -3 (all messages included)
  const discussion = makeDiscussionState(2, messages)

  const result = buildConversationContext(discussion, 'recent_N', 5)

  assert.ok(
    result.includes('Only round 1 message A'),
    'recent_N fallback: should include round 1 when total rounds < N',
  )
  assert.ok(
    result.includes('Only round 2 message B'),
    'recent_N fallback: should include round 2 when total rounds < N',
  )
})

test('buildConversationContext with rolling_summary and no compressed summary — all messages included', () => {
  const messages = [
    makeMsg('agent-a', 'all', 1, 'Message round 1'),
    makeMsg('agent-b', 'all', 2, 'Message round 2'),
    makeMsg('agent-a', 'all', 3, 'Message round 3'),
  ]
  // No compressedSummary and no compressedUpToRound → all messages as raw history
  const discussion = makeDiscussionState(3, messages)

  const result = buildConversationContext(discussion, 'rolling_summary', 2)

  assert.ok(result.includes('Message round 1'), 'rolling_summary no-summary: round 1 included')
  assert.ok(result.includes('Message round 2'), 'rolling_summary no-summary: round 2 included')
  assert.ok(result.includes('Message round 3'), 'rolling_summary no-summary: round 3 included')
  assert.ok(
    !result.includes('Summary of rounds'),
    'rolling_summary no-summary: should NOT have summary header when no summary exists',
  )
})

test('buildConversationContext with rolling_summary and existing summary — summary prefix + recent messages', () => {
  const messages = [
    makeMsg('agent-a', 'all', 1, 'Round 1 message'),
    makeMsg('agent-b', 'all', 2, 'Round 2 message'),
    makeMsg('agent-a', 'all', 3, 'Round 3 message'),
    makeMsg('agent-b', 'all', 4, 'Round 4 message'),
    makeMsg('agent-a', 'all', 5, 'Round 5 message'),
  ]
  const discussion = makeDiscussionState(5, messages, {
    compressedSummary: 'Key decisions from prior rounds: agreed on approach X.',
    compressedUpToRound: 2,
  })

  const result = buildConversationContext(discussion, 'rolling_summary', 2)

  // Summary prefix must appear
  assert.ok(
    result.includes('Summary of rounds 1\u20132:'),
    'rolling_summary: should include "Summary of rounds 1–2:" header',
  )
  assert.ok(
    result.includes('Key decisions from prior rounds: agreed on approach X.'),
    'rolling_summary: should include the summary text',
  )

  // Raw messages for rounds AFTER compressedUpToRound=2 must appear
  assert.ok(result.includes('Round 3 message'), 'rolling_summary: should include round 3 (after compressed boundary)')
  assert.ok(result.includes('Round 4 message'), 'rolling_summary: should include round 4')
  assert.ok(result.includes('Round 5 message'), 'rolling_summary: should include round 5')

  // Compressed rounds (1 and 2) should NOT appear as raw messages
  assert.ok(!result.includes('Round 1 message'), 'rolling_summary: round 1 raw message excluded (in summary)')
  assert.ok(!result.includes('Round 2 message'), 'rolling_summary: round 2 raw message excluded (in summary)')
})

// ─── Tests 6–10: maybeCompressHistory ────────────────────────────────────────

test('compression trigger fires when: round=4, summarize_after_rounds=3, compressedUpToRound=0', async () => {
  compressionCalls = []

  const ctx = makeMinimalCtx(/* summarizeAfterRounds */ 3)
  const messages = [
    makeMsg('agent-a', 'all', 1, 'Round 1'),
    makeMsg('agent-b', 'all', 2, 'Round 2'),
    makeMsg('agent-a', 'all', 3, 'Round 3'),
  ]
  // discussion.round=4 (already incremented by execute before maybeCompressHistory runs)
  // completedRounds = 4 - 1 = 3
  // uncompressedRounds = 3 - 0 = 3 >= summarizeAfterRounds(3) → SHOULD FIRE
  const discussion = makeDiscussionState(4, messages, { compressedUpToRound: 0 })

  await maybeCompressHistory(ctx, discussion)

  assert.equal(compressionCalls.length, 1, 'compressConversation should be called once when threshold met')
})

test('compression trigger does NOT fire: round=2, summarize_after_rounds=3, compressedUpToRound=0', async () => {
  compressionCalls = []

  const ctx = makeMinimalCtx(/* summarizeAfterRounds */ 3)
  const messages = [
    makeMsg('agent-a', 'all', 1, 'Round 1'),
  ]
  // discussion.round=2 (already incremented)
  // completedRounds = 2 - 1 = 1
  // uncompressedRounds = 1 - 0 = 1 < summarizeAfterRounds(3) → should NOT fire
  const discussion = makeDiscussionState(2, messages, { compressedUpToRound: 0 })

  await maybeCompressHistory(ctx, discussion)

  assert.equal(
    compressionCalls.length,
    0,
    'compressConversation should NOT be called when uncompressed rounds < threshold',
  )
})

test('compression trigger fires after prior compression: round=7, summarize_after_rounds=3, compressedUpToRound=3', async () => {
  compressionCalls = []

  const ctx = makeMinimalCtx(/* summarizeAfterRounds */ 3)
  const messages = [
    makeMsg('agent-a', 'all', 1, 'Round 1'),
    makeMsg('agent-b', 'all', 2, 'Round 2'),
    makeMsg('agent-a', 'all', 3, 'Round 3'),
    makeMsg('agent-b', 'all', 4, 'Round 4'),
    makeMsg('agent-a', 'all', 5, 'Round 5'),
    makeMsg('agent-b', 'all', 6, 'Round 6'),
  ]
  // discussion.round=7, compressedUpToRound=3 (rounds 1–3 already compressed)
  // completedRounds = 7 - 1 = 6
  // uncompressedRounds = 6 - 3 = 3 >= summarizeAfterRounds(3) → SHOULD FIRE
  const discussion = makeDiscussionState(7, messages, {
    compressedUpToRound: 3,
    compressedSummary: 'Prior summary of rounds 1–3.',
  })

  await maybeCompressHistory(ctx, discussion)

  assert.equal(
    compressionCalls.length,
    1,
    'compressConversation should fire again after prior compression when threshold is met',
  )
})

test('compression result stored correctly on DiscussionState (compressedSummary, compressedUpToRound)', async () => {
  compressionCalls = []
  compressionResult = {
    summary: 'Compressed: decided on TypeScript, ship by Q3.',
    inputTokensEstimate: 150,
    cost: 0.007,
  }

  const ctx = makeMinimalCtx(3)
  const messages = [
    makeMsg('agent-a', 'all', 1, 'Round 1'),
    makeMsg('agent-b', 'all', 2, 'Round 2'),
    makeMsg('agent-a', 'all', 3, 'Round 3'),
  ]
  // round=4, completedRounds=3
  const discussion = makeDiscussionState(4, messages, { compressedUpToRound: 0 })

  await maybeCompressHistory(ctx, discussion)

  // Summary text from mock result stored on discussion state
  assert.equal(
    discussion.compressedSummary,
    'Compressed: decided on TypeScript, ship by Q3.',
    'compressedSummary should be stored from compression result',
  )

  // compressedUpToRound = completedRounds = round - 1 = 3
  assert.equal(
    discussion.compressedUpToRound,
    3,
    'compressedUpToRound should equal completedRounds (round - 1)',
  )

  // Reset for later tests
  compressionResult = { summary: 'Mock compressed summary', inputTokensEstimate: 100, cost: 0.005 }
})

test('compression cost added to state.totalCost', async () => {
  compressionCalls = []
  compressionResult = {
    summary: 'Summary',
    inputTokensEstimate: 100,
    cost: 0.003,
  }

  const initialCost = 0.50
  const ctx = makeMinimalCtx(3, initialCost)
  const messages = [
    makeMsg('agent-a', 'all', 1, 'Round 1'),
    makeMsg('agent-b', 'all', 2, 'Round 2'),
    makeMsg('agent-a', 'all', 3, 'Round 3'),
  ]
  const discussion = makeDiscussionState(4, messages, { compressedUpToRound: 0 })

  await maybeCompressHistory(ctx, discussion)

  const expected = initialCost + 0.003
  assert.ok(
    Math.abs(ctx.state.totalCost - expected) < 0.000001,
    `state.totalCost should be ${expected} (${initialCost} + 0.003), got ${ctx.state.totalCost}`,
  )

  // Reset for later tests
  compressionResult = { summary: 'Mock compressed summary', inputTokensEstimate: 100, cost: 0.005 }
})
