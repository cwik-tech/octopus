import { readModelSelectionRecord } from "@contracts/agent-model-selection";
import { isTerminalTaskStatus } from "@contracts/sessions";
import type { TaskRunEntry, TaskSlotHold } from "@/components/run/tasks/task-strip";
import type {
  SchedulingQueueHold,
  SchedulingQueueSnapshot,
} from "@/lib/clients/scheduling-queue-client";
import { parseFirstTimestamp } from "@/components/run/tasks/task-timing";
import type { RunEvent } from "@/components/run/stage-renderers/index";
import { isRunBlockedCause } from "@/components/run/stage-renderers/index";
import type { SessionTask } from "@/lib/models/session-model";
import type { EngineEventEnvelope } from "@/lib/models/runtime-model";
import { isProviderErrorKind } from "@contracts/provider";

// ── toRunEvent ─────────────────────────────────────────────────────────────
// Maps a raw EngineEventEnvelope (delivered via openRunEventStream.onEvent)
// to the UI-facing RunEvent shape consumed by TaskBody / StageTimeline.
//
// Field mapping matches the documentation in domains/sessions/run-event-types.ts
// (created by T1). Actual engine event type strings (e.g. 'run.completed',
// 'gate.transition') are stored as-is in RunEvent.type — the DefaultRenderer
// handles unknowns via its default case.

