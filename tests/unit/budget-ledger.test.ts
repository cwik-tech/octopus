/**
 * T2: Unit Tests — BudgetLedger Module
 *
 * Covers:
 *   1: canDispatch returns allowed:true when under cap
 *   2: canDispatch returns allowed:false when at cap
 *   3: canDispatch returns allowed:false when over cap
 *   4: checkStageBudget returns allowed:false when stage exceeds limit
 *   5: checkStageBudget returns allowed:true when stage is under limit
 *   6: applyPolicy with 'halt' throws BudgetExceededError
 *   7: applyPolicy with 'warn' does NOT throw
 *   8: BudgetExceededError is instanceof Error
 *   9: BudgetExceededError has correct fields
 *  10: BudgetLedger getters return configured values
 *  11: canDispatch remaining is correct when under cap
 *  12: applyPolicy with 'halt' does nothing when under cap
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as util from 'node:util'

import {
  BudgetLedger,
  BudgetExceededError,
  adoptBudgetDispatchAdmission,
} from '../../core/budget-ledger.js'

// ─── canDispatch ─────────────────────────────────────────────────────────────

test('T2-1: canDispatch returns allowed:true when under cap', () => {
  const ledger = new BudgetLedger({ capUsd: 10, policy: 'halt' })
  const result = ledger.canDispatch(9.99)
  assert.equal(result.allowed, true, 'should be allowed when under cap')
  assert.ok(result.remaining > 0, 'remaining should be positive')
})

test('T2-2: canDispatch returns allowed:false when at cap', () => {
  const ledger = new BudgetLedger({ capUsd: 10, policy: 'halt' })
  const result = ledger.canDispatch(10)
  assert.equal(result.allowed, false, 'should not be allowed when exactly at cap')
  assert.equal(result.remaining, 0, 'remaining should be 0 at cap')
  assert.equal(result.reason, 'Budget exceeded', 'reason should be "Budget exceeded"')
})

test('T2-3: canDispatch returns allowed:false when over cap', () => {
  const ledger = new BudgetLedger({ capUsd: 10, policy: 'warn' })
  const result = ledger.canDispatch(15.50)
  assert.equal(result.allowed, false, 'should not be allowed when over cap')
  assert.equal(result.remaining, 0, 'remaining should be 0 when over cap')
  assert.equal(result.reason, 'Budget exceeded')
})

// ─── checkStageBudget ────────────────────────────────────────────────────────

test('T2-4: checkStageBudget returns allowed:false when stage exceeds limit', () => {
  const ledger = new BudgetLedger({ capUsd: 100, policy: 'halt' })
  const result = ledger.checkStageBudget(5.50, 5)
  assert.equal(result.allowed, false, 'should not be allowed when stage cost exceeds limit')
  assert.equal(result.remaining, 0)
})

test('T2-5: checkStageBudget returns allowed:true when stage is under limit', () => {
  const ledger = new BudgetLedger({ capUsd: 100, policy: 'halt' })
  const result = ledger.checkStageBudget(3, 5)
  assert.equal(result.allowed, true, 'should be allowed when stage cost is under limit')
  assert.equal(result.remaining, 2)
})

test('T2-13: checkStageBudget returns allowed:false when exactly at limit', () => {
  const ledger = new BudgetLedger({ capUsd: 100, policy: 'halt' })
  const result = ledger.checkStageBudget(5, 5)
  assert.equal(result.allowed, false, 'should not be allowed when exactly at limit')
  assert.equal(result.remaining, 0)
})

test('T2-14: checkStageBudget returns allowed:true and full remaining when cost is 0', () => {
  const ledger = new BudgetLedger({ capUsd: 100, policy: 'halt' })
  const result = ledger.checkStageBudget(0, 10)
  assert.equal(result.allowed, true)
  assert.equal(result.remaining, 10)
})

test('T2-15: checkStageBudget returns allowed:false and 0 remaining when limit is 0', () => {
  const ledger = new BudgetLedger({ capUsd: 100, policy: 'halt' })
  const result = ledger.checkStageBudget(0.01, 0)
  assert.equal(result.allowed, false)
  assert.equal(result.remaining, 0)
})

// ─── applyPolicy ─────────────────────────────────────────────────────────────

test('T2-6: applyPolicy with halt throws BudgetExceededError when at/over cap', () => {
  const ledger = new BudgetLedger({ capUsd: 20, policy: 'halt' })
  assert.throws(
    () => ledger.applyPolicy(20),
    (err: unknown) => {
      assert.ok(err instanceof BudgetExceededError, 'must be BudgetExceededError')
      return true
    },
    'should throw BudgetExceededError when halt policy and cap exceeded',
  )
})

test('T2-7: applyPolicy with warn does NOT throw and calls console.error with budget message', () => {
  const ledger = new BudgetLedger({ capUsd: 20, policy: 'warn' })

  // Spy on console.error to verify the side effect
  const calls: string[] = []
  const originalConsoleError = console.error
  console.error = (...args: unknown[]) => {
    calls.push(util.format(...args))
  }
  try {
    assert.doesNotThrow(() => ledger.applyPolicy(20), 'warn policy should not throw at cap')
    assert.doesNotThrow(() => ledger.applyPolicy(25), 'warn policy should not throw when over cap')

    // Negative obligation: console.error MUST have been called
    assert.equal(calls.length, 2, 'console.error must be called once per applyPolicy call')
    assert.ok(calls[0]!.includes('Budget cap reached'), `message should mention cap, got: ${calls[0]}`)
    assert.ok(calls[0]!.includes('$20.00'), `message should include cap amount, got: ${calls[0]}`)
    assert.ok(calls[0]!.includes('$20.00'), `message should include current cost, got: ${calls[0]}`)
    assert.ok(calls[0]!.includes('warn'), `message should mention warn policy, got: ${calls[0]}`)
  } finally {
    console.error = originalConsoleError
  }
})

// ─── BudgetExceededError ──────────────────────────────────────────────────────

test('T2-8: BudgetExceededError is instanceof Error', () => {
  const err = new BudgetExceededError(10, 12.50, 'halt')
  assert.ok(err instanceof Error, 'BudgetExceededError must be instanceof Error')
  assert.ok(err instanceof BudgetExceededError, 'must be instanceof BudgetExceededError')
})

test('T2-9: BudgetExceededError has correct fields, name, and message format', () => {
  const err = new BudgetExceededError(30, 35.75, 'warn')
  assert.equal(err.budgetCapUsd, 30, 'budgetCapUsd must match')
  assert.equal(err.totalSpent, 35.75, 'totalSpent must match')
  assert.equal(err.policy, 'warn', 'policy must match')
  assert.equal(err.name, 'BudgetExceededError', 'name must be BudgetExceededError for cross-module instanceof')
  // Verify message format contains all key info
  assert.ok(err.message.includes('35.75'), `message should include total spent, got: ${err.message}`)
  assert.ok(err.message.includes('30.00'), `message should include cap, got: ${err.message}`)
  assert.ok(err.message.includes('warn'), `message should include policy, got: ${err.message}`)
})

// ─── Getters ─────────────────────────────────────────────────────────────────

test('T2-10: BudgetLedger getters return configured values', () => {
  const ledger = new BudgetLedger({ capUsd: 42.5, policy: 'warn' })
  assert.equal(ledger.capUsd, 42.5, 'capUsd getter')
  assert.equal(ledger.policy, 'warn', 'policy getter')
})

// ─── Edge cases ───────────────────────────────────────────────────────────────

test('T2-11: canDispatch remaining is capped at 0 when over budget', () => {
  const ledger = new BudgetLedger({ capUsd: 10, policy: 'halt' })
  const result = ledger.canDispatch(100)
  assert.equal(result.remaining, 0, 'remaining must not be negative')
})

test('T2-12: applyPolicy with halt does nothing when under cap', () => {
  const ledger = new BudgetLedger({ capUsd: 50, policy: 'halt' })
  assert.doesNotThrow(() => ledger.applyPolicy(49.99), 'should not throw when under cap')
})

test('T2-16: canDispatch with zero cost returns full remaining', () => {
  const ledger = new BudgetLedger({ capUsd: 25, policy: 'halt' })
  const result = ledger.canDispatch(0)
  assert.equal(result.allowed, true)
  assert.equal(result.remaining, 25)
  assert.equal(result.reason, undefined)
})

test('T2-17: canDispatch floating-point precision near cap edge', () => {
  const ledger = new BudgetLedger({ capUsd: 10.00, policy: 'halt' })
  // Just barely under
  const under = ledger.canDispatch(9.9999999)
  assert.equal(under.allowed, true)
  assert.ok(under.remaining > 0)
  // Just barely over
  const over = ledger.canDispatch(10.0000001)
  assert.equal(over.allowed, false)
  assert.equal(over.remaining, 0)
})

test('T2-18: canDispatch rejects a negative currentTotalCost', () => {
  const ledger = new BudgetLedger({ capUsd: 10, policy: 'halt' })
  const result = ledger.canDispatch(-5)
  assert.equal(result.allowed, false)
  assert.equal(result.reason, 'Invalid budget total')
})

test('T2-19: applyPolicy with warn does NOT call console.error when under cap', () => {
  const ledger = new BudgetLedger({ capUsd: 20, policy: 'warn' })
  const calls: string[] = []
  const originalConsoleError = console.error
  console.error = (...args: unknown[]) => {
    calls.push(util.format(...args))
  }
  try {
    ledger.applyPolicy(15)
    // Negative obligation: console.error MUST NOT be called when under cap
    assert.equal(calls.length, 0, 'console.error should not be called when under cap')
  } finally {
    console.error = originalConsoleError
  }
})

test('hard-budget reservations serialize callers that observe the same spend', () => {
  const ledger = new BudgetLedger({ capUsd: 20, policy: 'halt' })
  const first = ledger.reserveRemaining(5)
  assert.equal(typeof first, 'number')
  assert.equal(ledger.reservedUsd, 15)
  assert.equal(ledger.reserveRemaining(5), null)

  ledger.releaseReservation(first!)
  assert.equal(ledger.reservedUsd, 0)
  assert.equal(typeof ledger.reserveRemaining(8), 'number')
})

test('releasing an unknown reservation is idempotent', () => {
  const ledger = new BudgetLedger({ capUsd: 10, policy: 'halt' })
  assert.doesNotThrow(() => ledger.releaseReservation(999))
  assert.equal(ledger.reservedUsd, 0)
})

test('invalid numeric totals are rejected without poisoning reservations', () => {
  const ledger = new BudgetLedger({ capUsd: 10, policy: 'halt' })
  assert.deepEqual(ledger.canDispatch(Number.NaN), {
    allowed: false,
    remaining: 0,
    reason: 'Invalid budget total',
  })
  assert.equal(ledger.reserveRemaining(Number.NaN), null)
  assert.equal(ledger.reservedUsd, 0)
  assert.equal(ledger.checkStageBudget(Number.NaN, 5).allowed, false)
  assert.throws(() => ledger.applyPolicy(Number.NaN), BudgetExceededError)
})

test('a governed engine with a ledger fails closed when its outer admission is missing', () => {
  const ledger = new BudgetLedger({ capUsd: 10, policy: 'halt' })

  assert.throws(
    () => adoptBudgetDispatchAdmission({
      ledger,
      adopt: () => undefined,
      toolCallId: 'missing-owned-admission',
    }),
    /could not adopt its dispatcher-owned budget reservation/,
  )
})

test('hard-budget dispatch slots are granted in FIFO order', async () => {
  const ledger = new BudgetLedger({ capUsd: 10, policy: 'halt' })
  const releaseFirst = await ledger.acquireDispatchSlot()
  let secondAcquired = false
  const second = ledger.acquireDispatchSlot().then((release) => {
    secondAcquired = true
    release()
  })

  await Promise.resolve()
  assert.equal(secondAcquired, false)
  releaseFirst()
  await second
  assert.equal(secondAcquired, true)
})
