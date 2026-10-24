import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { requiredValue } from '../../core/required-value.js'
import { TASK_QUEUE_EVENT_FILENAME } from '../../core/task-queue-events.js'
import { OWNED_PROCESS_SCOPE_ENV } from '../../core/owned-processes/owned-process-records.js'
import { WorkspaceDispatcherOwner } from '../../core/workspace-dispatcher-owner.js'
import { buildSessionRunAssignmentLocation } from '../../core/run-assignment-location.js'
import { runTeam } from '../../domains/agent-execution/agent-runner.js'
import { ISOLATED_DIRECTORY_PREFIX } from '../../domains/run/pi-agent-isolation.js'
import {
  ensureRunPrivateRuntimeDirectory,
  getRunAttemptTemporaryPath,
  getRunRuntimePaths,
} from '../../domains/runtime/runtime-paths.js'
import {
  FileSystemWorkflowStateStore,
  hashWorkflowContent,
} from '../../workflows/workflow-state-store.js'
import type { SessionTask, TaskAdmission } from '../../contracts/sessions.js'
import type { RunLauncher } from '../../domains/run/run-launcher.js'
import type { RunStartRequest } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { PROCESS_IDENTITY_ARGUMENT } from '../../domains/sessions/task-process-supervisor.js'
import { TaskQueue, TaskQueueError } from '../../services/task-queue.js'
import { cancelSessionTask } from '../../services/task-service.js'
import { currentAttemptScope } from '../support/current-attempt-scope.js'
import {
  describeErrors,
  processesCarrying,
  stopAllCarrying,
  stopProcessesCarrying,
  stopProcessesWithEnvironment,
  withinBound,
} from '../support/fixture-process-markers.js'

// Findings from the adversarial review of the A4.2c branch
// (docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md), through
// the real queue, the real session store and real processes. Each test waits
// on an event: a launcher call, a queue event appended to the workspace's
// event log, or a process exit. Bounds are safety limits only.

const TEST_TICK_INTERVAL_MS = 60_000
const BOUND_MS = 20_000

/** A member whose host was killed alone while its target still runs in the host's group. */
interface HeldMember {
  readonly hostPid: number
  readonly targetPid: number
  readonly targetMarker: string
  /** Stops the member's processes, found and rechecked by their markers; bounded. */
  stop(): Promise<void>
}

// The target's marker comes through the environment, so it appears on the
// target's command line and never on the host's.
const HOST_SCRIPT = [
  "const { spawn } = require('node:child_process')",
  "const target = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', '--', process.env.OWNED_FIXTURE_TARGET], { stdio: ['ignore', 'inherit', 'inherit'] })",
  "target.on('spawn', () => process.stdout.write('ready ' + target.pid + '\\n'))",
  'setInterval(() => {}, 1 << 30)',
].join('\n')

/** Every member a test started, registered the moment its host exists. */
const fixtureMembers: HeldMember[] = []

async function startHeldMember(): Promise<HeldMember> {
  const hostMarker = `--owned-review-fixture-host=${randomUUID()}`
  const targetMarker = `--owned-review-fixture-target=${randomUUID()}`
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
    targetMarker,
    async stop() {
      const errors = await stopAllCarrying([targetMarker, hostMarker])
      if (errors.length > 0) throw new AggregateError(errors, `held member ${hostPid} could not be stopped`)
      await withinBound(closed, BOUND_MS, `held member ${hostPid} to close`)
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
  }), BOUND_MS, `fixture host ${hostPid} to start its target`)
  stdout.resume()
  const hostExited = once(host, 'exit')
  // Our own unreaped child, so its pid cannot have been reused.
  host.kill('SIGKILL')
  await withinBound(hostExited, BOUND_MS, `fixture host ${hostPid} to exit`)
  assert.deepEqual(
    processesCarrying(targetMarker).map((row) => ({ pid: row.pid, groupId: row.groupId })),
    [{ pid: targetPid, groupId: hostPid }],
    'the target still runs in the dead host\'s group',
  )
  return member
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

/** The attempt's scope, with one Team intent claimed by the held member's dead host. */
function publishHeldScope(workspacePath: string, task: SessionTask, member: HeldMember): void {
  const folder = scopePath(workspacePath, task)
  for (const sub of ['intents', 'claims', 'fences', '.staging']) {
    fs.mkdirSync(path.join(folder, sub), { recursive: true })
  }
  const at = new Date().toISOString()
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readQueueEvents(workspacePath: string): Record<string, unknown>[] {
  const eventsPath = path.join(workspacePath, 'task-queue', TASK_QUEUE_EVENT_FILENAME)
  if (!fs.existsSync(eventsPath)) return []
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line): unknown => JSON.parse(line))
    .filter(isRecord)
}

/**
 * Resolves once the workspace's queue event log holds an event `matches`
 * accepts: checked now, and again on each change the file system reports.
 */
function queueEvent(
  workspacePath: string,
  matches: (event: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const folder = path.join(workspacePath, 'task-queue')
  fs.mkdirSync(folder, { recursive: true })
  return new Promise((resolve) => {
    const check = (): boolean => {
      const found = readQueueEvents(workspacePath).find(matches)
      if (!found) return false
      watcher.close()
      resolve(found)
      return true
    }
    const watcher = fs.watch(folder, () => { check() })
    check()
  })
}

/** Reports each launch as an event, and lets a test decide what each launch does. */
class ScriptedLauncher implements RunLauncher {
  private readonly started = new Set<string>()
  private readonly waiters = new Map<string, () => void>()

  constructor(private readonly onStart: (request: RunStartRequest, taskId: string) => Promise<void>) {}

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
    await this.onStart(request, taskId)
    return await new Promise<never>(() => undefined)
  }
}

/**
 * Runs `fn` in a fresh workspace. Cleanup stops every member registered,
 * each attempted whatever failed before, keeps the workspace when anything
 * failed, and reports every error beside the body's.
 */
async function withWorkspace(fn: (workspacePath: string) => Promise<void>): Promise<void> {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-process-review-queue-'))
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

/** An interrupted task whose attempt 1 this version launched, waiting for a manual resume. */
async function seedInterruptedTask(store: FileSystemSessionStore, sessionId: string, label: string): Promise<SessionTask> {
  const created = requiredValue(await store.createTaskRecord(sessionId, {
    workflowId: 'review-queue-workflow',
    brief: `The ${label} task.`,
  }), `${label} task`)
  const previousAttemptId = `previous-attempt-${created.id}`
  return requiredValue((await store.compareAndSetTaskRecord(sessionId, created.id, ['queued'], {
    status: 'interrupted',
    processIdentity: previousAttemptId,
    executionAttemptId: previousAttemptId,
    executionAttemptNumber: 1,
    ...await currentAttemptScope(created, 1),
    executionKind: 'initial',
    interruptedAt: new Date().toISOString(),
    recoveryDisposition: 'manual',
    recoveryReason: `Resumed by the review queue test (${label}).`,
  }, { expectedExecutionAttemptId: null }))?.task, `${label} interrupted task`)
}

// Review rank 6: a recovery launch whose failure is written with the hold
// leaves the task `interrupted` with its granted admission. Once the hold
// clears, that grant must be released like any other ended attempt's, so the
// slot goes to the next task.
test('a resumed task left interrupted by a held launch failure releases its slot once the hold clears', { timeout: 90_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const store = new FileSystemSessionStore(workspacePath, { instanceId: 'review-queue-app' })
    const session = await store.createSession({ title: 'Held launch failure, then release' })
    const failing = await seedInterruptedTask(store, session.id, 'failing')
    const waiting = await seedInterruptedTask(store, session.id, 'waiting')

    let member: HeldMember | undefined
    const launcher = new ScriptedLauncher(async (_request, taskId) => {
      if (taskId !== failing.id) return
      const current = requiredValue(await store.getTaskRecord(session.id, failing.id), 'launching task')
      member = await startHeldMember()
      publishHeldScope(workspacePath, current, member)
      throw new Error('The launch failed after its root started a member.')
    })
    const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
    const queue = new TaskQueue({
      sessionStore: store,
      owner,
      maximumConcurrentTasks: 1,
      repoRootPath: process.cwd(),
      workspacePath,
      taskLauncher: launcher,
      tickIntervalMs: TEST_TICK_INTERVAL_MS,
    })
    try {
      await queue.initialize()
      const failureRecorded = queueEvent(workspacePath, (event) =>
        event.event === 'task_queue.dispatch_failed' && event.task_id === failing.id)
      await queue.enqueueRecovery({ sessionId: session.id, taskId: failing.id, source: 'manual_resume' })
      await queue.enqueueRecovery({ sessionId: session.id, taskId: waiting.id, source: 'manual_resume' })
      await withinBound(failureRecorded, BOUND_MS, 'the held launch failure to be recorded')

      const held = requiredValue(await store.getTaskRecord(session.id, failing.id), 'held task')
      assert.deepEqual(
        { status: held.status, admission: held.admission?.phase, hold: held.processCleanupHold?.reason },
        { status: 'interrupted', admission: 'granted', hold: 'owned_processes_unverified' },
        'arrangement: the failed launch keeps its slot and the hold',
      )

      await requiredValue(member, 'the held member').stop()
      queue.wake()
      await withinBound(launcher.launched(waiting.id), BOUND_MS, 'the waiting task to be admitted once the hold clears')

      const released = requiredValue(await store.getTaskRecord(session.id, failing.id), 'released task')
      assert.deepEqual(
        { status: released.status, admission: released.admission, hold: released.processCleanupHold },
        { status: 'interrupted', admission: undefined, hold: undefined },
        'the manual-resume task waits for Resume without its slot',
      )
    } finally {
      await queue.close(1)
      await owner.release()
    }
  })
})

/**
 * The attempt-1 Team child an earlier version left running: a detached
 * process in its own group, carrying a fixture marker, registered for
 * cleanup the moment it exists.
 */
