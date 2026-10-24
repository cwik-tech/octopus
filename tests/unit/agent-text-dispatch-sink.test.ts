/**
 * Turning one dispatch's provider events into frames.
 *
 * Each concrete attempt owns one bubble, so the sink is per dispatch: it
 * stamps every frame with that attempt's id and its own running sequence, and
 * closes exactly once. The sequence is what lets the hub notice a hole and
 * report a `gap` rather than splicing text across it, so it has to advance
 * per frame and never restart mid-answer.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentTextDispatchSink } from '../../domains/runtime/agent-text-dispatch-sink.js'
import type { AgentTextStreamInput } from '../../contracts/agent-text-stream.js'

function createRecordingSender() {
  const frames: AgentTextStreamInput[] = []
  let flushes = 0
  return {
    frames,
    flushes: () => flushes,
    sender: {
      send: (frame: AgentTextStreamInput) => frames.push(frame),
      flush: async () => {
        flushes += 1
      },
      close: async () => {},
    },
  }
}

test('answer text becomes deltas stamped with the dispatch and an advancing sequence', () => {
  const recorder = createRecordingSender()
  const sink = createAgentTextDispatchSink({
    sender: recorder.sender,
    dispatchId: 'invocation#1#line-one',
  })

  sink.onProtocolEvent({ kind: 'text', provider: 'openai', text: 'Kestrel' })
  sink.onProtocolEvent({ kind: 'text', provider: 'openai', text: ' and Marlin' })

  assert.deepEqual(recorder.frames, [
    {
      type: 'delta',
      replyId: 'invocation#1#line-one',
      channel: 'text',
      text: 'Kestrel',
      producerSequence: 0,
    },
    {
      type: 'delta',
      replyId: 'invocation#1#line-one',
      channel: 'text',
      text: ' and Marlin',
      producerSequence: 1,
    },
  ])
})

test('anything that is not committed answer text is left out', () => {
  const recorder = createRecordingSender()
  const sink = createAgentTextDispatchSink({
    sender: recorder.sender,
    dispatchId: 'dispatch-1',
  })

  sink.onProtocolEvent({ kind: 'reasoning', provider: 'openai', text: 'private' })
  sink.onProtocolEvent({ kind: 'tool_call', provider: 'openai', text: 'call' })
  sink.onProtocolEvent({ kind: 'lifecycle', provider: 'openai' })
  sink.onProtocolEvent({ kind: 'text', provider: 'openai', text: '' })

  assert.deepEqual(recorder.frames, [])
})

test('a dispatch closes its own bubble exactly once', () => {
  const recorder = createRecordingSender()
  const sink = createAgentTextDispatchSink({
    sender: recorder.sender,
    dispatchId: 'dispatch-1',
  })

  sink.onProtocolEvent({ kind: 'text', provider: 'openai', text: 'Kestrel' })
  sink.close('completed')
  sink.close('completed')

  assert.deepEqual(recorder.frames.slice(1), [
    {
      type: 'final',
      replyId: 'dispatch-1',
      reason: 'completed',
      producerSequence: 1,
    },
  ])
})

test('a failed dispatch closes as an error rather than as an answer', () => {
  const recorder = createRecordingSender()
  const sink = createAgentTextDispatchSink({
    sender: recorder.sender,
    dispatchId: 'dispatch-1',
  })

  sink.close('error')

  assert.equal(recorder.frames[0]?.type, 'error')
  assert.equal(recorder.frames[0]?.replyId, 'dispatch-1')
})

test('a waiting dispatch closes its stream without claiming completion or failure', () => {
  const recorder = createRecordingSender()
  const sink = createAgentTextDispatchSink({ sender: recorder.sender, dispatchId: 'waiting-writer' })
  sink.close('awaiting_input')
  assert.deepEqual(recorder.frames, [{
    type: 'final', replyId: 'waiting-writer', reason: 'awaiting_input', producerSequence: 0,
  }])
})

test('nothing is appended to a bubble that has already closed', () => {
  const recorder = createRecordingSender()
  const sink = createAgentTextDispatchSink({
    sender: recorder.sender,
    dispatchId: 'dispatch-1',
  })

  sink.close('completed')
  sink.onProtocolEvent({ kind: 'text', provider: 'openai', text: 'too late' })

  assert.equal(recorder.frames.length, 1)
})

test('a dispatch flush is the whole channel being drained, not just this bubble', async () => {
  const recorder = createRecordingSender()
  const sink = createAgentTextDispatchSink({
    sender: recorder.sender,
    dispatchId: 'invocation#1#line-one',
  })

  sink.onProtocolEvent({ kind: 'text', provider: 'openai', text: 'Kestrel' })
  sink.close('completed')
  await sink.flush()

  // The channel is shared, and delivery is per request rather than per reply,
  // so a barrier can only be stated against the sender.
  assert.equal(recorder.flushes(), 1)
})
