import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { ExecutionJournalScopeIdentity } from '../../contracts/execution-journal.js'
import { initializeExecutionJournal } from '../../core/execution-journal.js'
import { createJournalBackedDurableDispatch } from '../../core/durable-dispatch-journal.js'

/**
 * Reading one stream must cost that stream, not the whole journal. Recovery
 * runs once per dispatch, so a journal-wide read per lookup makes a long
 * assignment quadratic in its own history.
 */

const TEST_IDENTITY: ExecutionJournalScopeIdentity = {
  scopeKind: 'assignment',
  scopeId: 'scan-cost',
  tenantId: 'tenant-test',
  sessionId: 'session-scan-cost',
  runId: 'run-scan-cost',
  assignmentId: 'assignment-scan-cost',
}

const STREAM_COUNT = 12
const EVENTS_PER_STREAM = 2

function makeScopeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'execution-journal-scan-cost-'))
}

test('reading one stream reads only that stream', async () => {
  const scopeRoot = makeScopeRoot()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    try {
      for (let stream = 0; stream < STREAM_COUNT; stream += 1) {
        for (let revision = 0; revision < EVENTS_PER_STREAM; revision += 1) {
          await journal.append({
            eventId: `event-${stream}-${revision}`,
            streamKind: 'test.stream',
            streamId: `stream-${stream}`,
            expectedStreamRevision: revision,
            type: 'test.observation',
            payloadSchemaVersion: 1,
            payload: { stream, revision },
            correlationId: `stream-${stream}`,
          })
        }
      }

      const before = journal.getMetrics().scannedEventCount
      const summary = await journal.scanStream('test.stream', 'stream-3')
      const scanned = journal.getMetrics().scannedEventCount - before

      assert.equal(summary.eventCount, EVENTS_PER_STREAM)
      assert.deepEqual(
        summary.events.map((event) => event.streamId),
        ['stream-3', 'stream-3'],
      )
      assert.deepEqual(
        summary.events.map((event) => event.streamRevision),
        [1, 2],
      )
      assert.equal(
        scanned,
        EVENTS_PER_STREAM,
        'a stream read must not traverse the whole journal',
      )
    } finally {
      await journal.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

test('concurrent appends share one lock cycle and one durability barrier', async () => {
  const scopeRoot = makeScopeRoot()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    try {
      const before = journal.getMetrics()
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, (_unused, index) =>
          journal.append({
            eventId: `concurrent-${index}`,
            streamKind: 'test.stream',
            streamId: `concurrent-${index}`,
            expectedStreamRevision: 0,
            type: 'test.observation',
            payloadSchemaVersion: 1,
            payload: { index },
            correlationId: `concurrent-${index}`,
          }),
        ),
      )
      const after = journal.getMetrics()

      // Every append is still individually durable and ordered.
      assert.deepEqual(
        outcomes.map((outcome) => outcome.kind),
        Array.from({ length: 8 }, () => 'appended'),
      )
      assert.equal(after.appendCount - before.appendCount, 8)
      assert.deepEqual(
        (await journal.scan()).events.map((event) => event.sequence),
        [1, 2, 3, 4, 5, 6, 7, 8],
      )

      // The lock cycle and fsync are the expensive parts; a batch of
      // concurrent appends must not pay them once per event.
      assert.ok(
        after.lockAcquisitionCount - before.lockAcquisitionCount <= 2,
        `expected a shared lock cycle, saw ${after.lockAcquisitionCount - before.lockAcquisitionCount}`,
      )
      assert.ok(
        after.syncCount - before.syncCount <= 2,
        `expected a shared durability barrier, saw ${after.syncCount - before.syncCount}`,
      )
    } finally {
      await journal.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

test('a rejected append in a batch does not fail its neighbours', async () => {
  const scopeRoot = makeScopeRoot()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    try {
      const results = await Promise.allSettled([
        journal.append({
          eventId: 'batch-ok-one',
          streamKind: 'test.stream',
          streamId: 'batch-ok-one',
          expectedStreamRevision: 0,
          type: 'test.observation',
          payloadSchemaVersion: 1,
          payload: { index: 1 },
          correlationId: 'batch-ok-one',
        }),
        journal.append({
          eventId: 'batch-invalid',
          streamKind: 'test.stream',
          streamId: 'batch-invalid',
          expectedStreamRevision: 0,
          type: 'test.observation',
          payloadSchemaVersion: 0,
          payload: { index: 2 },
          correlationId: 'batch-invalid',
        }),
        journal.append({
          eventId: 'batch-ok-two',
          streamKind: 'test.stream',
          streamId: 'batch-ok-two',
          expectedStreamRevision: 0,
          type: 'test.observation',
          payloadSchemaVersion: 1,
          payload: { index: 3 },
          correlationId: 'batch-ok-two',
        }),
      ])

      assert.deepEqual(
        results.map((result) => result.status),
        ['fulfilled', 'rejected', 'fulfilled'],
      )
      assert.equal((await journal.scan()).eventCount, 2)
    } finally {
      await journal.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

test('dispatch recovery reads only the stream it recovers', async () => {
  const scopeRoot = makeScopeRoot()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    try {
      const port = createJournalBackedDurableDispatch(journal)
      for (let index = 0; index < STREAM_COUNT; index += 1) {
        await port.recordRequested({
          dispatchId: `dispatch-${index}`,
          attemptId: 'attempt-one',
        })
      }

      const before = journal.getMetrics().scannedEventCount
      const recovery = await port.recover({
        dispatchId: 'dispatch-4',
        argumentDigest: 'digest',
      })
      const scanned = journal.getMetrics().scannedEventCount - before

      assert.equal(recovery.kind, 'retriable')
      assert.equal(
        scanned,
        1,
        'recovery must not traverse every dispatch in the journal',
      )
    } finally {
      await journal.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})
