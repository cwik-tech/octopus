/**
 * What a turn's lifecycle is allowed to claim about itself.
 *
 * Replay and repair both work by matching a durable record against a transcript,
 * so the record has to be exact where the matching is exact. Four places it was
 * not:
 *
 * A turn could say it expected no replies, which is not a turn — and a
 * `completed` naming no replies would then agree with it.
 *
 * A reply list could name the same message twice, so two claimed replies could
 * be one message wearing one identity.
 *
 * Preparation could claim a different number of replies than the turn said it
 * expected, so the count an operator diagnoses a missing reply with never had
 * to be true.
 *
 * And completion compared its replies to preparation's as an unordered set, so
 * a turn could finish naming the same replies in a different order — which is a
 * different answer, because order is what pairs a reply with its place.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  ConversationTurnPayloadError,
  CONVERSATION_TURN_COMPLETED_EVENT_TYPE,
  CONVERSATION_TURN_PREPARED_EVENT_TYPE,
  CONVERSATION_TURN_STARTED_EVENT_TYPE,
  buildConversationTurnCompletedPayload,
  buildConversationTurnPreparedPayload,
  buildConversationTurnStartedPayload,
  reduceConversationTurnStream,
} from '../../domains/conversations/conversation-turn-journal.js'

const DIGEST = 'd1'.repeat(32)
const TURN = randomUUID()
const REPLY_ONE = `${TURN}:assistant:0`
const REPLY_TWO = `${TURN}:assistant:1`

function startedPayload(expectedResponseCount: number) {
  return buildConversationTurnStartedPayload({
    surface: 'run-receptionist',
    userMessageId: `${TURN}:user`,
    requestDigest: DIGEST,
    expectedResponseCount,
    origin: 'client',
  })
}

function streamOf(
  ...events: readonly { type: string; payload: unknown }[]
) {
  return reduceConversationTurnStream(TURN, events)
}

test('a turn that expects no reply is not a turn', () => {
  assert.throws(() => startedPayload(0), ConversationTurnPayloadError)
})

test('a reply list cannot name the same message twice', () => {
  assert.throws(
    () =>
      buildConversationTurnPreparedPayload({
        assistantMessageIds: [REPLY_ONE, REPLY_ONE],
      }),
    ConversationTurnPayloadError,
    'two claimed replies that are one message is one reply, counted twice',
  )
})

test('preparation must claim the number of replies the turn expected', () => {
  const summary = streamOf(
    { type: CONVERSATION_TURN_STARTED_EVENT_TYPE, payload: startedPayload(2) },
    {
      type: CONVERSATION_TURN_PREPARED_EVENT_TYPE,
      payload: buildConversationTurnPreparedPayload({
        assistantMessageIds: [REPLY_ONE],
      }),
    },
  )
  assert.equal(
    summary.state,
    'invalid',
    'the count an operator diagnoses a missing reply with has to be true',
  )
})

test('completion must name preparation’s replies in the order it named them', () => {
  const summary = streamOf(
    { type: CONVERSATION_TURN_STARTED_EVENT_TYPE, payload: startedPayload(2) },
    {
      type: CONVERSATION_TURN_PREPARED_EVENT_TYPE,
      payload: buildConversationTurnPreparedPayload({
        assistantMessageIds: [REPLY_ONE, REPLY_TWO],
      }),
    },
    {
      type: CONVERSATION_TURN_COMPLETED_EVENT_TYPE,
      payload: buildConversationTurnCompletedPayload({
        assistantMessageIds: [REPLY_TWO, REPLY_ONE],
      }),
    },
  )
  assert.equal(
    summary.state,
    'invalid',
    'order is what pairs a reply with its place, so a reordering is a ' +
      'different answer',
  )
})

test('the lifecycle this build actually writes still reduces cleanly', () => {
  const summary = streamOf(
    { type: CONVERSATION_TURN_STARTED_EVENT_TYPE, payload: startedPayload(2) },
    {
      type: CONVERSATION_TURN_PREPARED_EVENT_TYPE,
      payload: buildConversationTurnPreparedPayload({
        assistantMessageIds: [REPLY_ONE, REPLY_TWO],
      }),
    },
    {
      type: CONVERSATION_TURN_COMPLETED_EVENT_TYPE,
      payload: buildConversationTurnCompletedPayload({
        assistantMessageIds: [REPLY_ONE, REPLY_TWO],
      }),
    },
  )
  assert.equal(summary.state, 'completed')
  assert.deepEqual(summary.assistantMessageIds, [REPLY_ONE, REPLY_TWO])
  assert.equal(summary.expectedResponseCount, 2)
})
