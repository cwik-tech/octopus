import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { requiredValue } from '../../core/required-value.js'
import {
  describeErrors,
  processesCarrying,
  stopAllCarrying,
  withinBound,
} from '../support/fixture-process-markers.js'
import { WorkspaceDispatcherOwner } from '../../core/workspace-dispatcher-owner.js'
import { TASK_QUEUE_EVENT_FILENAME } from '../../core/task-queue-events.js'
import { buildSessionRunAssignmentLocation } from '../../core/run-assignment-location.js'
import {
  ensureRunPrivateRuntimeDirectory,
  getRunAttemptTemporaryPath,
} from '../../domains/runtime/runtime-paths.js'
import type { SessionTask, TaskAdmission } from '../../contracts/sessions.js'
import type { RunLauncher } from '../../domains/run/run-launcher.js'
import type { RunStartRequest } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { TaskQueue } from '../../services/task-queue.js'
import { cancelSessionTask } from '../../services/task-service.js'
import { currentAttemptScope } from '../support/current-attempt-scope.js'
import { PROCESS_IDENTITY_ARGUMENT } from '../../domains/sessions/task-process-supervisor.js'
import {
  FileSystemWorkflowStateStore,
  hashHumanInputSubmission,
  hashWorkflowContent,
} from '../../workflows/workflow-state-store.js'
import type { DurableWorkflowState } from '../../workflows/types.js'

// Requirements (docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md,
// sections 7 and 8, verification items 6 and 7): a slot is released only once
// the task's descendants are verified gone, whatever the task's status, and
// across a restart. A held wait enqueues no continuation until its scope is
// closed, keeps the answer or consent, and runs the continuation exactly once.
//
// Each test seeds the durable state a previous app instance left: task
// records, a workflow journal where one matters, and the attempt's ownership
// scope in the ADR's format. The unverifiable member is native: a host that
// led its own process group was killed alone, and the target it started still
// runs in that group, so the recorded group is alive and no process carries the
// host's marker. Starting a queue on that workspace is the restart. The
// launcher starts nothing; it reports each launch as an event.

const TEST_TICK_INTERVAL_MS = 60_000

class SignallingLauncher implements RunLauncher {
  readonly starts: string[] = []
  private readonly waiters: Array<{ readonly taskId: string; readonly resolve: () => void }> = []

  launched(taskId: string): Promise<void> {
    if (this.starts.includes(taskId)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.waiters.push({ taskId, resolve })
    })
  }

  async startRun(request: RunStartRequest): Promise<never> {
    const taskId = requiredValue(request.env?.TEAM_RUNTIME_TASK_ID, 'launched task id')
    this.starts.push(taskId)
    for (const waiter of this.waiters.filter((candidate) => candidate.taskId === taskId)) waiter.resolve()
    return await new Promise<never>(() => undefined)
  }
}

interface RunningQueue {
  readonly queue: TaskQueue
  readonly owner: WorkspaceDispatcherOwner
  readonly initialized: { readonly pending: number; readonly granted: number; readonly legacyActive: number }
}

/** A queue started on the workspace by a fresh app instance: the restart. */
async function startQueue(
  workspacePath: string,
  launcher: RunLauncher,
  maximumConcurrentTasks: number,
): Promise<RunningQueue> {
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const queue = new TaskQueue({
    sessionStore: new FileSystemSessionStore(workspacePath, {
      instanceId: `restarted-app-${randomUUID()}`,
    }),
    owner,
    maximumConcurrentTasks,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
  })
  const initialized = await queue.initialize()
  return { queue, owner, initialized }
}

async function stopQueue(running: RunningQueue): Promise<void> {
  await running.queue.close(1)
  await running.owner.release()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function taskRecordPath(workspacePath: string, task: SessionTask): string {
  return path.join(workspacePath, 'sessions', task.sessionId, 'tasks', task.id, 'task.json')
}

/** Adds fields to the stored record, as the app that left it would have written them. */
function amendTaskRecord(
  workspacePath: string,
  task: SessionTask,
  fields: Record<string, unknown>,
): void {
  const recordPath = taskRecordPath(workspacePath, task)
  const record: unknown = JSON.parse(fs.readFileSync(recordPath, 'utf8'))
  assert.ok(isRecord(record))
  fs.writeFileSync(recordPath, `${JSON.stringify({ ...record, ...fields }, null, 2)}\n`)
}

function processCleanupHoldReason(task: SessionTask): unknown {
  const hold: unknown = Reflect.get(task, 'processCleanupHold')
  return isRecord(hold) ? hold.reason : undefined
}

function scopePath(workspacePath: string, task: SessionTask): string {
  return path.join(
    workspacePath,
    'sessions',
    task.sessionId,
    'tasks',
    task.id,
    'owned-processes',
    `attempt-${requiredValue(task.executionAttemptNumber, 'attempt number')}`,
  )
}

function grantedAdmission(executionAttemptId: string, order: string): Extract<TaskAdmission, { phase: 'granted' }> {
  const at = new Date().toISOString()
  return {
    version: 1,
    phase: 'granted',
    requestId: `request-${executionAttemptId}`,
    order,
    requestedAt: at,
    executionKind: 'initial',
    source: 'apply',
    expectedExecutionAttemptId: null,
    grantId: `grant-${executionAttemptId}`,
    ownerEpoch: 'previous-app-owner',
    grantedAt: at,
    executionAttemptId,
  }
}

/** A member whose host was killed alone while its target still runs in the host's group. */
interface HeldMember {
  readonly hostPid: number
  readonly targetPid: number
  /** The fixture's own marker on the host's command line. */
  readonly hostMarker: string
  /** The fixture's own marker on the target's command line. */
  readonly targetMarker: string
  /** Stops the member's processes, found and rechecked by their markers; bounded. */
  stop(): Promise<void>
}

// The target's marker comes through the environment, so it appears on the
// target's command line and never on the host's.
const HOST_SCRIPT = [
  "const { spawn } = require('node:child_process')",
  // The target inherits the host's stdout, so the pipe closes only when the target exits.
  "const target = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', '--', process.env.OWNED_FIXTURE_TARGET], { stdio: ['ignore', 'inherit', 'inherit'] })",
  "target.on('spawn', () => process.stdout.write('ready ' + target.pid + '\\n'))",
  'setInterval(() => {}, 1 << 30)',
].join('\n')

const FIXTURE_BOUND_MS = 5_000

/** Every member a test started, registered the moment its host exists. */
const fixtureMembers: HeldMember[] = []

async function startHeldMember(): Promise<HeldMember> {
  const hostMarker = `--owned-queue-fixture-host=${randomUUID()}`
  const targetMarker = `--owned-queue-fixture-target=${randomUUID()}`
  const host: ChildProcess = spawn(process.execPath, ['-e', HOST_SCRIPT, '--', hostMarker], {
    detached: true,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, OWNED_FIXTURE_TARGET: targetMarker },
  })
  const hostPid = requiredValue(host.pid, 'host pid')
  const closed = once(host, 'close')
  let targetPid = 0
  const member: HeldMember = {
    hostPid,
    get targetPid() { return targetPid },
    hostMarker,
    targetMarker,
    async stop() {
      const errors = await stopAllCarrying([targetMarker, hostMarker])
      if (errors.length > 0) throw new AggregateError(errors, `held member ${hostPid} could not be stopped`)
      await withinBound(closed, FIXTURE_BOUND_MS, `held member ${hostPid} to close`)
    },
  }
  fixtureMembers.push(member)
  const stdout = requiredValue(host.stdout, 'host stdout')
  targetPid = await withinBound(new Promise<number>((resolve, reject) => {
    let buffered = ''
    stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const match = /ready (\d+)\n/u.exec(buffered)
      if (match?.[1]) resolve(Number(match[1]))
    })
    host.once('exit', () => reject(new Error('the fixture host exited before its target started')))
  }), FIXTURE_BOUND_MS, `fixture host ${hostPid} to start its target`)
  stdout.resume()
  const hostExited = once(host, 'exit')
  // Our own unreaped child, so its pid cannot have been reused.
  host.kill('SIGKILL')
  await withinBound(hostExited, FIXTURE_BOUND_MS, `fixture host ${hostPid} to exit`)
  const target = processesCarrying(targetMarker)
  assert.deepEqual(
    target.map((row) => ({ pid: row.pid, groupId: row.groupId })),
    [{ pid: targetPid, groupId: hostPid }],
    'the target still runs in the dead host\'s group',
  )
  return member
}

