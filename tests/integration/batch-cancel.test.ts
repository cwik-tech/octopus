import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { WorkspaceDispatcherOwner } from '../../core/workspace-dispatcher-owner.js'
import { DefaultBatchFolderAccessPolicy } from '../../domains/batches/batch-folder-access.js'
import { BatchStore } from '../../domains/batches/batch-store.js'
import type { BatchDefinition, BatchExecution, BatchItem } from '../../domains/batches/batch-types.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { BatchAdmissionCoordinator } from '../../services/batch-admission-coordinator.js'
import { BatchService } from '../../services/batch-service.js'
import { TaskQueue } from '../../services/task-queue.js'
import { cancelSessionTask } from '../../services/task-service.js'

test('Batch cancellation persists intent before cancelling admitted work and remains terminal after restart', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-cancel-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Queued Batch item' })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'workflow',
    brief: 'Cancel this task',
  })
  assert.ok(task)
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  const definition = makeDefinition()
  await store.writeDefinitions([definition])
  await store.writeExecution(makeExecution(definition, session.id, task.id))
  let releaseCancellation!: () => void
  const cancellationReleased = new Promise<void>((resolve) => {
    releaseCancellation = resolve
  })
  let observeCancellationStart!: () => void
  const cancellationStarted = new Promise<void>((resolve) => {
    observeCancellationStart = resolve
  })
  const service = new BatchService({
    workspacePath,
    store,
    folderAccessPolicy: new DefaultBatchFolderAccessPolicy({ workspacePath, repoRootPath: workspacePath }),
    validateWorkflow: async () => true,
    cancelTask: async (sessionId, taskId) => {
      const marked = await store.readExecution(definition.id, EXECUTION_ID)
      assert.ok(marked?.cancelRequestedAt, 'cancellation intent must be durable before task cancellation')
      observeCancellationStart()
      await cancellationReleased
      return cancelSessionTask({ sessionId, taskId, sessionStore })
    },
  })
  await service.initialize()

  const response = await service.cancelExecution(definition.id, EXECUTION_ID)
  assert.ok(response.cancelRequestedAt)
  assert.equal(response.status, 'draining')
  await cancellationStarted
  releaseCancellation()
  const cancelled = await waitForExecution(store, definition.id, EXECUTION_ID, 'cancelled')
  assert.deepEqual(cancelled.items.map((item) => item.status), ['cancelled', 'cancelled'])
  assert.equal((await sessionStore.getTaskRecord(session.id, task.id))?.status, 'cancelled')

  const restartedStore = new BatchStore({ workspacePath })
  await restartedStore.initialize()
  const persisted = await restartedStore.readExecution(definition.id, EXECUTION_ID)
  assert.equal(persisted?.status, 'cancelled')
  assert.ok(persisted?.cancelRequestedAt)
})

test('Batch cancellation aborts the one in-flight preparation and prevents another admission', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-cancel-preparation-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  const definition = makeDefinition()
  const baseExecution = makeExecution(definition, 'session-unused', 'task-unused')
  const execution: BatchExecution = { ...baseExecution, items: [baseExecution.items[1]!] }
  await store.writeDefinitions([definition])
  await store.writeExecution(execution)
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const taskQueue = new TaskQueue({
    sessionStore,
    owner,
    maximumConcurrentTasks: 1,
    repoRootPath: process.cwd(),
    workspacePath,
    workflowsRegistryPath: path.join(process.cwd(), 'workflows', 'registry.yaml'),
    taskLauncher: { async startRun() { return await new Promise<never>(() => undefined) } },
    tickIntervalMs: 10,
  })
  let observeStarted!: () => void
  const started = new Promise<void>((resolve) => {
    observeStarted = resolve
  })
  let observeAborted!: () => void
  const aborted = new Promise<void>((resolve) => {
    observeAborted = resolve
  })
  const coordinator = new BatchAdmissionCoordinator({
    store,
    taskQueue,
    pollIntervalMs: 10,
    prepareItem: async ({ signal }) => {
      observeStarted()
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          observeAborted()
          reject(signal.reason)
        }, { once: true })
      })
      throw new Error('Unreachable preparation completion.')
    },
  })
  try {
    await taskQueue.initialize()
    await coordinator.initialize()
    await started
    await store.mutateExecution(definition.id, EXECUTION_ID, (current) => ({
      execution: {
        ...current,
        status: 'draining',
        cancelRequestedAt: '2026-08-06T10:01:00.000Z',
      },
      result: undefined,
    }))

    coordinator.cancelExecution(definition.id, EXECUTION_ID)

    await Promise.race([
      aborted,
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error('Preparation did not receive cancellation.')),
        500,
      )),
    ])
  } finally {
    await coordinator.close()
    await taskQueue.close(1)
    await owner.release()
  }
})

