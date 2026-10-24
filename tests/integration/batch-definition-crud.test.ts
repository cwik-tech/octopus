import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { DefaultBatchFolderAccessPolicy } from '../../domains/batches/batch-folder-access.js'
import { BatchStore } from '../../domains/batches/batch-store.js'
import { BatchService, BatchServiceError } from '../../services/batch-service.js'

const IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
]

test('Batch service persists revision-checked definitions and immutable execution snapshots', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-crud-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const sourcePath = path.join(workspacePath, 'source')
  await fs.mkdir(sourcePath)
  await fs.writeFile(path.join(sourcePath, 'one.txt'), 'one')
  const store = new BatchStore({ workspacePath })
  let idIndex = 0
  const service = new BatchService({
    workspacePath,
    store,
    folderAccessPolicy: new DefaultBatchFolderAccessPolicy({
      workspacePath,
      repoRootPath: workspacePath,
    }),
    validateWorkflow: async (workflowId) => workflowId === 'test-workflow',
    randomUUID: () => IDS[idIndex++]!,
    now: () => new Date('2026-08-06T10:00:00.000Z'),
  })
  await service.initialize()

  const created = await service.create({
    name: 'Files',
    workflowId: 'test-workflow',
    folderPath: sourcePath,
    fileExtensions: ['txt'],
    rerunPolicy: 'new_and_changed',
  })
  assert.equal(created.revision, 1)
  assert.equal(created.folderPath, await fs.realpath(sourcePath))
  assert.equal((await service.list()).length, 1)

  const updated = await service.update(created.id, {
    expectedRevision: 1,
    name: 'Renamed',
  })
  assert.equal(updated.revision, 2)
  await assert.rejects(
    service.update(created.id, { expectedRevision: 1, name: 'Stale' }),
    (error) => error instanceof BatchServiceError && error.code === 'batch_definition_changed',
  )

  const preflight = await service.preflight(created.id)
  assert.equal(preflight.fileCount, 1)
  assert.equal(preflight.selectedCount, 1)
  const execution = await service.runNow(created.id)
  assert.equal(execution.definitionSnapshot.name, 'Renamed')
  assert.equal(execution.items.length, 1)
  assert.equal(execution.items[0]?.status, 'pending')

  await assert.rejects(
    service.delete(created.id),
    (error) => error instanceof BatchServiceError && error.code === 'batch_active',
  )
  await store.writeExecution({
    ...execution,
    status: 'completed',
    items: execution.items.map((item) => ({
      ...item,
      status: 'done' as const,
      completedAt: '2026-08-06T10:02:00.000Z',
      updatedAt: '2026-08-06T10:02:00.000Z',
    })),
    completedAt: '2026-08-06T10:02:00.000Z',
    updatedAt: '2026-08-06T10:02:00.000Z',
  })
  await service.delete(created.id)
  assert.equal(await service.get(created.id), null)
})