/** Whether a member's target still runs, found by its own marker. */
function targetRuns(member: HeldMember): boolean {
  return processesCarrying(member.targetMarker).some((row) => row.pid === member.targetPid)
}

/** The attempt's scope, with one Team intent claimed by the held member's dead host. */
function publishHeldScope(workspacePath: string, task: SessionTask, member: HeldMember): string {
  const folder = scopePath(workspacePath, task)
  for (const sub of ['intents', 'claims', 'fences', '.staging']) {
    fs.mkdirSync(path.join(folder, sub), { recursive: true })
  }
  const at = new Date().toISOString()
  fs.writeFileSync(path.join(folder, 'scope.json'), `${JSON.stringify({
    version: 1,
    taskId: task.id,
    sessionId: task.sessionId,
    executionAttemptNumber: task.executionAttemptNumber,
    createdAt: at,
  })}\n`)
  const ownedProcessId = randomUUID()
  fs.writeFileSync(path.join(folder, 'intents', `${ownedProcessId}.json`), `${JSON.stringify({
    version: 1,
    ownedProcessId,
    parentOwnedProcessId: null,
    kind: 'team',
    childRunId: `child-${randomUUID()}`,
    spawnerRunId: task.runId,
    spawnerAssignmentId: task.runId,
    createdAt: at,
  })}\n`)
  fs.writeFileSync(path.join(folder, 'claims', `${ownedProcessId}.json`), `${JSON.stringify({
    version: 1,
    ownedProcessId,
    claimant: 'host',
    pid: member.hostPid,
    processGroupId: member.hostPid,
    claimedAt: at,
  })}\n`)
  return folder
}

function isClosedRecord(folder: string): boolean {
  const closedPath = path.join(folder, 'closed.json')
  if (!fs.existsSync(closedPath)) return false
  const parsed: unknown = JSON.parse(fs.readFileSync(closedPath, 'utf8'))
  return isRecord(parsed) && parsed.version === 1
}

/**
 * Runs `fn` in a fresh workspace. Cleanup stops every member registered,
 * each attempted whatever failed before, keeps the workspace when anything
 * failed, and reports every error beside the body's.
 */
async function withWorkspace(fn: (workspacePath: string) => Promise<void>): Promise<void> {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-process-queue-hold-'))
  const failures: unknown[] = []
  try {
    await fn(workspacePath)
  } catch (error) {
    failures.push(error)
  }
  for (const member of fixtureMembers.splice(0)) {
    try {
      await member.stop()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length === 0) fs.rmSync(workspacePath, { recursive: true, force: true })
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, `the test and its cleanup failed; ${workspacePath} is kept: ${describeErrors(failures)}`)
}

const HELD_SINCE = new Date().toISOString()

test('a terminal task whose scope is held keeps its slot across restarts until the scope is closed', { timeout: 60_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const previousApp = new FileSystemSessionStore(workspacePath, { instanceId: 'previous-app' })
    const session = await previousApp.createSession({ title: 'Held terminal task' })
    const created = requiredValue(await previousApp.createTaskRecord(session.id, {
      workflowId: 'held-terminal-workflow',
      brief: 'A task that ended while one of its Team children could not be verified.',
    }), 'held task')
    const attemptId = randomUUID()
    const admission = grantedAdmission(attemptId, '1')
    const ended = await previousApp.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
      status: 'done',
      executionAttemptId: attemptId,
      processIdentity: attemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      completedAt: new Date().toISOString(),
      admission,
    }, { expectedExecutionAttemptId: null })
    const heldTask = requiredValue(ended?.task, 'ended task')
    // The root's terminal write with the scope held, as section 8 specifies.
    amendTaskRecord(workspacePath, heldTask, {
      ownedProcessScope: 1,
      processCleanupHold: { reason: 'owned_processes_unverified', since: HELD_SINCE },
    })
    const member = await startHeldMember()
    const folder = publishHeldScope(workspacePath, heldTask, member)
    const waiting = requiredValue(await previousApp.createTaskRecord(session.id, {
      workflowId: 'waiting-workflow',
      brief: 'Waits for the only slot.',
    }), 'waiting task')
    const launcher = new SignallingLauncher()

    let running = await startQueue(workspacePath, launcher, 1)
    try {
      for (let restart = 0; restart < 2; restart += 1) {
        if (restart > 0) {
          await stopQueue(running)
          running = await startQueue(workspacePath, launcher, 1)
        }
        const held = requiredValue(await previousApp.getTaskRecord(session.id, heldTask.id), 'held task record')
        assert.deepEqual(held.admission, admission, `restart ${restart}: the held terminal task keeps its admission`)
        assert.equal(held.status, 'done')
        assert.equal(processCleanupHoldReason(held), 'owned_processes_unverified')
        const snapshot = await running.queue.snapshot()
        assert.equal(snapshot.availableSlots, 0, `restart ${restart}: the held slot stays in use`)
        assert.deepEqual(launcher.starts, [], `restart ${restart}: nothing is admitted into the held slot`)
      }

      await member.stop()
      const admitted = launcher.launched(waiting.id)
      running.queue.wake()
      await withinBound(admitted, 20_000, 'the waiting task to be admitted once the scope is closed')

      assert.equal(isClosedRecord(folder), true, 'the closed scope is recorded')
      const released = requiredValue(await previousApp.getTaskRecord(session.id, heldTask.id), 'released task record')
      assert.equal(released.admission, undefined)
      assert.equal(processCleanupHoldReason(released), undefined)
      assert.deepEqual(launcher.starts, [waiting.id])
    } finally {
      await stopQueue(running)
    }
  })
})

