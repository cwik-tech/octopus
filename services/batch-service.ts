import * as crypto from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { whenDefined } from '../core/optional-properties.js'

import type {
  BatchDefinitionInput,
  BatchExecutionSummary,
  BatchExecutionItemPage,
  BatchExecutionPage,
  BatchItemView,
  BatchLimitSummary,
  BatchPatch,
  BatchPreflight,
  BatchView,
} from '../contracts/batches.js'
import type { SessionTask } from '../contracts/sessions.js'
import {
  parseCreateBatchRequest,
  parsePatchBatchRequest,
} from '../contracts/schemas/batch-requests.js'
import type { BatchFolderAccessPolicy } from '../domains/batches/batch-folder-access.js'
import {
  BatchFolderScanError,
  scanBatchFolder,
  type BatchFolderScanResult,
} from '../domains/batches/batch-folder-scanner.js'
import { selectBatchFiles } from '../domains/batches/batch-rerun-selector.js'
import { BatchStore, BatchStoreUnavailableError } from '../domains/batches/batch-store.js'
import {
  parseBatchDefinitionsFile,
  type BatchDefinition,
  type BatchExecution,
  type BatchItem,
} from '../domains/batches/batch-types.js'

export type BatchServiceErrorCode =
  | 'invalid_batch_request'
  | 'folder_access_denied'
  | 'grant_not_found'
  | 'batch_not_found'
  | 'execution_not_found'
  | 'item_not_found'
  | 'artifact_not_found'
  | 'artifact_cleared'
  | 'batch_active'
  | 'batch_execution_active'
  | 'batch_cleanup_active'
  | 'batch_definition_changed'
  | 'batch_has_no_matching_files'
  | 'batch_too_large'
  | 'task_queue_recovering'
  | 'batch_service_unavailable'

export class BatchServiceError extends Error {
  constructor(
    readonly code: BatchServiceErrorCode,
    message: string,
    readonly details?: { readonly limits?: BatchLimitSummary; readonly preflight?: BatchPreflight },
  ) {
    super(message)
    this.name = 'BatchServiceError'
  }
}

export interface BatchServiceOptions {
  readonly workspacePath: string
  readonly store: BatchStore
  readonly folderAccessPolicy: BatchFolderAccessPolicy
  readonly validateWorkflow: (workflowId: string) => Promise<boolean>
  readonly validateProject?: (projectId: string) => Promise<boolean>
  readonly isTaskQueueReady?: () => boolean
  readonly cancelTask?: (sessionId: string, taskId: string) => Promise<SessionTask | null>
  readonly coordinator?: {
    wake(): void
    cancelExecution(batchId: string, executionId: string): Promise<void>
  }
  readonly randomUUID?: () => string
  readonly now?: () => Date
  readonly cancellationRetryDelayMs?: number
  readonly cancellationMaxAttempts?: number
}

export class BatchService {
  private readonly workspacePath: string
  private readonly resultsPath: string
  private readonly store: BatchStore
  private readonly folderAccessPolicy: BatchFolderAccessPolicy
  private readonly validateWorkflow: (workflowId: string) => Promise<boolean>
  private readonly validateProject: ((projectId: string) => Promise<boolean>) | undefined
  private readonly isTaskQueueReady: (() => boolean) | undefined
  private readonly cancelTask: ((sessionId: string, taskId: string) => Promise<SessionTask | null>) | undefined
  private readonly coordinator?: BatchServiceOptions['coordinator']
  private readonly randomUUID: () => string
  private readonly now: () => Date
  private readonly cancellationRetryDelayMs: number
  private readonly cancellationMaxAttempts: number
  private operationTail: Promise<void> = Promise.resolve()
  private readonly cancellationDrains = new Map<string, Promise<void>>()
  private readonly resultClearOperations = new Map<string, Promise<void>>()
  private readonly batchDeletionOperations = new Set<string>()
  private initialized = false

