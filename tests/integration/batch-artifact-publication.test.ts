import test from 'node:test'
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { BatchStore } from '../../domains/batches/batch-store.js'
import type { BatchDefinition, BatchExecution, BatchItem } from '../../domains/batches/batch-types.js'
import { FileSystemSessionStore, type SessionStore } from '../../domains/sessions/session-store.js'
import {
  BatchAdmissionCoordinator,
  reconcileBatchExecutions,
} from '../../services/batch-admission-coordinator.js'
import { BatchArtifactWriter } from '../../services/batch-artifact-writer.js'
import type { RunPlanTaskQueue } from '../../services/run-orchestrator-service.js'

const batchId = 'batch_00000000-0000-4000-8000-000000000001'
const executionId = 'exec_00000000-0000-4000-8000-000000000002'
const itemId = 'item_00000000-0000-4000-8000-000000000003'

test('Batch artifact publication copies the complete verified text and binary set atomically and idempotently', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-artifacts-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const assignmentPath = path.join(workspacePath, 'assignments', 'child-run')
  await fs.mkdir(assignmentPath, { recursive: true })
  const markdown = Buffer.from('# Final report\n', 'utf8')
  const docx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10])
  await fs.writeFile(path.join(assignmentPath, 'report.md'), markdown)
  await fs.writeFile(path.join(assignmentPath, 'report.docx'), docx)
  const writer = new BatchArtifactWriter({
    workspacePath,
    runStore: new FileSystemRunStore(workspacePath),
  })
  const verified = [
    artifact('primary', 'report.md', markdown),
    artifact('secondary', 'report.docx', docx),
  ] as const

  const first = await writer.publish({ batchId, executionId, itemId, artifacts: verified })
  assert.equal(first.status, 'published')
  if (first.status !== 'published') return
  assert.deepEqual(first.artifacts.map((entry) => ({
    role: entry.role,
    destinationPath: entry.destinationPath,
    byteLength: entry.byteLength,
    sha256: entry.sha256,
  })), [
    {
      role: 'final',
      destinationPath: `${batchId}/${executionId}/${itemId}/01-report.md`,
      byteLength: markdown.byteLength,
      sha256: sha256(markdown),
    },
    {
      role: 'secondary',
      destinationPath: `${batchId}/${executionId}/${itemId}/02-report.docx`,
      byteLength: docx.byteLength,
      sha256: sha256(docx),
    },
  ])
  const itemDirectory = path.join(workspacePath, 'batch-results', batchId, executionId, itemId)
  assert.equal(await fs.readFile(path.join(itemDirectory, '01-report.md'), 'utf8'), markdown.toString())
  assert.deepEqual(await fs.readFile(path.join(itemDirectory, '02-report.docx')), docx)
  assert.equal((await fs.stat(path.join(itemDirectory, '02-report.docx'))).mode & 0o777, 0o600)

  const second = await writer.publish({ batchId, executionId, itemId, artifacts: verified })
  assert.deepEqual(second, first)
  await fs.rm(assignmentPath, { recursive: true, force: true })
  assert.deepEqual(await fs.readFile(path.join(itemDirectory, '02-report.docx')), docx)
})

test('Batch artifact publication rejects an out-of-bounds set without a partial result directory', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-artifact-limits-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const writer = new BatchArtifactWriter({
    workspacePath,
    runStore: new FileSystemRunStore(workspacePath),
  })
  const result = await writer.publish({
    batchId,
    executionId,
    itemId,
    artifacts: [{
      role: 'primary',
      childRunId: 'child-run',
      path: 'too-large.docx',
      byteLength: 25 * 1024 * 1024 + 1,
      sha256: 'a'.repeat(64),
    }],
  })

  assert.deepEqual(result, {
    status: 'failed',
    code: 'artifact_too_large',
    detail: 'A verified artifact exceeds the 25 MiB per-artifact limit.',
  })
  await assert.rejects(
    fs.access(path.join(workspacePath, 'batch-results', batchId, executionId, itemId)),
    { code: 'ENOENT' },
  )
})

test('Batch artifact publication fsyncs the parent directory after its atomic rename', async () => {
  const source = await fs.readFile(
    path.join(process.cwd(), 'services', 'batch-artifact-writer.ts'),
    'utf8',
  )

  assert.match(
    source,
    /await fs\.rename\(temporaryDirectory, itemDirectory\)[\s\S]*?await syncDirectory\(executionDirectory\)/,
  )
})

