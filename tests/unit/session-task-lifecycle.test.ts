import { whenDefined } from '../../core/optional-properties.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'

import type { RunPlan } from '../../contracts/run-plan.js'
import { buildArtifactMetadata, withArtifactFrontmatter } from '../../domains/runtime/artifacts.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { logRuntimeEvent } from '../../domains/runtime/logger.js'
import { cancelSessionTask } from '../../services/task-service.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import {
  createTaskTerminationController,
  posixProcessRowsContainLiveTarget,
} from '../../domains/sessions/task-process-supervisor.js'
import { currentAttemptScope } from '../support/current-attempt-scope.js'

test('task worker termination signals abort in-flight workflow work', () => {
  const processSignals = new EventEmitter()
  const termination = createTaskTerminationController(processSignals)

  processSignals.emit('SIGTERM')

  assert.equal(termination.signal.aborted, true)
  termination.dispose()
})

test('a zombie-only POSIX process group is not treated as live work', () => {
  assert.equal(posixProcessRowsContainLiveTarget([
    { pid: 4101, processGroupId: 4101, state: 'Z' },
    { pid: 4102, processGroupId: 4101, state: 'Z+' },
  ], -4101), false)
  assert.equal(posixProcessRowsContainLiveTarget([
    { pid: 4101, processGroupId: 4101, state: 'Z' },
    { pid: 4102, processGroupId: 4101, state: 'S' },
  ], -4101), true)
})

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'session-task-lifecycle-'))
}

function readyPlan(): RunPlan {
  return {
    id: `plan-${Date.now()}`,
    goal: 'Write a lifecycle test memo.',
    summary: 'Ready to launch workflow wf-1.',
    status: 'ready',
    selectedWorkflow: {
      id: 'wf-1',
      rationale: 'Selected for lifecycle testing.',
      confidence: 'high',
    },
    requiredInputs: [],
    actions: [{
      id: 'launch-workflow',
      type: 'launch_workflow',
      status: 'ready',
      title: 'Launch wf-1',
      rationale: 'Ready.',
      workflowId: 'wf-1',
    }],
    warnings: [],
    createdAt: new Date().toISOString(),
  }
}

