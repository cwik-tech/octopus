import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { WorkspaceDispatcherOwner } from '../../core/workspace-dispatcher-owner.js'
import { BatchStore } from '../../domains/batches/batch-store.js'
import type { BatchDefinition, BatchExecution, BatchItem } from '../../domains/batches/batch-types.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { BatchAdmissionCoordinator } from '../../services/batch-admission-coordinator.js'
import {
  applyRunPlanService,
  createRunPlanService,
  type RunPlanTaskQueue,
} from '../../services/run-orchestrator-service.js'
import { TaskQueue } from '../../services/task-queue.js'

test('global Batch coordinator retains one combined TaskQueue footprint and visits executions round-robin', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-global-admission-'))
  t.after(() => fs.rm(workspacePath, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 20,
  }))
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  const first = makeExecution(1)
  const second = makeExecution(2)
  await store.writeDefinitions([first.definitionSnapshot, second.definitionSnapshot])
  await store.writeExecution(first)
  await store.writeExecution(second)
  // This fixture holds launches before a worker exists. Admission order must
  // not depend on whether filesystem work crosses the launch recovery grace.
  const now = () => new Date('2026-10-10T00:00:00.000Z')
  const sessionStore = new FileSystemSessionStore(workspacePath, { now })
  const workflowsRegistryPath = await writeWorkflowRegistry(path.join(workspacePath, 'workflow-fixture'))
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const taskQueue = new TaskQueue({
    sessionStore,
    owner,
    maximumConcurrentTasks: 2,
    repoRootPath: process.cwd(),
    workspacePath,
    workflowsRegistryPath,
    taskLauncher: { async startRun() { return await new Promise<never>(() => undefined) } },
    tickIntervalMs: 10,
    now,
  })
  const prepared: string[] = []
  let prepareStage = 'idle'
  const coordinator = new BatchAdmissionCoordinator({
    store,
    sessionStore,
    taskQueue,
    pollIntervalMs: 10,
    prepareItem: async ({ batchId, executionId, itemId }) => {
      prepareStage = `session:${itemId}`
      const session = await sessionStore.createSession({ title: itemId })
      prepareStage = `plan:${itemId}`
      const plan = await createRunPlanService({
        sessionId: session.id,
        sessionStore,
        repoRootPath: process.cwd(),
        workflowsRegistryPath,
        workflowId: 'batch-test-workflow',
        goal: itemId,
      })
      prepareStage = `apply:${itemId}`
      const applied = await applyRunPlanService({
        sessionId: session.id,
        sessionStore,
        taskQueue,
        repoRootPath: process.cwd(),
        workspacePath,
        workflowsRegistryPath,
        plan,
        admissionSource: 'batch',
      })
      assert.equal(applied.ok, true)
      if (!applied.ok) throw new Error('Batch fixture task was not admitted')
      const task = applied.task
      prepareStage = `patch:${itemId}`
      prepared.push(`${executionId}:${itemId}`)
      return store.mutateExecution(batchId, executionId, (execution) => {
        const item = execution.items.find((entry) => entry.id === itemId)!
        const next = { ...item, status: 'queued' as const, sessionId: session.id, taskId: task.id }
        return {
          execution: {
            ...execution,
            items: execution.items.map((entry) => entry.id === itemId ? next : entry),
          },
          result: next,
        }
      })
    },
  })

  try {
    await taskQueue.initialize()
    await coordinator.initialize()
    await waitFor(
      () => prepared.length === 3,
      10_000,
      () => `prepared=${prepared.length}; stage=${prepareStage}; preparing=${coordinator.preparing ?? 'none'}; ${coordinator.failure?.message ?? 'no failure'}`,
    )
    assert.deepEqual(prepared.map((entry) => entry.split(':')[0]), [first.id, second.id, first.id])
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(prepared.length, 3)
    const queue = await taskQueue.snapshot()
    assert.equal(queue.slotsInUse, 2)
    assert.equal(queue.waitingCount, 1)

    const interactiveSession = await sessionStore.createSession({ title: 'Interactive' })
    const interactivePlan = await createRunPlanService({
      sessionId: interactiveSession.id,
      sessionStore,
      repoRootPath: process.cwd(),
      workflowsRegistryPath,
      workflowId: 'batch-test-workflow',
      goal: 'Analyze this interactive operational request and produce a detailed written recommendation.',
    })
    const interactiveApplied = await applyRunPlanService({
      sessionId: interactiveSession.id,
      sessionStore,
      taskQueue,
      repoRootPath: process.cwd(),
      workspacePath,
      workflowsRegistryPath,
      plan: interactivePlan,
    })
    assert.equal(
      interactiveApplied.ok,
      true,
      interactiveApplied.ok ? undefined : `${interactiveApplied.status}: ${'error' in interactiveApplied ? interactiveApplied.error : ''}`,
    )
    const withInteractive = await taskQueue.snapshot()
    assert.ok(withInteractive.items.some((item) =>
      item.sessionId === interactiveSession.id && item.source === 'apply',
    ))
    assert.equal(prepared.length, 3)

    await taskQueue.updateMaximumConcurrentTasks(1, async () => undefined)
    coordinator.wake()
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(prepared.length, 3)
    await taskQueue.updateMaximumConcurrentTasks(3, async () => undefined)
    coordinator.wake()
    await waitFor(() => prepared.length === 4, 10_000)
  } finally {
    await coordinator.close()
    await taskQueue.close(1)
    await owner.release()
  }
})

