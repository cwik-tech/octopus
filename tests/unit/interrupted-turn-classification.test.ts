/**
 * The rules recovery is allowed to act on, stated without a workspace.
 *
 * Each of these is a decision about somebody's durable record, and the cost of
 * getting one wrong is asymmetric: reading a live turn as dead ends work that
 * was going to succeed, and reading a dead turn as live leaves the user in
 * front of a question that will never be answered. They are worth stating
 * one at a time.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyInterruptedTurn } from '../../domains/conversations/interrupted-turn-classification.js'
import type { AgentTurnSummary } from '../../domains/agent-execution/agent-turn-journal.js'
import type { ConversationTurnSummary } from '../../domains/conversations/conversation-turn-journal.js'

const TURN_ID = 'f15742b7-2854-41df-8584-101ddba7bbdb'
const ASSIGNMENT_ID = '8c3c7288-004c-4620-854d-78123c7bfa34'
const REPLY_MESSAGE_ID = `${TURN_ID}:assistant:0`

function makeConversation(
  overrides: Partial<ConversationTurnSummary> = {},
): ConversationTurnSummary {
  return {
    turnId: TURN_ID,
    state: 'prepared',
    assistantMessageIds: [REPLY_MESSAGE_ID],
    assignments: [
      { assignmentId: ASSIGNMENT_ID, assistantMessageId: REPLY_MESSAGE_ID },
    ],
    expectedResponseCount: 1,
    ...overrides,
  }
}

function makeAssignment(
  overrides: Partial<AgentTurnSummary> = {},
): AgentTurnSummary {
  return {
    assignmentId: ASSIGNMENT_ID,
    turnId: TURN_ID,
    replyId: 'stuck-agent:0',
    state: 'provider_in_progress',
    ...overrides,
  }
}

function classify(input: {
  conversation?: ConversationTurnSummary
  assignments?: readonly AgentTurnSummary[]
  durableAssistantMessageIds?: readonly string[]
  liveInProcess?: boolean
}) {
  return classifyInterruptedTurn({
    turnId: TURN_ID,
    conversation: input.conversation ?? makeConversation(),
    assignments: input.assignments ?? [makeAssignment()],
    durableAssistantMessageIds: input.durableAssistantMessageIds ?? [],
    liveInProcess: input.liveInProcess ?? false,
  })
}

test('a turn whose stream is still owned in this process is left alone', () => {
  assert.deepEqual(classify({ liveInProcess: true }), { kind: 'live' })
})

test('a turn that already reached a terminal is not reopened', () => {
  for (const state of ['completed', 'failed', 'cancelled'] as const) {
    assert.deepEqual(
      classify({ conversation: makeConversation({ state }) }),
      { kind: 'terminal' },
      `a ${state} turn`,
    )
  }
})

test('a turn holding every reply it claimed is left to the replay reconciliation', () => {
  assert.deepEqual(
    classify({
      assignments: [
        makeAssignment({
          state: 'reply_pending',
          assistantMessageId: REPLY_MESSAGE_ID,
        }),
      ],
      durableAssistantMessageIds: [REPLY_MESSAGE_ID],
    }),
    { kind: 'reconcilable' },
  )
})

test('a turn still inside its provider with no live owner is interrupted', () => {
  assert.deepEqual(classify({}), {
    kind: 'interrupted',
    unresolvedAssignmentIds: [ASSIGNMENT_ID],
  })
})

test('a reply that was prepared and never stored is a lost reply, not an interruption', () => {
  assert.deepEqual(
    classify({
      assignments: [
        makeAssignment({
          state: 'reply_pending',
          assistantMessageId: REPLY_MESSAGE_ID,
        }),
      ],
      durableAssistantMessageIds: [],
    }),
    { kind: 'reply-lost', unresolvedAssignmentIds: [ASSIGNMENT_ID] },
  )
})

test('an in-flight speaker decides a turn that also has a lost reply', () => {
  // A multi-speaker turn can hold both. The whole turn's outcome is unknown
  // while any speaker is still inside a provider, and calling it a lost reply
  // would claim more than the record supports.
  const second = 'aa11bb22-cc33-dd44-ee55-ff6677889900'
  assert.deepEqual(
    classify({
      assignments: [
        makeAssignment({
          state: 'reply_pending',
          assistantMessageId: REPLY_MESSAGE_ID,
        }),
        makeAssignment({ assignmentId: second, state: 'provider_in_progress' }),
      ],
    }),
    { kind: 'interrupted', unresolvedAssignmentIds: [second] },
  )
})

test('a turn that died before naming any assignment is interrupted', () => {
  assert.deepEqual(
    classify({
      conversation: {
        turnId: TURN_ID,
        state: 'started',
        assistantMessageIds: [],
        expectedResponseCount: 1,
      },
      assignments: [],
    }),
    { kind: 'interrupted', unresolvedAssignmentIds: [] },
  )
})

test('a stream this build cannot understand is never acted on', () => {
  assert.deepEqual(
    classify({ conversation: makeConversation({ state: 'invalid' }) }),
    { kind: 'indeterminate', reason: 'conversation_stream_invalid' },
  )
  assert.deepEqual(
    classify({ conversation: makeConversation({ state: 'absent' }) }),
    { kind: 'indeterminate', reason: 'conversation_stream_absent' },
  )
  assert.deepEqual(
    classify({ assignments: [makeAssignment({ state: 'invalid' })] }),
    { kind: 'indeterminate', reason: 'assignment_stream_invalid' },
  )
})
