/**
 * What becomes of a Team's live preview when its dispatch ends.
 *
 * Two engine families end differently, and the difference is visible. A
 * discussion records a durable message, so the preview is replaced by it. A
 * chain records none, so there is nothing to replace it with — but a reply
 * that grows and then vanishes leaves the user looking at the space where an
 * answer used to be, which is worse than never showing it. The bubble becomes
 * the step's own outcome instead.
 */
import { describe, expect, it } from "vitest";

import { buildTeamStreamDispatches } from "@/lib/chat/team-stream-dispatches";
import {
  resolveTeamStreamHandoff,
  type TeamStreamDispatch,
} from "@/lib/chat/team-stream-handoff";
import {
  EMPTY_STREAMED_TURN,
  applyStreamDelivery,
  type StreamedTurn,
} from "@/lib/chat/streamed-turn";

const DISPATCH = "invocation#1#line-one";

function streamed(replyId: string, ...texts: readonly string[]): StreamedTurn {
  return texts.reduce<StreamedTurn>(
    (current, text) =>
      applyStreamDelivery(current, {
        type: "delta",
        channelId: "channel",
        cursor: 0,
        replyId,
        channel: "text",
        text,
      }),
    EMPTY_STREAMED_TURN,
  );
}

function dispatch(overrides: Partial<TeamStreamDispatch> = {}): TeamStreamDispatch {
  return {
    dispatchId: DISPATCH,
    agentName: "Line One",
    ended: false,
    hasDurableMessage: false,
    ...overrides,
  };
}

/**
 * A reply is matched on its text alone; its other fields are the stream's
 * bookkeeping. Typed `unknown` because vitest types its matchers as `any`.
 */
function replyWithText(text: string): unknown {
  return expect.objectContaining({ text })
}

