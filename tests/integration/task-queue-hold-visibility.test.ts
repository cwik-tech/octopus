/**
 * The queue names every task that holds a slot for a reason (A5.2).
 *
 * A task whose worker cannot be verified, or whose descendants cannot be
 * verified gone, keeps its slot, and SR-01 keeps it: that rule is unchanged.
 * What was missing is the reason. The public snapshot at `GET /scheduling/queue`
 * now carries it on the task's own item, as `hold`:
 *
 * - `unverified_live_process`: the recorded worker is alive but does not carry
 *   the task's identity (`processId` is its pid);
 * - `ambiguous_marker`: several process groups carry the task's identity
 *   (`processGroupCount` counts them);
 * - the two descendant reasons A4.2c persists on the task (`processCleanupHold`).
 *
 * `blocksDispatch` is true for the two root reasons, which stop all dispatch in
 * the workspace. While the queue is ready and open, the snapshot's status is
 * `blocked` exactly when some item's hold blocks dispatch; while it is not
 * ready, or closed, it stays `recovering`. The event log records
 * `task_queue.dispatch_blocked` naming the blocking tasks on each change of
 * that set, and `task_queue.dispatch_unblocked` when it empties.
 *
 * Each case seeds the task state the product writes, at one of the queue's
 * sites that set its blocked flag, and reads the snapshot through the real
 * route over loopback. The processes are real, and the store's own `ps` probes
 * decide every identity. Nothing is mocked; the launcher only reports that a
 * launch began. The store and the queue read one fixed clock.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { z } from 'zod'

import { requiredValue } from '../../core/required-value.js'
import { TASK_QUEUE_EVENT_FILENAME } from '../../core/task-queue-events.js'
import { WorkspaceDispatcherOwner } from '../../core/workspace-dispatcher-owner.js'
import type { SessionTask, TaskAdmission } from '../../contracts/sessions.js'
import type { RunLauncher } from '../../domains/run/run-launcher.js'
import type { RunStartRequest } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { PROCESS_IDENTITY_ARGUMENT } from '../../domains/sessions/task-process-supervisor.js'
import { handleSchedulingQueueRoutes } from '../../server/routes/scheduling-queue.js'
import { TaskQueue } from '../../services/task-queue.js'
import { cancelSessionTask } from '../../services/task-service.js'
import { currentAttemptScope } from '../support/current-attempt-scope.js'
import {
  describeErrors,
  stopAllCarrying,
  stopProcessesCarrying,
  withinBound,
} from '../support/fixture-process-markers.js'

const FIXED_NOW = new Date('2026-01-01T09:00:00.000Z')
const TEST_TICK_INTERVAL_MS = 60_000
const EVENT_BOUND_MS = 20_000

const holdSchema = z.object({
  reason: z.string(),
  blocksDispatch: z.boolean(),
  processId: z.number().optional(),
  processGroupCount: z.number().optional(),
  since: z.string().optional(),
}).strict()

const snapshotSchema = z.object({
  status: z.string(),
  items: z.array(z.object({
    taskId: z.string(),
    state: z.string(),
    hold: holdSchema.optional(),
  })),
})

type Snapshot = z.infer<typeof snapshotSchema>

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

interface Harness {
  readonly workspacePath: string
  readonly store: FileSystemSessionStore
  readonly launcher: SignallingLauncher
  /** Every fixture marker a process here was started with, for cleanup. */
  readonly markers: string[]
  owner?: WorkspaceDispatcherOwner
  queue?: TaskQueue
  server?: http.Server
}

/**
 * One workspace, its store, and every process and server a case starts.
 * Cleanup closes the route and the queue, stops every fixture process by its
 * own marker (rechecked immediately before its signal), attempts every step
 * whatever failed before, and keeps the workspace on any failure.
 */
async function withHarness(label: string, fn: (harness: Harness) => Promise<void>): Promise<void> {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), `queue-hold-${label}-`))
  const harness: Harness = {
    workspacePath,
    store: new FileSystemSessionStore(workspacePath, { instanceId: 'desktop-owner', now: () => FIXED_NOW }),
    launcher: new SignallingLauncher(),
    markers: [],
  }
  const failures: unknown[] = []
  try {
    await fn(harness)
  } catch (error) {
    failures.push(error)
  }
  for (const step of [
    async () => {
      const server = harness.server
      if (server) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
    async () => {
      const queue = harness.queue
      if (!queue) return
      await queue.close(1)
      // A pass already under way (a held task's reconciliation takes a session
      // lock) would otherwise write into the workspace after it is removed.
      await withinBound(queue.whenIdle(), EVENT_BOUND_MS, 'the closed queue to finish its last pass')
    },
    async () => { await harness.owner?.release() },
  ]) {
    try {
      await step()
    } catch (error) {
      failures.push(error)
    }
  }
  failures.push(...await stopAllCarrying(harness.markers))
  if (failures.length === 0) fs.rmSync(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, `hold visibility case and its cleanup failed; ${workspacePath} is kept: ${describeErrors(failures)}`)
}