  constructor(options: BatchServiceOptions) {
    this.workspacePath = path.resolve(options.workspacePath)
    this.resultsPath = path.join(this.workspacePath, 'batch-results')
    this.store = options.store
    this.folderAccessPolicy = options.folderAccessPolicy
    this.validateWorkflow = options.validateWorkflow
    this.validateProject = options.validateProject
    this.isTaskQueueReady = options.isTaskQueueReady
    this.cancelTask = options.cancelTask
    this.coordinator = options.coordinator
    this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID())
    this.now = options.now ?? (() => new Date())
    this.cancellationRetryDelayMs = options.cancellationRetryDelayMs ?? 100
    if (!Number.isSafeInteger(this.cancellationRetryDelayMs) || this.cancellationRetryDelayMs < 0) {
      throw new Error('Batch cancellation retry delay must be a non-negative integer.')
    }
    this.cancellationMaxAttempts = options.cancellationMaxAttempts ?? 5
    if (!Number.isSafeInteger(this.cancellationMaxAttempts) || this.cancellationMaxAttempts < 1) {
      throw new Error('Batch cancellation maximum attempts must be a positive integer.')
    }
  }

  async initialize(): Promise<void> {
    try {
      await this.store.initialize()
      this.initialized = true
      await this.resumeCancellationDrains()
    } catch (error) {
      this.initialized = false
      throw this.unavailable(error)
    }
  }

  markUnavailable(): void {
    this.initialized = false
  }

  async close(): Promise<void> {
    this.initialized = false
    await Promise.allSettled([...this.cancellationDrains.values()])
  }

  async list(): Promise<BatchView[]> {
    this.assertReady()
    const definitions = await this.store.readDefinitions()
    return Promise.all(definitions.map((definition) => this.toView(definition)))
  }

  async get(batchId: string): Promise<BatchView | null> {
    this.assertReady()
    const definition = (await this.store.readDefinitions()).find((entry) => entry.id === batchId)
    return definition ? this.toView(definition) : null
  }

  async listExecutionsPage(
    batchId: string,
    options: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<BatchExecutionPage> {
    this.assertReady()
    await this.requireDefinition(batchId)
    const limit = paginationLimit(options.limit)
    const executions = await this.store.listExecutions(batchId)
    const start = options.cursor === undefined
      ? 0
      : executionCursorStart(executions, options.cursor)
    const page = executions.slice(start, start + limit)
    const lastExecution = page.at(-1)
    return {
      executions: page.map(summarizeExecution),
      ...(start + page.length < executions.length && lastExecution
        ? { nextCursor: encodeExecutionCursor(lastExecution) }
        : {}),
    }
  }

  async getExecutionItemsPage(
    batchId: string,
    executionId: string,
    options: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<BatchExecutionItemPage> {
    this.assertReady()
    const execution = await this.store.readExecution(batchId, executionId)
    if (!execution) {
      throw new BatchServiceError('execution_not_found', `Batch execution not found: ${executionId}`)
    }
    const limit = paginationLimit(options.limit)
    const afterOrdinal = options.cursor === undefined ? -1 : decodeItemCursor(options.cursor)
    const items = [...execution.items]
      .sort((left, right) => left.ordinal - right.ordinal)
      .filter((item) => item.ordinal > afterOrdinal)
    const page = items.slice(0, limit)
    const lastItem = page.at(-1)
    return {
      execution: summarizeExecution(execution),
      items: page.map(toItemView),
      ...(page.length < items.length && lastItem
        ? { nextCursor: encodeItemCursor(lastItem.ordinal) }
        : {}),
    }
  }

  async readResultArtifact(
    batchId: string,
    executionId: string,
    itemId: string,
    artifactIndex: number,
  ): Promise<{ readonly content: Buffer; readonly contentType: string; readonly fileName: string }> {
    this.assertReady()
    if (this.isResultCleanupActive(batchId, executionId)) {
      throw new BatchServiceError('batch_cleanup_active', 'Batch result cleanup is active.')
    }
    const execution = await this.store.readExecution(batchId, executionId)
    if (!execution) {
      throw new BatchServiceError('execution_not_found', `Batch execution not found: ${executionId}`)
    }
    const item = execution.items.find((candidate) => candidate.id === itemId)
    if (!item) throw new BatchServiceError('item_not_found', `Batch item not found: ${itemId}`)
    const artifact = Number.isSafeInteger(artifactIndex) && artifactIndex >= 0
      ? item.resultArtifacts[artifactIndex]
      : undefined
    if (!artifact) throw new BatchServiceError('artifact_not_found', 'Batch artifact not found.')
    if (execution.resultsClearedAt) {
      throw new BatchServiceError('artifact_cleared', 'Batch artifact copy was cleared.')
    }
    const artifactPath = path.resolve(this.resultsPath, artifact.destinationPath)
    const relative = path.relative(this.resultsPath, artifactPath)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new BatchServiceError('artifact_not_found', 'Batch artifact path is invalid.')
    }
    let content: Buffer
    let handle: fs.FileHandle | undefined
    try {
      handle = await fs.open(artifactPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size !== artifact.byteLength) {
        throw new Error('Batch artifact is not a regular file with the expected size.')
      }
      content = await handle.readFile()
    } catch {
      throw new BatchServiceError('artifact_not_found', 'Batch artifact copy is unavailable.')
    } finally {
      await handle?.close().catch(() => undefined)
    }
    if (crypto.createHash('sha256').update(content).digest('hex') !== artifact.sha256) {
      throw new BatchServiceError('artifact_not_found', 'Batch artifact copy failed verification.')
    }
    return {
      content,
      contentType: artifact.mediaType ?? 'application/octet-stream',
      fileName: path.basename(artifact.destinationPath),
    }
  }

  async create(input: BatchDefinitionInput): Promise<BatchDefinition> {
    this.assertReady()
    let parsed: BatchDefinitionInput
    try {
      parsed = parseCreateBatchRequest(input)
    } catch (error) {
      throw this.invalid(error)
    }
    const canonicalFolder = await this.requireFolder(parsed.folderPath)
    await this.requireWorkflow(parsed.workflowId)
    await this.requireProject(parsed.projectId)
    return this.enqueueMutation(async () => {
      const now = this.now().toISOString()
      const definition: BatchDefinition = {
        id: `batch_${this.randomUUID()}`,
        revision: 1,
        ...parsed,
        folderPath: canonicalFolder,
        createdAt: now,
        updatedAt: now,
      }
      return this.store.mutateDefinitions((definitions) => ({
        definitions: [...definitions, definition],
        result: definition,
      }))
    })
  }

  async update(batchId: string, patch: BatchPatch): Promise<BatchDefinition> {
    this.assertReady()
    let parsed: BatchPatch
    try {
      parsed = parsePatchBatchRequest(patch)
    } catch (error) {
      throw this.invalid(error)
    }
    const canonicalFolder = parsed.folderPath === undefined
      ? undefined
      : await this.requireFolder(parsed.folderPath)
    if (parsed.workflowId !== undefined) await this.requireWorkflow(parsed.workflowId)
    if (parsed.projectId !== undefined && parsed.projectId !== null) {
      await this.requireProject(parsed.projectId)
    }
    return this.enqueueMutation(() => this.store.mutateDefinitions((definitions) => {
      const current = definitions.find((entry) => entry.id === batchId)
      if (!current) throw new BatchServiceError('batch_not_found', `Batch not found: ${batchId}`)
      if (current.revision !== parsed.expectedRevision) {
        throw new BatchServiceError('batch_definition_changed', 'Batch definition revision changed.')
      }
      const {
        expectedRevision: _expectedRevision,
        projectId: nextProjectId,
        ...changes
      } = parsed
      const { projectId: _currentProjectId, ...currentWithoutProject } = current
      const updated: BatchDefinition = {
        ...currentWithoutProject,
        ...changes,
        ...(canonicalFolder === undefined ? {} : { folderPath: canonicalFolder }),
        ...(nextProjectId === undefined
          ? {}
          : nextProjectId === null
            ? {}
            : { projectId: nextProjectId }),
        revision: current.revision + 1,
        updatedAt: this.now().toISOString(),
      }
      return {
        definitions: definitions.map((entry) => entry.id === batchId ? updated : entry),
        result: updated,
      }
    }))
  }

  async delete(batchId: string): Promise<void> {
    this.assertReady()
    if ([...this.resultClearOperations.keys()].some((key) => key.startsWith(`${batchId}:`))) {
      throw new BatchServiceError('batch_cleanup_active', 'Batch result cleanup is active.')
    }
    if (this.batchDeletionOperations.has(batchId)) {
      throw new BatchServiceError('batch_cleanup_active', 'Batch deletion is active.')
    }
    this.batchDeletionOperations.add(batchId)
    try {
      await this.enqueueMutation(async () => {
        const definitions = await this.store.readDefinitions()
        if (!definitions.some((entry) => entry.id === batchId)) {
          throw new BatchServiceError('batch_not_found', `Batch not found: ${batchId}`)
        }
        const executions = await this.store.listExecutions(batchId)
        if (executions.some((execution) => !isTerminalExecution(execution))) {
          throw new BatchServiceError('batch_active', 'Batch has an active execution.')
        }
        const requestedAt = this.now().toISOString()
        await this.store.writeDeletionIntent({ schemaVersion: 1, batchId, requestedAt })
        await fs.rm(path.join(this.resultsPath, batchId), { recursive: true, force: true })
        await this.store.deleteBatchState(batchId)
        await this.store.mutateDefinitions((current) => ({
          definitions: current.filter((entry) => entry.id !== batchId),
          result: undefined,
        }))
        await this.store.removeDeletionIntent(batchId)
      })
    } finally {
      this.batchDeletionOperations.delete(batchId)
    }
  }

  async preflight(batchId: string): Promise<BatchPreflight> {
    this.assertReady()
    const definition = await this.requireDefinition(batchId)
    const scan = await this.scan(definition)
    const history = await this.store.listExecutions(batchId)
    return toPreflight(scan, selectBatchFiles(definition.rerunPolicy, scan.files, history))
  }

  async runNow(batchId: string): Promise<BatchExecution> {
    this.assertReady()
    this.requireReadyTaskQueue()
    const definition = await this.requireDefinition(batchId)
    await this.requireWorkflow(definition.workflowId)
    await this.requireProject(definition.projectId)
    const history = await this.store.listExecutions(batchId)
    if (history.some((execution) => !isTerminalExecution(execution))) {
      throw new BatchServiceError('batch_active', 'Batch has an active execution.')
    }
    const scan = await this.scan(definition)
    if (scan.files.length === 0) {
      throw new BatchServiceError(
        'batch_has_no_matching_files',
        'Batch folder has no matching files.',
        { preflight: toPreflight(scan, selectBatchFiles(definition.rerunPolicy, scan.files, history)) },
      )
    }
    return this.enqueueMutation(async () => {
      const current = await this.requireDefinition(batchId)
      if (current.revision !== definition.revision) {
        throw new BatchServiceError('batch_definition_changed', 'Batch definition changed during preflight.')
      }
      this.requireReadyTaskQueue()
      await this.requireWorkflow(current.workflowId)
      await this.requireProject(current.projectId)
      const currentFolder = await this.requireFolder(current.folderPath)
      if (currentFolder !== scan.canonicalFolderPath) {
        throw new BatchServiceError('folder_access_denied', 'Batch folder changed during preflight.')
      }
      const executions = await this.store.listExecutions(batchId)
      if (executions.some((execution) => !isTerminalExecution(execution))) {
        throw new BatchServiceError('batch_active', 'Batch has an active execution.')
      }
      const selection = selectBatchFiles(current.rerunPolicy, scan.files, executions)
      const now = this.now().toISOString()
      const items: BatchItem[] = selection.map((decision) => ({
        id: `item_${this.randomUUID()}`,
        ordinal: decision.file.ordinal,
        fileName: decision.file.fileName,
        sourceSize: decision.file.sourceSize,
        sourceMtime: decision.file.sourceMtime,
        sourceSha256: decision.file.sourceSha256,
        status: decision.selected ? 'pending' : 'skipped',
        ...(decision.skipReason ? { skipReason: decision.skipReason } : {}),
        resultArtifacts: [],
        createdAt: now,
        updatedAt: now,
        ...(!decision.selected ? { completedAt: now } : {}),
      }))
      const hasSelected = selection.some((decision) => decision.selected)
      const execution: BatchExecution = {
        id: `exec_${this.randomUUID()}`,
        batchId,
        definitionSnapshot: structuredClone(current),
        sourceFolderCanonicalPath: scan.canonicalFolderPath,
        sourceSnapshotSha256: scan.sourceSnapshotSha256,
        status: hasSelected ? 'running' : 'completed',
        items,
        retainedResultBytes: 0,
        startedAt: now,
        updatedAt: now,
        ...(!hasSelected ? { completedAt: now } : {}),
      }
      await this.store.writeExecution(execution)
      this.coordinator?.wake()
      return execution
    })
  }

  async cancelExecution(batchId: string, executionId: string): Promise<BatchExecution> {
    this.assertReady()
    const marked = await this.enqueueMutation(() => this.store.mutateExecution(
      batchId,
      executionId,
      (execution) => {
        if (isTerminalExecution(execution)) return { execution, result: execution }
        const timestamp = this.now().toISOString()
        const next: BatchExecution = {
          ...execution,
          status: 'draining',
          cancelRequestedAt: execution.cancelRequestedAt ?? timestamp,
          updatedAt: timestamp,
        }
        return { execution: next, result: next }
      },
    ).catch((error) => {
      if (error instanceof Error && error.message.includes('not found')) {
        throw new BatchServiceError('execution_not_found', `Batch execution not found: ${executionId}`)
      }
      throw error
    }))
    if (isTerminalExecution(marked)) return marked
    const preparationStopped = this.coordinator?.cancelExecution(batchId, executionId) ?? Promise.resolve()
    this.startCancellationDrain(batchId, executionId, preparationStopped)
    return marked
  }

  async clearExecutionResults(batchId: string, executionId: string): Promise<void> {
    this.assertReady()
    const key = `${batchId}:${executionId}`
    const existingOperation = this.resultClearOperations.get(key)
    if (existingOperation) return existingOperation
    if (this.batchDeletionOperations.has(batchId)) {
      throw new BatchServiceError('batch_cleanup_active', 'Batch deletion is active.')
    }
    const operation = this.validateAndPerformResultClear(batchId, executionId)
      .finally(() => this.resultClearOperations.delete(key))
    this.resultClearOperations.set(key, operation)
    return operation
  }

  private async validateAndPerformResultClear(batchId: string, executionId: string): Promise<void> {
    const current = await this.store.readExecution(batchId, executionId)
    if (!current) {
      throw new BatchServiceError('execution_not_found', `Batch execution not found: ${executionId}`)
    }
    if (!isTerminalExecution(current)) {
      throw new BatchServiceError('batch_execution_active', 'Batch execution is still active.')
    }
    if (current.resultsClearedAt && current.retainedResultBytes === 0) return
    await this.performResultClear(batchId, executionId)
  }

  isResultCleanupActive(batchId: string, executionId: string): boolean {
    return this.resultClearOperations.has(`${batchId}:${executionId}`)
  }

  private async performResultClear(batchId: string, executionId: string): Promise<void> {
    const requestedAt = this.now().toISOString()
    await this.store.writeResultClearIntent({
      schemaVersion: 1,
      batchId,
      executionId,
      requestedAt,
    })
    await fs.rm(path.join(this.resultsPath, batchId, executionId), { recursive: true, force: true })
    await this.store.mutateExecution(batchId, executionId, (execution) => ({
      execution: {
        ...execution,
        retainedResultBytes: 0,
        resultsClearedAt: execution.resultsClearedAt ?? requestedAt,
        updatedAt: requestedAt,
      },
      result: undefined,
    }))
    await this.store.removeResultClearIntent(batchId, executionId)
  }

  private startCancellationDrain(
    batchId: string,
    executionId: string,
    preparationStopped: Promise<void>,
  ): void {
    const key = `${batchId}:${executionId}`
    if (this.cancellationDrains.has(key)) return
    const drain = this.retryCancellationDrain(batchId, executionId, preparationStopped)
      .catch(() => undefined)
      .finally(() => {
        this.cancellationDrains.delete(key)
      })
    this.cancellationDrains.set(key, drain)
  }

  private async retryCancellationDrain(
    batchId: string,
    executionId: string,
    initialPreparationStopped: Promise<void>,
  ): Promise<void> {
    let preparationStopped = initialPreparationStopped
    let attempt = 0
    while (true) {
      try {
        await this.drainCancellation(batchId, executionId, preparationStopped)
        return
      } catch (error) {
        if (error instanceof CancellationStillConvergingError) {
          await waitForCancellationRetry(this.cancellationRetryDelayMs)
          preparationStopped = this.coordinator?.cancelExecution(batchId, executionId) ?? Promise.resolve()
          continue
        }
        attempt += 1
        const failureDetail = error instanceof Error ? error.message : String(error)
        await this.store.mutateExecution(batchId, executionId, (execution) => ({
          execution: {
            ...execution,
            failureDetail,
            updatedAt: this.now().toISOString(),
          },
          result: undefined,
        })).catch(() => undefined)
        if (attempt >= this.cancellationMaxAttempts) {
          await this.forceFailCancellation(batchId, executionId, attempt, failureDetail)
          return
        }
        await waitForCancellationRetry(
          Math.min(this.cancellationRetryDelayMs * 2 ** Math.min(attempt - 1, 4), 1_000),
        )
        preparationStopped = this.coordinator?.cancelExecution(batchId, executionId) ?? Promise.resolve()
      }
    }
  }

  private async forceFailCancellation(
    batchId: string,
    executionId: string,
    attempts: number,
    lastFailure: string,
  ): Promise<void> {
    const completedAt = this.now().toISOString()
    const failureDetail = (
      `Batch cancellation failed after ${attempts} attempts: ${lastFailure || 'unknown error'}`
    ).slice(0, 4_000)
    await this.store.mutateExecution(batchId, executionId, (execution) => ({
      execution: {
        ...execution,
        status: 'failed',
        items: execution.items.map((item) => isTerminalItem(item)
          ? item
          : {
              ...item,
              status: 'failed' as const,
              failureCode: 'cancellation_failed' as const,
              failureDetail,
              completedAt: item.completedAt ?? completedAt,
              updatedAt: completedAt,
            }),
        failureDetail,
        completedAt: execution.completedAt ?? completedAt,
        updatedAt: completedAt,
      },
      result: undefined,
    }))
    this.coordinator?.wake()
  }

  private async drainCancellation(
    batchId: string,
    executionId: string,
    preparationStopped: Promise<void>,
  ): Promise<void> {
    await preparationStopped
    const timestamp = this.now().toISOString()
    const admitted = await this.store.mutateExecution(batchId, executionId, (execution) => {
      const items = execution.items.map((item) =>
        item.status === 'pending' || item.status === 'preparing'
          ? {
              ...item,
              status: 'cancelled' as const,
              failureCode: 'task_cancelled' as const,
              failureDetail: 'Batch execution was cancelled before task admission.',
              completedAt: item.completedAt ?? timestamp,
              updatedAt: timestamp,
            }
          : item,
      )
      return {
        execution: { ...execution, items, updatedAt: timestamp },
        result: items.filter((item) =>
          (item.status === 'queued' || item.status === 'running' || item.status === 'recovering') &&
          item.sessionId && item.taskId,
        ),
      }
    })
    const results = new Map<string, SessionTask | null>()
    const cancellationFailures = new Map<string, string>()
    const cancelTask = this.cancelTask
    if (cancelTask) {
      await Promise.all(admitted.map(async (item) => {
        try {
          if (!item.sessionId || !item.taskId) {
            throw new Error(`Batch item ${item.id} was admitted for cancellation without a session and task`)
          }
          results.set(item.id, await cancelTask(item.sessionId, item.taskId))
        } catch (error) {
          cancellationFailures.set(
            item.id,
            error instanceof Error ? error.message : String(error),
          )
        }
      }))
    }
    const cancellationFailureDetail = [...cancellationFailures.values()].join('; ')
    const terminal = await this.store.mutateExecution(batchId, executionId, (execution) => {
      const completedAt = this.now().toISOString()
      const items = execution.items.map((item): BatchItem => {
        const task = results.get(item.id)
        const cancellationFailure = cancellationFailures.get(item.id)
        if (!task) {
          return cancellationFailure
            ? { ...item, failureDetail: cancellationFailure, updatedAt: completedAt }
            : item
        }
        if (task.status === 'cancelled') {
          return {
            ...item,
            status: 'cancelled',
            failureCode: 'task_cancelled',
            ...whenDefined(task.error, (failureDetail) => ({ failureDetail })),
            completedAt: item.completedAt ?? completedAt,
            updatedAt: completedAt,
          }
        }
        return item
      })
      const terminal = items.every(isTerminalItem)
      const next: BatchExecution = {
        ...execution,
        items,
        status: terminal ? 'cancelled' : 'draining',
        ...(cancellationFailureDetail ? { failureDetail: cancellationFailureDetail } : {}),
        ...(terminal ? { completedAt: execution.completedAt ?? completedAt } : {}),
        updatedAt: completedAt,
      }
      return { execution: next, result: terminal }
    })
    this.coordinator?.wake()
    if (!terminal) {
      if (cancellationFailureDetail) throw new Error(cancellationFailureDetail)
      throw new CancellationStillConvergingError()
    }
  }

  private async resumeCancellationDrains(): Promise<void> {
    const definitions = await this.store.readDefinitions()
    for (const definition of definitions) {
      const executions = await this.store.listExecutions(definition.id)
      for (const execution of executions) {
        if (execution.status !== 'draining' || !execution.cancelRequestedAt) continue
        const preparationStopped = this.coordinator?.cancelExecution(definition.id, execution.id) ?? Promise.resolve()
        this.startCancellationDrain(definition.id, execution.id, preparationStopped)
      }
    }
  }

  private async requireDefinition(batchId: string): Promise<BatchDefinition> {
    const definition = (await this.store.readDefinitions()).find((entry) => entry.id === batchId)
    if (!definition) throw new BatchServiceError('batch_not_found', `Batch not found: ${batchId}`)
    return definition
  }

  private async requireFolder(folderPath: string): Promise<string> {
    const canonical = await this.folderAccessPolicy.resolveAllowedFolder(folderPath)
    if (!canonical) throw new BatchServiceError('folder_access_denied', 'Batch folder is not allowed.')
    return canonical
  }

  private async requireWorkflow(workflowId: string): Promise<void> {
    if (!await this.validateWorkflow(workflowId)) {
      throw new BatchServiceError('invalid_batch_request', `Workflow is not Batch-eligible: ${workflowId}`)
    }
  }

  private async requireProject(projectId: string | undefined): Promise<void> {
    if (projectId && this.validateProject && !await this.validateProject(projectId)) {
      throw new BatchServiceError('invalid_batch_request', `Project is not active: ${projectId}`)
    }
  }

  private async scan(definition: BatchDefinition): Promise<BatchFolderScanResult> {
    const canonical = await this.requireFolder(definition.folderPath)
    try {
      return await scanBatchFolder({
        folderPath: canonical,
        fileExtensions: definition.fileExtensions,
      })
    } catch (error) {
      if (error instanceof BatchFolderScanError) {
        throw new BatchServiceError(
          error.code === 'batch_too_large' ? 'batch_too_large' : 'folder_access_denied',
          error.message,
          error.detail ? { limits: error.detail } : undefined,
        )
      }
      throw error
    }
  }

  private async toView(definition: BatchDefinition): Promise<BatchView> {
    const executions = await this.store.listExecutions(definition.id)
    const latestExecution = executions[0]
    const activeExecution = executions.find((execution) => !isTerminalExecution(execution))
    return {
      ...definition,
      ...(activeExecution ? { activeExecution: summarizeExecution(activeExecution) } : {}),
      ...(latestExecution ? { latestExecution: summarizeExecution(latestExecution) } : {}),
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.operationTail.then(operation)
    this.operationTail = running.then(() => undefined, () => undefined)
    return running
  }

  private assertReady(): void {
    if (!this.initialized) throw this.unavailable()
  }

  private requireReadyTaskQueue(): void {
    if (this.isTaskQueueReady && !this.isTaskQueueReady()) {
      throw new BatchServiceError('task_queue_recovering', 'Task queue is recovering.')
    }
  }

  private invalid(error: unknown): BatchServiceError {
    return new BatchServiceError(
      'invalid_batch_request',
      error instanceof Error ? error.message : String(error),
    )
  }

  private unavailable(error?: unknown): BatchServiceError {
    const message = error instanceof BatchStoreUnavailableError
      ? error.message
      : 'Batch service is unavailable.'
    return new BatchServiceError('batch_service_unavailable', message)
  }
}

function isTerminalExecution(execution: BatchExecution): boolean {
  return execution.status === 'completed' || execution.status === 'cancelled' || execution.status === 'failed'
}

function isTerminalItem(item: BatchItem): boolean {
  return item.status === 'skipped' || item.status === 'done' || item.status === 'failed' ||
    item.status === 'blocked' || item.status === 'cancelled' ||
    item.status === 'setup_failed' || item.status === 'artifact_failed'
}

class CancellationStillConvergingError extends Error {
  constructor() {
    super('Batch cancellation is waiting for admitted work to become terminal.')
    this.name = 'CancellationStillConvergingError'
  }
}

function waitForCancellationRetry(delayMs: number): Promise<void> {
  if (delayMs === 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs)
    timer.unref()
  })
}

