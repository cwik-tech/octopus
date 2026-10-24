import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AgentTextStreamHub,
  PUBLISH_IGNORED,
} from '../../domains/runtime/agent-text-stream-hub.js'
import type { AgentTextStreamFrame } from '../../contracts/agent-text-stream.js'

function makeHub(overrides: {
  ringCapacity?: number
  closedRetentionMs?: number
  now?: () => number
} = {}): AgentTextStreamHub {
  return new AgentTextStreamHub({
    ringCapacity: overrides.ringCapacity ?? 64,
    closedRetentionMs: overrides.closedRetentionMs ?? 60_000,
    now: overrides.now ?? (() => 1_000),
  })
}

function delta(replyId: string, text: string, producerSequence?: number) {
  return {
    type: 'delta' as const,
    replyId,
    channel: 'text' as const,
    text,
    ...(producerSequence === undefined ? {} : { producerSequence }),
  }
}

// ─── Cursor assignment ──────────────────────────────────────────────────────

test('cursors start at zero and are channel-global across interleaved replies', () => {
  const hub = makeHub()
  hub.openChannel('c1')

  assert.equal(hub.publish('c1', delta('a:0', 'A1')), 0)
  assert.equal(hub.publish('c1', delta('b:1', 'B1')), 1)
  assert.equal(hub.publish('c1', delta('a:0', 'A2')), 2)
  assert.equal(hub.publish('c1', delta('b:1', 'B2')), 3)

  const page = hub.read('c1', 0)
  assert.ok(page)
  assert.deepEqual(
    page.frames.map((frame) => frame.cursor),
    [0, 1, 2, 3],
  )
  assert.equal(page.nextCursor, 4)
})

test('a channel-global cursor never restarts for a second reply', () => {
  const hub = makeHub()
  hub.openChannel('c1')
  hub.publish('c1', delta('a:0', 'first'))
  hub.publish('c1', { type: 'final', replyId: 'a:0', reason: 'completed' })

  // Second speaker begins. Its first frame must not reuse cursor 0.
  assert.equal(hub.publish('c1', delta('b:1', 'second')), 2)
})

// ─── Producer-sequence dedupe ───────────────────────────────────────────────

test('a repeated producerSequence is ignored and consumes no cursor', () => {
  const hub = makeHub()
  hub.openChannel('c1')

  assert.equal(hub.publish('c1', delta('a:0', 'one', 0)), 0)
  assert.equal(hub.publish('c1', delta('a:0', 'one', 0)), PUBLISH_IGNORED)
  assert.equal(hub.publish('c1', delta('a:0', 'two', 1)), 1)

  const page = hub.read('c1', 0)
  assert.ok(page)
  assert.equal(page.frames.length, 2)
})

test('a lower producerSequence is ignored as already seen', () => {
  const hub = makeHub()
  hub.openChannel('c1')
  hub.publish('c1', delta('a:0', 'one', 0))
  hub.publish('c1', delta('a:0', 'two', 1))

  assert.equal(hub.publish('c1', delta('a:0', 'stale', 0)), PUBLISH_IGNORED)
})

test('dedupe is per reply, so two replies may both start at sequence zero', () => {
  const hub = makeHub()
  hub.openChannel('c1')

  assert.equal(hub.publish('c1', delta('a:0', 'A', 0)), 0)
  assert.equal(hub.publish('c1', delta('b:1', 'B', 0)), 1)
})

test('frames without a producerSequence are never deduped', () => {
  const hub = makeHub()
  hub.openChannel('c1')

  assert.equal(hub.publish('c1', delta('a:0', 'same')), 0)
  assert.equal(hub.publish('c1', delta('a:0', 'same')), 1)
})

// ─── Gap on a producer-sequence jump ────────────────────────────────────────

test('a producerSequence jump emits a scoped gap naming the missing range', () => {
  const hub = makeHub()
  hub.openChannel('c1')
  hub.publish('c1', delta('a:0', 'one', 0))

  // 1 and 2 never arrived.
  const cursor = hub.publish('c1', delta('a:0', 'four', 3))

  const page = hub.read('c1', 0)
  assert.ok(page)
  const gap = page.frames.find(
    (frame): frame is Extract<AgentTextStreamFrame, { type: 'gap' }> =>
      frame.type === 'gap',
  )
  assert.ok(gap, 'expected a gap frame')
  assert.equal(gap.replyId, 'a:0')
  assert.equal(gap.missingProducerFrom, 1)
  assert.equal(gap.missingProducerTo, 2)
  // The gap precedes the frame that revealed it.
  assert.ok(gap.cursor < cursor)
})

test('the gap is scoped to the reply that jumped, leaving others untouched', () => {
  const hub = makeHub()
  hub.openChannel('c1')
  hub.publish('c1', delta('a:0', 'a-one', 0))
  hub.publish('c1', delta('b:1', 'b-one', 0))
  hub.publish('c1', delta('a:0', 'a-jumped', 5))

  const page = hub.read('c1', 0)
  assert.ok(page)
  const gaps = page.frames.filter((frame) => frame.type === 'gap')
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0]?.type === 'gap' ? gaps[0].replyId : undefined, 'a:0')
})

test('a contiguous producerSequence emits no gap', () => {
  const hub = makeHub()
  hub.openChannel('c1')
  hub.publish('c1', delta('a:0', 'one', 0))
  hub.publish('c1', delta('a:0', 'two', 1))
  hub.publish('c1', delta('a:0', 'three', 2))

  const page = hub.read('c1', 0)
  assert.ok(page)
  assert.equal(
    page.frames.filter((frame) => frame.type === 'gap').length,
    0,
  )
})

