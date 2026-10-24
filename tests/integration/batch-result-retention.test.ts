import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { DefaultBatchFolderAccessPolicy } from '../../domains/batches/batch-folder-access.js'
import { BatchStore } from '../../domains/batches/batch-store.js'
import type { BatchDefinition, BatchExecution } from '../../domains/batches/batch-types.js'
import { BatchService, BatchServiceError } from '../../services/batch-service.js'

const batchId = 'batch_00000000-0000-4000-8000-000000000001'
const executionId = 'exec_00000000-0000-4000-8000-000000000002'
const itemId = 'item_00000000-0000-4000-8000-000000000003'

test('clearing terminal Batch copies preserves the journal, artifact receipt, and rerun history', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-result-clear-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  const definition = makeDefinition(workspacePath)
  await store.writeDefinitions([definition])
  await store.writeExecution(makeExecution(definition, 'completed'))
  const resultPath = path.join(workspacePath, 'batch-results', batchId, executionId, itemId, '01-report.md')
  await fs.mkdir(path.dirname(resultPath), { recursive: true })
  await fs.writeFile(resultPath, 'report')
  const service = makeService(workspacePath, store)
  await service.initialize()

  await service.clearExecutionResults(batchId, executionId)
  await service.clearExecutionResults(batchId, executionId)

  await assert.rejects(fs.access(resultPath), { code: 'ENOENT' })
  const cleared = await store.readExecution(batchId, executionId)
  assert.equal(cleared?.retainedResultBytes, 0)
  assert.ok(cleared?.resultsClearedAt)
  assert.equal(cleared?.items[0]?.status, 'done')
  assert.equal(cleared?.items[0]?.resultArtifacts.length, 1)
})

test('Batch result clearing rejects active executions and completes a durable intent after restart', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-result-clear-restart-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  const definition = makeDefinition(workspacePath)
  await store.writeDefinitions([definition])
  await store.writeExecution(makeExecution(definition, 'running'))
  const service = makeService(workspacePath, store)
  await service.initialize()
  await assert.rejects(
    service.clearExecutionResults(batchId, executionId),
    (error) => error instanceof BatchServiceError && error.code === 'batch_execution_active',
  )

  await store.writeExecution(makeExecution(definition, 'completed'))
  const resultDirectory = path.join(workspacePath, 'batch-results', batchId, executionId)
  await fs.mkdir(resultDirectory, { recursive: true })
  await fs.writeFile(path.join(resultDirectory, 'copy.md'), 'copy')
  await store.writeResultClearIntent({
    schemaVersion: 1,
    batchId,
    executionId,
    requestedAt: '2026-08-06T11:00:00.000Z',
  })

  const restarted = new BatchStore({ workspacePath })
  await restarted.initialize()
  const recovered = await restarted.readExecution(batchId, executionId)
  assert.equal(recovered?.retainedResultBytes, 0)
  assert.equal(recovered?.resultsClearedAt, '2026-08-06T11:00:00.000Z')
  await assert.rejects(fs.access(resultDirectory), { code: 'ENOENT' })
})

test('concurrent Batch result clears join one durable cleanup operation', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-result-clear-concurrent-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  const definition = makeDefinition(workspacePath)
  await store.writeDefinitions([definition])
  await store.writeExecution(makeExecution(definition, 'completed'))

  const originalReadExecution = store.readExecution.bind(store)
  const originalWriteIntent = store.writeResultClearIntent.bind(store)
  let readCount = 0
  let intentCount = 0
  let releaseRead!: () => void
  let observeRead!: () => void
  const readReleased = new Promise<void>((resolve) => { releaseRead = resolve })
  const readStarted = new Promise<void>((resolve) => { observeRead = resolve })
  store.readExecution = async (...args) => {
    readCount += 1
    observeRead()
    await readReleased
    return originalReadExecution(...args)
  }
  store.writeResultClearIntent = async (...args) => {
    intentCount += 1
    return originalWriteIntent(...args)
  }

  const service = makeService(workspacePath, store)
  await service.initialize()
  const first = service.clearExecutionResults(batchId, executionId)
  await readStarted
  const second = service.clearExecutionResults(batchId, executionId)
  await new Promise((resolve) => setImmediate(resolve))
  releaseRead()
  await Promise.all([first, second])

  assert.equal(readCount, 1)
  assert.equal(intentCount, 1)
})

