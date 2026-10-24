import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Readable } from 'node:stream'
import test, { after } from 'node:test'

import { requiredValue } from '../../core/required-value.js'
import type { SessionTask, TaskAdmission } from '../../contracts/sessions.js'
import { getAssignmentLogPath } from '../../domains/runtime/logger.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { currentAttemptScope } from '../support/current-attempt-scope.js'
import {
  defaultIsProcessAlive,
  PROCESS_IDENTITY_ARGUMENT,
} from '../../domains/sessions/task-process-supervisor.js'
import {
  FileSystemWorkflowStateStore,
  hashWorkflowContent,
} from '../../workflows/workflow-state-store.js'

// The owner reconciles one of its own admitted tasks through the store's public
// FileSystemSessionStore.reconcileAdmittedTaskRecord, the call the queue makes
// from TaskQueue.executePostMutationActions (services/task-queue.ts:1700). The
// recorded worker is a real child that is alive but has no process identity
// marker on its command line, so the store's real ps-based probe cannot verify
// it. That is what the probe sees for a reused PID or a confirmed mismatch, and
// the probe's boolean answer is the same when ps itself fails
// (task-process-supervisor.ts:101-105, 215-217, 235-236). What made the probe
// fail in the packaged run is not established; a one-time ps failure is only a
// hypothesis. Stale configured-provider broker identity after the first
// connection (electron/main.ts:252-256) is covered by
// task-queue-provider-broker-reconciliation.test.ts.
//
// The contract. Only a worker that is gone (kill(target, 0) fails with ESRCH)
// proves the owned task dead. The owner reconciles it on the first pass once the
// record is older than staleTaskGraceMs, as today.
// A worker that is alive (kill 0 succeeds or reports EPERM) is never reconciled
// by the owner, however long it runs and however many identity probes fail:
// elapsed time plus failed probes is not proof of death, and clearing pid and
// admission while the process may still be the worker brings back the detached
// worker and duplicate resume, only later. The task keeps status, pid,
// processGroupId, processIdentity and its granted admission, and a later pass
// tries again. This holds whether ps could not be read or ps was read and the
// group carries no marker. The store's probe answers false in both cases, and
// the store's reconcile path writes nothing that could tell them apart, so this
// file does not try to.
//
// Residual limitation. A live process that holds the recorded pid or pgid but
// cannot be confirmed (a reused PID, say) keeps the task's state and its grant
// until that process exits. A cancel ends it sooner only when the task's marker
// matches exactly one live process elsewhere: cleanup then moves the record to
// that worker and stops it (task-queue-cancelled-process-reconciliation.test.ts
// covers this). The queue side is
// wider than one slot (read from code, not asserted here): for any granted task whose process
// is alive and unverified, TaskQueue sets dispatchBlockedByAmbiguity
// (task-queue.ts:913-916). While that holds it reserves nothing new
// (task-queue.ts:708), its snapshot reports 'blocked' (task-queue.ts:216-217),
// and it emits task_queue.dispatch_blocked with reason
// ambiguous_process_identity once (task-queue.ts:1080-1083). The user can cancel
// (cancelSessionTask, services/task-service.ts:840). The cancel sets the task to
// cancelled first (:880-888), which fences the attempt. terminateTaskProcess
// then refuses to signal a process whose marker it cannot see
// (task-process-supervisor.ts:140-143), so the cancel throws "process cleanup
// remains pending" (:990) before the admission release at :934. Without a
// unique marked worker to recover, the grant and the queue block therefore last
// until the process exits, which the user may have to cause outside the app.
//
// Substituted boundaries. This is not a full desktop stack:
// - The grant. The test writes a granted admission through the store's public
//   compareAndSetTaskRecord, as session-task-process-lifecycle.test.ts:79-99
//   and :294-301 do, instead of having TaskQueue grant it. No queue runs here:
//   this file pins the store's verdict on the record, and each pass is awaited
//   directly. The queue's side (it drops a grant as
//   grant_no_longer_authoritative once the record's admission is cleared,
//   task-queue.ts:862-871) is covered on a real path by task-queue-core.test.ts
//   :1527-1622, whose `interrupted` iteration clears the admission of a real
//   SessionTaskRunnerLauncher worker and then sees the successor granted. That
//   test observes the freed slot, not the reason string.
// - The worker. A plain detached node child, not SessionTaskRunnerLauncher: the
//   real task runner carries --runtime-process-identity=<attempt>, so its
//   identity would verify and this state could not arise without mocking the
//   probe. No probe is mocked.
// - The clock. The store and the journal read an injected now() that returns
//   a fixed instant the test sets by assignment.