test('Batch cancellation continues across admitted items when one process cleanup fails', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-cancel-independent-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const firstSession = await sessionStore.createSession({ title: 'First cancellation' })
  const secondSession = await sessionStore.createSession({ title: 'Second cancellation' })
  const firstTask = await sessionStore.createTaskRecord(firstSession.id, {
    workflowId: 'workflow',
    brief: 'First task',
  })
  const secondTask = await sessionStore.createTaskRecord(secondSession.id, {
    workflowId: 'workflow',
    brief: 'Second task',
  })
  assert.ok(firstTask)
  assert.ok(secondTask)
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  const definition = makeDefinition()
  const baseExecution = makeExecution(definition, firstSession.id, firstTask.id)
  const execution: BatchExecution = {
    ...baseExecution,
    items: [
      baseExecution.items[0]!,
      {
        ...baseExecution.items[1]!,
        status: 'queued',
        sessionId: secondSession.id,
        taskId: secondTask.id,
      },
    ],
  }
  await store.writeDefinitions([definition])
  await store.writeExecution(execution)
  const cancellationAttempts: string[] = []
  let firstTaskAttempts = 0
  const service = new BatchService({
    workspacePath,
    store,
    folderAccessPolicy: new DefaultBatchFolderAccessPolicy({ workspacePath, repoRootPath: workspacePath }),
    validateWorkflow: async () => true,
    cancelTask: async (sessionId, taskId) => {
      cancellationAttempts.push(taskId)
      if (taskId === firstTask.id && firstTaskAttempts++ === 0) {
        throw new Error('first cleanup failed')
      }
      return cancelSessionTask({ sessionId, taskId, sessionStore })
    },
    cancellationRetryDelayMs: 1,
  })
  await service.initialize()

  await service.cancelExecution(definition.id, EXECUTION_ID)
  const deadline = Date.now() + 2_000
  while (cancellationAttempts.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  const cancelled = await waitForExecution(store, definition.id, EXECUTION_ID, 'cancelled')
  assert.deepEqual(cancellationAttempts, [firstTask.id, secondTask.id, firstTask.id])
  assert.deepEqual(cancelled.items.map((item) => item.status), ['cancelled', 'cancelled'])
  assert.match(cancelled.failureDetail ?? '', /first cleanup failed/)
})

test('Batch service retries a transient cancellation failure until the execution is terminal', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-cancel-retry-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Retry cancellation' })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'workflow',
    brief: 'Retry this cancellation',
  })
  assert.ok(task)
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  const definition = makeDefinition()
  await store.writeDefinitions([definition])
  await store.writeExecution({
    ...makeExecution(definition, session.id, task.id),
    items: [{ ...makeExecution(definition, session.id, task.id).items[0]! }],
  })
  let attempts = 0
  const service = new BatchService({
    workspacePath,
    store,
    folderAccessPolicy: new DefaultBatchFolderAccessPolicy({ workspacePath, repoRootPath: workspacePath }),
    validateWorkflow: async () => true,
    cancelTask: async (sessionId, taskId) => {
      attempts += 1
      if (attempts === 1) throw new Error('transient cancellation failure')
      return cancelSessionTask({ sessionId, taskId, sessionStore })
    },
    cancellationRetryDelayMs: 1,
  })
  await service.initialize()

  await service.cancelExecution(definition.id, EXECUTION_ID)
  const cancelled = await waitForExecution(store, definition.id, EXECUTION_ID, 'cancelled')

  assert.equal(attempts, 2)
  assert.equal(cancelled.items[0]?.status, 'cancelled')
})

