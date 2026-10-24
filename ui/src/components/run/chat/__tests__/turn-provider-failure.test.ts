import { describe, expect, it } from "vitest";

import { turnReportedProviderFailure } from "@/components/run/chat/turn-provider-failure";
import type {
  ChatMessage,
  SessionMessageDispatchResponse,
} from "@/lib/models/session-model";

/**
 * A reply that came back because the provider refused is the moment the
 * sidebars stop being right.
 *
 * A turn that dies on an exhausted key does not throw — it returns a perfectly
 * ordinary response carrying a safe apology, and the badges beside it go on
 * saying the agent is available. This is the one bit the renderer needs from
 * that response: whether to go and ask again.
 */

function message(id: string): ChatMessage {
  return {
    id,
    role: "assistant",
    text: "You've hit your provider usage limit.",
    createdAt: "2026-09-12T02:05:31.717Z",
  };
}

function agentsResponse(
  replies: Array<{ fallback: boolean }>,
): SessionMessageDispatchResponse {
  return {
    user: { ...message("u1"), role: "user", text: "hi" },
    messages: [message("a1")],
    replayed: false,
    dispatch: { kind: "agents", agentNames: ["crypto-market-analyst"] },
    meta: {
      replies: replies.map((reply, index) => ({
        speakerId: `s${index}`,
        speakerName: "Crypto Market Analyst",
        model: "gpt-5.5",
        fallback: reply.fallback,
      })),
    },
  };
}

describe("turnReportedProviderFailure", () => {
  it("reports a turn whose reply was a provider apology rather than an answer", () => {
    expect(turnReportedProviderFailure(agentsResponse([{ fallback: true }]))).toBe(
      true,
    );
  });

  it("reports a multi-speaker turn where only one speaker lost its provider", () => {
    expect(
      turnReportedProviderFailure(
        agentsResponse([{ fallback: false }, { fallback: true }]),
      ),
    ).toBe(true);
  });

  it("stays quiet when every speaker answered", () => {
    expect(
      turnReportedProviderFailure(
        agentsResponse([{ fallback: false }, { fallback: false }]),
      ),
    ).toBe(false);
  });

  it("reports the front door losing its own provider", () => {
    expect(
      turnReportedProviderFailure({
        user: { ...message("u1"), role: "user", text: "hi" },
        messages: [message("a1")],
        replayed: false,
        dispatch: { kind: "coordinator" },
        plan: { id: "p1", status: "draft", tasks: [] } as never,
        meta: { model: "gpt-5.5", fallback: true },
      }),
    ).toBe(true);
  });

  it("stays quiet for a Team turn, which reports its own failures elsewhere", () => {
    // A Team dispatch starts durable work and carries no reply meta at all;
    // treating the absence as a failure would re-ping every provider on every
    // Team launch.
    expect(
      turnReportedProviderFailure({
        user: { ...message("u1"), role: "user", text: "hi" },
        messages: [],
        replayed: false,
        dispatch: { kind: "team", teamId: "writing-team" },
        plan: { id: "p1", status: "draft", tasks: [] } as never,
        task: { id: "t1" } as never,
      }),
    ).toBe(false);
  });
});
