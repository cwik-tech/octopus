import assert from 'node:assert/strict'
import test from 'node:test'

import type { ExecutionJournalEvent } from '../../contracts/execution-journal.js'
import type {
  ResearchExecutionManifest,
  ResearchJournal,
  ResearchWorkItem,
} from '../../contracts/deep-research.js'
import {
  reduceResearchSnapshot,
  RESEARCH_SNAPSHOT_EVENT_TYPE,
  RESEARCH_RUN_STREAM_KIND,
  ResearchJournalError,
} from '../../domains/deep-research/research-journal.js'

function makeManifest(
  overrides: Partial<ResearchExecutionManifest> = {},
): ResearchExecutionManifest {
  return {
    schemaVersion: 1,
    sessionId: 'session-one',
    runId: 'run-one',
    planId: 'plan-one',
    approvedPlanHash: 'ab'.repeat(32),
    maxDurationMinutes: 20,
    maxResearcherAgents: 8,
    authenticatedDomains: [],
    createdAt: '2026-08-17T12:00:00.000Z',
    ...overrides,
  }
}

function makeJournal(
  overrides: Partial<ResearchJournal> = {},
): ResearchJournal {
  return {
    schemaVersion: 1,
    revision: 0,
    ownerExecutionAttemptId: 'attempt-one',
    status: 'planned',
    correctionWave: 0,
    workItemIds: ['task-1'],
    createdAt: '2026-08-17T12:00:00.000Z',
    updatedAt: '2026-08-17T12:00:00.000Z',
    ...overrides,
  }
}

function makeWorkItem(
  overrides: Partial<ResearchWorkItem> = {},
): ResearchWorkItem {
  return {
    schemaVersion: 1,
    taskId: 'task-1',
    assignmentId: 'assignment-1',
    workerSpecHash: 'cd'.repeat(32),
    attempt: 1,
    status: 'pending',
    ...overrides,
  }
}

function makeEvent(
  payload: Record<string, unknown>,
  sequence: number,
): ExecutionJournalEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    sequence,
    recordedAt: '2026-08-17T12:00:01.000Z',
    scopeKind: 'assignment',
    scopeId: 'run-one',
    tenantId: 'local',
    streamKind: RESEARCH_RUN_STREAM_KIND,
    streamId: 'run-one',
    streamRevision: sequence,
    type: RESEARCH_SNAPSHOT_EVENT_TYPE,
    payloadSchemaVersion: 1,
    appendRequestDigest: 'ef'.repeat(32),
    correlationId: 'run-one',
    previousEventHash: '12'.repeat(32),
    eventHash: '34'.repeat(32),
    payload: payload as ExecutionJournalEvent['payload'],
  }
}

function completedWorkItem(): ResearchWorkItem {
  return makeWorkItem({
    status: 'completed',
    completedAt: '2026-08-17T12:00:02.000Z',
    receipt: {
      schemaVersion: 1,
      taskId: 'task-1',
      assignmentId: 'assignment-1',
      attempt: 1,
      workerSpecHash: 'cd'.repeat(32),
      relativePath: 'report.md',
      sha256: '56'.repeat(32),
      byteLength: 12,
      completedAt: '2026-08-17T12:00:02.000Z',
    },
  })
}

test('reduceResearchSnapshot returns the latest validated snapshot', () => {
  const manifest = makeManifest()
  const events = [
    makeEvent(
      { manifest, journal: makeJournal(), workItems: [makeWorkItem()] },
      1,
    ),
    makeEvent(
      {
        journal: makeJournal({ revision: 1, status: 'running' }),
        workItems: [makeWorkItem({ status: 'running' })],
      },
      2,
    ),
  ]
  const snapshot = reduceResearchSnapshot(events)
  assert.equal(snapshot.journal.revision, 1)
  assert.equal(snapshot.journal.status, 'running')
  assert.deepEqual(snapshot.manifest, manifest)
})

test('reduceResearchSnapshot fails closed when the manifest changes', () => {
  const events = [
    makeEvent(
      {
        manifest: makeManifest(),
        journal: makeJournal(),
        workItems: [makeWorkItem()],
      },
      1,
    ),
    makeEvent(
      {
        manifest: makeManifest({ planId: 'different-plan' }),
        journal: makeJournal({ revision: 1 }),
        workItems: [makeWorkItem()],
      },
      2,
    ),
  ]
  assert.throws(
    () => reduceResearchSnapshot(events),
    (error: unknown) =>
      error instanceof ResearchJournalError &&
      error.code === 'identity_mismatch',
  )
})

