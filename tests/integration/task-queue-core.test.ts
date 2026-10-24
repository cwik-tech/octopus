import { whenDefined } from '../../core/optional-properties.js'
import { requiredValue } from '../../core/required-value.js'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type { RunLauncher } from '../../domains/run/run-launcher.js'
import type { RunStartRequest } from '../../domains/run/run-store.js'
import type { RunPlan } from '../../contracts/run-plan.js'
import { DEFAULT_MAXIMUM_CONCURRENT_TASKS } from '../../domains/scheduling/scheduling-settings.js'
import { SchedulingSettingsService } from '../../services/scheduling-settings-service.js'
import { ServiceError } from '../../services/service-errors.js'
import { cancelSessionTask } from '../../services/task-service.js'
import { TaskQueue } from '../../services/task-queue.js'
import { WorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'
import { initializeExecutionJournal } from '../../core/execution-journal.js'
import { buildDurableWorkflowTerminalOutcome } from '../../workflows/results.js'
import { resolveWorkflowJournalRecorder } from '../../services/workflow-journal-recorder.js'
import type { WorkflowJournalRecorder } from '../../workflows/workflow-journal.js'
import {
  FileSystemSessionStore,
  type FileSystemSessionStoreOptions,
} from '../../domains/sessions/session-store.js'
import { SessionTaskRunnerLauncher } from '../../domains/sessions/session-task-launcher.js'
import { currentAttemptScope } from '../support/current-attempt-scope.js'
import {
  FileSystemWorkflowStateStore,
  hashHumanInputSubmission,
  hashWorkflowContent,
} from '../../workflows/workflow-state-store.js'
import type { DurableWorkflowState } from '../../workflows/types.js'
import type {
  SessionTask,
  TaskAdmission,
  TaskStatus,
} from '../../contracts/sessions.js'
import { WorkspaceDispatcherOwner } from '../../core/workspace-dispatcher-owner.js'
import { TASK_QUEUE_EVENT_FILENAME } from '../../core/task-queue-events.js'
import { withinBound } from '../support/fixture-process-markers.js'
import {
  defaultIsProcessAlive,
  PROCESS_IDENTITY_ARGUMENT,
  taskProcessTarget,
} from '../../domains/sessions/task-process-supervisor.js'

const TEST_TICK_INTERVAL_MS = 60_000

class BlockingLauncher implements RunLauncher {
  readonly starts: Array<{ taskId: string; processIdentity?: string }> = []
  private startWaiters: Array<{ readonly count: number; readonly resolve: () => void }> = []

  /** Resolves once `count` launches have reached this launcher. */
  started(count: number): Promise<void> {
    if (this.starts.length >= count) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.startWaiters.push({ count, resolve })
    })
  }

  async startRun(request: RunStartRequest): Promise<never> {
    const taskId = request.env?.TEAM_RUNTIME_TASK_ID
    if (!taskId) throw new Error('Task launch request is missing TEAM_RUNTIME_TASK_ID')
    this.starts.push({ taskId, ...whenDefined(request.processIdentity, (processIdentity) => ({ processIdentity: processIdentity })) })
    const reached = this.startWaiters.filter((waiter) => this.starts.length >= waiter.count)
    this.startWaiters = this.startWaiters.filter((waiter) => this.starts.length < waiter.count)
    for (const waiter of reached) waiter.resolve()
    return await new Promise<never>(() => undefined)
  }
}

interface LaunchPause {
  entered: Promise<void>
  release: () => void
}

class PausingRealLauncher implements RunLauncher {
  private readonly delegate = new SessionTaskRunnerLauncher(process.cwd())
  private nextLaunchPause:
    | {
        entered: ReturnType<typeof deferred>
        release: ReturnType<typeof deferred>
      }
    | undefined

  pauseNextLaunch(): LaunchPause {
    if (this.nextLaunchPause) throw new Error('A launch pause is already armed')
    const entered = deferred()
    const release = deferred()
    this.nextLaunchPause = { entered, release }
    return {
      entered: entered.promise,
      release: release.resolve,
    }
  }

  async startRun(request: RunStartRequest) {
    const pause = this.nextLaunchPause
    this.nextLaunchPause = undefined
    if (pause) {
      pause.entered.resolve()
      await pause.release.promise
    }
    return this.delegate.startRun(request)
  }
}

interface QueueHarness {
  workspacePath: string
  sessionStore: FileSystemSessionStore
  owner: WorkspaceDispatcherOwner
  launcher: BlockingLauncher
  taskQueue: TaskQueue
}

interface RealQueueHarness {
  workspacePath: string
  sessionStore: FileSystemSessionStore
  owner: WorkspaceDispatcherOwner
  launcher: PausingRealLauncher
  taskQueue: TaskQueue
  settingsService: SchedulingSettingsService
}

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'task-queue-core-'))
}

async function createHarness(
  maximumConcurrentTasks: number,
  sessionStoreOptions: FileSystemSessionStoreOptions = {},
): Promise<QueueHarness> {
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath, {
    instanceId: `queue-test-${Date.now()}`,
    ...sessionStoreOptions,
  })
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new BlockingLauncher()
  const taskQueue = new TaskQueue({
    sessionStore,
    owner,
    maximumConcurrentTasks,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
  })
  await taskQueue.initialize()
  return { workspacePath, sessionStore, owner, launcher, taskQueue }
}

async function destroyHarness(harness: QueueHarness): Promise<void> {
  await harness.taskQueue.close(1)
  await harness.owner.release()
  fs.rmSync(harness.workspacePath, { recursive: true, force: true })
}

async function initializeSubmittedHumanInputJournal(params: {
  task: SessionTask
  executionAttemptId: string
}): Promise<void> {
  assert.ok(params.task.assignmentPath)
  const stateStore = new FileSystemWorkflowStateStore(params.task.assignmentPath)
  const sourceChildRunId = randomUUID()
  await stateStore.initialize({
    manifest: {
      taskId: params.task.id,
      sessionId: params.task.sessionId,
      rootRunId: params.task.runId,
      workflowId: params.task.workflowId,
      workflowDefinitionHash: hashWorkflowContent('queue-waiting-workflow:v1'),
      briefHash: hashWorkflowContent(params.task.brief),
      teamDefinitionHashes: { writers: hashWorkflowContent('writers:v1') },
      runtimeVersion: 'workflow-runtime-v1',
    },
    executionAttemptId: params.executionAttemptId,
    steps: [
      {
        stepId: 'human-feedback',
        stepIndex: 0,
        stepType: 'human-in-the-loop',
        definitionHash: hashWorkflowContent('queue-human-feedback:v1'),
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
        definitionHash: hashWorkflowContent('queue-write:v1'),
        recoveryPolicy: 'safe_retry',
        inputArtifact: 'incoming-brief.md',
        resultArtifact: 'report.md',
        requestedResultType: 'artifact:report.md',
      },
    ],
  })
  const waiting = await stateStore.requestHumanInput({
    expectedRevision: 0,
    executionAttemptId: params.executionAttemptId,
    stepId: 'human-feedback',
    interactionId: randomUUID(),
    sourceArtifact: {
      childRunId: sourceChildRunId,
      relativePath: 'round-one.md',
      sha256: hashWorkflowContent('round one'),
      byteLength: 'round one'.length,
    },
    successorStepId: 'write',
    eligibleRecipients: [],
  })
  const interaction = waiting.steps[0]!.humanInput
  assert.ok(interaction)
  const submissionId = randomUUID()
  const messageId = randomUUID()
  const messages = [{ id: messageId, text: 'Please continue.', recipients: 'all' as const }]
  await stateStore.submitHumanInput({
    expectedRevision: waiting.revision,
    interactionId: interaction.interactionId,
    expectedSourceArtifactSha256: interaction.sourceArtifact.sha256,
    submission: {
      submissionId,
      mode: 'feedback',
      messages,
      submittedAt: new Date().toISOString(),
      canonicalHash: hashHumanInputSubmission({
        submissionId: submissionId,
        mode: 'feedback',
        messages,
      }),
    },
  })
}

async function createRealQueueHarness(
  maximumConcurrentTasks: number,
): Promise<RealQueueHarness> {
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath, {
    instanceId: `real-queue-test-${Date.now()}`,
  })
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new PausingRealLauncher()
  const taskQueue = new TaskQueue({
    sessionStore,
    owner,
    maximumConcurrentTasks,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
  })
  const settingsService = new SchedulingSettingsService({
    storagePath: path.join(workspacePath, 'task-queue', 'settings.json'),
    environment: {},
  })
  await settingsService.updateMaximumConcurrentTasks(maximumConcurrentTasks)
  await taskQueue.initialize()
  return {
    workspacePath,
    sessionStore,
    owner,
    launcher,
    taskQueue,
    settingsService,
  }
}

async function destroyRealQueueHarness(harness: RealQueueHarness): Promise<void> {
  await harness.taskQueue.close(1)
  const tasks = await harness.sessionStore.listTaskRecordsStrict()
  const processTargets = new Set<number>()
  for (const task of tasks) {
    const target = taskProcessTarget(task)
    if (target !== null) processTargets.add(target)
    if (
      task.status === 'done' ||
      task.status === 'failed' ||
      task.status === 'blocked' ||
      task.status === 'cancelled'
    ) {
      continue
    }
    await cancelSessionTask({
      sessionId: task.sessionId,
      taskId: task.id,
      sessionStore: harness.sessionStore,
    }).catch(() => undefined)
  }
  await waitFor(
    () => [...processTargets].every((target) => !defaultIsProcessAlive(target)),
    'real queue worker cleanup',
    5_000,
  ).catch(() => {
    for (const target of processTargets) {
      if (!defaultIsProcessAlive(target)) continue
      try {
        process.kill(target, 'SIGKILL')
      } catch {
        // Best-effort cleanup after a failed assertion.
      }
    }
  })
  await harness.owner.release()
  fs.rmSync(harness.workspacePath, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 20,
  })
}

async function createInterruptedTasks(
  store: FileSystemSessionStore,
  sessionId: string,
  count: number,
): Promise<SessionTask[]> {
  const tasks: SessionTask[] = []
  for (let index = 0; index < count; index += 1) {
    const task = await store.createTaskRecord(sessionId, {
      workflowId: 'queue-contract-workflow',
      brief: `Queue contract task ${index + 1}.`,
    })
    assert.ok(task)
    const previousAttemptId = `previous-attempt-${task.id}`
    const interrupted = await store.compareAndSetTaskRecord(
      sessionId,
      task.id,
      ['queued'],
      {
        status: 'interrupted',
        processIdentity: previousAttemptId,
        executionAttemptId: previousAttemptId,
        executionAttemptNumber: 1,
        ...await currentAttemptScope(task, 1),
        executionKind: 'initial',
        interruptedAt: new Date().toISOString(),
        recoveryDisposition: 'manual',
        recoveryReason: 'Queued by the task queue contract test.',
      },
      { expectedExecutionAttemptId: null },
    )
    assert.equal(interrupted?.updated, true)
    tasks.push(interrupted!.task)
  }
  return tasks
}

async function enqueueRecoveries(
  queue: TaskQueue,
  tasks: readonly SessionTask[],
): Promise<SessionTask[]> {
  const admitted: SessionTask[] = []
  for (const task of tasks) {
    admitted.push(await queue.enqueueRecovery({
      sessionId: task.sessionId,
      taskId: task.id,
      source: 'manual_resume',
    }))
  }
  return admitted
}

async function cancelAndWake(
  harness: QueueHarness,
  task: Pick<SessionTask, 'sessionId' | 'id'>,
): Promise<SessionTask> {
  const cancelled = await cancelSessionTask({
    sessionId: task.sessionId,
    taskId: task.id,
    sessionStore: harness.sessionStore,
  })
  assert.ok(cancelled)
  harness.taskQueue.wake()
  return cancelled
}

async function cancelVerifiedRealTask(
  store: FileSystemSessionStore,
  task: Pick<SessionTask, 'sessionId' | 'id'>,
): Promise<SessionTask> {
  const deadline = Date.now() + 3_000
  let lastIdentityError: ServiceError | undefined
  while (Date.now() < deadline) {
    try {
      const cancelled = await cancelSessionTask({
        sessionId: task.sessionId,
        taskId: task.id,
        sessionStore: store,
      })
      assert.ok(cancelled)
      return cancelled
    } catch (error) {
      if (
        !(error instanceof ServiceError) ||
        error.code !== 'internal' ||
        !error.message.includes('live process identity could not be verified')
      ) {
        throw error
      }
      lastIdentityError = error
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
  }
  throw lastIdentityError ?? new Error('Timed out retrying verified task cancellation')
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function waitForStarts(launcher: BlockingLauncher, count: number): Promise<void> {
  await waitFor(
    () => launcher.starts.length >= count,
    `${count} task launches`,
  )
}

/** Only a safety net: the waits below end on what the queue and the launcher do. */
const EVENT_BOUND_MS = 20_000

/** Resolves once the launcher has received `count` launches. */
async function launchesReach(harness: QueueHarness, count: number): Promise<void> {
  await withinBound(harness.launcher.started(count), EVENT_BOUND_MS, `${count} task launches`)
}

/** The events of one kind the queue has recorded in its event file. */
function queueEventsNamed(harness: QueueHarness, name: string): Array<Record<string, unknown>> {
  const eventPath = path.join(harness.workspacePath, 'task-queue', TASK_QUEUE_EVENT_FILENAME)
  if (!fs.existsSync(eventPath)) return []
  return fs.readFileSync(eventPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line): unknown => JSON.parse(line))
    .filter((event): event is Record<string, unknown> =>
      typeof event === 'object' && event !== null && !Array.isArray(event) && Reflect.get(event, 'event') === name)
}

/**
 * Resolves with `read()` once it matches, reading again on every change in
 * `folder`: a write the queue makes. The bound is only a safety net.
 */
async function waitForChange<T>(
  description: string,
  folder: string,
  read: () => T,
  matches: (value: T) => boolean,
): Promise<T> {
  let watcher: fs.FSWatcher | undefined
  const reached = new Promise<T>((resolve, reject) => {
    const check = (): void => {
      try {
        const latest = read()
        if (matches(latest)) resolve(latest)
      } catch (error) {
        reject(error)
      }
    }
    // Watched before the first read, so a change between the two is not missed.
    watcher = fs.watch(folder, check)
    watcher.on('error', reject)
    check()
  })
  try {
    return await withinBound(reached, EVENT_BOUND_MS, description)
  } finally {
    watcher?.close()
  }
}

/**
 * Resolves once the queue has recorded releasing the slot of every one of
 * `released`, and a locked read has followed the pass that released the last:
 * that pass decided whether to grant the freed slot under the same lock. It
 * then waits until every grant recorded by then has reached the launcher, so
 * what the launcher has started is a fact rather than a guess about timing.
 *
 * Not `whenIdle()`: while a launch is in flight, as every launch of this
 * launcher stays, each pass hands the task to recovery and wakes the queue
 * again, so the queue is never idle.
 */
async function releasedAndSettled(harness: QueueHarness, released: readonly SessionTask[]): Promise<void> {
  await waitForChange(
    'the queue to release the cancelled tasks\' slots',
    path.join(harness.workspacePath, 'task-queue'),
    () => new Set(queueEventsNamed(harness, 'task_queue.released').map((event) => event.task_id)),
    (ids) => released.every((task) => ids.has(task.id)),
  )
  await withinBound(harness.taskQueue.snapshot(), EVENT_BOUND_MS, 'a locked read after the release')
  await launchesReach(harness, queueEventsNamed(harness, 'task_queue.granted').length)
}

async function waitForLiveWorker(
  store: FileSystemSessionStore,
  task: Pick<SessionTask, 'sessionId' | 'id'>,
): Promise<SessionTask> {
  let current: SessionTask | null = null
  await waitFor(async () => {
    current = await store.getTaskRecord(task.sessionId, task.id)
    if (current?.admission?.phase !== 'granted') return false
    const target = taskProcessTarget(current)
    return target !== null && defaultIsProcessAlive(target)
  }, `a live worker for task ${task.id}`, 12_000)
  assert.ok(current)
  return current
}

function useRealQueueWorkerEnvironment(): () => void {
  const previousDryRun = process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN
  const previousDelay = process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS
  process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN = '1'
  process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS = '30000'
  return () => {
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
  }
}

async function killRealTaskWorker(task: SessionTask): Promise<void> {
  const target = taskProcessTarget(task)
  assert.notEqual(target, null)
  process.kill(target!, 'SIGKILL')
  await waitFor(
    () => !defaultIsProcessAlive(target!),
    `worker process for task ${task.id} to exit`,
    5_000,
  )
}

async function settleDispatch(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}

async function readTasks(
  store: FileSystemSessionStore,
  tasks: readonly SessionTask[],
): Promise<SessionTask[]> {
  return Promise.all(tasks.map(async (task) => {
    const current = await store.getTaskRecord(task.sessionId, task.id)
    assert.ok(current)
    return current
  }))
}

function pendingAdmission(order: string): Extract<TaskAdmission, { phase: 'pending' }> {
  return {
    version: 1,
    phase: 'pending',
    requestId: `pending-request-${order}`,
    order,
    requestedAt: new Date().toISOString(),
    executionKind: 'initial',
    source: 'startup_repair',
    expectedExecutionAttemptId: null,
  }
}

function grantedAdmission(params: {
  order: string
  executionAttemptId: string
  ownerEpoch: string
}): Extract<TaskAdmission, { phase: 'granted' }> {
  return {
    version: 1,
    phase: 'granted',
    requestId: `granted-request-${params.order}`,
    order: params.order,
    requestedAt: new Date().toISOString(),
    executionKind: 'initial',
    source: 'startup_repair',
    expectedExecutionAttemptId: null,
    grantId: `grant-${params.executionAttemptId}`,
    ownerEpoch: params.ownerEpoch,
    grantedAt: new Date().toISOString(),
    executionAttemptId: params.executionAttemptId,
  }
}

function grantedAdmissionFence(task: SessionTask) {
  assert.equal(task.admission?.phase, 'granted')
  const admission = task.admission
  return {
    expectedExecutionAttemptId: requiredValue(
      task.executionAttemptId,
      'granted task execution attempt id',
    ),
    expectedAdmissionRequestId: admission.requestId,
    expectedAdmissionPhase: 'granted' as const,
    expectedAdmissionGrantId: admission.grantId,
    expectedAdmissionOwnerEpoch: admission.ownerEpoch,
  }
}

test('a human-input continuation requeues an awaiting task without incrementing recovery', async () => {
  const harness = await createHarness(1)
  try {
    const session = await harness.sessionStore.createSession({
      title: 'Human-input continuation',
    })
    const task = await harness.sessionStore.createTaskRecord(session.id, {
      workflowId: 'queue-contract-workflow',
      brief: 'Resume after durable human feedback.',
    })
    assert.ok(task)
    const waiting = await harness.sessionStore.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['queued'],
      {
        status: 'awaiting_input',
        executionAttemptId: 'attempt-before-feedback',
        processIdentity: 'attempt-before-feedback',
        executionAttemptNumber: 1,
        executionKind: 'initial',
        recoveryCount: 3,
      },
      { expectedExecutionAttemptId: null },
    )
    assert.equal(waiting?.updated, true)

    const admitted = await harness.taskQueue.enqueueContinuation({
      sessionId: session.id,
      taskId: task.id,
    })
    assert.equal(admitted.status, 'awaiting_input')
    assert.equal(admitted.admission?.executionKind, 'continuation')
    assert.equal(admitted.admission?.source, 'human_input')
    assert.equal(admitted.recoveryCount, 3)

    await waitForStarts(harness.launcher, 1)
    const granted = await harness.sessionStore.getTaskRecord(session.id, task.id)
    assert.equal(granted?.status, 'queued')
    assert.equal(granted?.executionKind, 'continuation')
    assert.equal(granted?.admission?.phase, 'granted')
    assert.equal(granted?.recoveryCount, 3)
  } finally {
    await destroyHarness(harness)
  }
})

