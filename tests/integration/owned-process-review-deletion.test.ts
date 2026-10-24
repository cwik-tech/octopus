import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { requiredValue } from '../../core/required-value.js'
import { withinBound } from '../support/fixture-process-markers.js'
import { WorkspaceDispatcherOwner } from '../../core/workspace-dispatcher-owner.js'
import type { SessionTask } from '../../contracts/sessions.js'
import type { RunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore, type RunStartRequest } from '../../domains/run/run-store.js'
import { startApiServer } from '../../server/api-server.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { WorkspaceProjectMembershipStore } from '../../domains/projects/project-membership-store.js'
import { WorkspaceProjectStore } from '../../domains/projects/project-store.js'
import {
  WorkspaceProjectService,
  WorkspaceProjectServiceError,
} from '../../domains/projects/workspace-project-service.js'
import { TaskQueue } from '../../services/task-queue.js'
import { cancelSessionTask } from '../../services/task-service.js'

// Requirement (docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md):
// section 2, nothing removes a scope while its task holds a
// `processCleanupHold`; section 7, an earlier-version task held with
// `descendants_unverified_without_scope` keeps its legacy-active slot, and
// cancelling it reports "process cleanup remains pending". Deleting its
// session, alone or with its project, removes the task record, and a queue
// that no longer finds the record releases the slot. So deletion is refused
// while the task is held, and the task keeps its record and its slot.
//
// The refusal says what is happening. A session whose only blocker is a task
// that has ended while its processes could not be confirmed stopped is not
// waiting for anyone to cancel anything, so it is not told to "cancel active
// tasks"; a session with a task that really is active still is.
//
// The earlier version's app leaves a running task with an attempt, no
// admission and no scope, whose root has exited. A second task, in another
// session, is queued and waits for the one slot. Starting a queue on the
// workspace is the app starting; the launcher starts nothing and records
// each launch.

const TEST_TICK_INTERVAL_MS = 60_000
const CLEANUP_PENDING_SESSION_MESSAGE =
  'A task in this session has ended, but its processes could not yet be confirmed stopped. ' +
  'Delete the session once that cleanup finishes.'
const CLEANUP_PENDING_PROJECT_MESSAGE =
  "A task in one of this project's sessions has ended, but its processes could not yet be confirmed stopped. " +
  "Delete the project's sessions once that cleanup finishes."
const ACTIVE_TASKS_SESSION_MESSAGE = 'Cancel active tasks before deleting the session'
const FIXTURE_BOUND_MS = 5_000

class RecordingLauncher implements RunLauncher {
  readonly starts: string[] = []

  async startRun(request: RunStartRequest): Promise<never> {
    this.starts.push(requiredValue(request.env?.TEAM_RUNTIME_TASK_ID, 'launched task id'))
    return await new Promise<never>(() => undefined)
  }
}

interface RunningQueue {
  readonly queue: TaskQueue
  readonly legacyActive: number
  /** Stops the queue once; later calls do nothing. */
  stop(): Promise<void>
}

/**
 * Every queue a test started, as the stop the workspace's cleanup runs before
 * it removes the folder. Registered as soon as the dispatcher owner is held,
 * so a queue whose start or test failed is stopped too.
 */
const openQueues: Array<() => Promise<void>> = []

async function startQueue(workspacePath: string, launcher: RunLauncher): Promise<RunningQueue> {
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const queue = new TaskQueue({
    sessionStore: new FileSystemSessionStore(workspacePath, { instanceId: `app-${randomUUID()}` }),
    owner,
    maximumConcurrentTasks: 1,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
  })
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    // The default bound, not a short one: close waits for the dispatch
    // initialize started, whose reconciliation writes to the workspace. A
    // close that returns first lets that work recreate a removed folder.
    await queue.close()
    await owner.release()
  }
  openQueues.push(stop)
  const initialized = await queue.initialize()
  return { queue, legacyActive: initialized.legacyActive, stop }
}

async function stopQueue(running: RunningQueue): Promise<void> {
  await running.stop()
}

function taskRecordPath(workspacePath: string, task: SessionTask): string {
  return path.join(workspacePath, 'sessions', task.sessionId, 'tasks', task.id, 'task.json')
}

