import assert from 'node:assert/strict'
import test from 'node:test'

import type { ExecutionJournalEvent } from '../../contracts/execution-journal.js'
import type { BatchExecution, BatchItem } from '../../domains/batches/batch-types.js'
import {
  BATCH_EXECUTION_STREAM_KIND,
  isBatchBaselineEligible,
  BATCH_SNAPSHOT_EVENT_TYPE,
  BatchJournalError,
  reduceBatchExecutionStream,
} from '../../domains/batches/batch-journal.js'

// The reducer validates payloads with the domain schema, so fixtures use
// real batch identity formats rather than placeholders.
const BATCH_ID = 'batch_11111111-2222-4333-8444-555555555555'
const EXECUTION_ID = 'exec_66666666-7777-4888-8999-aaaaaaaaaaaa'
const ITEM_ID = 'item_bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
const OTHER_ITEM_ID = 'item_dddddddd-eeee-4fff-8000-111111111111'

function makeItem(overrides: Partial<BatchItem> = {}): BatchItem {
  return {
    id: ITEM_ID,
    ordinal: 0,
    fileName: 'file.txt',
    sourceSize: 10,
    sourceMtime: '2026-08-17T12:00:00.000Z',
    sourceSha256: 'ab'.repeat(32),
    status: 'done',
    sessionId: 'session-1',
    taskId: 'task-1',
    taskExecutionAttemptId: 'attempt-1',
    resultArtifacts: [],
    createdAt: '2026-08-17T12:00:00.000Z',
    updatedAt: '2026-08-17T12:00:00.000Z',
    completedAt: '2026-08-17T12:00:00.000Z',
    ...overrides,
  }
}

function makeExecution(overrides: Partial<BatchExecution> = {}): BatchExecution {
  return {
    id: EXECUTION_ID,
    batchId: BATCH_ID,
    definitionSnapshot: {
      id: BATCH_ID,
      revision: 1,
      name: 'Batch',
      workflowId: 'workflow-one',
      folderPath: '/tmp/source',
      fileExtensions: ['.txt'],
      rerunPolicy: 'new_only',
      createdAt: '2026-08-17T12:00:00.000Z',
      updatedAt: '2026-08-17T12:00:00.000Z',
    },
    sourceFolderCanonicalPath: '/tmp/source',
    sourceSnapshotSha256: 'cd'.repeat(32),
    status: 'running',
    items: [makeItem()],
    retainedResultBytes: 0,
    startedAt: '2026-08-17T12:00:00.000Z',
    updatedAt: '2026-08-17T12:00:00.000Z',
    ...overrides,
  }
}

function makeEvent(execution: BatchExecution, sequence: number): ExecutionJournalEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    sequence,
    recordedAt: '2026-08-17T12:00:01.000Z',
    scopeKind: 'batch',
    scopeId: EXECUTION_ID,
    tenantId: 'local',
    streamKind: BATCH_EXECUTION_STREAM_KIND,
    streamId: EXECUTION_ID,
    streamRevision: sequence,
    type: BATCH_SNAPSHOT_EVENT_TYPE,
    payloadSchemaVersion: 1,
    appendRequestDigest: 'ef'.repeat(32),
    correlationId: EXECUTION_ID,
    previousEventHash: '12'.repeat(32),
    eventHash: '34'.repeat(32),
    payload: { execution } as unknown as ExecutionJournalEvent['payload'],
  }
}

test('reduceBatchExecutionStream returns the latest snapshot', () => {
  const events = [
    makeEvent(makeExecution({ status: 'running' }), 1),
    makeEvent(makeExecution({ status: 'completed' }), 2),
  ]
  const execution = reduceBatchExecutionStream(events, BATCH_ID, EXECUTION_ID)
  assert.equal(execution.status, 'completed')
})