test('startup ignores an approval owned by a different execution attempt', async () => {
  // The workflow's owner and the task's owner must agree before anything is
  // staged. A disagreement means this task is not the one that workflow is
  // waiting on, and admitting it would run somebody else's approval.
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath, {
    instanceId: `queue-choice-owner-${Date.now()}`,
  })
  const session = await sessionStore.createSession({ title: 'Mismatched owner' })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'queue-owner-mismatch-model-choice',
    brief: 'Do not adopt another attempt approval.',
  })
  assert.ok(task)
  const executionAttemptId = randomUUID()
  await sessionStore.compareAndSetTaskRecord(
    session.id,
    task.id,
    ['queued'],
    {
      status: 'awaiting_model_choice',
      executionAttemptId,
      processIdentity: executionAttemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      recoveryCount: 0,
    },
    { expectedExecutionAttemptId: null },
  )
  // The workflow records a different owner than the task does.
  await initializeApprovedModelChoiceJournal({
    task,
    executionAttemptId: `${executionAttemptId}-other`,
  })

  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new BlockingLauncher()
  const taskQueue = new TaskQueue({
    sessionStore: new FileSystemSessionStore(workspacePath, {
      instanceId: `queue-choice-owner-target-${Date.now()}`,
    }),
    owner,
    maximumConcurrentTasks: 1,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
  })
  try {
    await taskQueue.initialize()

    const settled = await sessionStore.getTaskRecord(session.id, task.id)
    assert.equal(settled?.status, 'awaiting_model_choice')
    assert.equal(settled?.admission, undefined, 'nothing was staged')
    assert.equal(launcher.starts.length, 0, 'nothing was launched')
  } finally {
    await taskQueue.close(1)
    await owner.release()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('startup leaves an approval that was already continued alone', async () => {
  // One approval admits one continuation. A crash *after* the admission leaves
  // a receipt on the step, and staging it again would run the approved retry a
  // second time on a permission the user gave once.
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath, {
    instanceId: `queue-choice-consumed-${Date.now()}`,
  })
  const session = await sessionStore.createSession({ title: 'Consumed model choice' })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'queue-consumed-model-choice',
    brief: 'Do not continue twice.',
  })
  assert.ok(task)
  const executionAttemptId = randomUUID()
  await sessionStore.compareAndSetTaskRecord(
    session.id,
    task.id,
    ['queued'],
    {
      status: 'awaiting_model_choice',
      executionAttemptId,
      processIdentity: executionAttemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      recoveryCount: 0,
    },
    { expectedExecutionAttemptId: null },
  )
  await initializeApprovedModelChoiceJournal({
    task,
    executionAttemptId,
    admissionRequestId: 'admission-1',
  })
  // The claim moved the workflow's owner, so the task's owner moves with it.
  // Left mismatched, this test would pass because the owners disagree rather
  // than because the approval was already spent, and the receipt guard it
  // exists to protect would go uncovered.
  await sessionStore.compareAndSetTaskRecord(
    session.id,
    task.id,
    ['awaiting_model_choice'],
    { executionAttemptId: `${executionAttemptId}-continued` },
    { expectedExecutionAttemptId: executionAttemptId },
  )

  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new BlockingLauncher()
  const taskQueue = new TaskQueue({
    sessionStore: new FileSystemSessionStore(workspacePath, {
      instanceId: `queue-choice-consumed-target-${Date.now()}`,
    }),
    owner,
    maximumConcurrentTasks: 1,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
  })
  try {
    await taskQueue.initialize()

    const settled = await sessionStore.getTaskRecord(session.id, task.id)
    assert.equal(settled?.status, 'awaiting_model_choice')
    assert.equal(settled?.admission, undefined, 'nothing was staged')
    assert.equal(launcher.starts.length, 0, 'nothing was launched')
  } finally {
    await taskQueue.close(1)
    await owner.release()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('startup stages an approved model choice that crashed before admission', async () => {
  // Approval and admission are two writes. A crash between them leaves an
  // approval nobody acted on: the workflow has the permission the user gave,
  // and the queue has nothing to run. Without this the run waits forever on a
  // decision that has already been made.
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath, {
    instanceId: `queue-choice-source-${Date.now()}`,
  })
  const session = await sessionStore.createSession({ title: 'Approved model choice restart' })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'queue-approved-model-choice',
    brief: 'Continue after an approved model choice.',
  })
  assert.ok(task)
  const executionAttemptId = randomUUID()
  const waiting = await sessionStore.compareAndSetTaskRecord(
    session.id,
    task.id,
    ['queued'],
    {
      status: 'awaiting_model_choice',
      executionAttemptId,
      processIdentity: executionAttemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      recoveryCount: 0,
    },
    { expectedExecutionAttemptId: null },
  )
  assert.equal(waiting?.updated, true)
  await initializeApprovedModelChoiceJournal({ task, executionAttemptId })

  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new BlockingLauncher()
  const taskQueue = new TaskQueue({
    sessionStore: new FileSystemSessionStore(workspacePath, {
      instanceId: `queue-choice-target-${Date.now()}`,
    }),
    owner,
    maximumConcurrentTasks: 1,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
  })
  try {
    await taskQueue.initialize()

    await waitForStarts(launcher, 1)
    const resumed = await sessionStore.getTaskRecord(session.id, task.id)
    assert.equal(resumed?.status, 'queued')
    assert.equal(resumed?.executionKind, 'continuation')
    assert.equal(resumed?.admission?.phase, 'granted')
    // Named for what it is: an approval, not a recovery, so nothing counts
    // this against the run's recovery budget.
    assert.equal(resumed?.recoveryCount, 0)
  } finally {
    await taskQueue.close(1)
    await owner.release()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('startup stages a submitted human-input continuation that crashed before admission', async () => {
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath, {
    instanceId: `queue-restart-source-${Date.now()}`,
  })
  const session = await sessionStore.createSession({ title: 'Submitted human input restart' })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'queue-submitted-human-input',
    brief: 'Continue after persisted feedback.',
  })
  assert.ok(task)
  const executionAttemptId = randomUUID()
  const waiting = await sessionStore.compareAndSetTaskRecord(
    session.id,
    task.id,
    ['queued'],
    {
      status: 'awaiting_input',
      executionAttemptId,
      processIdentity: executionAttemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      recoveryCount: 0,
    },
    { expectedExecutionAttemptId: null },
  )
  assert.equal(waiting?.updated, true)
  await initializeSubmittedHumanInputJournal({ task, executionAttemptId })

  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new BlockingLauncher()
  const taskQueue = new TaskQueue({
    sessionStore: new FileSystemSessionStore(workspacePath, {
      instanceId: `queue-restart-target-${Date.now()}`,
    }),
    owner,
    maximumConcurrentTasks: 1,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
  })
  try {
    await taskQueue.initialize()

    await waitForStarts(launcher, 1)
    const resumed = await sessionStore.getTaskRecord(session.id, task.id)
    assert.equal(resumed?.status, 'queued')
    assert.equal(resumed?.executionKind, 'continuation')
    assert.equal(resumed?.admission?.phase, 'granted')
    assert.equal(resumed?.recoveryCount, 0)
  } finally {
    await taskQueue.close(1)
    await owner.release()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

/**
 * A workflow that asked for a model choice and got one, with nothing having
 * acted on it yet — the state a crash between approval and admission leaves.
 */
async function initializeApprovedModelChoiceJournal(params: {
  task: SessionTask
  executionAttemptId: string
  /** Set to model a continuation that was already admitted before the crash. */
  admissionRequestId?: string
  /** Given when the approval must land in a canonical journal, not just a projection. */
  journal?: { readonly journal?: WorkflowJournalRecorder }
  /** Set to leave the approved step terminal, with nothing left to continue. */
  blockStep?: boolean
}): Promise<void> {
  assert.ok(params.task.assignmentPath)
  const stateStore = new FileSystemWorkflowStateStore(
    params.task.assignmentPath,
    params.journal,
  )
  await stateStore.initialize({
    manifest: {
      taskId: params.task.id,
      sessionId: params.task.sessionId,
      rootRunId: params.task.runId,
      workflowId: params.task.workflowId,
      workflowDefinitionHash: hashWorkflowContent('queue-model-choice-workflow:v1'),
      briefHash: hashWorkflowContent(params.task.brief),
      teamDefinitionHashes: { writers: hashWorkflowContent('writers:v1') },
      runtimeVersion: 'workflow-runtime-v1',
    },
    executionAttemptId: params.executionAttemptId,
    steps: [
      {
        stepId: 'write',
        stepIndex: 0,
        stepType: 'team',
        team: 'writers',
        definitionHash: hashWorkflowContent('queue-write:v1'),
        recoveryPolicy: 'safe_retry',
        inputArtifact: 'incoming-brief.md',
        resultArtifact: 'report.md',
        requestedResultType: 'artifact:report.md',
      },
    ],
  })
  let revision = 0
  const advance = async (mutate: (draft: DurableWorkflowState) => void) => {
    await stateStore.update({
      expectedRevision: revision,
      executionAttemptId: params.executionAttemptId,
      mutate,
    })
    revision += 1
  }
  await advance((draft) => {
    draft.steps[0]!.status = 'launching'
    draft.steps[0]!.attemptCount = 1
    draft.steps[0]!.startedAt = new Date().toISOString()
  })
  await advance((draft) => {
    draft.steps[0]!.status = 'running'
  })
  await advance((draft) => {
    draft.status = 'awaiting_model_choice'
    draft.steps[0]!.status = 'awaiting_model_choice'
    draft.steps[0]!.modelChoice = {
      offerId: 'offer-1',
      scope: {
        kind: 'task',
        sessionId: params.task.sessionId,
        taskId: params.task.id,
      },
      agentName: 'writer',
      expectedRevision: '3',
      logicalInvocationId: 'write',
      failedChoice: { provider: 'anthropic', model: 'claude-opus-4-6' },
      proposedDefault: { provider: 'connection:abc', model: 'gpt-5.4-mini' },
      reason: 'missing-credential',
    }
  })
  const approved = await stateStore.approveModelChoice({
    expectedRevision: revision,
    offerId: 'offer-1',
  })
  if (params.blockStep) {
    // A step that ended blocked has finished. It is terminal exactly as
    // `failed` is, so its approval has nothing left to continue.
    await stateStore.update({
      expectedRevision: approved.revision,
      executionAttemptId: params.executionAttemptId,
      mutate(draft) {
        const step = draft.steps.find((candidate) => candidate.stepId === 'write')
        assert.ok(step)
        step.status = 'blocked'
        step.error = 'The step could not proceed.'
        step.completedAt = new Date().toISOString()
        // Terminal the way the runner leaves it: the workflow's own outcome is
        // committed and no step is current, not a step marked blocked under a
        // workflow that is still running.
        draft.status = 'blocked'
        draft.terminalOutcome = buildDurableWorkflowTerminalOutcome({
          workflowId: params.task.workflowId,
          status: 'blocked',
          summary: 'The step could not proceed.',
          requestedResultType: 'artifact:report.md',
          outputStepId: 'write',
        })
        delete draft.currentStepId
      },
    })
    return
  }
  if (params.admissionRequestId) {
    await stateStore.claimModelChoiceContinuation({
      expectedRevision: approved.revision,
      stepId: 'write',
      expectedOwnerExecutionAttemptId: params.executionAttemptId,
      nextExecutionAttemptId: `${params.executionAttemptId}-continued`,
      continuationAdmissionRequestId: params.admissionRequestId,
    })
  }
}

function deferred(): {
  promise: Promise<void>
  resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function readyPlan(id: string): RunPlan {
  return {
    id,
    goal: 'Exercise startup admission repair.',
    summary: 'Queue repair plan',
    status: 'ready',
    selectedWorkflow: {
      id: 'queue-contract-workflow',
      rationale: 'Explicit queue repair fixture.',
      confidence: 'high',
    },
    requiredInputs: [],
    brief: 'Repair the staged queue admission.',
    actions: [
      {
        id: 'launch-workflow',
        type: 'launch_workflow',
        status: 'ready',
        title: 'Launch workflow',
        rationale: 'Exercise durable startup repair.',
        workflowId: 'queue-contract-workflow',
      },
    ],
    warnings: [],
    createdAt: new Date().toISOString(),
  }
}

test('the default cap grants three admissions concurrently and leaves the fourth pending', async () => {
  const harness = await createHarness(DEFAULT_MAXIMUM_CONCURRENT_TASKS)
  try {
    const session = await harness.sessionStore.createSession({ title: 'Default queue cap' })
    const tasks = await createInterruptedTasks(harness.sessionStore, session.id, 4)
    await enqueueRecoveries(harness.taskQueue, tasks)

    await waitForStarts(harness.launcher, DEFAULT_MAXIMUM_CONCURRENT_TASKS)
    await settleDispatch()
    const current = await readTasks(harness.sessionStore, tasks)

    assert.deepEqual(
      harness.launcher.starts.map((start) => start.taskId),
      tasks.slice(0, 3).map((task) => task.id),
    )
    assert.deepEqual(
      current.map((task) => task.admission?.phase),
      ['granted', 'granted', 'granted', 'pending'],
    )
    assert.equal(harness.taskQueue.maximumConcurrentTasks, 3)
  } finally {
    await destroyHarness(harness)
  }
})

test('the queue snapshot exposes live capacity and FIFO work without admission fences', async () => {
  const harness = await createHarness(1)
  try {
    const session = await harness.sessionStore.createSession({
      title: 'Queue snapshot contract',
    })
    const tasks = await createInterruptedTasks(harness.sessionStore, session.id, 3)
    await enqueueRecoveries(harness.taskQueue, tasks)
    await waitForStarts(harness.launcher, 1)

    let snapshot = await harness.taskQueue.snapshot()
    assert.equal(snapshot.version, 1)
    assert.equal(snapshot.status, 'ready')
    assert.equal(snapshot.maximumConcurrentTasks, 1)
    assert.equal(snapshot.slotsInUse, 1)
    assert.equal(snapshot.availableSlots, 0)
    assert.equal(snapshot.waitingCount, 2)
    assert.deepEqual(
      snapshot.items.map((item) => [item.taskId, item.state]),
      [
        [tasks[0]!.id, 'starting'],
        [tasks[1]!.id, 'waiting'],
        [tasks[2]!.id, 'waiting'],
      ],
    )
    assert.equal(snapshot.items[0]?.executionKind, 'recovery')
    assert.equal(snapshot.items[0]?.source, 'manual_resume')
    for (const privateField of [
      'requestId',
      'grantId',
      'ownerEpoch',
      'order',
      'pid',
      'processIdentity',
    ]) {
      assert.equal(JSON.stringify(snapshot).includes(privateField), false)
    }

    const granted = await harness.sessionStore.getTaskRecord(session.id, tasks[0]!.id)
    assert.ok(granted)
    const running = await harness.sessionStore.compareAndSetTaskRecord(
      session.id,
      granted.id,
      ['queued'],
      {
        status: 'running',
        workerStartedAt: new Date().toISOString(),
      },
      grantedAdmissionFence(granted),
    )
    assert.equal(running?.updated, true)
    const adoptedRunning = await harness.taskQueue.adoptDurableAdmission({
      sessionId: session.id,
      taskId: granted.id,
    })
    assert.equal(adoptedRunning.status, 'running')
    assert.equal((await harness.taskQueue.snapshot()).items[0]?.state, 'running')

    await cancelAndWake(harness, tasks[2]!)
    await waitFor(
      async () => (await harness.taskQueue.snapshot()).waitingCount === 1,
      'cancelled waiting task to leave the queue snapshot',
    )
    snapshot = await harness.taskQueue.snapshot()
    assert.deepEqual(
      snapshot.items.map((item) => item.taskId),
      [tasks[0]!.id, tasks[1]!.id],
    )
  } finally {
    await destroyHarness(harness)
  }
})

test('concurrent cross-session admissions receive unique monotonic ordinals', async () => {
  const harness = await createHarness(1)
  try {
    const [firstSession, secondSession] = await Promise.all([
      harness.sessionStore.createSession({ title: 'Ordinal session one' }),
      harness.sessionStore.createSession({ title: 'Ordinal session two' }),
    ])
    const [firstTasks, secondTasks] = await Promise.all([
      createInterruptedTasks(harness.sessionStore, firstSession.id, 2),
      createInterruptedTasks(harness.sessionStore, secondSession.id, 2),
    ])
    const tasks = [
      firstTasks[0]!,
      secondTasks[0]!,
      firstTasks[1]!,
      secondTasks[1]!,
    ]
    const admitted = await Promise.all(tasks.map((task) =>
      harness.taskQueue.enqueueRecovery({
        sessionId: task.sessionId,
        taskId: task.id,
        source: 'manual_resume',
      }),
    ))

    const orders = admitted.map((task) => BigInt(task.admission!.order))
    assert.deepEqual(
      [...orders].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
      [1n, 2n, 3n, 4n],
    )
    assert.equal(new Set(orders.map(String)).size, tasks.length)
    const persisted = await readTasks(harness.sessionStore, tasks)
    assert.deepEqual(
      persisted.map((task) => task.admission?.order),
      admitted.map((task) => task.admission?.order),
    )
  } finally {
    await destroyHarness(harness)
  }
})

test('FIFO handoff starts each next admission as the single slot releases', async () => {
  const harness = await createHarness(1)
  try {
    const session = await harness.sessionStore.createSession({ title: 'FIFO queue' })
    const tasks = await createInterruptedTasks(harness.sessionStore, session.id, 3)
    const admitted = await enqueueRecoveries(harness.taskQueue, tasks)
    assert.deepEqual(
      admitted.map((task) => task.admission?.order),
      ['1', '2', '3'],
    )

    await waitForStarts(harness.launcher, 1)
    assert.equal(harness.launcher.starts[0]?.taskId, tasks[0]?.id)
    await cancelAndWake(harness, tasks[0]!)
    await waitForStarts(harness.launcher, 2)
    assert.equal(harness.launcher.starts[1]?.taskId, tasks[1]?.id)
    await cancelAndWake(harness, tasks[1]!)
    await waitForStarts(harness.launcher, 3)
    assert.deepEqual(
      harness.launcher.starts.map((start) => start.taskId),
      tasks.map((task) => task.id),
    )
  } finally {
    await destroyHarness(harness)
  }
})

test('a wake during active dispatch is replayed after the current pass', async () => {
  const harness = await createHarness(1)
  const refreshEntered = deferred()
  const allowRefresh = deferred()
  const originalGetTaskRecord = harness.sessionStore.getTaskRecord.bind(harness.sessionStore)
  const storeWithBarrier = harness.sessionStore as unknown as {
    getTaskRecord(sessionId: string, taskId: string): Promise<SessionTask | null>
  }
  let pauseNextGrantedRead = false
  try {
    const session = await harness.sessionStore.createSession({ title: 'Replay queue wake' })
    const tasks = await createInterruptedTasks(harness.sessionStore, session.id, 2)
    await enqueueRecoveries(harness.taskQueue, tasks)
    await waitForStarts(harness.launcher, 1)
    await settleDispatch()

    storeWithBarrier.getTaskRecord = async (sessionId, taskId) => {
      const current = await originalGetTaskRecord(sessionId, taskId)
      if (pauseNextGrantedRead && taskId === tasks[0]!.id) {
        pauseNextGrantedRead = false
        refreshEntered.resolve()
        await allowRefresh.promise
      }
      return current
    }
    pauseNextGrantedRead = true
    harness.taskQueue.wake()
    await refreshEntered.promise

    const first = await originalGetTaskRecord(session.id, tasks[0]!.id)
    assert.ok(first)
    const completed = await harness.sessionStore.compareAndSetTaskRecord(
      session.id,
      first.id,
      [first.status],
      {
        status: 'done',
        admission: undefined,
        completedAt: new Date().toISOString(),
      },
      grantedAdmissionFence(first),
    )
    assert.equal(completed?.updated, true)

    harness.taskQueue.wake()
    allowRefresh.resolve()
    await waitForStarts(harness.launcher, 2)
    assert.equal(harness.launcher.starts[1]?.taskId, tasks[1]!.id)
  } finally {
    allowRefresh.resolve()
    storeWithBarrier.getTaskRecord = originalGetTaskRecord
    await destroyHarness(harness)
  }
})

test('live limit lowering drains without eviction and raising fills every new slot', async () => {
  // The blocking launcher never starts a worker, so after the 5 s default
  // grace recovery would reap the never-started launches as dead and free
  // their slots: a separate rule this test does not check. The grace is set
  // far beyond the test's run, which then does not depend on its pace.
  const harness = await createHarness(3, { staleTaskGraceMs: 10 * 60_000 })
  try {
    const session = await harness.sessionStore.createSession({ title: 'Live queue limit' })
    const tasks = await createInterruptedTasks(harness.sessionStore, session.id, 6)
    await enqueueRecoveries(harness.taskQueue, tasks)
    await launchesReach(harness, 3)

    let limitObservedDuringPersist: number | undefined
    const lowered = await harness.taskQueue.updateMaximumConcurrentTasks(1, async () => {
      limitObservedDuringPersist = harness.taskQueue.maximumConcurrentTasks
      return 'lowered'
    })
    assert.equal(lowered, 'lowered')
    assert.equal(limitObservedDuringPersist, 3)
    assert.equal(harness.taskQueue.maximumConcurrentTasks, 1)

    await cancelAndWake(harness, tasks[0]!)
    await cancelAndWake(harness, tasks[1]!)
    // Read once the queue has released both cancelled tasks' slots, has
    // decided what to grant in their place, and every grant it recorded has
    // reached the launcher. One running task holds the one slot the lowered
    // limit allows.
    await releasedAndSettled(harness, [tasks[0]!, tasks[1]!])
    const releasedTaskIds = new Set(queueEventsNamed(harness, 'task_queue.released').map((event) => event.task_id))
    assert.ok(
      releasedTaskIds.has(tasks[0]!.id) && releasedTaskIds.has(tasks[1]!.id),
      'both cancelled tasks released their slots',
    )
    assert.equal(harness.launcher.starts.length, 3)

    await cancelAndWake(harness, tasks[2]!)
    await launchesReach(harness, 4)
    assert.equal(harness.launcher.starts[3]?.taskId, tasks[3]?.id)

    const raised = await harness.taskQueue.updateMaximumConcurrentTasks(3, async () => {
      limitObservedDuringPersist = harness.taskQueue.maximumConcurrentTasks
      return 'raised'
    })
    assert.equal(raised, 'raised')
    assert.equal(limitObservedDuringPersist, 1)
    await launchesReach(harness, 6)
    assert.deepEqual(
      harness.launcher.starts.map((start) => start.taskId),
      tasks.map((task) => task.id),
    )
  } finally {
    await destroyHarness(harness)
  }
})

test(
  'a lower limit that wins the queue mutex keeps the next real worker pending',
  { timeout: 30_000, skip: process.platform === 'win32' },
  async () => {
    const restoreEnvironment = useRealQueueWorkerEnvironment()
    const allowPersistence = deferred()
    let harness: RealQueueHarness | undefined
    try {
      harness = await createRealQueueHarness(2)
      const session = await harness.sessionStore.createSession({
        title: 'Limit wins grant race',
      })
      const tasks = await createInterruptedTasks(harness.sessionStore, session.id, 2)
      await harness.taskQueue.enqueueRecovery({
        sessionId: session.id,
        taskId: tasks[0]!.id,
        source: 'manual_resume',
      })
      const firstWorker = await waitForLiveWorker(harness.sessionStore, tasks[0]!)
      const firstTarget = taskProcessTarget(firstWorker)
      assert.notEqual(firstTarget, null)

      const persistenceEntered = deferred()
      const lowering = harness.taskQueue.updateMaximumConcurrentTasks(1, async () => {
        persistenceEntered.resolve()
        await allowPersistence.promise
        return harness!.settingsService.updateMaximumConcurrentTasks(1)
      })
      await persistenceEntered.promise

      let admissionSettled = false
      const secondAdmission = harness.taskQueue.enqueueRecovery({
        sessionId: session.id,
        taskId: tasks[1]!.id,
        source: 'manual_resume',
      }).finally(() => {
        admissionSettled = true
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      assert.equal(admissionSettled, false)
      assert.equal(harness.taskQueue.maximumConcurrentTasks, 2)
      assert.equal(defaultIsProcessAlive(firstTarget!), true)

      allowPersistence.resolve()
      const [saved, admitted] = await Promise.all([lowering, secondAdmission])
      assert.equal(saved.maximumConcurrentTasks, 1)
      assert.equal(admitted.admission?.phase, 'pending')
      assert.equal(harness.taskQueue.maximumConcurrentTasks, 1)
      assert.equal((await harness.settingsService.snapshot()).maximumConcurrentTasks, 1)

      await settleDispatch()
      const current = await readTasks(harness.sessionStore, tasks)
      assert.deepEqual(
        current.map((task) => task.admission?.phase),
        ['granted', 'pending'],
      )
      assert.equal(current[1]?.pid, undefined)
      assert.equal(current[1]?.processGroupId, undefined)
      assert.equal(
        current.filter((task) => task.admission?.phase === 'granted').length,
        1,
      )
      assert.equal(defaultIsProcessAlive(firstTarget!), true)
    } finally {
      allowPersistence.resolve()
      if (harness) await destroyRealQueueHarness(harness)
      restoreEnvironment()
    }
  },
)

test(
  'a real reservation that wins the queue mutex remains active when the limit is lowered',
  { timeout: 30_000, skip: process.platform === 'win32' },
  async () => {
    const restoreEnvironment = useRealQueueWorkerEnvironment()
    let harness: RealQueueHarness | undefined
    let launchPause: LaunchPause | undefined
    try {
      harness = await createRealQueueHarness(2)
      const session = await harness.sessionStore.createSession({
        title: 'Grant wins limit race',
      })
      const tasks = await createInterruptedTasks(harness.sessionStore, session.id, 3)
      await harness.taskQueue.enqueueRecovery({
        sessionId: session.id,
        taskId: tasks[0]!.id,
        source: 'manual_resume',
      })
      const firstWorker = await waitForLiveWorker(harness.sessionStore, tasks[0]!)
      assert.notEqual(taskProcessTarget(firstWorker), null)

      launchPause = harness.launcher.pauseNextLaunch()
      const secondAdmission = await harness.taskQueue.enqueueRecovery({
        sessionId: session.id,
        taskId: tasks[1]!.id,
        source: 'manual_resume',
      })
      assert.equal(secondAdmission.admission?.phase, 'pending')
      await launchPause.entered

      let current = await readTasks(harness.sessionStore, tasks)
      assert.deepEqual(
        current.map((task) => task.admission?.phase),
        ['granted', 'granted', undefined],
      )
      assert.equal(current[1]?.pid, undefined)
      assert.equal(current[1]?.processGroupId, undefined)
      assert.equal(
        current.filter((task) => task.admission?.phase === 'granted').length,
        2,
      )

      const saved = await harness.taskQueue.updateMaximumConcurrentTasks(
        1,
        () => harness!.settingsService.updateMaximumConcurrentTasks(1),
      )
      assert.equal(saved.maximumConcurrentTasks, 1)
      assert.equal(harness.taskQueue.maximumConcurrentTasks, 1)
      const thirdAdmission = await harness.taskQueue.enqueueRecovery({
        sessionId: session.id,
        taskId: tasks[2]!.id,
        source: 'manual_resume',
      })
      assert.equal(thirdAdmission.admission?.phase, 'pending')
      await settleDispatch()

      current = await readTasks(harness.sessionStore, tasks)
      assert.deepEqual(
        current.map((task) => task.admission?.phase),
        ['granted', 'granted', 'pending'],
      )
      assert.equal(current[1]?.pid, undefined)
      assert.equal(current[2]?.pid, undefined)
      assert.equal(current[2]?.processGroupId, undefined)

      launchPause.release()
      const secondWorker = await waitForLiveWorker(harness.sessionStore, tasks[1]!)
      assert.notEqual(taskProcessTarget(secondWorker), null)
      await cancelVerifiedRealTask(harness.sessionStore, tasks[0]!)
      harness.taskQueue.wake()
      await settleDispatch()
      const afterOneRelease = await readTasks(harness.sessionStore, tasks)
      assert.equal(afterOneRelease[1]?.admission?.phase, 'granted')
      assert.equal(afterOneRelease[2]?.admission?.phase, 'pending')
      assert.equal(afterOneRelease[2]?.pid, undefined)

      await cancelVerifiedRealTask(harness.sessionStore, tasks[1]!)
      harness.taskQueue.wake()
      const thirdWorker = await waitForLiveWorker(harness.sessionStore, tasks[2]!)
      assert.notEqual(taskProcessTarget(thirdWorker), null)
    } finally {
      launchPause?.release()
      if (harness) await destroyRealQueueHarness(harness)
      restoreEnvironment()
    }
  },
)

test('task admission and session deletion serialize safely when admission wins', async () => {
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath, {
    instanceId: 'admission-wins-delete-race',
  })
  const commitEntered = deferred()
  const allowCommit = deferred()
  try {
    const session = await sessionStore.createSession({
      title: 'Admission wins deletion race',
    })
    const creation = sessionStore.createTaskRecord(
      session.id,
      {
        workflowId: 'queue-contract-workflow',
        brief: 'Commit a pending admission while deletion waits on the session lock.',
        admission: pendingAdmission('1'),
      },
      {
        beforeCommit: async () => {
          commitEntered.resolve()
          await allowCommit.promise
        },
      },
    )
    await commitEntered.promise

    let deletionSettled = false
    const deletion = sessionStore.deleteSessionIfNoActiveTasks(session.id)
      .finally(() => {
        deletionSettled = true
      })
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    assert.equal(deletionSettled, false)

    allowCommit.resolve()
    const [task, deletionResult] = await Promise.all([creation, deletion])
    assert.ok(task)
    assert.equal(task.admission?.phase, 'pending')
    assert.deepEqual(deletionResult, {
      deleted: false,
      reason: 'active_tasks',
    })
    assert.ok(await sessionStore.getSession(session.id))
    assert.equal(
      (await sessionStore.getTaskRecord(session.id, task.id))?.admission?.phase,
      'pending',
    )
  } finally {
    allowCommit.resolve()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('task admission and session deletion serialize safely when deletion wins', async () => {
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath, {
    instanceId: 'delete-wins-admission-race',
  })
  const deletionInsideLock = deferred()
  const allowDeletion = deferred()
  try {
    const session = await sessionStore.createSession({
      title: 'Deletion wins admission race',
    })
    const storeWithBarrier = sessionStore as unknown as {
      readTaskRecordsStrictForSession(id: string): Promise<SessionTask[]>
    }
    const readTaskRecordsStrictForSession =
      storeWithBarrier.readTaskRecordsStrictForSession.bind(sessionStore)
    storeWithBarrier.readTaskRecordsStrictForSession = async (id) => {
      const tasks = await readTaskRecordsStrictForSession(id)
      if (id === session.id) {
        deletionInsideLock.resolve()
        await allowDeletion.promise
      }
      return tasks
    }

    const deletion = sessionStore.deleteSessionIfNoActiveTasks(session.id)
    await deletionInsideLock.promise
    const creation = sessionStore.createTaskRecord(session.id, {
      workflowId: 'queue-contract-workflow',
      brief: 'Race a pending admission against an already locked deletion.',
      admission: pendingAdmission('1'),
    })
    allowDeletion.resolve()
    const [deletionResult, task] = await Promise.all([deletion, creation])
    assert.deepEqual(deletionResult, { deleted: true })
    assert.equal(task, null)
    assert.equal(await sessionStore.getSession(session.id), null)
    assert.deepEqual(await sessionStore.listTaskRecordsStrict(), [])
    const runIndexPath = path.join(workspacePath, 'run-index')
    assert.equal(
      fs.existsSync(runIndexPath) && fs.readdirSync(runIndexPath).length > 0,
      false,
    )
  } finally {
    allowDeletion.resolve()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test(
  'done, failed, blocked, cancelled, and interrupted outcomes each release a real worker slot',
  { timeout: 30_000, skip: process.platform === 'win32' },
  async () => {
    const restoreEnvironment = useRealQueueWorkerEnvironment()
    let harness: RealQueueHarness | undefined
    try {
      harness = await createRealQueueHarness(1)
      const session = await harness.sessionStore.createSession({
        title: 'Every release outcome',
      })
      const releaseStatuses: readonly TaskStatus[] = [
        'done',
        'failed',
        'blocked',
        'cancelled',
        'interrupted',
      ]
      const tasks = await createInterruptedTasks(
        harness.sessionStore,
        session.id,
        releaseStatuses.length + 1,
      )
      await enqueueRecoveries(harness.taskQueue, tasks)

      for (const [index, status] of releaseStatuses.entries()) {
        const current = await waitForLiveWorker(harness.sessionStore, tasks[index]!)
        const target = taskProcessTarget(current)
        assert.notEqual(target, null)

        let released: SessionTask
        if (status === 'cancelled') {
          released = await cancelVerifiedRealTask(harness.sessionStore, current)
        } else {
          await killRealTaskWorker(current)
          const transitioned = await harness.sessionStore.compareAndSetTaskRecord(
            session.id,
            current.id,
            [current.status],
            {
              status,
              admission: undefined,
              pid: undefined,
              processGroupId: undefined,
              ...(status === 'interrupted'
                ? {
                    interruptedAt: new Date().toISOString(),
                    recoveryDisposition: 'manual' as const,
                    recoveryReason: 'Exercise interrupted capacity release.',
                  }
                : {
                    completedAt: new Date().toISOString(),
                    ...(status === 'failed' || status === 'blocked'
                      ? { error: `Exercise ${status} capacity release.` }
                      : {}),
                  }),
            },
            grantedAdmissionFence(current),
          )
          assert.equal(transitioned?.updated, true)
          assert.ok(transitioned?.task)
          released = transitioned.task
        }

        assert.equal(released.status, status)
        await waitFor(
          () => !defaultIsProcessAlive(target!),
          `${status} worker process to stop`,
        )
        harness.taskQueue.wake()
        await waitFor(async () => {
          const converged = await harness!.sessionStore.getTaskRecord(
            session.id,
            current.id,
          )
          return converged?.status === status && converged.admission === undefined
        }, `${status} admission to be released`)
        const successor = await waitForLiveWorker(
          harness.sessionStore,
          tasks[index + 1]!,
        )
        assert.equal(successor.admission?.phase, 'granted')
        assert.equal(
          (await harness.sessionStore.getTaskRecord(
            session.id,
            tasks[index]!.id,
          ))?.status,
          status,
        )
      }
    } finally {
      if (harness) await destroyRealQueueHarness(harness)
      restoreEnvironment()
    }
  },
)

test('startup rebuilds pending and granted indexes and continues the durable ordinal', async () => {
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath, {
    instanceId: 'startup-index-queue',
  })
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new BlockingLauncher()
  const taskQueue = new TaskQueue({
    sessionStore,
    owner,
    maximumConcurrentTasks: 1,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
  })
  const harness = { workspacePath, sessionStore, owner, launcher, taskQueue }

  try {
    const session = await sessionStore.createSession({ title: 'Startup queue index' })
    const seeded = await createInterruptedTasks(sessionStore, session.id, 2)
    const pending = await sessionStore.compareAndSetTaskRecord(
      session.id,
      seeded[0]!.id,
      ['interrupted'],
      {
        status: 'queued',
        admission: pendingAdmission('7'),
        processIdentity: undefined,
        executionAttemptId: undefined,
        executionAttemptNumber: undefined,
        executionKind: undefined,
        attemptStartedAt: undefined,
      },
      { expectedExecutionAttemptId: requiredValue(seeded[0]!.executionAttemptId, 'expected execution attempt id') },
    )
    assert.equal(pending?.updated, true)

    const existingAttemptId = `startup-granted-${seeded[1]!.id}`
    const granted = await sessionStore.compareAndSetTaskRecord(
      session.id,
      seeded[1]!.id,
      ['interrupted'],
      {
        status: 'queued',
        admission: grantedAdmission({
          order: '9',
          executionAttemptId: existingAttemptId,
          ownerEpoch: owner.epoch,
        }),
        processIdentity: existingAttemptId,
        executionAttemptId: existingAttemptId,
        executionAttemptNumber: 2,
        ...await currentAttemptScope(seeded[1]!, 2),
        executionKind: 'initial',
        attemptStartedAt: new Date().toISOString(),
      },
      { expectedExecutionAttemptId: requiredValue(seeded[1]!.executionAttemptId, 'expected execution attempt id') },
    )
    assert.equal(granted?.updated, true)

    const initialized = await taskQueue.initialize()
    assert.deepEqual(initialized, { pending: 1, granted: 1, legacyActive: 0 })
    await waitForStarts(launcher, 1)
    assert.equal(launcher.starts[0]?.taskId, seeded[1]?.id)

    const [newTask] = await createInterruptedTasks(sessionStore, session.id, 1)
    assert.ok(newTask)
    const newlyAdmitted = await taskQueue.enqueueRecovery({
      sessionId: session.id,
      taskId: newTask.id,
      source: 'manual_resume',
    })
    assert.equal(newlyAdmitted.admission?.order, '10')

    await cancelAndWake(harness, seeded[1]!)
    await waitForStarts(launcher, 2)
    assert.equal(launcher.starts[1]?.taskId, seeded[0]?.id)
    await cancelAndWake(harness, seeded[0]!)
    await waitForStarts(launcher, 3)
    assert.equal(launcher.starts[2]?.taskId, newTask.id)
  } finally {
    await destroyHarness(harness)
  }
})

test('public task listing skips a corrupt record while startup fails closed on it', async () => {
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new BlockingLauncher()
  const taskQueue = new TaskQueue({
    sessionStore,
    owner,
    maximumConcurrentTasks: 3,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
  })
  const harness = { workspacePath, sessionStore, owner, launcher, taskQueue }

  try {
    const session = await sessionStore.createSession({ title: 'Corrupt task startup' })
    const healthyTask = await sessionStore.createTaskRecord(session.id, {
      workflowId: 'queue-contract-workflow',
      brief: 'Keep this valid task visible through permissive listing.',
    })
    const task = await sessionStore.createTaskRecord(session.id, {
      workflowId: 'queue-contract-workflow',
      brief: 'Corrupt this authoritative record.',
    })
    assert.ok(healthyTask)
    assert.ok(task)
    fs.writeFileSync(
      path.join(sessionStore.taskDir(session.id, task.id), 'task.json'),
      '{not valid json',
    )

    const listed = await sessionStore.listTaskRecords(session.id)
    assert.deepEqual(listed.map((record) => record.id), [healthyTask.id])

    await assert.rejects(
      taskQueue.initialize(),
      /Task record cannot be decoded/,
    )
    assert.equal(taskQueue.isReady(), false)
    assert.equal(launcher.starts.length, 0)
  } finally {
    await destroyHarness(harness)
  }
})

test('startup fails closed when authoritative session metadata is corrupt', async () => {
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new BlockingLauncher()
  const taskQueue = new TaskQueue({
    sessionStore,
    owner,
    maximumConcurrentTasks: 3,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
  })
  const harness = { workspacePath, sessionStore, owner, launcher, taskQueue }

  try {
    const session = await sessionStore.createSession({ title: 'Corrupt session startup' })
    const task = await sessionStore.createTaskRecord(session.id, {
      workflowId: 'queue-contract-workflow',
      brief: 'Keep this task undispatched when its session is corrupt.',
    })
    assert.ok(task)
    fs.writeFileSync(
      path.join(workspacePath, 'sessions', session.id, 'session.json'),
      '{not valid json',
    )

    await assert.rejects(
      taskQueue.initialize(),
      /Session metadata cannot be decoded/,
    )
    assert.equal(taskQueue.isReady(), false)
    assert.equal(launcher.starts.length, 0)
  } finally {
    await destroyHarness(harness)
  }
})

test('pending cancellation is skipped and granted cancellation releases its slot', async () => {
  const harness = await createHarness(1)
  try {
    const session = await harness.sessionStore.createSession({ title: 'Queue cancellation' })
    const tasks = await createInterruptedTasks(harness.sessionStore, session.id, 3)
    await enqueueRecoveries(harness.taskQueue, tasks)
    await waitForStarts(harness.launcher, 1)

    const pendingCancelled = await cancelAndWake(harness, tasks[1]!)
    assert.equal(pendingCancelled.status, 'cancelled')
    assert.equal(pendingCancelled.admission, undefined)
    await cancelAndWake(harness, tasks[0]!)
    await waitForStarts(harness.launcher, 2)

    assert.deepEqual(
      harness.launcher.starts.map((start) => start.taskId),
      [tasks[0]!.id, tasks[2]!.id],
    )
    const grantedAfterRelease = await harness.sessionStore.getTaskRecord(
      tasks[2]!.sessionId,
      tasks[2]!.id,
    )
    assert.equal(grantedAfterRelease?.admission?.phase, 'granted')
  } finally {
    await destroyHarness(harness)
  }
})

/** Reports each launch as an event; the launched run never settles. */
class StartSignallingLauncher implements RunLauncher {
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

// A person who cancels a task just as the queue admits it gets the task
// cancelled, not a conflict. Cancellation reads the task and writes it fenced
// on that read's admission, so the fence still targets the attempt it read.
//
// Substituted boundary, for the supervisor to judge: cancelSessionTask gets
// a delegating wrapper around the real FileSystemSessionStore. Every call goes
// to the real store. The wrapper adds one thing: after the cancel's first
// read of the task, and before that read is returned, it runs the real
// queue's admission of the task (a slot is freed by cancelling the task that
// held it, and the queue grants and launches the waiting one). Assertions are
// on the cancel's result and the stored record only.
test('cancelling a task the queue admits between the cancel\'s read and its write still cancels it', async () => {
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath, { instanceId: `queue-test-${randomUUID()}` })
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new StartSignallingLauncher()
  const taskQueue = new TaskQueue({
    sessionStore,
    owner,
    maximumConcurrentTasks: 1,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
  })
  try {
    await taskQueue.initialize()
    const session = await sessionStore.createSession({ title: 'Cancel during admission' })
    const [holding, waiting] = await createInterruptedTasks(sessionStore, session.id, 2)
    assert.ok(holding && waiting)
    await enqueueRecoveries(taskQueue, [holding, waiting])
    await launcher.launched(holding.id)
    const before = requiredValue(await sessionStore.getTaskRecord(session.id, waiting.id), 'waiting task')
    assert.equal(before.admission?.phase, 'pending', 'arrangement: the second task waits for the slot')

    let admittedDuringCancel = false
    const cancellingStore = new Proxy(sessionStore, {
      get(target, property) {
        if (property === 'getTaskRecord') {
          return async (sessionId: string, taskId: string) => {
            const read = await target.getTaskRecord(sessionId, taskId)
            if (!admittedDuringCancel && taskId === waiting.id) {
              admittedDuringCancel = true
              // The real admission, between the cancel's read and its write.
              await cancelSessionTask({ sessionId: session.id, taskId: holding.id, sessionStore: target })
              taskQueue.wake()
              await launcher.launched(waiting.id)
            }
            return read
          }
        }
        const value: unknown = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

    const cancelled = await cancelSessionTask({
      sessionId: session.id,
      taskId: waiting.id,
      sessionStore: cancellingStore,
    })

    const admitted = requiredValue(await sessionStore.getTaskRecord(session.id, waiting.id), 'cancelled task')
    assert.deepEqual(
      {
        admittedDuringCancel,
        cancelledStatus: cancelled?.status,
        status: admitted.status,
        error: admitted.error,
        admission: admitted.admission,
      },
      {
        admittedDuringCancel: true,
        cancelledStatus: 'cancelled',
        status: 'cancelled',
        error: 'Cancelled by user',
        admission: undefined,
      },
    )
  } finally {
    await taskQueue.close(1)
    await owner.release()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('failed process cancellation retains its grant and blocks over-admission', async () => {
  const harness = await createHarness(1, {
    isProcessAlive: () => true,
    isProcessIdentityValid: () => false,
    findProcessByIdentity: () => null,
  })
  try {
    const session = await harness.sessionStore.createSession({
      title: 'Failed cancellation capacity',
    })
    const tasks = await createInterruptedTasks(harness.sessionStore, session.id, 2)
    await enqueueRecoveries(harness.taskQueue, tasks)
    await waitForStarts(harness.launcher, 1)

    const granted = await harness.sessionStore.getTaskRecord(session.id, tasks[0]!.id)
    assert.ok(granted)
    assert.equal(granted.admission?.phase, 'granted')
    const running = await harness.sessionStore.compareAndSetTaskRecord(
      session.id,
      granted.id,
      ['queued'],
      {
        status: 'running',
        pid: 432_101,
        processGroupId: 432_101,
        workerStartedAt: new Date().toISOString(),
      },
      grantedAdmissionFence(granted),
    )
    assert.equal(running?.updated, true)

    const signals: NodeJS.Signals[] = []
    await assert.rejects(
      cancelSessionTask({
        sessionId: session.id,
        taskId: granted.id,
        sessionStore: harness.sessionStore,
        killProcess(_target, signal) {
          signals.push(signal)
        },
        isProcessAlive: () => true,
        isProcessIdentityValid: () => true,
        gracefulTimeoutMs: 0,
        forceTimeoutMs: 0,
      }),
      /process did not exit after SIGTERM and SIGKILL/,
    )
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])

    harness.taskQueue.wake()
    await settleDispatch()
    const current = await readTasks(harness.sessionStore, tasks)
    assert.equal(current[0]?.status, 'cancelled')
    assert.equal(current[0]?.admission?.phase, 'granted')
    assert.equal(current[0]?.pid, 432_101)
    assert.equal(current[1]?.admission?.phase, 'pending')
    assert.deepEqual(
      harness.launcher.starts.map((start) => start.taskId),
      [tasks[0]!.id],
    )
  } finally {
    await destroyHarness(harness)
  }
})

test('a stale worker terminal release cannot clear a newer granted admission', async () => {
  const harness = await createHarness(1)
  try {
    const session = await harness.sessionStore.createSession({
      title: 'Stale worker release fence',
    })
    const [task] = await createInterruptedTasks(harness.sessionStore, session.id, 1)
    assert.ok(task)
    await harness.taskQueue.enqueueRecovery({
      sessionId: session.id,
      taskId: task.id,
      source: 'manual_resume',
    })
    await waitForStarts(harness.launcher, 1)
    const firstGrant = await harness.sessionStore.getTaskRecord(session.id, task.id)
    assert.ok(firstGrant)
    assert.equal(firstGrant.admission?.phase, 'granted')

    const interrupted = await harness.sessionStore.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['queued', 'running'],
      {
        status: 'interrupted',
        admission: undefined,
        interruptedAt: new Date().toISOString(),
        recoveryDisposition: 'manual',
        recoveryReason: 'Retry this attempt through a newer admission.',
      },
      grantedAdmissionFence(firstGrant),
    )
    assert.equal(interrupted?.updated, true)

    await harness.taskQueue.enqueueRecovery({
      sessionId: session.id,
      taskId: task.id,
      source: 'manual_resume',
    })
    await waitForStarts(harness.launcher, 2)
    const secondGrant = await harness.sessionStore.getTaskRecord(session.id, task.id)
    assert.ok(secondGrant)
    assert.equal(secondGrant.admission?.phase, 'granted')
    assert.notEqual(secondGrant.executionAttemptId, firstGrant.executionAttemptId)
    assert.notEqual(secondGrant.admission?.requestId, firstGrant.admission?.requestId)

    const staleRelease = await harness.sessionStore.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['queued', 'running'],
      {
        status: 'done',
        admission: undefined,
        completedAt: new Date().toISOString(),
      },
      grantedAdmissionFence(firstGrant),
    )
    assert.equal(staleRelease?.updated, false)
    assert.equal(staleRelease?.task.status, 'queued')
    assert.equal(staleRelease?.task.executionAttemptId, secondGrant.executionAttemptId)
    assert.equal(staleRelease?.task.admission?.requestId, secondGrant.admission?.requestId)
    assert.equal(staleRelease?.task.admission?.phase, 'granted')
  } finally {
    await destroyHarness(harness)
  }
})

test('startup repairs a staged apply admission before dispatch', async () => {
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new BlockingLauncher()
  const taskQueue = new TaskQueue({
    sessionStore,
    owner,
    maximumConcurrentTasks: 1,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
  })
  const harness = { workspacePath, sessionStore, owner, launcher, taskQueue }

  try {
    const session = await sessionStore.createSession({ title: 'Staged repair' })
    const plan = readyPlan('staged-repair-plan')
    assert.equal(await sessionStore.saveRunPlan(session.id, plan), true)
    const claim = await sessionStore.claimRunPlanForApply(session.id, plan.id)
    assert.equal(claim?.claimed, true)
    assert.ok(claim?.plan.applyClaimId)
    const stagedAdmission: Extract<TaskAdmission, { phase: 'staged' }> = {
      version: 1,
      phase: 'staged',
      requestId: 'staged-repair-request',
      order: '4',
      requestedAt: new Date().toISOString(),
      executionKind: 'initial',
      source: 'apply',
      expectedExecutionAttemptId: null,
      runPlanId: plan.id,
      applyClaimId: claim.plan.applyClaimId,
    }
    const committed = await sessionStore.createTaskRecord(session.id, {
      workflowId: 'queue-contract-workflow',
      brief: 'Repair the staged queue admission.',
      runPlanId: plan.id,
      runPlanApplyClaimId: claim.plan.applyClaimId,
      admission: stagedAdmission,
    })
    assert.ok(committed)

    // Recreate the crash seam after task(staged), before plan(queued) and
    // task(pending), using the exact durable records the store wrote.
    fs.writeFileSync(
      path.join(workspacePath, 'sessions', session.id, 'run-plan.json'),
      `${JSON.stringify(claim.plan, null, 2)}\n`,
    )
    fs.writeFileSync(
      path.join(sessionStore.taskDir(session.id, committed.id), 'task.json'),
      `${JSON.stringify({ ...committed, admission: stagedAdmission }, null, 2)}\n`,
    )

    await taskQueue.initialize()
    await waitForStarts(launcher, 1)
    const repairedTask = await sessionStore.getTaskRecord(session.id, committed.id)
    const repairedPlan = await sessionStore.getRunPlan(session.id)
    assert.equal(repairedTask?.admission?.phase, 'granted')
    assert.equal(repairedPlan?.status, 'queued')
    assert.equal(repairedPlan?.taskId, committed.id)
    assert.equal(repairedPlan?.applyClaimId, undefined)
  } finally {
    await destroyHarness(harness)
  }
})

test('queued-to-running RunPlan reconciliation cannot outlive a terminal task race', async () => {
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath, {
    instanceId: 'run-plan-terminal-race',
  })
  try {
    const session = await sessionStore.createSession({ title: 'RunPlan terminal race' })
    const plan = readyPlan('run-plan-terminal-race-plan')
    assert.equal(await sessionStore.saveRunPlan(session.id, plan), true)
    const claim = await sessionStore.claimRunPlanForApply(session.id, plan.id)
    assert.equal(claim?.claimed, true)
    assert.ok(claim?.plan.applyClaimId)
    const stagedAdmission: Extract<TaskAdmission, { phase: 'staged' }> = {
      version: 1,
      phase: 'staged',
      requestId: 'run-plan-terminal-race-request',
      order: '1',
      requestedAt: new Date().toISOString(),
      executionKind: 'initial',
      source: 'apply',
      expectedExecutionAttemptId: null,
      runPlanId: plan.id,
      applyClaimId: claim.plan.applyClaimId,
    }
    const task = await sessionStore.createTaskRecord(session.id, {
      workflowId: 'queue-contract-workflow',
      brief: 'Race worker startup against terminal task reconciliation.',
      runPlanId: plan.id,
      runPlanApplyClaimId: claim.plan.applyClaimId,
      admission: stagedAdmission,
    })
    assert.ok(task)
    assert.equal(task.admission?.phase, 'pending')
    assert.equal((await sessionStore.getRunPlan(session.id))?.status, 'queued')

    const pendingAdmission = task.admission
    assert.equal(pendingAdmission?.phase, 'pending')
    if (pendingAdmission?.phase !== 'pending') {
      throw new Error('Expected createTaskRecord to commit a pending admission')
    }
    const executionAttemptId = 'run-plan-terminal-race-attempt'
    const grantedAdmission: Extract<TaskAdmission, { phase: 'granted' }> = {
      ...pendingAdmission,
      phase: 'granted',
      grantId: 'run-plan-terminal-race-grant',
      ownerEpoch: 'run-plan-terminal-race-owner',
      grantedAt: new Date().toISOString(),
      executionAttemptId,
    }
    const running = await sessionStore.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['queued'],
      {
        status: 'running',
        admission: grantedAdmission,
        processIdentity: executionAttemptId,
        executionAttemptId,
        executionAttemptNumber: 1,
        executionKind: 'initial',
        attemptStartedAt: new Date().toISOString(),
        workerStartedAt: new Date().toISOString(),
      },
      {
        expectedExecutionAttemptId: null,
        expectedAdmissionRequestId: pendingAdmission.requestId,
        expectedAdmissionPhase: 'pending',
      },
    )
    assert.equal(running?.updated, true)
    assert.ok(running?.task)

    const [, terminal] = await Promise.all([
      sessionStore.markRunPlanRunningIfQueued(
        session.id,
        plan.id,
        task.id,
        executionAttemptId,
      ),
      sessionStore.compareAndSetTaskRecord(
        session.id,
        task.id,
        ['running'],
        {
          status: 'done',
          admission: undefined,
          completedAt: new Date().toISOString(),
        },
        grantedAdmissionFence(running!.task),
      ),
    ])
    assert.equal(terminal?.updated, true)
    assert.equal((await sessionStore.getTaskRecord(session.id, task.id))?.status, 'done')
    assert.equal((await sessionStore.getRunPlan(session.id))?.status, 'completed')

    const lateWorkerStart = await sessionStore.markRunPlanRunningIfQueued(
      session.id,
      plan.id,
      task.id,
      executionAttemptId,
    )
    assert.equal(lateWorkerStart?.status, 'completed')
    assert.equal((await sessionStore.getRunPlan(session.id))?.status, 'completed')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a stale owner epoch cannot grant after losing ownership at the grant CAS fence', async () => {
  const harness = await createHarness(1)
  const releaseDispatchFence = deferred()
  let dispatchFenceEntered = false
  let dispatchFenceFinished = false
  let replacementOwner: WorkspaceDispatcherOwner | undefined
  try {
    const session = await harness.sessionStore.createSession({ title: 'Stale grant owner' })
    const [task] = await createInterruptedTasks(harness.sessionStore, session.id, 1)
    assert.ok(task)

    const assertCurrent = harness.owner.assertCurrent.bind(harness.owner)
    let assertionCount = 0
    harness.owner.assertCurrent = async () => {
      assertionCount += 1
      if (assertionCount !== 3) {
        await assertCurrent()
        return
      }
      dispatchFenceEntered = true
      await releaseDispatchFence.promise
      try {
        await assertCurrent()
      } finally {
        dispatchFenceFinished = true
      }
    }

    const admitted = await harness.taskQueue.enqueueRecovery({
      sessionId: session.id,
      taskId: task.id,
      source: 'manual_resume',
    })
    assert.equal(admitted.admission?.phase, 'pending')
    await waitFor(() => dispatchFenceEntered, 'dispatch to reach the grant owner fence')

    await harness.owner.release()
    replacementOwner = await WorkspaceDispatcherOwner.acquire({
      workspacePath: harness.workspacePath,
      instanceId: 'replacement-grant-owner',
    })
    await harness.taskQueue.close(1)
    releaseDispatchFence.resolve()
    await waitFor(() => dispatchFenceFinished, 'the stale grant owner check to finish')

    const persisted = await harness.sessionStore.getTaskRecord(session.id, task.id)
    assert.equal(persisted?.status, 'interrupted')
    assert.equal(persisted?.admission?.phase, 'pending')
    assert.equal(persisted?.executionAttemptId, task.executionAttemptId)
    assert.equal(harness.launcher.starts.length, 0)
  } finally {
    releaseDispatchFence.resolve()
    await harness.taskQueue.close(1)
    await replacementOwner?.release()
    await harness.owner.release()
    fs.rmSync(harness.workspacePath, { recursive: true, force: true })
  }
})

test('startup resets an applying plan that never created a linked task', async () => {
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new BlockingLauncher()
  const taskQueue = new TaskQueue({
    sessionStore,
    owner,
    maximumConcurrentTasks: 1,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
  })
  const harness = { workspacePath, sessionStore, owner, launcher, taskQueue }

  try {
    const session = await sessionStore.createSession({ title: 'Orphaned apply' })
    const plan = readyPlan('orphaned-apply-plan')
    assert.equal(await sessionStore.saveRunPlan(session.id, plan), true)
    const claim = await sessionStore.claimRunPlanForApply(session.id, plan.id)
    assert.equal(claim?.claimed, true)

    await taskQueue.initialize()
    const recovered = await sessionStore.getRunPlan(session.id)
    assert.equal(recovered?.status, 'ready')
    assert.equal(recovered?.applyClaimId, undefined)
    assert.equal(recovered?.taskId, undefined)
    assert.equal(launcher.starts.length, 0)
  } finally {
    await destroyHarness(harness)
  }
})

test('startup rebinds a proven-unspawned old-owner grant without changing its attempt', async () => {
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Old grant rebind' })
  const [task] = await createInterruptedTasks(sessionStore, session.id, 1)
  assert.ok(task)
  const executionAttemptId = 'old-owner-unspawned-attempt'
  const seeded = await sessionStore.compareAndSetTaskRecord(
    session.id,
    task.id,
    ['interrupted'],
    {
      status: 'queued',
      admission: grantedAdmission({
        order: '8',
        executionAttemptId,
        ownerEpoch: 'old-owner-epoch',
      }),
      processIdentity: executionAttemptId,
      executionAttemptId,
      executionAttemptNumber: 2,
      executionKind: 'recovery',
      attemptStartedAt: new Date().toISOString(),
      pid: undefined,
      processGroupId: undefined,
    },
    { expectedExecutionAttemptId: requiredValue(task.executionAttemptId, 'expected execution attempt id') },
  )
  assert.equal(seeded?.updated, true)
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new BlockingLauncher()
  const taskQueue = new TaskQueue({
    sessionStore,
    owner,
    maximumConcurrentTasks: 1,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
  })
  const harness = { workspacePath, sessionStore, owner, launcher, taskQueue }

  try {
    await taskQueue.initialize()
    await waitForStarts(launcher, 1)
    const rebound = await sessionStore.getTaskRecord(session.id, task.id)
    assert.equal(rebound?.executionAttemptId, executionAttemptId)
    assert.equal(rebound?.admission?.phase, 'granted')
    assert.equal(
      rebound?.admission?.phase === 'granted'
        ? rebound.admission.ownerEpoch
        : undefined,
      owner.epoch,
    )
  } finally {
    await destroyHarness(harness)
  }
})

test('startup preserves and counts a verified live old-owner grant', async () => {
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath, {
    isProcessAlive: () => true,
    isProcessIdentityValid: () => true,
  })
  const session = await sessionStore.createSession({ title: 'Live old grant' })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'queue-contract-workflow',
    brief: 'Preserve the verified live attempt.',
  })
  assert.ok(task)
  const executionAttemptId = 'old-owner-live-attempt'
  const seeded = await sessionStore.compareAndSetTaskRecord(
    session.id,
    task.id,
    ['queued'],
    {
      status: 'running',
      admission: grantedAdmission({
        order: '12',
        executionAttemptId,
        ownerEpoch: 'old-live-owner-epoch',
      }),
      processIdentity: executionAttemptId,
      executionAttemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      attemptStartedAt: new Date().toISOString(),
      workerStartedAt: new Date().toISOString(),
      pid: 456_789,
      processGroupId: 456_789,
    },
    { expectedExecutionAttemptId: null },
  )
  assert.equal(seeded?.updated, true)
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new BlockingLauncher()
  const taskQueue = new TaskQueue({
    sessionStore,
    owner,
    maximumConcurrentTasks: 1,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
  })
  const harness = { workspacePath, sessionStore, owner, launcher, taskQueue }

  try {
    const initialized = await taskQueue.initialize()
    assert.deepEqual(initialized, { pending: 0, granted: 1, legacyActive: 0 })
    assert.equal(launcher.starts.length, 0)
    const preserved = await sessionStore.getTaskRecord(session.id, task.id)
    assert.equal(preserved?.status, 'running')
    assert.equal(
      preserved?.admission?.phase === 'granted'
        ? preserved.admission.ownerEpoch
        : undefined,
      'old-live-owner-epoch',
    )
  } finally {
    await destroyHarness(harness)
  }
})

test('an ambiguous old-owner process identity blocks every pending grant', {
  skip: process.platform === 'win32',
}, async () => {
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Ambiguous old grant' })
  const tasks = await createInterruptedTasks(sessionStore, session.id, 2)
  const processIdentity = `ambiguous-queue-${Date.now()}`
  const workers: ChildProcess[] = []

  try {
    for (let index = 0; index < 2; index += 1) {
      const worker = spawn(
        process.execPath,
        [
          '-e',
          'setInterval(() => undefined, 1000)',
          '--',
          `${PROCESS_IDENTITY_ARGUMENT}${processIdentity}`,
        ],
        { detached: true, stdio: 'ignore' },
      )
      workers.push(worker)
      await new Promise<void>((resolve, reject) => {
        worker.once('spawn', resolve)
        worker.once('error', reject)
      })
    }

    const granted = await sessionStore.compareAndSetTaskRecord(
      session.id,
      tasks[0]!.id,
      ['interrupted'],
      {
        status: 'queued',
        admission: grantedAdmission({
          order: '1',
          executionAttemptId: processIdentity,
          ownerEpoch: 'dead-owner-epoch',
        }),
        processIdentity,
        executionAttemptId: processIdentity,
        executionAttemptNumber: 2,
        executionKind: 'recovery',
        attemptStartedAt: new Date().toISOString(),
        pid: undefined,
        processGroupId: undefined,
      },
      { expectedExecutionAttemptId: requiredValue(tasks[0]!.executionAttemptId, 'expected execution attempt id') },
    )
    assert.equal(granted?.updated, true)
    const pending = await sessionStore.compareAndSetTaskRecord(
      session.id,
      tasks[1]!.id,
      ['interrupted'],
      {
        status: 'queued',
        admission: pendingAdmission('2'),
        processIdentity: undefined,
        executionAttemptId: undefined,
        executionAttemptNumber: undefined,
        executionKind: undefined,
        attemptStartedAt: undefined,
      },
      { expectedExecutionAttemptId: requiredValue(tasks[1]!.executionAttemptId, 'expected execution attempt id') },
    )
    assert.equal(pending?.updated, true)

    const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
    const launcher = new BlockingLauncher()
    const taskQueue = new TaskQueue({
      sessionStore,
      owner,
      maximumConcurrentTasks: 2,
      repoRootPath: process.cwd(),
      workspacePath,
      taskLauncher: launcher,
      tickIntervalMs: TEST_TICK_INTERVAL_MS,
    })
    try {
      const initialized = await taskQueue.initialize()
      assert.deepEqual(initialized, { pending: 1, granted: 1, legacyActive: 0 })
      await settleDispatch()
      assert.equal(launcher.starts.length, 0)
      assert.equal(
        (await sessionStore.getTaskRecord(session.id, tasks[1]!.id))
          ?.admission?.phase,
        'pending',
      )
      const snapshot = await taskQueue.snapshot()
      assert.equal(snapshot.status, 'blocked')
      assert.equal(snapshot.slotsInUse, 1)
      assert.equal(snapshot.waitingCount, 1)
    } finally {
      await taskQueue.close(1)
      await owner.release()
    }
  } finally {
    for (const worker of workers) {
      if (worker.pid) {
        try {
          process.kill(-worker.pid, 'SIGKILL')
        } catch {
          worker.kill('SIGKILL')
        }
      }
    }
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('startup queues a legacy interruption after reconciliation, while the toggle leaves manual Resume available', async () => {
  for (const durableRecoveryEnabled of [true, false]) {
    const workspacePath = makeWorkspace()
    const sessionStore = new FileSystemSessionStore(workspacePath, {
      instanceId: `automatic-recovery-${durableRecoveryEnabled}`,
      staleTaskGraceMs: 0,
      isProcessAlive: () => false,
      isProcessIdentityValid: () => false,
      findProcessByIdentity: () => null,
    })
    const session = await sessionStore.createSession({ title: 'Automatic recovery rescan' })
    const task = await sessionStore.createTaskRecord(session.id, {
      workflowId: 'queue-contract-workflow',
      brief: 'Recover this legacy queued attempt.',
    })
    assert.ok(task)
    const oldAttempt = `legacy-attempt-${durableRecoveryEnabled}`
    // "Legacy" in the queue's sense: an attempt without an admission, as a
    // direct launch still makes. It was launched by this version, so it has
    // an ownership scope; an earlier version's attempt, which has none, is
    // held instead (owned-process-queue-hold.test.ts).
    const executing = await sessionStore.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['queued'],
      {
        ownerInstanceId: 'dead-api-owner',
        processIdentity: oldAttempt,
        executionAttemptId: oldAttempt,
        executionAttemptNumber: 1,
        ...await currentAttemptScope(task, 1),
        executionKind: 'initial',
        attemptStartedAt: new Date(0).toISOString(),
      },
      { expectedExecutionAttemptId: null },
    )
    assert.equal(executing?.updated, true)
    const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
    const launcher = new BlockingLauncher()
    const taskQueue = new TaskQueue({
      sessionStore,
      owner,
      maximumConcurrentTasks: 1,
      repoRootPath: process.cwd(),
      workspacePath,
      taskLauncher: launcher,
      tickIntervalMs: TEST_TICK_INTERVAL_MS,
      durableRecoveryEnabled,
    })
    const harness = { workspacePath, sessionStore, owner, launcher, taskQueue }

    try {
      await taskQueue.initialize()
      if (durableRecoveryEnabled) {
        await waitForStarts(launcher, 1)
        const recovered = await sessionStore.getTaskRecord(session.id, task.id)
        assert.equal(recovered?.admission?.phase, 'granted')
        assert.equal(recovered?.executionKind, 'recovery')
      } else {
        const interrupted = await sessionStore.getTaskRecord(session.id, task.id)
        assert.equal(interrupted?.status, 'interrupted')
        assert.equal(interrupted?.admission, undefined)
        assert.equal(launcher.starts.length, 0)
        await taskQueue.enqueueRecovery({
          sessionId: session.id,
          taskId: task.id,
          source: 'manual_resume',
        })
        await waitForStarts(launcher, 1)
      }
    } finally {
      await destroyHarness(harness)
    }
  }
})

test('structured queue events cover admission lifecycle without logging task briefs', async () => {
  const harness = await createHarness(1)
  try {
    const session = await harness.sessionStore.createSession({ title: 'Queue events' })
    const [task] = await createInterruptedTasks(harness.sessionStore, session.id, 1)
    assert.ok(task)
    await harness.taskQueue.enqueueRecovery({
      sessionId: session.id,
      taskId: task.id,
      source: 'manual_resume',
    })
    await waitForStarts(harness.launcher, 1)
    await harness.taskQueue.updateMaximumConcurrentTasks(2, async () => undefined)
    await cancelAndWake(harness, task)

    const eventPath = path.join(
      harness.workspacePath,
      'task-queue',
      TASK_QUEUE_EVENT_FILENAME,
    )
    await waitFor(() => {
      const contents = fs.readFileSync(eventPath, 'utf8')
      return contents.includes('task_queue.released')
    }, 'the release event')
    const contents = fs.readFileSync(eventPath, 'utf8')
    const names = new Set(contents.trim().split('\n').map((line) =>
      (JSON.parse(line) as { event: string }).event,
    ))
    for (const name of [
      'task_queue.owner_acquired',
      'task_queue.index_rebuilt',
      'task_queue.reconciled',
      'task_queue.enqueued',
      'task_queue.granted',
      'task_queue.launch_handoff',
      'task_queue.limit_updated',
      'task_queue.released',
    ]) {
      assert.ok(names.has(name), `Missing ${name}`)
    }
    assert.equal(contents.includes(task.brief), false)
    assert.equal(fs.statSync(eventPath).mode & 0o777, 0o600)
    assert.equal(
      fs.existsSync(path.join(harness.workspacePath, '.runtime')),
      false,
      'queue authority must not create a workspace-root .runtime directory',
    )
  } finally {
    await destroyHarness(harness)
  }
})

test('an approved model choice on a blocked step is not adopted', async () => {
  // `blocked` is terminal for a step, as `failed` and `cancelled` are. An
  // approval on a step that has already ended has nothing left to continue, so
  // adopting it would launch an attempt for work that is over.
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath, {
    instanceId: `queue-blocked-source-${Date.now()}`,
  })
  const session = await sessionStore.createSession({ title: 'Blocked approved step' })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'queue-blocked-model-choice',
    brief: 'An approval on a step that ended.',
  })
  assert.ok(task)
  const executionAttemptId = randomUUID()
  const waiting = await sessionStore.compareAndSetTaskRecord(
    session.id,
    task.id,
    ['queued'],
    {
      status: 'awaiting_model_choice',
      executionAttemptId,
      processIdentity: executionAttemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      recoveryCount: 0,
    },
    { expectedExecutionAttemptId: null },
  )
  assert.equal(waiting?.updated, true)
  await initializeApprovedModelChoiceJournal({
    task,
    executionAttemptId,
    blockStep: true,
  })

  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new BlockingLauncher()
  const taskQueue = new TaskQueue({
    sessionStore: new FileSystemSessionStore(workspacePath, {
      instanceId: `queue-blocked-target-${Date.now()}`,
    }),
    owner,
    maximumConcurrentTasks: 2,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
  })
  try {
    await taskQueue.initialize()

    // Proven against a queue that is demonstrably working: an unrelated
    // recovery launches, and the blocked approval still has not been admitted.
    const unrelated = await startUnrelatedRecovery({
      queue: taskQueue,
      store: sessionStore,
      sessionId: session.id,
    })
    await waitFor(
      () => launcher.starts.some((start) => start.taskId === unrelated),
      'the unrelated recovery to launch',
    )

    const settled = await sessionStore.getTaskRecord(session.id, task.id)
    // The workflow is terminal, so the task settles to that outcome rather
    // than staying on a wait nobody can answer. What must not happen is an
    // admission: the approval had nothing left to continue.
    assert.equal(settled?.status, 'blocked')
    assert.equal(settled?.admission, undefined, 'a blocked step was adopted')
    assert.equal(
      launcher.starts.filter((start) => start.taskId === task.id).length,
      0,
      'a blocked step was launched',
    )
  } finally {
    await taskQueue.close(1)
    await owner.release()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a deferred approval whose task changed identity is not asked about again', async () => {
  // Deferral remembers which execution attempt was waiting. If the task moves
  // to another attempt, it is no longer the task that was deferred, and asking
  // its authority about it would keep an outage alive against work that has
  // moved on. Counted at the opener, because that is where the asking happens.
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath, {
    instanceId: `queue-identity-source-${Date.now()}`,
  })
  const session = await sessionStore.createSession({ title: 'Deferred identity' })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'queue-identity-model-choice',
    brief: 'Deferred, then moved on.',
  })
  assert.ok(task)
  const executionAttemptId = randomUUID()
  const waiting = await sessionStore.compareAndSetTaskRecord(
    session.id,
    task.id,
    ['queued'],
    {
      status: 'awaiting_model_choice',
      executionAttemptId,
      processIdentity: executionAttemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      recoveryCount: 0,
    },
    { expectedExecutionAttemptId: null },
  )
  assert.equal(waiting?.updated, true)
  await initializeApprovedModelChoiceJournal({ task, executionAttemptId })

  let openerCalls = 0
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
    journalOpener: async () => {
      openerCalls += 1
      throw new Error('journal authority is transiently unavailable')
    },
  })

  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new BlockingLauncher()
  const taskQueue = new TaskQueue({
    sessionStore: new FileSystemSessionStore(workspacePath, {
      instanceId: `queue-identity-target-${Date.now()}`,
    }),
    owner,
    maximumConcurrentTasks: 2,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
    executionJournalRegistry: registry,
  })
  try {
    await taskQueue.initialize()
    assert.ok(openerCalls > 0, 'startup never asked the authority')

    // The task moves to a different execution attempt.
    const moved = await sessionStore.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['awaiting_model_choice'],
      { executionAttemptId: randomUUID() },
      { expectedExecutionAttemptId: executionAttemptId },
    )
    assert.equal(moved?.updated, true)
    const callsBeforeWakes = openerCalls

    // Later dispatches must not ask about it again. An unrelated recovery is
    // the barrier: once it has launched, those dispatches have been processed.
    taskQueue.wake()
    const unrelated = await startUnrelatedRecovery({
      queue: taskQueue,
      store: sessionStore,
      sessionId: session.id,
    })
    await waitFor(
      () => launcher.starts.some((start) => start.taskId === unrelated),
      'the unrelated recovery to launch',
    )

    assert.equal(
      openerCalls,
      callsBeforeWakes,
      'the queue kept asking about a task that had moved on',
    )
    const settled = await sessionStore.getTaskRecord(session.id, task.id)
    assert.equal(settled?.admission, undefined, 'a moved task was adopted')
  } finally {
    await taskQueue.close(1)
    await registry.close()
    await owner.release()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a held canonical recheck does not stop the queue running other work', async () => {
  // The deferred re-examination reads a canonical authority, and an authority
  // that is merely slow is what an outage ordinarily looks like. If that read
  // happens while the queue's own lock is held, every unrelated admission,
  // reservation and launch waits behind it — so an approval nobody can read
  // stops work that has nothing to do with it.
  //
  // Startup opens are refused quickly; only the re-examination after `wake` is
  // held, and unrelated recovery is enqueued while that read is in flight.
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath, {
    instanceId: `queue-hold-source-${Date.now()}`,
  })
  const session = await sessionStore.createSession({ title: 'Held canonical read' })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'queue-hold-model-choice',
    brief: 'Deferred behind a slow authority.',
  })
  assert.ok(task)
  const executionAttemptId = randomUUID()
  const waiting = await sessionStore.compareAndSetTaskRecord(
    session.id,
    task.id,
    ['queued'],
    {
      status: 'awaiting_model_choice',
      executionAttemptId,
      processIdentity: executionAttemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      recoveryCount: 0,
    },
    { expectedExecutionAttemptId: null },
  )
  assert.equal(waiting?.updated, true)
  await initializeApprovedModelChoiceJournal({ task, executionAttemptId })

  let holdRecheck = false
  // A boolean the test can poll with a bounded wait, so a probe that never runs
  // fails by name rather than hanging the suite. The deferred below only
  // releases the held opener.
  let heldOpenBegan = false
  const release = deferred()
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
    journalOpener: async () => {
      if (!holdRecheck) {
        throw new Error('journal authority is transiently unavailable')
      }
      heldOpenBegan = true
      await release.promise
      throw new Error('journal authority is still unavailable')
    },
  })

  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new BlockingLauncher()
  const taskQueue = new TaskQueue({
    sessionStore: new FileSystemSessionStore(workspacePath, {
      instanceId: `queue-hold-target-${Date.now()}`,
    }),
    owner,
    maximumConcurrentTasks: 2,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
    executionJournalRegistry: registry,
  })
  let enqueued: Promise<void> | undefined
  try {
    await taskQueue.initialize()
    assert.equal(
      (await sessionStore.getTaskRecord(session.id, task.id))?.admission,
      undefined,
      'an unreadable authority admitted work',
    )

    // Prepared before the hold, so nothing this test needs is itself waiting on
    // the authority.
    const [unrelated] = await createInterruptedTasks(sessionStore, session.id, 1)
    assert.ok(unrelated)

    // Only now does the authority hang, and only the re-examination reaches it.
    holdRecheck = true
    taskQueue.wake()
    await waitFor(() => heldOpenBegan, 'the deferred re-examination to begin')

    // Started, not awaited: if the held read holds the queue's lock this never
    // settles, and the bounded wait below is what reports it.
    let enqueueFailure: unknown
    enqueued = taskQueue.enqueueRecovery({
      sessionId: unrelated.sessionId,
      taskId: unrelated.id,
      source: 'manual_resume',
    }).then(() => undefined, (error: unknown) => {
      // Recorded rather than swallowed: an enqueue that failed for its own
      // reasons must not read as the liveness this test is asserting.
      enqueueFailure = error
    })

    await waitFor(
      () => launcher.starts.some((start) => start.taskId === unrelated.id),
      'unrelated work to launch while a canonical read is held',
    )
    assert.equal(enqueueFailure, undefined, 'the unrelated enqueue failed')
  } finally {
    release.resolve()
    holdRecheck = false
    if (enqueued) await enqueued
    await taskQueue.close(1)
    await registry.close()
    await owner.release()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

/** One task suspended on an approved model choice, seeded canonically. */
async function seedApprovedModelChoiceTask(params: {
  store: FileSystemSessionStore
  sessionId: string
  workflowId: string
  registry: WorkspaceExecutionJournalRegistry
}): Promise<SessionTask> {
  const task = await params.store.createTaskRecord(params.sessionId, {
    workflowId: params.workflowId,
    brief: 'Approved, waiting on its authority.',
  })
  assert.ok(task)
  const executionAttemptId = randomUUID()
  const waiting = await params.store.compareAndSetTaskRecord(
    params.sessionId,
    task.id,
    ['queued'],
    {
      status: 'awaiting_model_choice',
      executionAttemptId,
      processIdentity: executionAttemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      recoveryCount: 0,
    },
    { expectedExecutionAttemptId: null },
  )
  assert.equal(waiting?.updated, true)
  await initializeApprovedModelChoiceJournal({
    task,
    executionAttemptId,
    journal: await resolveWorkflowJournalRecorder({
      registry: params.registry,
      task,
      requestId: `seed-${task.id}`,
      processIdentity: executionAttemptId,
    }),
  })
  return requiredValue(waiting?.task, 'waiting task')
}

test('a deferred approval whose assignment changed is not asked about again', async () => {
  // The authority is identified by the assignment, not by the execution
  // attempt. A task that keeps its attempt but is repointed at another
  // assignment is a different run as far as the journal is concerned. Nothing
  // may be opened for it after that — not the authority it left, and not the
  // one it now names, because neither is the run that was deferred.
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath, {
    instanceId: `queue-assignment-source-${Date.now()}`,
  })
  const session = await sessionStore.createSession({ title: 'Repointed assignment' })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'queue-assignment-model-choice',
    brief: 'Deferred, then repointed.',
  })
  assert.ok(task)
  const deferredAssignmentId = requiredValue(task.assignmentId, 'assignment id')
  const executionAttemptId = randomUUID()
  const waiting = await sessionStore.compareAndSetTaskRecord(
    session.id,
    task.id,
    ['queued'],
    {
      status: 'awaiting_model_choice',
      executionAttemptId,
      processIdentity: executionAttemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      recoveryCount: 0,
    },
    { expectedExecutionAttemptId: null },
  )
  assert.equal(waiting?.updated, true)
  await initializeApprovedModelChoiceJournal({ task, executionAttemptId })

  const openedAssignments: string[] = []
  let holdFirstProbe = false
  let firstProbeBegan = false
  const releaseFirstProbe = deferred()
  let taskQueue: TaskQueue | undefined
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
    journalOpener: async (input) => {
      // The resolver passes `assignmentId ?? runId`, so this is the identity
      // the authority is actually keyed by.
      openedAssignments.push(
        input.identity.assignmentId ?? input.identity.runId ?? '',
      )
      // Held once, after readiness, so the probe initialize starts cannot race
      // the identity change below. Startup opens still refuse immediately.
      if (
        holdFirstProbe &&
        taskQueue?.isReady() === true &&
        input.identity.assignmentId === deferredAssignmentId
      ) {
        holdFirstProbe = false
        firstProbeBegan = true
        await releaseFirstProbe.promise
      }
      throw new Error('journal authority is unavailable')
    },
  })

  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new BlockingLauncher()
  taskQueue = new TaskQueue({
    sessionStore: new FileSystemSessionStore(workspacePath, {
      instanceId: `queue-assignment-target-${Date.now()}`,
    }),
    owner,
    maximumConcurrentTasks: 2,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
    executionJournalRegistry: registry,
  })
  holdFirstProbe = true
  try {
    await taskQueue.initialize()
    await waitFor(() => firstProbeBegan, 'the first probe to begin')
    releaseFirstProbe.resolve()
    await new Promise((resolve) => setImmediate(resolve))

    // Repointed at another assignment, on the same execution attempt.
    const movedAssignmentId = randomUUID()
    const moved = await sessionStore.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['awaiting_model_choice'],
      {
        assignmentId: movedAssignmentId,
        assignmentPath: path.join(workspacePath, 'assignments', movedAssignmentId),
      },
      { expectedExecutionAttemptId: executionAttemptId },
    )
    assert.equal(moved?.updated, true)
    const openedBefore = openedAssignments.length

    // One dispatch barrier: once unrelated work has launched, any probe that
    // dispatch would have started has run.
    const unrelated = await startUnrelatedRecovery({
      queue: taskQueue,
      store: sessionStore,
      sessionId: session.id,
    })
    await waitFor(
      () => launcher.starts.some((start) => start.taskId === unrelated),
      'the unrelated recovery to launch',
    )

    assert.equal(
      openedAssignments.length,
      openedBefore,
      'the queue opened an authority for a task that had been repointed',
    )
    const settled = await sessionStore.getTaskRecord(session.id, task.id)
    assert.equal(settled?.admission, undefined, 'a repointed task was adopted')
  } finally {
    releaseFirstProbe.resolve()
    await taskQueue.close(1)
    await registry.close()
    await owner.release()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a canonical read that fails unexpectedly is reported, not swallowed', async () => {
  // `unavailable` is an authority that would not open. An authority that opens
  // and then fails while being read is something else — a defect, not an
  // outage — and rotating past it silently would leave nobody any evidence.
  // The queue already has a structured failure boundary; this has to reach it.
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath, {
    instanceId: `queue-report-source-${Date.now()}`,
  })
  const session = await sessionStore.createSession({ title: 'Unexpected read failure' })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'queue-report-model-choice',
    brief: 'Deferred, then read badly.',
  })
  assert.ok(task)
  const executionAttemptId = randomUUID()
  const waiting = await sessionStore.compareAndSetTaskRecord(
    session.id,
    task.id,
    ['queued'],
    {
      status: 'awaiting_model_choice',
      executionAttemptId,
      processIdentity: executionAttemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      recoveryCount: 0,
    },
    { expectedExecutionAttemptId: null },
  )
  assert.equal(waiting?.updated, true)

  const seedRegistry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  try {
    await initializeApprovedModelChoiceJournal({
      task,
      executionAttemptId,
      journal: await resolveWorkflowJournalRecorder({
        registry: seedRegistry,
        task,
        requestId: `seed-${task.id}`,
        processIdentity: executionAttemptId,
      }),
    })
  } finally {
    await seedRegistry.close()
  }

  // Refuses at first, so the task is deferred; then hands back a real handle
  // that has already been closed, so opening succeeds and reading does not.
  let returnClosedJournal = false
  let holdFirstProbe = false
  let firstProbeBegan = false
  const releaseFirstProbe = deferred()
  let taskQueue: TaskQueue | undefined
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
    journalOpener: async (input) => {
      if (returnClosedJournal) {
        const journal = await initializeExecutionJournal(input)
        await journal.close()
        return journal
      }
      if (holdFirstProbe && taskQueue?.isReady() === true) {
        holdFirstProbe = false
        firstProbeBegan = true
        await releaseFirstProbe.promise
      }
      throw new Error('journal authority is transiently unavailable')
    },
  })

  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new BlockingLauncher()
  taskQueue = new TaskQueue({
    sessionStore: new FileSystemSessionStore(workspacePath, {
      instanceId: `queue-report-target-${Date.now()}`,
    }),
    owner,
    maximumConcurrentTasks: 2,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
    executionJournalRegistry: registry,
  })
  holdFirstProbe = true
  try {
    await taskQueue.initialize()
    await waitFor(() => firstProbeBegan, 'the first probe to begin')
    releaseFirstProbe.resolve()
    await new Promise((resolve) => setImmediate(resolve))

    returnClosedJournal = true
    taskQueue.wake()

    await waitFor(
      () => readTaskQueueEvents(workspacePath).some(
        (entry) =>
          entry.event === 'task_queue.dispatch_failed' &&
          String(entry.reason ?? '').includes('Execution journal is closed'),
      ),
      'the unexpected read failure to be reported',
    )

    // Nothing was decided from a read that failed.
    const settled = await sessionStore.getTaskRecord(session.id, task.id)
    assert.equal(settled?.status, 'awaiting_model_choice')
    assert.equal(settled?.admission, undefined, 'a failed read admitted work')
  } finally {
    releaseFirstProbe.resolve()
    await taskQueue.close(1)
    await registry.close()
    await owner.release()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('one unreadable authority does not starve another deferred approval', async () => {
  // The probe examines one deferred task per pass. If an entry that is still
  // unreadable stays at the front of the queue, every task behind it waits on
  // an outage that is not theirs — including ones whose own authority came
  // back. One assignment stays down here for the whole test; the other
  // recovers, and has to be adopted anyway.
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath, {
    instanceId: `queue-starve-source-${Date.now()}`,
  })
  const session = await sessionStore.createSession({ title: 'Starved deferral' })

  const seedRegistry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  let stuck: SessionTask
  let recovering: SessionTask
  try {
    stuck = await seedApprovedModelChoiceTask({
      store: sessionStore,
      sessionId: session.id,
      workflowId: 'queue-starve-stuck',
      registry: seedRegistry,
    })
    recovering = await seedApprovedModelChoiceTask({
      store: sessionStore,
      sessionId: session.id,
      workflowId: 'queue-starve-recovering',
      registry: seedRegistry,
    })
  } finally {
    await seedRegistry.close()
  }

  // One assignment never answers; the other answers once the flag flips.
  let recoveredAvailable = false
  let holdStuckProbe = false
  let stuckProbeBegan = false
  const releaseStuckProbe = deferred()
  const stuckAssignmentId = requiredValue(stuck.assignmentId, 'stuck assignment id')
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
    journalOpener: async (input) => {
      const assignmentId = input.identity.assignmentId
      if (assignmentId === stuckAssignmentId) {
        // Held once, and only after readiness: the two startup opens must still
        // refuse immediately, or initialize never returns. Arming before
        // initialize is what makes the automatic post-ready probe the one that
        // gets held, rather than racing it.
        if (holdStuckProbe && taskQueue?.isReady() === true) {
          holdStuckProbe = false
          stuckProbeBegan = true
          await releaseStuckProbe.promise
        }
        throw new Error('journal authority is unavailable')
      }
      if (!recoveredAvailable) {
        throw new Error('journal authority is unavailable')
      }
      return initializeExecutionJournal(input)
    },
  })

  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new BlockingLauncher()
  // Declared before use so the opener's closure is safe to read at any time.
  let taskQueue: TaskQueue | undefined
  taskQueue = new TaskQueue({
    sessionStore: new FileSystemSessionStore(workspacePath, {
      instanceId: `queue-starve-target-${Date.now()}`,
    }),
    owner,
    maximumConcurrentTasks: 3,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
    executionJournalRegistry: registry,
  })
  // Armed before initialize: the probe that initialize's own wake starts is the
  // one this holds.
  holdStuckProbe = true
  try {
    await taskQueue.initialize()
    assert.equal(
      (await sessionStore.getTaskRecord(session.id, recovering.id))?.admission,
      undefined,
      'an unreadable authority admitted work',
    )

    // The automatic post-ready probe reaches the stuck authority and stops.
    await waitFor(() => stuckProbeBegan, 'the stuck probe to begin')
    recoveredAvailable = true
    releaseStuckProbe.resolve()
    // One event-loop turn for that probe's own microtask chain to settle.
    await new Promise((resolve) => setImmediate(resolve))

    // Exactly one further wake. If the unavailable entry was not rotated, this
    // pass examines the stuck task again and the recovering one is never
    // reached.
    taskQueue.wake()
    await waitFor(
      async () => {
        const adopted = await sessionStore.getTaskRecord(session.id, recovering.id)
        return adopted?.admission?.source === 'model_choice'
      },
      'the recovered approval to be adopted behind a stuck one',
    )

    // The one that never answered is still waiting, untouched.
    const stillStuck = await sessionStore.getTaskRecord(session.id, stuck.id)
    assert.equal(stillStuck?.status, 'awaiting_model_choice')
    assert.equal(stillStuck?.admission, undefined, 'an unreadable authority was adopted')
  } finally {
    // Released whatever happened, so a failed assertion cannot hang cleanup.
    releaseStuckProbe.resolve()
    await taskQueue.close(1)
    await registry.close()
    await owner.release()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

/** A parsed line that is actually an object, proven rather than asserted. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The queue's own structured event log, as any operator would read it.
 *
 * Each line crosses a filesystem and JSON boundary, so it arrives `unknown` and
 * is kept only once it is shown to be a record. A line this build cannot read
 * is dropped rather than counted as an event that never happened.
 */
function readTaskQueueEvents(
  workspacePath: string,
): Record<string, unknown>[] {
  const eventsPath = path.join(
    workspacePath,
    'task-queue',
    TASK_QUEUE_EVENT_FILENAME,
  )
  if (!fs.existsSync(eventsPath)) return []
  const events: Record<string, unknown>[] = []
  for (const line of fs.readFileSync(eventsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (isRecord(parsed)) events.push(parsed)
  }
  return events
}

/** Starts one unrelated task through the queue's real recovery admission. */
async function startUnrelatedRecovery(params: {
  queue: TaskQueue
  store: FileSystemSessionStore
  sessionId: string
}): Promise<string> {
  const [unrelated] = await createInterruptedTasks(params.store, params.sessionId, 1)
  assert.ok(unrelated)
  await params.queue.enqueueRecovery({
    sessionId: unrelated.sessionId,
    taskId: unrelated.id,
    source: 'manual_resume',
  })
  return unrelated.id
}

test('an approved model choice whose journal was unavailable is adopted once it can be read', async () => {
  // Fail closed first, then recover. When the canonical authority cannot be
  // read, the queue must not decide the task's fate from a projection that may
  // be behind — and the approval *is* in the projection here, so a fallback
  // would admit during the unavailable phase and this would catch it. Adoption
  // ran only at startup, though, so the task then waited forever on a decision
  // already made. A later wake has to re-examine that exact task once the
  // authority answers, adopt it exactly once, and leave other work alone.
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath, {
    instanceId: `queue-journal-source-${Date.now()}`,
  })
  const session = await sessionStore.createSession({ title: 'Unavailable journal' })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'queue-journal-model-choice',
    brief: 'Continue once the journal can be read.',
  })
  assert.ok(task?.assignmentPath)
  const executionAttemptId = randomUUID()
  const waiting = await sessionStore.compareAndSetTaskRecord(
    session.id,
    task.id,
    ['queued'],
    {
      status: 'awaiting_model_choice',
      executionAttemptId,
      processIdentity: executionAttemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      recoveryCount: 0,
    },
    { expectedExecutionAttemptId: null },
  )
  assert.equal(waiting?.updated, true)

  // Seeded through an available authority, so the approval is genuinely in the
  // canonical journal rather than only in the derived projection. Closed before
  // the queue starts, so one owner holds the assignment at a time.
  const seedRegistry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  try {
    await initializeApprovedModelChoiceJournal({
      task,
      executionAttemptId,
      journal: await resolveWorkflowJournalRecorder({
        registry: seedRegistry,
        task,
        requestId: `seed-${task.id}`,
        processIdentity: executionAttemptId,
      }),
    })
  } finally {
    await seedRegistry.close()
  }

  // The authority is enrolled but refuses to open, which is what a transient
  // outage looks like from here. Flipped later, in this same process, so the
  // same queue instance sees it recover.
  let journalAvailable = false
  const openReadyStates: boolean[] = []
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
    journalOpener: async (input) => {
      // Recorded rather than counted by time: exactly one open may happen
      // before readiness, so a rescan inside the same initialize does not spend
      // the authority's budget a second time on a task already deferred.
      openReadyStates.push(taskQueue?.isReady() === true)
      if (!journalAvailable) {
        throw new Error('journal authority is transiently unavailable')
      }
      return initializeExecutionJournal(input)
    },
  })

  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new BlockingLauncher()
  const taskQueue: TaskQueue = new TaskQueue({
    sessionStore: new FileSystemSessionStore(workspacePath, {
      instanceId: `queue-journal-target-${Date.now()}`,
    }),
    owner,
    maximumConcurrentTasks: 3,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: launcher,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
    executionJournalRegistry: registry,
  })
  try {
    await taskQueue.initialize()

    // Fail closed: nothing admitted, nothing launched, and the wait intact.
    assert.equal(
      openReadyStates.filter((ready) => !ready).length,
      1,
      'initialize asked the authority more than once for one deferred task',
    )
    const unread = await sessionStore.getTaskRecord(session.id, task.id)
    assert.equal(unread?.status, 'awaiting_model_choice')
    assert.equal(unread?.admission, undefined, 'an unreadable authority admitted work')
    assert.equal(launcher.starts.length, 0, 'an unreadable authority launched work')

    // And the queue still runs other work while that one is blocked.
    const firstUnrelated = await startUnrelatedRecovery({
      queue: taskQueue,
      store: sessionStore,
      sessionId: session.id,
    })
    await waitForStarts(launcher, 1)
    assert.equal(launcher.starts[0]?.taskId, firstUnrelated)

    // The authority comes back, and a later wake re-examines that exact task.
    journalAvailable = true
    taskQueue.wake()
    await waitFor(
      async () => {
        const adopting = await sessionStore.getTaskRecord(session.id, task.id)
        return adopting?.admission?.phase === 'granted'
      },
      'the approved continuation to be adopted',
    )

    const adopted = await sessionStore.getTaskRecord(session.id, task.id)
    assert.equal(adopted?.status, 'queued')
    assert.equal(adopted?.executionKind, 'continuation')
    assert.equal(adopted?.admission?.source, 'model_choice')
    // An approval, not a recovery: nothing counts against the recovery budget.
    assert.equal(adopted?.recoveryCount, 0)
    const admissionRequestId = adopted?.admission?.requestId
    await waitForStarts(launcher, 2)

    // Repeated wakes adopt nothing further. Proven by making the queue finish
    // later work rather than by a predicate that was already true: a second
    // unrelated task has to be admitted and launched after those wakes, which
    // means the dispatches carrying them have been processed.
    taskQueue.wake()
    taskQueue.wake()
    const secondUnrelated = await startUnrelatedRecovery({
      queue: taskQueue,
      store: sessionStore,
      sessionId: session.id,
    })
    await waitFor(
      () => launcher.starts.some((start) => start.taskId === secondUnrelated),
      'the later unrelated task to launch',
    )

    const settled = await sessionStore.getTaskRecord(session.id, task.id)
    assert.equal(settled?.admission?.requestId, admissionRequestId)
    assert.equal(
      launcher.starts.filter((start) => start.taskId === task.id).length,
      1,
      'the approved continuation launched more than once',
    )
  } finally {
    await taskQueue.close(1)
    await registry.close()
    await owner.release()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

/** A parked run with one unanswered agent question and nothing else to do. */
async function initializePendingAgentQuestion(params: {
  task: SessionTask
  executionAttemptId: string
}): Promise<void> {
  assert.ok(params.task.assignmentPath)
  const childRunId = randomUUID()
  const stateStore = new FileSystemWorkflowStateStore(params.task.assignmentPath)
  await stateStore.initialize({
    manifest: {
      taskId: params.task.id, sessionId: params.task.sessionId, rootRunId: params.task.runId,
      workflowId: params.task.workflowId,
      workflowDefinitionHash: hashWorkflowContent('queue-question-workflow:v1'),
      briefHash: hashWorkflowContent(params.task.brief),
      teamDefinitionHashes: { writers: hashWorkflowContent('writers:v1') },
      runtimeVersion: 'workflow-runtime-v1',
    },
    executionAttemptId: params.executionAttemptId,
    steps: [{
      stepId: 'write', stepIndex: 0, stepType: 'team', team: 'writers', childRunId,
      definitionHash: hashWorkflowContent('queue-write:v1'), recoveryPolicy: 'safe_retry',
      inputArtifact: 'incoming-brief.md', resultArtifact: 'report.md',
      requestedResultType: 'artifact:report.md',
    }],
  })
  await stateStore.update({ expectedRevision: 0, executionAttemptId: params.executionAttemptId, mutate: (state) => {
    const step = state.steps[0]; assert.ok(step); step.status = 'launching'; step.attemptCount = 1
    state.currentStepId = step.stepId
  } })
  await stateStore.update({ expectedRevision: 1, executionAttemptId: params.executionAttemptId, mutate: (state) => {
    const step = state.steps[0]; assert.ok(step); step.status = 'running'
  } })
  const wait = await stateStore.requestAgentInput({
    executionAttemptId: params.executionAttemptId, stepId: 'write',
    invocation: {
      agentId: 'writer', agentDisplayName: 'Writer', logicalInvocationId: 'chain-step-one',
      dispatchId: 'dispatch-one', childRunId, teamId: 'writers', stageId: 'chain',
      definitionHash: hashWorkflowContent('writer:v1'),
    },
    request: { progress: 'I need the recipient.', questions: [{ question: 'Who is it for?', reason: 'Required.' }] },
    continuation: {
      systemPrompt: 'Private writer instructions.', userMessage: params.task.brief,
      provider: 'openai', model: 'fixture', thinking: 'low',
    },
  })
  assert.equal(wait.kind, 'awaiting_input')
  const parked = (await stateStore.load())?.state.agentQuestions?.interactions[0]
  assert.equal(parked?.status, 'pending', 'The fixture must park exactly one unanswered question')
}

/** Answer a parked question directly in the canonical store. */
async function answerParkedQuestion(task: SessionTask): Promise<void> {
  assert.ok(task.assignmentPath)
  const stateStore = new FileSystemWorkflowStateStore(task.assignmentPath)
  const parked = (await stateStore.load())?.state.agentQuestions?.interactions[0]
  assert.ok(parked)
  await stateStore.submitAgentInput({
    taskId: task.id, sessionId: task.sessionId, interactionId: parked.interactionId,
    expectedInteractionRevision: parked.revision, expectedRequestDigest: parked.requestDigest,
    submissionId: randomUUID(),
    answers: Object.fromEntries(parked.questionIds.map((id) => [id, 'Marta'])),
  })
}

async function seedParkedQuestion(params: { workspacePath: string; label: string }) {
  const sessionStore = new FileSystemSessionStore(params.workspacePath, { instanceId: `${params.label}-source-${Date.now()}` })
  const session = await sessionStore.createSession({ title: params.label })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: `${params.label}-workflow`, brief: 'Write a dedication.',
  })
  assert.ok(task)
  const executionAttemptId = randomUUID()
  const waiting = await sessionStore.compareAndSetTaskRecord(session.id, task.id, ['queued'], {
    status: 'awaiting_input', executionAttemptId, processIdentity: executionAttemptId,
    executionAttemptNumber: 1, executionKind: 'initial', recoveryCount: 0,
  }, { expectedExecutionAttemptId: null })
  assert.equal(waiting?.updated, true)
  await initializePendingAgentQuestion({ task, executionAttemptId })
  return { sessionStore, session, task, executionAttemptId }
}

