/**
 * The `conversation.turn` payload contract.
 *
 * This domain owns one user-visible publication: the user asked something and
 * the conversation answered. It is deliberately not `agent.turn` — that stream
 * is one selected-agent reply on an assignment, and its ADR excludes other
 * operations (docs/adr/2026-08-25-Durable-Agent-Turn-Journal.md:198-203).
 *
 * Two rules separate this module from its precedent, and both are asserted
 * here rather than left to review: a payload is bounded in bytes because a
 * conversation activity has a hard budget, and an unknown field is rejected on
 * read rather than quietly ignored, because the journal boundary is where an
 * unrecognised fact must fail closed.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONVERSATION_TURN_MAX_PAYLOAD_BYTES,
  CONVERSATION_TURN_MAX_RESPONSES,
  CONVERSATION_TURN_PAYLOAD_SCHEMA_VERSION,
  CONVERSATION_TURN_STREAM_KIND,
  ConversationTurnPayloadError,
  buildConversationTurnCancelledPayload,
  buildConversationTurnCompletedPayload,
  buildConversationTurnFailedPayload,
  buildConversationTurnPreparedPayload,
  buildConversationTurnStartedPayload,
  conversationTurnEventId,
  readConversationTurnCompletedPayload,
  readConversationTurnPreparedPayload,
  readConversationTurnStartedPayload,
  reduceConversationTurnStream,
} from '../../domains/conversations/conversation-turn-journal.js'

const DIGEST = 'a1'.repeat(32)

function started(overrides: Record<string, unknown> = {}) {
  return buildConversationTurnStartedPayload({
    surface: 'run-receptionist',
    userMessageId: '7b1c9f2e-2f4a-4a7d-9f0b-2c3d4e5f6a7b:user',
    requestDigest: DIGEST,
    expectedResponseCount: 1,
    origin: 'client',
    ...overrides,
  })
}

function prepared(overrides: Record<string, unknown> = {}) {
  return buildConversationTurnPreparedPayload({
    assistantMessageIds: ['7b1c9f2e-2f4a-4a7d-9f0b-2c3d4e5f6a7b:assistant:0'],
    ...overrides,
  })
}

test('the stream names itself and its payload version', () => {
  assert.equal(CONVERSATION_TURN_STREAM_KIND, 'conversation.turn')
  assert.equal(CONVERSATION_TURN_PAYLOAD_SCHEMA_VERSION, 1)
})

test('an event identity is deterministic and distinguishes turns', () => {
  const first = conversationTurnEventId('activity-1', 'turn-1', 'started')
  assert.equal(first, conversationTurnEventId('activity-1', 'turn-1', 'started'))
  assert.notEqual(first, conversationTurnEventId('activity-1', 'turn-1', 'prepared'))
  // The precedent keys only on the scope, which is safe there because one
  // assignment holds one reply. A conversation can hold many turns, so the turn
  // must be part of the identity or the second turn silently replays the first.
  assert.notEqual(first, conversationTurnEventId('activity-1', 'turn-2', 'started'))
  assert.notEqual(first, conversationTurnEventId('activity-2', 'turn-1', 'started'))
})

test('the three terminals share one stage, so a turn cannot end twice', () => {
  assert.equal(
    conversationTurnEventId('activity-1', 'turn-1', 'terminal'),
    conversationTurnEventId('activity-1', 'turn-1', 'terminal'),
  )
})

test('a started payload carries only allowlisted identity and request facts', () => {
  assert.deepEqual(started(), {
    surface: 'run-receptionist',
    userMessageId: '7b1c9f2e-2f4a-4a7d-9f0b-2c3d4e5f6a7b:user',
    requestDigest: DIGEST,
    expectedResponseCount: 1,
    origin: 'client',
  })
})

test('a builder refuses anything that is not an identity or a bounded fact', () => {
  assert.throws(() => started({ userMessageId: '   ' }), ConversationTurnPayloadError)
  assert.throws(() => started({ requestDigest: 'not-a-digest' }), ConversationTurnPayloadError)
  assert.throws(() => started({ surface: 'not-a-surface' }), ConversationTurnPayloadError)
  assert.throws(() => started({ origin: 'somewhere-else' }), ConversationTurnPayloadError)
  assert.throws(() => started({ expectedResponseCount: -1 }), ConversationTurnPayloadError)
  assert.throws(() => started({ expectedResponseCount: 1.5 }), ConversationTurnPayloadError)
})

test('a prepared payload names every reply it claims, within the bound', () => {
  assert.deepEqual(prepared(), {
    assistantMessageIds: ['7b1c9f2e-2f4a-4a7d-9f0b-2c3d4e5f6a7b:assistant:0'],
  })
  assert.throws(
    () =>
      prepared({
        assistantMessageIds: new Array(CONVERSATION_TURN_MAX_RESPONSES + 1)
          .fill(0)
          .map((_value, index) => `7b1c9f2e-2f4a-4a7d-9f0b-2c3d4e5f6a7b:assistant:${index}`),
      }),
    ConversationTurnPayloadError,
    'an unbounded reply list would make the payload unbounded',
  )
  assert.throws(
    () => prepared({ assistantMessageIds: [] }),
    ConversationTurnPayloadError,
    'a prepared turn claims at least one reply',
  )
  assert.throws(
    () => prepared({ assistantMessageIds: ['7b1c9f2e-2f4a-4a7d-9f0b-2c3d4e5f6a7b:assistant:0', '  '] }),
    ConversationTurnPayloadError,
    'a malformed element fails the payload rather than being filtered out',
  )
})

test('a failure identity is an allowlisted code, never prose', () => {
  assert.throws(
    () =>
      buildConversationTurnFailedPayload({
        failure: {
          code: 'Error: connect ECONNREFUSED 127.0.0.1:443 while calling the model',
          phase: 'provider',
        },
      }),
    ConversationTurnPayloadError,
    'a raw provider reason is not a diagnostic code',
  )
  assert.throws(
    () =>
      buildConversationTurnFailedPayload({
        failure: { code: 'ok', phase: 'not-a-phase' },
      }),
    ConversationTurnPayloadError,
  )
  assert.deepEqual(
    buildConversationTurnFailedPayload({
      failure: { code: 'plan_conflict', phase: 'plan-revision' },
    }),
    { failure: { code: 'plan_conflict', phase: 'plan-revision' } },
  )
})

test('a payload larger than the activity budget fails closed', () => {
  const oversized = 'x'.repeat(CONVERSATION_TURN_MAX_PAYLOAD_BYTES)
  assert.throws(
    () => started({ userMessageId: oversized }),
    ConversationTurnPayloadError,
    'the writer refuses before the append, not after the file grew',
  )
})

test('a reader rejects an unknown field instead of ignoring it', () => {
  const payload = { ...started(), smuggledText: 'the user actually said this' }
  assert.equal(
    readConversationTurnStartedPayload(payload),
    null,
    'an unrecognised field at the journal boundary is a rejection',
  )
})

test('a reader returns null for a malformed payload and never throws', () => {
  assert.equal(readConversationTurnStartedPayload(undefined), null)
  assert.equal(readConversationTurnStartedPayload('a string'), null)
  assert.equal(readConversationTurnStartedPayload({ surface: 'run-receptionist' }), null)
  assert.equal(readConversationTurnPreparedPayload({ assistantMessageIds: 'no' }), null)
})

test('a written payload reads back unchanged', () => {
  assert.deepEqual(readConversationTurnStartedPayload(started()), started())
  assert.deepEqual(readConversationTurnPreparedPayload(prepared()), prepared())
  const completed = buildConversationTurnCompletedPayload({
    assistantMessageIds: ['7b1c9f2e-2f4a-4a7d-9f0b-2c3d4e5f6a7b:assistant:0'],
  })
  assert.deepEqual(readConversationTurnCompletedPayload(completed), completed)
})

test('the reducer follows one turn from start to terminal', () => {
  const empty = reduceConversationTurnStream('turn-1', [])
  assert.equal(empty.state, 'absent')

  const afterStart = reduceConversationTurnStream('turn-1', [
    { type: 'conversation.turn.started', payload: started() },
  ])
  assert.equal(afterStart.state, 'started')
  assert.equal(afterStart.userMessageId, '7b1c9f2e-2f4a-4a7d-9f0b-2c3d4e5f6a7b:user')
  assert.equal(afterStart.requestDigest, DIGEST)

  const afterPrepared = reduceConversationTurnStream('turn-1', [
    { type: 'conversation.turn.started', payload: started() },
    { type: 'conversation.turn.prepared', payload: prepared() },
  ])
  assert.equal(afterPrepared.state, 'prepared')
  assert.deepEqual(afterPrepared.assistantMessageIds, ['7b1c9f2e-2f4a-4a7d-9f0b-2c3d4e5f6a7b:assistant:0'])

  const afterCompleted = reduceConversationTurnStream('turn-1', [
    { type: 'conversation.turn.started', payload: started() },
    { type: 'conversation.turn.prepared', payload: prepared() },
    {
      type: 'conversation.turn.completed',
      payload: buildConversationTurnCompletedPayload({
        assistantMessageIds: ['7b1c9f2e-2f4a-4a7d-9f0b-2c3d4e5f6a7b:assistant:0'],
      }),
    },
  ])
  assert.equal(afterCompleted.state, 'completed')
  assert.deepEqual(afterCompleted.assistantMessageIds, ['7b1c9f2e-2f4a-4a7d-9f0b-2c3d4e5f6a7b:assistant:0'])
})

test('the reducer reports an out-of-order stream as invalid rather than throwing', () => {
  const preparedFirst = reduceConversationTurnStream('turn-1', [
    { type: 'conversation.turn.prepared', payload: prepared() },
  ])
  assert.equal(preparedFirst.state, 'invalid')

  const twoStarts = reduceConversationTurnStream('turn-1', [
    { type: 'conversation.turn.started', payload: started() },
    { type: 'conversation.turn.started', payload: started() },
  ])
  assert.equal(twoStarts.state, 'invalid')

  const unreadable = reduceConversationTurnStream('turn-1', [
    { type: 'conversation.turn.started', payload: { nonsense: true } },
  ])
  assert.equal(unreadable.state, 'invalid')
})

test('a turn may fail or cancel before it ever prepares a reply', () => {
  const failedEarly = reduceConversationTurnStream('turn-1', [
    { type: 'conversation.turn.started', payload: started() },
    {
      type: 'conversation.turn.failed',
      payload: buildConversationTurnFailedPayload({
        failure: { code: 'plan_conflict', phase: 'plan-revision' },
      }),
    },
  ])
  assert.equal(failedEarly.state, 'failed')
  assert.deepEqual(failedEarly.failure, {
    code: 'plan_conflict',
    phase: 'plan-revision',
  })
  assert.deepEqual(failedEarly.assistantMessageIds, [])

  const cancelled = reduceConversationTurnStream('turn-1', [
    { type: 'conversation.turn.started', payload: started() },
    {
      type: 'conversation.turn.cancelled',
      payload: buildConversationTurnCancelledPayload({ phase: 'provider' }),
    },
  ])
  assert.equal(cancelled.state, 'cancelled')
})

test('a completed terminal must name exactly the replies preparation claimed', () => {
  const mismatched = reduceConversationTurnStream('turn-1', [
    { type: 'conversation.turn.started', payload: started() },
    { type: 'conversation.turn.prepared', payload: prepared() },
    {
      type: 'conversation.turn.completed',
      payload: buildConversationTurnCompletedPayload({
        assistantMessageIds: ['9c2d0a3f-4e5b-4c6d-8a1e-3f4a5b6c7d8e:assistant:0'],
      }),
    },
  ])
  assert.equal(
    mismatched.state,
    'invalid',
    'a terminal that renames the replies is not a completion',
  )
})

test('a payload built without diagnostics holds exactly the lifecycle facts', () => {
  // Diagnostics are additive, and this is what says so. A record written before
  // they existed, or by a path that has nothing to report, must still be a
  // valid, complete lifecycle record rather than one missing fields — and it
  // must not gain a placeholder for a fact nobody established.
  const startedKeys = Object.keys(started()).sort()
  assert.deepEqual(startedKeys, [
    'expectedResponseCount',
    'origin',
    'requestDigest',
    'surface',
    'userMessageId',
  ])

  const preparedKeys = Object.keys(prepared()).sort()
  assert.deepEqual(
    preparedKeys,
    ['assistantMessageIds'],
    'preparation names the replies it claims and nothing about the provider',
  )
})

/**
 * Phase 2 diagnostics: the same allowlist rules, applied to richer facts.
 *
 * Enriching a payload is where a content boundary usually fails, because every
 * useful new field is next to a tempting one. The provider's display reason
 * sits beside its status code, its response body sits beside its error code,
 * and the model's rejected output sits beside the verdict on it. So each new
 * field is a closed vocabulary or a bounded identifier, and the builder refuses
 * anything else rather than trimming it.
 */
