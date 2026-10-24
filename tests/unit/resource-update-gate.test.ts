/**
 * The provider budget an update job shares must be cancellable.
 *
 * A cancelled job cannot be left queued behind capacity another operation is
 * holding: the waiter has to be rejected and removed, and it must never hand
 * back a permit it never took.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createResourceUpdateGate } from '../../services/resource-update-gate.js'

test('an acquire within the budget resolves immediately', async () => {
  const gate = createResourceUpdateGate(1)

  await gate.acquire()

  gate.release()
})

test('an acquire with an already-aborted signal is refused without taking a permit', async () => {
  const gate = createResourceUpdateGate(1)
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(gate.acquire(controller.signal), { name: 'AbortError' })

  // The permit was never taken, so the budget is still fully available.
  await gate.acquire()
  gate.release()
})

test('a queued waiter that is cancelled rejects and leaves the queue', async () => {
  const gate = createResourceUpdateGate(1)
  await gate.acquire()
  const controller = new AbortController()
  const queued = gate.acquire(controller.signal)
  const settled: string[] = []
  const queuedOutcome = queued.then(
    () => settled.push('resolved'),
    (error: unknown) => settled.push((error as Error).name),
  )

  controller.abort()
  await queuedOutcome

  assert.deepEqual(settled, ['AbortError'])
})

test('releasing a permit hands it to a waiter that is still waiting, not a cancelled one', async () => {
  const gate = createResourceUpdateGate(1)
  await gate.acquire()
  const cancelled = new AbortController()
  const abandoned = gate.acquire(cancelled.signal).catch(() => 'abandoned')
  let survivorAcquired = false
  const survivor = gate.acquire().then(() => {
    survivorAcquired = true
  })

  cancelled.abort()
  await abandoned
  assert.equal(survivorAcquired, false, 'the survivor waits until a permit is freed')

  gate.release()
  await survivor

  assert.equal(survivorAcquired, true)
})

test('a cancelled waiter never frees a permit it did not hold', async () => {
  const gate = createResourceUpdateGate(1)
  await gate.acquire()
  const controller = new AbortController()
  const queued = gate.acquire(controller.signal).catch(() => undefined)
  controller.abort()
  await queued

  // Only one permit exists and it is still held, so a fresh acquire must wait.
  let admitted = false
  const pending = gate.acquire().then(() => {
    admitted = true
  })
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(
    admitted,
    false,
    'a cancelled waiter must not have released the holder’s permit',
  )

  gate.release()
  await pending
  assert.equal(admitted, true)
})
