import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { after } from 'node:test'

import { requiredValue } from '../../core/required-value.js'
import { TASK_QUEUE_EVENT_FILENAME } from '../../core/task-queue-events.js'
import { WorkspaceDispatcherOwner } from '../../core/workspace-dispatcher-owner.js'
import type { SessionTask, TaskAdmission } from '../../contracts/sessions.js'
import type { RunLauncher } from '../../domains/run/run-launcher.js'
import type { RunStartRequest } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { currentAttemptScope } from '../support/current-attempt-scope.js'
import { ownedProcessScopePath } from '../../core/owned-processes/owned-process-scope.js'
import {
  defaultIsProcessAlive,
  PROCESS_IDENTITY_ARGUMENT,
} from '../../domains/sessions/task-process-supervisor.js'
import { TaskQueue } from '../../services/task-queue.js'
import { cancelSessionTask } from '../../services/task-service.js'

// A cancelled task keeps its grant while its process is alive
// (terminalTaskStillConsumesCapacityLocked in services/task-queue.ts), and the
// queue asks the store to clean that process up. The store signals only a
// process whose identity it can verify (cleanupCancelledTaskProcess in
// task-recovery-manager.ts). For an owned task whose live worker carries no
// identity marker, as with a reused PID, cancelSessionTask stops before it
// releases the admission ("process cleanup remains pending"). Before the fix,
// every dispatch pass then asked for a cleanup the store refused, and the
// reconciliation woke the queue again at once.
//
// The record counted here is the queue's own task_queue.reconciled event with
// reason cancelled_process_cleanup, written once per cleanup request. It was
// added for this test: the refused cleanup leaves no other trace at a public
// boundary, so the Red was run on a tree with the record and without the fix.
//
// Substituted boundaries: the unverified worker is a plain detached node child
// with no marker, and the verified one carries the real
// --runtime-process-identity marker, so the store's real ps probe decides both.
// No probe is mocked. The launcher only reports that a launch began; no task
// runner runs. The store and the queue read one fixed clock.

const FIXED_NOW = new Date('2026-01-01T09:00:00.000Z')
const TEST_TICK_INTERVAL_MS = 60_000

/** Every process group a fixture here started, checked once all tests have run. */
const fixtureProcessGroups = new Set<number>()

after(() => {
  const survivors = [...fixtureProcessGroups].filter((group) => defaultIsProcessAlive(-group))
  assert.deepEqual(survivors, [], 'no fixture process group may outlive this file')
})

/** Reports each launch to the test; the launched run never settles. */
class SignallingLauncher implements RunLauncher {
  private readonly started = new Set<string>()
  private readonly waiters = new Map<string, () => void>()

  launched(taskId: string): Promise<void> {
    if (this.started.has(taskId)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.waiters.set(taskId, resolve)
    })
  }

  async startRun(request: RunStartRequest): Promise<never> {
    const taskId = requiredValue(request.env?.TEAM_RUNTIME_TASK_ID, 'launched task id')
    this.started.add(taskId)
    this.waiters.get(taskId)?.()
    return await new Promise<never>(() => undefined)
  }
}

/** A real detached worker in its own group, with or without the identity marker. */
async function spawnWorker(processIdentity?: string): Promise<ChildProcess> {
  const marker = processIdentity ? ['--', `${PROCESS_IDENTITY_ARGUMENT}${processIdentity}`] : []
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1e9)', ...marker],
    { detached: true, stdio: 'ignore' },
  )
  await once(child, 'spawn')
  fixtureProcessGroups.add(requiredValue(child.pid, 'worker pid'))
  return child
}

/** Kills the worker's own process group and waits for its exit event. */
async function stopWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  try {
    process.kill(-requiredValue(child.pid, 'worker pid'), 'SIGKILL')
  } catch {
    // The group is already gone; the exit event still settles below.
  }
  await exited
}

function grantedAdmission(
  executionAttemptId: string,
): Extract<TaskAdmission, { phase: 'granted' }> {
  const at = FIXED_NOW.toISOString()
  return {
    version: 1,
    phase: 'granted',
    requestId: `request-${executionAttemptId}`,
    order: '1',
    requestedAt: at,
    executionKind: 'initial',
    source: 'apply',
    expectedExecutionAttemptId: null,
    grantId: `grant-${executionAttemptId}`,
    ownerEpoch: 'launching-owner-epoch',
    grantedAt: at,
    executionAttemptId,
  }
}