const TURN_ID = '7b1c9f2e-2f4a-4a7d-9f0b-2c3d4e5f6a7b'

function providerBlock(overrides: Record<string, unknown> = {}) {
  return {
    resolvedProvider: 'openai',
    resolvedModel: 'gpt-5.5',
    route: 'http',
    outcome: 'success',
    timing: {
      providerDurationMs: 1234.6,
      processSpawnMs: null,
      firstProviderEventMs: 12.2,
      firstTextMs: 30.9,
    },
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    ...overrides,
  }
}

test('a started payload records the provider and model the caller asked for', () => {
  assert.deepEqual(
    started({ requestedProvider: 'OpenAI', requestedModel: 'gpt-5.5' }),
    {
      surface: 'run-receptionist',
      userMessageId: `${TURN_ID}:user`,
      requestDigest: DIGEST,
      expectedResponseCount: 1,
      origin: 'client',
      requestedProvider: 'OpenAI',
      requestedModel: 'gpt-5.5',
    },
  )
})

test('a requested provider or model longer than the request bound is refused', () => {
  assert.throws(
    () => started({ requestedProvider: 'p'.repeat(129) }),
    ConversationTurnPayloadError,
  )
  assert.throws(
    () => started({ requestedModel: 'm'.repeat(129) }),
    ConversationTurnPayloadError,
  )
})

