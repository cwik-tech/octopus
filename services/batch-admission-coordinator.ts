import { whenDefined } from '../core/optional-properties.js'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'

import type { SessionSummary } from '../contracts/sessions.js'
import type { FileParserLauncher } from '../core/file-parser-launcher.js'
import { throwIfSignalAborted } from '../core/file-mutation.js'
import { isPathInside } from '../core/path-safety.js'
import type { BatchFolderAccessPolicy } from '../domains/batches/batch-folder-access.js'
import type { BatchStore } from '../domains/batches/batch-store.js'
import type { BatchItem, BatchItemFailureCode } from '../domains/batches/batch-types.js'
import type { BatchTaskPublicationResolution } from '../domains/sessions/task-recovery-manager.js'
import {
  FileSourceRepository,
  FileSourceStreamError,
} from '../domains/file-sources/file-source-repository.js'
import type {
  CreateSessionInput,
  SessionStore,
} from '../domains/sessions/session-store.js'
import {
  applyRunPlanService,
  createRunPlanService,
  type RunPlanTaskQueue,
} from './run-orchestrator-service.js'
import type { BatchArtifactWriter } from './batch-artifact-writer.js'
import type { WorkflowMcpPreflightService } from './workflow-mcp-preflight-service.js'
import { parseWorkflowRegistry, parseWorkflowTemplate } from '../workflows/loader.js'
import { workflowRequiresHumanInput } from '../workflows/validation.js'

export interface PrepareBatchItemOptions {
  readonly store: BatchStore
  readonly batchId: string
  readonly executionId: string
  readonly itemId: string
  readonly sessionStore: SessionStore
  readonly createSession: (
    input: CreateSessionInput & { projectId?: string },
  ) => Promise<SessionSummary>
  readonly folderAccessPolicy: BatchFolderAccessPolicy
  readonly fileParserLauncher: FileParserLauncher
  readonly taskQueue: RunPlanTaskQueue
  readonly workspacePath: string
  readonly repoRootPath: string
  readonly workflowsRegistryPath: string
  readonly mcpWorkflowPreflightService?: Pick<WorkflowMcpPreflightService, 'resolve'>
  readonly signal?: AbortSignal
  readonly now?: () => Date
}

export interface BatchAdmissionCoordinatorOptions {
  readonly store: BatchStore
  readonly sessionStore?: SessionStore
  readonly taskQueue: RunPlanTaskQueue & { readonly maximumConcurrentTasks: number }
  readonly artifactWriter?: Pick<BatchArtifactWriter, 'publish'>
  readonly prepareItem: (item: {
    readonly batchId: string
    readonly executionId: string
    readonly itemId: string
    readonly signal: AbortSignal
  }) => Promise<BatchItem>
  readonly pollIntervalMs?: number
}

export class BatchAdmissionCoordinator {
  private readonly pollIntervalMs: number
  private tick: NodeJS.Timeout | undefined
  private pump: Promise<void> | undefined
  private wakePending = false
  private initialized = false
  private closed = false
  private lastExecutionId: string | undefined
  private failureValue: Error | undefined
  private failureRevision = 0
  private preparingValue: string | undefined
  private readonly preparations = new Map<string, {
    readonly itemId: string
    readonly controller: AbortController
  }>()
  private readonly publicationPromises = new Map<string, Promise<void>>()
  private readonly publicationRetries = new Map<string, {
    readonly failures: number
    readonly retryAfter: number
  }>()
  private readonly revokedExecutionKeys = new Set<string>()

