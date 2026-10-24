/**
 * The in-flight side of a streaming chat turn: a pure fold over deliveries.
 *
 * Kept out of ChatPanel so the rules that decide what a user is shown mid-turn
 * can be read and tested on their own, rather than through a large component.
 * The component holds the result in state and renders it; every decision about
 * what survives a loss lives here.
 */
import type { AgentTextStreamDelivery } from "@contracts/agent-text-stream";
import type { ModelSelectionRecord } from "@contracts/agent-model-selection";
import type { AgentProgressSnapshot } from "@contracts/agent-progress";

export interface StreamedProgress {
  readonly channelId: string;
  readonly replyId: string;
  readonly snapshot: AgentProgressSnapshot;
  readonly closed: boolean;
}

/** One in-flight bubble: text accumulated for a single `replyId`. */
export interface StreamedReply {
  readonly replyId: string;
  readonly text: string;
  /** Set once a gap makes this reply's accumulated text untrustworthy. */
  readonly lost: boolean;
  /** Set by a terminal `error` frame; the reply produced no answer. */
  readonly failed?: string;
  /** Set by a terminal `final` frame; the reply has said all it will say. */
  readonly closed?: boolean;
  /**
   * Set when that `final` said `truncated`: the provider hit its output ceiling
   * and discarded the partial answer rather than returning it. The text stays —
   * the user has already read it — but it is not the reply.
   */
  readonly truncated?: boolean;
}

/** How one in-flight reply's provider and model were decided. */
export interface StreamedSelection {
  readonly replyId: string;
  readonly speaker: string;
  readonly selection: ModelSelectionRecord;
}

export interface StreamedTurn {
  readonly progress?: readonly StreamedProgress[];
  readonly replies: readonly StreamedReply[];
  /**
   * Admitted selections for replies that have not finished, in arrival order,
   * whatever their source.
   *
   * Held beside the replies rather than on them because the selection arrives
   * before the reply's first token, and a reply that never produces one still
   * has to say which model it was admitted on.
   */
  readonly selections: readonly StreamedSelection[];
  /**
   * Set by a `reset`: what follows is a suffix of the answer, not the whole of
   * it, so the bubble says so rather than reading as a complete reply.
   */
  readonly partialView: boolean;
  /**
   * Set by a `gap` that named no reply, which reports loss somewhere in the
   * channel without saying where. Every reply is then untrustworthy — including
   * ones that have not appeared yet, which is why this outlives the replies
   * present when the gap arrived.
   */
  readonly channelLost: boolean;
}

export const EMPTY_STREAMED_TURN: StreamedTurn = {
  replies: [],
  selections: [],
  partialView: false,
  channelLost: false,
};

/** True when nothing further may be appended to this reply. */
function isSettled(reply: StreamedReply): boolean {
  return reply.lost || reply.failed !== undefined || reply.closed === true;
}

/**
 * Fold one delivery into the in-flight bubbles.
 *
 * Loss is never silent, and that has to hold for a reply the fold has not seen
 * yet. A `gap` marks its own reply unusable — creating it already lost when it
 * has not appeared, because the hub reports a hole immediately before the frame
 * that revealed it, and a reply whose opening frames were lost reveals it on its
 * first frame. A gap carrying no `replyId` says only that something in the
 * channel was lost, so it taints every reply including later ones. Either way
 * nothing appended afterwards would follow the last character the user actually
 * saw. A `reset` discards what was held — it is no longer contiguous with what
 * follows — and marks the turn a partial view, so the retained window still
 * renders but is labelled.
 *
 * Terminals are per reply. A `final` or `error` closes one speaker against
 * later deltas and leaves every other speaker's bubble live, which is what
 * "each closing independently" has to mean for a multi-speaker turn.
 */