test('a prepared payload carries the decision outcome and the provider account', () => {
  assert.deepEqual(
    prepared({
      decision: {
        initialValidation: 'invalid',
        repair: 'valid',
        fallback: 'none',
      },
      provider: providerBlock(),
    }),
    {
      assistantMessageIds: [`${TURN_ID}:assistant:0`],
      decision: {
        initialValidation: 'invalid',
        repair: 'valid',
        fallback: 'none',
      },
      provider: {
        resolvedProvider: 'openai',
        resolvedModel: 'gpt-5.5',
        route: 'http',
        outcome: 'success',
        // Rounded to whole milliseconds and stripped of the milestones that
        // never happened. A fractional performance counter is precision the
        // record cannot use and bytes it has to keep forever.
        timing: {
          providerDurationMs: 1235,
          firstProviderEventMs: 12,
          firstTextMs: 31,
        },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    },
  )
})

test('a decision outcome outside the closed vocabulary is refused', () => {
  for (const decision of [
    { initialValidation: 'maybe', repair: 'valid', fallback: 'none' },
    { initialValidation: 'valid', repair: 'sort-of', fallback: 'none' },
    { initialValidation: 'valid', repair: 'valid', fallback: 'because it broke' },
    { initialValidation: 'valid', repair: 'valid' },
    {
      initialValidation: 'valid',
      repair: 'valid',
      fallback: 'none',
      // The model's rejected output, arriving beside the verdict on it.
      rejectedOutput: 'Sorry, I cannot answer that.',
    },
  ]) {
    assert.throws(
      () => prepared({ decision }),
      ConversationTurnPayloadError,
      `${JSON.stringify(decision)} must be refused`,
    )
  }
})

test('a provider account refuses a reason, a body, a header map, or any other unknown field', () => {
  for (const extra of [
    { reason: 'OpenAI 429 Too Many Requests {"error":{"message":"slow down"}}' },
    { responseBody: '{"choices":[{"message":{"content":"the answer"}}]}' },
    { headers: { 'x-request-id': 'req_123' } },
    { text: 'the assistant reply' },
    { apiKey: 'sk-proj-not-a-real-key' },
  ]) {
    assert.throws(
      () => prepared({ provider: providerBlock(extra) }),
      ConversationTurnPayloadError,
      `${JSON.stringify(extra)} must be refused`,
    )
  }
})

test('a provider failure identity keeps only allowlisted codes and a bounded provider code', () => {
  assert.deepEqual(
    prepared({
      provider: providerBlock({
        outcome: 'provider_failure',
        resolvedModel: undefined,
        usage: undefined,
        failure: {
          code: 'http_status',
          phase: 'response',
          providerKind: 'chat-completions',
          providerCode: 'rate_limit_exceeded',
          httpStatus: 429,
          retryable: true,
        },
      }),
    }).provider,
    {
      resolvedProvider: 'openai',
      route: 'http',
      outcome: 'provider_failure',
      failure: {
        code: 'http_status',
        phase: 'response',
        providerKind: 'chat-completions',
        providerCode: 'rate_limit_exceeded',
        httpStatus: 429,
        retryable: true,
      },
      timing: {
        providerDurationMs: 1235,
        firstProviderEventMs: 12,
        firstTextMs: 31,
      },
    },
  )
})

test('a provider code that is really a message is refused rather than trimmed', () => {
  assert.throws(
    () =>
      prepared({
        provider: providerBlock({
          failure: {
            code: 'http_status',
            phase: 'response',
            // The display reason, moved one field to the left.
            providerCode: 'Too Many Requests: slow down, you sent 60 in 1s',
            retryable: true,
          },
        }),
      }),
    ConversationTurnPayloadError,
  )
})

test('usage that contradicts itself is refused rather than recorded', () => {
  assert.throws(
    () =>
      prepared({
        provider: providerBlock({
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 99 },
        }),
      }),
    ConversationTurnPayloadError,
  )
  assert.throws(
    () =>
      prepared({
        provider: providerBlock({
          usage: { inputTokens: -1, outputTokens: 5, totalTokens: 4 },
        }),
      }),
    ConversationTurnPayloadError,
  )
})