async function startEarlierVersionChild(): Promise<{ readonly pid: number; readonly marker: string }> {
  const marker = `--owned-review-fixture-earlier-child=${randomUUID()}`
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', '--', marker], {
    detached: true,
    stdio: 'ignore',
  })
  const pid = requiredValue(child.pid, 'earlier-version child pid')
  fixtureMembers.push({
    hostPid: pid,
    targetPid: pid,
    targetMarker: marker,
    async stop() {
      const errors = await stopAllCarrying([marker])
      if (errors.length > 0) throw new AggregateError(errors, `earlier-version child ${pid} could not be stopped`)
    },
  })
  await once(child, 'spawn')
  return { pid, marker }
}

/** An interrupted task an earlier version launched: an attempt, no scope, no admission. */
async function seedEarlierVersionInterruptedTask(params: {
  readonly store: FileSystemSessionStore
  readonly sessionId: string
  readonly disposition: 'manual' | 'automatic'
  readonly admission?: TaskAdmission
}): Promise<SessionTask> {
  const created = requiredValue(await params.store.createTaskRecord(params.sessionId, {
    workflowId: 'review-queue-workflow',
    brief: 'A task an earlier version interrupted while its Team child kept running.',
  }), 'earlier-version task')
  const attemptId = `earlier-attempt-${created.id}`
  return requiredValue((await params.store.compareAndSetTaskRecord(params.sessionId, created.id, ['queued'], {
    status: 'interrupted',
    processIdentity: attemptId,
    executionAttemptId: attemptId,
    executionAttemptNumber: 1,
    executionKind: 'initial',
    interruptedAt: new Date().toISOString(),
    recoveryCount: 0,
    recoveryDisposition: params.disposition,
    recoveryReason: 'Interrupted by an earlier version.',
    ...(params.admission ? { admission: params.admission } : {}),
  }, { expectedExecutionAttemptId: null }))?.task, 'earlier-version interrupted task')
}

async function startReviewQueue(workspacePath: string, store: FileSystemSessionStore, launcher: RunLauncher): Promise<{
  readonly queue: TaskQueue
  readonly owner: WorkspaceDispatcherOwner
}> {
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const queue = new TaskQueue({
    sessionStore: store,
    owner,
    maximumConcurrentTasks: 1,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
  })
  await queue.initialize()
  return { queue, owner }
}

// Review rank 1: an earlier version interrupted the task and released its
// slot while attempt 1's Team child kept running. Its descendants cannot be
// known (no scope), so no resume, manual or automatic, may start attempt 2
// beside that child (ADR section 7); the hold says why, and nothing is
// signalled.
test('an earlier-version interrupted task is held and refuses a manual resume while its child may run', { timeout: 60_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const store = new FileSystemSessionStore(workspacePath, { instanceId: 'review-queue-app' })
    const session = await store.createSession({ title: 'Earlier-version interrupted task, manual' })
    const child = await startEarlierVersionChild()
    const seeded = await seedEarlierVersionInterruptedTask({ store, sessionId: session.id, disposition: 'manual' })
    const launcher = new ScriptedLauncher(async () => undefined)
    const { queue, owner } = await startReviewQueue(workspacePath, store, launcher)
    try {
      const refusal = await queue.enqueueRecovery({ sessionId: session.id, taskId: seeded.id, source: 'manual_resume' })
        .then(() => undefined, (error: unknown) => error)
      const current = requiredValue(await store.getTaskRecord(session.id, seeded.id), 'held task')
      assert.deepEqual(
        {
          refused: refusal instanceof TaskQueueError ? refusal.code : String(refusal),
          status: current.status,
          admission: current.admission,
          attempt: current.executionAttemptId,
          hold: current.processCleanupHold?.reason,
          childRuns: processesCarrying(child.marker).length === 1,
        },
        {
          refused: 'task_admission_conflict',
          status: 'interrupted',
          admission: undefined,
          attempt: seeded.executionAttemptId,
          hold: 'descendants_unverified_without_scope',
          childRuns: true,
        },
      )
    } finally {
      await queue.close(1)
      await owner.release()
    }
  })
})

test('an earlier-version interrupted task with automatic recovery is held and not staged at startup', { timeout: 60_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const store = new FileSystemSessionStore(workspacePath, { instanceId: 'review-queue-app' })
    const session = await store.createSession({ title: 'Earlier-version interrupted task, automatic' })
    const child = await startEarlierVersionChild()
    const seeded = await seedEarlierVersionInterruptedTask({ store, sessionId: session.id, disposition: 'automatic' })
    const launcher = new ScriptedLauncher(async () => undefined)
    const { queue, owner } = await startReviewQueue(workspacePath, store, launcher)
    try {
      // A locked read after initialize, so the startup pass has run.
      await queue.snapshot()
      const current = requiredValue(await store.getTaskRecord(session.id, seeded.id), 'held task')
      assert.deepEqual(
        {
          status: current.status,
          admission: current.admission,
          hold: current.processCleanupHold?.reason,
          childRuns: processesCarrying(child.marker).length === 1,
        },
        {
          status: 'interrupted',
          admission: undefined,
          hold: 'descendants_unverified_without_scope',
          childRuns: true,
        },
      )
    } finally {
      await queue.close(1)
      await owner.release()
    }
  })
})

test('an earlier-version interrupted task already pending recovery at upgrade is not granted while its child may run', { timeout: 60_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const store = new FileSystemSessionStore(workspacePath, { instanceId: 'review-queue-app' })
    const session = await store.createSession({ title: 'Earlier-version pending recovery' })
    const child = await startEarlierVersionChild()
    const created = requiredValue(await store.createTaskRecord(session.id, {
      workflowId: 'review-queue-workflow',
      brief: 'Placeholder, replaced below.',
    }), 'placeholder')
    const attemptId = `earlier-attempt-${created.id}`
    const pending: TaskAdmission = {
      version: 1,
      phase: 'pending',
      requestId: `earlier-request-${created.id}`,
      order: '1',
      requestedAt: new Date().toISOString(),
      executionKind: 'recovery',
      source: 'manual_resume',
      expectedExecutionAttemptId: attemptId,
    }
    const seeded = requiredValue((await store.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
      status: 'interrupted',
      processIdentity: attemptId,
      executionAttemptId: attemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      interruptedAt: new Date().toISOString(),
      recoveryCount: 0,
      recoveryDisposition: 'manual',
      recoveryReason: 'Interrupted by an earlier version.',
      admission: pending,
    }, { expectedExecutionAttemptId: null }))?.task, 'earlier-version pending task')
    let launches = 0
    const launcher = new ScriptedLauncher(async () => { launches += 1 })
    const { queue, owner } = await startReviewQueue(workspacePath, store, launcher)
    try {
      await queue.snapshot()
      // The held request waits for the next periodic pass (an hour away
      // here), so the queue goes idle rather than dispatching again at once,
      // forever (final review, finding A).
      await withinBound(queue.whenIdle(), BOUND_MS, 'the queue to go idle beside a held pending recovery')
      const current = requiredValue(await store.getTaskRecord(session.id, seeded.id), 'held task')
      assert.deepEqual(
        {
          launches,
          status: current.status,
          admission: current.admission?.phase,
          attempt: current.executionAttemptId,
          hold: current.processCleanupHold?.reason,
          childRuns: processesCarrying(child.marker).length === 1,
        },
        {
          launches: 0,
          status: 'interrupted',
          admission: 'pending',
          attempt: attemptId,
          hold: 'descendants_unverified_without_scope',
          childRuns: true,
        },
      )
    } finally {
      await queue.close(1)
      await owner.release()
    }
  })
})

/**
 * A root worker an earlier version started: it carries the attempt's
 * identity marker and a fixture marker of its own, and is registered for
 * cleanup the moment it exists.
 */
async function startEarlierVersionRoot(processIdentity: string): Promise<{
  readonly pid: number
  readonly marker: string
  readonly exited: Promise<unknown>
}> {
  const marker = `--owned-review-fixture-root=${randomUUID()}`
  const root = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', '--', `${PROCESS_IDENTITY_ARGUMENT}${processIdentity}`, marker], {
    detached: true,
    stdio: 'ignore',
  })
  const pid = requiredValue(root.pid, 'earlier-version root pid')
  const exited = once(root, 'exit')
  fixtureMembers.push({
    hostPid: pid,
    targetPid: pid,
    targetMarker: marker,
    async stop() {
      const errors = await stopAllCarrying([marker])
      if (errors.length > 0) throw new AggregateError(errors, `earlier-version root ${pid} could not be stopped`)
    },
  })
  await once(root, 'spawn')
  return { pid, marker, exited }
}

