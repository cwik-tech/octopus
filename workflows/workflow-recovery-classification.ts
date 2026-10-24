/**
 * Recovery classification of a durable workflow state: the map from a
 * workflow status to a terminal session-task status, and the rules that decide
 * whether an unfinished workflow resumes automatically, needs a person, or
 * cannot resume. Nothing here reads files, the clock, random IDs, the lock or
 * the journal.
 */

import { whenDefined } from "../core/optional-properties.js";
import type {
  DurableWorkflowState,
  DurableWorkflowStatus,
  DurableWorkflowStepState,
  WorkflowStepRecoveryPolicy,
} from "./types.js";
import { TERMINAL_STEP_STATUSES } from "./workflow-state-transitions.js";

export interface WorkflowRecoveryDisposition {
  disposition: "automatic" | "manual" | "not_resumable";
  stepId?: string;
  policy?: WorkflowStepRecoveryPolicy;
  reason: string;
}

export type WorkflowTerminalTaskStatus =
  "done" | "blocked" | "failed" | "cancelled";

/**
 * Map a terminal durable workflow state to the existing session-task status.
 * A null result means the journal is still active and cannot reconcile a task
 * to terminal state.
 */
export function terminalTaskStatusForWorkflow(
  status: DurableWorkflowStatus,
): WorkflowTerminalTaskStatus | null {
  switch (status) {
    case "completed":
    case "completed_with_warnings":
      return "done";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "running":
    case "awaiting_input":
    case "awaiting_model_choice":
    case "interrupted":
      return null;
  }
}

/** Classify whether an unfinished journal can be resumed without user input. */
export function classifyWorkflowRecovery(
  state: DurableWorkflowState,
): WorkflowRecoveryDisposition {
  if (terminalTaskStatusForWorkflow(state.status)) {
    return {
      disposition: "not_resumable",
      reason: `Workflow is already terminal with status '${state.status}'.`,
    };
  }

  if (state.status === "awaiting_input") {
    return {
      disposition: "manual",
      ...whenDefined(state.currentStepId, (stepId) => ({ stepId })),
      reason: "Workflow is awaiting human input.",
    };
  }
  const currentStep = state.currentStepId
    ? state.steps.find(
        (step) =>
          step.stepId === state.currentStepId &&
          !TERMINAL_STEP_STATUSES.has(step.status),
      )
    : undefined;
  const unfinishedStep =
    currentStep ??
    state.steps.find((step) => !TERMINAL_STEP_STATUSES.has(step.status));

  if (!unfinishedStep) {
    const adverseTerminalStep = state.steps.find(
      (step) =>
        step.status === "blocked" ||
        step.status === "failed" ||
        step.status === "cancelled",
    );
    if (adverseTerminalStep) {
      return {
        disposition: "not_resumable",
        stepId: adverseTerminalStep.stepId,
        policy: adverseTerminalStep.recoveryPolicy,
        reason:
          `Workflow journal is active but step '${adverseTerminalStep.stepId}' ` +
          `is already '${adverseTerminalStep.status}'.`,
      };
    }
    return {
      disposition: "automatic",
      reason:
        "All workflow steps are committed; terminal reconciliation may continue.",
    };
  }

  if (unfinishedStep.status === "pending") {
    return {
      disposition: "automatic",
      stepId: unfinishedStep.stepId,
      policy: unfinishedStep.recoveryPolicy,
      reason: "The next workflow step has not started.",
    };
  }

  if (unfinishedStep.recoveryPolicy === "safe_retry") {
    return {
      disposition: "automatic",
      stepId: unfinishedStep.stepId,
      policy: unfinishedStep.recoveryPolicy,
      reason: "The interrupted step explicitly permits a safe retry.",
    };
  }

  if (unfinishedStep.recoveryPolicy === "idempotent") {
    return {
      disposition: "automatic",
      stepId: unfinishedStep.stepId,
      policy: unfinishedStep.recoveryPolicy,
      reason: "The interrupted step has a persisted idempotency key.",
    };
  }

  if (unfinishedStep.recoveryPolicy === "manual") {
    return {
      disposition: "manual",
      stepId: unfinishedStep.stepId,
      policy: unfinishedStep.recoveryPolicy,
      reason: "The interrupted step requires a user recovery decision.",
    };
  }

  return {
    disposition: "not_resumable",
    stepId: unfinishedStep.stepId,
    policy: unfinishedStep.recoveryPolicy,
    reason: "The interrupted step is explicitly marked never retry.",
  };
}

export function findUnfinishedStep(
  state: DurableWorkflowState,
): DurableWorkflowStepState | undefined {
  const currentStep = state.currentStepId
    ? state.steps.find(
        (step) =>
          step.stepId === state.currentStepId &&
          !TERMINAL_STEP_STATUSES.has(step.status),
      )
    : undefined;
  return (
    currentStep ??
    state.steps.find((step) => !TERMINAL_STEP_STATUSES.has(step.status))
  );
}