test('a failed terminal may carry the provider account that explains it', () => {
  const payload = buildConversationTurnFailedPayload({
    failure: { code: 'provider_failed', phase: 'provider' },
    provider: providerBlock({
      outcome: 'timeout',
      resolvedModel: undefined,
      usage: undefined,
      failure: {
        code: 'timeout',
        phase: 'request',
        providerKind: 'chat-completions',
        retryable: true,
      },
    }),
  })
  assert.deepEqual(payload.failure, {
    code: 'provider_failed',
    phase: 'provider',
  })
  assert.deepEqual(Reflect.get(payload, 'provider'), {
    resolvedProvider: 'openai',
    route: 'http',
    outcome: 'timeout',
    failure: {
      code: 'timeout',
      phase: 'request',
      providerKind: 'chat-completions',
      retryable: true,
    },
    timing: {
      providerDurationMs: 1235,
      firstProviderEventMs: 12,
      firstTextMs: 31,
    },
  })
})

test('a cancelled terminal may carry the provider account of the call it withdrew', () => {
  const payload = buildConversationTurnCancelledPayload({
    phase: 'provider',
    provider: providerBlock({
      outcome: 'cancelled',
      resolvedModel: undefined,
      usage: undefined,
      failure: {
        code: 'cancelled',
        phase: 'request',
        providerKind: 'chat-completions',
        retryable: false,
      },
    }),
  })
  assert.equal(Reflect.get(payload, 'phase'), 'provider')
  const provider = Reflect.get(payload, 'provider')
  assert.ok(typeof provider === 'object' && provider !== null)
  assert.equal(Reflect.get(provider, 'outcome'), 'cancelled')
})

