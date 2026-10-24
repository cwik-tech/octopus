import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isAgentTextStreamDelivery,
  isAgentTextStreamInput,
} from '../../contracts/agent-text-stream.js'

test('progress frames accept bounded metadata separately from answer text', () => {
  assert.equal(isAgentTextStreamInput({ type: 'progress', replyId: 'alpha:0', progress: {
    revision: 1, startedAt: 1000, updatedAt: 1000,
    current: { kind: 'observed', phase: 'thinking' }, history: [],
  } }), true)
  assert.equal(isAgentTextStreamInput({ type: 'progress', replyId: 'alpha:0', text: 'PRIVATE', progress: {} }), false)
})

// ─── Producer input ─────────────────────────────────────────────────────────

test('isAgentTextStreamInput accepts a text delta', () => {
  assert.equal(
    isAgentTextStreamInput({
      type: 'delta',
      replyId: 'speaker-a:0',
      channel: 'text',
      text: 'Hello',
    }),
    true,
  )
})

test('isAgentTextStreamInput accepts a reasoning delta', () => {
  assert.equal(
    isAgentTextStreamInput({
      type: 'delta',
      replyId: 'speaker-a:0',
      channel: 'reasoning',
      text: 'thinking',
    }),
    true,
  )
})

test('isAgentTextStreamInput accepts a delta carrying a producer sequence', () => {
  assert.equal(
    isAgentTextStreamInput({
      type: 'delta',
      replyId: 'dispatch-1',
      channel: 'text',
      text: 'Hello',
      producerSequence: 4,
    }),
    true,
  )
})

test('isAgentTextStreamInput accepts a completed final', () => {
  assert.equal(
    isAgentTextStreamInput({
      type: 'final',
      replyId: 'speaker-a:0',
      reason: 'completed',
    }),
    true,
  )
})

test('isAgentTextStreamInput accepts a truncated final', () => {
  assert.equal(
    isAgentTextStreamInput({
      type: 'final',
      replyId: 'speaker-a:0',
      reason: 'truncated',
    }),
    true,
  )
})

test('isAgentTextStreamInput accepts an error', () => {
  assert.equal(
    isAgentTextStreamInput({
      type: 'error',
      replyId: 'speaker-a:0',
      message: 'provider unavailable',
    }),
    true,
  )
})

// ─── Producer input — cross-shaped rejections ───────────────────────────────

test('isAgentTextStreamInput rejects a final carrying text', () => {
  assert.equal(
    isAgentTextStreamInput({
      type: 'final',
      replyId: 'speaker-a:0',
      reason: 'completed',
      text: 'leftover',
    }),
    false,
  )
})

test('isAgentTextStreamInput rejects a delta with no channel', () => {
  assert.equal(
    isAgentTextStreamInput({ type: 'delta', replyId: 'a:0', text: 'Hello' }),
    false,
  )
})

test('isAgentTextStreamInput rejects a delta with an unknown channel', () => {
  assert.equal(
    isAgentTextStreamInput({
      type: 'delta',
      replyId: 'a:0',
      channel: 'audio',
      text: 'Hello',
    }),
    false,
  )
})

test('isAgentTextStreamInput rejects a final with an unknown reason', () => {
  assert.equal(
    isAgentTextStreamInput({ type: 'final', replyId: 'a:0', reason: 'aborted' }),
    false,
  )
})

test('isAgentTextStreamInput rejects a frame with no replyId', () => {
  assert.equal(
    isAgentTextStreamInput({ type: 'delta', channel: 'text', text: 'Hello' }),
    false,
  )
})

test('isAgentTextStreamInput rejects a non-integer producer sequence', () => {
  assert.equal(
    isAgentTextStreamInput({
      type: 'delta',
      replyId: 'a:0',
      channel: 'text',
      text: 'Hello',
      producerSequence: 1.5,
    }),
    false,
  )
})

test('isAgentTextStreamInput rejects a gap, which no producer may submit', () => {
  assert.equal(
    isAgentTextStreamInput({
      type: 'gap',
      channelId: 'c',
      cursor: 3,
      missingProducerFrom: 1,
      missingProducerTo: 2,
    }),
    false,
  )
})

test('isAgentTextStreamInput rejects non-objects', () => {
  assert.equal(isAgentTextStreamInput(null), false)
  assert.equal(isAgentTextStreamInput('delta'), false)
  assert.equal(isAgentTextStreamInput([]), false)
})

// ─── Delivered frames ───────────────────────────────────────────────────────

test('isAgentTextStreamDelivery accepts a delta carrying channelId and cursor', () => {
  assert.equal(
    isAgentTextStreamDelivery({
      type: 'delta',
      replyId: 'a:0',
      channel: 'text',
      text: 'Hello',
      channelId: 'channel-1',
      cursor: 0,
    }),
    true,
  )
})

