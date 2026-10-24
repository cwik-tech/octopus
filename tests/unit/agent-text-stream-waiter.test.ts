import test from 'node:test'
import assert from 'node:assert/strict'

import { AgentTextStreamHub } from '../../domains/runtime/agent-text-stream-hub.js'

/**
 * A controllable scheduler, so a bounded timeout can be proved without waiting
 * for real time to pass.
 */
function fakeScheduler() {
  const pending = new Map<number, () => void>()
  let nextId = 1
  return {
    schedule(callback: () => void, _delayMs: number): () => void {
      const id = nextId
      nextId += 1
      pending.set(id, callback)
      return () => {
        pending.delete(id)
      }
    },
    fireAll(): void {
      const callbacks = [...pending.values()]
      pending.clear()
      for (const callback of callbacks) callback()
    },
    get size(): number {
      return pending.size
    },
  }
}

function makeHub(overrides: {
  maxPendingWaiters?: number
  scheduler?: ReturnType<typeof fakeScheduler>
} = {}) {
  const scheduler = overrides.scheduler ?? fakeScheduler()
  const hub = new AgentTextStreamHub({
    now: () => 1_000,
    maxPendingWaiters: overrides.maxPendingWaiters ?? 8,
    scheduleTimeout: (callback, delayMs) => scheduler.schedule(callback, delayMs),
  })
  return { hub, scheduler }
}

test('a waiter resolves as opened when the matching channel is opened', async () => {
  const { hub } = makeHub()
  const waiting = hub.waitForChannel('c1', 'session-a', { timeoutMs: 5_000 })
  hub.openChannel('c1', 'session-a')
  assert.equal(await waiting, 'opened')
})

test('a waiter never creates the channel it waits for', async () => {
  const { hub, scheduler } = makeHub()
  const waiting = hub.waitForChannel('c1', 'session-a', { timeoutMs: 5_000 })

  assert.equal(hub.read('c1', 0), undefined, 'waiting alone opens nothing')
  assert.equal(hub.ownerOf('c1'), undefined)

  scheduler.fireAll()
  assert.equal(await waiting, 'timeout')
  assert.equal(hub.read('c1', 0), undefined, 'and it leaves nothing behind')
})

test('a channel opened by a different session does not satisfy the waiter', async () => {
  const { hub, scheduler } = makeHub()
  const waiting = hub.waitForChannel('c1', 'session-a', { timeoutMs: 5_000 })

  hub.openChannel('c1', 'session-b')
  scheduler.fireAll()
  assert.equal(
    await waiting,
    'timeout',
    'ownership is part of the match, so another session cannot release it',
  )
})

test('a waiter resolves as timeout when its bounded deadline fires', async () => {
  const { hub, scheduler } = makeHub()
  const waiting = hub.waitForChannel('c1', 'session-a', { timeoutMs: 5_000 })
  assert.equal(scheduler.size, 1, 'the deadline is armed, not open-ended')
  scheduler.fireAll()
  assert.equal(await waiting, 'timeout')
})

test('a waiter resolves as aborted when its request closes', async () => {
  const { hub } = makeHub()
  const controller = new AbortController()
  const waiting = hub.waitForChannel('c1', 'session-a', {
    timeoutMs: 5_000,
    signal: controller.signal,
  })
  controller.abort()
  assert.equal(await waiting, 'aborted')
})

test('an already-aborted signal resolves immediately without registering', async () => {
  const { hub, scheduler } = makeHub()
  const controller = new AbortController()
  controller.abort()
  const result = await hub.waitForChannel('c1', 'session-a', {
    timeoutMs: 5_000,
    signal: controller.signal,
  })
  assert.equal(result, 'aborted')
  assert.equal(scheduler.size, 0, 'no timer was armed')
  assert.equal(hub.pendingWaiterCount, 0)
})

test('a settled waiter releases its slot and cancels its timer', async () => {
  const { hub, scheduler } = makeHub()
  const waiting = hub.waitForChannel('c1', 'session-a', { timeoutMs: 5_000 })
  assert.equal(hub.pendingWaiterCount, 1)

  hub.openChannel('c1', 'session-a')
  assert.equal(await waiting, 'opened')
  assert.equal(hub.pendingWaiterCount, 0, 'the slot is freed')
  assert.equal(scheduler.size, 0, 'and the deadline is disarmed')
})

test('only one waiter per session and channel is admitted', async () => {
  const { hub } = makeHub()
  const first = hub.waitForChannel('c1', 'session-a', { timeoutMs: 5_000 })
  const second = await hub.waitForChannel('c1', 'session-a', { timeoutMs: 5_000 })

  assert.equal(second, 'rejected', 'a duplicate waiter is refused, not queued')
  hub.openChannel('c1', 'session-a')
  assert.equal(await first, 'opened', 'the original waiter is unaffected')
})

test('the same channel id may be awaited by a different session independently', async () => {
  const { hub } = makeHub()
  const a = hub.waitForChannel('c1', 'session-a', { timeoutMs: 5_000 })
  assert.equal(hub.pendingWaiterCount, 1)
  const b = hub.waitForChannel('c1', 'session-b', { timeoutMs: 5_000 })
  assert.equal(hub.pendingWaiterCount, 2)

  hub.openChannel('c1', 'session-a')
  assert.equal(await a, 'opened')
  void b
})

test('pending waiters are globally bounded so idle GETs cannot grow memory', async () => {
  const { hub } = makeHub({ maxPendingWaiters: 3 })
  const admitted = [
    hub.waitForChannel('c1', 'session-a', { timeoutMs: 5_000 }),
    hub.waitForChannel('c2', 'session-a', { timeoutMs: 5_000 }),
    hub.waitForChannel('c3', 'session-a', { timeoutMs: 5_000 }),
  ]
  assert.equal(hub.pendingWaiterCount, 3)

  const overflow = await hub.waitForChannel('c4', 'session-a', { timeoutMs: 5_000 })
  assert.equal(overflow, 'rejected', 'past capacity a waiter is refused outright')
  assert.equal(hub.pendingWaiterCount, 3, 'and the count does not grow')

  hub.openChannel('c1', 'session-a')
  assert.equal(await admitted[0], 'opened')
  assert.equal(hub.pendingWaiterCount, 2, 'capacity is returned when one settles')
  void admitted
})

test('closing a channel does not resolve a waiter for a channel never opened', async () => {
  const { hub, scheduler } = makeHub()
  hub.openChannel('other', 'session-a')
  const waiting = hub.waitForChannel('c1', 'session-a', { timeoutMs: 5_000 })
  hub.closeChannel('other')
  scheduler.fireAll()
  assert.equal(await waiting, 'timeout')
})