const FIXED_START_MS = Date.parse('2026-01-01T09:00:00.000Z')
const STALE_TASK_GRACE_MS = 5_000
const ONE_HOUR_MS = 60 * 60 * 1_000
const ONE_DAY_MS = 24 * ONE_HOUR_MS
const THIRTY_DAYS_MS = 30 * ONE_DAY_MS

const FINALIZE_STEP_RECOVERY_REASON =
  'The interrupted step requires a user recovery decision.'

/** Every process group a fixture here started, checked once all tests have run. */
const fixtureProcessGroups = new Set<number>()

after(() => {
  const survivors = [...fixtureProcessGroups].filter((group) => defaultIsProcessAlive(-group))
  assert.deepEqual(survivors, [], 'no fixture process group may outlive this file')
})

interface StoreHarness {
  workspacePath: string
  sessionStore: FileSystemSessionStore
  /** The instant now() returns. It moves only when a test assigns it. */
  clock: { nowMs: number }
}

function createStoreHarness(): StoreHarness {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'owned-task-live-worker-recovery-'),
  )
  const clock = { nowMs: FIXED_START_MS }
  const sessionStore = new FileSystemSessionStore(workspacePath, {
    instanceId: 'owned-task-owner',
    now: () => new Date(clock.nowMs),
    staleTaskGraceMs: STALE_TASK_GRACE_MS,
  })
  return { workspacePath, sessionStore, clock }
}

function destroyStoreHarness(harness: StoreHarness): void {
  fs.rmSync(harness.workspacePath, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 20,
  })
}

/** A real, long-lived process in its own group with no identity marker on its command line. */
async function spawnUnmarkedWorker(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1e9)'],
    { detached: true, stdio: 'ignore' },
  )
  await once(child, 'spawn')
  fixtureProcessGroups.add(requiredValue(child.pid, 'worker pid'))
  assert.equal(
    child.spawnargs.some((argument) => argument.includes(PROCESS_IDENTITY_ARGUMENT)),
    false,
    'the worker command line must not carry a process identity marker',
  )
  return child
}

/** A group whose leader has exited and been reaped while one descendant runs on. */
interface OrphanedGroup {
  leader: ChildProcess
  processGroupId: number
  descendantPid: number
  /** Settles once the descendant, the last holder of the leader's stdout, has exited. */
  closed: Promise<unknown>
}

/** Resolves with the first newline-terminated line and keeps the stream flowing. */
function firstLine(stream: Readable): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffered = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      buffered += chunk
      const newline = buffered.indexOf('\n')
      if (newline >= 0) resolve(buffered.slice(0, newline))
    })
    stream.once('end', () => reject(new Error('the stream ended before a full line')))
  })
}

/**
 * A detached leader that starts one descendant in its own process group and
 * exits. Neither carries an identity marker. The descendant writes its own pid
 * to the leader's stdout, which it inherits, so that pipe closes only when the
 * descendant exits.
 */
async function spawnOrphanedGroup(): Promise<OrphanedGroup> {
  const descendant = "process.stdout.write(process.pid + '\\n'); setInterval(() => {}, 1e9)"
  const leader = spawn(
    process.execPath,
    [
      '-e',
      "const { spawn } = require('node:child_process');" +
        `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], ` +
        "{ stdio: ['ignore', 'inherit', 'ignore'] }).unref()",
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
  )
  const exited = once(leader, 'exit')
  const closed = once(leader, 'close')
  await once(leader, 'spawn')
  const processGroupId = requiredValue(leader.pid, 'leader pid')
  fixtureProcessGroups.add(processGroupId)
  const descendantPid = Number(await firstLine(requiredValue(leader.stdout, 'leader stdout')))
  await exited
  return { leader, processGroupId, descendantPid, closed }
}

/** Kills only the fixture's own group and waits until its descendant has exited. */
async function stopOrphanedGroup(group: OrphanedGroup): Promise<void> {
  try {
    process.kill(-group.processGroupId, 'SIGKILL')
  } catch {
    // The group is already gone; the close event has settled or will.
  }
  await group.closed
}

/** Kills the worker's process group and waits for its exit event. */
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
  grantedAt: string,
): Extract<TaskAdmission, { phase: 'granted' }> {
  return {
    version: 1,
    phase: 'granted',
    requestId: `request-${executionAttemptId}`,
    order: '1',
    requestedAt: grantedAt,
    executionKind: 'initial',
    source: 'apply',
    expectedExecutionAttemptId: null,
    grantId: `grant-${executionAttemptId}`,
    ownerEpoch: 'owner-epoch-1',
    grantedAt,
    executionAttemptId,
  }
}

