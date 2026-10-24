/**
 * The Team runtime's one connection back to the parent.
 *
 * Every dispatch in a run shares a single sender — one channel, one bounded
 * queue, one request in flight — while each dispatch gets its own bubble
 * inside it. A run that was never granted a channel has no sender at all,
 * rather than a disabled one, so a workflow run cannot accidentally acquire
 * one later.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_TEXT_STREAM_CHANNEL_ENV,
  AGENT_TEXT_STREAM_TOKEN_ENV,
  AGENT_TEXT_STREAM_URL_ENV,
} from '../../domains/runtime/agent-text-delta-tokens.js'
import { createRunTextStreamFromEnvironment } from '../../domains/runtime/agent-text-run-stream.js'

const GRANT = {
  [AGENT_TEXT_STREAM_URL_ENV]: 'http://127.0.0.1:4321/internal/agent-text-stream',
  [AGENT_TEXT_STREAM_CHANNEL_ENV]: '11111111-2222-4333-8444-555555555555',
  [AGENT_TEXT_STREAM_TOKEN_ENV]: 'a-working-credential',
}

function recordingSend() {
  const bodies: Array<{ channelId?: string; frames?: Array<Record<string, unknown>> }> = []
  return {
    bodies,
    send: async (_url: string, init: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(String(init.body ?? '{}')))
      return new Response(null, { status: 202 })
    },
  }
}

test('a granted run sends each dispatch under its own reply id', async () => {
  const transport = recordingSend()
  const stream = createRunTextStreamFromEnvironment(GRANT, {
    send: transport.send,
    flushIntervalMs: 0,
  })

  const first = stream.sinkFor('invocation#1#line-one')
  const second = stream.sinkFor('invocation#1#line-two')
  assert.ok(first)
  assert.ok(second)
  first.onProtocolEvent({ kind: 'text', provider: 'openai', text: 'from one' })
  second.onProtocolEvent({ kind: 'text', provider: 'openai', text: 'from two' })
  await stream.close()

  const frames = transport.bodies.flatMap((body) => body.frames ?? [])
  assert.deepEqual(
    frames.map((frame) => [frame.replyId, frame.text]),
    [
      ['invocation#1#line-one', 'from one'],
      ['invocation#1#line-two', 'from two'],
    ],
  )
  // One channel for the whole run: the bubbles differ, the channel does not.
  for (const body of transport.bodies) {
    assert.equal(body.channelId, GRANT[AGENT_TEXT_STREAM_CHANNEL_ENV])
  }
})

test('an ungranted run has no sink and never opens a connection', async () => {
  const transport = recordingSend()
  const stream = createRunTextStreamFromEnvironment(
    { PATH: '/usr/bin' },
    { send: transport.send, flushIntervalMs: 0 },
  )

  assert.equal(stream.sinkFor('dispatch-1'), undefined)
  await stream.close()
  assert.deepEqual(transport.bodies, [])
})

test('asking twice for the same dispatch gives the same bubble', () => {
  const transport = recordingSend()
  const stream = createRunTextStreamFromEnvironment(GRANT, {
    send: transport.send,
    flushIntervalMs: 0,
  })

  // A retry mints a new dispatch id, so the same id always means the same
  // attempt — and therefore the same bubble and the same sequence.
  assert.equal(stream.sinkFor('dispatch-1'), stream.sinkFor('dispatch-1'))
})