// Review rank 5: a task an earlier version launched, still running at the
// upgrade, is counted legacy-active. When its root ends with a status, its
// descendants still cannot be known, so it keeps its slot (ADR section 7),
// and that has to survive a restart: the hold is written to the record.
test('an earlier-version legacy task that ends keeps its slot across a restart, with its hold recorded', { timeout: 90_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const store = new FileSystemSessionStore(workspacePath, { instanceId: 'review-queue-app' })
    const session = await store.createSession({ title: 'Earlier-version legacy task ends' })
    const child = await startEarlierVersionChild()
    const created = requiredValue(await store.createTaskRecord(session.id, {
      workflowId: 'review-queue-workflow',
      brief: 'A task an earlier version launched, still running at the upgrade.',
    }), 'legacy task')
    const attemptId = `earlier-attempt-${created.id}`
    const root = await startEarlierVersionRoot(attemptId)
    const legacy = requiredValue((await store.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
      status: 'running',
      processIdentity: attemptId,
      executionAttemptId: attemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      attemptStartedAt: new Date().toISOString(),
      workerStartedAt: new Date().toISOString(),
      pid: root.pid,
      processGroupId: root.pid,
    }, { expectedExecutionAttemptId: null }))?.task, 'legacy running task')
    const waiting = await seedInterruptedTask(store, session.id, 'waiting')

    const firstLauncher = new ScriptedLauncher(async () => undefined)
    const first = await startReviewQueue(workspacePath, store, firstLauncher)
    let firstClosed = false
    try {
      const pending = await first.queue.enqueueRecovery({ sessionId: session.id, taskId: waiting.id, source: 'manual_resume' })
      assert.equal(pending.admission?.phase, 'pending', 'arrangement: the legacy task holds the only slot')

      // The earlier version's root writes its end and exits.
      const ended = await store.compareAndSetTaskRecord(session.id, legacy.id, ['running'], {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: 'A step timed out.',
      }, { expectedExecutionAttemptId: attemptId })
      assert.equal(ended?.updated, true)
      const rootMarkerRows = processesCarrying(root.marker)
      assert.deepEqual(rootMarkerRows.map((row) => row.pid), [root.pid], 'the root is this fixture\'s own')
      process.kill(root.pid, 'SIGKILL')
      await withinBound(root.exited, BOUND_MS, 'the legacy root to exit')

      const heldEvent = queueEvent(workspacePath, (event) =>
        event.event === 'task_queue.reconciled' && event.task_id === legacy.id && event.reason === 'owned_process_cleanup')
      first.queue.wake()
      await withinBound(heldEvent, BOUND_MS, 'the queue to hold the ended legacy task')
      await first.queue.close(1)
      await first.owner.release()
      firstClosed = true
    } finally {
      if (!firstClosed) {
        await first.queue.close(1)
        await first.owner.release()
      }
    }

    // A restart: a fresh store and queue on the same workspace.
    const restartedStore = new FileSystemSessionStore(workspacePath, { instanceId: 'restarted-app' })
    let launchesAfterRestart = 0
    const restarted = await startReviewQueue(workspacePath, restartedStore, new ScriptedLauncher(async () => { launchesAfterRestart += 1 }))
    try {
      await restarted.queue.snapshot()
      const held = requiredValue(await restartedStore.getTaskRecord(session.id, legacy.id), 'legacy task after restart')
      const stillWaiting = requiredValue(await restartedStore.getTaskRecord(session.id, waiting.id), 'waiting task after restart')
      assert.deepEqual(
        {
          status: held.status,
          admission: held.admission,
          hold: held.processCleanupHold?.reason,
          waiting: stillWaiting.admission?.phase,
          launchesAfterRestart,
          childRuns: processesCarrying(child.marker).length === 1,
        },
        {
          status: 'failed',
          admission: undefined,
          hold: 'descendants_unverified_without_scope',
          waiting: 'pending',
          launchesAfterRestart: 0,
          childRuns: true,
        },
      )
    } finally {
      await restarted.queue.close(1)
      await restarted.owner.release()
    }
  })
})

// Review rank 10: a request whose next attempt's scope cannot be prepared
// (here its scope.json names another attempt) stays pending and is tried
// again on the next periodic pass. It must not make the dispatcher run again
// at once, forever, appending a failure event each time.
test('a pending request whose scope cannot be prepared leaves the queue idle until its next periodic pass', { timeout: 60_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const store = new FileSystemSessionStore(workspacePath, { instanceId: 'review-queue-app' })
    const session = await store.createSession({ title: 'Unpreparable scope' })
    const created = requiredValue(await store.createTaskRecord(session.id, {
      workflowId: 'review-queue-workflow',
      brief: 'A request whose next scope is damaged.',
    }), 'task')
    const pending: TaskAdmission = {
      version: 1,
      phase: 'pending',
      requestId: `damaged-scope-request-${created.id}`,
      order: '1',
      requestedAt: new Date().toISOString(),
      executionKind: 'initial',
      source: 'startup_repair',
      expectedExecutionAttemptId: null,
    }
    const queued = requiredValue((await store.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
      admission: pending,
    }, { expectedExecutionAttemptId: null }))?.task, 'pending task')
    // Attempt 1's scope folder exists, but its scope.json names attempt 2.
    const damaged = path.join(workspacePath, 'sessions', session.id, 'tasks', queued.id, 'owned-processes', 'attempt-1')
    for (const sub of ['intents', 'claims', 'fences', '.staging']) fs.mkdirSync(path.join(damaged, sub), { recursive: true })
    fs.writeFileSync(path.join(damaged, 'scope.json'), `${JSON.stringify({
      version: 1,
      taskId: queued.id,
      sessionId: session.id,
      executionAttemptNumber: 2,
      createdAt: new Date().toISOString(),
    })}\n`)

    const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
    const queue = new TaskQueue({
      sessionStore: store,
      owner,
      maximumConcurrentTasks: 1,
      repoRootPath: process.cwd(),
      workspacePath,
      taskLauncher: new ScriptedLauncher(async () => undefined),
      // One pass an hour, so any second pass in this test is a self-wake.
      tickIntervalMs: 60 * 60 * 1000,
    })
    try {
      await queue.initialize()
      await withinBound(queue.whenIdle(), BOUND_MS, 'the queue to go idle')
      const failures = readQueueEvents(workspacePath).filter((event) =>
        event.event === 'task_queue.dispatch_failed' && event.task_id === queued.id)
      const current = requiredValue(await store.getTaskRecord(session.id, queued.id), 'pending task')
      assert.deepEqual(
        { failureEvents: failures.length, admission: current.admission?.phase },
        { failureEvents: 1, admission: 'pending' },
      )
    } finally {
      await queue.close(1)
      await owner.release()
    }
  })
})

/**
 * A root whose parent never reaps it: a perl parent forks, the child leads
 * its own group and execs the root, and the parent sleeps without waiting.
 * Once the root is signalled it stays a zombie in its own group until the
 * parent exits. Both carry fixture markers and are registered for cleanup.
 */
async function startUnreapedRoot(processIdentity: string): Promise<{ readonly pid: number; readonly rootMarker: string }> {
  const parentMarker = `--owned-review-fixture-reaper=${randomUUID()}`
  const rootMarker = `--owned-review-fixture-root=${randomUUID()}`
  // The root's arguments travel in the environment, so only the root's own
  // command line carries the task's identity marker and the root marker.
  const script = [
    'my $pid = fork();',
    'if ($pid == 0) { setpgrp(0, 0); exec($ARGV[0], "-e", $ENV{OWNED_REVIEW_ROOT_CODE}, "--", $ENV{OWNED_REVIEW_ROOT_IDENTITY}, $ENV{OWNED_REVIEW_ROOT_MARKER}); exit 127; }',
    '$| = 1; print "root $pid\\n";',
    'sleep 3600;',
  ].join(' ')
  const parent = spawn('/usr/bin/perl', ['-e', script, process.execPath, parentMarker], {
    detached: true,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: {
      ...process.env,
      // The root says it runs, on the pipe it shares with its parent.
      OWNED_REVIEW_ROOT_CODE: "process.stdout.write('ready\\n'); setInterval(() => {}, 1 << 30)",
      OWNED_REVIEW_ROOT_IDENTITY: `${PROCESS_IDENTITY_ARGUMENT}${processIdentity}`,
      OWNED_REVIEW_ROOT_MARKER: rootMarker,
    },
  })
  const parentPid = requiredValue(parent.pid, 'reaper pid')
  fixtureMembers.push({
    hostPid: parentPid,
    targetPid: parentPid,
    targetMarker: parentMarker,
    async stop() {
      const errors = await stopAllCarrying([rootMarker, parentMarker])
      if (errors.length > 0) throw new AggregateError(errors, `unreaped root fixture ${parentPid} could not be stopped`)
    },
  })
  const stdout = requiredValue(parent.stdout, 'reaper stdout')
  const pid = await withinBound(new Promise<number>((resolve, reject) => {
    let buffered = ''
    stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const match = /root (\d+)\n/u.exec(buffered)
      if (match?.[1] && buffered.includes('ready\n')) resolve(Number(match[1]))
    })
    parent.once('exit', () => reject(new Error('the reaper exited before its root started')))
  }), BOUND_MS, 'the unreaped root to start and say it runs')
  stdout.resume()
  assert.deepEqual(
    processesCarrying(rootMarker).map((row) => ({ pid: row.pid, groupId: row.groupId })),
    [{ pid, groupId: pid }],
    'the root leads its own group',
  )
  return { pid, rootMarker }
}

// Review rank 4: cancellation releases the slot only once the attempt's
// scope is verified closed (closed.json), not merely because no hold was
// recorded. Here the stopped root stays a zombie in its own group, so the
// cancel's stop sees it exited while recovery still sees a live, unverified
// root and neither closes the scope nor records a hold.
test('cancelling a task whose stopped root is unreaped keeps its slot while its scope is open', { timeout: 60_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const store = new FileSystemSessionStore(workspacePath, { instanceId: 'review-queue-app' })
    const session = await store.createSession({ title: 'Cancel with an unreaped root' })
    const created = requiredValue(await store.createTaskRecord(session.id, {
      workflowId: 'review-queue-workflow',
      brief: 'A running task cancelled while its Team child runs.',
    }), 'task')
    const attemptId = randomUUID()
    const root = await startUnreapedRoot(attemptId)
    const member = await startHeldMember()
    const admission: TaskAdmission = {
      version: 1,
      phase: 'granted',
      requestId: `request-${attemptId}`,
      order: '1',
      requestedAt: new Date().toISOString(),
      executionKind: 'initial',
      source: 'apply',
      expectedExecutionAttemptId: null,
      grantId: `grant-${attemptId}`,
      ownerEpoch: 'previous-app-owner',
      grantedAt: new Date().toISOString(),
      executionAttemptId: attemptId,
    }
    const running = requiredValue((await store.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
      status: 'running',
      admission,
      processIdentity: attemptId,
      executionAttemptId: attemptId,
      executionAttemptNumber: 1,
      ...await currentAttemptScope(created, 1),
      executionKind: 'initial',
      attemptStartedAt: new Date().toISOString(),
      workerStartedAt: new Date().toISOString(),
      pid: root.pid,
      processGroupId: root.pid,
    }, { expectedExecutionAttemptId: null }))?.task, 'running task')
    publishHeldScope(workspacePath, running, member)

    const outcome = await cancelSessionTask({ sessionId: session.id, taskId: running.id, sessionStore: store })
      .then(() => 'resolved', (error: unknown) => error instanceof Error ? error.message : String(error))
    const current = requiredValue(await store.getTaskRecord(session.id, running.id), 'cancelled task')
    assert.deepEqual(
      {
        cleanupPending: /process cleanup remains pending/.test(outcome),
        status: current.status,
        admission: current.admission?.phase,
        scopeClosed: fs.existsSync(path.join(scopePath(workspacePath, running), 'closed.json')),
        memberRuns: processesCarrying(member.targetMarker).length === 1,
      },
      {
        cleanupPending: true,
        status: 'cancelled',
        admission: 'granted',
        scopeClosed: false,
        memberRuns: true,
      },
      `cancel outcome: ${outcome}`,
    )
  })
})