// A closed.json proves closure only for the scope it sits in, and only when
// that scope's scope.json names this task's current attempt.
for (const variant of ['missing', 'unreadable', 'another attempt'] as const) {
  test(`a terminal task whose closed scope has a ${variant} scope.json keeps its slot and its hold`, { timeout: 60_000 }, async () => {
    await withWorkspace(async (workspacePath) => {
      const previousApp = new FileSystemSessionStore(workspacePath, { instanceId: 'previous-app' })
      const session = await previousApp.createSession({ title: `Closed scope, ${variant} scope.json` })
      const created = requiredValue(await previousApp.createTaskRecord(session.id, {
        workflowId: 'mismatched-scope-workflow',
        brief: 'A finished task whose closed scope does not prove its own attempt closed.',
      }), 'task')
      const attemptId = randomUUID()
      const admission = grantedAdmission(attemptId, '1')
      const ended = requiredValue((await previousApp.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
        status: 'done',
        executionAttemptId: attemptId,
        processIdentity: attemptId,
        executionAttemptNumber: 1,
        executionKind: 'initial',
        completedAt: new Date().toISOString(),
        admission,
      }, { expectedExecutionAttemptId: null }))?.task, 'ended task')
      amendTaskRecord(workspacePath, ended, { ownedProcessScope: 1 })
      const folder = scopePath(workspacePath, ended)
      for (const sub of ['intents', 'claims', 'fences', '.staging']) fs.mkdirSync(path.join(folder, sub), { recursive: true })
      if (variant === 'unreadable') fs.writeFileSync(path.join(folder, 'scope.json'), '')
      if (variant === 'another attempt') {
        fs.writeFileSync(path.join(folder, 'scope.json'), JSON.stringify({
          version: 1, taskId: ended.id, sessionId: ended.sessionId, executionAttemptNumber: 2, createdAt: 'then',
        }))
      }
      fs.writeFileSync(path.join(folder, 'closed.json'), JSON.stringify({ version: 1, closedBy: 'someone', closedAt: 'then' }))
      const waiting = requiredValue(await previousApp.createTaskRecord(session.id, {
        workflowId: 'waiting-workflow',
        brief: 'Waits for the only slot.',
      }), 'waiting task')
      const launcher = new SignallingLauncher()

      const running = await startQueue(workspacePath, launcher, 1)
      try {
        const kept = requiredValue(await previousApp.getTaskRecord(session.id, ended.id), 'kept task')
        assert.deepEqual(kept.admission, admission, `a ${variant} scope.json released the slot`)
        assert.equal(processCleanupHoldReason(kept), 'owned_processes_unverified')
        assert.equal((await running.queue.snapshot()).availableSlots, 0)
        assert.deepEqual(launcher.starts, [], 'nothing is admitted into the slot')
        assert.equal((await previousApp.getTaskRecord(session.id, waiting.id))?.admission?.phase, 'pending')
      } finally {
        await stopQueue(running)
      }
    })
  })
}

// A delegated child's attempt folder under .runtime/tmp is its working space:
// its TMPDIR, and the attempt's copy of the user's Pi credentials. It is
// removed only once nothing that may still use it runs (matrix A5.1), which
// for an owned member means its scope is verified closed.
test('a cancelled task whose root is gone keeps its attempt\'s temporary folders while an owned member is unverifiable', { timeout: 60_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const previousApp = new FileSystemSessionStore(workspacePath, { instanceId: 'previous-app' })
    const session = await previousApp.createSession({ title: 'Cancelled with a held member' })
    const created = requiredValue(await previousApp.createTaskRecord(session.id, {
      workflowId: 'cancelled-held-workflow',
      brief: 'A task cancelled while one of its Team children could not be verified.',
    }), 'cancelled task')
    const attemptId = randomUUID()
    const childRunId = `child-${randomUUID()}`

    // The workflow's one step ran as a delegated child in its own assignment.
    const stateStore = new FileSystemWorkflowStateStore(requiredValue(created.assignmentPath, 'task assignment path'))
    await stateStore.initialize({
      manifest: {
        taskId: created.id,
        sessionId: session.id,
        rootRunId: created.runId,
        workflowId: created.workflowId,
        workflowDefinitionHash: hashWorkflowContent('cancelled-held-workflow'),
        briefHash: hashWorkflowContent(created.brief),
        teamDefinitionHashes: { writers: hashWorkflowContent('writers') },
        runtimeVersion: 'fixture-v1',
      },
      executionAttemptId: attemptId,
      steps: [{
        stepId: 'write',
        stepIndex: 0,
        stepType: 'team',
        team: 'writers',
        childRunId,
        definitionHash: hashWorkflowContent('write'),
        recoveryPolicy: 'safe_retry',
        inputArtifact: 'incoming-brief.md',
        resultArtifact: 'answer.md',
        requestedResultType: 'artifact:answer.md',
      }],
    })
    await stateStore.update({ expectedRevision: 0, executionAttemptId: attemptId, mutate: (draft) => {
      const step = requiredValue(draft.steps[0], 'workflow step')
      step.status = 'launching'
      step.attemptCount = 1
      draft.currentStepId = step.stepId
    } })
    await stateStore.update({ expectedRevision: 1, executionAttemptId: attemptId, mutate: (draft) => {
      requiredValue(draft.steps[0], 'workflow step').status = 'running'
    } })

    // The child's attempt folder, made as the agent runner makes it.
    const childLocation = requiredValue(buildSessionRunAssignmentLocation(workspacePath, {
      sessionId: session.id,
      runId: created.runId,
      assignmentId: childRunId,
    }), 'child assignment location')
    fs.mkdirSync(childLocation.assignmentPath, { recursive: true })
    ensureRunPrivateRuntimeDirectory(childLocation.assignmentPath)
    const attemptTemporaryPath = getRunAttemptTemporaryPath(childLocation.assignmentPath, randomUUID())
    fs.mkdirSync(attemptTemporaryPath, { recursive: true, mode: 0o700 })
    const workingFile = path.join(attemptTemporaryPath, 'in-use.txt')
    fs.writeFileSync(workingFile, 'A live member may be using this file.')

    // Cancelled, with the root gone: no process carries the task's marker.
    const admission = grantedAdmission(attemptId, '1')
    const cancelled = requiredValue((await previousApp.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
      status: 'cancelled',
      executionAttemptId: attemptId,
      processIdentity: attemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      completedAt: new Date().toISOString(),
      error: 'Cancelled by user',
      admission,
    }, { expectedExecutionAttemptId: null }))?.task, 'cancelled task record')
    amendTaskRecord(workspacePath, cancelled, { ownedProcessScope: 1 })
    const member = await startHeldMember()
    publishHeldScope(workspacePath, cancelled, member)

    const running = await startQueue(workspacePath, new SignallingLauncher(), 1)
    try {
      const held = requiredValue(await previousApp.getTaskRecord(session.id, cancelled.id), 'held task record')
      assert.deepEqual(
        {
          attemptFolderKept: fs.existsSync(attemptTemporaryPath),
          workingFileKept: fs.existsSync(workingFile),
          memberRuns: targetRuns(member),
          status: held.status,
          admission: held.admission,
          hold: processCleanupHoldReason(held),
        },
        {
          attemptFolderKept: true,
          workingFileKept: true,
          memberRuns: true,
          status: 'cancelled',
          admission,
          hold: 'owned_processes_unverified',
        },
        'While an owned member may still run, its attempt\'s temporary folders stay, and the task keeps its slot and the hold.',
      )
    } finally {
      await stopQueue(running)
    }
  })
})

