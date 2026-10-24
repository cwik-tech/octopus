/**
 * Provider stall watchdog.
 *
 * Contract: a CLI provider that goes silent mid-turn — retrying upstream, or
 * waiting on a slow model — emits no protocol events at all, so the run looks
 * alive but idle with nothing in the timeline to explain it. The watchdog turns
 * that silence into one labelled span with a measured duration.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createProviderStallWatchdog } from '../../providers/provider-stall-watchdog.js'

function makeWatchdog(idleMs = 60_000) {
  const stalls: number[] = []
  const resumes: number[] = []
  const watchdog = createProviderStallWatchdog({
    idleMs,
    onStall: (detail) => stalls.push(detail.idleMs),
    onResume: (detail) => resumes.push(detail.idleMs),
  })
  return { watchdog, stalls, resumes }
}

test('silence past the idle threshold reports one stall, not one per check', () => {
  const { watchdog, stalls } = makeWatchdog()
  watchdog.observe(0)

  watchdog.check(30_000)
  assert.deepEqual(stalls, [], 'no stall before the threshold')

  watchdog.check(60_000)
  assert.deepEqual(stalls, [60_000], 'stall reported once the threshold is crossed')

  watchdog.check(90_000)
  watchdog.check(120_000)
  assert.deepEqual(stalls, [60_000], 'the same silence is not reported again')
})

test('the next protocol event closes the span with its measured duration', () => {
  const { watchdog, stalls, resumes } = makeWatchdog()
  watchdog.observe(0)
  watchdog.check(60_000)
  assert.deepEqual(stalls, [60_000])

  watchdog.observe(307_000)
  assert.deepEqual(resumes, [307_000], 'the resume carries the full silent duration')

  // A second silence is a new span.
  watchdog.check(367_000)
  assert.deepEqual(stalls, [60_000, 60_000])
})

test('a run that never stalls reports nothing', () => {
  const { watchdog, stalls, resumes } = makeWatchdog()
  watchdog.observe(0)
  for (let now = 10_000; now <= 300_000; now += 10_000) {
    watchdog.check(now)
    watchdog.observe(now)
  }
  assert.deepEqual(stalls, [])
  assert.deepEqual(resumes, [])
})

test('a resume without a preceding stall is not reported', () => {
  const { watchdog, resumes } = makeWatchdog()
  watchdog.observe(0)
  watchdog.observe(5_000)
  assert.deepEqual(resumes, [])
})

/**
 * Reporting a stall explains the hole in the timeline but does not stop it:
 * the run stays alive while its deadline drains. Past a second, larger
 * threshold the turn is aborted so the attempt loop can retry against a
 * working provider instead of waiting out the whole budget.
 */
function makeAbortingWatchdog(abortIdleMs = 120_000) {
  const events: Array<{ phase: string; idleMs: number }> = []
  const watchdog = createProviderStallWatchdog({
    idleMs: 60_000,
    abortIdleMs,
    onStall: (detail) => events.push({ phase: 'stalled', idleMs: detail.idleMs }),
    onResume: (detail) => events.push({ phase: 'resumed', idleMs: detail.idleMs }),
    onAbort: (detail) => events.push({ phase: 'aborted', idleMs: detail.idleMs }),
  })
  return { watchdog, events }
}

test('silence below the abort threshold only reports', () => {
  const { watchdog, events } = makeAbortingWatchdog()
  watchdog.observe(0)
  watchdog.check(90_000)
  assert.deepEqual(
    events.map((event) => event.phase),
    ['stalled'],
    'a provider that is merely slow must be allowed to finish',
  )
})

test('silence past the abort threshold aborts exactly once', () => {
  const { watchdog, events } = makeAbortingWatchdog()
  watchdog.observe(0)
  watchdog.check(70_000)
  watchdog.check(130_000)
  watchdog.check(200_000)
  assert.deepEqual(
    events.map((event) => event.phase),
    ['stalled', 'aborted'],
    'one abort per span; repeated polls must not re-kill the process',
  )
  assert.equal(events[1]?.idleMs, 130_000, 'the abort names the idle duration')
})

test('a resumed provider can stall and abort again on a later span', () => {
  const { watchdog, events } = makeAbortingWatchdog()
  watchdog.observe(0)
  watchdog.check(130_000)
  watchdog.observe(140_000)
  watchdog.check(270_000)
  assert.deepEqual(
    events.map((event) => event.phase),
    ['stalled', 'aborted', 'resumed', 'stalled', 'aborted'],
  )
})

test('a watchdog with no abort threshold never aborts', () => {
  const { watchdog, stalls } = makeWatchdog()
  watchdog.observe(0)
  watchdog.check(600_000)
  assert.deepEqual(stalls, [600_000], 'reporting stays available on its own')
})
