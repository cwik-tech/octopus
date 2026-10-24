import {
  canonicalizeJson,
  toCanonicalJsonObject,
  type CanonicalJsonObject,
} from "../contracts/canonical-json.js";
import { agentQuestionsStateSchema } from '../contracts/agent-questions.js'
import {
  readApprovedModelChoiceAuthorization,
  type ApprovedModelChoiceAuthorization,
} from "../contracts/model-choice.js";
import type { ExecutionJournalEvent } from "../contracts/execution-journal.js";
import type { ExecutionJournal } from "../core/execution-journal.js";
import { appendJournalStreamEvent } from "../core/journal-stream-append.js";
import {
  journalProjectionsDirectory,
  JournalProjectionMetadataStore,
} from "../core/journal-projection.js";
import type {
  DurableWorkflowState,
  DurableWorkflowStepState,
} from "./types.js";
import type { FileSystemWorkflowStateStore } from "./workflow-state-store.js";

/**
 * Workflow migration onto the canonical execution journal (Phase 8 ADR §9).
 *
 * For journaled executions the workflow stream records a full validated state
 * snapshot for every transition, appended durably before the corresponding
 * `workflow-state.json` projection is rewritten. Replay validates the stream
 * (identity, strictly increasing revisions, and owner fencing) and rebuilds
 * the projection. Legacy executions are imported through one
 * `workflow.migration.baseline` event carrying the complete validated state
 * and source-file hashes.
 */

export const WORKFLOW_STATE_STREAM_KIND = "workflow.state";
export const WORKFLOW_SNAPSHOT_EVENT_TYPE = "workflow.state.snapshot";
export const WORKFLOW_BASELINE_EVENT_TYPE = "workflow.migration.baseline";
export const WORKFLOW_STATE_PROJECTION_ID = "workflow-state";
export const WORKFLOW_STATE_REDUCER_VERSION = 1;

const WORKFLOW_JOURNAL_PAYLOAD_SCHEMA_VERSION = 1;

export type WorkflowJournalErrorCode =
  | "append_rejected"
  | "corrupt"
  | "identity_mismatch"
  | "invalid_baseline"
  | "invalid_event"
  | "not_found"
  | "ownership_conflict"
  | "revision_conflict";

export class WorkflowJournalError extends Error {
  constructor(
    readonly code: WorkflowJournalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowJournalError";
  }
}

export interface WorkflowBaselineSourceHashes {
  stateSha256: string;
  stateByteLength: number;
  manifestSha256: string;
  manifestByteLength: number;
}

/**
 * Statuses from which a legacy execution may be imported as a baseline.
 *
 * ADR §9: a running execution is never switched between authorities.
 * `interrupted` and `awaiting_input` are not running at this instant but are
 * resumable, so importing them would switch a live execution mid-flight.
 */
const BASELINE_ELIGIBLE_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "completed_with_warnings",
  "blocked",
  "failed",
  "cancelled",
]);

export function isWorkflowBaselineEligible(
  state: Pick<DurableWorkflowState, "status">,
): boolean {
  return BASELINE_ELIGIBLE_STATUSES.has(state.status);
}

export function workflowJournalStreamId(
  taskId: string,
  workflowId: string,
): string {
  return `${taskId}:${workflowId}`;
}

/** The identity a workflow stream is addressed by; see `workflowJournalStreamId`. */
export interface WorkflowJournalIdentity {
  readonly taskId: string;
  readonly workflowId: string;
}

/** The validated result of replaying one workflow stream. */
export interface WorkflowJournalRecordedState {
  readonly state: DurableWorkflowState;
  readonly lastSequence: number;
}

/**
 * The workflow store's view of the canonical journal.
 *
 * `workflows/` may not import `services/`, so the journal reaches the store
 * as an injected port rather than a registry handle. AC9 adds the three reads
 * a projection rebuild needs and nothing else: replay one workflow's stream,
 * ask whether this assignment's journal holds workflow state at all, and
 * record how far a rebuilt projection was replayed.
 */
