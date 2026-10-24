import assert from 'node:assert/strict'
import test from 'node:test'
import { OfficeProcessSlots } from '../../services/office-process-slots.js'
test('all Office commands share two slots, bounded waiting and cancellable admission', async () => {
  const slots = new OfficeProcessSlots()
  const signal = new AbortController().signal
  const first = await slots.acquire(signal)
  const second = await slots.acquire(signal)
  assert.equal(first.ok, true); assert.equal(second.ok, true)
  const cancelled = new AbortController()
  const waiting = slots.acquire(cancelled.signal)
  cancelled.abort()
  assert.deepEqual(await waiting, { ok: false, code: 'cancelled' })
  const next = slots.acquire(signal)
  first.release()
  const admitted = await next
  assert.equal(admitted.ok, true)
  admitted.release(); second.release()
})
