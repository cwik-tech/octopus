/**
 * Unit tests for core/lifecycle.ts
 *
 * Covers:
 *   1. installShutdownHandlers shares its process listeners across
 *      registrations rather than accumulating them
 *   2. a registration runs once however many signals arrive, stops when
 *      disposed, and does not stand in for a later one
 *   3. the last disposal gives the process listeners back
 *   4. gracefulShutdown aborts controller and calls persistFn
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { installShutdownHandlers, gracefulShutdown } from '../../core/lifecycle.js'

// ─── installShutdownHandlers ─────────────────────────────────────────────────

// Every test here disposes what it registers. A leaked registration keeps the
// shared signal listener installed, which would silently move the baseline the
// next test measures against.

test('installShutdownHandlers repeated calls do not accumulate SIGTERM handlers', () => {
  const first = installShutdownHandlers({ onShutdown: () => {} })
  const countAfterFirst = process.listenerCount('SIGTERM')

  const second = installShutdownHandlers({ onShutdown: () => {} })
  const countAfterSecond = process.listenerCount('SIGTERM')

  try {
    assert.equal(
      countAfterSecond,
      countAfterFirst,
      'a second registration must not add additional SIGTERM listeners',
    )
  } finally {
    first.dispose()
    second.dispose()
  }
})

test('installShutdownHandlers repeated calls do not accumulate SIGINT handlers', () => {
  const first = installShutdownHandlers({ onShutdown: () => {} })
  const countAfterFirst = process.listenerCount('SIGINT')

  const second = installShutdownHandlers({ onShutdown: () => {} })
  const countAfterSecond = process.listenerCount('SIGINT')

  try {
    assert.equal(
      countAfterSecond,
      countAfterFirst,
      'a second registration must not add additional SIGINT listeners',
    )
  } finally {
    first.dispose()
    second.dispose()
  }
})

test('a disposed shutdown registration stops being called, and a later one is called instead', () => {
  const calls: string[] = []

  const first = installShutdownHandlers({ onShutdown: () => calls.push('first') })
  first.dispose()

  const second = installShutdownHandlers({ onShutdown: () => calls.push('second') })
  try {
    process.emit('SIGHUP')
    assert.deepEqual(
      calls,
      ['second'],
      'a signal must reach the live registration and not the disposed one',
    )
  } finally {
    second.dispose()
  }
})

test('a registration runs once however many signals arrive, and nothing after disposal', () => {
  const calls: string[] = []
  const registration = installShutdownHandlers({
    onShutdown: () => calls.push('shutdown'),
  })

  try {
    process.emit('SIGTERM')
    process.emit('SIGINT')
    process.emit('SIGHUP')
    assert.deepEqual(calls, ['shutdown'], 'three signals, one shutdown')
  } finally {
    registration.dispose()
  }

  process.emit('SIGTERM')
  assert.deepEqual(calls, ['shutdown'], 'and none after it was disposed')
})

test('disposing every registration releases the signal listeners it needed', () => {
  const before = {
    SIGTERM: process.listenerCount('SIGTERM'),
    SIGINT: process.listenerCount('SIGINT'),
    SIGHUP: process.listenerCount('SIGHUP'),
  }

  const first = installShutdownHandlers({ onShutdown: () => {} })
  const second = installShutdownHandlers({ onShutdown: () => {} })
  try {
    assert.equal(
      process.listenerCount('SIGTERM'),
      before.SIGTERM + 1,
      'two registrations still share one listener per signal',
    )

    first.dispose()
    assert.equal(
      process.listenerCount('SIGTERM'),
      before.SIGTERM + 1,
      'and the listener stays while another registration is live',
    )
  } finally {
    // Both, unconditionally: a failed assertion above must not leave a
    // registration behind for the next test to measure against.
    first.dispose()
    second.dispose()
  }

  assert.deepEqual(
    {
      SIGTERM: process.listenerCount('SIGTERM'),
      SIGINT: process.listenerCount('SIGINT'),
      SIGHUP: process.listenerCount('SIGHUP'),
    },
    before,
    'the last disposal gives every signal listener back',
  )
})

// ─── gracefulShutdown ─────────────────────────────────────────────────────────

test('gracefulShutdown aborts the controller synchronously', () => {
  const controller = new AbortController()
  assert.equal(controller.signal.aborted, false, 'signal not aborted before call')

  // Pass a very large grace period; timer is unreffed so it does not block exit.
  gracefulShutdown(controller, () => {}, 99_999_999)

  assert.equal(controller.signal.aborted, true, 'controller must be aborted after gracefulShutdown')
})

test('gracefulShutdown calls persistFn synchronously', () => {
  const controller = new AbortController()
  let persistCalled = false

  gracefulShutdown(controller, () => { persistCalled = true }, 99_999_999)

  assert.equal(persistCalled, true, 'persistFn must be called synchronously inside gracefulShutdown')
})

test('gracefulShutdown aborts controller and calls persistFn in a single call', () => {
  const controller = new AbortController()
  const calls: string[] = []

  gracefulShutdown(
    controller,
    () => { calls.push('persist') },
    99_999_999,
  )

  assert.equal(controller.signal.aborted, true, 'controller aborted')
  assert.deepEqual(calls, ['persist'], 'persistFn was called exactly once')
})