test('a reduced turn reports the diagnostics its stream recorded', () => {
  const summary = reduceConversationTurnStream(TURN_ID, [
    {
      type: 'conversation.turn.started',
      payload: started({ requestedProvider: 'OpenAI', requestedModel: 'gpt-5.5' }),
    },
    {
      type: 'conversation.turn.prepared',
      payload: prepared({
        decision: {
          initialValidation: 'invalid',
          repair: 'valid',
          fallback: 'none',
        },
        provider: providerBlock(),
      }),
    },
    {
      type: 'conversation.turn.completed',
      payload: buildConversationTurnCompletedPayload({
        assistantMessageIds: [`${TURN_ID}:assistant:0`],
      }),
    },
  ])

  assert.equal(summary.state, 'completed')
  assert.equal(summary.requestedProvider, 'OpenAI')
  assert.equal(summary.requestedModel, 'gpt-5.5')
  assert.deepEqual(summary.decision, {
    initialValidation: 'invalid',
    repair: 'valid',
    fallback: 'none',
  })
  assert.equal(summary.provider?.resolvedModel, 'gpt-5.5')
  assert.deepEqual(summary.provider?.usage, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  })
})

test('a Phase 1 stream still reduces, and simply reports no diagnostics', () => {
  const summary = reduceConversationTurnStream(TURN_ID, [
    { type: 'conversation.turn.started', payload: started() },
    { type: 'conversation.turn.prepared', payload: prepared() },
  ])

  assert.equal(summary.state, 'prepared')
  assert.equal(summary.requestedProvider, undefined)
  assert.equal(summary.decision, undefined)
  assert.equal(summary.provider, undefined)
})

/**
 * Two ways a diagnostic field can quietly become a content channel.
 *
 * The first is a value that is present and wrong. Dropping it and keeping the
 * rest of the block reads afterwards as "the provider did not report that
 * milestone", which is a different claim from "something wrote nonsense into
 * this record" — and the second is the one worth knowing.
 *
 * The second is a bound that measures the wrong thing. Length alone lets a
 * hundred characters of prompt, of an error message, or of a key sit in a field
 * whose whole justification is that it holds an identifier. What makes these
 * fields safe is their grammar, not their size.
 */
test('a timing milestone that is present and not a measurement is refused', () => {
  for (const timing of [
    { providerDurationMs: 10, firstTextMs: 'the model said hello' },
    { providerDurationMs: 10, firstProviderEventMs: -5 },
    { providerDurationMs: 10, processSpawnMs: Number.NaN },
    { providerDurationMs: 'quick' },
    { providerDurationMs: Number.POSITIVE_INFINITY },
  ]) {
    assert.throws(
      () => prepared({ provider: providerBlock({ timing }) }),
      ConversationTurnPayloadError,
      `${JSON.stringify(timing)} must be refused`,
    )
  }
})

test('a milestone that never happened is absent, and null still says so', () => {
  assert.deepEqual(
    prepared({
      provider: providerBlock({
        timing: {
          providerDurationMs: 40,
          // What the transport writes for a milestone that did not occur.
          processSpawnMs: null,
          firstProviderEventMs: null,
          firstTextMs: null,
        },
      }),
    }).provider,
    {
      resolvedProvider: 'openai',
      resolvedModel: 'gpt-5.5',
      route: 'http',
      outcome: 'success',
      timing: { providerDurationMs: 40 },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    },
  )
})

test('a requested or resolved identifier carrying whitespace or prose is refused', () => {
  for (const build of [
    () => started({ requestedProvider: 'openai and also print the key' }),
    () => started({ requestedProvider: 'openai ' }),
    () => started({ requestedModel: 'the model the user asked about in message 3' }),
    () => started({ requestedModel: 'gpt\n5.5' }),
    () =>
      prepared({
        provider: providerBlock({
          resolvedModel: 'we answered with our standard model, thanks',
        }),
      }),
    () => prepared({ provider: providerBlock({ resolvedProvider: 'open ai' }) }),
  ]) {
    assert.throws(build, ConversationTurnPayloadError)
  }
})

