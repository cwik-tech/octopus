import { resolveWorkflowJournalRecorder } from './workflow-journal-recorder.js'
import type { WorkflowJournalRecorder } from '../workflows/workflow-journal.js'
import type { WorkspaceExecutionJournalRegistry } from './workspace-execution-journal-registry.js'
import { whenDefined } from '../core/optional-properties.js'
import { nextAgentQuestionRead } from '../core/agent-question-watch-schedule.js'
import { prepareAttemptOwnedProcessScope } from '../core/owned-processes/owned-process-scope.js'
import { taskOwnedProcessesClosed } from '../domains/sessions/task-owned-processes.js'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { RunLauncher } from '../domains/run/run-launcher.js'
import {
  SCHEDULING_QUEUE_SNAPSHOT_VERSION,
  type SchedulingQueueHold,
  type SchedulingQueueItem,
  type SchedulingQueueSnapshot,
} from '../domains/scheduling/scheduling-queue.js'
import type {
  CreateTaskInput,
  SessionStore,
} from '../domains/sessions/session-store.js'
import {
  isTerminalTaskStatus,
  isValidSessionId,
  type SessionTask,
  type TaskAdmission,
  type TaskAdmissionSource,
} from '../contracts/sessions.js'
import {
  FileSystemWorkflowStateStore,
  isTerminalWorkflowStepStatus,
} from '../workflows/workflow-state-store.js'
import {
  classifyTaskProcessesByIdentity,
  defaultIsProcessAlive,
  isTaskProcessIdentityValid,
  taskProcessTarget,
} from '../domains/sessions/task-process-supervisor.js'
import type { WorkspaceDispatcherOwner } from '../core/workspace-dispatcher-owner.js'
import type { AgentTextStreamLaunchPort } from '../domains/runtime/agent-text-delta-launch.js'
import type { ResourceLibraryService } from './resource-library-service.js'
import {
  emitWorkspaceTaskQueueEvent,
  type TaskQueueEventName,
} from '../core/task-queue-events.js'
import {
  launchReservedTaskExecutionAttempt,
  openTaskLaunchGate,
  type SessionTaskLaunchResult,
} from './task-service.js'

/**
 * Everything that has to still be true for a deferred approval to be the same
 * one. The attempt fences the execution; the assignment fences which authority
 * and which projection the answer would come from.
 */
interface DeferredModelChoiceEntry {
  readonly reference: TaskReference
  readonly executionAttemptId: string
  readonly assignmentId?: string
  readonly assignmentPath?: string
}

/**
 * A canonical read that says whether it could read at all.
 *
 * `unavailable` is an enrolled authority this process could not reach; `read`
 * carries what the authority actually holds, which may legitimately be nothing.
 */
type CanonicalWorkflowRead =
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'read'
      readonly snapshot: Awaited<ReturnType<FileSystemWorkflowStateStore['load']>>
    }

const DEFAULT_TICK_INTERVAL_MS = 1_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000

export class TaskQueueError extends Error {
  constructor(
    readonly code:
      | 'task_admission_recovering'
      | 'task_admission_conflict'
      | 'task_store_unsupported'
      | 'task_queue_closed',
    message: string,
  ) {
    super(message)
    this.name = 'TaskQueueError'
  }
}

export interface TaskQueueOptions {
  /** View invalidation after a committed task change, including scheduled admission. */
  readonly onSessionChanged?: (sessionId: string) => void
  /** Absent means Team runs simply show no live text. */
  readonly textStream?: AgentTextStreamLaunchPort;
  sessionStore: SessionStore
  /**
   * The workspace's execution journal authority, when one is enrolled.
   *
   * Startup adoption reads durable workflow state through it, so a projection
   * that is behind or unreadable is rebuilt rather than believed.
   */
  readonly executionJournalRegistry?: WorkspaceExecutionJournalRegistry
  owner: WorkspaceDispatcherOwner
  maximumConcurrentTasks: number
  repoRootPath: string
  workspacePath: string
  workflowsRegistryPath?: string
  resourceLibraryService?: Pick<ResourceLibraryService, "createTaskProjection">
  taskLauncher?: RunLauncher
  tickIntervalMs?: number
  durableRecoveryEnabled?: boolean
  maxAutomaticRecoveries?: number
  now?: () => Date
}

/** One parked run being watched for an answer, and when to read it next. */
interface AgentQuestionWatch {
  readonly reference: TaskReference
  /** The parked attempt this watch belongs to, not merely its task. */
  readonly executionAttemptId: string
  readonly dueAtMs: number
  readonly misses: number
}

export interface EnqueueInitialTaskInput {
  sessionId: string
  task: Omit<CreateTaskInput, 'admission'>
  /** Defaults to 'apply'; durable automation passes its source explicitly. */
  admissionSource?: Extract<TaskAdmissionSource, 'apply' | 'scheduled' | 'batch'>
}

export interface TaskQueueInitializationResult {
  pending: number
  granted: number
  legacyActive: number
}

interface TaskReference {
  sessionId: string
  taskId: string
}

interface PendingReference extends TaskReference {
  order: bigint
  requestId: string
}

interface PostMutationActions {
  launch: SessionTask[]
  openGate: SessionTask[]
  reconcileAdmitted: Map<string, TaskReference>
  /**
   * The reconciled grants whose launch is in flight. Their reconcile does not
   * wake the queue at once: the launch wakes it when it ends, and recovery's
   * rules for a worker that never started are applied on the next pass.
   */
  reconcileLaunching: Set<string>
  reconcileSessions: Set<string>
  /**
   * Tasks held until their descendants are verified gone. Reconciled so
   * recovery closes their scope again, but the queue wakes only when a hold
   * clears, so a hold that persists cannot spin it.
   */
  reconcileHeld: Map<string, TaskReference>
}

export class TaskQueue {
  private readonly pending = new Map<string, PendingReference>()
  /**
   * Pending requests that cannot be granted yet for a reason no dispatch can
   * change (their next scope could not be prepared, or the previous attempt
   * is not verified gone): skipped until the next periodic pass clears this,
   * so a lasting reason cannot make the dispatcher run again at once.
   */
  private readonly waitingForPeriodicPass = new Set<string>()
  /**
   * The hold last reported for each held task, so a hold that stays the
   * same is reported once rather than on every pass.
   */
  private readonly reportedHolds = new Map<string, string>()
  /** The last scope-preparation failure reported for each request, by request id. */
  private readonly scopePreparationFailures = new Map<string, string>()
  private readonly granted = new Map<string, TaskReference>()
  private readonly legacyActive = new Map<string, TaskReference>()
  /**
   * Legacy-active tasks an earlier version had already finished, its slot
   * released, when this version started. Each counts only while its root may
   * live, as before; no hold is written for its descendants (ADR section 7).
   */
  private readonly legacyReleasedAtStartup = new Set<string>()
  private readonly liveTaskProjection = new Map<string, SessionTask>()
  private readonly preparingInitial = new Set<bigint>()
  private readonly inFlightLaunches = new Set<Promise<void>>()
  private readonly inFlightDispatches = new Set<Promise<void>>()
  private readonly inFlightTaskAttempts = new Set<string>()
  private mutationTail: Promise<void> = Promise.resolve()
  private nextOrder = 1n
  private ready = false
  private closed = false
  private wakeScheduled = false
  /** The one in-flight deferred probe, tracked so shutdown can wait for it. */
  private deferredModelChoiceProbe: Promise<void> | undefined
  private agentQuestionProbe: Promise<void> | undefined
  private readonly agentQuestionWaits = new Map<string, AgentQuestionWatch>()
  /**
   * Tasks whose approved continuation could not be decided because the
   * canonical authority was unreachable, with the execution attempt each was
   * deferred under.
   *
   * Bounded by construction rather than by a cap: only startup adoption adds to
   * it, over the finite set of tasks that snapshot held, and every later pass
   * revisits existing keys and only ever removes them. A cap would have to
   * choose between forgetting an approved task — stranding a decision the user
   * already made — and failing visibly, and neither is needed when the set
   * cannot grow on its own.
   */
  private readonly deferredModelChoiceAdoptions = new Map<
    string,
    DeferredModelChoiceEntry
  >()
  private dispatchRunning = false
  private dispatchRequested = false
  private dispatchBlockedByAmbiguity = false
  /**
   * Why each held task holds its slot, as the last pass found it. Set where
   * the pass decides the hold, with the blocked flag for the root reasons, so
   * the snapshot's items say what its status says.
   */
  private holds = new Map<string, { readonly reference: TaskReference; readonly hold: SchedulingQueueHold }>()
  /** The blocking tasks the event log last named; empty when it last said none. */
  private reportedBlockingSet = ''
  private tick: NodeJS.Timeout | undefined
  private maximumConcurrentTasksValue: number
  private readonly now: () => Date

  constructor(private readonly options: TaskQueueOptions) {
    this.maximumConcurrentTasksValue = options.maximumConcurrentTasks
    this.now = options.now ?? (() => new Date())
  }

  get maximumConcurrentTasks(): number {
    return this.maximumConcurrentTasksValue
  }

  isReady(): boolean {
    return this.ready && !this.closed
  }

  async snapshot(): Promise<SchedulingQueueSnapshot> {
    return this.withMutation(async () => {
      const slotsInUse = this.granted.size + this.legacyActive.size
      const items = [...this.liveTaskProjection.values()]
        .sort(compareProjectedQueueTasks)
        .map((task) => schedulingQueueItem(task, this.holds.get(taskKey(taskReference(task)))?.hold))
        .filter((item): item is SchedulingQueueItem => item !== null)
      return {
        version: SCHEDULING_QUEUE_SNAPSHOT_VERSION,
        status: !this.ready || this.closed
          ? 'recovering'
          : this.dispatchBlockedByAmbiguity
            ? 'blocked'
            : 'ready',
        maximumConcurrentTasks: this.maximumConcurrentTasksValue,
        slotsInUse,
        availableSlots: Math.max(
          0,
          this.maximumConcurrentTasksValue - slotsInUse,
        ),
        waitingCount: this.pending.size,
        observedAt: this.now().toISOString(),
        items,
      }
    })
  }

