/**
 * The status transition rules and write-side transition checks of the
 * workflow state store.
 *
 * The validators compare the stored state, which has passed schema
 * validation, with a candidate the store is about to publish, and either
 * return or throw a WorkflowStateStoreError. The store validates the
 * candidate's schema after these checks. Nothing here reads files, the clock,
 * random IDs, the lock or the journal; the store owns all of those and decides
 * which check each write path runs.
 */

import type {
  DurableWorkflowState,
  DurableWorkflowStatus,
  DurableWorkflowStepState,
  DurableWorkflowStepStatus,
} from "./types.js";
import { invalidState, WorkflowStateStoreError } from "./workflow-state-errors.js";

export const TERMINAL_WORKFLOW_STATUSES: ReadonlySet<DurableWorkflowStatus> =
  new Set<DurableWorkflowStatus>([
    "completed",
    "completed_with_warnings",
    "blocked",
    "failed",
    "cancelled",
  ]);

export const TERMINAL_STEP_STATUSES: ReadonlySet<DurableWorkflowStepStatus> =
  new Set<DurableWorkflowStepStatus>([
    "completed",
    "completed_with_warnings",
    "blocked",
    "failed",
    "cancelled",
  ]);

/**
 * Whether a step has reached an outcome it cannot leave.
 *
 * Exported because more than one boundary has to agree on it, and a second copy
 * of the list is how they stop agreeing: the API route once kept its own and
 * left out `blocked`, so a retry that ended blocked read as unfinished.
 */
export function isTerminalWorkflowStepStatus(
  status: DurableWorkflowStepStatus,
): boolean {
  return TERMINAL_STEP_STATUSES.has(status);
}

const WORKFLOW_TRANSITIONS: Record<
  DurableWorkflowStatus,
  ReadonlySet<DurableWorkflowStatus>