export function toRunEvent(id: string, env: EngineEventEnvelope): RunEvent {
  const payload = env.payload as Record<string, unknown>;
  return {
    id,
    // Cast: env.type is string; RunEvent.type is a string-literal union.
    // TypeScript allows this narrowing cast. Runtime values are actual
    // engine event strings (e.g. 'run.completed', 'gate.transition').
    type: env.type as RunEvent["type"],
    ts: Date.parse(env.timestamp),
    runId: env.run_id,
    stageType: env.stage_type ?? undefined,
    stageName: env.level_id ?? undefined,
    agentId:
      typeof payload.agent_id === "string"
        ? payload.agent_id
        : typeof payload.agent_name === "string"
          ? payload.agent_name
          : env.run_id ?? undefined,
    agentName:
      typeof payload.agent_display_name === "string"
        ? payload.agent_display_name
        : typeof payload.agent_name === "string"
          ? payload.agent_name
          // A host event names its coordinator in `coordinator`; `agent_name`
          // belongs to an agent's own dispatch. Without this a host turn is
          // attributed to the run rather than to the coordinator whose turn it
          // was — and a coordinator-less host, which is exactly the case with
          // no other record, is indistinguishable from one that had a name.
          : typeof payload.coordinator === "string"
            ? payload.coordinator
            : undefined,
    agentActivity:
      env.type === "agent.start" &&
        env.stage_type === "discussion" &&
        payload.trigger_tool === "coordinator"
        ? "selecting-team-members"
        : undefined,
    dispatchId:
      typeof payload.dispatch_id === "string" ? payload.dispatch_id : undefined,
    logicalInvocationId:
      typeof payload.logical_invocation_id === "string"
        ? payload.logical_invocation_id
        : undefined,
    textChannelId:
      typeof payload.text_channel_id === "string"
        ? payload.text_channel_id
        : undefined,
    participants:
      Array.isArray(payload.participants) &&
      payload.participants.every(
        (participant) => typeof participant === "string",
      )
        ? payload.participants
        : undefined,
    model: typeof payload.model === "string" ? payload.model : undefined,
    provider:
      typeof payload.provider === "string" ? payload.provider : undefined,
    // Validated, not asserted: the payload comes off disk and over HTTP, and a
    // half-read record would let the run claim something it never recorded.
    //
    // Two field names for the same validated record. An agent turn writes
    // `model_selection`; a host lifecycle event writes `host_model_selection`,
    // because it describes the process rather than one agent's turn — and for a
    // run whose level has no coordinator it is the only disclosure there is.
    // The agent's own record wins where an event carries both: it describes the
    // turn, and the host record describes what the turn ran inside.
    modelSelection:
      readModelSelectionRecord(payload.model_selection) ??
      readModelSelectionRecord(payload.host_model_selection),
    delegationId:
      typeof payload.delegation_id === "string"
        ? payload.delegation_id
        : undefined,
    helper: typeof payload.helper === "string" ? payload.helper : undefined,
    coordinatorRunId:
      typeof payload.coordinator_run_id === "number"
        ? payload.coordinator_run_id
        : undefined,
    hostInstanceId:
      typeof payload.host_instance_id === "string"
        ? payload.host_instance_id
        : undefined,
    content:
      typeof payload.text === "string"
        ? payload.text
        : typeof payload.content === "string"
          ? payload.content
          : undefined,
    messageId:
      typeof payload.message_id === "string" ? payload.message_id : undefined,
    round:
      typeof payload.round === "number" ? payload.round : undefined,
    messageType:
      typeof payload.message_type === "string"
        ? payload.message_type
        : undefined,
    stepIndex:
      typeof payload.step_index === "number" ? payload.step_index : undefined,
    artifactIn:
      typeof payload.input_artifact === "string"
        ? payload.input_artifact
        : undefined,
    artifactOut:
      typeof payload.output_artifact === "string"
        ? payload.output_artifact
        : undefined,
    childRunId:
      typeof payload.child_run_id === "string"
        ? payload.child_run_id
        : undefined,
    artifactPath:
      typeof payload.path === "string" ? payload.path : undefined,
    artifactRunId:
      typeof payload.artifact_run_id === "string"
        ? payload.artifact_run_id
        : env.run_id ?? undefined,
    artifactRole:
      typeof payload.artifact_role === "string" ? payload.artifact_role : undefined,
    artifactType:
      typeof payload.artifact_type === "string" ? payload.artifact_type : undefined,
    artifactStatus:
      typeof payload.status === "string" ? payload.status : undefined,
    artifactTitle:
      typeof payload.title === "string" ? payload.title : undefined,
    acquisitionActivityId:
      typeof payload.activity_id === "string"
        ? payload.activity_id
        : undefined,
    acquisitionSourceKey:
      typeof payload.source_key === "string"
        ? payload.source_key
        : undefined,
    acquisitionIssueKind:
      payload.issue_kind === "none" ||
      payload.issue_kind === "blocked" ||
      payload.issue_kind === "rate-limited" ||
      payload.issue_kind === "limited" ||
      payload.issue_kind === "failed" ||
      payload.issue_kind === "recovered" ||
      payload.issue_kind === "ignored"
        ? payload.issue_kind
        : undefined,
    acquisitionUsable:
      typeof payload.usable === "boolean" ? payload.usable : undefined,
    searchCapabilityBlocked:
      env.type === "research.search_capability.blocked" || undefined,
    // Only the capability event carries these; reading them from any payload
    // would let an unrelated event with a `remediation` string masquerade as
    // an operator action.
    searchCapabilityRemediation:
      env.type === "research.search_capability.blocked" &&
      typeof payload.remediation === "string"
        ? payload.remediation
        : undefined,
    searchCapabilityProviderPriority:
      env.type === "research.search_capability.blocked" &&
      Array.isArray(payload.provider_priority) &&
      payload.provider_priority.every(
        (provider) => typeof provider === "string",
      )
        ? (payload.provider_priority as string[])
        : undefined,
    searchCapabilityCause:
      env.type === "research.search_capability.blocked" &&
      typeof payload.cause === "string"
        ? payload.cause
        : undefined,
    searchCapabilityFailureCodes:
      env.type === "research.search_capability.blocked" &&
      Array.isArray(payload.failure_codes) &&
      payload.failure_codes.length > 0 &&
      payload.failure_codes.every((code) => typeof code === "string")
        ? (payload.failure_codes as string[])
        : undefined,
    errorMessage:
      typeof payload.error === "string"
        ? payload.error
        : typeof payload.error_message === "string"
          ? payload.error_message
          : env.type === "agent.fail" && typeof payload.status === "string"
            ? payload.status
            : undefined,
    // Only a failed agent run carries this. Reading it from any payload would
    // let an unrelated event with a matching string claim a diagnosis.
    providerFailureKind:
      env.type === "agent.fail" && isProviderErrorKind(payload.provider_failure_kind)
        ? payload.provider_failure_kind
        : undefined,
    // Only a blocked run carries this, and only one of the values this build
    // knows how to describe. Reading it from any payload would let an
    // unrelated event claim a diagnosis.
    blockedCause:
      env.type === "run.blocked" && isRunBlockedCause(payload.blocked_cause)
        ? payload.blocked_cause
        : undefined,
    executionAttemptId:
      typeof payload.execution_attempt_id === "string"
        ? payload.execution_attempt_id
        : undefined,
    sourceEnvelope: env,
  };
}

