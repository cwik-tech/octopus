import * as path from 'node:path'

import { isValidWorkspaceProjectId } from '../../contracts/projects.js'

export const BATCH_SCHEMA_VERSION = 2 as const
export const BATCH_ID_PATTERN = /^batch_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const BATCH_EXECUTION_ID_PATTERN = /^exec_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const BATCH_ITEM_ID_PATTERN = /^item_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const SHA256_PATTERN = /^[0-9a-f]{64}$/

export type BatchRerunPolicy = 'new_only' | 'new_and_changed' | 'always'
export type BatchExecutionStatus =
  | 'pending'
  | 'running'
  | 'draining'
  | 'completed'
  | 'cancelled'
  | 'failed'
export type BatchItemStatus =
  | 'skipped'
  | 'pending'
  | 'preparing'
  | 'queued'
  | 'running'
  | 'recovering'
  | 'publishing'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'setup_failed'
  | 'artifact_failed'
export type BatchItemFailureCode =
  | 'folder_access_revoked'
  | 'source_changed'
  | 'source_unavailable'
  | 'file_too_large'
  | 'parse_failed'
  | 'parsed_text_missing'
  | 'project_unavailable'
  | 'workflow_ineligible'
  | 'workflow_requires_input'
  | 'admission_failed'
  | 'task_failed'
  | 'task_blocked'
  | 'task_cancelled'
  | 'cancellation_failed'
  | 'verified_publication_missing'
  | 'verified_publication_invalid'
  | 'artifact_too_large'
  | 'artifact_copy_failed'
  | 'recovery_state_ambiguous'
export type BatchPreparationPhase =
  | 'intent_persisted'
  | 'session_persisted'
  | 'file_staged'
  | 'plan_persisted'

