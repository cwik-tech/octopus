/**
 * The delivery fold, tested directly.
 *
 * Two rules are invisible through the rendered bubble — a gap's scope, and that
 * nothing accumulates after a loss — because a lost reply renders a notice
 * either way. They are still the rules that decide whether a user could be
 * shown a sentence with a hole in it, so they are asserted on the pure function
 * that owns them.
 */
import { describe, expect, it } from "vitest";

import {
  applyStreamDelivery,
  EMPTY_STREAMED_TURN,
} from "@/lib/chat/streamed-turn";
import type { AgentTextStreamDelivery } from "@contracts/agent-text-stream";

it('shows progress without creating answer text and ignores activity after completion', () => {
  const delivery = {
    type: 'progress' as const, channelId: 'c', cursor: 0, replyId: 'alpha:0',
    progress: { revision: 1, startedAt: 1000, updatedAt: 1000, current: { kind: 'observed' as const, phase: 'thinking' as const }, history: [] },
  };
  const running = applyStreamDelivery(EMPTY_STREAMED_TURN, delivery);
  expect(running.replies).toEqual([]);
  expect(running.progress?.[0]?.snapshot.current).toEqual({ kind: 'observed', phase: 'thinking' });
  const finished = applyStreamDelivery(running, { type: 'final', channelId: 'c', cursor: 1, replyId: 'alpha:0', reason: 'completed' });
  expect(finished.progress?.[0]?.closed).toBe(true);
  expect(applyStreamDelivery(finished, { ...delivery, cursor: 2, progress: { ...delivery.progress, revision: 2 } })).toEqual(finished);
});

it('a reset drops progress rows, because the stream resends progress only for replies still running', () => {
  const running = applyStreamDelivery(EMPTY_STREAMED_TURN, {
    type: 'progress', channelId: 'c', cursor: 0, replyId: 'alpha:0',
    progress: { revision: 1, startedAt: 1000, updatedAt: 1000, current: { kind: 'observed', phase: 'thinking' }, history: [] },
  });
  const reset = applyStreamDelivery(running, { type: 'reset', channelId: 'c', requestedFromCursor: 1, retainedFromCursor: 100, reason: 'evicted' });
  expect(reset.progress ?? []).toEqual([]);
});

function delta(replyId: string, text: string): AgentTextStreamDelivery {
  return { type: "delta", channelId: "c", cursor: 0, replyId, channel: "text", text };
}

function gap(replyId?: string): AgentTextStreamDelivery {
  return {
    type: "gap",
    channelId: "c",
    cursor: 9,
    ...(replyId === undefined ? {} : { replyId }),
    missingProducerFrom: 1,
    missingProducerTo: 2,
  };
}