export function toSnapshotRunEvent(env: EngineEventEnvelope, index: number): RunEvent {
  return toRunEvent(`${index}:${env.timestamp}:${env.type}`, env);
}

const TERMINAL_RUN_EVENT_TYPES = new Set<RunEvent["type"]>([
  "run.completed",
  "run.failed",
  "run.blocked",
  "run.cancelled",
]);

/**
 * A root-run stream includes events from delegated child runs. A child terminal
 * event is activity within the workflow, not terminal state for the task.
 *
 * Older snapshots and isolated event fixtures may omit `run_id`; retain the
 * former behavior in that case because the event cannot be attributed safely.
 */
function isTerminalEventForTaskRun(event: RunEvent, taskRunId: string): boolean {
  if (!TERMINAL_RUN_EVENT_TYPES.has(event.type)) return false;
  return isEventForTaskRun(event, taskRunId);
}

function isEventForTaskRun(event: RunEvent, taskRunId: string): boolean {
  return !event.runId || event.runId === taskRunId;
}

/**
 * Do not use `root_run_id` alone here: every delegated child event shares the
 * root id. Its own `run_id` must match the task's root run before it can alter
 * task-level state or choose the user-facing delivery.
 */
export function isEventEnvelopeForTaskRun(
  envelope: EngineEventEnvelope,
  taskRunId: string,
): boolean {
  return !envelope.run_id || envelope.run_id === taskRunId;
}

/**
 * Whether the task's root run has selected a final delivery. When it has, the
 * server persists a delivery chat message, so the local completion note is
 * skipped in favor of the reloaded persisted message.
 */
export function hasDeliverySelection(events: RunEvent[], taskRunId: string): boolean {
  return events.some(
    (event) =>
      event.type === "artifact.delivery_selected" &&
      isEventForTaskRun(event, taskRunId),
  );
}

function taskModeFromRecord(task: SessionTask, events: RunEvent[]): TaskRunEntry["mode"] {
  if (task.status === "cancelled") return "cancelled";
  if (task.status === "blocked") return "blocked";
  if (task.status === "failed") return "error";
  if (task.status === "done") return "done";
  if (task.status === "awaiting_input") return "awaiting_input";
  // Its own mode, not `running`: the run has stopped, released its worker, and
  // is waiting on an answer, so a progress view would describe work in flight
  // that nothing is doing.
  if (task.status === "awaiting_model_choice") return "awaiting_model_choice";
  if (
    events.some(
      (event) =>
        event.type === "run.cancelled" && isTerminalEventForTaskRun(event, task.runId),
    )
  ) {
    return "cancelled";
  }
  if (
    events.some(
      (event) =>
        event.type === "run.completed" && isTerminalEventForTaskRun(event, task.runId),
    )
  ) {
    return "done";
  }
  if (
    events.some(
      (event) =>
        event.type === "run.blocked" && isTerminalEventForTaskRun(event, task.runId),
    )
  ) {
    return "blocked";
  }
  if (
    events.some(
      (event) =>
        event.type === "run.failed" && isTerminalEventForTaskRun(event, task.runId),
    )
  ) {
    return "error";
  }
  if (task.status === "running") return "running";
  const workflowStartedEvents = events.filter(
    (event) =>
      event.type === "session_task.workflow_started" &&
      isEventForTaskRun(event, task.runId),
  );
  if (task.admission) {
    if (task.admission.phase === "granted") {
      const executionAttemptId = task.admission.executionAttemptId;
      if (
        workflowStartedEvents.some(
          (event) => event.executionAttemptId === executionAttemptId,
        )
      ) {
        return "running";
      }
    }
    return "queued";
  }
  if (task.status === "queued") {
    if (
      workflowStartedEvents.some(
        (event) =>
          !task.executionAttemptId ||
          event.executionAttemptId === task.executionAttemptId,
      )
    ) {
      return "running";
    }
    return "queued";
  }
  if (task.status === "interrupted") return "interrupted";
  if (workflowStartedEvents.length > 0) return "running";
  return "running";
}