/** This store's own granted, running task with the worker attached. */
async function seedOwnedRunningTask(params: {
  store: FileSystemSessionStore
  sessionId: string
  worker: ChildProcess
}): Promise<SessionTask> {
  const created = requiredValue(
    await params.store.createTaskRecord(params.sessionId, {
      workflowId: 'cancelled-cleanup-workflow',
      brief: 'Hold a worker while a cancellation is cleaned up.',
    }),
    'created task',
  )
  const executionAttemptId = `attempt-${created.id}`
  const workerPid = requiredValue(params.worker.pid, 'worker pid')
  const seeded = await params.store.compareAndSetTaskRecord(
    params.sessionId,
    created.id,
    ['queued'],
    {
      status: 'running',
      admission: grantedAdmission(executionAttemptId),
      processIdentity: executionAttemptId,
      executionAttemptId,
      executionAttemptNumber: 1,
      ...await currentAttemptScope(created, 1),
      executionKind: 'initial',
      attemptStartedAt: FIXED_NOW.toISOString(),
      workerStartedAt: FIXED_NOW.toISOString(),
      pid: workerPid,
      processGroupId: workerPid,
    },
    { expectedExecutionAttemptId: null },
  )
  assert.equal(seeded?.updated, true)
  return requiredValue(seeded?.task, 'seeded task')
}

/** An interrupted task a manual resume can send through the queue. */
async function seedInterruptedTask(
  store: FileSystemSessionStore,
  sessionId: string,
): Promise<SessionTask> {
  const created = requiredValue(
    await store.createTaskRecord(sessionId, {
      workflowId: 'cancelled-cleanup-workflow',
      brief: 'Wait for the cancelled task to free its slot.',
    }),
    'created task',
  )
  const previousAttemptId = `previous-attempt-${created.id}`
  const interrupted = await store.compareAndSetTaskRecord(
    sessionId,
    created.id,
    ['queued'],
    {
      status: 'interrupted',
      processIdentity: previousAttemptId,
      executionAttemptId: previousAttemptId,
      executionAttemptNumber: 1,
      ...await currentAttemptScope(created, 1),
      executionKind: 'initial',
      interruptedAt: FIXED_NOW.toISOString(),
      recoveryDisposition: 'manual',
      recoveryReason: 'Resumed by the cancelled cleanup test.',
    },
    { expectedExecutionAttemptId: null },
  )
  assert.equal(interrupted?.updated, true)
  return requiredValue(interrupted?.task, 'interrupted task')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The queue's cancelled-cleanup requests for one task, from its event log. */
function cleanupRequests(workspacePath: string, taskId: string): number {
  const eventsPath = path.join(workspacePath, 'task-queue', TASK_QUEUE_EVENT_FILENAME)
  if (!fs.existsSync(eventsPath)) return 0
  return fs
    .readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line): unknown => JSON.parse(line))
    .filter(isRecord)
    .filter((event) =>
      event.event === 'task_queue.reconciled' &&
      event.reason === 'cancelled_process_cleanup' &&
      event.task_id === taskId,
    )
    .length
}

interface Harness {
  workspacePath: string
  store: FileSystemSessionStore
  launcher: SignallingLauncher
  owner?: WorkspaceDispatcherOwner
  queue?: TaskQueue
}

function createHarness(label: string): Harness {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), `queue-cancelled-${label}-`))
  return {
    workspacePath,
    store: new FileSystemSessionStore(workspacePath, {
      instanceId: 'desktop-owner',
      now: () => FIXED_NOW,
    }),
    launcher: new SignallingLauncher(),
  }
}

