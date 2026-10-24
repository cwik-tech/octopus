import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  canonicalizeJson,
  CanonicalJsonError,
  toCanonicalJsonObject,
} from '../../contracts/canonical-json.js'
import { hashCanonicalJson } from '../../core/canonical-json-hash.js'

test('canonical JSON sorts object keys recursively while preserving JSON values', () => {
  assert.equal(
    canonicalizeJson({
      z: [3, { beta: true, alpha: null }],
      a: { second: 'two', first: 'one' },
    }),
    '{"a":{"first":"one","second":"two"},"z":[3,{"alpha":null,"beta":true}]}',
  )
})

test('canonical JSON preserves array element order', () => {
  assert.equal(
    canonicalizeJson({ values: ['third', 'first', 'second'] }),
    '{"values":["third","first","second"]}',
  )
})

test('canonical JSON digest is stable across recursively reordered keys', () => {
  const first = hashCanonicalJson({
    z: [3, { beta: true, alpha: null }],
    a: 'value',
  })
  const reordered = hashCanonicalJson({
    a: 'value',
    z: [3, { alpha: null, beta: true }],
  })
  const changed = hashCanonicalJson({
    a: 'different',
    z: [3, { alpha: null, beta: true }],
  })
  const canonical = '{"a":"value","z":[3,{"alpha":null,"beta":true}]}'

  assert.deepEqual(first, {
    algorithm: 'sha256',
    value: createHash('sha256').update(canonical, 'utf8').digest('hex'),
  })
  assert.deepEqual(reordered, first)
  assert.notEqual(changed.value, first.value)
})

test('canonical JSON rejects non-finite and unsupported JSON values', () => {
  for (const invalid of [
    null,
    [],
    'scalar',
    1,
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: Number.NEGATIVE_INFINITY },
    { value: undefined },
    { value: 1n },
    { value: Symbol('invalid') },
    { value: () => 'invalid' },
    { value: new Date(0) },
  ]) {
    assertCanonicalJsonRejected(invalid)
  }
})

test('canonical JSON rejects cycles without rejecting repeated non-cyclic references', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const shared = { safe: true }

  assertCanonicalJsonRejected(cyclic)
  assert.equal(
    canonicalizeJson({ left: shared, right: shared }),
    '{"left":{"safe":true},"right":{"safe":true}}',
  )
})

test('canonical JSON accepts the MCP maximum depth and rejects one level beyond it', () => {
  let accepted: unknown = null
  for (let index = 0; index < 63; index += 1) accepted = [accepted]
  let rejected: unknown = null
  for (let index = 0; index < 64; index += 1) rejected = [rejected]

  assert.doesNotThrow(() => canonicalizeJson({ value: accepted }))
  assertCanonicalJsonRejected({ value: rejected })
})

test('canonical JSON rejects accessors without invoking them', () => {
  let getterCalls = 0
  const accessor: Record<string, unknown> = {}
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get: () => {
      getterCalls += 1
      return 'must-not-be-read'
    },
  })

  assertCanonicalJsonRejected(accessor)
  assert.equal(getterCalls, 0)
})

test('canonical JSON rejects sparse arrays and arrays with extra properties', () => {
  const sparse: unknown[] = new Array(2)
  sparse[1] = 'value'
  const extended: unknown[] = ['value']
  Object.defineProperty(extended, 'extra', {
    enumerable: true,
    value: 'hidden-shape',
  })

  assertCanonicalJsonRejected({ value: sparse })
  assertCanonicalJsonRejected({ value: extended })
})

test('canonical JSON rejects symbol values and symbol-keyed properties', () => {
  const symbolKeyed: Record<PropertyKey, unknown> = { value: 'safe' }
  symbolKeyed[Symbol('hidden')] = 'hidden'

  assertCanonicalJsonRejected({ value: Symbol('invalid') })
  assertCanonicalJsonRejected(symbolKeyed)
})

test('canonical JSON rejects prototype-pollution and unsafe argument keys', () => {
  for (const invalid of [
    JSON.parse('{"__proto__":"blocked"}') as unknown,
    { nested: { constructor: 'blocked' } },
    { nested: { prototype: 'blocked' } },
    { '': 'blocked' },
    { 'control\u0000key': 'blocked' },
    { ['x'.repeat(513)]: 'blocked' },
  ]) {
    assertCanonicalJsonRejected(invalid)
  }
})

function assertCanonicalJsonRejected(value: unknown): void {
  assert.throws(() => canonicalizeJson(value))
  assert.throws(() => hashCanonicalJson(value))
}

/**
 * Journal payloads arrive from domain code as loosely typed records. They are
 * converted through a validating parse rather than an assertion, so a value
 * the journal could not durably reproduce is rejected at the boundary instead
 * of being trusted by a cast.
 */

test('toCanonicalJsonObject returns the canonical form of a plain record', () => {
  const converted = toCanonicalJsonObject({ b: 1, a: { d: [1, 2], c: 'x' } })
  assert.deepEqual(converted, { a: { c: 'x', d: [1, 2] }, b: 1 })
  assert.equal(canonicalizeJson(converted), '{"a":{"c":"x","d":[1,2]},"b":1}')
})

test('toCanonicalJsonObject rejects values the journal cannot reproduce', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic['self'] = cyclic
  for (const invalid of [
    [1, 2],
    'text',
    null,
    { fn: () => undefined },
    { nan: Number.NaN },
    cyclic,
  ]) {
    assert.throws(
      () => toCanonicalJsonObject(invalid),
      CanonicalJsonError,
      JSON.stringify(String(invalid)),
    )
  }
})