function summarizeExecution(execution: BatchExecution): BatchExecutionSummary {
  const counts = {
    skipped: 0, pending: 0, preparing: 0, queued: 0, running: 0, recovering: 0,
    publishing: 0, done: 0, failed: 0, blocked: 0, cancelled: 0,
    setup_failed: 0, artifact_failed: 0,
  }
  for (const item of execution.items) counts[item.status] += 1
  const unsuccessfulCount = counts.failed + counts.blocked + counts.cancelled +
    counts.setup_failed + counts.artifact_failed
  const status = execution.status === 'completed' && unsuccessfulCount > 0
    ? counts.done > 0 ? 'partially_completed' : 'failed'
    : execution.status
  return {
    id: execution.id,
    batchId: execution.batchId,
    status,
    counts,
    retainedResultBytes: execution.retainedResultBytes,
    ...(execution.resultsClearedAt ? { resultsClearedAt: execution.resultsClearedAt } : {}),
    startedAt: execution.startedAt,
    updatedAt: execution.updatedAt,
    ...(execution.completedAt ? { completedAt: execution.completedAt } : {}),
  }
}

function toPreflight(
  scan: BatchFolderScanResult,
  selection: ReturnType<typeof selectBatchFiles>,
): BatchPreflight {
  const extensionCounts: Record<string, number> = {}
  for (const file of scan.files) {
    const extension = path.extname(file.fileName).toLowerCase() || '<none>'
    extensionCounts[extension] = (extensionCounts[extension] ?? 0) + 1
  }
  const selectedCount = selection.filter((decision) => decision.selected).length
  return {
    canonicalFolderPath: scan.canonicalFolderPath,
    fileCount: scan.files.length,
    selectedCount,
    totalBytes: scan.totalBytes,
    extensionCounts,
    requiresConfirmation: selectedCount > 10 || scan.totalBytes > 100 * 1024 * 1024,
    sourceSnapshotSha256: scan.sourceSnapshotSha256,
    files: selection.map((decision) => ({
      fileName: decision.file.fileName,
      size: decision.file.sourceSize,
      sha256: decision.file.sourceSha256,
      selected: decision.selected,
      ...(decision.skipReason ? { skipReason: decision.skipReason } : {}),
    })),
  }
}