test('sessions identify workflow activity after a workflow task is created', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath)
    const session = await store.createSession({ title: 'Activity type' })
    assert.equal(session.activityType, 'chat')

    const task = await store.createTaskRecord(session.id, {
      workflowId: 'wf-1',
      brief: 'Write the memo.',
    })
    assert.ok(task)
    assert.equal((await store.getSession(session.id))?.activityType, 'workflow')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('durable task terminal transition notifies the exact assignment lifecycle owner', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath)
    const session = await store.createSession({ title: 'Terminal assignment release' })
    const task = await store.createTaskRecord(session.id, {
      workflowId: 'wf-1',
      brief: 'Exercise terminal assignment cleanup.',
    })
    assert.ok(task?.assignmentId)
    const notifications: Array<{
      sessionId: string
      runId: string
      assignmentId: string
      persistedStatus: string | undefined
    }> = []
    const unsubscribe = store.subscribeTaskTerminal(async (scope) => {
      notifications.push({
        ...scope,
        persistedStatus: (await store.getTaskRecord(session.id, task.id))?.status,
      })
    })

    await store.compareAndSetTaskRecord(session.id, task.id, ['queued'], {
      status: 'running',
    })
    await store.compareAndSetTaskRecord(session.id, task.id, ['running'], {
      status: 'failed',
      error: 'Expected terminal fixture.',
    })
    unsubscribe()

    assert.deepEqual(notifications, [{
      sessionId: session.id,
      runId: task.runId,
      assignmentId: task.assignmentId,
      persistedStatus: 'failed',
    }])
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a terminal task with no assignmentId still releases its run-scoped assignment', async () => {
  // AC18: `assignmentId` is optional on a task record, and production already
  // treats `runId` as the assignment identity when it is missing — the worker
  // is launched with `task.assignmentId ?? task.runId`
  // (`services/task-service.ts`), and recovery resolves the same way
  // (`domains/sessions/task-recovery-manager.ts`). So a journal is opened
  // under `runId` for exactly these tasks.
  //
  // Terminal finalization used to return before building the scope when
  // `assignmentId` was absent. The listener never fired, so the release never
  // ran: that journal stayed open, with its index in memory, for the lifetime
  // of the process. Nothing surfaced it — the task looked finished.
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath)
    const session = await store.createSession({ title: 'Run-scoped release' })
    const task = await store.createTaskRecord(session.id, {
      workflowId: 'wf-1',
      brief: 'Exercise release for a task with no assignment id.',
    })
    assert.ok(task)

    // Cleared through the ordinary patch path, the same way production clears
    // a field, rather than by writing a record behind the store's back.
    const cleared = await store.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['queued'],
      { status: 'running', assignmentId: undefined },
    )
    assert.ok(cleared, 'the fixture transition must be accepted')
    assert.equal(
      (await store.getTaskRecord(session.id, task.id))?.assignmentId,
      undefined,
      'the record under test must genuinely carry no assignment id',
    )

    const scopes: Array<{
      sessionId: string
      runId: string
      assignmentId: string
    }> = []
    const unsubscribe = store.subscribeTaskTerminal((scope) => {
      scopes.push({ ...scope })
    })
    await store.compareAndSetTaskRecord(session.id, task.id, ['running'], {
      status: 'failed',
      error: 'Expected terminal fixture.',
    })
    unsubscribe()

    assert.deepEqual(
      scopes,
      [{
        sessionId: session.id,
        runId: task.runId,
        assignmentId: task.runId,
      }],
      'the release must fire, and under the same identity the worker journal ' +
        'was opened with',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('session lock acquisition removes abandoned reclaim guards', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath)
    const session = await store.createSession({ title: 'Reclaim guard recovery' })
    const reclaimPath = path.join(
      workspacePath,
      'sessions',
      '.locks',
      `${session.id}.lock.reclaim`,
    )
    fs.mkdirSync(path.dirname(reclaimPath), { recursive: true })
    fs.mkdirSync(reclaimPath)
    const staleTime = new Date('2000-01-01T00:00:00.000Z')
    fs.utimesSync(reclaimPath, staleTime, staleTime)

    assert.equal((await store.updateSessionTitle(session.id, 'Recovered once'))?.title, 'Recovered once')
    assert.equal(fs.existsSync(reclaimPath), false)

    fs.mkdirSync(reclaimPath)
    fs.writeFileSync(
      path.join(reclaimPath, 'owner.json'),
      `${JSON.stringify({
        pid: 2_000_000_000,
        nonce: 'killed-session-reclaimer',
        createdAt: '2026-07-13T12:00:00.000Z',
      })}\n`,
    )
    assert.equal((await store.updateSessionTitle(session.id, 'Recovered twice'))?.title, 'Recovered twice')
    assert.equal(fs.existsSync(reclaimPath), false)

    fs.writeFileSync(
      reclaimPath,
      `${JSON.stringify({
        pid: 2_000_000_000,
        nonce: 'killed-atomic-session-reclaimer',
        createdAt: '2026-07-13T12:00:00.000Z',
      })}\n`,
    )
    assert.equal((await store.updateSessionTitle(session.id, 'Recovered thrice'))?.title, 'Recovered thrice')
    assert.equal(fs.existsSync(reclaimPath), false)
    assert.deepEqual(
      fs.readdirSync(path.dirname(reclaimPath))
        .filter((name) => name.includes('.reclaim') || name.includes('.orphan-')),
      [],
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('session lock leaves a live owner published until that owner releases it', async () => {
  const workspacePath = makeWorkspace()
  let lockPath: string | undefined
  let update: ReturnType<FileSystemSessionStore['updateSessionTitle']> | undefined
  try {
    const store = new FileSystemSessionStore(workspacePath)
    const session = await store.createSession({ title: 'Live lock owner' })
    lockPath = path.join(
      workspacePath,
      'sessions',
      '.locks',
      `${session.id}.lock`,
    )
    const owner = {
      pid: process.pid,
      nonce: 'live-session-owner',
      createdAt: new Date().toISOString(),
    }
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.writeFileSync(lockPath, `${JSON.stringify(owner)}\n`)

    let settled = false
    update = store.updateSessionTitle(session.id, 'Waited for live owner')
      .finally(() => {
        settled = true
      })
    await new Promise<void>((resolve) => setTimeout(resolve, 75))

    assert.equal(settled, false)
    assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), owner)

    fs.unlinkSync(lockPath)
    assert.equal((await update)?.title, 'Waited for live owner')
    assert.equal(fs.existsSync(lockPath), false)
  } finally {
    if (lockPath && fs.existsSync(lockPath)) fs.unlinkSync(lockPath)
    await update?.catch(() => undefined)
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('session lock reclaims a dead owner before mutating the session', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath)
    const session = await store.createSession({ title: 'Dead lock owner' })
    const lockPath = path.join(
      workspacePath,
      'sessions',
      '.locks',
      `${session.id}.lock`,
    )
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.writeFileSync(lockPath, `${JSON.stringify({
      pid: 2_000_000_000,
      nonce: 'dead-session-owner',
      createdAt: new Date().toISOString(),
    })}\n`)

    const updated = await store.updateSessionTitle(session.id, 'Reclaimed dead owner')

    assert.equal(updated?.title, 'Reclaimed dead owner')
    assert.equal(fs.existsSync(lockPath), false)
    assert.deepEqual(
      fs.readdirSync(path.dirname(lockPath))
        .filter((name) => name.startsWith(`${session.id}.lock`)),
      [],
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a paused unpublished session lock candidate cannot block an atomic winner', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath)
    const session = await store.createSession({ title: 'Paused publisher' })
    const lockPath = path.join(
      workspacePath,
      'sessions',
      '.locks',
      `${session.id}.lock`,
    )
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    const candidatePath = `${lockPath}.candidate-${process.pid}-paused-owner`
    fs.writeFileSync(candidatePath, `${JSON.stringify({
      pid: process.pid,
      nonce: 'paused-owner',
      createdAt: '2026-07-13T12:00:00.000Z',
    })}\n`)

    assert.equal((await store.updateSessionTitle(session.id, 'Atomic winner'))?.title, 'Atomic winner')
    assert.equal(fs.existsSync(lockPath), false)
    assert.equal(fs.existsSync(candidatePath), true)
    fs.unlinkSync(candidatePath)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('RunPlan revision and finalization are CAS-fenced and clear apply ownership', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath, {
      instanceId: 'finalize-owner',
    })
    const session = await store.createSession({ title: 'Finalize plan guard' })
    const plan = readyPlan()
    assert.equal(await store.saveRunPlan(session.id, plan), true)
    const revisedPlan = {
      ...readyPlan(),
      id: `${plan.id}-revised`,
      goal: 'Run the revised lifecycle test memo.',
    }
    const revision = await store.reviseRunPlan(session.id, plan.id, revisedPlan)
    assert.equal(revision?.revised, true)
    assert.equal(revision?.plan.id, revisedPlan.id)
    const staleRevision = await store.reviseRunPlan(
      session.id,
      plan.id,
      readyPlan(),
    )
    assert.equal(staleRevision?.revised, false)
    assert.equal(staleRevision?.plan.id, revisedPlan.id)

    const claim = await store.claimRunPlanForApply(session.id, revisedPlan.id)
    assert.equal(claim?.claimed, true)
    assert.ok(claim?.plan.applyClaimId)
    const duplicateClaim = await store.claimRunPlanForApply(
      session.id,
      revisedPlan.id,
    )
    assert.equal(duplicateClaim?.claimed, false)
    assert.equal(duplicateClaim?.plan.applyClaimId, claim.plan.applyClaimId)

    const queuedPlan: RunPlan = {
      ...claim.plan,
      status: 'queued',
      taskId: session.id,
      actions: claim.plan.actions.map((action) =>
        action.type === 'launch_workflow'
          ? { ...action, status: 'queued' }
          : action,
      ),
      applyClaimId: claim.plan.applyClaimId,
      ...whenDefined(claim.plan.applyClaimOwnerInstanceId, (applyClaimOwnerInstanceId) => ({ applyClaimOwnerInstanceId: applyClaimOwnerInstanceId })),
      ...whenDefined(claim.plan.applyClaimOwnerPid, (applyClaimOwnerPid) => ({ applyClaimOwnerPid: applyClaimOwnerPid })),
      ...whenDefined(claim.plan.applyClaimedAt, (applyClaimedAt) => ({ applyClaimedAt: applyClaimedAt })),
    }
    assert.equal(
      await store.finalizeRunPlanApply(
        session.id,
        revisedPlan.id,
        'stale-claim',
        queuedPlan,
      ),
      null,
    )
    assert.equal((await store.getRunPlan(session.id))?.status, 'applying')

    const finalized = await store.finalizeRunPlanApply(
      session.id,
      revisedPlan.id,
      claim.plan.applyClaimId,
      queuedPlan,
    )
    assert.equal(finalized?.status, 'queued')
    assert.equal(finalized?.taskId, session.id)
    assert.equal(finalized?.applyClaimId, undefined)
    assert.equal(finalized?.applyClaimOwnerInstanceId, undefined)
    assert.equal(finalized?.applyClaimOwnerPid, undefined)
    assert.equal(finalized?.applyClaimedAt, undefined)
    assert.deepEqual(await store.getRunPlan(session.id), finalized)
    assert.equal(
      await store.finalizeRunPlanApply(
        session.id,
        revisedPlan.id,
        claim.plan.applyClaimId,
        queuedPlan,
      ),
      null,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('RunPlan apply recovery respects a live lease and reclaims it after expiry', async () => {
  const workspacePath = makeWorkspace()
  let nowMs = Date.parse('2026-07-23T12:00:00.000Z')
  try {
    const owner = new FileSystemSessionStore(workspacePath, {
      instanceId: 'lease-owner',
      processId: 41_001,
      now: () => new Date(nowMs),
    })
    const session = await owner.createSession({ title: 'Apply lease recovery' })
    const plan = readyPlan()
    assert.equal(await owner.saveRunPlan(session.id, plan), true)
    const claim = await owner.claimRunPlanForApply(session.id, plan.id)
    assert.equal(claim?.claimed, true)

    const recovery = new FileSystemSessionStore(workspacePath, {
      instanceId: 'lease-recovery',
      processId: 41_002,
      now: () => new Date(nowMs),
      applyClaimLeaseMs: 1_000,
      isProcessAlive: () => true,
    })
    const stillOwned = await recovery.recoverRunPlanApply(session.id, plan.id)
    assert.equal(stillOwned?.status, 'applying')
    assert.equal(stillOwned?.applyClaimId, claim?.plan.applyClaimId)

    nowMs += 1_001
    const reclaimed = await recovery.recoverRunPlanApply(session.id, plan.id)
    assert.equal(reclaimed?.status, 'ready')
    assert.equal(reclaimed?.applyClaimId, undefined)
    assert.equal(reclaimed?.applyClaimOwnerInstanceId, undefined)
    assert.equal(reclaimed?.applyClaimOwnerPid, undefined)
    assert.equal(reclaimed?.applyClaimedAt, undefined)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('an applying RunPlan cannot be replaced or revised', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath, {
      instanceId: 'api-instance',
    })
    const session = await store.createSession({ title: 'Applying plan guard' })
    const initialPlan = readyPlan()
    assert.equal(await store.saveRunPlan(session.id, initialPlan), true)
    const claim = await store.claimRunPlanForApply(session.id, initialPlan.id)
    assert.equal(claim?.claimed, true)
    assert.equal(claim?.plan.status, 'applying')

    const replacement = {
      ...readyPlan(),
      id: `${initialPlan.id}-replacement`,
    }
    assert.equal(await store.saveRunPlan(session.id, replacement), false)
    const revision = await store.reviseRunPlan(
      session.id,
      initialPlan.id,
      replacement,
    )
    assert.equal(revision?.revised, false)
    assert.equal(revision?.plan.id, initialPlan.id)
    assert.equal(revision?.plan.status, 'applying')
    assert.equal((await store.getRunPlan(session.id))?.id, initialPlan.id)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('cancellation is persisted before graceful and forced process shutdown', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath, {
      instanceId: 'api-instance',
    })
    const session = await store.createSession({ title: 'Cancellation' })
    const initialPlan = readyPlan()
    await store.saveRunPlan(session.id, initialPlan)
    const task = await store.createTaskRecord(session.id, {
      workflowId: 'wf-1',
      brief: 'Write the memo.',
    })
    assert.ok(task)
    await store.compareAndSetTaskRecord(session.id, task.id, ['queued'], {
      status: 'running',
      pid: 43210,
      processGroupId: 43210,
      executionAttemptId: 'attempt-before-cancellation',
      executionAttemptNumber: 1,
      ...await currentAttemptScope(task, 1),
    })

    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = []
    let processAlive = true
    const cancelled = await cancelSessionTask({
      sessionId: session.id,
      taskId: task.id,
      sessionStore: store,
      killProcess(pid, signal) {
        const persisted = JSON.parse(
          fs.readFileSync(path.join(store.taskDir(session.id, task.id), 'task.json'), 'utf8'),
        ) as { status: string }
        assert.equal(persisted.status, 'cancelled')
        signals.push({ pid, signal })
        if (signal === 'SIGKILL') processAlive = false
      },
      isProcessAlive: () => processAlive,
      gracefulTimeoutMs: 0,
      forceTimeoutMs: 25,
    })

    assert.equal(cancelled?.status, 'cancelled')
    assert.deepEqual(signals, [
      {
        pid: process.platform === 'win32' ? 43210 : -43210,
        signal: 'SIGTERM',
      },
      {
        pid: process.platform === 'win32' ? 43210 : -43210,
        signal: 'SIGKILL',
      },
    ])
    assert.equal((await store.getRunPlan(session.id))?.status, 'cancelled')
    assert.equal(
      (await cancelSessionTask({
        sessionId: session.id,
        taskId: task.id,
        sessionStore: store,
      }))?.status,
      'cancelled',
    )
    assert.equal((await store.getSession(session.id))?.status, 'done')
    assert.equal(
      await store.saveRunPlan(session.id, { ...initialPlan, status: 'running' }),
      false,
    )
    assert.equal((await store.getRunPlan(session.id))?.status, 'cancelled')

    const lateCompletion = await store.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['queued', 'running'],
      { status: 'done' },
      { expectedExecutionAttemptId: 'attempt-before-cancellation' },
    )
    assert.equal(lateCompletion?.updated, false)
    assert.equal(lateCompletion?.task.status, 'cancelled')
    const lateFailure = await store.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['queued', 'running'],
      { status: 'failed', error: 'Runner exited after cancellation.' },
      { expectedExecutionAttemptId: 'attempt-before-cancellation' },
    )
    assert.equal(lateFailure?.updated, false)
    assert.equal(lateFailure?.task.status, 'cancelled')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('user cancellation remains authoritative when runtime shutdown logs incomplete later', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath, {
      instanceId: 'api-instance',
    })
    const session = await store.createSession({ title: 'Cancellation status projection' })
    const task = await store.createTaskRecord(session.id, {
      workflowId: 'wf-1',
      brief: 'Cancel while the runtime is shutting down.',
    })
    assert.ok(task?.assignmentPath)
    const assignmentPath = task.assignmentPath
    await store.compareAndSetTaskRecord(session.id, task.id, ['queued'], {
      status: 'running',
      pid: 43212,
      processGroupId: 43212,
      processIdentity: 'cancelled-runtime-worker',
      executionAttemptId: 'cancelled-runtime-worker',
      executionAttemptNumber: 1,
      ...await currentAttemptScope(task, 1),
    })

    let processAlive = true
    let shutdownLogged = false
    const cancelled = await cancelSessionTask({
      sessionId: session.id,
      taskId: task.id,
      sessionStore: store,
      killProcess(_target, signal) {
        if (!shutdownLogged) {
          shutdownLogged = true
          logRuntimeEvent(assignmentPath, {
            timestamp: '2099-01-01T00:00:00.000Z',
            event: 'run.incomplete',
            session_id: task.runId,
            root_session_id: task.runId,
            assignment_path: assignmentPath,
            team: 'workflow:wf-1',
          })
        }
        if (signal === 'SIGKILL') processAlive = false
      },
      isProcessAlive: () => processAlive,
      isProcessIdentityValid: () => true,
      gracefulTimeoutMs: 0,
      forceTimeoutMs: 25,
    })

    assert.equal(cancelled?.status, 'cancelled')
    assert.equal(shutdownLogged, true)
    assert.equal((await new FileSystemRunStore(workspacePath).getRun(task.runId))?.status, 'cancelled')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('cancellation reports an unverifiable live process and preserves its cleanup handle', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath, {
      instanceId: 'api-instance',
    })
    const session = await store.createSession({ title: 'Cancellation identity' })
    const task = await store.createTaskRecord(session.id, {
      workflowId: 'wf-1',
      brief: 'Keep the process handle after an identity mismatch.',
    })
    assert.ok(task)
    await store.compareAndSetTaskRecord(session.id, task.id, ['queued'], {
      status: 'running',
      pid: 43211,
      processGroupId: 43211,
      processIdentity: 'expected-worker-identity',
      executionAttemptId: 'expected-worker-identity',
      executionAttemptNumber: 1,
      admission: {
        version: 1,
        phase: 'granted',
        requestId: 'cancellation-request',
        order: '1',
        requestedAt: new Date().toISOString(),
        executionKind: 'initial',
        source: 'apply',
        expectedExecutionAttemptId: null,
        grantId: 'cancellation-grant',
        ownerEpoch: 'cancellation-owner',
        grantedAt: new Date().toISOString(),
        executionAttemptId: 'expected-worker-identity',
      },
    })

    const signals: NodeJS.Signals[] = []
    await assert.rejects(
      cancelSessionTask({
        sessionId: session.id,
        taskId: task.id,
        sessionStore: store,
        killProcess(_target, signal) {
          signals.push(signal)
        },
        isProcessAlive: () => true,
        isProcessIdentityValid: () => false,
      }),
      /identity could not be verified; process cleanup remains pending/,
    )

    assert.equal(signals.length, 0)
    const persisted = await store.getTaskRecord(session.id, task.id)
    assert.equal(persisted?.status, 'cancelled')
    assert.equal(persisted?.pid, 43211)
    assert.equal(persisted?.processGroupId, 43211)
    assert.equal(persisted?.processIdentity, 'expected-worker-identity')
    assert.equal(persisted?.admission?.phase, 'granted')

    await assert.rejects(
      cancelSessionTask({
        sessionId: session.id,
        taskId: task.id,
        sessionStore: store,
        killProcess(_target, signal) {
          signals.push(signal)
        },
        isProcessAlive: () => true,
        isProcessIdentityValid: () => false,
      }),
      /identity could not be verified; process cleanup remains pending/,
    )
    assert.equal(signals.length, 0)
    assert.equal(
      (await store.getTaskRecord(session.id, task.id))?.pid,
      43211,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('cancellation converges an awaiting-input task without a live worker', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath, {
      instanceId: 'api-instance',
    })
    const session = await store.createSession({ title: 'Awaiting input cancellation' })
    const task = await store.createTaskRecord(session.id, {
      workflowId: 'wf-1',
      brief: 'Await feedback.',
    })
    assert.ok(task)
    const waiting = await store.compareAndSetTaskRecord(session.id, task.id, ['queued'], {
      status: 'awaiting_input',
      executionAttemptId: 'attempt-awaiting-input',
      processIdentity: 'attempt-awaiting-input',
      executionAttemptNumber: 1,
    }, { expectedExecutionAttemptId: null })
    assert.equal(waiting?.updated, true)

    const cancelled = await cancelSessionTask({
      sessionId: session.id,
      taskId: task.id,
      sessionStore: store,
    })
    assert.equal(cancelled?.status, 'cancelled')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('blocked is a real terminal task and RunPlan status', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath, {
      instanceId: 'api-instance',
    })
    const session = await store.createSession({ title: 'Blocked' })
    await store.saveRunPlan(session.id, readyPlan())
    const task = await store.createTaskRecord(session.id, {
      workflowId: 'wf-1',
      brief: 'Write the memo.',
    })
    assert.ok(task)
    await store.compareAndSetTaskRecord(session.id, task.id, ['queued'], {
      status: 'running',
    })
    const blocked = await store.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['running'],
      { status: 'blocked', error: 'Approval is required.' },
    )

    assert.equal(blocked?.task.status, 'blocked')
    const plan = await store.getRunPlan(session.id)
    assert.equal(plan?.status, 'blocked')
    assert.equal(plan?.actions[0]?.status, 'blocked')
    assert.equal(plan?.error, 'Approval is required.')
    assert.ok(plan?.completedAt)
    assert.equal((await store.getSession(session.id))?.status, 'done')
    await assert.rejects(
      cancelSessionTask({
        sessionId: session.id,
        taskId: task.id,
        sessionStore: store,
      }),
      /already blocked/i,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('successful task completion closes its RunPlan as completed', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath, {
      instanceId: 'api-instance',
    })
    const session = await store.createSession({ title: 'Completed' })
    await store.saveRunPlan(session.id, readyPlan())
    const task = await store.createTaskRecord(session.id, {
      workflowId: 'wf-1',
      brief: 'Complete the memo.',
    })
    assert.ok(task)
    await store.compareAndSetTaskRecord(session.id, task.id, ['queued'], {
      status: 'running',
    })
    await store.compareAndSetTaskRecord(session.id, task.id, ['running'], {
      status: 'done',
    })

    const plan = await store.getRunPlan(session.id)
    assert.equal(plan?.status, 'completed')
    assert.equal(plan?.actions[0]?.status, 'completed')
    assert.ok(plan?.completedAt)
    assert.equal((await store.getSession(session.id))?.status, 'done')
    await assert.rejects(
      cancelSessionTask({
        sessionId: session.id,
        taskId: task.id,
        sessionStore: store,
      }),
      /already done/i,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a fresh store publishes the winning terminal result candidate after a worker crash', async () => {
  const workspacePath = makeWorkspace()
  try {
    const originalStore = new FileSystemSessionStore(workspacePath, {
      instanceId: 'original-api',
    })
    const session = await originalStore.createSession({ title: 'Result repair' })
    const task = await originalStore.createTaskRecord(session.id, {
      workflowId: 'wf-1',
      brief: 'Complete the memo.',
    })
    assert.ok(task?.assignmentPath)
    const executionAttemptId = 'winning-attempt'
    const running = await originalStore.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['queued'],
      {
        status: 'running',
        executionAttemptId,
        executionAttemptNumber: 1,
      },
    )
    assert.equal(running?.updated, true)

    const resultPath = path.join(task.assignmentPath, 'workflow-wf-1-result.md')
    const candidatePath = path.join(
      task.assignmentPath,
      '.runtime',
      'task-results',
      `${executionAttemptId}.md`,
    )
    fs.mkdirSync(path.dirname(candidatePath), { recursive: true })
    const candidateContents = withArtifactFrontmatter(
      buildArtifactMetadata({
        filePath: resultPath,
        rootDir: task.assignmentPath,
        artifactType: 'result',
        artifactRole: 'final',
        sessionId: task.runId,
        rootSessionId: task.runId,
        team: 'workflow:wf-1',
        status: 'done',
        title: 'Workflow result from wf-1',
      }),
      '# Winning result',
    )
    fs.writeFileSync(candidatePath, candidateContents)

    // Reproduce the durable point immediately after the terminal task record
    // was committed but before the worker promoted its public wrapper.
    const taskRecordPath = path.join(
      originalStore.taskDir(session.id, task.id),
      'task.json',
    )
    const persisted = JSON.parse(fs.readFileSync(taskRecordPath, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(taskRecordPath, `${JSON.stringify({
      ...persisted,
      status: 'done',
      completedAt: new Date().toISOString(),
    }, null, 2)}\n`)

    const replacementStore = new FileSystemSessionStore(workspacePath, {
      instanceId: 'replacement-api',
    })
    await replacementStore.listTaskRecords(session.id)

    assert.equal(fs.readFileSync(resultPath, 'utf8'), candidateContents)
    assert.equal(fs.existsSync(candidatePath), false)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a session becomes done only after every active task is terminal', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath, {
      instanceId: 'api-instance',
    })
    const session = await store.createSession({ title: 'Multiple tasks' })
    const first = await store.createTaskRecord(session.id, {
      workflowId: 'wf-1',
      brief: 'First.',
    })
    const second = await store.createTaskRecord(session.id, {
      workflowId: 'wf-1',
      brief: 'Second.',
    })
    assert.ok(first && second)

    await store.compareAndSetTaskRecord(session.id, first.id, ['queued'], {
      status: 'failed',
      error: 'First failed.',
    })
    assert.equal((await store.getSession(session.id))?.status, 'active')

    await store.compareAndSetTaskRecord(session.id, second.id, ['queued'], {
      status: 'done',
    })
    assert.equal((await store.getSession(session.id))?.status, 'done')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('restart reconciliation safely reattaches an identified live task', async () => {
  const workspacePath = makeWorkspace()
  try {
    const original = new FileSystemSessionStore(workspacePath, {
      instanceId: 'old-api-instance',
    })
    const session = await original.createSession({ title: 'Restart' })
    await original.saveRunPlan(session.id, readyPlan())
    const running = await original.createTaskRecord(session.id, {
      workflowId: 'wf-1',
      brief: 'Running task.',
    })
    const queued = await original.createTaskRecord(session.id, {
      workflowId: 'wf-2',
      brief: 'Queued task.',
    })
    assert.ok(running && queued)
    await original.compareAndSetTaskRecord(session.id, running.id, ['queued'], {
      status: 'running',
      pid: process.pid,
      processGroupId: process.pid,
      processIdentity: 'persisted-worker-token',
    })

    let processProbeCount = 0
    let processAlive = true
    const restarted = new FileSystemSessionStore(workspacePath, {
      instanceId: 'new-api-instance',
      isProcessAlive() {
        processProbeCount += 1
        return processAlive
      },
      isProcessIdentityValid: (task) =>
        task.processIdentity === 'persisted-worker-token',
    })
    const tasks = await restarted.listTaskRecords(session.id)

    assert.deepEqual(tasks.map((task) => task.status), ['running', 'queued'])
    assert.ok(processProbeCount > 0)
    const processSignals: Array<{ pid: number; signal: NodeJS.Signals }> = []
    const cancelledAfterRestart = await cancelSessionTask({
      sessionId: session.id,
      taskId: running.id,
      sessionStore: restarted,
      killProcess(pid, signal) {
        processSignals.push({ pid, signal })
        processAlive = false
      },
      isProcessAlive: () => processAlive,
      isProcessIdentityValid: () => true,
    })
    assert.equal(cancelledAfterRestart?.status, 'cancelled')
    assert.deepEqual(processSignals, [{
      pid: process.platform === 'win32' ? process.pid : -process.pid,
      signal: 'SIGTERM',
    }])
    assert.equal((await restarted.getRunPlan(session.id))?.status, 'cancelled')
    assert.equal((await restarted.getSession(session.id))?.status, 'active')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('restart reconciliation preserves a never-attempted queued task for startup launch', async () => {
  const workspacePath = makeWorkspace()
  try {
    const original = new FileSystemSessionStore(workspacePath, {
      instanceId: 'old-api-instance',
    })
    const session = await original.createSession({ title: 'Queued crash window' })
    await original.saveRunPlan(session.id, readyPlan())
    const queued = await original.createTaskRecord(session.id, {
      workflowId: 'wf-1',
      brief: 'The service exits before starting this worker.',
    })
    assert.ok(queued)

    const restarted = new FileSystemSessionStore(workspacePath, {
      instanceId: 'new-api-instance',
    })
    const tasks = await restarted.listTaskRecords(session.id)
    const preserved = tasks.find((task) => task.id === queued.id)

    assert.equal(preserved?.status, 'queued')
    assert.equal(preserved?.executionAttemptId, undefined)
    assert.equal(preserved?.error, undefined)
    assert.equal((await restarted.getRunPlan(session.id))?.taskId, queued.id)
    assert.equal((await restarted.getSession(session.id))?.status, 'active')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('dead pid reconciliation and concurrent terminal writes remain atomic', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath, {
      instanceId: 'api-instance',
      staleTaskGraceMs: 0,
      isProcessAlive: () => false,
    })
    const session = await store.createSession({ title: 'Dead process' })
    const dead = await store.createTaskRecord(session.id, {
      workflowId: 'wf-1',
      brief: 'Dead task.',
    })
    assert.ok(dead)
    await store.compareAndSetTaskRecord(session.id, dead.id, ['queued'], {
      status: 'running',
      pid: 987654,
    })
    assert.equal((await store.listTaskRecords(session.id))[0]?.status, 'failed')

    const concurrent = await store.createTaskRecord(session.id, {
      workflowId: 'wf-2',
      brief: 'Concurrent task.',
    })
    assert.ok(concurrent)
    const pausedCandidatePath = path.join(
      store.taskDir(session.id, concurrent.id),
      `.task.lock.candidate-${process.pid}-paused-concurrent-owner`,
    )
    fs.writeFileSync(pausedCandidatePath, `${JSON.stringify({
      pid: process.pid,
      nonce: 'paused-concurrent-owner',
      createdAt: '2026-07-13T12:00:00.000Z',
    })}\n`)
    const transitions = await Promise.all([
      store.compareAndSetTaskRecord(session.id, concurrent.id, ['queued'], {
        status: 'done',
      }),
      store.compareAndSetTaskRecord(session.id, concurrent.id, ['queued'], {
        status: 'cancelled',
      }),
    ])
    assert.equal(transitions.filter((result) => result?.updated).length, 1)
    assert.equal(fs.existsSync(pausedCandidatePath), true)
    fs.unlinkSync(pausedCandidatePath)

    const taskJson = fs.readFileSync(
      path.join(store.taskDir(session.id, concurrent.id), 'task.json'),
      'utf8',
    )
    const sessionJson = fs.readFileSync(
      path.join(workspacePath, 'sessions', session.id, 'session.json'),
      'utf8',
    )
    assert.doesNotThrow(() => JSON.parse(taskJson))
    assert.doesNotThrow(() => JSON.parse(sessionJson))
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
