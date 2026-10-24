import { whenDefined } from '../../core/optional-properties.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { startApiServer } from '../../server/api-server.js'
import {
  FileSystemRunStore,
  type RunStartRequest,
} from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import type { SessionTask } from '../../contracts/sessions.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { currentAttemptScope } from '../support/current-attempt-scope.js'
import {
  cancelSessionTask,
  recoverInterruptedSessionTasks,
} from '../../services/task-service.js'
import {
  FileSystemWorkflowStateStore,
  createWorkflowArtifactReference,
  hashWorkflowContent,
} from '../../workflows/workflow-state-store.js'
import { buildDurableWorkflowTerminalOutcome } from '../../workflows/results.js'
import type { WorkflowStepRecoveryPolicy } from '../../workflows/types.js'
import { getRunRuntimePaths } from '../../domains/runtime/runtime-paths.js'
import { readExecutionJournal } from '../../core/execution-journal.js'
import {
  createJournalBackedWorkflowRecorder,
  rebuildWorkflowStateProjection,
  WORKFLOW_STATE_STREAM_KIND,
  type WorkflowJournalRecorder,
} from '../../workflows/workflow-journal.js'
import { WorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'

const DEAD_PROCESS_ID = 2_000_000_000

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'task-recovery-contract-'))
}

async function waitForValue<T>(params: {
  read: () => T | Promise<T>
  accept: (value: T) => boolean
  description: string
  timeoutMs?: number
}): Promise<T> {
  const deadline = Date.now() + (params.timeoutMs ?? 5_000)
  let value = await params.read()
  while (!params.accept(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    value = await params.read()
  }
  assert.ok(params.accept(value), `Timed out waiting for ${params.description}`)
  return value
}

async function createTask(
  store: FileSystemSessionStore,
  sessionId: string,
  workflowId = 'recovery-workflow',
): Promise<SessionTask> {
  const task = await store.createTaskRecord(sessionId, {
    workflowId,
    brief: 'Continue the persisted research run.',
  })
  assert.ok(task)
  return task
}

async function persistTaskStatus(params: {
  store: FileSystemSessionStore
  sessionId: string
  task: SessionTask
  status: 'running' | 'interrupted'
  executionAttemptId: string
  recoveryDisposition?: 'automatic' | 'manual' | 'not_resumable'
  recoveryReason?: string
}): Promise<SessionTask> {
  const result = await params.store.compareAndSetTaskRecord(
    params.sessionId,
    params.task.id,
    ['queued'],
    {
      status: params.status,
      executionAttemptId: params.executionAttemptId,
      executionAttemptNumber: 1,
      ...await currentAttemptScope(params.task, 1),
      executionKind: 'initial',
      attemptStartedAt: new Date().toISOString(),
      recoveryCount: 0,
      ...(params.status === 'running'
        ? {
            pid: DEAD_PROCESS_ID,
            processGroupId: DEAD_PROCESS_ID,
            processIdentity: params.executionAttemptId,
            workerStartedAt: new Date().toISOString(),
          }
        : {
            interruptedAt: new Date().toISOString(),
            ...whenDefined(params.recoveryDisposition, (recoveryDisposition) => ({ recoveryDisposition: recoveryDisposition })),
            ...whenDefined(params.recoveryReason, (recoveryReason) => ({ recoveryReason: recoveryReason })),
          }),
    },
  )
  assert.equal(result?.updated, true)
  return result!.task
}

async function initializeRunningJournal(params: {
  task: SessionTask
  executionAttemptId: string
  recoveryPolicy: WorkflowStepRecoveryPolicy
  resultArtifacts?: string[]
  /** Attached when the assignment is journal-enrolled for the case under test. */
  journal?: WorkflowJournalRecorder
}): Promise<{
  store: FileSystemWorkflowStateStore
  childRunId: string
}> {
  assert.ok(params.task.assignmentPath)
  const childRunId = randomUUID()
  const store = new FileSystemWorkflowStateStore(
    params.task.assignmentPath,
    params.journal ? { journal: params.journal } : {},
  )
  await store.initialize({
    manifest: {
      taskId: params.task.id,
      sessionId: params.task.sessionId,
      rootRunId: params.task.runId,
      workflowId: params.task.workflowId,
      workflowDefinitionHash: hashWorkflowContent('recovery-workflow:v1'),
      briefHash: hashWorkflowContent(params.task.brief),
      teamDefinitionHashes: {
        researchers: hashWorkflowContent('researchers:v1'),
      },
      runtimeVersion: 'workflow-runtime-v1',
    },
    executionAttemptId: params.executionAttemptId,
    steps: [
      {
        stepId: 'research',
        stepIndex: 0,
        stepType: 'team',
        team: 'researchers',
        definitionHash: hashWorkflowContent('research-step:v1'),
        recoveryPolicy: params.recoveryPolicy,
        childRunId,
        inputArtifact: 'incoming-brief.md',
        resultArtifact: 'report.md',
        ...whenDefined(params.resultArtifacts, (resultArtifacts) => ({ resultArtifacts: resultArtifacts })),
        requestedResultType: 'artifact:report.md',
      },
    ],
  })
  const launching = await store.update({
    expectedRevision: 0,
    executionAttemptId: params.executionAttemptId,
    mutate(state) {
      state.currentStepId = 'research'
      state.steps[0]!.status = 'launching'
      state.steps[0]!.attemptCount = 1
      state.steps[0]!.startedAt = new Date().toISOString()
    },
  })
  await store.update({
    expectedRevision: launching.revision,
    executionAttemptId: params.executionAttemptId,
    mutate(state) {
      state.steps[0]!.status = 'running'
    },
  })
  return { store, childRunId }
}

async function initializeAwaitingHumanInputJournal(params: {
  task: SessionTask
  executionAttemptId: string
}): Promise<FileSystemWorkflowStateStore> {
  assert.ok(params.task.assignmentPath)
  const store = new FileSystemWorkflowStateStore(params.task.assignmentPath)
  const sourceChildRunId = randomUUID()
  await store.initialize({
    manifest: {
      taskId: params.task.id,
      sessionId: params.task.sessionId,
      rootRunId: params.task.runId,
      workflowId: params.task.workflowId,
      workflowDefinitionHash: hashWorkflowContent('waiting-workflow:v1'),
      briefHash: hashWorkflowContent(params.task.brief),
      teamDefinitionHashes: {
        researchers: hashWorkflowContent('researchers:v1'),
        writers: hashWorkflowContent('writers:v1'),
      },
      runtimeVersion: 'workflow-runtime-v1',
    },
    executionAttemptId: params.executionAttemptId,
    steps: [
      {
        stepId: 'research',
        stepIndex: 0,
        stepType: 'team',
        team: 'researchers',
        definitionHash: hashWorkflowContent('research-step:v1'),
        recoveryPolicy: 'safe_retry',
        childRunId: sourceChildRunId,
        inputArtifact: 'incoming-brief.md',
        resultArtifact: 'round-one.md',
        requestedResultType: 'artifact:round-one.md',
      },
      {
        stepId: 'human-feedback',
        stepIndex: 1,
        stepType: 'human-in-the-loop',
        definitionHash: hashWorkflowContent('human-feedback-step:v1'),
        recoveryPolicy: 'manual',
        inputArtifact: 'review/round-one.md',
        resultArtifact: 'feedback/round-one.json',
        requestedResultType: 'artifact:feedback/round-one.json',
      },
      {
        stepId: 'write',
        stepIndex: 2,
        stepType: 'team',
        team: 'writers',
        definitionHash: hashWorkflowContent('write-step:v1'),
        recoveryPolicy: 'safe_retry',
        inputArtifact: 'incoming-brief.md',
        resultArtifact: 'report.md',
        requestedResultType: 'artifact:report.md',
      },
    ],
  })
  await store.requestHumanInput({
    expectedRevision: 0,
    executionAttemptId: params.executionAttemptId,
    stepId: 'human-feedback',
    interactionId: randomUUID(),
    sourceArtifact: {
      childRunId: sourceChildRunId,
      relativePath: 'round-one.md',
      sha256: hashWorkflowContent('round one output'),
      byteLength: 'round one output'.length,
    },
    successorStepId: 'write',
    eligibleRecipients: [],
  })
  return store
}

function resolveChildAssignmentPath(
  workspacePath: string,
  task: SessionTask,
  childRunId: string,
): string {
  const location = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: task.sessionId,
    runId: task.runId,
    assignmentId: childRunId,
  })
  assert.ok(location, `Child assignment ${childRunId} must have a canonical session-run location`)
  return location.assignmentPath
}

