import { whenDefined } from '../core/optional-properties.js'
import type { WorkspaceExecutionJournalRegistry } from './workspace-execution-journal-registry.js'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { Cron } from 'croner'

import { parseWorkflowRegistry, parseWorkflowTemplate } from '../workflows/loader.js'
import { workflowRequiresHumanInput } from '../workflows/validation.js'
import { writeFileAtomic } from '../core/file-mutation.js'
import { generateScheduledArtifactFilename } from '../domains/scheduling/scheduled-artifact-filename.js'
import {
  isValidTimezone,
  parseSchedulesFile,
  SCHEDULES_SCHEMA_VERSION,
  SCHEDULER_GENERATED_TAG,
  validateScheduleInput,
  validateSchedulePatch,
  type ScheduleActiveFire,
  type ScheduleInput,
  type ScheduleLastStatus,
  type ScheduleModelOverride,
  type SchedulePendingFire,
  type ScheduleProjectContextSelection,
  type SchedulePatch,
  type ScheduleRuntime,
  type ScheduleView,
  type SchedulesFile,
  type StoredSchedule,
} from '../domains/scheduling/schedule-types.js'
import type { SessionStore } from '../domains/sessions/session-store.js'
import type { WorkspaceProjectContextStore } from '../domains/projects/project-context-store.js'
import { isGeneratedTarget } from "./generated-target-registry.js";

type ScheduleRuntimePatch = {
  -readonly [Key in keyof ScheduleRuntime]?: ScheduleRuntime[Key] | undefined
}
import type { WorkspaceProjectService } from '../domains/projects/workspace-project-service.js'
import {
  isTerminalTaskStatus,
  type ScheduledSessionOrigin,
  type SessionTask,
  type TaskStatus,
} from '../contracts/sessions.js'
import { emitTaskQueueControlEvent } from '../core/task-queue-events.js'
import {
  applyRunPlanService,
  createRunPlanService,
  validateWorkflowForLaunch,
  type RunPlanTaskQueue,
} from './run-orchestrator-service.js'
import {
  renderScheduledAgentWorkflowSnapshot,
  type ScheduledAgentTargetResolver,
} from './scheduled-agent-target.js'
import { cancelSessionTask } from './task-service.js'
import type { WorkflowMcpPreflightService } from './workflow-mcp-preflight-service.js'

export type ScheduleServiceErrorCode =
  | 'configuration_invalid'
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'schedule_unavailable'
  | 'workflow_requires_input'
  | 'fire_failed'
  | 'persistence_failed'

export class ScheduleServiceError extends Error {
  constructor(
    readonly code: ScheduleServiceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ScheduleServiceError'
  }
}