  async initialize(): Promise<TaskQueueInitializationResult> {
    if (this.closed) throw new TaskQueueError('task_queue_closed', 'Task queue is closed')
    if (!this.options.sessionStore.listTaskRecordsStrict) {
      throw new TaskQueueError(
        'task_store_unsupported',
        'Session store does not support strict queue startup enumeration',
      )
    }

    await this.options.owner.assertCurrent()
    const initialTasks = await this.options.sessionStore.listTaskRecordsStrict()
    this.initializeNextOrder(initialTasks)
    const startupAdmissionChanged = await this.withMutation(async () => {
      await this.options.owner.assertCurrent()
      let changed = false
      for (const task of initialTasks) {
        changed = (await this.adoptStartupTask(task)) || changed
      }
      return changed
    })
    await this.options.owner.assertCurrent()
    const applyRecoveryChanged =
      await this.options.sessionStore.recoverOrphanedRunPlanApplies?.() ?? false

    // Admission-aware tasks are deliberately skipped by generic reconciliation.
    // Reconcile only after they have been classified and indexed above.
    const sessionIds = new Set(
      initialTasks
        .filter((task) =>
          !task.admission &&
          (
            task.status === 'queued' ||
            task.status === 'running' ||
            task.status === 'awaiting_input' ||
            task.status === 'awaiting_model_choice' ||
            (
              task.status === 'cancelled' &&
              Boolean(taskProcessTarget(task) ?? task.processIdentity)
            )
          )
        )
        .map((task) => task.sessionId),
    )
    for (const sessionId of sessionIds) {
      await this.options.owner.assertCurrent()
      await this.options.sessionStore.reconcileTaskRecords(sessionId)
    }

    // Legacy executing tasks may become interrupted only after journal/process
    // reconciliation. Rescan so eligible automatic recoveries enter the same
    // durable FIFO path before readiness opens.
    await this.options.owner.assertCurrent()
    const needsRescan =
      startupAdmissionChanged || applyRecoveryChanged || sessionIds.size > 0
    const reconciledTasks = needsRescan
      ? await this.options.sessionStore.listTaskRecordsStrict()
      : initialTasks
    if (needsRescan) {
      await this.withMutation(async () => {
        await this.options.owner.assertCurrent()
        for (const task of reconciledTasks) await this.adoptStartupTask(task)
      })
    }

    const startupActions = await this.withMutation(async () => {
      await this.options.owner.assertCurrent()
      const actions = await this.refreshKnownTasksLocked(new Map(
        reconciledTasks.map((task) => [taskKey(taskReference(task)), task]),
      ))
      await this.refreshProjectionLocked()
      return actions
    })
    await this.executePostMutationActions(startupActions)
    await this.withMutation(async () => {
      await this.options.owner.assertCurrent()
      this.ready = true
    })
    this.tick = setInterval(
      () => {
        this.waitingForPeriodicPass.clear()
        this.wake()
      },
      this.options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
    )
    this.tick.unref()
    this.emit('task_queue.index_rebuilt', {
      indexed_tasks: reconciledTasks.length,
      next_order: this.nextOrder.toString(),
    })
    this.emit('task_queue.reconciled', {
      reconciled_tasks: reconciledTasks.length,
      reason: 'startup',
    })
    this.wake()
    return {
      pending: this.pending.size,
      granted: this.granted.size,
      legacyActive: this.legacyActive.size,
    }
  }

  async enqueueInitial(input: EnqueueInitialTaskInput): Promise<SessionTask> {
    const { admission, order } = await this.withMutation(async () => {
      this.requireReady()
      await this.options.owner.assertCurrent()
      const order = this.allocateOrder()
      const admission = this.createPendingAdmission({
        order,
        executionKind: 'initial',
        source: input.admissionSource ?? 'apply',
        expectedExecutionAttemptId: null,
        ...whenDefined(input.task.runPlanId, (definedValue) => ({ runPlanId: definedValue })),
        ...whenDefined(input.task.runPlanApplyClaimId, (definedValue) => ({ applyClaimId: definedValue })),
        phase: 'staged',
      })
      this.preparingInitial.add(order)
      return { admission, order }
    })

    try {
      const task = await this.options.sessionStore.createTaskRecord(
        input.sessionId,
        { ...input.task, admission },
        {
          beforeCommit: async () => {
            if (this.closed) {
              throw new TaskQueueError('task_queue_closed', 'Task queue is closed')
            }
            await this.options.owner.assertCurrent()
          },
        },
      )
      if (!task || task.admission?.phase !== 'pending') {
        throw new TaskQueueError(
          'task_admission_conflict',
          'Initial task admission did not commit',
        )
      }
      return await this.withMutation(async () => {
        this.preparingInitial.delete(order)
        this.requireReady()
        await this.options.owner.assertCurrent()
        this.addPending(task)
        this.emit('task_queue.enqueued', this.taskEventFields(task))
        queueMicrotask(() => this.wake())
        return task
      })
    } catch (error) {
      await this.withMutation(async () => {
        this.preparingInitial.delete(order)
      })
      this.wake()
      throw error
    }
  }

  async enqueueRecovery(params: {
    sessionId: string
    taskId: string
    source: Extract<TaskAdmissionSource, 'automatic_recovery' | 'manual_resume'>
  }): Promise<SessionTask> {
    return this.withMutation(async () => {
      this.requireReady()
      await this.options.owner.assertCurrent()
      const current = await this.options.sessionStore.getTaskRecord(
        params.sessionId,
        params.taskId,
      )
      if (!current) {
        throw new TaskQueueError('task_admission_conflict', 'Task was not found')
      }
      if (current.admission?.phase === 'pending' || current.admission?.phase === 'granted') {
        return current
      }
      if (current.status !== 'interrupted' || !current.executionAttemptId) {
        throw new TaskQueueError(
          'task_admission_conflict',
          `Task is ${current.status}, expected interrupted`,
        )
      }
      if (current.recoveryDisposition === 'not_resumable') {
        throw new TaskQueueError(
          'task_admission_conflict',
          current.recoveryReason ?? 'Task is not resumable',
        )
      }
      if (!(await this.previousAttemptVerifiedGone(current))) {
        const held = await this.options.sessionStore.getTaskRecord(params.sessionId, params.taskId)
        throw new TaskQueueError(
          'task_admission_conflict',
          held?.processCleanupHold?.detail ??
            'The task\'s previous attempt may still have running processes',
        )
      }
      const admission = this.createPendingAdmission({
        order: this.allocateOrder(),
        executionKind: 'recovery',
        source: params.source,
        expectedExecutionAttemptId: current.executionAttemptId,
        ...whenDefined(current.runPlanId, (definedValue) => ({ runPlanId: definedValue })),
        phase: 'pending',
      })
      await this.options.owner.assertCurrent()
      const updated = await this.options.sessionStore.compareAndSetTaskRecord(
        params.sessionId,
        params.taskId,
        ['interrupted'],
        { admission },
        {
          expectedExecutionAttemptId: current.executionAttemptId,
          expectedAdmissionRequestId: null,
        },
      )
      if (!updated?.updated) {
        if (updated?.task.admission) return updated.task
        throw new TaskQueueError(
          'task_admission_conflict',
          'Task changed before recovery admission committed',
        )
      }
      this.addPending(updated.task)
      this.emit('task_queue.enqueued', this.taskEventFields(updated.task))
      queueMicrotask(() => this.wake())
      return updated.task
    })
  }

  /**
   * Queue a worker that will consume an already-persisted human-input
   * submission. This is intentionally distinct from recovery: the existing
   * attempt is not a crash and recovery counters must not change.
   */
  /**
   * Re-admits a task a person has answered.
   *
   * Two waits reach this: content a person wrote, and a decision a person
   * approved. The waiting status and the admission source travel together so
   * one wait's answer can never release the other, and so the journal says
   * which kind of consent restarted the work.
   */
  async enqueueContinuation(params: {
    sessionId: string
    taskId: string
    from?: 'awaiting_input' | 'awaiting_model_choice'
    source?: 'human_input' | 'model_choice' | 'agent_question'
  }): Promise<SessionTask> {
    return this.withMutation(async () => {
      this.requireReady()
      await this.options.owner.assertCurrent()
      const current = await this.options.sessionStore.getTaskRecord(
        params.sessionId,
        params.taskId,
      )
      if (!current) {
        throw new TaskQueueError('task_admission_conflict', 'Task was not found')
      }
      if (current.processCleanupHold !== undefined) {
        // Held until its descendants are verified gone. The answer or consent
        // is already recorded in the workflow journal; the continuation is
        // staged once the hold clears, not now.
        this.emit('task_queue.reconciled', {
          ...this.taskEventFields(current),
          reason: 'continuation_deferred_for_owned_process_cleanup',
        })
        return current
      }
      const waitingStatus = params.from ?? 'awaiting_input'
      const admissionSource = params.source ?? 'human_input'
      if (current.admission?.phase === 'pending' || current.admission?.phase === 'granted') {
        if (
          current.admission.executionKind === 'continuation' &&
          current.admission.source === admissionSource
        ) {
          return current
        }
        throw new TaskQueueError(
          'task_admission_conflict',
          'Task already has a non-continuation admission.',
        )
      }
      if (current.status !== waitingStatus || !current.executionAttemptId) {
        throw new TaskQueueError(
          'task_admission_conflict',
          `Task is ${current.status}, expected ${waitingStatus} with an execution attempt`,
        )
      }
      const admission = this.createPendingAdmission({
        order: this.allocateOrder(),
        executionKind: 'continuation',
        source: admissionSource,
        expectedExecutionAttemptId: current.executionAttemptId,
        ...whenDefined(current.runPlanId, (definedValue) => ({ runPlanId: definedValue })),
        phase: 'pending',
      })
      await this.options.owner.assertCurrent()
      const updated = await this.options.sessionStore.compareAndSetTaskRecord(
        params.sessionId,
        params.taskId,
        [waitingStatus],
        { admission },
        {
          expectedExecutionAttemptId: current.executionAttemptId,
          expectedAdmissionRequestId: null,
        },
      )
      if (!updated?.updated) {
        if (
          updated?.task.admission?.executionKind === 'continuation' &&
          updated.task.admission.source === admissionSource
        ) {
          return updated.task
        }
        throw new TaskQueueError(
          'task_admission_conflict',
          'Task changed before continuation admission committed',
        )
      }
      this.addPending(updated.task)
      this.emit('task_queue.enqueued', this.taskEventFields(updated.task))
      queueMicrotask(() => this.wake())
      return updated.task
    })
  }

  async adoptDurableAdmission(params: {
    sessionId: string
    taskId: string
  }): Promise<SessionTask> {
    const task = await this.withMutation(async () => {
      this.requireReady()
      await this.options.owner.assertCurrent()
      let current = await this.options.sessionStore.getTaskRecord(
        params.sessionId,
        params.taskId,
      )
      if (!current) {
        throw new TaskQueueError('task_admission_conflict', 'Task was not found')
      }
      if (current.admission?.phase === 'staged') {
        if (!this.options.sessionStore.repairStagedTaskAdmission) {
          throw new TaskQueueError(
            'task_store_unsupported',
            'Session store does not support staged admission repair',
          )
        }
        await this.options.owner.assertCurrent()
        current = await this.options.sessionStore.repairStagedTaskAdmission(
          params.sessionId,
          params.taskId,
        )
        if (!current) {
          throw new TaskQueueError(
            'task_admission_conflict',
            'Staged task admission could not be repaired',
          )
        }
      }
      if (current.admission?.phase === 'pending') {
        const key = taskKey(taskReference(current))
        const wasIndexed = this.pending.has(key)
        this.addPending(current)
        if (!wasIndexed) {
          this.emit('task_queue.enqueued', {
            ...this.taskEventFields(current),
            reason: 'durable_admission_adopted',
          })
        }
      } else if (current.admission?.phase === 'granted') {
        if (current.admission.executionAttemptId !== current.executionAttemptId) {
          throw new TaskQueueError(
            'task_admission_conflict',
            'Granted admission conflicts with its execution attempt',
          )
        }
        this.granted.set(current.admission.grantId, taskReference(current))
        this.rememberTask(current)
      }
      return current
    })
    this.wake()
    return task
  }

