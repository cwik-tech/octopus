import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { requiredValue } from '../../core/required-value.js'
import { TASK_QUEUE_EVENT_FILENAME } from '../../core/task-queue-events.js'
import { WorkspaceDispatcherOwner } from '../../core/workspace-dispatcher-owner.js'
import type { SessionTask, TaskAdmission } from '../../contracts/sessions.js'
import {
  CONFIGURED_PROVIDER_BROKER_URL_ENV,
  type RuntimeProviderConnection,
} from '../../domains/provider/provider-settings.js'
import type { RunLauncher } from '../../domains/run/run-launcher.js'
import type { RunStartRequest } from '../../domains/run/run-store.js'
import { configuredProviderBrokerIdentity } from '../../domains/sessions/provider-broker-identity.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { currentAttemptScope } from '../support/current-attempt-scope.js'
import {
  defaultIsProcessAlive,
  PROCESS_IDENTITY_ARGUMENT,
} from '../../domains/sessions/task-process-supervisor.js'
import { configuredProviderEnvironment } from '../../providers/configured-provider.js'
import { TaskQueue } from '../../services/task-queue.js'

// The queue compares a granted task's provider broker identity with the
// store's on every dispatch pass (services/task-queue.ts, the
// isTaskProviderBrokerCompatible branches). The desktop sets the store's
// identity once, when the API starts listening, from the configured-provider
// environment (electron/main.ts:252-256). With no provider connection that
// environment has no broker URL (providers/configured-provider.ts:59), so the
// store holds no identity. A task launched after the first connection is added
// carries one (electron/session-task-launcher.ts:119-141). Both identities are
// computed here with those same functions.
//
// The owner's broker URL is fixed for as long as it runs, and the store only
// acts on a broker mismatch after a restart (task-recovery-manager.ts, the
// `restarted && processIdentityMatches` broker branch). Asking the store to
// reconcile the owner's own live worker for that reason therefore changes
// nothing, and the queue woke itself again at once. The record counted here is
// the queue's own task_queue.reconciled event with reason
// provider_broker_incompatible, written once per reconciliation request.
//
// Substituted boundaries: the running task is seeded through the store's public
// compareAndSetTaskRecord with a granted admission, as task-queue-core.test.ts
// does for adopted grants, and its worker is a plain detached node child that
// carries the real --runtime-process-identity marker, so the store's real ps
// probe verifies it. The launcher only reports that a launch began; no task
// runner runs. The store and the queue read one fixed clock.

const FIXED_NOW = new Date('2026-01-01T09:00:00.000Z')
const TEST_TICK_INTERVAL_MS = 60_000
const BROKER_URL = 'http://127.0.0.1:41010/broker-token/settings/provider-execute'
const RESTARTED_BROKER_URL = 'http://127.0.0.1:41020/new-token/settings/provider-execute'
const FIRST_CONNECTION: RuntimeProviderConnection = {
  id: 'first-connection',
  kind: 'openai-compatible',
  name: 'First connection',
  baseUrl: 'http://127.0.0.1:41030/v1',
}

/** The identity the desktop stores at startup for these connections and broker URL. */
function desktopBrokerUrl(
  connections: RuntimeProviderConnection[],
  brokerUrl: string,
): string | undefined {
  return configuredProviderEnvironment(connections, brokerUrl)[
    CONFIGURED_PROVIDER_BROKER_URL_ENV
  ]
}

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

/** A real detached worker whose command line carries the task's identity marker. */
async function spawnMarkedWorker(processIdentity: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1e9)', '--', `${PROCESS_IDENTITY_ARGUMENT}${processIdentity}`],
    { detached: true, stdio: 'ignore' },
  )
  await once(child, 'spawn')
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

