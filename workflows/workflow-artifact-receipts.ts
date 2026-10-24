/**
 * Artifact references and completion receipts of durable workflow child runs.
 *
 * An artifact reference binds one regular file inside one child run's folder
 * to its byte length and SHA-256. A completion receipt is the immutable record
 * of how a child run finished, written once under that run's private runtime
 * path. A repeated write returns the stored receipt when only the completion
 * time differs and is refused otherwise. Every read checks the child run's
 * identity, the caller's expectation and each referenced artifact again.
 *
 * The receipt write takes its own lock, completion-receipt.lock, through
 * workflows/workflow-files.ts. This module does not import the workflow state
 * store. The store imports readWorkflowCompletionReceipt for receipt-aware
 * recovery and re-exports the public names here, so its callers keep importing
 * them from workflows/workflow-state-store.ts.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { defaultIsProcessAlive } from "../core/cross-process-file-lock.js";
import {
  resolveExistingPathInside,
  resolveRelativePathInside,
} from "../core/path-safety.js";
import { getRunRuntimePaths } from "../domains/runtime/runtime-paths.js";
import {
  MAX_HUMAN_INPUT_SOURCE_PREVIEW_BYTES,
} from "../contracts/human-input.js";
import type {
  WorkflowArtifactReference,
  WorkflowCompletionReceipt,
} from "./types.js";
import {
  cloneJson,
  DEFAULT_LOCK_RETRY_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  type FileLockOptions,
  hashFile,
  readJsonFile,
  withWorkflowFileLock,
  writeJsonAtomic,
} from "./workflow-files.js";
import { invalidState, WorkflowStateStoreError } from "./workflow-state-errors.js";
import { sameJson } from "./workflow-state-transitions.js";
import {
  assertExactSchemaVersion,
  assertIsoTimestamp,
  assertNonEmptyString,
  assertNonNegativeNumber,
  assertRelativeArtifactPath,
  assertSafeIdentifier,
  requireObject,
  validateArtifactReference,
  validateArtifactReferenceArray,
} from "./workflow-state-validation.js";

export const WORKFLOW_COMPLETION_RECEIPT_FILENAME = "completion-receipt.json";

const WORKFLOW_COMPLETION_RECEIPT_SCHEMA_VERSION = 1 as const;

export type WorkflowCompletionReceiptInput = Omit<
  WorkflowCompletionReceipt,
  "schemaVersion" | "completedAt"
> & {
  completedAt?: string;
};

export interface WorkflowCompletionReceiptExpectation {
  taskId?: string;
  rootRunId?: string;
  workflowId?: string;
  stepId?: string;
  childRunId?: string;
  executionAttemptId?: string;
}

/** Build a hash-bound reference to one regular file in one exact child run. */
export async function createWorkflowArtifactReference(params: {
  childAssignmentPath: string;
  childRunId: string;
  relativePath: string;
}): Promise<WorkflowArtifactReference> {
  const artifactPath = await resolveOwnedArtifactPath(params);
  const artifact = await hashFile(artifactPath);
  return {
    childRunId: params.childRunId,
    relativePath: params.relativePath,
    sha256: artifact.sha256,
    byteLength: artifact.byteLength,
  };
}

/** Verify artifact ownership, path containment, size, and content hash. */
export async function verifyWorkflowArtifactReference(
  childAssignmentPath: string,
  reference: WorkflowArtifactReference,
): Promise<string> {
  validateArtifactReference(reference, "Artifact reference");
  const artifactPath = await resolveOwnedArtifactPath({
    childAssignmentPath,
    childRunId: reference.childRunId,
    relativePath: reference.relativePath,
  });
  const artifact = await hashFile(artifactPath);
  if (artifact.byteLength !== reference.byteLength) {
    throw new WorkflowStateStoreError(
      "artifact_invalid",
      `Artifact '${reference.relativePath}' byte length does not match its durable reference.`,
    );
  }
  if (artifact.sha256 !== reference.sha256) {
    throw new WorkflowStateStoreError(
      "artifact_invalid",
      `Artifact '${reference.relativePath}' hash does not match its durable reference.`,
    );
  }
  return artifactPath;
}

/** Verify a source artifact, then return a bounded asynchronous text preview. */
export async function readVerifiedWorkflowArtifactPreview(
  childAssignmentPath: string,
  reference: WorkflowArtifactReference,
  maxBytes = MAX_HUMAN_INPUT_SOURCE_PREVIEW_BYTES,
): Promise<{ text: string; truncated: boolean; byteLength: number }> {
  const artifactPath = await verifyWorkflowArtifactReference(
    childAssignmentPath,
    reference,
  );
  const previewLength = Math.min(reference.byteLength, maxBytes);
  const handle = await fs.open(artifactPath, "r");
  try {
    const buffer = Buffer.alloc(previewLength);
    const { bytesRead } = await handle.read(buffer, 0, previewLength, 0);
    return {
      // Do not create a replacement character when a bounded byte window ends
      // halfway through a UTF-8 code point.
      text: new StringDecoder("utf8").write(buffer.subarray(0, bytesRead)),
      truncated: reference.byteLength > bytesRead,
      byteLength: reference.byteLength,
    };
  } finally {
    await handle.close();
  }
}