// Cancellation stops the root, then closes the attempt's scope. Held: the task
// is cancelled with its admission kept and the hold set, and cancellation
// reports that process cleanup remains pending (ADR section 8).
test('cancelling a task whose attempt has an unverifiable member keeps its slot and reports cleanup pending', { timeout: 60_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const store = new FileSystemSessionStore(workspacePath, { instanceId: 'cancelling-app' })
    const session = await store.createSession({ title: 'Cancelled with a held member' })
    const created = requiredValue(await store.createTaskRecord(session.id, {
      workflowId: 'cancel-held-workflow',
      brief: 'A running task cancelled while one of its Team children cannot be verified.',
    }), 'task')
    const attemptId = randomUUID()
    // The root worker: carries the task's identity marker, and a fixture
    // marker of its own that cleanup rechecks before any signal.
    const rootMarker = `--owned-queue-fixture-root=${randomUUID()}`
    const root = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', '--', `${PROCESS_IDENTITY_ARGUMENT}${attemptId}`, rootMarker], {
      detached: true,
      stdio: 'ignore',
    })
    const rootClosed = once(root, 'close')
    try {
      await once(root, 'spawn')
      const rootPid = requiredValue(root.pid, 'root pid')
      const admission = grantedAdmission(attemptId, '1')
      const running = requiredValue((await store.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
        status: 'running',
        admission,
        processIdentity: attemptId,
        executionAttemptId: attemptId,
        executionAttemptNumber: 1,
        executionKind: 'initial',
        attemptStartedAt: new Date().toISOString(),
        workerStartedAt: new Date().toISOString(),
        pid: rootPid,
        processGroupId: rootPid,
      }, { expectedExecutionAttemptId: null }))?.task, 'running task')
      amendTaskRecord(workspacePath, running, { ownedProcessScope: 1 })
      const member = await startHeldMember()
      const folder = publishHeldScope(workspacePath, running, member)

      await assert.rejects(
        cancelSessionTask({ sessionId: session.id, taskId: running.id, sessionStore: store }),
        // The held scope's refusal only. A root whose identity cannot be
        // verified also leaves cleanup pending, but is never signalled.
        /descendants could not be verified gone; process cleanup remains pending/,
      )
      // Bounded, so a root that was not stopped fails the test here and the
      // cleanup below stops it by its marker.
      await withinBound(rootClosed, FIXTURE_BOUND_MS, 'the root to close once cancellation stopped it')
      const cancelled = requiredValue(await store.getTaskRecord(session.id, running.id), 'cancelled task')
      assert.deepEqual(
        {
          status: cancelled.status,
          admission: cancelled.admission,
          hold: processCleanupHoldReason(cancelled),
          scopeClosed: isClosedRecord(folder),
          memberRuns: targetRuns(member),
        },
        {
          status: 'cancelled',
          admission,
          hold: 'owned_processes_unverified',
          scopeClosed: false,
          memberRuns: true,
        },
        'With the root gone and a member unverifiable, the cancelled task keeps its slot and the hold, and the member is not signalled.',
      )
    } finally {
      const errors = await stopAllCarrying([rootMarker])
      if (errors.length > 0) throw new AggregateError(errors, 'the fixture root could not be stopped')
    }
  })
})