  constructor(private readonly options: BatchAdmissionCoordinatorOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 250
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 1) {
      throw new Error('Batch coordinator poll interval must be a positive integer.')
    }
  }

  async initialize(): Promise<void> {
    if (this.closed) throw new Error('Batch admission coordinator is closed.')
    if (this.options.sessionStore) {
      await this.reconcileExecutions()
    }
    this.initialized = true
    this.tick = setInterval(() => this.wake(), this.pollIntervalMs)
    this.tick.unref()
    this.wake()
  }

  wake(): void {
    if (!this.initialized || this.closed) return
    if (this.pump) {
      this.wakePending = true
      return
    }
    const failureRevision = this.failureRevision
    this.pump = this.runPump()
      .then(
        () => this.clearFailureIfUnchanged(failureRevision),
        (error) => this.recordFailure(error),
      )
      .finally(() => {
        this.pump = undefined
        if (this.wakePending) {
          this.wakePending = false
          queueMicrotask(() => this.wake())
        }
      })
  }

  async close(): Promise<void> {
    this.closed = true
    this.initialized = false
    if (this.tick) clearInterval(this.tick)
    this.tick = undefined
    for (const preparation of this.preparations.values()) preparation.controller.abort()
    await this.pump
    await Promise.all(this.publicationPromises.values())
  }

  cancelExecution(batchId: string, executionId: string): Promise<void> {
    this.preparations.get(executionKey(batchId, executionId))?.controller.abort()
    this.wake()
    return this.pump ?? Promise.resolve()
  }

  async reconcileFolderAccess(policy: BatchFolderAccessPolicy): Promise<void> {
    const executions = await this.activeExecutions()
    for (const execution of executions) {
      if (await policy.resolveAllowedFolder(execution.sourceFolderCanonicalPath)) continue
      const key = executionKey(execution.batchId, execution.id)
      this.revokedExecutionKeys.add(key)
      const stagedItemIds = await this.options.store.mutateExecution(
        execution.batchId,
        execution.id,
        (current) => {
          const timestamp = new Date().toISOString()
          const items = current.items.map((item) =>
            item.status === 'pending' ||
            (item.status === 'preparing' && !hasImmutableStagedSource(item))
              ? {
                  ...item,
                  status: 'setup_failed' as const,
                  failureCode: 'folder_access_revoked' as const,
                  failureDetail: 'Batch folder access was revoked.',
                  completedAt: item.completedAt ?? timestamp,
                  updatedAt: timestamp,
                }
              : item,
          )
          const terminal = items.every(isTerminalBatchItem)
          return {
            execution: {
              ...current,
              items,
              ...(terminal
                ? {
                    status: current.cancelRequestedAt ? 'cancelled' as const : 'completed' as const,
                    completedAt: current.completedAt ?? timestamp,
                  }
                : {}),
              updatedAt: timestamp,
            },
            result: current.items
              .filter((item) => item.status === 'preparing' && hasImmutableStagedSource(item))
              .map((item) => item.id),
          }
        },
      )
      const preparation = this.preparations.get(key)
      if (preparation && !stagedItemIds.includes(preparation.itemId)) {
        preparation.controller.abort(
          new DOMException('Batch folder access was revoked.', 'AbortError'),
        )
        await this.pump
      }
    }
    this.wake()
  }

  get failure(): Error | undefined {
    return this.failureValue
  }

  get preparing(): string | undefined {
    return this.preparingValue
  }

  private async runPump(): Promise<void> {
    if (this.options.sessionStore) {
      await this.reconcileExecutions()
    }
    while (!this.closed && this.options.taskQueue.isReady()) {
      const executions = await this.activeExecutions()
      const accepted = executions.reduce(
        (total, execution) => total + execution.items.filter(isTaskQueueAccepted).length,
        0,
      )
      if (accepted >= this.options.taskQueue.maximumConcurrentTasks + 1) return
      const candidates = executions.filter((execution) =>
        execution.status === 'running' &&
        !execution.cancelRequestedAt &&
        !this.revokedExecutionKeys.has(executionKey(execution.batchId, execution.id)) &&
        execution.items.some((item) => item.status === 'pending'),
      )
      if (candidates.length === 0) return
      const execution = nextExecution(candidates, this.lastExecutionId)
      const item = execution.items.find((candidate) => candidate.status === 'pending')
      if (!item) return
      this.lastExecutionId = execution.id
      const controller = new AbortController()
      const key = executionKey(execution.batchId, execution.id)
      this.preparations.set(key, { itemId: item.id, controller })
      try {
        this.preparingValue = `${execution.id}:${item.id}`
        await this.options.prepareItem({
          batchId: execution.batchId,
          executionId: execution.id,
          itemId: item.id,
          signal: controller.signal,
        })
      } catch (error) {
        if (isAbortError(error)) continue
        throw error
      } finally {
        this.preparations.delete(key)
        this.preparingValue = undefined
      }
    }
  }

  private async reconcileExecutions(): Promise<void> {
    if (!this.options.sessionStore) return
    await reconcileBatchExecutions({
      store: this.options.store,
      sessionStore: this.options.sessionStore,
      ...(this.options.artifactWriter
        ? {
            artifactWriter: this.options.artifactWriter,
            schedulePublication: (
              key: string,
              publication: () => Promise<void>,
            ) => this.schedulePublication(key, publication),
          }
        : {}),
    })
  }

  private schedulePublication(key: string, publication: () => Promise<void>): void {
    if (this.publicationPromises.has(key)) return
    const retry = this.publicationRetries.get(key)
    if (retry && retry.retryAfter > Date.now()) return
    const failureRevision = this.failureRevision
    let succeeded = false
    const promise = Promise.resolve()
      .then(publication)
      .then(
        () => {
          succeeded = true
          this.publicationRetries.delete(key)
          this.clearFailureIfUnchanged(failureRevision)
        },
        (error) => {
          const failures = (retry?.failures ?? 0) + 1
          this.publicationRetries.set(key, {
            failures,
            retryAfter: Date.now() + Math.min(
              this.pollIntervalMs * 2 ** Math.min(failures - 1, 4),
              5_000,
            ),
          })
          this.recordFailure(error)
        },
      )
      .finally(() => {
        this.publicationPromises.delete(key)
        if (succeeded) this.wake()
      })
    this.publicationPromises.set(key, promise)
  }

  private recordFailure(error: unknown): void {
    this.failureRevision += 1
    this.failureValue = error instanceof Error ? error : new Error(String(error))
  }

  private clearFailureIfUnchanged(failureRevision: number): void {
    if (this.failureRevision === failureRevision) this.failureValue = undefined
  }

  private async activeExecutions() {
    const definitions = await this.options.store.readDefinitions()
    const executions = (
      await Promise.all(definitions.map((definition) =>
        this.options.store.listExecutions(definition.id),
      ))
    ).flat().filter((execution) =>
      execution.status === 'pending' || execution.status === 'running' || execution.status === 'draining',
    )
    return executions.sort((left, right) =>
      left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id),
    )
  }
}