interface HeldEarlierVersionTask {
  readonly store: FileSystemSessionStore
  readonly held: SessionTask
  readonly waiting: SessionTask
  readonly launcher: RecordingLauncher
  running: RunningQueue
}

/**
 * The earlier version's running task, held by the queue's startup pass, then
 * cancelled: cancelled, still held, and still in its legacy-active slot.
 */
async function cancelledHeldEarlierVersionTask(workspacePath: string): Promise<HeldEarlierVersionTask> {
  const store = new FileSystemSessionStore(workspacePath, { instanceId: 'earlier-version-app' })
  const session = await store.createSession({ title: 'Earlier-version task' })
  const created = requiredValue(await store.createTaskRecord(session.id, {
    workflowId: 'earlier-version-workflow',
    brief: 'Launched by an earlier version, without a scope.',
  }), 'earlier-version task')
  const root = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' })
  const rootPid = requiredValue(root.pid, 'root pid')
  await withinBound(once(root, 'exit'), FIXTURE_BOUND_MS, 'the earlier root to exit')
  const attemptId = randomUUID()
  const legacy = requiredValue((await store.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
    status: 'running',
    executionAttemptId: attemptId,
    processIdentity: attemptId,
    executionAttemptNumber: 1,
    executionKind: 'initial',
    pid: rootPid,
    processGroupId: rootPid,
    startedAt: new Date().toISOString(),
  }, { expectedExecutionAttemptId: null }))?.task, 'legacy-active task')
  const otherSession = await store.createSession({ title: 'Waiting for the slot' })
  const waiting = requiredValue(await store.createTaskRecord(otherSession.id, {
    workflowId: 'waiting-workflow',
    brief: 'Queued behind the earlier-version task.',
  }), 'waiting task')

  const launcher = new RecordingLauncher()
  const running = await startQueue(workspacePath, launcher)
  assert.equal(running.legacyActive, 1, 'precondition: the earlier-version task holds the one slot')
  assert.equal(
    (await store.getTaskRecord(session.id, legacy.id))?.processCleanupHold?.reason,
    'descendants_unverified_without_scope',
    'precondition: the task is held',
  )

  await assert.rejects(
    cancelSessionTask({ sessionId: session.id, taskId: legacy.id, sessionStore: store }),
    /process cleanup remains pending/,
  )
  const held = requiredValue(await store.getTaskRecord(session.id, legacy.id), 'cancelled task')
  assert.deepEqual(
    { status: held.status, admission: held.admission, hold: held.processCleanupHold?.reason },
    { status: 'cancelled', admission: undefined, hold: 'descendants_unverified_without_scope' },
    'precondition: the cancelled task keeps its hold and has no admission',
  )
  return { store, held, waiting, launcher, running }
}

/** After a restart, the held task still has its record and the one slot, and the waiting task still waits. */
async function assertHeldTaskKeepsRecordAndSlot(
  workspacePath: string,
  fixture: HeldEarlierVersionTask,
): Promise<void> {
  assert.equal(fs.existsSync(taskRecordPath(workspacePath, fixture.held)), true, 'the held task keeps its record')
  await stopQueue(fixture.running)
  fixture.running = await startQueue(workspacePath, fixture.launcher)
  const snapshot = await fixture.running.queue.snapshot()
  const waiting = requiredValue(
    await fixture.store.getTaskRecord(fixture.waiting.sessionId, fixture.waiting.id),
    'waiting task',
  )
  assert.deepEqual(
    {
      legacyActive: fixture.running.legacyActive,
      availableSlots: snapshot.availableSlots,
      waitingAdmission: waiting.admission?.phase,
      launched: fixture.launcher.starts,
    },
    { legacyActive: 1, availableSlots: 0, waitingAdmission: 'pending', launched: [] },
    'after a restart the held task keeps its legacy-active slot, and the waiting task is not admitted',
  )
}

/**
 * Runs `fn` in a fresh workspace. Cleanup always runs, whether `fn` passed or
 * failed: every queue the test started is stopped first, each close awaited
 * to its default bound, and only then is the folder removed. Every error is
 * reported beside the body's.
 */
