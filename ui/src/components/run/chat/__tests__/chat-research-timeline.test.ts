import { expect, it } from "vitest";

import {
  buildConversationTimeline,
  type ConversationTimelineItem,
} from "@/lib/utils/chat-timeline";
import type { ResearchActivity } from "@/lib/clients/research-activity-client";
import type { ChatMessage } from "@/lib/models/session-model";

it("places research steps between the initiating user message and final answer", () => {
  const messages: ChatMessage[] = [
    { id: "user", role: "user", text: "Research this", createdAt: "2026-07-16T10:00:00.000Z" },
    { id: "assistant", role: "assistant", text: "Grounded answer", createdAt: "2026-07-16T10:00:03.000Z" },
  ];

  expect(
    buildConversationTimeline(messages, [
      makeActivity({ activityId: "step", createdAt: "2026-07-16T10:00:01.000Z" }),
    ]).map((item) => item.kind),
  ).toEqual(["message", "research-group", "message"]);
});

it("attaches all research activity to the matching agent answer", () => {
  const messages: ChatMessage[] = [
    {
      id: "user",
      role: "user",
      text: "Research this",
      turnId: "turn-1",
      createdAt: "2026-07-16T10:00:00.000Z",
    },
    {
      id: "assistant",
      role: "assistant",
      text: "Grounded answer",
      turnId: "turn-1",
      speaker: { type: "agent", id: "web-researcher", name: "web-researcher" },
      createdAt: "2026-07-16T10:00:03.000Z",
    },
  ];
  const activities = ["step-1", "step-2"].map((activityId, index) =>
    makeActivity({
      activityId,
      createdAt: `2026-07-16T10:00:0${index + 1}.000Z`,
    }));

  const timeline = buildConversationTimeline(messages, activities);
  expect(timeline.map((item) => item.kind)).toEqual(["message", "message"]);
  const answer = timeline[1];
  expect(answer?.kind).toBe("message");
  if (answer?.kind !== "message") return;
  expect(answer.researchActivities.map((activity) => activity.activityId))
    .toEqual(["step-1", "step-2"]);
});

it("gathers both research tools of one turn into a single group", () => {
  // The user asked one question. Whether the answer came through the search
  // tool, the managed browser, or both is an implementation detail they should
  // never see as two separate disclosures.
  const timeline = buildConversationTimeline([], [
    makeActivity({
      activityId: "searched",
      source: "research-web",
      kind: "search",
      action: "search",
      createdAt: "2026-07-16T10:00:01.000Z",
    }),
    makeActivity({
      activityId: "browsed",
      source: "browser",
      action: "open",
      createdAt: "2026-07-16T10:00:02.000Z",
    }),
  ]);

  expect(timeline).toHaveLength(1);
  const group = timeline[0];
  expect(group?.kind).toBe("research-group");
  expect(activityIdsOf(group)).toEqual(["searched", "browsed"]);
});

it("keeps the step order the endpoint delivered", () => {
  // The endpoint is the single ordering authority: it merges two journals that
  // are each already correct, and `research_web` in particular stores parallel
  // calls in the provider's call order rather than in creation order. Sorting
  // again here is not just redundant, it is unsound — an ordinal comparison for
  // two research steps and a time comparison for anything involving a browser
  // step do not agree, so with a browser step timed between two out-of-order
  // provider calls the three comparisons form a cycle and the sort may return
  // any of several orders.
  const timeline = buildConversationTimeline([], [
    makeActivity({
      activityId: "provider-call-0",
      providerCallOrdinal: 0,
      createdAt: "2026-07-16T10:00:03.000Z",
    }),
    makeActivity({
      activityId: "browser-step",
      source: "browser",
      action: "open",
      createdAt: "2026-07-16T10:00:02.000Z",
    }),
    makeActivity({
      activityId: "provider-call-1",
      providerCallOrdinal: 1,
      createdAt: "2026-07-16T10:00:01.000Z",
    }),
  ]);

  expect(activityIdsOf(timeline[0])).toEqual([
    "provider-call-0",
    "browser-step",
    "provider-call-1",
  ]);
});

/** The steps an entry carries, for the entry kinds that carry any. */
function activityIdsOf(item: ConversationTimelineItem | undefined): string[] {
  if (
    !item ||
    item.kind === "turn-outcome" ||
    item.kind === "model-selection" ||
    item.kind === "session-model-selection" ||
    item.kind === "model-choice"
  ) {
    return [];
  }
  return item.researchActivities.map((activity) => activity.activityId);
}

function makeActivity(
  overrides: Partial<ResearchActivity> & { readonly activityId: string },
): ResearchActivity {
  return {
    source: "research-web",
    sessionId: "session",
    runId: "turn-1",
    assignmentId: "assignment",
    agentPath: "agents/web-researcher",
    toolCallId: `call-${overrides.activityId}`,
    action: "acquire",
    kind: "page",
    state: "completed",
    createdAt: "2026-07-16T10:00:01.000Z",
    updatedAt: "2026-07-16T10:00:02.000Z",
    ...overrides,
  };
}
