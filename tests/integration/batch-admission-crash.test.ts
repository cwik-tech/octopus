import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import type { RunPlan } from '../../contracts/run-plan.js'
import { BatchStore } from '../../domains/batches/batch-store.js'
import type { BatchDefinition, BatchExecution, BatchItem } from '../../domains/batches/batch-types.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { reconcileBatchExecutions } from '../../services/batch-admission-coordinator.js'

test('Batch recovery backfills an admitted task and never creates a second session task', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-admission-crash-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const definition = makeDefinition()
  const session = await sessionStore.createSession({
    title: 'Crash recovery',
    origin: {
      kind: 'batch',
      batchId: definition.id,
      executionId: EXECUTION_ID,
      itemId: ITEM_ID,
    },
  })
  const plan = makePlan()
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'workflow',
    brief: 'Persisted Batch task',
  })
  assert.ok(task)
  assert.equal(await sessionStore.saveRunPlan(session.id, plan), true)
  assert.ok(await sessionStore.updateTaskRecord(session.id, task.id, { runPlanId: plan.id }))
  await store.writeDefinitions([definition])
  await store.writeExecution(makeExecution(definition, {
    ...makeItem(),
    status: 'preparing',
    preparationPhase: 'plan_persisted',
    sessionId: session.id,
    runPlanId: plan.id,
  }))

  await reconcileBatchExecutions({ store, sessionStore })
  const recovered = await store.readExecution(definition.id, EXECUTION_ID)
  assert.equal(recovered?.items[0]?.taskId, task.id)
  assert.equal(recovered?.items[0]?.status, 'queued')
  assert.equal((await sessionStore.listTaskRecords(session.id)).length, 1)
})

test('Batch recovery fails closed when preparation has no durable session identity', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-admission-ambiguous-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  const definition = makeDefinition()
  await store.writeDefinitions([definition])
  await store.writeExecution(makeExecution(definition, {
    ...makeItem(),
    status: 'preparing',
    preparationPhase: 'intent_persisted',
  }))
  const sessionStore = new FileSystemSessionStore(workspacePath)

  await reconcileBatchExecutions({ store, sessionStore })
  const recovered = await store.readExecution(definition.id, EXECUTION_ID)
  assert.equal(recovered?.items[0]?.status, 'setup_failed')
  assert.equal(recovered?.items[0]?.failureCode, 'recovery_state_ambiguous')
  assert.deepEqual(await sessionStore.listSessions(), [])
})

const BATCH_ID = 'batch_00000000-0000-4000-8000-000000000001'
const EXECUTION_ID = 'exec_00000000-0000-4000-8000-000000000002'
const ITEM_ID = 'item_00000000-0000-4000-8000-000000000003'

function makeDefinition(): BatchDefinition {
  return {
    id: BATCH_ID,
    revision: 1,
    name: 'Recovery',
    workflowId: 'workflow',
    folderPath: '/tmp',
    fileExtensions: [],
    rerunPolicy: 'always',
    createdAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:00:00.000Z',
  }
}

function makeItem(): BatchItem {
  return {
    id: ITEM_ID,
    ordinal: 0,
    fileName: 'one.txt',
    sourceSize: 1,
    sourceMtime: '2026-08-06T10:00:00.000Z',
    sourceSha256: 'a'.repeat(64),
    status: 'pending',
    resultArtifacts: [],
    createdAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:00:00.000Z',
  }
}

function makeExecution(definition: BatchDefinition, item: BatchItem): BatchExecution {
  return {
    id: EXECUTION_ID,
    batchId: definition.id,
    definitionSnapshot: definition,
    sourceFolderCanonicalPath: '/tmp',
    sourceSnapshotSha256: 'a'.repeat(64),
    status: 'running',
    items: [item],
    retainedResultBytes: 0,
    startedAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:00:00.000Z',
  }
}

function makePlan(): RunPlan {
  return {
    id: '00000000-0000-4000-8000-000000000004',
    goal: 'Recover the Batch item.',
    summary: 'Recover the Batch item.',
    status: 'ready',
    selectedWorkflow: { id: 'workflow', rationale: 'Selected', confidence: 'high' },
    requiredInputs: [],
    actions: [{
      id: 'launch-workflow',
      type: 'launch_workflow',
      status: 'ready',
      title: 'Launch',
      rationale: 'Ready',
      workflowId: 'workflow',
    }],
    warnings: [],
    createdAt: '2026-08-06T10:00:00.000Z',
  }
}
