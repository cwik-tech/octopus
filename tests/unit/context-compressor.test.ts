import { requiredValue } from '../../core/required-value.js'
/**
 * Unit tests for domains/agent-execution/context-compressor.ts
 *
 * 7 test cases:
 * 1. estimateTokens returns reasonable values
 * 2. buildCompressionPrompt groups messages by round with markdown headers
 * 3. buildCompressionPrompt truncates messages over 500 chars
 * 4. compressConversation with mocked runAgent returns LLM response as summary
 * 5. compressConversation includes existing summary in user message when provided
 * 6. compressConversation uses mechanical fallback when runAgent throws
 * 7. Mechanical fallback produces truncated text per message
 *
 * NOTE: Uses node:test with mock.module (--experimental-test-module-mocks required).
 * Run via `npm run test:unit` — do NOT run node --test directly.
 */

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ConversationMessage } from '../../core/types.js'
import { MINUTES_THINKING } from '../../core/constants.js'

// ── runAgent mock ──────────────────────────────────────────────────────────────
// mock.module MUST be called before context-compressor.js is first loaded,
// so that it imports the mocked agent-runner. See: conditional-routing.test.ts.

/** Tracks arguments passed to the mocked runAgent for assertion in tests. */
let capturedCallArgs: Array<{
  systemPrompt: string
  userMessage: string
  model: string
  provider: string
  thinking: string
}> = []

/** Swap this out in each test to control what runAgent returns. */
let runAgentImpl: () => Promise<{ text: string; cost: number }> = async () => ({
  text: 'LLM summary response.',
  cost: 0.001,
})

mock.module('../../domains/agent-execution/agent-runner.js', {
  namedExports: {
    runAgent: mock.fn(async (opts: any) => {
      capturedCallArgs.push(opts)
      return runAgentImpl()
    }),
  },
})

// Dynamic import AFTER mock is registered — context-compressor.js will import
// the mocked agent-runner instead of the real one.
const { estimateTokens, buildCompressionPrompt, compressConversation } = await import(
  '../../domains/agent-execution/context-compressor.js'
)
const { setRuntimeDefaultModelState } = await import(
  '../../domains/provider/default-model-selection.js'
)

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * The pair compression runs on, and the run it discloses that to.
 *
 * Stated by every case that expects a dispatch, because there is no implicit
 * model any more: compression owns no Agent, so it uses the one application
 * default or it compresses mechanically. A fixture that left this out would be
 * testing the second of those while claiming to test the first.
 */
const APP_DEFAULT = {
  provider: 'connection:compressor-fixture',
  model: 'app-default-compressor-model',
}

function withAppDefault(): { outputPath: string; cleanUp: () => void } {
  setRuntimeDefaultModelState({ status: 'available', ...APP_DEFAULT })
  const outputPath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'compressor-unit-')),
  )
  return {
    outputPath,
    cleanUp: () => {
      setRuntimeDefaultModelState({ status: 'unset' })
      fs.rmSync(outputPath, { recursive: true, force: true })
    },
  }
}

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

// ── Test 1: estimateTokens ─────────────────────────────────────────────────────

test('estimateTokens measures bytes through the system-wide estimator', () => {
  // This used to divide `text.length` by four. That counts UTF-16 code units,
  // so a CJK transcript was read as a fraction of what it costs on the wire,
  // and it disagreed with the two byte-based estimators elsewhere in the system.
  // It now delegates to core/context-tokens.ts, which is the only estimator.
  // The assertions below state the properties that matter rather than pinning
  // one ratio's arithmetic, so changing the ratio does not falsify them.

  // Empty costs nothing.
  assert.equal(estimateTokens(''), 0)

  // Any content costs at least one token.
  assert.equal(estimateTokens('a'), 1)

  // Cost grows with size.
  assert.ok(estimateTokens('a'.repeat(4000)) > estimateTokens('a'.repeat(400)))

  // It never under-counts against a four-bytes-per-token reading, which is what
  // makes it safe to admit a request on.
  const prose = 'a'.repeat(400)
  assert.ok(estimateTokens(prose) >= Math.ceil(Buffer.byteLength(prose, 'utf8') / 4))

  // Bytes, not characters: the same number of CJK characters costs more.
  assert.ok(estimateTokens('匹'.repeat(100)) > estimateTokens('a'.repeat(100)))
})

// ── Test 2: buildCompressionPrompt groups by round ────────────────────────────

