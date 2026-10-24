import { whenDefined } from '../../core/optional-properties.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { markRunPlanQueued } from '../../domains/run-orchestrator/orchestrator.js'
import type { RunPlan } from '../../contracts/run-plan.js'
import type { SessionTask, TaskAdmission } from '../../contracts/sessions.js'
import {
  cancelSessionTask,
  launchReservedTaskExecutionAttempt,
  launchSessionTask,
  openTaskLaunchGate,
  resumeSessionTask,
} from '../../services/task-service.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { currentAttemptScope } from '../support/current-attempt-scope.js'
import type { RunLauncher } from '../../domains/run/run-launcher.js'
import {
  PROCESS_IDENTITY_ARGUMENT,
  SessionTaskRunnerLauncher,
} from '../../domains/sessions/session-task-launcher.js'
import {
  defaultIsProcessAlive,
  findTaskProcessByIdentity,
  isTaskProcessIdentityValid,
} from '../../domains/sessions/task-process-supervisor.js'
import { configuredProviderBrokerIdentity } from '../../domains/sessions/provider-broker-identity.js'

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'real-task-process-'))
}

test('launch gate publication is idempotent only for the same worker identity', async () => {
  const workspacePath = makeWorkspace()
  const gatePath = path.join(workspacePath, '.worker-launch-ready.test-attempt')
  try {
    await Promise.all([
      openTaskLaunchGate(gatePath, 'worker-identity'),
      openTaskLaunchGate(gatePath, 'worker-identity'),
    ])
    assert.equal(fs.readFileSync(gatePath, 'utf8'), 'worker-identity')
    await assert.rejects(
      openTaskLaunchGate(gatePath, 'different-worker'),
      /identity does not match/,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

function readyPlan(): RunPlan {
  return {
    id: `plan-${Date.now()}`,
    goal: 'Exercise a real task worker process.',
    summary: 'Ready.',
    status: 'ready',
    selectedWorkflow: {
      id: 'wf-1',
      rationale: 'Selected for process lifecycle testing.',
      confidence: 'high',
    },
    requiredInputs: [],
    actions: [{
      id: 'launch-workflow',
      type: 'launch_workflow',
      status: 'ready',
      title: 'Launch wf-1',
      rationale: 'Ready.',
    }],
    warnings: [],
    createdAt: new Date().toISOString(),
  }
}

function grantedAdmission(params: {
  executionAttemptId: string
  executionKind?: 'initial' | 'recovery'
  runPlanId?: string
}): Extract<TaskAdmission, { phase: 'granted' }> {
  const now = new Date().toISOString()
  return {
    version: 1,
    phase: 'granted',
    requestId: `request-${params.executionAttemptId}`,
    order: '1',
    requestedAt: now,
    executionKind: params.executionKind ?? 'initial',
    source: params.executionKind === 'recovery' ? 'automatic_recovery' : 'apply',
    expectedExecutionAttemptId: null,
    ...(params.runPlanId ? { runPlanId: params.runPlanId } : {}),
    grantId: `grant-${params.executionAttemptId}`,
    ownerEpoch: 'owner-epoch-1',
    grantedAt: now,
    executionAttemptId: params.executionAttemptId,
  }
}

async function spawnWorker(params: {
  identity: string
  sigtermMarker?: string
}): Promise<ChildProcess> {
  const signalHandler = params.sigtermMarker
    ? `process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(params.sigtermMarker)}, 'received'))`
    : ''
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const fs=require('node:fs');${signalHandler};setInterval(()=>{},1000)`,
      '--',
      `${PROCESS_IDENTITY_ARGUMENT}${params.identity}`,
    ],
    { detached: true, stdio: 'ignore' },
  )
  await once(child, 'spawn')
  return child
}

async function spawnOrphanedWorkerGroup(markerPath: string): Promise<ChildProcess> {
  const leader = spawn(
    process.execPath,
    [
      '-e',
      [
        "const {spawn}=require('node:child_process')",
        "const fs=require('node:fs')",
        "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
        'child.unref()',
        `fs.writeFileSync(${JSON.stringify(markerPath)}, String(child.pid))`,
      ].join(';'),
    ],
    { detached: true, stdio: 'ignore' },
  )
  await once(leader, 'spawn')
  const deadline = Date.now() + 2_000
  while (!fs.existsSync(markerPath) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(fs.existsSync(markerPath), true)
  if (leader.exitCode === null) await once(leader, 'exit')
  return leader
}

async function attachRunningTask(params: {
  store: FileSystemSessionStore
  sessionId: string
  child: ChildProcess
  identity: string
}) {
  assert.ok(params.child.pid)
  const task = await params.store.createTaskRecord(params.sessionId, {
    workflowId: 'wf-1',
    brief: 'Run the process lifecycle integration test.',
  })
  assert.ok(task)
  const running = await params.store.compareAndSetTaskRecord(
    params.sessionId,
    task.id,
    ['queued'],
    {
      status: 'running',
      pid: params.child.pid,
      processGroupId: params.child.pid,
      processIdentity: params.identity,
      executionAttemptId: params.identity,
      executionAttemptNumber: 1,
      ...await currentAttemptScope(task, 1),
      executionKind: 'initial',
    },
  )
  assert.equal(running?.task.status, 'running')
  assert.equal(isTaskProcessIdentityValid(running!.task), true)
  return running!.task
}

function forceCleanup(child: ChildProcess): void {
  if (!child.pid) return
  const target = process.platform === 'win32' ? child.pid : -child.pid
  if (!defaultIsProcessAlive(target)) return
  try {
    process.kill(target, 'SIGKILL')
  } catch {
    // The worker may have exited between the liveness check and cleanup.
  }
}

async function waitForProcessStop(target: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (defaultIsProcessAlive(target) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(
    defaultIsProcessAlive(target),
    false,
    `Process target ${target} was still alive after ${timeoutMs}ms`,
  )
}

async function waitForTerminalTask(
  store: FileSystemSessionStore,
  sessionId: string,
  taskId: string,
  timeoutMs = 5_000,
): Promise<SessionTask> {
  const deadline = Date.now() + timeoutMs
  let task = await store.getTaskRecord(sessionId, taskId)
  while (
    task &&
    task.status !== 'done' &&
    task.status !== 'failed' &&
    task.status !== 'blocked' &&
    task.status !== 'cancelled' &&
    Date.now() < deadline
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    task = await store.getTaskRecord(sessionId, taskId)
  }
  if (!task) throw new Error(`Task ${taskId} disappeared before reaching a terminal state`)
  if (task.pid) {
    const target = process.platform === 'win32'
      ? task.pid
      : -(task.processGroupId ?? task.pid)
    await waitForProcessStop(target, timeoutMs)
  }
  return task
}

test('task creation publishes its lifecycle lock record before commit and removes it after release', async () => {
  const workspacePath = makeWorkspace()
  const store = new FileSystemSessionStore(workspacePath)
  try {
    const session = await store.createSession({ title: 'Lifecycle lock record' })
    const lockPath = path.join(
      workspacePath,
      'sessions',
      '.locks',
      `${session.id}.lock`,
    )
    let observedLock = false

    const task = await store.createTaskRecord(
      session.id,
      {
        workflowId: 'wf-lock-record',
        brief: 'Observe the real lifecycle lock before durable commit.',
      },
      {
        beforeCommit: async () => {
          const lockRecord = JSON.parse(
            await fs.promises.readFile(lockPath, 'utf8'),
          ) as {
            pid?: unknown
            nonce?: unknown
            createdAt?: unknown
          }

          assert.equal(lockRecord.pid, process.pid)
          assert.equal(
            typeof lockRecord.nonce === 'string' && lockRecord.nonce.length > 0,
            true,
          )
          assert.equal(
            typeof lockRecord.createdAt === 'string'
              && Number.isFinite(Date.parse(lockRecord.createdAt)),
            true,
          )
          observedLock = true
        },
      },
    )

    assert.ok(task)
    assert.equal(observedLock, true)
    assert.equal(fs.existsSync(lockPath), false)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('cancellation is persisted and fenced before signalling a real non-cooperative worker', async () => {
  const workspacePath = makeWorkspace()
  const markerPath = path.join(workspacePath, 'sigterm-received')
  const identity = `cancel-${Date.now()}`
  const child = await spawnWorker({ identity, sigtermMarker: markerPath })
  try {
    const store = new FileSystemSessionStore(workspacePath, {
      instanceId: 'launching-api',
    })
    const session = await store.createSession({ title: 'Real cancellation' })
    await store.saveRunPlan(session.id, readyPlan())
    const runningTask = await attachRunningTask({ store, sessionId: session.id, child, identity })
    const admitted = await store.compareAndSetTaskRecord(
      session.id,
      runningTask.id,
      ['running'],
      { admission: grantedAdmission({ executionAttemptId: identity }) },
      { expectedExecutionAttemptId: identity },
    )
    assert.equal(admitted?.updated, true)
    const task = admitted!.task

    const signalObservations: Array<{
      signal: NodeJS.Signals
      status: SessionTask['status']
      executionAttemptId?: string
      hasAdmission: boolean
    }> = []
    const cancelled = await cancelSessionTask({
      sessionId: session.id,
      taskId: task.id,
      sessionStore: store,
      killProcess(pid, signal) {
        const persisted = JSON.parse(
          fs.readFileSync(
            path.join(store.taskDir(session.id, task.id), 'task.json'),
            'utf8',
          ),
        ) as SessionTask
        signalObservations.push({
          signal,
          status: persisted.status,
          ...whenDefined(persisted.executionAttemptId, (executionAttemptId) => ({ executionAttemptId: executionAttemptId })),
          hasAdmission: persisted.admission !== undefined,
        })
        process.kill(pid, signal)
      },
      gracefulTimeoutMs: 150,
      forceTimeoutMs: 1_000,
    })

    assert.equal(cancelled?.status, 'cancelled')
    assert.deepEqual(signalObservations, [
      {
        signal: 'SIGTERM',
        status: 'cancelled',
        executionAttemptId: identity,
        hasAdmission: true,
      },
      {
        signal: 'SIGKILL',
        status: 'cancelled',
        executionAttemptId: identity,
        hasAdmission: true,
      },
    ])
    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'received')
    assert.equal(defaultIsProcessAlive(process.platform === 'win32' ? child.pid! : -child.pid!), false)
    assert.equal(
      (await store.getTaskRecord(session.id, task.id))?.admission,
      undefined,
    )
    assert.equal((await store.getRunPlan(session.id))?.status, 'cancelled')

    const lateCompletion = await store.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['queued', 'running'],
      { status: 'done' },
      { expectedExecutionAttemptId: identity },
    )
    assert.equal(lateCompletion?.updated, false)
    assert.equal(lateCompletion?.task.status, 'cancelled')
  } finally {
    forceCleanup(child)
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('stale execution attempt cannot commit after a newer attempt takes ownership', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath, {
      instanceId: 'attempt-fencing-api',
    })
    const session = await store.createSession({ title: 'Attempt fencing' })
    const task = await store.createTaskRecord(session.id, {
      workflowId: 'wf-1',
      brief: 'Fence stale execution attempts.',
    })
    assert.ok(task)

    const firstAttempt = await store.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['queued'],
      {
        status: 'interrupted',
        executionAttemptId: 'attempt-1',
        executionAttemptNumber: 1,
        executionKind: 'initial',
      },
    )
    assert.equal(firstAttempt?.updated, true)

    const secondAttempt = await store.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['interrupted'],
      {
        status: 'running',
        executionAttemptId: 'attempt-2',
        executionAttemptNumber: 2,
        executionKind: 'recovery',
      },
      { expectedExecutionAttemptId: 'attempt-1' },
    )
    assert.equal(secondAttempt?.updated, true)

    const staleCompletion = await store.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['running'],
      { status: 'done' },
      { expectedExecutionAttemptId: 'attempt-1' },
    )
    assert.equal(staleCompletion?.updated, false)
    assert.equal(staleCompletion?.task.status, 'running')
    assert.equal(staleCompletion?.task.executionAttemptId, 'attempt-2')

    const currentCompletion = await store.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['running'],
      { status: 'done' },
      { expectedExecutionAttemptId: 'attempt-2' },
    )
    assert.equal(currentCompletion?.updated, true)
    assert.equal(currentCompletion?.task.status, 'done')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('concurrent recovery requests rotate the attempt exactly once', async () => {
  const workspacePath = makeWorkspace()
  const previousDryRun = process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN
  const previousDelay = process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS
  process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN = '1'
  process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS = '150'
  try {
    const store = new FileSystemSessionStore(workspacePath, {
      instanceId: 'recovery-claim-api',
    })
    const session = await store.createSession({ title: 'Recovery claim race' })
    const task = await store.createTaskRecord(session.id, {
      workflowId: 'recovery-claim-dry-run',
      brief: 'Only one replacement worker may claim this task.',
    })
    assert.ok(task)
    const interrupted = await store.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['queued'],
      {
        status: 'interrupted',
        processIdentity: 'initial-attempt',
        executionAttemptId: 'initial-attempt',
        executionAttemptNumber: 1,
        executionKind: 'initial',
        recoveryCount: 0,
        interruptedAt: new Date().toISOString(),
      },
    )
    assert.equal(interrupted?.updated, true)

    const launcher = new SessionTaskRunnerLauncher(process.cwd())
    const recoveryParams = {
      sessionId: session.id,
      taskId: task.id,
      sessionStore: store,
      taskLauncher: launcher,
      repoRootPath: process.cwd(),
      workspacePath,
      startupTimeoutMs: 5_000,
    }
    const results = await Promise.all([
      resumeSessionTask(recoveryParams),
      resumeSessionTask(recoveryParams),
    ])

    assert.equal(results.filter((result) => result.ok).length, 1)
    assert.equal(results.filter((result) => !result.ok).length, 1)
    const rejected = results.find((result) => !result.ok)
    assert.ok(rejected && !rejected.ok)
    assert.equal(rejected.statusCode, 409)
    assert.equal(rejected.error, 'Task cannot be resumed')
    assert.match(rejected.detail, /expected interrupted|became queued before launch/i)

    const completed = await waitForTerminalTask(store, session.id, task.id)
    assert.equal(completed.status, 'done')
    assert.equal(completed.executionAttemptNumber, 2)
    assert.equal(completed.executionKind, 'recovery')
    assert.equal(completed.recoveryCount, 1)
    assert.ok(completed.lastRecoveryAt)
    assert.notEqual(completed.executionAttemptId, 'initial-attempt')
    assert.equal(completed.executionAttemptId, completed.processIdentity)
  } finally {
    if (previousDryRun === undefined) {
      delete process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN
    } else {
      process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN = previousDryRun
    }
    if (previousDelay === undefined) {
      delete process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS
    } else {
      process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS = previousDelay
    }
    fs.rmSync(workspacePath, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    })
  }
})

test('a real granted worker preserves recovery state until startup and releases admission at terminal', async () => {
  const workspacePath = makeWorkspace()
  const previousDryRun = process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN
  const previousDelay = process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS
  process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN = '1'
  process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS = '300'
  let processTarget: number | undefined
  try {
    const store = new FileSystemSessionStore(workspacePath, {
      instanceId: 'admission-lifecycle-api',
    })
    const session = await store.createSession({ title: 'Granted admission lifecycle' })
    const plan = readyPlan()
    await store.saveRunPlan(session.id, plan)
    const task = await store.createTaskRecord(session.id, {
      workflowId: 'wf-1',
      brief: 'Exercise the real granted worker lifecycle.',
    })
    assert.ok(task)
    assert.equal(await store.saveRunPlan(session.id, markRunPlanQueued(plan, task.id)), true)

    const executionAttemptId = `granted-attempt-${Date.now()}`
    const admitted = await store.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['queued'],
      {
        status: 'queued',
        admission: grantedAdmission({
          executionAttemptId,
          executionKind: 'recovery',
          runPlanId: plan.id,
        }),
        processIdentity: executionAttemptId,
        executionAttemptId,
        executionAttemptNumber: 2,
        ...await currentAttemptScope(task, 2),
        executionKind: 'recovery',
        attemptStartedAt: new Date().toISOString(),
        recoveryCount: 1,
        recoveryDisposition: 'automatic',
        recoveryReason: 'Restart recovery is pending worker acknowledgement.',
        runPlanId: plan.id,
      },
      { expectedExecutionAttemptId: null },
    )
    assert.equal(admitted?.updated, true)

    const launchPromise = launchReservedTaskExecutionAttempt({
      sessionId: session.id,
      sessionStore: store,
      taskLauncher: new SessionTaskRunnerLauncher(process.cwd()),
      repoRootPath: process.cwd(),
      workspacePath,
      task: admitted!.task,
      warnings: [],
      startupTimeoutMs: 5_000,
    })

    const attachDeadline = Date.now() + 2_000
    let attached = await store.getTaskRecord(session.id, task.id)
    while (!attached?.pid && Date.now() < attachDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
      attached = await store.getTaskRecord(session.id, task.id)
    }
    assert.ok(attached?.pid)
    processTarget = process.platform === 'win32'
      ? attached.pid
      : -(attached.processGroupId ?? attached.pid)
    assert.equal(attached.workerStartedAt, undefined)
    assert.equal(attached.recoveryDisposition, 'automatic')
    assert.equal(attached.admission?.phase, 'granted')
    assert.equal(
      attached.admission?.phase === 'granted' ? attached.admission.grantId : undefined,
      `grant-${executionAttemptId}`,
    )

    const launched = await launchPromise
    assert.equal(launched.ok, true)
    const terminal = await waitForTerminalTask(store, session.id, task.id)
    assert.equal(terminal.status, 'done')
    assert.equal(terminal.admission, undefined)
    assert.equal(terminal.recoveryDisposition, undefined)
    assert.equal(terminal.recoveryReason, undefined)
    assert.ok(terminal.workerStartedAt)
    assert.equal((await store.getRunPlan(session.id))?.status, 'completed')
  } finally {
    if (processTarget !== undefined && defaultIsProcessAlive(processTarget)) {
      process.kill(processTarget, 'SIGKILL')
    }
    if (previousDryRun === undefined) {
      delete process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN
    } else {
      process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN = previousDryRun
    }
    if (previousDelay === undefined) {
      delete process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS
    } else {
      process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS = previousDelay
    }
    fs.rmSync(workspacePath, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    })
  }
})

test('a stale grant cannot attach its real worker after admission ownership rotates', async () => {
  const workspacePath = makeWorkspace()
  let staleProcessTarget: number | undefined
  try {
    const store = new FileSystemSessionStore(workspacePath, {
      instanceId: 'rotating-admission-api',
    })
    const session = await store.createSession({ title: 'Rotating admission ownership' })
    const task = await store.createTaskRecord(session.id, {
      workflowId: 'wf-1',
      brief: 'A stale grant must not attach its worker.',
    })
    assert.ok(task)
    const staleAttemptId = `stale-grant-${Date.now()}`
    const staleAdmission = grantedAdmission({ executionAttemptId: staleAttemptId })
    const admitted = await store.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['queued'],
      {
        admission: staleAdmission,
        processIdentity: staleAttemptId,
        executionAttemptId: staleAttemptId,
        executionAttemptNumber: 1,
        executionKind: 'initial',
        attemptStartedAt: new Date().toISOString(),
      },
      { expectedExecutionAttemptId: null },
    )
    assert.equal(admitted?.updated, true)

    const replacementAttemptId = `replacement-grant-${Date.now()}`
    const replacementAdmission = grantedAdmission({
      executionAttemptId: replacementAttemptId,
    })
    const delegate = new SessionTaskRunnerLauncher(process.cwd())
    const rotatingLauncher: RunLauncher = {
      async startRun(request) {
        const launched = await delegate.startRun(request)
        staleProcessTarget = process.platform === 'win32'
          ? launched.pid
          : -(launched.processGroupId ?? launched.pid)
        const rotated = await store.compareAndSetTaskRecord(
          session.id,
          task.id,
          ['queued'],
          {
            admission: replacementAdmission,
            processIdentity: replacementAttemptId,
            executionAttemptId: replacementAttemptId,
            executionAttemptNumber: 2,
            attemptStartedAt: new Date().toISOString(),
          },
          {
            expectedExecutionAttemptId: staleAttemptId,
            expectedAdmissionRequestId: staleAdmission.requestId,
            expectedAdmissionPhase: 'granted',
            expectedAdmissionGrantId: staleAdmission.grantId,
            expectedAdmissionOwnerEpoch: staleAdmission.ownerEpoch,
          },
        )
        assert.equal(rotated?.updated, true)
        return launched
      },
    }

    const result = await launchReservedTaskExecutionAttempt({
      sessionId: session.id,
      sessionStore: store,
      taskLauncher: rotatingLauncher,
      repoRootPath: process.cwd(),
      workspacePath,
      task: admitted!.task,
      warnings: [],
      startupTimeoutMs: 2_000,
    })

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.statusCode, 502)
    assert.equal(result.error, 'Task launch lost ownership')
    assert.ok(staleProcessTarget !== undefined)
    await waitForProcessStop(staleProcessTarget)
    const current = await store.getTaskRecord(session.id, task.id)
    assert.equal(current?.status, 'queued')
    assert.equal(current?.pid, undefined)
    assert.equal(current?.executionAttemptId, replacementAttemptId)
    assert.equal(current?.admission?.requestId, replacementAdmission.requestId)
  } finally {
    if (staleProcessTarget !== undefined && defaultIsProcessAlive(staleProcessTarget)) {
      process.kill(staleProcessTarget, 'SIGKILL')
    }
    fs.rmSync(workspacePath, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    })
  }
})

test('a restarted API keeps an identified live worker manageable', async () => {
  const workspacePath = makeWorkspace()
  const identity = `restart-${Date.now()}`
  const child = await spawnWorker({ identity })
  try {
    const original = new FileSystemSessionStore(workspacePath, {
      instanceId: 'old-api',
    })
    const session = await original.createSession({ title: 'Restart recovery' })
    await original.saveRunPlan(session.id, readyPlan())
    const task = await attachRunningTask({
      store: original,
      sessionId: session.id,
      child,
      identity,
    })

    const restarted = new FileSystemSessionStore(workspacePath, {
      instanceId: 'new-api',
    })
    const reconciled = await restarted.listTaskRecords(session.id)
    assert.equal(reconciled.find((record) => record.id === task.id)?.status, 'running')

    const cancelled = await cancelSessionTask({
      sessionId: session.id,
      taskId: task.id,
      sessionStore: restarted,
      gracefulTimeoutMs: 500,
      forceTimeoutMs: 1_000,
    })
    assert.equal(cancelled?.status, 'cancelled')
    assert.equal(defaultIsProcessAlive(process.platform === 'win32' ? child.pid! : -child.pid!), false)
  } finally {
    forceCleanup(child)
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('restart reconciliation fences a live worker bound to an obsolete provider broker', async () => {
  const workspacePath = makeWorkspace()
  const identity = `broker-restart-${Date.now()}`
  const child = await spawnWorker({ identity })
  try {
    const original = new FileSystemSessionStore(workspacePath, {
      instanceId: 'old-broker-api',
      configuredProviderBrokerUrl: 'http://127.0.0.1:41001/old-broker',
    })
    const session = await original.createSession({ title: 'Broker restart' })
    const task = await attachRunningTask({
      store: original,
      sessionId: session.id,
      child,
      identity,
    })
    await original.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['running'],
      {
        ...whenDefined(configuredProviderBrokerIdentity(
          'http://127.0.0.1:41001/old-broker',
        ), (configuredProviderBrokerIdentity) => ({ configuredProviderBrokerIdentity: configuredProviderBrokerIdentity })),
      },
      { expectedExecutionAttemptId: identity },
    )

    const restarted = new FileSystemSessionStore(workspacePath, {
      instanceId: 'new-broker-api',
      configuredProviderBrokerUrl: 'http://127.0.0.1:41002/new-broker',
    })
    const reconciled = await restarted.listTaskRecords(session.id)
    const target = process.platform === 'win32' ? child.pid! : -child.pid!

    await waitForProcessStop(target)
    const failed = reconciled.find((record) => record.id === task.id)
    assert.equal(failed?.status, 'failed')
    assert.match(failed?.error ?? '', /obsolete configured-provider broker/i)
  } finally {
    forceCleanup(child)
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('restart reconciliation terminates orphaned descendants before recovery', {
  skip: process.platform === 'win32',
}, async () => {
  const workspacePath = makeWorkspace()
  const markerPath = path.join(workspacePath, 'orphan-child-pid')
  const leader = await spawnOrphanedWorkerGroup(markerPath)
  assert.ok(leader.pid)
  const processGroupTarget = -leader.pid
  try {
    assert.equal(defaultIsProcessAlive(leader.pid), false)
    assert.equal(defaultIsProcessAlive(processGroupTarget), true)

    const original = new FileSystemSessionStore(workspacePath, {
      instanceId: 'orphan-original-api',
    })
    const session = await original.createSession({ title: 'Orphan cleanup' })
    const task = await original.createTaskRecord(session.id, {
      workflowId: 'wf-1',
      brief: 'Clean up the inherited process group before retrying.',
    })
    assert.ok(task)
    const running = await original.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['queued'],
      {
        status: 'running',
        pid: leader.pid,
        processGroupId: leader.pid,
        processIdentity: 'dead-leader-attempt',
        executionAttemptId: 'dead-leader-attempt',
        executionAttemptNumber: 1,
        ...await currentAttemptScope(task, 1),
        executionKind: 'initial',
      },
    )
    assert.equal(running?.updated, true)

    const restarted = new FileSystemSessionStore(workspacePath, {
      instanceId: 'orphan-restarted-api',
      staleTaskGraceMs: 0,
    })
    const reconciled = await restarted.listTaskRecords(session.id)
    await waitForProcessStop(processGroupTarget)
    assert.equal(defaultIsProcessAlive(processGroupTarget), false)
    assert.equal(
      reconciled.find((candidate) => candidate.id === task.id)?.status,
      'failed',
    )
  } finally {
    if (defaultIsProcessAlive(processGroupTarget)) {
      process.kill(processGroupTarget, 'SIGKILL')
    }
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('same-owner reconciliation keeps a task whose live pid carries another process identity', async () => {
  const workspacePath = makeWorkspace()
  const child = await spawnWorker({ identity: `actual-worker-${Date.now()}` })
  try {
    const store = new FileSystemSessionStore(workspacePath, {
      instanceId: 'same-api-instance',
      staleTaskGraceMs: 0,
    })
    const session = await store.createSession({ title: 'PID reuse' })
    const task = await store.createTaskRecord(session.id, {
      workflowId: 'wf-1',
      brief: 'Do not trust a reused pid.',
    })
    assert.ok(task && child.pid)
    await store.compareAndSetTaskRecord(session.id, task.id, ['queued'], {
      status: 'running',
      pid: child.pid,
      processGroupId: child.pid,
      processIdentity: 'different-worker-identity',
    })

    const reconciled = await store.listTaskRecords(session.id)
    const kept = reconciled.find((record) => record.id === task.id)
    const target = process.platform === 'win32' ? child.pid : -child.pid

    // A live process the owner cannot verify may still be its worker, and a
    // reused pid looks the same, so only an exit ends the task. It stays
    // running, keeps its process fields and records no error.
    assert.deepEqual(
      {
        status: kept?.status,
        pid: kept?.pid,
        processGroupId: kept?.processGroupId,
        processIdentity: kept?.processIdentity,
        error: kept?.error,
      },
      {
        status: 'running',
        pid: child.pid,
        processGroupId: child.pid,
        processIdentity: 'different-worker-identity',
        error: undefined,
      },
    )
    assert.equal(defaultIsProcessAlive(target), true)
  } finally {
    forceCleanup(child)
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('restart recovery finds and terminates a real worker spawned before pid persistence', async () => {
  const workspacePath = makeWorkspace()
  const identity = `pre-cas-crash-${Date.now()}`
  let child: ChildProcess | null = null
  try {
    const original = new FileSystemSessionStore(workspacePath, {
      instanceId: 'api-before-spawn-crash',
    })
    const session = await original.createSession({ title: 'Pre-CAS crash' })
    await original.saveRunPlan(session.id, readyPlan())
    const queued = await original.createTaskRecord(session.id, {
      workflowId: 'wf-1',
      brief: 'The API exits after spawn but before persisting the pid.',
    })
    assert.ok(queued)
    const identified = await original.compareAndSetTaskRecord(
      session.id,
      queued.id,
      ['queued'],
      {
        processIdentity: identity,
        executionAttemptId: identity,
        executionAttemptNumber: 1,
        ...await currentAttemptScope(queued, 1),
        executionKind: 'initial',
      },
    )
    assert.equal(identified?.updated, true)
    assert.equal(identified?.task.pid, undefined)
    child = await spawnWorker({ identity })
    assert.ok(findTaskProcessByIdentity(identity))

    const restarted = new FileSystemSessionStore(workspacePath, {
      instanceId: 'api-after-spawn-crash',
    })
    const tasks = await restarted.listTaskRecords(session.id)
    const interrupted = tasks.find((task) => task.id === queued.id)
    const target = process.platform === 'win32' ? child.pid! : -child.pid!

    await waitForProcessStop(target)
    assert.equal(defaultIsProcessAlive(target), false)
    assert.equal(interrupted?.status, 'interrupted')
    assert.equal(interrupted?.pid, undefined)
    assert.equal(interrupted?.processGroupId, undefined)
    assert.equal(interrupted?.recoveryDisposition, 'automatic')
    assert.match(
      interrupted?.recoveryReason ?? '',
      /recovered worker was terminated|before the workflow journal was initialized/i,
    )
    assert.equal((await restarted.getRunPlan(session.id))?.status, 'ready')
  } finally {
    if (child) forceCleanup(child)
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('real managed worker can acknowledge startup after the previous two-second window', async () => {
  const workspacePath = makeWorkspace()
  const previousDryRun = process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN
  const previousDelay = process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS
  process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN = '1'
  process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS = '2250'
  try {
    const sessionStore = new FileSystemSessionStore(workspacePath)
    const session = await sessionStore.createSession({ title: 'Cold startup' })
    const startedAt = Date.now()
    const launched = await launchSessionTask({
      sessionId: session.id,
      sessionStore,
      taskLauncher: new SessionTaskRunnerLauncher(process.cwd()),
      repoRootPath: process.cwd(),
      workspacePath,
      workflowId: 'dry-run-cold-start',
      briefMarkdown: '# Task Brief\n\nWait for a cold managed worker.\n',
    })
    const elapsedMs = Date.now() - startedAt

    assert.equal(launched.ok, true)
    if (!launched.ok) return
    assert.ok(launched.task.workerStartedAt)
    assert.ok(
      launched.task.status === 'running' || launched.task.status === 'done',
      `unexpected acknowledged task status: ${launched.task.status}`,
    )
    const completed = await waitForTerminalTask(
      sessionStore,
      session.id,
      launched.task.id,
    )
    assert.equal(completed.status, 'done')
    assert.ok(elapsedMs >= 2_200, `worker acknowledged too early: ${elapsedMs}ms`)
    assert.ok(elapsedMs < 10_000, `worker startup exceeded the default timeout: ${elapsedMs}ms`)
  } finally {
    if (previousDryRun === undefined) {
      delete process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN
    } else {
      process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN = previousDryRun
    }
    if (previousDelay === undefined) {
      delete process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS
    } else {
      process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS = previousDelay
    }
    fs.rmSync(workspacePath, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    })
  }
})

test('real session task runner records an unknown workflow as failed after startup', async () => {
  const workspacePath = makeWorkspace()
  try {
    const sessionStore = new FileSystemSessionStore(workspacePath)
    const session = await sessionStore.createSession({ title: 'Real startup failure' })
    const launched = await launchSessionTask({
      sessionId: session.id,
      sessionStore,
      taskLauncher: new SessionTaskRunnerLauncher(process.cwd()),
      repoRootPath: process.cwd(),
      workspacePath,
      workflowId: 'workflow-that-does-not-exist',
      briefMarkdown: '# Task Brief\n\nExercise real startup failure.\n',
    })

    if (!('task' in launched)) {
      assert.fail(`Task launch failed before a task record was available: ${launched.error}`)
    }
    const failed = await waitForTerminalTask(
      sessionStore,
      session.id,
      launched.task.id,
    )
    assert.equal(failed.status, 'failed')
    assert.match(failed.error ?? '', /Unknown workflow/)
    if (failed.pid) {
      await waitForProcessStop(
        process.platform === 'win32'
          ? failed.pid
          : -(failed.processGroupId ?? failed.pid),
      )
    }
  } finally {
    fs.rmSync(workspacePath, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    })
  }
})

test('real session task runner uses the configured external workflow registry', async () => {
  const workspacePath = makeWorkspace()
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-workflow-registry-'))
  try {
    const registryPath = path.join(registryDir, 'registry.yaml')
    fs.writeFileSync(
      registryPath,
      [
        'external-only:',
        '  description: Exists only in the external test registry.',
        '  template_path: ./external-only.yaml',
        '',
      ].join('\n'),
    )
    fs.writeFileSync(
      path.join(registryDir, 'external-only.yaml'),
      [
        'workflow:',
        '  id: external-only',
        '  steps:',
        '    - id: execute',
        '      type: team',
        '      team: external-only-missing-team',
        '      input_artifact: incoming-brief.md',
        '      result_artifact: result.md',
        '  output:',
        '    from_step: execute',
        '    artifact: result.md',
        '',
      ].join('\n'),
    )

    const sessionStore = new FileSystemSessionStore(workspacePath)
    const session = await sessionStore.createSession({ title: 'External registry' })
    const launched = await launchSessionTask({
      sessionId: session.id,
      sessionStore,
      taskLauncher: new SessionTaskRunnerLauncher(process.cwd()),
      repoRootPath: process.cwd(),
      workspacePath,
      workflowsRegistryPath: registryPath,
      workflowId: 'external-only',
      briefMarkdown: '# Task Brief\n\nUse an external workflow registry.\n',
    })
    const terminalTask = 'task' in launched
      ? await waitForTerminalTask(
          sessionStore,
          session.id,
          launched.task.id,
        )
      : undefined

    if (!launched.ok) {
      assert.equal(launched.statusCode, 502)
      assert.equal('task' in launched ? launched.task.status : undefined, 'failed')
    }
    assert.equal(terminalTask?.status, 'failed')
    assert.match(terminalTask?.error ?? '', /external-only-missing-team/)
    assert.doesNotMatch(terminalTask?.error ?? '', /Unknown workflow: external-only/)
  } finally {
    fs.rmSync(workspacePath, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    })
    fs.rmSync(registryDir, { recursive: true, force: true })
  }
})
