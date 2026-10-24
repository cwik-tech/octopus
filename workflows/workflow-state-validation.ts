/**
 * The schema and invariant checks of the workflow state store, and the content
 * hash they use.
 *
 * Each validator reads its arguments and this module's constants, changes none
 * of its arguments, and either returns or throws a WorkflowStateStoreError.
 * Nothing here reads files, the clock, random IDs, the environment, the lock or
 * the journal.
 */

import * as crypto from "node:crypto";
import * as path from "node:path";
import { agentQuestionsStateSchema } from "../contracts/agent-questions.js";
import {
  MAX_HUMAN_INPUT_MESSAGES,
  MAX_HUMAN_INPUT_RECIPIENTS_PER_MESSAGE,
  MAX_HUMAN_INPUT_TOTAL_CHARACTERS,
} from "../contracts/human-input.js";
import {
  readApprovedModelChoiceAuthorization,
  type ModelChoiceOffer,
} from "../contracts/model-choice.js";
import { isSafePathSegment } from "../core/path-safety.js";
import { isUnknownArray } from "../core/unknown-array.js";
import type {
  DurableWorkflowState,
  DurableWorkflowStatus,
  DurableWorkflowStepState,
  DurableWorkflowStepStatus,
  HumanInputInteraction,
  WorkflowArtifactReference,
  WorkflowExecutionManifest,
  WorkflowStepRecoveryPolicy,
  WorkflowStepStateSeed,
} from "./types.js";
import { invalidState, WorkflowStateStoreError } from "./workflow-state-errors.js";
import { sameJson, TERMINAL_WORKFLOW_STATUSES } from "./workflow-state-transitions.js";