test('Batch reconciliation promotes a done task through verified publication and retains its receipt bytes', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-artifact-lifecycle-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const assignmentPath = path.join(workspacePath, 'assignments', 'child-run')
  await fs.mkdir(assignmentPath, { recursive: true })
  const markdown = Buffer.from('# Reconciled report\n')
  await fs.writeFile(path.join(assignmentPath, 'report.md'), markdown)
  const verified = [artifact('primary', 'report.md', markdown)] as const
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  const definition = makeDefinition()
  await store.writeDefinitions([definition])
  await store.writeExecution(makePublishingExecution(definition))
  const artifactWriter = new BatchArtifactWriter({
    workspacePath,
    runStore: new FileSystemRunStore(workspacePath),
  })

  await reconcileBatchExecutions({
    store,
    sessionStore: new FileSystemSessionStore(workspacePath),
    artifactWriter,
    publicationResolver: async () => ({ status: 'ready', artifacts: verified }),
  })

  const execution = await store.readExecution(batchId, executionId)
  assert.equal(execution?.status, 'completed')
  assert.equal(execution?.items[0]?.status, 'done')
  assert.equal(execution?.retainedResultBytes, markdown.byteLength)
  assert.equal(execution?.items[0]?.resultArtifacts[0]?.role, 'final')
})

test('Batch coordinator admits pending work while publication runs and awaits publication on close', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-artifact-background-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  const publishingDefinition = makeDefinition()
  const pendingDefinition: BatchDefinition = {
    ...makeDefinition(),
    id: 'batch_00000000-0000-4000-8000-000000000011',
    name: 'Pending lifecycle',
  }
  const pendingExecutionId = 'exec_00000000-0000-4000-8000-000000000012'
  const pendingItemId = 'item_00000000-0000-4000-8000-000000000013'
  const pendingItem: BatchItem = {
    id: pendingItemId,
    ordinal: 0,
    fileName: 'pending.txt',
    sourceSize: 1,
    sourceMtime: '2026-08-06T10:00:00.000Z',
    sourceSha256: 'c'.repeat(64),
    status: 'pending',
    resultArtifacts: [],
    createdAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:00:00.000Z',
  }
  const pendingExecution: BatchExecution = {
    id: pendingExecutionId,
    batchId: pendingDefinition.id,
    definitionSnapshot: pendingDefinition,
    sourceFolderCanonicalPath: '/tmp',
    sourceSnapshotSha256: 'd'.repeat(64),
    status: 'running',
    items: [pendingItem],
    retainedResultBytes: 0,
    startedAt: '2026-08-06T10:00:01.000Z',
    updatedAt: '2026-08-06T10:00:01.000Z',
  }
  await store.writeDefinitions([publishingDefinition, pendingDefinition])
  await store.writeExecution(makePublishingExecution(publishingDefinition))
  await store.writeExecution(pendingExecution)
  let publicationStartedResolve!: () => void
  const publicationStarted = new Promise<void>((resolve) => { publicationStartedResolve = resolve })
  let releasePublication!: () => void
  const publicationRelease = new Promise<void>((resolve) => { releasePublication = resolve })
  const sessionStore = {
    async resolveTaskPublication() {
      return { status: 'ready' as const, artifacts: [] }
    },
  } as unknown as SessionStore
  const artifactWriter = {
    async publish() {
      publicationStartedResolve()
      await publicationRelease
      return { status: 'published' as const, artifacts: [], retainedBytes: 0 }
    },
  }
  const taskQueue = {
    maximumConcurrentTasks: 1,
    isReady: () => true,
  } as unknown as RunPlanTaskQueue & { readonly maximumConcurrentTasks: number }
  let preparedResolve!: () => void
  const prepared = new Promise<void>((resolve) => { preparedResolve = resolve })
  const coordinator = new BatchAdmissionCoordinator({
    store,
    sessionStore,
    taskQueue,
    artifactWriter,
    pollIntervalMs: 60_000,
    prepareItem: async ({ batchId: candidateBatchId, executionId: candidateExecutionId, itemId }) => {
      const result = await store.mutateExecution(candidateBatchId, candidateExecutionId, (execution) => {
        const next = { ...execution.items[0]!, status: 'queued' as const }
        return {
          execution: { ...execution, items: [next] },
          result: next,
        }
      })
      assert.equal(itemId, pendingItemId)
      preparedResolve()
      return result
    },
  })
  let initializeSettled = false
  const initialization = coordinator.initialize().then(() => { initializeSettled = true })

  try {
    await publicationStarted
    let admissionTimeout: NodeJS.Timeout | undefined
    const admissionResult = await Promise.race([
      prepared.then(() => 'prepared' as const),
      new Promise<'blocked'>((resolve) => {
        admissionTimeout = setTimeout(() => resolve('blocked'), 1_000)
      }),
    ])
    if (admissionTimeout) clearTimeout(admissionTimeout)
    assert.equal(
      admissionResult,
      'prepared',
      coordinator.failure?.message ?? 'artifact publication must not block preparation',
    )
    assert.equal(initializeSettled, true)

    let closeSettled = false
    const closing = coordinator.close().then(() => { closeSettled = true })
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(closeSettled, false, 'coordinator close must await tracked publication')
    releasePublication()
    await closing
  } finally {
    releasePublication()
    await initialization
    await coordinator.close()
  }
})