export interface WorkflowJournalRecorder {
  recordSnapshot(state: DurableWorkflowState): Promise<void>;
  recordBaseline(
    state: DurableWorkflowState,
    sourceHashes: WorkflowBaselineSourceHashes,
  ): Promise<void>;
  /**
   * Replay and validate this workflow's canonical stream. `null` when the
   * journal holds no state for it, which is not an error: an assignment can
   * enrol before its first transition is journaled.
   */
  readRecordedState(
    identity: WorkflowJournalIdentity,
  ): Promise<WorkflowJournalRecordedState | null>;
  /**
   * Whether this assignment's journal holds any workflow state, for the one
   * question the manifest cannot answer: whether a missing manifest means an
   * execution that never started or one whose identity was lost.
   */
  hasRecordedState(): Promise<boolean>;
  /** Record the journal sequence a rebuilt projection was replayed to. */
  recordProjectionApplied(lastAppliedSequence: number): Promise<void>;
}

export function createJournalBackedWorkflowRecorder(
  journal: ExecutionJournal,
): WorkflowJournalRecorder {
  return new JournalBackedWorkflowRecorder(journal);
}

class JournalBackedWorkflowRecorder implements WorkflowJournalRecorder {
  private readonly streamRevisions = new Map<string, number>();

  constructor(private readonly journal: ExecutionJournal) {}

  async recordSnapshot(state: DurableWorkflowState): Promise<void> {
    await this.append(state, WORKFLOW_SNAPSHOT_EVENT_TYPE, { state });
  }

  async recordBaseline(
    state: DurableWorkflowState,
    sourceHashes: WorkflowBaselineSourceHashes,
  ): Promise<void> {
    await this.append(state, WORKFLOW_BASELINE_EVENT_TYPE, {
      state,
      sourceHashes,
    });
  }

  private async append(
    state: DurableWorkflowState,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const streamId = workflowJournalStreamId(state.taskId, state.workflowId);
    const expectedStreamRevision =
      this.streamRevisions.get(streamId) ??
      (await this.currentStreamRevision(streamId));
    const stage =
      type === WORKFLOW_BASELINE_EVENT_TYPE ? "baseline" : "snapshot";
    const eventId = `${streamId}:${stage}:r${state.revision}`;
    const event = await appendJournalStreamEvent(this.journal, {
      eventId,
      streamKind: WORKFLOW_STATE_STREAM_KIND,
      streamId,
      expectedStreamRevision,
      type,
      payloadSchemaVersion: WORKFLOW_JOURNAL_PAYLOAD_SCHEMA_VERSION,
      payload: toCanonicalJsonObject(payload),
      correlationId: streamId,
    });
    this.streamRevisions.set(streamId, event.streamRevision);
  }

  async readRecordedState(
    identity: WorkflowJournalIdentity,
  ): Promise<WorkflowJournalRecordedState | null> {
    const streamId = workflowJournalStreamId(
      identity.taskId,
      identity.workflowId,
    );
    const stream = (
      await this.journal.scanStream(WORKFLOW_STATE_STREAM_KIND, streamId)
    ).events;
    if (stream.length === 0) return null;
    return validateWorkflowJournalStream(stream, streamId);
  }

  async hasRecordedState(): Promise<boolean> {
    const scan = await this.journal.scan();
    return scan.events.some(
      (event) => event.streamKind === WORKFLOW_STATE_STREAM_KIND,
    );
  }

  async recordProjectionApplied(lastAppliedSequence: number): Promise<void> {
    await createWorkflowProjectionMetadataStore(this.journal).recordApplied(
      lastAppliedSequence,
    );
  }

  private async currentStreamRevision(streamId: string): Promise<number> {
    const stream = await this.journal.scanStream(
      WORKFLOW_STATE_STREAM_KIND,
      streamId,
    );
    return stream.events[stream.events.length - 1]?.streamRevision ?? 0;
  }
}

/**
 * Import a validated legacy workflow execution as a single baseline event.
 * Idempotent for an identical already-imported state; importing a divergent
 * state into an already baselined stream fails closed.
 */
export async function importWorkflowBaseline(
  journal: ExecutionJournal,
  store: FileSystemWorkflowStateStore,
): Promise<void> {
  const { state, sourceHashes } = await store.readValidatedBaseline();
  if (!isWorkflowBaselineEligible(state)) {
    throw new WorkflowJournalError(
      "invalid_baseline",
      `Workflow '${state.workflowId}' is '${state.status}' and may still resume; a running execution is never switched between authorities.`,
    );
  }
  const streamId = workflowJournalStreamId(state.taskId, state.workflowId);
  const stream = (
    await journal.scanStream(WORKFLOW_STATE_STREAM_KIND, streamId)
  ).events;
  const existingBaseline = stream.find(
    (event) => event.type === WORKFLOW_BASELINE_EVENT_TYPE,
  );
  if (existingBaseline) {
    const existingState = readWorkflowStatePayload(existingBaseline.payload);
    if (canonicalizeJson(existingState) === canonicalizeJson(state)) return;
    throw new WorkflowJournalError(
      "identity_mismatch",
      `A different workflow baseline was already imported for stream '${streamId}'.`,
    );
  }
  if (stream.length > 0) {
    throw new WorkflowJournalError(
      "invalid_baseline",
      `Cannot import a baseline into stream '${streamId}' that already has workflow events.`,
    );
  }
  const recorder = createJournalBackedWorkflowRecorder(journal);
  await recorder.recordBaseline(state, sourceHashes);
}

