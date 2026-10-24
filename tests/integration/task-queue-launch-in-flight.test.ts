import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { requiredValue } from '../../core/required-value.js'
import { WorkspaceDispatcherOwner } from '../../core/workspace-dispatcher-owner.js'
import type { SessionTask } from '../../contracts/sessions.js'
import type { RunLauncher } from '../../domains/run/run-launcher.js'
import type { RunLaunchResult, RunStartRequest } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { TaskQueue } from '../../services/task-queue.js'
import { currentAttemptScope } from '../support/current-attempt-scope.js'
import { withinBound } from '../support/fixture-process-markers.js'

// While a granted task's launch is in flight, the queue has nothing to change
// for it: the launch's own completion wakes the queue, and recovery's rules
// for a worker that never started are applied on each periodic pass. So the
// queue must go idle rather than dispatch again at once, on every pass, for
// as long as the launch runs ("no hot loop, wait for the tick").

const BOUND_MS = 20_000
// One pass an hour, so every pass in these tests is one the queue woke itself for.
const TICK_INTERVAL_MS = 60 * 60 * 1000
// Longer than a test, so recovery never reaps a launching task here.
const STALE_TASK_GRACE_MS = 10 * 60 * 1000

interface HeldLaunch {
  readonly started: Promise<void>
  markStarted(): void
  release?: (error: Error) => void
}

/** A launcher whose launches are reported as events and settle only when the test releases them. */
class HeldLauncher implements RunLauncher {
  private readonly launches = new Map<string, HeldLaunch>()

  private launch(taskId: string): HeldLaunch {
    const existing = this.launches.get(taskId)
    if (existing) return existing
    let markStarted = (): void => undefined
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const created: HeldLaunch = { started, markStarted }
    this.launches.set(taskId, created)
    return created
  }

  started(taskId: string): Promise<void> {
    return this.launch(taskId).started
  }

  startRun(request: RunStartRequest): Promise<RunLaunchResult> {
    const held = this.launch(requiredValue(request.env?.TEAM_RUNTIME_TASK_ID, 'launched task id'))
    held.markStarted()
    return new Promise<RunLaunchResult>((_resolve, reject) => { held.release = reject })
  }

  fail(taskId: string, message: string): void {
    this.launch(taskId).release?.(new Error(message))
  }

  failAll(message: string): void {
    for (const held of this.launches.values()) held.release?.(new Error(message))
  }
}

async function withQueue(fn: (context: {
  readonly store: FileSystemSessionStore
  readonly queue: TaskQueue
  readonly launcher: HeldLauncher
}) => Promise<void>): Promise<void> {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'task-queue-launch-in-flight-'))
  const store = new FileSystemSessionStore(workspacePath, {
    instanceId: 'launch-in-flight-app',
    staleTaskGraceMs: STALE_TASK_GRACE_MS,
  })
  const launcher = new HeldLauncher()
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const queue = new TaskQueue({
    sessionStore: store,
    owner,
    maximumConcurrentTasks: 1,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TICK_INTERVAL_MS,
  })
  try {
    await fn({ store, queue, launcher })
  } finally {
    launcher.failAll('Released by the launch-in-flight test.')
    await queue.close()
    await owner.release()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
}

/** An interrupted task this version launched, waiting for a manual resume. */
async function seedInterruptedTask(store: FileSystemSessionStore, sessionId: string, label: string): Promise<SessionTask> {
  const created = requiredValue(await store.createTaskRecord(sessionId, {
    workflowId: 'launch-in-flight-workflow',
    brief: `The ${label} task.`,
  }), `${label} task`)
  return requiredValue((await store.compareAndSetTaskRecord(sessionId, created.id, ['queued'], {
    status: 'interrupted',
    processIdentity: `previous-attempt-${created.id}`,
    executionAttemptId: `previous-attempt-${created.id}`,
    executionAttemptNumber: 1,
    ...await currentAttemptScope(created, 1),
    executionKind: 'initial',
    interruptedAt: new Date().toISOString(),
    recoveryDisposition: 'manual',
    recoveryReason: `Resumed by the launch-in-flight test (${label}).`,
  }, { expectedExecutionAttemptId: null }))?.task, `${label} interrupted task`)
}

test('the queue goes idle while a granted task\'s launch is still in flight', { timeout: 60_000 }, async () => {
  await withQueue(async ({ store, queue, launcher }) => {
    const session = await store.createSession({ title: 'Launch in flight' })
    const interrupted = await seedInterruptedTask(store, session.id, 'slow')

    await queue.initialize()
    await withinBound(queue.whenIdle(), BOUND_MS, 'the startup pass to finish')
    await queue.enqueueRecovery({ sessionId: session.id, taskId: interrupted.id, source: 'manual_resume' })
    await withinBound(launcher.started(interrupted.id), BOUND_MS, 'the launch to start')
    await withinBound(queue.whenIdle(), BOUND_MS, 'the granting pass to finish')

    // A pass while the launch is in flight, as the periodic tick brings one.
    queue.wake()
    await withinBound(queue.whenIdle(), BOUND_MS, 'the queue to go idle while the launch is in flight')
    const launching = requiredValue(await store.getTaskRecord(session.id, interrupted.id), 'launching task')
    assert.deepEqual(
      { status: launching.status, admission: launching.admission?.phase, pid: launching.pid },
      { status: 'queued', admission: 'granted', pid: undefined },
      'the launch is still in flight, and its grant is kept',
    )
  })
})

// Characterization guard, passing before the idle fix too: the queue relies
// on a launch's own end to wake it, so a launch that fails in flight must
// still wake the queue, and the next task takes the slot without waiting for
// the periodic pass (an hour away here).
test('characterization guard: a launch that fails in flight wakes the queue, and the next task takes the slot', { timeout: 60_000 }, async () => {
  await withQueue(async ({ store, queue, launcher }) => {
    const session = await store.createSession({ title: 'Launch fails in flight' })
    const failing = await seedInterruptedTask(store, session.id, 'failing')
    const waiting = await seedInterruptedTask(store, session.id, 'waiting')

    await queue.initialize()
    await withinBound(queue.whenIdle(), BOUND_MS, 'the startup pass to finish')
    await queue.enqueueRecovery({ sessionId: session.id, taskId: failing.id, source: 'manual_resume' })
    await queue.enqueueRecovery({ sessionId: session.id, taskId: waiting.id, source: 'manual_resume' })
    await withinBound(launcher.started(failing.id), BOUND_MS, 'the first launch to start')
    assert.equal(
      requiredValue(await store.getTaskRecord(session.id, waiting.id), 'waiting task').admission?.phase,
      'pending',
      'arrangement: the waiting task has no slot while the first launch holds it',
    )

    launcher.fail(failing.id, 'The launch failed in flight.')
    await withinBound(launcher.started(waiting.id), BOUND_MS, 'the waiting task to launch once the first launch has failed')
    const failed = requiredValue(await store.getTaskRecord(session.id, failing.id), 'failed task')
    assert.deepEqual(
      { status: failed.status, admission: failed.admission },
      { status: 'interrupted', admission: undefined },
      'the failed launch gave its slot back',
    )
  })
})