// A launch that fails closes the attempt's scope once its root is gone or was
// never spawned. Held: the failure is written with the admission kept and the
// hold set (ADR section 8, launch failures). Substituted boundary: the
// launcher places the unverifiable member in the attempt's scope itself and
// then fails, standing in for a root that started a member before its launch
// failed; the member is native (its host killed alone, its target alive).
test('a launch that fails while its attempt has an unverifiable member keeps the slot and the hold', { timeout: 60_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const store = new FileSystemSessionStore(workspacePath, { instanceId: 'launching-app' })
    const session = await store.createSession({ title: 'Launch failure with a held member' })
    const created = requiredValue(await store.createTaskRecord(session.id, {
      workflowId: 'launch-held-workflow',
      brief: 'A resumed task whose launch fails after a member started.',
    }), 'task')
    const previousAttemptId = `previous-attempt-${created.id}`
    const interrupted = requiredValue((await store.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
      status: 'interrupted',
      processIdentity: previousAttemptId,
      executionAttemptId: previousAttemptId,
      executionAttemptNumber: 1,
      ...await currentAttemptScope(created, 1),
      executionKind: 'initial',
      interruptedAt: new Date().toISOString(),
      recoveryDisposition: 'manual',
      recoveryReason: 'Resumed by the launch-failure hold test.',
    }, { expectedExecutionAttemptId: null }))?.task, 'interrupted task')

    let member: HeldMember | undefined
    let signalLaunchReached: () => void = () => undefined
    const launchReached = new Promise<void>((resolve) => { signalLaunchReached = resolve })
    const launcher: RunLauncher = {
      async startRun() {
        const current = requiredValue(await store.getTaskRecord(session.id, interrupted.id), 'launching task')
        member = await startHeldMember()
        publishHeldScope(workspacePath, current, member)
        signalLaunchReached()
        throw new Error('The launch failed after its root started a member.')
      },
    }
    const running = await startQueue(workspacePath, launcher, 1)
    let closed = false
    try {
      const admitted = await running.queue.enqueueRecovery({
        sessionId: session.id,
        taskId: interrupted.id,
        source: 'manual_resume',
      })
      await launchReached
      // Closing waits for every in-flight launch, including its failure write.
      await running.queue.close(20_000)
      closed = true
      await running.owner.release()
      const failed = requiredValue(await store.getTaskRecord(session.id, interrupted.id), 'failed launch')
      assert.deepEqual(
        {
          status: failed.status,
          admissionPhase: failed.admission?.phase,
          admissionRequest: failed.admission?.requestId,
          hold: processCleanupHoldReason(failed),
          memberRuns: member ? targetRuns(member) : 'no member was started',
        },
        {
          status: 'interrupted',
          admissionPhase: 'granted',
          admissionRequest: admitted.admission?.requestId,
          hold: 'owned_processes_unverified',
          memberRuns: true,
        },
        'A failed launch whose attempt has an unverifiable member keeps its slot and the hold, and the member is not signalled.',
      )
    } finally {
      if (!closed) await stopQueue(running)
    }
  })
})

// The other launch failure: a root that never acknowledges startup is stopped,
// and the failure is written with the slot kept while a member is
// unverifiable. Substituted boundary as above; the root is a plain process
// carrying the attempt's identity marker.
test('a launch whose root never acknowledges startup keeps the slot and the hold while a member is unverifiable', { timeout: 60_000 }, async () => {
  const startupTimeoutKey = 'TEAM_RUNTIME_TASK_STARTUP_TIMEOUT_MS'
  const previousStartupTimeout = process.env[startupTimeoutKey]
  process.env[startupTimeoutKey] = '300'
  const rootMarker = `--owned-queue-fixture-root=${randomUUID()}`
  try {
    await withWorkspace(async (workspacePath) => {
      const store = new FileSystemSessionStore(workspacePath, { instanceId: 'launching-app' })
      const session = await store.createSession({ title: 'Unacknowledged launch with a held member' })
      const created = requiredValue(await store.createTaskRecord(session.id, {
        workflowId: 'launch-held-workflow',
        brief: 'A resumed task whose root never acknowledges startup.',
      }), 'task')
      const previousAttemptId = `previous-attempt-${created.id}`
      const interrupted = requiredValue((await store.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
        status: 'interrupted',
        processIdentity: previousAttemptId,
        executionAttemptId: previousAttemptId,
        executionAttemptNumber: 1,
        ...await currentAttemptScope(created, 1),
        executionKind: 'initial',
        interruptedAt: new Date().toISOString(),
        recoveryDisposition: 'manual',
        recoveryReason: 'Resumed by the unacknowledged-launch hold test.',
      }, { expectedExecutionAttemptId: null }))?.task, 'interrupted task')

      let member: HeldMember | undefined
      let signalLaunchReached: () => void = () => undefined
      const launchReached = new Promise<void>((resolve) => { signalLaunchReached = resolve })
      const launcher: RunLauncher = {
        async startRun(request) {
          const current = requiredValue(await store.getTaskRecord(session.id, interrupted.id), 'launching task')
          member = await startHeldMember()
          publishHeldScope(workspacePath, current, member)
          const identity = requiredValue(request.processIdentity, 'process identity')
          const root = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', '--', `${PROCESS_IDENTITY_ARGUMENT}${identity}`, rootMarker], {
            detached: true,
            stdio: 'ignore',
          })
          await once(root, 'spawn')
          signalLaunchReached()
          const rootPid = requiredValue(root.pid, 'root pid')
          return { launched: true, pid: rootPid, processGroupId: rootPid, processIdentity: identity, cwd: request.cwd }
        },
      }
      const running = await startQueue(workspacePath, launcher, 1)
      let closed = false
      try {
        const admitted = await running.queue.enqueueRecovery({
          sessionId: session.id,
          taskId: interrupted.id,
          source: 'manual_resume',
        })
        await launchReached
        // Closing waits for every in-flight launch: the startup wait, the
        // root's termination and the failure write.
        await running.queue.close(20_000)
        closed = true
        await running.owner.release()
        const failed = requiredValue(await store.getTaskRecord(session.id, interrupted.id), 'failed launch')
        assert.deepEqual(
          {
            status: failed.status,
            admissionPhase: failed.admission?.phase,
            admissionRequest: failed.admission?.requestId,
            hold: processCleanupHoldReason(failed),
            rootRuns: processesCarrying(rootMarker).length > 0,
            memberRuns: member ? targetRuns(member) : 'no member was started',
          },
          {
            status: 'interrupted',
            admissionPhase: 'granted',
            admissionRequest: admitted.admission?.requestId,
            hold: 'owned_processes_unverified',
            rootRuns: false,
            memberRuns: true,
          },
          'An unacknowledged launch is stopped, and with a member unverifiable its slot and the hold are kept.',
        )
      } finally {
        if (!closed) await stopQueue(running)
      }
    })
  } finally {
    const errors = await stopAllCarrying([rootMarker])
    if (previousStartupTimeout === undefined) delete process.env[startupTimeoutKey]
    else process.env[startupTimeoutKey] = previousStartupTimeout
    if (errors.length > 0) throw new AggregateError(errors, 'the fixture root could not be stopped')
  }
})

