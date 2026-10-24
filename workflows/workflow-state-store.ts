import {
  agentQuestionAnswersSchema,
  agentQuestionContinuationSchema,
  agentQuestionRequestSchema,
  agentQuestionResultSchema,
  requestAgentInputSchema,
  pauseAgentQuestionSchema,
  blockAgentQuestionsSchema,
  claimAgentQuestionContinuationSchema,
  submitAgentInputSchema,
  resolveAgentQuestionSchema,
  beginAgentQuestionProviderSchema,
  type AgentQuestionInteraction,
  type AgentQuestionContentReference,
} from '../contracts/agent-questions.js'
import { canonicalizeJson as serializeCanonicalJson } from '../contracts/canonical-json.js'
import { decideAgentQuestionRound } from '../core/agent-question-policy.js'
import { readExecutionJournal } from '../core/execution-journal.js'
import { validateWorkflowJournalStream, workflowJournalStreamId, WORKFLOW_STATE_STREAM_KIND } from './workflow-journal.js'
import * as crypto from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveExistingPathInside } from "../core/path-safety.js";
import {
  defaultIsProcessAlive,
} from "../core/cross-process-file-lock.js";
import { getRunRuntimePaths } from "../domains/runtime/runtime-paths.js";
import {
  modelChoiceOfferId,
  type ModelChoiceOffer,
} from "../contracts/model-choice.js";
import type { ProviderModelPair } from "../contracts/agent-model-selection.js";
import { BUILTIN_TRANSFORM_EXECUTOR } from "./artifact-contracts.js";
import { buildDurableWorkflowTerminalOutcome } from "./results.js";
import type {
  DurableWorkflowState,
  DurableWorkflowStepState,
  DurableWorkflowTerminalOutcome,
  HumanInputRecipient,
  HumanInputSubmission,
  WorkflowArtifactReference,
  WorkflowExecutionManifest,
  WorkflowStepStateSeed,
} from "./types.js";
import type {
  WorkflowBaselineSourceHashes,
  WorkflowJournalRecordedState,
  WorkflowJournalRecorder,
} from "./workflow-journal.js";
import {
  invalidState,
  WorkflowStateStoreError,
  type WorkflowStateStoreErrorCode,
} from "./workflow-state-errors.js";
import {
  assertControlledFieldsUnchanged,
  assertExecutionOwner,
  assertExpectedRevision,
  sameJson,
  TERMINAL_STEP_STATUSES,
  TERMINAL_WORKFLOW_STATUSES,
  validateClaimTransition,
  validateHumanInputContinuationClaim,
  validateStateTransition,
} from "./workflow-state-transitions.js";
import {
  assertExactSchemaVersion,
  assertIsoTimestamp,
  assertManifestMatchesInitialization,
  assertSafeIdentifier,
  assertStateMatchesSeeds,
  hashWorkflowContent,
  requireObject,
  validateManifest,
  validateState,
  WORKFLOW_EXECUTION_MANIFEST_SCHEMA_VERSION,
  WORKFLOW_STATE_SCHEMA_VERSION,
} from "./workflow-state-validation.js";
import {
  classifyWorkflowRecovery,
  findUnfinishedStep,
  terminalTaskStatusForWorkflow,
  type WorkflowRecoveryDisposition,
} from "./workflow-recovery-classification.js";
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
import { readWorkflowCompletionReceipt } from "./workflow-artifact-receipts.js";
import {
  readAgentQuestionContentFile,
  writeAgentQuestionContentFile,
} from "./workflow-agent-question-content.js";
import {
  buildHumanInputContinuationClaimCandidate,
  buildHumanInputRequestCandidate,
  buildHumanInputSubmissionCandidate,
  findHumanInputInteraction,
} from "./workflow-state-candidates.js";

export {
  WorkflowStateStoreError,
  type WorkflowStateStoreErrorCode,
} from "./workflow-state-errors.js";
export { isTerminalWorkflowStepStatus } from "./workflow-state-transitions.js";
export { hashWorkflowContent } from "./workflow-state-validation.js";
export {
  classifyWorkflowRecovery,
  terminalTaskStatusForWorkflow,
  type WorkflowRecoveryDisposition,
  type WorkflowTerminalTaskStatus,
} from "./workflow-recovery-classification.js";
export {
  createWorkflowArtifactReference,
  readVerifiedWorkflowArtifactPreview,
  readWorkflowCompletionReceipt,
  verifyWorkflowArtifactReference,
  WORKFLOW_COMPLETION_RECEIPT_FILENAME,
  writeWorkflowCompletionReceipt,
  type WorkflowCompletionReceiptExpectation,
  type WorkflowCompletionReceiptInput,
} from "./workflow-artifact-receipts.js";

export const WORKFLOW_EXECUTION_MANIFEST_FILENAME = "execution-manifest.json";
export const WORKFLOW_STATE_FILENAME = "workflow-state.json";
export const WORKFLOW_STATE_LOCK_FILENAME = "workflow.lock";

export interface WorkflowStateStorePaths {
  privateRuntimePath: string;
  manifestPath: string;
  statePath: string;
  lockPath: string;
}

export interface WorkflowStateStoreOptions {
  now?: () => Date;
  randomUUID?: () => string;
  processId?: number;
  isProcessAlive?: (pid: number) => boolean;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  /**
   * When provided, every state publication is journaled first and the
   * on-disk workflow-state.json becomes a projection of the canonical
   * journal (`docs/adr/2026-08-16-Durable-Execution-Journal-And-Replay-Safety.md`
   * §9). Legacy executions omit this and stay on the
   * snapshot-first authority.
   */
  journal?: WorkflowJournalRecorder;
}

export interface InitializeWorkflowExecutionInput {
  manifest: Omit<WorkflowExecutionManifest, "schemaVersion" | "createdAt"> & {
    createdAt?: string;
  };
  executionAttemptId: string;
  steps: WorkflowStepStateSeed[];
}

export interface WorkflowExecutionSnapshot {
  manifest: WorkflowExecutionManifest;
  state: DurableWorkflowState;
}

export interface UpdateWorkflowStateInput {
  expectedRevision: number;
  executionAttemptId: string;
  mutate: (draft: DurableWorkflowState) => void | DurableWorkflowState;
}

export interface ClaimWorkflowExecutionAttemptInput {
  expectedRevision: number;
  expectedOwnerExecutionAttemptId: string;
  nextExecutionAttemptId: string;
}

export interface AuthoritativeWorkflowCancellationInput {
  taskId: string;
  summary: string;
  completedAt?: string;
}

export interface RequestHumanInputInput {
  expectedRevision: number;
  executionAttemptId: string;
  stepId: string;
  interactionId: string;
  sourceArtifact: WorkflowArtifactReference;
  successorStepId: string;
  eligibleRecipients: HumanInputRecipient[];
  prompt?: string;
}

export interface SubmitHumanInputInput {
  expectedRevision: number;
  interactionId: string;
  expectedSourceArtifactSha256: string;
  submission: HumanInputSubmission;
}

export interface ClaimHumanInputContinuationInput {
  expectedRevision: number;
  interactionId: string;
  expectedOwnerExecutionAttemptId: string;
  nextExecutionAttemptId: string;
  continuationAdmissionRequestId: string;
}

/**
 * Receipt-aware recovery classification. A validated immutable child receipt
 * is safe to adopt even when rerunning that step would require manual action
 * or is forbidden entirely.
 */
export async function classifyWorkflowRecoveryWithReceipts(
  rootAssignmentPath: string,
  snapshot: WorkflowExecutionSnapshot,
): Promise<WorkflowRecoveryDisposition> {
  const fallback = classifyWorkflowRecovery(snapshot.state);
  if (
    fallback.disposition === "not_resumable" &&
    terminalTaskStatusForWorkflow(snapshot.state.status)
  ) {
    return fallback;
  }

  const unfinishedStep = findUnfinishedStep(snapshot.state);
  if (!unfinishedStep || unfinishedStep.status === "pending") return fallback;

  const childAssignmentPath = path.join(
    path.dirname(path.resolve(rootAssignmentPath)),
    unfinishedStep.childRunId,
  );
  const receipt = await readWorkflowCompletionReceipt(childAssignmentPath, {
    taskId: snapshot.manifest.taskId,
    rootRunId: snapshot.manifest.rootRunId,
    workflowId: snapshot.manifest.workflowId,
    stepId: unfinishedStep.stepId,
    childRunId: unfinishedStep.childRunId,
  });
  if (!receipt) return fallback;

  return {
    disposition: "automatic",
    stepId: unfinishedStep.stepId,
    policy: unfinishedStep.recoveryPolicy,
    reason:
      `Workflow step '${unfinishedStep.stepId}' has a validated immutable ` +
      "completion receipt that can be adopted without rerunning the child.",
  };
}