test('buildCompressionPrompt groups messages by round with markdown headers', () => {
  const messages: ConversationMessage[] = [
    makeMsg('agent-a', 'all', 1, 'Round 1 message from A'),
    makeMsg('agent-b', 'all', 1, 'Round 1 message from B'),
    makeMsg('agent-a', 'all', 2, 'Round 2 message from A'),
  ]

  const prompt = buildCompressionPrompt(messages)

  // Markdown round headers
  assert.ok(prompt.includes('### Round 1'), 'should have ### Round 1 header')
  assert.ok(prompt.includes('### Round 2'), 'should have ### Round 2 header')

  // All message content present
  assert.ok(prompt.includes('Round 1 message from A'), 'should include A round-1 message')
  assert.ok(prompt.includes('Round 1 message from B'), 'should include B round-1 message')
  assert.ok(prompt.includes('Round 2 message from A'), 'should include A round-2 message')

  // Round 1 header appears before Round 2 header
  const r1Idx = prompt.indexOf('### Round 1')
  const r2Idx = prompt.indexOf('### Round 2')
  assert.ok(r1Idx < r2Idx, 'Round 1 header must appear before Round 2 header')

  // Round 1 header appears only once (messages in same round reuse existing header)
  const round1Occurrences = (prompt.match(/### Round 1/g) ?? []).length
  assert.equal(round1Occurrences, 1, 'Round 1 header should appear exactly once')
})

// ── Test 3: buildCompressionPrompt truncates long messages ────────────────────

test('buildCompressionPrompt truncates messages over 500 chars', () => {
  const longMessage = 'x'.repeat(600)
  const shortMessage = 'short content'

  const messages: ConversationMessage[] = [
    makeMsg('agent-a', 'all', 1, longMessage),
    makeMsg('agent-b', 'all', 1, shortMessage),
  ]

  const prompt = buildCompressionPrompt(messages)

  // Long message should be truncated with ellipsis
  assert.ok(prompt.includes('...'), 'truncated message should end with ...')
  // Exactly 500 x-chars should appear (not 600)
  assert.ok(prompt.includes('x'.repeat(500)), 'should contain exactly 500 x chars')
  assert.ok(!prompt.includes('x'.repeat(501)), 'should not contain 501+ x chars')

  // Short message should be unchanged
  assert.ok(prompt.includes(shortMessage), 'short message should be unchanged')
})

// ── Test 4: compressConversation returns LLM response ─────────────────────────

test('compressConversation with mocked runAgent returns LLM response as summary', async () => {
  capturedCallArgs = []
  runAgentImpl = async () => ({
    text: 'Decision: Use TypeScript. Action: Agent-A to implement by Friday.',
    cost: 0.002,
  })

  const messages: ConversationMessage[] = [
    makeMsg('agent-a', 'all', 1, 'We should use TypeScript'),
    makeMsg('agent-b', 'all', 1, 'Agreed, TypeScript it is'),
  ]

  const { outputPath, cleanUp } = withAppDefault()
  try {
    const result = await compressConversation({
      messages,
      teamName: 'Test Team',
      levelId: 'level-1',
      currentRound: 2,
      runIdentity: { outputPath, sessionId: 'compressor-unit-session' },
    })

    // Returns LLM text as summary
    assert.equal(
      result.summary,
      'Decision: Use TypeScript. Action: Agent-A to implement by Friday.',
    )
    // compressedUpToRound = currentRound - 1
    assert.equal(result.compressedUpToRound, 1)
    // Cost from LLM call
    assert.equal(result.cost, 0.002)
    // Token estimate is positive
    assert.ok(result.inputTokensEstimate > 0, 'inputTokensEstimate should be positive')

    // runAgent was called exactly once
    assert.equal(capturedCallArgs.length, 1, 'runAgent should be called once')
    // On the whole application default pair, because compression owns no Agent.
    // `MINUTES_MODEL` — the literal string `default` — was never a model, and
    // sending it left the provider to be substituted further down.
    const dispatched = requiredValue(
      capturedCallArgs[0],
      'tests/unit/context-compressor.test.ts:184',
    )
    assert.equal(dispatched.model, APP_DEFAULT.model)
    assert.equal(dispatched.provider, APP_DEFAULT.provider)
    assert.equal(dispatched.thinking, MINUTES_THINKING)
  } finally {
    cleanUp()
  }
})

// ── Test 5: compressConversation includes existing summary ────────────────────

test('compressConversation includes existing summary in user message when provided', async () => {
  capturedCallArgs = []
  runAgentImpl = async () => ({ text: 'Updated rolling summary', cost: 0.001 })

  const messages: ConversationMessage[] = [
    makeMsg('agent-c', 'all', 3, 'New round 3 content'),
  ]

  const existingSummary = 'Prior rounds 1–2 summary: agreed to use TypeScript and ship by Q2.'

  const { outputPath, cleanUp } = withAppDefault()
  try {
    await compressConversation({
      messages,
      teamName: 'Test Team',
      levelId: 'level-1',
      currentRound: 4,
      existingSummary,
      runIdentity: { outputPath, sessionId: 'compressor-unit-session' },
    })

    assert.equal(capturedCallArgs.length, 1, 'runAgent should be called once')
    const userMessage = requiredValue(capturedCallArgs[0], 'tests/unit/context-compressor.test.ts:213').userMessage

    // Prior summary is prepended
    assert.ok(
      userMessage.includes(existingSummary),
      'user message should include the existing summary',
    )
    // "New messages to incorporate" section heading present
    assert.ok(
      userMessage.includes('New messages to incorporate'),
      'user message should contain "New messages to incorporate" section',
    )
    // New message content included
    assert.ok(
      userMessage.includes('New round 3 content'),
      'user message should include new message content',
    )
  } finally {
    cleanUp()
  }
})

// ── Test 6: compressConversation falls back when runAgent throws ───────────────

test('compressConversation uses mechanical fallback when runAgent throws', async () => {
  // The application default and a run to disclose to are both required for the
  // dispatch to happen at all. Without them compression answers mechanically
  // before it reaches the runner — so this case used to pass without ever
  // calling the throwing mock, and would have gone on passing if the error
  // handling it is named for were deleted.
  const { outputPath, cleanUp } = withAppDefault()
  capturedCallArgs = []
  runAgentImpl = async () => {
    throw new Error('API error: rate limit exceeded')
  }

  const messages: ConversationMessage[] = [
    makeMsg('agent-a', 'all', 1, 'This is a test message for the fallback path'),
  ]

  try {
    // Must NOT throw — should return a fallback result
    const result = await compressConversation({
      messages,
      teamName: 'Test Team',
      levelId: 'level-1',
      currentRound: 2,
      runIdentity: { outputPath, sessionId: 'compressor-fallback-session' },
    })

    // The throw this case is named for really happened.
    assert.equal(capturedCallArgs.length, 1, 'the runner must have been called once')
    assert.ok(typeof result.summary === 'string', 'fallback must produce a string summary')
    assert.ok(result.summary.length > 0, 'fallback summary must not be empty')
    assert.equal(result.cost, 0, 'fallback should have zero cost (no LLM call succeeded)')
    assert.equal(result.compressedUpToRound, 1, 'compressedUpToRound should be currentRound - 1')
  } finally {
    cleanUp()
    // Reset so later tests use a working mock
    runAgentImpl = async () => ({ text: 'LLM summary response.', cost: 0.001 })
  }
})

// ── Test 7: Mechanical fallback truncates text per message ────────────────────

test('Mechanical fallback produces truncated text per message', async () => {
  capturedCallArgs = []
  runAgentImpl = async () => {
    throw new Error('LLM unavailable')
  }

  // A long message exceeding 200 chars (the per-message truncation limit)
  const longText =
    'This is a very long message that contains a lot of words and should be ' +
    'truncated at the word boundary when the mechanical fallback kicks in ' +
    'because it exceeds two hundred characters easily with this amount of text ' +
    'included here yes indeed my friend.'

  assert.ok(longText.length > 200, 'test setup: longText must exceed 200 chars')

  const messages: ConversationMessage[] = [
    makeMsg('agent-a', 'all', 1, longText),
    makeMsg('agent-b', 'all', 2, 'Short message'),
  ]

  const result = await compressConversation({
    messages,
    teamName: 'Test Team',
    levelId: 'level-1',
    currentRound: 3,
  })

  // Both agents appear in output
  assert.ok(result.summary.includes('agent-a'), 'fallback summary should mention agent-a')
  assert.ok(result.summary.includes('agent-b'), 'fallback summary should mention agent-b')

  // Short message included as-is
  assert.ok(result.summary.includes('Short message'), 'short message should be included fully')

  // Long message is truncated (contains '...')
  assert.ok(
    result.summary.includes('...'),
    'long message should be truncated with ellipsis',
  )

  // Fallback has zero cost
  assert.equal(result.cost, 0, 'fallback has zero cost')

  // Reset mock
  runAgentImpl = async () => ({ text: 'LLM summary response.', cost: 0.001 })
})