// The typed reason is reported where the queue explains itself: in its
// reconciled events (ADR section 7).
test('the queue reports a held task\'s hold reason in its reconciled events', { timeout: 60_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const previousApp = new FileSystemSessionStore(workspacePath, { instanceId: 'previous-app' })
    const session = await previousApp.createSession({ title: 'Held reason in events' })
    const created = requiredValue(await previousApp.createTaskRecord(session.id, {
      workflowId: 'held-event-workflow',
      brief: 'A task that ended while one of its Team children could not be verified.',
    }), 'held task')
    const attemptId = randomUUID()
    const ended = requiredValue((await previousApp.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
      status: 'done',
      executionAttemptId: attemptId,
      processIdentity: attemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      completedAt: new Date().toISOString(),
      admission: grantedAdmission(attemptId, '1'),
    }, { expectedExecutionAttemptId: null }))?.task, 'ended task')
    amendTaskRecord(workspacePath, ended, {
      ownedProcessScope: 1,
      processCleanupHold: { reason: 'owned_processes_unverified', since: HELD_SINCE },
    })
    const member = await startHeldMember()
    publishHeldScope(workspacePath, ended, member)

    const running = await startQueue(workspacePath, new SignallingLauncher(), 1)
    try {
      // A locked read after initialize, so the startup pass's events are written.
      await running.queue.snapshot()
      const eventsPath = path.join(workspacePath, 'task-queue', TASK_QUEUE_EVENT_FILENAME)
      const heldEvents = fs.readFileSync(eventsPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line): unknown => JSON.parse(line))
        .filter(isRecord)
        .filter((event) => event.event === 'task_queue.reconciled' && event.task_id === ended.id && event.reason === 'owned_process_cleanup')
      assert.ok(heldEvents.length > 0, 'the queue reports the held task')
      assert.deepEqual(
        heldEvents.map((event) => event.process_cleanup_hold_reason),
        heldEvents.map(() => 'owned_processes_unverified'),
        'each reconciled event for the held task names why it is held',
      )
    } finally {
      await stopQueue(running)
    }
  })
})

// A launch that fails after its root has started must stop that root before
// it closes the attempt's scope or releases the slot (ADR section 8: the
// launcher closes the scope once the root is confirmed gone). The failure
// here is attaching the root: the task's lock is held by a live process, so
// the attach times out. Substituted boundary: the launcher starts a plain
// root carrying the attempt's identity marker, and the lock's holder is that
// root itself.
test('a launch that fails after its root started stops the root before closing its scope and releasing its slot', { timeout: 90_000 }, async () => {
  const rootMarker = `--owned-queue-fixture-root=${randomUUID()}`
  try {
    await withWorkspace(async (workspacePath) => {
      const store = new FileSystemSessionStore(workspacePath, { instanceId: 'launching-app' })
      const session = await store.createSession({ title: 'Launch failure after the root started' })
      const created = requiredValue(await store.createTaskRecord(session.id, {
        workflowId: 'launch-root-workflow',
        brief: 'A resumed task whose root starts but cannot be attached.',
      }), 'task')
      const previousAttemptId = `previous-attempt-${created.id}`
      const interrupted = requiredValue((await store.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
        status: 'interrupted',
        processIdentity: previousAttemptId,
        executionAttemptId: previousAttemptId,
        executionAttemptNumber: 1,
        ...await currentAttemptScope(created, 1),
        executionKind: 'initial',
        interruptedAt: new Date().toISOString(),
        recoveryDisposition: 'manual',
        recoveryReason: 'Resumed by the launch-root test.',
      }, { expectedExecutionAttemptId: null }))?.task, 'interrupted task')

      let signalLaunchReached: () => void = () => undefined
      const launchReached = new Promise<void>((resolve) => { signalLaunchReached = resolve })
      const launcher: RunLauncher = {
        async startRun(request) {
          const identity = requiredValue(request.processIdentity, 'process identity')
          const root = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', '--', `${PROCESS_IDENTITY_ARGUMENT}${identity}`, rootMarker], {
            detached: true,
            stdio: 'ignore',
          })
          await once(root, 'spawn')
          const rootPid = requiredValue(root.pid, 'root pid')
          // The task's lock, held by a live process: attaching the root times out.
          fs.writeFileSync(
            path.join(store.taskDir(session.id, interrupted.id), '.task.lock'),
            `${JSON.stringify({ pid: rootPid, nonce: randomUUID(), createdAt: new Date().toISOString() })}\n`,
          )
          signalLaunchReached()
          return { launched: true, pid: rootPid, processGroupId: rootPid, processIdentity: identity, cwd: request.cwd }
        },
      }
      const running = await startQueue(workspacePath, launcher, 1)
      let closed = false
      try {
        await running.queue.enqueueRecovery({
          sessionId: session.id,
          taskId: interrupted.id,
          source: 'manual_resume',
        })
        await launchReached
        // Closing waits for the in-flight launch and its failure handling.
        await running.queue.close(60_000)
        closed = true
        await running.owner.release()
        const current = requiredValue(await store.getTaskRecord(session.id, interrupted.id), 'launched task')
        const scopeFolder = scopePath(workspacePath, current)
        assert.deepEqual(
          {
            rootRuns: processesCarrying(rootMarker).length > 0,
            scopeClosed: isClosedRecord(scopeFolder),
            status: current.status,
            admission: current.admission,
          },
          {
            rootRuns: false,
            scopeClosed: true,
            status: 'interrupted',
            admission: undefined,
          },
          'The failed launch stops its root, and only then closes the attempt\'s scope and releases the slot.',
        )
      } finally {
        if (!closed) await stopQueue(running)
      }
    })
  } finally {
    const errors = await stopAllCarrying([rootMarker])
    if (errors.length > 0) throw new AggregateError(errors, 'the fixture root could not be stopped')
  }
})

test('an earlier-version task the queue counts as legacy-active keeps its slot across restarts, and a never-launched request is not held', { timeout: 60_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const previousApp = new FileSystemSessionStore(workspacePath, { instanceId: 'earlier-version-app' })
    const session = await previousApp.createSession({ title: 'Earlier-version task' })
    const created = requiredValue(await previousApp.createTaskRecord(session.id, {
      workflowId: 'earlier-version-workflow',
      brief: 'Launched by an earlier version, without a scope.',
    }), 'earlier-version task')
    // Its root has gone: the recorded pid belonged to a process that exited.
    const root = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' })
    const rootPid = requiredValue(root.pid, 'root pid')
    await withinBound(once(root, 'exit'), FIXTURE_BOUND_MS, 'the earlier root to exit')
    const attemptId = randomUUID()
    const legacy = requiredValue((await previousApp.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
      status: 'running',
      executionAttemptId: attemptId,
      processIdentity: attemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      pid: rootPid,
      processGroupId: rootPid,
      startedAt: new Date().toISOString(),
    }, { expectedExecutionAttemptId: null }))?.task, 'legacy-active task')
    // A child the earlier version started may still run; nothing ties it to the task.
    const oldChild = await startHeldMember()
    const neverLaunched = requiredValue(await previousApp.createTaskRecord(session.id, {
      workflowId: 'never-launched-workflow',
      brief: 'Queued, never launched.',
    }), 'never-launched task')
    const launcher = new SignallingLauncher()

    let running = await startQueue(workspacePath, launcher, 1)
    try {
      for (let restart = 0; restart < 2; restart += 1) {
        if (restart > 0) {
          await stopQueue(running)
          running = await startQueue(workspacePath, launcher, 1)
        }
        assert.equal(running.initialized.legacyActive, 1, `restart ${restart}: the earlier-version task keeps its legacy-active slot`)
        const held = requiredValue(await previousApp.getTaskRecord(session.id, legacy.id), 'legacy task record')
        assert.equal(held.status, 'running', `restart ${restart}: the earlier-version task is not reconciled while its descendants are unverified`)
        assert.equal(held.admission, undefined, 'no granted admission is invented for it')
        assert.equal(processCleanupHoldReason(held), 'descendants_unverified_without_scope')
        const request = requiredValue(await previousApp.getTaskRecord(session.id, neverLaunched.id), 'never-launched record')
        assert.equal(processCleanupHoldReason(request), undefined, 'a never-launched request is not held')
        assert.equal(request.admission?.phase, 'pending')
        assert.deepEqual(launcher.starts, [], `restart ${restart}: nothing is admitted into the held slot`)
      }
      assert.equal(targetRuns(oldChild), true, 'nothing signals a process no record ties to the task')
    } finally {
      await stopQueue(running)
    }
  })
})