/**
 * Rebuild `workflow-state.json` by replaying the workflow journal stream.
 * Returns the journal sequence of the last applied event.
 *
 * The workflow lock is not reentrant, so this entry point owns exactly one
 * acquisition for external callers and the store performs the manifest read,
 * replay, and republish underneath it — the same unlocked path `load()` uses
 * when it repairs a projection itself (ADR §9, AC9).
 */
export async function rebuildWorkflowStateProjection(
  journal: ExecutionJournal,
  store: FileSystemWorkflowStateStore,
): Promise<{ lastAppliedSequence: number }> {
  return store.rebuildStateProjection(
    createJournalBackedWorkflowRecorder(journal),
  );
}

/**
 * Validate an ordered workflow journal stream and return the latest state.
 * Enforces identity constancy, strictly increasing revisions, and owner
 * fencing; fails closed on any violation.
 */
export function validateWorkflowJournalStream(
  events: readonly ExecutionJournalEvent[],
  expectedStreamId: string,
): { state: DurableWorkflowState; lastSequence: number } {
  let previous: DurableWorkflowState | undefined;
  let latest: DurableWorkflowState | undefined;
  let lastSequence = 0;
  let sawBaseline = false;

  events.forEach((event, index) => {
    if (
      event.type !== WORKFLOW_SNAPSHOT_EVENT_TYPE &&
      event.type !== WORKFLOW_BASELINE_EVENT_TYPE
    ) {
      throw new WorkflowJournalError(
        "invalid_event",
        `Unexpected workflow journal event type '${event.type}'.`,
      );
    }
    if (event.type === WORKFLOW_BASELINE_EVENT_TYPE) {
      if (index !== 0 || sawBaseline) {
        throw new WorkflowJournalError(
          "invalid_baseline",
          "workflow.migration.baseline must be the single first stream event.",
        );
      }
      sawBaseline = true;
    }

    const state = readWorkflowStatePayload(event.payload);
    const eventStreamId = workflowJournalStreamId(
      state.taskId,
      state.workflowId,
    );
    if (eventStreamId !== expectedStreamId) {
      throw new WorkflowJournalError(
        "identity_mismatch",
        `Workflow journal event belongs to stream '${eventStreamId}', not '${expectedStreamId}'.`,
      );
    }

    if (previous) {
      if (
        state.taskId !== previous.taskId ||
        state.workflowId !== previous.workflowId ||
        state.rootRunId !== previous.rootRunId
      ) {
        throw new WorkflowJournalError(
          "identity_mismatch",
          "Workflow journal stream identity changed between events.",
        );
      }
      if (state.revision <= previous.revision) {
        throw new WorkflowJournalError(
          "revision_conflict",
          `Workflow revision did not strictly increase (${previous.revision} -> ${state.revision}).`,
        );
      }
      if (!isLegitimateOwnerChange(previous, state)) {
        throw new WorkflowJournalError(
          "ownership_conflict",
          `Workflow owner fencing rejected transition from '${previous.ownerExecutionAttemptId}' to '${state.ownerExecutionAttemptId}'.`,
        );
      }
    }

    latest = state;
    lastSequence = event.sequence;
    previous = state;
  });

  if (!latest) {
    throw new WorkflowJournalError(
      "not_found",
      "Workflow journal stream contained no usable state events.",
    );
  }
  return { state: latest, lastSequence };
}

