/**
 * Unit tests for core/timeout-manager.ts
 *
 * Covers:
 *   1. combineAbortSignals with one undefined signal returns a working signal
 *   2. combineAbortSignals with a pre-aborted signal immediately aborts combined
 *   3. Aborting any input signal aborts the combined signal
 *   4. TimeoutError has correct fields
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { combineAbortSignals, TimeoutError } from '../../core/timeout-manager.js'

// ─── combineAbortSignals ─────────────────────────────────────────────────────

test('combineAbortSignals with one undefined signal returns a working signal', () => {
  const combined = combineAbortSignals(undefined)
  assert.ok(combined instanceof AbortSignal, 'returns an AbortSignal')
  assert.equal(combined.aborted, false, 'combined signal is not pre-aborted')
})

test('combineAbortSignals with no arguments returns a never-aborting signal', () => {
  const combined = combineAbortSignals()
  assert.ok(combined instanceof AbortSignal, 'returns an AbortSignal')
  assert.equal(combined.aborted, false, 'combined signal is not aborted')
})

test('combineAbortSignals with pre-aborted signal immediately aborts combined', () => {
  const alreadyAborted = AbortSignal.abort('test-reason')
  const combined = combineAbortSignals(alreadyAborted)
  assert.equal(combined.aborted, true, 'combined signal is immediately aborted')
})

test('combineAbortSignals with pre-aborted and undefined signals immediately aborts', () => {
  const alreadyAborted = AbortSignal.abort()
  const combined = combineAbortSignals(undefined, alreadyAborted, undefined)
  assert.equal(combined.aborted, true, 'undefined signals skipped; pre-aborted propagates')
})

test('aborting any input signal aborts the combined signal', () => {
  const ctrl1 = new AbortController()
  const ctrl2 = new AbortController()
  const combined = combineAbortSignals(ctrl1.signal, ctrl2.signal)

  assert.equal(combined.aborted, false, 'not aborted before any input aborts')
  ctrl1.abort()
  assert.equal(combined.aborted, true, 'combined aborts when first input aborts')
})

test('aborting the second input signal also aborts the combined signal', () => {
  const ctrl1 = new AbortController()
  const ctrl2 = new AbortController()
  const combined = combineAbortSignals(ctrl1.signal, ctrl2.signal)

  ctrl2.abort()
  assert.equal(combined.aborted, true, 'combined aborts when second input aborts')
})

test('combineAbortSignals skips undefined and links valid signals', () => {
  const ctrl = new AbortController()
  const combined = combineAbortSignals(undefined, ctrl.signal, undefined)

  assert.equal(combined.aborted, false)
  ctrl.abort()
  assert.equal(combined.aborted, true)
})

// ─── TimeoutError ─────────────────────────────────────────────────────────────

test('TimeoutError has correct fields', () => {
  const err = new TimeoutError('my-agent', 30_000, 30_001)

  assert.ok(err instanceof Error, 'instanceof Error')
  assert.ok(err instanceof TimeoutError, 'instanceof TimeoutError')
  assert.equal(err.name, 'TimeoutError', 'name property is TimeoutError')
  assert.equal(err.agentName, 'my-agent', 'agentName field')
  assert.equal(err.timeoutMs, 30_000, 'timeoutMs field')
  assert.equal(err.elapsedMs, 30_001, 'elapsedMs field')
  assert.ok(err.message.includes('my-agent'), 'message mentions agent name')
})

test('TimeoutError message includes elapsed and limit timing', () => {
  const err = new TimeoutError('slow-agent', 60_000, 62_000)
  // Message should reference either elapsed or limit ms
  assert.ok(
    err.message.includes('60000') || err.message.includes('62000'),
    `message should include timing info, got: "${err.message}"`,
  )
})

test('TimeoutError is a proper Error subclass with correct prototype chain', () => {
  const err = new TimeoutError('agent', 1000, 1001)
  assert.ok(err instanceof Error)
  assert.ok(err instanceof TimeoutError)
  assert.equal(Object.getPrototypeOf(err), TimeoutError.prototype)
})
