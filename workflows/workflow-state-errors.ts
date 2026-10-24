/**
 * The one error class the workflow state store and its rule modules throw.
 *
 * This file imports nothing, so any module the store uses can throw it without
 * an import cycle. Keep it the only definition: projection rebuild and callers
 * outside the store match it with `instanceof`, and a second copy of the class
 * would stop matching.
 */

export type WorkflowStateStoreErrorCode =
  | "already_exists"
  | "artifact_invalid"
  | "corrupt"
  | "identity_mismatch"
  | "invalid_state"
  | "lock_timeout"
  | "not_found"
  | "ownership_conflict"
  | "revision_conflict"
  | "unsupported_version";

export class WorkflowStateStoreError extends Error {
  constructor(
    readonly code: WorkflowStateStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkflowStateStoreError";
  }
}

export function invalidState(message: string): never {
  throw new WorkflowStateStoreError("invalid_state", message);
}