interface Worker {
  readonly child: ChildProcess
  readonly pid: number
  readonly marker: string
  readonly exited: Promise<unknown>
}

/**
 * A detached worker leading its own group. It carries a fixture marker of its
 * own and, when given, the task's identity marker. With `sameGroupCopy` it
 * first starts one more process in its own group carrying the same arguments.
 * It prints `ready` once everything it starts is running.
 */
async function startWorker(
  harness: Harness,
  options: { readonly processIdentity?: string; readonly sameGroupCopy?: boolean } = {},
): Promise<Worker> {
  const marker = `--hold-visibility-fixture=${randomUUID()}`
  // Registered before the spawn, so cleanup always sees it.
  harness.markers.push(marker)
  const identity = options.processIdentity ? [`${PROCESS_IDENTITY_ARGUMENT}${options.processIdentity}`] : []
  const script = options.sameGroupCopy
    ? [
        "const copy = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', '--', ...process.argv.slice(1)], { stdio: 'ignore' })",
        "copy.once('spawn', () => process.stdout.write('ready\\n'))",
        'setInterval(() => {}, 1 << 30)',
      ].join('\n')
    : "process.stdout.write('ready\\n'); setInterval(() => {}, 1 << 30)"
  const child = spawn(process.execPath, ['-e', script, '--', marker, ...identity], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const exited = once(child, 'exit')
  const stdout = requiredValue(child.stdout, 'worker stdout')
  await withinBound(new Promise<void>((resolve, reject) => {
    stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('ready\n')) resolve()
    })
    child.once('exit', () => reject(new Error('the worker exited before it was ready')))
  }), EVENT_BOUND_MS, 'the worker to be ready')
  stdout.resume()
  return { child, pid: requiredValue(child.pid, 'worker pid'), marker, exited }
}

function grantedAdmission(executionAttemptId: string): Extract<TaskAdmission, { phase: 'granted' }> {
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

async function createTask(harness: Harness, sessionId: string, brief: string): Promise<SessionTask> {
  return requiredValue(
    await harness.store.createTaskRecord(sessionId, { workflowId: 'hold-visibility-workflow', brief }),
    'created task',
  )
}

/** Writes a launched attempt's fields onto a queued task, as a launch would have. */
async function seedAttempt(
  harness: Harness,
  task: SessionTask,
  fields: Partial<SessionTask>,
): Promise<SessionTask> {
  const executionAttemptId = `attempt-${task.id}`
  const seeded = await harness.store.compareAndSetTaskRecord(
    task.sessionId,
    task.id,
    ['queued'],
    {
      processIdentity: executionAttemptId,
      executionAttemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      attemptStartedAt: FIXED_NOW.toISOString(),
      workerStartedAt: FIXED_NOW.toISOString(),
      ...fields,
    },
    { expectedExecutionAttemptId: null },
  )
  assert.equal(seeded?.updated, true, 'arrangement: the attempt was seeded')
  return requiredValue(seeded?.task, 'seeded task')
}

/** An interrupted task a manual resume can send through the queue. */
async function seedInterruptedTask(harness: Harness, sessionId: string): Promise<SessionTask> {
  const created = await createTask(harness, sessionId, 'Wait for the held slot.')
  const previousAttemptId = `previous-attempt-${created.id}`
  const interrupted = await harness.store.compareAndSetTaskRecord(
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
      recoveryReason: 'Resumed by the hold visibility test.',
    },
    { expectedExecutionAttemptId: null },
  )
  assert.equal(interrupted?.updated, true)
  return requiredValue(interrupted?.task, 'interrupted task')
}

