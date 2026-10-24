import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ExecutionJournalError,
  type ExecutionJournalAppendInput,
  type ExecutionJournalAppendOutcome,
  type ExecutionJournalEvent,
} from '../../contracts/execution-journal.js'
import { appendJournalStreamEvent } from '../../core/journal-stream-append.js'
import type { ExecutionJournal } from '../../core/execution-journal.js'

/**
 * Recorders cache the stream revision in process. Another writer advancing
 * the same stream makes that cache stale, which is a concurrency conflict —
 * not journal corruption — and must resolve against the journal's own view.
 */

function fakeEvent(streamRevision: number): ExecutionJournalEvent {
  return {
    schemaVersion: 1,
    eventId: 'event-1',
    sequence: streamRevision,
    recordedAt: '2026-08-17T12:00:00.000Z',
    scopeKind: 'assignment',
    scopeId: 'scope',
    tenantId: 'tenant',
    streamKind: 'test.stream',
    streamId: 'stream-1',
    streamRevision,
    type: 'test.event',
    payloadSchemaVersion: 1,
    appendRequestDigest: 'a'.repeat(64),
    correlationId: 'corr',
    previousEventHash: 'b'.repeat(64),
    eventHash: 'c'.repeat(64),
    payload: {},
  }
}

function fakeJournal(
  outcomes: readonly ExecutionJournalAppendOutcome[],
): { journal: ExecutionJournal; readonly attempts: number[] } {
  const attempts: number[] = []
  let index = 0
  const journal = {
    manifest: undefined,
    journalDirectoryPath: '/unused',
    append: async (
      input: ExecutionJournalAppendInput,
    ): Promise<ExecutionJournalAppendOutcome> => {
      attempts.push(input.expectedStreamRevision)
      const outcome = outcomes[index] ?? outcomes[outcomes.length - 1]
      index += 1
      if (!outcome) throw new Error('no outcome configured')
      return outcome
    },
    scan: async () => ({
      eventCount: 0,
      lastSequence: 0,
      events: [],
      truncatedFragmentBytes: 0,
    }),
    close: async () => undefined,
    getMetrics: () => {
      throw new Error('unused')
    },
  }
  // The fake stands in for the append surface only.
  return { journal: journal as unknown as ExecutionJournal, attempts }
}

function appendInput(
  expectedStreamRevision: number,
): ExecutionJournalAppendInput {
  return {
    eventId: 'event-1',
    streamKind: 'test.stream',
    streamId: 'stream-1',
    expectedStreamRevision,
    type: 'test.event',
    payloadSchemaVersion: 1,
    payload: {},
    correlationId: 'corr',
  }
}

test('a stale revision cache is refreshed from the journal and the append lands', async () => {
  const { journal, attempts } = fakeJournal([
    { kind: 'revision-conflict', expectedRevision: 1, actualRevision: 4 },
    { kind: 'appended', event: fakeEvent(5) },
  ])

  const event = await appendJournalStreamEvent(journal, appendInput(1))

  assert.equal(event.streamRevision, 5)
  assert.deepEqual(attempts, [1, 4], 'retry must use the journal actual revision')
})

test('a persistent revision conflict is reported as a conflict, not corruption', async () => {
  const { journal } = fakeJournal([
    { kind: 'revision-conflict', expectedRevision: 1, actualRevision: 4 },
    { kind: 'revision-conflict', expectedRevision: 4, actualRevision: 9 },
  ])

  await assert.rejects(
    appendJournalStreamEvent(journal, appendInput(1)),
    (error: unknown) =>
      error instanceof ExecutionJournalError &&
      error.code === 'revision_conflict',
  )
})

test('a reused event identity with different content is reported as an identity conflict', async () => {
  const { journal } = fakeJournal([
    { kind: 'event-identity-conflict', eventId: 'event-1' },
  ])

  await assert.rejects(
    appendJournalStreamEvent(journal, appendInput(0)),
    (error: unknown) =>
      error instanceof ExecutionJournalError &&
      error.code === 'event_identity_conflict',
  )
})

test('an idempotent replay returns the already-accepted event', async () => {
  const { journal, attempts } = fakeJournal([
    { kind: 'already-accepted', event: fakeEvent(2) },
  ])

  const event = await appendJournalStreamEvent(journal, appendInput(1))

  assert.equal(event.streamRevision, 2)
  assert.deepEqual(attempts, [1])
})
