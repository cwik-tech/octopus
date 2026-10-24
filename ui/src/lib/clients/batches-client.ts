import type {
  BatchApiError,
  BatchDefinitionInput,
  BatchExecutionSummary,
  BatchExecutionItemPage,
  BatchExecutionPage,
  BatchPatch,
  BatchPreflight,
  BatchView,
} from "@contracts/batches";
import { getApiBaseUrl } from "@/lib/utils/desktop";

const API_BASE = getApiBaseUrl();

export class BatchesClientError extends Error {
  readonly status: number;
  readonly code: BatchApiError["code"];

  constructor(message: string, status: number, code: BatchApiError["code"]) {
    super(message);
    this.name = "BatchesClientError";
    this.status = status;
    this.code = code;
  }
}

export async function listBatches(signal?: AbortSignal): Promise<BatchView[]> {
  return (await request("/batches", signal === undefined ? {} : { signal }, parseBatchList)).batches;
}

export function createBatch(input: BatchDefinitionInput): Promise<BatchView> {
  return request("/batches", json("POST", input), parseBatchView);
}

export function updateBatch(id: string, patch: BatchPatch): Promise<BatchView> {
  return request(
    `/batches/${encodeURIComponent(id)}`,
    json("PATCH", patch),
    parseBatchView,
  );
}

export async function deleteBatch(id: string): Promise<void> {
  await request(
    `/batches/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    parseEmptyResponse,
  );
}

export function preflightBatch(id: string): Promise<BatchPreflight> {
  return request(
    `/batches/${encodeURIComponent(id)}/preflight`,
    json("POST", {}),
    parseBatchPreflight,
  );
}

export function runBatchNow(id: string): Promise<{ executionId: string }> {
  return request(
    `/batches/${encodeURIComponent(id)}/run-now`,
    json("POST", {}),
    parseRunNowResponse,
  );
}

export function listBatchExecutions(
  id: string,
  cursor?: string,
): Promise<BatchExecutionPage> {
  return request(
    `/batches/${encodeURIComponent(id)}/executions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    undefined,
    parseExecutionPage,
  );
}