export function toTaskRunEntry(task: SessionTask, events: RunEvent[]): TaskRunEntry {
  const mode = taskModeFromRecord(task, events);
  const startedAt = parseFirstTimestamp(
    task.startedAt,
    task.workerStartedAt,
  );
  const completedAt = parseFirstTimestamp(
    mode === "interrupted" ? task.interruptedAt : task.completedAt,
  );
  // Older scheduled-agent sessions have no origin metadata; their generated
  // workflow identity survives completion and recovery clearing admission.
  const isScheduled = task.admission?.source === "scheduled" ||
    /^scheduled-agent-.+-[0-9a-f]{12}$/.test(task.workflowId);
  return {
    taskId: task.id,
    runId: task.runId,
    workflowId: task.workflowId || undefined,
    ...(task.targetKind ? { targetKind: task.targetKind } : {}),
    ...(task.teamId ? { teamId: task.teamId } : {}),
    // Carried so a Team launch's naming notice can find the question that
    // asked for it. Absent on tasks written before turn-scoped identity
    // existed, which is why nothing may assume it is there.
    ...(task.sourceTurn ? { sourceTurn: task.sourceTurn } : {}),
    ...(isScheduled ? { isScheduled: true } : {}),
    label: task.workflowId || task.id,
    mode,
    startedAt,
    completedAt,
    errorMessage: task.error,
    executionKind: task.admission?.executionKind ?? task.executionKind,
    executionAttemptId: task.executionAttemptId,
    executionAttemptNumber: task.executionAttemptNumber,
    recoveryCount: task.recoveryCount,
    recoveryDisposition: task.recoveryDisposition,
    recoveryReason: task.recoveryReason,
    // Set even when absent: the history poll merges each fresh entry over
    // the one it had, so a hold that is gone has to overwrite the old one.
    slotHold: slotHoldFromRecord(task),
  };
}

/**
 * What the task record says about its worker slot. A descendant hold is
 * recorded on the task, whatever its status. A finished task whose grant is
 * still held has not had its slot released yet; the queue snapshot says why.
 */
function slotHoldFromRecord(task: SessionTask): TaskSlotHold | undefined {
  const hold = task.processCleanupHold;
  if (hold) return { reason: hold.reason, since: hold.since };
  if (task.admission?.phase === "granted" && isTerminalTaskStatus(task.status)) return {};
  return undefined;
}

const FINISHED_MODES: ReadonlySet<TaskRunEntry["mode"]> = new Set(["done", "error", "blocked", "cancelled"]);

/**
 * The entry as the live queue snapshot says its slot stands. Once the queue
 * has read every task, its snapshot lists every task that holds a slot, so a
 * task it does not list holds none, whatever its record last said; one it
 * lists with a hold says why. A finished task it lists without a hold keeps
 * what its record said: the snapshot adds a notice only with a reason, since
 * every run that just finished is listed until the queue's next pass releases
 * its slot. Anything else it lists without a hold shows no notice. Unchanged
 * until a snapshot has been read, and not cleared while the queue is still
 * recovering.
 */
export function applyQueueSnapshot(
  entry: TaskRunEntry,
  snapshot: SchedulingQueueSnapshot | null,
): TaskRunEntry {
  if (!snapshot) return entry;
  const item = snapshot.items.find((candidate) => candidate.taskId === entry.taskId);
  if (item?.hold) return withQueueHold(entry, item.hold);
  if (!item && snapshot.status === "recovering") return entry;
  const slotHold = item && FINISHED_MODES.has(entry.mode) ? entry.slotHold : undefined;
  return slotHold === entry.slotHold ? entry : { ...entry, slotHold };
}

/**
 * The entry with the queue snapshot's live reason for its slot hold, which
 * the task record cannot carry: a root worker that cannot be confirmed, and
 * its detail. Unchanged when the snapshot names no hold for the task.
 */
export function withQueueHold(
  entry: TaskRunEntry,
  hold: SchedulingQueueHold | undefined,
): TaskRunEntry {
  if (!hold) return entry;
  const since = hold.since ?? entry.slotHold?.since;
  return {
    ...entry,
    slotHold: {
      reason: hold.reason,
      ...(hold.processId !== undefined ? { processId: hold.processId } : {}),
      ...(hold.processGroupCount !== undefined ? { processGroupCount: hold.processGroupCount } : {}),
      ...(since !== undefined ? { since } : {}),
    },
  };
}

/**
 * The operator-facing status for a search-capability blocker.
 *
 * A missing credential is one of several ways a run can end up with no
 * discovery path. Naming it for every blocker sent operators to buy an API key
 * for an unreadable settings file, an empty web, or an exhausted budget, so the
 * credential wording is reserved for the one code that means it.
 */
export function describeSearchCapabilityStatus(
  failureCodes: readonly string[] | undefined,
): string {
  return failureCodes?.length === 1 && failureCodes[0] === "not_configured"
    ? "API key missing"
    : "No discovery path";
}