export class FileSystemWorkflowStateStore {
  /** Recovery calls this only after proving the owning worker is gone. */
  async blockIndeterminateAgentContinuation(executionAttemptId: string): Promise<WorkflowExecutionSnapshot> {
    return this.withStorageLock(async () => {
      const snapshot = await this.requireSnapshotUnlocked()
      const current = snapshot.state
      assertExecutionOwner(current, executionAttemptId)
      const unknown = current.agentQuestions?.interactions.find((entry) => entry.status === 'resuming' && entry.continuation.providerStartedAt)
      if (!unknown || TERMINAL_WORKFLOW_STATUSES.has(current.status)) return snapshot
      const candidate = cloneJson(current)
      const step = candidate.steps.find((entry) => entry.stepId === unknown.stepId)
      if (!step) throw new WorkflowStateStoreError('corrupt', 'The resumed question has no workflow step.')
      const summary = 'The agent stopped after its continuation provider request began. Its outcome is unknown; start a new run to continue safely.'
      const completedAt = this.now().toISOString()
      candidate.agentQuestions = { schemaVersion: 1, interactions: (current.agentQuestions?.interactions ?? []).map((entry) =>
        ['resolved', 'blocked', 'cancelled'].includes(entry.status) ? entry : {
          ...entry, status: 'blocked', revision: entry.revision + 1, blockedAt: completedAt, blockCode: 'continuation_indeterminate',
        }) }
      candidate.status = 'blocked'
      delete candidate.currentStepId
      step.status = 'blocked'
      step.completedAt = completedAt
      step.summary = summary
      step.error = summary
      candidate.terminalOutcome = buildDurableWorkflowTerminalOutcome({
        workflowId: current.workflowId, status: 'blocked', summary,
        requestedResultType: step.requestedResultType, outputStepId: step.stepId,
      })
      await this.publishAgentQuestionMutation(current, snapshot.manifest, candidate)
      return { manifest: snapshot.manifest, state: candidate }
    })
  }

  async beginAgentQuestionProviderAttempt(unvalidated: unknown): Promise<'started' | 'in_progress'> {
    const input = beginAgentQuestionProviderSchema.parse(unvalidated)
    return this.withStorageLock(async () => {
      const { state: current, manifest } = await this.requireSnapshotUnlocked()
      assertExecutionOwner(current, input.executionAttemptId)
      const interaction = current.agentQuestions?.interactions.find((entry) => entry.interactionId === input.interactionId)
      if (TERMINAL_WORKFLOW_STATUSES.has(current.status) || interaction?.status !== 'resuming' ||
          interaction.continuation.executionAttemptId !== input.executionAttemptId ||
          interaction.invocation.agentId !== input.agentId || interaction.invocation.logicalInvocationId !== input.logicalInvocationId) {
        throw new WorkflowStateStoreError('ownership_conflict', 'Only the resumed agent may start its provider request.')
      }
      if (interaction.continuation.providerStartedAt) return 'in_progress'
      const candidate = cloneJson(current)
      // Recovery transfers an unstarted continuation while leaving its workflow
      // interrupted. The first reserved provider turn starts that same step.
      const step = candidate.steps.find((entry) => entry.stepId === interaction.stepId)
      if (candidate.status === 'interrupted' && step?.status === 'interrupted') {
        candidate.status = 'running'
        step.status = 'running'
      }
      candidate.agentQuestions = { schemaVersion: 1, interactions: (current.agentQuestions?.interactions ?? []).map((entry) =>
        entry.interactionId === interaction.interactionId ? {
          ...interaction, revision: interaction.revision + 1,
          continuation: { ...interaction.continuation, providerStartedAt: this.now().toISOString() },
        } : entry) }
      await this.publishAgentQuestionMutation(current, manifest, candidate)
      return 'started'
    })
  }
  /** Called after independent in-flight work has drained, before releasing the task. */
  async pauseAgentQuestion(unvalidated: unknown): Promise<DurableWorkflowState> {
    const input = pauseAgentQuestionSchema.parse(unvalidated)
    return this.withStorageLock(async () => {
      const { state: current, manifest } = await this.requireSnapshotUnlocked()
      assertExecutionOwner(current, input.executionAttemptId)
      const interaction = current.agentQuestions?.interactions.find((entry) => entry.interactionId === input.interactionId)
      if (!interaction || (interaction.status !== 'pending' && interaction.status !== 'submitted') || TERMINAL_WORKFLOW_STATUSES.has(current.status)) {
        throw new WorkflowStateStoreError('revision_conflict', 'The agent has no unresolved question to wait for.')
      }
      const candidate = cloneJson(current)
      const step = candidate.steps.find((entry) => entry.stepId === interaction.stepId)
      if (!step || !['running', 'awaiting_input'].includes(step.status)) {
        throw new WorkflowStateStoreError('revision_conflict', 'The question step is no longer active.')
      }
      if (candidate.status === 'awaiting_input' && step.status === 'awaiting_input') return candidate
      candidate.status = 'awaiting_input'
      candidate.currentStepId = step.stepId
      step.status = 'awaiting_input'
      await this.publishAgentQuestionMutation(current, manifest, candidate)
      return candidate
    })
  }

  async resolveAgentQuestion(unvalidated: unknown) {
    const input = resolveAgentQuestionSchema.parse(unvalidated)
    return this.withStorageLock(async () => {
      const { state: current, manifest } = await this.requireSnapshotUnlocked()
      assertExecutionOwner(current, input.executionAttemptId)
      const interaction = current.agentQuestions?.interactions.find((entry) => entry.interactionId === input.interactionId)
      if (!interaction) throw new WorkflowStateStoreError('not_found', 'The agent question was not found.')
      if ((interaction.status !== 'resuming' && interaction.status !== 'resolved') ||
          interaction.continuation.executionAttemptId !== input.executionAttemptId ||
          interaction.invocation.agentId !== input.agentId ||
          interaction.invocation.logicalInvocationId !== input.logicalInvocationId) {
        throw new WorkflowStateStoreError('ownership_conflict', 'Only the resumed agent invocation may accept this response.')
      }
      if (interaction.status === 'resolved') {
        if (interaction.resultContent.sha256 === hashWorkflowContent(serializeCanonicalJson(input.result))) return cloneJson(interaction)
        throw new WorkflowStateStoreError('revision_conflict', 'The agent already accepted a different response.')
      }
      if (TERMINAL_WORKFLOW_STATUSES.has(current.status)) {
        throw new WorkflowStateStoreError('revision_conflict', 'The run is no longer accepting agent responses.')
      }
      const resolved: AgentQuestionInteraction = {
        ...interaction, status: 'resolved', revision: interaction.revision + 1,
        resultContent: await this.writeAgentQuestionContent(input.result), resolvedAt: this.now().toISOString(),
      }
      const candidate = cloneJson(current)
      candidate.agentQuestions = {
        schemaVersion: 1, interactions: (current.agentQuestions?.interactions ?? []).map((entry) =>
          entry.interactionId === interaction.interactionId ? resolved : entry),
      }
      await this.publishAgentQuestionMutation(current, manifest, candidate)
      return cloneJson(resolved)
    })
  }

  async claimAgentQuestionContinuation(unvalidated: unknown) {
    const input = claimAgentQuestionContinuationSchema.parse(unvalidated)
    return this.withStorageLock(async () => {
      const { state: current, manifest } = await this.requireSnapshotUnlocked()
      const interaction = current.agentQuestions?.interactions.find((entry) => entry.interactionId === input.interactionId)
      if (!interaction) throw new WorkflowStateStoreError('not_found', 'The agent question was not found.')
      if (interaction.status === 'resuming' || interaction.status === 'resolved') {
        if (interaction.continuation.admissionRequestId === input.continuationAdmissionRequestId &&
            interaction.continuation.executionAttemptId === input.nextExecutionAttemptId &&
            interaction.submission.submissionId === input.submissionId) return cloneJson(current)
        throw new WorkflowStateStoreError('revision_conflict', 'This question has already admitted its continuation.')
      }
      assertExecutionOwner(current, input.expectedOwnerExecutionAttemptId)
      assertSafeIdentifier(input.nextExecutionAttemptId, 'Agent-question continuation attempt')
      assertSafeIdentifier(input.continuationAdmissionRequestId, 'Agent-question continuation admission')
      if (current.status !== 'awaiting_input' || interaction.status !== 'submitted' ||
          interaction.submission.submissionId !== input.submissionId ||
          input.nextExecutionAttemptId === current.ownerExecutionAttemptId) {
        throw new WorkflowStateStoreError('revision_conflict', 'The question has no answer ready for this continuation.')
      }
      const candidate = cloneJson(current)
      candidate.agentQuestions = {
        schemaVersion: 1, interactions: (current.agentQuestions?.interactions ?? []).map((entry) =>
          entry.stepId === interaction.stepId && entry.status === 'submitted'
            ? {
                ...entry, status: 'resuming', revision: entry.revision + 1,
                continuation: {
                  admissionRequestId: input.continuationAdmissionRequestId,
                  executionAttemptId: input.nextExecutionAttemptId, startedAt: this.now().toISOString(),
                },
              }
            : entry),
      }
      const step = candidate.steps.find((entry) => entry.stepId === interaction.stepId)
      if (!step || step.status !== 'awaiting_input') throw new WorkflowStateStoreError('invalid_state', 'The question step is not waiting.')
      step.status = 'running'
      step.attemptCount += 1
      candidate.ownerExecutionAttemptId = input.nextExecutionAttemptId
      candidate.status = 'running'
      await this.publishAgentQuestionMutation(current, manifest, candidate)
      return cloneJson(candidate)
    })
  }