test('Batch deletion cannot cross a result clear that has started validation', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-result-clear-delete-race-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  const definition = makeDefinition(workspacePath)
  await store.writeDefinitions([definition])
  await store.writeExecution(makeExecution(definition, 'completed'))

  const originalReadExecution = store.readExecution.bind(store)
  let releaseRead!: () => void
  let observeRead!: () => void
  const readReleased = new Promise<void>((resolve) => { releaseRead = resolve })
  const readStarted = new Promise<void>((resolve) => { observeRead = resolve })
  store.readExecution = async (...args) => {
    observeRead()
    await readReleased
    return originalReadExecution(...args)
  }

  const service = makeService(workspacePath, store)
  await service.initialize()
  const clearing = service.clearExecutionResults(batchId, executionId)
  await readStarted
  try {
    await assert.rejects(
      service.delete(batchId),
      (error) => error instanceof BatchServiceError && error.code === 'batch_cleanup_active',
    )
  } finally {
    releaseRead()
    await clearing.catch(() => undefined)
  }

  assert.ok(await service.get(batchId))
})

test('Batch result clearing cannot start after deletion has entered its mutation', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-delete-result-clear-race-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  const definition = makeDefinition(workspacePath)
  await store.writeDefinitions([definition])
  await store.writeExecution(makeExecution(definition, 'completed'))
  const service = makeService(workspacePath, store)
  await service.initialize()

  const originalReadDefinitions = store.readDefinitions.bind(store)
  let releaseRead!: () => void
  let observeRead!: () => void
  const readReleased = new Promise<void>((resolve) => { releaseRead = resolve })
  const readStarted = new Promise<void>((resolve) => { observeRead = resolve })
  store.readDefinitions = async () => {
    observeRead()
    await readReleased
    return originalReadDefinitions()
  }

  const deletion = service.delete(batchId)
  await readStarted
  try {
    await assert.rejects(
      service.clearExecutionResults(batchId, executionId),
      (error) => error instanceof BatchServiceError && error.code === 'batch_cleanup_active',
    )
  } finally {
    releaseRead()
    await deletion
  }
})

function makeService(workspacePath: string, store: BatchStore): BatchService {
  return new BatchService({
    workspacePath,
    store,
    folderAccessPolicy: new DefaultBatchFolderAccessPolicy({ workspacePath, repoRootPath: workspacePath }),
    validateWorkflow: async () => true,
  })
}

function makeDefinition(workspacePath: string): BatchDefinition {
  return {
    id: batchId,
    revision: 1,
    name: 'Retention',
    workflowId: 'workflow',
    folderPath: workspacePath,
    fileExtensions: [],
    rerunPolicy: 'new_only',
    createdAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:00:00.000Z',
  }
}

function makeExecution(
  definition: BatchDefinition,
  status: 'running' | 'completed',
): BatchExecution {
  return {
    id: executionId,
    batchId,
    definitionSnapshot: definition,
    sourceFolderCanonicalPath: definition.folderPath,
    sourceSnapshotSha256: 'a'.repeat(64),
    status,
    items: [{
      id: itemId,
      ordinal: 0,
      fileName: 'source.txt',
      sourceSize: 1,
      sourceMtime: '2026-08-06T10:00:00.000Z',
      sourceSha256: 'b'.repeat(64),
      status: status === 'completed' ? 'done' : 'running',
      sessionId: 'session-1',
      taskId: 'task-1',
      resultArtifacts: [{
        role: 'final',
        sourceRunId: 'run-1',
        sourcePath: 'report.md',
        destinationPath: `${batchId}/${executionId}/${itemId}/01-report.md`,
        mediaType: 'text/markdown',
        byteLength: 6,
        sha256: 'c'.repeat(64),
      }],
      createdAt: '2026-08-06T10:00:00.000Z',
      updatedAt: '2026-08-06T10:01:00.000Z',
      ...(status === 'completed' ? { completedAt: '2026-08-06T10:01:00.000Z' } : {}),
    }],
    retainedResultBytes: 6,
    startedAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:01:00.000Z',
    ...(status === 'completed' ? { completedAt: '2026-08-06T10:01:00.000Z' } : {}),
  }
}