export const WORKFLOW_EXECUTION_MANIFEST_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_STATE_SCHEMA_VERSION = 2 as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/** Hash workflow definitions, team definitions, briefs, and artifact bytes. */
export function hashWorkflowContent(contents: string | Uint8Array): string {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

const WORKFLOW_STATUSES = new Set<DurableWorkflowStatus>([
  "running",
  "awaiting_input",
  "awaiting_model_choice",
  "interrupted",
  "completed",
  "completed_with_warnings",
  "blocked",
  "failed",
  "cancelled",
]);

const STEP_STATUSES = new Set<DurableWorkflowStepStatus>([
  "pending",
  "awaiting_input",
  "awaiting_model_choice",
  "launching",
  "running",
  "interrupted",
  "indeterminate",
  "completed",
  "completed_with_warnings",
  "blocked",
  "failed",
  "cancelled",
]);

const STEP_TYPES = new Set<DurableWorkflowStepState["stepType"]>([
  "team",
  "agent",
  "transform",
  "human-in-the-loop",
]);

const RECOVERY_POLICIES = new Set<WorkflowStepRecoveryPolicy>([
  "safe_retry",
  "idempotent",
  "manual",
  "never_retry",
]);

export function validateManifest(
  value: unknown,
): asserts value is WorkflowExecutionManifest {
  const manifest = requireObject(value, "Execution manifest");
  assertExactSchemaVersion(
    manifest.schemaVersion,
    WORKFLOW_EXECUTION_MANIFEST_SCHEMA_VERSION,
    "Execution manifest",
  );
  assertSafeIdentifier(manifest.taskId, "Manifest task ID");
  assertSafeIdentifier(manifest.sessionId, "Manifest session ID");
  assertSafeIdentifier(manifest.rootRunId, "Manifest root run ID");
  assertNonEmptyString(manifest.workflowId, "Manifest workflow ID");
  assertSha256(manifest.workflowDefinitionHash, "Workflow definition hash");
  assertSha256(manifest.briefHash, "Brief hash");
  assertNonEmptyString(manifest.runtimeVersion, "Runtime version");
  assertIsoTimestamp(manifest.createdAt, "Manifest creation time");

  const teamHashes = requireObject(
    manifest.teamDefinitionHashes,
    "Team definition hashes",
  );
  for (const [team, hash] of Object.entries(teamHashes)) {
    assertNonEmptyString(team, "Team definition hash key");
    assertSha256(hash, `Team definition hash for '${team}'`);
  }
}

export function validateState(
  value: unknown,
  manifest: WorkflowExecutionManifest,
): asserts value is DurableWorkflowState {
  const state = requireObject(value, "Workflow state");
  const parsedQuestions = state.agentQuestions === undefined
    ? undefined : agentQuestionsStateSchema.safeParse(state.agentQuestions)
  if (parsedQuestions && !parsedQuestions.success) invalidState('Agent-question state is invalid.')
  assertExactSchemaVersion(
    state.schemaVersion,
    WORKFLOW_STATE_SCHEMA_VERSION,
    "Workflow state",
  );
  assertNonNegativeInteger(state.revision, "Workflow revision");
  assertSafeIdentifier(state.taskId, "Workflow task ID");
  assertSafeIdentifier(state.sessionId, "Workflow session ID");
  assertSafeIdentifier(state.rootRunId, "Workflow root run ID");
  assertNonEmptyString(state.workflowId, "Workflow ID");
  assertSafeIdentifier(
    state.ownerExecutionAttemptId,
    "Owner execution attempt ID",
  );
  if (!WORKFLOW_STATUSES.has(state.status as DurableWorkflowStatus)) {
    invalidState(`Unsupported workflow status '${String(state.status)}'.`);
  }
  assertNonNegativeNumber(state.totalCostUsd, "Workflow total cost");
  assertNonNegativeInteger(state.recoveryCount, "Workflow recovery count");
  assertIsoTimestamp(state.createdAt, "Workflow creation time");
  assertIsoTimestamp(state.updatedAt, "Workflow update time");
  if (state.currentStepId !== undefined) {
    assertNonEmptyString(state.currentStepId, "Current workflow step ID");
  }
  if (!Array.isArray(state.steps)) {
    invalidState("Workflow steps must be an array.");
  }

  const stepIds = new Set<string>();
  const childRunIds = new Set<string>();
  const typedSteps = state.steps.map((step, position) => {
    validateStepState(step, position, {
      sessionId: String(state.sessionId),
      taskId: String(state.taskId),
    });
    return step;
  });
  if (typedSteps.length === 0) {
    invalidState("Workflow state must contain at least one step.");
  }
  for (const [position, step] of typedSteps.entries()) {
    if (step.stepIndex !== position) {
      invalidState(
        `Workflow step '${step.stepId}' index ${step.stepIndex} does not match position ${position}.`,
      );
    }
    if (stepIds.has(step.stepId)) {
      invalidState(`Duplicate workflow step ID '${step.stepId}'.`);
    }
    if (childRunIds.has(step.childRunId)) {
      invalidState(`Duplicate child run ID '${step.childRunId}'.`);
    }
    stepIds.add(step.stepId);
    childRunIds.add(step.childRunId);
  }
  if (
    state.currentStepId !== undefined &&
    !stepIds.has(state.currentStepId as string)
  ) {
    invalidState(
      `Current workflow step '${state.currentStepId}' does not exist.`,
    );
  }
  if (state.status === "awaiting_input") {
    const awaitingStep = typedSteps.find(
      (step) => step.stepId === state.currentStepId,
    );
    if (!awaitingStep || awaitingStep.status !== "awaiting_input") {
      invalidState(
        "An awaiting-input workflow must point to an awaiting-input step.",
      );
    }
  }
  if (state.status === "awaiting_model_choice") {
    // A run that says it is waiting with nothing to approve anywhere in it is
    // a run no approval can ever release.
    const waiting = typedSteps.filter(
      (step) => step.status === "awaiting_model_choice" && step.modelChoice,
    );
    if (waiting.length === 0) {
      invalidState(
        "A workflow awaiting a model choice must have a step waiting on an offer.",
      );
    }
    if (waiting.length > 1) {
      // Consent is per invocation. Two live offers would leave an approval
      // unable to say which attempt it authorized.
      invalidState(
        "A workflow may await only one model choice at a time.",
      );
    }
  }
  for (const step of typedSteps) {
    const interaction = step.humanInput;
    if (!interaction) continue;
    if (
      interaction.taskId !== state.taskId ||
      interaction.sessionId !== state.sessionId ||
      interaction.workflowId !== state.workflowId
    ) {
      invalidState(
        `Human input interaction '${interaction.interactionId}' does not match workflow identity.`,
      );
    }
    if (
      (interaction.status === "pending" ||
        interaction.status === "submitted") &&
      step.status !== "awaiting_input"
    ) {
      invalidState(
        `Human input interaction '${interaction.interactionId}' must remain on an awaiting-input step.`,
      );
    }
  }

  if (parsedQuestions?.success) {
    for (const interaction of parsedQuestions.data.interactions) {
      if (interaction.status !== 'pending' && interaction.status !== 'submitted') continue
      const step = typedSteps.find((entry) => entry.stepId === interaction.stepId)
      const siblingContinuation = parsedQuestions.data.interactions.some((candidate) =>
        candidate.stepId === interaction.stepId &&
        (candidate.status === 'resuming' || candidate.status === 'resolved') &&
        candidate.continuation.executionAttemptId === state.ownerExecutionAttemptId,
      )
      const waiting = state.status === 'awaiting_input' && step?.status === 'awaiting_input'
      const continuingSibling = siblingContinuation &&
        ((state.status === 'running' && (step?.status === 'running' || step?.status === 'launching')) ||
         (state.status === 'interrupted' && step?.status === 'interrupted'))
      if (!waiting && !continuingSibling) {
        invalidState('An unanswered agent question must keep its workflow step waiting.')
      }
    }
  }

  const summedCost = roundUsd(
    typedSteps.reduce((total, step) => total + step.costUsd, 0),
  );
  if (roundUsd(state.totalCostUsd as number) !== summedCost) {
    invalidState(
      `Workflow total cost ${state.totalCostUsd} does not equal committed step cost ${summedCost}.`,
    );
  }
  validateTerminalOutcome(state, typedSteps);
  assertStateMatchesManifest(
    {
      taskId: state.taskId,
      sessionId: state.sessionId,
      rootRunId: state.rootRunId,
      workflowId: state.workflowId,
      createdAt: state.createdAt,
    },
    manifest,
  );
}

function validateTerminalOutcome(
  state: Record<string, unknown>,
  steps: readonly DurableWorkflowStepState[],
): void {
  const isTerminal =
    typeof state.status === "string" &&
    TERMINAL_WORKFLOW_STATUSES.has(state.status as DurableWorkflowStatus);
  if (!isTerminal) {
    if (state.terminalOutcome !== undefined) {
      invalidState("A nonterminal workflow cannot contain a terminal outcome.");
    }
    return;
  }

  if (state.terminalOutcome === undefined) {
    invalidState(
      `Terminal workflow status '${state.status}' requires a terminal outcome.`,
    );
  }
  const outcome = requireObject(
    state.terminalOutcome,
    "Workflow terminal outcome",
  );
  if (outcome.status !== state.status) {
    invalidState(
      "Workflow terminal outcome status must match workflow status.",
    );
  }
  if (
    typeof outcome.summary !== "string" ||
    outcome.summary.trim().length === 0
  ) {
    invalidState(
      "Workflow terminal outcome summary must be a non-empty string.",
    );
  }
  assertNonEmptyString(
    outcome.requestedResultType,
    "Workflow terminal outcome requested result type",
  );
  assertNonEmptyString(
    outcome.outputStepId,
    "Workflow terminal outcome output step ID",
  );
  const outputStep = steps.find((step) => step.stepId === outcome.outputStepId);
  if (!outputStep) {
    invalidState(
      `Workflow terminal outcome references unknown step '${outcome.outputStepId}'.`,
    );
  }
  if (
    typeof outcome.rootWrapperBody !== "string" ||
    outcome.rootWrapperBody.length === 0
  ) {
    invalidState(
      "Workflow terminal outcome root wrapper body must be non-empty.",
    );
  }
  assertSha256(
    outcome.rootWrapperSha256,
    "Workflow terminal outcome root wrapper hash",
  );
  if (
    hashWorkflowContent(outcome.rootWrapperBody) !== outcome.rootWrapperSha256
  ) {
    invalidState(
      "Workflow terminal outcome root wrapper hash does not match its body.",
    );
  }
  if (outcome.primaryArtifact !== undefined) {
    validateArtifactReference(
      outcome.primaryArtifact,
      "Workflow terminal outcome primary artifact",
    );
    if (
      !outputStep ||
      !stepArtifactReferences(outputStep).some((artifact) =>
        sameJson(artifact, outcome.primaryArtifact),
      )
    ) {
      invalidState(
        "Workflow terminal outcome primary artifact must belong to the output step.",
      );
    }
  }
  if (outcome.artifacts !== undefined) {
    if (!Array.isArray(outcome.artifacts) || outcome.artifacts.length === 0) {
      invalidState(
        "Workflow terminal outcome artifacts must be a non-empty array.",
      );
    }
    const primaryArtifacts = outcome.artifacts.filter(isPrimaryPublishedArtifact);
    if (primaryArtifacts.length !== 1) {
      invalidState(
        "Workflow terminal outcome artifacts must contain exactly one primary artifact.",
      );
    }
    if (!outcome.primaryArtifact) {
      invalidState(
        "Workflow terminal outcome artifacts require a primary artifact alias.",
      );
    }
    for (const [index, published] of outcome.artifacts.entries()) {
      const record = requireObject(
        published,
        `Workflow terminal outcome artifact ${index + 1}`,
      );
      assertNonEmptyString(
        record.stepId,
        `Workflow terminal outcome artifact ${index + 1} step ID`,
      );
      if (record.role !== "primary" && record.role !== "secondary") {
        invalidState(
          `Workflow terminal outcome artifact ${index + 1} has unsupported role '${String(record.role)}'.`,
        );
      }
      if (
        record.mediaType !== undefined &&
        typeof record.mediaType !== "string"
      ) {
        invalidState(
          `Workflow terminal outcome artifact ${index + 1} media type must be a string.`,
        );
      }
      if (record.label !== undefined && typeof record.label !== "string") {
        invalidState(
          `Workflow terminal outcome artifact ${index + 1} label must be a string.`,
        );
      }
      validateArtifactReference(
        record.artifact,
        `Workflow terminal outcome artifact ${index + 1} reference`,
      );
      const ownerStep = steps.find((step) => step.stepId === record.stepId);
      if (
        !ownerStep ||
        !stepArtifactReferences(ownerStep).some((artifact) =>
          sameJson(artifact, record.artifact),
        )
      ) {
        invalidState(
          `Workflow terminal outcome artifact ${index + 1} must match its owning step artifact.`,
        );
      }
    }
    if (
      outcome.primaryArtifact &&
      !sameJson(primaryArtifacts[0]?.artifact, outcome.primaryArtifact)
    ) {
      invalidState(
        "Workflow terminal outcome primary artifact alias must match its published primary artifact.",
      );
    }
  }
}

function isPrimaryPublishedArtifact(
  value: unknown,
): value is Record<string, unknown> {
  return (
    requireObject(value, "Workflow terminal outcome artifact").role ===
    "primary"
  );
}

function validateStepState(
  value: unknown,
  position: number,
  owner: { sessionId: string; taskId: string },
): asserts value is DurableWorkflowStepState {
  const step = requireObject(value, `Workflow step ${position}`);
  assertNonEmptyString(step.stepId, `Workflow step ${position} ID`);
  assertNonNegativeInteger(
    step.stepIndex,
    `Workflow step '${step.stepId}' index`,
  );
  if (!STEP_TYPES.has(step.stepType as DurableWorkflowStepState["stepType"])) {
    invalidState(
      `Unsupported type '${String(step.stepType)}' for workflow step '${step.stepId}'.`,
    );
  }
  if (step.stepType === "human-in-the-loop") {
    if (step.team !== undefined) {
      invalidState(
        `Human-input workflow step '${step.stepId}' cannot declare a team.`,
      );
    }
    if (step.humanInput !== undefined) {
      validateHumanInputInteraction(step.humanInput, step.stepId);
    }
  } else {
    assertNonEmptyString(step.team, `Workflow step '${step.stepId}' team`);
    if (step.humanInput !== undefined) {
      invalidState(
        `Executable workflow step '${step.stepId}' cannot contain human input.`,
      );
    }
  }
  if (step.modelChoice !== undefined) {
    if (step.stepType === "human-in-the-loop") {
      invalidState(
        `Human-input workflow step '${step.stepId}' cannot wait on a model choice.`,
      );
    }
    validateModelChoiceOffer(step.modelChoice, step.stepId, owner);
  } else if (step.status === "awaiting_model_choice") {
    // A wait with nothing to approve is a run that can never move again.
    invalidState(
      `Workflow step '${step.stepId}' is awaiting a model choice but records no offer.`,
    );
  }
  if (step.approvedModelChoice !== undefined) {
    if (step.modelChoice !== undefined) {
      // One is a question and the other its answer. Both live at once would
      // leave no way to say whether the user has decided.
      invalidState(
        `Workflow step '${step.stepId}' records both a pending and an approved model choice.`,
      );
    }
    validateApprovedModelChoice(step.approvedModelChoice, step.stepId);
  }
  if (step.modelChoiceContinuationAdmissionRequestId !== undefined) {
    // The receipt is what makes an approval spent, so it is read as strictly
    // as the approval itself. A value that is not an identifier, or one with
    // no approval behind it, would mark a decision consumed that nobody made.
    if (step.approvedModelChoice === undefined) {
      invalidState(
        `Workflow step '${step.stepId}' records a continuation admission with no approved model choice.`,
      );
    }
    assertSafeIdentifier(
      step.modelChoiceContinuationAdmissionRequestId,
      `Workflow step '${step.stepId}' continuation admission request ID`,
    );
  }
  assertSha256(
    step.definitionHash,
    `Workflow step '${step.stepId}' definition hash`,
  );
  if (!STEP_STATUSES.has(step.status as DurableWorkflowStepStatus)) {
    invalidState(
      `Unsupported status '${String(step.status)}' for workflow step '${step.stepId}'.`,
    );
  }
  if (
    !RECOVERY_POLICIES.has(step.recoveryPolicy as WorkflowStepRecoveryPolicy)
  ) {
    invalidState(
      `Unsupported recovery policy '${String(step.recoveryPolicy)}' for workflow step '${step.stepId}'.`,
    );
  }
  assertSafeIdentifier(
    step.childRunId,
    `Workflow step '${step.stepId}' child run ID`,
  );
  assertRelativeArtifactPath(
    step.inputArtifact,
    `Workflow step '${step.stepId}' input artifact`,
  );
  assertRelativeArtifactPath(
    step.resultArtifact,
    `Workflow step '${step.stepId}' result artifact`,
  );
  if (step.resultArtifacts !== undefined) {
    if (
      !Array.isArray(step.resultArtifacts) ||
      step.resultArtifacts.length === 0
    ) {
      invalidState(
        `Workflow step '${step.stepId}' result artifacts must be a non-empty array.`,
      );
    }
    const declaredArtifacts = new Set<string>();
    for (const artifact of step.resultArtifacts as unknown[]) {
      assertRelativeArtifactPath(
        artifact,
        `Workflow step '${step.stepId}' declared result artifact`,
      );
      if (declaredArtifacts.has(artifact as string)) {
        invalidState(
          `Workflow step '${step.stepId}' declares duplicate result artifact '${String(artifact)}'.`,
        );
      }
      declaredArtifacts.add(artifact as string);
    }
    if (step.resultArtifacts[0] !== step.resultArtifact) {
      invalidState(
        `Workflow step '${step.stepId}' primary result artifact must be first in resultArtifacts.`,
      );
    }
  }
  if (step.resultArtifactGlobs !== undefined) {
    if (
      !Array.isArray(step.resultArtifactGlobs) ||
      step.resultArtifactGlobs.length === 0
    ) {
      invalidState(
        `Workflow step '${step.stepId}' result artifact globs must be a non-empty array.`,
      );
    }
    for (const artifactGlob of step.resultArtifactGlobs) {
      assertSafeArtifactGlob(
        artifactGlob,
        `Workflow step '${step.stepId}' result artifact glob`,
      );
    }
  }
  assertNonEmptyString(
    step.requestedResultType,
    `Workflow step '${step.stepId}' requested result type`,
  );
  assertNonNegativeInteger(
    step.attemptCount,
    `Workflow step '${step.stepId}' attempt count`,
  );
  assertNonNegativeNumber(step.costUsd, `Workflow step '${step.stepId}' cost`);
  if (step.costTracked !== undefined && typeof step.costTracked !== "boolean") {
    invalidState(`Workflow step '${step.stepId}' costTracked must be boolean.`);
  }
  if (step.idempotencyKey !== undefined) {
    assertNonEmptyString(
      step.idempotencyKey,
      `Workflow step '${step.stepId}' idempotency key`,
    );
  }
  if (step.recoveryPolicy === "idempotent" && !step.idempotencyKey) {
    invalidState(
      `Idempotent workflow step '${step.stepId}' requires a persisted idempotency key.`,
    );
  }
  if (step.summary !== undefined && typeof step.summary !== "string") {
    invalidState(`Workflow step '${step.stepId}' summary must be a string.`);
  }
  if (step.error !== undefined && typeof step.error !== "string") {
    invalidState(`Workflow step '${step.stepId}' error must be a string.`);
  }
  if (step.startedAt !== undefined) {
    assertIsoTimestamp(
      step.startedAt,
      `Workflow step '${step.stepId}' start time`,
    );
  }
  if (step.completedAt !== undefined) {
    assertIsoTimestamp(
      step.completedAt,
      `Workflow step '${step.stepId}' completion time`,
    );
  }
  if (step.status === "pending" && step.attemptCount !== 0) {
    invalidState(
      `Pending workflow step '${step.stepId}' cannot have an attempt count.`,
    );
  }
  if (step.status !== "pending" && step.attemptCount < 1) {
    invalidState(
      `Started workflow step '${step.stepId}' must have an attempt count.`,
    );
  }
  if (step.artifact !== undefined) {
    validateArtifactReference(
      step.artifact,
      `Workflow step '${step.stepId}' artifact`,
    );
    if (step.artifact.childRunId !== step.childRunId) {
      invalidState(
        `Workflow step '${step.stepId}' artifact belongs to a different child run.`,
      );
    }
  }
  if (step.artifacts !== undefined) {
    validateArtifactReferenceArray(
      step.artifacts,
      `Workflow step '${step.stepId}' artifacts`,
      step.childRunId as string,
    );
    if (!step.artifact) {
      invalidState(
        `Workflow step '${step.stepId}' artifacts require an artifact alias.`,
      );
    }
    if (!sameJson(step.artifact, step.artifacts[0])) {
      invalidState(
        `Workflow step '${step.stepId}' artifact alias must match the first artifact.`,
      );
    }
    if (
      !stepArtifactsMatchDeclarations({
        artifacts: step.artifacts,
        resultArtifact: step.resultArtifact,
        resultArtifacts: step.resultArtifacts,
        resultArtifactGlobs: step.resultArtifactGlobs,
      })
    ) {
      invalidState(
        `Workflow step '${step.stepId}' artifacts must match its declared result artifacts.`,
      );
    }
  }
  if (
    (step.status === "completed" ||
      step.status === "completed_with_warnings") &&
    ((step.requestedResultType !== "chat:messages" &&
      (Array.isArray(step.artifacts)
        ? step.artifacts
        : step.artifact === undefined
          ? []
          : [step.artifact]
      ).length === 0) ||
      !step.completedAt)
  ) {
    invalidState(
      `Completed workflow step '${step.stepId}' requires an artifact and completion time.`,
    );
  }
}

function assertSafeArtifactGlob(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !value) {
    invalidState(`${label} must be a non-empty string.`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized
      .split("/")
      .some(
        (segment) =>
          segment === "" ||
          segment === "." ||
          segment === ".." ||
          (segment.includes("*") && segment !== "*"),
      ) ||
    !normalized.split("/").includes("*")
  ) {
    invalidState(`${label} must be a safe bounded artifact glob.`);
  }
}

function stepArtifactsMatchDeclarations(step: {
  readonly artifacts: unknown;
  readonly resultArtifact: unknown;
  readonly resultArtifacts: unknown;
  readonly resultArtifactGlobs: unknown;
}): boolean {
  if (
    !isUnknownArray(step.artifacts) ||
    typeof step.resultArtifact !== "string" ||
    (step.resultArtifacts !== undefined &&
      !isUnknownArray(step.resultArtifacts)) ||
    (step.resultArtifactGlobs !== undefined &&
      !isUnknownArray(step.resultArtifactGlobs))
  ) {
    return false;
  }
  const artifactPaths = step.artifacts.map(artifactReferencePath);
  if (artifactPaths.some((artifactPath) => artifactPath === null)) return false;
  const exactArtifacts: readonly unknown[] =
    step.resultArtifacts ?? [step.resultArtifact];
  if (!exactArtifacts.every((artifact) => typeof artifact === "string"))
    return false;
  if (
    !exactArtifacts.every(
      (artifact, index) => artifactPaths[index] === artifact,
    )
  ) {
    return false;
  }
  const artifactGlobs =
    step.resultArtifactGlobs === undefined
      ? []
      : step.resultArtifactGlobs.filter(
          (artifactGlob): artifactGlob is string =>
            typeof artifactGlob === "string",
        );
  const globArtifacts = artifactPaths.slice(exactArtifacts.length);
  return globArtifacts.every(
    (artifactPath) =>
      typeof artifactPath === "string" &&
      artifactGlobs.some((artifactGlob) =>
        artifactGlobMatches(artifactGlob, artifactPath),
      ),
  );
}

function artifactReferencePath(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("relativePath" in value)) {
    return null;
  }
  return typeof value.relativePath === "string" ? value.relativePath : null;
}

