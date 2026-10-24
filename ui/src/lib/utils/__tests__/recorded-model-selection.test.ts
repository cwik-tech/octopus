/**
 * What a past reply is labelled with.
 *
 * The execution's own record, never today's agent library. An agent edited
 * after a reply was written must not retroactively relabel that reply, and a
 * reply written before provenance existed must say so rather than borrow a
 * current setting.
 */
import { describe, expect, it } from "vitest";

import type { ModelSelectionRecord } from "@contracts/agent-model-selection";
import type { ChatMessage } from "@/lib/models/session-model";
import { recordedReplyModel } from "@/lib/utils/recorded-model-selection";

const ADMITTED: ModelSelectionRecord = {
  provider: "codex",
  model: "gpt-5.6-sol",
  source: "agent",
  reason: "explicit-agent-choice",
  caller: "agent",
};

function userMessage(
  turnId: string,
  admittedSelections?: Record<string, ModelSelectionRecord>,
): ChatMessage {
  return {
    id: `${turnId}:user`,
    role: "user",
    text: "Question.",
    turnId,
    createdAt: "2026-09-05T10:00:00.000Z",
    ...(admittedSelections
      ? {
          turnRequest: {
            fingerprint: turnId,
            expectedReplies: 1,
            admittedSelections,
          },
        }
      : {}),
  };
}

function reply(turnId: string, speakerName: string): ChatMessage {
  return {
    id: `${turnId}:${speakerName}`,
    role: "assistant",
    text: "Answer.",
    turnId,
    createdAt: "2026-09-05T10:00:01.000Z",
    speaker: { type: "agent", id: speakerName, name: speakerName },
  };
}

describe("recorded reply model", () => {
  it("labels a reply with the selection its own turn admitted", () => {
    const messages = [
      userMessage("turn-1", { Reviewer: ADMITTED }),
      reply("turn-1", "Reviewer"),
    ];

    expect(recordedReplyModel(messages, messages[1]!)).toEqual({
      provider: "codex",
      model: "gpt-5.6-sol",
    });
  });

  it("reports nothing when the turn recorded no selection", () => {
    // Older history. Borrowing today's agent library here would make the
    // transcript claim something the run never recorded.
    const messages = [userMessage("turn-1"), reply("turn-1", "Reviewer")];

    expect(recordedReplyModel(messages, messages[1]!)).toBeUndefined();
  });

  it("does not borrow another turn's record", () => {
    const messages = [
      userMessage("turn-1", { Reviewer: ADMITTED }),
      reply("turn-1", "Reviewer"),
      userMessage("turn-2"),
      reply("turn-2", "Reviewer"),
    ];

    expect(recordedReplyModel(messages, messages[3]!)).toBeUndefined();
  });

  it("matches a speaker by id as well as by name", () => {
    const messages = [
      userMessage("turn-1", { reviewer: ADMITTED }),
      {
        ...reply("turn-1", "Reviewer"),
        speaker: { type: "agent" as const, id: "reviewer", name: "Reviewer" },
      },
    ];

    expect(recordedReplyModel(messages, messages[1]!)?.model).toBe("gpt-5.6-sol");
  });
});
