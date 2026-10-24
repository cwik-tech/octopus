/**
 * ChatPanel streaming: a bubble that grows while the turn is still running.
 *
 * The panel mints the turn id, opens the stream before the POST, renders one
 * bubble per `replyId`, and hands over to the persisted message when the `201`
 * arrives. Loss is explicit: a `gap` or `reset` stops appending rather than
 * showing text with a hole in it.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMessageTarget } from "@contracts/schemas/session-requests";

import ChatPanel from "@/components/run/chat/chat-panel";
import {
  openAgentTextStream as mockOpenAgentTextStream,
  postSessionMessage as mockPostSessionMessage,
} from "@/lib/clients/session-client";
import type { AgentTextStreamDelivery } from "@contracts/agent-text-stream";
import type { SessionSummary } from "@/lib/models/session-model";

vi.mock("@/lib/clients/session-client", () => ({
  listSessionResults: vi.fn().mockResolvedValue([]),
  postSessionMessage: vi.fn(),
  listChatMessages: vi.fn().mockResolvedValue({ messages: [], outcomes: [] }),
  openAgentTextStream: vi.fn(),
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

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const SESSION_FIXTURE: SessionSummary = {
  id: "sess-1",
  title: "Test Session",
  status: "active",
  activityType: "chat",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function assistantMessage(id: string, text: string, speakerId: string) {
  return {
    id,
    role: "assistant" as const,
    text,
    createdAt: "2026-05-01T12:00:01.000Z",
    speaker: { type: "agent" as const, id: speakerId, name: speakerId },
  };
}

function frame(
  cursor: number,
  replyId: string,
  text: string,
): AgentTextStreamDelivery {
  return {
    type: "delta",
    channelId: "channel-1",
    cursor,
    replyId,
    channel: "text",
    text,
  };
}

/** Capture the panel's stream subscription so the test can drive it. */
function captureStream(order?: string[]) {
  const captured: {
    channelId?: string;
    deliver?: (delivery: AgentTextStreamDelivery) => void;
    aborted: boolean;
  } = { aborted: false };

  vi.mocked(mockOpenAgentTextStream).mockImplementation(async (params) => {
    order?.push("stream");
    captured.channelId = params.channelId;
    captured.deliver = params.onDelivery;
    params.signal.addEventListener("abort", () => {
      captured.aborted = true;
    });
    await new Promise<void>((resolve) => {
      params.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });

  return captured;
}

const AGENTS_TARGET: SessionMessageTarget = {
  kind: "agents",
  agentNames: ["analyst"],
};

async function sendAgentMessage(text: string): Promise<void> {
  const input = await screen.findByPlaceholderText(
    /Send a message to the selected agents/i,
  );
  await userEvent.type(input, text);
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
}

describe("ChatPanel — streaming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.ResizeObserver = class ResizeObserver {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    };
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("mints a turn id, opens the stream, and only then posts the turn", async () => {
    const order: string[] = [];
    const stream = captureStream(order);
    vi.mocked(mockPostSessionMessage).mockImplementation(async () => {
      order.push("post");
      return { user: { id: "u1", role: "user", text: "hi", createdAt: "" }, dispatch: { kind: 'agents', agentNames: ['analyst'] }, meta: { replies: [] }, replayed: false, messages: [] };
    });

    render(<ChatPanel session={SESSION_FIXTURE} target={AGENTS_TARGET} />);
    await sendAgentMessage("hi");

    await waitFor(() => expect(order).toContain("post"));
    // Both boundaries are recorded, so the ordering is asserted rather than
    // inferred from one of them existing.
    expect(order).toEqual(["stream", "post"]);
    expect(stream.channelId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const posted = vi.mocked(mockPostSessionMessage).mock.calls[0];
    expect(posted?.[2]).toMatchObject({ turnId: stream.channelId });
  });

  it("grows a bubble as deltas arrive, then hands over to the persisted reply", async () => {
    const stream = captureStream();
    let releasePost: () => void = () => {};
    vi.mocked(mockPostSessionMessage).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releasePost = resolve;
      });
      return {
        user: { id: "u1", role: "user", text: "hi", createdAt: "" },
        dispatch: { kind: 'agents', agentNames: ['analyst'] }, meta: { replies: [] }, replayed: false, messages: [assistantMessage("a1", "Hello world", "assistant")],
      };
    });

    render(<ChatPanel session={SESSION_FIXTURE} target={AGENTS_TARGET} />);
    await sendAgentMessage("hi");
    await waitFor(() => expect(stream.deliver).toBeDefined());

    stream.deliver?.(frame(0, "assistant:0", "Hello "));
    expect(await screen.findByText(/Hello/)).toBeInTheDocument();

    stream.deliver?.(frame(1, "assistant:0", "wor"));
    await waitFor(() =>
      expect(screen.getByText(/Hello wor/)).toBeInTheDocument(),
    );

    releasePost();
    await waitFor(() =>
      expect(screen.getByText("Hello world")).toBeInTheDocument(),
    );
  });

  it("renders one bubble per reply for a multi-speaker turn", async () => {
    const stream = captureStream();
    let releasePost: () => void = () => {};
    vi.mocked(mockPostSessionMessage).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releasePost = resolve;
      });
      return {
        user: { id: "u1", role: "user", text: "hi", createdAt: "" },
        dispatch: { kind: 'agents', agentNames: ['analyst'] }, meta: { replies: [] }, replayed: false, messages: [
          assistantMessage("a1", "Alpha done", "alpha"),
          assistantMessage("a2", "Beta done", "beta"),
        ],
      };
    });

    render(<ChatPanel session={SESSION_FIXTURE} target={AGENTS_TARGET} />);
    await sendAgentMessage("hi");
    await waitFor(() => expect(stream.deliver).toBeDefined());

    stream.deliver?.(frame(0, "alpha:0", "Alpha speaking"));
    stream.deliver?.(frame(1, "beta:1", "Beta speaking"));

    expect(await screen.findByText(/Alpha speaking/)).toBeInTheDocument();
    expect(screen.getByText(/Beta speaking/)).toBeInTheDocument();

    releasePost();
    await waitFor(() => {
      expect(screen.getByText("Alpha done")).toBeInTheDocument();
      expect(screen.getByText("Beta done")).toBeInTheDocument();
    });
  });

  it("falls back to the durable reply after a gap instead of showing a hole", async () => {
    const stream = captureStream();
    let releasePost: () => void = () => {};
    vi.mocked(mockPostSessionMessage).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releasePost = resolve;
      });
      return {
        user: { id: "u1", role: "user", text: "hi", createdAt: "" },
        dispatch: { kind: 'agents', agentNames: ['analyst'] }, meta: { replies: [] }, replayed: false, messages: [assistantMessage("a1", "Hello brave world", "assistant")],
      };
    });

    render(<ChatPanel session={SESSION_FIXTURE} target={AGENTS_TARGET} />);
    await sendAgentMessage("hi");
    await waitFor(() => expect(stream.deliver).toBeDefined());

    stream.deliver?.(frame(0, "assistant:0", "Hello "));
    expect(await screen.findByText(/Hello/)).toBeInTheDocument();

    stream.deliver?.({
      type: "gap",
      channelId: "channel-1",
      cursor: 1,
      replyId: "assistant:0",
      missingProducerFrom: 1,
      missingProducerTo: 3,
    });
    stream.deliver?.(frame(4, "assistant:0", "world"));

    // Nothing is spliced across the hole, and the user is told why.
    expect(
      await screen.findByText(/Live preview unavailable/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Hello world/)).not.toBeInTheDocument();

    // The durable reply is what actually answers the question.
    releasePost();
    expect(await screen.findByText("Hello brave world")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByText(/Live preview unavailable/i),
      ).not.toBeInTheDocument(),
    );
  });

  it("labels a truncated reply as cut short while the partial text stays visible", async () => {
    const stream = captureStream();
    vi.mocked(mockPostSessionMessage).mockImplementation(
      async () => new Promise(() => {}),
    );

    render(<ChatPanel session={SESSION_FIXTURE} target={AGENTS_TARGET} />);
    await sendAgentMessage("hi");
    await waitFor(() => expect(stream.deliver).toBeDefined());

    stream.deliver?.(frame(0, "assistant:0", "The answer beg"));
    expect(await screen.findByText(/The answer beg/)).toBeInTheDocument();

    stream.deliver?.({
      type: "final",
      channelId: "channel-1",
      cursor: 1,
      replyId: "assistant:0",
      reason: "truncated",
    });

    // The text the user already read stays on screen, and the bubble says the
    // provider stopped at its limit and discarded it.
    expect(await screen.findByText(/cut off at its length limit/i)).toBeInTheDocument();
    expect(screen.getByText(/The answer beg/)).toBeInTheDocument();
  });

  it("a completed reply carries no cut-short label", async () => {
    const stream = captureStream();
    vi.mocked(mockPostSessionMessage).mockImplementation(
      async () => new Promise(() => {}),
    );

    render(<ChatPanel session={SESSION_FIXTURE} target={AGENTS_TARGET} />);
    await sendAgentMessage("hi");
    await waitFor(() => expect(stream.deliver).toBeDefined());

    stream.deliver?.(frame(0, "assistant:0", "The whole answer"));
    stream.deliver?.({
      type: "final",
      channelId: "channel-1",
      cursor: 1,
      replyId: "assistant:0",
      reason: "completed",
    });

    expect(await screen.findByText(/The whole answer/)).toBeInTheDocument();
    expect(screen.queryByText(/cut off at its length limit/i)).not.toBeInTheDocument();
  });

  it("a gap before a reply's first delta shows the loss notice, not the suffix", async () => {
    const stream = captureStream();
    vi.mocked(mockPostSessionMessage).mockImplementation(
      async () => new Promise(() => {}),
    );

    render(<ChatPanel session={SESSION_FIXTURE} target={AGENTS_TARGET} />);
    await sendAgentMessage("hi");
    await waitFor(() => expect(stream.deliver).toBeDefined());

    // The producer's opening frames were lost, so the hub reports the hole
    // before the first frame it managed to deliver.
    stream.deliver?.({
      type: "gap",
      channelId: "channel-1",
      cursor: 0,
      replyId: "assistant:0",
      missingProducerFrom: 0,
      missingProducerTo: 2,
    });
    stream.deliver?.(frame(1, "assistant:0", "swer to your question."));

    expect(
      await screen.findByText(/Live preview unavailable/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/swer to your question/),
    ).not.toBeInTheDocument();
  });

  it("after a reset, discards stale text and marks the retained window partial", async () => {
    const stream = captureStream();
    vi.mocked(mockPostSessionMessage).mockImplementation(
      async () => new Promise(() => {}),
    );

    render(<ChatPanel session={SESSION_FIXTURE} target={AGENTS_TARGET} />);
    await sendAgentMessage("hi");
    await waitFor(() => expect(stream.deliver).toBeDefined());

    stream.deliver?.(frame(0, "assistant:0", "stale text"));
    expect(await screen.findByText(/stale text/)).toBeInTheDocument();

    stream.deliver?.({
      type: "reset",
      channelId: "channel-1",
      requestedFromCursor: 0,
      retainedFromCursor: 100,
      reason: "evicted",
    });
    await waitFor(() =>
      expect(screen.queryByText(/stale text/)).not.toBeInTheDocument(),
    );

    // D7: the retained window still renders, labelled so a mid-answer suffix
    // is never mistaken for the whole reply.
    stream.deliver?.(frame(100, "assistant:0", "resumed tail"));
    expect(await screen.findByText(/resumed tail/)).toBeInTheDocument();
    expect(screen.getByText(/Earlier output not shown/i)).toBeInTheDocument();
  });

  it("a frame arriving after unmount paints nothing", async () => {
    const stream = captureStream();
    vi.mocked(mockPostSessionMessage).mockImplementation(
      async () => new Promise(() => {}),
    );

    const view = render(<ChatPanel session={SESSION_FIXTURE} target={AGENTS_TARGET} />);
    await sendAgentMessage("hi");
    await waitFor(() => expect(stream.deliver).toBeDefined());
    stream.deliver?.(frame(0, "assistant:0", "before unmount"));
    expect(await screen.findByText(/before unmount/)).toBeInTheDocument();

    view.unmount();
    await waitFor(() => expect(stream.aborted).toBe(true));

    // A late frame must be inert: nothing to paint into, and no warning.
    expect(() =>
      stream.deliver?.(frame(1, "assistant:0", " and after")),
    ).not.toThrow();
    expect(screen.queryByText(/and after/)).not.toBeInTheDocument();
  });

  it("a frame arriving after a session switch does not paint, and switching back does not resurrect it", async () => {
    const stream = captureStream();
    vi.mocked(mockPostSessionMessage).mockImplementation(
      async () => new Promise(() => {}),
    );

    const view = render(<ChatPanel session={SESSION_FIXTURE} target={AGENTS_TARGET} />);
    await sendAgentMessage("hi");
    await waitFor(() => expect(stream.deliver).toBeDefined());
    stream.deliver?.(frame(0, "assistant:0", "session one text"));
    expect(await screen.findByText(/session one text/)).toBeInTheDocument();

    view.rerender(
      <ChatPanel session={{ ...SESSION_FIXTURE, id: "sess-2" }} target={AGENTS_TARGET} />,
    );
    // Immediately, on the very first render of the new session — not after
    // effects have run. A preview belonging to another conversation must never
    // be painted, not even for one frame.
    expect(screen.queryByText(/session one text/)).not.toBeInTheDocument();

    await waitFor(() => expect(stream.aborted).toBe(true));
    await waitFor(() =>
      expect(screen.queryByText(/session one text/)).not.toBeInTheDocument(),
    );

    stream.deliver?.(frame(1, "assistant:0", " leaked"));
    await waitFor(() =>
      expect(screen.queryByText(/leaked/)).not.toBeInTheDocument(),
    );

    // Returning to the original session must not bring the abandoned preview
    // back: the durable log is what restores a conversation. The POST for that
    // turn is still pending, so nothing has cleared the preview on its own.
    view.rerender(<ChatPanel session={SESSION_FIXTURE} target={AGENTS_TARGET} />);
    await waitFor(() =>
      expect(screen.queryByText(/session one text/)).not.toBeInTheDocument(),
    );
    // Give any pending re-render a chance to resurrect it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(/session one text/)).not.toBeInTheDocument();
  });

  it("a frame from an abandoned subscription writes nothing after returning to its session", async () => {
    const stream = captureStream();
    vi.mocked(mockPostSessionMessage).mockImplementation(
      async () => new Promise(() => {}),
    );

    const view = render(<ChatPanel session={SESSION_FIXTURE} target={AGENTS_TARGET} />);
    await sendAgentMessage("hi");
    await waitFor(() => expect(stream.deliver).toBeDefined());
    stream.deliver?.(frame(0, "assistant:0", "original text"));
    expect(await screen.findByText(/original text/)).toBeInTheDocument();

    // Away and back, with the turn still pending. The old subscription is
    // abandoned but its callback is still reachable.
    view.rerender(
      <ChatPanel session={{ ...SESSION_FIXTURE, id: "sess-2" }} target={AGENTS_TARGET} />,
    );
    view.rerender(<ChatPanel session={SESSION_FIXTURE} target={AGENTS_TARGET} />);
    expect(screen.queryByText(/original text/)).not.toBeInTheDocument();

    stream.deliver?.(frame(1, "assistant:0", "late leak"));
    await waitFor(() =>
      expect(screen.queryByText(/late leak/)).not.toBeInTheDocument(),
    );
  });

  // Not covered: an abandoned turn whose POST settles after a replacement turn
  // has started. The composer is disabled while `submitting` is true, so a
  // replacement cannot be started through the UI while the first POST is
  // pending — there is no reachable path to drive it. The owning-token guard in
  // the submit `finally` is defensive against that shape, and is deliberately
  // recorded here as unproven rather than covered by a test that fakes a route
  // the product does not have.

  it("a terminal for one reply leaves another reply still streaming", async () => {
    const stream = captureStream();
    vi.mocked(mockPostSessionMessage).mockImplementation(
      async () => new Promise(() => {}),
    );

    render(<ChatPanel session={SESSION_FIXTURE} target={AGENTS_TARGET} />);
    await sendAgentMessage("hi");
    await waitFor(() => expect(stream.deliver).toBeDefined());

    stream.deliver?.(frame(0, "alpha:0", "Alpha part"));
    stream.deliver?.(frame(1, "beta:1", "Beta part"));
    expect(await screen.findByText(/Alpha part/)).toBeInTheDocument();

    // Alpha fails; Beta must be untouched and must keep growing.
    stream.deliver?.({
      type: "error",
      channelId: "channel-1",
      cursor: 2,
      replyId: "alpha:0",
      message: "Alpha could not answer.",
    });
    stream.deliver?.(frame(3, "beta:1", " continues"));

    expect(
      await screen.findByText("Alpha could not answer."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/Beta part continues/)).toBeInTheDocument(),
    );

    // And a final for Beta does not disturb Alpha's reported failure.
    stream.deliver?.({
      type: "final",
      channelId: "channel-1",
      cursor: 4,
      replyId: "beta:1",
      reason: "completed",
    });
    expect(screen.getByText("Alpha could not answer.")).toBeInTheDocument();
    expect(screen.getByText(/Beta part continues/)).toBeInTheDocument();
  });

  it("keeps model-default diagnostics out of a streaming reply", async () => {
    const stream = captureStream();
    let releasePost: (() => void) | undefined;
    vi.mocked(mockPostSessionMessage).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releasePost = resolve;
      });
      return {
        user: { id: "u1", role: "user", text: "hi", createdAt: "" },
        dispatch: { kind: "agents", agentNames: ["analyst"] },
        meta: { replies: [] },
        replayed: false,
        messages: [],
      };
    });

    render(<ChatPanel session={SESSION_FIXTURE} target={AGENTS_TARGET} />);
    await sendAgentMessage("hi");
    await waitFor(() => expect(stream.deliver).toBeDefined());

    stream.deliver?.({
      type: "selection",
      channelId: "channel-1",
      cursor: 0,
      replyId: "analyst:0",
      speaker: "analyst",
      selection: {
        provider: "connection:abc",
        model: "gpt-5.4-mini",
        source: "app-default",
        reason: "agent-default",
        caller: "agent",
      },
    });

    stream.deliver?.(frame(1, "analyst:0", "Review in progress."));
    await screen.findByText("Review in progress.");
    expect(screen.queryByRole("note", { name: "Model selection" })).not.toBeInTheDocument();

    releasePost?.();
  });

  it("names the admitted model on a streaming reply whose selection is the agent's own choice", async () => {
    const stream = captureStream();
    let releasePost: () => void = () => {};
    vi.mocked(mockPostSessionMessage).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releasePost = resolve;
      });
      return {
        user: { id: "u1", role: "user", text: "hi", createdAt: "" },
        dispatch: { kind: "agents", agentNames: ["analyst"] }, meta: { replies: [] }, replayed: false, messages: [assistantMessage("a1", "Review done.", "analyst")],
      };
    });

    render(<ChatPanel session={SESSION_FIXTURE} target={AGENTS_TARGET} />);
    await sendAgentMessage("hi");
    await waitFor(() => expect(stream.deliver).toBeDefined());

    stream.deliver?.({
      type: "selection",
      channelId: "channel-1",
      cursor: 0,
      replyId: "analyst:0",
      speaker: "analyst",
      selection: {
        provider: "connection:abc",
        model: "gpt-5.4-mini",
        source: "agent",
        reason: "explicit-agent-choice",
        caller: "agent",
      },
    });
    stream.deliver?.(frame(1, "analyst:0", "Review in progress."));
    await screen.findByText("Review in progress.");

    const preview = screen.getByTestId("streaming-reply");
    expect(within(preview).getByLabelText("Model: gpt-5.4-mini")).toBeInTheDocument();
    expect(
      within(preview).queryByLabelText("Model: deepseek-v4-flash"),
    ).not.toBeInTheDocument();

    releasePost();
    expect(await screen.findByText("Review done.")).toBeInTheDocument();
  });
});