function artifactGlobMatches(
  artifactGlob: string,
  artifactPath: string,
): boolean {
  const pattern = artifactGlob.replaceAll("\\", "/").split("/");
  const value = artifactPath.replaceAll("\\", "/").split("/");
  return (
    pattern.length === value.length &&
    pattern.every(
      (segment, index) => segment === "*" || segment === value[index],
    )
  );
}

function validateHumanInputInteraction(
  value: unknown,
  stepId: string,
): asserts value is HumanInputInteraction {
  const interaction = requireObject(
    value,
    `Human input for workflow step '${stepId}'`,
  );
  assertSafeIdentifier(interaction.interactionId, "Human input interaction ID");
  assertSafeIdentifier(interaction.taskId, "Human input task ID");
  assertSafeIdentifier(interaction.sessionId, "Human input session ID");
  assertNonEmptyString(interaction.workflowId, "Human input workflow ID");
  if (interaction.stepId !== stepId) {
    invalidState(
      `Human input interaction does not belong to step '${stepId}'.`,
    );
  }
  assertSafeIdentifier(
    interaction.ownerExecutionAttemptId,
    "Human input owner execution attempt ID",
  );
  validateArtifactReference(
    interaction.sourceArtifact,
    "Human input source artifact",
  );
  assertNonEmptyString(
    interaction.successorStepId,
    "Human input successor step ID",
  );
  if (!Array.isArray(interaction.eligibleRecipients)) {
    invalidState("Human input eligible recipients must be an array.");
  }
  const recipientIds = new Set<string>();
  const mentionTokens = new Set<string>();
  for (const recipient of interaction.eligibleRecipients) {
    const record = requireObject(recipient, "Human input eligible recipient");
    assertNonEmptyString(record.id, "Human input recipient ID");
    assertNonEmptyString(
      record.mentionToken,
      "Human input recipient mention token",
    );
    assertNonEmptyString(
      record.displayName,
      "Human input recipient display name",
    );
    if (recipientIds.has(record.id as string)) {
      invalidState(`Duplicate human input recipient '${record.id}'.`);
    }
    const canonicalMentionToken = (record.mentionToken as string).toLowerCase();
    if (mentionTokens.has(canonicalMentionToken)) {
      invalidState(
        `Duplicate human input recipient mention '${record.mentionToken}'.`,
      );
    }
    recipientIds.add(record.id as string);
    mentionTokens.add(canonicalMentionToken);
  }
  if (
    interaction.prompt !== undefined &&
    typeof interaction.prompt !== "string"
  ) {
    invalidState("Human input prompt must be a string.");
  }
  assertIsoTimestamp(interaction.requestedAt, "Human input request time");
  if (
    interaction.status !== "pending" &&
    interaction.status !== "submitted" &&
    interaction.status !== "consumed" &&
    interaction.status !== "cancelled"
  ) {
    invalidState(
      `Unsupported human input status '${String(interaction.status)}'.`,
    );
  }
  if (interaction.submission !== undefined) {
    validateHumanInputSubmission(interaction.submission, recipientIds);
  }
  if (
    interaction.status === "pending" &&
    interaction.submission !== undefined
  ) {
    invalidState("Pending human input cannot contain a submission.");
  }
  if (
    (interaction.status === "submitted" || interaction.status === "consumed") &&
    interaction.submission === undefined
  ) {
    invalidState(
      `Human input status '${interaction.status}' requires a submission.`,
    );
  }
  if (interaction.continuationAdmissionRequestId !== undefined) {
    assertSafeIdentifier(
      interaction.continuationAdmissionRequestId,
      "Human input continuation admission request ID",
    );
  }
  if (interaction.feedbackArtifact !== undefined) {
    validateArtifactReference(
      interaction.feedbackArtifact,
      "Human input feedback artifact",
    );
    if (interaction.status !== "consumed") {
      invalidState(
        "Only consumed human input can reference a feedback artifact.",
      );
    }
  }
}

