import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentTextStreamHub } from '../../domains/runtime/agent-text-stream-hub.js'
import { startAgentTextStreamPump } from '../../domains/runtime/agent-text-stream-pump.js'
import type { AgentTextStreamDelivery } from '../../contracts/agent-text-stream.js'

function gate() {
  let release = () => {}
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

test('a reopened stream restores the latest progress after text eviction without moving its SSE cursor', async () => {
  const hub = new AgentTextStreamHub({ ringCapacity: 2 })
  hub.openChannel('turn', 'session')
  hub.publish('turn', { type: 'progress', replyId: 'alpha:0', progress: {
    revision: 1, startedAt: 1000, updatedAt: 1000, current: { kind: 'observed', phase: 'thinking' }, history: [],
  } })
  hub.publish('turn', { type: 'delta', replyId: 'alpha:0', channel: 'text', text: 'First' })
  hub.publish('turn', { type: 'delta', replyId: 'alpha:0', channel: 'text', text: 'Second' })
  hub.closeChannel('turn')
  const received: { delivery: AgentTextStreamDelivery; id: number | undefined }[] = []
  const pump = startAgentTextStreamPump({ hub, channelId: 'turn', fromCursor: 0,
    write: async (delivery, id) => { received.push({ delivery, id }) },
  })
  await pump.done

  assert.deepEqual(received.map(item => item.delivery.type), ['reset', 'progress-snapshot', 'delta', 'delta'])
  assert.deepEqual(received.map(item => item.id), [undefined, undefined, 1, 2])
})

test('a mid-stream reset restores running progress and omits a reply that finished in the evicted window', async () => {
  const hub = new AgentTextStreamHub({ ringCapacity: 2 })
  hub.openChannel('turn', 'session')
  const thinking = { revision: 1, startedAt: 1000, updatedAt: 1000, current: { kind: 'observed' as const, phase: 'thinking' as const }, history: [] }
  hub.publish('turn', { type: 'progress', replyId: 'alpha:0', progress: thinking })
  const firstWrite = gate()
  const resume = gate()
  const received: AgentTextStreamDelivery[] = []
  const pump = startAgentTextStreamPump({ hub, channelId: 'turn', fromCursor: 0,
    write: async (delivery) => {
      received.push(delivery)
      if (received.length === 1) { firstWrite.release(); await resume.promise }
    },
  })
  await firstWrite.promise
  // The reader is held while alpha finishes and beta starts; alpha's final leaves the ring.
  hub.publish('turn', { type: 'final', replyId: 'alpha:0', reason: 'completed' })
  hub.publish('turn', { type: 'progress', replyId: 'beta:1', progress: thinking })
  hub.publish('turn', { type: 'delta', replyId: 'beta:1', channel: 'text', text: 'Beta' })
  hub.closeChannel('turn')
  resume.release()
  await pump.done

  assert.deepEqual(received.map(delivery => delivery.type === 'progress-snapshot' ? `snapshot:${delivery.replyId}` : delivery.type),
    ['snapshot:alpha:0', 'reset', 'snapshot:beta:1', 'progress', 'delta'])
})

test('a settled reply cannot regain a progress snapshot from a late event', () => {
  const hub = new AgentTextStreamHub({ ringCapacity: 2 })
  hub.openChannel('turn', 'session')
  const progress = { type: 'progress' as const, replyId: 'alpha:0', progress: {
    revision: 1, startedAt: 1000, updatedAt: 1000, current: { kind: 'observed' as const, phase: 'thinking' as const }, history: [],
  } }
  hub.publish('turn', progress)
  hub.publish('turn', { type: 'final', replyId: 'alpha:0', reason: 'completed' })
  assert.equal(hub.publish('turn', { ...progress, progress: { ...progress.progress, revision: 2 } }), -1)
})

test('progress identity retention stays bounded while answer delivery continues', () => {
  const hub = new AgentTextStreamHub({ ringCapacity: 2 })
  hub.openChannel('turn', 'session')
  for (let index = 0; index < 64; index += 1) {
    hub.publish('turn', { type: 'progress', replyId: `speaker:${index}`, progress: {
      revision: 1, startedAt: 1000, updatedAt: 1000, current: { kind: 'observed', phase: 'thinking' }, history: [],
    } })
    hub.publish('turn', { type: 'final', replyId: `speaker:${index}`, reason: 'completed' })
  }
  assert.equal(hub.publish('turn', { type: 'progress', replyId: 'overflow', progress: {
    revision: 1, startedAt: 1000, updatedAt: 1000, current: { kind: 'observed', phase: 'thinking' }, history: [],
  } }), -1)
  assert.ok(hub.publish('turn', { type: 'delta', replyId: 'overflow', channel: 'text', text: 'Still delivered' }) >= 0)
  assert.equal(hub.read('turn', 0)?.frames.at(-1)?.type, 'delta')
})