export async function hasProjectScheduleReferenceInFile(
  storagePath: string,
  projectId: string,
): Promise<boolean> {
  try {
    const parsed = JSON.parse(await fs.readFile(storagePath, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return true
    const schedules = (parsed as { schedules?: unknown }).schedules
    if (!Array.isArray(schedules)) return true
    return schedules.some(
      (schedule) =>
        Boolean(schedule) &&
        typeof schedule === 'object' &&
        !Array.isArray(schedule) &&
        (schedule as { projectId?: unknown }).projectId === projectId,
    )
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

export interface ScheduleServiceOptions {
  readonly storagePath: string
  readonly sessionStore: SessionStore
  /**
   * The workspace journal registry. A scheduled cancellation is an
   * authoritative workflow transition like any other (ADR §9).
   */
  readonly executionJournalRegistry?: WorkspaceExecutionJournalRegistry
  /** May be undefined in server configurations without a task runtime. */
  readonly taskQueue?: RunPlanTaskQueue
  readonly repoRootPath: string
  readonly workspacePath: string
  readonly workflowsRegistryPath?: string
  readonly mcpWorkflowPreflightService?: Pick<
    WorkflowMcpPreflightService,
    'resolve'
  >
  readonly resolveAgentTarget?: ScheduledAgentTargetResolver
  readonly workspaceProjectService?: Pick<
    WorkspaceProjectService,
    'createSession' | 'getProjectRecord' | 'getSession' | 'withProjectReferenceMutation'
  >
  readonly workspaceProjectContextStore?: WorkspaceProjectContextStore
  readonly tickIntervalMs?: number
  readonly now?: () => Date
}

const DEFAULT_TICK_INTERVAL_MS = 15_000

/**
 * Durable, single-writer scheduler. Timer ticks and every API operation share
 * one operation chain, so in-memory state and the atomic JSON snapshot cannot
 * race each other.
 */
export class ScheduleService {
  private schedules: StoredSchedule[] | null = null
  private loadPromise: Promise<StoredSchedule[]> | null = null
  private operationTail: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly tickIntervalMs: number
  private readonly now: () => Date
  private initialized = false
  private closed = false
  private stateDirty = false

  constructor(private readonly options: ScheduleServiceOptions) {
    if (!options.storagePath.trim()) {
      throw new ScheduleServiceError(
        'configuration_invalid',
        'Schedules storage path is required.',
      )
    }
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
    if (!Number.isFinite(this.tickIntervalMs) || this.tickIntervalMs <= 0) {
      throw new ScheduleServiceError(
        'configuration_invalid',
        'Schedules tick interval must be greater than zero.',
      )
    }
    this.now = options.now ?? (() => new Date())
  }

  /** Loads state, repairs internal targets, skips missed fires, and starts ticking. */
  async initialize(): Promise<void> {
    await this.enqueueOperation(async () => {
      if (this.initialized) return
      await this.ensureLoaded()
      await this.reconcileActiveFires()
      const now = this.now()
      for (const schedule of [...(this.schedules ?? [])]) {
        try {
          const execution = await this.resolveExecutionTarget(schedule)
          this.replaceSchedule(schedule.id, (current) => ({
            ...current,
            execution,
          }))
        } catch (error) {
          this.recordFireError(schedule.id, error)
        }
        this.setNextFireFrom(schedule.id, now)
      }
      await this.persistCurrentIfNeeded()
      this.initialized = true
    })
    this.startTimer()
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.closed = true
    await this.operationTail
  }

  async list(): Promise<ScheduleView[]> {
    return this.enqueueOperation(async () => {
      await this.ensureLoaded()
      return (this.schedules ?? []).map(toScheduleView)
    })
  }

  async listByProject(projectId: string): Promise<ScheduleView[]> {
    return this.enqueueOperation(async () => {
      await this.ensureLoaded()
      return (this.schedules ?? [])
        .filter((schedule) => schedule.projectId === projectId)
        .map(toScheduleView)
    })
  }

  async create(input: ScheduleInput): Promise<ScheduleView> {
    return this.enqueueOperation(async () => {
      await this.ensureLoaded()
      const normalized = normalizeScheduleInput(input)
      assertValidCronExpression(normalized.cron, normalized.timezone)
      const execution = await this.resolveExecutionTarget(normalized)
      const now = this.now()
      const enabled = normalized.enabled ?? true
      const nextFireAt = enabled
        ? requireNextFireAt(normalized.cron, normalized.timezone, now)
        : undefined
      const schedule: StoredSchedule = {
        id: `sch_${crypto.randomUUID()}`,
        ...normalized,
        enabled,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        execution,
        ...(nextFireAt ? { runtime: { nextFireAt } } : {}),
      }
      await this.withProjectReferenceMutation(normalized.projectId, async () => {
        await this.validateProjectSelection(normalized)
        await this.commit([...(this.schedules ?? []), schedule])
      })
      return toScheduleView(schedule)
    })
  }

  async update(id: string, patch: SchedulePatch): Promise<ScheduleView> {
    return this.enqueueOperation(async () => {
      await this.ensureLoaded()
      const schedule = this.requireSchedule(id)
      const normalizedPatch = normalizeSchedulePatch(patch)
      const nextKind = normalizedPatch.kind ?? schedule.kind
      const nextModelOverride = normalizedPatch.modelOverride === null ||
        nextKind === 'workflow'
        ? undefined
        : normalizedPatch.modelOverride ?? schedule.modelOverride
      const nextProjectId = normalizedPatch.projectId === null
        ? undefined
        : normalizedPatch.projectId ?? schedule.projectId
      const nextProjectContext = normalizedPatch.projectId === null ||
        normalizedPatch.projectContext === null
        ? undefined
        : normalizedPatch.projectContext ?? schedule.projectContext
      const normalized = normalizeScheduleInput({
        name: normalizedPatch.name ?? schedule.name,
        kind: nextKind,
        target: normalizedPatch.target ?? schedule.target,
        ...(nextModelOverride ? { modelOverride: nextModelOverride } : {}),
        ...(nextProjectId ? { projectId: nextProjectId } : {}),
        ...(nextProjectContext ? { projectContext: nextProjectContext } : {}),
        prompt: normalizedPatch.prompt ?? schedule.prompt,
        cron: normalizedPatch.cron ?? schedule.cron,
        timezone: normalizedPatch.timezone ?? schedule.timezone,
        scheduleLabel: normalizedPatch.scheduleLabel ?? schedule.scheduleLabel,
        overlap: normalizedPatch.overlap ?? schedule.overlap,
        notifyOnFailure:
          normalizedPatch.notifyOnFailure ?? schedule.notifyOnFailure,
        enabled: normalizedPatch.enabled ?? schedule.enabled,
      })
      assertValidCronExpression(normalized.cron, normalized.timezone)
      const execution = await this.resolveExecutionTarget(normalized)
      const now = this.now()
      const enabled = normalized.enabled ?? schedule.enabled
      const nextFireAt = enabled
        ? requireNextFireAt(normalized.cron, normalized.timezone, now)
        : undefined
      const runtime = withRuntimePatch(schedule.runtime, {
        nextFireAt,
      })
      const {
        modelOverride: _previousModelOverride,
        projectId: _previousProjectId,
        projectContext: _previousProjectContext,
        runtime: _previousRuntime,
        ...scheduleBase
      } = schedule
      const updated: StoredSchedule = {
        ...scheduleBase,
        ...normalized,
        enabled,
        updatedAt: now.toISOString(),
        execution,
        ...(Object.keys(runtime).length > 0 ? { runtime } : {}),
      }
      const next = (this.schedules ?? []).map((entry) =>
        entry.id === id ? updated : entry,
      )
      await this.withProjectReferenceMutation(
        normalized.projectId ?? schedule.projectId,
        async () => {
          await this.validateProjectSelection(normalized)
          await this.commit(next)
        },
      )
      return toScheduleView(updated)
    })
  }

  async delete(id: string): Promise<void> {
    return this.enqueueOperation(async () => {
      await this.ensureLoaded()
      const schedule = this.requireSchedule(id)
      await this.reconcileScheduleActiveFires(id)
      const active = this.requireSchedule(id).runtime?.activeFires ?? []
      if (active.length > 0) {
        await this.cancelActiveFires(id, active)
      }
      const next = (this.schedules ?? []).filter((entry) => entry.id !== id)
      await this.withProjectReferenceMutation(schedule.projectId, () =>
        this.commit(next),
      )
    })
  }

  /** Fires immediately, regardless of enabled state or the wall clock. */
  async runNow(id: string): Promise<{ sessionId: string; taskId: string }> {
    return this.enqueueOperation(async () => {
      await this.ensureLoaded()
      const schedule = this.requireSchedule(id)
      try {
        const outcome = await this.admitFire(schedule, 'manual')
        if (outcome === 'skipped') {
          throw new ScheduleServiceError(
            'conflict',
            'Schedule already has an active run.',
          )
        }
        this.recordAdmittedFire(id, outcome)
        this.setNextFireFrom(id, this.now())
        await this.persistCurrentIfNeeded()
        return { sessionId: outcome.sessionId, taskId: outcome.taskId }
      } catch (error) {
        if (error instanceof ScheduleServiceError && error.code === 'conflict') {
          await this.persistCurrentIfNeeded()
          throw error
        }
        this.recordFireError(id, error)
        this.setNextFireFrom(id, this.now())
        await this.persistCurrentIfNeeded()
        throw error
      }
    })
  }

  private async admitFire(
    initialSchedule: StoredSchedule,
    trigger: 'clock' | 'manual',
  ): Promise<ScheduleActiveFire | 'skipped'> {
    const taskQueue = this.requireReadyTaskQueue()
    const execution = await this.resolveExecutionTarget(initialSchedule)
    this.replaceSchedule(initialSchedule.id, (schedule) => ({
      ...schedule,
      execution,
    }))

    await this.reconcileScheduleActiveFires(initialSchedule.id)
    let schedule = this.requireSchedule(initialSchedule.id)
    const active = schedule.runtime?.activeFires ?? []
    if (active.length > 0 && schedule.overlap === 'skip') {
      if (trigger === 'manual') {
        throw new ScheduleServiceError(
          'conflict',
          'Schedule already has an active run.',
        )
      }
      return 'skipped'
    }
    if (active.length > 0 && schedule.overlap === 'cancel_previous') {
      await this.cancelActiveFires(schedule.id, active)
      schedule = this.requireSchedule(schedule.id)
    }

    const firedAt = this.now()
    let pendingFire: SchedulePendingFire | undefined
    try {
      const title = `⏰ ${schedule.name} — ${formatFireTimestamp(firedAt)}`
      const origin: ScheduledSessionOrigin = { kind: 'scheduled', scheduleId: schedule.id }
      const session = schedule.projectId
        ? await this.requireWorkspaceProjectService().createSession({
            title,
            projectId: schedule.projectId,
            origin,
          })
        : await this.options.sessionStore.createSession({ title, origin })
      pendingFire = {
        sessionId: session.id,
        firedAt: firedAt.toISOString(),
      }
      this.patchRuntime(schedule.id, { pendingFire })
      // Persist the fire intent before admission. After a crash, the dedicated
      // session lets initialization recover the task or safely mark the fire
      // interrupted without admitting the same occurrence twice.
      await this.persistCurrentIfNeeded()
      const plan = await createRunPlanService({
        sessionId: session.id,
        sessionStore: this.options.sessionStore,
        repoRootPath: this.options.repoRootPath,
        ...whenDefined(this.options.workflowsRegistryPath, (definedValue) => ({ workflowsRegistryPath: definedValue })),
        goal: schedule.prompt,
        workflowId: execution.workflowId,
        includeInternalWorkflows: schedule.kind === 'agent',
      })
      if (plan.status !== 'ready') {
        throw new Error(
          plan.requiredInputs.length > 0
            ? `Scheduled run requires input: ${plan.requiredInputs.join(', ')}.`
            : 'Scheduled run plan is not ready.',
        )
      }
      const scheduledWorkflowYaml = schedule.kind === 'agent'
        ? renderScheduledAgentWorkflowSnapshot({
            agentName: schedule.target,
            workflowId: execution.workflowId,
            resultArtifact: await generateScheduledArtifactFilename({
              brief: schedule.prompt,
              firedAt,
              // Naming the artifact owns no Agent, so it runs on the one
              // application default — and now says so. Recorded before the
              // send, against the fire that caused it: there is no chat turn
              // here and no admitted task yet, and a fire's session is created
              // one per occurrence above, so it is the only identity this
              // occurrence has. A session that cannot take the record declines
              // the call rather than letting a model name the file with nothing
              // to say so.
              onSelected: (selection) =>
                this.options.sessionStore.appendSessionTitleAttempt(session.id, {
                  operation: 'scheduled-filename',
                  owner: session.id,
                  attemptId: crypto.randomUUID(),
                  selection,
                  // This service's own clock, the one every other thing it
                  // records is stamped from.
                  at: this.now().toISOString(),
                }),
            }),
          })
        : undefined
      const result = await applyRunPlanService({
        sessionId: session.id,
        sessionStore: this.options.sessionStore,
        taskQueue,
        repoRootPath: this.options.repoRootPath,
        workspacePath: this.options.workspacePath,
        ...whenDefined(this.options.workflowsRegistryPath, (definedValue) => ({ workflowsRegistryPath: definedValue })),
        plan,
        workflowId: execution.workflowId,
        brief: schedule.prompt,
        admissionSource: 'scheduled',
        ...(schedule.projectId && schedule.projectContext
          ? {
              projectContext: scheduleContextSelection(
                schedule.projectId,
                schedule.projectContext,
              ),
              workspaceProjectService:
                this.requireWorkspaceProjectService(),
              workspaceProjectContextStore:
                this.requireWorkspaceProjectContextStore(),
            }
          : {}),
        ...(scheduledWorkflowYaml ? { scheduledWorkflowYaml } : {}),
        ...whenDefined(this.options.mcpWorkflowPreflightService, (definedValue) => ({ mcpWorkflowPreflightService: definedValue })),
      })
      if (!result.ok) {
        throw new Error(runPlanApplyFailureMessage(result))
      }
      return {
        sessionId: session.id,
        taskId: result.task.id,
        firedAt: firedAt.toISOString(),
      }
    } catch (error) {
      if (pendingFire) {
        await this.reconcileScheduleActiveFires(schedule.id)
      }
      if (error instanceof ScheduleServiceError) throw error
      throw new ScheduleServiceError(
        'fire_failed',
        error instanceof Error ? error.message : 'Scheduled run could not be admitted.',
        { cause: error },
      )
    }
  }

  private async fireDue(id: string): Promise<void> {
    const schedule = this.findSchedule(id)
    if (!schedule?.enabled) return
    try {
      const outcome = await this.admitFire(schedule, 'clock')
      if (outcome === 'skipped') {
        this.patchRuntime(id, {
          lastStatus: 'skipped_overlap',
        })
      } else {
        this.recordAdmittedFire(id, outcome)
      }
    } catch (error) {
      this.recordFireError(id, error)
    }
    // Compute from completion time, so a slow admission never catches up a
    // second occurrence that elapsed while the first was being admitted.
    this.setNextFireFrom(id, this.now())
    await this.persistCurrentIfNeeded()
  }

  private recordAdmittedFire(id: string, fire: ScheduleActiveFire): void {
    const schedule = this.requireSchedule(id)
    const activeFires = [
      ...(schedule.runtime?.activeFires ?? []),
      fire,
    ]
    this.patchRuntime(id, {
      lastFireAt: fire.firedAt,
      lastSessionId: fire.sessionId,
      lastTaskId: fire.taskId,
      activeFires,
      pendingFire: undefined,
      lastError: undefined,
    })
  }

  private recordFireError(id: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.patchRuntime(id, {
      lastStatus: 'error',
      lastError: message,
    })
    emitTaskQueueControlEvent(path.dirname(this.options.storagePath), {
      event: 'schedules.fire_failed',
      schedule_id: id,
      reason: message,
    })
  }

  private async cancelActiveFires(
    scheduleId: string,
    fires: readonly ScheduleActiveFire[],
  ): Promise<void> {
    for (const fire of fires) {
      await this.cancelActiveFire(fire)
    }
    await this.reconcileScheduleActiveFires(scheduleId)
    if ((this.requireSchedule(scheduleId).runtime?.activeFires?.length ?? 0) > 0) {
      throw new ScheduleServiceError(
        'conflict',
        'One or more active scheduled runs could not be cancelled.',
      )
    }
  }

  private async cancelActiveFire(fire: ScheduleActiveFire): Promise<void> {
    const deadline = Date.now() + 2_000
    let lastError: unknown
    while (Date.now() < deadline) {
      let current: SessionTask | null
      try {
        current = await this.options.sessionStore.getTaskRecord(
          fire.sessionId,
          fire.taskId,
        )
      } catch (error) {
        lastError = error
        await new Promise<void>((resolve) => setTimeout(resolve, 20))
        continue
      }
      if (!current || isTerminalTaskStatus(current.status)) return
      try {
        const cancelled = await cancelSessionTask({
          sessionId: fire.sessionId,
          taskId: fire.taskId,
          sessionStore: this.options.sessionStore,
          ...whenDefined(this.options.executionJournalRegistry, (registry) => ({ executionJournalRegistry: registry })),
        })
        if (!cancelled || isTerminalTaskStatus(cancelled.status)) return
      } catch (error) {
        // Admission can move staged -> pending -> granted between the read and
        // its cancellation CAS. Re-read and retry against the new fence.
        lastError = error
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
    }
    throw new ScheduleServiceError(
      'conflict',
      `Active task '${fire.taskId}' could not be cancelled.`,
      { cause: lastError },
    )
  }

  private async reconcileActiveFires(): Promise<void> {
    for (const schedule of [...(this.schedules ?? [])]) {
      await this.reconcileScheduleActiveFires(schedule.id)
    }
  }

  private async reconcileScheduleActiveFires(id: string): Promise<void> {
    await this.reconcilePendingFire(id)
    const schedule = this.findSchedule(id)
    if (!schedule) return
    const active = schedule.runtime?.activeFires ?? []
    if (active.length === 0) return

    const retained: ScheduleActiveFire[] = []
    let latestResult:
      | { fire: ScheduleActiveFire; task: SessionTask | null; lookupError?: string }
      | undefined
    for (const fire of active) {
      let task: SessionTask | null
      try {
        task = await this.options.sessionStore.getTaskRecord(
          fire.sessionId,
          fire.taskId,
        )
      } catch (error) {
        retained.push(fire)
        if (fire.taskId === schedule.runtime?.lastTaskId) {
          latestResult = {
            fire,
            task: null,
            lookupError: error instanceof Error ? error.message : String(error),
          }
        }
        continue
      }
      if (task && !isTerminalTaskStatus(task.status)) {
        retained.push(fire)
        continue
      }
      if (fire.taskId === schedule.runtime?.lastTaskId) {
        latestResult = { fire, task }
      }
    }

    if (retained.length === active.length && !latestResult) return
    const patch: ScheduleRuntimePatch = { activeFires: retained }
    if (latestResult?.lookupError) {
      patch.lastError = `Fired task status could not be read: ${latestResult.lookupError}`
    } else if (latestResult && !latestResult.task) {
      patch.lastStatus = 'error'
      patch.lastError = 'Fired task record could not be found.'
    } else if (latestResult?.task) {
      patch.lastStatus = mapTerminalStatus(latestResult.task.status)
      patch.lastError = latestResult.task.status === 'done'
        ? undefined
        : latestResult.task.error ?? `Task ${latestResult.task.status}.`
    }
    this.patchRuntime(id, patch)
  }

  private async reconcilePendingFire(id: string): Promise<void> {
    const schedule = this.findSchedule(id)
    const pending = schedule?.runtime?.pendingFire
    if (!schedule || !pending) return

    let tasks: SessionTask[]
    try {
      tasks = await this.options.sessionStore.listTaskRecords(pending.sessionId)
    } catch (error) {
      this.patchRuntime(id, {
        lastError: `Pending scheduled fire could not be reconciled: ${
          error instanceof Error ? error.message : String(error)
        }`,
      })
      return
    }

    const task = tasks.find((entry) => entry.admission?.source === 'scheduled') ??
      tasks[0]
    if (!task) {
      this.patchRuntime(id, {
        pendingFire: undefined,
        lastStatus: 'error',
        lastError: 'Scheduled fire was interrupted before task admission.',
      })
      return
    }

    const recoveredFire: ScheduleActiveFire = {
      sessionId: pending.sessionId,
      taskId: task.id,
      firedAt: pending.firedAt,
    }
    const activeFires = [
      ...(schedule.runtime?.activeFires ?? []),
      recoveredFire,
    ].filter(
      (fire, index, fires) =>
        fires.findIndex(
          (candidate) =>
            candidate.sessionId === fire.sessionId &&
            candidate.taskId === fire.taskId,
        ) === index,
    )
    this.patchRuntime(id, {
      pendingFire: undefined,
      lastFireAt: pending.firedAt,
      lastSessionId: pending.sessionId,
      lastTaskId: task.id,
      activeFires,
      lastError: undefined,
    })
  }

  private async resolveExecutionTarget(
    schedule: Pick<StoredSchedule, 'kind' | 'target' | 'modelOverride'>,
  ): Promise<{ workflowId: string }> {
    if (schedule.kind === 'agent') {
      const resolver = this.options.resolveAgentTarget
      if (!resolver) {
        throw new ScheduleServiceError(
          'schedule_unavailable',
          'Agent schedules are not available in this server configuration.',
        )
      }
      return resolver({
        agentName: schedule.target,
        ...(schedule.modelOverride
          ? { modelOverride: cloneModelOverride(schedule.modelOverride) }
          : {}),
      })
    }

    const registryPath = this.options.workflowsRegistryPath?.trim()
      ? path.resolve(this.options.workflowsRegistryPath)
      : path.join(this.options.repoRootPath, 'workflows', 'registry.yaml')
    const registry = parseWorkflowRegistry(registryPath)
    if (registry.errors.length > 0) {
      throw new ScheduleServiceError(
        'invalid_request',
        `Workflow registry is invalid: ${registry.errors.join('; ')}`,
      )
    }
    const entry = registry.entries.find((candidate) => candidate.name === schedule.target)
    // Internal wrappers (scheduler- and chat-generated) are not schedulable targets.
    if (!entry || isGeneratedTarget(entry.tags)) {
      throw new ScheduleServiceError(
        'invalid_request',
        `Workflow '${schedule.target}' is not available for scheduling.`,
      )
    }
    const template = parseWorkflowTemplate(entry.template_path)
    if (!template.template) {
      throw new ScheduleServiceError(
        'invalid_request',
        `Workflow '${schedule.target}' could not be parsed: ${template.errors.join('; ')}`,
      )
    }
    if (workflowRequiresHumanInput(template.template)) {
      throw new ScheduleServiceError(
        'workflow_requires_input',
        `Workflow '${schedule.target}' contains a human-in-the-loop step and cannot be scheduled.`,
      )
    }
    const validationErrors = validateWorkflowForLaunch({
      repoRootPath: this.options.repoRootPath,
      workflowsRegistryPath: registryPath,
      workflowId: schedule.target,
    })
    if (validationErrors.length > 0) {
      throw new ScheduleServiceError(
        'invalid_request',
        `Workflow '${schedule.target}' is invalid: ${validationErrors.join('; ')}`,
      )
    }
    return { workflowId: schedule.target }
  }

  private requireReadyTaskQueue(): RunPlanTaskQueue {
    const taskQueue = this.options.taskQueue
    if (!taskQueue || !taskQueue.isReady()) {
      throw new ScheduleServiceError(
        'schedule_unavailable',
        'Task queue is not available; the fire was not admitted.',
      )
    }
    return taskQueue
  }

  private requireWorkspaceProjectService(): Pick<
    WorkspaceProjectService,
    'createSession' | 'getProjectRecord' | 'getSession' | 'withProjectReferenceMutation'
  > {
    const service = this.options.workspaceProjectService
    if (!service) {
      throw new ScheduleServiceError(
        'schedule_unavailable',
        'Workspace projects are not available for this schedule.',
      )
    }
    return service
  }

  private async withProjectReferenceMutation<T>(
    projectId: string | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!projectId) return operation()
    return this.requireWorkspaceProjectService()
      .withProjectReferenceMutation(projectId, operation)
  }

  private requireWorkspaceProjectContextStore(): WorkspaceProjectContextStore {
    const store = this.options.workspaceProjectContextStore
    if (!store) {
      throw new ScheduleServiceError(
        'schedule_unavailable',
        'Workspace project context is not available for this schedule.',
      )
    }
    return store
  }

  private async validateProjectSelection(
    schedule: Pick<ScheduleInput, 'projectId' | 'projectContext'>,
  ): Promise<void> {
    if (!schedule.projectId) return
    let project
    try {
      project = await this.requireWorkspaceProjectService().getProjectRecord(
        schedule.projectId,
      )
    } catch (error) {
      throw new ScheduleServiceError(
        'invalid_request',
        error instanceof Error ? error.message : 'Scheduled project is unavailable.',
        { cause: error },
      )
    }
    if (project.status !== 'active') {
      throw new ScheduleServiceError(
        'invalid_request',
        `Project is archived: ${schedule.projectId}`,
      )
    }
    if (schedule.projectContext) this.requireWorkspaceProjectContextStore()
  }

  private setNextFireFrom(id: string, from: Date): void {
    const schedule = this.findSchedule(id)
    if (!schedule) return
    this.patchRuntime(id, {
      nextFireAt: schedule.enabled
        ? requireNextFireAt(schedule.cron, schedule.timezone, from)
        : undefined,
    })
  }

  private startTimer(): void {
    if (this.timer || this.closed) return
    this.timer = setInterval(() => {
      void this.enqueueOperation(() => this.tickSafely()).catch(() => undefined)
    }, this.tickIntervalMs)
    this.timer.unref()
  }

  private async tickSafely(): Promise<void> {
    try {
      await this.ensureLoaded()
      // Retry a prior persistence failure before admitting more work.
      await this.persistCurrentIfNeeded()
      await this.reconcileActiveFires()
      const now = this.now()
      const dueIds = (this.schedules ?? [])
        .filter(
          (schedule) =>
            schedule.enabled &&
            schedule.runtime?.nextFireAt &&
            Date.parse(schedule.runtime.nextFireAt) <= now.getTime(),
        )
        .map((schedule) => schedule.id)
      for (const id of dueIds) await this.fireDue(id)
      await this.persistCurrentIfNeeded()
    } catch (error) {
      emitTaskQueueControlEvent(path.dirname(this.options.storagePath), {
        event: 'schedules.fire_failed',
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private findSchedule(id: string): StoredSchedule | undefined {
    return (this.schedules ?? []).find((schedule) => schedule.id === id)
  }

  private requireSchedule(id: string): StoredSchedule {
    const schedule = this.findSchedule(id)
    if (!schedule) {
      throw new ScheduleServiceError('not_found', `Schedule '${id}' was not found.`)
    }
    return schedule
  }

  private replaceSchedule(
    id: string,
    transform: (schedule: StoredSchedule) => StoredSchedule,
  ): void {
    let replaced = false
    this.schedules = (this.schedules ?? []).map((schedule) => {
      if (schedule.id !== id) return schedule
      replaced = true
      return transform(schedule)
    })
    if (replaced) this.stateDirty = true
  }

  private patchRuntime(id: string, patch: ScheduleRuntimePatch): void {
    this.replaceSchedule(id, (schedule) => {
      const runtime = withRuntimePatch(schedule.runtime, patch)
      return {
        ...schedule,
        ...(Object.keys(runtime).length > 0 ? { runtime } : {}),
      }
    })
  }

  private async ensureLoaded(): Promise<StoredSchedule[]> {
    if (this.schedules) return this.schedules
    if (!this.loadPromise) this.loadPromise = this.load()
    try {
      this.schedules = await this.loadPromise
      return this.schedules
    } finally {
      this.loadPromise = null
    }
  }

  private async load(): Promise<StoredSchedule[]> {
    let content: string
    try {
      content = await fs.readFile(this.options.storagePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new ScheduleServiceError(
        'configuration_invalid',
        'Schedules file could not be read.',
        { cause: error },
      )
    }
    try {
      return [...parseSchedulesFile(JSON.parse(content)).schedules]
    } catch (error) {
      throw new ScheduleServiceError(
        'configuration_invalid',
        'Schedules file is invalid.',
        { cause: error },
      )
    }
  }

  private async commit(next: StoredSchedule[]): Promise<void> {
    await this.persist(next)
    this.schedules = next
    this.stateDirty = false
  }

  private async persistCurrentIfNeeded(): Promise<void> {
    if (!this.stateDirty) return
    await this.persist(this.schedules ?? [])
    this.stateDirty = false
  }

  private async persist(schedules: readonly StoredSchedule[]): Promise<void> {
    const file: SchedulesFile = {
      version: SCHEDULES_SCHEMA_VERSION,
      schedules,
    }
    const directory = path.dirname(this.options.storagePath)
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      await fs.chmod(directory, 0o700)
      await writeFileAtomic(
        this.options.storagePath,
        `${JSON.stringify(file, null, 2)}\n`,
      )
      await fs.chmod(this.options.storagePath, 0o600)
    } catch (error) {
      emitTaskQueueControlEvent(directory, {
        event: 'schedules.persistence_failed',
        reason: error instanceof Error ? error.message : String(error),
      })
      throw new ScheduleServiceError(
        'persistence_failed',
        'Schedules could not be persisted.',
        { cause: error },
      )
    }
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new ScheduleServiceError('schedule_unavailable', 'Schedule service is closed.'),
      )
    }
    const running = this.operationTail.then(operation)
    this.operationTail = running.then(() => undefined, () => undefined)
    return running
  }
}

function withRuntimePatch(
  current: ScheduleRuntime | undefined,
  patch: ScheduleRuntimePatch,
): ScheduleRuntime {
  const nextFireAt = 'nextFireAt' in patch ? patch.nextFireAt : current?.nextFireAt
  const lastFireAt = 'lastFireAt' in patch ? patch.lastFireAt : current?.lastFireAt
  const lastStatus = 'lastStatus' in patch ? patch.lastStatus : current?.lastStatus
  const lastSessionId = 'lastSessionId' in patch ? patch.lastSessionId : current?.lastSessionId
  const lastTaskId = 'lastTaskId' in patch ? patch.lastTaskId : current?.lastTaskId
  const activeFires = 'activeFires' in patch ? patch.activeFires : current?.activeFires
  const pendingFire = 'pendingFire' in patch ? patch.pendingFire : current?.pendingFire
  const lastError = 'lastError' in patch ? patch.lastError : current?.lastError
  return {
    ...whenDefined(nextFireAt, (value) => ({ nextFireAt: value })),
    ...whenDefined(lastFireAt, (value) => ({ lastFireAt: value })),
    ...whenDefined(lastStatus, (value) => ({ lastStatus: value })),
    ...whenDefined(lastSessionId, (value) => ({ lastSessionId: value })),
    ...whenDefined(lastTaskId, (value) => ({ lastTaskId: value })),
    ...(activeFires && activeFires.length > 0 ? { activeFires } : {}),
    ...whenDefined(pendingFire, (value) => ({ pendingFire: value })),
    ...whenDefined(lastError, (value) => ({ lastError: value })),
  }
}

function toScheduleView(schedule: StoredSchedule): ScheduleView {
  const { execution: _execution, runtime, ...definition } = schedule
  return {
    ...definition,
    ...(schedule.modelOverride
      ? { modelOverride: cloneModelOverride(schedule.modelOverride) }
      : {}),
    runtime: {
      ...(runtime ?? {}),
      ...(runtime?.activeFires
        ? { activeFires: runtime.activeFires.map((fire) => ({ ...fire })) }
        : {}),
    },
  }
}

function cloneModelOverride(
  value: ScheduleModelOverride,
): ScheduleModelOverride {
  return { provider: value.provider, model: value.model }
}

function scheduleContextSelection(
  projectId: string,
  selection: ScheduleProjectContextSelection,
) {
  return {
    projectId,
    includeBrief: selection.includeBrief,
    fileNames: [...selection.fileNames],
  }
}

function mapTerminalStatus(status: TaskStatus): ScheduleLastStatus {
  switch (status) {
    case 'done':
      return 'completed'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'failed'
  }
}

function formatFireTimestamp(date: Date): string {
  return date.toISOString().slice(0, 16).replace('T', ' ')
}

function normalizeScheduleInput(value: unknown): ScheduleInput {
  try {
    return validateScheduleInput(value)
  } catch (error) {
    throw new ScheduleServiceError(
      'invalid_request',
      error instanceof Error ? error.message : 'Schedule is invalid.',
      { cause: error },
    )
  }
}

function normalizeSchedulePatch(value: unknown): SchedulePatch {
  try {
    return validateSchedulePatch(value)
  } catch (error) {
    throw new ScheduleServiceError(
      'invalid_request',
      error instanceof Error ? error.message : 'Schedule patch is invalid.',
      { cause: error },
    )
  }
}

function runPlanApplyFailureMessage(result: unknown): string {
  if (!result || typeof result !== 'object') {
    return 'Scheduled run was not accepted.'
  }
  const record = result as Record<string, unknown>
  const error = typeof record.error === 'string'
    ? record.error
    : `Scheduled run was not accepted (status: ${String(record.status ?? 'unknown')}).`
  return typeof record.detail === 'string' && record.detail
    ? `${error}: ${record.detail}`
    : error
}

export function assertValidCronExpression(cron: string, timezone: string): void {
  if (!isValidTimezone(timezone)) {
    throw new ScheduleServiceError(
      'invalid_request',
      `Timezone '${timezone}' is invalid.`,
    )
  }
  if (cron.trim().split(/\s+/).length !== 5) {
    throw new ScheduleServiceError(
      'invalid_request',
      'Cron expression must contain exactly five fields.',
    )
  }
  try {
    new Cron(cron, { timezone, paused: true }).stop()
  } catch {
    throw new ScheduleServiceError(
      'invalid_request',
      `Cron expression '${cron}' is invalid.`,
    )
  }
}

export function computeNextScheduleFireAt(
  cron: string,
  timezone: string,
  from: Date,
): string | undefined {
  assertValidCronExpression(cron, timezone)
  const job = new Cron(cron, { timezone, paused: true })
  try {
    const next = job.nextRun(from)
    return next ? next.toISOString() : undefined
  } finally {
    job.stop()
  }
}

function requireNextFireAt(
  cron: string,
  timezone: string,
  from: Date,
): string {
  const nextFireAt = computeNextScheduleFireAt(cron, timezone, from)
  if (!nextFireAt) {
    throw new ScheduleServiceError(
      'invalid_request',
      `Cron expression '${cron}' has no future fire times.`,
    )
  }
  return nextFireAt
}