/** Grants the queue has released, as it persists them. */
function releasedGrants(workspacePath: string, taskId: string): string[] {
  const eventsPath = path.join(workspacePath, 'task-queue', 'events.jsonl')
  if (!fs.existsSync(eventsPath)) return []
  return fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { event?: string; task_id?: string; grant_id?: string })
    .filter((entry) => entry.event === 'task_queue.released' && entry.task_id === taskId)
    .map((entry) => entry.grant_id ?? '')
}

/** Failed probes, as the queue persists them. `defer` runs before the emit. */
function countDispatchFailures(workspacePath: string): number {
  const eventsPath = path.join(workspacePath, 'task-queue', 'events.jsonl')
  if (!fs.existsSync(eventsPath)) return 0
  return fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { event?: string })
    .filter((entry) => entry.event === 'task_queue.dispatch_failed').length
}

test('a parked question whose canonical state cannot be read waits before trying again', async () => {
  const workspacePath = makeWorkspace()
  const { sessionStore, session, task, executionAttemptId } = await seedParkedQuestion({
    workspacePath, label: 'queue-unreadable-question',
  })
  assert.ok(task.assignmentPath)
  const statePath = new FileSystemWorkflowStateStore(task.assignmentPath).paths.statePath
  const healthyState = fs.readFileSync(statePath, 'utf8')

  let clockMs = Date.parse('2026-09-20T12:00:00.000Z')
  // Counted where the probe STARTS its read, before its first await, so a read
  // that began is observed even if it never finishes.
  let readStarts = 0
  const queueStore = new FileSystemSessionStore(workspacePath, { instanceId: `queue-unreadable-target-${Date.now()}` })
  const countingStore = new Proxy(queueStore, {
    get(target, property, receiver) {
      if (property !== 'getTaskRecord') return Reflect.get(target, property, receiver)
      return (readSessionId: string, readTaskId: string) => {
        if (readTaskId === task.id) readStarts += 1
        return queueStore.getTaskRecord(readSessionId, readTaskId)
      }
    },
  })
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new BlockingLauncher()
  const taskQueue = new TaskQueue({
    sessionStore: countingStore, owner, maximumConcurrentTasks: 16,
    repoRootPath: process.cwd(), workspacePath,
    taskLauncher: launcher, tickIntervalMs: TEST_TICK_INTERVAL_MS, now: () => new Date(clockMs),
  })
  const admitRecovery = async () => {
    const unrelated = await startUnrelatedRecovery({ queue: taskQueue, store: sessionStore, sessionId: session.id })
    await waitFor(() => launcher.starts.some((start) => start.taskId === unrelated), 'the unrelated recovery to launch')
  }
  try {
    await taskQueue.initialize()

    // Make the canonical state unreadable and let a probe fail on it. The
    // persisted failure is the completion signal: the probe defers its watch
    // before reporting, so seeing the report means the defer has happened.
    fs.writeFileSync(statePath, '{ not json')
    clockMs += 10 * 60_000
    taskQueue.wake()
    await waitFor(() => countDispatchFailures(workspacePath) > 0, 'a failed canonical read to be reported')
    const afterFailure = readStarts

    // Clock held still, so a watch that waited is not due. Two recoveries in
    // sequence: the second launch proves the first post-failure dispatch has
    // reached the point where a due probe would already have started its read.
    await admitRecovery()
    await admitRecovery()

    assert.equal(readStarts, afterFailure,
      'A failing read must wait like any other, not start again on the next dispatch')

    // Hours later the state is readable again and the person has answered. The
    // watch never expired, so that answer is admitted as a real continuation
    // under a new attempt.
    fs.writeFileSync(statePath, healthyState)
    await answerParkedQuestion(task)
    clockMs += 6 * 60 * 60_000
    taskQueue.wake()
    await waitFor(async () => (await sessionStore.getTaskRecord(session.id, task.id))?.admission?.phase === 'granted',
      'the recovered read to admit a continuation')
    const admitted = await sessionStore.getTaskRecord(session.id, task.id)
    assert.equal(admitted?.executionKind, 'continuation')
    assert.notEqual(admitted?.executionAttemptId, executionAttemptId,
      'The continuation must run under a new execution attempt')
    const canonical = await new FileSystemWorkflowStateStore(task.assignmentPath).load()
    assert.equal(canonical?.state.agentQuestions?.interactions[0]?.status, 'submitted',
      'The admitted continuation must be the one carrying the saved answer')
  } finally {
    await taskQueue.close(1)
    await owner.release()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a newly parked execution attempt is read at once rather than serving out the previous wait', async () => {
  const workspacePath = makeWorkspace()
  const { sessionStore, session, task, executionAttemptId } = await seedParkedQuestion({
    workspacePath, label: 'queue-new-attempt-question',
  })
  assert.ok(task.assignmentPath)
  const stateStore = new FileSystemWorkflowStateStore(task.assignmentPath)
  const statePath = stateStore.paths.statePath
  const healthyState = fs.readFileSync(statePath, 'utf8')

  let clockMs = Date.parse('2026-09-20T12:00:00.000Z')
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new BlockingLauncher()
  const taskQueue = new TaskQueue({
    sessionStore: new FileSystemSessionStore(workspacePath, { instanceId: `queue-new-attempt-target-${Date.now()}` }),
    owner, maximumConcurrentTasks: 16, repoRootPath: process.cwd(), workspacePath,
    taskLauncher: launcher, tickIntervalMs: TEST_TICK_INTERVAL_MS, now: () => new Date(clockMs),
  })
  try {
    await taskQueue.initialize()
    // Give the first round's watch a wait that is demonstrably still running.
    // A failed read is the one probe outcome this boundary reports, and the
    // probe defers before reporting, so the persisted failure proves the defer
    // happened rather than assuming the canonical read finished.
    fs.writeFileSync(statePath, '{ not json')
    clockMs += 10 * 60_000
    taskQueue.wake()
    await waitFor(() => countDispatchFailures(workspacePath) > 0, 'the first watch to be read and deferred')
    fs.writeFileSync(statePath, healthyState)
    // The clock stops here, so that deferred deadline stays in the future.

    // The person answers, and the run is admitted the ordinary way.
    await answerParkedQuestion(task)
    await taskQueue.enqueueContinuation({ sessionId: session.id, taskId: task.id, source: 'agent_question' })
    await waitFor(() => launcher.starts.some((start) => start.taskId === task.id), 'the answered run to launch')
    const granted = await sessionStore.getTaskRecord(session.id, task.id)
    assert.equal(granted?.admission?.phase, 'granted')
    const grantedAttemptId = granted?.executionAttemptId
    assert.ok(grantedAttemptId)
    assert.notEqual(grantedAttemptId, executionAttemptId)

    // That worker consumes the answered round, then a second agent asks its own
    // blocking question, which the person answers straight away.
    const parked = (await stateStore.load())?.state.agentQuestions?.interactions[0]
    assert.ok(parked)
    if (parked.status !== 'submitted') throw new Error('Expected the first round to hold its answer')
    await stateStore.claimAgentQuestionContinuation({
      interactionId: parked.interactionId, submissionId: parked.submission.submissionId,
      expectedOwnerExecutionAttemptId: executionAttemptId, nextExecutionAttemptId: grantedAttemptId,
      continuationAdmissionRequestId: granted.admission.requestId,
    })
    await stateStore.resolveAgentQuestion({
      executionAttemptId: grantedAttemptId, interactionId: parked.interactionId,
      agentId: 'writer', logicalInvocationId: 'chain-step-one',
      result: {
        text: 'For Marta, a flower opens in the morning light.', model: 'fixture',
        toolCallCount: 0, executedToolCallCount: 0,
        usage: { inputTokens: 10, outputTokens: 12, totalTokens: 22 },
      },
    })
    const step = (await stateStore.load())?.state.steps[0]
    assert.ok(step?.childRunId)
    const second = await stateStore.requestAgentInput({
      executionAttemptId: grantedAttemptId, stepId: 'write',
      invocation: {
        agentId: 'editor', agentDisplayName: 'Editor', logicalInvocationId: 'chain-step-two',
        dispatchId: 'dispatch-two', childRunId: step.childRunId, teamId: 'writers', stageId: 'chain',
        definitionHash: hashWorkflowContent('editor:v1'),
      },
      request: { progress: 'I need the tone.', questions: [{ question: 'Formal or warm?', reason: 'Required.' }] },
      continuation: {
        systemPrompt: 'Private editor instructions.', userMessage: task.brief,
        provider: 'openai', model: 'fixture', thinking: 'low',
      },
    })
    assert.equal(second.kind, 'awaiting_input')
    if (second.kind !== 'awaiting_input') throw new Error('Expected a second question')
    const secondSaved = await stateStore.readAgentQuestion(second.interactionId)
    await stateStore.submitAgentInput({
      taskId: task.id, sessionId: session.id, interactionId: second.interactionId,
      expectedInteractionRevision: secondSaved.interaction.revision,
      expectedRequestDigest: secondSaved.interaction.requestDigest,
      submissionId: randomUUID(),
      answers: Object.fromEntries(secondSaved.interaction.questionIds.map((id) => [id, 'Warm'])),
    })

    // The granted worker now parks on that second round, under its own attempt.
    await sessionStore.compareAndSetTaskRecord(session.id, task.id, ['queued', 'running'], {
      status: 'awaiting_input',
    })

    // The previous round's wait is still in the future. This newly parked
    // attempt must not serve it out: its answer is already waiting.
    taskQueue.wake()
    await waitFor(async () => {
      const readmitted = await sessionStore.getTaskRecord(session.id, task.id)
      return readmitted?.admission?.phase === 'granted' && readmitted.executionAttemptId !== grantedAttemptId
    }, 'the newly parked attempt to be read and admitted')
    const readmitted = await sessionStore.getTaskRecord(session.id, task.id)
    assert.equal(readmitted?.executionKind, 'continuation')
    const canonical = await stateStore.load()
    assert.equal(canonical?.state.agentQuestions?.interactions[1]?.status, 'submitted',
      'The admitted continuation must carry the second round\'s saved answer')
  } finally {
    await taskQueue.close(1)
    await owner.release()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

/**
 * The two ways a read that finished late could take back the watch that
 * replaced it: by dropping it, and by putting it back on its own old schedule.
 * The second needs the late read to fail, which is the one probe outcome this
 * boundary reports.
 */
const LATE_PROBE_OUTCOMES = [
  { name: 'reads a state that has moved on', breakNewStateFirst: false },
  { name: 'fails on a state it cannot read', breakNewStateFirst: true },
] as const

for (const outcome of LATE_PROBE_OUTCOMES) test(`a read still in flight cannot take back the watch a newly parked attempt was given when it ${outcome.name}`, async () => {
  const workspacePath = makeWorkspace()
  const { sessionStore, session, task, executionAttemptId } = await seedParkedQuestion({
    workspacePath, label: 'queue-late-probe-question',
  })
  assert.ok(task.assignmentPath)
  const stateStore = new FileSystemWorkflowStateStore(task.assignmentPath)

  let clockMs = Date.parse('2026-09-20T12:00:00.000Z')
  // A gate on the real store read, so the probe that opened it can be left in
  // flight while the run moves on underneath it.
  let holdParkedRead = false
  let releaseHeldRead: (() => void) | undefined
  const queueStore = new FileSystemSessionStore(workspacePath, { instanceId: `queue-late-probe-target-${Date.now()}` })
  const gatedStore = new Proxy(queueStore, {
    get(target, property, receiver) {
      if (property !== 'getTaskRecord') return Reflect.get(target, property, receiver)
      return async (readSessionId: string, readTaskId: string) => {
        // Claimed before the real read, so a second caller cannot take the gate.
        const holdThisRead = readTaskId === task.id && holdParkedRead
        if (holdThisRead) holdParkedRead = false
        // Read now, deliver later: the probe resumes carrying the record it
        // captured before the run moved on underneath it.
        const captured = await queueStore.getTaskRecord(readSessionId, readTaskId)
        if (holdThisRead) await new Promise<void>((resolve) => { releaseHeldRead = resolve })
        return captured
      }
    },
  })
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new BlockingLauncher()
  const taskQueue = new TaskQueue({
    sessionStore: gatedStore, owner, maximumConcurrentTasks: 16,
    repoRootPath: process.cwd(), workspacePath,
    taskLauncher: launcher, tickIntervalMs: TEST_TICK_INTERVAL_MS, now: () => new Date(clockMs),
  })
  try {
    await taskQueue.initialize()

    // Open a probe read on the first attempt's watch and leave it in flight.
    holdParkedRead = true
    clockMs += 10 * 60_000
    taskQueue.wake()
    await waitFor(() => releaseHeldRead !== undefined, 'a probe read to be in flight')

    // Meanwhile the run is answered, admitted, asks a second round and parks on
    // it under the granted attempt, which replaces the watch.
    await answerParkedQuestion(task)
    await taskQueue.enqueueContinuation({ sessionId: session.id, taskId: task.id, source: 'agent_question' })
    await waitFor(() => launcher.starts.some((start) => start.taskId === task.id), 'the answered run to launch')
    const granted = await sessionStore.getTaskRecord(session.id, task.id)
    assert.ok(granted?.admission && granted.executionAttemptId)
    if (granted.admission.phase !== 'granted') throw new Error('Expected a granted admission')
    const grantedAdmissionId = granted.admission.grantId
    const grantedRequestId = granted.admission.requestId
    const grantedAttemptId = granted.executionAttemptId
    const first = (await stateStore.load())?.state.agentQuestions?.interactions[0]
    assert.ok(first)
    if (first.status !== 'submitted') throw new Error('Expected the first round to hold its answer')
    await stateStore.claimAgentQuestionContinuation({
      interactionId: first.interactionId, submissionId: first.submission.submissionId,
      expectedOwnerExecutionAttemptId: executionAttemptId, nextExecutionAttemptId: grantedAttemptId,
      continuationAdmissionRequestId: grantedRequestId,
    })
    await stateStore.resolveAgentQuestion({
      executionAttemptId: grantedAttemptId, interactionId: first.interactionId,
      agentId: 'writer', logicalInvocationId: 'chain-step-one',
      result: {
        text: 'For Marta.', model: 'fixture', toolCallCount: 0, executedToolCallCount: 0,
        usage: { inputTokens: 10, outputTokens: 12, totalTokens: 22 },
      },
    })
    const step = (await stateStore.load())?.state.steps[0]
    assert.ok(step?.childRunId)
    const second = await stateStore.requestAgentInput({
      executionAttemptId: grantedAttemptId, stepId: 'write',
      invocation: {
        agentId: 'editor', agentDisplayName: 'Editor', logicalInvocationId: 'chain-step-two',
        dispatchId: 'dispatch-two', childRunId: step.childRunId, teamId: 'writers', stageId: 'chain',
        definitionHash: hashWorkflowContent('editor:v1'),
      },
      request: { progress: 'I need the tone.', questions: [{ question: 'Formal or warm?', reason: 'Required.' }] },
      continuation: {
        systemPrompt: 'Private editor instructions.', userMessage: task.brief,
        provider: 'openai', model: 'fixture', thinking: 'low',
      },
    })
    if (second.kind !== 'awaiting_input') throw new Error('Expected a second question')
    const secondSaved = await stateStore.readAgentQuestion(second.interactionId)
    await stateStore.submitAgentInput({
      taskId: task.id, sessionId: session.id, interactionId: second.interactionId,
      expectedInteractionRevision: secondSaved.interaction.revision,
      expectedRequestDigest: secondSaved.interaction.requestDigest,
      submissionId: randomUUID(),
      answers: Object.fromEntries(secondSaved.interaction.questionIds.map((id) => [id, 'Warm'])),
    })
    await sessionStore.compareAndSetTaskRecord(session.id, task.id, ['queued', 'running'], { status: 'awaiting_input' })
    taskQueue.wake()
    // The release path remembers the newly parked attempt's watch before it
    // reports, so this event proves the replacement has happened.
    await waitFor(() => releasedGrants(workspacePath, task.id).includes(grantedAdmissionId),
      'the granted task to be released back to its new wait')

    // For the defer branch the late read has to FAIL, so the canonical state is
    // briefly unreadable. The probe defers before it reports, so the extra
    // persisted failure is what proves that deferral has happened.
    const healthyNewState = fs.readFileSync(stateStore.paths.statePath, 'utf8')
    const failuresBefore = countDispatchFailures(workspacePath)
    if (outcome.breakNewStateFirst) fs.writeFileSync(stateStore.paths.statePath, '{ not json')

    // Only now does the old read finish, carrying the record it captured before
    // any of that. It belongs to a watch that no longer exists, so it must not
    // reschedule or drop the one that replaced it.
    releaseHeldRead?.()

    if (outcome.breakNewStateFirst) {
      await waitFor(() => countDispatchFailures(workspacePath) > failuresBefore,
        'the late read to fail and defer')
      fs.writeFileSync(stateStore.paths.statePath, healthyNewState)
    }

    await waitFor(async () => {
      // The replacement watch is due now; each pass gives it a dispatch to be
      // read on.
      taskQueue.wake()
      const readmitted = await sessionStore.getTaskRecord(session.id, task.id)
      return readmitted?.admission?.phase === 'granted' && readmitted.executionAttemptId !== grantedAttemptId
    }, 'the second answered round to be admitted despite the late read')
    const canonical = await stateStore.load()
    assert.equal(canonical?.state.agentQuestions?.interactions[1]?.status, 'submitted',
      'The admitted continuation must carry the second round\'s saved answer')
  } finally {
    releaseHeldRead?.()
    await taskQueue.close(1)
    await owner.release()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
