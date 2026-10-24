/**
 * Which result references a session's authoritative state implies.
 *
 * Pure. It reads task records and the transcript and says what should exist;
 * persisting the difference is the shell's job.
 *
 * Derived rather than emitted at each terminal transition, for two reasons.
 * A chat-only Team reaches `done` without publishing anything — the runner
 * publishes no artifacts in team-chat mode and no delivery card follows — so
 * the eager hook would have to be added to a path that currently produces
 * nothing, in three places with three different notions of "finished". And a
 * derivation also covers work that completed before this build existed, which
 * an emitter never can.
 *
 * Idempotence is the same either way: the id is the producer plus its
 * execution attempt, so re-deriving yields the record already held.
 *
 * See `docs/adr/2026-09-09-Continuation-Context-Result-References.md`.
 */

import type {
  ChatMessage,
  ChatMessageDelivery,
  SessionTask,
} from "../../contracts/sessions.js";
import {
  RESULT_REFERENCE_SCHEMA_VERSION,
  resultReferenceId,
  type ResultReference,
} from "../../contracts/schemas/result-reference.js";

/** Terminal states a result may be offered from. Only success continues. */
const CONTINUABLE_STATUS = "done";

/**
 * The delivery card a task's current attempt published, if it published one.
 *
 * Exported because projection and use-time validation must agree about which
 * card belongs to a task. They matched by different rules — one filtered on
 * the execution attempt and the other took the first card with the right task
 * id — so after a retry left two cards behind, one of them could carry stale
 * bytes under a new result id while the other rejected the current result as
 * changed for ever.
 *
 * A card that records no attempt matches a task that records none, and either
 * way the newest matching card wins: a retry publishes after the attempt it
 * replaced.
 */
export function findTaskDelivery(
  messages: readonly ChatMessage[],
  task: Pick<SessionTask, "id" | "executionAttemptId">,
): ChatMessageDelivery | undefined {
  let found: ChatMessageDelivery | undefined;
  for (const message of messages) {
    const delivery = message.delivery;
    if (!delivery || delivery.taskId !== task.id) continue;
    if (
      task.executionAttemptId !== undefined &&
      delivery.executionAttemptId !== undefined &&
      delivery.executionAttemptId !== task.executionAttemptId
    ) {
      continue;
    }
    found = delivery;
  }
  return found;
}

export function projectResultReferences(input: {
  sessionId: string;
  tasks: readonly SessionTask[];
  messages: readonly ChatMessage[];
}): ResultReference[] {
  return [
    ...projectTaskResults(input),
    ...projectAgentReplyResults(input),
  ];
}

/**
 * One reference per completed Team or Workflow run.
 *
 * A run that published artifacts points at its primary one. A chat-only Team
 * published none, and points at its run instead: the accepted messages and the
 * terminal summary in run state are its output, and manufacturing a delivery
 * artifact merely to give the reader something to open would put a file on
 * disk that the Team deliberately did not produce.
 */
function projectTaskResults(input: {
  sessionId: string;
  tasks: readonly SessionTask[];
  messages: readonly ChatMessage[];
}): ResultReference[] {
  const references: ResultReference[] = [];
  for (const task of input.tasks) {
    if (task.status !== CONTINUABLE_STATUS) continue;
    const delivery = findTaskDelivery(input.messages, task);
    const primary =
      delivery?.artifacts.find((artifact) => artifact.role === "final") ??
      delivery?.artifacts[0];
    const producer: ResultReference["producer"] = task.teamId
      ? { kind: "team", id: task.teamId, label: task.teamId }
      : { kind: "workflow", id: task.workflowId, label: task.workflowId };
    // A run-summary pointer is the chat-only Team's shape, not a fallback for
    // anything that happens to have no delivery yet. A Workflow's delivery is
    // published by a path that can still be catching up, and a provisional
    // pointer written here would be frozen: the id is final, so a later pass
    // skips it and the real artifact never replaces it.
    if (!primary && producer.kind === "workflow") continue;
    references.push({
      schemaVersion: RESULT_REFERENCE_SCHEMA_VERSION,
      id: resultReferenceId({
        producerKind: producer.kind,
        producerId: task.id,
        ...(task.executionAttemptId
          ? { executionAttemptId: task.executionAttemptId }
          : {}),
      }),
      sessionId: input.sessionId,
      producer,
      status: CONTINUABLE_STATUS,
      completedAt: task.completedAt ?? task.updatedAt ?? task.createdAt,
      ...(task.brief ? { brief: boundedBrief(task.brief) } : {}),
      producerTaskId: task.id,
      ...(task.executionAttemptId
        ? { executionAttemptId: task.executionAttemptId }
        : {}),
      source: primary
        ? {
            kind: "artifact",
            runId: primary.runId,
            path: primary.path,
            ...(primary.digest ? { digest: primary.digest } : {}),
          }
        : { kind: "run-summary", runId: task.runId },
      ...(delivery && delivery.artifacts.length > 0
        ? {
            artifacts: delivery.artifacts.slice(0, 20).map((artifact) => ({
              runId: artifact.runId,
              path: artifact.path,
              ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {}),
              ...(artifact.digest ? { digest: artifact.digest } : {}),
            })),
          }
        : {}),
    });
  }
  return references;
}