describe("team stream handoff", () => {
  it("shows the growing reply while its dispatch is still running", () => {
    const handoff = resolveTeamStreamHandoff({
      streamedTurn: streamed(DISPATCH, "The first tradeoff"),
      dispatches: [dispatch()],
    });

    expect(handoff).toEqual([
      {
        kind: "streaming",
        dispatchId: DISPATCH,
        agentName: "Line One",
        reply: replyWithText("The first tradeoff"),
      },
    ]);
  });

  it("stands aside once the run has recorded the message itself", () => {
    // A discussion's durable message renders through the transcript. Leaving
    // the preview beside it would show the same answer twice.
    const handoff = resolveTeamStreamHandoff({
      streamedTurn: streamed(DISPATCH, "Electron ships faster"),
      dispatches: [dispatch({ ended: true, hasDurableMessage: true })],
    });

    expect(handoff).toEqual([]);
  });

  it("replaces a chain step's placeholder once its durable message arrives", () => {
    // The whole defect, at the layer the user sees it: a chain step that
    // answered used to end as "its answer went to a file". Read through the
    // run's own events, so a break anywhere between the event and the bubble
    // shows up here.
    const events = [
      {
        id: "start",
        ts: 1,
        type: "agent.start" as const,
        agentName: "Line One",
        dispatchId: DISPATCH,
        textChannelId: "channel",
      },
      {
        id: "end",
        ts: 2,
        type: "agent.end" as const,
        agentName: "Line One",
        dispatchId: DISPATCH,
      },
      {
        id: "artifact",
        ts: 3,
        type: "artifact.written" as const,
        artifactPath: "chain-step-1-line-one.md",
      },
      {
        id: "message",
        ts: 4,
        type: "team.message" as const,
        agentName: "Line One",
        content: "Phased rollout recommended.",
        dispatchId: DISPATCH,
        messageId: "run#invocation#1#line-one",
      },
    ];

    const handoff = resolveTeamStreamHandoff({
      streamedTurn: streamed(DISPATCH, "Phased rollout recommended."),
      dispatches: buildTeamStreamDispatches([{ taskId: "task-1", events }])
        .dispatches,
    });

    expect(handoff).toEqual([]);
  });

  it("becomes the step's outcome when the run records no message for it", () => {
    const handoff = resolveTeamStreamHandoff({
      streamedTurn: streamed(DISPATCH, "The first tradeoff is portability."),
      dispatches: [
        dispatch({ ended: true, artifactPath: "line-result.md" }),
      ],
    });

    expect(handoff).toEqual([
      {
        kind: "handoff",
        dispatchId: DISPATCH,
        agentName: "Line One",
        label: "line-result.md",
      },
    ]);
  });

  it("still says the step completed when no artifact is named yet", () => {
    // The alternative is showing nothing, which is the disappearance this
    // whole mapping exists to prevent.
    const handoff = resolveTeamStreamHandoff({
      streamedTurn: streamed(DISPATCH, "The first tradeoff"),
      dispatches: [dispatch({ ended: true })],
    });

    expect(handoff).toEqual([
      {
        kind: "handoff",
        dispatchId: DISPATCH,
        agentName: "Line One",
        label: "completed",
      },
    ]);
  });

  it("carries a failed step's reason into its bubble", () => {
    const reason =
      "You've hit your provider usage limit. It resets on Sep 14, 2026 at 9:45 PM.";
    const handoff = resolveTeamStreamHandoff({
      streamedTurn: streamed(DISPATCH, "Drafting the brief"),
      dispatches: [
        dispatch({ ended: true, outcome: "failed", failureReason: reason }),
      ],
    });

    expect(handoff).toEqual([
      {
        kind: "handoff",
        dispatchId: DISPATCH,
        agentName: "Line One",
        label: "failed",
        detail: reason,
      },
    ]);
  });

  it("keeps each speaker's bubble separate", () => {
    const other = "invocation#1#line-two";
    let turn = streamed(DISPATCH, "from one");
    turn = applyStreamDelivery(turn, {
      type: "delta",
      channelId: "channel",
      cursor: 1,
      replyId: other,
      channel: "text",
      text: "from two",
    });

    const handoff = resolveTeamStreamHandoff({
      streamedTurn: turn,
      dispatches: [
        dispatch({ ended: true, hasDurableMessage: true }),
        dispatch({ dispatchId: other, agentName: "Line Two" }),
      ],
    });

    expect(handoff).toEqual([
      {
        kind: "streaming",
        dispatchId: other,
        agentName: "Line Two",
        reply: replyWithText("from two"),
      },
    ]);
  });

  it("ignores streamed text for a dispatch the run never announced", () => {
    const handoff = resolveTeamStreamHandoff({
      streamedTurn: streamed("unknown-dispatch", "orphan"),
      dispatches: [dispatch()],
    });

    expect(handoff).toEqual([]);
  });
});

describe("team stream handoff — honest outcomes", () => {
  it("does not tell the user a failed attempt completed", () => {
    const handoff = resolveTeamStreamHandoff({
      streamedTurn: streamed(DISPATCH, "The first tradeoff"),
      dispatches: [dispatch({ ended: true, outcome: "failed" })],
    });

    expect(handoff).toHaveLength(1);
    const only = handoff[0];
    expect(only?.kind).toBe("handoff");
    expect(only && "label" in only ? only.label : "").not.toMatch(/completed/i);
    expect(only && "label" in only ? only.label : "").toMatch(/fail/i);
  });

  it("names an artifact only when the step actually finished", () => {
    // An artifact written by an earlier step is not where a failed step's
    // answer went.
    const handoff = resolveTeamStreamHandoff({
      streamedTurn: streamed(DISPATCH, "partial"),
      dispatches: [
        dispatch({ ended: true, outcome: "failed", artifactPath: "line-result.md" }),
      ],
    });

    const only = handoff[0];
    expect(only && "label" in only ? only.label : "").not.toContain(
      "line-result.md",
    );
  });

  it("says cancelled when the run was cancelled", () => {
    const handoff = resolveTeamStreamHandoff({
      streamedTurn: streamed(DISPATCH, "partial"),
      dispatches: [dispatch({ ended: true, outcome: "cancelled" })],
    });

    const only = handoff[0];
    expect(only && "label" in only ? only.label : "").toMatch(/cancel/i);
  });
});
