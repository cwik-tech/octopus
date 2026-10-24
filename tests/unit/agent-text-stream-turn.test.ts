/**
 * A turn's ownership of a display channel, and what it may publish there.
 *
 * The disclosure is about the model, not about the reply. A proposal answers
 * with a card rather than prose, so it must not stream its JSON envelope — but
 * it uses a model exactly as a conversation does, and a person watching it work
 * is owed the same notice while it works.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { AgentTextStreamHub } from '../../domains/runtime/agent-text-stream-hub.js'
import { openTurnTextStream } from '../../domains/runtime/agent-text-stream-turn.js'
import type { AgentTextStreamFrame } from '../../contracts/agent-text-stream.js'

const SELECTION = {
  provider: 'connection:abc',
  model: 'gpt-5.6-sol',
  source: 'app-default',
  reason: 'agent-default',
  caller: 'authoring',
} as const

function makeHub(): AgentTextStreamHub {
  return new AgentTextStreamHub({
    ringCapacity: 64,
    closedRetentionMs: 60_000,
    now: () => 1_000,
  })
}

function framesOf(hub: AgentTextStreamHub, channelId: string): readonly AgentTextStreamFrame[] {
  return hub.read(channelId, 0)?.frames ?? []
}

test('a turn that answers with a card still discloses its model', () => {
  const hub = makeHub()
  const stream = openTurnTextStream({
    hub,
    channelId: 'proposal-turn',
    ownerId: 'create:resource-architect',
    streaming: false,
  })

  stream.publishSelection('Agent Architect', SELECTION)

  // No text channel at all: streaming a proposal's envelope would put raw
  // machinery on screen. The disclosure is not text and travels regardless.
  assert.equal(stream.onTextDelta, undefined)
  const frames = framesOf(hub, 'proposal-turn')
  assert.equal(frames.length, 1)
  assert.equal(frames[0]?.type, 'selection')
  assert.deepEqual(
    frames[0]?.type === 'selection' ? frames[0].selection : undefined,
    SELECTION,
  )
})

test('a streaming turn publishes its disclosure before any token', () => {
  const hub = makeHub()
  const stream = openTurnTextStream({
    hub,
    channelId: 'conversation-turn',
    ownerId: 'create:resource-architect',
    streaming: true,
  })

  stream.publishSelection('Agent Architect', SELECTION)
  stream.onTextDelta?.('First token.')

  const frames = framesOf(hub, 'conversation-turn')
  assert.deepEqual(
    frames.map((frame) => frame.type),
    ['selection', 'delta'],
    'the notice is on the wire before the answer starts',
  )
})

test('a turn with no hub publishes nothing and still runs', () => {
  const stream = openTurnTextStream({
    channelId: 'no-hub-turn',
    ownerId: 'create:resource-architect',
    streaming: true,
  })

  // A turn whose channel could not be opened shows no preview. It must not
  // throw: the preview is optional and the turn's own response is authority.
  stream.publishSelection('Agent Architect', SELECTION)
  stream.close('completed')
  assert.equal(stream.onTextDelta, undefined)
})
