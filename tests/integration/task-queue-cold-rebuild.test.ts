import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'

import { TaskQueue } from '../../services/task-queue.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import type { SessionTask } from '../../contracts/sessions.js'
import { WorkspaceDispatcherOwner } from '../../core/workspace-dispatcher-owner.js'

const TASK_COUNT = 5_000
const REBUILD_GUARDRAIL_MS = 5_000

test('cold startup rebuilds 5,000 real task records within the CI guardrail', async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'task-queue-rebuild-'))
  const sessionStore = new FileSystemSessionStore(workspacePath, {
    isProcessAlive: () => true,
    isProcessIdentityValid: () => true,
  })
  const session = await sessionStore.createSession({ title: 'Cold rebuild benchmark' })
  const tasksPath = path.join(workspacePath, 'sessions', session.id, 'tasks')
  fs.mkdirSync(tasksPath, { recursive: true })
  const createdAt = new Date().toISOString()

  for (let index = 0; index < TASK_COUNT; index += 1) {
    const suffix = index.toString(16).padStart(12, '0')
    const taskId = `00000000-0000-4000-8000-${suffix}`
    const attemptId = `cold-rebuild-attempt-${index}`
    const taskPath = path.join(tasksPath, taskId)
    const task: SessionTask = {
      id: taskId,
      sessionId: session.id,
      runId: taskId,
      workflowId: 'cold-rebuild-workflow',
      brief: `Cold rebuild task ${index}`,
      status: 'running',
      createdAt,
      updatedAt: createdAt,
      cwd: taskPath,
      ownerInstanceId: 'previous-owner',
      processIdentity: attemptId,
      executionAttemptId: attemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      attemptStartedAt: createdAt,
      workerStartedAt: createdAt,
      pid: 900_000 + index,
      processGroupId: 900_000 + index,
      admission: {
        version: 1,
        phase: 'granted',
        requestId: `request-${index}`,
        order: String(index + 1),
        requestedAt: createdAt,
        executionKind: 'initial',
        source: 'startup_repair',
        expectedExecutionAttemptId: null,
        grantId: `grant-${index}`,
        ownerEpoch: 'previous-owner-epoch',
        grantedAt: createdAt,
        executionAttemptId: attemptId,
      },
    }
    fs.mkdirSync(taskPath)
    fs.writeFileSync(
      path.join(taskPath, 'task.json'),
      `${JSON.stringify(task)}\n`,
      { mode: 0o600 },
    )
  }

  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const queue = new TaskQueue({
    sessionStore,
    owner,
    maximumConcurrentTasks: 3,
    repoRootPath: process.cwd(),
    workspacePath,
    tickIntervalMs: 60_000,
  })

  try {
    const startedAt = performance.now()
    const initialized = await queue.initialize()
    const elapsedMs = performance.now() - startedAt

    assert.deepEqual(initialized, {
      pending: 0,
      granted: TASK_COUNT,
      legacyActive: 0,
    })
    assert.ok(
      elapsedMs < REBUILD_GUARDRAIL_MS,
      `Cold queue rebuild took ${elapsedMs.toFixed(1)}ms; guardrail is ${REBUILD_GUARDRAIL_MS}ms`,
    )
  } finally {
    await queue.close()
    await owner.release()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
