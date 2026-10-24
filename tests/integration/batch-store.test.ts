import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { BatchStore } from '../../domains/batches/batch-store.js'
import type { BatchDefinition, BatchExecution } from '../../domains/batches/batch-types.js'

const BATCH_ID = 'batch_00000000-0000-4000-8000-000000000001'
const EXECUTION_ID = 'exec_00000000-0000-4000-8000-000000000002'

function definition(): BatchDefinition {
  return {
    id: BATCH_ID,
    revision: 1,
    name: 'Persisted batch',
    workflowId: 'test-workflow',
    folderPath: '/tmp/source',
    fileExtensions: [],
    rerunPolicy: 'always',
    createdAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:00:00.000Z',
  }
}

function execution(): BatchExecution {
  return {
    id: EXECUTION_ID,
    batchId: BATCH_ID,
    definitionSnapshot: definition(),
    sourceFolderCanonicalPath: '/tmp/source',
    sourceSnapshotSha256: 'b'.repeat(64),
    status: 'running',
    items: [],
    retainedResultBytes: 0,
    startedAt: '2026-08-06T10:01:00.000Z',
    updatedAt: '2026-08-06T10:01:00.000Z',
  }
}

test('Batch store atomically persists definitions and independent execution journals', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-store-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  await store.writeDefinitions([definition()])
  await store.writeExecution(execution())

  const restarted = new BatchStore({ workspacePath })
  await restarted.initialize()
  assert.deepEqual(await restarted.readDefinitions(), [definition()])
  assert.deepEqual(await restarted.readExecution(BATCH_ID, EXECUTION_ID), execution())
  assert.deepEqual((await restarted.listExecutions(BATCH_ID)).map((entry) => entry.id), [EXECUTION_ID])

  const definitionsPath = path.join(workspacePath, 'task-queue', 'batches', 'definitions.json')
  const executionPath = path.join(workspacePath, 'task-queue', 'batches', 'executions', BATCH_ID, `${EXECUTION_ID}.json`)
  assert.equal((await fs.stat(definitionsPath)).mode & 0o777, 0o600)
  assert.equal((await fs.stat(executionPath)).mode & 0o777, 0o600)
})

test('Batch store migrates legacy prompt-bearing definitions and execution snapshots', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-store-prompt-migration-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const definitionsPath = path.join(workspacePath, 'task-queue', 'batches', 'definitions.json')
  const executionPath = path.join(
    workspacePath,
    'task-queue',
    'batches',
    'executions',
    BATCH_ID,
    `${EXECUTION_ID}.json`,
  )
  await fs.mkdir(path.dirname(executionPath), { recursive: true })
  const legacyDefinition = { ...definition(), promptTemplate: 'Process {{FILE_NAME}}' }
  await fs.writeFile(definitionsPath, JSON.stringify({
    schemaVersion: 1,
    definitions: [legacyDefinition],
  }))
  await fs.writeFile(executionPath, JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    execution: { ...execution(), definitionSnapshot: legacyDefinition },
  }))

  const store = new BatchStore({ workspacePath })
  await store.initialize()

  const migratedDefinitions = JSON.parse(await fs.readFile(definitionsPath, 'utf8')) as {
    schemaVersion?: number
    definitions?: Array<Record<string, unknown>>
  }
  const migratedExecution = JSON.parse(await fs.readFile(executionPath, 'utf8')) as {
    schemaVersion?: number
    execution?: { definitionSnapshot?: Record<string, unknown> }
  }
  assert.equal(migratedDefinitions.schemaVersion, 2)
  assert.equal('promptTemplate' in migratedDefinitions.definitions![0]!, false)
  assert.equal(migratedExecution.schemaVersion, 2)
  assert.equal('promptTemplate' in migratedExecution.execution!.definitionSnapshot!, false)
})

test('Batch store fails closed without rewriting corrupt state', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-store-corrupt-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const definitionsPath = path.join(workspacePath, 'task-queue', 'batches', 'definitions.json')
  await fs.mkdir(path.dirname(definitionsPath), { recursive: true })
  await fs.writeFile(definitionsPath, '{broken')
  const store = new BatchStore({ workspacePath })

  await assert.rejects(store.initialize(), /Batch store/i)
  await assert.rejects(store.readDefinitions(), /unavailable/i)
  assert.equal(await fs.readFile(definitionsPath, 'utf8'), '{broken')
})

test('Batch store fails closed when definitions become corrupt after initialization', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-store-runtime-corrupt-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const definitionsPath = path.join(workspacePath, 'task-queue', 'batches', 'definitions.json')
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  await store.writeDefinitions([definition()])
  await fs.writeFile(definitionsPath, '{broken')

  await assert.rejects(store.readDefinitions(), (error) => {
    assert.equal(error instanceof Error && error.name, 'BatchStoreUnavailableError')
    return true
  })
  await fs.writeFile(definitionsPath, JSON.stringify({ schemaVersion: 2, definitions: [] }))
  await assert.rejects(store.readDefinitions(), /unavailable/i)
})

test('Batch store fails closed when an execution becomes corrupt after initialization', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-store-runtime-execution-corrupt-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const executionPath = path.join(
    workspacePath,
    'task-queue',
    'batches',
    'executions',
    BATCH_ID,
    `${EXECUTION_ID}.json`,
  )
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  await store.writeExecution(execution())
  await fs.writeFile(executionPath, '{broken')

  await assert.rejects(store.readExecution(BATCH_ID, EXECUTION_ID), (error) => {
    assert.equal(error instanceof Error && error.name, 'BatchStoreUnavailableError')
    return true
  })
  await assert.rejects(store.listExecutions(BATCH_ID), /unavailable/i)
})