  async acknowledgeResolvedAgentInput(unvalidated: unknown) {
    const input = submitAgentInputSchema.parse(unvalidated)
    const snapshot = await this.loadAgentQuestionSnapshot()
    const interaction = snapshot?.state.agentQuestions?.interactions.find((entry) => entry.interactionId === input.interactionId)
    if (snapshot?.state.taskId !== input.taskId || snapshot.state.sessionId !== input.sessionId ||
        interaction?.status !== 'resolved' || interaction.requestDigest !== input.expectedRequestDigest ||
        interaction.submission.submissionId !== input.submissionId ||
        interaction.submission.answerDigest !== hashWorkflowContent(serializeCanonicalJson(input.answers))) {
      throw new WorkflowStateStoreError('revision_conflict', 'This run is no longer accepting answers.')
    }
    return cloneJson(interaction)
  }

  async submitAgentInput(unvalidated: unknown) {
    const input = submitAgentInputSchema.parse(unvalidated)
    return this.withStorageLock(async () => {
      const { state: current, manifest } = await this.requireSnapshotUnlocked()
      if (input.taskId !== current.taskId || input.sessionId !== current.sessionId) {
        throw new WorkflowStateStoreError('identity_mismatch', 'The answer belongs to a different task or session.')
      }
      const interaction = current.agentQuestions?.interactions.find((entry) => entry.interactionId === input.interactionId)
      if (!interaction) throw new WorkflowStateStoreError('not_found', 'The agent question was not found.')
      if (input.expectedRequestDigest !== interaction.requestDigest) {
        throw new WorkflowStateStoreError('revision_conflict', 'The question has changed.')
      }
      const answerDigest = hashWorkflowContent(serializeCanonicalJson(input.answers))
      if (interaction.status === 'cancelled' || interaction.status === 'blocked') {
        throw new WorkflowStateStoreError('revision_conflict', 'The question was cancelled.')
      }
      if (interaction.status !== 'pending') {
        if (interaction.submission.submissionId === input.submissionId && interaction.submission.answerDigest === answerDigest) {
          return cloneJson(interaction)
        }
        throw new WorkflowStateStoreError('revision_conflict', 'This question already has a different answer.')
      }
      if (TERMINAL_WORKFLOW_STATUSES.has(current.status) || interaction.revision !== input.expectedInteractionRevision) {
        throw new WorkflowStateStoreError('revision_conflict', 'The question is no longer accepting this answer.')
      }
      if (Object.keys(input.answers).length !== interaction.questionIds.length ||
          interaction.questionIds.some((id) => input.answers[id] === undefined)) {
        throw new WorkflowStateStoreError('invalid_state', 'Answer each question exactly once.')
      }
      const answerContent = await this.writeAgentQuestionContent(input.answers)
      const submitted: AgentQuestionInteraction = {
        ...interaction, status: 'submitted', revision: interaction.revision + 1,
        submission: { submissionId: input.submissionId, answerDigest, answerContent, submittedAt: this.now().toISOString() },
      }
      const candidate = cloneJson(current)
      candidate.agentQuestions = {
        schemaVersion: 1,
        interactions: (current.agentQuestions?.interactions ?? []).map((entry) =>
          entry.interactionId === submitted.interactionId ? submitted : entry),
      }
      await this.publishAgentQuestionMutation(current, manifest, candidate)
      return cloneJson(submitted)
    })
  }

  async blockAgentQuestions(unvalidated: unknown): Promise<void> {
    const input = blockAgentQuestionsSchema.parse(unvalidated)
    await this.withStorageLock(async () => {
      const { state: current, manifest } = await this.requireSnapshotUnlocked()
      assertExecutionOwner(current, input.executionAttemptId)
      if (TERMINAL_WORKFLOW_STATUSES.has(current.status)) {
        throw new WorkflowStateStoreError('revision_conflict', 'The run is already terminal.')
      }
      const candidate = cloneJson(current)
      if (!candidate.agentQuestions?.interactions.some((entry) => entry.invocation.agentId === input.agentId)) {
        throw new WorkflowStateStoreError('ownership_conflict', 'The agent has no question in this run.')
      }
      const blockedAt = this.now().toISOString()
      candidate.agentQuestions.interactions = candidate.agentQuestions.interactions.map((entry) => {
        if (entry.status === 'cancelled' || entry.status === 'blocked') return entry
        // An answered round is history the conversation keeps, so it stays
        // `resolved` and its accepted response stays readable. The refusal is
        // recorded on it instead, which is what a recovered run reads to know
        // this agent may not ask again.
        if (entry.status === 'resolved') {
          // The first refusal is why the run stopped. A sibling turn or a
          // duplicate prepared turn arriving afterwards must not restate the
          // cause, which is the guarantee the blocked-status path used to give
          // by refusing to touch an already-blocked round.
          return entry.invocation.agentId === input.agentId && !entry.blockCode
            ? { ...entry, revision: entry.revision + 1, blockedAt, blockCode: input.code }
            : entry
        }
        return { ...entry, status: 'blocked', revision: entry.revision + 1, blockedAt, blockCode: input.code }
      })
      // The still-owned runner settles the blocked child through the existing
      // receipt/terminal-outcome path. No question can admit a continuation.
      candidate.status = 'running'
      const step = candidate.steps.find((entry) => entry.stepId === candidate.currentStepId)
      if (step?.status === 'awaiting_input') step.status = 'running'
      await this.publishAgentQuestionMutation(current, manifest, candidate)
    })
  }

  async requestAgentInput(unvalidated: unknown) {
    const input = requestAgentInputSchema.parse(unvalidated)
    return this.withStorageLock(async () => {
      const { state: current, manifest } = await this.requireSnapshotUnlocked()
      assertExecutionOwner(current, input.executionAttemptId)
      if (TERMINAL_WORKFLOW_STATUSES.has(current.status)) {
        throw new WorkflowStateStoreError('revision_conflict', 'The run is no longer accepting questions.')
      }
      const candidate = cloneJson(current)
      const step = candidate.steps.find((entry) => entry.stepId === input.stepId)
      if (!step || step.childRunId !== (input.invocation.workflowChildRunId ?? input.invocation.childRunId)) {
        throw new WorkflowStateStoreError('ownership_conflict', 'The question does not belong to a running workflow step.')
      }
      const requestDigest = hashWorkflowContent(serializeCanonicalJson(input.request))
      const decision = decideAgentQuestionRound({
        rootRunId: current.rootRunId, agentId: input.invocation.agentId,
        logicalInvocationId: input.invocation.logicalInvocationId, requestDigest,
      }, (current.agentQuestions?.interactions ?? []).map((interaction) => ({
        rootRunId: interaction.rootRunId, agentId: interaction.invocation.agentId,
        logicalInvocationId: interaction.invocation.logicalInvocationId,
        requestDigest: interaction.requestDigest, interactionId: interaction.interactionId,
      })))
      if (decision.kind === 'rejected') return { kind: 'blocked' as const, code: decision.code }
      if (decision.kind === 'replay') return { kind: 'awaiting_input' as const, interactionId: decision.interactionId }
      if (step.status !== 'running' && step.status !== 'awaiting_input') {
        throw new WorkflowStateStoreError('ownership_conflict', 'The question does not belong to a running workflow step.')
      }
      const requestContent = await this.writeAgentQuestionContent(input.request)
      const continuationContent = await this.writeAgentQuestionContent(input.continuation)
      const interactionId = this.randomUUID()
      candidate.agentQuestions ??= { schemaVersion: 1, interactions: [] }
      candidate.agentQuestions.interactions.push({
        schemaVersion: 1, interactionId, revision: 0,
        rootRunId: current.rootRunId, sessionId: current.sessionId, taskId: current.taskId,
        workflowId: current.workflowId, stepId: step.stepId,
        ownerExecutionAttemptId: input.executionAttemptId, invocation: input.invocation,
        requestDigest: requestContent.sha256, requestContent, continuationContent,
        questionIds: input.request.questions.map((_question, index) => `${interactionId}:${index + 1}`),
        requestedAt: this.now().toISOString(), status: 'pending',
      })
      step.status = 'awaiting_input'
      candidate.status = 'awaiting_input'
      candidate.currentStepId = step.stepId
      await this.publishAgentQuestionMutation(current, manifest, candidate)
      return { kind: 'awaiting_input' as const, interactionId }
    })
  }