function validateHumanInputSubmission(
  value: unknown,
  recipientIds: ReadonlySet<string>,
): void {
  const submission = requireObject(value, "Human input submission");
  assertSafeIdentifier(submission.submissionId, "Human input submission ID");
  if (
    submission.mode !== "feedback" &&
    submission.mode !== "continue_without_feedback"
  ) {
    invalidState(
      `Unsupported human input submission mode '${String(submission.mode)}'.`,
    );
  }
  if (!Array.isArray(submission.messages)) {
    invalidState("Human input messages must be an array.");
  }
  if (submission.messages.length > MAX_HUMAN_INPUT_MESSAGES) {
    invalidState(
      `Human input submissions support at most ${MAX_HUMAN_INPUT_MESSAGES} messages.`,
    );
  }
  if (
    submission.mode === "continue_without_feedback" &&
    submission.messages.length !== 0
  ) {
    invalidState(
      "Continue-without-feedback submissions cannot contain messages.",
    );
  }
  const messageIds = new Set<string>();
  let totalCharacters = 0;
  for (const message of submission.messages) {
    const record = requireObject(message, "Human input message");
    assertSafeIdentifier(record.id, "Human input message ID");
    if (messageIds.has(record.id as string)) {
      invalidState(`Duplicate human input message '${record.id}'.`);
    }
    messageIds.add(record.id as string);
    if (typeof record.text !== "string" || !record.text.trim()) {
      invalidState("Human input message text must be non-empty.");
    }
    totalCharacters += record.text.length;
    if (record.recipients !== "all") {
      if (!Array.isArray(record.recipients) || record.recipients.length === 0) {
        invalidState(
          "Human input message recipients must be all or a non-empty array.",
        );
      }
      const messageRecipients = new Set<string>();
      for (const recipientId of record.recipients) {
        assertNonEmptyString(recipientId, "Human input message recipient ID");
        if (!recipientIds.has(recipientId)) {
          invalidState(
            `Human input message references ineligible recipient '${recipientId}'.`,
          );
        }
        if (messageRecipients.has(recipientId)) {
          invalidState(
            `Human input message duplicates recipient '${recipientId}'.`,
          );
        }
        messageRecipients.add(recipientId);
      }
      if (messageRecipients.size > MAX_HUMAN_INPUT_RECIPIENTS_PER_MESSAGE) {
        invalidState(
          `Human input messages support at most ${MAX_HUMAN_INPUT_RECIPIENTS_PER_MESSAGE} recipients.`,
        );
      }
    }
  }
  if (totalCharacters > MAX_HUMAN_INPUT_TOTAL_CHARACTERS) {
    invalidState(
      `Human input submissions support at most ${MAX_HUMAN_INPUT_TOTAL_CHARACTERS} characters.`,
    );
  }
  assertIsoTimestamp(submission.submittedAt, "Human input submission time");
  assertSha256(
    submission.canonicalHash,
    "Human input submission canonical hash",
  );
}