test('Batch service reuses successful exact-name history and rejects empty folders', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-rerun-service-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const sourcePath = path.join(workspacePath, 'source')
  await fs.mkdir(sourcePath)
  const store = new BatchStore({ workspacePath })
  let counter = 10
  const service = new BatchService({
    workspacePath,
    store,
    folderAccessPolicy: new DefaultBatchFolderAccessPolicy({ workspacePath, repoRootPath: workspacePath }),
    validateWorkflow: async () => true,
    randomUUID: () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`,
  })
  await service.initialize()
  const batch = await service.create({
    name: 'Empty first',
    workflowId: 'workflow',
    folderPath: sourcePath,
    fileExtensions: [],
    rerunPolicy: 'new_only',
  })
  const canonicalSourcePath = await fs.realpath(sourcePath)
  await assert.rejects(
    service.runNow(batch.id),
    (error) => {
      assert.ok(error instanceof BatchServiceError)
      assert.equal(error.code, 'batch_has_no_matching_files')
      assert.deepEqual(error.details?.preflight, {
        canonicalFolderPath: canonicalSourcePath,
        fileCount: 0,
        selectedCount: 0,
        totalBytes: 0,
        extensionCounts: {},
        requiresConfirmation: false,
        sourceSnapshotSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        files: [],
      })
      return true
    },
  )

  await fs.writeFile(path.join(sourcePath, 'A.txt'), 'one')
  const first = await service.runNow(batch.id)
  await store.writeExecution({
    ...first,
    status: 'completed',
    items: first.items.map((entry) => ({
      ...entry,
      status: 'done' as const,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  const second = await service.runNow(batch.id)
  assert.equal(second.status, 'completed')
  assert.equal(second.items[0]?.status, 'skipped')
  assert.equal(second.items[0]?.skipReason, 'already_processed')
})

test('Batch summaries report partially completed when one file finishes and another is blocked', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-partial-summary-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const sourcePath = path.join(workspacePath, 'source')
  await fs.mkdir(sourcePath)
  const store = new BatchStore({ workspacePath })
  const service = new BatchService({
    workspacePath,
    store,
    folderAccessPolicy: new DefaultBatchFolderAccessPolicy({
      workspacePath,
      repoRootPath: workspacePath,
    }),
    validateWorkflow: async () => true,
    randomUUID: () => '00000000-0000-4000-8000-000000000080',
  })
  await service.initialize()
  const batch = await service.create({
    name: 'Pitch decks',
    workflowId: 'pitch-deck-evaluation',
    folderPath: sourcePath,
    fileExtensions: ['.pdf'],
    rerunPolicy: 'always',
  })
  await store.writeExecution({
    id: 'exec_00000000-0000-4000-8000-000000000081',
    batchId: batch.id,
    definitionSnapshot: batch,
    sourceFolderCanonicalPath: sourcePath,
    sourceSnapshotSha256: 'a'.repeat(64),
    status: 'completed',
    items: [
      {
        id: 'item_00000000-0000-4000-8000-000000000082',
        ordinal: 0,
        fileName: 'finished.pdf',
        sourceSize: 1,
        sourceMtime: '2026-08-06T10:00:00.000Z',
        sourceSha256: 'b'.repeat(64),
        status: 'done',
        resultArtifacts: [],
        createdAt: '2026-08-06T10:00:00.000Z',
        updatedAt: '2026-08-06T10:02:00.000Z',
        completedAt: '2026-08-06T10:02:00.000Z',
      },
      {
        id: 'item_00000000-0000-4000-8000-000000000083',
        ordinal: 1,
        fileName: 'blocked.pdf',
        sourceSize: 1,
        sourceMtime: '2026-08-06T10:00:00.000Z',
        sourceSha256: 'c'.repeat(64),
        status: 'blocked',
        failureCode: 'task_blocked',
        failureDetail: 'Expected final artifact was not produced.',
        resultArtifacts: [],
        createdAt: '2026-08-06T10:00:00.000Z',
        updatedAt: '2026-08-06T10:03:00.000Z',
        completedAt: '2026-08-06T10:03:00.000Z',
      },
    ],
    retainedResultBytes: 0,
    startedAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:03:00.000Z',
    completedAt: '2026-08-06T10:03:00.000Z',
  })

  const listed = await service.list()

  assert.equal(listed[0]?.latestExecution?.status, 'partially_completed')
})

test('Batch run computes rerun selection from history read inside the commit', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-rerun-commit-history-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const sourcePath = path.join(workspacePath, 'source')
  await fs.mkdir(sourcePath)
  await fs.writeFile(path.join(sourcePath, 'A.txt'), 'one')
  const store = new BatchStore({ workspacePath })
  let validationCount = 0
  let releaseCommit!: () => void
  let observeCommit!: () => void
  const commitReleased = new Promise<void>((resolve) => { releaseCommit = resolve })
  const commitStarted = new Promise<void>((resolve) => { observeCommit = resolve })
  let counter = 40
  const service = new BatchService({
    workspacePath,
    store,
    folderAccessPolicy: new DefaultBatchFolderAccessPolicy({ workspacePath, repoRootPath: workspacePath }),
    validateWorkflow: async () => {
      validationCount += 1
      if (validationCount === 3) {
        observeCommit()
        await commitReleased
      }
      return true
    },
    randomUUID: () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`,
  })
  await service.initialize()
  const batch = await service.create({
    name: 'Commit history',
    workflowId: 'workflow',
    folderPath: sourcePath,
    fileExtensions: ['.txt'],
    rerunPolicy: 'new_only',
  })

  const running = service.runNow(batch.id)
  await commitStarted
  await store.writeExecution({
    id: 'exec_00000000-0000-4000-8000-000000000099',
    batchId: batch.id,
    definitionSnapshot: batch,
    sourceFolderCanonicalPath: sourcePath,
    sourceSnapshotSha256: 'a'.repeat(64),
    status: 'completed',
    items: [{
      id: 'item_00000000-0000-4000-8000-000000000098',
      ordinal: 0,
      fileName: 'A.txt',
      sourceSize: 3,
      sourceMtime: '2026-08-06T10:00:00.000Z',
      sourceSha256: 'b'.repeat(64),
      status: 'done',
      resultArtifacts: [],
      createdAt: '2026-08-06T10:00:00.000Z',
      updatedAt: '2026-08-06T10:01:00.000Z',
      completedAt: '2026-08-06T10:01:00.000Z',
    }],
    retainedResultBytes: 0,
    startedAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:01:00.000Z',
    completedAt: '2026-08-06T10:01:00.000Z',
  })
  releaseCommit()

  const execution = await running
  assert.equal(execution.status, 'completed')
  assert.equal(execution.items[0]?.status, 'skipped')
  assert.equal(execution.items[0]?.skipReason, 'already_processed')
})