async function withWorkspace(fn: (workspacePath: string) => Promise<void>): Promise<void> {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-process-review-deletion-'))
  const failures: unknown[] = []
  try {
    await fn(workspacePath)
  } catch (error) {
    failures.push(error)
  }
  for (const stop of openQueues.splice(0).reverse()) {
    try {
      await stop()
    } catch (error) {
      failures.push(error)
    }
  }
  try {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  } catch (error) {
    failures.push(error)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, `the test and its cleanup failed in ${workspacePath}`)
}

test('deleting the session of a held earlier-version task is refused, and the task keeps its record and its slot', { timeout: 60_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const fixture = await cancelledHeldEarlierVersionTask(workspacePath)
    const deletion = await fixture.store.deleteSessionIfNoActiveTasks(fixture.held.sessionId)

    assert.deepEqual(deletion, { deleted: false, reason: 'process_cleanup_pending' })
    await assertHeldTaskKeepsRecordAndSlot(workspacePath, fixture)
  })
})

test("deleting a project with its sessions' data is refused while one of them holds a held earlier-version task, and the task keeps its record and its slot", { timeout: 60_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const fixture = await cancelledHeldEarlierVersionTask(workspacePath)
    const projects = new WorkspaceProjectService({
      projectStore: new WorkspaceProjectStore({ workspacePath }),
      membershipStore: new WorkspaceProjectMembershipStore({ workspacePath }),
      sessionStore: fixture.store,
    })
    const project = await projects.createProject({ name: 'Held work' })
    await projects.assignSession(project.id, fixture.held.sessionId)

    await assert.rejects(
      projects.deleteProject(project.id, 'delete_sessions'),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceProjectServiceError, String(error))
        assert.equal(error.code, 'project_not_empty')
        assert.equal(error.message, CLEANUP_PENDING_PROJECT_MESSAGE)
        return true
      },
    )
    await assertHeldTaskKeepsRecordAndSlot(workspacePath, fixture)
  })
})

/** Runs `fn` against the app's API on the workspace, the queue stopped first so the app's own queue owns it. */
async function withApi(
  workspacePath: string,
  fixture: HeldEarlierVersionTask,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  await stopQueue(fixture.running)
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 0, cwd: '' }
      },
    },
    taskLauncher: fixture.launcher,
    sessionStore: new FileSystemSessionStore(workspacePath, { instanceId: `api-${randomUUID()}` }),
    workspacePath,
  })
  try {
    await fn(server.url)
  } finally {
    await server.close()
  }
}

test('deleting through the API the session of a held task that has ended answers 409 saying its processes are not yet confirmed stopped, and deletes nothing', { timeout: 60_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const fixture = await cancelledHeldEarlierVersionTask(workspacePath)
    await withApi(workspacePath, fixture, async (base) => {
      const response = await fetch(`${base}/sessions/${fixture.held.sessionId}`, { method: 'DELETE' })

      assert.equal(response.status, 409)
      assert.deepEqual(await response.json(), { error: CLEANUP_PENDING_SESSION_MESSAGE })
      assert.equal((await fetch(`${base}/sessions/${fixture.held.sessionId}`)).status, 200)
      assert.equal(fs.existsSync(taskRecordPath(workspacePath, fixture.held)), true, 'the held task keeps its record')
    })
  })
})

test('deleting through the API a session with a really active task beside a held one still asks to cancel active tasks', { timeout: 60_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const fixture = await cancelledHeldEarlierVersionTask(workspacePath)
    const active = requiredValue(await fixture.store.createTaskRecord(fixture.held.sessionId, {
      workflowId: 'active-workflow',
      brief: 'Queued in the same session, and not yet run.',
    }), 'active task')
    assert.equal(active.status, 'queued')
    await withApi(workspacePath, fixture, async (base) => {
      const response = await fetch(`${base}/sessions/${fixture.held.sessionId}`, { method: 'DELETE' })

      assert.equal(response.status, 409)
      assert.deepEqual(await response.json(), { error: ACTIVE_TASKS_SESSION_MESSAGE })
      assert.equal(fs.existsSync(taskRecordPath(workspacePath, fixture.held)), true, 'the held task keeps its record')
    })
  })
})