function executionKey(batchId: string, executionId: string): string {
  return `${batchId}:${executionId}`
}

function isTaskQueueAccepted(item: BatchItem): boolean {
  return item.status === 'queued' || item.status === 'running' || item.status === 'recovering'
}

function hasImmutableStagedSource(item: BatchItem): boolean {
  return item.preparationPhase === 'file_staged' || item.preparationPhase === 'plan_persisted'
}

function nextExecution<T extends { id: string }>(
  executions: readonly T[],
  lastExecutionId: string | undefined,
): T {
  const priorIndex = lastExecutionId
    ? executions.findIndex((execution) => execution.id === lastExecutionId)
    : -1
  const execution = executions[(priorIndex + 1 + executions.length) % executions.length]
  if (!execution) throw new Error('Batch admission needs at least one candidate execution to pick from.')
  return execution
}

export async function prepareBatchItem(
  options: PrepareBatchItemOptions,
): Promise<BatchItem> {
  const now = options.now ?? (() => new Date())
  let current = await requireItem(options)
  if (current.status !== 'pending') return current
  try {
    throwIfSignalAborted(options.signal)
    current = await patchItem(options, current, {
      status: 'preparing',
      preparationPhase: 'intent_persisted',
      updatedAt: now().toISOString(),
    })
    const execution = await requireExecution(options)
    const workflowRegistry = parseWorkflowRegistry(options.workflowsRegistryPath)
    const workflowEntry = workflowRegistry.entries.find(
      (entry) => entry.name === execution.definitionSnapshot.workflowId,
    )
    const workflowTemplate = workflowEntry
      ? parseWorkflowTemplate(workflowEntry.template_path).template
      : undefined
    if (workflowTemplate && workflowRequiresHumanInput(workflowTemplate)) {
      throw setupError(
        'workflow_requires_input',
        `Batch workflow '${execution.definitionSnapshot.workflowId}' contains a human-in-the-loop step.`,
      )
    }
    const session = await options.createSession({
      title: `${execution.definitionSnapshot.name} — ${current.id}`,
      ...(execution.definitionSnapshot.projectId
        ? { projectId: execution.definitionSnapshot.projectId }
        : {}),
      origin: {
        kind: 'batch',
        batchId: options.batchId,
        executionId: options.executionId,
        itemId: options.itemId,
      },
    })
    current = await patchItem(options, current, {
      sessionId: session.id,
      preparationPhase: 'session_persisted',
      updatedAt: now().toISOString(),
    })

    throwIfSignalAborted(options.signal)
    const canonicalFolder = await options.folderAccessPolicy.resolveAllowedFolder(
      execution.sourceFolderCanonicalPath,
    )
    if (!canonicalFolder) throw setupError('folder_access_revoked', 'Batch folder access was revoked.')
    const sourcePath = path.join(canonicalFolder, current.fileName)
    const canonicalSource = await fs.realpath(sourcePath).catch(() => null)
    const sourceStat = await fs.lstat(sourcePath).catch(() => null)
    if (
      !canonicalSource ||
      !sourceStat?.isFile() ||
      sourceStat.isSymbolicLink() ||
      !isPathInside(canonicalFolder, canonicalSource)
    ) {
      throw setupError('source_unavailable', 'Batch source is unavailable or unsafe.')
    }
    const inputsDir = options.sessionStore.inputsDir(session.id)
    const repository = new FileSourceRepository({
      rootDir: inputsDir,
      containmentRoot: path.dirname(inputsDir),
    })
    const staged = await repository.saveFromFile(canonicalSource, current.fileName, {
      overwrite: false,
      maxBytes: 100 * 1024 * 1024,
      expectedSha256: current.sourceSha256,
      ...whenDefined(options.signal, (definedValue) => ({ signal: definedValue })),
    })
    if (staged.status !== 'saved') {
      throw setupError('source_unavailable', `Batch source could not be staged: ${staged.status}`)
    }
    current = await patchItem(options, current, {
      preparationPhase: 'file_staged',
      updatedAt: now().toISOString(),
    })

    await options.fileParserLauncher.parseDirectory(inputsDir, { ...whenDefined(options.signal, (definedValue) => ({ signal: definedValue })) })
    throwIfSignalAborted(options.signal)
    const file = (await options.sessionStore.listFiles(session.id)).find(
      (candidate) => candidate.name === current.fileName,
    )
    if (!file || file.parseStatus === 'error') {
      throw setupError('parse_failed', file?.parserError ?? 'Batch parser did not produce a file record.')
    }
    const textOutput = file.outputs?.text
    if (!textOutput || !await options.sessionStore.readParsedText(session.id, textOutput)) {
      throw setupError('parsed_text_missing', 'Batch parser did not produce readable text output.')
    }

    const plan = await createRunPlanService({
      sessionId: session.id,
      sessionStore: options.sessionStore,
      repoRootPath: options.repoRootPath,
      workflowsRegistryPath: options.workflowsRegistryPath,
      goal: '',
      workflowId: execution.definitionSnapshot.workflowId,
    })
    if (plan.status !== 'ready') {
      throw setupError('workflow_requires_input', `Batch run plan is ${plan.status}.`)
    }
    current = await patchItem(options, current, {
      runPlanId: plan.id,
      preparationPhase: 'plan_persisted',
      updatedAt: now().toISOString(),
    })

    throwIfSignalAborted(options.signal)
    const applied = await applyRunPlanService({
      sessionId: session.id,
      sessionStore: options.sessionStore,
      taskQueue: options.taskQueue,
      repoRootPath: options.repoRootPath,
      workspacePath: options.workspacePath,
      workflowsRegistryPath: options.workflowsRegistryPath,
      plan,
      admissionSource: 'batch',
      ...(options.mcpWorkflowPreflightService
        ? { mcpWorkflowPreflightService: options.mcpWorkflowPreflightService }
        : {}),
    })
    if (!applied.ok) {
      throw setupError(
        applied.status === 'needs_input' ? 'workflow_requires_input' : 'admission_failed',
        'Batch run plan was not admitted.',
      )
    }
    return patchItem(options, current, {
      taskId: applied.task.id,
      status: 'queued',
      updatedAt: now().toISOString(),
    })
  } catch (error) {
    if (error instanceof BatchItemTransitionConflictError) return error.latest
    if (isAbortError(error)) throw error
    const classified = classifyPreparationError(error)
    try {
      return await patchItem(options, current, {
        status: 'setup_failed',
        failureCode: classified.code,
        failureDetail: classified.message,
        completedAt: now().toISOString(),
        updatedAt: now().toISOString(),
      })
    } catch (patchError) {
      if (patchError instanceof BatchItemTransitionConflictError) return patchError.latest
      throw patchError
    }
  }
}