/** The child's own run log, which is where a step's producing agent is named. */
function writeChildAgentRunLog(params: {
  childAssignmentPath: string
  childRunId: string
  agentName: string
  event: 'end' | 'fail'
}): void {
  fs.mkdirSync(path.join(params.childAssignmentPath, 'logs'), { recursive: true })
  fs.writeFileSync(
    path.join(params.childAssignmentPath, 'logs', 'agent-runs.jsonl'),
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event: params.event,
      session_id: params.childRunId,
      assignment_path: params.childAssignmentPath,
      team: 'researchers',
      agent_name: params.agentName,
      agent_type: 'agent',
    })}\n`,
  )
}

function freshDeadProcessReconciler(
  workspacePath: string,
): FileSystemSessionStore {
  return new FileSystemSessionStore(workspacePath, {
    instanceId: randomUUID(),
    isProcessAlive: () => false,
    isProcessIdentityValid: () => false,
    findProcessByIdentity: () => null,
    staleTaskGraceMs: 0,
  })
}

test('POST task resume preserves task/run identity and starts a new fenced attempt', async () => {
  const workspacePath = makeWorkspace()
  const launcherRequests: RunStartRequest[] = []
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Resume contract' })
  const previousAttemptId = randomUUID()
  const task = await createTask(sessionStore, session.id)
  await persistTaskStatus({
    store: sessionStore,
    sessionId: session.id,
    task,
    status: 'interrupted',
    executionAttemptId: previousAttemptId,
    recoveryDisposition: 'manual',
    recoveryReason: 'The interrupted step requires a user recovery decision.',
  })

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun(request) {
        return { launched: true as const, pid: 1, cwd: request.cwd }
      },
    },
    taskLauncher: {
      async startRun(request) {
        launcherRequests.push(request)
        return { launched: true as const, pid: 42, cwd: request.cwd }
      },
    },
    sessionStore,
    workspacePath,
    repoRootPath: process.cwd(),
  })

  try {
    const response = await fetch(
      `${server.url}/sessions/${session.id}/tasks/${task.id}/resume`,
      { method: 'POST' },
    )
    const resumed = (await response.json()) as SessionTask

    assert.equal(response.status, 202)
    assert.equal(resumed.id, task.id)
    assert.equal(resumed.runId, task.runId)
    assert.equal(resumed.sessionId, task.sessionId)
    assert.equal(resumed.status, 'interrupted')
    assert.equal(resumed.admission?.phase, 'pending')
    assert.equal(resumed.admission?.executionKind, 'recovery')
    assert.equal(resumed.executionAttemptId, previousAttemptId)
    await waitForValue({
      read: () => launcherRequests.length,
      accept: (count) => count === 1,
      description: 'the resumed task to reach the launcher',
    })
    const running = await waitForValue({
      read: () => sessionStore.getTaskRecord(session.id, task.id),
      accept: (value) => value?.status === 'running',
      description: 'the resumed task to become running',
    })
    assert.ok(running)
    assert.equal(running.executionKind, 'recovery')
    assert.equal(running.executionAttemptNumber, 2)
    assert.equal(running.recoveryCount, 1)
    assert.notEqual(running.executionAttemptId, previousAttemptId)
    assert.equal(
      launcherRequests[0]?.processIdentity,
      running.executionAttemptId,
    )
    assert.equal(
      launcherRequests[0]?.env?.TEAM_RUNTIME_EXECUTION_ATTEMPT_ID,
      running.executionAttemptId,
    )
    assert.equal(
      launcherRequests[0]?.env?.TEAM_RUNTIME_TASK_ID,
      task.id,
    )
    assert.equal(
      launcherRequests[0]?.env?.TEAM_RUNTIME_RUN_ID,
      task.runId,
    )
    assert.equal(launcherRequests[0]?.env?.TEAM_RUNTIME_RECOVERY, '1')

    const persisted = await sessionStore.getTaskRecord(session.id, task.id)
    assert.equal(persisted?.executionAttemptId, running.executionAttemptId)
    assert.equal(persisted?.runId, task.runId)
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('POST task resume rejects status conflicts and explicitly non-resumable tasks', async () => {
  const workspacePath = makeWorkspace()
  const launcherRequests: RunStartRequest[] = []
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Resume rejection' })

  const runningTask = await createTask(sessionStore, session.id)
  await persistTaskStatus({
    store: sessionStore,
    sessionId: session.id,
    task: runningTask,
    status: 'running',
    executionAttemptId: randomUUID(),
  })

  const nonResumableTask = await createTask(sessionStore, session.id)
  const nonResumableReason = 'The interrupted step is explicitly marked never retry.'
  await persistTaskStatus({
    store: sessionStore,
    sessionId: session.id,
    task: nonResumableTask,
    status: 'interrupted',
    executionAttemptId: randomUUID(),
    recoveryDisposition: 'not_resumable',
    recoveryReason: nonResumableReason,
  })

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun(request) {
        return { launched: true as const, pid: 1, cwd: request.cwd }
      },
    },
    taskLauncher: {
      async startRun(request) {
        launcherRequests.push(request)
        return { launched: true as const, pid: 42, cwd: request.cwd }
      },
    },
    sessionStore,
    workspacePath,
    repoRootPath: process.cwd(),
  })

  try {
    const conflictResponse = await fetch(
      `${server.url}/sessions/${session.id}/tasks/${runningTask.id}/resume`,
      { method: 'POST' },
    )
    const conflict = (await conflictResponse.json()) as {
      error: string
      detail: string
      task: SessionTask
    }
    assert.equal(conflictResponse.status, 409)
    assert.equal(conflict.error, 'Task cannot be resumed')
    assert.match(conflict.detail, /running, expected interrupted/)
    assert.equal(conflict.task.id, runningTask.id)
    assert.equal(conflict.task.status, 'running')

    const nonResumableResponse = await fetch(
      `${server.url}/sessions/${session.id}/tasks/${nonResumableTask.id}/resume`,
      { method: 'POST' },
    )
    const nonResumable = (await nonResumableResponse.json()) as {
      error: string
      detail: string
      task: SessionTask
    }
    assert.equal(nonResumableResponse.status, 409)
    assert.equal(nonResumable.error, 'Task cannot be resumed')
    assert.equal(nonResumable.detail, nonResumableReason)
    assert.equal(nonResumable.task.id, nonResumableTask.id)
    assert.equal(nonResumable.task.status, 'interrupted')
    assert.equal(launcherRequests.length, 0)
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a fresh session store reconciles dead running journals to automatic or manual interruption', async (t) => {
  for (const scenario of [
    {
      name: 'safe-retry journal',
      policy: 'safe_retry' as const,
      expectedDisposition: 'automatic' as const,
      reason: /safe retry/,
    },
    {
      name: 'manual-recovery journal',
      policy: 'manual' as const,
      expectedDisposition: 'manual' as const,
      reason: /user recovery decision/,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const workspacePath = makeWorkspace()
      try {
        const originalStore = new FileSystemSessionStore(workspacePath, {
          instanceId: randomUUID(),
        })
        const session = await originalStore.createSession({ title: scenario.name })
        const task = await createTask(originalStore, session.id)
        const executionAttemptId = randomUUID()
        await persistTaskStatus({
          store: originalStore,
          sessionId: session.id,
          task,
          status: 'running',
          executionAttemptId,
        })
        await initializeRunningJournal({
          task,
          executionAttemptId,
          recoveryPolicy: scenario.policy,
        })

        const replacementStore = freshDeadProcessReconciler(workspacePath)
        const reconciledTasks = await replacementStore.listTaskRecords(session.id)
        const reconciled = reconciledTasks.find((candidate) => candidate.id === task.id)

        assert.equal(reconciled?.status, 'interrupted')
        assert.equal(
          reconciled?.recoveryDisposition,
          scenario.expectedDisposition,
        )
        assert.match(reconciled?.recoveryReason ?? '', scenario.reason)
        assert.equal(reconciled?.executionAttemptId, executionAttemptId)
        assert.equal(reconciled?.pid, undefined)
        assert.equal(reconciled?.processGroupId, undefined)
        assert.ok(reconciled?.interruptedAt)

        const persisted = await new FileSystemSessionStore(
          workspacePath,
        ).getTaskRecord(session.id, task.id)
        assert.equal(persisted?.status, 'interrupted')
        assert.equal(
          persisted?.recoveryDisposition,
          scenario.expectedDisposition,
        )
      } finally {
        fs.rmSync(workspacePath, { recursive: true, force: true })
      }
    })
  }
})

test('API startup listens before automatically relaunching only safe persisted tasks', async () => {
  const workspacePath = makeWorkspace()
  const launcherRequests: RunStartRequest[] = []
  const originalInstanceId = randomUUID()
  const originalStore = new FileSystemSessionStore(workspacePath, {
    instanceId: originalInstanceId,
  })
  const session = await originalStore.createSession({
    title: 'Automatic startup recovery',
  })
  const scenarios = [
    { policy: 'safe_retry' as const, disposition: 'automatic' as const },
    { policy: 'manual' as const, disposition: 'manual' as const },
    { policy: 'never_retry' as const, disposition: 'not_resumable' as const },
  ]
  const persisted = [] as Array<{
    task: SessionTask
    executionAttemptId: string
    disposition: (typeof scenarios)[number]['disposition']
  }>
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined

  try {
    for (const scenario of scenarios) {
      const task = await createTask(
        originalStore,
        session.id,
        `startup-${scenario.policy}`,
      )
      const executionAttemptId = randomUUID()
      await persistTaskStatus({
        store: originalStore,
        sessionId: session.id,
        task,
        status: 'running',
        executionAttemptId,
      })
      await initializeRunningJournal({
        task,
        executionAttemptId,
        recoveryPolicy: scenario.policy,
      })
      persisted.push({
        task,
        executionAttemptId,
        disposition: scenario.disposition,
      })
    }

    const replacementStore = freshDeadProcessReconciler(workspacePath)
    let listeningHookCompleted = false
    server = await startApiServer({
      store: new FileSystemRunStore(workspacePath),
      launcher: {
        async startRun(request) {
          return { launched: true as const, pid: 1, cwd: request.cwd }
        },
      },
      taskLauncher: {
        async startRun(request) {
          assert.equal(listeningHookCompleted, true)
          launcherRequests.push(request)
          return { launched: true as const, pid: 42, cwd: request.cwd }
        },
      },
      sessionStore: replacementStore,
      recoverInterruptedTasks: true,
      onListening: async ({ url }) => {
        const response = await fetch(`${url}/health`)
        assert.equal(response.status, 200)
        listeningHookCompleted = true
      },
      workspacePath,
      repoRootPath: process.cwd(),
    })

    assert.equal(listeningHookCompleted, true)
    await waitForValue({
      read: () => launcherRequests.length,
      accept: (count) => count === 1,
      description: 'the automatic recovery to reach the launcher',
    })

    const safe = persisted[0]!
    const recovered = await waitForValue({
      read: () => replacementStore.getTaskRecord(session.id, safe.task.id),
      accept: (value) => value?.status === 'running',
      description: 'the automatic recovery to become running',
    })
    assert.equal(recovered?.id, safe.task.id)
    assert.equal(recovered?.runId, safe.task.runId)
    assert.equal(recovered?.status, 'running')
    assert.equal(recovered?.executionKind, 'recovery')
    assert.equal(recovered?.executionAttemptNumber, 2)
    assert.equal(recovered?.recoveryCount, 1)
    assert.notEqual(recovered?.executionAttemptId, safe.executionAttemptId)
    assert.equal(recovered?.ownerInstanceId, replacementStore.getInstanceId())
    assert.notEqual(recovered?.ownerInstanceId, originalInstanceId)
    assert.equal(
      launcherRequests[0]?.processIdentity,
      recovered?.executionAttemptId,
    )
    assert.equal(
      launcherRequests[0]?.env?.TEAM_RUNTIME_RUN_ID,
      safe.task.runId,
    )
    assert.equal(
      launcherRequests[0]?.env?.TEAM_RUNTIME_TASK_ID,
      safe.task.id,
    )

    for (const deferred of persisted.slice(1)) {
      const task = await replacementStore.getTaskRecord(
        session.id,
        deferred.task.id,
      )
      assert.equal(task?.status, 'interrupted')
      assert.equal(task?.recoveryDisposition, deferred.disposition)
      assert.equal(task?.executionAttemptId, deferred.executionAttemptId)
      assert.equal(task?.executionAttemptNumber, 1)
      assert.equal(task?.recoveryCount, 0)
    }
  } finally {
    await server?.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a failed automatic startup launch remains eligible for a later recovery sweep', async () => {
  const workspacePath = makeWorkspace()
  const originalStore = new FileSystemSessionStore(workspacePath, {
    instanceId: randomUUID(),
  })
  const session = await originalStore.createSession({
    title: 'Retry failed recovery launch',
  })
  const task = await createTask(originalStore, session.id)
  const originalAttemptId = randomUUID()
  let firstServer: Awaited<ReturnType<typeof startApiServer>> | undefined
  let secondServer: Awaited<ReturnType<typeof startApiServer>> | undefined

  try {
    await persistTaskStatus({
      store: originalStore,
      sessionId: session.id,
      task,
      status: 'running',
      executionAttemptId: originalAttemptId,
    })
    await initializeRunningJournal({
      task,
      executionAttemptId: originalAttemptId,
      recoveryPolicy: 'safe_retry',
    })

    const replacementStore = freshDeadProcessReconciler(workspacePath)
    let launchCount = 0
    const recoveringLauncher = {
      async startRun(request: RunStartRequest) {
        launchCount += 1
        if (launchCount === 1) {
          throw new Error('simulated one-time recovery launch failure')
        }
        return { launched: true as const, pid: 43, cwd: request.cwd }
      },
    }
    const baseOptions = {
      store: new FileSystemRunStore(workspacePath),
      launcher: {
        async startRun(request: RunStartRequest) {
          return { launched: true as const, pid: 1, cwd: request.cwd }
        },
      },
      taskLauncher: recoveringLauncher,
      sessionStore: replacementStore,
      recoverInterruptedTasks: true,
      workspacePath,
      repoRootPath: process.cwd(),
    }

    firstServer = await startApiServer(baseOptions)
    await waitForValue({
      read: () => launchCount,
      accept: (count) => count === 1,
      description: 'the first automatic recovery launch',
    })
    const afterFailure = await waitForValue({
      read: () => replacementStore.getTaskRecord(session.id, task.id),
      accept: (value) => value?.status === 'interrupted' && value.recoveryCount === 1,
      description: 'the failed recovery to return to interrupted',
    })
    assert.equal(afterFailure?.status, 'interrupted')
    assert.equal(afterFailure?.recoveryDisposition, 'automatic')
    assert.match(afterFailure?.error ?? '', /one-time recovery launch failure/)
    assert.equal(afterFailure?.executionAttemptNumber, 2)
    assert.equal(afterFailure?.recoveryCount, 1)
    assert.notEqual(afterFailure?.executionAttemptId, originalAttemptId)

    await firstServer.close()
    firstServer = undefined
    secondServer = await startApiServer(baseOptions)
    await waitForValue({
      read: () => launchCount,
      accept: (count) => count === 2,
      description: 'the second automatic recovery launch',
    })
    const afterRetry = await waitForValue({
      read: () => replacementStore.getTaskRecord(session.id, task.id),
      accept: (value) => value?.status === 'running' && value.recoveryCount === 2,
      description: 'the retried recovery to become running',
    })
    assert.equal(afterRetry?.status, 'running')
    assert.equal(afterRetry?.id, task.id)
    assert.equal(afterRetry?.runId, task.runId)
    assert.equal(afterRetry?.executionKind, 'recovery')
    assert.equal(afterRetry?.executionAttemptNumber, 3)
    assert.equal(afterRetry?.recoveryCount, 2)
    assert.notEqual(
      afterRetry?.executionAttemptId,
      afterFailure?.executionAttemptId,
    )
    assert.equal(
      afterRetry?.ownerInstanceId,
      replacementStore.getInstanceId(),
    )
  } finally {
    await firstServer?.close()
    await secondServer?.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('startup recovery does not classify or relaunch a live process with mismatched identity', async () => {
  const workspacePath = makeWorkspace()
  const originalStore = new FileSystemSessionStore(workspacePath, {
    instanceId: randomUUID(),
  })
  const session = await originalStore.createSession({
    title: 'Unverified live process',
  })
  const task = await createTask(originalStore, session.id)
  const executionAttemptId = randomUUID()
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined

  try {
    await persistTaskStatus({
      store: originalStore,
      sessionId: session.id,
      task,
      status: 'running',
      executionAttemptId,
    })
    await initializeRunningJournal({
      task,
      executionAttemptId,
      recoveryPolicy: 'safe_retry',
    })

    const replacementStore = new FileSystemSessionStore(workspacePath, {
      instanceId: randomUUID(),
      isProcessAlive: () => true,
      isProcessIdentityValid: () => false,
      findProcessByIdentity: () => null,
      staleTaskGraceMs: 0,
    })
    let launchCount = 0
    server = await startApiServer({
      store: new FileSystemRunStore(workspacePath),
      launcher: {
        async startRun(request) {
          return { launched: true as const, pid: 1, cwd: request.cwd }
        },
      },
      taskLauncher: {
        async startRun(request) {
          launchCount += 1
          return { launched: true as const, pid: 44, cwd: request.cwd }
        },
      },
      sessionStore: replacementStore,
      recoverInterruptedTasks: true,
      workspacePath,
      repoRootPath: process.cwd(),
    })

    const unchanged = await replacementStore.getTaskRecord(session.id, task.id)
    assert.equal(launchCount, 0)
    assert.equal(unchanged?.status, 'running')
    assert.equal(unchanged?.executionAttemptId, executionAttemptId)
    assert.equal(unchanged?.executionAttemptNumber, 1)
    assert.equal(unchanged?.recoveryDisposition, undefined)
    assert.equal(unchanged?.ownerInstanceId, originalStore.getInstanceId())
  } finally {
    await server?.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a fresh session store repairs a dead running task from a terminal workflow journal', async () => {
  const workspacePath = makeWorkspace()
  try {
    const originalStore = new FileSystemSessionStore(workspacePath, {
      instanceId: randomUUID(),
    })
    const session = await originalStore.createSession({ title: 'Terminal repair' })
    const task = await createTask(originalStore, session.id)
    const executionAttemptId = randomUUID()
    await persistTaskStatus({
      store: originalStore,
      sessionId: session.id,
      task,
      status: 'running',
      executionAttemptId,
    })
    const journal = await initializeRunningJournal({
      task,
      executionAttemptId,
      recoveryPolicy: 'safe_retry',
    })
    const childAssignmentPath = resolveChildAssignmentPath(
      workspacePath,
      task,
      journal.childRunId,
    )
    fs.mkdirSync(childAssignmentPath, { recursive: true })
    fs.writeFileSync(path.join(childAssignmentPath, 'report.md'), '# Persisted report\n')
    const artifact = await createWorkflowArtifactReference({
      childAssignmentPath,
      childRunId: journal.childRunId,
      relativePath: 'report.md',
    })
    const beforeTerminal = await journal.store.requireSnapshot()
    const terminalState = await journal.store.update({
      expectedRevision: beforeTerminal.state.revision,
      executionAttemptId,
      mutate(state) {
        state.status = 'completed'
        delete state.currentStepId
        state.steps[0]!.status = 'completed'
        state.steps[0]!.artifact = artifact
        state.steps[0]!.summary = 'Persisted research completed.'
        state.steps[0]!.completedAt = new Date().toISOString()
        state.terminalOutcome = buildDurableWorkflowTerminalOutcome({
          workflowId: state.workflowId,
          status: 'completed',
          summary: 'Persisted research completed.',
          requestedResultType: state.steps[0]!.requestedResultType,
          outputStepId: state.steps[0]!.stepId,
          primaryArtifact: artifact,
          primaryArtifactPath: path.join(childAssignmentPath, 'report.md'),
        })
      },
    })

    const replacementStore = freshDeadProcessReconciler(workspacePath)
    const reconciledTasks = await replacementStore.listTaskRecords(session.id)
    const repaired = reconciledTasks.find((candidate) => candidate.id === task.id)

    assert.equal(repaired?.status, 'done')
    assert.equal(repaired?.completedAt, terminalState.updatedAt)
    assert.equal(repaired?.executionAttemptId, executionAttemptId)
    assert.equal(repaired?.pid, undefined)
    assert.equal(repaired?.processGroupId, undefined)

    const persisted = await new FileSystemSessionStore(
      workspacePath,
    ).getTaskRecord(session.id, task.id)
    assert.equal(persisted?.status, 'done')
    assert.equal(persisted?.completedAt, terminalState.updatedAt)
    const publicResultPath = path.join(
      task.assignmentPath!,
      `workflow-${task.workflowId}-result.md`,
    )
    assert.equal(fs.existsSync(publicResultPath), true)
    assert.match(fs.readFileSync(publicResultPath, 'utf8'), /Persisted research completed/)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('multi-artifact publication exposes the secondary while selecting only the primary', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath, {
      instanceId: randomUUID(),
    })
    const session = await store.createSession({ title: 'Multi-artifact publication' })
    const task = await createTask(store, session.id)
    const executionAttemptId = randomUUID()
    await persistTaskStatus({
      store,
      sessionId: session.id,
      task,
      status: 'running',
      executionAttemptId,
    })
    const journal = await initializeRunningJournal({
      task,
      executionAttemptId,
      recoveryPolicy: 'safe_retry',
      resultArtifacts: ['report.md', 'report.docx'],
    })
    const childAssignmentPath = resolveChildAssignmentPath(
      workspacePath,
      task,
      journal.childRunId,
    )
    fs.mkdirSync(childAssignmentPath, { recursive: true })
    fs.writeFileSync(path.join(childAssignmentPath, 'report.md'), '# Published report\n')
    fs.writeFileSync(path.join(childAssignmentPath, 'report.docx'), Buffer.from('docx-bytes'))
    writeChildAgentRunLog({
      childAssignmentPath,
      childRunId: journal.childRunId,
      agentName: 'report-writer',
      event: 'end',
    })
    const primaryArtifact = await createWorkflowArtifactReference({
      childAssignmentPath,
      childRunId: journal.childRunId,
      relativePath: 'report.md',
    })
    const secondaryArtifact = await createWorkflowArtifactReference({
      childAssignmentPath,
      childRunId: journal.childRunId,
      relativePath: 'report.docx',
    })
    const beforeTerminal = await journal.store.requireSnapshot()
    await journal.store.update({
      expectedRevision: beforeTerminal.state.revision,
      executionAttemptId,
      mutate(state) {
        state.status = 'completed'
        delete state.currentStepId
        state.steps[0]!.status = 'completed'
        state.steps[0]!.artifact = primaryArtifact
        state.steps[0]!.artifacts = [primaryArtifact, secondaryArtifact]
        state.steps[0]!.summary = 'Published both report formats.'
        state.steps[0]!.completedAt = new Date().toISOString()
        state.terminalOutcome = buildDurableWorkflowTerminalOutcome({
          workflowId: state.workflowId,
          status: 'completed',
          summary: 'Published both report formats.',
          requestedResultType: state.steps[0]!.requestedResultType,
          outputStepId: state.steps[0]!.stepId,
          primaryArtifact,
          artifacts: [
            {
              stepId: state.steps[0]!.stepId,
              role: 'primary',
              artifact: primaryArtifact,
              mediaType: 'text/markdown',
              label: 'Markdown report',
            },
            {
              stepId: state.steps[0]!.stepId,
              role: 'secondary',
              artifact: secondaryArtifact,
              mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              label: 'Word document',
            },
          ],
          primaryArtifactPath: path.join(childAssignmentPath, 'report.md'),
        })
      },
    })

    const completed = await store.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['running'],
      { status: 'done', completedAt: new Date().toISOString() },
      { expectedExecutionAttemptId: executionAttemptId },
    )
    assert.equal(completed?.updated, true)

    const runtimeEventsPath = path.join(task.assignmentPath!, 'logs', 'runtime-events.jsonl')
    const publicationEvents = fs.readFileSync(runtimeEventsPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) =>
        event.event === 'artifact.written' || event.event === 'artifact.delivery_selected',
      )
    const selected = publicationEvents.filter(
      (event) => event.event === 'artifact.delivery_selected',
    )
    assert.equal(selected.length, 1)
    assert.equal(selected[0]?.path, 'report.md')
    assert.equal(selected[0]?.artifact_role, 'final')
    assert.ok(publicationEvents.some(
      (event) =>
        event.event === 'artifact.written' &&
        event.path === 'report.docx' &&
        event.artifact_role === 'secondary' &&
        event.title === 'Word document',
    ))

    const markerPath = path.join(
      getRunRuntimePaths(task.assignmentPath!).privateRuntimePath,
      'task-results',
      `${executionAttemptId}.published.json`,
    )
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as {
      schemaVersion: number
      artifacts: Array<Record<string, unknown>>
    }
    assert.equal(marker.schemaVersion, 2)
    assert.deepEqual(marker.artifacts.map((artifact) => ({
      role: artifact.role,
      path: artifact.path,
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
    })), [
      {
        role: 'primary',
        path: 'report.md',
        sha256: primaryArtifact.sha256,
        byteLength: primaryArtifact.byteLength,
      },
      {
        role: 'secondary',
        path: 'report.docx',
        sha256: secondaryArtifact.sha256,
        byteLength: secondaryArtifact.byteLength,
      },
    ])

    const resolution = await store.resolveTaskPublication(
      session.id,
      task.id,
      executionAttemptId,
    )
    assert.equal(resolution.status, 'ready')
    if (resolution.status === 'ready') {
      assert.deepEqual(resolution.artifacts.map((artifact) => ({
        role: artifact.role,
        path: artifact.path,
        sha256: artifact.sha256,
        byteLength: artifact.byteLength,
      })), [
        {
          role: 'primary',
          path: 'report.md',
          sha256: primaryArtifact.sha256,
          byteLength: primaryArtifact.byteLength,
        },
        {
          role: 'secondary',
          path: 'report.docx',
          sha256: secondaryArtifact.sha256,
          byteLength: secondaryArtifact.byteLength,
        },
      ])
    }
    const wrongAttempt = await store.resolveTaskPublication(
      session.id,
      task.id,
      randomUUID(),
    )
    assert.deepEqual(wrongAttempt, {
      status: 'failed',
      code: 'verified_publication_invalid',
      detail: 'Task publication identity does not match the requested execution attempt.',
    })

    fs.writeFileSync(markerPath, `${JSON.stringify({
      schemaVersion: 1,
      taskId: task.id,
      executionAttemptId,
      publishedAt: new Date().toISOString(),
    }, null, 2)}\n`)
    await store.listTaskRecords(session.id)
    const upgradedMarker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as {
      schemaVersion: number
      artifacts: unknown[]
    }
    assert.equal(upgradedMarker.schemaVersion, 2)
    assert.equal(upgradedMarker.artifacts.length, 2)

    // The delivery is also surfaced as a persisted chat message (primary
    // first), and the marker re-publish above must not duplicate it.
    const deliveryMessages = (await store.listChatMessages(session.id))
      .filter((message) => message.delivery)
    assert.equal(deliveryMessages.length, 1)
    assert.equal(deliveryMessages[0]?.role, 'assistant')
    // Credited to the agent that produced the delivered artifact, not to the
    // front-door persona the panel falls back to when a speaker is missing.
    assert.deepEqual(deliveryMessages[0]?.speaker, {
      type: 'agent',
      id: 'report-writer',
      name: 'report-writer',
    })
    assert.equal(deliveryMessages[0]?.delivery?.taskId, task.id)
    assert.equal(deliveryMessages[0]?.delivery?.executionAttemptId, executionAttemptId)
    assert.deepEqual(
      deliveryMessages[0]?.delivery?.artifacts.map((artifact) => ({
        role: artifact.role,
        path: artifact.path,
        runId: artifact.runId,
        title: artifact.title,
        mediaType: artifact.mediaType,
      })),
      [
        {
          role: 'final',
          path: 'report.md',
          runId: journal.childRunId,
          title: 'Markdown report',
          mediaType: 'text/markdown',
        },
        {
          role: 'secondary',
          path: 'report.docx',
          runId: journal.childRunId,
          title: 'Word document',
          mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      ],
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a failed workflow run posts one sanitized outcome message naming the workflow and the failed step', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath, {
      instanceId: randomUUID(),
    })
    const session = await store.createSession({ title: 'Failed run outcome' })
    const task = await createTask(store, session.id, 'youtube-manual-generation')
    const executionAttemptId = randomUUID()
    await persistTaskStatus({
      store,
      sessionId: session.id,
      task,
      status: 'running',
      executionAttemptId,
    })
    const journal = await initializeRunningJournal({
      task,
      executionAttemptId,
      recoveryPolicy: 'safe_retry',
    })
    const childAssignmentPath = resolveChildAssignmentPath(
      workspacePath,
      task,
      journal.childRunId,
    )
    fs.mkdirSync(childAssignmentPath, { recursive: true })
    writeChildAgentRunLog({
      childAssignmentPath,
      childRunId: journal.childRunId,
      agentName: 'youtube-extractor',
      event: 'fail',
    })

    // The workflow's own terminal summary, shaped the way a worker leaves it:
    // several lines, and carrying the absolute path of the file it wanted.
    const leakedPath = '/Users/tester/Library/Application Support/pipeline/manual.docx'
    const summary = [
      "Step 'research' failed.",
      '  Bundled YouTube media tools are unavailable.',
      `  Expected ${leakedPath}.`,
    ].join('\n')
    const beforeTerminal = await journal.store.requireSnapshot()
    await journal.store.update({
      expectedRevision: beforeTerminal.state.revision,
      executionAttemptId,
      mutate(state) {
        state.status = 'failed'
        delete state.currentStepId
        state.steps[0]!.status = 'failed'
        state.steps[0]!.summary = summary
        state.steps[0]!.error = summary
        state.steps[0]!.completedAt = new Date().toISOString()
        state.terminalOutcome = buildDurableWorkflowTerminalOutcome({
          workflowId: state.workflowId,
          status: 'failed',
          summary,
          requestedResultType: state.steps[0]!.requestedResultType,
          outputStepId: state.steps[0]!.stepId,
        })
      },
    })

    const failed = await store.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['running'],
      {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: summary,
      },
      { expectedExecutionAttemptId: executionAttemptId },
    )
    assert.equal(failed?.updated, true)

    const outcomeMessages = (await store.listChatMessages(session.id))
      .filter((message) => message.outcome)
    assert.equal(outcomeMessages.length, 1)
    const posted = outcomeMessages[0]!
    assert.equal(posted.role, 'assistant')
    assert.equal(posted.outcome?.taskId, task.id)
    assert.equal(posted.outcome?.executionAttemptId, executionAttemptId)
    assert.equal(posted.outcome?.status, 'failed')
    assert.equal(posted.outcome?.workflowId, 'youtube-manual-generation')
    assert.equal(posted.outcome?.stepId, 'research')
    assert.match(posted.text, /youtube-manual-generation/)
    assert.match(posted.text, /research/)
    assert.match(posted.text, /Bundled YouTube media tools are unavailable\./)
    assert.equal(posted.text.includes(leakedPath), false)
    assert.equal(posted.outcome?.reason?.includes(leakedPath), false)
    // The failing step's own agent owns the message, as the delivery's does.
    assert.deepEqual(posted.speaker, {
      type: 'agent',
      id: 'youtube-extractor',
      name: 'youtube-extractor',
    })

    // A repeated publication repairs the marker and must not post a second copy.
    const markerPath = path.join(
      getRunRuntimePaths(task.assignmentPath!).privateRuntimePath,
      'task-results',
      `${executionAttemptId}.published.json`,
    )
    fs.writeFileSync(markerPath, `${JSON.stringify({
      schemaVersion: 1,
      taskId: task.id,
      executionAttemptId,
      publishedAt: new Date().toISOString(),
    }, null, 2)}\n`)
    await store.listTaskRecords(session.id)
    assert.equal(
      (await store.listChatMessages(session.id))
        .filter((message) => message.outcome).length,
      1,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a run that failed before its durable journal existed still posts one outcome message', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath, {
      instanceId: randomUUID(),
    })
    const session = await store.createSession({ title: 'Failed before the journal' })
    const task = await createTask(store, session.id, 'youtube-manual-generation')
    const executionAttemptId = randomUUID()
    await persistTaskStatus({
      store,
      sessionId: session.id,
      task,
      status: 'running',
      executionAttemptId,
    })

    // No journal, so there is no terminal outcome and no result artifact to
    // synthesise — an MCP preflight rejection or an unresolvable template.
    const failed = await store.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['running'],
      {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: 'MCP preflight rejected the workflow template.',
      },
      { expectedExecutionAttemptId: executionAttemptId },
    )
    assert.equal(failed?.updated, true)

    const outcomeMessages = (await store.listChatMessages(session.id))
      .filter((message) => message.outcome)
    assert.equal(outcomeMessages.length, 1)
    const posted = outcomeMessages[0]!
    assert.equal(posted.outcome?.taskId, task.id)
    assert.equal(posted.outcome?.executionAttemptId, executionAttemptId)
    assert.equal(posted.outcome?.status, 'failed')
    assert.equal(posted.outcome?.workflowId, 'youtube-manual-generation')
    assert.equal(posted.outcome?.stepId, undefined)
    assert.match(posted.text, /MCP preflight rejected the workflow template\./)
    // No child ran, so the workflow itself owns the line.
    assert.deepEqual(posted.speaker, {
      type: 'assistant',
      id: 'youtube-manual-generation',
      name: 'youtube-manual-generation',
    })

    await store.listTaskRecords(session.id)
    assert.equal(
      (await store.listChatMessages(session.id))
        .filter((message) => message.outcome).length,
      1,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a blocked run whose journal never reached a terminal state still posts one outcome message', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath, {
      instanceId: randomUUID(),
    })
    const session = await store.createSession({ title: 'Blocked run outcome' })
    const task = await createTask(store, session.id, 'youtube-manual-generation')
    const executionAttemptId = randomUUID()
    await persistTaskStatus({
      store,
      sessionId: session.id,
      task,
      status: 'running',
      executionAttemptId,
    })
    // The journal stays on `running`: the reconciler only converges cancelled
    // and failed runs, so a blocked task's journal can be left behind.
    await initializeRunningJournal({
      task,
      executionAttemptId,
      recoveryPolicy: 'safe_retry',
    })

    const blocked = await store.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['running'],
      {
        status: 'blocked',
        completedAt: new Date().toISOString(),
        error: "Provider 'codex' failed: You've hit your provider usage limit",
      },
      { expectedExecutionAttemptId: executionAttemptId },
    )
    assert.equal(blocked?.updated, true)

    const outcomeMessages = (await store.listChatMessages(session.id))
      .filter((message) => message.outcome)
    assert.equal(outcomeMessages.length, 1)
    const posted = outcomeMessages[0]!
    assert.equal(posted.outcome?.status, 'blocked')
    assert.equal(posted.outcome?.taskId, task.id)
    assert.equal(posted.outcome?.executionAttemptId, executionAttemptId)
    assert.match(posted.text, /blocked/)
    assert.match(posted.text, /provider usage limit/)

    await store.listTaskRecords(session.id)
    assert.equal(
      (await store.listChatMessages(session.id))
        .filter((message) => message.outcome).length,
      1,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a child provider quota becomes one safe persisted chat outcome', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath, { instanceId: randomUUID() })
    const session = await store.createSession({ title: 'Child provider quota' })
    const task = await createTask(store, session.id, 'youtube-manual-generation')
    const executionAttemptId = randomUUID()
    await persistTaskStatus({ store, sessionId: session.id, task, status: 'running', executionAttemptId })
    const blocked = await store.compareAndSetTaskRecord(session.id, task.id, ['running'], {
      status: 'blocked', completedAt: new Date().toISOString(),
      error: [
        '[Child team process completed without producing the expected output artifact: extraction-report.md]',
        "Reason: Provider 'claude' failed: You've hit your provider usage limit. Try again after it resets.",
        'Child stderr:',
        'PRIVATE_WORKER_OUTPUT API_KEY=fixture-secret',
      ].join('\n'),
    }, { expectedExecutionAttemptId: executionAttemptId })
    assert.equal(blocked?.updated, true)

    // Reopening the store and repeated reconciliation must keep one outcome.
    const reopened = new FileSystemSessionStore(workspacePath, { instanceId: randomUUID() })
    await reopened.listTaskRecords(session.id)
    const messages = (await reopened.listChatMessages(session.id)).filter((message) => message.outcome)
    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.outcome?.taskId, task.id)
    assert.equal(messages[0]?.text, '⛔ youtube-manual-generation is blocked. Claude usage limit reached. Select a different model or wait for the limit to reset.')
    assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_WORKER_OUTPUT|fixture-secret/)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('terminal journal reconciliation rejects a corrupt secondary workflow artifact', async () => {
  const workspacePath = makeWorkspace()
  try {
    const originalStore = new FileSystemSessionStore(workspacePath, {
      instanceId: randomUUID(),
    })
    const session = await originalStore.createSession({ title: 'Secondary artifact integrity' })
    const task = await createTask(originalStore, session.id)
    const executionAttemptId = randomUUID()
    await persistTaskStatus({
      store: originalStore,
      sessionId: session.id,
      task,
      status: 'running',
      executionAttemptId,
    })
    const journal = await initializeRunningJournal({
      task,
      executionAttemptId,
      recoveryPolicy: 'safe_retry',
      resultArtifacts: ['report.md', 'report.docx'],
    })
    const childAssignmentPath = resolveChildAssignmentPath(
      workspacePath,
      task,
      journal.childRunId,
    )
    fs.mkdirSync(childAssignmentPath, { recursive: true })
    fs.writeFileSync(path.join(childAssignmentPath, 'report.md'), '# Persisted report\n')
    fs.writeFileSync(path.join(childAssignmentPath, 'report.docx'), Buffer.from('valid-docx-placeholder'))
    const primaryArtifact = await createWorkflowArtifactReference({
      childAssignmentPath,
      childRunId: journal.childRunId,
      relativePath: 'report.md',
    })
    const secondaryArtifact = await createWorkflowArtifactReference({
      childAssignmentPath,
      childRunId: journal.childRunId,
      relativePath: 'report.docx',
    })
    const beforeTerminal = await journal.store.requireSnapshot()
    await journal.store.update({
      expectedRevision: beforeTerminal.state.revision,
      executionAttemptId,
      mutate(state) {
        state.status = 'completed'
        delete state.currentStepId
        state.steps[0]!.status = 'completed'
        state.steps[0]!.artifact = primaryArtifact
        state.steps[0]!.artifacts = [primaryArtifact, secondaryArtifact]
        state.steps[0]!.summary = 'Research and publication completed.'
        state.steps[0]!.completedAt = new Date().toISOString()
        state.terminalOutcome = buildDurableWorkflowTerminalOutcome({
          workflowId: state.workflowId,
          status: 'completed',
          summary: 'Research and publication completed.',
          requestedResultType: state.steps[0]!.requestedResultType,
          outputStepId: state.steps[0]!.stepId,
          primaryArtifact,
          artifacts: [
            { stepId: state.steps[0]!.stepId, role: 'primary', artifact: primaryArtifact },
            { stepId: state.steps[0]!.stepId, role: 'secondary', artifact: secondaryArtifact },
          ],
          primaryArtifactPath: path.join(childAssignmentPath, 'report.md'),
        })
      },
    })

    fs.writeFileSync(path.join(childAssignmentPath, 'report.docx'), Buffer.from('corrupt'))

    await assert.rejects(
      originalStore.compareAndSetTaskRecord(
        session.id,
        task.id,
        ['running'],
        { status: 'done', completedAt: new Date().toISOString() },
        { expectedExecutionAttemptId: executionAttemptId },
      ),
      /artifact .* (?:byte length|hash) does not match/i,
    )
    assert.equal(
      (await originalStore.getTaskRecord(session.id, task.id))?.status,
      'running',
    )

    const replacementStore = freshDeadProcessReconciler(workspacePath)
    const reconciledTasks = await replacementStore.listTaskRecords(session.id)
    const repaired = reconciledTasks.find((candidate) => candidate.id === task.id)

    assert.equal(repaired?.status, 'failed')
    assert.match(repaired?.error ?? '', /artifact is missing or invalid/i)
    assert.equal(
      fs.existsSync(path.join(task.assignmentPath!, `workflow-${task.workflowId}-result.md`)),
      false,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('cancellation atomically leaves a valid terminal workflow journal', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath, {
      instanceId: randomUUID(),
    })
    const session = await store.createSession({ title: 'Journal cancellation' })
    const task = await createTask(store, session.id, 'cancel-journal-workflow')
    const executionAttemptId = randomUUID()
    await persistTaskStatus({
      store,
      sessionId: session.id,
      task,
      status: 'running',
      executionAttemptId,
    })
    const journal = await initializeRunningJournal({
      task,
      executionAttemptId,
      recoveryPolicy: 'safe_retry',
    })
    const abandonedTemporaryPath = path.join(
      resolveChildAssignmentPath(workspacePath, task, journal.childRunId),
      '.runtime',
      'tmp',
      executionAttemptId,
    )
    fs.mkdirSync(abandonedTemporaryPath, { recursive: true })
    fs.writeFileSync(path.join(abandonedTemporaryPath, 'provider.tmp'), 'partial')

    const cancelled = await cancelSessionTask({
      sessionId: session.id,
      taskId: task.id,
      sessionStore: store,
      isProcessAlive: () => false,
      isProcessIdentityValid: () => true,
    })
    assert.equal(cancelled?.status, 'cancelled')
    const snapshot = await journal.store.requireSnapshot()
    assert.equal(snapshot.state.status, 'cancelled')
    assert.equal(snapshot.state.currentStepId, undefined)
    assert.equal(snapshot.state.steps[0]!.status, 'cancelled')
    assert.equal(snapshot.state.terminalOutcome?.status, 'cancelled')
    assert.equal(
      snapshot.state.terminalOutcome?.outputStepId,
      snapshot.state.steps[0]!.stepId,
    )
    assert.equal(fs.existsSync(path.dirname(abandonedTemporaryPath)), false)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('restart converges a cancelled task whose workflow journal was still running', async () => {
  const workspacePath = makeWorkspace()
  try {
    const originalStore = new FileSystemSessionStore(workspacePath, {
      instanceId: randomUUID(),
    })
    const session = await originalStore.createSession({
      title: 'Cancellation crash window',
    })
    const task = await createTask(
      originalStore,
      session.id,
      'cancel-repair-workflow',
    )
    const executionAttemptId = randomUUID()
    await persistTaskStatus({
      store: originalStore,
      sessionId: session.id,
      task,
      status: 'running',
      executionAttemptId,
    })
    const journal = await initializeRunningJournal({
      task,
      executionAttemptId,
      recoveryPolicy: 'safe_retry',
    })

    // Simulate a hard crash after the task record rename but before the
    // normal terminal finalizer can update the workflow journal.
    const runningTask = await originalStore.getTaskRecord(session.id, task.id)
    assert.ok(runningTask)
    const cancellationTime = new Date().toISOString()
    fs.writeFileSync(
      path.join(originalStore.taskDir(session.id, task.id), 'task.json'),
      `${JSON.stringify({
        ...runningTask,
        status: 'cancelled',
        completedAt: cancellationTime,
        updatedAt: cancellationTime,
        error: 'Cancelled by user',
      }, null, 2)}\n`,
    )
    assert.equal((await journal.store.requireSnapshot()).state.status, 'running')

    const replacementStore = freshDeadProcessReconciler(workspacePath)
    const reconciled = await replacementStore.listTaskRecords(session.id)
    assert.equal(
      reconciled.find((candidate) => candidate.id === task.id)?.status,
      'cancelled',
    )
    const repairedJournal = await journal.store.requireSnapshot()
    assert.equal(repairedJournal.state.status, 'cancelled')
    assert.equal(repairedJournal.state.steps[0]!.status, 'cancelled')
    assert.equal(repairedJournal.state.terminalOutcome?.status, 'cancelled')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('authoritative task cancellation overrides a concurrently completed journal', async () => {
  const workspacePath = makeWorkspace()
  try {
    const originalStore = new FileSystemSessionStore(workspacePath, {
      instanceId: 'cancellation-race-api',
    })
    const session = await originalStore.createSession({
      title: 'Cancellation terminal race',
    })
    const task = await createTask(
      originalStore,
      session.id,
      'cancel-terminal-race',
    )
    const executionAttemptId = randomUUID()
    await persistTaskStatus({
      store: originalStore,
      sessionId: session.id,
      task,
      status: 'running',
      executionAttemptId,
    })
    const journal = await initializeRunningJournal({
      task,
      executionAttemptId,
      recoveryPolicy: 'safe_retry',
    })
    const childAssignmentPath = resolveChildAssignmentPath(
      workspacePath,
      task,
      journal.childRunId,
    )
    fs.mkdirSync(childAssignmentPath, { recursive: true })
    fs.writeFileSync(path.join(childAssignmentPath, 'report.md'), '# Too late\n')
    const artifact = await createWorkflowArtifactReference({
      childAssignmentPath,
      childRunId: journal.childRunId,
      relativePath: 'report.md',
    })

    // The task cancellation rename wins first, but the old worker already
    // owns the journal lock and commits completion before cancellation can
    // acquire it. Its later task completion CAS must still lose.
    const runningTask = await originalStore.getTaskRecord(session.id, task.id)
    assert.ok(runningTask)
    const cancellationTime = new Date().toISOString()
    fs.writeFileSync(
      path.join(originalStore.taskDir(session.id, task.id), 'task.json'),
      `${JSON.stringify({
        ...runningTask,
        status: 'cancelled',
        completedAt: cancellationTime,
        updatedAt: cancellationTime,
        error: 'Cancelled by user',
      }, null, 2)}\n`,
    )
    const beforeTerminal = await journal.store.requireSnapshot()
    const workerTerminal = await journal.store.update({
      expectedRevision: beforeTerminal.state.revision,
      executionAttemptId,
      mutate(state) {
        state.status = 'completed'
        delete state.currentStepId
        state.steps[0]!.status = 'completed'
        state.steps[0]!.artifact = artifact
        state.steps[0]!.summary = 'Worker completed after cancellation.'
        state.steps[0]!.completedAt = new Date().toISOString()
        state.terminalOutcome = buildDurableWorkflowTerminalOutcome({
          workflowId: state.workflowId,
          status: 'completed',
          summary: 'Worker completed after cancellation.',
          requestedResultType: state.steps[0]!.requestedResultType,
          outputStepId: state.steps[0]!.stepId,
          primaryArtifact: artifact,
          primaryArtifactPath: path.join(childAssignmentPath, 'report.md'),
        })
      },
    })
    const lateWorkerCas = await originalStore.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['running'],
      { status: 'done', completedAt: new Date().toISOString() },
      { expectedExecutionAttemptId: executionAttemptId },
    )
    assert.equal(lateWorkerCas?.updated, false)
    assert.equal(lateWorkerCas?.task.status, 'cancelled')

    const replacementStore = freshDeadProcessReconciler(workspacePath)
    const reconciled = await replacementStore.listTaskRecords(session.id)
    assert.equal(
      reconciled.find((candidate) => candidate.id === task.id)?.status,
      'cancelled',
    )
    const converged = await journal.store.requireSnapshot()
    assert.equal(converged.state.revision, workerTerminal.revision + 1)
    assert.equal(converged.state.status, 'cancelled')
    assert.equal(converged.state.steps[0]!.status, 'completed')
    assert.deepEqual(converged.state.steps[0]!.artifact, artifact)
    assert.equal(converged.state.terminalOutcome?.status, 'cancelled')
    assert.equal(converged.state.terminalOutcome?.primaryArtifact, undefined)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('startup launches a task committed before its first attempt reservation', async () => {
  const workspacePath = makeWorkspace()
  const originalStore = new FileSystemSessionStore(workspacePath, {
    instanceId: 'pre-attempt-original-api',
  })
  const session = await originalStore.createSession({
    title: 'Pre-attempt crash window',
  })
  const task = await createTask(originalStore, session.id, 'first-launch-workflow')
  assert.equal(task.status, 'queued')
  assert.equal(task.executionAttemptId, undefined)
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined
  const launches: RunStartRequest[] = []

  try {
    const replacementStore = new FileSystemSessionStore(workspacePath, {
      instanceId: 'pre-attempt-restarted-api',
      staleTaskGraceMs: 0,
    })
    server = await startApiServer({
      store: new FileSystemRunStore(workspacePath),
      launcher: {
        async startRun(request) {
          return { launched: true as const, pid: 1, cwd: request.cwd }
        },
      },
      taskLauncher: {
        async startRun(request) {
          launches.push(request)
          return { launched: true as const, pid: 45, cwd: request.cwd }
        },
      },
      sessionStore: replacementStore,
      recoverInterruptedTasks: true,
      workspacePath,
      repoRootPath: process.cwd(),
    })

    await waitForValue({
      read: () => launches.length,
      accept: (count) => count === 1,
      description: 'the first task attempt to reach the launcher',
    })
    const launched = await waitForValue({
      read: () => replacementStore.getTaskRecord(session.id, task.id),
      accept: (value) => value?.status === 'running',
      description: 'the first task attempt to become running',
    })
    assert.ok(launched)
    assert.equal(launched?.id, task.id)
    assert.equal(launched?.runId, task.runId)
    assert.equal(launched?.status, 'running')
    assert.equal(launched?.executionAttemptNumber, 1)
    assert.equal(launched?.executionKind, 'initial')
    assert.equal(launched?.recoveryCount, 0)
    assert.equal(launched?.ownerInstanceId, replacementStore.getInstanceId())
    assert.ok(launched?.executionAttemptId)
  } finally {
    await server?.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('concurrent startup sweeps reserve a never-attempted task exactly once', async () => {
  const workspacePath = makeWorkspace()
  try {
    const originalStore = new FileSystemSessionStore(workspacePath, {
      instanceId: 'concurrent-pre-attempt-original-api',
    })
    const session = await originalStore.createSession({
      title: 'Concurrent pre-attempt recovery',
    })
    const task = await createTask(
      originalStore,
      session.id,
      'concurrent-first-launch-workflow',
    )

    const firstStore = new FileSystemSessionStore(workspacePath, {
      instanceId: 'concurrent-pre-attempt-api-a',
      staleTaskGraceMs: 0,
    })
    const secondStore = new FileSystemSessionStore(workspacePath, {
      instanceId: 'concurrent-pre-attempt-api-b',
      staleTaskGraceMs: 0,
    })

    let snapshotCount = 0
    let releaseSnapshots!: () => void
    const bothSnapshotsReady = new Promise<void>((resolve) => {
      releaseSnapshots = resolve
    })
    const synchronizeTaskSnapshot = (store: FileSystemSessionStore): void => {
      const listTaskRecords = store.listTaskRecords.bind(store)
      store.listTaskRecords = async (sessionId) => {
        const tasks = await listTaskRecords(sessionId)
        snapshotCount += 1
        if (snapshotCount === 2) releaseSnapshots()
        await bothSnapshotsReady
        return tasks
      }
    }
    synchronizeTaskSnapshot(firstStore)
    synchronizeTaskSnapshot(secondStore)

    const launches: RunStartRequest[] = []
    const taskLauncher = {
      async startRun(request: RunStartRequest) {
        launches.push(request)
        return {
          launched: true as const,
          pid: 45,
          cwd: request.cwd,
        }
      },
    }

    const [firstSweep, secondSweep] = await Promise.all([
      recoverInterruptedSessionTasks({
        sessionStore: firstStore,
        taskLauncher,
        repoRootPath: process.cwd(),
        workspacePath,
      }),
      recoverInterruptedSessionTasks({
        sessionStore: secondStore,
        taskLauncher,
        repoRootPath: process.cwd(),
        workspacePath,
      }),
    ])

    assert.equal(launches.length, 1)
    assert.equal(
      firstSweep.resumed.length + secondSweep.resumed.length,
      1,
    )
    assert.equal(
      firstSweep.failed.length + secondSweep.failed.length,
      1,
    )
    const reserved = await originalStore.getTaskRecord(session.id, task.id)
    assert.equal(reserved?.status, 'running')
    assert.equal(reserved?.executionAttemptNumber, 1)
    assert.equal(reserved?.executionKind, 'initial')
    assert.ok(reserved?.executionAttemptId)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('terminal task failure converges a nonterminal workflow journal', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath, {
      instanceId: 'post-journal-failure-api',
    })
    const session = await store.createSession({ title: 'Post-journal failure' })
    const task = await createTask(store, session.id, 'post-journal-failure')
    const executionAttemptId = randomUUID()
    await persistTaskStatus({
      store,
      sessionId: session.id,
      task,
      status: 'running',
      executionAttemptId,
    })
    const journal = await initializeRunningJournal({
      task,
      executionAttemptId,
      recoveryPolicy: 'safe_retry',
    })

    const failed = await store.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['running'],
      {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: 'Receipt validation failed after child execution.',
      },
      { expectedExecutionAttemptId: executionAttemptId },
    )
    assert.equal(failed?.updated, true)
    const snapshot = await journal.store.requireSnapshot()
    assert.equal(snapshot.state.status, 'failed')
    assert.equal(snapshot.state.steps[0]!.status, 'failed')
    assert.equal(snapshot.state.terminalOutcome?.status, 'failed')
    assert.equal(
      snapshot.state.terminalOutcome?.summary,
      'Receipt validation failed after child execution.',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('terminal task failure before step launch leaves the pending step valid', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath, {
      instanceId: 'pre-step-failure-api',
    })
    const session = await store.createSession({ title: 'Pre-step failure' })
    const task = await createTask(store, session.id, 'pre-step-failure')
    const executionAttemptId = randomUUID()
    await persistTaskStatus({
      store,
      sessionId: session.id,
      task,
      status: 'running',
      executionAttemptId,
    })
    assert.ok(task.assignmentPath)
    const journal = new FileSystemWorkflowStateStore(task.assignmentPath)
    await journal.initialize({
      manifest: {
        taskId: task.id,
        sessionId: task.sessionId,
        rootRunId: task.runId,
        workflowId: task.workflowId,
        workflowDefinitionHash: hashWorkflowContent('pre-step-workflow:v1'),
        briefHash: hashWorkflowContent(task.brief),
        teamDefinitionHashes: {
          researchers: hashWorkflowContent('researchers:v1'),
        },
        runtimeVersion: 'workflow-runtime-v1',
      },
      executionAttemptId,
      steps: [
        {
          stepId: 'research',
          stepIndex: 0,
          stepType: 'team',
          team: 'researchers',
          definitionHash: hashWorkflowContent('research-step:v1'),
          recoveryPolicy: 'safe_retry',
          childRunId: randomUUID(),
          inputArtifact: 'incoming-brief.md',
          resultArtifact: 'report.md',
          requestedResultType: 'artifact:report.md',
        },
      ],
    })

    const failed = await store.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['running'],
      {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: 'Worker failed after journal initialization.',
      },
      { expectedExecutionAttemptId: executionAttemptId },
    )
    assert.equal(failed?.updated, true)

    const snapshot = await journal.requireSnapshot()
    assert.equal(snapshot.state.status, 'failed')
    assert.equal(snapshot.state.steps[0]!.status, 'pending')
    assert.equal(snapshot.state.steps[0]!.attemptCount, 0)
    assert.equal(snapshot.state.steps[0]!.summary, undefined)
    assert.equal(snapshot.state.terminalOutcome?.status, 'failed')
    assert.equal(snapshot.state.terminalOutcome?.outputStepId, 'research')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('terminal task failure after the final receipt preserves the completed step', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath, {
      instanceId: 'post-receipt-failure-api',
    })
    const session = await store.createSession({ title: 'Post-receipt failure' })
    const task = await createTask(store, session.id, 'post-receipt-failure')
    const executionAttemptId = randomUUID()
    await persistTaskStatus({
      store,
      sessionId: session.id,
      task,
      status: 'running',
      executionAttemptId,
    })
    const journal = await initializeRunningJournal({
      task,
      executionAttemptId,
      recoveryPolicy: 'safe_retry',
    })
    const childAssignmentPath = resolveChildAssignmentPath(
      workspacePath,
      task,
      journal.childRunId,
    )
    fs.mkdirSync(childAssignmentPath, { recursive: true })
    fs.writeFileSync(path.join(childAssignmentPath, 'report.md'), '# Completed child\n')
    const artifact = await createWorkflowArtifactReference({
      childAssignmentPath,
      childRunId: journal.childRunId,
      relativePath: 'report.md',
    })
    const beforeReceipt = await journal.store.requireSnapshot()
    await journal.store.update({
      expectedRevision: beforeReceipt.state.revision,
      executionAttemptId,
      mutate(state) {
        delete state.currentStepId
        state.steps[0]!.status = 'completed'
        state.steps[0]!.artifact = artifact
        state.steps[0]!.summary = 'Child output committed.'
        state.steps[0]!.completedAt = new Date().toISOString()
      },
    })

    const failed = await store.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['running'],
      {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: 'Terminal journal commit failed after the final receipt.',
      },
      { expectedExecutionAttemptId: executionAttemptId },
    )
    assert.equal(failed?.updated, true)

    const snapshot = await journal.store.requireSnapshot()
    assert.equal(snapshot.state.status, 'failed')
    assert.equal(snapshot.state.steps[0]!.status, 'completed')
    assert.equal(snapshot.state.steps[0]!.summary, 'Child output committed.')
    assert.deepEqual(snapshot.state.steps[0]!.artifact, artifact)
    assert.equal(snapshot.state.terminalOutcome?.status, 'failed')
    assert.equal(snapshot.state.terminalOutcome?.primaryArtifact, undefined)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('restart reconciliation preserves a durable human-input wait instead of interrupting it', async () => {
  const workspacePath = makeWorkspace()
  try {
    const originalStore = new FileSystemSessionStore(workspacePath, {
      instanceId: 'waiting-journal-original-api',
    })
    const session = await originalStore.createSession({
      title: 'Waiting journal recovery',
    })
    const task = await createTask(originalStore, session.id, 'waiting-journal')
    const executionAttemptId = randomUUID()
    await persistTaskStatus({
      store: originalStore,
      sessionId: session.id,
      task,
      status: 'running',
      executionAttemptId,
    })
    await initializeAwaitingHumanInputJournal({ task, executionAttemptId })

    const replacementStore = freshDeadProcessReconciler(workspacePath)
    await replacementStore.reconcileTaskRecords(session.id)

    const recovered = await replacementStore.getTaskRecord(session.id, task.id)
    assert.equal(recovered?.status, 'awaiting_input')
    assert.equal(recovered?.executionAttemptId, executionAttemptId)
    assert.equal(recovered?.recoveryCount, 0)
    assert.equal(recovered?.recoveryDisposition, undefined)
    assert.equal(recovered?.pid, undefined)
    assert.equal(recovered?.processGroupId, undefined)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a corrupt workflow journal fails closed without poisoning repeated session listing', async () => {
  const workspacePath = makeWorkspace()
  try {
    const originalStore = new FileSystemSessionStore(workspacePath, {
      instanceId: 'corrupt-journal-original-api',
    })
    const session = await originalStore.createSession({
      title: 'Corrupt journal recovery',
    })
    const task = await createTask(originalStore, session.id, 'corrupt-journal')
    const executionAttemptId = randomUUID()
    await persistTaskStatus({
      store: originalStore,
      sessionId: session.id,
      task,
      status: 'running',
      executionAttemptId,
    })
    const journal = await initializeRunningJournal({
      task,
      executionAttemptId,
      recoveryPolicy: 'safe_retry',
    })
    fs.writeFileSync(journal.store.paths.statePath, '{broken-json')

    const replacementStore = freshDeadProcessReconciler(workspacePath)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const tasks = await replacementStore.listTaskRecords(session.id)
      const failed = tasks.find((candidate) => candidate.id === task.id)
      assert.equal(failed?.status, 'failed')
      assert.match(failed?.error ?? '', /corrupt or incompatible/i)
    }
    const sessions = await replacementStore.listSessions()
    assert.equal(sessions.some((candidate) => candidate.id === session.id), true)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

/**
 * AC9: the counterpart of the contract above. The fail-closed rule holds where
 * no journal can answer; where one can, the projection is derived and losing it
 * must not lose the run. An enrolled assignment whose `workflow-state.json` is
 * unreadable recovers exactly as an intact one does.
 */
test('an enrolled run rebuilds its corrupt workflow projection instead of failing the task', async () => {
  const workspacePath = makeWorkspace()
  const registry = makeJournalRegistry(workspacePath)
  try {
    const originalStore = new FileSystemSessionStore(workspacePath, {
      instanceId: 'enrolled-corrupt-projection-api',
    })
    originalStore.useExecutionJournalRegistry(registry)
    const session = await originalStore.createSession({
      title: 'Enrolled corrupt projection',
    })
    const task = await createTask(originalStore, session.id, 'enrolled-journal')
    const executionAttemptId = randomUUID()
    const running = await persistTaskStatus({
      store: originalStore,
      sessionId: session.id,
      task,
      status: 'running',
      executionAttemptId,
    })
    assert.ok(running.assignmentPath)

    const journal = await registry.resolveJournalHandle({
      context: {
        contractVersion: 1,
        requestId: `enrol-${running.id}`,
        sessionId: running.sessionId,
        runId: running.runId,
        assignmentId: running.assignmentId ?? running.runId,
        agentPath: 'workflows/runner',
        authority: { kind: 'runtime-assignment', processIdentity: executionAttemptId },
      },
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 10_000,
    })
    assert.ok(journal, 'the assignment must enrol before the recovery under test')
    const workflowStore = await initializeRunningJournal({
      task: running,
      executionAttemptId,
      recoveryPolicy: 'safe_retry',
      journal: createJournalBackedWorkflowRecorder(journal),
    })
    const intact = await workflowStore.store.requireSnapshot()
    assert.ok(
      (await workflowEventCount(running.assignmentPath)) > 0,
      'the enrolled transitions must be in the canonical journal',
    )

    fs.writeFileSync(workflowStore.store.paths.statePath, '{broken-json')

    const replacementStore = freshDeadProcessReconciler(workspacePath)
    replacementStore.useExecutionJournalRegistry(registry)
    const tasks = await replacementStore.listTaskRecords(session.id)
    const recovered = tasks.find((candidate) => candidate.id === task.id)

    assert.equal(recovered?.status, 'interrupted')
    assert.equal(recovered?.recoveryDisposition, 'automatic')
    assert.match(recovered?.recoveryReason ?? '', /safe retry/)
    assert.equal(recovered?.executionAttemptId, executionAttemptId)

    const rebuilt = await new FileSystemWorkflowStateStore(
      running.assignmentPath,
    ).requireSnapshot()
    assert.deepEqual(rebuilt.state, intact.state)
  } finally {
    await registry.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

/**
 * AC5a and AC5b: authoritative workflow mutations must not happen outside the
 * journal.
 *
 * `cancelFromAuthoritativeTask` and the recovery manager's terminal
 * reconciliation both construct `FileSystemWorkflowStateStore` with no journal
 * recorder, so they bump `workflow-state.json`'s revision while the canonical
 * journal stays where it was. The projection then leads the journal, and a
 * rebuild replays a state that silently omits the cancellation or the failure.
 */

const AC5_TENANT = 'tenant-ac5'

function makeJournalRegistry(
  workspacePath: string,
): WorkspaceExecutionJournalRegistry {
  return new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: AC5_TENANT,
    mode: 'authoritative',
  })
}

async function enrolAssignmentJournal(
  registry: WorkspaceExecutionJournalRegistry,
  task: SessionTask,
): Promise<void> {
  const port = await registry.resolve({
    context: {
      contractVersion: 1,
      requestId: `enrol-${task.id}`,
      sessionId: task.sessionId,
      runId: task.runId,
      assignmentId: task.assignmentId ?? task.runId,
      agentPath: 'agents/enrol',
      authority: { kind: 'runtime-assignment', processIdentity: 'enrol' },
    },
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 5_000,
  })
  assert.ok(port, 'the assignment must enrol before the mutation under test')
}

/** Workflow-state events currently in this assignment's canonical journal. */
async function workflowEventCount(assignmentPath: string): Promise<number> {
  const read = await readExecutionJournal(assignmentPath)
  assert.equal(read.kind, 'ok', 'the assignment must hold a readable journal')
  if (read.kind !== 'ok') return 0
  return read.events.filter(
    (event) => event.streamKind === WORKFLOW_STATE_STREAM_KIND,
  ).length
}

test('cancelling an enrolled run records the cancellation in the journal', async () => {
  const workspacePath = makeWorkspace()
  // The registry is composition's, not the caller's: terminal reconciliation
  // runs inside the session store's cancellation CAS, so the store is one of
  // the two production sites that has to journal the transition.
  const registry = makeJournalRegistry(workspacePath)
  const store = new FileSystemSessionStore(workspacePath)
  store.useExecutionJournalRegistry(registry)
  const session = await store.createSession({ title: 'AC5a cancel' })
  const task = await createTask(store, session.id)
  const executionAttemptId = randomUUID()
  await persistTaskStatus({
    store,
    sessionId: session.id,
    task,
    status: 'running',
    executionAttemptId,
  })
  const running = await store.getTaskRecord(session.id, task.id)
  assert.ok(running?.assignmentPath)
  await initializeRunningJournal({
    task: running,
    executionAttemptId,
    recoveryPolicy: 'safe_retry',
  })

  await enrolAssignmentJournal(registry, running)
  try {
    const before = await workflowEventCount(running.assignmentPath)

    await cancelSessionTask({
      sessionId: session.id,
      taskId: task.id,
      sessionStore: store,
      isProcessAlive: () => false,
      executionJournalRegistry: registry,
    })

    const after = await workflowEventCount(running.assignmentPath)
    assert.ok(
      after > before,
      `cancellation must append to the canonical journal: ${before} events before, ${after} after`,
    )

    // And the projection is derivable from it: delete the state file, rebuild,
    // and the cancellation must still be there.
    const workflowStore = new FileSystemWorkflowStateStore(running.assignmentPath)
    const cancelled = await workflowStore.requireSnapshot()
    assert.equal(cancelled.state.status, 'cancelled')
    fs.rmSync(workflowStore.paths.statePath)

    const journal = await registry.resolveJournalHandle({
      context: {
        contractVersion: 1,
        requestId: 'rebuild-ac5a',
        sessionId: running.sessionId,
        runId: running.runId,
        assignmentId: running.assignmentId ?? running.runId,
        agentPath: 'workflows/runner',
        authority: { kind: 'runtime-assignment', processIdentity: 'rebuild' },
      },
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 10_000,
    })
    assert.ok(journal)
    await rebuildWorkflowStateProjection(journal, workflowStore)

    const rebuilt = await workflowStore.requireSnapshot()
    assert.equal(
      rebuilt.state.status,
      'cancelled',
      'a rebuild from the journal must not lose the cancellation',
    )
  } finally {
    await registry.close()
  }
})

test('a run failed by recovery records its terminal transition in the journal', async () => {
  const workspacePath = makeWorkspace()
  const registry = makeJournalRegistry(workspacePath)
  const store = new FileSystemSessionStore(workspacePath)
  store.useExecutionJournalRegistry(registry)
  const session = await store.createSession({ title: 'AC5b failure' })
  const task = await createTask(store, session.id)
  const executionAttemptId = randomUUID()
  await persistTaskStatus({
    store,
    sessionId: session.id,
    task,
    status: 'running',
    executionAttemptId,
  })
  const running = await store.getTaskRecord(session.id, task.id)
  assert.ok(running?.assignmentPath)
  await initializeRunningJournal({
    task: running,
    executionAttemptId,
    recoveryPolicy: 'safe_retry',
  })

  await enrolAssignmentJournal(registry, running)
  try {
    const before = await workflowEventCount(running.assignmentPath)

    // The production driver: a terminal task CAS, which runs the recovery
    // manager's reconciliation inside itself.
    const failed = await store.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['running'],
      {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: 'Receipt validation failed after child execution.',
      },
      { expectedExecutionAttemptId: executionAttemptId },
    )
    assert.equal(failed?.updated, true)

    const after = await workflowEventCount(running.assignmentPath)
    assert.ok(
      after > before,
      `the terminal transition must append to the canonical journal: ${before} events before, ${after} after`,
    )

    const workflowStore = new FileSystemWorkflowStateStore(running.assignmentPath)
    const converged = await workflowStore.requireSnapshot()
    assert.equal(converged.state.status, 'failed')
    fs.rmSync(workflowStore.paths.statePath)

    const journal = await registry.resolveJournalHandle({
      context: {
        contractVersion: 1,
        requestId: 'rebuild-ac5b',
        sessionId: running.sessionId,
        runId: running.runId,
        assignmentId: running.assignmentId ?? running.runId,
        agentPath: 'workflows/runner',
        authority: { kind: 'runtime-assignment', processIdentity: 'rebuild' },
      },
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 10_000,
    })
    assert.ok(journal)
    await rebuildWorkflowStateProjection(journal, workflowStore)

    const rebuilt = await workflowStore.requireSnapshot()
    assert.equal(
      rebuilt.state.status,
      'failed',
      'a rebuild from the journal must not lose the recovery failure',
    )
    assert.equal(
      rebuilt.state.terminalOutcome?.summary,
      'Receipt validation failed after child execution.',
      'and must carry the failure summary recovery recorded',
    )
  } finally {
    await registry.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

/**
 * AC5's error-handling requirement (plan §6, "Error handling that must change
 * with it"): both cancel sites swallow every error today — a bare `catch {}`
 * in `services/task-service.ts` and a logged-and-return in the recovery
 * manager. The task CAS stays the cancellation authority, so swallowing is
 * right; discarding the fact is not. A journal failure means the durable
 * record and the task record now disagree, and an operator has to be able to
 * see that.
 */

/** The divergence index the operator report reads, if one was recorded. */
function readDivergenceRecord(assignmentPath: string): Record<string, unknown> | null {
  const recordPath = path.join(
    assignmentPath,
    '.runtime',
    'journal-divergence.json',
  )
  if (!fs.existsSync(recordPath)) return null
  return JSON.parse(fs.readFileSync(recordPath, 'utf8')) as Record<string, unknown>
}

/** Runtime events this assignment logged. */
function readRuntimeEvents(assignmentPath: string): Record<string, unknown>[] {
  const eventPath = path.join(assignmentPath, 'logs', 'runtime-events.jsonl')
  if (!fs.existsSync(eventPath)) return []
  return fs
    .readFileSync(eventPath, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

test('a cancellation that cannot reach the journal reports the divergence at both sites', async () => {
  const workspacePath = makeWorkspace()
  const registry = makeJournalRegistry(workspacePath)
  const store = new FileSystemSessionStore(workspacePath)
  store.useExecutionJournalRegistry(registry)
  const session = await store.createSession({ title: 'AC5 divergence' })
  const task = await createTask(store, session.id)
  const executionAttemptId = randomUUID()
  await persistTaskStatus({
    store,
    sessionId: session.id,
    task,
    status: 'running',
    executionAttemptId,
  })
  const running = await store.getTaskRecord(session.id, task.id)
  assert.ok(running?.assignmentPath)
  await initializeRunningJournal({
    task: running,
    executionAttemptId,
    recoveryPolicy: 'safe_retry',
  })
  await enrolAssignmentJournal(registry, running)

  try {
    // The assignment is enrolled and its journal is now unreachable, which is
    // exactly the state in which silence is most expensive.
    await registry.close()

    const cancelled = await cancelSessionTask({
      sessionId: session.id,
      taskId: task.id,
      sessionStore: store,
      isProcessAlive: () => false,
      executionJournalRegistry: registry,
    })
    assert.equal(
      cancelled?.status,
      'cancelled',
      'the task CAS stays the cancellation authority',
    )

    const events = readRuntimeEvents(running.assignmentPath)
      .filter((event) => event.event === 'workflow.journal_divergence')
    const sites = new Set(events.map((event) => event.site))
    assert.deepEqual(
      [...sites].sort(),
      ['task-cancellation', 'terminal-reconciliation'],
      `both cancel sites must emit a distinct divergence diagnostic; saw ${JSON.stringify(events)}`,
    )

    const record = readDivergenceRecord(running.assignmentPath)
    assert.ok(
      record,
      'the divergence must be indexed where the operator report can read it',
    )
    assert.equal(record.taskId, task.id)
    assert.match(String(record.detail), /unavailable/i)

    // And it fails closed: the projection is not advanced without its journal.
    const snapshot = await new FileSystemWorkflowStateStore(
      running.assignmentPath,
    ).requireSnapshot()
    assert.notEqual(
      snapshot.state.status,
      'cancelled',
      'a journal that cannot be reached must not leave the projection ahead of it',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
