/**
 * Candidate builders for the workflow state store's human-input commands.
 * buildHumanInputRequestCandidate takes the clock as an argument; apart from
 * that clock, no builder does any I/O.
 *
 * Each builder clones the current state and returns the changed copy.
 * buildHumanInputRequestCandidate puts the step and the workflow into
 * awaiting_input with a pending interaction, and reads the clock twice: the
 * step's startedAt, then the interaction's requestedAt.
 * buildHumanInputSubmissionCandidate records the submission, and
 * buildHumanInputContinuationClaimCandidate hands the run to the next
 * execution attempt; neither reads the clock. findHumanInputInteraction finds
 * an interaction by id or throws not_found.
 *
 * This module takes no lock, touches no file and stamps neither revision nor
 * updatedAt. The store keeps its guards, those stamps, validation and
 * publication. The parameter types name only the fields the builders read,
 * so this module does not import the store.
 */

import type {
  DurableWorkflowState,
  DurableWorkflowStepState,
  HumanInputInteraction,
  HumanInputRecipient,
  HumanInputSubmission,
  WorkflowArtifactReference,
} from "./types.js";
import { cloneJson } from "./workflow-files.js";
import {
  invalidState,
  WorkflowStateStoreError,
} from "./workflow-state-errors.js";

interface HumanInputRequestFields {
  stepId: string;
  interactionId: string;
  sourceArtifact: WorkflowArtifactReference;
  successorStepId: string;
  eligibleRecipients: HumanInputRecipient[];
  prompt?: string;
}

interface HumanInputSubmissionFields {
  interactionId: string;
  submission: HumanInputSubmission;
}

interface HumanInputContinuationClaimFields {
  interactionId: string;
  nextExecutionAttemptId: string;
  continuationAdmissionRequestId: string;
}

export function buildHumanInputRequestCandidate(
  current: DurableWorkflowState,
  currentStep: Pick<DurableWorkflowStepState, "stepIndex">,
  input: HumanInputRequestFields,
  now: () => Date,
): DurableWorkflowState {
  const candidate = cloneJson(current);
  const step = candidate.steps[currentStep.stepIndex];
  if (!step) {
    invalidState(
      `Human-input workflow step '${input.stepId}' index ${currentStep.stepIndex} is outside the step list.`,
    );
  }
  step.status = "awaiting_input";
  step.attemptCount += 1;
  step.startedAt = now().toISOString();
  step.humanInput = {
    interactionId: input.interactionId,
    taskId: candidate.taskId,
    sessionId: candidate.sessionId,
    workflowId: candidate.workflowId,
    stepId: step.stepId,
    ownerExecutionAttemptId: candidate.ownerExecutionAttemptId,
    sourceArtifact: cloneJson(input.sourceArtifact),
    successorStepId: input.successorStepId,
    eligibleRecipients: cloneJson(input.eligibleRecipients),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    requestedAt: now().toISOString(),
    status: "pending",
  };
  candidate.status = "awaiting_input";
  candidate.currentStepId = step.stepId;
  return candidate;
}

export function buildHumanInputSubmissionCandidate(
  current: DurableWorkflowState,
  input: HumanInputSubmissionFields,
): DurableWorkflowState {
  const candidate = cloneJson(current);
  const { interaction: candidateInteraction } =
    findHumanInputInteraction(candidate, input.interactionId);
  candidateInteraction.status = "submitted";
  candidateInteraction.submission = cloneJson(input.submission);
  return candidate;
}

export function buildHumanInputContinuationClaimCandidate(
  current: DurableWorkflowState,
  input: HumanInputContinuationClaimFields,
): DurableWorkflowState {
  const candidate = cloneJson(current);
  const { interaction: candidateInteraction } = findHumanInputInteraction(
    candidate,
    input.interactionId,
  );
  candidate.ownerExecutionAttemptId = input.nextExecutionAttemptId;
  candidate.status = "running";
  candidateInteraction.continuationAdmissionRequestId =
    input.continuationAdmissionRequestId;
  return candidate;
}

export function findHumanInputInteraction(
  state: DurableWorkflowState,
  interactionId: string,
): { step: DurableWorkflowStepState; interaction: HumanInputInteraction } {
  for (const step of state.steps) {
    if (step.humanInput?.interactionId === interactionId) {
      return { step, interaction: step.humanInput };
    }
  }
  throw new WorkflowStateStoreError(
    "not_found",
    `Human-input interaction '${interactionId}' was not found.`,
  );
}