test('Batch service resumes a durable draining cancellation during initialization', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-cancel-resume-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Resume cancellation' })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'workflow',
    brief: 'Resume this cancellation',
  })
  assert.ok(task)
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  const definition = makeDefinition()
  const execution = makeExecution(definition, session.id, task.id)
  await store.writeDefinitions([definition])
  await store.writeExecution({
    ...execution,
    status: 'draining',
    cancelRequestedAt: '2026-08-06T10:01:00.000Z',
    items: [execution.items[0]!],
  })
  const service = new BatchService({
    workspacePath,
    store,
    folderAccessPolicy: new DefaultBatchFolderAccessPolicy({ workspacePath, repoRootPath: workspacePath }),
    validateWorkflow: async () => true,
    cancelTask: (sessionId, taskId) => cancelSessionTask({ sessionId, taskId, sessionStore }),
    cancellationRetryDelayMs: 1,
  })

  await service.initialize()
  const cancelled = await waitForExecution(store, definition.id, EXECUTION_ID, 'cancelled')

  assert.equal(cancelled.items[0]?.status, 'cancelled')
  assert.equal((await sessionStore.getTaskRecord(session.id, task.id))?.status, 'cancelled')
})

test('Batch cancellation force-fails after its bounded retry attempts are exhausted', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-cancel-exhausted-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Exhaust cancellation' })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'workflow',
    brief: 'Exhaust this cancellation',
  })
  assert.ok(task)
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  const definition = makeDefinition()
  await store.writeDefinitions([definition])
  await store.writeExecution({
    ...makeExecution(definition, session.id, task.id),
    items: [{ ...makeExecution(definition, session.id, task.id).items[0]! }],
  })
  let attempts = 0
  const service = new BatchService({
    workspacePath,
    store,
    folderAccessPolicy: new DefaultBatchFolderAccessPolicy({ workspacePath, repoRootPath: workspacePath }),
    validateWorkflow: async () => true,
    cancelTask: async (sessionId, taskId) => {
      attempts += 1
      if (attempts <= 3) throw new Error('permanent cancellation failure')
      return cancelSessionTask({ sessionId, taskId, sessionStore })
    },
    cancellationRetryDelayMs: 1,
    cancellationMaxAttempts: 3,
  })
  await service.initialize()

  await service.cancelExecution(definition.id, EXECUTION_ID)
  const terminal = await waitForAnyTerminalExecution(store, definition.id, EXECUTION_ID)

  assert.equal(attempts, 3)
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.items[0]?.status, 'failed')
  assert.equal(terminal.items[0]?.failureCode, 'cancellation_failed')
  assert.match(terminal.failureDetail ?? '', /3 attempts.*permanent cancellation failure/i)
  await service.close()
})

test('Batch cancellation does not spend failure attempts while publication is still converging', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-cancel-publishing-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  const definition = makeDefinition()
  const base = makeExecution(definition, 'session-publishing', 'task-publishing')
  await store.writeDefinitions([definition])
  await store.writeExecution({
    ...base,
    items: [{
      ...base.items[0]!,
      status: 'publishing',
      taskExecutionAttemptId: 'attempt-publishing',
      publicationStartedAt: '2026-08-06T10:00:01.000Z',
    }],
  })
  const service = new BatchService({
    workspacePath,
    store,
    folderAccessPolicy: new DefaultBatchFolderAccessPolicy({ workspacePath, repoRootPath: workspacePath }),
    validateWorkflow: async () => true,
    cancellationRetryDelayMs: 5,
    cancellationMaxAttempts: 1,
  })
  await service.initialize()

  await service.cancelExecution(definition.id, EXECUTION_ID)
  await new Promise((resolve) => setTimeout(resolve, 150))
  const converging = await store.readExecution(definition.id, EXECUTION_ID)
  assert.equal(converging?.status, 'draining')
  assert.equal(converging.items[0]?.status, 'publishing')

  await store.mutateExecution(definition.id, EXECUTION_ID, (execution) => ({
    execution: {
      ...execution,
      items: execution.items.map((item) => ({
        ...item,
        status: 'done' as const,
        completedAt: '2026-08-06T10:00:02.000Z',
        updatedAt: '2026-08-06T10:00:02.000Z',
      })),
    },
    result: undefined,
  }))
  const cancelled = await waitForExecution(store, definition.id, EXECUTION_ID, 'cancelled')
  assert.equal(cancelled.items[0]?.status, 'done')
  await service.close()
})