export async function reconcileBatchExecutions(options: {
  readonly store: BatchStore
  readonly sessionStore: SessionStore
  readonly artifactWriter?: Pick<BatchArtifactWriter, 'publish'>
  readonly publicationResolver?: (
    sessionId: string,
    taskId: string,
    executionAttemptId: string,
  ) => Promise<BatchTaskPublicationResolution>
  readonly schedulePublication?: (
    key: string,
    publication: () => Promise<void>,
  ) => void
  readonly now?: () => Date
}): Promise<void> {
  const now = options.now ?? (() => new Date())
  const definitions = await options.store.readDefinitions()
  for (const definition of definitions) {
    const executions = await options.store.listExecutions(definition.id)
    for (const execution of executions) {
      if (
        execution.status === 'completed' ||
        execution.status === 'cancelled' ||
        execution.status === 'failed'
      ) continue
      const reconciled = await options.store.mutateExecution(definition.id, execution.id, async (current) => {
        const items: BatchItem[] = []
        for (const item of current.items) {
          items.push(await reconcileItem(item, options.sessionStore, now))
        }
        const allTerminal = items.every(isTerminalBatchItem)
        const completedAt = allTerminal ? current.completedAt ?? now().toISOString() : current.completedAt
        return {
          execution: {
            ...current,
            items,
            ...(allTerminal
              ? {
                  status: current.cancelRequestedAt ? 'cancelled' as const : 'completed' as const,
                  completedAt,
                }
              : {}),
            updatedAt: now().toISOString(),
          },
          result: {
            ...current,
            items,
            ...(allTerminal
              ? {
                  status: current.cancelRequestedAt ? 'cancelled' as const : 'completed' as const,
                  completedAt,
                }
              : {}),
            updatedAt: now().toISOString(),
          },
        }
      })
      const artifactWriter = options.artifactWriter
      if (artifactWriter) {
        for (const item of reconciled.items.filter((candidate) => candidate.status === 'publishing')) {
          const publication = () => publishBatchItem({
            store: options.store,
            sessionStore: options.sessionStore,
            artifactWriter,
            ...(options.publicationResolver ? { publicationResolver: options.publicationResolver } : {}),
            ...(options.now ? { now: options.now } : {}),
            batchId: definition.id,
            executionId: execution.id,
            item,
          })
          if (options.schedulePublication) {
            options.schedulePublication(
              `${definition.id}:${execution.id}:${item.id}`,
              publication,
            )
          } else {
            await publication()
          }
        }
      }
    }
  }
}