/**
 * Creates this store's own task and records the real worker on it with a
 * granted admission, the state a launch leaves once the worker is attached.
 * updatedAt, workerStartedAt and grantedAt are all the fixed start instant.
 */
async function admitOwnedRunningTask(
  harness: StoreHarness,
  worker: ChildProcess,
): Promise<SessionTask> {
  const session = await harness.sessionStore.createSession({
    title: 'Owned task with a live worker',
  })
  const created = requiredValue(
    await harness.sessionStore.createTaskRecord(session.id, {
      workflowId: 'owned-recovery-workflow',
      brief: 'Write the final report for the owned recovery regression.',
    }),
    'created task',
  )
  const executionAttemptId = `attempt-${created.id}`
  const startedAt = new Date(harness.clock.nowMs).toISOString()
  await initializeRunningWorkflowJournal(harness, created, executionAttemptId)

  const workerPid = requiredValue(worker.pid, 'worker pid')
  const running = await harness.sessionStore.compareAndSetTaskRecord(
    session.id,
    created.id,
    ['queued'],
    {
      status: 'running',
      admission: grantedAdmission(executionAttemptId, startedAt),
      processIdentity: executionAttemptId,
      executionAttemptId,
      executionAttemptNumber: 1,
      ...await currentAttemptScope(created, 1),
      executionKind: 'initial',
      attemptStartedAt: startedAt,
      pid: workerPid,
      processGroupId: workerPid,
      workerStartedAt: startedAt,
    },
    { expectedExecutionAttemptId: null },
  )
  assert.equal(running?.updated, true)
  return requiredValue(running?.task, 'running task')
}

/** A durable journal with its only step running under a manual recovery policy. */
async function initializeRunningWorkflowJournal(
  harness: StoreHarness,
  task: SessionTask,
  executionAttemptId: string,
): Promise<void> {
  const assignmentPath = requiredValue(task.assignmentPath, 'task assignment path')
  const store = new FileSystemWorkflowStateStore(assignmentPath, {
    now: () => new Date(harness.clock.nowMs),
  })
  await store.initialize({
    manifest: {
      taskId: task.id,
      sessionId: task.sessionId,
      rootRunId: task.runId,
      workflowId: task.workflowId,
      workflowDefinitionHash: hashWorkflowContent('owned-recovery-workflow:v1'),
      briefHash: hashWorkflowContent(task.brief),
      teamDefinitionHashes: {
        writers: hashWorkflowContent('writers:v1'),
      },
      runtimeVersion: 'workflow-runtime-v1',
    },
    executionAttemptId,
    steps: [
      {
        stepId: 'finalize',
        stepIndex: 0,
        stepType: 'team',
        team: 'writers',
        definitionHash: hashWorkflowContent('finalize-step:v1'),
        recoveryPolicy: 'manual',
        childRunId: randomUUID(),
        inputArtifact: 'incoming-brief.md',
        resultArtifact: 'report.md',
        requestedResultType: 'artifact:report.md',
      },
    ],
  })
  const launching = await store.update({
    expectedRevision: 0,
    executionAttemptId,
    mutate(state) {
      state.currentStepId = 'finalize'
      const step = requiredValue(state.steps[0], 'finalize step')
      step.status = 'launching'
      step.attemptCount = 1
      step.startedAt = new Date(harness.clock.nowMs).toISOString()
    },
  })
  await store.update({
    expectedRevision: launching.revision,
    executionAttemptId,
    mutate(state) {
      requiredValue(state.steps[0], 'finalize step').status = 'running'
    },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJsonl(filePath: string): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) return []
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line): unknown => JSON.parse(line))
    .filter(isRecord)
}

function runInterruptedEventCount(task: SessionTask): number {
  const assignmentPath = requiredValue(task.assignmentPath, 'task assignment path')
  return readJsonl(getAssignmentLogPath(assignmentPath, 'runtime-events.jsonl'))
    .filter((event) => event.event === 'run.interrupted' && event.task_id === task.id)
    .length
}

/**
 * The record fields, journal events and worker state one reconcile pass leaves.
 * identityVerified re-runs the store's real probe against the originally
 * recorded pid and group, so it shows the probe still fails at that pass.
 */