test('Batch coordinator contains a transient pump failure and clears it after recovery', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-pump-recovery-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  let readinessChecks = 0
  const taskQueue = {
    maximumConcurrentTasks: 1,
    isReady() {
      readinessChecks += 1
      if (readinessChecks === 1) throw new Error('transient coordinator dependency failure')
      return false
    },
  } as unknown as RunPlanTaskQueue & { readonly maximumConcurrentTasks: number }
  const coordinator = new BatchAdmissionCoordinator({
    store,
    taskQueue,
    pollIntervalMs: 60_000,
    prepareItem: async () => {
      throw new Error('No item should be prepared in this fixture.')
    },
  })

  try {
    await coordinator.initialize()
    await waitFor(() => coordinator.failure?.message === 'transient coordinator dependency failure')

    coordinator.wake()
    await waitFor(() => coordinator.failure === undefined)
  } finally {
    await coordinator.close()
  }
})

test('Batch coordinator treats Node abort errors as cancellation without recording a failure', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-node-abort-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  const execution = makeExecution(7)
  await store.writeDefinitions([execution.definitionSnapshot])
  await store.writeExecution({ ...execution, items: [execution.items[0]!] })
  const taskQueue = {
    maximumConcurrentTasks: 1,
    isReady: () => true,
  } as unknown as RunPlanTaskQueue & { readonly maximumConcurrentTasks: number }
  let startedResolve!: () => void
  const started = new Promise<void>((resolve) => { startedResolve = resolve })
  const coordinator = new BatchAdmissionCoordinator({
    store,
    taskQueue,
    pollIntervalMs: 60_000,
    prepareItem: async ({ batchId, executionId, itemId }) => {
      await store.mutateExecution(batchId, executionId, (current) => ({
        execution: {
          ...current,
          items: current.items.map((item) => item.id === itemId
            ? { ...item, status: 'preparing' as const, preparationPhase: 'intent_persisted' as const }
            : item),
        },
        result: undefined,
      }))
      startedResolve()
      const error = new Error('The operation was aborted.') as Error & { code: string }
      error.name = 'AbortError'
      error.code = 'ABORT_ERR'
      throw error
    },
  })

  try {
    await coordinator.initialize()
    await started
    await waitFor(() => coordinator.preparing === undefined)
    assert.equal(coordinator.failure, undefined)
  } finally {
    await coordinator.close()
  }
})

function makeExecution(index: number): BatchExecution {
  const suffix = String(index).padStart(12, '0')
  const batchId = `batch_00000000-0000-4000-8000-${suffix}`
  const definition: BatchDefinition = {
    id: batchId,
    revision: 1,
    name: `Batch ${index}`,
    workflowId: 'batch-test',
    folderPath: '/tmp',
    fileExtensions: [],
    rerunPolicy: 'always',
    createdAt: `2026-08-06T10:00:0${index}.000Z`,
    updatedAt: `2026-08-06T10:00:0${index}.000Z`,
  }
  const items: BatchItem[] = Array.from({ length: 5 }, (_, itemIndex) => ({
    id: `item_00000000-0000-4000-8000-${String(index * 100 + itemIndex).padStart(12, '0')}`,
    ordinal: itemIndex,
    fileName: `${itemIndex}.txt`,
    sourceSize: 1,
    sourceMtime: '2026-08-06T10:00:00.000Z',
    sourceSha256: String(itemIndex).padStart(64, 'a'),
    status: 'pending',
    resultArtifacts: [],
    createdAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:00:00.000Z',
  }))
  return {
    id: `exec_00000000-0000-4000-8000-${suffix}`,
    batchId,
    definitionSnapshot: definition,
    sourceFolderCanonicalPath: '/tmp',
    sourceSnapshotSha256: 'a'.repeat(64),
    status: 'running',
    items,
    retainedResultBytes: 0,
    startedAt: `2026-08-06T10:00:0${index}.000Z`,
    updatedAt: `2026-08-06T10:00:0${index}.000Z`,
  }
}

async function writeWorkflowRegistry(directory: string): Promise<string> {
  await fs.mkdir(directory, { recursive: true })
  const registryPath = path.join(directory, 'registry.yaml')
  await fs.writeFile(registryPath, [
    'batch-test-workflow:',
    '  description: Execute a bounded Batch fixture.',
    '  template_path: ./batch-test-workflow.yaml',
    '',
  ].join('\n'))
  await fs.writeFile(path.join(directory, 'batch-test-workflow.yaml'), [
    'workflow:',
    '  id: batch-test-workflow',
    '  description: Execute a bounded Batch fixture.',
    '  input:',
    '    artifact: incoming-brief.md',
    '  steps:',
    '    - id: write',
    '      type: team',
    '      team: writing-team',
    '      input_artifact: incoming-brief.md',
    '      result_artifact: final-draft.md',
    '  output:',
    '    from_step: write',
    '    artifact: final-draft.md',
    '  on_blocked: stop',
    '  on_failed: stop',
    '',
  ].join('\n'))
  return registryPath
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
  failureDetail: () => string | undefined = () => undefined,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for Batch coordinator: ${failureDetail() ?? 'no failure'}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
