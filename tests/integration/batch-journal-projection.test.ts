import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { ExecutionJournalScopeIdentity } from '../../contracts/execution-journal.js'
import { initializeExecutionJournal } from '../../core/execution-journal.js'
import { BatchStore } from '../../domains/batches/batch-store.js'
import {
  BatchJournalError,
  createBatchProjectionMetadataStore,
  createJournalBackedBatchRecorder,
  importBatchExecutionBaseline,
  rebuildBatchExecutionProjection,
} from '../../domains/batches/batch-journal.js'
import type { BatchDefinition, BatchExecution, BatchItem } from '../../domains/batches/batch-types.js'

const NOW = '2026-08-17T12:00:00.000Z'

function hex64(seed: string): string {
  const base = Buffer.from(seed.padEnd(64, '0')).toString('hex').slice(0, 64)
  return base.padEnd(64, '0').slice(0, 64)
}

function makeDefinition(batchId: string): BatchDefinition {
  return {
    id: batchId,
    revision: 1,
    name: 'Test batch',
    workflowId: 'workflow-one',
    folderPath: path.join(os.tmpdir(), 'batch-input'),
    fileExtensions: ['.txt'],
    rerunPolicy: 'new_only',
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function makeItem(
  ordinal: number,
  overrides: Partial<BatchItem> = {},
): BatchItem {
  return {
    id: `item_${randomUUID()}`,
    ordinal,
    fileName: `file-${ordinal}.txt`,
    sourceSize: 100 + ordinal,
    sourceMtime: NOW,
    sourceSha256: hex64(`source-${ordinal}`),
    status: 'done',
    sessionId: `session-${ordinal}`,
    taskId: `task-${ordinal}`,
    taskExecutionAttemptId: `attempt-${ordinal}`,
    resultArtifacts: [],
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW,
    ...overrides,
  }
}

function makeExecution(
  batchId: string,
  executionId: string,
  overrides: Partial<BatchExecution> = {},
): BatchExecution {
  return {
    id: executionId,
    batchId,
    definitionSnapshot: makeDefinition(batchId),
    sourceFolderCanonicalPath: path.join(os.tmpdir(), 'batch-source'),
    sourceSnapshotSha256: hex64('snapshot'),
    status: 'running',
    items: [makeItem(0), makeItem(1)],
    retainedResultBytes: 0,
    startedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function withoutSession(item: BatchItem): BatchItem {
  const { sessionId: _sessionId, ...rest } = item
  return rest as BatchItem
}

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-journal-projection-'))
  fs.mkdirSync(path.join(root, 'workspace'), { recursive: true })
  fs.mkdirSync(path.join(root, 'journal-scope'), { recursive: true })
  return root
}

function journalIdentity(executionId: string): ExecutionJournalScopeIdentity {
  return {
    scopeKind: 'batch',
    scopeId: executionId,
    tenantId: 'local',
  }
}

test('a journaled batch execution rebuilds item outcomes and child links after its projection is deleted', async () => {
  const root = makeWorkspace()
  const workspacePath = path.join(root, 'workspace')
  const journalScope = path.join(root, 'journal-scope')
  try {
    const batchId = `batch_${randomUUID()}`
    const executionId = `exec_${randomUUID()}`
    const journal = await initializeExecutionJournal({
      scopeRoot: journalScope,
      identity: journalIdentity(executionId),
    })
    const recorder = createJournalBackedBatchRecorder(journal)
    const store = new BatchStore({ workspacePath, journal: recorder })
    await store.initialize()

    const execution = makeExecution(batchId, executionId)
    await store.writeExecution(execution)
    const before = await store.readExecution(batchId, executionId)
    assert.ok(before)
    assert.equal(before.items.length, 2)

    // Delete the projection and rebuild it from the canonical journal.
    fs.rmSync(
      path.join(workspacePath, 'task-queue', 'batches', 'executions', batchId, `${executionId}.json`),
    )
    assert.equal(await store.readExecution(batchId, executionId), null)
    await rebuildBatchExecutionProjection(journal, store, batchId, executionId)

    const after = await store.readExecution(batchId, executionId)
    assert.ok(after)
    assert.deepEqual(after, before)
    // Child assignment links survive the rebuild.
    assert.deepEqual(
      after.items.map((item) => ({
        sessionId: item.sessionId,
        taskId: item.taskId,
        taskExecutionAttemptId: item.taskExecutionAttemptId,
      })),
      [
        { sessionId: 'session-0', taskId: 'task-0', taskExecutionAttemptId: 'attempt-0' },
        { sessionId: 'session-1', taskId: 'task-1', taskExecutionAttemptId: 'attempt-1' },
      ],
    )
    await journal.close()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a rebuilt batch projection reports its lag against the journal', async () => {
  const root = makeWorkspace()
  const workspacePath = path.join(root, 'workspace')
  const journalScope = path.join(root, 'journal-scope')
  try {
    const batchId = `batch_${randomUUID()}`
    const executionId = `exec_${randomUUID()}`
    const journal = await initializeExecutionJournal({
      scopeRoot: journalScope,
      identity: journalIdentity(executionId),
    })
    const store = new BatchStore({
      workspacePath,
      journal: createJournalBackedBatchRecorder(journal),
    })
    await store.initialize()
    await store.writeExecution(makeExecution(batchId, executionId))
    await rebuildBatchExecutionProjection(journal, store, batchId, executionId)

    const metadata = createBatchProjectionMetadataStore(journal, executionId)
    assert.equal(
      await metadata.classifyLag((await journal.scan()).lastSequence),
      'current',
    )

    await journal.append({
      eventId: 'batch-lag-probe',
      streamKind: 'test',
      streamId: 'batch-lag',
      expectedStreamRevision: 0,
      type: 'test.observation',
      payloadSchemaVersion: 1,
      payload: { index: 1 },
      correlationId: 'batch-lag',
    })
    assert.equal(
      await metadata.classifyLag((await journal.scan()).lastSequence),
      'lagging',
    )
    await journal.close()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('rebuild rejects a snapshot whose child task link is missing its session link', async () => {
  const root = makeWorkspace()
  const workspacePath = path.join(root, 'workspace')
  const journalScope = path.join(root, 'journal-scope')
  try {
    const batchId = `batch_${randomUUID()}`
    const executionId = `exec_${randomUUID()}`
    const journal = await initializeExecutionJournal({
      scopeRoot: journalScope,
      identity: journalIdentity(executionId),
    })
    const recorder = createJournalBackedBatchRecorder(journal)
    const store = new BatchStore({ workspacePath, journal: recorder })
    await store.initialize()

    const forged: BatchExecution = {
      ...makeExecution(batchId, executionId),
      items: [withoutSession(makeItem(0, { taskId: 'task-orphan' }))],
    }
    await recorder.recordExecution(forged)
    await assert.rejects(
      rebuildBatchExecutionProjection(journal, store, batchId, executionId),
      (error: unknown) =>
        error instanceof BatchJournalError && error.code === 'child_link_invalid',
    )
    await journal.close()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('rebuild rejects an unsafe child execution-attempt identity', async () => {
  const root = makeWorkspace()
  const workspacePath = path.join(root, 'workspace')
  const journalScope = path.join(root, 'journal-scope')
  try {
    const batchId = `batch_${randomUUID()}`
    const executionId = `exec_${randomUUID()}`
    const journal = await initializeExecutionJournal({
      scopeRoot: journalScope,
      identity: journalIdentity(executionId),
    })
    const recorder = createJournalBackedBatchRecorder(journal)
    const store = new BatchStore({ workspacePath, journal: recorder })
    await store.initialize()

    const forged: BatchExecution = {
      ...makeExecution(batchId, executionId),
      items: [makeItem(0, { taskExecutionAttemptId: 'not a safe identity!' })],
    }
    await recorder.recordExecution(forged)
    await assert.rejects(
      rebuildBatchExecutionProjection(journal, store, batchId, executionId),
      (error: unknown) =>
        error instanceof BatchJournalError && error.code === 'child_link_invalid',
    )
    await journal.close()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a settled legacy batch execution imports and rebuilds; a running one is refused', async () => {
  const root = makeWorkspace()
  const workspacePath = path.join(root, 'workspace')
  const journalScope = path.join(root, 'journal-scope')
  try {
    const batchId = `batch_${randomUUID()}`
    const executionId = `exec_${randomUUID()}`
    // Legacy: no recorder, so the revisioned file is the authority.
    const legacyStore = new BatchStore({ workspacePath })
    await legacyStore.initialize()
    await legacyStore.writeExecution(
      makeExecution(batchId, executionId, { status: 'running' }),
    )

    const journal = await initializeExecutionJournal({
      scopeRoot: journalScope,
      identity: journalIdentity(executionId),
    })
    try {
      await assert.rejects(
        importBatchExecutionBaseline(journal, legacyStore, batchId, executionId),
        (error: unknown) => error instanceof BatchJournalError,
      )
      assert.equal((await journal.scan()).eventCount, 0)

      // Settled: the execution can no longer progress, so it may be imported.
      await legacyStore.writeExecution(
        makeExecution(batchId, executionId, { status: 'completed' }),
      )
      await importBatchExecutionBaseline(journal, legacyStore, batchId, executionId)
      const before = await legacyStore.readExecution(batchId, executionId)

      fs.rmSync(
        path.join(
          workspacePath,
          'task-queue',
          'batches',
          'executions',
          batchId,
          `${executionId}.json`,
        ),
      )
      await rebuildBatchExecutionProjection(journal, legacyStore, batchId, executionId)
      assert.deepEqual(
        await legacyStore.readExecution(batchId, executionId),
        before,
      )

      // Re-importing the same settled execution is idempotent.
      await importBatchExecutionBaseline(journal, legacyStore, batchId, executionId)
    } finally {
      await journal.close()
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
