import assert from 'node:assert/strict'
import test from 'node:test'

import { serializeResultForRetention } from '../../core/durable-dispatch-journal.js'

/**
 * Phase 3 removed the size threshold this used to describe. A retained result
 * is canonical bytes for the assignment's content store whatever its length,
 * so the only question left is whether the value has a canonical form at all.
 */

test('a canonical object is serialized to its canonical bytes', () => {
  const serialization = serializeResultForRetention({ ok: true, count: 2 })
  assert.equal(serialization.kind, 'canonical')
  if (serialization.kind !== 'canonical') return
  assert.equal(serialization.canonical, '{"count":2,"ok":true}')
})

test('length no longer changes how a result is retained', () => {
  const small = serializeResultForRetention({ blob: 'x' })
  const large = serializeResultForRetention({ blob: 'x'.repeat(200_000) })
  assert.equal(small.kind, 'canonical')
  assert.equal(large.kind, 'canonical')
  if (large.kind !== 'canonical') return
  assert.ok(large.canonical.startsWith('{"blob":"xxx'))
  assert.ok(large.canonical.length > 128 * 1024)
})

test('the same value serializes to the same bytes every time', () => {
  const make = () => serializeResultForRetention({ b: 2, a: 1 })
  const first = make()
  const second = make()
  assert.equal(first.kind, 'canonical')
  assert.equal(second.kind, 'canonical')
  if (first.kind !== 'canonical' || second.kind !== 'canonical') return
  assert.equal(first.canonical, second.canonical)
  // Key order is normalized, so a value that differs only by insertion order
  // is one content identity rather than two.
  assert.equal(first.canonical, '{"a":1,"b":2}')
})

test('non-object and non-canonical values are never retained', () => {
  assert.equal(serializeResultForRetention('a string').kind, 'unserializable')
  assert.equal(serializeResultForRetention(['array']).kind, 'unserializable')
  assert.equal(serializeResultForRetention(null).kind, 'unserializable')
  assert.equal(
    serializeResultForRetention({ notFinite: Number.NaN }).kind,
    'unserializable',
  )
  const cyclic: Record<string, unknown> = {}
  cyclic['self'] = cyclic
  assert.equal(serializeResultForRetention(cyclic).kind, 'unserializable')
})
