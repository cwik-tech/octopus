/**
 * What becomes of a Team's live preview when its dispatch ends.
 *
 * Two engine families end differently, and pretending otherwise would mean
 * lying about one of them. A discussion records a durable message, so its
 * preview is replaced by the transcript's own copy and this module stands
 * aside. A chain records none — and a reply that grows and then vanishes
 * leaves the user looking at the space where an answer used to be, which is
 * worse than never having shown it. There the bubble becomes the step's own
 * outcome, naming where the answer went.
 *
 * Kept pure so both endings can be stated as data. The component only renders
 * what this decides.
 */
import type { StreamedReply, StreamedTurn } from "@/lib/chat/streamed-turn";

/**
 * How an attempt ended.
 *
 * Kept distinct because the label the user reads is the only account they get
 * of what happened: a failed or cancelled attempt described as "completed" is
 * worse than no label at all.
 */
export type TeamStreamOutcome =
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled"
  | "incomplete";

/** One concrete attempt the run has announced. */
export interface TeamStreamDispatch {
  readonly dispatchId: string;
  readonly agentName: string;
  /** The dispatch has closed, successfully or not. */
  readonly ended: boolean;
  readonly outcome?: TeamStreamOutcome;
  /** The run recorded a message of its own for this dispatch. */
  readonly hasDurableMessage: boolean;
  /** Where this step's answer went, when the run has named it. */
  readonly artifactPath?: string;
  /** What the attempt said about its own failure, when it said anything. */
  readonly failureReason?: string;
}

export type TeamStreamHandoff =
  | {
      readonly kind: "streaming";
      readonly dispatchId: string;
      readonly agentName: string;
      readonly reply: StreamedReply;
    }
  | {
      readonly kind: "handoff";
      readonly dispatchId: string;
      readonly agentName: string;
      /** Short, readable: the artifact if known, otherwise the outcome. */
      readonly label: string;
      /** Why the step failed, in the run's own words, when it gave a reason. */
      readonly detail?: string;
    };

/**
 * What to say about an attempt that produced no durable message.
 *
 * Only a step that actually finished may name an artifact: one written by an
 * earlier step is not where this step's answer went, and saying so would send
 * the reader to the wrong file.
 */
function handoffLabel(dispatch: TeamStreamDispatch): string {
  switch (dispatch.outcome) {
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "cancelled":
      return "cancelled";
    case "incomplete":
      return "incomplete";
    default:
      return dispatch.artifactPath ?? "completed";
  }
}

export function resolveTeamStreamHandoff(input: {
  streamedTurn: StreamedTurn;
  dispatches: readonly TeamStreamDispatch[];
}): TeamStreamHandoff[] {
  const byDispatch = new Map(
    input.dispatches.map((dispatch) => [dispatch.dispatchId, dispatch]),
  );

  const resolved: TeamStreamHandoff[] = [];
  for (const reply of input.streamedTurn.replies) {
    const dispatch = byDispatch.get(reply.replyId);
    // Text for a dispatch the run never announced has no speaker to attribute
    // it to, so there is nothing honest to render.
    if (!dispatch) continue;
    // The transcript already holds this answer; a preview beside it would show
    // the same text twice.
    if (dispatch.hasDurableMessage) continue;

    if (!dispatch.ended) {
      resolved.push({
        kind: "streaming",
        dispatchId: dispatch.dispatchId,
        agentName: dispatch.agentName,
        reply,
      });
      continue;
    }

    resolved.push({
      kind: "handoff",
      dispatchId: dispatch.dispatchId,
      agentName: dispatch.agentName,
      label: handoffLabel(dispatch),
      ...(dispatch.failureReason === undefined
        ? {}
        : { detail: dispatch.failureReason }),
    });
  }
  return resolved;
}
