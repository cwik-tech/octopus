/**
 * The `agent.turn` domain stream: its payload schemas, its deterministic event
 * identity, and the reduction an operator report is derived from.
 *
 * These are the rules the outer journey cannot express. A crash between the
 * provider answering and the reply being stored has to read as `reply_pending`
 * and name the message it intended to write; a terminal with no start, or two
 * terminals, has to read as `invalid` rather than being quietly repaired.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { CanonicalJsonObject } from '../../contracts/canonical-json.js'
import type { ExecutionJournalEvent } from '../../contracts/execution-journal.js'
import {
  AGENT_TURN_CANCELLED_EVENT_TYPE,
  AGENT_TURN_COMPLETED_EVENT_TYPE,
  AGENT_TURN_FAILED_EVENT_TYPE,
  AGENT_TURN_PAYLOAD_SCHEMA_VERSION,
  AGENT_TURN_PREPARED_EVENT_TYPE,
  AGENT_TURN_STARTED_EVENT_TYPE,
  AGENT_TURN_STREAM_KIND,
  agentTurnEventId,
  buildAgentTurnCancelledPayload,
  buildAgentTurnCompletedPayload,
  buildAgentTurnFailedPayload,
  buildAgentTurnPreparedPayload,
  buildAgentTurnStartedPayload,
  readAgentTurnStartedPayload,
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
  readonly sequence?: number
  readonly streamId?: string
  readonly recordedAt?: string
}): ExecutionJournalEvent {
  const sequence = input.sequence ?? input.streamRevision
  return {
    schemaVersion: 1,
    eventId: `${input.streamId ?? ASSIGNMENT_ID}:agent-turn:${input.type}`,
    sequence,
    recordedAt: input.recordedAt ?? `2026-08-25T10:0${sequence}:00.000Z`,
    scopeKind: 'assignment',
    scopeId: ASSIGNMENT_ID,
    tenantId: 'local',
    streamKind: AGENT_TURN_STREAM_KIND,
    streamId: input.streamId ?? ASSIGNMENT_ID,
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

function startedEvent(streamId?: string): ExecutionJournalEvent {
  return makeEvent({
    type: AGENT_TURN_STARTED_EVENT_TYPE,
    streamRevision: 1,
    ...(streamId === undefined ? {} : { streamId }),
    payload: buildAgentTurnStartedPayload({
      turnId: TURN_ID,
      replyId: REPLY_ID,
      speakerOrdinal: 0,
      agentPath: 'agents/quick-scout',
      requestedProvider: 'connection:abc',
      requestedModel: 'fixture/quick-scout',
    }),
  })
}

function preparedEvent(
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
      resolvedModel: 'fixture/quick-scout',
      declaredToolCount: 3,
      executedToolCount: 1,
      outputByteLength: 128,
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      ...overrides,
    }),
  })
}

const PROVIDER_FAILURE = {
  layer: 'provider-adapter',
  phase: 'provider-request',
  serviceCode: 'provider_failed',
  providerKind: 'unavailable',
  providerCode: 'model_overloaded',
  httpStatus: 503,
  retryable: true,
} as const

test('a stream holding only a start is a provider request still in flight', () => {
  const [summary] = summarizeAgentTurnStreams([startedEvent()])

  assert.ok(summary)
  assert.equal(summary.state, 'provider_in_progress')
  assert.equal(summary.turnId, TURN_ID)
  assert.equal(summary.replyId, REPLY_ID)
  assert.equal(summary.assignmentId, ASSIGNMENT_ID)
  assert.equal(summary.assistantMessageId, undefined)
  assert.equal(summary.terminalSequence, undefined)
})

test('a stream ending at preparation names the reply it meant to store', () => {
  const [summary] = summarizeAgentTurnStreams([startedEvent(), preparedEvent()])

  assert.ok(summary)
  assert.equal(summary.state, 'reply_pending')
  assert.equal(
    summary.assistantMessageId,
    MESSAGE_ID,
    'reconciliation needs the predetermined message id',
  )
  assert.equal(summary.route, 'mcp-native')
  assert.equal(summary.model, 'fixture/quick-scout')
})

test('a prepared turn that stored its reply is completed', () => {
  const [summary] = summarizeAgentTurnStreams([
    startedEvent(),
    preparedEvent(),
    makeEvent({
      type: AGENT_TURN_COMPLETED_EVENT_TYPE,
      streamRevision: 3,
      payload: buildAgentTurnCompletedPayload({
        turnId: TURN_ID,
        replyId: REPLY_ID,
        assistantMessageId: MESSAGE_ID,
        route: 'mcp-native',
      }),
    }),
  ])

  assert.ok(summary)
  assert.equal(summary.state, 'completed')
  assert.equal(summary.assistantMessageId, MESSAGE_ID)
  assert.equal(summary.terminalSequence, 3)
})

test('a provider failure recorded after the safe reply keeps its sanitized identity', () => {
  const [summary] = summarizeAgentTurnStreams([
    startedEvent(),
    preparedEvent({
      outcome: 'provider-failure',
      route: 'direct-provider',
      failure: PROVIDER_FAILURE,
    }),
    makeEvent({
      type: AGENT_TURN_FAILED_EVENT_TYPE,
      streamRevision: 3,
      payload: buildAgentTurnFailedPayload({
        turnId: TURN_ID,
        replyId: REPLY_ID,
        assistantMessageId: MESSAGE_ID,
        route: 'direct-provider',
        failure: PROVIDER_FAILURE,
      }),
    }),
  ])

  assert.ok(summary)
  assert.equal(summary.state, 'failed')
  assert.deepEqual(summary.failure, PROVIDER_FAILURE)
  assert.equal(summary.assistantMessageId, MESSAGE_ID)
})

test('a failure before any response was prepared is terminal at the next revision', () => {
  const [summary] = summarizeAgentTurnStreams([
    startedEvent(),
    makeEvent({
      type: AGENT_TURN_FAILED_EVENT_TYPE,
      streamRevision: 2,
      payload: buildAgentTurnFailedPayload({
        turnId: TURN_ID,
        replyId: REPLY_ID,
        failure: {
          layer: 'chat-delivery',
          phase: 'artifact-publication',
          serviceCode: 'internal',
          retryable: false,
        },
      }),
    }),
  ])

  assert.ok(summary)
  assert.equal(summary.state, 'failed')
  assert.equal(
    summary.assistantMessageId,
    undefined,
    'no reply was stored, so none may be claimed',
  )
})

test('cancellation is its own terminal, not a provider failure', () => {
  const [summary] = summarizeAgentTurnStreams([
    startedEvent(),
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
})

test('completion without a preparation is invalid', () => {
  const [summary] = summarizeAgentTurnStreams([
    startedEvent(),
    makeEvent({
      type: AGENT_TURN_COMPLETED_EVENT_TYPE,
      streamRevision: 2,
      payload: buildAgentTurnCompletedPayload({
        turnId: TURN_ID,
        replyId: REPLY_ID,
        assistantMessageId: MESSAGE_ID,
        route: 'mcp-native',
      }),
    }),
  ])

  assert.ok(summary)
  assert.equal(summary.state, 'invalid')
})

test('a terminal with no start is invalid rather than silently repaired', () => {
  const [summary] = summarizeAgentTurnStreams([
    makeEvent({
      type: AGENT_TURN_FAILED_EVENT_TYPE,
      streamRevision: 1,
      payload: buildAgentTurnFailedPayload({
        turnId: TURN_ID,
        replyId: REPLY_ID,
        failure: PROVIDER_FAILURE,
      }),
    }),
  ])

  assert.ok(summary)
  assert.equal(summary.state, 'invalid')
})

test('a second terminal is invalid', () => {
  const [summary] = summarizeAgentTurnStreams([
    startedEvent(),
    preparedEvent(),
    makeEvent({
      type: AGENT_TURN_COMPLETED_EVENT_TYPE,
      streamRevision: 3,
      payload: buildAgentTurnCompletedPayload({
        turnId: TURN_ID,
        replyId: REPLY_ID,
        assistantMessageId: MESSAGE_ID,
        route: 'mcp-native',
      }),
    }),
    makeEvent({
      type: AGENT_TURN_FAILED_EVENT_TYPE,
      streamRevision: 4,
      payload: buildAgentTurnFailedPayload({
        turnId: TURN_ID,
        replyId: REPLY_ID,
        failure: PROVIDER_FAILURE,
      }),
    }),
  ])

  assert.ok(summary)
  assert.equal(summary.state, 'invalid')
})

test('an out-of-order revision is invalid', () => {
  const [summary] = summarizeAgentTurnStreams([
    startedEvent(),
    preparedEvent(),
    makeEvent({
      type: AGENT_TURN_COMPLETED_EVENT_TYPE,
      streamRevision: 5,
      payload: buildAgentTurnCompletedPayload({
        turnId: TURN_ID,
        replyId: REPLY_ID,
        assistantMessageId: MESSAGE_ID,
        route: 'mcp-native',
      }),
    }),
  ])

  assert.ok(summary)
  assert.equal(summary.state, 'invalid')
})

test('each turn stream is reduced separately', () => {
  const other = 'aaaaaaaa-1111-2222-3333-444444444444'
  const summaries = summarizeAgentTurnStreams([
    startedEvent(),
    startedEvent(other),
  ])

  assert.equal(summaries.length, 2)
  assert.deepEqual(
    summaries.map((summary) => summary.assignmentId).sort(),
    [other, ASSIGNMENT_ID].sort(),
  )
})

test('a payload read from the journal is validated, never trusted', () => {
  assert.equal(readAgentTurnStartedPayload({ turnId: TURN_ID }), null)
  assert.equal(
    readAgentTurnStartedPayload({
      turnId: TURN_ID,
      replyId: REPLY_ID,
      speakerOrdinal: -1,
      agentPath: 'agents/quick-scout',
      routeIntent: 'tool-capable',
    }),
    null,
    'a negative speaker ordinal is not a payload this domain produces',
  )
  const valid = readAgentTurnStartedPayload(
    buildAgentTurnStartedPayload({
      turnId: TURN_ID,
      replyId: REPLY_ID,
      speakerOrdinal: 0,
      agentPath: 'agents/quick-scout',
    }),
  )
  assert.equal(valid?.turnId, TURN_ID)
  assert.equal(valid?.routeIntent, 'tool-capable')
})

test('a constructed payload omits absent optional fields rather than nulling them', () => {
  const payload = buildAgentTurnStartedPayload({
    turnId: TURN_ID,
    replyId: REPLY_ID,
    speakerOrdinal: 0,
    agentPath: 'agents/quick-scout',
  })

  assert.deepEqual(Object.keys(payload).sort(), [
    'agentPath',
    'replyId',
    'routeIntent',
    'speakerOrdinal',
    'turnId',
  ])
})

test('a failure identity rejects an unrecognized layer or phase', () => {
  assert.throws(() =>
    buildAgentTurnFailedPayload({
      turnId: TURN_ID,
      replyId: REPLY_ID,
      failure: {
        // A value outside the closed union must not reach the journal.
        layer: 'provider-adapter',
        phase: 'provider-request',
        serviceCode: '',
        retryable: false,
      },
    }),
  )
})

test('event identity is deterministic per assignment and stage', () => {
  assert.equal(
    agentTurnEventId(ASSIGNMENT_ID, 'started'),
    `${ASSIGNMENT_ID}:agent-turn:started`,
  )
  assert.equal(
    agentTurnEventId(ASSIGNMENT_ID, 'prepared'),
    `${ASSIGNMENT_ID}:agent-turn:prepared`,
  )
  assert.equal(
    agentTurnEventId(ASSIGNMENT_ID, 'terminal'),
    `${ASSIGNMENT_ID}:agent-turn:terminal`,
  )
})