  async updateMaximumConcurrentTasks<T>(
    next: number,
    persist: () => Promise<T>,
  ): Promise<T> {
    const result = await this.withMutation(async () => {
      this.requireReady()
      await this.options.owner.assertCurrent()
      const previousLimit = this.maximumConcurrentTasksValue
      const persisted = await persist()
      await this.options.owner.assertCurrent()
      this.maximumConcurrentTasksValue = next
      this.emit('task_queue.limit_updated', {
        previous_limit: previousLimit,
        maximum_concurrent_tasks: next,
      })
      return persisted
    })
    this.wake()
    return result
  }

  wake(): void {
    if (!this.isReady()) return
    if (this.dispatchRunning) {
      this.dispatchRequested = true
      return
    }
    if (this.wakeScheduled) return
    this.wakeScheduled = true
    queueMicrotask(() => {
      this.wakeScheduled = false
      const dispatch = this.dispatch()
      this.inFlightDispatches.add(dispatch)
      void dispatch
        .catch((error) => {
          this.emit('task_queue.dispatch_failed', {
            reason: error instanceof Error ? error.message : String(error),
          })
        })
        .finally(() => this.inFlightDispatches.delete(dispatch))
    })
  }

  /**
   * Resolves once no dispatch is running, requested or scheduled: the queue
   * has nothing left to do until something wakes it.
   */
  async whenIdle(): Promise<void> {
    while (this.dispatchRunning || this.dispatchRequested || this.wakeScheduled || this.inFlightDispatches.size > 0) {
      await Promise.allSettled([...this.inFlightDispatches])
      // A wake that is scheduled starts its dispatch on the microtask queue.
      await new Promise<void>((resolve) => { queueMicrotask(resolve) })
    }
  }

  async close(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    this.ready = false
    this.closed = true
    if (this.tick) clearInterval(this.tick)
    this.tick = undefined
    const work = [
      ...this.inFlightDispatches,
      ...this.inFlightLaunches,
      ...(this.deferredModelChoiceProbe ? [this.deferredModelChoiceProbe] : []),
      ...(this.agentQuestionProbe ? [this.agentQuestionProbe] : []),
    ]
    if (work.length === 0) return
    let timeout: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        Promise.allSettled(work),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, timeoutMs)
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private async dispatch(): Promise<void> {
    if (this.dispatchRunning) {
      this.dispatchRequested = true
      return
    }
    if (!this.isReady()) return
    this.dispatchRunning = true
    try {
      const actions = await this.withMutation(async () => {
        await this.options.owner.assertCurrent()
        const actions = await this.refreshKnownTasksLocked()
        const reservations = await this.reserveAvailableLocked()
        actions.launch.push(...reservations)
        await this.refreshProjectionLocked()
        return actions
      })
      await this.executePostMutationActions(actions)
    } finally {
      this.dispatchRunning = false
      const dispatchRequested = this.dispatchRequested
      this.dispatchRequested = false
      // Detached on purpose, and started only once this dispatch has released
      // the queue. Reading a canonical authority takes as long as that
      // authority takes; awaiting it here would park every admission,
      // reservation and launch behind an outage that has nothing to do with
      // them.
      this.startDeferredModelChoiceProbe()
      this.startAgentQuestionProbe()
      if (
        this.isReady() &&
        (
          dispatchRequested ||
          (
            // A blocked queue reserves nothing, so dispatching again at once
            // would change nothing: it looks again on the periodic pass or
            // on any other wake.
            !this.dispatchBlockedByAmbiguity &&
            [...this.pending.keys()].some((key) => !this.waitingForPeriodicPass.has(key)) &&
            this.granted.size + this.legacyActive.size < this.maximumConcurrentTasksValue
          )
        )
      ) {
        this.wake()
      }
    }
  }

  private async reserveAvailableLocked(): Promise<SessionTask[]> {
    const reservations: SessionTask[] = []
    if (this.dispatchBlockedByAmbiguity) return reservations
    let usage = this.granted.size + this.legacyActive.size
    const earliestPreparingOrder = [...this.preparingInitial].reduce<bigint | undefined>(
      (earliest, order) => earliest === undefined || order < earliest ? order : earliest,
      undefined,
    )
    const pending = [...this.pending.values()].sort((left, right) =>
      left.order < right.order ? -1 : left.order > right.order ? 1 : 0,
    )
    for (const reference of pending) {
      if (usage >= this.maximumConcurrentTasksValue) break
      if (
        earliestPreparingOrder !== undefined &&
        earliestPreparingOrder < reference.order
      ) {
        break
      }
      if (this.waitingForPeriodicPass.has(taskKey(reference))) continue
      const task = await this.options.sessionStore.getTaskRecord(
        reference.sessionId,
        reference.taskId,
      )
      if (
        !task ||
        task.admission?.phase !== 'pending' ||
        task.admission.requestId !== reference.requestId
      ) {
        this.pending.delete(taskKey(reference))
        continue
      }
      const pendingAdmission = task.admission
      // A recovery starts its attempt only once the previous one is verified
      // gone; until then the request stays pending, and is looked at again on
      // the next periodic pass.
      if (
        pendingAdmission.executionKind === 'recovery' &&
        !(await this.previousAttemptVerifiedGone(task))
      ) {
        this.waitingForPeriodicPass.add(taskKey(reference))
        continue
      }
      const executionAttemptNumber = (task.executionAttemptNumber ?? 0) + 1
      let attemptScope: Awaited<ReturnType<typeof prepareAttemptOwnedProcessScope>>
      try {
        attemptScope = await prepareAttemptOwnedProcessScope({
          workspacePath: this.options.workspacePath,
          sessionId: task.sessionId,
          taskId: task.id,
          executionAttemptNumber,
        })
      } catch (error) {
        // Not granted: the request stays pending and is tried again on the
        // next periodic pass. The failure is reported once for each reason.
        const reason = error instanceof Error ? error.message : String(error)
        this.waitingForPeriodicPass.add(taskKey(reference))
        if (this.scopePreparationFailures.get(pendingAdmission.requestId) !== reason) {
          this.scopePreparationFailures.set(pendingAdmission.requestId, reason)
          this.emit('task_queue.dispatch_failed', {
            ...this.taskEventFields(task),
            reason,
          })
        }
        continue
      }
      this.scopePreparationFailures.delete(pendingAdmission.requestId)
      const executionAttemptId = randomUUID()
      const grantedAt = this.now().toISOString()
      const granted: TaskAdmission = {
        ...pendingAdmission,
        phase: 'granted',
        grantId: randomUUID(),
        ownerEpoch: this.options.owner.epoch,
        grantedAt,
        executionAttemptId,
      }
      await this.options.owner.assertCurrent()
      const updated = await this.options.sessionStore.compareAndSetTaskRecord(
        task.sessionId,
        task.id,
        pendingAdmission.executionKind === 'initial'
          ? ['queued']
          : pendingAdmission.executionKind === 'recovery'
            ? ['interrupted']
            : [
                pendingAdmission.source === 'model_choice'
                  ? 'awaiting_model_choice'
                  : 'awaiting_input',
              ],
        {
          status: 'queued',
          admission: granted,
          ownerInstanceId: this.options.sessionStore.getInstanceId(),
          processIdentity: executionAttemptId,
          executionAttemptId,
          executionAttemptNumber,
          executionKind: pendingAdmission.executionKind,
          ownedProcessScope: attemptScope.ownedProcessScope,
          attemptStartedAt: grantedAt,
          workerStartedAt: undefined,
          pid: undefined,
          processGroupId: undefined,
          completedAt: undefined,
          interruptedAt: undefined,
          error: undefined,
          ...(pendingAdmission.executionKind === 'recovery'
            ? {
                recoveryCount: (task.recoveryCount ?? 0) + 1,
                lastRecoveryAt: grantedAt,
              }
            : { recoveryCount: task.recoveryCount ?? 0 }),
        },
        {
          expectedExecutionAttemptId: pendingAdmission.expectedExecutionAttemptId,
          expectedAdmissionRequestId: pendingAdmission.requestId,
          expectedAdmissionPhase: 'pending',
        },
      )
      this.pending.delete(taskKey(reference))
      if (!updated?.updated || updated.task.admission?.phase !== 'granted') {
        continue
      }
      this.granted.set(updated.task.admission.grantId, {
        sessionId: updated.task.sessionId,
        taskId: updated.task.id,
      })
      this.rememberTask(updated.task)
      reservations.push(updated.task)
      usage += 1
      this.emit('task_queue.granted', this.taskEventFields(updated.task))
    }
    return reservations
  }