async function publishBatchItem(options: {
  readonly store: BatchStore
  readonly sessionStore: SessionStore
  readonly artifactWriter: Pick<BatchArtifactWriter, 'publish'>
  readonly publicationResolver?: (
    sessionId: string,
    taskId: string,
    executionAttemptId: string,
  ) => Promise<BatchTaskPublicationResolution>
  readonly batchId: string
  readonly executionId: string
  readonly item: BatchItem
  readonly now?: () => Date
}): Promise<void> {
  const now = options.now ?? (() => new Date())
  const { item } = options
  try {
    let resolution: BatchTaskPublicationResolution
    if (!item.sessionId || !item.taskId || !item.taskExecutionAttemptId) {
      resolution = {
        status: 'failed',
        code: 'verified_publication_invalid',
        detail: 'Publishing item does not contain exact task publication identity.',
      }
    } else {
      const resolver = options.publicationResolver ?? ((sessionId, taskId, executionAttemptId) =>
        options.sessionStore.resolveTaskPublication(sessionId, taskId, executionAttemptId))
      resolution = await resolver(item.sessionId, item.taskId, item.taskExecutionAttemptId)
    }
    if (resolution.status === 'failed') {
      await finishPublication(options, {
        status: 'artifact_failed',
        failureCode: resolution.code,
        failureDetail: resolution.detail,
        resultArtifacts: [],
      }, now)
      return
    }
    const publication = await options.artifactWriter.publish({
      batchId: options.batchId,
      executionId: options.executionId,
      itemId: item.id,
      artifacts: resolution.artifacts,
    })
    if (publication.status === 'failed') {
      await finishPublication(options, {
        status: 'artifact_failed',
        failureCode: publication.code,
        failureDetail: publication.detail,
        resultArtifacts: [],
      }, now)
      return
    }
    await finishPublication(options, {
      status: 'done',
      resultArtifacts: publication.artifacts,
    }, now)
  } catch (error) {
    await finishPublication(options, {
      status: 'artifact_failed',
      failureCode: 'artifact_copy_failed',
      failureDetail: boundedFailureDetail(
        'Unexpected Batch artifact publication failure',
        error,
      ),
      resultArtifacts: [],
    }, now)
  }
}