export function validateArtifactReference(
  value: unknown,
  label: string,
): asserts value is WorkflowArtifactReference {
  const reference = requireObject(value, label);
  assertSafeIdentifier(reference.childRunId, `${label} child run ID`);
  assertRelativeArtifactPath(reference.relativePath, `${label} relative path`);
  assertSha256(reference.sha256, `${label} hash`);
  assertNonNegativeInteger(reference.byteLength, `${label} byte length`);
}

export function validateArtifactReferenceArray(
  value: unknown,
  label: string,
  childRunId: string,
): asserts value is WorkflowArtifactReference[] {
  if (!Array.isArray(value) || value.length === 0) {
    invalidState(`${label} must be a non-empty array.`);
  }
  const paths = new Set<string>();
  for (const [index, artifact] of value.entries()) {
    validateArtifactReference(artifact, `${label} ${index + 1}`);
    if (artifact.childRunId !== childRunId) {
      invalidState(`${label} ${index + 1} belongs to a different child run.`);
    }
    if (paths.has(artifact.relativePath)) {
      invalidState(
        `${label} contains duplicate path '${artifact.relativePath}'.`,
      );
    }
    paths.add(artifact.relativePath);
  }
}

function stepArtifactReferences(
  step: DurableWorkflowStepState,
): WorkflowArtifactReference[] {
  return step.artifacts ?? (step.artifact ? [step.artifact] : []);
}