// Review rank 11: an earlier version granted the task but never passed its
// root the launch gate (no pid, no gate), so no root of that attempt ever did
// work. The new version launches it itself, and must launch it under an
// ownership scope, or the Team children its root starts go untracked.
test('an earlier version\'s never-launched grant is relaunched under an ownership scope', { timeout: 60_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const store = new FileSystemSessionStore(workspacePath, { instanceId: 'review-queue-app' })
    const session = await store.createSession({ title: 'Earlier-version grant, never launched' })
    const created = requiredValue(await store.createTaskRecord(session.id, {
      workflowId: 'review-queue-workflow',
      brief: 'A task an earlier version granted but never launched.',
    }), 'task')
    const attemptId = randomUUID()
    const admission: TaskAdmission = {
      version: 1,
      phase: 'granted',
      requestId: `request-${attemptId}`,
      order: '1',
      requestedAt: new Date().toISOString(),
      executionKind: 'initial',
      source: 'apply',
      expectedExecutionAttemptId: null,
      grantId: `grant-${attemptId}`,
      ownerEpoch: 'earlier-version-owner',
      grantedAt: new Date().toISOString(),
      executionAttemptId: attemptId,
    }
    const granted = requiredValue((await store.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
      admission,
      processIdentity: attemptId,
      executionAttemptId: attemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      attemptStartedAt: new Date().toISOString(),
    }, { expectedExecutionAttemptId: null }))?.task, 'granted task')
    assert.equal(granted.ownedProcessScope, undefined, 'arrangement: the earlier version recorded no scope')

    let launchedScope: string | undefined
    const launcher = new ScriptedLauncher(async (request) => {
      launchedScope = request.env?.[OWNED_PROCESS_SCOPE_ENV]
    })
    const { queue, owner } = await startReviewQueue(workspacePath, store, launcher)
    try {
      await withinBound(launcher.launched(granted.id), BOUND_MS, 'the grant to be launched')
      const current = requiredValue(await store.getTaskRecord(session.id, granted.id), 'launched task')
      const expectedScope = scopePath(workspacePath, current)
      assert.deepEqual(
        {
          launchedScope,
          ownedProcessScope: current.ownedProcessScope,
          scopePublished: fs.existsSync(path.join(expectedScope, 'scope.json')),
        },
        {
          launchedScope: expectedScope,
          ownedProcessScope: 1,
          scopePublished: true,
        },
      )
    } finally {
      await queue.close(1)
      await owner.release()
    }
  })
})

// Review rank 12: a held task keeps its slot until its descendants are
// verified gone, which for an earlier version's attempt is never. The queue
// reports the hold when it starts or changes, not on every pass.
test('a held task is reported once while its hold is unchanged, not on every pass', { timeout: 60_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const store = new FileSystemSessionStore(workspacePath, { instanceId: 'review-queue-app' })
    const session = await store.createSession({ title: 'Held task passes' })
    const child = await startEarlierVersionChild()
    const created = requiredValue(await store.createTaskRecord(session.id, {
      workflowId: 'review-queue-workflow',
      brief: 'An earlier-version task that ended while its Team child ran.',
    }), 'legacy task')
    const attemptId = `earlier-attempt-${created.id}`
    const held = requiredValue((await store.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
      status: 'failed',
      processIdentity: attemptId,
      executionAttemptId: attemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      completedAt: new Date().toISOString(),
      error: 'A step timed out.',
      processCleanupHold: {
        reason: 'descendants_unverified_without_scope',
        detail: 'This attempt was launched by an earlier version, which recorded no ownership scope.',
        since: new Date().toISOString(),
      },
    }, { expectedExecutionAttemptId: null }))?.task, 'held legacy task')

    const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
    const queue = new TaskQueue({
      sessionStore: store,
      owner,
      maximumConcurrentTasks: 1,
      repoRootPath: process.cwd(),
      workspacePath,
      taskLauncher: new ScriptedLauncher(async () => undefined),
      // One pass an hour, so every pass in this test is one it asked for.
      tickIntervalMs: 60 * 60 * 1000,
    })
    try {
      await queue.initialize()
      await withinBound(queue.whenIdle(), BOUND_MS, 'the startup pass to finish')
      for (let pass = 0; pass < 3; pass += 1) {
        queue.wake()
        await withinBound(queue.whenIdle(), BOUND_MS, `pass ${pass + 1} to finish`)
      }
      const reports = readQueueEvents(workspacePath).filter((event) =>
        event.event === 'task_queue.reconciled' &&
        event.reason === 'owned_process_cleanup' &&
        event.task_id === held.id)
      const current = requiredValue(await store.getTaskRecord(session.id, held.id), 'held task')
      assert.deepEqual(
        {
          reports: reports.length,
          hold: current.processCleanupHold?.reason,
          childRuns: processesCarrying(child.marker).length === 1,
        },
        {
          reports: 1,
          hold: 'descendants_unverified_without_scope',
          childRuns: true,
        },
      )
    } finally {
      await queue.close(1)
      await owner.release()
    }
  })
})

// Review rank 7(b): a Team step abandoned over a held subtree keeps its
// child's attempt folder (its working space, and the attempt's copy of the
// user's Pi credentials), and the root ends `failed` with the hold. The
// folder must stay while a member may run, and go once the attempt's scope
// is verified closed, whatever the finished status.
test('a failed task\'s attempt folder stays while its subtree is held and goes once its scope closes', { timeout: 90_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const store = new FileSystemSessionStore(workspacePath, { instanceId: 'review-queue-app' })
    const session = await store.createSession({ title: 'Failed with a held subtree' })
    const created = requiredValue(await store.createTaskRecord(session.id, {
      workflowId: 'review-queue-workflow',
      brief: 'A task whose Team step was abandoned over a held subtree.',
    }), 'task')
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
        workflowDefinitionHash: hashWorkflowContent('review-queue-workflow'),
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
    const childLocation = requiredValue(buildSessionRunAssignmentLocation(workspacePath, {
      sessionId: session.id,
      runId: created.runId,
      assignmentId: childRunId,
    }), 'child assignment location')
    fs.mkdirSync(childLocation.assignmentPath, { recursive: true })
    ensureRunPrivateRuntimeDirectory(childLocation.assignmentPath)
    const attemptTemporaryPath = getRunAttemptTemporaryPath(childLocation.assignmentPath, randomUUID())
    fs.mkdirSync(attemptTemporaryPath, { recursive: true, mode: 0o700 })
    const retainedCopy = path.join(attemptTemporaryPath, 'retained-agent-directory.txt')
    fs.writeFileSync(retainedCopy, 'Kept on purpose: a member may still use it.')

    const admission: TaskAdmission = {
      version: 1,
      phase: 'granted',
      requestId: `request-${attemptId}`,
      order: '1',
      requestedAt: new Date().toISOString(),
      executionKind: 'initial',
      source: 'apply',
      expectedExecutionAttemptId: null,
      grantId: `grant-${attemptId}`,
      ownerEpoch: 'previous-app-owner',
      grantedAt: new Date().toISOString(),
      executionAttemptId: attemptId,
    }
    const failed = requiredValue((await store.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
      status: 'failed',
      admission,
      processIdentity: attemptId,
      executionAttemptId: attemptId,
      executionAttemptNumber: 1,
      ...await currentAttemptScope(created, 1),
      executionKind: 'initial',
      completedAt: new Date().toISOString(),
      error: 'A descendant of this child could not be verified gone.',
      processCleanupHold: {
        reason: 'owned_processes_unverified',
        detail: 'A member of the step\'s subtree could not be verified gone.',
        since: new Date().toISOString(),
      },
    }, { expectedExecutionAttemptId: null }))?.task, 'failed task')
    const member = await startHeldMember()
    publishHeldScope(workspacePath, failed, member)

    const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
    const queue = new TaskQueue({
      sessionStore: store,
      owner,
      maximumConcurrentTasks: 1,
      repoRootPath: process.cwd(),
      workspacePath,
      taskLauncher: new ScriptedLauncher(async () => undefined),
      tickIntervalMs: TEST_TICK_INTERVAL_MS,
    })
    try {
      await queue.initialize()
      await withinBound(queue.whenIdle(), BOUND_MS, 'the startup pass to finish')
      assert.equal(fs.existsSync(retainedCopy), true, 'the attempt folder stays while a member may run')

      const released = queueEvent(workspacePath, (event) =>
        event.event === 'task_queue.released' && event.task_id === failed.id)
      await member.stop()
      queue.wake()
      await withinBound(released, BOUND_MS, 'the held slot to be released')
      const current = requiredValue(await store.getTaskRecord(session.id, failed.id), 'released task')
      assert.deepEqual(
        {
          status: current.status,
          admission: current.admission,
          hold: current.processCleanupHold,
          attemptFolderKept: fs.existsSync(attemptTemporaryPath),
        },
        {
          status: 'failed',
          admission: undefined,
          hold: undefined,
          attemptFolderKept: false,
        },
        'once the scope is verified closed, the attempt folder with its credential copy is removed',
      )
    } finally {
      await queue.close(1)
      await owner.release()
    }
  })
})

