import test from 'node:test'
import assert from 'node:assert/strict'

import { AgentTextStreamHub } from '../../domains/runtime/agent-text-stream-hub.js'
import { startAgentTextStreamPump } from '../../domains/runtime/agent-text-stream-pump.js'
import type { AgentTextStreamDelivery } from '../../contracts/agent-text-stream.js'

function delta(replyId: string, text: string) {
  return { type: 'delta' as const, replyId, channel: 'text' as const, text }
}

const RING_CAPACITY = 16

/**
 * Act (a): a connection whose first write never settles.
 *
 * The pump writes one frame at a time, so this connection can never emit a
 * later frame. What must be proved is that it cannot harm anything else: the
 * ring stays at its cap, `publish` keeps returning, the producer finishes, and
 * exactly one write is outstanding. Nothing is asserted about this connection
 * receiving anything further, because it cannot.
 */
test('a never-settling write leaves the ring bounded and the producer unaffected', async () => {
  const hub = new AgentTextStreamHub({
    ringCapacity: RING_CAPACITY,
    now: () => 1_000,
  })
  hub.openChannel('c1')

  let writesStarted = 0
  let writesSettled = 0
  const pump = startAgentTextStreamPump({
    hub,
    channelId: 'c1',
    fromCursor: 0,
    write: async () => {
      writesStarted += 1
      await new Promise<void>(() => {
        // Never resolves: models a socket that never drains.
      })
    },
  })

  // The producer runs far past the ring capacity while the pump is wedged.
  const cursors: number[] = []
  for (let index = 0; index < RING_CAPACITY * 10; index += 1) {
    cursors.push(hub.publish('c1', delta('a:0', `t${index}`)))
  }

  // Let any microtasks the pump scheduled run.
  await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(
    cursors.every((cursor, index) => cursor === index),
    true,
    'publish kept assigning cursors and never blocked',
  )

  const page = hub.read('c1', 0)
  assert.ok(page)
  assert.equal(page.frames.length, RING_CAPACITY, 'the ring stayed at its cap')
  assert.equal(page.nextCursor, RING_CAPACITY * 10)

  assert.equal(writesStarted, 1, 'exactly one write was ever outstanding')
  assert.equal(writesSettled, 0)

  pump.stop()
})

test('a never-settling write does not stop the turn from completing', async () => {
  const hub = new AgentTextStreamHub({
    ringCapacity: RING_CAPACITY,
    now: () => 1_000,
  })
  hub.openChannel('c1')

  const pump = startAgentTextStreamPump({
    hub,
    channelId: 'c1',
    fromCursor: 0,
    write: async () => {
      await new Promise<void>(() => {})
    },
  })

  // A whole simulated turn: deltas, then a terminal frame, then close.
  for (let index = 0; index < 50; index += 1) {
    hub.publish('c1', delta('a:0', `t${index}`))
  }
  const finalCursor = hub.publish('c1', {
    type: 'final',
    replyId: 'a:0',
    reason: 'completed',
  })
  hub.closeChannel('c1')

  assert.equal(finalCursor, 50, 'the terminal frame was accepted')
  assert.equal(hub.isOpen('c1'), false, 'the turn closed its channel normally')

  pump.stop()
})

/**
 * Act (b): the reset is what the NEXT connection receives.
 *
 * After the stalled connection is abandoned, a client reconnecting from its
 * stale cursor finds that position evicted and gets the `reset` prelude.
 */