export function assertManifestMatchesInitialization(
  manifest: WorkflowExecutionManifest,
  expected: Omit<WorkflowExecutionManifest, "schemaVersion" | "createdAt"> & {
    createdAt?: string;
  },
): void {
  const fields: Array<
    keyof Omit<WorkflowExecutionManifest, "schemaVersion" | "createdAt">
  > = [
    "taskId",
    "sessionId",
    "rootRunId",
    "workflowId",
    "workflowDefinitionHash",
    "briefHash",
    "teamDefinitionHashes",
    "runtimeVersion",
  ];
  for (const field of fields) {
    if (!sameJson(manifest[field], expected[field])) {
      throw new WorkflowStateStoreError(
        "identity_mismatch",
        `Existing execution manifest does not match '${field}'.`,
      );
    }
  }
  if (
    expected.createdAt !== undefined &&
    manifest.createdAt !== expected.createdAt
  ) {
    throw new WorkflowStateStoreError(
      "identity_mismatch",
      "Existing execution manifest does not match 'createdAt'.",
    );
  }
}

export function assertStateMatchesSeeds(
  state: DurableWorkflowState,
  seeds: WorkflowStepStateSeed[],
): void {
  if (state.steps.length !== seeds.length) {
    throw new WorkflowStateStoreError(
      "identity_mismatch",
      "Persisted workflow step count does not match initialization.",
    );
  }
  for (const [index, seed] of seeds.entries()) {
    const step = state.steps[index];
    if (!step) {
      throw new WorkflowStateStoreError(
        "identity_mismatch",
        "Persisted workflow step count does not match initialization.",
      );
    }
    const expected: Array<[string, unknown, unknown]> = [
      ["stepId", step.stepId, seed.stepId],
      ["stepIndex", step.stepIndex, seed.stepIndex],
      ["stepType", step.stepType, seed.stepType],
      ["team", step.team, seed.team],
      ["definitionHash", step.definitionHash, seed.definitionHash],
      ["recoveryPolicy", step.recoveryPolicy, seed.recoveryPolicy],
      ["inputArtifact", step.inputArtifact, seed.inputArtifact],
      ["resultArtifact", step.resultArtifact, seed.resultArtifact],
      ["resultArtifacts", step.resultArtifacts, seed.resultArtifacts],
      [
        "resultArtifactGlobs",
        step.resultArtifactGlobs,
        seed.resultArtifactGlobs,
      ],
      [
        "requestedResultType",
        step.requestedResultType,
        seed.requestedResultType,
      ],
      ["idempotencyKey", step.idempotencyKey, seed.idempotencyKey],
    ];
    if (seed.childRunId !== undefined) {
      expected.push(["childRunId", step.childRunId, seed.childRunId]);
    }
    for (const [field, actual, wanted] of expected) {
      if (!sameJson(actual, wanted)) {
        throw new WorkflowStateStoreError(
          "identity_mismatch",
          `Persisted workflow step '${step.stepId}' does not match '${field}'.`,
        );
      }
    }
  }
}

