import assert from 'node:assert/strict'
import test from 'node:test'

import {
  browserUseLiveGate,
  describeLiveSessionOutcome,
  hasObservedBrowserResearch,
  LIVE_THRESHOLD_ENV,
  LIVE_ENABLE_ENV,
  LIVE_KEY_ENV,
} from '../support/browser-use-live-gate.js'

/**
 * The decision to spend money, tested without spending any.
 *
 * The live check itself cannot be exercised here — that is the point of it —
 * so the gate is a pure function and this is where it is held to account.
 */

const configured = {
  [LIVE_ENABLE_ENV]: '1',
  [LIVE_THRESHOLD_ENV]: '20000',
  [LIVE_KEY_ENV]: 'bu_key',
}

test('a usable Browser Use cloud observation satisfies browser coverage without a local journal', () => {
  assert.equal(hasObservedBrowserResearch({
    localActivities: [],
    cloudAttempts: [{ method: 'cloud-browser', outcome: 'usable' }],
  }), true)
  assert.equal(hasObservedBrowserResearch({
    localActivities: [],
    cloudAttempts: [{ method: 'cloud-browser', outcome: 'challenge' }],
  }), false)
})

test('the session outcome reports the cleanup, and infers nothing beyond it', () => {
  // A confirmed stop whose meter could not be read is still a stopped session.
  // Calling it "never created" would be an inference the cleanup does not
  // support, so this reports only what cleanup showed.
  assert.equal(describeLiveSessionOutcome({ stopped: true }), 'stopped')
  assert.equal(
    describeLiveSessionOutcome({ stopped: false, warningKind: 'session-not-stopped' }),
    'not-stopped',
  )
  assert.equal(
    describeLiveSessionOutcome({ stopped: false, warningKind: 'session-indeterminate' }),
    'indeterminate',
  )
  assert.equal(describeLiveSessionOutcome({ stopped: false }), 'indeterminate')
})

test('an empty environment does not run the paid check', () => {
  const gate = browserUseLiveGate({})
  assert.equal(gate.kind, 'skip')
  assert.match(gate.kind === 'skip' ? gate.reason : '', /bills a real provider/u)
})

test('a fully configured environment runs it under the stated alarm', () => {
  const gate = browserUseLiveGate(configured)
  assert.equal(gate.kind, 'run')
  assert.equal(gate.kind === 'run' ? gate.alarmMicros : 0, 20_000)
})

test('an enable flag on its own is not authorization to spend', () => {
  // Easy to leave set. On its own it says nothing about how much.
  const gate = browserUseLiveGate({ [LIVE_ENABLE_ENV]: '1', [LIVE_KEY_ENV]: 'bu_key' })
  assert.equal(gate.kind, 'skip')
  assert.match(gate.kind === 'skip' ? gate.reason : '', /unexpectedly expensive/u)
})

test('an alarm that is not a positive whole amount is refused', () => {
  for (const alarm of ['0', '-1', '1.5', 'lots', '', '100000001']) {
    const gate = browserUseLiveGate({ ...configured, [LIVE_THRESHOLD_ENV]: alarm })
    assert.equal(gate.kind, 'skip', alarm)
  }
})

test('a missing key is a skip, not a failed request', () => {
  const gate = browserUseLiveGate({ ...configured, [LIVE_KEY_ENV]: '' })
  assert.equal(gate.kind, 'skip')
  assert.match(gate.kind === 'skip' ? gate.reason : '', /is not set/u)
})

test('every refusal explains itself', () => {
  // A live check that skips silently is one that has quietly stopped running.
  for (const environment of [
    {},
    { [LIVE_ENABLE_ENV]: '1' },
    { [LIVE_ENABLE_ENV]: '1', [LIVE_THRESHOLD_ENV]: 'lots' },
    { [LIVE_ENABLE_ENV]: '1', [LIVE_THRESHOLD_ENV]: '20000' },
  ]) {
    const gate = browserUseLiveGate(environment)
    assert.equal(gate.kind, 'skip')
    assert.ok((gate.kind === 'skip' ? gate.reason : '').length > 20)
  }
})