  /** Inspection does not acquire a writer or reopen a terminal assignment. */
  async loadAgentQuestionSnapshot(): Promise<WorkflowExecutionSnapshot | null> {
    await this.assertStorageInsideAssignment()
    const journal = await readExecutionJournal(this.rootAssignmentPath)
    if (journal.kind === 'not_found') return this.load()
    if (journal.kind !== 'ok') throw new WorkflowStateStoreError('corrupt', 'The question journal cannot be read.')
    const manifest = await readManifestFile(this.paths.manifestPath)
    if (!manifest) throw new WorkflowStateStoreError('corrupt', 'The question assignment has no manifest.')
    this.assertManifestBelongsToAssignment(manifest)
    const streamId = workflowJournalStreamId(manifest.taskId, manifest.workflowId)
    const events = journal.events.filter((event) => event.streamKind === WORKFLOW_STATE_STREAM_KIND && event.streamId === streamId)
    // An enrolled assignment may still be a legacy workflow without a stream.
    if (events.length === 0) return this.load()
    const { state } = validateWorkflowJournalStream(events, streamId)
    validateState(state, manifest)
    return { manifest, state }
  }

  async readAgentQuestion(interactionId: string) {
    const snapshot = await this.loadAgentQuestionSnapshot()
    const interaction = snapshot?.state.agentQuestions?.interactions.find((entry) => entry.interactionId === interactionId)
    if (!interaction) throw new WorkflowStateStoreError('not_found', 'The agent question was not found.')
    return {
      interaction,
      ...(interaction.status === 'resolved' ? {
        result: agentQuestionResultSchema.parse(await this.readAgentQuestionContent(interaction.resultContent)),
      } : {}),
      ...('submission' in interaction && interaction.submission ? {
        answers: agentQuestionAnswersSchema.parse(await this.readAgentQuestionContent(interaction.submission.answerContent)),
      } : {}),
      request: agentQuestionRequestSchema.parse(await this.readAgentQuestionContent(interaction.requestContent)),
      continuation: agentQuestionContinuationSchema.parse(await this.readAgentQuestionContent(interaction.continuationContent)),
    }
  }

  /**
   * What the inline card shows: the question, and its answers once they exist.
   *
   * The display projection deliberately excludes the saved prompts, so reading
   * a whole interaction to build it costs another journal replay and
   * deserializes a continuation bounded in the millions of characters that the
   * caller then discards. Taking an interaction the caller already holds keeps
   * a whole run's list to the one snapshot it was read from. A tampered
   * continuation is still rejected where it is used, on the resume read.
   */
  async readAgentQuestionDisplay(interaction: AgentQuestionInteraction) {
    return {
      request: agentQuestionRequestSchema.parse(await this.readAgentQuestionContent(interaction.requestContent)),
      ...('submission' in interaction && interaction.submission ? {
        answers: agentQuestionAnswersSchema.parse(await this.readAgentQuestionContent(interaction.submission.answerContent)),
      } : {}),
    }
  }

  /** Caller holds the workflow lock and has already validated the operation's authority. */
  private async publishAgentQuestionMutation(
    current: DurableWorkflowState,
    manifest: WorkflowExecutionManifest,
    candidate: DurableWorkflowState,
  ): Promise<void> {
    candidate.revision = current.revision + 1
    candidate.updatedAt = this.now().toISOString()
    validateStateTransition(current, candidate)
    validateState(candidate, manifest)
    await this.publishWorkflowState(candidate)
  }

  private async writeAgentQuestionContent(value: unknown): Promise<AgentQuestionContentReference> {
    return writeAgentQuestionContentFile(this.rootAssignmentPath, this.paths.privateRuntimePath, value)
  }

  private async readAgentQuestionContent(unvalidated: AgentQuestionContentReference): Promise<unknown> {
    return readAgentQuestionContentFile(this.rootAssignmentPath, this.paths.privateRuntimePath, unvalidated)
  }

  readonly paths: WorkflowStateStorePaths;

  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly lockOptions: FileLockOptions;
  private readonly journal: WorkflowJournalRecorder | undefined;

  constructor(
    readonly rootAssignmentPath: string,
    options: WorkflowStateStoreOptions = {},
  ) {
    const normalizedAssignmentPath = path.resolve(rootAssignmentPath);
    const { privateRuntimePath } = getRunRuntimePaths(normalizedAssignmentPath);
    this.rootAssignmentPath = normalizedAssignmentPath;
    this.paths = {
      privateRuntimePath,
      manifestPath: path.join(
        privateRuntimePath,
        WORKFLOW_EXECUTION_MANIFEST_FILENAME,
      ),
      statePath: path.join(privateRuntimePath, WORKFLOW_STATE_FILENAME),
      lockPath: path.join(privateRuntimePath, WORKFLOW_STATE_LOCK_FILENAME),
    };
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.lockOptions = {
      processId: options.processId ?? process.pid,
      isProcessAlive: options.isProcessAlive ?? defaultIsProcessAlive,
      timeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      retryMs: options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS,
    };
    this.journal = options.journal;
  }