/**
 * One reference per direct Agent reply.
 *
 * The reply is already in the transcript, so this matters where the transcript
 * no longer reaches it: a reply older than the window a model receives, or one
 * a different responder is being asked about.
 */
/**
 * How many Agent replies a session offers as results.
 *
 * Every reply is a candidate, and a long conversation would otherwise grow the
 * reference log without limit. The most recent are the ones a follow-up is
 * about; older replies are still in the transcript, which is where they were
 * always read from.
 */
export const MAX_AGENT_REPLY_RESULTS = 50;

function projectAgentReplyResults(input: {
  sessionId: string;
  messages: readonly ChatMessage[];
}): ResultReference[] {
  const references: ResultReference[] = [];
  for (const [index, message] of input.messages.entries()) {
    if (message.role !== "assistant") continue;
    const speaker = message.speaker;
    if (speaker?.type !== "agent") continue;
    const question = questionAnswered(input.messages, index, message.turnId);
    // The producer is the reply, not the agent: one agent answering twice
    // produced two results, and a reader choosing between them needs both.
    references.push({
      schemaVersion: RESULT_REFERENCE_SCHEMA_VERSION,
      id: resultReferenceId({
        producerKind: "agent",
        producerId: speaker.id,
        executionAttemptId: message.id,
      }),
      sessionId: input.sessionId,
      producer: { kind: "agent", id: speaker.id, label: speaker.name },
      status: CONTINUABLE_STATUS,
      completedAt: message.createdAt,
      // What was asked and how the answer opens. One agent answering twice in
      // the same minute is otherwise two choices with identical labels.
      ...(question ? { brief: boundedBrief(question) } : {}),
      ...(excerptOf(message.text) ? { excerpt: excerptOf(message.text) } : {}),
      source: { kind: "chat-message", messageId: message.id },
    });
  }
  return references.slice(-MAX_AGENT_REPLY_RESULTS);
}

/**
 * The user message this reply answered.
 *
 * By turn first, which is exact. A line written before turns were recorded has
 * no turn, so the nearest preceding user message is used instead: it is what a
 * reader scrolling back would take it to be answering.
 */
function questionAnswered(
  messages: readonly ChatMessage[],
  replyIndex: number,
  turnId: string | undefined,
): string | undefined {
  if (turnId !== undefined) {
    const sameTurn = messages.find(
      (message) => message.role === "user" && message.turnId === turnId,
    );
    if (sameTurn) return sameTurn.text;
  }
  for (let index = replyIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate?.role === "user") return candidate.text;
  }
  return undefined;
}

/** The opening of a reply, collapsed to one line. */
function excerptOf(text: string): string | undefined {
  const single = text.replace(/\s+/g, " ").trim();
  if (!single) return undefined;
  return single.length <= 300 ? single : `${single.slice(0, 299)}…`;
}

/** The schema caps this; cutting here keeps a long brief from being refused. */
function boundedBrief(brief: string): string {
  const single = brief.replace(/\s+/g, " ").trim();
  return single.length <= 2000 ? single : `${single.slice(0, 1999)}…`;
}
