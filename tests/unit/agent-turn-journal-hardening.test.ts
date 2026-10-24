/**
 * What the agent-turn journal refuses to believe.
 *
 * Two of these are content the journal must never hold: a provider chooses
 * the string in its own `code` field, so an unbounded one is a channel for
 * prose, an echoed prompt, or a credential. The rest are streams that parse
 * event by event but contradict themselves when read together — a terminal
 * naming a different reply than the preparation, or a preparation calling
 * itself a failure while carrying no failure at all.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { CanonicalJsonObject } from '../../contracts/canonical-json.js'
import type { ExecutionJournalEvent } from '../../contracts/execution-journal.js'
import {
  AGENT_TURN_CANCELLED_EVENT_TYPE,
  AGENT_TURN_COMPLETED_EVENT_TYPE,
  AGENT_TURN_PAYLOAD_SCHEMA_VERSION,
  AGENT_TURN_PREPARED_EVENT_TYPE,
  AGENT_TURN_STARTED_EVENT_TYPE,
  AGENT_TURN_STREAM_KIND,
  buildAgentTurnCancelledPayload,
  buildAgentTurnCompletedPayload,
  buildAgentTurnFailedPayload,
  readAgentTurnFailedPayload,
  buildAgentTurnPreparedPayload,
  buildAgentTurnStartedPayload,
  summarizeAgentTurnStreams,
} from '../../domains/agent-execution/agent-turn-journal.js'

const ASSIGNMENT_ID = '11111111-2222-3333-4444-555555555555'
const TURN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const REPLY_ID = 'quick-scout:0'
const MESSAGE_ID = 'msg-7'

function makeEvent(input: {
  readonly type: string
  readonly streamRevision: number
  readonly payload: CanonicalJsonObject
}): ExecutionJournalEvent {
  return {
    schemaVersion: 1,
    eventId: `${ASSIGNMENT_ID}:agent-turn:${input.type}`,
    sequence: input.streamRevision,
    recordedAt: `2026-08-25T10:0${input.streamRevision}:00.000Z`,
    scopeKind: 'assignment',
    scopeId: ASSIGNMENT_ID,
    tenantId: 'local',
    streamKind: AGENT_TURN_STREAM_KIND,
    streamId: ASSIGNMENT_ID,
    streamRevision: input.streamRevision,
    type: input.type,
    payloadSchemaVersion: AGENT_TURN_PAYLOAD_SCHEMA_VERSION,
    appendRequestDigest: 'digest',
    correlationId: TURN_ID,
    previousEventHash: 'previous',
    eventHash: 'hash',
    payload: input.payload,
  }
}

function started(): ExecutionJournalEvent {
  return makeEvent({
    type: AGENT_TURN_STARTED_EVENT_TYPE,
    streamRevision: 1,
    payload: buildAgentTurnStartedPayload({
      turnId: TURN_ID,
      replyId: REPLY_ID,
      speakerOrdinal: 0,
      agentPath: 'agents/quick-scout',
    }),
  })
}

function prepared(
  overrides: Partial<Parameters<typeof buildAgentTurnPreparedPayload>[0]> = {},
): ExecutionJournalEvent {
  return makeEvent({
    type: AGENT_TURN_PREPARED_EVENT_TYPE,
    streamRevision: 2,
    payload: buildAgentTurnPreparedPayload({
      turnId: TURN_ID,
      replyId: REPLY_ID,
      assistantMessageId: MESSAGE_ID,
      outcome: 'success',
      route: 'mcp-native',
      outputByteLength: 12,
      ...overrides,
    }),
  })
}

const PROSE =
  'The tenant key sk-live-9f3a2b was rejected; here is the prompt we saw: ...'

test('a provider code that is not a short identifier never reaches the journal', () => {
  const payload = buildAgentTurnFailedPayload({
    turnId: TURN_ID,
    replyId: REPLY_ID,
    failure: {
      layer: 'provider-adapter',
      phase: 'provider-request',
      serviceCode: 'provider_failed',
      providerCode: PROSE,
      retryable: true,
    },
  })

  const failure = payload.failure
  assert.ok(failure && typeof failure === 'object' && !Array.isArray(failure))
  assert.equal(
    'providerCode' in failure,
    false,
    'free-form provider text is dropped rather than stored',
  )
  assert.equal(JSON.stringify(payload).includes('sk-live-9f3a2b'), false)
})

test('an over-long provider code is dropped, and a short one is kept', () => {
  const overLong = 'a'.repeat(65)
  const dropped = buildAgentTurnFailedPayload({
    turnId: TURN_ID,
    replyId: REPLY_ID,
    failure: {
      layer: 'provider-adapter',
      phase: 'provider-request',
      serviceCode: 'provider_failed',
      providerCode: overLong,
      providerKind: 'overloaded',
      retryable: true,
    },
  })
  const droppedFailure = dropped.failure
  assert.ok(
    droppedFailure &&
      typeof droppedFailure === 'object' &&
      !Array.isArray(droppedFailure),
  )
  assert.equal('providerCode' in droppedFailure, false)

  const kept = buildAgentTurnFailedPayload({
    turnId: TURN_ID,
    replyId: REPLY_ID,
    failure: {
      layer: 'provider-adapter',
      phase: 'provider-request',
      serviceCode: 'provider_failed',
      providerCode: 'model_overloaded',
      retryable: true,
    },
  })
  const keptFailure = kept.failure
  assert.ok(
    keptFailure && typeof keptFailure === 'object' && !Array.isArray(keptFailure),
  )
  assert.equal(
    'providerCode' in keptFailure ? keptFailure.providerCode : undefined,
    'model_overloaded',
  )
})

test('a terminal naming a different reply than the preparation is invalid', () => {
  const [summary] = summarizeAgentTurnStreams([
    started(),
    prepared(),
    makeEvent({
      type: AGENT_TURN_COMPLETED_EVENT_TYPE,
      streamRevision: 3,
      payload: buildAgentTurnCompletedPayload({
        turnId: TURN_ID,
        replyId: REPLY_ID,
        assistantMessageId: 'some-other-message',
        route: 'mcp-native',
      }),
    }),
  ])

  assert.ok(summary)
  assert.equal(summary.state, 'invalid')
})

test('a terminal from a different turn or reply is invalid', () => {
  for (const conflicting of [
    { turnId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff', replyId: REPLY_ID },
    { turnId: TURN_ID, replyId: 'someone-else:3' },
  ]) {
    const [summary] = summarizeAgentTurnStreams([
      started(),
      prepared(),
      makeEvent({
        type: AGENT_TURN_COMPLETED_EVENT_TYPE,
        streamRevision: 3,
        payload: buildAgentTurnCompletedPayload({
          ...conflicting,
          assistantMessageId: MESSAGE_ID,
          route: 'mcp-native',
        }),
      }),
    ])

    assert.ok(summary)
    assert.equal(summary.state, 'invalid', JSON.stringify(conflicting))
  }
})

test('a terminal that changes the route mid-stream is invalid', () => {
  const [summary] = summarizeAgentTurnStreams([
    started(),
    prepared({ route: 'mcp-native' }),
    makeEvent({
      type: AGENT_TURN_COMPLETED_EVENT_TYPE,
      streamRevision: 3,
      payload: buildAgentTurnCompletedPayload({
        turnId: TURN_ID,
        replyId: REPLY_ID,
        assistantMessageId: MESSAGE_ID,
        route: 'direct-provider',
      }),
    }),
  ])

  assert.ok(summary)
  assert.equal(summary.state, 'invalid')
})

test('a preparation that calls itself a failure must carry one', () => {
  assert.throws(
    () =>
      buildAgentTurnPreparedPayload({
        turnId: TURN_ID,
        replyId: REPLY_ID,
        assistantMessageId: MESSAGE_ID,
        outcome: 'provider-failure',
        route: 'direct-provider',
        outputByteLength: 12,
      }),
    /failure/i,
    'a failed outcome with no failure identity would reconcile as a success',
  )
})

test('a successful preparation may not carry a failure identity', () => {
  assert.throws(() =>
    buildAgentTurnPreparedPayload({
      turnId: TURN_ID,
      replyId: REPLY_ID,
      assistantMessageId: MESSAGE_ID,
      outcome: 'success',
      route: 'direct-provider',
      outputByteLength: 12,
      failure: {
        layer: 'direct-provider',
        phase: 'provider-request',
        serviceCode: 'provider_failed',
        retryable: true,
      },
    }),
  )
})

test('a stored preparation whose outcome and failure disagree reads as invalid', () => {
  // Written as a raw payload, because the constructor now refuses to produce
  // one — which is the point: the reducer reads what is on disk.
  const [summary] = summarizeAgentTurnStreams([
    started(),
    makeEvent({
      type: AGENT_TURN_PREPARED_EVENT_TYPE,
      streamRevision: 2,
      payload: {
        turnId: TURN_ID,
        replyId: REPLY_ID,
        assistantMessageId: MESSAGE_ID,
        outcome: 'provider-failure',
        route: 'direct-provider',
        outputByteLength: 12,
      },
    }),
  ])

  assert.ok(summary)
  assert.equal(summary.state, 'invalid')
})

test('cancellation is not a preparation outcome', () => {
  // Cancellation is modelled as its own terminal, reached through
  // `recordCancelled`. Admitting it here too would give one fact two
  // representations, and the failure-carrying one would then be reduced as a
  // provider failure — which is not what the user did.
  assert.throws(
    () =>
      buildAgentTurnPreparedPayload({
        turnId: TURN_ID,
        replyId: REPLY_ID,
        assistantMessageId: MESSAGE_ID,
        // Deliberately outside the prepared union; the runtime cannot produce
        // this, and the journal must not accept it from anywhere else either.
        outcome: 'cancelled',
        route: 'direct-provider',
        outputByteLength: 12,
        failure: {
          layer: 'direct-provider',
          phase: 'provider-request',
          serviceCode: 'cancelled',
          retryable: false,
        },
      } as unknown as Parameters<typeof buildAgentTurnPreparedPayload>[0]),
    /cancel/i,
  )
})

test('a stored preparation claiming cancellation reads as invalid', () => {
  const [summary] = summarizeAgentTurnStreams([
    started(),
    makeEvent({
      type: AGENT_TURN_PREPARED_EVENT_TYPE,
      streamRevision: 2,
      payload: {
        turnId: TURN_ID,
        replyId: REPLY_ID,
        assistantMessageId: MESSAGE_ID,
        outcome: 'cancelled',
        route: 'direct-provider',
        outputByteLength: 12,
        failure: {
          layer: 'direct-provider',
          phase: 'provider-request',
          serviceCode: 'cancelled',
          retryable: false,
        },
      },
    }),
  ])

  assert.ok(summary)
  assert.equal(summary.state, 'invalid')
})

test('a started-to-cancelled turn stays cancelled and fabricates no failure', () => {
  const [summary] = summarizeAgentTurnStreams([
    started(),
    makeEvent({
      type: AGENT_TURN_CANCELLED_EVENT_TYPE,
      streamRevision: 2,
      payload: buildAgentTurnCancelledPayload({
        turnId: TURN_ID,
        replyId: REPLY_ID,
        phase: 'provider-request',
      }),
    }),
  ])

  assert.ok(summary)
  assert.equal(summary.state, 'cancelled')
  assert.equal(summary.failure, undefined)
  assert.equal(summary.failureAtPreparation, undefined)
  assert.equal(summary.outcome, undefined)
})

/**
 * When a usage limit stops being true, carried as a moment.
 *
 * Additive at payload schema version 1: a journal written before this field
 * existed still reduces and simply reports no reset, and a journal written by
 * a path with nothing to state is the same bytes as before.
 *
 * It is an instant this build derived, never the provider's own words about
 * when the account comes back. That sentence is display text, and the journal
 * holds no display text — which is exactly why the reset can travel here when
 * the message it came from cannot.
 */

