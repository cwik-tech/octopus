import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceArchitectFeedbackDiagnostics } from "@contracts/schemas/resource-architect-review";

import AgentsAndTeamsPanel from "@/components/create/agents-and-teams/agents-and-teams-panel";
import { ProviderCatalogProvider } from "@/contexts/provider-catalog-context";
import { openAgentTextStreamAt } from "@/lib/clients/agent-text-stream-client";
import { fetchChatDefaults } from "@/lib/clients/chat-defaults-client";
import {
  listResourceArchitectMetrics,
  postResourceArchitectTurn,
} from "@/lib/clients/resource-architect-client";

/**
 * The Create composer's model picker writes a value into itself.
 *
 * `ModelSelect` with `fallbackToFirstAvailable` calls the very same `onChange`
 * a person's click calls, from an effect, as soon as it sees an empty pair. A
 * panel that treats every `onChange` as a choice therefore records "the user
 * picked this model" for a picker nobody has touched, and the authoring turn's
 * disclosure then says explicit-user-choice about the application default.
 *
 * These tests go through the real chat and the real picker, because the defect
 * lives in that wiring and is invisible to a test that passes the panel's state
 * in directly.
 */

const catalog = [
  {
    provider: "connection:openai",
    name: "OpenAI",
    icon: "openai",
    source: "connection" as const,
    models: [
      { id: "chat-only", name: "Chat only", enabled: true, capabilities: ["chat" as const] },
      { id: "other-model", name: "Other model", enabled: true, capabilities: ["chat" as const] },
    ],
  },
];

vi.mock("@/lib/clients/resource-architect-client", () => ({
  listResourceArchitectMetrics: vi.fn(() => Promise.resolve([])),
  listResourceBuildJobs: vi.fn(() => Promise.resolve([])),
  postResourceArchitectTurn: vi.fn(),
  readResourceBuildJob: vi.fn(),
  retryResourceBuildJob: vi.fn(),
  startResourceBuildJob: vi.fn(),
}));

vi.mock("@/lib/clients/agent-generator-client", () => ({
  cancelAgentJob: vi.fn(),
}));

vi.mock("@/lib/clients/agent-text-stream-client", () => ({
  openAgentTextStreamAt: vi.fn(() => new Promise(() => {})),
}));

vi.mock("@/lib/clients/chat-defaults-client", () => ({
  fetchChatDefaults: vi.fn(),
}));

vi.mock("@/components/create/agent-architect-panel", () => ({
  default: () => <div>Agent inspector</div>,
}));

vi.mock("@/components/create/team-architect-panel", () => ({
  default: () => <div>Team inspector</div>,
}));

vi.mock("@/lib/clients/team-file-client", () => ({
  TEAM_CONTEXT_FILE_ACCEPT: ".txt",
  teamFileUploadApi: {
    list: vi.fn(async () => []),
    upload: vi.fn(),
    delete: vi.fn(async () => undefined),
  },
}));

const CHAT_DEFAULT_PAIR = { provider: "connection:openai", model: "chat-only" };
const CHAT_DEFAULTS = {
  workflow: CHAT_DEFAULT_PAIR,
  team: CHAT_DEFAULT_PAIR,
  agent: CHAT_DEFAULT_PAIR,
  run: CHAT_DEFAULT_PAIR,
};

const TURN_RESPONSE = {
  jobId: "turn-1",
  operation: "conversation" as const,
  message: "Tell me more.",
  warnings: [],
  meta: {
    provider: "connection:openai",
    model: "chat-only",
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
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchChatDefaults).mockResolvedValue(CHAT_DEFAULTS);
  vi.mocked(postResourceArchitectTurn).mockResolvedValue(TURN_RESPONSE);
  // `clearAllMocks` forgets calls but keeps implementations, so a metric set by
  // one test would otherwise restore a note in every test after it.
  vi.mocked(listResourceArchitectMetrics).mockResolvedValue([]);
  // The stream mock is reinstalled, not merely cleared: a test that makes it
  // emit a selection would otherwise emit one for every test after it, and an
  // explicit-choice case would then fail looking like a product defect.
  vi.mocked(openAgentTextStreamAt).mockImplementation(
    () => new Promise<void>(() => {}),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          catalog,
          defaultModel: { provider: "connection:openai", model: "chat-only" },
          defaultModelState: {
            status: "available",
            provider: "connection:openai",
            model: "chat-only",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderPanel() {
  render(
    <ProviderCatalogProvider>
      <AgentsAndTeamsPanel />
    </ProviderCatalogProvider>,
  );
  // The picker settles on the prefilled pair on its own; until it does, the
  // composer is disabled and nothing can be submitted.
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Agent Architect model" }),
    ).toHaveTextContent("Chat only"),
  );
}

async function submit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole("textbox"), "Create three lawyers");
  await user.click(screen.getByRole("button", { name: "Submit" }));
  await waitFor(() => expect(postResourceArchitectTurn).toHaveBeenCalled());
  return vi.mocked(postResourceArchitectTurn).mock.calls[0]![0];
}

