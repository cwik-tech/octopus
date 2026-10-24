import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyEngineEvent } from '../../contracts/engine-event-classification.js'
import {
  TEAM_CHAT_MESSAGE_EVENT_TYPE,
  isTeamChatMessagePayload,
  teamChatMessageId,
} from '../../contracts/team-chat-messages.js'

function makeMessagePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    message_id: 'run-1#run-1#1#line-one',
    run_id: 'run-1',
    dispatch_id: 'run-1#1#line-one',
    stage_id: 'run',
    agent_name: 'line-one',
    text: 'Phased rollout recommended.',
    timestamp: '2026-08-30T10:00:00.000Z',
    message_type: 'position',
    ...overrides,
  }
}

test('a Team chat message identity is stable for one run and dispatch', () => {
  const identity = teamChatMessageId({
    runId: 'run-1',
    dispatchId: 'run-1#1#line-one',
  })

  assert.equal(
    identity,
    teamChatMessageId({ runId: 'run-1', dispatchId: 'run-1#1#line-one' }),
  )
  assert.notEqual(
    identity,
    teamChatMessageId({ runId: 'run-1', dispatchId: 'run-1#2#line-one' }),
  )
  assert.notEqual(
    identity,
    teamChatMessageId({ runId: 'run-2', dispatchId: 'run-1#1#line-one' }),
  )
})

test('a durable Team chat payload must carry every field needed to render it', () => {
  assert.equal(isTeamChatMessagePayload(makeMessagePayload()), true)

  for (const field of [
    'message_id',
    'run_id',
    'dispatch_id',
    'stage_id',
    'agent_name',
    'text',
    'timestamp',
    'message_type',
  ]) {
    assert.equal(
      isTeamChatMessagePayload(makeMessagePayload({ [field]: undefined })),
      false,
      `${field} is required`,
    )
    assert.equal(
      isTeamChatMessagePayload(makeMessagePayload({ [field]: '   ' })),
      false,
      `${field} may not be blank`,
    )
    assert.equal(
      isTeamChatMessagePayload(makeMessagePayload({ [field]: 7 })),
      false,
      `${field} must be a string`,
    )
  }

  assert.equal(isTeamChatMessagePayload(null), false)
  assert.equal(isTeamChatMessagePayload('team.message'), false)
})

test('Team chat messages are content, so only their own file holds the prose', () => {
  assert.equal(TEAM_CHAT_MESSAGE_EVENT_TYPE, 'team.message')
  assert.equal(
    classifyEngineEvent({
      category: 'stage',
      type: TEAM_CHAT_MESSAGE_EVENT_TYPE,
    }).kind,
    'content',
  )
})