describe("applyStreamDelivery", () => {
  it("scopes a gap to its own reply and leaves the others usable", () => {
    let turn = applyStreamDelivery(EMPTY_STREAMED_TURN, delta("alpha:0", "A"));
    turn = applyStreamDelivery(turn, delta("beta:1", "B"));
    turn = applyStreamDelivery(turn, gap("alpha:0"));

    expect(turn.replies.find((r) => r.replyId === "alpha:0")?.lost).toBe(true);
    expect(turn.replies.find((r) => r.replyId === "beta:1")?.lost).toBe(false);
  });

  // ─── A gap can arrive before the reply it names exists ────────────────────
  //
  // The hub emits a gap immediately before the frame that revealed the hole
  // (`agent-text-stream-hub.ts:214-228`), and for a reply's *first* frame the
  // expected sequence is 0. So any producer whose opening frames were lost
  // publishes gap-then-delta for a replyId the fold has never seen. Dropping
  // that gap would display a suffix as a whole answer, which is precisely the
  // silent loss this module exists to prevent.

  it("a gap for a reply not yet seen makes its first delta untrusted", () => {
    let turn = applyStreamDelivery(EMPTY_STREAMED_TURN, gap("alpha:0"));
    turn = applyStreamDelivery(turn, delta("alpha:0", "swer to your question."));

    const alpha = turn.replies.find((reply) => reply.replyId === "alpha:0");
    expect(alpha?.lost).toBe(true);
    expect(alpha?.text).toBe("");
  });

  it("a gap for a reply not yet seen leaves a different reply usable", () => {
    let turn = applyStreamDelivery(EMPTY_STREAMED_TURN, gap("alpha:0"));
    turn = applyStreamDelivery(turn, delta("beta:1", "a whole answer"));

    const beta = turn.replies.find((reply) => reply.replyId === "beta:1");
    expect(beta?.lost).toBe(false);
    expect(beta?.text).toBe("a whole answer");
  });

  it("a channel-wide gap before any reply makes every later reply untrusted", () => {
    let turn = applyStreamDelivery(EMPTY_STREAMED_TURN, gap());
    turn = applyStreamDelivery(turn, delta("alpha:0", "suffix"));
    turn = applyStreamDelivery(turn, delta("beta:1", "other suffix"));

    expect(turn.replies.length).toBe(2);
    expect(turn.replies.every((reply) => reply.lost)).toBe(true);
  });

  it("a gap with no replyId marks the whole channel lost", () => {
    let turn = applyStreamDelivery(EMPTY_STREAMED_TURN, delta("alpha:0", "A"));
    turn = applyStreamDelivery(turn, delta("beta:1", "B"));
    turn = applyStreamDelivery(turn, gap());

    expect(turn.replies.every((reply) => reply.lost)).toBe(true);
  });

  it("never appends to a reply after a gap", () => {
    let turn = applyStreamDelivery(EMPTY_STREAMED_TURN, delta("alpha:0", "Hello "));
    turn = applyStreamDelivery(turn, gap("alpha:0"));
    turn = applyStreamDelivery(turn, delta("alpha:0", "world"));

    expect(turn.replies[0]?.text).toBe("Hello ");
  });

  it("keeps appending to a reply the gap did not name", () => {
    let turn = applyStreamDelivery(EMPTY_STREAMED_TURN, delta("alpha:0", "A"));
    turn = applyStreamDelivery(turn, delta("beta:1", "B"));
    turn = applyStreamDelivery(turn, gap("alpha:0"));
    turn = applyStreamDelivery(turn, delta("beta:1", "B2"));

    expect(turn.replies.find((r) => r.replyId === "beta:1")?.text).toBe("BB2");
  });

  it("never appends to a reply after an error", () => {
    let turn = applyStreamDelivery(EMPTY_STREAMED_TURN, delta("alpha:0", "A"));
    turn = applyStreamDelivery(turn, {
      type: "error",
      channelId: "c",
      cursor: 1,
      replyId: "alpha:0",
      message: "failed",
    });
    turn = applyStreamDelivery(turn, delta("alpha:0", "more"));

    expect(turn.replies[0]?.text).toBe("A");
    expect(turn.replies[0]?.failed).toBe("failed");
  });

  it("a reset clears the replies and marks the turn a partial view", () => {
    let turn = applyStreamDelivery(EMPTY_STREAMED_TURN, delta("alpha:0", "stale"));
    turn = applyStreamDelivery(turn, {
      type: "reset",
      channelId: "c",
      requestedFromCursor: 0,
      retainedFromCursor: 100,
      reason: "evicted",
    });

    expect(turn.replies).toEqual([]);
    expect(turn.partialView).toBe(true);
    // The retained window still renders, under the partial-view label.
    turn = applyStreamDelivery(turn, delta("alpha:0", "tail"));
    expect(turn.replies[0]?.text).toBe("tail");
    expect(turn.partialView).toBe(true);
  });

  it("a final closes its own reply against later deltas", () => {
    let turn = applyStreamDelivery(EMPTY_STREAMED_TURN, delta("alpha:0", "A"));
    turn = applyStreamDelivery(turn, {
      type: "final",
      channelId: "c",
      cursor: 1,
      replyId: "alpha:0",
      reason: "completed",
    });
    turn = applyStreamDelivery(turn, delta("alpha:0", " stray"));

    expect(turn.replies[0]?.text).toBe("A");
  });

  it("a truncated final keeps the partial text and marks it discarded", () => {
    // The user has already read this text. It must stay on screen — but it is
    // not the answer, because the provider threw the partial away, so the fold
    // records that so the bubble can say so.
    let turn = applyStreamDelivery(EMPTY_STREAMED_TURN, delta("alpha:0", "The answer beg"));
    turn = applyStreamDelivery(turn, {
      type: "final",
      channelId: "c",
      cursor: 3,
      replyId: "alpha:0",
      reason: "truncated",
    });

    expect(turn.replies[0]?.text).toBe("The answer beg");
    expect(turn.replies[0]?.truncated).toBe(true);
    expect(turn.replies[0]?.closed).toBe(true);
  });

  it("a completed final does not mark the reply truncated", () => {
    let turn = applyStreamDelivery(EMPTY_STREAMED_TURN, delta("alpha:0", "Whole answer"));
    turn = applyStreamDelivery(turn, {
      type: "final",
      channelId: "c",
      cursor: 3,
      replyId: "alpha:0",
      reason: "completed",
    });

    expect(turn.replies[0]?.truncated).toBeFalsy();
  });

  it("a final for one reply leaves another reply appendable", () => {
    let turn = applyStreamDelivery(EMPTY_STREAMED_TURN, delta("alpha:0", "A"));
    turn = applyStreamDelivery(turn, delta("beta:1", "B"));
    turn = applyStreamDelivery(turn, {
      type: "final",
      channelId: "c",
      cursor: 2,
      replyId: "alpha:0",
      reason: "completed",
    });
    turn = applyStreamDelivery(turn, delta("beta:1", "B2"));

    expect(turn.replies.find((r) => r.replyId === "beta:1")?.text).toBe("BB2");
  });
});

