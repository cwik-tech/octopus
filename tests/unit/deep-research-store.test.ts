import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  FileSystemResearchRunStore,
  ResearchRunStoreError,
  type InitializeResearchRunInput,
} from '../../domains/deep-research/deep-research-store.js'
import { hashResearchValue } from '../../domains/deep-research/deep-research-worker-policy.js'
import { TEST_TIME } from './deep-research-fixtures.js'

const NEXT_TIME = '2026-07-16T12:00:01.000Z'
const COMPLETED_TIME = '2026-07-16T12:00:02.000Z'

function makeAssignment(): { readonly workspace: string; readonly assignmentPath: string } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-store-'))
  const assignmentPath = path.join(workspace, 'assignments', 'run-one')
  fs.mkdirSync(assignmentPath, { recursive: true })
  return { workspace, assignmentPath }
}

function initializationInput(count = 1): InitializeResearchRunInput {
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
    workItems: Array.from({ length: count }, (_, index) => ({
      taskId: `task-${index + 1}`,
      assignmentId: `assignment-${index + 1}`,
      workerSpecHash: hashResearchValue(`worker-${index + 1}`),
    })),
  }
}

function makeStore(assignmentPath: string): FileSystemResearchRunStore {
  return new FileSystemResearchRunStore(assignmentPath, {
    now: () => new Date(NEXT_TIME),
    randomUUID: (() => {
      let sequence = 0
      return () => `event-${++sequence}`
    })(),
  })
}

function hasStoreCode(code: ResearchRunStoreError['code']) {
  return (error: unknown): boolean =>
    error instanceof ResearchRunStoreError && error.code === code
}

test('research store initializes versioned private state idempotently with restrictive permissions', async () => {
  const storage = makeAssignment()
  try {
    const store = makeStore(storage.assignmentPath)
    const initialized = await store.initialize(initializationInput())
    assert.equal(initialized.journal.revision, 0)
    assert.equal(initialized.journal.status, 'planned')
    assert.equal(initialized.workItems[0]?.attempt, 1)
    assert.equal(initialized.workItems[0]?.status, 'pending')
    assert.deepEqual(await store.initialize(initializationInput()), initialized)
    assert.deepEqual(await makeStore(storage.assignmentPath).load(), initialized)
    assert.equal(fs.statSync(store.paths.runtimePath).mode & 0o777, 0o700)
    assert.equal(fs.statSync(store.paths.workItemsPath).mode & 0o777, 0o700)
    assert.equal(fs.statSync(store.paths.manifestPath).mode & 0o777, 0o600)
    assert.equal(fs.statSync(store.paths.journalPath).mode & 0o777, 0o600)
    assert.equal(fs.existsSync(store.paths.lockPath), false)
    assert.deepEqual(
      fs.readdirSync(store.paths.runtimePath).filter((entry) => entry.endsWith('.tmp')),
      [],
    )
    assert.deepEqual((await store.readEvents()).map((event) => event.type), ['research.initialized'])
  } finally {
    fs.rmSync(storage.workspace, { recursive: true, force: true })
  }
})

test('journal CAS permits one concurrent writer and enforces legal correction transitions', async () => {
  const storage = makeAssignment()
  try {
    const firstStore = makeStore(storage.assignmentPath)
    const secondStore = makeStore(storage.assignmentPath)
    await firstStore.initialize(initializationInput())
    const update = (store: FileSystemResearchRunStore) => store.updateJournal({
      expectedRevision: 0,
      executionAttemptId: 'attempt-one',
      mutate(draft) {
        draft.status = 'running'
      },
    })
    const results = await Promise.allSettled([update(firstStore), update(secondStore)])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    const rejected = results.find((result) => result.status === 'rejected')
    assert.ok(rejected && rejected.status === 'rejected')
    assert.ok(hasStoreCode('revision_conflict')(rejected.reason))

    const correcting = await firstStore.updateJournal({
      expectedRevision: 1,
      executionAttemptId: 'attempt-one',
      mutate(draft) {
        draft.status = 'correcting'
        draft.correctionWave = 1
      },
    })
    assert.equal(correcting.correctionWave, 1)
    await assert.rejects(firstStore.updateJournal({
      expectedRevision: 2,
      executionAttemptId: 'attempt-one',
      mutate(draft) {
        draft.status = 'approved'
      },
    }), hasStoreCode('invalid_state'))
  } finally {
    fs.rmSync(storage.workspace, { recursive: true, force: true })
  }
})

