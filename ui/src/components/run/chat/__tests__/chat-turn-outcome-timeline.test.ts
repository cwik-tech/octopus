/**
 * Where a turn's outcome belongs in the conversation.
 *
 * Directly under the question it failed to answer, because that is the only
 * place it means anything: a list of interruptions at the bottom of a long
 * conversation tells the user something went wrong without telling them which
 * of their questions is still unanswered.
 *
 * A pure projection, tested as one. The card's markup is the component's
 * business; this is about which turn it belongs to.
 */
import { expect, it } from "vitest";

import { buildConversationTimeline } from "@/lib/utils/chat-timeline";
import type { ChatMessage } from "@/lib/models/session-model";
import type { ConversationTurnOutcome } from "@contracts/sessions";

const INTERRUPTED: ConversationTurnOutcome = {
  turnId: "turn-1",
  state: "interrupted",
  code: "provider_interrupted",
  retryable: true,
};

function userMessage(turnId: string, createdAt: string): ChatMessage {
  return {
    id: `${turnId}:user`,
    role: "user",
    text: `Question for ${turnId}`,
    turnId,
    createdAt,
  };
}

it("places a turn's outcome directly under the question it never answered", () => {
  const messages = [
    userMessage("turn-1", "2026-08-31T10:00:00.000Z"),
    userMessage("turn-2", "2026-08-31T10:05:00.000Z"),
  ];

  expect(
    buildConversationTimeline(messages, [], [INTERRUPTED]).map((item) =>
      item.kind === "turn-outcome"
        ? `outcome:${item.outcome.turnId}`
        : item.kind === "message"
          ? `message:${item.message.turnId}`
          : item.kind,
    ),
  ).toEqual(["message:turn-1", "outcome:turn-1", "message:turn-2"]);
});

it("drops an outcome for a turn the user cannot see", () => {
  // A turn whose user message is outside the loaded transcript has nothing to
  // attach to, and a card floating on its own would be an error message about
  // a question that is not on screen.
  expect(
    buildConversationTimeline(
      [userMessage("turn-2", "2026-08-31T10:05:00.000Z")],
      [],
      [INTERRUPTED],
    ).map((item) => item.kind),
  ).toEqual(["message"]);
});

it("says nothing about a turn that has an answer after all", () => {
  const messages: ChatMessage[] = [
    userMessage("turn-1", "2026-08-31T10:00:00.000Z"),
    {
      id: "turn-1:assistant:0",
      role: "assistant",
      text: "Here it is.",
      turnId: "turn-1",
      createdAt: "2026-08-31T10:00:30.000Z",
    },
  ];

  expect(
    buildConversationTimeline(messages, [], [INTERRUPTED]).map(
      (item) => item.kind,
    ),
  ).toEqual(["message", "message"]);
});

it("keeps quiet while a turn is still pending", () => {
  expect(
    buildConversationTimeline(
      [userMessage("turn-1", "2026-08-31T10:00:00.000Z")],
      [],
      [{ turnId: "turn-1", state: "pending" }],
    ).map((item) => item.kind),
  ).toEqual(["message"]);
});