/** One slot, so a waiting task launches only once the held task frees it. */
async function startQueue(harness: Harness): Promise<{ queue: TaskQueue; url: string }> {
  harness.owner = await WorkspaceDispatcherOwner.acquire({ workspacePath: harness.workspacePath })
  const queue = new TaskQueue({
    sessionStore: harness.store,
    owner: harness.owner,
    maximumConcurrentTasks: 1,
    repoRootPath: process.cwd(),
    workspacePath: harness.workspacePath,
    taskLauncher: harness.launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
    now: () => FIXED_NOW,
  })
  harness.queue = queue
  // Resolves after the startup pass and the reconciliations it requested.
  await queue.initialize()
  const server = http.createServer((req, res) => {
    void handleSchedulingQueueRoutes({
      req,
      res,
      url: new URL(req.url ?? '/', 'http://127.0.0.1'),
      runtime: queue,
    }).then((handled) => {
      if (!handled) {
        res.statusCode = 404
        res.end()
      }
    })
  })
  harness.server = server
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return { queue, url: `http://127.0.0.1:${address.port}` }
}

async function readSnapshot(url: string): Promise<Snapshot> {
  const response = await fetch(`${url}/scheduling/queue`)
  assert.equal(response.status, 200, 'the snapshot route answers')
  return snapshotSchema.parse(await response.json())
}

function holdOf(snapshot: Snapshot, taskId: string): unknown {
  const item = snapshot.items.find((entry) => entry.taskId === taskId)
  return item === undefined ? 'no item' : item.hold
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The dispatch events the queue logged, in order, reduced to what they name. */
function dispatchEvents(harness: Harness): Array<{ readonly event: string; readonly blockedBy?: string[] }> {
  const eventsPath = path.join(harness.workspacePath, 'task-queue', TASK_QUEUE_EVENT_FILENAME)
  if (!fs.existsSync(eventsPath)) return []
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line): unknown => JSON.parse(line))
    .filter(isRecord)
    .filter((entry) => entry.event === 'task_queue.dispatch_blocked' || entry.event === 'task_queue.dispatch_unblocked')
    .map((entry) => {
      const blockedBy = entry.blocked_by
      return {
        event: String(entry.event),
        ...(Array.isArray(blockedBy)
          ? {
              blockedBy: blockedBy
                .map((member: unknown) => (isRecord(member) ? `${String(member.task_id)}:${String(member.hold_reason)}` : '?'))
                .sort(),
            }
          : {}),
      }
    })
}

/** Resolves once the queue's event log satisfies `matches`, as reported by a watch on its folder. */
async function eventLogShows(
  harness: Harness,
  matches: (events: ReturnType<typeof dispatchEvents>) => boolean,
  description: string,
): Promise<void> {
  const folder = path.join(harness.workspacePath, 'task-queue')
  fs.mkdirSync(folder, { recursive: true })
  let watcher: fs.FSWatcher | undefined
  try {
    await withinBound(new Promise<void>((resolve) => {
      watcher = fs.watch(folder, () => {
        if (matches(dispatchEvents(harness))) resolve()
      })
      if (matches(dispatchEvents(harness))) resolve()
    }), EVENT_BOUND_MS, description)
  } finally {
    watcher?.close()
  }
}

// ── Root holds, one case per site that blocks dispatch ──────────────────────

test('a granted, running task whose live worker is not its own holds its item as an unverified live process', async () => {
  await withHarness('granted-unverified', async (harness) => {
    const session = await harness.store.createSession({ title: 'Granted unverified' })
    const worker = await startWorker(harness)
    const created = await createTask(harness, session.id, 'Run beside an unverified worker.')
    const task = await seedAttempt(harness, created, {
      status: 'running',
      admission: grantedAdmission(`attempt-${created.id}`),
      pid: worker.pid,
      processGroupId: worker.pid,
      ...await currentAttemptScope(created, 1),
    })

    const { url } = await startQueue(harness)
    const snapshot = await readSnapshot(url)

    assert.deepEqual(
      { status: snapshot.status, hold: holdOf(snapshot, task.id), taskStatus: (await harness.store.getTaskRecord(session.id, task.id))?.status },
      { status: 'blocked', hold: { reason: 'unverified_live_process', blocksDispatch: true, processId: worker.pid }, taskStatus: 'running' },
    )
  })
})

