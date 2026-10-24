/**
 * Reading a run's own events for what the display stream needs.
 *
 * Two things come from the run rather than from the stream: which channel to
 * read, and which attempts exist inside it. Everything the preview does hangs
 * off getting these right — a dispatch the run never announced has no speaker,
 * and a dispatch whose durable message has arrived must stop previewing.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { buildTeamStreamDispatches } from "@/lib/chat/team-stream-dispatches";
import type { RunEvent } from "@/components/run/stage-renderers/index";

const CHANNEL = "11111111-2222-4333-8444-555555555555";
const DISPATCH = "invocation#1#line-one";

/**
 * Fixed ids and timestamps: nothing here depends on wall-clock time or on
 * randomness, and a fixture that did would make a failure impossible to
 * reproduce from the report alone.
 */
let nextEventNumber = 0;
beforeEach(() => {
  nextEventNumber = 0;
});

function event(overrides: Partial<RunEvent> & { type: RunEvent["type"] }): RunEvent {
  nextEventNumber += 1;
  return {
    id: `event-${nextEventNumber}`,
    ts: Date.UTC(2026, 7, 23, 12, 0, nextEventNumber),
    ...overrides,
  };
}

/** One task group, which is what a single run looks like. */
function single(...events: RunEvent[]) {
  return [{ taskId: "task-1", events }];
}

describe("team stream dispatches", () => {
  it("learns the channel from the run that announced it", () => {
    const result = buildTeamStreamDispatches(
      single(
        event({
          type: "agent.start",
          dispatchId: DISPATCH,
          textChannelId: CHANNEL,
          agentName: "Line One",
        }),
      ),
    );

    expect(result.channelId).toBe(CHANNEL);
  });

  it("has no channel before the run names one", () => {
    const result = buildTeamStreamDispatches(
      single(event({ type: "agent.start", agentName: "Line One" })),
    );

    expect(result.channelId).toBeUndefined();
    expect(result.dispatches).toEqual([]);
  });

  it("marks a dispatch ended when its attempt closes", () => {
    const result = buildTeamStreamDispatches(
      single(
        event({
          type: "agent.start",
          dispatchId: DISPATCH,
          textChannelId: CHANNEL,
          agentName: "Line One",
        }),
        event({ type: "agent.end", dispatchId: DISPATCH, agentName: "Line One" }),
      ),
    );

    expect(result.dispatches).toEqual([
      expect.objectContaining({
        dispatchId: DISPATCH,
        agentName: "Line One",
        ended: true,
        hasDurableMessage: false,
      }),
    ]);
  });

  it("keeps the reason an attempt failed", () => {
    const reason =
      "You've hit your provider usage limit. It resets on Sep 14, 2026 at 9:45 PM.";
    const result = buildTeamStreamDispatches(
      single(
        event({
          type: "agent.start",
          dispatchId: DISPATCH,
          textChannelId: CHANNEL,
          agentName: "Brief Builder",
        }),
        event({
          type: "agent.fail",
          dispatchId: DISPATCH,
          agentName: "Brief Builder",
          errorMessage: reason,
        }),
      ),
    );

    expect(result.dispatches[0]).toEqual(
      expect.objectContaining({ outcome: "failed", failureReason: reason }),
    );
  });

  it("does not repeat a bare failed status as the reason", () => {
    // The coordinator's failure carries only the word itself, which the
    // bubble already says.
    const result = buildTeamStreamDispatches(
      single(
        event({
          type: "agent.start",
          dispatchId: DISPATCH,
          textChannelId: CHANNEL,
          agentName: "Team Lead",
        }),
        event({
          type: "agent.fail",
          dispatchId: DISPATCH,
          agentName: "Team Lead",
          errorMessage: "failed",
        }),
      ),
    );

    expect(result.dispatches[0]).not.toHaveProperty("failureReason");
  });

  it("notes the durable message the run recorded for a dispatch", () => {
    const result = buildTeamStreamDispatches(
      single(
        event({
          type: "agent.start",
          dispatchId: DISPATCH,
          textChannelId: CHANNEL,
          agentName: "Spec Beta",
        }),
        event({ type: "agent.end", dispatchId: DISPATCH, agentName: "Spec Beta" }),
        event({
          type: "discussion.message",
          dispatchId: DISPATCH,
          agentName: "Spec Beta",
          content: "Electron ships faster.",
        }),
      ),
    );

    expect(result.dispatches[0]).toEqual(
      expect.objectContaining({ hasDurableMessage: true }),
    );
  });

  it("notes a durable Team message that arrives after the attempt ended", () => {
    const result = buildTeamStreamDispatches(
      single(
        event({
          type: "agent.start",
          dispatchId: DISPATCH,
          textChannelId: CHANNEL,
          agentName: "Line One",
        }),
        event({ type: "agent.end", dispatchId: DISPATCH, agentName: "Line One" }),
        event({
          type: "team.message",
          dispatchId: DISPATCH,
          agentName: "Line One",
          content: "Phased rollout recommended.",
          messageId: "run#invocation#1#line-one",
        }),
      ),
    );

    expect(result.dispatches[0]).toEqual(
      expect.objectContaining({ ended: true, hasDurableMessage: true }),
    );
  });

  it("carries the artifact a step wrote, so a chain can name where its answer went", () => {
    const result = buildTeamStreamDispatches(
      single(
        event({
          type: "agent.start",
          dispatchId: DISPATCH,
          textChannelId: CHANNEL,
          agentName: "Line One",
        }),
        event({ type: "agent.end", dispatchId: DISPATCH, agentName: "Line One" }),
        event({ type: "artifact.written", artifactPath: "line-result.md" }),
      ),
    );

    expect(result.dispatches[0]).toEqual(
      expect.objectContaining({ artifactPath: "line-result.md" }),
    );
  });

  it("a failed attempt is ended too, so its bubble does not hang open", () => {
    const result = buildTeamStreamDispatches(
      single(
        event({
          type: "agent.start",
          dispatchId: DISPATCH,
          textChannelId: CHANNEL,
          agentName: "Line One",
        }),
        event({ type: "agent.fail", dispatchId: DISPATCH, agentName: "Line One" }),
      ),
    );

    expect(result.dispatches[0]).toEqual(
      expect.objectContaining({ ended: true }),
    );
  });

  it("a run that ended closes every attempt still open on it", () => {
    // The guaranteed backstop: whatever else happened, nothing keeps waiting
    // once the run itself is over.
    const result = buildTeamStreamDispatches(
      single(
        event({
          type: "agent.start",
          dispatchId: DISPATCH,
          textChannelId: CHANNEL,
          agentName: "Line One",
        }),
        event({ type: "run.completed" }),
      ),
    );

    expect(result.dispatches[0]).toEqual(
      expect.objectContaining({ ended: true }),
    );
  });
});

