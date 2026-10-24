import assert from 'node:assert/strict'
import test from 'node:test'

import type { ExecutionJournalEvent } from '../../contracts/execution-journal.js'
import type { ExecutionJournalReadResult } from '../../core/execution-journal.js'
import {
  APPROVED_DURABLE_BUDGET_TURN_CONCURRENCY,
  APPROVED_DURABLE_JOURNAL_BUDGET,
  evaluateDurableJournalBudget,
  measureAppendsPerAcceptedDispatch,
  summarizeCapabilityDispatchDurations,
} from '../../scripts/benchmark-capability-dispatch.js'

test('capability dispatch benchmark reports deterministic nearest-rank p50 and p95 statistics', () => {
  assert.deepEqual(
    summarizeCapabilityDispatchDurations([10, 1, 8, 2, 7, 3, 6, 4, 5, 9]),
    {
      samples: 10,
      minimumMs: 1,
      p50Ms: 5,
      p95Ms: 10,
      maximumMs: 10,
    },
  )
})

test('capability dispatch benchmark rejects empty or non-finite duration sets', () => {
  assert.throws(() => summarizeCapabilityDispatchDurations([]))
  assert.throws(() => summarizeCapabilityDispatchDurations([1, Number.NaN]))
  assert.throws(() => summarizeCapabilityDispatchDurations([1, -1]))
})

/**
 * A budget nothing can fail is decoration, not a gate.
 *
 * `provisionalBudget` reports two booleans, and `process.exitCode` is assigned
 * at exactly one place in the script — inside the `.catch()` that handles a
 * thrown benchmark. No budget result reaches it, so a run whose numbers are
 * outside budget still exits 0. That is broader than N13 records: it is true of
 * the non-journal gate as well as the durable one.
 *
 * The comparison is pure, so it is pinned here rather than through a child
 * process. Thresholds are supplied by the caller: this package builds the
 * mechanism and leaves the numbers to D11.
 */
test('durable journal budget passes only when both applied thresholds hold', () => {
  assert.deepEqual(
    evaluateDurableJournalBudget(
      { serialP50Ms: 88, concurrentPerCallP50Ms: 56 },
      { serialP50Ms: 90, concurrentPerCallP50Ms: 60 },
    ),
    {
      serialP50Ms: 90,
      concurrentPerCallP50Ms: 60,
      serialP50Pass: true,
      concurrentPerCallP50Pass: true,
      pass: true,
    },
  )
})

test('durable journal budget fails when either applied threshold is exceeded', () => {
  const summary = { serialP50Ms: 88, concurrentPerCallP50Ms: 56 }

  const serialOnly = evaluateDurableJournalBudget(summary, {
    serialP50Ms: 80,
    concurrentPerCallP50Ms: 60,
  })
  assert.equal(serialOnly.serialP50Pass, false)
  assert.equal(serialOnly.concurrentPerCallP50Pass, true)
  assert.equal(serialOnly.pass, false, 'one failing threshold fails the budget')

  const concurrentOnly = evaluateDurableJournalBudget(summary, {
    serialP50Ms: 90,
    concurrentPerCallP50Ms: 50,
  })
  assert.equal(concurrentOnly.serialP50Pass, true)
  assert.equal(concurrentOnly.concurrentPerCallP50Pass, false)
  assert.equal(concurrentOnly.pass, false)
})

/**
 * D11's approved thresholds, applied by default (2026-08-22).
 *
 * Serial p50 ≤ 100 ms and normalized per-call p50 ≤ 65 ms. They are
 * deliberately wider than the plan's earlier candidates: a quiet-machine sweep
 * across the whole post-baseline range measured serial p50 between 74 and 87 ms
 * on identical code, so a bound at 80 ms would have failed roughly half of all
 * runs while catching nothing. There is no p95 gate; p95 varied by 3.3× across
 * identical runs at this sample size.
 *
 * The concurrent bound is **not** width-independent. `concurrentPerCallMs` is a
 * wave duration divided by its width, so 65 ms describes an 8-wide wave and
 * nothing else — which is why the width travels with the number.
 */
test('the approved durable budget is the default a run is held to', () => {
  assert.deepEqual(APPROVED_DURABLE_JOURNAL_BUDGET, {
    serialP50Ms: 100,
    concurrentPerCallP50Ms: 65,
  })
  assert.equal(
    APPROVED_DURABLE_BUDGET_TURN_CONCURRENCY,
    8,
    'the width the concurrent bound was calibrated at',
  )
})

test('the approved default budget fails a measurement past either bound', () => {
  const slowSerial = evaluateDurableJournalBudget(
    { serialP50Ms: 101, concurrentPerCallP50Ms: 50 },
    APPROVED_DURABLE_JOURNAL_BUDGET,
  )
  assert.equal(slowSerial.serialP50Pass, false)
  assert.equal(slowSerial.pass, false)

  const slowConcurrent = evaluateDurableJournalBudget(
    { serialP50Ms: 80, concurrentPerCallP50Ms: 66 },
    APPROVED_DURABLE_JOURNAL_BUDGET,
  )
  assert.equal(slowConcurrent.concurrentPerCallP50Pass, false)
  assert.equal(slowConcurrent.pass, false)

  const withinBoth = evaluateDurableJournalBudget(
    { serialP50Ms: 100, concurrentPerCallP50Ms: 65 },
    APPROVED_DURABLE_JOURNAL_BUDGET,
  )
  assert.equal(withinBoth.pass, true, 'the approved bounds are inclusive')
})

