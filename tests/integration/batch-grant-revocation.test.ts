import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { DefaultBatchFolderAccessPolicy } from '../../domains/batches/batch-folder-access.js'
import { BatchFolderGrantStore } from '../../domains/batches/batch-folder-grant-store.js'
import { BatchStore } from '../../domains/batches/batch-store.js'
import type { BatchDefinition, BatchExecution, BatchItem } from '../../domains/batches/batch-types.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { parseFileNotExpected } from '../support/file-parser-launcher-doubles.js'
import {
  BatchAdmissionCoordinator,
  prepareBatchItem,
} from '../../services/batch-admission-coordinator.js'
import type { RunPlanTaskQueue } from '../../services/run-orchestrator-service.js'

test('revoking an external Batch grant aborts preparation and fails unadmitted files closed', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-grant-revoke-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspacePath = path.join(root, 'workspace')
  const externalPath = path.join(root, 'external')
  await fs.mkdir(workspacePath, { recursive: true })
  await fs.mkdir(externalPath, { recursive: true })
  const grantStore = new BatchFolderGrantStore(path.join(root, 'batch-folder-grants.json'))
  await grantStore.initialize()
  await grantStore.grant(externalPath)
  const policy = new DefaultBatchFolderAccessPolicy({
    workspacePath,
    repoRootPath: workspacePath,
    listGrants: () => grantStore.list(),
  })
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  const definition = makeDefinition(externalPath)
  await store.writeDefinitions([definition])
  await store.writeExecution(makeExecution(definition, externalPath))
  const queue = {
    maximumConcurrentTasks: 1,
    isReady: () => true,
  } as unknown as RunPlanTaskQueue & { readonly maximumConcurrentTasks: number }
  let startedResolve!: () => void
  const started = new Promise<void>((resolve) => { startedResolve = resolve })
  let abortedResolve!: () => void
  const aborted = new Promise<void>((resolve) => { abortedResolve = resolve })
  const coordinator = new BatchAdmissionCoordinator({
    store,
    taskQueue: queue,
    pollIntervalMs: 10,
    prepareItem: async ({ batchId, executionId, itemId, signal }) => {
      const preparing = await store.mutateExecution(batchId, executionId, (execution) => {
        const item = execution.items.find((candidate) => candidate.id === itemId)!
        const next = { ...item, status: 'preparing' as const, preparationPhase: 'intent_persisted' as const }
        return {
          execution: { ...execution, items: execution.items.map((candidate) => candidate.id === itemId ? next : candidate) },
          result: next,
        }
      })
      startedResolve()
      await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => {
        abortedResolve()
        reject(signal.reason)
      }, { once: true }))
      return preparing
    },
  })
  let grantReconciliation = Promise.resolve()
  const unsubscribe = grantStore.subscribe(() => {
    grantReconciliation = coordinator.reconcileFolderAccess(policy)
  })

  try {
    await coordinator.initialize()
    await started
    assert.equal(await grantStore.revoke(externalPath), true)
    await grantReconciliation
    await aborted

    const execution = await store.readExecution(definition.id, EXECUTION_ID)
    assert.deepEqual(execution?.items.map((item) => [item.status, item.failureCode]), [
      ['setup_failed', 'folder_access_revoked'],
      ['setup_failed', 'folder_access_revoked'],
    ])
  } finally {
    unsubscribe()
    await coordinator.close()
  }
})

test('revoking a grant lets an already staged item finish from its immutable session copy', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-grant-revoke-staged-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspacePath = path.join(root, 'workspace')
  const externalPath = path.join(root, 'external')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(externalPath, { recursive: true }),
  ])
  const grantStore = new BatchFolderGrantStore(path.join(root, 'batch-folder-grants.json'))
  await grantStore.initialize()
  await grantStore.grant(externalPath)
  const policy = new DefaultBatchFolderAccessPolicy({
    workspacePath,
    repoRootPath: workspacePath,
    listGrants: () => grantStore.list(),
  })
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  const definition = makeDefinition(externalPath)
  await store.writeDefinitions([definition])
  await store.writeExecution(makeExecution(definition, externalPath))
  const queue = {
    maximumConcurrentTasks: 1,
    isReady: () => true,
  } as unknown as RunPlanTaskQueue & { readonly maximumConcurrentTasks: number }
  let stagedResolve!: () => void
  const staged = new Promise<void>((resolve) => { stagedResolve = resolve })
  let releaseResolve!: () => void
  const release = new Promise<void>((resolve) => { releaseResolve = resolve })
  let aborted = false
  const coordinator = new BatchAdmissionCoordinator({
    store,
    taskQueue: queue,
    pollIntervalMs: 10,
    prepareItem: async ({ batchId, executionId, itemId, signal }) => {
      const preparing = await store.mutateExecution(batchId, executionId, (execution) => {
        const item = execution.items.find((candidate) => candidate.id === itemId)!
        const next = {
          ...item,
          status: 'preparing' as const,
          preparationPhase: 'file_staged' as const,
          sessionId: 'session-staged',
        }
        return {
          execution: {
            ...execution,
            items: execution.items.map((candidate) => candidate.id === itemId ? next : candidate),
          },
          result: next,
        }
      })
      signal.addEventListener('abort', () => { aborted = true }, { once: true })
      stagedResolve()
      await release
      return store.mutateExecution(batchId, executionId, (execution) => {
        const next = { ...preparing, status: 'queued' as const, taskId: 'task-staged' }
        return {
          execution: {
            ...execution,
            items: execution.items.map((candidate) => candidate.id === itemId ? next : candidate),
          },
          result: next,
        }
      })
    },
  })

  try {
    await coordinator.initialize()
    await staged
    await grantStore.revoke(externalPath)
    await coordinator.reconcileFolderAccess(policy)

    const duringRevocation = await store.readExecution(definition.id, EXECUTION_ID)
    assert.equal(aborted, false)
    assert.deepEqual(duringRevocation?.items.map((item) => [item.status, item.failureCode]), [
      ['preparing', undefined],
      ['setup_failed', 'folder_access_revoked'],
    ])

    releaseResolve()
    await waitFor(() => coordinator.preparing === undefined)
    const completedPreparation = await store.readExecution(definition.id, EXECUTION_ID)
    assert.equal(completedPreparation?.items[0]?.status, 'queued')
  } finally {
    releaseResolve()
    await coordinator.close()
  }
})