// ADR section 7 and verification item 4: a task an earlier version admitted
// and launched records no scope, so its descendants can never be verified
// gone. Cancelled, with its root gone, it keeps its granted admission, and a
// task waiting for the only slot is not admitted.
test('a cancelled earlier-version task holding a granted admission keeps its slot while its descendants cannot be verified, and a waiting task stays pending', { timeout: 60_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const previousApp = new FileSystemSessionStore(workspacePath, { instanceId: 'earlier-version-app' })
    const session = await previousApp.createSession({ title: 'Admitted earlier-version task' })
    const created = requiredValue(await previousApp.createTaskRecord(session.id, {
      workflowId: 'admitted-earlier-version-workflow',
      brief: 'Admitted and launched by an earlier version, without a scope, then cancelled.',
    }), 'admitted earlier-version task')
    // Its root has gone: the recorded pid belonged to a process that exited.
    const root = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' })
    const rootPid = requiredValue(root.pid, 'root pid')
    await withinBound(once(root, 'exit'), FIXTURE_BOUND_MS, 'the earlier root to exit')
    const attemptId = randomUUID()
    const admission = grantedAdmission(attemptId, '1')
    // Written as the earlier version wrote it: no ownedProcessScope, and no
    // scope folder beside the record.
    const cancelled = requiredValue((await previousApp.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
      status: 'cancelled',
      executionAttemptId: attemptId,
      processIdentity: attemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      pid: rootPid,
      processGroupId: rootPid,
      completedAt: new Date().toISOString(),
      error: 'Cancelled by user',
      admission,
    }, { expectedExecutionAttemptId: null }))?.task, 'cancelled earlier-version task')
    assert.equal(Reflect.get(cancelled, 'ownedProcessScope'), undefined)
    // A child the earlier version started may still run, in its own group;
    // nothing ties it to the task.
    const oldChild = await startHeldMember()
    // In a session of its own: startup reconciles the sessions of tasks that
    // hold no admission, which would hold the cancelled task before the
    // queue decides its slot. Here the queue's own decision is what holds it.
    const waitingSession = await previousApp.createSession({ title: 'Waiting task' })
    const waiting = requiredValue(await previousApp.createTaskRecord(waitingSession.id, {
      workflowId: 'waiting-workflow',
      brief: 'Waits for the only slot.',
    }), 'waiting task')
    const launcher = new SignallingLauncher()

    const running = await startQueue(workspacePath, launcher, 1)
    try {
      const held = requiredValue(await previousApp.getTaskRecord(session.id, cancelled.id), 'held task record')
      assert.deepEqual(
        { status: held.status, admission: held.admission, hold: processCleanupHoldReason(held) },
        { status: 'cancelled', admission, hold: 'descendants_unverified_without_scope' },
        'The cancelled earlier-version task keeps its granted admission and is held.',
      )
      assert.equal((await running.queue.snapshot()).availableSlots, 0, 'the held slot stays in use')
      assert.equal(
        (await previousApp.getTaskRecord(waitingSession.id, waiting.id))?.admission?.phase,
        'pending',
        'the waiting task is not admitted',
      )
      assert.deepEqual(launcher.starts, [], 'nothing is admitted into the held slot')
      assert.equal(targetRuns(oldChild), true, 'nothing signals a process no record ties to the task')
    } finally {
      await stopQueue(running)
    }
  })
})

async function seedSubmittedHumanInput(task: SessionTask, executionAttemptId: string): Promise<string> {
  const stateStore = new FileSystemWorkflowStateStore(requiredValue(task.assignmentPath, 'assignment path'))
  await stateStore.initialize({
    manifest: {
      taskId: task.id,
      sessionId: task.sessionId,
      rootRunId: task.runId,
      workflowId: task.workflowId,
      workflowDefinitionHash: hashWorkflowContent('held-wait-workflow:v1'),
      briefHash: hashWorkflowContent(task.brief),
      teamDefinitionHashes: { writers: hashWorkflowContent('writers:v1') },
      runtimeVersion: 'workflow-runtime-v1',
    },
    executionAttemptId,
    steps: [
      {
        stepId: 'human-feedback',
        stepIndex: 0,
        stepType: 'human-in-the-loop',
        definitionHash: hashWorkflowContent('held-human-feedback:v1'),
        recoveryPolicy: 'manual',
        inputArtifact: 'review/round-one.md',
        resultArtifact: 'feedback/round-one.json',
        requestedResultType: 'artifact:feedback/round-one.json',
      },
      {
        stepId: 'write',
        stepIndex: 1,
        stepType: 'team',
        team: 'writers',
        definitionHash: hashWorkflowContent('held-write:v1'),
        recoveryPolicy: 'safe_retry',
        inputArtifact: 'incoming-brief.md',
        resultArtifact: 'report.md',
        requestedResultType: 'artifact:report.md',
      },
    ],
  })
  const waiting = await stateStore.requestHumanInput({
    expectedRevision: 0,
    executionAttemptId,
    stepId: 'human-feedback',
    interactionId: randomUUID(),
    sourceArtifact: {
      childRunId: randomUUID(),
      relativePath: 'round-one.md',
      sha256: hashWorkflowContent('round one'),
      byteLength: 'round one'.length,
    },
    successorStepId: 'write',
    eligibleRecipients: [],
  })
  const interaction = requiredValue(waiting.steps[0]?.humanInput, 'human input interaction')
  const submissionId = randomUUID()
  const messages = [{ id: randomUUID(), text: 'Please continue.', recipients: 'all' as const }]
  await stateStore.submitHumanInput({
    expectedRevision: waiting.revision,
    interactionId: interaction.interactionId,
    expectedSourceArtifactSha256: interaction.sourceArtifact.sha256,
    submission: {
      submissionId,
      mode: 'feedback',
      messages,
      submittedAt: new Date().toISOString(),
      canonicalHash: hashHumanInputSubmission({ submissionId, mode: 'feedback', messages }),
    },
  })
  return submissionId
}