test('a stated reset instant reaches the journal and reads back unchanged', () => {
  const resetsAt = '2026-09-14T21:45:00.000Z'
  const payload = buildAgentTurnFailedPayload({
    turnId: TURN_ID,
    replyId: REPLY_ID,
    failure: {
      layer: 'provider-adapter',
      phase: 'provider-request',
      serviceCode: 'usage_limit',
      providerKind: 'usage_limit',
      provider: 'codex',
      model: 'gpt-5.5',
      resetsAt,
      retryable: false,
    },
  })

  const failure = payload.failure
  assert.ok(failure && typeof failure === 'object' && !Array.isArray(failure))
  assert.equal('resetsAt' in failure ? failure.resetsAt : undefined, resetsAt)

  const read = readAgentTurnFailedPayload(payload)
  assert.ok(read)
  assert.equal(read.failure.resetsAt, resetsAt)
})

test('a reset that is not an exact instant never reaches the journal', () => {
  // "Sep 14, 2026 at 9:45 PM" is the sentence a person reads. Storing it would
  // put display text in a record that holds none, and would hand a later
  // reader a string it would have to re-interpret against the wrong clock.
  for (const notAnInstant of [
    'Sep 14, 2026 at 9:45 PM',
    'tomorrow',
    '2026-09-14',
    PROSE,
  ]) {
    const payload = buildAgentTurnFailedPayload({
      turnId: TURN_ID,
      replyId: REPLY_ID,
      failure: {
        layer: 'provider-adapter',
        phase: 'provider-request',
        serviceCode: 'usage_limit',
        providerKind: 'usage_limit',
        resetsAt: notAnInstant,
        retryable: false,
      },
    })
    const failure = payload.failure
    assert.ok(failure && typeof failure === 'object' && !Array.isArray(failure))
    assert.equal(
      'resetsAt' in failure,
      false,
      `'${notAnInstant}' is not an instant and is dropped`,
    )
  }
})

test('a reset a reader finds stored as prose is refused on the way out too', () => {
  // A journal file predating the write rule, or written by another hand, must
  // not hand a reader something it would parse against today's clock.
  const read = readAgentTurnFailedPayload({
    turnId: TURN_ID,
    replyId: REPLY_ID,
    failure: {
      layer: 'provider-adapter',
      phase: 'provider-request',
      serviceCode: 'usage_limit',
      providerKind: 'usage_limit',
      resetsAt: 'Sep 14, 2026 at 9:45 PM',
      retryable: false,
    },
  })

  assert.ok(read)
  assert.equal(read.failure.resetsAt, undefined)
})