test('a reconnecting connection receives reset with no id, then the retained frames', async () => {
  const hub = new AgentTextStreamHub({
    ringCapacity: RING_CAPACITY,
    now: () => 1_000,
  })
  hub.openChannel('c1')

  const stalled = startAgentTextStreamPump({
    hub,
    channelId: 'c1',
    fromCursor: 0,
    write: async () => {
      await new Promise<void>(() => {})
    },
  })

  for (let index = 0; index < RING_CAPACITY * 4; index += 1) {
    hub.publish('c1', delta('a:0', `t${index}`))
  }

  // Abort the stalled connection, exactly as a closed socket would.
  stalled.stop()
  await new Promise((resolve) => setImmediate(resolve))

  const written: Array<{ delivery: AgentTextStreamDelivery; id: number | undefined }> = []
  const reconnected = startAgentTextStreamPump({
    hub,
    channelId: 'c1',
    fromCursor: 0, // the stale cursor the abandoned connection still held
    write: async (delivery, id) => {
      written.push({ delivery, id })
    },
  })
  hub.closeChannel('c1')
  await reconnected.done

  const first = written[0]
  assert.ok(first)
  assert.equal(first.delivery.type, 'reset')
  assert.equal(first.id, undefined)
  if (first.delivery.type === 'reset') {
    assert.equal(first.delivery.requestedFromCursor, 0)
    assert.equal(
      first.delivery.retainedFromCursor,
      RING_CAPACITY * 4 - RING_CAPACITY,
    )
  }

  const ids = written
    .map((entry) => entry.id)
    .filter((id): id is number => id !== undefined)
  assert.equal(ids.length, RING_CAPACITY)
  for (let index = 1; index < ids.length; index += 1) {
    assert.ok((ids[index] ?? 0) > (ids[index - 1] ?? 0))
  }
})

test('the pump reports whether a write is outstanding, so nothing else may write', async () => {
  const hub = new AgentTextStreamHub({ ringCapacity: 64, now: () => 1_000 })
  hub.openChannel('c1')

  let settle: () => void = () => {}
  const pump = startAgentTextStreamPump({
    hub,
    channelId: 'c1',
    fromCursor: 0,
    write: async () => {
      await new Promise<void>((resolve) => {
        settle = resolve
      })
    },
  })

  assert.equal(pump.busy, false, 'idle before anything is published')

  hub.publish('c1', delta('a:0', 'one'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    pump.busy,
    true,
    'a write is outstanding — a heartbeat written now would interleave with it',
  )

  settle()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(pump.busy, false, 'idle again once the write settles')

  pump.stop()
})

test('a stopped pump is never reported busy', async () => {
  const hub = new AgentTextStreamHub({ ringCapacity: 64, now: () => 1_000 })
  hub.openChannel('c1')
  const pump = startAgentTextStreamPump({
    hub,
    channelId: 'c1',
    fromCursor: 0,
    write: async () => {
      await new Promise<void>(() => {})
    },
  })
  hub.publish('c1', delta('a:0', 'one'))
  await new Promise((resolve) => setImmediate(resolve))
  pump.stop()
  assert.equal(pump.busy, false)
})

test('stopping a pump releases its subscription so it stops being notified', async () => {
  const hub = new AgentTextStreamHub({ ringCapacity: 64, now: () => 1_000 })
  hub.openChannel('c1')

  let writes = 0
  const pump = startAgentTextStreamPump({
    hub,
    channelId: 'c1',
    fromCursor: 0,
    write: async () => {
      writes += 1
    },
  })

  hub.publish('c1', delta('a:0', 'one'))
  await new Promise((resolve) => setImmediate(resolve))
  const afterFirst = writes

  pump.stop()
  hub.publish('c1', delta('a:0', 'two'))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(writes, afterFirst, 'no write happened after stop')
})

test('a write that rejects stops the pump rather than looping', async () => {
  const hub = new AgentTextStreamHub({ ringCapacity: 64, now: () => 1_000 })
  hub.openChannel('c1')

  let writes = 0
  const pump = startAgentTextStreamPump({
    hub,
    channelId: 'c1',
    fromCursor: 0,
    write: async () => {
      writes += 1
      throw new Error('socket closed')
    },
  })

  hub.publish('c1', delta('a:0', 'one'))
  await pump.done

  hub.publish('c1', delta('a:0', 'two'))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(writes, 1)
  assert.equal(pump.stopped, true)
})