describe("live model selection", () => {
  const record = {
    provider: "connection:abc",
    model: "gpt-5.4-mini",
    source: "app-default" as const,
    reason: "agent-default" as const,
    caller: "agent" as const,
  };

  function selection(replyId: string): AgentTextStreamDelivery {
    return {
      type: "selection",
      channelId: "c",
      cursor: 0,
      replyId,
      speaker: "Reviewer",
      selection: record,
    };
  }

  it("carries a selection that arrives before the reply's first token", () => {
    const turn = applyStreamDelivery(EMPTY_STREAMED_TURN, selection("a:0"));

    expect(turn.selections).toEqual([
      { replyId: "a:0", speaker: "Reviewer", selection: record },
    ]);
  });

  it("keeps the notice once the reply starts producing text", () => {
    const turn = applyStreamDelivery(
      applyStreamDelivery(EMPTY_STREAMED_TURN, selection("a:0")),
      delta("a:0", "Hello"),
    );

    expect(turn.selections).toHaveLength(1);
    expect(turn.replies[0]?.text).toBe("Hello");
  });

  it("keeps one notice per speaker when the same frame is replayed", () => {
    // A reconnect replays the retained window from its cursor, so the same
    // frame arrives twice. Two notices for one attempt would read as two
    // attempts.
    const turn = applyStreamDelivery(
      applyStreamDelivery(EMPTY_STREAMED_TURN, selection("a:0")),
      selection("a:0"),
    );

    expect(turn.selections).toHaveLength(1);
  });

  it("keeps notices across a reset, which only says the text is a suffix", () => {
    // A reset means the retained *text* is not contiguous with what came
    // before. The selection is not text: it was decided once, before the
    // provider was called, and it is backed by the turn's durable record.
    // Dropping it leaves the reply running with no visible model until the
    // turn completes — the gap this notice exists to close.
    const reset: AgentTextStreamDelivery = {
      type: "reset",
      channelId: "c",
      requestedFromCursor: 0,
      retainedFromCursor: 5,
      reason: "evicted",
    };
    const turn = applyStreamDelivery(
      applyStreamDelivery(EMPTY_STREAMED_TURN, selection("a:0")),
      reset,
    );

    expect(turn.selections).toEqual([
      { replyId: "a:0", speaker: "Reviewer", selection: record },
    ]);
    expect(turn.partialView).toBe(true);
    expect(turn.replies).toEqual([]);
  });
});