export function applyStreamDelivery(
  current: StreamedTurn,
  delivery: AgentTextStreamDelivery,
): StreamedTurn {
  if (delivery.type === "reset") {
    // `channelLost` does not survive: the retained window is contiguous from
    // its own start, and whatever an earlier channel-wide gap described is
    // either replayed inside that window — re-setting the flag — or older than
    // it, which `partialView` already says.
    // The replies go; the notices stay. A reset says the retained *text* is
    // not contiguous with what came before, which is a statement about text.
    // A selection is not text: it was decided once, before the provider was
    // called, and the turn's durable record is its authority. Dropping it here
    // would leave a reply visibly running with no model named until the turn
    // completed — the gap the notice exists to close.
    // Progress goes too: a reply's terminal can be in the evicted window, and
    // the stream follows a reset with snapshots of the replies still running.
    return {
      ...current,
      ...(current.progress ? { progress: [] } : {}),
      replies: [],
      partialView: true,
      channelLost: false,
    };
  }

  if (delivery.type === "gap") {
    // A gap can arrive before the reply it names has been seen. The hub records
    // the hole immediately before the frame that revealed it, and a reply whose
    // opening frames were lost reveals it on its very first frame. Marking only
    // the replies that already exist would drop that gap on the floor and let
    // the delta behind it open a trusted bubble holding a bare suffix.
    const known = current.replies.some(
      (reply) => reply.replyId === delivery.replyId,
    );
    return {
      ...current,
      ...(delivery.replyId === undefined ? { channelLost: true } : {}),
      replies:
        delivery.replyId !== undefined && !known
          ? [
              ...current.replies,
              { replyId: delivery.replyId, text: "", lost: true },
            ]
          : current.replies.map((reply) =>
              delivery.replyId === undefined || reply.replyId === delivery.replyId
                ? { ...reply, lost: true }
                : reply,
            ),
    };
  }

  if (delivery.type === 'progress' || delivery.type === 'progress-snapshot') {
    const progress = current.progress ?? [];
    const existing = progress.find(entry => entry.replyId === delivery.replyId && entry.channelId === delivery.channelId);
    if (existing?.closed || (existing && existing.snapshot.revision >= delivery.progress.revision) || current.replies.some(reply => reply.replyId === delivery.replyId && isSettled(reply))) return current;
    const entry = { channelId: delivery.channelId, replyId: delivery.replyId, snapshot: delivery.progress, closed: false };
    return { ...current, progress: existing ? progress.map(value => value === existing ? entry : value) : [...progress, entry] };
  }

  if (delivery.type === "error") {
    const known = current.replies.some(
      (reply) => reply.replyId === delivery.replyId,
    );
    return {
      ...current,
      ...(current.progress ? { progress: current.progress.map(entry => entry.replyId === delivery.replyId ? { ...entry, closed: true } : entry) } : {}),
      replies: known
        ? current.replies.map((reply) =>
            reply.replyId === delivery.replyId
              ? { ...reply, failed: delivery.message }
              : reply,
          )
        : [
            ...current.replies,
            {
              replyId: delivery.replyId,
              text: "",
              lost: false,
              failed: delivery.message,
            },
          ],
    };
  }

  if (delivery.type === "selection") {
    // A reconnect replays the retained window, so the same frame arrives
    // twice. Two notices for one attempt would read as two attempts.
    const known = current.selections.some(
      (entry) => entry.replyId === delivery.replyId,
    );
    if (known) return current;
    return {
      ...current,
      selections: [
        ...current.selections,
        {
          replyId: delivery.replyId,
          speaker: delivery.speaker,
          selection: delivery.selection,
        },
      ],
    };
  }

  if (delivery.type === "final") {
    return {
      ...current,
      ...(current.progress ? { progress: current.progress.map(entry => entry.replyId === delivery.replyId ? { ...entry, closed: true } : entry) } : {}),
      replies: current.replies.map((reply) =>
        reply.replyId === delivery.replyId
          ? {
              ...reply,
              closed: true,
              ...(delivery.reason === "truncated" ? { truncated: true } : {}),
            }
          : reply,
      ),
    };
  }

  const existing = current.replies.find(
    (reply) => reply.replyId === delivery.replyId,
  );
  if (!existing) {
    // A channel-wide gap taints replies that had not appeared when it arrived,
    // so a first delta after one opens an already-lost bubble rather than a
    // trusted one holding a suffix.
    return {
      ...current,
      replies: [
        ...current.replies,
        current.channelLost
          ? { replyId: delivery.replyId, text: "", lost: true }
          : { replyId: delivery.replyId, text: delivery.text, lost: false },
      ],
    };
  }
  if (isSettled(existing)) return current;
  return {
    ...current,
    replies: current.replies.map((reply) =>
      reply.replyId === delivery.replyId
        ? { ...reply, text: reply.text + delivery.text }
        : reply,
    ),
  };
}
