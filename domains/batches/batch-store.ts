import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { writeFileAtomic } from '../../core/file-mutation.js'
import type { BatchJournalRecorder } from './batch-journal.js'
import {
  BATCH_SCHEMA_VERSION,
  isBatchExecutionId,
  isBatchId,
  parseBatchDefinitionsFile,
  parseBatchDeletionFile,
  parseBatchExecutionFile,
  parseBatchResultClearFile,
  type BatchDefinition,
  type BatchDeletionFileV1,
  type BatchExecution,
  type BatchExecutionFileV2,
  type BatchResultClearFileV1,
} from './batch-types.js'

export class BatchStoreUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BatchStoreUnavailableError'
  }
}

export class BatchStore {
  private readonly rootPath: string
  private readonly resultsPath: string
  private operationTail: Promise<void> = Promise.resolve()
  private initialized = false
  private unavailableError: Error | undefined
  private readonly journal: BatchJournalRecorder | undefined

  constructor(options: { workspacePath: string; journal?: BatchJournalRecorder }) {
    const workspacePath = path.resolve(options.workspacePath)
    this.rootPath = path.join(workspacePath, 'task-queue', 'batches')
    this.resultsPath = path.join(workspacePath, 'batch-results')
    this.journal = options.journal
  }

  async initialize(): Promise<void> {
    try {
      await this.ensureDirectories()
      await this.validateAllState()
      await this.migrateLegacyState()
      await this.completePendingIntents()
      await this.validateAllState()
      this.initialized = true
      this.unavailableError = undefined
    } catch (error) {
      this.initialized = false
      this.unavailableError = error instanceof Error ? error : new Error(String(error))
      throw new BatchStoreUnavailableError(
        `Batch store failed to initialize: ${this.unavailableError.message}`,
        { cause: this.unavailableError },
      )
    }
  }

  async readDefinitions(): Promise<readonly BatchDefinition[]> {
    this.assertAvailable()
    return this.readDurableState(() => this.readDefinitionsUnchecked())
  }

  async writeDefinitions(definitions: readonly BatchDefinition[]): Promise<void> {
    return this.enqueue(async () => {
      const parsed = parseBatchDefinitionsFile({
        schemaVersion: BATCH_SCHEMA_VERSION,
        definitions,
      })
      await this.writeJson(this.definitionsPath, parsed)
    })
  }

  async mutateDefinitions<T>(
    mutation: (definitions: readonly BatchDefinition[]) => Promise<{
      readonly definitions: readonly BatchDefinition[]
      readonly result: T
    }> | {
      readonly definitions: readonly BatchDefinition[]
      readonly result: T
    },
  ): Promise<T> {
    return this.enqueue(async () => {
      const current = await this.readDurableState(() => this.readDefinitionsUnchecked())
      const next = await mutation(current)
      const parsed = parseBatchDefinitionsFile({
        schemaVersion: BATCH_SCHEMA_VERSION,
        definitions: next.definitions,
      })
      await this.writeJson(this.definitionsPath, parsed)
      return next.result
    })
  }

  async readExecution(batchId: string, executionId: string): Promise<BatchExecution | null> {
    this.assertAvailable()
    this.assertIds(batchId, executionId)
    const envelope = await this.readDurableState(() => this.readExecutionFile(batchId, executionId))
    return envelope?.execution ?? null
  }

  async writeExecution(execution: BatchExecution): Promise<void> {
    return this.enqueue(async () => {
      this.assertIds(execution.batchId, execution.id)
      if (this.journal) await this.journal.recordExecution(execution)
      const existing = await this.readDurableState(
        () => this.readExecutionFile(execution.batchId, execution.id),
      )
      const envelope = parseBatchExecutionFile({
        schemaVersion: BATCH_SCHEMA_VERSION,
        revision: (existing?.revision ?? 0) + 1,
        execution,
      })
      await this.writeJson(this.executionPath(execution.batchId, execution.id), envelope)
    })
  }