test('reduceBatchExecutionStream fails closed on an identity mismatch', () => {
  const otherBatchId = 'batch_99999999-8888-4777-8666-555555555555'
  const other = makeExecution({ batchId: otherBatchId })
  const events = [
    makeEvent(
      { ...other, definitionSnapshot: { ...other.definitionSnapshot, id: otherBatchId } },
      1,
    ),
  ]
  assert.throws(
    () => reduceBatchExecutionStream(events, BATCH_ID, EXECUTION_ID),
    (error: unknown) =>
      error instanceof BatchJournalError && error.code === 'identity_mismatch',
  )
})

test('reduceBatchExecutionStream fails closed on duplicated item ids', () => {
  const events = [
    makeEvent(
      makeExecution({ items: [makeItem(), makeItem({ ordinal: 1 })] }),
      1,
    ),
  ]
  // Duplicate identities are rejected by the domain schema the reducer parses
  // the payload with, before the journal's own item rules run.
  assert.throws(
    () => reduceBatchExecutionStream(events, BATCH_ID, EXECUTION_ID),
    (error: unknown) =>
      error instanceof BatchJournalError && (error.code === 'corrupt' || error.code === 'item_invalid'),
  )
})

test('a child task link without a session link is rejected', () => {
  const orphan = makeItem({ taskId: 'task-orphan' })
  const { sessionId: _sessionId, ...withoutSession } = orphan
  const events = [
    makeEvent(
      makeExecution({ items: [withoutSession as BatchItem] }),
      1,
    ),
  ]
  assert.throws(
    () => reduceBatchExecutionStream(events, BATCH_ID, EXECUTION_ID),
    (error: unknown) =>
      error instanceof BatchJournalError && error.code === 'child_link_invalid',
  )
})

test('an unsafe child execution-attempt identity is rejected', () => {
  const events = [
    makeEvent(
      makeExecution({
        items: [makeItem({ taskExecutionAttemptId: 'unsafe identity!' })],
      }),
      1,
    ),
  ]
  assert.throws(
    () => reduceBatchExecutionStream(events, BATCH_ID, EXECUTION_ID),
    (error: unknown) =>
      error instanceof BatchJournalError && error.code === 'child_link_invalid',
  )
})

test('a valid child link passes', () => {
  const events = [makeEvent(makeExecution(), 1)]
  const execution = reduceBatchExecutionStream(events, BATCH_ID, EXECUTION_ID)
  assert.equal(execution.items[0]?.taskId, 'task-1')
  assert.equal(execution.items[0]?.sessionId, 'session-1')
})

/**
 * A journal file can be damaged or hand-edited. The reducer is the fail-closed
 * boundary for that, so a payload that does not carry a well-formed execution
 * must be reported as corruption rather than trusted or thrown through as a
 * runtime type error.
 */
test('reduceBatchExecutionStream fails closed on a malformed execution payload', () => {
  const malformed: ReadonlyArray<unknown> = [
    { execution: 'not-an-object' },
    { execution: { batchId: BATCH_ID, id: EXECUTION_ID, items: 'not-an-array' } },
    { execution: { batchId: BATCH_ID, id: EXECUTION_ID, items: [null] } },
    { execution: { batchId: BATCH_ID, id: EXECUTION_ID, items: [{ id: 5 }] } },
    {},
  ]
  for (const payload of malformed) {
    const event = {
      ...makeEvent(makeExecution(), 1),
      payload: payload as ExecutionJournalEvent['payload'],
    }
    assert.throws(
      () => reduceBatchExecutionStream([event], BATCH_ID, EXECUTION_ID),
      (error: unknown) =>
        error instanceof BatchJournalError &&
        (error.code === 'corrupt' || error.code === 'item_invalid'),
      JSON.stringify(payload),
    )
  }
})

/**
 * A batch execution that can still progress must not change authorities
 * mid-flight, matching the workflow rule (ADR §9).
 */
test('batch baseline eligibility admits only settled executions', () => {
  const resumable = ['pending', 'running', 'draining'] as const
  const settled = ['completed', 'cancelled', 'failed'] as const
  for (const status of resumable) {
    assert.equal(
      isBatchBaselineEligible(makeExecution({ status })),
      false,
      status,
    )
  }
  for (const status of settled) {
    assert.equal(
      isBatchBaselineEligible(makeExecution({ status })),
      true,
      status,
    )
  }
})