  /**
   * The workflow lock, taken only while `.runtime` is still this assignment's
   * own folder.
   *
   * The store resolves its paths once, when it is opened. A private runtime
   * folder replaced by a link afterwards would carry the lock, the manifest
   * and the state to wherever the link points, so every locked operation checks
   * again first.
   */
  private async withStorageLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.assertStorageInsideAssignment();
    return withWorkflowFileLock(this.paths.lockPath, this.lockOptions, operation);
  }

  /**
   * Refuses a private runtime folder that is now a link, not a folder, or
   * resolves outside the assignment. A folder that does not exist yet is
   * allowed: nothing can be reached through it, and `initialize` creates it.
   */
  private async assertStorageInsideAssignment(): Promise<void> {
    let stat: Stats;
    try {
      stat = await fs.lstat(this.paths.privateRuntimePath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      !resolveExistingPathInside(this.rootAssignmentPath, this.paths.privateRuntimePath)
    ) {
      throw new WorkflowStateStoreError(
        "corrupt",
        "The workflow storage is outside its assignment.",
      );
    }
  }

  /**
   * Journal-first publication (Phase 8 ADR §9): when a journal recorder is
   * attached, the canonical snapshot event is durably appended before the
   * on-disk workflow-state.json projection is rewritten. The projection is
   * never written ahead of the journal.
   */
  private async publishWorkflowState(
    candidate: DurableWorkflowState,
  ): Promise<void> {
    if (this.journal) {
      await this.journal.recordSnapshot(candidate);
    }
    await writeJsonAtomic(this.paths.statePath, candidate);
  }

  /**
   * Create an immutable manifest and revision-zero journal. Repeating the call
   * with the exact same attempt and definitions returns the persisted state,
   * including its already allocated child IDs.
   */
  async initialize(
    input: InitializeWorkflowExecutionInput,
  ): Promise<WorkflowExecutionSnapshot> {
    return this.withStorageLock(
      async () => {
        assertSafeIdentifier(input.executionAttemptId, "Execution attempt ID");
        const existingManifest = await readManifestFile(
          this.paths.manifestPath,
        );
        const existingState = await readStateFile(
          this.paths.statePath,
          input.steps,
        );

        if (existingManifest) {
          assertManifestMatchesInitialization(existingManifest, input.manifest);
          this.assertManifestBelongsToAssignment(existingManifest);
        }

        if (existingState) {
          if (!existingManifest) {
            throw new WorkflowStateStoreError(
              "corrupt",
              "Workflow state exists without its immutable execution manifest.",
            );
          }
          validateState(existingState, existingManifest);
          if (
            existingState.ownerExecutionAttemptId !== input.executionAttemptId
          ) {
            throw new WorkflowStateStoreError(
              "ownership_conflict",
              `Workflow is owned by execution attempt '${existingState.ownerExecutionAttemptId}', not '${input.executionAttemptId}'.`,
            );
          }
          assertStateMatchesSeeds(existingState, input.steps);
          return cloneJson({
            manifest: existingManifest,
            state: existingState,
          });
        }

        const manifest =
          existingManifest ?? buildManifest(input.manifest, this.now);
        this.assertManifestBelongsToAssignment(manifest);
        const state = buildInitialState({
          manifest,
          executionAttemptId: input.executionAttemptId,
          seeds: input.steps,
          randomUUID: this.randomUUID,
        });
        validateState(state, manifest);

        if (!existingManifest) {
          await writeJsonAtomic(this.paths.manifestPath, manifest);
        }
        await this.publishWorkflowState(state);
        return cloneJson({ manifest, state });
      },
    );
  }

  /**
   * Load a complete journal snapshot. Partial, corrupt, or mismatched data
   * throws.
   *
   * For a journal-enrolled assignment `workflow-state.json` is a projection of
   * the canonical journal, so a projection that is missing, unreadable, or
   * behind the journal is rebuilt here instead of failing the execution
   * (Phase 8 ADR §9, AC9). This is the only lock acquisition in that
   * transaction: the workflow lock is a cross-process file lock and is not
   * reentrant, so every helper below runs unlocked, and the six mutators —
   * which read the projection while already holding the lock — go through
   * `requireSnapshotUnlocked` rather than through here.
   */
  async load(): Promise<WorkflowExecutionSnapshot | null> {
    return this.withStorageLock(() =>
      this.loadUnlocked(),
    );
  }

  /**
   * Replaces one pending offer with the same question asked about a new pair.
   *
   * The application default can move while a run waits. The offer then names a
   * pair that can no longer run, and refusing the approval alone would leave
   * the wait advertising it forever. This asks the question again instead.
   *
   * Fenced on the offer being replaced as well as the revision. A revision says
   * the state has not moved; it cannot say *which* question is being answered,
   * and two refreshes racing — a retried approval, a tab left open — would
   * otherwise let the later one overwrite an offer the user is already looking
   * at. The identity check runs inside the same locked transaction as the
   * write, so the pair cannot separate.
   *
   * Only the proposed pair and the revision change. Who failed, on what, in
   * which invocation and for what reason are carried across: they describe the
   * failure that earned the offer, and recomputing them here would let a
   * refresh quietly become a different retry.
   */
  async refreshModelChoiceOffer(input: {
    expectedRevision: number;
    offerId: string;
    proposedDefault: ProviderModelPair;
  }): Promise<{
    offer: ModelChoiceOffer;
    revision: number;
    stepId: string;
  }> {
    const snapshot = await this.requireSnapshot();
    const owner = snapshot.state.ownerExecutionAttemptId;
    let refreshed: { offer: ModelChoiceOffer; stepId: string } | undefined;
    const state = await this.update({
      expectedRevision: input.expectedRevision,
      executionAttemptId: owner,
      mutate: (draft) => {
        const target = draft.steps.find(
          (candidate) => candidate.modelChoice?.offerId === input.offerId,
        );
        const stale = target?.modelChoice;
        if (!target || !stale) {
          throw new WorkflowStateStoreError(
            "invalid_state",
            `No workflow step is waiting on model choice '${input.offerId}'.`,
          );
        }
        const offer: ModelChoiceOffer = {
          ...stale,
          offerId: modelChoiceOfferId({
            scope: stale.scope,
            agentName: stale.agentName,
            expectedRevision: String(draft.revision),
            proposedDefault: input.proposedDefault,
          }),
          expectedRevision: String(draft.revision),
          proposedDefault: { ...input.proposedDefault },
        };
        target.modelChoice = offer;
        refreshed = { offer, stepId: target.stepId };
      },
    });
    if (!refreshed) {
      throw new WorkflowStateStoreError(
        "invalid_state",
        `Model choice '${input.offerId}' was not refreshed.`,
      );
    }
    return { ...refreshed, revision: state.revision };
  }

  /**
   * Turns one pending offer into the authorization its step will run under.
   *
   * The offer is cleared as the authorization is written: one is a question and
   * the other its answer, and both live at once would leave no way to say
   * whether the user has decided. The step and the workflow return to
   * `running`, which is the only way either can reach a result — an approval
   * can never be inferred from a completion.
   */
  async approveModelChoice(input: {
    expectedRevision: number;
    offerId: string;
  }): Promise<DurableWorkflowState> {
    const snapshot = await this.requireSnapshot();
    const step = snapshot.state.steps.find(
      (candidate) => candidate.modelChoice?.offerId === input.offerId,
    );
    const offer = step?.modelChoice;
    if (!step || !offer) {
      throw new WorkflowStateStoreError(
        "invalid_state",
        `No workflow step is waiting on model choice '${input.offerId}'.`,
      );
    }
    return this.update({
      expectedRevision: input.expectedRevision,
      executionAttemptId: snapshot.state.ownerExecutionAttemptId,
      mutate(draft) {
        const target = draft.steps.find(
          (candidate) => candidate.stepId === step.stepId,
        );
        if (!target) return;
        delete target.modelChoice;
        target.approvedModelChoice = {
          offerId: offer.offerId,
          agentName: offer.agentName,
          // Carried so the permission covers the one invocation the user was
          // asked about, and not every attempt that agent makes.
          ...(offer.logicalInvocationId
            ? { logicalInvocationId: offer.logicalInvocationId }
            : {}),
          failedChoice: { ...offer.failedChoice },
          proposedDefault: { ...offer.proposedDefault },
        };
        target.status = "running";
        draft.status = "running";
      },
    });
  }

  async requireSnapshot(): Promise<WorkflowExecutionSnapshot> {
    const snapshot = await this.load();
    if (!snapshot) {
      throw new WorkflowStateStoreError(
        "not_found",
        "Durable workflow state was not found.",
      );
    }
    return snapshot;
  }

  /**
   * Rebuild the projection from the canonical journal for an external caller.
   * Retains one lock acquisition and delegates to the same unlocked path
   * `load()` uses (ADR §9, AC9).
   */
  async rebuildStateProjection(
    journal: WorkflowJournalRecorder,
  ): Promise<{ lastAppliedSequence: number }> {
    return this.withStorageLock(() =>
      this.rebuildStateProjectionUnlocked(journal),
    );
  }

  /** Read the immutable execution manifest without requiring state. */
  async readExecutionManifest(): Promise<WorkflowExecutionManifest> {
    await this.assertStorageInsideAssignment();
    const manifest = await readManifestFile(this.paths.manifestPath);
    if (!manifest) {
      throw new WorkflowStateStoreError(
        "not_found",
        "Workflow execution manifest was not found.",
      );
    }
    this.assertManifestBelongsToAssignment(manifest);
    return manifest;
  }

  /**
   * Publish workflow-state.json as a derived projection (Phase 8 ADR §9).
   * Used by journal replay; it never appends to the journal itself.
   */
  async writeStateProjection(state: DurableWorkflowState): Promise<void> {
    const manifest = await this.readExecutionManifest();
    validateState(state, manifest);
    await writeJsonAtomic(this.paths.statePath, state);
  }

  /** Today's read: the projection is authoritative and must be complete. */
  private async readSnapshotUnlocked(): Promise<WorkflowExecutionSnapshot | null> {
    const manifest = await readManifestFile(this.paths.manifestPath);
    const state = await readStateFile(this.paths.statePath);
    if (!manifest && !state) return null;
    if (!manifest || !state) {
      throw new WorkflowStateStoreError(
        "corrupt",
        "Workflow execution is incomplete: both manifest and state are required.",
      );
    }
    this.assertManifestBelongsToAssignment(manifest);
    validateState(state, manifest);
    return cloneJson({ manifest, state });
  }

  private async requireSnapshotUnlocked(): Promise<WorkflowExecutionSnapshot> {
    const snapshot = await this.readSnapshotUnlocked();
    if (!snapshot) {
      throw new WorkflowStateStoreError(
        "not_found",
        "Durable workflow state was not found.",
      );
    }
    return snapshot;
  }

  /**
   * Classify the projection against the canonical journal and repair it when
   * the journal is the authority for this assignment. An unenrolled
   * assignment has no journal to answer with and keeps today's read exactly.
   */
  private async loadUnlocked(): Promise<WorkflowExecutionSnapshot | null> {
    const journal = this.journal;
    if (!journal) return this.readSnapshotUnlocked();

    const manifest = await this.readManifestForRebuildUnlocked(journal);
    if (!manifest) {
      // No manifest and no recorded state: an execution that never started.
      return this.readSnapshotUnlocked();
    }

    const recorded = await journal.readRecordedState({
      taskId: manifest.taskId,
      workflowId: manifest.workflowId,
    });
    if (!recorded) return this.readSnapshotUnlocked();

    const projected = await this.readUsableProjectionUnlocked(manifest);
    if (projected && projected.revision === recorded.state.revision) {
      return this.readSnapshotUnlocked();
    }
    if (projected && projected.revision > recorded.state.revision) {
      // After AC5 every authoritative mutator journals first, so nothing may
      // legitimately publish a projection the journal has never seen.
      throw new WorkflowStateStoreError(
        "revision_conflict",
        `Workflow projection revision ${projected.revision} is ahead of the canonical journal's revision ${recorded.state.revision}.`,
      );
    }

    // Missing, unreadable, schema-invalid, or behind: the journal answers.
    await this.publishRebuiltProjectionUnlocked(journal, manifest, recorded);
    return this.readSnapshotUnlocked();
  }

  /**
   * The immutable manifest, which is the rebuild's only identity source: a
   * workflow journal event's payload is `{ state }` and the stream id is
   * derived from it, so nothing in the journal can reconstruct the manifest.
   * A manifest that is missing or unreadable therefore fails closed and never
   * reaches a rebuild. `null` means an execution that has not started yet.
   */
  private async readManifestForRebuildUnlocked(
    journal: WorkflowJournalRecorder,
  ): Promise<WorkflowExecutionManifest | null> {
    let manifest: WorkflowExecutionManifest | null;
    try {
      manifest = await readManifestFile(this.paths.manifestPath);
    } catch (error) {
      throw new WorkflowStateStoreError(
        errorCodeOr(error, "corrupt"),
        "The workflow execution manifest could not be read, so this journal-enrolled workflow cannot be recovered: " +
          (error instanceof Error ? error.message : String(error)),
        { cause: error },
      );
    }
    if (!manifest) {
      // An absent manifest is normal before `initialize`, and unrecoverable
      // once the journal holds state whose identity only the manifest carries.
      if (await journal.hasRecordedState()) {
        throw new WorkflowStateStoreError(
          "not_found",
          "The workflow execution manifest is missing while the canonical journal holds workflow state, so this workflow cannot be recovered.",
        );
      }
      return null;
    }
    this.assertManifestBelongsToAssignment(manifest);
    return manifest;
  }

  /**
   * The projection as a loader can actually use it. `null` when it is absent,
   * unparsable, or fails the workflow-state schema — every case the canonical
   * journal can answer. An identity that disagrees with the manifest is not
   * one of them and still fails closed.
   */
  private async readUsableProjectionUnlocked(
    manifest: WorkflowExecutionManifest,
  ): Promise<DurableWorkflowState | null> {
    try {
      const state = await readStateFile(this.paths.statePath);
      if (!state) return null;
      validateState(state, manifest);
      return state;
    } catch (error) {
      if (isRebuildableProjectionError(error)) return null;
      throw error;
    }
  }

  private async rebuildStateProjectionUnlocked(
    journal: WorkflowJournalRecorder,
  ): Promise<{ lastAppliedSequence: number }> {
    const manifest = await this.readExecutionManifest();
    const recorded = await journal.readRecordedState({
      taskId: manifest.taskId,
      workflowId: manifest.workflowId,
    });
    if (!recorded) {
      throw new WorkflowStateStoreError(
        "not_found",
        `No workflow journal events found for workflow '${manifest.workflowId}' of task '${manifest.taskId}'.`,
      );
    }
    await this.publishRebuiltProjectionUnlocked(journal, manifest, recorded);
    return { lastAppliedSequence: recorded.lastSequence };
  }

  private async publishRebuiltProjectionUnlocked(
    journal: WorkflowJournalRecorder,
    manifest: WorkflowExecutionManifest,
    recorded: WorkflowJournalRecordedState,
  ): Promise<void> {
    validateState(recorded.state, manifest);
    await writeJsonAtomic(this.paths.statePath, recorded.state);
    await journal.recordProjectionApplied(recorded.lastSequence);
  }

  /**
   * Read and validate the current manifest+state under the workflow lock and
   * hash both source files, for import as a `workflow.migration.baseline`
   * journal event (Phase 8 ADR §9).
   */
  async readValidatedBaseline(): Promise<{
    manifest: WorkflowExecutionManifest;
    state: DurableWorkflowState;
    sourceHashes: WorkflowBaselineSourceHashes;
  }> {
    return this.withStorageLock(
      async () => {
        const snapshot = await this.requireSnapshotUnlocked();
        const stateHash = await hashFile(this.paths.statePath);
        const manifestHash = await hashFile(this.paths.manifestPath);
        return {
          manifest: snapshot.manifest,
          state: snapshot.state,
          sourceHashes: {
            stateSha256: stateHash.sha256,
            stateByteLength: stateHash.byteLength,
            manifestSha256: manifestHash.sha256,
            manifestByteLength: manifestHash.byteLength,
          },
        };
      },
    );
  }

  /** Revision-CAS update fenced to the currently owning execution attempt. */
  async update(input: UpdateWorkflowStateInput): Promise<DurableWorkflowState> {
    return this.withStorageLock(
      async () => {
        const snapshot = await this.requireSnapshotUnlocked();
        const current = snapshot.state;
        assertExpectedRevision(current, input.expectedRevision);
        assertExecutionOwner(current, input.executionAttemptId);
        if (TERMINAL_WORKFLOW_STATUSES.has(current.status)) {
          throw new WorkflowStateStoreError(
            "invalid_state",
            `Terminal workflow state '${current.status}' is immutable.`,
          );
        }

        const draft = cloneJson(current);
        const returned = input.mutate(draft);
        const candidate = returned ?? draft;
        assertControlledFieldsUnchanged(current, candidate);
        candidate.revision = current.revision + 1;
        candidate.updatedAt = this.now().toISOString();
        validateStateTransition(current, candidate);
        validateState(candidate, snapshot.manifest);
        await this.publishWorkflowState(candidate);
        return cloneJson(candidate);
      },
    );
  }

  /** Persist a durable workflow pause before the worker releases its task slot. */
  async requestHumanInput(
    input: RequestHumanInputInput,
  ): Promise<DurableWorkflowState> {
    return this.withStorageLock(
      async () => {
        const snapshot = await this.requireSnapshotUnlocked();
        const current = snapshot.state;
        const currentStep = current.steps.find(
          (step) => step.stepId === input.stepId,
        );
        const existingInteraction = currentStep?.humanInput;
        if (existingInteraction?.interactionId === input.interactionId) {
          return cloneJson(current);
        }
        assertExpectedRevision(current, input.expectedRevision);
        assertExecutionOwner(current, input.executionAttemptId);
        if (TERMINAL_WORKFLOW_STATUSES.has(current.status)) {
          throw new WorkflowStateStoreError(
            "invalid_state",
            `Cannot request human input from terminal workflow state '${current.status}'.`,
          );
        }
        if (!currentStep || currentStep.stepType !== "human-in-the-loop") {
          throw new WorkflowStateStoreError(
            "invalid_state",
            `Workflow step '${input.stepId}' is not a human-in-the-loop step.`,
          );
        }
        if (currentStep.status !== "pending") {
          throw new WorkflowStateStoreError(
            "invalid_state",
            `Human-input workflow step '${input.stepId}' is already '${currentStep.status}'.`,
          );
        }
        const successor = current.steps[currentStep.stepIndex + 1];
        if (!successor || successor.stepId !== input.successorStepId) {
          throw new WorkflowStateStoreError(
            "invalid_state",
            `Human-input workflow step '${input.stepId}' must name its immediate successor.`,
          );
        }

        const candidate = buildHumanInputRequestCandidate(
          current,
          currentStep,
          input,
          this.now,
        );
        candidate.revision = current.revision + 1;
        candidate.updatedAt = this.now().toISOString();
        validateStateTransition(current, candidate);
        validateState(candidate, snapshot.manifest);
        await this.publishWorkflowState(candidate);
        return cloneJson(candidate);
      },
    );
  }

  /** Store an immutable, hash-fenced human submission without starting a worker. */
  async submitHumanInput(
    input: SubmitHumanInputInput,
  ): Promise<DurableWorkflowState> {
    return this.withStorageLock(
      async () => {
        if (
          input.submission.canonicalHash !==
          hashHumanInputSubmission(input.submission)
        ) {
          throw new WorkflowStateStoreError(
            "invalid_state",
            "Human-input submission canonical hash does not match its contents.",
          );
        }
        const snapshot = await this.requireSnapshotUnlocked();
        const current = snapshot.state;
        const { step, interaction } = findHumanInputInteraction(
          current,
          input.interactionId,
        );
        if (
          TERMINAL_WORKFLOW_STATUSES.has(current.status) ||
          interaction.status === "cancelled"
        ) {
          throw new WorkflowStateStoreError(
            "revision_conflict",
            `Human-input interaction '${input.interactionId}' is no longer accepting feedback.`,
          );
        }
        if (
          interaction.status === "submitted" ||
          interaction.status === "consumed"
        ) {
          if (
            interaction.submission &&
            sameHumanInputSubmission(interaction.submission, input.submission)
          ) {
            return cloneJson(current);
          }
          throw new WorkflowStateStoreError(
            "revision_conflict",
            `Human-input interaction '${input.interactionId}' already has a different submission.`,
          );
        }
        assertExpectedRevision(current, input.expectedRevision);
        if (
          current.status !== "awaiting_input" ||
          step.status !== "awaiting_input"
        ) {
          throw new WorkflowStateStoreError(
            "revision_conflict",
            `Human-input interaction '${input.interactionId}' is no longer awaiting feedback.`,
          );
        }
        if (interaction.status !== "pending") {
          throw new WorkflowStateStoreError(
            "revision_conflict",
            `Human-input interaction '${input.interactionId}' is '${interaction.status}'.`,
          );
        }
        if (
          interaction.sourceArtifact.sha256 !==
          input.expectedSourceArtifactSha256
        ) {
          throw new WorkflowStateStoreError(
            "revision_conflict",
            `Human-input interaction '${input.interactionId}' source artifact has changed.`,
          );
        }

        const candidate = buildHumanInputSubmissionCandidate(current, input);
        candidate.revision = current.revision + 1;
        candidate.updatedAt = this.now().toISOString();
        validateStateTransition(current, candidate);
        validateState(candidate, snapshot.manifest);
        await this.publishWorkflowState(candidate);
        return cloneJson(candidate);
      },
    );
  }

  /**
   * Give a continuation worker ownership after feedback is persisted. Unlike
   * crash recovery, this transition neither interrupts work nor increments the
   * recovery counter.
   */
  async claimHumanInputContinuation(
    input: ClaimHumanInputContinuationInput,
  ): Promise<DurableWorkflowState> {
    return this.withStorageLock(
      async () => {
        const snapshot = await this.requireSnapshotUnlocked();
        const current = snapshot.state;
        assertExpectedRevision(current, input.expectedRevision);
        assertExecutionOwner(current, input.expectedOwnerExecutionAttemptId);
        assertSafeIdentifier(
          input.nextExecutionAttemptId,
          "Continuation execution attempt ID",
        );
        assertSafeIdentifier(
          input.continuationAdmissionRequestId,
          "Continuation admission request ID",
        );
        if (input.nextExecutionAttemptId === current.ownerExecutionAttemptId) {
          throw new WorkflowStateStoreError(
            "ownership_conflict",
            "A continuation attempt must use a new execution attempt ID.",
          );
        }
        const { interaction } = findHumanInputInteraction(
          current,
          input.interactionId,
        );
        if (
          current.status !== "awaiting_input" ||
          interaction.status !== "submitted"
        ) {
          throw new WorkflowStateStoreError(
            "revision_conflict",
            `Human-input interaction '${input.interactionId}' is not ready for continuation.`,
          );
        }

        const candidate = buildHumanInputContinuationClaimCandidate(
          current,
          input,
        );
        candidate.revision = current.revision + 1;
        candidate.updatedAt = this.now().toISOString();
        validateHumanInputContinuationClaim(
          current,
          candidate,
          input.interactionId,
        );
        validateState(candidate, snapshot.manifest);
        await this.publishWorkflowState(candidate);
        return cloneJson(candidate);
      },
    );
  }

  /**
   * Hand ownership to the attempt admitted to run an approved model choice.
   *
   * The approval and the run that acts on it are separate: the API records the
   * decision, and the runtime later starts a *new* execution attempt for it.
   * Without this the continuation finds a workflow owned by the attempt that
   * failed and stops before dispatching, because the only continuation it knew
   * about was a submitted human input — which a model-choice approval never
   * produces.
   */
  async claimModelChoiceContinuation(input: {
    expectedRevision: number;
    stepId: string;
    expectedOwnerExecutionAttemptId: string;
    nextExecutionAttemptId: string;
    continuationAdmissionRequestId: string;
  }): Promise<DurableWorkflowState> {
    return this.withStorageLock(
      async () => {
        const snapshot = await this.requireSnapshotUnlocked();
        const current = snapshot.state;
        assertExpectedRevision(current, input.expectedRevision);
        assertExecutionOwner(current, input.expectedOwnerExecutionAttemptId);
        assertSafeIdentifier(
          input.nextExecutionAttemptId,
          "Continuation execution attempt ID",
        );
        assertSafeIdentifier(
          input.continuationAdmissionRequestId,
          "Continuation admission request ID",
        );
        if (input.nextExecutionAttemptId === current.ownerExecutionAttemptId) {
          throw new WorkflowStateStoreError(
            "ownership_conflict",
            "A continuation attempt must use a new execution attempt ID.",
          );
        }
        const step = current.steps.find(
          (candidate) => candidate.stepId === input.stepId,
        );
        if (!step?.approvedModelChoice) {
          throw new WorkflowStateStoreError(
            "revision_conflict",
            `Workflow step '${input.stepId}' has no approved model choice to continue.`,
          );
        }
        // One approval authorizes one continuation. The lock fences two claims
        // racing each other; it says nothing about a later caller that rereads
        // the state and claims the same approval again under a fresh attempt,
        // which is exactly what a retransmitted admission looks like.
        if (step.modelChoiceContinuationAdmissionRequestId !== undefined) {
          throw new WorkflowStateStoreError(
            "revision_conflict",
            `Workflow step '${input.stepId}' has already admitted a continuation ` +
              `for its approved model choice.`,
          );
        }
        // A step that already produced its result is not waiting on anything.
        if (TERMINAL_STEP_STATUSES.has(step.status)) {
          throw new WorkflowStateStoreError(
            "revision_conflict",
            `Workflow step '${input.stepId}' is '${step.status}' and cannot continue.`,
          );
        }
        const candidate = cloneJson(current);
        const candidateStep = candidate.steps.find(
          (entry) => entry.stepId === input.stepId,
        );
        if (!candidateStep) {
          invalidState(
            `Workflow step '${input.stepId}' is missing from the cloned workflow state.`,
          );
        }
        candidate.ownerExecutionAttemptId = input.nextExecutionAttemptId;
        candidate.status = "running";
        candidateStep.modelChoiceContinuationAdmissionRequestId =
          input.continuationAdmissionRequestId;
        // The approval left the step marked as running under the attempt that
        // failed, and that attempt is gone. Saying so is what lets the new
        // owner launch it: a step is not resumed from "running", it is
        // relaunched from an execution that ended without a result.
        for (const entry of candidate.steps) {
          if (entry.status === "launching" || entry.status === "running") {
            entry.status = "interrupted";
          }
        }
        candidate.revision = current.revision + 1;
        candidate.updatedAt = this.now().toISOString();
        validateState(candidate, snapshot.manifest);
        await this.publishWorkflowState(candidate);
        return cloneJson(candidate);
      },
    );
  }

  /**
   * Atomically fence a dead worker and give a replacement attempt ownership.
   * Any in-flight step is recorded as interrupted before the replacement runs.
   */
  async claimExecutionAttempt(
    input: ClaimWorkflowExecutionAttemptInput,
  ): Promise<DurableWorkflowState> {
    return this.withStorageLock(
      async () => {
        const snapshot = await this.requireSnapshotUnlocked();
        const current = snapshot.state;
        assertExpectedRevision(current, input.expectedRevision);
        assertExecutionOwner(current, input.expectedOwnerExecutionAttemptId);
        assertSafeIdentifier(
          input.nextExecutionAttemptId,
          "Next execution attempt ID",
        );
        if (input.nextExecutionAttemptId === current.ownerExecutionAttemptId) {
          throw new WorkflowStateStoreError(
            "ownership_conflict",
            "A recovery attempt must use a new execution attempt ID.",
          );
        }
        if (TERMINAL_WORKFLOW_STATUSES.has(current.status)) {
          throw new WorkflowStateStoreError(
            "invalid_state",
            `Cannot claim terminal workflow state '${current.status}'.`,
          );
        }

        if (current.agentQuestions?.interactions.some((interaction) =>
          interaction.status === 'resuming' && interaction.continuation.providerStartedAt)) {
          throw new WorkflowStateStoreError('invalid_state', 'A started question continuation has an unknown provider outcome.')
        }
        const candidate = cloneJson(current);
        if (candidate.agentQuestions) {
          candidate.agentQuestions.interactions = candidate.agentQuestions.interactions.map((interaction) =>
            interaction.status === 'resuming'
              ? { ...interaction, revision: interaction.revision + 1,
                  continuation: { ...interaction.continuation, executionAttemptId: input.nextExecutionAttemptId } }
              : interaction)
        }
        candidate.ownerExecutionAttemptId = input.nextExecutionAttemptId;
        candidate.recoveryCount += 1;
        candidate.status = "interrupted";
        candidate.revision += 1;
        candidate.updatedAt = this.now().toISOString();
        for (const step of candidate.steps) {
          if (step.status === "launching" || step.status === "running") {
            step.status = "interrupted";
          }
        }
        validateClaimTransition(current, candidate);
        validateState(candidate, snapshot.manifest);
        await this.publishWorkflowState(candidate);
        return cloneJson(candidate);
      },
    );
  }

  /**
   * Converge the workflow to a cancellation that already won the fenced
   * session-task CAS. This is the sole exception to terminal journal
   * immutability: a worker may have committed a terminal journal in the small
   * window after the task cancellation became authoritative. The override is
   * serialized by the workflow lock and leaves completed step evidence intact.
   */
  async cancelFromAuthoritativeTask(
    input: AuthoritativeWorkflowCancellationInput,
  ): Promise<DurableWorkflowState | null> {
    return this.withStorageLock(
      async () => {
        assertSafeIdentifier(
          input.taskId,
          "Authoritative cancellation task ID",
        );
        if (input.completedAt !== undefined) {
          assertIsoTimestamp(
            input.completedAt,
            "Authoritative cancellation time",
          );
        }
        // Another task's cancellation is refused before anything below can
        // repair the projection, which it has no claim to rewrite. The
        // manifest is the execution's identity; the journal stream is derived
        // from it.
        const identity = await readManifestFile(this.paths.manifestPath);
        if (identity) {
          this.assertManifestBelongsToAssignment(identity);
          if (identity.taskId !== input.taskId) {
            throw new WorkflowStateStoreError(
              "identity_mismatch",
              "Authoritative cancellation belongs to a different session task.",
            );
          }
        }
        // The read `load()` makes. A crash between a journal append and the
        // projection write leaves the projection behind the journal; building
        // on it would reuse a revision the journal already holds, which the
        // journal refuses, so the cancellation could never land. This rebuilds
        // the projection from the journal first, and fails closed where the
        // journal cannot answer. Without a journal it is the projection read
        // this method always made.
        const snapshot = await this.loadUnlocked();
        if (!snapshot) return null;
        const { manifest, state: current } = snapshot;
        if (
          manifest.taskId !== input.taskId ||
          current.taskId !== input.taskId
        ) {
          throw new WorkflowStateStoreError(
            "identity_mismatch",
            "Authoritative cancellation belongs to a different session task.",
          );
        }
        if (current.status === "cancelled") return cloneJson(current);

        const candidate = cloneJson(current);
        const completedAt = input.completedAt ?? this.now().toISOString();
        const outputStep =
          candidate.steps.find(
            (step) => step.stepId === candidate.currentStepId,
          ) ?? candidate.steps.at(-1);
        if (!outputStep) {
          invalidState("Cannot cancel a workflow that has no steps.");
        }
        candidate.status = "cancelled";
        delete candidate.currentStepId;
        for (const step of candidate.steps) {
          if (
            [
              "awaiting_input",
              "launching",
              "running",
              "interrupted",
              "indeterminate",
            ].includes(step.status)
          ) {
            step.status = "cancelled";
            step.summary = input.summary;
            step.error = input.summary;
            step.completedAt = completedAt;
            if (step.humanInput) {
              step.humanInput.status = "cancelled";
            }
          }
        }
        candidate.terminalOutcome = buildDurableWorkflowTerminalOutcome({
          workflowId: candidate.workflowId,
          status: "cancelled",
          summary: input.summary,
          requestedResultType: outputStep.requestedResultType,
          outputStepId: outputStep.stepId,
        });
        assertControlledFieldsUnchanged(current, candidate);
        if (candidate.agentQuestions) {
          candidate.agentQuestions.interactions = candidate.agentQuestions.interactions.map((interaction) =>
            interaction.status === 'resolved' || interaction.status === 'cancelled' ? interaction : {
              ...interaction, status: 'cancelled', revision: interaction.revision + 1,
              cancelledAt: completedAt, cancellationReason: input.summary.slice(0, 2_000),
            })
        }
        candidate.revision = current.revision + 1;
        candidate.updatedAt = this.now().toISOString();
        validateState(candidate, manifest);
        await this.publishWorkflowState(candidate);
        return cloneJson(candidate);
      },
    );
  }

  private assertManifestBelongsToAssignment(
    manifest: WorkflowExecutionManifest,
  ): void {
    if (path.basename(this.rootAssignmentPath) !== manifest.rootRunId) {
      throw new WorkflowStateStoreError(
        "identity_mismatch",
        `Manifest root run '${manifest.rootRunId}' does not own assignment '${path.basename(this.rootAssignmentPath)}'.`,
      );
    }
  }
}