test('a durable journal budget threshold is inclusive at its boundary', () => {
  const boundary = evaluateDurableJournalBudget(
    { serialP50Ms: 80, concurrentPerCallP50Ms: 60 },
    { serialP50Ms: 80, concurrentPerCallP50Ms: 60 },
  )
  assert.equal(boundary.pass, true, 'equal to the budget is within it')
})

/**
 * `appendsPerSuccessfulDispatch` was a literal `5`, corroborated only by the
 * event count happening to divide evenly. These pin a derivation instead.
 *
 * "Successful" means accepted. A stream that never reached
 * `capability.dispatch.accepted` did not complete, and counting its partial
 * appends would understate the per-dispatch cost the number exists to report.
 */
test('appends per accepted dispatch counts only streams that reached accepted', () => {
  assert.equal(
    measureAppendsPerAcceptedDispatch(
      okRead([
        ...dispatchStream('one', ['requested', 'prepared', 'started', 'committed', 'accepted']),
        ...dispatchStream('two', ['requested', 'prepared', 'started', 'committed', 'accepted']),
        // Crashed after commit: four appends, never accepted. Excluded from
        // both the numerator and the denominator.
        ...dispatchStream('three', ['requested', 'prepared', 'started', 'committed']),
        // A different stream kind sharing the journal must not be counted.
        journalEvent('workflow-one', 'workflow.state', 'workflow.state.snapshot'),
      ]),
    ),
    5,
    'the shape a healthy dispatch actually has',
  )
})

/**
 * Deliberately not five.
 *
 * The case above expects exactly the value the field used to be hardcoded to,
 * so on its own it cannot tell a derivation from that literal — a mutation
 * replacing the body with `return 5` passes it. This one moves the answer off
 * that number, which is what makes the pair load-bearing.
 *
 * The six-event streams below are **synthetic**, not a lifecycle claim. No
 * assertion is made here that a real dispatch ever appends two `started`
 * events; the shape exists only to give the arithmetic an answer a constant
 * cannot match.
 */
test('appends per accepted dispatch reports what the journal holds, not a fixed five', () => {
  const sixEventAcceptedStream = [
    'requested',
    'prepared',
    'started',
    'started',
    'committed',
    'accepted',
  ]
  assert.equal(
    measureAppendsPerAcceptedDispatch(
      okRead([
        ...dispatchStream('one', sixEventAcceptedStream),
        ...dispatchStream('two', sixEventAcceptedStream),
      ]),
    ),
    6,
  )
})

test('appends per accepted dispatch fails honestly rather than reporting a number', () => {
  assert.throws(
    () => measureAppendsPerAcceptedDispatch({ kind: 'not_found' }),
    /journal/i,
    'an unreadable journal scan cannot yield a measurement',
  )
  assert.throws(
    () =>
      measureAppendsPerAcceptedDispatch(
        okRead([...dispatchStream('one', ['requested', 'prepared'])]),
      ),
    /accepted/i,
    'no accepted dispatch means there is nothing to average over',
  )
})

function dispatchStream(
  streamId: string,
  stages: readonly string[],
): readonly ExecutionJournalEvent[] {
  return stages.map((stage) =>
    journalEvent(streamId, 'capability.dispatch', `capability.dispatch.${stage}`),
  )
}

/** A real event: the production caller hands over whole journal records. */
function journalEvent(
  streamId: string,
  streamKind: string,
  type: string,
): ExecutionJournalEvent {
  return {
    schemaVersion: 1,
    eventId: `${streamId}-${type}`,
    sequence: 1,
    recordedAt: '2026-08-22T12:00:00.000Z',
    scopeKind: 'assignment',
    scopeId: 'root-run',
    tenantId: 'local',
    streamKind,
    streamId,
    streamRevision: 1,
    type,
    payloadSchemaVersion: 1,
    appendRequestDigest: 'digest',
    correlationId: 'correlation',
    previousEventHash: 'previous',
    eventHash: 'hash',
    payload: {},
  }
}

function okRead(events: readonly ExecutionJournalEvent[]): ExecutionJournalReadResult {
  return {
    kind: 'ok',
    truncatedTail: false,
    manifest: {
      schemaVersion: 1,
      scopeKind: 'assignment',
      scopeId: 'root-run',
      tenantId: 'local',
      createdAt: '2026-08-22T12:00:00.000Z',
      journalRelativePath: 'journal.jsonl',
      initialSequence: 0,
      initialPreviousEventHash: 'genesis',
      createdBy: { implementation: 'test', version: 1 },
    },
    events,
  }
}