  private startLaunch(task: SessionTask): void {
    const attemptKey = taskAttemptKey(task)
    if (this.inFlightTaskAttempts.has(attemptKey)) return
    this.inFlightTaskAttempts.add(attemptKey)
    this.emit('task_queue.launch_handoff', this.taskEventFields(task))
    const launch = (async () => {
      const result = await launchReservedTaskExecutionAttempt({
        sessionId: task.sessionId,
        sessionStore: this.options.sessionStore,
        ...whenDefined(this.options.taskLauncher, (definedValue) => ({ taskLauncher: definedValue })),
        repoRootPath: this.options.repoRootPath,
        workspacePath: this.options.workspacePath,
        ...whenDefined(this.options.workflowsRegistryPath, (definedValue) => ({ workflowsRegistryPath: definedValue })),
        ...whenDefined(this.options.resourceLibraryService, (resourceLibraryService) => ({ resourceLibraryService })),
        task,
        warnings: task.mcpWarnings ?? [],
        ...whenDefined(this.options.textStream, (textStream) => ({ textStream })),
      })
      if (!result.ok) {
        this.emit('task_queue.dispatch_failed', {
          ...('task' in result
            ? this.taskEventFields(result.task)
            : this.taskEventFields(task)),
          reason: 'detail' in result ? result.detail : result.error,
        })
      }
    })()
      .catch((error) => {
        this.emit('task_queue.dispatch_failed', {
          ...this.taskEventFields(task),
          reason: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        this.inFlightTaskAttempts.delete(attemptKey)
        this.inFlightLaunches.delete(launch)
        this.wake()
      })
    this.inFlightLaunches.add(launch)
  }

  private async refreshKnownTasksLocked(
    knownTasks?: ReadonlyMap<string, SessionTask>,
  ): Promise<PostMutationActions> {
    const actions: PostMutationActions = {
      launch: [],
      openGate: [],
      reconcileAdmitted: new Map(),
      reconcileLaunching: new Set(),
      reconcileSessions: new Set(),
      reconcileHeld: new Map(),
    }
    this.dispatchBlockedByAmbiguity = false
    this.holds = new Map()
    for (const [grantId, reference] of [...this.granted]) {
      let task = knownTasks?.get(taskKey(reference)) ??
        await this.options.sessionStore.getTaskRecord(
          reference.sessionId,
          reference.taskId,
        )
      if (!task || task.admission?.phase !== 'granted' || task.admission.grantId !== grantId) {
        if (task?.status === 'awaiting_input') this.rememberAgentQuestionWait(task)
        this.granted.delete(grantId)
        this.emit('task_queue.released', {
          session_id: reference.sessionId,
          task_id: reference.taskId,
          grant_id: grantId,
          reason: 'grant_no_longer_authoritative',
        })
        // A wait whose admission recovery released (after its hold cleared,
        // for one) is continued now if its answer or consent is already
        // recorded, exactly once, as startup would continue it.
        if (
          task &&
          task.admission === undefined &&
          (task.status === 'awaiting_input' || task.status === 'awaiting_model_choice')
        ) {
          await this.adoptStartupTask(task)
        }
        continue
      }
      if (task.processCleanupHold !== undefined) {
        // Held until its attempt's descendants are verified gone, whatever
        // its status: the slot stays, and a wait stages no continuation. Its
        // recorded root is still probed, so a live, unverified one blocks
        // dispatch as it would without the hold (ADR section 7).
        await this.terminalRootCapacityHoldLocked(task)
        this.requestHeldReconciliation(task, actions)
        continue
      }
      if (isTerminalTaskStatus(task.status)) {
        const hold = await this.terminalTaskCapacityHoldLocked(task)
        if (hold === 'owned_processes_held') {
          this.requestHeldReconciliation(task, actions)
          continue
        }
        if (hold !== 'free') {
          // The store signals only a process it can verify, so a cleanup
          // request for an unverified live process, or for a marker several
          // live processes carry, would change nothing and wake the queue
          // again at once. The exception is a unique process carrying the
          // task's identity marker elsewhere (a reused recorded pid): the
          // store records and stops that one. Each later pass probes again,
          // and the slot is freed once the processes exit.
          if (
            task.status === 'cancelled' &&
            hold !== 'ambiguous_marker' &&
            (
              hold !== 'unverified_live_process' ||
              // An empty identity classifies as absent.
              classifyTaskProcessesByIdentity(task.processIdentity ?? '').kind === 'unique'
            )
          ) {
            const reference = taskReference(task)
            actions.reconcileAdmitted.set(taskKey(reference), reference)
            this.emit('task_queue.reconciled', {
              ...this.taskEventFields(task),
              reason: 'cancelled_process_cleanup',
            })
          }
          continue
        }
        await this.clearAdmission(task)
        this.granted.delete(grantId)
        this.emit('task_queue.released', {
          ...this.taskEventFields(task),
          reason: task.status,
        })
        continue
      }
      if (
        task.status === 'awaiting_input' ||
        task.status === 'awaiting_model_choice'
      ) {
        if (task.status === 'awaiting_input') this.rememberAgentQuestionWait(task)
        // Both wait for a person. Holding the worker slot while nobody is
        // there to answer starves the queue for as long as the wait lasts,
        // which for a model choice can be indefinitely.
        await this.clearAdmission(task)
        this.granted.delete(grantId)
        this.emit('task_queue.released', {
          ...this.taskEventFields(task),
          reason: task.status,
        })
        // An answer or consent recorded while the wait still held its slot
        // (while it was held for its descendants, for one) is continued now,
        // exactly once, as startup would continue it.
        const released = await this.options.sessionStore.getTaskRecord(task.sessionId, task.id)
        if (released && released.admission === undefined) await this.adoptStartupTask(released)
        continue
      }

      const target = taskProcessTarget(task)
      const targetAlive = target != null &&
        (this.options.sessionStore.isTaskProcessAlive?.(task) ??
          defaultIsProcessAlive(target))
      const identityValid =
        this.options.sessionStore.hasValidTaskProcessIdentity?.(task) ??
        isTaskProcessIdentityValid(task)
      if (targetAlive && !identityValid) {
        this.blockOnUnverifiedWorker(task)
        continue
      }
      // A broker mismatch only makes a worker obsolete after a restart. The
      // owner's broker URL does not change while it runs, and the store checks
      // broker identity only for a task it did not launch
      // (TaskRecoveryManager.reconcileTaskRecord). Sending the owner's own
      // worker there would change nothing and wake the queue again at once.
      if (
        targetAlive &&
        identityValid &&
        (
          this.options.sessionStore.ownsTaskProcess(task) ||
          this.options.sessionStore.isTaskProviderBrokerCompatible?.(task) !== false
        )
      ) {
        if (task.status === 'queued' && !this.hasInFlightLaunch(task)) {
          actions.openGate.push(task)
        }
        continue
      }
      if (
        targetAlive &&
        this.options.sessionStore.isTaskProviderBrokerCompatible?.(task) === false
      ) {
        const reference = taskReference(task)
        actions.reconcileAdmitted.set(taskKey(reference), reference)
        // One record per request, so a task the store keeps sending back
        // unchanged shows up in the event log instead of only as CPU.
        this.emit('task_queue.reconciled', {
          ...this.taskEventFields(task),
          reason: 'provider_broker_incompatible',
        })
        continue
      }
      if (!targetAlive && task.processIdentity) {
        const classified = classifyTaskProcessesByIdentity(task.processIdentity)
        if (classified.kind === 'ambiguous') {
          this.blockOnAmbiguousMarker(task, classified.matches.length)
          continue
        }
        if (classified.kind === 'unique') {
          await this.options.owner.assertCurrent()
          const attached = await this.options.sessionStore.compareAndSetTaskRecord(
            task.sessionId,
            task.id,
            ['queued', 'running'],
            {
              pid: classified.process.pid,
              ...whenDefined(classified.process.processGroupId, (processGroupId) => ({ processGroupId })),
            },
            admissionFence(task),
          )
          task = attached?.task ?? task
          if (
            attached?.updated &&
            task.status === 'queued' &&
            !this.hasInFlightLaunch(task)
          ) {
            actions.openGate.push(task)
          }
          continue
        }
      }

      if (
        task.status === 'queued' &&
        !task.pid &&
        !task.processGroupId &&
        !this.hasInFlightLaunch(task)
      ) {
        const admission = task.admission
        if (
          admission?.phase === 'granted' &&
          admission.ownerEpoch !== this.options.owner.epoch
        ) {
          if (await this.launchGateExists(task)) {
            const reference = taskReference(task)
            actions.reconcileAdmitted.set(taskKey(reference), reference)
            continue
          } else {
            const reboundAdmission: TaskAdmission = {
              ...admission,
              ownerEpoch: this.options.owner.epoch,
            }
            // No gate: no root of this attempt ever did work, so nothing
            // descends from it yet. An earlier version's grant is launched
            // here under a scope of its own, like any attempt this version
            // starts.
            let attemptScope: 1 | undefined = task.ownedProcessScope
            if (attemptScope !== 1 && task.executionAttemptNumber !== undefined) {
              try {
                attemptScope = (await prepareAttemptOwnedProcessScope({
                  workspacePath: this.options.workspacePath,
                  sessionId: task.sessionId,
                  taskId: task.id,
                  executionAttemptNumber: task.executionAttemptNumber,
                })).ownedProcessScope
              } catch (error) {
                // The grant is kept and tried again on later passes; its
                // failure is reported once for each reason.
                const reason = error instanceof Error ? error.message : String(error)
                if (this.scopePreparationFailures.get(admission.requestId) !== reason) {
                  this.scopePreparationFailures.set(admission.requestId, reason)
                  this.emit('task_queue.dispatch_failed', {
                    ...this.taskEventFields(task),
                    reason,
                  })
                }
                continue
              }
              this.scopePreparationFailures.delete(admission.requestId)
            }
            await this.options.owner.assertCurrent()
            const rebound = await this.options.sessionStore.compareAndSetTaskRecord(
              task.sessionId,
              task.id,
              ['queued'],
              {
                admission: reboundAdmission,
                ...(attemptScope === 1 ? { ownedProcessScope: attemptScope } : {}),
              },
              admissionFence(task),
            )
            if (!rebound?.updated) continue
            task = rebound.task
          }
        }
        actions.launch.push(task)
        continue
      }

      if (task.status === 'interrupted') {
        // An attempt that ended interrupted with its grant kept (a launch
        // failure written while its scope was held, for one) gives the slot
        // back once its root and descendants are verified gone. Reconciling
        // it again would change nothing, and waking on that would spin.
        const hold = await this.terminalTaskCapacityHoldLocked(task)
        if (hold === 'owned_processes_held') this.requestHeldReconciliation(task, actions)
        if (hold !== 'free') continue
        await this.clearAdmission(task)
        this.granted.delete(grantId)
        this.emit('task_queue.released', {
          ...this.taskEventFields(task),
          reason: task.status,
        })
        // As startup would: an automatic recovery is staged again, and a
        // manual one waits for Resume.
        const released = await this.options.sessionStore.getTaskRecord(task.sessionId, task.id)
        if (released && released.admission === undefined) await this.adoptStartupTask(released)
        continue
      }
      if (this.options.sessionStore.reconcileAdmittedTaskRecord) {
        const reference = taskReference(task)
        actions.reconcileAdmitted.set(taskKey(reference), reference)
        if (this.hasInFlightLaunch(task)) actions.reconcileLaunching.add(taskKey(reference))
        continue
      }
      if (isTerminalTaskStatus(task.status)) {
        const hold = await this.terminalTaskCapacityHoldLocked(task)
        if (hold === 'owned_processes_held') this.requestHeldReconciliation(task, actions)
        if (hold !== 'free') continue
        await this.clearAdmission(task)
        this.granted.delete(grantId)
        this.emit('task_queue.released', {
          ...this.taskEventFields(task),
          reason: task.status,
        })
      }
    }

    for (const [key, reference] of [...this.legacyActive]) {
      const task = knownTasks?.get(taskKey(reference)) ??
        await this.options.sessionStore.getTaskRecord(
          reference.sessionId,
          reference.taskId,
        )
      if (!task) {
        this.legacyActive.delete(key)
        this.legacyReleasedAtStartup.delete(key)
        this.emit('task_queue.released', {
          session_id: reference.sessionId,
          task_id: reference.taskId,
          reason: 'legacy_task_missing',
        })
        continue
      }
      if (task.processCleanupHold !== undefined) {
        // An earlier version's attempt, or one whose descendants cannot be
        // verified: it keeps its legacy-active slot. Its recorded root is
        // still probed, so a live, unverified one blocks dispatch.
        await this.terminalRootCapacityHoldLocked(task)
        this.requestHeldReconciliation(task, actions)
        continue
      }
      if (isTerminalTaskStatus(task.status) || task.status === 'interrupted') {
        const hold = this.legacyReleasedAtStartup.has(key)
          ? await this.terminalRootCapacityHoldLocked(task)
          : await this.terminalTaskCapacityHoldLocked(task)
        if (hold === 'owned_processes_held') {
          // Recorded on the task, so the slot and the reason survive a
          // restart (ADR section 7).
          await this.recordLegacyHold(task)
          this.requestHeldReconciliation(task, actions)
          continue
        }
        if (hold !== 'free') {
          actions.reconcileSessions.add(reference.sessionId)
          continue
        }
        this.legacyActive.delete(key)
        this.legacyReleasedAtStartup.delete(key)
        this.emit('task_queue.released', {
          session_id: reference.sessionId,
          task_id: reference.taskId,
          reason: task.status,
        })
        continue
      }
      const target = taskProcessTarget(task)
      if (
        target != null &&
        (this.options.sessionStore.isTaskProcessAlive?.(task) ??
          defaultIsProcessAlive(target))
      ) {
        const identityValid =
          this.options.sessionStore.hasValidTaskProcessIdentity?.(task) ??
          isTaskProcessIdentityValid(task)
        if (!identityValid) this.blockOnUnverifiedWorker(task)
        continue
      }
      if (task.processIdentity) {
        const classified = classifyTaskProcessesByIdentity(task.processIdentity)
        if (classified.kind === 'ambiguous') {
          this.blockOnAmbiguousMarker(task, classified.matches.length)
          continue
        }
      }
      actions.reconcileSessions.add(reference.sessionId)
    }
    this.reportBlockingSetChange()
    return actions
  }

  /**
   * The task's recorded worker is alive but does not carry its identity:
   * nothing new is dispatched in the workspace, and the task says why.
   */
  private blockOnUnverifiedWorker(task: SessionTask): void {
    this.dispatchBlockedByAmbiguity = true
    this.holds.set(taskKey(taskReference(task)), {
      reference: taskReference(task),
      hold: {
        reason: 'unverified_live_process',
        blocksDispatch: true,
        ...whenDefined(task.pid ?? task.processGroupId, (processId) => ({ processId })),
      },
    })
  }

  /**
   * More than one process group carries the task's identity, so none can be
   * verified as its own: nothing new is dispatched, and the task says why. The
   * classifier collapses its matches by process group, so this counts groups.
   */
  private blockOnAmbiguousMarker(task: SessionTask, processGroupCount: number): void {
    this.dispatchBlockedByAmbiguity = true
    this.holds.set(taskKey(taskReference(task)), {
      reference: taskReference(task),
      hold: { reason: 'ambiguous_marker', blocksDispatch: true, processGroupCount },
    })
  }

  /**
   * Writes the tasks that block dispatch to the event log whenever that set
   * changes, and that dispatch is unblocked once it empties. Keeps the old
   * `reason` for readers that know only it.
   */
  private reportBlockingSetChange(): void {
    const blocking = [...this.holds.values()]
      .filter((entry) => entry.hold.blocksDispatch)
      .sort((left, right) => taskKey(left.reference).localeCompare(taskKey(right.reference)))
    const signature = blocking
      .map((entry) => `${taskKey(entry.reference)}\0${entry.hold.reason}`)
      .join('\n')
    if (signature === this.reportedBlockingSet) return
    this.reportedBlockingSet = signature
    if (blocking.length === 0) {
      this.emit('task_queue.dispatch_unblocked')
      return
    }
    this.emit('task_queue.dispatch_blocked', {
      reason: 'ambiguous_process_identity',
      blocked_by: blocking.map((entry) => ({
        session_id: entry.reference.sessionId,
        task_id: entry.reference.taskId,
        hold_reason: entry.hold.reason,
      })),
    })
  }

  private async adoptStartupTask(task: SessionTask): Promise<boolean> {
    if (task.status === 'awaiting_input') this.rememberAgentQuestionWait(task)
    if (
      task.admission === undefined &&
      task.processCleanupHold !== undefined &&
      isTerminalTaskStatus(task.status)
    ) {
      // A legacy-active task that ended while its descendants could not be
      // verified gone keeps the slot it held before the restart.
      this.legacyActive.set(taskKey(taskReference(task)), taskReference(task))
      this.rememberTask(task)
      return false
    }
    if (task.admission) {
      if (isTerminalTaskStatus(task.status)) {
        if (task.admission.phase === 'granted') {
          if (task.admission.executionAttemptId !== task.executionAttemptId) {
            throw new TaskQueueError(
              'task_admission_conflict',
              `Granted admission conflicts with task attempt: ${task.sessionId}/${task.id}`,
            )
          }
          this.granted.set(task.admission.grantId, taskReference(task))
          this.rememberTask(task)
          return false
        }
        await this.clearAdmission(task)
        return true
      }
      if (task.admission.phase === 'pending') {
        this.addPending(task)
        return false
      }
      if (task.admission.phase === 'staged') {
        if (!this.options.sessionStore.repairStagedTaskAdmission) {
          throw new TaskQueueError(
            'task_store_unsupported',
            'Session store does not support staged admission repair',
          )
        }
        await this.options.owner.assertCurrent()
        const repaired = await this.options.sessionStore.repairStagedTaskAdmission(
          task.sessionId,
          task.id,
        )
        if (repaired?.admission?.phase !== 'pending') {
          throw new TaskQueueError(
            'task_admission_conflict',
            `Staged admission could not be repaired: ${task.sessionId}/${task.id}`,
          )
        }
        this.addPending(repaired)
        return true
      }
      if (task.admission.executionAttemptId !== task.executionAttemptId) {
        throw new TaskQueueError(
          'task_admission_conflict',
          `Granted admission conflicts with task attempt: ${task.sessionId}/${task.id}`,
        )
      }
      this.granted.set(task.admission.grantId, {
        sessionId: task.sessionId,
        taskId: task.id,
      })
      this.rememberTask(task)
      return false
    }

    if (
      task.status === 'queued' &&
      !task.executionAttemptId &&
      task.pid === undefined &&
      task.processGroupId === undefined
    ) {
      const admission = this.createPendingAdmission({
        order: this.allocateOrder(),
        executionKind: 'initial',
        source: 'startup_repair',
        expectedExecutionAttemptId: null,
        ...whenDefined(task.runPlanId, (definedValue) => ({ runPlanId: definedValue })),
        phase: 'pending',
      })
      await this.options.owner.assertCurrent()
      const updated = await this.options.sessionStore.compareAndSetTaskRecord(
        task.sessionId,
        task.id,
        ['queued'],
        { admission },
        {
          expectedExecutionAttemptId: null,
          expectedAdmissionRequestId: null,
        },
      )
      if (updated?.updated) this.addPending(updated.task)
      return updated?.updated === true
    }

    if (
      task.status === 'awaiting_input' &&
      task.executionAttemptId &&
      await this.hasSubmittedHumanInput(task)
    ) {
      const admission = this.createPendingAdmission({
        order: this.allocateOrder(),
        executionKind: 'continuation',
        source: 'human_input',
        expectedExecutionAttemptId: task.executionAttemptId,
        ...whenDefined(task.runPlanId, (definedValue) => ({ runPlanId: definedValue })),
        phase: 'pending',
      })
      await this.options.owner.assertCurrent()
      const updated = await this.options.sessionStore.compareAndSetTaskRecord(
        task.sessionId,
        task.id,
        ['awaiting_input'],
        { admission },
        {
          expectedExecutionAttemptId: task.executionAttemptId,
          expectedAdmissionRequestId: null,
        },
      )
      if (updated?.updated) this.addPending(updated.task)
      return updated?.updated === true
    }

    // Approval and admission are two writes, and a crash between them leaves an
    // approval nobody acted on: the workflow holds the permission the user
    // gave, and the queue has nothing to run. Staged as a continuation, not a
    // recovery, because the user decided this — it must not spend the run's
    // recovery budget.
    if (task.status === 'awaiting_model_choice' && task.executionAttemptId) {
      const admitted = await this.admitApprovedModelChoiceLocked(task)
      if (admitted !== 'not-eligible') return admitted === 'admitted'
    }

    if (
      task.status === 'interrupted' &&
      this.options.durableRecoveryEnabled !== false &&
      task.recoveryDisposition === 'automatic' &&
      (task.recoveryCount ?? 0) < (this.options.maxAutomaticRecoveries ?? 3) &&
      task.executionAttemptId
    ) {
      if (!(await this.previousAttemptVerifiedGone(task))) return false
      const admission = this.createPendingAdmission({
        order: this.allocateOrder(),
        executionKind: 'recovery',
        source: 'automatic_recovery',
        expectedExecutionAttemptId: task.executionAttemptId,
        ...whenDefined(task.runPlanId, (definedValue) => ({ runPlanId: definedValue })),
        phase: 'pending',
      })
      await this.options.owner.assertCurrent()
      const updated = await this.options.sessionStore.compareAndSetTaskRecord(
        task.sessionId,
        task.id,
        ['interrupted'],
        { admission },
        {
          expectedExecutionAttemptId: task.executionAttemptId,
          expectedAdmissionRequestId: null,
        },
      )
      if (updated?.updated) this.addPending(updated.task)
      return updated?.updated === true
    }

    if (
      (task.status === 'queued' || task.status === 'running') &&
      task.executionAttemptId
    ) {
      this.legacyActive.set(taskKey({ sessionId: task.sessionId, taskId: task.id }), {
        sessionId: task.sessionId,
        taskId: task.id,
      })
      this.rememberTask(task)
      return false
    }

    if (
      task.status === 'cancelled' &&
      Boolean(taskProcessTarget(task) ?? task.processIdentity)
    ) {
      // Cancelled with its slot already released: counted only while its
      // root may live.
      this.legacyActive.set(taskKey(taskReference(task)), taskReference(task))
      this.legacyReleasedAtStartup.add(taskKey(taskReference(task)))
      this.rememberTask(task)
    }
    return false
  }

  /**
   * Admits one approved continuation, or says why it did not.
   *
   * Repairs the narrow crash window between an approval being persisted and the
   * request handler durably enqueueing its admission. A step that already
   * carries its continuation receipt has been admitted, and a step that has
   * ended is not waiting for anything, so neither is staged again.
   *
   * `deferred` is the honest answer when the canonical authority is enrolled
   * but unreachable: nothing is admitted, and the task is remembered so a later
   * dispatch can ask again. That re-examination is detached rather than a retry
   * loop, and it happens only for tasks an outage actually blocked.
   */
  private async admitApprovedModelChoiceLocked(
    task: SessionTask,
  ): Promise<'admitted' | 'deferred' | 'not-eligible'> {
    const key = taskKey(taskReference(task))
    // A rescan inside the same initialize must not pay the authority's budget
    // twice for a task already known to be waiting on it. The first dispatch
    // after readiness probes it instead.
    const alreadyDeferred = this.deferredModelChoiceAdoptions.get(key)
    if (
      alreadyDeferred &&
      alreadyDeferred.executionAttemptId === task.executionAttemptId
    ) {
      return 'deferred'
    }
    const classification = await this.classifyUnadmittedModelChoice(task)
    if (classification === 'unavailable') {
      if (task.executionAttemptId) {
        this.deferredModelChoiceAdoptions.set(key, {
          reference: taskReference(task),
          executionAttemptId: task.executionAttemptId,
          // The authority is keyed by the assignment, and the projection is
          // chosen by its path, so both are part of what was deferred. A task
          // repointed at another assignment keeps its attempt but is a
          // different run to the journal.
          ...whenDefined(task.assignmentId, (assignmentId) => ({ assignmentId })),
          ...whenDefined(task.assignmentPath, (assignmentPath) => ({
            assignmentPath,
          })),
        })
      }
      return 'deferred'
    }
    this.deferredModelChoiceAdoptions.delete(key)
    if (classification === 'ineligible') return 'not-eligible'
    return (await this.commitApprovedModelChoiceLocked(task))
      ? 'admitted'
      : 'not-eligible'
  }

  /**
   * Writes the one continuation admission, and nothing else.
   *
   * Split out because the probe has already read the authority: calling
   * anything that classifies again would open a journal while the queue's lock
   * is held, which is the whole thing the probe exists to avoid.
   */
  private async commitApprovedModelChoiceLocked(
    task: SessionTask,
  ): Promise<boolean> {
    if (!task.executionAttemptId) return false
    const admission = this.createPendingAdmission({
      order: this.allocateOrder(),
      executionKind: 'continuation',
      source: 'model_choice',
      expectedExecutionAttemptId: task.executionAttemptId,
      ...whenDefined(task.runPlanId, (definedValue) => ({ runPlanId: definedValue })),
      phase: 'pending',
    })
    await this.options.owner.assertCurrent()
    const updated = await this.options.sessionStore.compareAndSetTaskRecord(
      task.sessionId,
      task.id,
      ['awaiting_model_choice'],
      { admission },
      {
        expectedExecutionAttemptId: task.executionAttemptId,
        expectedAdmissionRequestId: null,
      },
    )
    if (updated?.updated) this.addPending(updated.task)
    return updated?.updated === true
  }

  /**
   * Starts at most one detached re-examination of a deferred approval.
   *
   * A task stops being tracked the moment it is no longer the one that was
   * deferred — gone, admitted, moved on, or a different execution — and the
   * moment a successful canonical read says there is nothing to adopt.
   */
  private startDeferredModelChoiceProbe(): void {
    if (this.deferredModelChoiceProbe) return
    if (this.deferredModelChoiceAdoptions.size === 0) return
    if (!this.isReady()) return
    // Held as a promise rather than a flag, so shutdown can wait for it.
    const probe = this.probeOneDeferredModelChoice()
      .catch((error: unknown) => {
        this.emit('task_queue.dispatch_failed', {
          reason: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        this.deferredModelChoiceProbe = undefined
      })
    this.deferredModelChoiceProbe = probe
  }

  /**
   * Asks one deferred task's authority, outside every lock.
   *
   * One per pass, not the whole map: each probe costs however long an
   * unreachable authority takes to answer, and walking a dynamic set of them in
   * a single pass turns one outage into many waits. The next dispatch picks up
   * the next one.
   *
   * The canonical read happens here, unlocked. Only the admission that follows
   * takes the queue's lock, and it re-reads the task and re-checks its identity
   * first: the record can have moved while the authority was being read, and
   * the classification is carried in rather than recomputed, so nothing opens a
   * journal under the lock.
   */
  private async probeOneDeferredModelChoice(): Promise<void> {
    const next = [...this.deferredModelChoiceAdoptions][0]
    if (!next) return
    const [key, entry] = next
    const observed = await this.options.sessionStore.getTaskRecord(
      entry.reference.sessionId,
      entry.reference.taskId,
    )
    // Dropped before the journal is opened, not after: a task that changed
    // identity is not the task that was deferred, and asking its authority
    // about it would keep an outage alive against work that has moved on.
    if (!this.stillDeferred(observed, entry)) {
      this.deferredModelChoiceAdoptions.delete(key)
      return
    }
    let classification: 'eligible' | 'ineligible' | 'unavailable'
    try {
      classification = await this.classifyUnadmittedModelChoice(observed)
    } catch (error: unknown) {
      // Rotated for fairness, then re-raised: an authority that opened and
      // then failed while being read is a defect rather than an outage, and
      // the queue's own failure boundary is where that belongs. Swallowing it
      // here would leave nobody any evidence it happened.
      this.rotateDeferredModelChoice(key, entry)
      throw error
    }
    if (classification === 'unavailable') {
      // Moved to the back rather than left at the front. One assignment that
      // never answers would otherwise be examined again on every pass, and
      // every task behind it would wait on an outage that is not its own.
      this.rotateDeferredModelChoice(key, entry)
      return
    }
    if (classification === 'ineligible') {
      this.deferredModelChoiceAdoptions.delete(key)
      return
    }
    const admitted = await this.withMutation(async () => {
      if (!this.isReady()) return false
      await this.options.owner.assertCurrent()
      // Re-read under the lock: the authority answered a while ago, and the
      // task may have moved since.
      const current = await this.options.sessionStore.getTaskRecord(
        entry.reference.sessionId,
        entry.reference.taskId,
      )
      if (!this.stillDeferred(current, entry)) {
        this.deferredModelChoiceAdoptions.delete(key)
        return false
      }
      // Kept until the write lands. Forgetting an approval because a commit
      // failed transiently would strand a decision the user already made.
      const committed = await this.commitApprovedModelChoiceLocked(current)
      if (committed) this.deferredModelChoiceAdoptions.delete(key)
      return committed
    })
    if (admitted) this.wake()
  }

  /**
   * Sends an entry the authority could not answer for to the back of the line.
   *
   * Deliberately no wake of its own: the queue's existing tick and the wakes
   * ordinary work already produces are what bring the next pass, and a probe
   * that rescheduled itself would spin against a down authority.
   */
  private rotateDeferredModelChoice(
    key: string,
    entry: DeferredModelChoiceEntry,
  ): void {
    if (!this.deferredModelChoiceAdoptions.has(key)) return
    this.deferredModelChoiceAdoptions.delete(key)
    this.deferredModelChoiceAdoptions.set(key, entry)
  }

  /** Still the exact task, on the exact attempt, that was deferred. */
  private stillDeferred(
    task: SessionTask | null,
    entry: DeferredModelChoiceEntry,
  ): task is SessionTask {
    return (
      task !== null &&
      task.status === 'awaiting_model_choice' &&
      task.admission === undefined &&
      task.executionAttemptId === entry.executionAttemptId &&
      task.assignmentId === entry.assignmentId &&
      task.assignmentPath === entry.assignmentPath
    )
  }

  private async classifyUnadmittedModelChoice(
    task: SessionTask,
  ): Promise<'eligible' | 'ineligible' | 'unavailable'> {
    if (!task.assignmentPath) return 'ineligible'
    const canonical = await this.loadCanonicalWorkflowState(task)
    if (canonical.kind === 'unavailable') return 'unavailable'
    const snapshot = canonical.snapshot
    if (
      !snapshot ||
      snapshot.manifest.taskId !== task.id ||
      snapshot.manifest.sessionId !== task.sessionId ||
      snapshot.manifest.rootRunId !== task.runId ||
      snapshot.manifest.workflowId !== task.workflowId ||
      // The workflow's owner and the task's owner must agree. A disagreement
      // means this task is not the one that workflow is waiting on, and
      // admitting it would run somebody else's approval.
      snapshot.state.ownerExecutionAttemptId !== task.executionAttemptId
    ) {
      return 'ineligible'
    }
    return snapshot.state.steps.some(
      (step) =>
        step.approvedModelChoice !== undefined &&
        step.modelChoiceContinuationAdmissionRequestId === undefined &&
        // The store owns what terminal means. A second copy of that list here
        // once left out `blocked`, and an approval on a step that had already
        // ended would have been adopted.
        !isTerminalWorkflowStepStatus(step.status),
    )
      ? 'eligible'
      : 'ineligible'
  }

  /**
   * The workflow's canonical state, not merely its projection.
   *
   * `workflow-state.json` is a projection of the journal for an enrolled
   * assignment, so a bare store read can be missing, unreadable or behind.
   * Reading through the recorder rebuilds it. An unenrolled assignment resolves
   * no recorder and reads exactly as before; an enrolled-but-unavailable
   * authority yields nothing rather than a stale answer, because deciding a
   * task's fate from evidence this could not read is worse than deciding later.
   */
  private async loadCanonicalWorkflowState(
    task: SessionTask,
  ): Promise<CanonicalWorkflowRead> {
    if (!task.assignmentPath) return { kind: 'read', snapshot: null }
    let journalOptions: { readonly journal?: WorkflowJournalRecorder }
    try {
      journalOptions = await resolveWorkflowJournalRecorder({
        ...whenDefined(this.options.executionJournalRegistry, (registry) => ({
          registry,
        })),
        task,
        requestId: `queue-adopt-${task.id}`,
        processIdentity: task.executionAttemptId ?? task.id,
      })
    } catch {
      // Enrolled but unreachable. Told apart from a successful read that found
      // nothing, because the two mean opposite things: one is a task with no
      // approval to act on, the other a task whose approval this cannot see
      // yet. Collapsing them made an outage look like ineligibility, and the
      // run then waited forever on a decision already made.
      return { kind: 'unavailable' }
    }
    return {
      kind: 'read',
      snapshot: await new FileSystemWorkflowStateStore(
        task.assignmentPath,
        journalOptions,
      ).load(),
    }
  }

  private rememberAgentQuestionWait(task: SessionTask): void {
    const reference = taskReference(task)
    const key = taskKey(reference)
    const executionAttemptId = task.executionAttemptId ?? ''
    // Repeated sightings of the same parked attempt keep the schedule it has
    // earned. A different attempt is a different wait: it has only just parked,
    // its answer may already be sitting there, and making it serve out the
    // previous attempt's backoff would hold that answer for no reason.
    const existing = this.agentQuestionWaits.get(key)
    if (existing?.executionAttemptId === executionAttemptId) return
    this.agentQuestionWaits.set(key, { reference, executionAttemptId, dueAtMs: 0, misses: 0 })
  }

  /** Only the watch this probe actually read may be rescheduled or dropped. */
  private forgetAgentQuestionWait(key: string, watch: AgentQuestionWatch): void {
    if (this.agentQuestionWaits.get(key) === watch) this.agentQuestionWaits.delete(key)
  }

  /**
   * Nothing to report: read again later, and later still next time. The first
   * read after a task parks is immediate, because an answer may already have
   * been accepted in the window where the worker still held the task and the
   * route therefore enqueued nothing.
   */
  private deferAgentQuestionWait(key: string, watch: AgentQuestionWatch): void {
    // A watch replaced while this read was in flight belongs to a newer parked
    // attempt, and must not inherit this one's wait.
    if (this.agentQuestionWaits.get(key) !== watch) return
    const schedule = nextAgentQuestionRead({ misses: watch.misses, nowMs: this.now().getTime() })
    this.agentQuestionWaits.set(key, {
      reference: watch.reference, executionAttemptId: watch.executionAttemptId, ...schedule,
    })
  }

  /** Read one waiting run outside the dispatcher lock; a journal outage cannot
   * park unrelated tasks. Keep pending questions watched until an early answer
   * is submitted or the task stops waiting. */
  private startAgentQuestionProbe(): void {
    if (!this.isReady() || this.agentQuestionProbe || this.agentQuestionWaits.size === 0) return
    if (!this.hasDueAgentQuestionWait()) return
    this.agentQuestionProbe = this.probeAgentQuestionWait()
      .catch((error: unknown) => {
        this.emit('task_queue.dispatch_failed', { reason: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => { this.agentQuestionProbe = undefined })
  }

  private hasDueAgentQuestionWait(): boolean {
    const now = this.now().getTime()
    for (const watch of this.agentQuestionWaits.values()) {
      if (watch.dueAtMs <= now) return true
    }
    return false
  }

  private async probeAgentQuestionWait(): Promise<void> {
    const now = this.now().getTime()
    const entry = [...this.agentQuestionWaits.entries()].find(([, watch]) => watch.dueAtMs <= now)
    if (!entry) return
    const [key, watch] = entry
    const reference = watch.reference
    // Rotate before I/O so a pending person does not starve another answer.
    this.agentQuestionWaits.delete(key)
    this.agentQuestionWaits.set(key, watch)
    const task = await this.options.sessionStore.getTaskRecord(reference.sessionId, reference.taskId)
    if (!task || task.status !== 'awaiting_input' || task.admission || !task.executionAttemptId) {
      this.forgetAgentQuestionWait(key, watch)
      return
    }
    // A read that throws is still a read that admitted nothing, so it earns the
    // same wait as one that found no answer. Left to reject, it reached the
    // probe's catch with the schedule untouched and tried again every tick.
    let read: CanonicalWorkflowRead
    try {
      read = await this.loadCanonicalWorkflowState(task)
    } catch (error) {
      this.deferAgentQuestionWait(key, watch)
      this.emit('task_queue.dispatch_failed', {
        reason: error instanceof Error ? error.message : String(error),
      })
      return
    }
    if (read.kind === 'unavailable' || !this.isReady()) {
      this.deferAgentQuestionWait(key, watch)
      return
    }
    const snapshot = read.snapshot
    if (!snapshot || snapshot.manifest.taskId !== task.id || snapshot.manifest.sessionId !== task.sessionId ||
        snapshot.manifest.rootRunId !== task.runId || snapshot.manifest.workflowId !== task.workflowId ||
        snapshot.state.ownerExecutionAttemptId !== task.executionAttemptId || snapshot.state.status !== 'awaiting_input') {
      this.forgetAgentQuestionWait(key, watch)
      return
    }
    const questions = snapshot.state.agentQuestions?.interactions ?? []
    if (!questions.some((interaction) => interaction.status === 'submitted')) {
      if (questions.some((interaction) => interaction.status === 'pending')) this.deferAgentQuestionWait(key, watch)
      else this.forgetAgentQuestionWait(key, watch)
      return
    }
    // enqueueContinuation re-reads and fences admission under the dispatcher
    // lock. A competing HTTP submission can only return that same admission.
    await this.enqueueContinuation({ ...reference, source: 'agent_question' })
    this.forgetAgentQuestionWait(key, watch)
  }

  private async hasSubmittedHumanInput(task: SessionTask): Promise<boolean> {
    if (!task.assignmentPath) return false
    // Deliberately the projection, as this path has always read it. Reading
    // through the journal rebuilds the projection under a lock, and changing a
    // shipped path deserves its own evidence rather than arriving as a side
    // effect of adding a new one. The model-choice adoption below reads
    // canonically because it is new and has no behaviour to preserve.
    const snapshot = await new FileSystemWorkflowStateStore(task.assignmentPath).load()
    if (
      !snapshot ||
      snapshot.manifest.taskId !== task.id ||
      snapshot.manifest.sessionId !== task.sessionId ||
      snapshot.manifest.rootRunId !== task.runId ||
      snapshot.manifest.workflowId !== task.workflowId ||
      snapshot.state.status !== 'awaiting_input'
    ) {
      return false
    }
    return snapshot.state.steps.some(
      (step) => step.humanInput?.status === 'submitted',
    )
  }

  private async clearAdmission(task: SessionTask): Promise<void> {
    if (!task.admission) return
    await this.options.owner.assertCurrent()
    await this.options.sessionStore.compareAndSetTaskRecord(
      task.sessionId,
      task.id,
      [task.status],
      { admission: undefined },
      admissionFence(task),
    )
  }

  private async executePostMutationActions(
    actions: PostMutationActions,
  ): Promise<void> {
    let reconciled = false
    for (const [key, reference] of actions.reconcileAdmitted) {
      if (this.closed) return
      await this.options.owner.assertCurrent()
      try {
        await this.options.sessionStore.reconcileAdmittedTaskRecord?.(
          reference.sessionId,
          reference.taskId,
        )
        if (!actions.reconcileLaunching.has(key)) reconciled = true
      } catch (error) {
        this.emit('task_queue.dispatch_failed', {
          session_id: reference.sessionId,
          task_id: reference.taskId,
          reason: `reconcile_admitted: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
    for (const reference of actions.reconcileHeld.values()) {
      if (this.closed) return
      await this.options.owner.assertCurrent()
      try {
        if (this.options.sessionStore.reconcileAdmittedTaskRecord) {
          await this.options.sessionStore.reconcileAdmittedTaskRecord(reference.sessionId, reference.taskId)
        } else {
          await this.options.sessionStore.reconcileTaskRecords(reference.sessionId)
        }
        // Woken only once the hold is gone and the scope verified closed; a
        // hold that persists is checked again on a later pass, not at once.
        const current = await this.options.sessionStore.getTaskRecord(reference.sessionId, reference.taskId)
        if (
          !current ||
          (current.processCleanupHold === undefined &&
            await taskOwnedProcessesClosed(current, this.options.workspacePath))
        ) {
          this.reportedHolds.delete(taskKey(reference))
          reconciled = true
        }
      } catch (error) {
        this.emit('task_queue.dispatch_failed', {
          session_id: reference.sessionId,
          task_id: reference.taskId,
          reason: `reconcile_held: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
    for (const sessionId of actions.reconcileSessions) {
      if (this.closed) return
      await this.options.owner.assertCurrent()
      try {
        await this.options.sessionStore.reconcileTaskRecords(sessionId)
        reconciled = true
      } catch (error) {
        this.emit('task_queue.dispatch_failed', {
          session_id: sessionId,
          reason: `reconcile_session: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
    for (const task of actions.openGate) {
      if (this.closed) return
      await this.options.owner.assertCurrent()
      try {
        const current = await this.currentGrantedTask(task)
        if (current?.status !== 'queued') continue
        await this.openLaunchGate(current)
      } catch (error) {
        this.emit('task_queue.dispatch_failed', {
          ...this.taskEventFields(task),
          reason: `launch_gate: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
    for (const task of actions.launch) {
      if (this.closed) return
      await this.options.owner.assertCurrent()
      const current = await this.currentGrantedTask(task)
      if (
        current?.status !== 'queued' ||
        current.pid !== undefined ||
        current.processGroupId !== undefined ||
        this.hasInFlightLaunch(current)
      ) {
        continue
      }
      this.startLaunch(current)
    }
    if (reconciled) this.wake()
  }

  /**
   * Whether a terminal task still holds its slot: its root may still run
   * (`held`, `unverified_live_process` or `ambiguous_marker`), or its root is gone but its
   * attempt's descendants are not yet verified gone (`owned_processes_held`).
   */
  private async terminalTaskCapacityHoldLocked(
    task: SessionTask,
  ): Promise<'free' | 'held' | 'unverified_live_process' | 'ambiguous_marker' | 'owned_processes_held'> {
    if (task.processCleanupHold !== undefined) return 'owned_processes_held'
    const root = await this.terminalRootCapacityHoldLocked(task)
    if (root !== 'free') return root
    return await taskOwnedProcessesClosed(task, this.options.workspacePath)
      ? 'free'
      : 'owned_processes_held'
  }

  /**
   * Whether an interrupted task's previous attempt is verified gone, so a
   * recovery may start the next one (ADR section 7). When it is not verified
   * yet and no hold says why, the store reconciles the task once: recovery
   * closes that attempt's scope, or records the hold. A held task waits for
   * the reconciliation that clears its hold.
   */
  private async previousAttemptVerifiedGone(task: SessionTask): Promise<boolean> {
    if (process.platform === 'win32') return true
    if (task.processCleanupHold !== undefined) return false
    if (await taskOwnedProcessesClosed(task, this.options.workspacePath)) return true
    await this.options.sessionStore.reconcileAdmittedTaskRecord?.(task.sessionId, task.id)
    const current = await this.options.sessionStore.getTaskRecord(task.sessionId, task.id)
    return Boolean(
      current &&
        current.processCleanupHold === undefined &&
        await taskOwnedProcessesClosed(current, this.options.workspacePath),
    )
  }

  /**
   * Writes the hold on an ended legacy-active task whose descendants cannot
   * be verified gone, once. Fenced on its attempt and on having no
   * admission, so it never touches a task the queue has since admitted.
   */
  private async recordLegacyHold(task: SessionTask): Promise<void> {
    if (task.processCleanupHold !== undefined || !task.executionAttemptId) return
    await this.options.owner.assertCurrent()
    await this.options.sessionStore.compareAndSetTaskRecord(
      task.sessionId,
      task.id,
      [task.status],
      {
        processCleanupHold: task.ownedProcessScope === 1
          ? {
              reason: 'owned_processes_unverified',
              detail: 'The attempt ended while its scope was not verified closed.',
              since: this.now().toISOString(),
            }
          : {
              reason: 'descendants_unverified_without_scope',
              detail: 'This attempt was launched by an earlier version, which recorded no ownership scope.',
              since: this.now().toISOString(),
            },
      },
      {
        expectedExecutionAttemptId: task.executionAttemptId,
        expectedAdmissionRequestId: null,
      },
    )
  }

  /**
   * A task that holds its slot until its descendants are verified gone is
   * handed to recovery, which closes its scope again. The queue wakes only
   * when that clears the hold.
   */
  private requestHeldReconciliation(task: SessionTask, actions: PostMutationActions): void {
    const reference = taskReference(task)
    const key = taskKey(reference)
    actions.reconcileHeld.set(key, reference)
    // The reason recovery records for this state, or has recorded: the same
    // rule as recordLegacyHold. It holds this slot only, so dispatch goes on.
    // A root reason the probe recorded first for this task stands: that one
    // blocks dispatch (ADR section 7).
    if (!this.holds.has(key)) {
      this.holds.set(key, {
        reference,
        hold: {
          reason: task.processCleanupHold?.reason ??
            (task.ownedProcessScope === 1 ? 'owned_processes_unverified' : 'descendants_unverified_without_scope'),
          blocksDispatch: false,
          ...whenDefined(task.processCleanupHold?.since, (since) => ({ since })),
        },
      })
    }
    const hold = JSON.stringify([task.processCleanupHold?.reason ?? null, task.processCleanupHold?.detail ?? null])
    if (this.reportedHolds.get(key) === hold) return
    this.reportedHolds.set(key, hold)
    this.emit('task_queue.reconciled', {
      ...this.taskEventFields(task),
      reason: 'owned_process_cleanup',
    })
  }

  /**
   * Whether a terminal task's root may still run, and whether it is
   * unverified: a live recorded process without the task's identity, or a
   * marker several live processes carry.
   */
  private async terminalRootCapacityHoldLocked(
    task: SessionTask,
  ): Promise<'free' | 'held' | 'unverified_live_process' | 'ambiguous_marker'> {
    const target = taskProcessTarget(task)
    if (target != null) {
      const targetAlive = this.options.sessionStore.isTaskProcessAlive?.(task) ??
        defaultIsProcessAlive(target)
      if (targetAlive) {
        const identityValid =
          this.options.sessionStore.hasValidTaskProcessIdentity?.(task) ??
          isTaskProcessIdentityValid(task)
        if (identityValid) return 'held'
        this.blockOnUnverifiedWorker(task)
        return 'unverified_live_process'
      }
    }
    if (!task.processIdentity) return 'free'
    const classified = classifyTaskProcessesByIdentity(task.processIdentity)
    if (classified.kind === 'ambiguous') {
      this.blockOnAmbiguousMarker(task, classified.matches.length)
      return 'ambiguous_marker'
    }
    if (classified.kind !== 'unique') return 'free'
    await this.options.owner.assertCurrent()
    const attached = await this.options.sessionStore.compareAndSetTaskRecord(
      task.sessionId,
      task.id,
      [task.status],
      {
        pid: classified.process.pid,
        ...whenDefined(classified.process.processGroupId, (processGroupId) => ({ processGroupId })),
      },
      admissionFence(task),
    )
    return attached?.updated === true || Boolean(
      attached &&
        attached.task.status === task.status &&
        taskProcessTarget(attached.task) != null,
    )
      ? 'held'
      : 'free'
  }

  private taskEventFields(task: SessionTask): Record<string, unknown> {
    const admission = task.admission
    return {
      session_id: task.sessionId,
      task_id: task.id,
      task_status: task.status,
      ...(admission
        ? {
            admission_phase: admission.phase,
            request_id: admission.requestId,
            admission_order: admission.order,
            ...(admission.phase === 'granted'
              ? {
                  grant_id: admission.grantId,
                  execution_attempt_id: admission.executionAttemptId,
                }
              : {}),
          }
        : {}),
      ...(task.executionAttemptId
        ? { execution_attempt_id: task.executionAttemptId }
        : {}),
      // Why a task keeps its slot while its descendants are unverified
      // (docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md, section 7).
      ...(task.processCleanupHold
        ? { process_cleanup_hold_reason: task.processCleanupHold.reason }
        : {}),
    }
  }

  private emit(
    event: TaskQueueEventName,
    fields: Record<string, unknown> = {},
  ): void {
    const entry = {
      event,
      owner_epoch: this.options.owner.epoch,
      maximum_concurrent_tasks: this.maximumConcurrentTasksValue,
      pending_count: this.pending.size,
      granted_count: this.granted.size,
      legacy_active_count: this.legacyActive.size,
      ...fields,
    } as const
    queueMicrotask(() => {
      emitWorkspaceTaskQueueEvent(this.options.workspacePath, entry)
      const sessionId = fields.session_id
      if (typeof sessionId === 'string' && isValidSessionId(sessionId)) {
        try { this.options.onSessionChanged?.(sessionId) }
        catch {
          // View invalidation is best effort and cannot alter committed admission.
          emitWorkspaceTaskQueueEvent(this.options.workspacePath, { event: 'task_queue.reconciled', reason: 'session_refresh_failed' })
        }
      }
    })
  }

  private async openLaunchGate(task: SessionTask): Promise<void> {
    if (!task.executionAttemptId || !task.processIdentity) return
    const gatePath = path.join(
      task.cwd,
      `.worker-launch-ready.${task.executionAttemptId}`,
    )
    await openTaskLaunchGate(gatePath, task.processIdentity)
  }

  private async currentGrantedTask(
    expected: SessionTask,
  ): Promise<SessionTask | null> {
    const current = await this.options.sessionStore.getTaskRecord(
      expected.sessionId,
      expected.id,
    )
    if (!current || !sameGrantedAdmission(current, expected)) return null
    return current
  }

  private async launchGateExists(task: SessionTask): Promise<boolean> {
    if (!task.executionAttemptId) return false
    return fs.access(
      path.join(task.cwd, `.worker-launch-ready.${task.executionAttemptId}`),
    ).then(() => true, () => false)
  }

  private hasInFlightLaunch(task: SessionTask): boolean {
    return this.inFlightTaskAttempts.has(taskAttemptKey(task))
  }

  private initializeNextOrder(tasks: readonly SessionTask[]): void {
    let maximum = 0n
    for (const task of tasks) {
      if (!task.admission) continue
      const order = BigInt(task.admission.order)
      if (order > maximum) maximum = order
    }
    this.nextOrder = maximum + 1n
  }

  private allocateOrder(): bigint {
    const order = this.nextOrder
    this.nextOrder += 1n
    return order
  }

  private createPendingAdmission(params: {
    order: bigint
    executionKind: 'initial' | 'recovery' | 'continuation'
    source: TaskAdmissionSource
    expectedExecutionAttemptId: string | null
    runPlanId?: string
    applyClaimId?: string
    phase: 'staged' | 'pending'
  }): TaskAdmission {
    return {
      version: 1,
      requestId: randomUUID(),
      order: params.order.toString(),
      requestedAt: this.now().toISOString(),
      executionKind: params.executionKind,
      source: params.source,
      expectedExecutionAttemptId: params.expectedExecutionAttemptId,
      ...(params.runPlanId ? { runPlanId: params.runPlanId } : {}),
      ...(params.applyClaimId ? { applyClaimId: params.applyClaimId } : {}),
      phase: params.phase,
    }
  }

  private addPending(task: SessionTask): void {
    if (task.admission?.phase !== 'pending') return
    this.pending.set(taskKey({ sessionId: task.sessionId, taskId: task.id }), {
      sessionId: task.sessionId,
      taskId: task.id,
      requestId: task.admission.requestId,
      order: BigInt(task.admission.order),
    })
    this.rememberTask(task)
  }

  private rememberTask(task: SessionTask): void {
    this.liveTaskProjection.set(taskKey(taskReference(task)), task)
  }

  private async refreshProjectionLocked(): Promise<void> {
    const next = new Map<string, SessionTask>()

    for (const [key, reference] of [...this.pending]) {
      const task = await this.options.sessionStore.getTaskRecord(
        reference.sessionId,
        reference.taskId,
      )
      if (
        task?.admission?.phase !== 'pending' ||
        task.admission.requestId !== reference.requestId
      ) {
        this.pending.delete(key)
        continue
      }
      next.set(key, task)
    }

    for (const [grantId, reference] of this.granted) {
      const task = await this.options.sessionStore.getTaskRecord(
        reference.sessionId,
        reference.taskId,
      )
      if (
        task?.admission?.phase === 'granted' &&
        task.admission.grantId === grantId
      ) {
        next.set(taskKey(reference), task)
      }
    }

    for (const reference of this.legacyActive.values()) {
      const task = await this.options.sessionStore.getTaskRecord(
        reference.sessionId,
        reference.taskId,
      )
      if (task) next.set(taskKey(reference), task)
    }

    this.liveTaskProjection.clear()
    for (const [key, task] of next) this.liveTaskProjection.set(key, task)
  }

  private requireReady(): void {
    if (this.closed) throw new TaskQueueError('task_queue_closed', 'Task queue is closed')
    if (!this.ready) {
      throw new TaskQueueError(
        'task_admission_recovering',
        'Task admission is still recovering',
      )
    }
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let release!: () => void
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

function taskKey(reference: TaskReference): string {
  return `${reference.sessionId}\0${reference.taskId}`
}

function taskReference(task: SessionTask): TaskReference {
  return { sessionId: task.sessionId, taskId: task.id }
}

function taskAttemptKey(task: SessionTask): string {
  return `${task.sessionId}\0${task.id}\0${task.executionAttemptId ?? ''}`
}

function schedulingQueueItem(task: SessionTask, hold: SchedulingQueueHold | undefined): SchedulingQueueItem | null {
  const admission = task.admission
  const isLegacyActive = !admission && (
    task.status === 'queued' ||
    task.status === 'running' ||
    (isTerminalTaskStatus(task.status) && Boolean(
      taskProcessTarget(task) ?? task.processIdentity,
    ))
  )
  // A task the queue holds a slot for a reason is listed whatever its status:
  // an earlier version's wait or interruption can hold one, and block dispatch.
  if (!admission && !isLegacyActive && !hold) return null

  const state = admission?.phase === 'pending'
    ? 'waiting'
    : isTerminalTaskStatus(task.status)
      ? 'finishing'
      : task.status === 'running' || Boolean(task.workerStartedAt)
        ? 'running'
        : 'starting'
  const requestedAt = admission?.requestedAt ?? task.attemptStartedAt ?? task.createdAt
  const startedAt = task.workerStartedAt ?? task.startedAt

  return {
    sessionId: task.sessionId,
    taskId: task.id,
    runId: task.runId,
    workflowId: task.workflowId,
    state,
    executionKind: admission?.executionKind ?? task.executionKind ?? 'initial',
    source: admission?.source ?? 'legacy',
    requestedAt,
    ...(startedAt ? { startedAt } : {}),
    ...(hold ? { hold } : {}),
  }
}

function compareProjectedQueueTasks(
  left: SessionTask,
  right: SessionTask,
): number {
  const leftWaiting = left.admission?.phase === 'pending' ? left.admission : undefined
  const rightWaiting = right.admission?.phase === 'pending' ? right.admission : undefined
  if (leftWaiting && rightWaiting) {
    const leftOrder = BigInt(leftWaiting.order)
    const rightOrder = BigInt(rightWaiting.order)
    return leftOrder < rightOrder ? -1 : leftOrder > rightOrder ? 1 : 0
  }
  if (leftWaiting) return 1
  if (rightWaiting) return -1
  return (
    left.workerStartedAt ??
    left.startedAt ??
    left.admission?.requestedAt ??
    left.createdAt
  ).localeCompare(
    right.workerStartedAt ??
    right.startedAt ??
    right.admission?.requestedAt ??
    right.createdAt,
  )
}

function admissionFence(task: SessionTask) {
  const admission = task.admission
  return {
    ...whenDefined(task.executionAttemptId, (expectedExecutionAttemptId) => ({
      expectedExecutionAttemptId,
    })),
    ...(admission
      ? {
          expectedAdmissionRequestId: admission.requestId,
          expectedAdmissionPhase: admission.phase,
          ...(admission.phase === 'granted'
            ? {
                expectedAdmissionGrantId: admission.grantId,
                expectedAdmissionOwnerEpoch: admission.ownerEpoch,
              }
            : {}),
        }
      : {}),
  }
}

function sameGrantedAdmission(
  current: SessionTask,
  expected: SessionTask,
): boolean {
  const currentAdmission = current.admission
  const expectedAdmission = expected.admission
  return currentAdmission?.phase === 'granted' &&
    expectedAdmission?.phase === 'granted' &&
    currentAdmission.requestId === expectedAdmission.requestId &&
    currentAdmission.grantId === expectedAdmission.grantId &&
    currentAdmission.ownerEpoch === expectedAdmission.ownerEpoch &&
    currentAdmission.executionAttemptId === expectedAdmission.executionAttemptId &&
    current.executionAttemptId === expected.executionAttemptId &&
    current.processIdentity === expected.processIdentity
}

export type TaskQueueLaunchResult = SessionTaskLaunchResult