function boundedFailureDetail(prefix: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `${prefix}: ${detail || 'unknown error'}`.slice(0, 4_000)
}

async function finishPublication(
  options: {
    readonly store: BatchStore
    readonly batchId: string
    readonly executionId: string
    readonly item: BatchItem
  },
  patch: Partial<BatchItem>,
  now: () => Date,
): Promise<void> {
  await options.store.mutateExecution(options.batchId, options.executionId, (execution) => {
    const timestamp = now().toISOString()
    const items = execution.items.map((item) => {
      if (item.id !== options.item.id) return item
      if (patch.status === 'done') {
        const {
          failureCode: _failureCode,
          failureDetail: _failureDetail,
          ...successfulItem
        } = item
        return {
          ...successfulItem,
          ...patch,
          completedAt: item.completedAt ?? timestamp,
          updatedAt: timestamp,
        }
      }
      return {
        ...item,
        ...patch,
        completedAt: item.completedAt ?? timestamp,
        updatedAt: timestamp,
      }
    })
    const terminal = items.every(isTerminalBatchItem)
    const retainedResultBytes = items.reduce(
      (total, item) => total + item.resultArtifacts.reduce(
        (itemTotal, artifact) => itemTotal + artifact.byteLength,
        0,
      ),
      0,
    )
    return {
      execution: {
        ...execution,
        items,
        retainedResultBytes,
        ...(terminal
          ? {
              status: execution.cancelRequestedAt ? 'cancelled' as const : 'completed' as const,
              completedAt: execution.completedAt ?? timestamp,
            }
          : {}),
        updatedAt: timestamp,
      },
      result: undefined,
    }
  })
}

async function reconcileItem(
  item: BatchItem,
  sessionStore: SessionStore,
  now: () => Date,
): Promise<BatchItem> {
  if (item.status === 'preparing') {
    if (!item.sessionId) return ambiguousRecovery(item, now, 'Preparation has no durable session ID.')
    const session = await sessionStore.getSession(item.sessionId)
    if (!session) return ambiguousRecovery(item, now, 'Preparation session is missing.')
    const tasks = await sessionStore.listTaskRecords(item.sessionId)
    if (item.preparationPhase === 'plan_persisted' && item.runPlanId) {
      const matching = tasks.filter((task) => task.runPlanId === item.runPlanId)
      if (matching.length !== 1) {
        return ambiguousRecovery(
          item,
          now,
          matching.length === 0
            ? 'Persisted plan has no linked task.'
            : 'Persisted plan has multiple linked tasks.',
        )
      }
      const [linkedTask] = matching
      if (!linkedTask) throw new Error('Persisted plan must have exactly one linked task at this point.')
      return projectTaskStatus({ ...item, taskId: linkedTask.id }, linkedTask, now)
    }
    return ambiguousRecovery(item, now, 'Preparation stopped before a task-linked plan was persisted.')
  }
  if (
    (item.status === 'queued' || item.status === 'running' || item.status === 'recovering') &&
    item.sessionId &&
    item.taskId
  ) {
    const task = await sessionStore.getTaskRecord(item.sessionId, item.taskId)
    return task
      ? projectTaskStatus(item, task, now)
      : ambiguousRecovery(item, now, 'Batch task is missing during recovery.')
  }
  return item
}