  async mutateExecution<T>(
    batchId: string,
    executionId: string,
    mutation: (execution: BatchExecution) => Promise<{
      readonly execution: BatchExecution
      readonly result: T
    }> | {
      readonly execution: BatchExecution
      readonly result: T
    },
  ): Promise<T> {
    return this.enqueue(async () => {
      this.assertIds(batchId, executionId)
      const current = await this.readDurableState(() => this.readExecutionFile(batchId, executionId))
      if (!current) throw new Error(`Batch execution not found: ${executionId}`)
      const next = await mutation(current.execution)
      if (this.journal) await this.journal.recordExecution(next.execution)
      const envelope = parseBatchExecutionFile({
        schemaVersion: BATCH_SCHEMA_VERSION,
        revision: current.revision + 1,
        execution: next.execution,
      })
      await this.writeJson(this.executionPath(batchId, executionId), envelope)
      return next.result
    })
  }

  /**
   * Publish a batch execution file as a derived projection (Phase 8 ADR §8).
   * Used by journal replay; it never appends to the journal itself.
   */
  async writeExecutionProjection(execution: BatchExecution): Promise<void> {
    return this.enqueue(async () => {
      this.assertIds(execution.batchId, execution.id)
      const existing = await this.readDurableState(
        () => this.readExecutionFile(execution.batchId, execution.id),
      )
      const envelope = parseBatchExecutionFile({
        schemaVersion: BATCH_SCHEMA_VERSION,
        revision: (existing?.revision ?? 0) + 1,
        execution,
      })
      await this.writeJson(this.executionPath(execution.batchId, execution.id), envelope)
    })
  }

