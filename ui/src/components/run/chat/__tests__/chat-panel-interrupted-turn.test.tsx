/**
 * What Chat shows when a turn has no answer and never will.
 *
 * The transcript holds the question and nothing under it. Before this the
 * panel had no way to say why, so the conversation simply stopped — with no
 * distinction between an agent still thinking and one whose process died an
 * hour ago.
 *
 * Two things are asserted, and only two: that the outcome is shown against the
 * question it belongs to, and that Retry starts a genuinely new turn. Where
 * the card sits in the markup and what it is styled with are not contracts.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMessageTarget } from "@contracts/schemas/session-requests";

import ChatPanel from "@/components/run/chat/chat-panel";
import {
  listChatMessages as mockListChatMessages,
  postSessionMessage as mockPostSessionMessage,
} from "@/lib/clients/session-client";
import type { SessionSummary } from "@/lib/models/session-model";

vi.mock("@/lib/clients/session-client", () => ({
  listSessionResults: vi.fn().mockResolvedValue([]),
  postSessionMessage: vi.fn(),
  listChatMessages: vi.fn(),
  // Resolved, not bare: the panel chains `.catch` onto this call, and an
  // undefined return would throw before the turn was ever posted.
  openAgentTextStream: vi.fn().mockResolvedValue(undefined),
  updateSessionTitle: vi.fn(),
  listSessionFiles: vi.fn().mockResolvedValue([]),
  uploadSessionFile: vi.fn(),
  deleteSessionFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/clients/mcp-resources-client", () => ({
  mcpResourcesClient: {
    listServers: vi.fn(),
    listResources: vi.fn(),
    listImports: vi.fn(),
    importResource: vi.fn(),
  },
}));

vi.mock("@/lib/clients/chat-defaults-client", () => ({
  fetchChatDefaults: vi.fn().mockResolvedValue({
    workflow: { provider: "deepseek", model: "deepseek-v4-flash" },
    team: { provider: "deepseek", model: "deepseek-v4-flash" },
    agent: { provider: "deepseek", model: "deepseek-v4-flash" },
    run: { provider: "deepseek", model: "deepseek-v4-flash" },
  }),
}));

vi.mock("@/lib/clients/runtime-client", () => ({
  artifactUrl: (runId: string, artifactPath: string) =>
    `/api/runs/${runId}/assignments/${artifactPath}`,
  fetchArtifact: vi.fn(),
  fetchExcelWorkbookPreview: vi.fn(),
}));

vi.mock("@/contexts/provider-catalog-context", () => ({
  useProviderCatalog: () => ({
    groups: [
      {
        provider: "deepseek",
        name: "DeepSeek",
        icon: "deepseek",
        source: "cli",
        models: [
          {
            id: "deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            enabled: true,
            capabilities: ["chat"],
          },
        ],
      },
    ],
    defaultModel: { provider: "deepseek", model: "deepseek-v4-flash" },
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

// Unmocked, this panel's MCP list fails its own poll and renders its own
// "Retry" — an unrelated error that would make every Retry query in this file
// ambiguous.
vi.mock("@/lib/clients/mcp-interactions-client", () => ({
  mcpInteractionsClient: {
    list: vi.fn().mockResolvedValue({ interactions: [] }),
    respond: vi.fn(),
  },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const SESSION_FIXTURE: SessionSummary = {
  id: "sess-1",
  title: "Interrupted Session",
  status: "active",
  activityType: "chat",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const AGENTS_TARGET: SessionMessageTarget = {
  kind: "agents",
  agentNames: ["analyst"],
};

const INTERRUPTED_TURN_ID = "4a2277b8-e9cf-453e-b058-60b5a55a8b10";
const QUESTION = "Find me the TripAdvisor listing.";

function interruptedTranscript() {
  return {
    modelChoices: [],
    messages: [
      {
        id: `${INTERRUPTED_TURN_ID}:user`,
        role: "user" as const,
        text: QUESTION,
        createdAt: "2026-08-31T09:00:00.000Z",
        turnId: INTERRUPTED_TURN_ID,
      },
    ],
    outcomes: [
      {
        turnId: INTERRUPTED_TURN_ID,
        state: "interrupted" as const,
        code: "provider_interrupted" as const,
        retryable: true,
        // Who the interrupted turn was addressed to. Retry is offered only
        // when the record still says, so a fixture without this is testing
        // the fail-closed case rather than the ordinary one.
        agentNames: ["analyst"],
      },
    ],
  };
}

describe("ChatPanel — an interrupted turn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.ResizeObserver = class ResizeObserver {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    };
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("tells the user the response was interrupted and offers a retry", async () => {
    vi.mocked(mockListChatMessages).mockResolvedValue(interruptedTranscript());

    render(<ChatPanel session={SESSION_FIXTURE} target={AGENTS_TARGET} />);

    expect(await screen.findByText(QUESTION)).toBeInTheDocument();
    expect(await screen.findByText(/Response interrupted/i)).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: /Retry/i }),
    ).toBeInTheDocument();
  });

  it("says nothing about a turn the transcript already answered", async () => {
    vi.mocked(mockListChatMessages).mockResolvedValue({
      messages: interruptedTranscript().messages,
      outcomes: [],
      modelChoices: [],
    });

    render(<ChatPanel session={SESSION_FIXTURE} target={AGENTS_TARGET} />);

    expect(await screen.findByText(QUESTION)).toBeInTheDocument();
    expect(screen.queryByText(/Response interrupted/i)).not.toBeInTheDocument();
  });

  it("shows the durable outcome when the turn fails while the user is watching", async () => {
    // The optimistic user message is removed on failure, so without re-reading
    // the session the question the user just asked disappears from the screen
    // even though it is durably stored. They are left with an error banner and
    // no record of what they asked.
    vi.mocked(mockListChatMessages)
      .mockResolvedValueOnce({ messages: [], outcomes: [], modelChoices: [] })
      .mockResolvedValue(interruptedTranscript());
    vi.mocked(mockPostSessionMessage).mockRejectedValue(
      new Error("The agent did not respond before this turn's deadline."),
    );

    render(<ChatPanel session={SESSION_FIXTURE} target={AGENTS_TARGET} />);

    const composer = await screen.findByPlaceholderText(
      /Send a message to the selected agents/i,
    );
    await userEvent.type(composer, QUESTION);
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText(QUESTION)).toBeInTheDocument();
    expect(await screen.findByText(/Response interrupted/i)).toBeInTheDocument();
  });

  it("retries the original question as a new turn, exactly once", async () => {
    vi.mocked(mockListChatMessages).mockResolvedValue(interruptedTranscript());
    vi.mocked(mockPostSessionMessage).mockResolvedValue({
      user: {
        id: "retry:user",
        role: "user",
        text: QUESTION,
        createdAt: "2026-08-31T09:05:00.000Z",
      },
      dispatch: { kind: "agents", agentNames: ["analyst"] },
      meta: { replies: [] },
      replayed: false,
      messages: [],
    });

    render(<ChatPanel session={SESSION_FIXTURE} target={AGENTS_TARGET} />);

    await userEvent.click(
      await screen.findByRole("button", { name: /Retry/i }),
    );

    await waitFor(() =>
      expect(vi.mocked(mockPostSessionMessage)).toHaveBeenCalledTimes(1),
    );
    const call = vi.mocked(mockPostSessionMessage).mock.calls[0];
    expect(call?.[1]).toBe(QUESTION);
    // A new identity, always. Reusing the interrupted turn's id would ask the
    // server to replay a turn whose outcome nobody knows — which is the
    // duplicate provider call the whole recovery rule exists to prevent.
    expect(call?.[2]?.turnId).toEqual(expect.any(String));
    expect(call?.[2]?.turnId).not.toBe(INTERRUPTED_TURN_ID);
  });

  it("retries the interrupted turn to the agent it was originally addressed to", async () => {
    // Routing must come from the record, not from the screen. By the time a
    // user sees this card the selection is whatever they left it as — often
    // nothing, sometimes a different agent — and recomputing the target from
    // that sends the retry to somebody the original turn never asked.
    vi.mocked(mockListChatMessages).mockResolvedValue({
      messages: interruptedTranscript().messages,
      modelChoices: [],
      outcomes: [
        {
          turnId: INTERRUPTED_TURN_ID,
          state: "interrupted",
          code: "provider_interrupted",
          retryable: true,
          agentNames: ["scout"],
        },
      ],
    });
    vi.mocked(mockPostSessionMessage).mockResolvedValue({
      user: {
        id: "retry:user",
        role: "user",
        text: QUESTION,
        createdAt: "2026-08-31T09:05:00.000Z",
      },
      dispatch: { kind: "agents", agentNames: ["scout"] },
      meta: { replies: [] },
      replayed: false,
      messages: [],
    });

    // The screen now points somewhere else entirely.
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: "agents", agentNames: ["someone-else"] }}
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: /Retry/i }),
    );

    await waitFor(() =>
      expect(vi.mocked(mockPostSessionMessage)).toHaveBeenCalledTimes(1),
    );
    expect(
      vi.mocked(mockPostSessionMessage).mock.calls[0]?.[2]?.target,
    ).toEqual({ kind: "agents", agentNames: ["scout"] });
  });

  it("names the recorded agent while retrying, not the selected Team", async () => {
    // A Team can be selected when the user reaches an old interruption. The
    // retry is routed to the recorded agent, so the pending bubble has to say
    // so — a bubble announcing the Team is starting describes work that is not
    // happening.
    vi.mocked(mockListChatMessages).mockResolvedValue({
      messages: interruptedTranscript().messages,
      modelChoices: [],
      outcomes: [
        {
          turnId: INTERRUPTED_TURN_ID,
          state: "interrupted",
          code: "provider_interrupted",
          retryable: true,
          agentNames: ["scout"],
        },
      ],
    });
    let releasePost: () => void = () => {};
    vi.mocked(mockPostSessionMessage).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releasePost = resolve;
      });
      return {
        user: {
          id: "retry:user",
          role: "user",
          text: QUESTION,
          createdAt: "2026-08-31T09:05:00.000Z",
        },
        dispatch: { kind: "agents", agentNames: ["scout"] },
        meta: { replies: [] },
        replayed: false,
        messages: [],
      };
    });

    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: "team", teamId: "research-team" }}
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: /Retry/i }),
    );

    expect(await screen.findByText(/scout/i)).toBeInTheDocument();
    expect(screen.queryByText(/Starting the Team/i)).not.toBeInTheDocument();

    expect(
      vi.mocked(mockPostSessionMessage).mock.calls[0]?.[2]?.target,
    ).toEqual({ kind: "agents", agentNames: ["scout"] });
    releasePost();
  });

  it("leaves a draft alone when a retry does not go through", async () => {
    // Retry is the card's affordance, not the composer's. Restoring the
    // submitted text into the composer is right for a failed composer submit
    // and wrong here: it would overwrite whatever the user is in the middle of
    // typing with a question they asked an hour ago.
    vi.mocked(mockListChatMessages).mockResolvedValue({
      messages: interruptedTranscript().messages,
      modelChoices: [],
      outcomes: [
        {
          turnId: INTERRUPTED_TURN_ID,
          state: "interrupted",
          code: "provider_interrupted",
          retryable: true,
          agentNames: ["analyst"],
        },
      ],
    });
    vi.mocked(mockPostSessionMessage).mockRejectedValue(
      new Error("The retry could not be sent."),
    );

    render(<ChatPanel session={SESSION_FIXTURE} target={AGENTS_TARGET} />);

    const composer = await screen.findByPlaceholderText(
      /Send a message to the selected agents/i,
    );
    await userEvent.type(composer, "a different question I am still writing");

    await userEvent.click(
      await screen.findByRole("button", { name: /Retry/i }),
    );

    await waitFor(() =>
      expect(vi.mocked(mockPostSessionMessage)).toHaveBeenCalled(),
    );
    await waitFor(() =>
      expect(composer).toHaveValue("a different question I am still writing"),
    );
  });

  it("says an outcome it cannot read is unavailable, and offers no retry", async () => {
    // `evidence_unreadable` is the fail-closed outcome: the record could not be
    // read, so nothing is known about how the turn ended. Saying "this turn
    // ended before the agent could answer" states a fact the evidence does not
    // support.
    vi.mocked(mockListChatMessages).mockResolvedValue({
      messages: interruptedTranscript().messages,
      modelChoices: [],
      outcomes: [
        {
          turnId: INTERRUPTED_TURN_ID,
          state: "failed",
          code: "evidence_unreadable",
          retryable: false,
        },
      ],
    });

    render(<ChatPanel session={SESSION_FIXTURE} target={AGENTS_TARGET} />);

    expect(await screen.findByText(/Status unavailable/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/ended before the agent could answer/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Retry/i }),
    ).not.toBeInTheDocument();
  });

  it("retries even while a selection is still being written", async () => {
    // `selectionPending` guards the composer, whose turn is routed from the
    // selection currently being saved. A card Retry carries its own target, so
    // that guard has nothing to protect here — and silently doing nothing when
    // the button is enabled is the worst of both options.
    vi.mocked(mockListChatMessages).mockResolvedValue(interruptedTranscript());
    vi.mocked(mockPostSessionMessage).mockResolvedValue({
      user: {
        id: "retry:user",
        role: "user",
        text: QUESTION,
        createdAt: "2026-08-31T09:05:00.000Z",
      },
      dispatch: { kind: "agents", agentNames: ["analyst"] },
      meta: { replies: [] },
      replayed: false,
      messages: [],
    });

    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={AGENTS_TARGET}
        selectionPending
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: /Retry/i }),
    );

    await waitFor(() =>
      expect(vi.mocked(mockPostSessionMessage)).toHaveBeenCalledTimes(1),
    );
    expect(
      vi.mocked(mockPostSessionMessage).mock.calls[0]?.[2]?.target,
    ).toEqual({ kind: "agents", agentNames: ["analyst"] });
  });

  it("offers no retry when the record no longer names who was asked", async () => {
    // Falling back to the current selection would send the retry to whoever is
    // selected now — which is the bug the durable roster exists to prevent,
    // reintroduced through the one case where the roster is missing. Better to
    // show what happened and let the user re-ask deliberately.
    vi.mocked(mockListChatMessages).mockResolvedValue({
      messages: interruptedTranscript().messages,
      modelChoices: [],
      outcomes: [
        {
          turnId: INTERRUPTED_TURN_ID,
          state: "interrupted",
          code: "provider_interrupted",
          retryable: true,
        },
      ],
    });

    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: "agents", agentNames: ["someone-else"] }}
      />,
    );

    expect(await screen.findByText(/Response interrupted/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Retry/i }),
    ).not.toBeInTheDocument();
  });
});