test('Batch service close waits for an active cancellation drain', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-cancel-close-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Close cancellation' })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'workflow',
    brief: 'Close this cancellation',
  })
  assert.ok(task)
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  const definition = makeDefinition()
  await store.writeDefinitions([definition])
  await store.writeExecution({
    ...makeExecution(definition, session.id, task.id),
    items: [{ ...makeExecution(definition, session.id, task.id).items[0]! }],
  })
  let observeCancellation!: () => void
  const cancellationStarted = new Promise<void>((resolve) => { observeCancellation = resolve })
  let releaseCancellation!: () => void
  const cancellationReleased = new Promise<void>((resolve) => { releaseCancellation = resolve })
  const service = new BatchService({
    workspacePath,
    store,
    folderAccessPolicy: new DefaultBatchFolderAccessPolicy({ workspacePath, repoRootPath: workspacePath }),
    validateWorkflow: async () => true,
    cancelTask: async (sessionId, taskId) => {
      observeCancellation()
      await cancellationReleased
      return cancelSessionTask({ sessionId, taskId, sessionStore })
    },
  })
  await service.initialize()
  await service.cancelExecution(definition.id, EXECUTION_ID)
  await cancellationStarted

  let closeSettled = false
  const closing = service.close().then(() => { closeSettled = true })
  try {
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(closeSettled, false)
  } finally {
    releaseCancellation()
    await closing
  }
  assert.equal((await store.readExecution(definition.id, EXECUTION_ID))?.status, 'cancelled')
})

async function waitForAnyTerminalExecution(
  store: BatchStore,
  batchId: string,
  executionId: string,
): Promise<BatchExecution> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const execution = await store.readExecution(batchId, executionId)
    if (execution && ['completed', 'cancelled', 'failed'].includes(execution.status)) return execution
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for a terminal Batch execution.')
}

async function waitForExecution(
  store: BatchStore,
  batchId: string,
  executionId: string,
  status: BatchExecution['status'],
): Promise<BatchExecution> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const execution = await store.readExecution(batchId, executionId)
    if (execution?.status === status) return execution
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for Batch execution status ${status}.`)
}

const BATCH_ID = 'batch_00000000-0000-4000-8000-000000000001'
const EXECUTION_ID = 'exec_00000000-0000-4000-8000-000000000002'

function makeDefinition(): BatchDefinition {
  return {
    id: BATCH_ID,
    revision: 1,
    name: 'Cancellation',
    workflowId: 'workflow',
    folderPath: '/tmp',
    fileExtensions: [],
    rerunPolicy: 'always',
    createdAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:00:00.000Z',
  }
}

function makeExecution(
  definition: BatchDefinition,
  sessionId: string,
  taskId: string,
): BatchExecution {
  const base = (index: number): BatchItem => ({
    id: `item_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    ordinal: index - 1,
    fileName: `${index}.txt`,
    sourceSize: 1,
    sourceMtime: '2026-08-06T10:00:00.000Z',
    sourceSha256: 'a'.repeat(64),
    status: 'pending',
    resultArtifacts: [],
    createdAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:00:00.000Z',
  })
  return {
    id: EXECUTION_ID,
    batchId: definition.id,
    definitionSnapshot: definition,
    sourceFolderCanonicalPath: '/tmp',
    sourceSnapshotSha256: 'a'.repeat(64),
    status: 'running',
    items: [
      { ...base(1), status: 'queued', sessionId, taskId },
      base(2),
    ],
    retainedResultBytes: 0,
    startedAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:00:00.000Z',
  }
}
