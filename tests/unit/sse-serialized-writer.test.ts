import test from 'node:test'
import assert from 'node:assert/strict'

import { createSerializedSseWriter } from '../../domains/runtime/sse-serialized-writer.js'

interface Deferred {
  readonly promise: Promise<void>
  readonly settle: () => void
}

function deferred(): Deferred {
  let settle: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    settle = resolve
  })
  return { promise, settle }
}

/**
 * The exact interleaving the review named.
 *
 * A heartbeat is not pump-owned, so a flag on the pump cannot protect against
 * this: the heartbeat goes out while the pump is idle, becomes backpressured,
 * and a publish then asks the pump to write a frame before the heartbeat has
 * drained. Only one writer owning every byte can order these.
 */
test('a frame queued during a backpressured heartbeat does not start until the heartbeat drains', async () => {
  const started: string[] = []
  const pending = deferred()
  const writer = createSerializedSseWriter(async (payload: string) => {
    started.push(payload)
    if (payload === 'heartbeat') await pending.promise
  })

  // Idle. The heartbeat goes out and becomes backpressured.
  const heartbeat = writer.write('heartbeat')
  await Promise.resolve()
  assert.deepEqual(started, ['heartbeat'])

  // A publish asks for a frame before the heartbeat has drained.
  const frame = writer.write('frame')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(
    started,
    ['heartbeat'],
    'the frame write must not begin while the heartbeat is still draining',
  )

  pending.settle()
  await heartbeat
  await frame
  assert.deepEqual(started, ['heartbeat', 'frame'], 'and it runs after, in order')
})

test('the connected prelude is serialized ahead of the first frame', async () => {
  const started: string[] = []
  const pending = deferred()
  const writer = createSerializedSseWriter(async (payload: string) => {
    started.push(payload)
    if (payload === 'connected') await pending.promise
  })

  const connected = writer.write('connected')
  const frame = writer.write('frame')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(
    started,
    ['connected'],
    'the prelude can be backpressured too, and must still precede frames',
  )

  pending.settle()
  await connected
  await frame
  assert.deepEqual(started, ['connected', 'frame'])
})

test('writes run in submission order under sustained backpressure', async () => {
  const started: string[] = []
  const gates = [deferred(), deferred(), deferred()]
  let index = 0
  const writer = createSerializedSseWriter(async (payload: string) => {
    started.push(payload)
    const gate = gates[index]
    index += 1
    if (gate) await gate.promise
  })

  const all = [writer.write('a'), writer.write('b'), writer.write('c')]
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['a'])

  gates[0]?.settle()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['a', 'b'])

  gates[1]?.settle()
  gates[2]?.settle()
  await Promise.all(all)
  assert.deepEqual(started, ['a', 'b', 'c'])
})

test('a rejected write does not stall the queue for later writes', async () => {
  const started: string[] = []
  const writer = createSerializedSseWriter(async (payload: string) => {
    started.push(payload)
    if (payload === 'bad') throw new Error('socket closed')
  })

  await assert.rejects(writer.write('bad'))
  await writer.write('after')
  assert.deepEqual(started, ['bad', 'after'])
})

test('the writer reports whether anything is in flight', async () => {
  const pending = deferred()
  const writer = createSerializedSseWriter(async () => {
    await pending.promise
  })

  assert.equal(writer.idle, true)
  const inFlight = writer.write('x')
  await Promise.resolve()
  assert.equal(writer.idle, false, 'a heartbeat may skip itself while busy')

  pending.settle()
  await inFlight
  assert.equal(writer.idle, true)
})