describe("team stream dispatches — one run at a time", () => {
  function group(taskId: string, events: RunEvent[]) {
    return { taskId, events };
  }

  it("reads the newest run's channel, not an older one's", () => {
    // A session accumulates every task it has ever run. Reading them as one
    // list makes the previous run's channel and the previous run's ending
    // apply to the run the user is watching now.
    const result = buildTeamStreamDispatches([
      group("task-1", [
        event({
          type: "agent.start",
          dispatchId: "older#1#line-one",
          textChannelId: "channel-older",
          agentName: "Line One",
        }),
        event({ type: "agent.end", dispatchId: "older#1#line-one" }),
        event({ type: "run.completed" }),
      ]),
      group("task-2", [
        event({
          type: "agent.start",
          dispatchId: "newer#1#line-one",
          textChannelId: "channel-newer",
          agentName: "Line One",
        }),
      ]),
    ]);

    expect(result.channelId).toBe("channel-newer");
    expect(result.dispatches).toEqual([
      expect.objectContaining({ dispatchId: "newer#1#line-one", ended: false }),
    ]);
  });

  it("does not end a running attempt because an earlier run finished", () => {
    const result = buildTeamStreamDispatches([
      group("task-1", [
        event({
          type: "agent.start",
          dispatchId: "older#1#line-one",
          textChannelId: "channel-older",
        }),
        event({ type: "run.completed" }),
      ]),
      group("task-2", [
        event({
          type: "agent.start",
          dispatchId: "newer#1#line-one",
          textChannelId: "channel-newer",
        }),
      ]),
    ]);

    expect(result.dispatches[0]?.ended).toBe(false);
  });

  it("gives each step the artifact that step actually wrote", () => {
    // A chain writes one artifact per step. Labelling every handoff with the
    // last one tells the user their first step's answer went somewhere it did
    // not.
    const result = buildTeamStreamDispatches([
      group("task-1", [
        event({
          type: "agent.start",
          dispatchId: "run#1#line-one",
          textChannelId: "channel",
          agentName: "Line One",
        }),
        event({ type: "agent.end", dispatchId: "run#1#line-one" }),
        event({ type: "artifact.written", artifactPath: "step-one.md" }),
        event({
          type: "agent.start",
          dispatchId: "run#1#line-two",
          agentName: "Line Two",
        }),
        event({ type: "agent.end", dispatchId: "run#1#line-two" }),
        event({ type: "artifact.written", artifactPath: "step-two.md" }),
      ]),
    ]);

    expect(
      result.dispatches.map((dispatch) => [
        dispatch.dispatchId,
        dispatch.artifactPath,
      ]),
    ).toEqual([
      ["run#1#line-one", "step-one.md"],
      ["run#1#line-two", "step-two.md"],
    ]);
  });

  it("a retry replaces the attempt it supersedes rather than sitting beside it", () => {
    // Both attempts belong to one logical call. Showing the failed partial
    // next to the answer that replaced it reads as two speakers disagreeing.
    const result = buildTeamStreamDispatches([
      group("task-1", [
        event({
          type: "agent.start",
          dispatchId: "call#1#line-one",
          logicalInvocationId: "call",
          textChannelId: "channel",
          agentName: "Line One",
        }),
        event({ type: "agent.fail", dispatchId: "call#1#line-one" }),
        event({
          type: "agent.start",
          dispatchId: "call#2#line-one",
          logicalInvocationId: "call",
          agentName: "Line One",
        }),
      ]),
    ]);

    expect(result.dispatches).toEqual([
      expect.objectContaining({ dispatchId: "call#2#line-one" }),
    ]);
  });

  it("a fallback to a different agent supersedes the attempt before it too", () => {
    // "Same agent, next attempt" is not the rule: a fallback runs a different
    // agent under the same logical call.
    const result = buildTeamStreamDispatches([
      group("task-1", [
        event({
          type: "agent.start",
          dispatchId: "call#1#line-one",
          logicalInvocationId: "call",
          textChannelId: "channel",
          agentName: "Line One",
        }),
        event({ type: "agent.fail", dispatchId: "call#1#line-one" }),
        event({
          type: "agent.start",
          dispatchId: "call#2#line-two",
          logicalInvocationId: "call",
          agentName: "Line Two",
        }),
      ]),
    ]);

    expect(result.dispatches).toEqual([
      expect.objectContaining({
        dispatchId: "call#2#line-two",
        agentName: "Line Two",
      }),
    ]);
  });

  it("keeps separate logical calls side by side", () => {
    const result = buildTeamStreamDispatches([
      group("task-1", [
        event({
          type: "agent.start",
          dispatchId: "first#1#line-one",
          logicalInvocationId: "first",
          textChannelId: "channel",
          agentName: "Line One",
        }),
        event({
          type: "agent.start",
          dispatchId: "second#1#line-two",
          logicalInvocationId: "second",
          agentName: "Line Two",
        }),
      ]),
    ]);

    expect(result.dispatches.map((dispatch) => dispatch.dispatchId)).toEqual([
      "first#1#line-one",
      "second#1#line-two",
    ]);
  });
});

