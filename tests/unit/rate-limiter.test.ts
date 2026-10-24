import { requiredValue } from '../../core/required-value.js'
/**
 * Unit tests for core/rate-limiter.ts
 *
 * 8 test cases covering:
 *   1. Semaphore allows up to N concurrent acquisitions
 *   2. Semaphore blocks acquisition N+1 until a release
 *   3. Semaphore release unblocks next queued waiter (FIFO order)
 *   4. Semaphore `active` and `pending` counts are accurate
 *   5. RateLimiter enforces inter-dispatch delay
 *   6. RateLimiter `run()` acquires before fn and releases after fn completes
 *   7. RateLimiter `run()` releases even when fn throws (finally block)
 *   8. RateLimiter with maxConcurrent=2 — dispatch 5 tasks, verify max 2 active at any point
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { ConcurrencySemaphore, RateLimiter } from '../../core/rate-limiter.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── ConcurrencySemaphore Tests ───────────────────────────────────────────────

test('Semaphore allows up to N concurrent acquisitions', async () => {
  const sem = new ConcurrencySemaphore(3)

  // All 3 acquisitions should resolve immediately
  await sem.acquire()
  await sem.acquire()
  await sem.acquire()

  assert.strictEqual(sem.active, 3)
  assert.strictEqual(sem.pending, 0)

  sem.release()
  sem.release()
  sem.release()
})

test('Semaphore blocks acquisition N+1 until a release', async () => {
  const sem = new ConcurrencySemaphore(2)

  await sem.acquire() // slot 1
  await sem.acquire() // slot 2

  let thirdResolved = false
  const thirdAcquire = sem.acquire().then(() => {
    thirdResolved = true
  })

  // Yield to the event loop — third acquire should NOT have resolved yet
  await sleep(10)
  assert.strictEqual(thirdResolved, false, 'third acquire should be blocked')
  assert.strictEqual(sem.pending, 1)

  // Release one slot — third should now unblock
  sem.release()
  await thirdAcquire

  assert.strictEqual(thirdResolved, true, 'third acquire should resolve after release')
  assert.strictEqual(sem.active, 2)
  assert.strictEqual(sem.pending, 0)

  sem.release()
  sem.release()
})

test('Semaphore release unblocks next queued waiter (FIFO order)', async () => {
  const sem = new ConcurrencySemaphore(1)

  await sem.acquire() // fills the single slot

  const order: number[] = []

  // Queue up waiters 1, 2, 3 in order
  const p1 = sem.acquire().then(() => { order.push(1) })
  const p2 = sem.acquire().then(() => { order.push(2) })
  const p3 = sem.acquire().then(() => { order.push(3) })

  // Release 1 → waiter 1 unblocks, then we release again, etc.
  sem.release() // unblocks waiter 1
  await p1
  sem.release() // unblocks waiter 2
  await p2
  sem.release() // unblocks waiter 3
  await p3

  assert.deepStrictEqual(order, [1, 2, 3], 'waiters should be unblocked in FIFO order')

  // Clean up the final slot
  sem.release()
})

test('Semaphore `active` and `pending` counts are accurate', async () => {
  const sem = new ConcurrencySemaphore(2)

  assert.strictEqual(sem.active, 0)
  assert.strictEqual(sem.pending, 0)

  await sem.acquire()
  assert.strictEqual(sem.active, 1)
  assert.strictEqual(sem.pending, 0)

  await sem.acquire()
  assert.strictEqual(sem.active, 2)
  assert.strictEqual(sem.pending, 0)

  // Queue a third waiter — should be pending
  const pendingAcquire = sem.acquire()
  // Allow microtasks to run
  await sleep(5)
  assert.strictEqual(sem.active, 2)
  assert.strictEqual(sem.pending, 1)

  // Release one slot
  sem.release()
  await pendingAcquire

  assert.strictEqual(sem.active, 2)
  assert.strictEqual(sem.pending, 0)

  sem.release()
  sem.release()

  assert.strictEqual(sem.active, 0)
  assert.strictEqual(sem.pending, 0)
})

test('Semaphore rejects release calls without an acquired slot', () => {
  const sem = new ConcurrencySemaphore(1)
  assert.throws(() => sem.release(), /without an acquired slot/)
})

// ─── RateLimiter Tests ────────────────────────────────────────────────────────

test('RateLimiter enforces inter-dispatch delay', async () => {
  const delayMs = 50
  const limiter = new RateLimiter({ maxConcurrent: 5, delayBetweenMs: delayMs })

  const times: number[] = []

  // Dispatch 3 sequential acquires (single slot means they run one at a time here,
  // but with maxConcurrent=5 they all get slots immediately — the delay between
  // dispatches is what we're testing)
  //
  // To test the delay in isolation, we acquire and release 3 times in sequence.
  for (let i = 0; i < 3; i++) {
    await limiter.acquire()
    times.push(Date.now())
    limiter.release()
  }

  // First acquire has no prior dispatch, so it's immediate.
  // Second acquire should wait ~delayMs after first.
  // Third acquire should wait ~delayMs after second.
  const gap1 = requiredValue(times[1], 'tests/unit/rate-limiter.test.ts:159') - requiredValue(times[0], 'tests/unit/rate-limiter.test.ts:159')
  const gap2 = requiredValue(times[2], 'tests/unit/rate-limiter.test.ts:160') - requiredValue(times[1], 'tests/unit/rate-limiter.test.ts:160')

  assert.ok(
    gap1 >= delayMs - 10,
    `gap between dispatch 1 and 2 should be >= ${delayMs - 10}ms, got ${gap1}ms`,
  )
  assert.ok(
    gap2 >= delayMs - 10,
    `gap between dispatch 2 and 3 should be >= ${delayMs - 10}ms, got ${gap2}ms`,
  )
})

test('RateLimiter run() acquires before fn and releases after fn completes', async () => {
  const limiter = new RateLimiter({ maxConcurrent: 1, delayBetweenMs: 0 })

  assert.strictEqual(limiter.active, 0)

  let activeInsideFn = -1
  await limiter.run(async () => {
    activeInsideFn = limiter.active
  })

  assert.strictEqual(activeInsideFn, 1, 'active should be 1 inside run fn')
  assert.strictEqual(limiter.active, 0, 'active should be 0 after run completes')
})

test('RateLimiter run() releases even when fn throws (finally block)', async () => {
  const limiter = new RateLimiter({ maxConcurrent: 1, delayBetweenMs: 0 })

  await assert.rejects(
    () => limiter.run(async () => {
      throw new Error('intentional error')
    }),
    /intentional error/,
  )

  assert.strictEqual(limiter.active, 0, 'slot should be released even after fn throws')
  assert.strictEqual(limiter.pending, 0)

  // Verify we can still acquire after the throw
  await limiter.run(async () => {
    assert.strictEqual(limiter.active, 1, 'should be able to acquire after a throw')
  })
  assert.strictEqual(limiter.active, 0)
})

test('RateLimiter with maxConcurrent=2 — dispatch 5 tasks, verify max 2 active at any point', async () => {
  const limiter = new RateLimiter({ maxConcurrent: 2, delayBetweenMs: 0 })

  let activeCount = 0
  let maxActive = 0

  const taskFn = async () => {
    activeCount++
    if (activeCount > maxActive) maxActive = activeCount
    await sleep(10)
    activeCount--
  }

  // Dispatch all 5 tasks simultaneously
  await Promise.all([
    limiter.run(taskFn),
    limiter.run(taskFn),
    limiter.run(taskFn),
    limiter.run(taskFn),
    limiter.run(taskFn),
  ])

  assert.ok(
    maxActive <= 2,
    `max concurrent active tasks should be <= 2, but was ${maxActive}`,
  )
  assert.strictEqual(activeCount, 0, 'all tasks should have completed')
  assert.strictEqual(limiter.active, 0)
  assert.strictEqual(limiter.pending, 0)
})