function assertStateMatchesManifest(
  state: Pick<
    DurableWorkflowState,
    "taskId" | "sessionId" | "rootRunId" | "workflowId" | "createdAt"
  >,
  manifest: WorkflowExecutionManifest,
): void {
  const fields: Array<
    keyof Pick<
      DurableWorkflowState,
      "taskId" | "sessionId" | "rootRunId" | "workflowId"
    >
  > = ["taskId", "sessionId", "rootRunId", "workflowId"];
  for (const field of fields) {
    if (state[field] !== manifest[field]) {
      throw new WorkflowStateStoreError(
        "identity_mismatch",
        `Workflow state '${field}' does not match its execution manifest.`,
      );
    }
  }
  if (state.createdAt !== manifest.createdAt) {
    throw new WorkflowStateStoreError(
      "identity_mismatch",
      "Workflow state creation time does not match its execution manifest.",
    );
  }
}

export function assertExactSchemaVersion<TVersion extends number>(
  value: unknown,
  expectedVersion: TVersion,
  label: string,
): asserts value is TVersion {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value !== expectedVersion
  ) {
    throw new WorkflowStateStoreError(
      "unsupported_version",
      `${label} schema version ${value} is not supported.`,
    );
  }
  if (value !== expectedVersion) {
    throw new WorkflowStateStoreError(
      "corrupt",
      `${label} schema version is missing or invalid.`,
    );
  }
}