async function seedApprovedModelChoice(task: SessionTask, executionAttemptId: string): Promise<void> {
  const stateStore = new FileSystemWorkflowStateStore(requiredValue(task.assignmentPath, 'assignment path'))
  await stateStore.initialize({
    manifest: {
      taskId: task.id,
      sessionId: task.sessionId,
      rootRunId: task.runId,
      workflowId: task.workflowId,
      workflowDefinitionHash: hashWorkflowContent('held-model-choice-workflow:v1'),
      briefHash: hashWorkflowContent(task.brief),
      teamDefinitionHashes: { writers: hashWorkflowContent('writers:v1') },
      runtimeVersion: 'workflow-runtime-v1',
    },
    executionAttemptId,
    steps: [
      {
        stepId: 'write',
        stepIndex: 0,
        stepType: 'team',
        team: 'writers',
        definitionHash: hashWorkflowContent('held-write:v1'),
        recoveryPolicy: 'safe_retry',
        inputArtifact: 'incoming-brief.md',
        resultArtifact: 'report.md',
        requestedResultType: 'artifact:report.md',
      },
    ],
  })
  let revision = 0
  const advance = async (mutate: (draft: DurableWorkflowState) => void): Promise<void> => {
    await stateStore.update({ expectedRevision: revision, executionAttemptId, mutate })
    revision += 1
  }
  await advance((draft) => {
    const step = requiredValue(draft.steps[0], 'write step')
    step.status = 'launching'
    step.attemptCount = 1
    step.startedAt = new Date().toISOString()
  })
  await advance((draft) => {
    requiredValue(draft.steps[0], 'write step').status = 'running'
  })
  await advance((draft) => {
    const step = requiredValue(draft.steps[0], 'write step')
    draft.status = 'awaiting_model_choice'
    step.status = 'awaiting_model_choice'
    step.modelChoice = {
      offerId: 'offer-1',
      scope: { kind: 'task', sessionId: task.sessionId, taskId: task.id },
      agentName: 'writer',
      expectedRevision: '3',
      logicalInvocationId: 'write',
      failedChoice: { provider: 'anthropic', model: 'claude-opus-4-6' },
      proposedDefault: { provider: 'connection:abc', model: 'gpt-5.4-mini' },
      reason: 'missing-credential',
    }
  })
  await stateStore.approveModelChoice({ expectedRevision: revision, offerId: 'offer-1' })
}

for (const wait of [
  { status: 'awaiting_input', label: 'human-input answer' },
  { status: 'awaiting_model_choice', label: 'model-choice consent' },
] as const) {
  test(`a held ${wait.status} wait keeps its slot, keeps its ${wait.label}, and runs its continuation once after cleanup`, { timeout: 60_000 }, async () => {
    await withWorkspace(async (workspacePath) => {
      const previousApp = new FileSystemSessionStore(workspacePath, { instanceId: 'previous-app' })
      const session = await previousApp.createSession({ title: `Held ${wait.status}` })
      const created = requiredValue(await previousApp.createTaskRecord(session.id, {
        workflowId: `held-${wait.status}-workflow`,
        brief: 'A wait parked while one of its Team children could not be verified.',
      }), 'waiting task')
      const attemptId = randomUUID()
      const admission = grantedAdmission(attemptId, '1')
      const parked = requiredValue((await previousApp.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
        status: wait.status,
        executionAttemptId: attemptId,
        processIdentity: attemptId,
        executionAttemptNumber: 1,
        executionKind: 'initial',
        recoveryCount: 0,
        admission,
      }, { expectedExecutionAttemptId: null }))?.task, 'parked task')
      const submissionId = wait.status === 'awaiting_input'
        ? await seedSubmittedHumanInput(parked, attemptId)
        : undefined
      if (wait.status === 'awaiting_model_choice') await seedApprovedModelChoice(parked, attemptId)
      amendTaskRecord(workspacePath, parked, {
        ownedProcessScope: 1,
        processCleanupHold: { reason: 'owned_processes_unverified', since: HELD_SINCE },
      })
      const member = await startHeldMember()
      const folder = publishHeldScope(workspacePath, parked, member)
      const launcher = new SignallingLauncher()

      const running = await startQueue(workspacePath, launcher, 1)
      try {
        const held = requiredValue(await previousApp.getTaskRecord(session.id, parked.id), 'held wait')
        assert.equal(held.status, wait.status)
        assert.deepEqual(held.admission, admission, 'the held wait keeps its admission')
        assert.equal(processCleanupHoldReason(held), 'owned_processes_unverified')
        const snapshot = await running.queue.snapshot()
        assert.equal(snapshot.waitingCount, 0, 'no continuation is enqueued while the scope is held')
        assert.equal(snapshot.availableSlots, 0)
        assert.deepEqual(launcher.starts, [])

        await member.stop()
        const continued = launcher.launched(parked.id)
        running.queue.wake()
        await withinBound(continued, 20_000, 'the continuation to launch once the scope is closed')

        assert.equal(isClosedRecord(folder), true, 'the closed scope is recorded')
        const resumed = requiredValue(await previousApp.getTaskRecord(session.id, parked.id), 'continued task')
        assert.equal(resumed.executionKind, 'continuation')
        assert.equal(resumed.admission?.phase, 'granted')
        assert.equal(processCleanupHoldReason(resumed), undefined)
        assert.deepEqual(launcher.starts, [parked.id], 'the continuation runs exactly once')
        const state = await new FileSystemWorkflowStateStore(requiredValue(parked.assignmentPath, 'assignment path')).load()
        const firstStep = state?.state.steps[0]
        if (wait.status === 'awaiting_input') {
          assert.equal(firstStep?.humanInput?.submission?.submissionId, submissionId, 'the answer is kept')
        } else {
          assert.equal(firstStep?.approvedModelChoice?.offerId, 'offer-1', 'the consent is kept')
        }
      } finally {
        await stopQueue(running)
      }
    })
  })
}
