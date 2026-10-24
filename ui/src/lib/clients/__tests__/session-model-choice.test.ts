/**
 * How a model-choice offer reaches the renderer, and what an approval sends.
 *
 * The offer is data the server computed from a durable failure. The approval
 * says which offer and once — never which model — because a payload that could
 * name a model would be an arbitrary override API wearing a consent label.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  approveModelChoice,
  listChatMessages,
} from "@/lib/clients/session-client";

const OFFER = {
  offerId: "offer-1",
  scope: { kind: "chat", sessionId: "session-1", turnId: "turn-1" },
  agentName: "reviewer",
  expectedRevision: "revision-1",
  failedChoice: { provider: "anthropic", model: "claude-sonnet-4-6" },
  proposedDefault: { provider: "connection:abc", model: "gpt-5.4-mini" },
  reason: "missing-credential",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session model choice", () => {
  it("reads the offers a reopened transcript carries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ messages: [], outcomes: [], modelChoices: [OFFER] }),
          { status: 200, headers: { "content-type": "application/json" } },
        )),
    );

    await expect(listChatMessages("session-1")).resolves.toMatchObject({
      modelChoices: [OFFER],
    });
  });

  it("treats a server that offers none as offering none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ messages: [], outcomes: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })),
    );

    await expect(listChatMessages("session-1")).resolves.toMatchObject({
      modelChoices: [],
    });
  });

  it("sends only the offer identity and an idempotency key", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ turnId: "retry-turn" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await approveModelChoice("session-1", "turn-1", {
      offerId: "offer-1",
      idempotencyKey: "approval-1",
    });

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const init = call[1];
    expect(JSON.parse(String(init.body))).toEqual({
      offerId: "offer-1",
      idempotencyKey: "approval-1",
    });
  });
});
