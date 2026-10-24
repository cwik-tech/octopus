import test from 'node:test'
import assert from 'node:assert/strict'

import { AgentTextStreamHub } from '../../domains/runtime/agent-text-stream-hub.js'
import { startAgentTextStreamPump } from '../../domains/runtime/agent-text-stream-pump.js'
import type { AgentTextStreamDelivery } from '../../contracts/agent-text-stream.js'

interface Written {
  readonly delivery: AgentTextStreamDelivery
  readonly id: number | undefined
}

function delta(replyId: string, text: string) {
  return { type: 'delta' as const, replyId, channel: 'text' as const, text }
}

/**
 * The falsifying case from the plan review. With cursors 100..200 retained and
 * a client resuming from 50, a ring-member gap could not work: it would need a
 * cursor above 99 yet must arrive before frame 100. The `reset` prelude carries
 * no SSE id, which is what keeps ids strictly monotonic.
 */
test('resuming from an evicted cursor sends reset with no id, then the retained frames', async () => {
  // Capacity 101 retains cursors 100..200 after 201 publishes.
  const hub = new AgentTextStreamHub({ ringCapacity: 101, now: () => 1_000 })
  hub.openChannel('c1')
  for (let index = 0; index <= 200; index += 1) {
    hub.publish('c1', delta('a:0', `t${index}`))
  }

  const page = hub.read('c1', 50)
  assert.ok(page)
  assert.equal(page.retainedFromCursor, 100, 'precondition: 0..99 are evicted')

  const written: Written[] = []
  const pump = startAgentTextStreamPump({
    hub,
    channelId: 'c1',
    fromCursor: 50,
    write: async (delivery, id) => {
      written.push({ delivery, id })
    },
  })

  hub.closeChannel('c1')
  await pump.done

  const first = written[0]
  assert.ok(first)
  assert.equal(first.delivery.type, 'reset')
  assert.equal(first.id, undefined, 'the reset prelude must carry no SSE id')
  if (first.delivery.type === 'reset') {
    assert.equal(first.delivery.requestedFromCursor, 50)
    assert.equal(first.delivery.retainedFromCursor, 100)
    assert.equal(first.delivery.reason, 'evicted')
  }

  const second = written[1]
  assert.ok(second)
  assert.equal(second.id, 100, 'the first framed event resumes at the retained cursor')

  const ids = written
    .map((entry) => entry.id)
    .filter((id): id is number => id !== undefined)
  assert.deepEqual(ids, ids.slice().sort((left, right) => left - right))
  for (let index = 1; index < ids.length; index += 1) {
    assert.ok(
      (ids[index] ?? 0) > (ids[index - 1] ?? 0),
      'SSE ids must be strictly monotonic across the prelude',
    )
  }
  assert.equal(ids[0], 100)
  assert.equal(ids[ids.length - 1], 200)
})

test('resuming from a retained cursor sends no reset at all', async () => {
  const hub = new AgentTextStreamHub({ ringCapacity: 101, now: () => 1_000 })
  hub.openChannel('c1')
  for (let index = 0; index <= 200; index += 1) {
    hub.publish('c1', delta('a:0', `t${index}`))
  }

  const written: Written[] = []
  const pump = startAgentTextStreamPump({
    hub,
    channelId: 'c1',
    fromCursor: 150,
    write: async (delivery, id) => {
      written.push({ delivery, id })
    },
  })
  hub.closeChannel('c1')
  await pump.done

  assert.equal(
    written.some((entry) => entry.delivery.type === 'reset'),
    false,
  )
  assert.equal(written[0]?.id, 150)
})

test('a fresh subscriber on a young channel starts at cursor zero with no reset', async () => {
  const hub = new AgentTextStreamHub({ ringCapacity: 64, now: () => 1_000 })
  hub.openChannel('c1')
  hub.publish('c1', delta('a:0', 'one'))
  hub.publish('c1', delta('a:0', 'two'))

  const written: Written[] = []
  const pump = startAgentTextStreamPump({
    hub,
    channelId: 'c1',
    fromCursor: 0,
    write: async (delivery, id) => {
      written.push({ delivery, id })
    },
  })
  hub.closeChannel('c1')
  await pump.done

  assert.deepEqual(
    written.map((entry) => entry.id),
    [0, 1],
  )
})

test('frames published after the pump starts are delivered in cursor order', async () => {
  const hub = new AgentTextStreamHub({ ringCapacity: 64, now: () => 1_000 })
  hub.openChannel('c1')

  const written: Written[] = []
  const pump = startAgentTextStreamPump({
    hub,
    channelId: 'c1',
    fromCursor: 0,
    write: async (delivery, id) => {
      written.push({ delivery, id })
    },
  })

  hub.publish('c1', delta('a:0', 'one'))
  hub.publish('c1', delta('b:1', 'two'))
  hub.publish('c1', delta('a:0', 'three'))
  hub.closeChannel('c1')
  await pump.done

  assert.deepEqual(
    written.map((entry) => entry.id),
    [0, 1, 2],
  )
})

test('the pump ends when the channel closes', async () => {
  const hub = new AgentTextStreamHub({ ringCapacity: 64, now: () => 1_000 })
  hub.openChannel('c1')
  const pump = startAgentTextStreamPump({
    hub,
    channelId: 'c1',
    fromCursor: 0,
    write: async () => {},
  })

  hub.closeChannel('c1')
  await pump.done
  assert.equal(pump.stopped, true)
})

test('an unknown channel ends the pump immediately', async () => {
  const hub = new AgentTextStreamHub({ now: () => 1_000 })
  const pump = startAgentTextStreamPump({
    hub,
    channelId: 'never-opened',
    fromCursor: 0,
    write: async () => {
      throw new Error('nothing should be written')
    },
  })
  await pump.done
  assert.equal(pump.stopped, true)
})