/** Write one immutable, content-validated receipt in the child run. */
export async function writeWorkflowCompletionReceipt(
  childAssignmentPath: string,
  input: WorkflowCompletionReceiptInput,
): Promise<WorkflowCompletionReceipt> {
  const completedAt = input.completedAt ?? new Date().toISOString();
  const receipt: WorkflowCompletionReceipt = {
    ...input,
    schemaVersion: WORKFLOW_COMPLETION_RECEIPT_SCHEMA_VERSION,
    completedAt,
  };
  validateCompletionReceipt(receipt);
  assertChildAssignmentIdentity(childAssignmentPath, receipt.childRunId);
  if (receipt.artifact) {
    await verifyWorkflowArtifactReference(
      childAssignmentPath,
      receipt.artifact,
    );
  }
  for (const artifact of receipt.artifacts ?? []) {
    await verifyWorkflowArtifactReference(childAssignmentPath, artifact);
  }

  const paths = getCompletionReceiptPaths(childAssignmentPath);
  const lockOptions: FileLockOptions = {
    processId: process.pid,
    isProcessAlive: defaultIsProcessAlive,
    timeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
    retryMs: DEFAULT_LOCK_RETRY_MS,
  };
  return withWorkflowFileLock(paths.lockPath, lockOptions, async () => {
    const existing = await readReceiptFile(paths.receiptPath);
    if (existing) {
      assertChildAssignmentIdentity(childAssignmentPath, existing.childRunId);
      if (!sameReceiptOutcome(existing, receipt)) {
        throw new WorkflowStateStoreError(
          "already_exists",
          "A different completion receipt already exists for this child run.",
        );
      }
      return cloneJson(existing);
    }
    await writeJsonAtomic(paths.receiptPath, receipt);
    return cloneJson(receipt);
  });
}

/** Read and validate an immutable child receipt and its referenced artifact. */
export async function readWorkflowCompletionReceipt(
  childAssignmentPath: string,
  expected: WorkflowCompletionReceiptExpectation = {},
): Promise<WorkflowCompletionReceipt | null> {
  const { receiptPath } = getCompletionReceiptPaths(childAssignmentPath);
  const receipt = await readReceiptFile(receiptPath);
  if (!receipt) return null;
  assertChildAssignmentIdentity(childAssignmentPath, receipt.childRunId);
  assertReceiptExpectation(receipt, expected);
  if (receipt.artifact) {
    await verifyWorkflowArtifactReference(
      childAssignmentPath,
      receipt.artifact,
    );
  }
  for (const artifact of receipt.artifacts ?? []) {
    await verifyWorkflowArtifactReference(childAssignmentPath, artifact);
  }
  return cloneJson(receipt);
}

function receiptArtifactReferences(
  receipt: WorkflowCompletionReceipt,
): WorkflowArtifactReference[] {
  return receipt.artifacts ?? (receipt.artifact ? [receipt.artifact] : []);
}