function sameHumanInputSubmission(
  left: HumanInputSubmission,
  right: HumanInputSubmission,
): boolean {
  return sameJson(
    { ...left, submittedAt: undefined },
    { ...right, submittedAt: undefined },
  );
}

/** Hash the immutable submission fields in a stable, server-verifiable shape. */
export function hashHumanInputSubmission(
  submission: Pick<HumanInputSubmission, "submissionId" | "mode" | "messages">,
): string {
  return hashWorkflowContent(
    JSON.stringify({
      submissionId: submission.submissionId,
      mode: submission.mode,
      messages: submission.messages.map((message) => ({
        id: message.id,
        text: message.text,
        recipients:
          message.recipients === "all" ? "all" : [...message.recipients],
      })),
    }),
  );
}

function buildManifest(
  input: InitializeWorkflowExecutionInput["manifest"],
  now: () => Date,
): WorkflowExecutionManifest {
  const manifest: WorkflowExecutionManifest = {
    ...input,
    schemaVersion: WORKFLOW_EXECUTION_MANIFEST_SCHEMA_VERSION,
    createdAt: input.createdAt ?? now().toISOString(),
    teamDefinitionHashes: { ...input.teamDefinitionHashes },
  };
  validateManifest(manifest);
  return manifest;
}

function buildInitialState(params: {
  manifest: WorkflowExecutionManifest;
  executionAttemptId: string;
  seeds: WorkflowStepStateSeed[];
  randomUUID: () => string;
}): DurableWorkflowState {
  const steps: DurableWorkflowStepState[] = params.seeds.map((seed) => ({
    ...seed,
    childRunId: seed.childRunId ?? params.randomUUID(),
    status: "pending",
    attemptCount: 0,
    costUsd: 0,
  }));
  return {
    schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION,
    revision: 0,
    taskId: params.manifest.taskId,
    sessionId: params.manifest.sessionId,
    rootRunId: params.manifest.rootRunId,
    workflowId: params.manifest.workflowId,
    ownerExecutionAttemptId: params.executionAttemptId,
    status: "running",
    totalCostUsd: 0,
    recoveryCount: 0,
    createdAt: params.manifest.createdAt,
    updatedAt: params.manifest.createdAt,
    steps,
  };
}