export interface BatchDefinition {
  readonly id: string
  readonly revision: number
  readonly name: string
  readonly workflowId: string
  readonly folderPath: string
  readonly fileExtensions: readonly string[]
  readonly rerunPolicy: BatchRerunPolicy
  readonly projectId?: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface BatchResultArtifact {
  readonly role: 'final' | 'secondary'
  readonly sourceRunId: string
  readonly sourcePath: string
  readonly destinationPath: string
  readonly mediaType?: string
  readonly byteLength: number
  readonly sha256: string
}

export interface BatchItem {
  readonly id: string
  readonly ordinal: number
  readonly fileName: string
  readonly sourceSize: number
  readonly sourceMtime: string
  readonly sourceSha256: string
  readonly status: BatchItemStatus
  readonly skipReason?: 'already_processed' | 'unchanged'
  readonly preparationPhase?: BatchPreparationPhase
  readonly sessionId?: string
  readonly runPlanId?: string
  readonly taskId?: string
  readonly taskExecutionAttemptId?: string
  readonly failureCode?: BatchItemFailureCode
  readonly failureDetail?: string
  readonly publicationStartedAt?: string
  readonly resultArtifacts: readonly BatchResultArtifact[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly completedAt?: string
}

export interface BatchExecution {
  readonly id: string
  readonly batchId: string
  readonly definitionSnapshot: BatchDefinition
  readonly sourceFolderCanonicalPath: string
  readonly sourceSnapshotSha256: string
  readonly status: BatchExecutionStatus
  readonly cancelRequestedAt?: string
  readonly items: readonly BatchItem[]
  readonly retainedResultBytes: number
  readonly resultsClearedAt?: string
  readonly startedAt: string
  readonly updatedAt: string
  readonly completedAt?: string
  readonly failureDetail?: string
}

export interface BatchDefinitionsFileV2 {
  readonly schemaVersion: 2
  readonly definitions: readonly BatchDefinition[]
}
export interface BatchExecutionFileV2 {
  readonly schemaVersion: 2
  readonly revision: number
  readonly execution: BatchExecution
}
export interface BatchDeletionFileV1 {
  readonly schemaVersion: 1
  readonly batchId: string
  readonly requestedAt: string
}
export interface BatchResultClearFileV1 extends BatchDeletionFileV1 {
  readonly executionId: string
}

export function isBatchId(value: unknown): value is string {
  return typeof value === 'string' && BATCH_ID_PATTERN.test(value)
}

export function isBatchExecutionId(value: unknown): value is string {
  return typeof value === 'string' && BATCH_EXECUTION_ID_PATTERN.test(value)
}

export function isBatchItemId(value: unknown): value is string {
  return typeof value === 'string' && BATCH_ITEM_ID_PATTERN.test(value)
}

export function parseBatchDefinitionsFile(value: unknown): BatchDefinitionsFileV2 {
  const source = record(value, 'Batch definitions must be a JSON object.')
  exactKeys(source, ['schemaVersion', 'definitions'], 'Batch definitions')
  const version = stateSchemaVersion(source.schemaVersion)
  if (!Array.isArray(source.definitions)) {
    throw new Error("Batch definitions field 'definitions' must be an array.")
  }
  const definitions = source.definitions.map((definition) =>
    parseBatchDefinition(definition, version === 1))
  if (new Set(definitions.map((definition) => definition.id)).size !== definitions.length) {
    throw new Error('Batch definitions contain duplicate IDs.')
  }
  return { schemaVersion: BATCH_SCHEMA_VERSION, definitions }
}

export function parseBatchExecutionFile(value: unknown): BatchExecutionFileV2 {
  const source = record(value, 'Batch execution must be a JSON object.')
  exactKeys(source, ['schemaVersion', 'revision', 'execution'], 'Batch execution file')
  const version = stateSchemaVersion(source.schemaVersion)
  const revision = positiveInteger(source.revision, 'Batch execution revision')
  return {
    schemaVersion: BATCH_SCHEMA_VERSION,
    revision,
    execution: parseBatchExecution(source.execution, version === 1),
  }
}

export function parseBatchDeletionFile(value: unknown): BatchDeletionFileV1 {
  const source = record(value, 'Batch deletion must be a JSON object.')
  exactKeys(source, ['schemaVersion', 'batchId', 'requestedAt'], 'Batch deletion')
  intentSchemaVersion(source.schemaVersion)
  return {
    schemaVersion: 1,
    batchId: batchId(source.batchId),
    requestedAt: timestamp(source.requestedAt, 'Batch deletion requestedAt'),
  }
}

export function parseBatchResultClearFile(value: unknown): BatchResultClearFileV1 {
  const source = record(value, 'Batch result clear must be a JSON object.')
  exactKeys(
    source,
    ['schemaVersion', 'batchId', 'executionId', 'requestedAt'],
    'Batch result clear',
  )
  intentSchemaVersion(source.schemaVersion)
  return {
    schemaVersion: 1,
    batchId: batchId(source.batchId),
    executionId: executionId(source.executionId),
    requestedAt: timestamp(source.requestedAt, 'Batch result clear requestedAt'),
  }
}

export function parseBatchDefinition(value: unknown, allowLegacyPrompt = false): BatchDefinition {
  const source = record(value, 'Batch definition must be a JSON object.')
  exactKeys(source, [
    'id',
    'revision',
    'name',
    'workflowId',
    'folderPath',
    'fileExtensions',
    ...(allowLegacyPrompt ? ['promptTemplate'] : []),
    'rerunPolicy',
    'projectId',
    'createdAt',
    'updatedAt',
  ], 'Batch definition')
  if (typeof source.folderPath !== 'string' || !path.isAbsolute(source.folderPath)) {
    throw new Error("Batch definition field 'folderPath' must be an absolute path.")
  }
  if (!Array.isArray(source.fileExtensions)) {
    throw new Error("Batch definition field 'fileExtensions' must be an array.")
  }
  const fileExtensions = source.fileExtensions.map((extension) => {
    if (
      typeof extension !== 'string' ||
      !/^\.[a-z0-9][a-z0-9._+-]{0,19}$/i.test(extension)
    ) {
      throw new Error('Batch definition contains an invalid extension.')
    }
    return extension.toLowerCase()
  })
  if (new Set(fileExtensions).size !== fileExtensions.length) {
    throw new Error('Batch definition contains duplicate extensions.')
  }
  if (allowLegacyPrompt) {
    boundedString(source.promptTemplate, 'Batch definition promptTemplate', 20_000)
  }
  if (
    source.rerunPolicy !== 'new_only' &&
    source.rerunPolicy !== 'new_and_changed' &&
    source.rerunPolicy !== 'always'
  ) {
    throw new Error("Batch definition field 'rerunPolicy' is invalid.")
  }
  if (
    source.projectId !== undefined &&
    (typeof source.projectId !== 'string' || !isValidWorkspaceProjectId(source.projectId))
  ) {
    throw new Error("Batch definition field 'projectId' must be a UUID.")
  }
  return {
    id: batchId(source.id),
    revision: positiveInteger(source.revision, 'Batch definition revision'),
    name: boundedString(source.name, 'Batch definition name', 120),
    workflowId: boundedString(source.workflowId, 'Batch definition workflowId', 300),
    folderPath: source.folderPath,
    fileExtensions,
    rerunPolicy: source.rerunPolicy,
    ...(source.projectId === undefined ? {} : { projectId: source.projectId }),
    createdAt: timestamp(source.createdAt, 'Batch definition createdAt'),
    updatedAt: timestamp(source.updatedAt, 'Batch definition updatedAt'),
  }
}

export function parseBatchExecution(value: unknown, allowLegacyPrompt = false): BatchExecution {
  const source = record(value, 'Batch execution value must be a JSON object.')
  exactKeys(source, [
    'id',
    'batchId',
    'definitionSnapshot',
    'sourceFolderCanonicalPath',
    'sourceSnapshotSha256',
    'status',
    'cancelRequestedAt',
    'items',
    'retainedResultBytes',
    'resultsClearedAt',
    'startedAt',
    'updatedAt',
    'completedAt',
    'failureDetail',
  ], 'Batch execution')
  const id = executionId(source.id)
  const ownerBatchId = batchId(source.batchId)
  const definitionSnapshot = parseBatchDefinition(source.definitionSnapshot, allowLegacyPrompt)
  if (definitionSnapshot.id !== ownerBatchId) {
    throw new Error('Batch execution definition identity does not match batchId.')
  }
  if (
    typeof source.sourceFolderCanonicalPath !== 'string' ||
    !path.isAbsolute(source.sourceFolderCanonicalPath)
  ) {
    throw new Error('Batch execution source folder must be an absolute path.')
  }
  if (!isExecutionStatus(source.status)) {
    throw new Error('Batch execution status is invalid.')
  }
  if (!Array.isArray(source.items)) {
    throw new Error('Batch execution items must be an array.')
  }
  const items = source.items.map(parseBatchItem)
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new Error('Batch execution contains duplicate item IDs.')
  }
  if (new Set(items.map((item) => item.ordinal)).size !== items.length) {
    throw new Error('Batch execution contains duplicate item ordinals.')
  }
  return {
    id,
    batchId: ownerBatchId,
    definitionSnapshot,
    sourceFolderCanonicalPath: source.sourceFolderCanonicalPath,
    sourceSnapshotSha256: sha256(source.sourceSnapshotSha256, 'Batch execution snapshot hash'),
    status: source.status,
    ...(source.cancelRequestedAt === undefined
      ? {}
      : { cancelRequestedAt: timestamp(source.cancelRequestedAt, 'Batch execution cancelRequestedAt') }),
    items,
    retainedResultBytes: nonNegativeInteger(source.retainedResultBytes, 'Batch execution retainedResultBytes'),
    ...(source.resultsClearedAt === undefined
      ? {}
      : { resultsClearedAt: timestamp(source.resultsClearedAt, 'Batch execution resultsClearedAt') }),
    startedAt: timestamp(source.startedAt, 'Batch execution startedAt'),
    updatedAt: timestamp(source.updatedAt, 'Batch execution updatedAt'),
    ...(source.completedAt === undefined
      ? {}
      : { completedAt: timestamp(source.completedAt, 'Batch execution completedAt') }),
    ...(source.failureDetail === undefined
      ? {}
      : { failureDetail: boundedString(source.failureDetail, 'Batch execution failureDetail', 4_000) }),
  }
}

function parseBatchItem(value: unknown): BatchItem {
  const source = record(value, 'Batch item must be a JSON object.')
  exactKeys(source, [
    'id', 'ordinal', 'fileName', 'sourceSize', 'sourceMtime', 'sourceSha256',
    'status', 'skipReason', 'preparationPhase', 'sessionId', 'runPlanId', 'taskId',
    'taskExecutionAttemptId', 'failureCode', 'failureDetail', 'publicationStartedAt',
    'resultArtifacts', 'createdAt', 'updatedAt', 'completedAt',
  ], 'Batch item')
  if (!isItemStatus(source.status)) throw new Error('Batch item status is invalid.')
  if (!Array.isArray(source.resultArtifacts)) {
    throw new Error('Batch item resultArtifacts must be an array.')
  }
  return {
    id: itemId(source.id),
    ordinal: nonNegativeInteger(source.ordinal, 'Batch item ordinal'),
    fileName: safeFileName(source.fileName),
    sourceSize: nonNegativeInteger(source.sourceSize, 'Batch item sourceSize'),
    sourceMtime: timestamp(source.sourceMtime, 'Batch item sourceMtime'),
    sourceSha256: sha256(source.sourceSha256, 'Batch item sourceSha256'),
    status: source.status,
    ...optionalEnum(source, 'skipReason', ['already_processed', 'unchanged']),
    ...optionalEnum(source, 'preparationPhase', ['intent_persisted', 'session_persisted', 'file_staged', 'plan_persisted']),
    ...optionalString(source, 'sessionId', 300),
    ...optionalString(source, 'runPlanId', 300),
    ...optionalString(source, 'taskId', 300),
    ...optionalString(source, 'taskExecutionAttemptId', 300),
    ...optionalEnum(source, 'failureCode', [
      'folder_access_revoked', 'source_changed', 'source_unavailable', 'file_too_large',
      'parse_failed', 'parsed_text_missing', 'project_unavailable', 'workflow_ineligible',
      'workflow_requires_input', 'admission_failed', 'task_failed', 'task_blocked',
      'task_cancelled', 'cancellation_failed', 'verified_publication_missing', 'verified_publication_invalid',
      'artifact_too_large', 'artifact_copy_failed', 'recovery_state_ambiguous',
    ]),
    ...optionalString(source, 'failureDetail', 4_000),
    ...(source.publicationStartedAt === undefined
      ? {}
      : { publicationStartedAt: timestamp(source.publicationStartedAt, 'Batch item publicationStartedAt') }),
    resultArtifacts: source.resultArtifacts.map(parseResultArtifact),
    createdAt: timestamp(source.createdAt, 'Batch item createdAt'),
    updatedAt: timestamp(source.updatedAt, 'Batch item updatedAt'),
    ...(source.completedAt === undefined
      ? {}
      : { completedAt: timestamp(source.completedAt, 'Batch item completedAt') }),
  } as BatchItem
}

function parseResultArtifact(value: unknown): BatchResultArtifact {
  const source = record(value, 'Batch result artifact must be a JSON object.')
  exactKeys(source, [
    'role', 'sourceRunId', 'sourcePath', 'destinationPath', 'mediaType',
    'byteLength', 'sha256',
  ], 'Batch result artifact')
  if (source.role !== 'final' && source.role !== 'secondary') {
    throw new Error('Batch result artifact role is invalid.')
  }
  return {
    role: source.role,
    sourceRunId: boundedString(source.sourceRunId, 'Batch artifact sourceRunId', 300),
    sourcePath: relativeSafePath(source.sourcePath, 'Batch artifact sourcePath'),
    destinationPath: relativeSafePath(source.destinationPath, 'Batch artifact destinationPath'),
    ...(source.mediaType === undefined
      ? {}
      : { mediaType: boundedString(source.mediaType, 'Batch artifact mediaType', 200) }),
    byteLength: nonNegativeInteger(source.byteLength, 'Batch artifact byteLength'),
    sha256: sha256(source.sha256, 'Batch artifact sha256'),
  }
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function exactKeys(source: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(source).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields: ${unknown.join(', ')}.`)
}

function stateSchemaVersion(value: unknown): 1 | 2 {
  if (value !== 1 && value !== BATCH_SCHEMA_VERSION) {
    throw new Error('Batch state uses an unsupported schema version.')
  }
  return value
}

function intentSchemaVersion(value: unknown): asserts value is 1 {
  if (value !== 1) throw new Error('Batch state uses an unsupported schema version.')
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer.`)
  return value as number
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer.`)
  return value as number
}

function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${label} must be a non-empty string of at most ${max} characters.`)
  }
  return value.trim()
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a valid timestamp.`)
  }
  return value
}

function batchId(value: unknown): string {
  if (!isBatchId(value)) throw new Error('Batch id is invalid.')
  return value
}

function executionId(value: unknown): string {
  if (!isBatchExecutionId(value)) throw new Error('Batch execution id is invalid.')
  return value
}

function itemId(value: unknown): string {
  if (!isBatchItemId(value)) throw new Error('Batch item id is invalid.')
  return value
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new Error(`${label} is invalid.`)
  return value
}

function safeFileName(value: unknown): string {
  if (
    typeof value !== 'string' || !value || value === '.' || value === '..' ||
    value.includes('/') || value.includes('\\') || value.includes('\0')
  ) throw new Error('Batch item fileName is invalid.')
  return value
}

function relativeSafePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${label} is invalid.`)
  }
  const normalized = path.normalize(value)
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) throw new Error(`${label} is invalid.`)
  return value
}

function optionalString(source: Record<string, unknown>, key: string, max: number): Record<string, string> {
  if (source[key] === undefined) return {}
  return { [key]: boundedString(source[key], `Batch item ${key}`, max) }
}

function optionalEnum(
  source: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): Record<string, string> {
  if (source[key] === undefined) return {}
  if (typeof source[key] !== 'string' || !allowed.includes(source[key])) {
    throw new Error(`Batch item ${key} is invalid.`)
  }
  return { [key]: source[key] }
}

function isExecutionStatus(value: unknown): value is BatchExecutionStatus {
  return value === 'pending' || value === 'running' || value === 'draining' ||
    value === 'completed' || value === 'cancelled' || value === 'failed'
}

function isItemStatus(value: unknown): value is BatchItemStatus {
  return value === 'skipped' || value === 'pending' || value === 'preparing' ||
    value === 'queued' || value === 'running' || value === 'recovering' ||
    value === 'publishing' || value === 'done' || value === 'failed' ||
    value === 'blocked' || value === 'cancelled' || value === 'setup_failed' ||
    value === 'artifact_failed'
}