test('revoking a grant fences an unstaged preparation before a stale phase write', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-grant-revoke-fence-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspacePath = path.join(root, 'workspace')
  const externalPath = path.join(root, 'external')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(externalPath, { recursive: true }),
  ])
  await fs.writeFile(path.join(externalPath, '1.txt'), 'Batch source')
  const grantStore = new BatchFolderGrantStore(path.join(root, 'batch-folder-grants.json'))
  await grantStore.initialize()
  await grantStore.grant(externalPath)
  const policy = new DefaultBatchFolderAccessPolicy({
    workspacePath,
    repoRootPath: workspacePath,
    listGrants: () => grantStore.list(),
  })
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  const definition = makeDefinition(externalPath)
  const execution = makeExecution(definition, externalPath)
  await store.writeDefinitions([definition])
  await store.writeExecution({ ...execution, items: [execution.items[0]!] })
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const queue = {
    maximumConcurrentTasks: 1,
    isReady: () => true,
  } as unknown as RunPlanTaskQueue & { readonly maximumConcurrentTasks: number }
  let sessionCreationStartedResolve!: () => void
  const sessionCreationStarted = new Promise<void>((resolve) => {
    sessionCreationStartedResolve = resolve
  })
  let releaseSessionCreation!: () => void
  const sessionCreationRelease = new Promise<void>((resolve) => {
    releaseSessionCreation = resolve
  })
  let parserCalled = false
  const coordinator = new BatchAdmissionCoordinator({
    store,
    taskQueue: queue,
    pollIntervalMs: 60_000,
    prepareItem: (item) => prepareBatchItem({
      ...item,
      store,
      sessionStore,
      createSession: async (input) => {
        sessionCreationStartedResolve()
        await sessionCreationRelease
        return sessionStore.createSession(input)
      },
      folderAccessPolicy: policy,
      fileParserLauncher: {
        async parseDirectory() {
          parserCalled = true
          throw new Error('Parser must not run after revocation wins the transition.')
        },
        parseFile: parseFileNotExpected,
      },
      taskQueue: queue,
      workspacePath,
      repoRootPath: process.cwd(),
      workflowsRegistryPath: path.join(process.cwd(), 'workflows', 'registry.yaml'),
    }),
  })

  try {
    await coordinator.initialize()
    await sessionCreationStarted
    assert.equal(await grantStore.revoke(externalPath), true)
    let reconciliationSettled = false
    const reconciliation = coordinator.reconcileFolderAccess(policy).then(() => {
      reconciliationSettled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(reconciliationSettled, false, 'revocation must wait for unstaged preparation to stop')

    releaseSessionCreation()
    await reconciliation
    const revoked = await store.readExecution(definition.id, EXECUTION_ID)
    assert.equal(parserCalled, false)
    assert.deepEqual(revoked?.items[0], {
      ...execution.items[0],
      status: 'setup_failed',
      preparationPhase: 'intent_persisted',
      failureCode: 'folder_access_revoked',
      failureDetail: 'Batch folder access was revoked.',
      completedAt: revoked?.items[0]?.completedAt,
      updatedAt: revoked?.items[0]?.updatedAt,
    })
  } finally {
    releaseSessionCreation()
    await coordinator.close()
  }
})

const BATCH_ID = 'batch_00000000-0000-4000-8000-000000000091'
const EXECUTION_ID = 'exec_00000000-0000-4000-8000-000000000092'

function makeDefinition(folderPath: string): BatchDefinition {
  return {
    id: BATCH_ID,
    revision: 1,
    name: 'Revocation',
    workflowId: 'workflow',
    folderPath,
    fileExtensions: ['.txt'],
    rerunPolicy: 'always',
    createdAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:00:00.000Z',
  }
}

function makeExecution(definition: BatchDefinition, folderPath: string): BatchExecution {
  const item = (index: number): BatchItem => ({
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
    sourceFolderCanonicalPath: folderPath,
    sourceSnapshotSha256: 'b'.repeat(64),
    status: 'running',
    items: [item(1), item(2)],
    retainedResultBytes: 0,
    startedAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:00:00.000Z',
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Batch coordinator.')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