test('a granted, running task whose marker two process groups carry holds its item as an ambiguous marker, counting groups', async () => {
  await withHarness('granted-ambiguous', async (harness) => {
    const session = await harness.store.createSession({ title: 'Granted ambiguous' })
    const created = await createTask(harness, session.id, 'Run while two groups carry its identity.')
    const identity = `attempt-${created.id}`
    // Three processes carry the identity: two in one group, one in another.
    await startWorker(harness, { processIdentity: identity, sameGroupCopy: true })
    await startWorker(harness, { processIdentity: identity })
    const task = await seedAttempt(harness, created, {
      status: 'running',
      admission: grantedAdmission(identity),
      ...await currentAttemptScope(created, 1),
    })

    const { url } = await startQueue(harness)
    const snapshot = await readSnapshot(url)

    assert.deepEqual(
      { status: snapshot.status, hold: holdOf(snapshot, task.id), taskStatus: (await harness.store.getTaskRecord(session.id, task.id))?.status },
      { status: 'blocked', hold: { reason: 'ambiguous_marker', blocksDispatch: true, processGroupCount: 2 }, taskStatus: 'running' },
    )
  })
})

test('an earlier-version running task, with no admission, whose live worker is not its own holds its item as an unverified live process', async () => {
  await withHarness('legacy-unverified', async (harness) => {
    const session = await harness.store.createSession({ title: 'Legacy unverified' })
    const worker = await startWorker(harness)
    const created = await createTask(harness, session.id, 'An earlier version started this.')
    const task = await seedAttempt(harness, created, {
      status: 'running',
      pid: worker.pid,
      processGroupId: worker.pid,
    })

    const { url } = await startQueue(harness)
    const snapshot = await readSnapshot(url)

    assert.deepEqual(
      { status: snapshot.status, hold: holdOf(snapshot, task.id), taskStatus: (await harness.store.getTaskRecord(session.id, task.id))?.status },
      { status: 'blocked', hold: { reason: 'unverified_live_process', blocksDispatch: true, processId: worker.pid }, taskStatus: 'running' },
    )
  })
})

test('an earlier-version running task, with no admission, whose marker two process groups carry holds its item as an ambiguous marker', async () => {
  await withHarness('legacy-ambiguous', async (harness) => {
    const session = await harness.store.createSession({ title: 'Legacy ambiguous' })
    const created = await createTask(harness, session.id, 'An earlier version started this.')
    const identity = `attempt-${created.id}`
    await startWorker(harness, { processIdentity: identity })
    await startWorker(harness, { processIdentity: identity })
    const task = await seedAttempt(harness, created, { status: 'running' })

    const { url } = await startQueue(harness)
    const snapshot = await readSnapshot(url)

    assert.deepEqual(
      { status: snapshot.status, hold: holdOf(snapshot, task.id), taskStatus: (await harness.store.getTaskRecord(session.id, task.id))?.status },
      { status: 'blocked', hold: { reason: 'ambiguous_marker', blocksDispatch: true, processGroupCount: 2 }, taskStatus: 'running' },
    )
  })
})

// An earlier version's task keeps its slot through a wait or an interruption
// recorded while its worker, not its own, still runs. While that worker lives,
// dispatch stays blocked (ADR section 7), and the task's item names the worker
// whatever the task's status (A5.2 review 4).
const LEGACY_TRANSITIONS: ReadonlyArray<{
  readonly status: 'awaiting_input' | 'interrupted'
  readonly fields: Partial<SessionTask>
  /** The descendant hold recovery records on the task once the queue has read the change. */
  readonly recordedHold?: string
}> = [
  { status: 'awaiting_input', fields: {} },
  {
    status: 'interrupted',
    fields: {
      interruptedAt: FIXED_NOW.toISOString(),
      recoveryDisposition: 'manual',
      recoveryReason: 'Interrupted by an earlier version.',
    },
    // Recovery reconciles the interruption and, as the earlier version
    // recorded no ownership scope, records that its descendants cannot be
    // verified gone. The root is still probed, so the hold does not unblock.
    recordedHold: 'descendants_unverified_without_scope',
  },
]