function toItemView(item: BatchItem): BatchItemView {
  return {
    id: item.id,
    ordinal: item.ordinal,
    fileName: item.fileName,
    sourceSize: item.sourceSize,
    sourceMtime: item.sourceMtime,
    sourceSha256: item.sourceSha256,
    status: item.status,
    ...(item.sessionId ? { sessionId: item.sessionId } : {}),
    ...(item.taskId ? { taskId: item.taskId } : {}),
    ...(item.failureCode ? { failureCode: item.failureCode } : {}),
    ...(item.failureDetail ? { failureDetail: item.failureDetail } : {}),
    resultArtifacts: item.resultArtifacts.map((artifact) => ({
      role: artifact.role,
      sourceRunId: artifact.sourceRunId,
      sourcePath: artifact.sourcePath,
      ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {}),
      byteLength: artifact.byteLength,
      sha256: artifact.sha256,
    })),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.completedAt ? { completedAt: item.completedAt } : {}),
  }
}

function paginationLimit(value: number | undefined): number {
  if (value === undefined) return 50
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new BatchServiceError('invalid_batch_request', 'Pagination limit must be between 1 and 100.')
  }
  return value
}

function encodeExecutionCursor(execution: BatchExecution): string {
  return Buffer.from(JSON.stringify([execution.startedAt, execution.id]), 'utf8').toString('base64url')
}