async function observeOwnedTask(
  harness: StoreHarness,
  running: SessionTask,
  worker: ChildProcess,
) {
  const current = await harness.sessionStore.getTaskRecord(running.sessionId, running.id)
  return {
    identityVerified: harness.sessionStore.hasValidTaskProcessIdentity(running),
    status: current?.status,
    pid: current?.pid,
    processGroupId: current?.processGroupId,
    processIdentity: current?.processIdentity,
    admission: current?.admission,
    runInterruptedEvents: runInterruptedEventCount(running),
    workerAlive: defaultIsProcessAlive(-requiredValue(worker.pid, 'worker pid')),
  }
}

/** What an owned task with a live, unverified worker must look like after any pass. */
function heldOwnedTask(running: SessionTask, workerPid: number) {
  return {
    identityVerified: false,
    status: 'running',
    pid: workerPid,
    processGroupId: workerPid,
    processIdentity: running.processIdentity,
    admission: running.admission,
    runInterruptedEvents: 0,
    workerAlive: true,
  }
}

/** Sets the fixed clock to `ageMs` after the record's updatedAt and runs one owner pass. */
async function reconcileAtAge(
  harness: StoreHarness,
  running: SessionTask,
  ageMs: number,
): Promise<void> {
  harness.clock.nowMs = Date.parse(requiredValue(running.updatedAt, 'task updatedAt')) + ageMs
  await harness.sessionStore.reconcileAdmittedTaskRecord(running.sessionId, running.id)
}

function preconditions(harness: StoreHarness, running: SessionTask) {
  return {
    updatedAt: running.updatedAt,
    processIdentity: running.processIdentity,
    admissionPhase: running.admission?.phase,
    owned: harness.sessionStore.ownsTaskProcess(running),
    alive: harness.sessionStore.isTaskProcessAlive(running),
    identityVerified: harness.sessionStore.hasValidTaskProcessIdentity(running),
  }
}

test('owner reconciliation keeps its live worker running with its grant when identity is unconfirmed', {
  timeout: 30_000,
}, async () => {
  const harness = createStoreHarness()
  let worker: ChildProcess | undefined
  try {
    worker = await spawnUnmarkedWorker()
    const running = await admitOwnedRunningTask(harness, worker)
    const workerPid = requiredValue(worker.pid, 'worker pid')
    assert.deepEqual(preconditions(harness, running), {
      updatedAt: new Date(FIXED_START_MS).toISOString(),
      processIdentity: `attempt-${running.id}`,
      admissionPhase: 'granted',
      owned: true,
      alive: true,
      identityVerified: false,
    })

    await reconcileAtAge(harness, running, STALE_TASK_GRACE_MS + 1)

    assert.deepEqual(
      await observeOwnedTask(harness, running, worker),
      heldOwnedTask(running, workerPid),
      'An unconfirmed identity is not evidence that the owner\'s live worker is gone: ' +
        'the task must stay running with its pid, processGroupId, processIdentity and grant, ' +
        'and no run.interrupted may be written.',
    )
  } finally {
    if (worker) await stopWorker(worker)
    destroyStoreHarness(harness)
  }
})

test('owner reconciliation still interrupts a task whose worker has exited and clears its grant', {
  timeout: 30_000,
}, async () => {
  const harness = createStoreHarness()
  let worker: ChildProcess | undefined
  try {
    worker = await spawnUnmarkedWorker()
    const running = await admitOwnedRunningTask(harness, worker)
    await stopWorker(worker)
    assert.deepEqual(preconditions(harness, running), {
      updatedAt: new Date(FIXED_START_MS).toISOString(),
      processIdentity: `attempt-${running.id}`,
      admissionPhase: 'granted',
      owned: true,
      alive: false,
      identityVerified: false,
    })

    await reconcileAtAge(harness, running, STALE_TASK_GRACE_MS + 1)
    const current = await harness.sessionStore.getTaskRecord(running.sessionId, running.id)

    assert.deepEqual(
      {
        status: current?.status,
        interruptedAt: current?.interruptedAt,
        recoveryDisposition: current?.recoveryDisposition,
        recoveryReason: current?.recoveryReason,
        executionAttemptId: current?.executionAttemptId,
        pid: current?.pid,
        processGroupId: current?.processGroupId,
        admission: current?.admission,
        runInterruptedEvents: runInterruptedEventCount(running),
      },
      {
        status: 'interrupted',
        interruptedAt: new Date(harness.clock.nowMs).toISOString(),
        recoveryDisposition: 'manual',
        recoveryReason: FINALIZE_STEP_RECOVERY_REASON,
        executionAttemptId: running.executionAttemptId,
        pid: undefined,
        processGroupId: undefined,
        admission: undefined,
        runInterruptedEvents: 1,
      },
    )
  } finally {
    if (worker) await stopWorker(worker)
    destroyStoreHarness(harness)
  }
})

