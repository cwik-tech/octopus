import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useResourceArchitectChat } from "@/components/create/agents-and-teams/use-resource-architect-chat";
import { openAgentTextStreamAt } from "@/lib/clients/agent-text-stream-client";
import { postResourceArchitectTurn } from "@/lib/clients/resource-architect-client";

vi.mock("@/lib/clients/resource-architect-client", () => ({
  listResourceArchitectMetrics: vi.fn(() => Promise.resolve([])),
  listResourceBuildJobs: vi.fn(() => Promise.resolve([])),
  postResourceArchitectTurn: vi.fn(),
  readResourceBuildJob: vi.fn(),
  readTeamShape: vi.fn(),
  amendTeamShape: vi.fn(),
  retryResourceBuildJob: vi.fn(),
  startResourceBuildJob: vi.fn(),
}));

vi.mock("@/lib/clients/agent-generator-client", () => ({
  cancelAgentJob: vi.fn(),
}));

vi.mock("@/lib/clients/agent-text-stream-client", () => ({
  openAgentTextStreamAt: vi.fn(),
}));

/** What the conversation endpoint returns after a reload with an Agent open. */
const savedConversation = {
  schemaVersion: 1,
  draftId: "draft-with-open-agent",
  history: [
    { role: "user", text: "Tell me about the open Agent.", createdAt: "2026-09-20T10:00:00.000Z" },
    { role: "assistant", text: "It sequences intake work.", createdAt: "2026-09-20T10:00:05.000Z" },
  ],
  planId: null,
  buildJobId: null,
  selectedResource: { kind: "agent", id: "run-order-analyst" },
  documentReader: null,
  updatedAt: "2026-09-20T10:00:05.000Z",
  turn: { jobId: "earlier-turn", operation: "conversation", status: "completed" },
};

describe("a reloaded Create conversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The hook's only HTTP read here is the saved conversation; every client
    // call it makes is mocked above.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(savedConversation), {
      headers: { "content-type": "application/json" },
    })));
    vi.mocked(openAgentTextStreamAt).mockImplementation(() => new Promise(() => {}));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the restored Agent identity with the next turn, so the server reads that package again", async () => {
    vi.mocked(postResourceArchitectTurn).mockResolvedValue({
      jobId: "next-turn", operation: "conversation", message: "Its run order has three steps.",
      warnings: [], meta: testMeta(),
    });
    // The restored history is the production result that signals the reload
    // finished. The render that shows it hands over its own hook state, so the
    // next turn is sent from exactly the restored conversation, not on a timer.
    type Chat = ReturnType<typeof useResourceArchitectChat>;
    let restored: (chat: Chat) => void = () => undefined;
    const historyRestored = new Promise<Chat>((resolve) => { restored = resolve; });
    renderHook(() => {
      const chat = useResourceArchitectChat({ model: { provider: "openai", model: "test-model" }, modelOrigin: "default" });
      if (chat.history.length === savedConversation.history.length) restored(chat);
      return chat;
    });
    const chat = await historyRestored;

    await act(async () => chat.submit("What is its exact run order?"));

    expect(postResourceArchitectTurn).toHaveBeenCalledWith(expect.objectContaining({
      draftId: "draft-with-open-agent",
      selectedResource: { kind: "agent", id: "run-order-analyst" },
    }));
  });
});

function testMeta() {
  return {
    provider: "openai",
    model: "test-model",
    fallback: false,
    reasoning: "low" as const,
    timing: {
      contextAssemblyMs: 1,
      providerDurationMs: 1,
      processSpawnMs: null,
      firstProviderEventMs: null,
      firstTextMs: 1,
      parseDurationMs: 0,
      repairOccurred: false,
      repairDurationMs: 0,
      totalDurationMs: 2,
      context: {
        instructionsChars: 1,
        operationChars: 1,
        uploadedDocumentPolicyChars: 1,
        visualizationPolicyChars: 1,
        teamLibraryChars: 1,
        agentLibraryChars: 1,
        totalChars: 6,
        historyChars: 1,
      },
    },
  };
}