// ─── Channel lifecycle ──────────────────────────────────────────────────────

test('opening the same channel twice throws', () => {
  const hub = makeHub()
  hub.openChannel('c1')
  assert.throws(() => hub.openChannel('c1'), /already open/i)
})

test('publishing after close is a no-op rather than a throw', () => {
  const hub = makeHub()
  hub.openChannel('c1')
  hub.publish('c1', delta('a:0', 'one'))
  hub.closeChannel('c1')

  assert.equal(hub.publish('c1', delta('a:0', 'late')), PUBLISH_IGNORED)
})

test('publishing to an unknown channel is a no-op rather than a throw', () => {
  const hub = makeHub()
  assert.equal(hub.publish('never-opened', delta('a:0', 'one')), PUBLISH_IGNORED)
})

test('reading an unknown channel returns undefined', () => {
  const hub = makeHub()
  assert.equal(hub.read('never-opened', 0), undefined)
})

test('a closed channel stays readable until its retention expires', () => {
  let clock = 1_000
  const hub = makeHub({ closedRetentionMs: 5_000, now: () => clock })
  hub.openChannel('c1')
  hub.publish('c1', delta('a:0', 'one'))
  hub.closeChannel('c1')

  clock = 5_999
  assert.ok(hub.read('c1', 0), 'still readable inside the retention window')

  clock = 6_001
  assert.equal(hub.read('c1', 0), undefined, 'evicted after retention')
})

test('a channel may be reopened once its closed retention has expired', () => {
  let clock = 1_000
  const hub = makeHub({ closedRetentionMs: 5_000, now: () => clock })
  hub.openChannel('c1')
  hub.closeChannel('c1')
  clock = 6_001
  assert.doesNotThrow(() => hub.openChannel('c1'))
})

// ─── Subscription ───────────────────────────────────────────────────────────

test('subscribers are notified when a frame is published', () => {
  const hub = makeHub()
  hub.openChannel('c1')
  let notifications = 0
  hub.subscribe('c1', () => {
    notifications += 1
  })

  hub.publish('c1', delta('a:0', 'one'))
  hub.publish('c1', delta('a:0', 'two'))
  assert.equal(notifications, 2)
})

test('a notification carries no frames, so the subscriber must read', () => {
  const hub = makeHub()
  hub.openChannel('c1')
  const received: unknown[] = []
  hub.subscribe('c1', (...args: unknown[]) => {
    received.push(args)
  })
  hub.publish('c1', delta('a:0', 'one'))

  assert.deepEqual(received, [[]])
})

test('an ignored duplicate does not notify', () => {
  const hub = makeHub()
  hub.openChannel('c1')
  hub.publish('c1', delta('a:0', 'one', 0))
  let notifications = 0
  hub.subscribe('c1', () => {
    notifications += 1
  })

  hub.publish('c1', delta('a:0', 'one', 0))
  assert.equal(notifications, 0)
})

test('unsubscribing stops notifications', () => {
  const hub = makeHub()
  hub.openChannel('c1')
  let notifications = 0
  const unsubscribe = hub.subscribe('c1', () => {
    notifications += 1
  })

  hub.publish('c1', delta('a:0', 'one'))
  unsubscribe()
  hub.publish('c1', delta('a:0', 'two'))
  assert.equal(notifications, 1)
})

test('closing a channel notifies subscribers so their pump can drain and stop', () => {
  const hub = makeHub()
  hub.openChannel('c1')
  let notifications = 0
  hub.subscribe('c1', () => {
    notifications += 1
  })

  hub.closeChannel('c1')
  assert.equal(notifications, 1)
})

test('a throwing subscriber does not break publish or other subscribers', () => {
  const hub = makeHub()
  hub.openChannel('c1')
  let reached = false
  hub.subscribe('c1', () => {
    throw new Error('subscriber exploded')
  })
  hub.subscribe('c1', () => {
    reached = true
  })

  assert.equal(hub.publish('c1', delta('a:0', 'one')), 0)
  assert.equal(reached, true)
})

// ─── Ring bound ─────────────────────────────────────────────────────────────

test('the ring is bounded and reports what it still retains', () => {
  const hub = makeHub({ ringCapacity: 4 })
  hub.openChannel('c1')
  for (let index = 0; index < 10; index += 1) {
    hub.publish('c1', delta('a:0', `t${index}`))
  }

  const page = hub.read('c1', 0)
  assert.ok(page)
  assert.equal(page.frames.length, 4)
  assert.equal(page.retainedFromCursor, 6)
  assert.equal(page.nextCursor, 10)
})

test('reading from a retained cursor returns only the frames from there on', () => {
  const hub = makeHub({ ringCapacity: 8 })
  hub.openChannel('c1')
  for (let index = 0; index < 5; index += 1) {
    hub.publish('c1', delta('a:0', `t${index}`))
  }

  const page = hub.read('c1', 3)
  assert.ok(page)
  assert.deepEqual(
    page.frames.map((frame) => frame.cursor),
    [3, 4],
  )
})

// ─── Invariant 9: no I/O, never awaits ──────────────────────────────────────

test('publish is synchronous and returns a number, never a promise', () => {
  const hub = makeHub()
  hub.openChannel('c1')
  const result = hub.publish('c1', delta('a:0', 'one'))
  assert.equal(typeof result, 'number')
})
