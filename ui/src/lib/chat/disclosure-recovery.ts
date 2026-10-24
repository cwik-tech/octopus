/**
 * Listening again for a disclosure that may have been missed.
 *
 * A turn publishes which model it runs on before the provider is called, on a
 * stream that is a preview: it can drop, and its client returns normally once
 * its retries are exhausted — so a subscription ending is not the same as it
 * having delivered. While the same turn is still running and has said nothing,
 * the record the server wrote is the only place the disclosure can come from,
 * and the stream may be worth listening to again.
 *
 * Both rules live here rather than inside the panel because a wrong answer
 * there looks like a rendering problem: text painted twice, or a notice that
 * never appears for a provider still thinking.
 */

/** A stream frame, as far as resuming is concerned. */
export interface StreamCursorDelivery {
  readonly type: string;
  readonly cursor?: number;
}

/**
 * Where to resume reading from, given a frame just seen.
 *
 * Monotonic, because frames can arrive out of order across a reconnect and
 * taking the newest at face value would rewind the reader and replay text
 * already on screen. A `reset` advances nothing: it says frames were lost, not
 * that one was read, and counting it would skip the frames a recovery exists to
 * find.
 */
export function advancedStreamCursor(
  current: number,
  delivery: StreamCursorDelivery,
): number {
  if (delivery.type === "reset" || typeof delivery.cursor !== "number") {
    return current;
  }
  return Math.max(current, delivery.cursor + 1);
}

export type DisclosureRecoveryPlan =
  | "stop"
  | "reload-only"
  | "reload-and-resubscribe";

/**
 * What to do when a subscription ends or reports lost frames.
 *
 * `stop` where there is nothing owed: the panel has moved on, or the turn has
 * already said what it runs on — which an explicit choice does by saying
 * nothing at all, so a notice on screen is not the test.
 *
 * `reload-only` where the record is worth re-reading but a second reader is
 * not: one is already live, or the bounded attempts are spent. Bounded by
 * attempts rather than a timer, because a timer either gives up on a slow
 * provider or never stops.
 */
export function planDisclosureRecovery(state: {
  readonly activeJobId: string | null;
  readonly jobId: string;
  readonly selectionSeen: boolean;
  readonly readerActive: boolean;
  readonly remainingResubscribes: number;
}): DisclosureRecoveryPlan {
  if (state.activeJobId !== state.jobId || state.selectionSeen) return "stop";
  if (state.readerActive || state.remainingResubscribes <= 0) {
    return "reload-only";
  }
  return "reload-and-resubscribe";
}
