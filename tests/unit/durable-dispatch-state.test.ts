import assert from 'node:assert/strict'
import test from 'node:test'

import type { CapabilityRecoveryPolicy } from '../../contracts/durable-dispatch.js'
import {
  narrowRecoveryPolicy,
  reduceDurableDispatchState,
  resolveDurableRecovery,
  resolveRecoveryAfterStarted,
  type DurableDispatchStreamEvent,
} from '../../core/durable-dispatch.js'

function streamEvent(
  type: DurableDispatchStreamEvent['type'],
  overrides: Partial<DurableDispatchStreamEvent> = {},
): DurableDispatchStreamEvent {
  return {
    type,
    attemptId: 'attempt-1',
    ...overrides,
  }
}

test('reduces the full durable dispatch lifecycle to accepted', () => {
  const reduced = reduceDurableDispatchState([
    streamEvent('requested'),
    streamEvent('prepared'),
    streamEvent('started'),
    streamEvent('committed'),
    streamEvent('accepted'),
  ])
  assert.deepEqual(reduced, { kind: 'valid', state: 'accepted' })
})

test('a prepared-only stream is safe to resume before execution', () => {
  const reduced = reduceDurableDispatchState([
    streamEvent('requested'),
    streamEvent('prepared'),
  ])
  assert.deepEqual(reduced, { kind: 'valid', state: 'prepared' })
})

test('failed after started requires proof that no effect committed', () => {
  const provenNoEffect = reduceDurableDispatchState([
    streamEvent('requested'),
    streamEvent('prepared'),
    streamEvent('started'),
    streamEvent('failed', { effectCommitted: false }),
  ])
  assert.deepEqual(provenNoEffect, { kind: 'valid', state: 'failed' })

  // Without proof the outcome is unproven, so the state degrades to
  // indeterminate rather than allowing an unsafe retry.
  const unproven = reduceDurableDispatchState([
    streamEvent('requested'),
    streamEvent('prepared'),
    streamEvent('started'),
    streamEvent('failed'),
  ])
  assert.deepEqual(unproven, { kind: 'valid', state: 'indeterminate' })
})

test('cancellation after started leaves the dispatch indeterminate', () => {
  const reduced = reduceDurableDispatchState([
    streamEvent('requested'),
    streamEvent('prepared'),
    streamEvent('started'),
    streamEvent('cancelled'),
  ])
  assert.deepEqual(reduced, { kind: 'valid', state: 'indeterminate' })
})

test('rejection and cancellation are terminal before execution starts', () => {
  assert.deepEqual(
    reduceDurableDispatchState([
      streamEvent('requested'),
      streamEvent('prepared'),
      streamEvent('rejected'),
    ]),
    { kind: 'valid', state: 'rejected' },
  )
  assert.deepEqual(
    reduceDurableDispatchState([streamEvent('requested'), streamEvent('cancelled')]),
    { kind: 'valid', state: 'cancelled' },
  )
})

test('a started stream without a terminal record reduces to indeterminate', () => {
  const reduced = reduceDurableDispatchState([
    streamEvent('requested'),
    streamEvent('prepared'),
    streamEvent('started'),
  ])
  assert.deepEqual(reduced, { kind: 'valid', state: 'indeterminate' })
})

test('a committed but unaccepted stream must reconcile before reuse', () => {
  const reduced = reduceDurableDispatchState([
    streamEvent('requested'),
    streamEvent('prepared'),
    streamEvent('started'),
    streamEvent('committed'),
  ])
  assert.deepEqual(reduced, { kind: 'valid', state: 'committed' })
})

test('forbidden transitions fail closed', () => {
  const committedWithoutStarted = reduceDurableDispatchState([
    streamEvent('requested'),
    streamEvent('prepared'),
    streamEvent('committed'),
  ])
  assert.equal(committedWithoutStarted.kind, 'invalid')

  const startedWithoutPrepared = reduceDurableDispatchState([
    streamEvent('requested'),
    streamEvent('started'),
  ])
  assert.equal(startedWithoutPrepared.kind, 'invalid')

  const eventAfterAccepted = reduceDurableDispatchState([
    streamEvent('requested'),
    streamEvent('prepared'),
    streamEvent('started'),
    streamEvent('committed'),
    streamEvent('accepted'),
    streamEvent('started', { attemptId: 'attempt-2' }),
  ])
  assert.equal(eventAfterAccepted.kind, 'invalid')

  const empty = reduceDurableDispatchState([])
  assert.equal(empty.kind, 'invalid')
})

test('a retry after a pre-effect crash reduces to the new attempt outcome', () => {
  // Attempt one crashed after `requested`; attempt two ran to completion.
  // The stream must reduce to the latest attempt, not fail closed because a
  // second `requested` follows the first.
  const reduced = reduceDurableDispatchState([
    streamEvent('requested'),
    streamEvent('requested', { attemptId: 'attempt-2' }),
    streamEvent('prepared', { attemptId: 'attempt-2' }),
    streamEvent('started', { attemptId: 'attempt-2' }),
    streamEvent('committed', { attemptId: 'attempt-2' }),
    streamEvent('accepted', { attemptId: 'attempt-2' }),
  ])
  assert.deepEqual(reduced, { kind: 'valid', state: 'accepted' })
})