test('artifact receipts bind assignment, attempt, worker hash, bytes, and path immutably', async () => {
  const storage = makeAssignment()
  try {
    const store = makeStore(storage.assignmentPath)
    const input = initializationInput()
    await store.initialize(input)
    await store.updateJournal({
      expectedRevision: 0,
      executionAttemptId: 'attempt-one',
      mutate(draft) { draft.status = 'running' },
    })
    await store.beginWorkItem({
      taskId: 'task-1',
      expectedAttempt: 1,
      executionAttemptId: 'attempt-one',
    })
    const relativePath = 'research/evidence/task-1-v1.md'
    fs.mkdirSync(path.join(storage.assignmentPath, 'research', 'evidence'), { recursive: true })
    fs.writeFileSync(path.join(storage.assignmentPath, relativePath), '# Evidence\n')
    const commit = {
      taskId: 'task-1',
      assignmentId: 'assignment-1',
      attempt: 1,
      workerSpecHash: input.workItems[0]!.workerSpecHash,
      relativePath,
      completedAt: COMPLETED_TIME,
    }
    const receipt = await store.commitWorkItemReceipt(commit)
    assert.equal(receipt.byteLength, Buffer.byteLength('# Evidence\n'))
    assert.match(receipt.sha256, /^[a-f0-9]{64}$/)
    assert.deepEqual(await store.commitWorkItemReceipt(commit), receipt)
    assert.equal((await store.requireSnapshot()).workItems[0]?.status, 'completed')

    fs.writeFileSync(path.join(storage.assignmentPath, relativePath), '# Changed\n')
    await assert.rejects(
      store.commitWorkItemReceipt(commit),
      hasStoreCode('artifact_invalid'),
    )
    await assert.rejects(store.commitWorkItemReceipt({
      ...commit,
      workerSpecHash: hashResearchValue('other-worker'),
    }), hasStoreCode('identity_mismatch'))
    await assert.rejects(store.commitWorkItemReceipt({
      ...commit,
      relativePath: '../escape.md',
    }))
  } finally {
    fs.rmSync(storage.workspace, { recursive: true, force: true })
  }
})

test('recovery adopts completed receipts and retries only interrupted work with a higher attempt', async () => {
  const storage = makeAssignment()
  try {
    const store = makeStore(storage.assignmentPath)
    const input = initializationInput(2)
    await store.initialize(input)
    await store.updateJournal({
      expectedRevision: 0,
      executionAttemptId: 'attempt-one',
      mutate(draft) { draft.status = 'running' },
    })
    await store.beginWorkItem({ taskId: 'task-1', expectedAttempt: 1, executionAttemptId: 'attempt-one' })
    await store.beginWorkItem({ taskId: 'task-2', expectedAttempt: 1, executionAttemptId: 'attempt-one' })
    fs.mkdirSync(path.join(storage.assignmentPath, 'research'), { recursive: true })
    fs.writeFileSync(path.join(storage.assignmentPath, 'research', 'task-1.md'), 'complete')
    await store.commitWorkItemReceipt({
      taskId: 'task-1',
      assignmentId: 'assignment-1',
      attempt: 1,
      workerSpecHash: input.workItems[0]!.workerSpecHash,
      relativePath: 'research/task-1.md',
      completedAt: COMPLETED_TIME,
    })

    const recovered = await store.claimExecutionAttempt({
      expectedRevision: 1,
      expectedOwnerExecutionAttemptId: 'attempt-one',
      nextExecutionAttemptId: 'attempt-two',
    })
    assert.equal(recovered.workItems[0]?.status, 'completed')
    assert.equal(recovered.workItems[0]?.attempt, 1)
    assert.equal(recovered.workItems[1]?.status, 'interrupted')
    assert.equal(recovered.workItems[1]?.attempt, 2)
    assert.equal(recovered.journal.ownerExecutionAttemptId, 'attempt-two')
    assert.equal((await store.beginWorkItem({
      taskId: 'task-2',
      expectedAttempt: 2,
      executionAttemptId: 'attempt-two',
    })).attempt, 2)
  } finally {
    fs.rmSync(storage.workspace, { recursive: true, force: true })
  }
})

