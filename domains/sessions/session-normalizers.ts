import { workflowModelSelectionSchema } from '../../contracts/workflow-model-selection.js'
import * as path from "node:path";

import {
  conversationMessageSourceSchema,
  isTaskAdmission,
  type ChatMessageDelivery,
  type ChatMessageOutcome,
  type ChatMessageConversationReference,
  type ConversationMessageKind,
  type ConversationMessageSource,
  type ChatMessageExecutionReference,
  type ChatMessageSpeaker,
  type ChatTurnRequest,
  type SessionActivityType,
  type SessionStatus,
  type SessionSummary,
  type SessionTask,
  type TaskStatus,
} from "../../contracts/sessions.js";
import type { WorkspaceProjectContextSelection } from "../../contracts/projects.js";
import {
  readModelSelectionRecord,
  type ModelSelectionRecord,
} from "../../contracts/agent-model-selection.js";

export function requireSessionTaskRecord(
  value: unknown,
  expected: { sessionId: string; taskId: string },
): SessionTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Task record is not an object: ${expected.taskId}`);
  }
  const task = value as Partial<SessionTask>;
  const statuses = new Set<TaskStatus>([
    "queued",
    "running",
    "awaiting_input",
    "awaiting_model_choice",
    "interrupted",
    "done",
    "failed",
    "blocked",
    "cancelled",
  ]);
  if (
    task.id !== expected.taskId ||
    task.sessionId !== expected.sessionId ||
    typeof task.runId !== "string" ||
    !task.runId ||
    typeof task.workflowId !== "string" ||
    !task.workflowId ||
    (task.targetKind !== undefined && task.targetKind !== "team-chat") ||
    (task.teamId !== undefined && (typeof task.teamId !== "string" || !task.teamId)) ||
    typeof task.brief !== "string" ||
    typeof task.status !== "string" ||
    !statuses.has(task.status as TaskStatus) ||
    typeof task.createdAt !== "string" ||
    !Number.isFinite(Date.parse(task.createdAt)) ||
    typeof task.cwd !== "string" ||
    !task.cwd
  ) {
    throw new Error(
      `Task record has an invalid authoritative schema: ${expected.sessionId}/${expected.taskId}`,
    );
  }
  if (task.workerModel !== undefined && !workflowModelSelectionSchema.safeParse(task.workerModel).success) {
    throw new Error(`Task worker model has an invalid schema: ${expected.sessionId}/${expected.taskId}`);
  }
  if (task.admission !== undefined && !isTaskAdmission(task.admission)) {
    throw new Error(
      `Task admission has an invalid schema: ${expected.sessionId}/${expected.taskId}`,
    );
  }
  if (
    task.admission?.phase === "granted" &&
    (task.executionAttemptId !== task.admission.executionAttemptId ||
      task.processIdentity !== task.admission.executionAttemptId)
  ) {
    throw new Error(
      `Granted task admission conflicts with its execution attempt: ${expected.sessionId}/${expected.taskId}`,
    );
  }
  return task as SessionTask;
}

export function normalizeTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, 200);
}

export function normalizeStatus(value: unknown): SessionStatus {
  if (value === "active" || value === "done" || value === "idle") return value;
  return "idle";
}

export function normalizeActivityType(value: unknown): SessionActivityType {
  return value === "workflow" ? "workflow" : "chat";
}

export function inferSessionActivityType(
  summary: SessionSummary,
  tasks: readonly SessionTask[],
): SessionActivityType {
  return tasks.length > 0 ? "workflow" : summary.activityType;
}

export function isChatMessageSpeaker(
  value: unknown,
): value is ChatMessageSpeaker {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const speaker = value as Partial<ChatMessageSpeaker>;
  return (
    (speaker.type === "assistant" || speaker.type === "agent") &&
    typeof speaker.id === "string" &&
    typeof speaker.name === "string" &&
    // Absent on every reply that ran on the pair its settings were written for,
    // which is almost all of them. Present, it has to be a list of names — a
    // half-read one would report the wrong settings as still applying.
    (speaker.droppedProviderOptions === undefined ||
      (Array.isArray(speaker.droppedProviderOptions) &&
        speaker.droppedProviderOptions.every(
          (entry) => typeof entry === "string",
        )))
  );
}

/**
 * The recorded request behind a turn, read back from the chat log so a replay
 * can be checked against what was actually asked, not merely against the id.
 */
export function isChatTurnRequest(value: unknown): value is ChatTurnRequest {
  return readChatTurnRequest(value) !== undefined;
}

/**
 * Reads a persisted turn request, including its admitted model selections.
 *
 * Validated the same all-or-nothing way as the rest of the transcript: a
 * selection present but unreadable makes the whole turn request unreadable,
 * because a turn that silently lost its provenance reads as a turn that never
 * had any.
 */
export function readChatTurnRequest(
  value: unknown,
): ChatTurnRequest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record: Record<string, unknown> = { ...value };
  if (
    typeof record.fingerprint !== "string" ||
    record.fingerprint.length === 0 ||
    typeof record.expectedReplies !== "number" ||
    !Number.isSafeInteger(record.expectedReplies) ||
    record.expectedReplies < 0
  ) {
    return undefined;
  }
  // A responder nobody can read is refused along with the rest of the record.
  // The value picks the scheme a replay is checked against, so guessing one
  // would hand back an answer hashed under a scheme this turn never used;
  // "unverifiable" is the honest outcome instead. Absent stays readable: every
  // line written before responders were recorded was a Coordinator turn.
  const responder =
    record.responder === "agents" || record.responder === "coordinator"
      ? record.responder
      : undefined;
  if (record.responder !== undefined && !responder) return undefined;
  const approvedOffer = readApprovedOffer(record.approvedOffer);
  if (record.approvedOffer !== undefined && !approvedOffer) return undefined;
  const projectContext = readProjectContextSelection(record.projectContext);
  if (record.projectContext !== undefined && !projectContext) return undefined;
  const base: ChatTurnRequest = {
    fingerprint: record.fingerprint,
    expectedReplies: record.expectedReplies,
    ...(responder ? { responder } : {}),
    ...(approvedOffer ? { approvedOffer } : {}),
    ...(projectContext ? { projectContext } : {}),
  };
  if (record.admittedSelections === undefined) return base;
  const raw = record.admittedSelections;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const admittedSelections: Record<string, ModelSelectionRecord> = {};
  for (const [speaker, entry] of Object.entries(raw)) {
    const selection = readModelSelectionRecord(entry);
    if (!speaker || !selection) return undefined;
    admittedSelections[speaker] = selection;
  }
  return { ...base, admittedSelections };
}

/**
 * The approval an attempt was authorized by, read back from disk.
 *
 * Half a record is refused rather than partially trusted: this is what stops a
 * second approval, so a version of it that lost its offer id would silently
 * stop stopping anything.
 */
/**
 * The project selection a turn was sent with, read back from disk.
 *
 * Refused whole rather than in part: a retry built from half a selection would
 * answer a different question from the attempt it is retrying.
 */
function readProjectContextSelection(
  value: unknown,
): WorkspaceProjectContextSelection | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const projectId = record.projectId;
  const includeBrief = record.includeBrief;
  const fileNames = record.fileNames;
  if (typeof projectId !== "string" || projectId.length === 0) return undefined;
  if (typeof includeBrief !== "boolean") return undefined;
  if (
    !Array.isArray(fileNames) ||
    !fileNames.every((name) => typeof name === "string")
  ) {
    return undefined;
  }
  return { projectId, includeBrief, fileNames: [...fileNames] };
}

function readApprovedOffer(
  value: unknown,
): { readonly offerId: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const offerId = record.offerId;
  if (typeof offerId !== "string" || offerId.length === 0) return undefined;
  return { offerId };
}

/**
 * The execution pointer read back from the chat log.
 *
 * Validated from `unknown` rather than asserted onto a `Partial<ChatMessage>`:
 * this field is what an operator follows to a durable journal, and a malformed
 * one would send them to an assignment that does not exist.
 */
export function isChatMessageExecutionReference(
  value: unknown,
): value is ChatMessageExecutionReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record: Record<string, unknown> = { ...value };
  return (
    typeof record.runId === "string" &&
    record.runId.length > 0 &&
    typeof record.assignmentId === "string" &&
    record.assignmentId.length > 0
  );
}

/**
 * The execution pointer as read off a chat-log line.
 *
 * Takes the whole line as `unknown` rather than a field plucked from a
 * `Partial<ChatMessage>` assertion: the assertion is what makes the other
 * fields need their own guards, and this field points an operator at a durable
 * journal, so a malformed one has to be dropped rather than trusted.
 */
export function readChatMessageExecutionReference(
  message: unknown,
): ChatMessageExecutionReference | undefined {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return undefined;
  }
  const record: Record<string, unknown> = { ...message };
  return isChatMessageExecutionReference(record.execution)
    ? record.execution
    : undefined;
}

/**
 * A conversation pointer, validated from unknown input.
 *
 * Like the execution pointer, this is what leads an operator from a message to
 * the evidence for it, so it is validated on read rather than trusted from the
 * line's own shape. A malformed pointer is dropped; the message stays readable.
 */
export function isChatMessageConversationReference(
  value: unknown,
): value is ChatMessageConversationReference {
  // Narrowed, never asserted. This value came off a file: claiming it is a
  // partial pointer is a promise about bytes nobody has checked.
  if (!isUnknownRecord(value)) return false;
  return (
    isNonEmptyString(value.conversationId) &&
    isNonEmptyString(value.activityId) &&
    isNonEmptyString(value.turnId)
  );
}

export function readChatMessageConversationReference(
  message: unknown,
): ChatMessageConversationReference | undefined {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return undefined;
  }
  const record: Record<string, unknown> = { ...message };
  return isChatMessageConversationReference(record.conversation)
    ? record.conversation
    : undefined;
}

/** A v2 source, validated from unknown input like every other pointer. */
export function isConversationMessageSource(
  value: unknown,
): value is ConversationMessageSource {
  return conversationMessageSourceSchema.safeParse(value).success;
}

export function isConversationMessageKind(
  value: unknown,
): value is ConversationMessageKind {
  return value === "chat";
}

export function isChatMessageDelivery(
  value: unknown,
): value is ChatMessageDelivery {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const delivery = value as Partial<ChatMessageDelivery>;
  if (
    typeof delivery.taskId !== "string" ||
    (delivery.executionAttemptId !== undefined &&
      typeof delivery.executionAttemptId !== "string") ||
    !Array.isArray(delivery.artifacts)
  ) {
    return false;
  }
  return delivery.artifacts.every(
    (artifact) =>
      artifact &&
      typeof artifact === "object" &&
      !Array.isArray(artifact) &&
      typeof (artifact as { runId?: unknown }).runId === "string" &&
      typeof (artifact as { path?: unknown }).path === "string" &&
      ((artifact as { title?: unknown }).title === undefined ||
        typeof (artifact as { title?: unknown }).title === "string") &&
      ((artifact as { mediaType?: unknown }).mediaType === undefined ||
        typeof (artifact as { mediaType?: unknown }).mediaType === "string") &&
      ((artifact as { digest?: unknown }).digest === undefined ||
        typeof (artifact as { digest?: unknown }).digest === "string") &&
      ((artifact as { role?: unknown }).role === "final" ||
        (artifact as { role?: unknown }).role === "secondary"),
  );
}

export function isChatMessageOutcome(
  value: unknown,
): value is ChatMessageOutcome {
  if (!isUnknownRecord(value)) return false;
  return (
    typeof value.taskId === "string" &&
    (value.executionAttemptId === undefined ||
      typeof value.executionAttemptId === "string") &&
    (value.status === "failed" || value.status === "blocked") &&
    typeof value.workflowId === "string" &&
    (value.stepId === undefined || typeof value.stepId === "string") &&
    (value.reason === undefined || typeof value.reason === "string")
  );
}

export function sanitizeUploadFilename(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const base = path
    .basename(value)
    .replace(/[^\w.\-]+/g, "_")
    .slice(0, 200);
  if (base.length === 0 || base === "." || base === "..") return null;
  return base;
}

/** A JSON object, narrowed rather than asserted. */
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