/** The running, granted record a launch leaves once its worker is attached. */
async function seedRunningTask(params: {
  store: FileSystemSessionStore
  sessionId: string
  worker: ChildProcess
  processIdentity: string
  brokerIdentity: string
}): Promise<SessionTask> {
  const created = requiredValue(
    await params.store.createTaskRecord(params.sessionId, {
      workflowId: 'broker-identity-workflow',
      brief: 'Keep working while the provider broker identity is compared.',
    }),
    'created task',
  )
  const workerPid = requiredValue(params.worker.pid, 'worker pid')
  const running = await params.store.compareAndSetTaskRecord(
    params.sessionId,
    created.id,
    ['queued'],
    {
      status: 'running',
      admission: grantedAdmission(params.processIdentity),
      processIdentity: params.processIdentity,
      executionAttemptId: params.processIdentity,
      executionAttemptNumber: 1,
      ...await currentAttemptScope(created, 1),
      executionKind: 'initial',
      attemptStartedAt: FIXED_NOW.toISOString(),
      workerStartedAt: FIXED_NOW.toISOString(),
      pid: workerPid,
      processGroupId: workerPid,
      configuredProviderBrokerIdentity: params.brokerIdentity,
    },
    { expectedExecutionAttemptId: null },
  )
  assert.equal(running?.updated, true)
  return requiredValue(running?.task, 'running task')
}