export function getBatchExecution(
  batchId: string,
  executionId: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<BatchExecutionItemPage> {
  const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return request(
    `/batches/${encodeURIComponent(batchId)}/executions/${encodeURIComponent(executionId)}${suffix}`,
    signal === undefined ? {} : { signal },
    parseExecutionItemPage,
  );
}

export function cancelBatchExecution(
  batchId: string,
  executionId: string,
): Promise<void> {
  return request(
    `/batches/${encodeURIComponent(batchId)}/executions/${encodeURIComponent(executionId)}/cancel`,
    json("POST", {}),
    parseCancelResponse,
  );
}

export function clearBatchExecutionResults(
  batchId: string,
  executionId: string,
): Promise<void> {
  return request(
    `/batches/${encodeURIComponent(batchId)}/executions/${encodeURIComponent(executionId)}/results`,
    json("DELETE", {}),
    parseEmptyResponse,
  );
}

export function batchArtifactUrl(
  batchId: string,
  executionId: string,
  itemId: string,
  artifactIndex: number,
): string {
  return `${API_BASE}/batches/${encodeURIComponent(batchId)}/executions/${encodeURIComponent(executionId)}/items/${encodeURIComponent(itemId)}/artifacts/${artifactIndex}`;
}

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function request<T>(
  path: string,
  init: RequestInit | undefined,
  parse: (value: unknown) => T,
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (response.ok) {
    if (response.status === 204) return parse(undefined);
    return parse(await response.json());
  }
  const payload = recordOrNull(await response.json().catch(() => null));
  throw new BatchesClientError(
    typeof payload?.error === "string"
      ? payload.error
      : `${response.status} ${response.statusText || "Batch request failed"}`,
    response.status,
    isBatchErrorCode(payload?.code)
      ? payload.code
      : "batch_service_unavailable",
  );
}

const EXECUTION_STATUSES = new Set([
  "pending",
  "running",
  "draining",
  "completed",
  "cancelled",
  "failed",
]);
const ITEM_STATUSES = new Set([
  "skipped",
  "pending",
  "preparing",
  "queued",
  "running",
  "recovering",
  "publishing",
  "done",
  "failed",
  "blocked",
  "cancelled",
  "setup_failed",
  "artifact_failed",
]);
const RERUN_POLICIES = new Set(["new_only", "new_and_changed", "always"]);
const BATCH_ERROR_CODES: ReadonlySet<BatchApiError["code"]> = new Set([
  "invalid_batch_request",
  "internal_batch_error",
  "folder_access_denied",
  "batch_not_found",
  "execution_not_found",
  "item_not_found",
  "artifact_not_found",
  "grant_not_found",
  "batch_active",
  "batch_execution_active",
  "batch_cleanup_active",
  "batch_definition_changed",
  "batch_has_no_matching_files",
  "artifact_cleared",
  "batch_too_large",
  "batch_service_unavailable",
  "task_queue_recovering",
]);

function parseEmptyResponse(value: unknown): void {
  if (value !== undefined) invalidBatchResponse();
}

function parseBatchList(value: unknown): { batches: BatchView[] } {
  const source = requiredRecord(value);
  if (!Array.isArray(source.batches)) invalidBatchResponse();
  return { batches: source.batches.map(parseBatchView) };
}

function parseBatchView(value: unknown): BatchView {
  const source = requiredRecord(value);
  requiredString(source.id);
  requiredPositiveInteger(source.revision);
  requiredString(source.name);
  requiredString(source.workflowId);
  requiredString(source.folderPath);
  if (
    !Array.isArray(source.fileExtensions) ||
    !source.fileExtensions.every((entry) => typeof entry === "string")
  ) {
    invalidBatchResponse();
  }
  if (!RERUN_POLICIES.has(String(source.rerunPolicy))) invalidBatchResponse();
  if (source.projectId !== undefined) optionalString(source.projectId);
  requiredString(source.createdAt);
  requiredString(source.updatedAt);
  return {
    id: requiredString(source.id),
    revision: requiredPositiveInteger(source.revision),
    name: requiredString(source.name),
    workflowId: requiredString(source.workflowId),
    folderPath: requiredString(source.folderPath),
    fileExtensions: source.fileExtensions,
    rerunPolicy: source.rerunPolicy as BatchView["rerunPolicy"],
    ...(source.projectId === undefined
      ? {}
      : { projectId: optionalString(source.projectId) }),
    createdAt: requiredString(source.createdAt),
    updatedAt: requiredString(source.updatedAt),
    ...(source.activeExecution === undefined
      ? {}
      : { activeExecution: parseExecutionSummary(source.activeExecution) }),
    ...(source.latestExecution === undefined
      ? {}
      : { latestExecution: parseExecutionSummary(source.latestExecution) }),
  };
}

function parseExecutionSummary(
  value: unknown,
): BatchExecutionPage["executions"][number] {
  const source = requiredRecord(value);
  requiredString(source.id);
  requiredString(source.batchId);
  if (!EXECUTION_STATUSES.has(String(source.status))) invalidBatchResponse();
  const counts = requiredRecord(source.counts);
  for (const status of ITEM_STATUSES) requiredNonNegativeNumber(counts[status]);
  requiredNonNegativeNumber(source.retainedResultBytes);
  if (source.resultsClearedAt !== undefined) optionalString(source.resultsClearedAt);
  requiredString(source.startedAt);
  requiredString(source.updatedAt);
  if (source.completedAt !== undefined) optionalString(source.completedAt);
  return {
    id: requiredString(source.id),
    batchId: requiredString(source.batchId),
    status: source.status as BatchExecutionSummary["status"],
    counts: Object.fromEntries(
      Array.from(ITEM_STATUSES, (status) => [
        status,
        requiredNonNegativeNumber(counts[status]),
      ]),
    ) as BatchExecutionSummary["counts"],
    retainedResultBytes: requiredNonNegativeNumber(source.retainedResultBytes),
    ...(source.resultsClearedAt === undefined
      ? {}
      : { resultsClearedAt: optionalString(source.resultsClearedAt) }),
    startedAt: requiredString(source.startedAt),
    updatedAt: requiredString(source.updatedAt),
    ...(source.completedAt === undefined
      ? {}
      : { completedAt: optionalString(source.completedAt) }),
  };
}

function parseBatchPreflight(value: unknown): BatchPreflight {
  const source = requiredRecord(value);
  requiredString(source.canonicalFolderPath);
  requiredNonNegativeNumber(source.fileCount);
  requiredNonNegativeNumber(source.selectedCount);
  requiredNonNegativeNumber(source.totalBytes);
  const extensionCounts = requiredRecord(source.extensionCounts);
  for (const count of Object.values(extensionCounts))
    requiredNonNegativeNumber(count);
  if (typeof source.requiresConfirmation !== "boolean") invalidBatchResponse();
  requiredString(source.sourceSnapshotSha256);
  if (!Array.isArray(source.files)) invalidBatchResponse();
  return {
    canonicalFolderPath: requiredString(source.canonicalFolderPath),
    fileCount: requiredNonNegativeNumber(source.fileCount),
    selectedCount: requiredNonNegativeNumber(source.selectedCount),
    totalBytes: requiredNonNegativeNumber(source.totalBytes),
    extensionCounts: Object.fromEntries(
      Object.entries(extensionCounts).map(([extension, count]) => [
        extension,
        requiredNonNegativeNumber(count),
      ]),
    ),
    requiresConfirmation: requiredBoolean(source.requiresConfirmation),
    sourceSnapshotSha256: requiredString(source.sourceSnapshotSha256),
    files: source.files.map(parsePreflightFile),
  };
}

function parseRunNowResponse(value: unknown): { executionId: string } {
  const source = requiredRecord(value);
  requiredString(source.executionId);
  return { executionId: requiredString(source.executionId) };
}

function parseCancelResponse(value: unknown): void {
  const source = requiredRecord(value);
  requiredString(source.executionId);
  if (!EXECUTION_STATUSES.has(String(source.status))) invalidBatchResponse();
  if (source.cancelRequestedAt !== undefined) optionalString(source.cancelRequestedAt);
}

function parseExecutionPage(value: unknown): BatchExecutionPage {
  const source = requiredRecord(value);
  if (!Array.isArray(source.executions)) invalidBatchResponse();
  return {
    executions: source.executions.map(parseExecutionSummary),
    ...(source.nextCursor === undefined
      ? {}
      : { nextCursor: optionalString(source.nextCursor) }),
  };
}

function parseExecutionItemPage(value: unknown): BatchExecutionItemPage {
  const source = requiredRecord(value);
  if (!Array.isArray(source.items)) invalidBatchResponse();
  return {
    execution: parseExecutionSummary(source.execution),
    items: source.items.map(parseBatchItem),
    ...(source.nextCursor === undefined
      ? {}
      : { nextCursor: optionalString(source.nextCursor) }),
  };
}

function parsePreflightFile(value: unknown): BatchPreflight["files"][number] {
  const source = requiredRecord(value);
  const skipReason = source.skipReason;
  if (
    skipReason !== undefined &&
    skipReason !== "already_processed" &&
    skipReason !== "unchanged"
  )
    invalidBatchResponse();
  return {
    fileName: requiredString(source.fileName),
    size: requiredNonNegativeNumber(source.size),
    sha256: requiredString(source.sha256),
    selected: requiredBoolean(source.selected),
    ...(skipReason === undefined ? {} : { skipReason }),
  };
}

function parseBatchItem(
  value: unknown,
): BatchExecutionItemPage["items"][number] {
  const source = requiredRecord(value);
  if (
    !ITEM_STATUSES.has(String(source.status)) ||
    !Array.isArray(source.resultArtifacts)
  )
    invalidBatchResponse();
  return {
    id: requiredString(source.id),
    ordinal: requiredNonNegativeNumber(source.ordinal),
    fileName: requiredString(source.fileName),
    sourceSize: requiredNonNegativeNumber(source.sourceSize),
    sourceMtime: requiredString(source.sourceMtime),
    sourceSha256: requiredString(source.sourceSha256),
    status: source.status as BatchExecutionItemPage["items"][number]["status"],
    ...(source.sessionId === undefined
      ? {}
      : { sessionId: optionalString(source.sessionId) }),
    ...(source.taskId === undefined
      ? {}
      : { taskId: optionalString(source.taskId) }),
    ...(source.failureCode === undefined
      ? {}
      : { failureCode: optionalString(source.failureCode) }),
    ...(source.failureDetail === undefined
      ? {}
      : { failureDetail: optionalString(source.failureDetail) }),
    resultArtifacts: source.resultArtifacts.map(parseResultArtifact),
    createdAt: requiredString(source.createdAt),
    updatedAt: requiredString(source.updatedAt),
    ...(source.completedAt === undefined
      ? {}
      : { completedAt: optionalString(source.completedAt) }),
  };
}

function parseResultArtifact(
  value: unknown,
): BatchExecutionItemPage["items"][number]["resultArtifacts"][number] {
  const source = requiredRecord(value);
  if (source.role !== "final" && source.role !== "secondary")
    invalidBatchResponse();
  return {
    role: source.role,
    sourceRunId: requiredString(source.sourceRunId),
    sourcePath: requiredString(source.sourcePath),
    ...(source.mediaType === undefined
      ? {}
      : { mediaType: optionalString(source.mediaType) }),
    byteLength: requiredNonNegativeNumber(source.byteLength),
    sha256: requiredString(source.sha256),
  };
}

function requiredRecord(value: unknown): Record<string, unknown> {
  const source = recordOrNull(value);
  if (!source) invalidBatchResponse();
  return source;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) invalidBatchResponse();
  return value;
}

function optionalString(value: unknown): string {
  if (typeof value !== "string") invalidBatchResponse();
  return value;
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalidBatchResponse();
  return value;
}

function requiredPositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    invalidBatchResponse();
  return value;
}

function requiredNonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    invalidBatchResponse();
  return value;
}

function isBatchErrorCode(value: unknown): value is BatchApiError["code"] {
  return (
    typeof value === "string" &&
    BATCH_ERROR_CODES.has(value as BatchApiError["code"])
  );
}

function invalidBatchResponse(): never {
  throw new Error("Invalid Batch response from the local API.");
}