function executionCursorStart(executions: readonly BatchExecution[], cursor: string): number {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (!Array.isArray(decoded) || decoded.length !== 2 || decoded.some((value) => typeof value !== 'string')) {
      throw new Error('invalid')
    }
    const index = executions.findIndex(
      (execution) => execution.startedAt === decoded[0] && execution.id === decoded[1],
    )
    if (index < 0) throw new Error('invalid')
    return index + 1
  } catch {
    throw new BatchServiceError('invalid_batch_request', 'Execution cursor is invalid.')
  }
}

function encodeItemCursor(ordinal: number): string {
  return Buffer.from(String(ordinal), 'utf8').toString('base64url')
}

function decodeItemCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
  if (!/^(0|[1-9][0-9]*)$/.test(decoded)) {
    throw new BatchServiceError('invalid_batch_request', 'Item cursor is invalid.')
  }
  const ordinal = Number(decoded)
  if (!Number.isSafeInteger(ordinal)) {
    throw new BatchServiceError('invalid_batch_request', 'Item cursor is invalid.')
  }
  return ordinal
}

export async function hasProjectBatchReferenceInFile(
  definitionsPath: string,
  projectId: string,
): Promise<boolean> {
  const raw = await fs.readFile(definitionsPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (raw === null) return false
  try {
    return parseBatchDefinitionsFile(JSON.parse(raw)).definitions.some(
      (definition) => definition.projectId === projectId,
    )
  } catch (error) {
    throw new Error(
      `Batch definitions cannot be checked for project references: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}