test('Batch run revalidates folder access immediately before committing its execution', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-run-access-race-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const sourcePath = path.join(workspacePath, 'source')
  await fs.mkdir(sourcePath)
  await fs.writeFile(path.join(sourcePath, 'one.txt'), 'one')
  const canonicalSource = await fs.realpath(sourcePath)
  const store = new BatchStore({ workspacePath })
  let accessChecks = 0
  let counter = 20
  const service = new BatchService({
    workspacePath,
    store,
    folderAccessPolicy: {
      async resolveAllowedFolder() {
        accessChecks += 1
        return accessChecks < 3 ? canonicalSource : null
      },
    },
    validateWorkflow: async () => true,
    randomUUID: () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`,
  })
  await service.initialize()
  const batch = await service.create({
    name: 'Access race',
    workflowId: 'workflow',
    folderPath: sourcePath,
    fileExtensions: ['.txt'],
    rerunPolicy: 'always',
  })

  await assert.rejects(
    service.runNow(batch.id),
    (error) => error instanceof BatchServiceError && error.code === 'folder_access_denied',
  )
  assert.deepEqual(await store.listExecutions(batch.id), [])
})

test('Batch run refuses to commit while its owning TaskQueue is recovering', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-queue-recovering-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const sourcePath = path.join(workspacePath, 'source')
  await fs.mkdir(sourcePath)
  await fs.writeFile(path.join(sourcePath, 'one.txt'), 'one')
  const store = new BatchStore({ workspacePath })
  const service = new BatchService({
    workspacePath,
    store,
    folderAccessPolicy: new DefaultBatchFolderAccessPolicy({
      workspacePath,
      repoRootPath: workspacePath,
    }),
    validateWorkflow: async () => true,
    isTaskQueueReady: () => false,
    randomUUID: () => '00000000-0000-4000-8000-000000000030',
  })
  await service.initialize()
  const batch = await service.create({
    name: 'Queue recovering',
    workflowId: 'workflow',
    folderPath: sourcePath,
    fileExtensions: ['.txt'],
    rerunPolicy: 'always',
  })

  await assert.rejects(
    service.runNow(batch.id),
    (error) => error instanceof BatchServiceError && error.code === 'task_queue_recovering',
  )
  assert.deepEqual(await store.listExecutions(batch.id), [])
})