/** An interrupted task a manual resume can send through the queue. */
async function seedInterruptedTask(
  store: FileSystemSessionStore,
  sessionId: string,
  label: string,
): Promise<SessionTask> {
  const created = requiredValue(
    await store.createTaskRecord(sessionId, {
      workflowId: 'broker-identity-workflow',
      brief: `Unrelated work ${label}.`,
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
      recoveryReason: 'Resumed by the broker identity test.',
    },
    { expectedExecutionAttemptId: null },
  )
  assert.equal(interrupted?.updated, true)
  return requiredValue(interrupted?.task, 'interrupted task')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The queue's broker reconciliation records for one task, from its event log. */
function brokerReconciliationRecords(workspacePath: string, taskId: string): number {
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
      event.reason === 'provider_broker_incompatible' &&
      event.task_id === taskId,
    )
    .length
}

function createQueue(params: {
  store: FileSystemSessionStore
  owner: WorkspaceDispatcherOwner
  workspacePath: string
  launcher: RunLauncher
}): TaskQueue {
  return new TaskQueue({
    sessionStore: params.store,
    owner: params.owner,
    maximumConcurrentTasks: 3,
    repoRootPath: process.cwd(),
    workspacePath: params.workspacePath,
    taskLauncher: params.launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
    now: () => FIXED_NOW,
  })
}

test('the owner does not reconcile its own live worker on every pass after the first provider connection', {
  timeout: 30_000,
  skip: process.platform === 'win32',
}, async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-broker-owned-'))
  const store = new FileSystemSessionStore(workspacePath, {
    instanceId: 'desktop-owner',
    now: () => FIXED_NOW,
  })
  // Desktop startup with no provider connection (electron/main.ts:252-256).
  store.setConfiguredProviderBrokerUrl(desktopBrokerUrl([], BROKER_URL))
  const processIdentity = `owned-broker-attempt-${process.pid}`
  const worker = await spawnMarkedWorker(processIdentity)
  let owner: WorkspaceDispatcherOwner | undefined
  let queue: TaskQueue | undefined
  try {
    const session = await store.createSession({ title: 'Owned broker identity' })
    // Launched after the first connection was added.
    const launchedBrokerIdentity = requiredValue(
      configuredProviderBrokerIdentity(desktopBrokerUrl([FIRST_CONNECTION], BROKER_URL)),
      'launched broker identity',
    )
    const running = await seedRunningTask({
      store,
      sessionId: session.id,
      worker,
      processIdentity,
      brokerIdentity: launchedBrokerIdentity,
    })
    assert.deepEqual(
      {
        owned: store.ownsTaskProcess(running),
        alive: store.isTaskProcessAlive(running),
        identityVerified: store.hasValidTaskProcessIdentity(running),
        brokerCompatible: store.isTaskProviderBrokerCompatible(running),
      },
      { owned: true, alive: true, identityVerified: true, brokerCompatible: false },
    )
    const second = await seedInterruptedTask(store, session.id, 'two')
    const third = await seedInterruptedTask(store, session.id, 'three')

    owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
    const launcher = new SignallingLauncher()
    queue = createQueue({ store, owner, workspacePath, launcher })
    assert.deepEqual(await queue.initialize(), { pending: 0, granted: 1, legacyActive: 0 })

    // Two more dispatch passes, each proven by the launch it performs. A pass
    // asks for the running task's reconciliation before it launches anything.
    await queue.enqueueRecovery({ sessionId: session.id, taskId: second.id, source: 'manual_resume' })
    await launcher.launched(second.id)
    await queue.enqueueRecovery({ sessionId: session.id, taskId: third.id, source: 'manual_resume' })
    await launcher.launched(third.id)

    const current = await store.getTaskRecord(session.id, running.id)
    assert.deepEqual(
      {
        brokerReconciliations: brokerReconciliationRecords(workspacePath, running.id),
        status: current?.status,
        pid: current?.pid,
        processGroupId: current?.processGroupId,
        admission: current?.admission,
        workerAlive: defaultIsProcessAlive(-requiredValue(worker.pid, 'worker pid')),
      },
      {
        brokerReconciliations: 0,
        status: 'running',
        pid: running.pid,
        processGroupId: running.processGroupId,
        admission: running.admission,
        workerAlive: true,
      },
      'The owner launched this worker against its own broker, so a broker identity ' +
        'comparison cannot make it obsolete: the queue must not ask for its reconciliation ' +
        'on startup or on either later pass, and the task keeps running with its grant.',
    )
  } finally {
    await queue?.close(1)
    await owner?.release()
    await stopWorker(worker)
    fs.rmSync(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('a restarted owner still terminates a live worker bound to the previous broker', {
  timeout: 30_000,
  skip: process.platform === 'win32',
}, async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-broker-restarted-'))
  const processIdentity = `restarted-broker-attempt-${process.pid}`
  const worker = await spawnMarkedWorker(processIdentity)
  const workerExited = once(worker, 'exit')
  let owner: WorkspaceDispatcherOwner | undefined
  let queue: TaskQueue | undefined
  try {
    const previous = new FileSystemSessionStore(workspacePath, {
      instanceId: 'previous-desktop',
      now: () => FIXED_NOW,
    })
    const session = await previous.createSession({ title: 'Restarted broker identity' })
    const running = await seedRunningTask({
      store: previous,
      sessionId: session.id,
      worker,
      processIdentity,
      brokerIdentity: requiredValue(
        configuredProviderBrokerIdentity(desktopBrokerUrl([FIRST_CONNECTION], BROKER_URL)),
        'previous broker identity',
      ),
    })

    const restarted = new FileSystemSessionStore(workspacePath, {
      instanceId: 'restarted-desktop',
      now: () => FIXED_NOW,
    })
    restarted.setConfiguredProviderBrokerUrl(
      desktopBrokerUrl([FIRST_CONNECTION], RESTARTED_BROKER_URL),
    )
    assert.deepEqual(
      {
        owned: restarted.ownsTaskProcess(running),
        identityVerified: restarted.hasValidTaskProcessIdentity(running),
        brokerCompatible: restarted.isTaskProviderBrokerCompatible(running),
      },
      { owned: false, identityVerified: true, brokerCompatible: false },
    )

    owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
    queue = createQueue({ store: restarted, owner, workspacePath, launcher: new SignallingLauncher() })
    // Startup routes the inherited grant to the store, which terminates the
    // worker before initialize resolves.
    await queue.initialize()
    await workerExited

    const current = await restarted.getTaskRecord(session.id, running.id)
    assert.deepEqual(
      {
        brokerReconciliations: brokerReconciliationRecords(workspacePath, running.id),
        status: current?.status,
        error: current?.error,
        admission: current?.admission,
      },
      {
        brokerReconciliations: 1,
        status: 'failed',
        error: 'Task worker used an obsolete configured-provider broker after a service restart',
        admission: undefined,
      },
    )
  } finally {
    await queue?.close(1)
    await owner?.release()
    await stopWorker(worker)
    fs.rmSync(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