describe("team stream dispatches — what actually happened", () => {
  it("records a failed attempt as failed, not as finished", () => {
    const result = buildTeamStreamDispatches(
      single(
        event({
          type: "agent.start",
          dispatchId: DISPATCH,
          textChannelId: CHANNEL,
          agentName: "Line One",
        }),
        event({ type: "agent.fail", dispatchId: DISPATCH }),
      ),
    );

    expect(result.dispatches[0]).toEqual(
      expect.objectContaining({ ended: true, outcome: "failed" }),
    );
  });

  it("records a skipped attempt as skipped", () => {
    const result = buildTeamStreamDispatches(
      single(
        event({
          type: "agent.start",
          dispatchId: DISPATCH,
          textChannelId: CHANNEL,
        }),
        event({ type: "agent.skip", dispatchId: DISPATCH }),
      ),
    );

    expect(result.dispatches[0]?.outcome).toBe("skipped");
  });

  it("a run that failed does not make its open attempts look finished", () => {
    // The backstop closes bubbles that never got their own ending. What it
    // must not do is invent a successful one.
    const result = buildTeamStreamDispatches(
      single(
        event({
          type: "agent.start",
          dispatchId: DISPATCH,
          textChannelId: CHANNEL,
        }),
        event({ type: "run.failed" }),
      ),
    );

    expect(result.dispatches[0]).toEqual(
      expect.objectContaining({ ended: true, outcome: "failed" }),
    );
  });

  it("a cancelled run says cancelled, and an incomplete one says incomplete", () => {
    const cancelled = buildTeamStreamDispatches(
      single(
        event({
          type: "agent.start",
          dispatchId: DISPATCH,
          textChannelId: CHANNEL,
        }),
        event({ type: "run.cancelled" }),
      ),
    );
    const incomplete = buildTeamStreamDispatches(
      single(
        event({
          type: "agent.start",
          dispatchId: DISPATCH,
          textChannelId: CHANNEL,
        }),
        event({ type: "run.incomplete" }),
      ),
    );

    expect(cancelled.dispatches[0]?.outcome).toBe("cancelled");
    expect(incomplete.dispatches[0]?.outcome).toBe("incomplete");
  });

  it("an attempt that ended on its own keeps its own outcome when the run later fails", () => {
    const result = buildTeamStreamDispatches(
      single(
        event({
          type: "agent.start",
          dispatchId: DISPATCH,
          textChannelId: CHANNEL,
        }),
        event({ type: "agent.end", dispatchId: DISPATCH }),
        event({ type: "run.failed" }),
      ),
    );

    expect(result.dispatches[0]?.outcome).toBe("completed");
  });
});