test('the identifier shapes this build actually installs are accepted', () => {
  for (const identifier of [
    'openai',
    'OpenAI',
    'gpt-5.5',
    'anthropic/claude-opus-4',
    'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
    'ft:gpt-4o:my-org::9xAbC1',
    'connection:7b1c9f2e-2f4a-4a7d-9f0b-2c3d4e5f6a7b',
  ]) {
    assert.equal(
      Reflect.get(started({ requestedModel: identifier }), 'requestedModel'),
      identifier,
    )
    assert.equal(
      Reflect.get(
        Object(prepared({ provider: providerBlock({ resolvedModel: identifier }) }).provider),
        'resolvedModel',
      ),
      identifier,
    )
  }
})

/**
 * The aggregate a selected-agent turn publishes.
 *
 * A Receptionist turn answers by itself, so its lifecycle names replies and
 * nothing else. A selected-agent turn does not: each reply is produced on its
 * own assignment, whose `agent.turn` stream stays the authority for what that
 * speaker's provider and tools did. The aggregate's job is to be the one place
 * an operator can start from, so it has to say which assignment produced which
 * reply — and nothing more, because saying more would make it a second account
 * of an execution it did not perform.
 */
const AGGREGATE_TURN = '0b9e3f61-7c2d-4a55-9f13-6d8e0a2b4c17'
const ALPHA_ASSIGNMENT = '4f8b1d27-3a6c-4e19-b0d5-72c1e93a5f80'
const BETA_ASSIGNMENT = 'd51a7c04-98be-4f23-8c67-1e0b34d9a7f2'

function aggregatePrepared(overrides: Record<string, unknown> = {}) {
  return buildConversationTurnPreparedPayload({
    assistantMessageIds: [
      `${AGGREGATE_TURN}:assistant:0`,
      `${AGGREGATE_TURN}:assistant:1`,
    ],
    assignments: [
      {
        assignmentId: ALPHA_ASSIGNMENT,
        assistantMessageId: `${AGGREGATE_TURN}:assistant:0`,
      },
      {
        assignmentId: BETA_ASSIGNMENT,
        assistantMessageId: `${AGGREGATE_TURN}:assistant:1`,
      },
    ],
    ...overrides,
  })
}

test('selected-agent chat is a surface a turn may publish under', () => {
  assert.deepEqual(
    readConversationTurnStartedPayload(
      started({ surface: 'run-selected-agents', expectedResponseCount: 2 }),
    ),
    {
      surface: 'run-selected-agents',
      userMessageId: '7b1c9f2e-2f4a-4a7d-9f0b-2c3d4e5f6a7b:user',
      requestDigest: DIGEST,
      expectedResponseCount: 2,
      origin: 'client',
    },
  )
})

test('a prepared payload links each reply to the assignment that produced it', () => {
  const payload = aggregatePrepared()
  assert.deepEqual(payload, {
    assistantMessageIds: [
      `${AGGREGATE_TURN}:assistant:0`,
      `${AGGREGATE_TURN}:assistant:1`,
    ],
    assignments: [
      {
        assignmentId: ALPHA_ASSIGNMENT,
        assistantMessageId: `${AGGREGATE_TURN}:assistant:0`,
      },
      {
        assignmentId: BETA_ASSIGNMENT,
        assistantMessageId: `${AGGREGATE_TURN}:assistant:1`,
      },
    ],
  })
  assert.deepEqual(readConversationTurnPreparedPayload(payload), payload)
})

test('a turn whose speakers run no assignment prepares without links', () => {
  // A generic assistant answers in-process and has no assignment at all, so
  // the absence of a link is a fact about the speaker rather than a gap.
  assert.deepEqual(prepared(), {
    assistantMessageIds: ['7b1c9f2e-2f4a-4a7d-9f0b-2c3d4e5f6a7b:assistant:0'],
  })
})

test('an assignment link must name an assignment, never prose', () => {
  assert.throws(
    () =>
      aggregatePrepared({
        assignments: [
          {
            assignmentId: 'the user asked about their salary',
            assistantMessageId: `${AGGREGATE_TURN}:assistant:0`,
          },
        ],
      }),
    ConversationTurnPayloadError,
    'a free-text assignment id is content wearing an identity field',
  )
  assert.throws(
    () =>
      aggregatePrepared({
        assignments: [{ assignmentId: ALPHA_ASSIGNMENT }],
      }),
    ConversationTurnPayloadError,
    'a link that names no reply links nothing',
  )
  assert.throws(
    () =>
      aggregatePrepared({
        assignments: [
          {
            assignmentId: ALPHA_ASSIGNMENT,
            assistantMessageId: `${AGGREGATE_TURN}:assistant:0`,
            promptExcerpt: 'what the user said',
          },
        ],
      }),
    ConversationTurnPayloadError,
    'an unrecognised field on a link is a rejection, not a field to drop',
  )
})