function validateCompletionReceipt(
  value: unknown,
): asserts value is WorkflowCompletionReceipt {
  const receipt = requireObject(value, "Workflow completion receipt");
  assertExactSchemaVersion(
    receipt.schemaVersion,
    WORKFLOW_COMPLETION_RECEIPT_SCHEMA_VERSION,
    "Workflow completion receipt",
  );
  assertSafeIdentifier(receipt.taskId, "Receipt task ID");
  assertSafeIdentifier(receipt.rootRunId, "Receipt root run ID");
  assertNonEmptyString(receipt.workflowId, "Receipt workflow ID");
  assertNonEmptyString(receipt.stepId, "Receipt step ID");
  assertSafeIdentifier(receipt.childRunId, "Receipt child run ID");
  assertSafeIdentifier(
    receipt.executionAttemptId,
    "Receipt execution attempt ID",
  );
  if (
    !["completed", "completed_with_warnings", "blocked", "failed"].includes(
      String(receipt.status),
    )
  ) {
    invalidState(
      `Unsupported completion receipt status '${String(receipt.status)}'.`,
    );
  }
  if (typeof receipt.summary !== "string") {
    invalidState("Completion receipt summary must be a string.");
  }
  if (receipt.requestedResultType !== undefined) {
    assertNonEmptyString(
      receipt.requestedResultType,
      "Completion receipt requested result type",
    );
  }
  assertNonNegativeNumber(receipt.costUsd, "Completion receipt cost");
  if (
    receipt.costTracked !== undefined &&
    typeof receipt.costTracked !== "boolean"
  ) {
    invalidState("Completion receipt costTracked must be boolean.");
  }
  assertIsoTimestamp(receipt.completedAt, "Completion receipt time");
  if (receipt.artifact !== undefined) {
    validateArtifactReference(receipt.artifact, "Completion receipt artifact");
    if (receipt.artifact.childRunId !== receipt.childRunId) {
      invalidState(
        "Completion receipt artifact belongs to a different child run.",
      );
    }
  }
  if (receipt.artifacts !== undefined) {
    validateArtifactReferenceArray(
      receipt.artifacts,
      "Completion receipt artifacts",
      receipt.childRunId as string,
    );
    if (!receipt.artifact) {
      invalidState("Completion receipt artifacts require an artifact alias.");
    }
    if (!sameJson(receipt.artifact, receipt.artifacts[0])) {
      invalidState(
        "Completion receipt artifact alias must match the first artifact.",
      );
    }
  }
  if (
    (receipt.status === "completed" ||
      receipt.status === "completed_with_warnings") &&
    receipt.requestedResultType !== "chat:messages" &&
    (Array.isArray(receipt.artifacts)
      ? receipt.artifacts
      : receipt.artifact === undefined
        ? []
        : [receipt.artifact]
    ).length === 0
  ) {
    invalidState(
      "A successful completion receipt requires an artifact reference.",
    );
  }
}

async function readReceiptFile(
  filePath: string,
): Promise<WorkflowCompletionReceipt | null> {
  const value = await readJsonFile(filePath, "workflow completion receipt");
  if (value === null) return null;
  validateCompletionReceipt(value);
  return value;
}

async function resolveOwnedArtifactPath(params: {
  childAssignmentPath: string;
  childRunId: string;
  relativePath: string;
}): Promise<string> {
  assertChildAssignmentIdentity(params.childAssignmentPath, params.childRunId);
  assertRelativeArtifactPath(params.relativePath, "Artifact relative path");
  const resolvedPath = resolveRelativePathInside(
    params.childAssignmentPath,
    params.relativePath,
  );
  if (!resolvedPath) {
    throw new WorkflowStateStoreError(
      "artifact_invalid",
      `Artifact path '${params.relativePath}' escapes its child assignment.`,
    );
  }
  const fileStat = await fs.lstat(resolvedPath).catch(() => null);
  if (!fileStat?.isFile() || fileStat.isSymbolicLink()) {
    throw new WorkflowStateStoreError(
      "artifact_invalid",
      `Artifact '${params.relativePath}' is not a regular owned file.`,
    );
  }
  if (!resolveExistingPathInside(params.childAssignmentPath, resolvedPath)) {
    throw new WorkflowStateStoreError(
      "artifact_invalid",
      `Artifact '${params.relativePath}' resolves outside its child assignment.`,
    );
  }
  return resolvedPath;
}

function assertChildAssignmentIdentity(
  childAssignmentPath: string,
  childRunId: string,
): void {
  assertSafeIdentifier(childRunId, "Child run ID");
  if (path.basename(path.resolve(childAssignmentPath)) !== childRunId) {
    throw new WorkflowStateStoreError(
      "identity_mismatch",
      `Child run '${childRunId}' does not own assignment '${path.basename(childAssignmentPath)}'.`,
    );
  }
}

function getCompletionReceiptPaths(childAssignmentPath: string): {
  receiptPath: string;
  lockPath: string;
} {
  const { privateRuntimePath } = getRunRuntimePaths(childAssignmentPath);
  return {
    receiptPath: path.join(
      privateRuntimePath,
      WORKFLOW_COMPLETION_RECEIPT_FILENAME,
    ),
    lockPath: path.join(privateRuntimePath, "completion-receipt.lock"),
  };
}

function assertReceiptExpectation(
  receipt: WorkflowCompletionReceipt,
  expected: WorkflowCompletionReceiptExpectation,
): void {
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (
      expectedValue !== undefined &&
      receipt[field as keyof WorkflowCompletionReceipt] !== expectedValue
    ) {
      throw new WorkflowStateStoreError(
        "identity_mismatch",
        `Completion receipt does not match expected '${field}'.`,
      );
    }
  }
}

function sameReceiptOutcome(
  left: WorkflowCompletionReceipt,
  right: WorkflowCompletionReceipt,
): boolean {
  const { completedAt: _leftCompletedAt, ...leftOutcome } = left;
  const { completedAt: _rightCompletedAt, ...rightOutcome } = right;
  return sameJson(leftOutcome, rightOutcome);
}
