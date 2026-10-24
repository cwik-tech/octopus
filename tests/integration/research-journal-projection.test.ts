import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { ExecutionJournalScopeIdentity } from '../../contracts/execution-journal.js'
import { initializeExecutionJournal } from '../../core/execution-journal.js'
import {
  FileSystemResearchRunStore,
  type InitializeResearchRunInput,
} from '../../domains/deep-research/deep-research-store.js'
import {
  createJournalBackedResearchRecorder,
  createResearchProjectionMetadataStore,
  rebuildResearchProjection,
  ResearchJournalError,
} from '../../domains/deep-research/research-journal.js'
import { hashResearchValue } from '../../domains/deep-research/deep-research-worker-policy.js'

const TEST_TIME = '2026-08-17T12:00:00.000Z'
const NEXT_TIME = '2026-08-17T12:00:01.000Z'

function makeAssignmentPath(): string {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), 'research-journal-projection-'),
  )
  const assignmentPath = path.join(workspace, 'assignments', 'run-one')
  fs.mkdirSync(assignmentPath, { recursive: true })
  return assignmentPath
}

function workspaceOf(assignmentPath: string): string {
  return path.dirname(path.dirname(assignmentPath))
}

function journalIdentity(): ExecutionJournalScopeIdentity {
  return {
    scopeKind: 'assignment',
    scopeId: 'run-one',
    tenantId: 'local',
    sessionId: 'session-one',
    runId: 'run-one',
    assignmentId: 'run-one',
  }
}

function initializationInput(): InitializeResearchRunInput {
  return {
    manifest: {
      sessionId: 'session-one',
      runId: 'run-one',
      planId: 'plan-one',
      approvedPlanHash: hashResearchValue('approved-plan'),
      maxDurationMinutes: 20,
      maxResearcherAgents: 8,
      authenticatedDomains: [],
      createdAt: TEST_TIME,
    },
    executionAttemptId: 'attempt-one',
    workItems: [
      {
        taskId: 'task-1',
        assignmentId: 'assignment-1',
        workerSpecHash: hashResearchValue('worker-1'),
      },
      {
        taskId: 'task-2',
        assignmentId: 'assignment-2',
        workerSpecHash: hashResearchValue('worker-2'),
      },
    ],
  }
}

test('a journaled research run rebuilds the same snapshot after its projection is deleted', async () => {
  const assignmentPath = makeAssignmentPath()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot: assignmentPath,
      identity: journalIdentity(),
    })
    const recorder = createJournalBackedResearchRecorder(journal)
    const store = new FileSystemResearchRunStore(assignmentPath, {
      now: () => new Date(NEXT_TIME),
      journal: recorder,
    })

    await store.initialize(initializationInput())
    // Plan -> running.
    await store.updateJournal({
      expectedRevision: 0,
      executionAttemptId: 'attempt-one',
      mutate: (draft) => {
        draft.status = 'running'
      },
    })
    // Rejected attempt: start then fail task-1.
    await store.beginWorkItem({
      taskId: 'task-1',
      expectedAttempt: 1,
      executionAttemptId: 'attempt-one',
    })
    await store.markWorkItemFailed({
      taskId: 'task-1',
      expectedAttempt: 1,
      executionAttemptId: 'attempt-one',
      errorCode: 'provider_timeout',
    })
    // Correction wave 1.
    await store.updateJournal({
      expectedRevision: 1,
      executionAttemptId: 'attempt-one',
      mutate: (draft) => {
        draft.status = 'correcting'
        draft.correctionWave = 1
      },
    })
    // Accepted retry: restart task-1 (attempt 2) and commit an artifact receipt.
    await store.beginWorkItem({
      taskId: 'task-1',
      expectedAttempt: 1,
      executionAttemptId: 'attempt-one',
    })
    const artifactPath = path.join(assignmentPath, 'report.md')
    fs.writeFileSync(artifactPath, '# Research findings\n', 'utf8')
    await store.commitWorkItemReceipt({
      taskId: 'task-1',
      assignmentId: 'assignment-1',
      attempt: 2,
      workerSpecHash: hashResearchValue('worker-1'),
      relativePath: 'report.md',
      completedAt: NEXT_TIME,
    })
    // Start task-2 then claim recovery with a new owner.
    await store.beginWorkItem({
      taskId: 'task-2',
      expectedAttempt: 1,
      executionAttemptId: 'attempt-one',
    })
    await store.claimExecutionAttempt({
      expectedRevision: 2,
      expectedOwnerExecutionAttemptId: 'attempt-one',
      nextExecutionAttemptId: 'attempt-two',
    })

    const before = await store.requireSnapshot()
    assert.equal(before.journal.ownerExecutionAttemptId, 'attempt-two')

    // Delete the projection (manifest + journal + work items) and rebuild.
    fs.rmSync(store.paths.manifestPath)
    fs.rmSync(store.paths.journalPath)
    fs.rmSync(store.paths.workItemsPath, { recursive: true, force: true })
    await rebuildResearchProjection(journal, store)

    const after = await store.requireSnapshot()
    assert.deepEqual(after, before)
    await journal.close()
  } finally {
    fs.rmSync(workspaceOf(assignmentPath), { recursive: true, force: true })
  }
})