export function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowStateStoreError(
      "corrupt",
      `${label} must be a JSON object.`,
    );
  }
  return value as Record<string, unknown>;
}

export function assertSafeIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !isSafePathSegment(value)) {
    invalidState(`${label} must be a safe non-empty identifier.`);
  }
}

export function assertNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    invalidState(`${label} must be a non-empty string.`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    invalidState(`${label} must be a lowercase SHA-256 digest.`);
  }
}

export function assertNonNegativeNumber(
  value: unknown,
  label: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    invalidState(`${label} must be a finite non-negative number.`);
  }
}

function assertNonNegativeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    invalidState(`${label} must be a non-negative integer.`);
  }
}

export function assertIsoTimestamp(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    invalidState(`${label} must be an ISO-8601 timestamp.`);
  }
}

export function assertRelativeArtifactPath(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    path.isAbsolute(value) ||
    value.includes("\0")
  ) {
    invalidState(`${label} must be a safe relative path.`);
  }
  const segments = value.split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => !isSafePathSegment(segment))
  ) {
    invalidState(`${label} must be a safe slash-delimited relative path.`);
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * The offer a waiting step records, read back from disk.
 *
 * Validated rather than trusted, and refused whole rather than in part: an
 * approval is bound to exactly the pair the user was shown, so a half-readable
 * offer must never become an approvable one.
 */
function validateModelChoiceOffer(
  value: unknown,
  stepId: string,
  owner: { sessionId: string; taskId: string },
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidState(`Workflow step '${stepId}' model choice must be an object.`);
    return;
  }
  const offer = value as ModelChoiceOffer;
  if (
    typeof offer.scope !== "object" ||
    offer.scope === null ||
    typeof offer.failedChoice !== "object" ||
    offer.failedChoice === null ||
    typeof offer.proposedDefault !== "object" ||
    offer.proposedDefault === null
  ) {
    invalidState(`Workflow step '${stepId}' model choice is incomplete.`);
    return;
  }
  assertNonEmptyString(offer.offerId, `Workflow step '${stepId}' offer id`);
  assertNonEmptyString(
    offer.agentName,
    `Workflow step '${stepId}' offer agent name`,
  );
  assertNonEmptyString(
    offer.expectedRevision,
    `Workflow step '${stepId}' offer revision`,
  );
  if (offer.scope.kind !== "task") {
    invalidState(
      `Workflow step '${stepId}' offer must be scoped to a task, not '${String(offer.scope.kind)}'.`,
    );
  }
  assertNonEmptyString(
    offer.scope.sessionId,
    `Workflow step '${stepId}' offer session ID`,
  );
  assertNonEmptyString(
    offer.scope.taskId,
    `Workflow step '${stepId}' offer task ID`,
  );
  // An offer computed for some other run is not an offer for this one, and an
  // approval bound to it would authorize work nobody asked about here.
  if (
    offer.scope.sessionId !== owner.sessionId ||
    offer.scope.taskId !== owner.taskId
  ) {
    invalidState(
      `Workflow step '${stepId}' offer belongs to another run.`,
    );
  }
  if (!MODEL_CHOICE_ELIGIBLE_REASONS.has(offer.reason)) {
    // The reason is what the notice tells the user. An unreadable one would be
    // rendered as something nobody decided.
    invalidState(
      `Workflow step '${stepId}' offer reason '${String(offer.reason)}' is not one this build makes.`,
    );
  }
  if (
    offer.logicalInvocationId !== undefined &&
    typeof offer.logicalInvocationId !== "string"
  ) {
    invalidState(
      `Workflow step '${stepId}' offer logical invocation ID must be a string.`,
    );
  }
  assertOfferPairs(offer.failedChoice, offer.proposedDefault, stepId, "offer");
}

/** The eligibility reasons this build can offer, and therefore can read back. */
const MODEL_CHOICE_ELIGIBLE_REASONS = new Set<string>([
  "missing-credential",
  "unknown-model",
  "provider-rejected",
]);

/**
 * The approval a resumed step runs under, read back from disk.
 *
 * Refused whole rather than in part, for the same reason as the offer: a
 * half-readable authorization would either dispatch a model the user never
 * approved or silently stop applying.
 */
function validateApprovedModelChoice(value: unknown, stepId: string): void {
  const authorization = readApprovedModelChoiceAuthorization(value);
  if (!authorization) {
    invalidState(
      `Workflow step '${stepId}' approved model choice is incomplete.`,
    );
    return;
  }
  assertOfferPairs(
    authorization.failedChoice,
    authorization.proposedDefault,
    stepId,
    "approved model choice",
  );
}

function assertOfferPairs(
  failedChoice: { provider: string; model: string },
  proposedDefault: { provider: string; model: string },
  stepId: string,
  label: string,
): void {
  for (const [name, pair] of [
    ["failed choice", failedChoice],
    ["proposed default", proposedDefault],
  ] as const) {
    assertNonEmptyString(
      pair.provider,
      `Workflow step '${stepId}' ${label} ${name} provider`,
    );
    assertNonEmptyString(
      pair.model,
      `Workflow step '${stepId}' ${label} ${name} model`,
    );
  }
  // Proposing what already failed would present "retry on the app default" as
  // a change when it is not one.
  if (
    proposedDefault.provider === failedChoice.provider &&
    proposedDefault.model === failedChoice.model
  ) {
    invalidState(
      `Workflow step '${stepId}' ${label} proposes the pair that already failed.`,
    );
  }
}