test('owner reconciliation never interrupts a live worker whose identity stays unconfirmed, however long it runs', {
  timeout: 30_000,
}, async () => {
  // No timeout policy for an owned live process. Each pass runs the store's
  // real liveness and ps probes again; the fixed clock moves from just past
  // the stale grace to thirty days, and the task must look the same after
  // every pass. See the residual limitation in the header: this is the case
  // that keeps a reused PID's task, and the queue's dispatch, blocked until
  // the process exits.
  const harness = createStoreHarness()
  let worker: ChildProcess | undefined
  try {
    worker = await spawnUnmarkedWorker()
    const running = await admitOwnedRunningTask(harness, worker)
    const workerPid = requiredValue(worker.pid, 'worker pid')
    assert.deepEqual(preconditions(harness, running), {
      updatedAt: new Date(FIXED_START_MS).toISOString(),
      processIdentity: `attempt-${running.id}`,
      admissionPhase: 'granted',
      owned: true,
      alive: true,
      identityVerified: false,
    })

    await reconcileAtAge(harness, running, STALE_TASK_GRACE_MS + 1)
    const pastGrace = await observeOwnedTask(harness, running, worker)
    await reconcileAtAge(harness, running, ONE_HOUR_MS)
    const afterOneHour = await observeOwnedTask(harness, running, worker)
    await reconcileAtAge(harness, running, ONE_DAY_MS)
    const afterOneDay = await observeOwnedTask(harness, running, worker)
    await reconcileAtAge(harness, running, THIRTY_DAYS_MS)
    const afterThirtyDays = await observeOwnedTask(harness, running, worker)

    const held = heldOwnedTask(running, workerPid)
    assert.deepEqual(
      { pastGrace, afterOneHour, afterOneDay, afterThirtyDays },
      {
        pastGrace: held,
        afterOneHour: held,
        afterOneDay: held,
        afterThirtyDays: held,
      },
      'Elapsed time and repeated failed identity probes are not proof that a live worker is gone: ' +
        'the owner must keep the task running with its pid, processGroupId, processIdentity and grant ' +
        'on every pass, and never write run.interrupted.',
    )
  } finally {
    if (worker) await stopWorker(worker)
    destroyStoreHarness(harness)
  }
})

// Characterization, written after the implementation (test-last), not a Red.
// It pins the one liveness rule the owner's decision depends on: the store
// probes the recorded process group (taskProcessTarget,
// task-process-supervisor.ts:81-90), not the leader pid. Here the leader has
// exited and been reaped, so kill(pid, 0) fails with ESRCH, while its
// descendant keeps the group alive. The owner keeps the task. A check on the
// leader pid alone would interrupt it and leave the descendant running
// unrecorded. Release once the whole group is gone is the second test above.
test('owner reconciliation keeps a task whose group outlives its exited leader', {
  timeout: 30_000,
  skip: process.platform === 'win32',
}, async () => {
  const harness = createStoreHarness()
  let group: OrphanedGroup | undefined
  try {
    group = await spawnOrphanedGroup()
    const running = await admitOwnedRunningTask(harness, group.leader)
    assert.deepEqual(
      {
        leaderAlive: defaultIsProcessAlive(group.processGroupId),
        descendantIsAnotherProcess: group.descendantPid !== group.processGroupId,
        descendantAlive: defaultIsProcessAlive(group.descendantPid),
        groupAlive: defaultIsProcessAlive(-group.processGroupId),
        ...preconditions(harness, running),
      },
      {
        leaderAlive: false,
        descendantIsAnotherProcess: true,
        descendantAlive: true,
        groupAlive: true,
        updatedAt: new Date(FIXED_START_MS).toISOString(),
        processIdentity: `attempt-${running.id}`,
        admissionPhase: 'granted',
        owned: true,
        alive: true,
        identityVerified: false,
      },
    )

    await reconcileAtAge(harness, running, STALE_TASK_GRACE_MS + 1)

    assert.deepEqual(
      await observeOwnedTask(harness, running, group.leader),
      heldOwnedTask(running, group.processGroupId),
      'A live member of the recorded group is a live worker even after the leader has exited: ' +
        'the task must stay running with its pid, processGroupId, processIdentity and grant, ' +
        'and no run.interrupted may be written.',
    )
  } finally {
    if (group) await stopOrphanedGroup(group)
    destroyStoreHarness(harness)
  }
})