// The guard beside rank 7(b): an attempt folder is removed only once the
// attempt's scope is verified closed. An earlier version's finished task has
// no scope, so its descendants are never verified gone and its folder stays,
// whatever its status and though it holds no slot.
test('an earlier version\'s finished task keeps its attempt folder, its descendants unknown', { timeout: 60_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const store = new FileSystemSessionStore(workspacePath, { instanceId: 'review-queue-app' })
    const session = await store.createSession({ title: 'Earlier-version finished task' })
    const created = requiredValue(await store.createTaskRecord(session.id, {
      workflowId: 'review-queue-workflow',
      brief: 'A task an earlier version finished.',
    }), 'task')
    const attemptId = `earlier-attempt-${created.id}`
    const childRunId = `child-${randomUUID()}`
    const stateStore = new FileSystemWorkflowStateStore(requiredValue(created.assignmentPath, 'task assignment path'))
    await stateStore.initialize({
      manifest: {
        taskId: created.id,
        sessionId: session.id,
        rootRunId: created.runId,
        workflowId: created.workflowId,
        workflowDefinitionHash: hashWorkflowContent('review-queue-workflow'),
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
    fs.writeFileSync(workingFile, 'A descendant of an unknown attempt may be using this file.')
    const finished = requiredValue((await store.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
      status: 'done',
      processIdentity: attemptId,
      executionAttemptId: attemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      completedAt: new Date().toISOString(),
    }, { expectedExecutionAttemptId: null }))?.task, 'finished task')

    const { queue, owner } = await startReviewQueue(workspacePath, store, new ScriptedLauncher(async () => undefined))
    try {
      await withinBound(queue.whenIdle(), BOUND_MS, 'the startup pass to finish')
      // A listing runs recovery over every task in the session.
      await store.listTaskRecords(session.id)
      const current = requiredValue(await store.getTaskRecord(session.id, finished.id), 'finished task')
      assert.deepEqual(
        { status: current.status, admission: current.admission, workingFileKept: fs.existsSync(workingFile) },
        { status: 'done', admission: undefined, workingFileKept: true },
      )
    } finally {
      await queue.close(1)
      await owner.release()
    }
  })
})

// The nested-Team credential gap, beside rank 7(b): a Team step's child that
// starts a nested Team puts that Team's attempt folder, with its copy of the
// user's Pi credentials, in a sibling assignment of the same run. Only the
// nested Team's own spawner, inside the step's child, removes it, and when the
// step's child is terminated that spawner dies with it. Recovery removes the
// steps' folders, never the nested ones. Once the attempt's scope is verified
// closed every Team it records has ended, so their folders must go too; while
// the scope is held they stay.

/** Names this test's fixture identity; not read by any product code. */
const NESTED_FIXTURE_ID_ENV = 'PIPELINE_TEST_FIXTURE_ID'

const NESTED_ENV_KEYS = [
  'NODE_ENV',
  'PATH',
  'PI_CODING_AGENT_DIR',
  'TEAM_RUNTIME_PI_CLI_PATH',
  'TEAM_RUNTIME_PI_NODE_PATH',
  'TEAM_RUNTIME_TEST_CONTROL_DIR',
  'TEAM_RUNTIME_TEST_AGENT_RUNNER_MODULE',
  'TEAM_RUNTIME_TEST_NESTED_RUN_ID',
  OWNED_PROCESS_SCOPE_ENV,
  NESTED_FIXTURE_ID_ENV,
]

// The step's Team child (depth 1) starts one nested Team through the product's
// runTeam; every fake Pi records itself and then holds.
const NESTED_FAKE_PI = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