  async listExecutions(batchId: string): Promise<readonly BatchExecution[]> {
    this.assertAvailable()
    if (!isBatchId(batchId)) throw new Error('Invalid Batch id.')
    return this.readDurableState(async () => {
      const directory = this.batchExecutionsPath(batchId)
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      const executions: BatchExecution[] = []
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue
        if (!entry.name.endsWith('.json')) throw new Error(`Unexpected Batch execution file: ${entry.name}`)
        const executionId = entry.name.slice(0, -'.json'.length)
        if (!isBatchExecutionId(executionId)) throw new Error(`Invalid Batch execution filename: ${entry.name}`)
        const envelope = await this.readExecutionFile(batchId, executionId)
        if (!envelope || envelope.execution.batchId !== batchId || envelope.execution.id !== executionId) {
          throw new Error(`Batch execution identity mismatch: ${entry.name}`)
        }
        executions.push(envelope.execution)
      }
      return executions.sort((left, right) =>
        right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id),
      )
    })
  }

  async writeDeletionIntent(intent: BatchDeletionFileV1): Promise<void> {
    return this.enqueue(async () => {
      const parsed = parseBatchDeletionFile(intent)
      await this.writeJson(this.deletionPath(parsed.batchId), parsed)
    })
  }

  async removeDeletionIntent(batchId: string): Promise<void> {
    return this.enqueue(async () => {
      if (!isBatchId(batchId)) throw new Error('Invalid Batch id.')
      await fs.rm(this.deletionPath(batchId), { force: true })
    })
  }

  async writeResultClearIntent(intent: BatchResultClearFileV1): Promise<void> {
    return this.enqueue(async () => {
      const parsed = parseBatchResultClearFile(intent)
      await this.writeJson(this.resultClearPath(parsed.batchId, parsed.executionId), parsed)
    })
  }

  async removeResultClearIntent(batchId: string, executionId: string): Promise<void> {
    return this.enqueue(async () => {
      this.assertIds(batchId, executionId)
      await fs.rm(this.resultClearPath(batchId, executionId), { force: true })
    })
  }

  async deleteBatchState(batchId: string): Promise<void> {
    return this.enqueue(async () => {
      if (!isBatchId(batchId)) throw new Error('Invalid Batch id.')
      await fs.rm(this.batchExecutionsPath(batchId), { recursive: true, force: true })
    })
  }

  get storageRoot(): string {
    return this.rootPath
  }

  private async validateAllState(): Promise<void> {
    await this.readDefinitionsUnchecked()
    await this.validateExecutionDirectories()
    await this.validateIntentDirectory(this.deletionsPath, (value) => parseBatchDeletionFile(value))
    const batchDirs = await fs.readdir(this.resultClearsPath, { withFileTypes: true })
    for (const batchDir of batchDirs) {
      if (!batchDir.isDirectory() || batchDir.isSymbolicLink() || !isBatchId(batchDir.name)) {
        throw new Error(`Invalid Batch result-clear directory: ${batchDir.name}`)
      }
      await this.validateIntentDirectory(
        path.join(this.resultClearsPath, batchDir.name),
        (value) => parseBatchResultClearFile(value),
      )
    }
  }

  private async completePendingIntents(): Promise<void> {
    const deletionEntries = await fs.readdir(this.deletionsPath, { withFileTypes: true })
    for (const entry of deletionEntries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith('.')) continue
      const intent = await this.readJson(path.join(this.deletionsPath, entry.name), parseBatchDeletionFile)
      await fs.rm(path.join(this.resultsPath, intent.batchId), { recursive: true, force: true })
      await fs.rm(this.batchExecutionsPath(intent.batchId), { recursive: true, force: true })
      const definitions = await this.readDefinitionsUnchecked()
      await this.writeJson(this.definitionsPath, parseBatchDefinitionsFile({
        schemaVersion: BATCH_SCHEMA_VERSION,
        definitions: definitions.filter((definition) => definition.id !== intent.batchId),
      }))
      await fs.rm(path.join(this.deletionsPath, entry.name), { force: true })
    }

    const batchEntries = await fs.readdir(this.resultClearsPath, { withFileTypes: true })
    for (const batchEntry of batchEntries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (batchEntry.name.startsWith('.')) continue
      const directory = path.join(this.resultClearsPath, batchEntry.name)
      const entries = await fs.readdir(directory, { withFileTypes: true })
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.name.startsWith('.')) continue
        const intentPath = path.join(directory, entry.name)
        const intent = await this.readJson(intentPath, parseBatchResultClearFile)
        await fs.rm(path.join(this.resultsPath, intent.batchId, intent.executionId), {
          recursive: true,
          force: true,
        })
        const envelope = await this.readExecutionFile(intent.batchId, intent.executionId)
        if (envelope) {
          await this.writeJson(this.executionPath(intent.batchId, intent.executionId), {
            schemaVersion: BATCH_SCHEMA_VERSION,
            revision: envelope.revision + 1,
            execution: {
              ...envelope.execution,
              retainedResultBytes: 0,
              resultsClearedAt: envelope.execution.resultsClearedAt ?? intent.requestedAt,
              updatedAt: intent.requestedAt,
            },
          })
        }
        await fs.rm(intentPath, { force: true })
      }
      await fs.rmdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error
      })
    }
  }

  private async migrateLegacyState(): Promise<void> {
    const definitionsRaw = await fs.readFile(this.definitionsPath, 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      },
    )
    if (definitionsRaw !== null) {
      const source = JSON.parse(definitionsRaw) as { schemaVersion?: unknown }
      if (source.schemaVersion === 1) {
        await this.writeJson(this.definitionsPath, parseBatchDefinitionsFile(source))
      }
    }

    const batchDirs = await fs.readdir(this.executionsPath, { withFileTypes: true })
    for (const batchDir of batchDirs) {
      if (!batchDir.isDirectory() || batchDir.isSymbolicLink()) continue
      const directory = path.join(this.executionsPath, batchDir.name)
      const entries = await fs.readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) continue
        const filePath = path.join(directory, entry.name)
        const source = JSON.parse(await fs.readFile(filePath, 'utf8')) as { schemaVersion?: unknown }
        if (source.schemaVersion === 1) {
          await this.writeJson(filePath, parseBatchExecutionFile(source))
        }
      }
    }
  }

  private async validateExecutionDirectories(): Promise<void> {
    const batchDirs = await fs.readdir(this.executionsPath, { withFileTypes: true })
    for (const batchDir of batchDirs) {
      if (!batchDir.isDirectory() || batchDir.isSymbolicLink() || !isBatchId(batchDir.name)) {
        throw new Error(`Invalid Batch execution directory: ${batchDir.name}`)
      }
      const entries = await fs.readdir(path.join(this.executionsPath, batchDir.name), { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) {
          throw new Error(`Invalid Batch execution entry: ${entry.name}`)
        }
        const id = entry.name.slice(0, -5)
        if (!isBatchExecutionId(id)) throw new Error(`Invalid Batch execution filename: ${entry.name}`)
        const parsed = await this.readJson(path.join(this.executionsPath, batchDir.name, entry.name), parseBatchExecutionFile)
        if (parsed.execution.batchId !== batchDir.name || parsed.execution.id !== id) {
          throw new Error(`Batch execution identity mismatch: ${entry.name}`)
        }
      }
    }
  }

  private async validateIntentDirectory<T>(
    directory: string,
    parser: (value: unknown) => T,
  ): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) {
        throw new Error(`Invalid Batch intent entry: ${entry.name}`)
      }
      await this.readJson(path.join(directory, entry.name), parser)
    }
  }

  private async readDefinitionsUnchecked(): Promise<readonly BatchDefinition[]> {
    const raw = await fs.readFile(this.definitionsPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (raw === null) return []
    return parseBatchDefinitionsFile(JSON.parse(raw)).definitions
  }

  private async readExecutionFile(batchId: string, executionId: string): Promise<BatchExecutionFileV2 | null> {
    const filePath = this.executionPath(batchId, executionId)
    const raw = await fs.readFile(filePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    return raw === null ? null : parseBatchExecutionFile(JSON.parse(raw))
  }

  private async readJson<T>(filePath: string, parser: (value: unknown) => T): Promise<T> {
    return parser(JSON.parse(await fs.readFile(filePath, 'utf8')))
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
    await fs.chmod(path.dirname(filePath), 0o700)
    await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`)
    await fs.chmod(filePath, 0o600)
  }

  private async ensureDirectories(): Promise<void> {
    for (const directory of [this.rootPath, this.executionsPath, this.deletionsPath, this.resultClearsPath]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      await fs.chmod(directory, 0o700)
    }
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.assertAvailable()
    const running = this.operationTail.then(operation)
    this.operationTail = running.then(() => undefined, () => undefined)
    return running
  }

  private async readDurableState<T>(operation: () => Promise<T>): Promise<T> {
    this.assertAvailable()
    try {
      return await operation()
    } catch (error) {
      if (error instanceof BatchStoreUnavailableError) throw error
      this.initialized = false
      this.unavailableError = error instanceof Error ? error : new Error(String(error))
      throw new BatchStoreUnavailableError(
        `Batch store became unavailable: ${this.unavailableError.message}`,
        { cause: this.unavailableError },
      )
    }
  }

  private assertAvailable(): void {
    if (!this.initialized || this.unavailableError) {
      throw new BatchStoreUnavailableError('Batch store is unavailable.', { cause: this.unavailableError })
    }
  }

  private assertIds(batchId: string, executionId: string): void {
    if (!isBatchId(batchId) || !isBatchExecutionId(executionId)) {
      throw new Error('Invalid Batch or execution id.')
    }
  }

  private get definitionsPath(): string {
    return path.join(this.rootPath, 'definitions.json')
  }
  private get executionsPath(): string {
    return path.join(this.rootPath, 'executions')
  }
  private get deletionsPath(): string {
    return path.join(this.rootPath, 'deletions')
  }
  private get resultClearsPath(): string {
    return path.join(this.rootPath, 'result-clears')
  }
  private batchExecutionsPath(batchId: string): string {
    return path.join(this.executionsPath, batchId)
  }
  private executionPath(batchId: string, executionId: string): string {
    return path.join(this.batchExecutionsPath(batchId), `${executionId}.json`)
  }
  private deletionPath(batchId: string): string {
    return path.join(this.deletionsPath, `${batchId}.json`)
  }
  private resultClearPath(batchId: string, executionId: string): string {
    return path.join(this.resultClearsPath, batchId, `${executionId}.json`)
  }
}