async function readManifestFile(
  filePath: string,
): Promise<WorkflowExecutionManifest | null> {
  const value = await readJsonFile(filePath, "execution manifest");
  if (value === null) return null;
  validateManifest(value);
  return value;
}

async function readStateFile(
  filePath: string,
  migrationSeeds?: readonly WorkflowStepStateSeed[],
): Promise<Record<string, unknown> | null> {
  const value = await readJsonFile(filePath, "workflow state");
  if (value === null) return null;
  const stateObject = requireObject(value, "Workflow state");
  if (stateObject.schemaVersion === 1) {
    if (stateObject.status === "awaiting_input") {
      throw new WorkflowStateStoreError(
        "corrupt",
        "Version-1 workflow state cannot await human input.",
      );
    }
    return {
      ...stateObject,
      schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION,
      steps: Array.isArray(stateObject.steps)
        ? stateObject.steps.map((step, index) => {
            const record = step as Record<string, unknown>;
            const seed = migrationSeeds?.[index];
            return {
              ...record,
              // A v1 journal did not persist a step discriminator. During
              // initialize the sealed template seed is authoritative; load()
              // can still safely recognize the builtin transform executor.
              stepType:
                seed && seed.stepId === record.stepId
                  ? seed.stepType
                  : record.team === BUILTIN_TRANSFORM_EXECUTOR
                    ? "transform"
                    : "team",
            };
          })
        : stateObject.steps,
    };
  }
  assertExactSchemaVersion(
    stateObject.schemaVersion,
    WORKFLOW_STATE_SCHEMA_VERSION,
    "Workflow state",
  );
  return stateObject;
}

/**
 * Projection damage the canonical journal can repair: bytes that cannot be
 * read or parsed, and content that fails the workflow-state schema. An
 * identity that disagrees with the manifest is deliberately not in this set —
 * that is a mixed-up assignment, not a damaged derivation of this one.
 */
const REBUILDABLE_PROJECTION_ERROR_CODES: ReadonlySet<WorkflowStateStoreErrorCode> =
  new Set(["corrupt", "invalid_state", "unsupported_version"]);

function isRebuildableProjectionError(error: unknown): boolean {
  return (
    error instanceof WorkflowStateStoreError &&
    REBUILDABLE_PROJECTION_ERROR_CODES.has(error.code)
  );
}

/** Keep a store error's own classification when reframing its message. */
function errorCodeOr(
  error: unknown,
  fallback: WorkflowStateStoreErrorCode,
): WorkflowStateStoreErrorCode {
  return error instanceof WorkflowStateStoreError ? error.code : fallback;
}