describe("Create authoring model provenance", () => {
  it("restores the Not reviewed disclosure when Create is reopened", async () => {
    vi.mocked(listResourceArchitectMetrics).mockResolvedValue([{
      schemaVersion: 1, recordedAt: "2026-09-19T12:00:00.000Z", jobId: "review-failed-turn",
      operation: "conversation", status: "completed", provider: "connection:openai",
      model: "chat-only", reasoning: "low", outcomeKind: null, fallback: false,
      timing: TURN_RESPONSE.meta.timing,
      review: {
        reviewStatus: "not_reviewed", reviewerId: "reviewer-of-agent-architect",
        defaultFallbackAttempted: false, failureReason: "review_output_invalid", phases: [],
      },
    }]);

    await renderPanel();

    expect(await screen.findByRole("note", { name: "Agent Architect review" }))
      .toHaveTextContent("Not reviewed. Reviewer of Agent Architect could not complete review.");
    expect(screen.queryByRole("note", { name: "Model selection" })).not.toBeInTheDocument();
  });

  it("keeps the disclosed draft visible once and starts no proposal", async () => {
    vi.mocked(postResourceArchitectTurn).mockResolvedValue({
      ...TURN_RESPONSE, message: "The draft recommends one Agent.",
      warnings: ["Not reviewed. Reviewer of Agent Architect could not complete review."],
      meta: { ...TURN_RESPONSE.meta, review: {
        reviewStatus: "not_reviewed", reviewerId: "reviewer-of-agent-architect",
        defaultFallbackAttempted: false, failureReason: "review_output_invalid", phases: [],
      } satisfies ResourceArchitectFeedbackDiagnostics },
    });
    await renderPanel();

    await submit(userEvent.setup());

    await screen.findByText("The draft recommends one Agent.");
    expect(screen.getAllByText("Not reviewed. Reviewer of Agent Architect could not complete review."))
      .toHaveLength(1);
    expect(postResourceArchitectTurn).toHaveBeenCalledTimes(1);
  });

  it("waits for the displayed default before consuming and submitting a handoff", async () => {
    let resolveDefaults: (defaults: typeof CHAT_DEFAULTS) => void = () => {
      throw new Error("Default response is not pending");
    };
    vi.mocked(fetchChatDefaults).mockReturnValue(new Promise((resolve) => { resolveDefaults = resolve; }));
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const onHandoffConsumed = vi.fn();
    render(<ProviderCatalogProvider><AgentsAndTeamsPanel
      handoffPrompt={{ id: "handoff-1", text: "Create three lawyers" }}
      onHandoffConsumed={onHandoffConsumed}
    /></ProviderCatalogProvider>);

    expect(onHandoffConsumed).not.toHaveBeenCalled();
    expect(postResourceArchitectTurn).not.toHaveBeenCalled();

    resolveDefaults(CHAT_DEFAULTS);
    await waitFor(() => expect(postResourceArchitectTurn).toHaveBeenCalledTimes(1));
    expect(onHandoffConsumed).toHaveBeenCalledExactlyOnceWith("handoff-1");
    expect(postResourceArchitectTurn).toHaveBeenCalledWith(expect.objectContaining({
      composerSelection: { ...CHAT_DEFAULT_PAIR, origin: "default" },
    }));
  });

  it("keeps Send unavailable until the displayed provider/model resolves", async () => {
    // A loading catalog and Settings response are external boundaries.
    vi.mocked(fetchChatDefaults).mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<ProviderCatalogProvider><AgentsAndTeamsPanel /></ProviderCatalogProvider>);

    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(postResourceArchitectTurn).not.toHaveBeenCalled();
  });

  it("shows the answer without a speculative Mermaid workflow or default-model card", async () => {
    vi.mocked(postResourceArchitectTurn).mockResolvedValue({
      ...TURN_RESPONSE,
      message: "Here is the proposed team.\n\n```mermaid\ngraph LR\nA-->B\n```\n\nReview the team card.",
      meta: { ...TURN_RESPONSE.meta, selection: {
        provider: "connection:openai", model: "chat-only", source: "app-default",
        reason: "agent-default", caller: "authoring",
      } as const },
    });
    await renderPanel();
    await submit(userEvent.setup());
    await screen.findByText("Review the team card.");
    expect(screen.queryByText("mermaid")).not.toBeInTheDocument();
    expect(screen.queryByRole("note", { name: "Model selection" })).not.toBeInTheDocument();
    expect(screen.getByText("Here is the proposed team.")).toBeInTheDocument();
  });
  it("keeps restored default-model records out of the transcript", async () => {
    // The record is still read for provenance, but no longer renders a card.
    vi.mocked(listResourceArchitectMetrics).mockResolvedValue([
      {
        schemaVersion: 1,
        recordedAt: "2026-09-05T10:00:00.000Z",
        jobId: "earlier-turn",
        operation: "conversation",
        status: "completed",
        provider: "connection:openai",
        model: "chat-only",
        reasoning: "low",
        outcomeKind: null,
        fallback: false,
        selection: {
          provider: "connection:openai",
          model: "chat-only",
          source: "app-default",
          reason: "agent-default",
          caller: "authoring",
        },
        timing: TURN_RESPONSE.meta.timing,
      },
    ]);
    await renderPanel();

    await waitFor(() => expect(listResourceArchitectMetrics).toHaveBeenCalled());
    expect(screen.queryByRole("note", { name: "Model selection" })).not.toBeInTheDocument();
  });

  it("restores nothing for a recorded turn that ran on a chosen pair", async () => {
    // Restoration follows the same rule as live disclosure: only default use is
    // disclosed. A recorded explicit choice restored as a note would tell a
    // person, after the fact, that a setting they made was overridden.
    vi.mocked(listResourceArchitectMetrics).mockResolvedValue([
      {
        schemaVersion: 1,
        recordedAt: "2026-09-05T10:00:00.000Z",
        jobId: "chosen-turn",
        operation: "conversation",
        status: "completed",
        provider: "connection:openai",
        model: "chat-only",
        reasoning: "low",
        outcomeKind: null,
        fallback: false,
        selection: {
          provider: "connection:openai",
          model: "chat-only",
          source: "agent",
          reason: "explicit-agent-choice",
          caller: "authoring",
        },
        timing: TURN_RESPONSE.meta.timing,
      },
    ]);
    await renderPanel();

    await waitFor(() => expect(listResourceArchitectMetrics).toHaveBeenCalled());
    expect(screen.queryByRole("note", { name: "Model selection" })).toBeNull();
  });

  it("releases the composer even when the history read never answers", async () => {
    // The reconciliation read is a recovery, not part of the turn. Waiting on
    // it would let a stalled history request hold an already-failed composer
    // shut, which is the one thing the person needs released.
    vi.mocked(listResourceArchitectMetrics).mockResolvedValueOnce([]);
    vi.mocked(postResourceArchitectTurn).mockRejectedValue(
      new Error("plan.tasks contains an invalid reference."),
    );
    const user = userEvent.setup();
    await renderPanel();
    vi.mocked(listResourceArchitectMetrics).mockReturnValue(new Promise(() => {}));

    await user.type(screen.getByRole("textbox"), "Create three lawyers");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() =>
      expect(screen.getByRole("textbox")).not.toBeDisabled(),
    );
  });

  it("resumes a dropped stream where it left off instead of replaying it", async () => {
    // Listening again must not mean hearing the same thing twice. The client
    // resumes from a cursor for exactly this reason, and a fresh subscription
    // that starts at zero replays every frame the turn already showed — so a
    // reply that had streamed "A" renders "AA" the moment its connection drops.
    vi.mocked(listResourceArchitectMetrics).mockResolvedValue([]);
    const cursors: number[] = [];
    let subscriptions = 0;
    vi.mocked(openAgentTextStreamAt).mockImplementation((input) => {
      subscriptions += 1;
      cursors.push(input.fromCursor ?? 0);
      // The channel's frames, replayed from whatever cursor the reader asks
      // for. A reader that asks for 0 again hears "Considering" a second time.
      const frames = [
        {
          type: "delta" as const,
          channelId: input.channelId,
          cursor: 0,
          replyId: "assistant:0",
          channel: "text" as const,
          text: "Considering",
        },
      ];
      for (const frame of frames.slice(input.fromCursor ?? 0)) {
        input.onDelivery(frame);
      }
      // The first connection ends having said only that; the second stays open.
      if (subscriptions === 1) return Promise.resolve();
      return new Promise<void>(() => {});
    });
    vi.mocked(postResourceArchitectTurn).mockImplementation(
      async () => new Promise(() => {}) as never,
    );
    const user = userEvent.setup();
    await renderPanel();

    await user.type(screen.getByRole("textbox"), "Create three lawyers");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(subscriptions).toBeGreaterThan(1));
    // Resumed past what it already heard, never from the beginning.
    expect(cursors[0]).toBe(0);
    expect(cursors[1]).toBe(1);
    // What a person actually sees. A replayed frame renders the same suffix
    // twice, and no cursor assertion says that out loud.
    await waitFor(() =>
      expect(screen.getByText("Considering")).toBeInTheDocument(),
    );
    expect(screen.queryByText("ConsideringConsidering")).toBeNull();
  });

  it("stops looking once the turn has said what it runs on", async () => {
    // An explicit choice is disclosed by saying nothing: no default notice is
    // owed. The recovery exists to find a disclosure, so once the turn has
    // made one it has nothing left to look for, whether or not a note appears.
    vi.mocked(listResourceArchitectMetrics).mockResolvedValue([]);
    let subscriptions = 0;
    vi.mocked(openAgentTextStreamAt).mockImplementation((input) => {
      subscriptions += 1;
      input.onDelivery({
        type: "selection",
        channelId: input.channelId,
        cursor: 0,
        replyId: "assistant:0",
        speaker: "Agent Architect",
        selection: {
          provider: "connection:openai",
          model: "chat-only",
          source: "agent",
          reason: "explicit-agent-choice",
          caller: "authoring",
        },
      });
      return Promise.resolve();
    });
    vi.mocked(postResourceArchitectTurn).mockImplementation(
      async () => new Promise(() => {}) as never,
    );
    const user = userEvent.setup();
    await renderPanel();

    await user.type(screen.getByRole("textbox"), "Create three lawyers");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(postResourceArchitectTurn).toHaveBeenCalled());
    expect(subscriptions).toBe(1);
    expect(screen.queryByRole("note", { name: "Model selection" })).toBeNull();
  });

  it("keeps one reader when the retained window moves past it", async () => {
    // A reset says frames were lost, not that the reader is gone. Starting a
    // second reader beside a live one makes every later delta arrive twice.
    vi.mocked(listResourceArchitectMetrics).mockResolvedValue([]);
    let subscriptions = 0;
    vi.mocked(openAgentTextStreamAt).mockImplementation((input) => {
      subscriptions += 1;
      if (subscriptions === 1) {
        input.onDelivery({
          type: "reset",
          channelId: input.channelId,
          requestedFromCursor: 0,
          retainedFromCursor: 7,
          reason: "evicted",
        });
        // Text after the reset, on the reader that is still connected. A
        // second reader beside it would deliver this again.
        input.onDelivery({
          type: "delta",
          channelId: input.channelId,
          cursor: 8,
          replyId: "assistant:0",
          channel: "text",
          text: "Reviewing",
        });
      }
      // Still connected either way: this reader has not ended.
      return new Promise<void>(() => {});
    });
    vi.mocked(postResourceArchitectTurn).mockImplementation(
      async () => new Promise(() => {}) as never,
    );
    const user = userEvent.setup();
    await renderPanel();

    await user.type(screen.getByRole("textbox"), "Create three lawyers");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(listResourceArchitectMetrics).toHaveBeenCalled());
    expect(subscriptions).toBe(1);
    await waitFor(() => expect(screen.getByText("Reviewing")).toBeInTheDocument());
    expect(screen.queryByText("ReviewingReviewing")).toBeNull();
  });


  it("says nothing when the Architect ran on a pair that was chosen", async () => {
    // A choice is not a default, even when the two pairs are identical. A note
    // here would tell a person their setting is being overridden.
    vi.mocked(postResourceArchitectTurn).mockResolvedValue({
      ...TURN_RESPONSE,
      meta: {
        ...TURN_RESPONSE.meta,
        selection: {
          provider: "connection:openai",
          model: "chat-only",
          source: "agent",
          reason: "explicit-agent-choice",
          caller: "authoring",
        } as const,
      },
    });
    const user = userEvent.setup();
    await renderPanel();

    await submit(user);

    await screen.findByText("Tell me more.");
    expect(screen.queryByRole("note", { name: "Model selection" })).toBeNull();
  });

  it("sends the displayed pair with default provenance when the picker filled itself in", async () => {
    const user = userEvent.setup();
    await renderPanel();

    const posted = await submit(user);

    expect(posted).toMatchObject({
      provider: "connection:openai", model: "chat-only",
      composerSelection: { provider: "connection:openai", model: "chat-only", origin: "default" },
    });
  });

  it("captures the displayed catalog default when the separate prefill failed", async () => {
    // The prefill is a separate request from the catalog and can lose the race
    // or fail outright, and the panel deliberately ignores that failure. The
    // picker then writes the catalog default into an empty pair through the
    // very same callback a click uses. Nobody chose anything here.
    vi.mocked(fetchChatDefaults).mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    await renderPanel();

    const posted = await submit(user);

    expect(posted).toMatchObject({
      provider: "connection:openai", model: "chat-only",
      composerSelection: { provider: "connection:openai", model: "chat-only", origin: "default" },
    });
  });

  it("keeps a person's pick when the prefill answers late", async () => {
    // The prefill is a separate request with no ordering guarantee. If it lands
    // after someone has already picked, writing it into the picker replaces
    // their choice while the panel still remembers that a choice was made, so
    // the turn goes out claiming they explicitly chose the default.
    let releaseDefaults!: (
      value: Awaited<ReturnType<typeof fetchChatDefaults>>,
    ) => void;
    vi.mocked(fetchChatDefaults).mockReturnValue(
      new Promise<Awaited<ReturnType<typeof fetchChatDefaults>>>((resolve) => {
        releaseDefaults = resolve;
      }),
    );
    const user = userEvent.setup();
    render(
      <ProviderCatalogProvider>
        <AgentsAndTeamsPanel />
      </ProviderCatalogProvider>,
    );
    const picker = await screen.findByRole("button", {
      name: "Agent Architect model",
    });
    await waitFor(() => expect(picker).toHaveTextContent("Chat only"));

    await user.click(picker);
    await user.click(await screen.findByRole("option", { name: /Other model/ }));
    await waitFor(() => expect(picker).toHaveTextContent("Other model"));

    releaseDefaults(CHAT_DEFAULTS);
    await waitFor(() => expect(picker).toHaveTextContent("Other model"));

    const posted = await submit(user);

    expect(posted).toMatchObject({
      provider: "connection:openai",
      model: "other-model",
      composerSelection: { provider: "connection:openai", model: "other-model", origin: "user-choice" },
    });
  });

  it("sends the pair a person picked, even when it equals the default", async () => {
    // Deliberately choosing the model that was already showing is a choice.
    // Comparing pairs instead of tracking the interaction would erase it.
    const user = userEvent.setup();
    await renderPanel();

    await user.click(
      screen.getByRole("button", { name: "Agent Architect model" }),
    );
    await user.click(await screen.findByRole("option", { name: /Chat only/ }));

    const posted = await submit(user);

    expect(posted).toMatchObject({
      provider: "connection:openai",
      model: "chat-only",
      composerSelection: { provider: "connection:openai", model: "chat-only", origin: "user-choice" },
    });
  });
});