> = {
  running: new Set([
    "running",
    "awaiting_input",
    "awaiting_model_choice",
    "interrupted",
    "completed",
    "completed_with_warnings",
    "blocked",
    "failed",
    "cancelled",
  ]),
  awaiting_input: new Set(["awaiting_input", "running", "cancelled"]),
  // A waiting workflow resumes when an approval arrives, is abandoned, or is
  // given up on. It may never advance to a result on its own: leaving
  // `completed` reachable is what would let a generic exit path finish a run
  // nobody authorized.
  awaiting_model_choice: new Set([
    "awaiting_model_choice",
    "running",
    "failed",
    "cancelled",
  ]),
  interrupted: new Set([
    "interrupted",
    "running",
    "completed",
    "completed_with_warnings",
    "blocked",
    "failed",
    "cancelled",
  ]),
  completed: new Set(),
  completed_with_warnings: new Set(),
  blocked: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

const STEP_TRANSITIONS: Record<
  DurableWorkflowStepStatus,
  ReadonlySet<DurableWorkflowStepStatus>
> = {
  pending: new Set([
    "pending",
    "awaiting_input",
    "launching",
    "blocked",
    "failed",
    "cancelled",
  ]),
  awaiting_input: new Set([
    "awaiting_input",
    "running",
    "completed",
    "completed_with_warnings",
    "blocked",
    "failed",
    "cancelled",
  ]),
  // A waiting step runs again only when a decision is approved. It cannot
  // reach a result without running, which is what stops an approval from being
  // inferred from a completion.
  awaiting_model_choice: new Set([
    "awaiting_model_choice",
    "running",
    "failed",
    "cancelled",
  ]),
  launching: new Set([
    "launching",
    "running",
    "interrupted",
    "indeterminate",
    "blocked",
    "failed",
    "cancelled",
  ]),
  running: new Set([
    "running",
    "awaiting_input",
    "awaiting_model_choice",
    "interrupted",
    "indeterminate",
    "completed",
    "completed_with_warnings",
    "blocked",
    "failed",
    "cancelled",
  ]),
  interrupted: new Set([
    "interrupted",
    "launching",
    "running",
    "indeterminate",
    "blocked",
    "failed",
    "cancelled",
  ]),
  indeterminate: new Set([
    "indeterminate",
    "launching",
    "blocked",
    "failed",
    "cancelled",
  ]),
  completed: new Set(),
  completed_with_warnings: new Set(),
  blocked: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export function validateStateTransition(
  current: DurableWorkflowState,
  candidate: DurableWorkflowState,
): void {
  if (!WORKFLOW_TRANSITIONS[current.status].has(candidate.status)) {
    invalidState(
      `Illegal workflow transition '${current.status}' -> '${candidate.status}'.`,
    );
  }
  if (candidate.totalCostUsd < current.totalCostUsd) {
    invalidState("Workflow total cost cannot decrease.");
  }
  if (candidate.steps.length !== current.steps.length) {
    invalidState(
      "Workflow steps cannot be added or removed after initialization.",
    );
  }

  for (const [index, previousStep] of current.steps.entries()) {
    const nextStep = candidate.steps[index];
    if (!nextStep) {
      invalidState(
        "Workflow steps cannot be added or removed after initialization.",
      );
    }
    assertImmutableStepIdentity(previousStep, nextStep);
    if (sameJson(previousStep, nextStep)) continue;
    if (TERMINAL_STEP_STATUSES.has(previousStep.status)) {
      invalidState(
        `Terminal workflow step '${previousStep.stepId}' is immutable.`,
      );
    }
    if (!STEP_TRANSITIONS[previousStep.status].has(nextStep.status)) {
      invalidState(
        `Illegal transition for workflow step '${previousStep.stepId}': ` +
          `'${previousStep.status}' -> '${nextStep.status}'.`,
      );
    }
    if (previousStep.status === "awaiting_model_choice") {
      // The only way out of a wait is the answer to the question it asked.
      // Without this, deleting the offer and setting both statuses back to
      // `running` releases the run with no approval at all — and a
      // well-formed approval for some other offer does too.
      const pending = previousStep.modelChoice;
      const approval = nextStep.approvedModelChoice;
      if (nextStep.status === "running") {
        if (!pending) {
          invalidState(
            `Workflow step '${previousStep.stepId}' cannot resume: it recorded no offer.`,
          );
        } else if (!approval) {
          invalidState(
            `Workflow step '${previousStep.stepId}' cannot resume without the approval that answers its offer.`,
          );
        } else if (
          approval.offerId !== pending.offerId ||
          approval.logicalInvocationId !== pending.logicalInvocationId ||
          // Consent is per agent. A matching offer id and matching pairs under
          // a different agent name would authorize a retry for somebody else.
          approval.agentName !== pending.agentName ||
          approval.failedChoice.provider !== pending.failedChoice.provider ||
          approval.failedChoice.model !== pending.failedChoice.model ||
          approval.proposedDefault.provider !== pending.proposedDefault.provider ||
          approval.proposedDefault.model !== pending.proposedDefault.model
        ) {
          // A pair the user was never shown, or a different question's answer.
          invalidState(
            `Workflow step '${previousStep.stepId}' approval does not answer the offer it is waiting on.`,
          );
        }
      }
    }
    if (
      previousStep.modelChoiceContinuationAdmissionRequestId !== undefined &&
      nextStep.modelChoiceContinuationAdmissionRequestId !==
        previousStep.modelChoiceContinuationAdmissionRequestId
    ) {
      // Once-only authority. A receipt that an ordinary update can clear or
      // replace lets the same approval be admitted again under a new attempt,
      // which is precisely what claiming refuses to do directly.
      invalidState(
        `Workflow step '${previousStep.stepId}' continuation admission is already recorded and cannot change.`,
      );
    }
    if (nextStep.attemptCount < previousStep.attemptCount) {
      invalidState(
        `Workflow step '${previousStep.stepId}' attempt count cannot decrease.`,
      );
    }
    if (nextStep.costUsd < previousStep.costUsd) {
      invalidState(
        `Workflow step '${previousStep.stepId}' cost cannot decrease.`,
      );
    }
  }
}

export function validateClaimTransition(
  current: DurableWorkflowState,
  candidate: DurableWorkflowState,
): void {
  if (candidate.revision !== current.revision + 1) {
    invalidState("Recovery claim must increment the workflow revision once.");
  }
  if (candidate.recoveryCount !== current.recoveryCount + 1) {
    invalidState("Recovery claim must increment the recovery count once.");
  }
  if (candidate.status !== "interrupted") {
    invalidState("Recovery claim must leave the workflow interrupted.");
  }
  if (candidate.totalCostUsd !== current.totalCostUsd) {
    invalidState("Recovery claim cannot change committed workflow cost.");
  }
  for (const [index, previousStep] of current.steps.entries()) {
    const nextStep = candidate.steps[index];
    if (!nextStep) {
      invalidState(
        `Recovery claim removed workflow step '${previousStep.stepId}'.`,
      );
    }
    assertImmutableStepIdentity(previousStep, nextStep);
    const expectedStatus =
      previousStep.status === "launching" || previousStep.status === "running"
        ? "interrupted"
        : previousStep.status;
    if (nextStep.status !== expectedStatus) {
      invalidState(
        `Recovery claim changed workflow step '${previousStep.stepId}' unexpectedly.`,
      );
    }
    const { status: _previousStatus, ...previousRest } = previousStep;
    const { status: _nextStatus, ...nextRest } = nextStep;
    if (!sameJson(previousRest, nextRest)) {
      invalidState(
        `Recovery claim changed workflow step '${previousStep.stepId}' data.`,
      );
    }
  }
}

export function assertControlledFieldsUnchanged(
  current: DurableWorkflowState,
  candidate: DurableWorkflowState,
): void {
  const immutableFields: Array<keyof DurableWorkflowState> = [
    "agentQuestions",
    "schemaVersion",
    "revision",
    "taskId",
    "sessionId",
    "rootRunId",
    "workflowId",
    "ownerExecutionAttemptId",
    "recoveryCount",
    "createdAt",
    "updatedAt",
  ];
  for (const field of immutableFields) {
    if (!sameJson(current[field], candidate[field])) {
      invalidState(
        `Workflow field '${field}' is controlled by the state store.`,
      );
    }
  }
}

function assertImmutableStepIdentity(
  current: DurableWorkflowStepState,
  candidate: DurableWorkflowStepState,
): void {
  const fields: Array<keyof DurableWorkflowStepState> = [
    "stepId",
    "stepIndex",
    "stepType",
    "team",
    "definitionHash",
    "recoveryPolicy",
    "childRunId",
    "inputArtifact",
    "resultArtifact",
    "resultArtifacts",
    "resultArtifactGlobs",
    "requestedResultType",
    "idempotencyKey",
  ];
  for (const field of fields) {
    if (!sameJson(current[field], candidate[field])) {
      invalidState(
        `Workflow step '${current.stepId}' field '${field}' is immutable.`,
      );
    }
  }
}

export function validateHumanInputContinuationClaim(
  current: DurableWorkflowState,
  candidate: DurableWorkflowState,
  interactionId: string,
): void {
  if (candidate.revision !== current.revision + 1) {
    invalidState(
      "Human-input continuation claim must increment the workflow revision once.",
    );
  }
  if (candidate.recoveryCount !== current.recoveryCount) {
    invalidState(
      "Human-input continuation claim cannot increment the recovery count.",
    );
  }
  if (candidate.status !== "running") {
    invalidState(
      "Human-input continuation claim must resume the workflow as running.",
    );
  }
  if (candidate.totalCostUsd !== current.totalCostUsd) {
    invalidState(
      "Human-input continuation claim cannot change committed workflow cost.",
    );
  }
  if (candidate.steps.length !== current.steps.length) {
    invalidState(
      "Human-input continuation claim cannot add or remove workflow steps.",
    );
  }
  for (const [index, previousStep] of current.steps.entries()) {
    const nextStep = candidate.steps[index];
    if (!nextStep) {
      invalidState(
        "Human-input continuation claim cannot add or remove workflow steps.",
      );
    }
    assertImmutableStepIdentity(previousStep, nextStep);
    if (previousStep.humanInput?.interactionId === interactionId) {
      const previousInteraction = previousStep.humanInput;
      const nextInteraction = nextStep.humanInput;
      if (
        !nextInteraction ||
        !sameJson(
          {
            ...previousInteraction,
            continuationAdmissionRequestId:
              nextInteraction.continuationAdmissionRequestId,
          },
          nextInteraction,
        )
      ) {
        invalidState(
          "Human-input continuation claim changed immutable interaction fields.",
        );
      }
      continue;
    }
    if (!sameJson(previousStep, nextStep)) {
      invalidState(
        `Human-input continuation claim changed workflow step '${previousStep.stepId}'.`,
      );
    }
  }
}

export function assertExpectedRevision(
  state: DurableWorkflowState,
  expectedRevision: number,
): void {
  if (state.revision !== expectedRevision) {
    throw new WorkflowStateStoreError(
      "revision_conflict",
      `Expected workflow revision ${expectedRevision}, found ${state.revision}.`,
    );
  }
}

export function assertExecutionOwner(
  state: DurableWorkflowState,
  executionAttemptId: string,
): void {
  if (state.ownerExecutionAttemptId !== executionAttemptId) {
    throw new WorkflowStateStoreError(
      "ownership_conflict",
      `Execution attempt '${executionAttemptId}' does not own this workflow; ` +
        `current owner is '${state.ownerExecutionAttemptId}'.`,
    );
  }
}

/**
 * Deep equality over JSON-shaped values. A key whose value is `undefined`
 * counts as absent, and key order does not matter. This is deliberately not
 * contracts/canonical-json.ts. That one throws on `undefined` values and on
 * roots that are not objects, and callers here compare both.
 */
export function sameJson(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(canonicalizeJson(left)) ===
    JSON.stringify(canonicalizeJson(right))
  );
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeJson(entry)]),
  );
}