async function main() {
  const depth = Number(process.env.TEAM_SPAWN_DEPTH || '0')
  const childRunId = process.env.TEAM_SESSION_ID || path.basename(process.cwd())
  fs.appendFileSync(
    path.join(process.env.TEAM_RUNTIME_TEST_CONTROL_DIR, 'invocations.jsonl'),
    JSON.stringify({ pid: process.pid, depth, childRunId }) + '\\n',
  )
  if (depth === 1) {
    const { runTeam } = await import(pathToFileURL(process.env.TEAM_RUNTIME_TEST_AGENT_RUNNER_MODULE).href)
    runTeam({
      teamPath: path.dirname(process.env.TEAM_CONFIG_PATH),
      workspacePath: process.env.TEAM_WORKSPACE_PATH,
      brief: 'The nested Team.',
      spawnDepth: depth,
      childSessionId: process.env.TEAM_RUNTIME_TEST_NESTED_RUN_ID,
    }).catch((error) => console.error(error && error.stack ? error.stack : String(error)))
  }
  setInterval(() => {}, 1 << 30)
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error))
  process.exit(1)
})
`

interface NestedInvocation {
  readonly pid: number
  readonly depth: number
  readonly childRunId: string
}

function isNestedInvocation(value: unknown): value is NestedInvocation {
  return isRecord(value) &&
    typeof value.pid === 'number' &&
    typeof value.depth === 'number' &&
    typeof value.childRunId === 'string'
}

function readNestedInvocations(controlPath: string): NestedInvocation[] {
  const filePath = path.join(controlPath, 'invocations.jsonl')
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line): unknown => JSON.parse(line))
    .filter(isNestedInvocation)
}

/** Resolves once `read()` matches: checked now, and again on each change in `folder`. */
async function folderReaches<T>(folder: string, read: () => T, matches: (value: T) => boolean, description: string): Promise<T> {
  let watcher: fs.FSWatcher | undefined
  const reached = new Promise<T>((resolve, reject) => {
    const check = (): void => {
      const value = read()
      if (matches(value)) resolve(value)
    }
    // Watched before the first read, so a change between the two is not missed.
    watcher = fs.watch(folder, check)
    watcher.on('error', reject)
    check()
  })
  try {
    return await withinBound(reached, BOUND_MS, description)
  } finally {
    watcher?.close()
  }
}

/** The Pi agent-directory credential copies inside one assignment's attempt folders. */
function credentialCopies(assignmentPath: string): string[] {
  const { temporaryPath } = getRunRuntimePaths(assignmentPath)
  if (!fs.existsSync(temporaryPath)) return []
  return fs.readdirSync(temporaryPath).flatMap((attempt) => {
    const attemptPath = path.join(temporaryPath, attempt)
    return fs.readdirSync(attemptPath)
      .filter((entry) => entry.startsWith(ISOLATED_DIRECTORY_PREFIX))
      .map((entry) => path.join(attemptPath, entry, 'auth.json'))
      .filter((copy) => fs.existsSync(copy))
  })
}

test('a cancelled task\'s nested Team folder, left when its step\'s child was terminated, stays while held and goes once the scope closes', { timeout: 120_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const store = new FileSystemSessionStore(workspacePath, { instanceId: 'review-queue-app' })
    const session = await store.createSession({ title: 'Cancelled with a nested Team' })
    const created = requiredValue(await store.createTaskRecord(session.id, {
      workflowId: 'review-queue-workflow',
      brief: 'A task whose Team step started a nested Team and was cancelled.',
    }), 'task')
    const attemptId = `cancelled-attempt-${randomUUID()}`
    const stepRunId = `child-step-${randomUUID()}`
    const nestedRunId = `child-nested-${randomUUID()}`
    await new FileSystemWorkflowStateStore(requiredValue(created.assignmentPath, 'task assignment path')).initialize({
      manifest: {
        taskId: created.id,
        sessionId: session.id,
        rootRunId: created.runId,
        workflowId: created.workflowId,
        workflowDefinitionHash: hashWorkflowContent('review-queue-workflow'),
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
        childRunId: stepRunId,
        definitionHash: hashWorkflowContent('write'),
        recoveryPolicy: 'safe_retry',
        inputArtifact: 'incoming-brief.md',
        resultArtifact: 'answer.md',
        requestedResultType: 'artifact:answer.md',
      }],
    })
    const location = (assignmentId: string) => requiredValue(buildSessionRunAssignmentLocation(workspacePath, {
      sessionId: session.id,
      runId: created.runId,
      assignmentId,
    }), `assignment location ${assignmentId}`)
    const scopeFields = await currentAttemptScope(created, 1)
    const attemptScope = path.join(workspacePath, 'sessions', session.id, 'tasks', created.id, 'owned-processes', 'attempt-1')

    // The attempt's step runs in this process, standing for the task's root,
    // through the product's runTeam and a fake Pi, under the attempt's scope.
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-process-review-nested-'))
    const controlPath = path.join(fixtureRoot, 'control')
    const binPath = path.join(fixtureRoot, 'bin')
    const agentPath = path.join(fixtureRoot, 'pi-agent')
    for (const folder of [controlPath, binPath, agentPath]) fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
    const fakePiPath = path.join(binPath, 'pi')
    fs.writeFileSync(fakePiPath, NESTED_FAKE_PI, { mode: 0o755 })
    // A fixture value, never a real credential: the copy is what is observed.
    const credentialFixture = `${JSON.stringify({ fixture: randomUUID() })}\n`
    fs.writeFileSync(path.join(agentPath, 'auth.json'), credentialFixture, { mode: 0o600 })
    const fixtureId = randomUUID()
    const previous = new Map(NESTED_ENV_KEYS.map((key) => [key, process.env[key]]))
    process.env.NODE_ENV = 'test'
    process.env.PATH = `${binPath}${path.delimiter}${previous.get('PATH') ?? ''}`
    process.env.PI_CODING_AGENT_DIR = agentPath
    process.env.TEAM_RUNTIME_PI_CLI_PATH = fakePiPath
    process.env.TEAM_RUNTIME_PI_NODE_PATH = process.execPath
    process.env.TEAM_RUNTIME_TEST_CONTROL_DIR = controlPath
    process.env.TEAM_RUNTIME_TEST_AGENT_RUNNER_MODULE = fileURLToPath(
      new URL('../../domains/agent-execution/agent-runner.js', import.meta.url),
    )
    process.env.TEAM_RUNTIME_TEST_NESTED_RUN_ID = nestedRunId
    process.env[OWNED_PROCESS_SCOPE_ENV] = attemptScope
    process.env[NESTED_FIXTURE_ID_ENV] = fixtureId

    const cleanupErrors: unknown[] = []
    const step = new AbortController()
    let stepRun: Promise<unknown> | undefined
    try {
      stepRun = runTeam({
        teamPath: path.join(process.cwd(), 'teams', 'writing-team'),
        workspacePath,
        brief: 'The step that starts a nested Team and is cancelled.',
        spawnDepth: 0,
        childSessionId: stepRunId,
        parentAssignmentLocation: location(created.runId),
        signal: step.signal,
      })
      await folderReaches(
        controlPath,
        () => readNestedInvocations(controlPath),
        (entries) => entries.some((entry) => entry.childRunId === nestedRunId && entry.depth === 2),
        'the step\'s child and its nested Team to start',
      )
      assert.deepEqual(
        credentialCopies(location(nestedRunId).assignmentPath)
          .map((copy) => fs.readFileSync(copy, 'utf8') === credentialFixture),
        [true],
        'the nested Team\'s attempt folder holds its copy of the credentials',
      )

      // The step is cancelled: the product terminates its child's group and
      // closes the child's subtree, the nested Team included.
      step.abort()
      await withinBound(stepRun.then(() => undefined, () => undefined), BOUND_MS, 'the cancelled step to settle')
      assert.deepEqual(
        {
          fakePiRunning: processesCarrying(fakePiPath).length,
          stepCopies: credentialCopies(location(stepRunId).assignmentPath).length,
          nestedCopies: credentialCopies(location(nestedRunId).assignmentPath).length,
        },
        { fakePiRunning: 0, stepCopies: 0, nestedCopies: 1 },
        'the cancelled step removed its own child\'s copy, and the child that spawned the nested Team is gone',
      )
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      step.abort()
      if (stepRun) {
        await withinBound(stepRun.then(() => undefined, () => undefined), BOUND_MS, 'the step to settle')
          .catch((error: unknown) => { cleanupErrors.push(error) })
      }
      for (const stop of [
        () => stopProcessesWithEnvironment(NESTED_FIXTURE_ID_ENV, fixtureId),
        () => stopProcessesCarrying(fakePiPath),
      ]) {
        try {
          await stop()
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      if (cleanupErrors.length === 0) fs.rmSync(fixtureRoot, { recursive: true, force: true })
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, `nested fixture cleanup failed; ${fixtureRoot} is kept: ${describeErrors(cleanupErrors)}`)
    }

    // The task ended cancelled, still holding its grant, and a member of its
    // scope cannot be verified gone yet.
    const admission: TaskAdmission = {
      version: 1,
      phase: 'granted',
      requestId: `request-${attemptId}`,
      order: '1',
      requestedAt: new Date().toISOString(),
      executionKind: 'initial',
      source: 'apply',
      expectedExecutionAttemptId: null,
      grantId: `grant-${attemptId}`,
      ownerEpoch: 'previous-app-owner',
      grantedAt: new Date().toISOString(),
      executionAttemptId: attemptId,
    }
    const cancelled = requiredValue((await store.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
      status: 'cancelled',
      admission,
      processIdentity: attemptId,
      executionAttemptId: attemptId,
      executionAttemptNumber: 1,
      ...scopeFields,
      executionKind: 'initial',
      completedAt: new Date().toISOString(),
    }, { expectedExecutionAttemptId: null }))?.task, 'cancelled task')
    const member = await startHeldMember()
    publishHeldScope(workspacePath, cancelled, member)

    const { queue, owner } = await startReviewQueue(workspacePath, store, new ScriptedLauncher(async () => undefined))
    try {
      await withinBound(queue.whenIdle(), BOUND_MS, 'the startup pass to finish')
      const held = requiredValue(await store.getTaskRecord(session.id, cancelled.id), 'held task')
      assert.deepEqual(
        {
          hold: held.processCleanupHold?.reason,
          nestedCopies: credentialCopies(location(nestedRunId).assignmentPath).length,
        },
        { hold: 'owned_processes_unverified', nestedCopies: 1 },
        'while the scope is held, the nested Team\'s folder stays',
      )

      const released = queueEvent(workspacePath, (event) =>
        event.event === 'task_queue.released' && event.task_id === cancelled.id)
      await member.stop()
      queue.wake()
      await withinBound(released, BOUND_MS, 'the held slot to be released')
      const current = requiredValue(await store.getTaskRecord(session.id, cancelled.id), 'released task')
      assert.deepEqual(
        {
          status: current.status,
          admission: current.admission,
          hold: current.processCleanupHold,
          nestedFolderKept: fs.existsSync(getRunRuntimePaths(location(nestedRunId).assignmentPath).temporaryPath),
        },
        { status: 'cancelled', admission: undefined, hold: undefined, nestedFolderKept: false },
        'once the scope is verified closed, the nested Team\'s attempt folder with its credential copy is removed',
      )
    } finally {
      await queue.close(1)
      await owner.release()
    }
  })
})

// Characterization guard beside the nested-Team fix; it passes before the
// fix too. The folders recovery removes are named by records on disk, so one
// whose real path leads out of the run is kept. Here the run's assignments
// folder has become a link to a folder outside the workspace, and a Team
// intent in the attempt's own scope names a Team whose attempt folder is
// there. The scope still closes, so recovery reaches the removal.
test('characterization guard: a Team intent whose attempt folder leads outside its run keeps that folder', { timeout: 60_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const store = new FileSystemSessionStore(workspacePath, { instanceId: 'review-queue-app' })
    const session = await store.createSession({ title: 'Team folder outside the run' })
    const created = requiredValue(await store.createTaskRecord(session.id, {
      workflowId: 'review-queue-workflow',
      brief: 'A task whose run links its assignments outside the workspace.',
    }), 'task')
    const attemptId = `finished-attempt-${randomUUID()}`
    const outsideRunId = `child-outside-${randomUUID()}`
    const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-process-review-outside-'))
    try {
      const assignmentsPath = path.dirname(requiredValue(buildSessionRunAssignmentLocation(workspacePath, {
        sessionId: session.id,
        runId: created.runId,
        assignmentId: outsideRunId,
      }), 'outside Team location').assignmentPath)
      fs.renameSync(assignmentsPath, path.join(outsidePath, 'assignments'))
      fs.symlinkSync(path.join(outsidePath, 'assignments'), assignmentsPath, 'dir')
      const outsideTemporaryPath = path.join(outsidePath, 'assignments', outsideRunId, '.runtime', 'tmp', randomUUID())
      fs.mkdirSync(outsideTemporaryPath, { recursive: true, mode: 0o700 })
      const outsideFile = path.join(outsideTemporaryPath, 'outside.txt')
      fs.writeFileSync(outsideFile, 'Outside the run: recovery must never remove this.')

      const scopeFields = await currentAttemptScope(created, 1)
      const finished = requiredValue((await store.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
        status: 'failed',
        processIdentity: attemptId,
        executionAttemptId: attemptId,
        executionAttemptNumber: 1,
        ...scopeFields,
        executionKind: 'initial',
        completedAt: new Date().toISOString(),
        error: 'The step failed.',
      }, { expectedExecutionAttemptId: null }))?.task, 'finished task')
      const attemptScope = scopePath(workspacePath, finished)
      const ownedProcessId = randomUUID()
      fs.writeFileSync(path.join(attemptScope, 'intents', `${ownedProcessId}.json`), `${JSON.stringify({
        version: 1,
        ownedProcessId,
        parentOwnedProcessId: null,
        kind: 'team',
        childRunId: outsideRunId,
        spawnerRunId: finished.runId,
        spawnerAssignmentId: finished.runId,
        createdAt: new Date().toISOString(),
      })}\n`)

      // A listing runs recovery over every task in the session.
      await store.listTaskRecords(session.id)
      assert.deepEqual(
        {
          scopeClosed: fs.existsSync(path.join(attemptScope, 'closed.json')),
          outsideFileKept: fs.existsSync(outsideFile),
        },
        { scopeClosed: true, outsideFileKept: true },
        'the scope is verified closed, and the folder outside the run is kept',
      )
    } finally {
      fs.rmSync(outsidePath, { recursive: true, force: true })
    }
  })
})

// Final review, finding B: an earlier version's cancel released the task's
// slot, clearing its admission, pid and process group but keeping its attempt
// and process identity. Startup counts such a task legacy-active only while
// its root may live, as before. Its slot was already released, so it stays
// exactly as it is (ADR section 7): no hold is written for its descendants,
// and once its root is gone the slot goes to the next task, across restarts.
test('a task an earlier version cancelled long before the upgrade holds no slot and no hold, and a waiting task launches', { timeout: 60_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const store = new FileSystemSessionStore(workspacePath, { instanceId: 'review-queue-app' })
    const session = await store.createSession({ title: 'Cancelled before the upgrade' })
    const created = requiredValue(await store.createTaskRecord(session.id, {
      workflowId: 'review-queue-workflow',
      brief: 'A task an earlier version cancelled last week.',
    }), 'cancelled task')
    const attemptId = `earlier-attempt-${created.id}`
    const cancelled = requiredValue((await store.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
      status: 'cancelled',
      processIdentity: attemptId,
      executionAttemptId: attemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      attemptStartedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      completedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      error: 'Cancelled by user',
    }, { expectedExecutionAttemptId: null }))?.task, 'earlier-version cancelled task')

    // The upgrade: this version's first startup, then a restart.
    const first = await startReviewQueue(workspacePath, store, new ScriptedLauncher(async () => undefined))
    try {
      await withinBound(first.queue.whenIdle(), BOUND_MS, 'the upgrade\'s startup pass to finish')
    } finally {
      await first.queue.close(1)
      await first.owner.release()
    }

    const restartedStore = new FileSystemSessionStore(workspacePath, { instanceId: 'restarted-app' })
    const waiting = await seedInterruptedTask(restartedStore, session.id, 'waiting')
    const launcher = new ScriptedLauncher(async () => undefined)
    const restarted = await startReviewQueue(workspacePath, restartedStore, launcher)
    try {
      await restarted.queue.enqueueRecovery({ sessionId: session.id, taskId: waiting.id, source: 'manual_resume' })
      await withinBound(restarted.queue.whenIdle(), BOUND_MS, 'the queue to settle after the restart')
      const after = requiredValue(await restartedStore.getTaskRecord(session.id, cancelled.id), 'cancelled task after restart')
      const next = requiredValue(await restartedStore.getTaskRecord(session.id, waiting.id), 'waiting task after restart')
      assert.deepEqual(
        {
          status: after.status,
          admission: after.admission,
          hold: after.processCleanupHold,
          waitingCount: (await restarted.queue.snapshot()).waitingCount,
          waiting: next.admission?.phase,
        },
        { status: 'cancelled', admission: undefined, hold: undefined, waitingCount: 0, waiting: 'granted' },
        'the long-cancelled task holds no slot and no hold, and the only slot goes to the waiting task',
      )
      await withinBound(launcher.launched(waiting.id), BOUND_MS, 'the waiting task to launch')
    } finally {
      await restarted.queue.close(1)
      await restarted.owner.release()
    }
  })
})

// Final review, finding C: a task an earlier version launched and still ran
// at the upgrade is legacy-active: it holds a slot with no admission. Its
// descendants cannot be known, so cancelling it stops its root but reports
// that process cleanup remains pending (ADR section 7), as for an admitted
// task, rather than success.
test('cancelling a running earlier-version task reports that process cleanup remains pending', { timeout: 60_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const store = new FileSystemSessionStore(workspacePath, { instanceId: 'review-queue-app' })
    const session = await store.createSession({ title: 'Cancel an earlier-version running task' })
    const child = await startEarlierVersionChild()
    const created = requiredValue(await store.createTaskRecord(session.id, {
      workflowId: 'review-queue-workflow',
      brief: 'A task an earlier version launched, still running at the upgrade.',
    }), 'legacy task')
    const attemptId = `earlier-attempt-${created.id}`
    const root = await startEarlierVersionRoot(attemptId)
    const running = requiredValue((await store.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
      status: 'running',
      processIdentity: attemptId,
      executionAttemptId: attemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      attemptStartedAt: new Date().toISOString(),
      workerStartedAt: new Date().toISOString(),
      pid: root.pid,
      processGroupId: root.pid,
    }, { expectedExecutionAttemptId: null }))?.task, 'legacy running task')

    const outcome = await cancelSessionTask({ sessionId: session.id, taskId: running.id, sessionStore: store })
      .then(() => 'resolved', (error: unknown) => error instanceof Error ? error.message : String(error))
    await withinBound(root.exited, BOUND_MS, 'the cancelled root to exit')
    const current = requiredValue(await store.getTaskRecord(session.id, running.id), 'cancelled task')
    assert.deepEqual(
      {
        cleanupPending: /process cleanup remains pending/.test(outcome),
        status: current.status,
        childRuns: processesCarrying(child.marker).length === 1,
      },
      { cleanupPending: true, status: 'cancelled', childRuns: true },
      `cancel outcome: ${outcome}`,
    )
  })
})

// Final review, finding D: an earlier version's never-launched grant is
// launched under a scope of its own (rank 11). When that scope cannot be
// prepared, the grant is kept and tried again on later passes; like a
// pending request's (rank 10), its failure is reported once for each reason,
// not on every pass.
test('a never-launched earlier-version grant whose scope cannot be prepared is reported once, not on every pass', { timeout: 60_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const store = new FileSystemSessionStore(workspacePath, { instanceId: 'review-queue-app' })
    const session = await store.createSession({ title: 'Earlier-version grant, unpreparable scope' })
    const created = requiredValue(await store.createTaskRecord(session.id, {
      workflowId: 'review-queue-workflow',
      brief: 'A task an earlier version granted but never launched.',
    }), 'task')
    const attemptId = randomUUID()
    const admission: TaskAdmission = {
      version: 1,
      phase: 'granted',
      requestId: `request-${attemptId}`,
      order: '1',
      requestedAt: new Date().toISOString(),
      executionKind: 'initial',
      source: 'apply',
      expectedExecutionAttemptId: null,
      grantId: `grant-${attemptId}`,
      ownerEpoch: 'earlier-version-owner',
      grantedAt: new Date().toISOString(),
      executionAttemptId: attemptId,
    }
    const granted = requiredValue((await store.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
      admission,
      processIdentity: attemptId,
      executionAttemptId: attemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      attemptStartedAt: new Date().toISOString(),
    }, { expectedExecutionAttemptId: null }))?.task, 'granted task')
    // Attempt 1's scope folder exists, but its scope.json names attempt 2.
    const damaged = scopePath(workspacePath, granted)
    for (const sub of ['intents', 'claims', 'fences', '.staging']) fs.mkdirSync(path.join(damaged, sub), { recursive: true })
    fs.writeFileSync(path.join(damaged, 'scope.json'), `${JSON.stringify({
      version: 1,
      taskId: granted.id,
      sessionId: session.id,
      executionAttemptNumber: 2,
      createdAt: new Date().toISOString(),
    })}\n`)

    let launches = 0
    const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
    const queue = new TaskQueue({
      sessionStore: store,
      owner,
      maximumConcurrentTasks: 1,
      repoRootPath: process.cwd(),
      workspacePath,
      taskLauncher: new ScriptedLauncher(async () => { launches += 1 }),
      // One pass an hour, so every pass in this test is one it asked for.
      tickIntervalMs: 60 * 60 * 1000,
    })
    try {
      await queue.initialize()
      await withinBound(queue.whenIdle(), BOUND_MS, 'the startup pass to finish')
      for (let pass = 0; pass < 3; pass += 1) {
        queue.wake()
        await withinBound(queue.whenIdle(), BOUND_MS, `pass ${pass + 1} to finish`)
      }
      const failures = readQueueEvents(workspacePath).filter((event) =>
        event.event === 'task_queue.dispatch_failed' && event.task_id === granted.id)
      const current = requiredValue(await store.getTaskRecord(session.id, granted.id), 'granted task')
      assert.deepEqual(
        {
          failureEvents: failures.length,
          admission: current.admission?.phase,
          ownerEpoch: current.admission?.phase === 'granted' ? current.admission.ownerEpoch : undefined,
          launches,
        },
        { failureEvents: 1, admission: 'granted', ownerEpoch: 'earlier-version-owner', launches: 0 },
      )
    } finally {
      await queue.close(1)
      await owner.release()
    }
  })
})

// Final review, finding F; the owner's decision of 2026-09-29 (option 1): a
// task an earlier version had already moved to interrupted, with no scope and
// its root gone, can never be resumed after the upgrade. Resume stays refused
// with the hold's reason. It holds no slot, so cancelling it removes its hold:
// it becomes an ordinary finished earlier-version task, which holds no slot
// after a restart and whose session can be deleted. Nothing is signalled.
test('an earlier-version interrupted task is never resumed, and cancelling it drops its hold so it holds no slot and can be deleted', { timeout: 90_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const store = new FileSystemSessionStore(workspacePath, { instanceId: 'review-queue-app' })
    const session = await store.createSession({ title: 'Earlier-version interrupted task, cancelled' })
    const child = await startEarlierVersionChild()
    const seeded = await seedEarlierVersionInterruptedTask({ store, sessionId: session.id, disposition: 'manual' })

    const first = await startReviewQueue(workspacePath, store, new ScriptedLauncher(async () => undefined))
    let outcome: string
    try {
      const refusal = await first.queue.enqueueRecovery({ sessionId: session.id, taskId: seeded.id, source: 'manual_resume' })
        .then(() => undefined, (error: unknown) => error)
      const held = requiredValue(await store.getTaskRecord(session.id, seeded.id), 'held task')
      assert.deepEqual(
        {
          refused: refusal instanceof TaskQueueError ? refusal.code : String(refusal),
          reasonGiven: refusal instanceof Error && held.processCleanupHold?.detail !== undefined &&
            refusal.message.includes(held.processCleanupHold.detail),
          hold: held.processCleanupHold?.reason,
        },
        { refused: 'task_admission_conflict', reasonGiven: true, hold: 'descendants_unverified_without_scope' },
        'a resume is refused with the hold\'s reason',
      )

      outcome = await cancelSessionTask({ sessionId: session.id, taskId: seeded.id, sessionStore: store })
        .then(() => 'resolved', (error: unknown) => error instanceof Error ? error.message : String(error))
      await withinBound(first.queue.whenIdle(), BOUND_MS, 'the queue to settle after the cancel')
    } finally {
      await first.queue.close()
      await first.owner.release()
    }
    const cancelled = requiredValue(await store.getTaskRecord(session.id, seeded.id), 'cancelled task')
    assert.deepEqual(
      {
        outcome,
        status: cancelled.status,
        admission: cancelled.admission,
        hold: cancelled.processCleanupHold,
        childRuns: processesCarrying(child.marker).length === 1,
      },
      { outcome: 'resolved', status: 'cancelled', admission: undefined, hold: undefined, childRuns: true },
      'cancelling drops the hold and signals nothing',
    )

    // A restart: the cancelled task holds no slot, so a task in another
    // session waiting for the only slot launches.
    const restartedStore = new FileSystemSessionStore(workspacePath, { instanceId: 'restarted-app' })
    const otherSession = await restartedStore.createSession({ title: 'Another session' })
    const waiting = await seedInterruptedTask(restartedStore, otherSession.id, 'waiting')
    const launcher = new ScriptedLauncher(async () => undefined)
    const restarted = await startReviewQueue(workspacePath, restartedStore, launcher)
    try {
      await restarted.queue.enqueueRecovery({ sessionId: otherSession.id, taskId: waiting.id, source: 'manual_resume' })
      await withinBound(launcher.launched(waiting.id), BOUND_MS, 'the waiting task to launch beside the cancelled task')
      const after = requiredValue(await restartedStore.getTaskRecord(session.id, seeded.id), 'cancelled task after restart')
      assert.deepEqual(
        { status: after.status, hold: after.processCleanupHold },
        { status: 'cancelled', hold: undefined },
        'after a restart the cancelled task has no hold',
      )
    } finally {
      await restarted.queue.close()
      await restarted.owner.release()
    }

    const deletion = await restartedStore.deleteSessionIfNoActiveTasks(session.id)
    assert.deepEqual(deletion, { deleted: true }, 'its session can be deleted')
  })
})

// The same decision for an earlier-version interrupted task whose recovery
// request was left pending at the upgrade (rank 1 keeps it pending, never
// granted): cancelling it ends the request with the hold, so no request of a
// finished task waits for a pass that can never grant it.
test('cancelling an earlier-version interrupted task pending recovery ends its request and its hold', { timeout: 60_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const store = new FileSystemSessionStore(workspacePath, { instanceId: 'review-queue-app' })
    const session = await store.createSession({ title: 'Earlier-version pending recovery, cancelled' })
    const child = await startEarlierVersionChild()
    const created = requiredValue(await store.createTaskRecord(session.id, {
      workflowId: 'review-queue-workflow',
      brief: 'Placeholder, replaced below.',
    }), 'placeholder')
    const attemptId = `earlier-attempt-${created.id}`
    const pending: TaskAdmission = {
      version: 1,
      phase: 'pending',
      requestId: `earlier-request-${created.id}`,
      order: '1',
      requestedAt: new Date().toISOString(),
      executionKind: 'recovery',
      source: 'manual_resume',
      expectedExecutionAttemptId: attemptId,
    }
    const seeded = requiredValue((await store.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
      status: 'interrupted',
      processIdentity: attemptId,
      executionAttemptId: attemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      interruptedAt: new Date().toISOString(),
      recoveryCount: 0,
      recoveryDisposition: 'manual',
      recoveryReason: 'Interrupted by an earlier version.',
      admission: pending,
    }, { expectedExecutionAttemptId: null }))?.task, 'earlier-version pending task')
    const { queue, owner } = await startReviewQueue(workspacePath, store, new ScriptedLauncher(async () => undefined))
    try {
      await withinBound(queue.whenIdle(), BOUND_MS, 'the startup pass to hold the request')
      const outcome = await cancelSessionTask({ sessionId: session.id, taskId: seeded.id, sessionStore: store })
        .then(() => 'resolved', (error: unknown) => error instanceof Error ? error.message : String(error))
      await withinBound(queue.whenIdle(), BOUND_MS, 'the queue to settle after the cancel')
      const current = requiredValue(await store.getTaskRecord(session.id, seeded.id), 'cancelled task')
      assert.deepEqual(
        {
          outcome,
          status: current.status,
          admission: current.admission,
          hold: current.processCleanupHold,
          childRuns: processesCarrying(child.marker).length === 1,
        },
        { outcome: 'resolved', status: 'cancelled', admission: undefined, hold: undefined, childRuns: true },
      )
    } finally {
      await queue.close()
      await owner.release()
    }
  })
})

// A held task's root still blocks dispatch while it lives unverified. A task an
// earlier version launched is legacy-active, and its recorded worker is alive
// but not its own (a reused pid, or an identity that cannot be verified), so
// the queue reserves nothing new in the workspace (dispatch_blocked,
// ambiguous_process_identity) until that process exits. Once the task becomes
// interrupted, recovery holds it (rank 1). The hold keeps its slot, but it must
// not end the block: ADR section 7, "While its root lives, today's handling
// applies unchanged". With two slots, a second task must not start beside the
// unverified process, and nothing is signalled.
test('an earlier-version task held while its unverified worker lives keeps dispatch blocked, and a second task waits', { timeout: 90_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const store = new FileSystemSessionStore(workspacePath, { instanceId: 'review-queue-app' })
    const session = await store.createSession({ title: 'Held with an unverified worker' })
    // A live process at the recorded pid that does not carry the task's identity.
    const worker = await startEarlierVersionChild()
    const created = requiredValue(await store.createTaskRecord(session.id, {
      workflowId: 'review-queue-workflow',
      brief: 'A task an earlier version launched, whose recorded worker is not its own.',
    }), 'legacy task')
    const attemptId = `earlier-attempt-${created.id}`
    const legacy = requiredValue((await store.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
      status: 'running',
      processIdentity: attemptId,
      executionAttemptId: attemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      attemptStartedAt: new Date().toISOString(),
      workerStartedAt: new Date().toISOString(),
      pid: worker.pid,
      processGroupId: worker.pid,
    }, { expectedExecutionAttemptId: null }))?.task, 'legacy running task')
    const waiting = await seedInterruptedTask(store, session.id, 'waiting')

    let launches = 0
    const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
    const queue = new TaskQueue({
      sessionStore: store,
      owner,
      maximumConcurrentTasks: 2,
      repoRootPath: process.cwd(),
      workspacePath,
      taskLauncher: new ScriptedLauncher(async () => { launches += 1 }),
      // One pass an hour, so every pass in this test is one it asked for.
      tickIntervalMs: 60 * 60 * 1000,
    })
    try {
      await queue.initialize()
      await withinBound(queue.whenIdle(), BOUND_MS, 'the startup pass to finish')
      assert.equal((await queue.snapshot()).status, 'blocked', 'arrangement: the unverified worker blocks dispatch')

      // The earlier version's worker is recorded as interrupted while the
      // process at its pid still runs.
      const moved = await store.compareAndSetTaskRecord(session.id, legacy.id, ['running'], {
        status: 'interrupted',
        interruptedAt: new Date().toISOString(),
        recoveryDisposition: 'manual',
        recoveryReason: 'Interrupted by an earlier version.',
      }, { expectedExecutionAttemptId: attemptId })
      assert.equal(moved?.updated, true)
      const held = queueEvent(workspacePath, (event) =>
        event.event === 'task_queue.reconciled' && event.task_id === legacy.id && event.reason === 'owned_process_cleanup')
      queue.wake()
      await withinBound(held, BOUND_MS, 'recovery to hold the interrupted task')
      await withinBound(queue.whenIdle(), BOUND_MS, 'the pass after the hold to finish')

      await queue.enqueueRecovery({ sessionId: session.id, taskId: waiting.id, source: 'manual_resume' })
      await withinBound(queue.whenIdle(), BOUND_MS, 'the queue to settle with the second request')
      const current = requiredValue(await store.getTaskRecord(session.id, legacy.id), 'held task')
      const second = requiredValue(await store.getTaskRecord(session.id, waiting.id), 'waiting task')
      assert.deepEqual(
        {
          queue: (await queue.snapshot()).status,
          hold: current.processCleanupHold?.reason,
          second: second.admission?.phase,
          launches,
          workerRuns: processesCarrying(worker.marker).length === 1,
        },
        {
          queue: 'blocked',
          hold: 'descendants_unverified_without_scope',
          second: 'pending',
          launches: 0,
          workerRuns: true,
        },
        'while the unverified worker lives, dispatch stays blocked and the second task waits',
      )
    } finally {
      await queue.close()
      await owner.release()
    }
  })
})

// The same rule on the granted path. A task still holding its grant was held
// in an earlier session (its descendants unverified), and the pid it recorded
// now belongs to a live process that is not its own. The hold keeps its slot,
// and the unverified live root keeps dispatch blocked while it lives: a second
// task must not start beside it, and nothing is signalled.
test('a held granted task whose recorded root lives unverified keeps dispatch blocked, and a second task waits', { timeout: 90_000 }, async () => {
  await withWorkspace(async (workspacePath) => {
    const store = new FileSystemSessionStore(workspacePath, { instanceId: 'review-queue-app' })
    const session = await store.createSession({ title: 'Held grant with an unverified root' })
    // A live process at the recorded pid that does not carry the task's identity.
    const worker = await startEarlierVersionChild()
    const created = requiredValue(await store.createTaskRecord(session.id, {
      workflowId: 'review-queue-workflow',
      brief: 'A held task whose recorded pid is now another live process.',
    }), 'held task')
    const attemptId = `earlier-attempt-${created.id}`
    const admission: TaskAdmission = {
      version: 1,
      phase: 'granted',
      requestId: `request-${attemptId}`,
      order: '1',
      requestedAt: new Date().toISOString(),
      executionKind: 'initial',
      source: 'apply',
      expectedExecutionAttemptId: null,
      grantId: `grant-${attemptId}`,
      ownerEpoch: 'previous-app-owner',
      grantedAt: new Date().toISOString(),
      executionAttemptId: attemptId,
    }
    const held = requiredValue((await store.compareAndSetTaskRecord(session.id, created.id, ['queued'], {
      status: 'interrupted',
      admission,
      processIdentity: attemptId,
      executionAttemptId: attemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      interruptedAt: new Date().toISOString(),
      recoveryDisposition: 'manual',
      recoveryReason: 'Interrupted by an earlier version.',
      pid: worker.pid,
      processGroupId: worker.pid,
      processCleanupHold: {
        reason: 'descendants_unverified_without_scope',
        detail: 'This attempt was launched by an earlier version, which recorded no ownership scope.',
        since: new Date().toISOString(),
      },
    }, { expectedExecutionAttemptId: null }))?.task, 'held granted task')
    const waiting = await seedInterruptedTask(store, session.id, 'waiting')

    let launches = 0
    const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
    const queue = new TaskQueue({
      sessionStore: store,
      owner,
      maximumConcurrentTasks: 2,
      repoRootPath: process.cwd(),
      workspacePath,
      taskLauncher: new ScriptedLauncher(async () => { launches += 1 }),
      // One pass an hour, so every pass in this test is one it asked for.
      tickIntervalMs: 60 * 60 * 1000,
    })
    try {
      await queue.initialize()
      await withinBound(queue.whenIdle(), BOUND_MS, 'the startup pass to finish')
      await queue.enqueueRecovery({ sessionId: session.id, taskId: waiting.id, source: 'manual_resume' })
      await withinBound(queue.whenIdle(), BOUND_MS, 'the queue to settle with the second request')
      const current = requiredValue(await store.getTaskRecord(session.id, held.id), 'held task')
      const second = requiredValue(await store.getTaskRecord(session.id, waiting.id), 'waiting task')
      assert.deepEqual(
        {
          queue: (await queue.snapshot()).status,
          hold: current.processCleanupHold?.reason,
          grant: current.admission?.phase,
          second: second.admission?.phase,
          launches,
          workerRuns: processesCarrying(worker.marker).length === 1,
        },
        {
          queue: 'blocked',
          hold: 'descendants_unverified_without_scope',
          grant: 'granted',
          second: 'pending',
          launches: 0,
          workerRuns: true,
        },
        'while the unverified root lives, dispatch stays blocked and the second task waits',
      )
    } finally {
      await queue.close()
      await owner.release()
    }
  })
})