function readWorkflowStatePayload(
  payload: CanonicalJsonObject,
): DurableWorkflowState {
  const state = payload["state"];
  if (!isRecord(state)) {
    throw new WorkflowJournalError(
      "corrupt",
      "Workflow journal event payload is missing its state object.",
    );
  }
  if (
    state["schemaVersion"] !== 2 ||
    typeof state["revision"] !== "number" ||
    typeof state["taskId"] !== "string" ||
    typeof state["workflowId"] !== "string" ||
    typeof state["rootRunId"] !== "string" ||
    typeof state["ownerExecutionAttemptId"] !== "string" ||
    typeof state["recoveryCount"] !== "number" ||
    !Array.isArray(state["steps"])
  ) {
    throw new WorkflowJournalError(
      "corrupt",
      "Workflow journal state payload failed schema validation.",
    );
  }
  // Owner fencing reads into each step, so the step entries must be records
  // before anything dereferences them.
  if (!state["steps"].every(isRecord)) {
    throw new WorkflowJournalError(
      "corrupt",
      "Workflow journal state payload contains a malformed step entry.",
    );
  }
  if (state['agentQuestions'] !== undefined && !agentQuestionsStateSchema.safeParse(state['agentQuestions']).success) {
    throw new WorkflowJournalError('corrupt', 'Workflow journal contains malformed agent-question state.')
  }
  // The owner fence reads inside each approval, so a step that carries one has
  // to carry a whole one. A half-written authorization is corrupt journal
  // content, and saying so is the difference between a named failure and a
  // TypeError thrown from the middle of a comparison.
  for (const step of state["steps"]) {
    if (step["approvedModelChoice"] === undefined) continue;
    if (
      readApprovedModelChoiceAuthorization(step["approvedModelChoice"]) ===
      undefined
    ) {
      throw new WorkflowJournalError(
        "corrupt",
        "Workflow journal state payload contains a malformed approved model choice.",
      );
    }
  }
  const validated: unknown = state;
  return validated as DurableWorkflowState;
}

/**
 * Owner fencing: an unchanged owner is always legitimate. A changed owner is
 * legitimate only when it is a recovery claim (recovery count increased) or a
 * human-input continuation handoff (awaiting_input -> running with a
 * continuation admission recorded on a step).
 */
function isLegitimateOwnerChange(
  previous: DurableWorkflowState,
  current: DurableWorkflowState,
): boolean {
  if (
    current.ownerExecutionAttemptId === previous.ownerExecutionAttemptId
  ) {
    return true;
  }
  const agentClaims = (current.agentQuestions?.interactions ?? []).filter((interaction) =>
    interaction.status === 'resuming' && previous.agentQuestions?.interactions.find(
      (before) => before.interactionId === interaction.interactionId,
    )?.status !== 'resuming',
  )
  if (agentClaims.length > 0) {
    return isAgentQuestionContinuation(previous, current) &&
      newModelChoiceReceiptStepIds(previous, current).length === 0
  }
  // Judged before the recovery branch, because a recovery bump alone hands
  // ownership over: an event that bumped the counter *and* claimed an approval
  // would otherwise never reach a single model-choice check. Claiming a
  // continuation receipt is what this event is, whatever else it also does.
  const claimedSteps = newModelChoiceReceiptStepIds(previous, current);
  if (claimedSteps.length > 0) {
    // Exactly one. The check below scans for *a* satisfying step and binds it
    // to `currentStepId`, so without counting here an event could satisfy it on
    // the current step while quietly adding a second receipt to another — one
    // approval buying two continuations. Which step it is, is that check's
    // business, and repeating it here would be a branch nothing can reach.
    return (
      claimedSteps.length === 1 &&
      isApprovedModelChoiceContinuation(previous, current)
    );
  }
  if (current.recoveryCount > previous.recoveryCount) {
    return true;
  }
  if (previous.status === "awaiting_input" && current.status === "running") {
    return current.steps.some((step: DurableWorkflowStepState) =>
      Boolean(step.humanInput?.continuationAdmissionRequestId),
    );
  }
  return false;
}

function isAgentQuestionContinuation(previous: DurableWorkflowState, current: DurableWorkflowState): boolean {
  if (previous.status !== 'awaiting_input' || current.status !== 'running' ||
      previous.recoveryCount !== current.recoveryCount) return false
  const beforeQuestions = previous.agentQuestions?.interactions ?? []
  const afterQuestions = current.agentQuestions?.interactions ?? []
  if (beforeQuestions.length !== afterQuestions.length) return false
  return afterQuestions.every((after) => {
    const before = beforeQuestions.find((entry) => entry.interactionId === after.interactionId)
    if (!before) return false
    if (canonicalizeJson(before) === canonicalizeJson(after)) return true
    if (before.status !== 'submitted' || after.status !== 'resuming' ||
        after.continuation.executionAttemptId !== current.ownerExecutionAttemptId ||
        after.stepId !== current.currentStepId || after.stepId !== previous.currentStepId) return false
    return canonicalizeJson(after) === canonicalizeJson({
      ...before, status: 'resuming', revision: before.revision + 1, continuation: after.continuation,
    })
  })
}

