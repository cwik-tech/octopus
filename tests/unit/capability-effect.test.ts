import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canonicalizeCapabilityEffect,
  hostAuditedParallelReadEffect,
  mayRunConcurrently,
  normalizeExternalCapabilityEffect,
  serialCapabilityEffect,
  type CapabilityEffectKind,
} from '../../contracts/capability-effect.js'

const serialKinds: readonly CapabilityEffectKind[] = [
  'read-only',
  'mutating',
  'destructive',
  'unknown',
]

test('only the host-audited parallel read effect may run concurrently', () => {
  const audited = hostAuditedParallelReadEffect()

  assert.equal(mayRunConcurrently(audited), true)
  assert.equal(mayRunConcurrently({
    kind: 'read-only',
    concurrency: 'parallel-safe',
  }), false)
  for (const kind of serialKinds) {
    assert.equal(mayRunConcurrently(serialCapabilityEffect(kind)), false)
  }
})

test('external effect normalization fails closed and never grants parallel safety', () => {
  const malformedInputs: readonly unknown[] = [
    undefined,
    null,
    'read-only',
    {},
    { kind: 'read-only' },
    { kind: 'invalid', concurrency: 'serial' },
    { kind: 'mutating', concurrency: 'parallel-safe' },
    { kind: 'destructive', concurrency: 'parallel-safe' },
    { kind: 'unknown', concurrency: 'parallel-safe' },
  ]

  for (const input of malformedInputs) {
    assert.strictEqual(
      normalizeExternalCapabilityEffect(input),
      serialCapabilityEffect('unknown'),
    )
  }

  assert.strictEqual(
    normalizeExternalCapabilityEffect({
      kind: 'read-only',
      concurrency: 'parallel-safe',
    }),
    serialCapabilityEffect('read-only'),
  )
})

test('effect factories return frozen interned values', () => {
  const effects = [
    ...serialKinds.map((kind) => serialCapabilityEffect(kind)),
    hostAuditedParallelReadEffect(),
  ]

  for (const effect of effects) {
    assert.equal(Object.isFrozen(effect), true)
    assert.strictEqual(canonicalizeCapabilityEffect(effect), effect)
    assert.throws(
      () => Object.assign(effect, { kind: 'mutating' }),
      TypeError,
    )
  }

  for (const kind of serialKinds) {
    assert.strictEqual(
      serialCapabilityEffect(kind),
      serialCapabilityEffect(kind),
    )
  }
  assert.strictEqual(
    hostAuditedParallelReadEffect(),
    hostAuditedParallelReadEffect(),
  )
})

test('canonicalization preserves only the exact audited parallel singleton', () => {
  const audited = hostAuditedParallelReadEffect()

  assert.strictEqual(canonicalizeCapabilityEffect(audited), audited)
  assert.strictEqual(
    canonicalizeCapabilityEffect({
      kind: 'read-only',
      concurrency: 'parallel-safe',
    }),
    serialCapabilityEffect('read-only'),
  )
})