test('a rebuilt research projection reports its lag against the journal', async () => {
  const assignmentPath = makeAssignmentPath()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot: assignmentPath,
      identity: journalIdentity(),
    })
    const store = new FileSystemResearchRunStore(assignmentPath, {
      now: () => new Date(NEXT_TIME),
      journal: createJournalBackedResearchRecorder(journal),
    })
    await store.initialize(initializationInput())
    await rebuildResearchProjection(journal, store)

    const metadata = createResearchProjectionMetadataStore(journal)
    assert.equal(
      await metadata.classifyLag((await journal.scan()).lastSequence),
      'current',
    )

    await journal.append({
      eventId: 'research-lag-probe',
      streamKind: 'test',
      streamId: 'research-lag',
      expectedStreamRevision: 0,
      type: 'test.observation',
      payloadSchemaVersion: 1,
      payload: { index: 1 },
      correlationId: 'research-lag',
    })
    assert.equal(
      await metadata.classifyLag((await journal.scan()).lastSequence),
      'lagging',
    )
    await journal.close()
  } finally {
    fs.rmSync(path.dirname(path.dirname(assignmentPath)), {
      recursive: true,
      force: true,
    })
  }
})

test('rebuild rejects a snapshot whose receipt is mis-paired with its work item', async () => {
  const assignmentPath = makeAssignmentPath()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot: assignmentPath,
      identity: journalIdentity(),
    })
    const recorder = createJournalBackedResearchRecorder(journal)
    const store = new FileSystemResearchRunStore(assignmentPath, {
      now: () => new Date(NEXT_TIME),
      journal: recorder,
    })
    const initialized = await store.initialize(initializationInput())

    const forged = {
      ...initialized,
      workItems: initialized.workItems.map((item) =>
        item.taskId === 'task-1'
          ? {
              ...item,
              status: 'completed' as const,
              completedAt: NEXT_TIME,
              receipt: {
                schemaVersion: 1 as const,
                taskId: 'task-1',
                assignmentId: 'assignment-OTHER',
                attempt: 1,
                workerSpecHash: hashResearchValue('worker-1'),
                relativePath: 'report.md',
                sha256: 'ab'.repeat(32),
                byteLength: 10,
                completedAt: NEXT_TIME,
              },
            }
          : item,
      ),
    }
    await recorder.recordSnapshot(forged)
    await assert.rejects(
      rebuildResearchProjection(journal, store),
      (error: unknown) =>
        error instanceof ResearchJournalError &&
        error.code === 'invalid_receipt',
    )
    await journal.close()
  } finally {
    fs.rmSync(workspaceOf(assignmentPath), { recursive: true, force: true })
  }
})

test('rebuild rejects a completed work item that omits its receipt', async () => {
  const assignmentPath = makeAssignmentPath()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot: assignmentPath,
      identity: journalIdentity(),
    })
    const recorder = createJournalBackedResearchRecorder(journal)
    const store = new FileSystemResearchRunStore(assignmentPath, {
      now: () => new Date(NEXT_TIME),
      journal: recorder,
    })
    const initialized = await store.initialize(initializationInput())

    const forged = {
      ...initialized,
      workItems: initialized.workItems.map((item) =>
        item.taskId === 'task-1'
          ? { ...item, status: 'completed' as const, completedAt: NEXT_TIME }
          : item,
      ),
    }
    await recorder.recordSnapshot(forged)
    await assert.rejects(
      rebuildResearchProjection(journal, store),
      (error: unknown) =>
        error instanceof ResearchJournalError &&
        // The domain work-item schema rejects this first; the journal's own
        // receipt pairing rule backs it up.
        (error.code === 'missing_receipt' || error.code === 'corrupt'),
    )
    await journal.close()
  } finally {
    fs.rmSync(workspaceOf(assignmentPath), { recursive: true, force: true })
  }
})

test('rebuild rejects unsafe outcome metadata in a failed work item', async () => {
  const assignmentPath = makeAssignmentPath()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot: assignmentPath,
      identity: journalIdentity(),
    })
    const recorder = createJournalBackedResearchRecorder(journal)
    const store = new FileSystemResearchRunStore(assignmentPath, {
      now: () => new Date(NEXT_TIME),
      journal: recorder,
    })
    const initialized = await store.initialize(initializationInput())

    const rawResponseText =
      'Here is the raw model response with arbitrary prose that must never ' +
      'become authoritative journal content.'
    const forged = {
      ...initialized,
      workItems: initialized.workItems.map((item) =>
        item.taskId === 'task-1'
          ? { ...item, status: 'failed' as const, errorCode: rawResponseText }
          : item,
      ),
    }
    await recorder.recordSnapshot(forged)
    await assert.rejects(
      rebuildResearchProjection(journal, store),
      (error: unknown) =>
        error instanceof ResearchJournalError &&
        error.code === 'unsafe_metadata',
    )
    await journal.close()
  } finally {
    fs.rmSync(workspaceOf(assignmentPath), { recursive: true, force: true })
  }
})

test('a journal attached to an in-flight research run still rebuilds', async () => {
  const assignmentPath = makeAssignmentPath()
  try {
    // The run already exists on disk under the legacy authority; the journal
    // is attached afterwards, so its first event is a mid-run snapshot.
    const legacyStore = new FileSystemResearchRunStore(assignmentPath, {
      now: () => new Date(NEXT_TIME),
    })
    await legacyStore.initialize(initializationInput())
    const existing = await legacyStore.requireSnapshot()
    assert.ok(existing)

    const journal = await initializeExecutionJournal({
      scopeRoot: assignmentPath,
      identity: journalIdentity(),
    })
    const recorder = createJournalBackedResearchRecorder(journal)
    await recorder.recordSnapshot(existing)

    const store = new FileSystemResearchRunStore(assignmentPath, {
      now: () => new Date(NEXT_TIME),
      journal: recorder,
    })
    await rebuildResearchProjection(journal, store)

    const rebuilt = await store.requireSnapshot()
    assert.ok(rebuilt)
    assert.deepEqual(rebuilt.manifest, existing.manifest)
    assert.deepEqual(rebuilt.journal, existing.journal)
    await journal.close()
  } finally {
    fs.rmSync(path.dirname(path.dirname(assignmentPath)), {
      recursive: true,
      force: true,
    })
  }
})