test('isAgentTextStreamDelivery rejects a delta with no cursor', () => {
  assert.equal(
    isAgentTextStreamDelivery({
      type: 'delta',
      replyId: 'a:0',
      channel: 'text',
      text: 'Hello',
      channelId: 'channel-1',
    }),
    false,
  )
})

test('isAgentTextStreamDelivery accepts a channel-wide gap', () => {
  assert.equal(
    isAgentTextStreamDelivery({
      type: 'gap',
      channelId: 'channel-1',
      cursor: 7,
      missingProducerFrom: 3,
      missingProducerTo: 5,
    }),
    true,
  )
})

test('isAgentTextStreamDelivery accepts a reply-scoped gap', () => {
  assert.equal(
    isAgentTextStreamDelivery({
      type: 'gap',
      channelId: 'channel-1',
      cursor: 7,
      replyId: 'a:0',
      missingProducerFrom: 3,
      missingProducerTo: 5,
    }),
    true,
  )
})

test('isAgentTextStreamDelivery rejects a gap with no producer range', () => {
  assert.equal(
    isAgentTextStreamDelivery({
      type: 'gap',
      channelId: 'channel-1',
      cursor: 7,
    }),
    false,
  )
})

test('isAgentTextStreamDelivery rejects a gap whose range runs backwards', () => {
  assert.equal(
    isAgentTextStreamDelivery({
      type: 'gap',
      channelId: 'channel-1',
      cursor: 7,
      missingProducerFrom: 5,
      missingProducerTo: 3,
    }),
    false,
  )
})

test('isAgentTextStreamDelivery accepts a reset', () => {
  assert.equal(
    isAgentTextStreamDelivery({
      type: 'reset',
      channelId: 'channel-1',
      requestedFromCursor: 50,
      retainedFromCursor: 100,
      reason: 'evicted',
    }),
    true,
  )
})

test('isAgentTextStreamDelivery rejects a reset carrying a cursor', () => {
  assert.equal(
    isAgentTextStreamDelivery({
      type: 'reset',
      channelId: 'channel-1',
      requestedFromCursor: 50,
      retainedFromCursor: 100,
      reason: 'evicted',
      cursor: 100,
    }),
    false,
  )
})

test('isAgentTextStreamDelivery rejects an unknown frame type', () => {
  assert.equal(
    isAgentTextStreamDelivery({ type: 'heartbeat', channelId: 'c', cursor: 1 }),
    false,
  )
})

// ─── Selection frames ───────────────────────────────────────────────────────
//
// A default-use notice has to reach the user before the first token, and this
// per-turn channel is the only live one a chat turn opens. The frame is a
// preview like every other frame here: the durable record on the turn is the
// authority, so losing this one costs the live notice and nothing else.

test('isAgentTextStreamInput accepts a selection frame', () => {
  assert.equal(
    isAgentTextStreamInput({
      type: 'selection',
      replyId: 'speaker-a:0',
      speaker: 'Reviewer',
      selection: {
        provider: 'connection:abc',
        model: 'gpt-5.4-mini',
        source: 'app-default',
        reason: 'agent-default',
        caller: 'agent',
      },
    }),
    true,
  )
})

test('isAgentTextStreamInput rejects a selection whose record is unreadable', () => {
  // Half a record would render a notice naming something no execution
  // recorded, which is worse than showing no live notice at all.
  for (const selection of [
    { provider: 'connection:abc', model: 'gpt-5.4-mini', source: 'team', reason: 'agent-default', caller: 'agent' },
    { provider: 'connection:abc', source: 'app-default', reason: 'agent-default', caller: 'agent' },
    { provider: 'connection:abc', model: 'gpt-5.4-mini', source: 'app-default', reason: 'agent-default' },
    'not-a-record',
    null,
  ]) {
    assert.equal(
      isAgentTextStreamInput({
        type: 'selection',
        replyId: 'speaker-a:0',
        speaker: 'Reviewer',
        selection,
      }),
      false,
      JSON.stringify(selection),
    )
  }
})

test('isAgentTextStreamInput rejects a selection carrying text', () => {
  assert.equal(
    isAgentTextStreamInput({
      type: 'selection',
      replyId: 'speaker-a:0',
      speaker: 'Reviewer',
      selection: {
        provider: 'connection:abc',
        model: 'gpt-5.4-mini',
        source: 'app-default',
        reason: 'agent-default',
        caller: 'agent',
      },
      text: 'Hello',
    }),
    false,
  )
})

test('isAgentTextStreamDelivery accepts a selection carrying channelId and cursor', () => {
  assert.equal(
    isAgentTextStreamDelivery({
      type: 'selection',
      replyId: 'speaker-a:0',
      speaker: 'Reviewer',
      selection: {
        provider: 'connection:abc',
        model: 'gpt-5.4-mini',
        source: 'app-default',
        reason: 'agent-default',
        caller: 'agent',
      },
      channelId: 'turn-1',
      cursor: 0,
    }),
    true,
  )
})