test('a link must name a reply the same preparation claimed', () => {
  assert.throws(
    () =>
      aggregatePrepared({
        assignments: [
          {
            assignmentId: ALPHA_ASSIGNMENT,
            assistantMessageId: `${AGGREGATE_TURN}:assistant:7`,
          },
        ],
      }),
    ConversationTurnPayloadError,
    'a link to a reply this turn never claimed points at nothing',
  )
})

test('two links may not claim one assignment or one reply', () => {
  assert.throws(
    () =>
      aggregatePrepared({
        assignments: [
          {
            assignmentId: ALPHA_ASSIGNMENT,
            assistantMessageId: `${AGGREGATE_TURN}:assistant:0`,
          },
          {
            assignmentId: ALPHA_ASSIGNMENT,
            assistantMessageId: `${AGGREGATE_TURN}:assistant:1`,
          },
        ],
      }),
    ConversationTurnPayloadError,
    'one assignment produced one reply; two links to it contradict the journal it points at',
  )
  assert.throws(
    () =>
      aggregatePrepared({
        assignments: [
          {
            assignmentId: ALPHA_ASSIGNMENT,
            assistantMessageId: `${AGGREGATE_TURN}:assistant:0`,
          },
          {
            assignmentId: BETA_ASSIGNMENT,
            assistantMessageId: `${AGGREGATE_TURN}:assistant:0`,
          },
        ],
      }),
    ConversationTurnPayloadError,
    'one reply came from one assignment',
  )
})

test('a reduced aggregate reports every link its preparation recorded', () => {
  const summary = reduceConversationTurnStream(AGGREGATE_TURN, [
    {
      type: 'conversation.turn.started',
      payload: started({
        surface: 'run-selected-agents',
        userMessageId: `${AGGREGATE_TURN}:user`,
        expectedResponseCount: 2,
      }),
    },
    { type: 'conversation.turn.prepared', payload: aggregatePrepared() },
    {
      type: 'conversation.turn.completed',
      payload: buildConversationTurnCompletedPayload({
        assistantMessageIds: [
          `${AGGREGATE_TURN}:assistant:0`,
          `${AGGREGATE_TURN}:assistant:1`,
        ],
      }),
    },
  ])
  assert.equal(summary.state, 'completed')
  assert.equal(summary.surface, 'run-selected-agents')
  assert.deepEqual(summary.assignments, [
    {
      assignmentId: ALPHA_ASSIGNMENT,
      assistantMessageId: `${AGGREGATE_TURN}:assistant:0`,
    },
    {
      assignmentId: BETA_ASSIGNMENT,
      assistantMessageId: `${AGGREGATE_TURN}:assistant:1`,
    },
  ])
})

test('a partial multi-speaker failure keeps every link and only the durable replies', () => {
  const summary = reduceConversationTurnStream(AGGREGATE_TURN, [
    {
      type: 'conversation.turn.started',
      payload: started({
        surface: 'run-selected-agents',
        userMessageId: `${AGGREGATE_TURN}:user`,
        expectedResponseCount: 2,
      }),
    },
    { type: 'conversation.turn.prepared', payload: aggregatePrepared() },
    {
      type: 'conversation.turn.failed',
      payload: buildConversationTurnFailedPayload({
        failure: { code: 'reply_not_published', phase: 'publication' },
        assistantMessageIds: [`${AGGREGATE_TURN}:assistant:0`],
      }),
    },
  ])
  assert.equal(summary.state, 'failed')
  assert.deepEqual(
    summary.assistantMessageIds,
    [`${AGGREGATE_TURN}:assistant:0`],
    'only the reply that reached the transcript is durable',
  )
  // Both links stay, because both assignments really ran and both journals
  // hold evidence. Dropping the second would hide the assignment an operator
  // needs to open to find out why its reply never arrived.
  assert.deepEqual(summary.assignments?.length, 2)
})

test('a link the reader cannot check makes the stream invalid, not partial', () => {
  const smuggled = {
    ...aggregatePrepared(),
    assignments: [
      {
        assignmentId: ALPHA_ASSIGNMENT,
        assistantMessageId: `${AGGREGATE_TURN}:assistant:0`,
      },
      { assignmentId: BETA_ASSIGNMENT, assistantMessageId: 'the beta answer' },
    ],
  }
  assert.equal(readConversationTurnPreparedPayload(smuggled), null)
  assert.equal(
    reduceConversationTurnStream(AGGREGATE_TURN, [
      {
        type: 'conversation.turn.started',
        payload: started({
          surface: 'run-selected-agents',
          userMessageId: `${AGGREGATE_TURN}:user`,
          expectedResponseCount: 2,
        }),
      },
      { type: 'conversation.turn.prepared', payload: smuggled },
    ]).state,
    'invalid',
  )
})

/**
 * What the reducer refuses once it knows which surface published the turn.
 *
 * The payload reader cannot make these judgements: it sees one event, and the
 * facts that decide them — which surface this is, and which replies preparation
 * claimed — are carried by other events in the same stream. So the stream is
 * where they belong, and a record that fails them reduces to `invalid` rather
 * than being reported as a turn an operator could act on.
 */