test('correction tasks append without replacing healthy work-item history', async () => {
  const storage = makeAssignment()
  try {
    const store = makeStore(storage.assignmentPath)
    await store.initialize(initializationInput())
    await store.updateJournal({
      expectedRevision: 0,
      executionAttemptId: 'attempt-one',
      mutate(draft) {
        draft.status = 'running'
      },
    })
    await store.updateJournal({
      expectedRevision: 1,
      executionAttemptId: 'attempt-one',
      mutate(draft) {
        draft.status = 'correcting'
        draft.correctionWave = 1
      },
    })
    const updated = await store.addWorkItems({
      expectedRevision: 2,
      executionAttemptId: 'attempt-one',
      workItems: [{
        taskId: 'task-1-correction-1',
        assignmentId: 'assignment-correction-1',
        workerSpecHash: hashResearchValue('correction-worker'),
      }],
    })
    assert.deepEqual(updated.journal.workItemIds, ['task-1', 'task-1-correction-1'])
    assert.equal(updated.workItems[0]?.status, 'pending')
    assert.equal(updated.workItems[1]?.status, 'pending')
  } finally {
    fs.rmSync(storage.workspace, { recursive: true, force: true })
  }
})

test('research store rejects relaxed permissions instead of reading private state', async () => {
  const storage = makeAssignment()
  try {
    const store = makeStore(storage.assignmentPath)
    await store.initialize(initializationInput())
    fs.chmodSync(store.paths.journalPath, 0o644)
    await assert.rejects(store.load(), hasStoreCode('corrupt'))
  } finally {
    fs.rmSync(storage.workspace, { recursive: true, force: true })
  }
})

test('eight concurrent real-file lanes persist receipts and events within five seconds', async () => {
  const storage = makeAssignment()
  try {
    const store = makeStore(storage.assignmentPath)
    const input = initializationInput(8)
    await store.initialize(input)
    await store.updateJournal({
      expectedRevision: 0,
      executionAttemptId: 'attempt-one',
      mutate(draft) { draft.status = 'running' },
    })
    const evidencePath = path.join(storage.assignmentPath, 'research', 'evidence')
    fs.mkdirSync(evidencePath, { recursive: true })
    for (let index = 0; index < 8; index += 1) {
      fs.writeFileSync(path.join(evidencePath, `task-${index + 1}.json`), JSON.stringify({ lane: index + 1 }))
    }

    const startedAt = performance.now()
    await Promise.all(input.workItems.map((item) => store.beginWorkItem({
      taskId: item.taskId,
      expectedAttempt: 1,
      executionAttemptId: 'attempt-one',
    })))
    await Promise.all(input.workItems.map((item, index) => store.commitWorkItemReceipt({
      taskId: item.taskId,
      assignmentId: item.assignmentId,
      attempt: 1,
      workerSpecHash: item.workerSpecHash,
      relativePath: `research/evidence/task-${index + 1}.json`,
      completedAt: COMPLETED_TIME,
    })))
    const elapsedMs = performance.now() - startedAt
    const snapshot = await store.requireSnapshot()
    const events = await store.readEvents()

    assert.equal(snapshot.workItems.filter((item) => item.status === 'completed').length, 8)
    assert.equal(new Set(snapshot.workItems.map((item) => item.receipt?.sha256)).size, 8)
    assert.equal(events.filter((event) => event.type === 'research.work_item.started').length, 8)
    assert.equal(events.filter((event) => event.type === 'research.work_item.completed').length, 8)
    assert.ok(elapsedMs < 5_000, `Expected eight durable lanes under 5s, received ${elapsedMs.toFixed(1)}ms`)
    assert.equal(fs.existsSync(store.paths.lockPath), false)
  } finally {
    fs.rmSync(storage.workspace, { recursive: true, force: true })
  }
})
