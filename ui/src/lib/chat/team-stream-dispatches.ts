/**
 * What a run's own events say about its display stream.
 *
 * Two things come from the run rather than from the stream: which channel to
 * read, and which attempts exist inside it. Both are read from events the UI
 * already receives, so nothing new has to be persisted or polled for.
 *
 * Three rules shape this, and each exists because getting it wrong shows the
 * user something untrue.
 *
 * - **One run at a time.** A session accumulates every task it has ever run.
 *   Read as one list, a previous run's channel and a previous run's ending
 *   would apply to the run being watched now, ending its attempts the moment
 *   they start.
 * - **Each step owns the artifact it wrote.** A chain writes one per step.
 *   Labelling every handoff with the last one tells the user their first
 *   step's answer went somewhere it did not.
 * - **A later attempt replaces the one it supersedes.** A retry and a fallback
 *   belong to the same logical call, and showing the failed partial beside the
 *   answer that replaced it reads as two speakers disagreeing.
 *
 * Closing an attempt is event-driven, never timed.
 */
import type { RunEvent } from "@/components/run/stage-renderers/index";
import type {
  TeamStreamDispatch,
  TeamStreamOutcome,
} from "@/lib/chat/team-stream-handoff";

/**
 * How a run's own ending closes attempts that never got one.
 *
 * The backstop must close a bubble, not invent a successful ending for it:
 * only a run that completed may leave its open attempts looking completed.
 */
const RUN_TERMINAL_OUTCOMES: Readonly<Record<string, TeamStreamOutcome>> = {
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
  "run.incomplete": "incomplete",
};

/** How an attempt's own ending is read. */
const DISPATCH_TERMINAL_OUTCOMES: Readonly<Record<string, TeamStreamOutcome>> = {
  "agent.end": "completed",
  "agent.fail": "failed",
  "agent.skip": "skipped",
};

/** One task's events, as the run panel groups them. */
export interface TeamStreamTaskGroup {
  readonly taskId: string;
  readonly events: readonly RunEvent[];
}

export interface TeamStreamProjection {
  /** Absent until a run announces one. */
  readonly channelId?: string;
  readonly dispatches: readonly TeamStreamDispatch[];
}

interface MutableDispatch {
  dispatchId: string;
  logicalInvocationId: string;
  agentName: string;
  ended: boolean;
  outcome: TeamStreamOutcome;
  hasDurableMessage: boolean;
  artifactPath?: string;
  failureReason?: string;
}

export function buildTeamStreamDispatches(
  groups: readonly TeamStreamTaskGroup[],
): TeamStreamProjection {
  // The run being watched is the newest one that announced a channel. Older
  // tasks in the same session are finished history and say nothing about it.
  const active = [...groups]
    .reverse()
    .find((group) => group.events.some((event) => event.textChannelId));
  if (!active) return { dispatches: [] };

  let channelId: string | undefined;
  let runOutcome: TeamStreamOutcome | undefined;
  /** The attempt an artifact written now belongs to. */
  let currentDispatchId: string | undefined;
  const order: string[] = [];
  const byDispatch = new Map<string, MutableDispatch>();

  for (const event of active.events) {
    if (event.textChannelId) channelId = event.textChannelId;
    const terminal = RUN_TERMINAL_OUTCOMES[event.type];
    if (terminal) runOutcome = terminal;

    if (event.type === "artifact.written" && event.artifactPath) {
      const owner = currentDispatchId
        ? byDispatch.get(currentDispatchId)
        : undefined;
      if (owner) owner.artifactPath = event.artifactPath;
      continue;
    }

    const dispatchId = event.dispatchId;
    if (!dispatchId) continue;
    currentDispatchId = dispatchId;

    const existing = byDispatch.get(dispatchId);
    if (!existing) order.push(dispatchId);
    const dispatch: MutableDispatch = existing ?? {
      dispatchId,
      // Absent on older events; falling back to the dispatch id keeps every
      // attempt in its own logical call rather than merging unrelated ones.
      logicalInvocationId: event.logicalInvocationId ?? dispatchId,
      agentName: event.agentName ?? dispatchId,
      ended: false,
      outcome: "running",
      hasDurableMessage: false,
    };
    byDispatch.set(dispatchId, dispatch);

    // A later event may carry a better display name than the first did.
    if (event.agentName) dispatch.agentName = event.agentName;
    const dispatchOutcome = DISPATCH_TERMINAL_OUTCOMES[event.type];
    if (dispatchOutcome) {
      dispatch.ended = true;
      dispatch.outcome = dispatchOutcome;
    }
    // What the attempt said about its own failure. A bare "failed" says
    // nothing the bubble does not already say.
    if (
      event.type === "agent.fail" &&
      event.errorMessage &&
      event.errorMessage.trim().toLowerCase() !== "failed"
    ) {
      dispatch.failureReason = event.errorMessage;
    }
    // Either family closes the preview: the transcript now holds this
    // answer, so showing the bubble beside it would print it twice. The
    // durable message may arrive after `agent.end`, which is why this is read
    // from the whole event list rather than from arrival order.
    if (event.type === "team.message" || event.type === "discussion.message") {
      dispatch.hasDurableMessage = true;
    }
  }

  // Only the newest attempt of each logical call survives. A fallback runs a
  // different agent under the same call, so "same agent, next attempt" is not
  // the rule — the logical id is.
  const newestByCall = new Map<string, string>();
  for (const dispatchId of order) {
    const dispatch = byDispatch.get(dispatchId);
    if (dispatch) newestByCall.set(dispatch.logicalInvocationId, dispatchId);
  }

  const dispatches = order
    .filter(
      (dispatchId) =>
        newestByCall.get(
          byDispatch.get(dispatchId)?.logicalInvocationId ?? dispatchId,
        ) === dispatchId,
    )
    .map((dispatchId) => {
      const dispatch = byDispatch.get(dispatchId);
      if (!dispatch) throw new Error(`Unknown dispatch ${dispatchId}`);
      // An attempt that ended on its own keeps that ending; the run's outcome
      // only speaks for attempts that never got one.
      const ended = dispatch.ended || runOutcome !== undefined;
      return {
        dispatchId: dispatch.dispatchId,
        agentName: dispatch.agentName,
        ended,
        outcome: dispatch.ended
          ? dispatch.outcome
          : (runOutcome ?? dispatch.outcome),
        hasDurableMessage: dispatch.hasDurableMessage,
        ...(dispatch.artifactPath === undefined
          ? {}
          : { artifactPath: dispatch.artifactPath }),
        ...(dispatch.failureReason === undefined
          ? {}
          : { failureReason: dispatch.failureReason }),
      };
    });

  return {
    ...(channelId === undefined ? {} : { channelId }),
    dispatches,
  };
}