function selectedAgentsStarted(expectedResponseCount: number) {
  return started({
    surface: 'run-selected-agents',
    userMessageId: `${AGGREGATE_TURN}:user`,
    expectedResponseCount,
  })
}

test('a selected-agent turn linking only some of its replies is invalid, not completed', () => {
  // The whole point of the aggregate is that an operator can follow every
  // reply to the assignment that produced it. A record linking one of two
  // reduces to a turn that looks finished and cannot be followed, which is
  // worse than one that admits it is broken.
  const halfLinked = {
    ...aggregatePrepared(),
    assignments: [
      {
        assignmentId: ALPHA_ASSIGNMENT,
        assistantMessageId: `${AGGREGATE_TURN}:assistant:0`,
      },
    ],
  }
  const events = [
    { type: 'conversation.turn.started', payload: selectedAgentsStarted(2) },
    { type: 'conversation.turn.prepared', payload: halfLinked },
  ]
  assert.equal(
    reduceConversationTurnStream(AGGREGATE_TURN, events).state,
    'invalid',
    'a partially linked preparation is refused where it is written',
  )
  assert.equal(
    reduceConversationTurnStream(AGGREGATE_TURN, [
      ...events,
      {
        type: 'conversation.turn.completed',
        payload: buildConversationTurnCompletedPayload({
          assistantMessageIds: [
            `${AGGREGATE_TURN}:assistant:0`,
            `${AGGREGATE_TURN}:assistant:1`,
          ],
        }),
      },
    ]).state,
    'invalid',
    'and a terminal cannot make a partially linked turn readable',
  )
})

test('a selected-agent turn answered in process links nothing and stays valid', () => {
  // The generic assistant runs in this process and has no assignment at all,
  // so a turn it answered legitimately carries no link. Absent is "there was
  // nothing to link"; the case the rule above refuses is "there was, and only
  // some of it was recorded".
  const summary = reduceConversationTurnStream(AGGREGATE_TURN, [
    { type: 'conversation.turn.started', payload: selectedAgentsStarted(1) },
    {
      type: 'conversation.turn.prepared',
      payload: buildConversationTurnPreparedPayload({
        assistantMessageIds: [`${AGGREGATE_TURN}:assistant:0`],
      }),
    },
    {
      type: 'conversation.turn.completed',
      payload: buildConversationTurnCompletedPayload({
        assistantMessageIds: [`${AGGREGATE_TURN}:assistant:0`],
      }),
    },
  ])
  assert.equal(summary.state, 'completed')
  assert.equal(summary.assignments, undefined)
})

test('a failed terminal may only name replies the preparation claimed, in that order', () => {
  const prepare = [
    { type: 'conversation.turn.started', payload: selectedAgentsStarted(2) },
    { type: 'conversation.turn.prepared', payload: aggregatePrepared() },
  ]
  const failedWith = (assistantMessageIds: readonly string[]) => [
    ...prepare,
    {
      type: 'conversation.turn.failed',
      payload: buildConversationTurnFailedPayload({
        failure: { code: 'reply_not_published', phase: 'publication' },
        assistantMessageIds,
      }),
    },
  ]

  assert.equal(
    reduceConversationTurnStream(
      AGGREGATE_TURN,
      failedWith([`7b1c9f2e-2f4a-4a7d-9f0b-2c3d4e5f6a7b:assistant:0`]),
    ).state,
    'invalid',
    'a terminal naming a reply from another turn describes a different turn',
  )
  assert.equal(
    reduceConversationTurnStream(
      AGGREGATE_TURN,
      failedWith([
        `${AGGREGATE_TURN}:assistant:1`,
        `${AGGREGATE_TURN}:assistant:0`,
      ]),
    ).state,
    'invalid',
    'order pairs a reply with its speaker, so a reordered list is a different claim',
  )

  // The partial failure this field exists for is unchanged: a prefix, or any
  // ordered subset, of what preparation claimed.
  const partial = reduceConversationTurnStream(
    AGGREGATE_TURN,
    failedWith([`${AGGREGATE_TURN}:assistant:1`]),
  )
  assert.equal(partial.state, 'failed')
  assert.deepEqual(partial.assistantMessageIds, [
    `${AGGREGATE_TURN}:assistant:1`,
  ])
})

test('a turn that failed before preparing cannot name a durable reply', () => {
  assert.equal(
    reduceConversationTurnStream(AGGREGATE_TURN, [
      { type: 'conversation.turn.started', payload: selectedAgentsStarted(2) },
      {
        type: 'conversation.turn.failed',
        payload: buildConversationTurnFailedPayload({
          failure: { code: 'preparation_failed', phase: 'preparation' },
          assistantMessageIds: [`${AGGREGATE_TURN}:assistant:0`],
        }),
      },
    ]).state,
    'invalid',
    'nothing had been claimed yet, so there is no reply this turn could have published',
  )
})