test('reduceResearchSnapshot fails closed when the revision decreases', () => {
  const manifest = makeManifest()
  const events = [
    makeEvent(
      { manifest, journal: makeJournal({ revision: 2 }), workItems: [] },
      1,
    ),
    makeEvent({ journal: makeJournal({ revision: 1 }), workItems: [] }, 2),
  ]
  assert.throws(
    () => reduceResearchSnapshot(events),
    (error: unknown) =>
      error instanceof ResearchJournalError &&
      error.code === 'revision_conflict',
  )
})

test('reduceResearchSnapshot fails closed on an owner change without a revision bump', () => {
  const manifest = makeManifest()
  const events = [
    makeEvent(
      { manifest, journal: makeJournal(), workItems: [makeWorkItem()] },
      1,
    ),
    makeEvent(
      {
        journal: makeJournal({ ownerExecutionAttemptId: 'attacker' }),
        workItems: [makeWorkItem()],
      },
      2,
    ),
  ]
  assert.throws(
    () => reduceResearchSnapshot(events),
    (error: unknown) =>
      error instanceof ResearchJournalError &&
      error.code === 'ownership_conflict',
  )
})

test('a recovery claim that bumps the revision may change the owner', () => {
  const manifest = makeManifest()
  const events = [
    makeEvent(
      { manifest, journal: makeJournal(), workItems: [makeWorkItem()] },
      1,
    ),
    makeEvent(
      {
        journal: makeJournal({
          revision: 1,
          ownerExecutionAttemptId: 'attempt-two',
        }),
        workItems: [makeWorkItem({ status: 'interrupted', attempt: 2 })],
      },
      2,
    ),
  ]
  const snapshot = reduceResearchSnapshot(events)
  assert.equal(snapshot.journal.ownerExecutionAttemptId, 'attempt-two')
})

test('completed work without a receipt is rejected', () => {
  const manifest = makeManifest()
  const events = [
    makeEvent(
      {
        manifest,
        journal: makeJournal(),
        workItems: [makeWorkItem({ status: 'completed' })],
      },
      1,
    ),
  ]
  assert.throws(
    () => reduceResearchSnapshot(events),
    (error: unknown) =>
      error instanceof ResearchJournalError &&
      // The domain work-item schema is the first gate for this rule; the
      // journal's own receipt pairing check backs it up.
      (error.code === 'missing_receipt' || error.code === 'corrupt'),
  )
})

test('a receipt that does not pair with its work item is rejected', () => {
  const manifest = makeManifest()
  const item = completedWorkItem()
  const misPaired = {
    ...item,
    receipt: { ...(item.receipt as NonNullable<typeof item.receipt>), attempt: 9 },
  }
  const events = [
    makeEvent({ manifest, journal: makeJournal(), workItems: [misPaired] }, 1),
  ]
  assert.throws(
    () => reduceResearchSnapshot(events),
    (error: unknown) =>
      error instanceof ResearchJournalError &&
      error.code === 'invalid_receipt',
  )
})

test('an unsafe error code is rejected', () => {
  const manifest = makeManifest()
  const events = [
    makeEvent(
      {
        manifest,
        journal: makeJournal(),
        workItems: [
          makeWorkItem({ status: 'failed', errorCode: 'raw model prose here' }),
        ],
      },
      1,
    ),
  ]
  assert.throws(
    () => reduceResearchSnapshot(events),
    (error: unknown) =>
      error instanceof ResearchJournalError &&
      error.code === 'unsafe_metadata',
  )
})

/**
 * A damaged or hand-edited journal must be rejected by the reducer rather
 * than dereferenced. Every payload shape the reducer reads is validated.
 */
test('reduceResearchSnapshot fails closed on a malformed snapshot payload', () => {
  const malformed: ReadonlyArray<Record<string, unknown>> = [
    { journal: 'not-an-object', workItems: [] },
    { journal: { revision: 0 }, workItems: 'not-an-array' },
    { workItems: [] },
    { journal: { revision: 0 }, workItems: [null] },
    { journal: { revision: 0 }, workItems: ['not-an-object'] },
  ]
  for (const payload of malformed) {
    assert.throws(
      () => reduceResearchSnapshot([makeEvent(payload, 1)]),
      (error: unknown) => error instanceof ResearchJournalError,
      JSON.stringify(payload),
    )
  }
})