/** One slot, so a waiting task launches only once the cancelled task frees it. */
async function startQueue(harness: Harness): Promise<TaskQueue> {
  harness.owner = await WorkspaceDispatcherOwner.acquire({ workspacePath: harness.workspacePath })
  harness.queue = new TaskQueue({
    sessionStore: harness.store,
    owner: harness.owner,
    maximumConcurrentTasks: 1,
    repoRootPath: process.cwd(),
    workspacePath: harness.workspacePath,
    taskLauncher: harness.launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
    now: () => FIXED_NOW,
  })
  assert.deepEqual(await harness.queue.initialize(), { pending: 0, granted: 1, legacyActive: 0 })
  return harness.queue
}

async function destroyHarness(harness: Harness): Promise<void> {
  await harness.queue?.close(1)
  await harness.owner?.release()
  fs.rmSync(harness.workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
}

test('the queue does not keep asking to clean up a cancelled task whose live process it cannot verify', {
  timeout: 30_000,
  skip: process.platform === 'win32',
}, async () => {
  const harness = createHarness('unverified')
  const worker = await spawnWorker()
  try {
    const session = await harness.store.createSession({ title: 'Unverified cancellation' })
    const running = await seedOwnedRunningTask({
      store: harness.store,
      sessionId: session.id,
      worker,
    })
    await assert.rejects(
      cancelSessionTask({
        sessionId: session.id,
        taskId: running.id,
        sessionStore: harness.store,
      }),
      /process cleanup remains pending/,
    )
    const cancelled = requiredValue(
      await harness.store.getTaskRecord(session.id, running.id),
      'cancelled task',
    )
    assert.deepEqual(
      {
        status: cancelled.status,
        admissionPhase: cancelled.admission?.phase,
        owned: harness.store.ownsTaskProcess(cancelled),
        alive: harness.store.isTaskProcessAlive(cancelled),
        identityVerified: harness.store.hasValidTaskProcessIdentity(cancelled),
      },
      {
        status: 'cancelled',
        admissionPhase: 'granted',
        owned: true,
        alive: true,
        identityVerified: false,
      },
    )
    const waiting = await seedInterruptedTask(harness.store, session.id)

    const queue = await startQueue(harness)
    // enqueueRecovery takes the queue's mutation lock after the pass that
    // initialize started, so both passes have run when it resolves.
    await queue.enqueueRecovery({ sessionId: session.id, taskId: waiting.id, source: 'manual_resume' })

    const held = requiredValue(await harness.store.getTaskRecord(session.id, cancelled.id), 'held task')
    assert.deepEqual(
      {
        cleanupRequests: cleanupRequests(harness.workspacePath, cancelled.id),
        status: held.status,
        pid: held.pid,
        processGroupId: held.processGroupId,
        admission: held.admission,
        workerAlive: defaultIsProcessAlive(-requiredValue(worker.pid, 'worker pid')),
        waitingPhase: (await harness.store.getTaskRecord(session.id, waiting.id))?.admission?.phase,
      },
      {
        cleanupRequests: 0,
        status: 'cancelled',
        pid: cancelled.pid,
        processGroupId: cancelled.processGroupId,
        admission: cancelled.admission,
        workerAlive: true,
        waitingPhase: 'pending',
      },
      'The store refuses to signal a process it cannot verify, so asking again changes nothing: ' +
        'the queue must not request cleanup on startup or on the next pass, and the task keeps ' +
        'its cancelled state, its process fields and its slot.',
    )

    // The recheck stays: once that process has exited, a later pass frees the
    // slot and the waiting task launches.
    await stopWorker(worker)
    queue.wake()
    await harness.launcher.launched(waiting.id)
    const released = await harness.store.getTaskRecord(session.id, cancelled.id)
    assert.deepEqual(
      { status: released?.status, admission: released?.admission },
      { status: 'cancelled', admission: undefined },
    )
  } finally {
    await destroyHarness(harness)
    await stopWorker(worker)
  }
})

// A marker that several live processes carry verifies none of them as the
// task's own, so nothing shows the root gone (matrix A5.1). For a task this
// version launched, whose scope could otherwise be closed, that must still
// keep its slot and leave its scope unclosed.
test('a cancelled task whose marker two live processes carry keeps its slot and its scope unclosed', {
  timeout: 30_000,
  skip: process.platform === 'win32',
}, async () => {
  const harness = createHarness('ambiguous')
  const workers: ChildProcess[] = []
  try {
    const session = await harness.store.createSession({ title: 'Ambiguous cancellation' })
    const created = requiredValue(
      await harness.store.createTaskRecord(session.id, {
        workflowId: 'cancelled-cleanup-workflow',
        brief: 'Keep the slot while processes carrying the marker run.',
      }),
      'created task',
    )
    const executionAttemptId = `attempt-${created.id}`
    workers.push(await spawnWorker(executionAttemptId))
    workers.push(await spawnWorker(executionAttemptId))
    const seeded = await harness.store.compareAndSetTaskRecord(
      session.id,
      created.id,
      ['queued'],
      {
        status: 'cancelled',
        admission: grantedAdmission(executionAttemptId),
        processIdentity: executionAttemptId,
        executionAttemptId,
        executionAttemptNumber: 1,
        ...await currentAttemptScope(created, 1),
        executionKind: 'initial',
        attemptStartedAt: FIXED_NOW.toISOString(),
        workerStartedAt: FIXED_NOW.toISOString(),
        completedAt: FIXED_NOW.toISOString(),
        error: 'Cancelled by user',
      },
      { expectedExecutionAttemptId: null },
    )
    const cancelled = requiredValue(seeded?.task, 'cancelled task')
    const waiting = await seedInterruptedTask(harness.store, session.id)

    const queue = await startQueue(harness)
    // enqueueRecovery takes the queue's mutation lock after the pass that
    // initialize started, so both passes have run when it resolves.
    await queue.enqueueRecovery({ sessionId: session.id, taskId: waiting.id, source: 'manual_resume' })

    const held = requiredValue(await harness.store.getTaskRecord(session.id, cancelled.id), 'held task')
    const scopeClosedPath = path.join(ownedProcessScopePath({
      workspacePath: harness.workspacePath,
      sessionId: session.id,
      taskId: cancelled.id,
      executionAttemptNumber: 1,
    }), 'closed.json')
    assert.deepEqual(
      {
        status: held.status,
        admission: held.admission,
        scopeClosed: fs.existsSync(scopeClosedPath),
        workersAlive: workers.map((worker) => defaultIsProcessAlive(-requiredValue(worker.pid, 'worker pid'))),
        waitingPhase: (await harness.store.getTaskRecord(session.id, waiting.id))?.admission?.phase,
      },
      {
        status: 'cancelled',
        admission: cancelled.admission,
        scopeClosed: false,
        workersAlive: [true, true],
        waitingPhase: 'pending',
      },
      'Two live processes carry the task\'s marker and neither is verified as its own, so nothing ' +
        'shows the attempt stopped: the task keeps its slot and its scope stays unclosed.',
    )
  } finally {
    await destroyHarness(harness)
    for (const worker of workers) await stopWorker(worker)
  }
})

// The store refuses to act on a marker several live processes carry, as on an
// unverified live process, so asking it to clean up changes nothing. Asking
// anyway made each dispatch pass wake the next one at once.
test('the queue does not keep asking to clean up a cancelled task whose marker several live processes carry', {
  timeout: 30_000,
  skip: process.platform === 'win32',
}, async (t) => {
  const harness = createHarness('ambiguous-requests')
  const workers: ChildProcess[] = []
  try {
    const session = await harness.store.createSession({ title: 'Ambiguous cancellation requests' })
    const created = requiredValue(
      await harness.store.createTaskRecord(session.id, {
        workflowId: 'cancelled-cleanup-workflow',
        brief: 'Keep the slot, without asking again, while processes carrying the marker run.',
      }),
      'created task',
    )
    const executionAttemptId = `attempt-${created.id}`
    workers.push(await spawnWorker(executionAttemptId))
    workers.push(await spawnWorker(executionAttemptId))
    const cancelled = requiredValue((await harness.store.compareAndSetTaskRecord(
      session.id,
      created.id,
      ['queued'],
      {
        status: 'cancelled',
        admission: grantedAdmission(executionAttemptId),
        processIdentity: executionAttemptId,
        executionAttemptId,
        executionAttemptNumber: 1,
        ...await currentAttemptScope(created, 1),
        executionKind: 'initial',
        attemptStartedAt: FIXED_NOW.toISOString(),
        workerStartedAt: FIXED_NOW.toISOString(),
        completedAt: FIXED_NOW.toISOString(),
        error: 'Cancelled by user',
      },
      { expectedExecutionAttemptId: null },
    ))?.task, 'cancelled task')
    const waiting = await seedInterruptedTask(harness.store, session.id)

    const queue = await startQueue(harness)
    // enqueueRecovery takes the queue's mutation lock after the pass that
    // initialize started, so both passes have run when it resolves.
    await queue.enqueueRecovery({ sessionId: session.id, taskId: waiting.id, source: 'manual_resume' })

    const requests = cleanupRequests(harness.workspacePath, cancelled.id)
    t.diagnostic(`cleanup requests by the time of the check: ${requests}`)
    const held = requiredValue(await harness.store.getTaskRecord(session.id, cancelled.id), 'held task')
    assert.deepEqual(
      {
        cleanupRequests: requests,
        status: held.status,
        admission: held.admission,
        workersAlive: workers.map((worker) => defaultIsProcessAlive(-requiredValue(worker.pid, 'worker pid'))),
        waitingPhase: (await harness.store.getTaskRecord(session.id, waiting.id))?.admission?.phase,
      },
      {
        cleanupRequests: 0,
        status: 'cancelled',
        admission: cancelled.admission,
        workersAlive: [true, true],
        waitingPhase: 'pending',
      },
      'The store cannot act on a marker several live processes carry, so the queue must not ask it ' +
        'to clean up, on startup or on the next pass; the task keeps its cancelled state and its slot.',
    )

    // The recheck stays: once those processes have exited, a later pass frees
    // the slot and the waiting task launches.
    for (const worker of workers) await stopWorker(worker)
    queue.wake()
    await harness.launcher.launched(waiting.id)
    const released = await harness.store.getTaskRecord(session.id, cancelled.id)
    assert.deepEqual(
      { status: released?.status, admission: released?.admission },
      { status: 'cancelled', admission: undefined },
    )
  } finally {
    await destroyHarness(harness)
    for (const worker of workers) await stopWorker(worker)
  }
})

test('the queue still terminates and releases a cancelled task whose live worker it can verify', {
  timeout: 30_000,
  skip: process.platform === 'win32',
}, async () => {
  const harness = createHarness('verified')
  const processIdentity = `verified-cancelled-${process.pid}`
  const worker = await spawnWorker(processIdentity)
  const workerExited = once(worker, 'exit')
  try {
    const session = await harness.store.createSession({ title: 'Verified cancellation' })
    // The state a cancel leaves when it stopped after fencing the attempt and
    // before signalling the worker.
    const created = requiredValue(
      await harness.store.createTaskRecord(session.id, {
        workflowId: 'cancelled-cleanup-workflow',
        brief: 'Hold a verified worker until the queue cleans it up.',
      }),
      'created task',
    )
    const workerPid = requiredValue(worker.pid, 'worker pid')
    const seeded = await harness.store.compareAndSetTaskRecord(
      session.id,
      created.id,
      ['queued'],
      {
        status: 'cancelled',
        admission: grantedAdmission(processIdentity),
        processIdentity,
        executionAttemptId: processIdentity,
        executionAttemptNumber: 1,
        ...await currentAttemptScope(created, 1),
        executionKind: 'initial',
        attemptStartedAt: FIXED_NOW.toISOString(),
        workerStartedAt: FIXED_NOW.toISOString(),
        completedAt: FIXED_NOW.toISOString(),
        error: 'Cancelled by user',
        pid: workerPid,
        processGroupId: workerPid,
      },
      { expectedExecutionAttemptId: null },
    )
    assert.equal(seeded?.updated, true)
    const cancelled = requiredValue(seeded?.task, 'cancelled task')
    assert.deepEqual(
      {
        owned: harness.store.ownsTaskProcess(cancelled),
        alive: harness.store.isTaskProcessAlive(cancelled),
        identityVerified: harness.store.hasValidTaskProcessIdentity(cancelled),
      },
      { owned: true, alive: true, identityVerified: true },
    )
    const waiting = await seedInterruptedTask(harness.store, session.id)

    const queue = await startQueue(harness)
    await workerExited
    await queue.enqueueRecovery({ sessionId: session.id, taskId: waiting.id, source: 'manual_resume' })
    await harness.launcher.launched(waiting.id)

    const released = await harness.store.getTaskRecord(session.id, cancelled.id)
    assert.deepEqual(
      {
        cleanupRequests: cleanupRequests(harness.workspacePath, cancelled.id),
        status: released?.status,
        pid: released?.pid,
        processGroupId: released?.processGroupId,
        admission: released?.admission,
      },
      {
        cleanupRequests: 1,
        status: 'cancelled',
        pid: undefined,
        processGroupId: undefined,
        admission: undefined,
      },
    )
  } finally {
    await destroyHarness(harness)
    await stopWorker(worker)
  }
})

test('the queue still cleans up a cancelled task whose worker is found by identity away from a reused recorded pid', {
  timeout: 30_000,
  skip: process.platform === 'win32',
}, async () => {
  // The recorded pid and group now belong to an unrelated live process with no
  // marker, as after PID reuse. The actual worker carries the task's marker in
  // a group of its own. cleanupCancelledTaskProcess (task-recovery-manager.ts)
  // finds a unique marked process, records it and terminates it; the queue
  // must still ask it to.
  const harness = createHarness('relocated')
  const unrelated = await spawnWorker()
  let worker: ChildProcess | undefined
  try {
    const session = await harness.store.createSession({ title: 'Relocated cancellation' })
    const running = await seedOwnedRunningTask({
      store: harness.store,
      sessionId: session.id,
      worker: unrelated,
    })
    worker = await spawnWorker(requiredValue(running.processIdentity, 'process identity'))
    const workerGroup = -requiredValue(worker.pid, 'worker pid')
    await assert.rejects(
      cancelSessionTask({
        sessionId: session.id,
        taskId: running.id,
        sessionStore: harness.store,
      }),
      /process cleanup remains pending/,
    )
    const cancelled = requiredValue(
      await harness.store.getTaskRecord(session.id, running.id),
      'cancelled task',
    )
    assert.deepEqual(
      {
        status: cancelled.status,
        admissionPhase: cancelled.admission?.phase,
        pid: cancelled.pid,
        recordedAlive: harness.store.isTaskProcessAlive(cancelled),
        recordedIdentityVerified: harness.store.hasValidTaskProcessIdentity(cancelled),
        workerAlive: defaultIsProcessAlive(workerGroup),
      },
      {
        status: 'cancelled',
        admissionPhase: 'granted',
        pid: unrelated.pid,
        recordedAlive: true,
        recordedIdentityVerified: false,
        workerAlive: true,
      },
    )
    const waiting = await seedInterruptedTask(harness.store, session.id)

    const queue = await startQueue(harness)
    // enqueueRecovery takes the queue's mutation lock after the pass that
    // initialize started, so both passes have run when it resolves.
    await queue.enqueueRecovery({ sessionId: session.id, taskId: waiting.id, source: 'manual_resume' })

    const released = await harness.store.getTaskRecord(session.id, cancelled.id)
    assert.deepEqual(
      {
        cleanupRequests: cleanupRequests(harness.workspacePath, cancelled.id),
        workerAlive: defaultIsProcessAlive(workerGroup),
        unrelatedAlive: defaultIsProcessAlive(-requiredValue(unrelated.pid, 'unrelated pid')),
        status: released?.status,
        pid: released?.pid,
        processGroupId: released?.processGroupId,
        admission: released?.admission,
      },
      {
        cleanupRequests: 1,
        workerAlive: false,
        unrelatedAlive: true,
        status: 'cancelled',
        pid: undefined,
        processGroupId: undefined,
        admission: undefined,
      },
      'A unique marked worker elsewhere is the task\'s own process: cleanup must stop it, ' +
        'leave the unrelated process holding the recorded pid alone, and free the slot.',
    )
    await harness.launcher.launched(waiting.id)
  } finally {
    await destroyHarness(harness)
    if (worker) await stopWorker(worker)
    await stopWorker(unrelated)
  }
})
