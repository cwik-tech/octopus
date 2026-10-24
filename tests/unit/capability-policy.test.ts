import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveCapabilityPolicy } from '../../core/capability-policy.js'

test('a deny decision wins over approval and allow decisions', () => {
  assert.deepEqual(
    resolveCapabilityPolicy([
      { kind: 'allow' },
      { kind: 'require-approval', reason: 'Needs approval' },
      { kind: 'deny', code: 'blocked', reason: 'Blocked' },
    ]),
    { kind: 'deny', code: 'blocked', reason: 'Blocked' },
  )
})

test('approval wins when every other decision allows', () => {
  assert.deepEqual(
    resolveCapabilityPolicy([
      { kind: 'allow' },
      { kind: 'require-approval', reason: 'Needs approval' },
    ]),
    { kind: 'require-approval', reason: 'Needs approval' },
  )
})

test('all explicit allow decisions resolve to allow', () => {
  assert.deepEqual(
    resolveCapabilityPolicy([{ kind: 'allow' }, { kind: 'allow' }]),
    { kind: 'allow' },
  )
})

test('missing or malformed policy decisions fail closed', () => {
  assert.deepEqual(resolveCapabilityPolicy([]), {
    kind: 'deny',
    code: 'policy_decision_missing',
    reason: 'A mandatory policy decision was not provided.',
  })
  for (const malformed of [undefined, null, {}, { kind: 'allow', extra: true }]) {
    assert.deepEqual(resolveCapabilityPolicy([{ kind: 'allow' }, malformed]), {
      kind: 'deny',
      code: 'policy_decision_invalid',
      reason: 'A mandatory policy decision was invalid.',
    })
  }
})
