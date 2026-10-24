/**
 * The critical section the shape amendment depends on.
 *
 * It is tested here, at its own boundary, rather than through the endpoint.
 * The endpoint reads a plan, compares its revision and writes a new one across
 * two awaits; a test that forced two of those handlers to overlap would have
 * to get the second inside the critical section, which is precisely what a
 * correct lock prevents. Such a test deadlocks when the code is right and
 * passes when it is wrong, so it proves the opposite of what it claims.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { ResourceArchitectStore } from '../../server/resource-architect-store.js'

/** A promise plus the handle that settles it, so tests need no timers. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

test('a second operation on one plan does not start until the first has finished', async () => {
  const store = new ResourceArchitectStore()
  const order: string[] = []
  const firstStarted = deferred()
  const releaseFirst = deferred()

  const first = store.withPlanLock('plan-a', async () => {
    order.push('first:start')
    firstStarted.resolve()
    await releaseFirst.promise
    order.push('first:end')
  })

  await firstStarted.promise
  const second = store.withPlanLock('plan-a', async () => {
    order.push('second:start')
  })

  // The first is parked mid-operation. Nothing else may have begun.
  assert.deepEqual(order, ['first:start'])

  releaseFirst.resolve()
  await Promise.all([first, second])
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start'])
})

// A bounded timeout, because the failure this catches is a stall rather than a
// wrong answer: a lock that is global instead of per plan never lets plan-b
// run, and an unbounded await would hang the suite instead of reporting.
test('a different plan is not held behind the first', { timeout: 5_000 }, async () => {
  const store = new ResourceArchitectStore()
  const order: string[] = []
  const firstStarted = deferred()
  const releaseFirst = deferred()

  const first = store.withPlanLock('plan-a', async () => {
    firstStarted.resolve()
    await releaseFirst.promise
    order.push('a')
  })
  await firstStarted.promise

  // One user amending their plan must not stall everyone else's.
  await store.withPlanLock('plan-b', async () => {
    order.push('b')
  })
  assert.deepEqual(order, ['b'])

  releaseFirst.resolve()
  await first
  assert.deepEqual(order, ['b', 'a'])
})

test('a failed operation releases the plan instead of wedging it', async () => {
  const store = new ResourceArchitectStore()

  await assert.rejects(
    store.withPlanLock('plan-a', async () => {
      throw new Error('the store was unavailable')
    }),
    /the store was unavailable/,
  )

  // A refused amendment is ordinary. If it kept the lock, that plan could
  // never be changed again for the life of the process.
  const ran = await store.withPlanLock('plan-a', async () => 'ran')
  assert.equal(ran, 'ran')
})

test('the value and the failure both reach the caller that asked for them', async () => {
  const store = new ResourceArchitectStore()
  const [value, failure] = await Promise.allSettled([
    store.withPlanLock('plan-a', async () => 'first'),
    store.withPlanLock('plan-a', async () => {
      throw new Error('second failed')
    }),
  ])
  assert.deepEqual(value, { status: 'fulfilled', value: 'first' })
  assert.equal(failure.status, 'rejected')

  // And one failure does not reject the operations queued behind it.
  const third = await store.withPlanLock('plan-a', async () => 'third')
  assert.equal(third, 'third')
})
