export type BatchRerunPolicy = 'new_only' | 'new_and_changed' | 'always'

export interface BatchDefinitionInput {
  readonly name: string
  readonly workflowId: string
  readonly folderPath: string
  readonly fileExtensions: readonly string[]
  readonly rerunPolicy: BatchRerunPolicy
  readonly projectId?: string
}

export interface BatchPatch extends Partial<Omit<BatchDefinitionInput, 'projectId'>> {
  readonly expectedRevision: number
  readonly projectId?: string | null
}

export interface BatchDefinitionView extends BatchDefinitionInput {
  readonly id: string
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
}

export type BatchExecutionStatus =
  | 'pending'
  | 'running'
  | 'draining'
  | 'completed'
  | 'partially_completed'
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

export interface BatchExecutionSummary {
  readonly id: string
  readonly batchId: string
  readonly status: BatchExecutionStatus
  readonly counts: Readonly<Record<BatchItemStatus, number>>
  readonly retainedResultBytes: number
  readonly resultsClearedAt?: string
  readonly startedAt: string
  readonly updatedAt: string
  readonly completedAt?: string
}

export interface BatchView extends BatchDefinitionView {
  readonly activeExecution?: BatchExecutionSummary
  readonly latestExecution?: BatchExecutionSummary
}

export interface BatchResultArtifactView {
  readonly role: 'final' | 'secondary'
  readonly sourceRunId: string
  readonly sourcePath: string
  readonly mediaType?: string
  readonly byteLength: number
  readonly sha256: string
}

export interface BatchItemView {
  readonly id: string
  readonly ordinal: number
  readonly fileName: string
  readonly sourceSize: number
  readonly sourceMtime: string
  readonly sourceSha256: string
  readonly status: BatchItemStatus
  readonly sessionId?: string
  readonly taskId?: string
  readonly failureCode?: string
  readonly failureDetail?: string
  readonly resultArtifacts: readonly BatchResultArtifactView[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly completedAt?: string
}

export interface BatchExecutionPage {
  readonly executions: readonly BatchExecutionSummary[]
  readonly nextCursor?: string
}

export interface BatchExecutionItemPage {
  readonly execution: BatchExecutionSummary
  readonly items: readonly BatchItemView[]
  readonly nextCursor?: string
}

export interface BatchPreflightFile {
  readonly fileName: string
  readonly size: number
  readonly sha256: string
  readonly selected: boolean
  readonly skipReason?: 'already_processed' | 'unchanged'
}

export interface BatchPreflight {
  readonly canonicalFolderPath: string
  readonly fileCount: number
  readonly selectedCount: number
  readonly totalBytes: number
  readonly extensionCounts: Readonly<Record<string, number>>
  readonly requiresConfirmation: boolean
  readonly sourceSnapshotSha256: string
  readonly files: readonly BatchPreflightFile[]
}

export interface BatchFolderGrantView {
  readonly path: string
}

export interface BatchLimitSummary {
  readonly fileCount: number
  readonly totalBytes: number
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
  readonly fileName?: string
}

export type BatchErrorCode =
  | 'invalid_batch_request'
  | 'internal_batch_error'
  | 'folder_access_denied'
  | 'batch_not_found'
  | 'execution_not_found'
  | 'item_not_found'
  | 'artifact_not_found'
  | 'grant_not_found'
  | 'batch_active'
  | 'batch_execution_active'
  | 'batch_cleanup_active'
  | 'batch_definition_changed'
  | 'batch_has_no_matching_files'
  | 'artifact_cleared'
  | 'batch_too_large'
  | 'batch_service_unavailable'
  | 'task_queue_recovering'

export interface BatchApiError {
  readonly error: string
  readonly code: BatchErrorCode
  readonly detail?: string
  readonly limits?: BatchLimitSummary
  readonly preflight?: BatchPreflight
}

export type CreateBatchRequest = BatchDefinitionInput
export type PatchBatchRequest = BatchPatch
export type PreflightBatchRequest = Record<string, never>
export type RunBatchRequest = Record<string, never>
export type CancelBatchExecutionRequest = Record<string, never>
export type ClearBatchExecutionResultsRequest = Record<string, never>
export interface RevokeBatchFolderGrantRequest { readonly path: string }
