/**
 * Circuit Breaker Tests
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { CircuitBreakerRegistry } from '../../domains/runtime/circuit-breaker.js'

test('CircuitBreaker: starts closed and allows requests', () => {
  const cb = new CircuitBreakerRegistry({ failureThreshold: 3, cooldownMs: 1000 })
  const result = cb.check('anthropic')
  assert.equal(result.allowed, true)
  assert.equal(cb.getState('anthropic'), 'closed')
})

test('CircuitBreaker: opens after threshold failures', () => {
  const cb = new CircuitBreakerRegistry({ failureThreshold: 3, cooldownMs: 1000 })
  cb.recordFailure('anthropic')
  cb.recordFailure('anthropic')
  cb.recordFailure('anthropic')
  assert.equal(cb.getState('anthropic'), 'open')
  const result = cb.check('anthropic')
  assert.equal(result.allowed, false)
  assert.ok(result.reason?.includes('Circuit breaker OPEN'))
})

test('CircuitBreaker: success resets failure count and closes', () => {
  const cb = new CircuitBreakerRegistry({ failureThreshold: 3, cooldownMs: 1000 })
  cb.recordFailure('anthropic')
  cb.recordFailure('anthropic')
  cb.recordSuccess('anthropic')
  assert.equal(cb.getState('anthropic'), 'closed')
  const result = cb.check('anthropic')
  assert.equal(result.allowed, true)
})

test('CircuitBreaker: transitions to half-open after cooldown', async () => {
  const cb = new CircuitBreakerRegistry({ failureThreshold: 2, cooldownMs: 50 })
  cb.recordFailure('anthropic')
  cb.recordFailure('anthropic')
  assert.equal(cb.getState('anthropic'), 'open')

  await new Promise((r) => setTimeout(r, 60))
  const result = cb.check('anthropic')
  assert.equal(result.allowed, true)
  assert.equal(cb.getState('anthropic'), 'half_open')
})

test('CircuitBreaker: half-open test failure re-opens immediately', () => {
  const cb = new CircuitBreakerRegistry({ failureThreshold: 2, cooldownMs: 50, halfOpenMs: 5000 })
  cb.recordFailure('anthropic')
  cb.recordFailure('anthropic')
  // Simulate cooldown elapsed
  const record = (cb as any).records.get('anthropic')
  record.openedAt = Date.now() - 100
  const check = cb.check('anthropic')
  assert.equal(check.allowed, true)
  assert.equal(cb.getState('anthropic'), 'half_open')

  cb.recordFailure('anthropic')
  assert.equal(cb.getState('anthropic'), 'open')
})

test('CircuitBreaker: half-open allows only one test request', () => {
  const cb = new CircuitBreakerRegistry({ failureThreshold: 2, cooldownMs: 50, halfOpenMs: 5000 })
  cb.recordFailure('anthropic')
  cb.recordFailure('anthropic')
  const record = (cb as any).records.get('anthropic')
  record.openedAt = Date.now() - 100

  const first = cb.check('anthropic')
  assert.equal(first.allowed, true)
  assert.equal(cb.getState('anthropic'), 'half_open')

  const second = cb.check('anthropic')
  assert.equal(second.allowed, false)
  assert.ok(second.reason?.includes('HALF_OPEN'))
})

test('CircuitBreaker: half-open test success closes circuit', () => {
  const cb = new CircuitBreakerRegistry({ failureThreshold: 2, cooldownMs: 50, halfOpenMs: 5000 })
  cb.recordFailure('anthropic')
  cb.recordFailure('anthropic')
  const record = (cb as any).records.get('anthropic')
  record.openedAt = Date.now() - 100
  cb.check('anthropic')
  cb.recordSuccess('anthropic')
  assert.equal(cb.getState('anthropic'), 'closed')
})

test('CircuitBreaker: resetAll clears all records', () => {
  const cb = new CircuitBreakerRegistry({ failureThreshold: 2, cooldownMs: 1000 })
  cb.recordFailure('anthropic')
  cb.recordFailure('openai')
  cb.resetAll()
  assert.equal(cb.getState('anthropic'), 'closed')
  assert.equal(cb.getState('openai'), 'closed')
})

test('CircuitBreaker: different providers have independent states', () => {
  const cb = new CircuitBreakerRegistry({ failureThreshold: 2, cooldownMs: 1000 })
  cb.recordFailure('anthropic')
  cb.recordFailure('anthropic')
  assert.equal(cb.getState('anthropic'), 'open')
  assert.equal(cb.getState('openai'), 'closed')
})