/** Every step whose continuation receipt this event newly records. */
function newModelChoiceReceiptStepIds(
  previous: DurableWorkflowState,
  current: DurableWorkflowState,
): string[] {
  return current.steps
    .filter((step: DurableWorkflowStepState) => {
      const admission = step.modelChoiceContinuationAdmissionRequestId;
      if (typeof admission !== "string" || admission.length === 0) return false;
      const before = previous.steps.find(
        (entry: DurableWorkflowStepState) => entry.stepId === step.stepId,
      );
      return before?.modelChoiceContinuationAdmissionRequestId !== admission;
    })
    .map((step: DurableWorkflowStepState) => step.stepId);
}

/**
 * The one owner change an approved model choice is allowed to make.
 *
 * Deliberately narrow, because the states either side are both `running` and
 * that is far too weak a thing to hand ownership on. `approveModelChoice`
 * records the approval under the attempt that failed, leaving the workflow and
 * the step `running`; `claimModelChoiceContinuation` then takes ownership with
 * the workflow still `running`, moves that step to `interrupted` because the
 * attempt it belonged to is gone, and writes the admission that authorized the
 * continuation.
 *
 * So this recognises that exact pair and nothing else. The approval has to be
 * in the record the new owner *inherited* and unchanged across the handoff: an
 * event that grants the permission it is claiming, or edits the pair a person
 * agreed to, is a new owner writing its own authorization. The admission has to
 * be newly added, so one approval cannot be claimed twice. A recovery bump is
 * someone else's business and is handled in its own branch below, so the
 * counts must match here.
 */
function isApprovedModelChoiceContinuation(
  previous: DurableWorkflowState,
  current: DurableWorkflowState,
): boolean {
  if (previous.recoveryCount !== current.recoveryCount) return false;
  if (previous.status !== "running" || current.status !== "running") {
    return false;
  }
  // The claimed step must be the step the run is on, on both sides of the
  // handoff. An untouched approval sitting on some other step is otherwise
  // enough to take ownership while the run is somewhere else entirely.
  const claimedStepId = current.currentStepId;
  if (
    claimedStepId === undefined ||
    previous.currentStepId !== claimedStepId
  ) {
    return false;
  }
  return current.steps.some((step: DurableWorkflowStepState) => {
    if (step.stepId !== claimedStepId) return false;
    const admission = step.modelChoiceContinuationAdmissionRequestId;
    if (typeof admission !== "string" || admission.length === 0) return false;
    if (step.status !== "interrupted") return false;
    const before = previous.steps.find(
      (entry: DurableWorkflowStepState) => entry.stepId === step.stepId,
    );
    return (
      before !== undefined &&
      before.status === "running" &&
      before.modelChoiceContinuationAdmissionRequestId === undefined &&
      isSameApprovedModelChoice(before.approvedModelChoice, step.approvedModelChoice)
    );
  });
}

/** Field by field, so a re-serialised record is not mistaken for an edited one. */
function isSameApprovedModelChoice(
  before: ApprovedModelChoiceAuthorization | undefined,
  after: ApprovedModelChoiceAuthorization | undefined,
): boolean {
  if (before === undefined || after === undefined) return false;
  return (
    before.offerId === after.offerId &&
    before.agentName === after.agentName &&
    before.logicalInvocationId === after.logicalInvocationId &&
    before.failedChoice.provider === after.failedChoice.provider &&
    before.failedChoice.model === after.failedChoice.model &&
    before.proposedDefault.provider === after.proposedDefault.provider &&
    before.proposedDefault.model === after.proposedDefault.model
  );
}

/**
 * Lag tracking for the `workflow-state.json` projection, in the shared
 * projection-metadata shape so recovery can classify it uniformly.
 */
export function createWorkflowProjectionMetadataStore(
  journal: ExecutionJournal,
  clock?: { readonly now: () => number },
): JournalProjectionMetadataStore {
  return new JournalProjectionMetadataStore({
    projectionId: WORKFLOW_STATE_PROJECTION_ID,
    reducerVersion: WORKFLOW_STATE_REDUCER_VERSION,
    projectionDirectory: journalProjectionsDirectory(journal),
    ...(clock === undefined ? {} : { clock }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