function projectTaskStatus(
  item: BatchItem,
  task: Awaited<ReturnType<SessionStore['getTaskRecord']>> & {},
  now: () => Date,
): BatchItem {
  const updatedAt = now().toISOString()
  if (task.status === 'queued') return { ...item, status: 'queued', updatedAt }
  if (task.status === 'running') {
    return {
      ...item,
      status: 'running',
      ...(task.executionAttemptId ? { taskExecutionAttemptId: task.executionAttemptId } : {}),
      updatedAt,
    }
  }
  if (task.status === 'interrupted') {
    return {
      ...item,
      status: 'recovering',
      ...(task.executionAttemptId ? { taskExecutionAttemptId: task.executionAttemptId } : {}),
      updatedAt,
    }
  }
  if (task.status === 'done') {
    return {
      ...item,
      status: 'publishing',
      ...(task.executionAttemptId ? { taskExecutionAttemptId: task.executionAttemptId } : {}),
      publicationStartedAt: item.publicationStartedAt ?? updatedAt,
      updatedAt,
    }
  }
  const failure = task.status === 'blocked'
    ? { status: 'blocked' as const, failureCode: 'task_blocked' as const }
    : task.status === 'cancelled'
      ? { status: 'cancelled' as const, failureCode: 'task_cancelled' as const }
      : { status: 'failed' as const, failureCode: 'task_failed' as const }
  return {
    ...item,
    ...failure,
    ...whenDefined(task.error, (failureDetail) => ({ failureDetail })),
    completedAt: item.completedAt ?? updatedAt,
    updatedAt,
  }
}

function ambiguousRecovery(item: BatchItem, now: () => Date, detail: string): BatchItem {
  const timestamp = now().toISOString()
  return {
    ...item,
    status: 'setup_failed',
    failureCode: 'recovery_state_ambiguous',
    failureDetail: detail,
    completedAt: item.completedAt ?? timestamp,
    updatedAt: timestamp,
  }
}

function isTerminalBatchItem(item: BatchItem): boolean {
  return item.status === 'skipped' || item.status === 'done' || item.status === 'failed' ||
    item.status === 'blocked' || item.status === 'cancelled' ||
    item.status === 'setup_failed' || item.status === 'artifact_failed'
}

class BatchItemPreparationError extends Error {
  constructor(readonly code: BatchItemFailureCode, message: string) {
    super(message)
    this.name = 'BatchItemPreparationError'
  }
}

class BatchItemTransitionConflictError extends Error {
  constructor(readonly latest: BatchItem) {
    super('Batch item changed during preparation.')
    this.name = 'BatchItemTransitionConflictError'
  }
}

function setupError(code: BatchItemFailureCode, message: string): BatchItemPreparationError {
  return new BatchItemPreparationError(code, message)
}

async function requireExecution(options: PrepareBatchItemOptions) {
  const execution = await options.store.readExecution(options.batchId, options.executionId)
  if (!execution) throw new Error(`Batch execution not found: ${options.executionId}`)
  return execution
}

async function requireItem(options: PrepareBatchItemOptions): Promise<BatchItem> {
  const execution = await requireExecution(options)
  const item = execution.items.find((candidate) => candidate.id === options.itemId)
  if (!item) throw new Error(`Batch item not found: ${options.itemId}`)
  return item
}

async function patchItem(
  options: PrepareBatchItemOptions,
  prior: BatchItem,
  patch: Partial<BatchItem>,
): Promise<BatchItem> {
  return options.store.mutateExecution(options.batchId, options.executionId, (execution) => {
    const latest = execution.items.find((candidate) => candidate.id === options.itemId)
    if (!latest) throw new Error(`Batch item not found: ${options.itemId}`)
    if (
      latest.status !== prior.status ||
      latest.preparationPhase !== prior.preparationPhase
    ) {
      throw new BatchItemTransitionConflictError(latest)
    }
    if (latest.sessionId && prior.sessionId && latest.sessionId !== prior.sessionId) {
      throw new Error('Batch item session ownership changed during preparation.')
    }
    const next = { ...latest, ...patch }
    return {
      execution: {
        ...execution,
        items: execution.items.map((item) => item.id === next.id ? next : item),
        updatedAt: patch.updatedAt ?? execution.updatedAt,
      },
      result: next,
    }
  })
}

function classifyPreparationError(error: unknown): BatchItemPreparationError {
  if (error instanceof BatchItemPreparationError) return error
  if (error instanceof FileSourceStreamError) {
    return setupError(
      error.code === 'file_too_large'
        ? 'file_too_large'
        : error.code === 'source_changed'
          ? 'source_changed'
          : 'source_unavailable',
      error.message,
    )
  }
  return setupError('admission_failed', error instanceof Error ? error.message : String(error))
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { readonly name?: unknown; readonly code?: unknown }
  return candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR'
}