test('a retry after a proven failure reduces to the new attempt state', () => {
  const reduced = reduceDurableDispatchState([
    streamEvent('requested'),
    streamEvent('prepared'),
    streamEvent('started'),
    streamEvent('failed', { effectCommitted: false }),
    streamEvent('requested', { attemptId: 'attempt-2' }),
    streamEvent('prepared', { attemptId: 'attempt-2' }),
  ])
  assert.deepEqual(reduced, { kind: 'valid', state: 'prepared' })
})

test('a new attempt after an unproven effect fails closed', () => {
  // Attempt one started an external effect whose outcome was never proven.
  // Admitting attempt two would risk duplicating that effect.
  const afterStarted = reduceDurableDispatchState([
    streamEvent('requested'),
    streamEvent('prepared'),
    streamEvent('started'),
    streamEvent('requested', { attemptId: 'attempt-2' }),
  ])
  assert.equal(afterStarted.kind, 'invalid')

  const afterUnprovenFailure = reduceDurableDispatchState([
    streamEvent('requested'),
    streamEvent('prepared'),
    streamEvent('started'),
    streamEvent('failed'),
    streamEvent('requested', { attemptId: 'attempt-2' }),
  ])
  assert.equal(afterUnprovenFailure.kind, 'invalid')

  const afterCommitted = reduceDurableDispatchState([
    streamEvent('requested'),
    streamEvent('prepared'),
    streamEvent('started'),
    streamEvent('committed'),
    streamEvent('requested', { attemptId: 'attempt-2' }),
  ])
  assert.equal(afterCommitted.kind, 'invalid')
})

test('a new attempt after a settled outcome fails closed', () => {
  for (const settled of ['accepted', 'rejected', 'cancelled'] as const) {
    const reduced = reduceDurableDispatchState([
      streamEvent('requested'),
      streamEvent('prepared'),
      ...(settled === 'accepted'
        ? [streamEvent('started'), streamEvent('committed')]
        : []),
      streamEvent(settled),
      streamEvent('requested', { attemptId: 'attempt-2' }),
    ])
    assert.equal(reduced.kind, 'invalid', settled)
  }
})

test('mixed attempt identities inside one attempt fail closed', () => {
  const reduced = reduceDurableDispatchState([
    streamEvent('requested'),
    streamEvent('prepared', { attemptId: 'attempt-2' }),
  ])
  assert.equal(reduced.kind, 'invalid')
})

test('recovery admits retry only before started and reuse after accepted', () => {
  assert.deepEqual(resolveDurableRecovery('requested'), { kind: 'retriable' })
  assert.deepEqual(resolveDurableRecovery('prepared'), { kind: 'retriable' })
  assert.deepEqual(resolveDurableRecovery('accepted'), { kind: 'retained' })
  assert.deepEqual(resolveDurableRecovery('started'), { kind: 'blocked' })
  assert.deepEqual(resolveDurableRecovery('committed'), { kind: 'reconcile' })
  assert.deepEqual(resolveDurableRecovery('indeterminate'), { kind: 'blocked' })
  assert.deepEqual(resolveDurableRecovery('rejected'), { kind: 'terminal' })
  assert.deepEqual(resolveDurableRecovery('cancelled'), { kind: 'terminal' })
  assert.deepEqual(resolveDurableRecovery('failed'), { kind: 'retriable' })
})

test('adapter recovery policy decides post-started behavior', () => {
  const cases: ReadonlyArray<{
    readonly policy: CapabilityRecoveryPolicy
    readonly expected: ReturnType<typeof resolveRecoveryAfterStarted>
  }> = [
    { policy: 'read_only_retryable', expected: 'retry' },
    { policy: 'reconcilable', expected: 'reconcile' },
    { policy: 'non_retryable', expected: 'blocked' },
    { policy: 'unknown', expected: 'blocked' },
  ]
  for (const { policy, expected } of cases) {
    assert.equal(resolveRecoveryAfterStarted(policy), expected, policy)
  }
})

/**
 * A policy the runtime never honoured is not a policy.
 *
 * `idempotent_with_key` promised retry against an external idempotency key,
 * and no key ever reached a dispatcher, so it always failed closed. It is gone
 * from the union — but not from journals written while it was there, and a
 * value the runtime cannot act on has exactly one honest reading.
 */
test('a recovery policy the runtime no longer offers narrows to unknown', () => {
  assert.equal(narrowRecoveryPolicy('idempotent_with_key'), 'unknown')
  assert.equal(narrowRecoveryPolicy('read_only_retryable'), 'read_only_retryable')
  assert.equal(narrowRecoveryPolicy('reconcilable'), 'reconcilable')
  assert.equal(narrowRecoveryPolicy('non_retryable'), 'non_retryable')
  assert.equal(narrowRecoveryPolicy('anything-else'), 'unknown')
  assert.equal(narrowRecoveryPolicy(undefined), 'unknown')
})