test('Batch coordinator terminally fails a publishing item when its resolver throws', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-artifact-resolver-throw-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  const definition = makeDefinition()
  await store.writeDefinitions([definition])
  await store.writeExecution(makePublishingExecution(definition))
  let resolverCalls = 0
  const sessionStore = {
    async resolveTaskPublication() {
      resolverCalls += 1
      throw new Error('publication resolver unavailable')
    },
  } as unknown as SessionStore
  const taskQueue = {
    maximumConcurrentTasks: 1,
    isReady: () => true,
  } as unknown as RunPlanTaskQueue & { readonly maximumConcurrentTasks: number }
  const coordinator = new BatchAdmissionCoordinator({
    store,
    sessionStore,
    taskQueue,
    artifactWriter: {
      async publish() {
        throw new Error('artifact writer must not be reached')
      },
    },
    pollIntervalMs: 10,
    prepareItem: async () => { throw new Error('preparation must not run') },
  })

  try {
    await coordinator.initialize()
    const failed = await waitForItemStatus(store, 'artifact_failed')

    assert.equal(failed.status, 'completed')
    assert.equal(failed.items[0]?.failureCode, 'artifact_copy_failed')
    assert.match(failed.items[0]?.failureDetail ?? '', /publication resolver unavailable/)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(resolverCalls, 1)
  } finally {
    await coordinator.close()
  }
})

async function waitForItemStatus(
  store: BatchStore,
  status: BatchItem['status'],
): Promise<BatchExecution> {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    const execution = await store.readExecution(batchId, executionId)
    if (execution?.items[0]?.status === status) return execution
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for Batch item status ${status}.`)
}

function artifact(role: 'primary' | 'secondary', artifactPath: string, content: Buffer) {
  return {
    role,
    childRunId: 'child-run',
    path: artifactPath,
    byteLength: content.byteLength,
    sha256: sha256(content),
  }
}

function sha256(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

function makeDefinition(): BatchDefinition {
  return {
    id: batchId,
    revision: 1,
    name: 'Artifact lifecycle',
    workflowId: 'workflow',
    folderPath: '/tmp',
    fileExtensions: [],
    rerunPolicy: 'always',
    createdAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:00:00.000Z',
  }
}

function makePublishingExecution(definition: BatchDefinition): BatchExecution {
  return {
    id: executionId,
    batchId,
    definitionSnapshot: definition,
    sourceFolderCanonicalPath: '/tmp',
    sourceSnapshotSha256: 'a'.repeat(64),
    status: 'running',
    items: [{
      id: itemId,
      ordinal: 0,
      fileName: 'report.txt',
      sourceSize: 1,
      sourceMtime: '2026-08-06T10:00:00.000Z',
      sourceSha256: 'b'.repeat(64),
      status: 'publishing',
      sessionId: 'session-1',
      taskId: 'task-1',
      taskExecutionAttemptId: 'attempt-1',
      publicationStartedAt: '2026-08-06T10:01:00.000Z',
      resultArtifacts: [],
      createdAt: '2026-08-06T10:00:00.000Z',
      updatedAt: '2026-08-06T10:01:00.000Z',
    }],
    retainedResultBytes: 0,
    startedAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:01:00.000Z',
  }
}