for (const transition of LEGACY_TRANSITIONS) {
  test(`an earlier-version task that becomes ${transition.status} while its live worker is not its own keeps dispatch blocked, and its item names the worker`, async () => {
    await withHarness(`legacy-${transition.status}`, async (harness) => {
      const session = await harness.store.createSession({ title: `Legacy ${transition.status}` })
      const worker = await startWorker(harness)
      const created = await createTask(harness, session.id, 'An earlier version started this.')
      const task = await seedAttempt(harness, created, {
        status: 'running',
        pid: worker.pid,
        processGroupId: worker.pid,
      })
      const unverified = { reason: 'unverified_live_process', blocksDispatch: true, processId: worker.pid }
      const { queue, url } = await startQueue(harness)
      assert.deepEqual(holdOf(await readSnapshot(url), task.id), unverified, 'arrangement: the running task holds its item')

      const moved = await harness.store.compareAndSetTaskRecord(
        session.id,
        task.id,
        ['running'],
        { status: transition.status, ...transition.fields },
        { expectedExecutionAttemptId: task.executionAttemptId ?? null },
      )
      assert.equal(moved?.updated, true, `arrangement: the task became ${transition.status}`)
      queue.wake()
      await withinBound(queue.whenIdle(), EVENT_BOUND_MS, 'the queue to finish the passes that read the change')
      const snapshot = await readSnapshot(url)
      const stored = await harness.store.getTaskRecord(session.id, task.id)

      assert.deepEqual(
        {
          status: snapshot.status,
          hold: holdOf(snapshot, task.id),
          taskStatus: stored?.status,
          recordedHold: stored?.processCleanupHold?.reason,
          events: dispatchEvents(harness),
        },
        {
          status: 'blocked',
          hold: unverified,
          taskStatus: transition.status,
          recordedHold: transition.recordedHold,
          // Blocked at startup, and never unblocked while the worker lives.
          events: [{ event: 'task_queue.dispatch_blocked', blockedBy: [`${task.id}:unverified_live_process`] }],
        },
      )
    })
  })
}

test('a cancelled task whose live worker is not its own holds its item until the worker exits; the waiting task then starts, and the event log names both changes', async () => {
  await withHarness('cancelled-unverified', async (harness) => {
    const session = await harness.store.createSession({ title: 'Cancelled unverified' })
    const worker = await startWorker(harness)
    const created = await createTask(harness, session.id, 'Cancelled while an unverified worker runs.')
    const running = await seedAttempt(harness, created, {
      status: 'running',
      admission: grantedAdmission(`attempt-${created.id}`),
      pid: worker.pid,
      processGroupId: worker.pid,
      ...await currentAttemptScope(created, 1),
    })
    await assert.rejects(
      cancelSessionTask({ sessionId: session.id, taskId: running.id, sessionStore: harness.store }),
      /process cleanup remains pending/,
    )
    const waiting = await seedInterruptedTask(harness, session.id)

    const { queue, url } = await startQueue(harness)
    await queue.enqueueRecovery({ sessionId: session.id, taskId: waiting.id, source: 'manual_resume' })
    const blocked = await readSnapshot(url)

    assert.deepEqual(
      {
        status: blocked.status,
        hold: holdOf(blocked, running.id),
        waiting: blocked.items.find((item) => item.taskId === waiting.id)?.state,
      },
      {
        status: 'blocked',
        hold: { reason: 'unverified_live_process', blocksDispatch: true, processId: worker.pid },
        waiting: 'waiting',
      },
    )

    await stopProcessesCarrying(worker.marker)
    await withinBound(worker.exited, EVENT_BOUND_MS, 'the unverified worker to exit')
    queue.wake()
    await withinBound(harness.launcher.launched(waiting.id), EVENT_BOUND_MS, 'the waiting task to launch')
    await eventLogShows(
      harness,
      (events) => events.some((entry) => entry.event === 'task_queue.dispatch_unblocked'),
      'the event log to record that dispatch is no longer blocked',
    )
    const released = await readSnapshot(url)

    assert.deepEqual(
      {
        status: released.status,
        holds: released.items.filter((item) => item.hold !== undefined).map((item) => item.taskId),
        events: dispatchEvents(harness),
      },
      {
        status: 'ready',
        holds: [],
        events: [
          { event: 'task_queue.dispatch_blocked', blockedBy: [`${running.id}:unverified_live_process`] },
          { event: 'task_queue.dispatch_unblocked' },
        ],
      },
    )
  })
})

test('a cancelled task with no live target whose marker two process groups carry holds its item as an ambiguous marker', async () => {
  await withHarness('cancelled-ambiguous', async (harness) => {
    const session = await harness.store.createSession({ title: 'Cancelled ambiguous' })
    const created = await createTask(harness, session.id, 'Cancelled while two groups carry its identity.')
    const identity = `attempt-${created.id}`
    await startWorker(harness, { processIdentity: identity })
    await startWorker(harness, { processIdentity: identity })
    const task = await seedAttempt(harness, created, {
      status: 'cancelled',
      admission: grantedAdmission(identity),
      completedAt: FIXED_NOW.toISOString(),
      error: 'Cancelled by user',
      ...await currentAttemptScope(created, 1),
    })

    const { url } = await startQueue(harness)
    const snapshot = await readSnapshot(url)

    assert.deepEqual(
      { status: snapshot.status, hold: holdOf(snapshot, task.id) },
      { status: 'blocked', hold: { reason: 'ambiguous_marker', blocksDispatch: true, processGroupCount: 2 } },
    )
  })
})

test('each change to the set of blocking tasks is written to the event log', async () => {
  await withHarness('blocking-set-change', async (harness) => {
    const session = await harness.store.createSession({ title: 'Blocking set change' })
    const worker = await startWorker(harness)
    const first = await createTask(harness, session.id, 'Held by an unverified worker.')
    const unverified = await seedAttempt(harness, first, {
      status: 'running',
      admission: grantedAdmission(`attempt-${first.id}`),
      pid: worker.pid,
      processGroupId: worker.pid,
      ...await currentAttemptScope(first, 1),
    })
    const second = await createTask(harness, session.id, 'Held by an ambiguous marker.')
    const identity = `attempt-${second.id}`
    await startWorker(harness, { processIdentity: identity })
    await startWorker(harness, { processIdentity: identity })
    const ambiguous = await seedAttempt(harness, second, {
      status: 'cancelled',
      admission: grantedAdmission(identity),
      completedAt: FIXED_NOW.toISOString(),
      error: 'Cancelled by user',
      ...await currentAttemptScope(second, 1),
    })

    const { queue } = await startQueue(harness)
    assert.deepEqual(dispatchEvents(harness), [{
      event: 'task_queue.dispatch_blocked',
      blockedBy: [`${ambiguous.id}:ambiguous_marker`, `${unverified.id}:unverified_live_process`].sort(),
    }])

    await stopProcessesCarrying(worker.marker)
    await withinBound(worker.exited, EVENT_BOUND_MS, 'the unverified worker to exit')
    queue.wake()

    await eventLogShows(
      harness,
      (events) => events.length >= 2,
      'the event log to record the smaller set of blocking tasks',
    )
    assert.deepEqual(dispatchEvents(harness), [
      {
        event: 'task_queue.dispatch_blocked',
        blockedBy: [`${ambiguous.id}:ambiguous_marker`, `${unverified.id}:unverified_live_process`].sort(),
      },
      { event: 'task_queue.dispatch_blocked', blockedBy: [`${ambiguous.id}:ambiguous_marker`] },
    ])
  })
})

// ── Descendant holds, and the queue's recovering state ──────────────────────

test('a granted wait held for its descendants keeps its status and shows its persisted hold, without blocking dispatch', async () => {
  await withHarness('held-wait', async (harness) => {
    const session = await harness.store.createSession({ title: 'Held wait' })
    const created = await createTask(harness, session.id, 'Wait for an answer while a descendant may run.')
    const since = FIXED_NOW.toISOString()
    // An earlier version launched this attempt, so its descendants cannot be
    // known and recovery cannot clear the hold.
    const task = await seedAttempt(harness, created, {
      status: 'awaiting_input',
      admission: grantedAdmission(`attempt-${created.id}`),
      processCleanupHold: {
        reason: 'descendants_unverified_without_scope',
        detail: 'This attempt was launched by an earlier version, which recorded no ownership scope.',
        since,
      },
    })

    const { url } = await startQueue(harness)
    const snapshot = await readSnapshot(url)
    const stored = await harness.store.getTaskRecord(session.id, task.id)

    assert.deepEqual(
      {
        status: snapshot.status,
        hold: holdOf(snapshot, task.id),
        taskStatus: stored?.status,
        admission: stored?.admission?.phase,
      },
      {
        status: 'ready',
        hold: { reason: 'descendants_unverified_without_scope', blocksDispatch: false, since },
        taskStatus: 'awaiting_input',
        admission: 'granted',
      },
    )
  })
})

test('a closed queue reports recovering, not blocked, whatever holds it last recorded', async () => {
  await withHarness('closed-recovering', async (harness) => {
    const session = await harness.store.createSession({ title: 'Closed while blocked' })
    const worker = await startWorker(harness)
    const created = await createTask(harness, session.id, 'Run beside an unverified worker.')
    await seedAttempt(harness, created, {
      status: 'running',
      admission: grantedAdmission(`attempt-${created.id}`),
      pid: worker.pid,
      processGroupId: worker.pid,
      ...await currentAttemptScope(created, 1),
    })
    const { queue, url } = await startQueue(harness)
    assert.equal((await readSnapshot(url)).status, 'blocked', 'arrangement: the open queue is blocked')

    await queue.close(1)

    assert.equal((await readSnapshot(url)).status, 'recovering')
  })
})
