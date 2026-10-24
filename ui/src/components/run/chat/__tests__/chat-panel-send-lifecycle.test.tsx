/**
 * ChatPanel: one send, from the keypress to the settled reply.
 *
 * Characterization ahead of moving the send path out of the panel. Each test
 * pins one thing a user or the owning panel relies on today: where a reply
 * that settles after a session switch lands, what the panel-wide submitting
 * flag blocks and when it lets go, what the owner hears through
 * `onPendingResponseChange`, and that StrictMode's double render does not turn
 * one send into two.
 *
 * A switch here is a new `session` prop on the same panel, which the component
 * supports. The desktop app remounts the panel for each session instead; that
 * path is covered by tests/electron/chat-session-switch-streaming.spec.ts.
 */
import { StrictMode } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTextStreamDelivery } from "@contracts/agent-text-stream";
import type { SessionMessageTarget } from "@contracts/schemas/session-requests";

import ChatPanel from "@/components/run/chat/chat-panel";
import { NO_CONTEXT_RESULTS } from "@/components/run/chat/use-context-results";
import {
  listChatMessages as mockListChatMessages,
  openAgentTextStream as mockOpenAgentTextStream,
  postSessionMessage as mockPostSessionMessage,
} from "@/lib/clients/session-client";
import type { SessionSummary } from "@/lib/models/session-model";

vi.mock("@/lib/clients/session-client", () => ({
  listSessionResults: vi.fn().mockResolvedValue([]),
  postSessionMessage: vi.fn(),
  listChatMessages: vi.fn(),
  openAgentTextStream: vi.fn(),
  updateSessionTitle: vi.fn(),
  listSessionFiles: vi.fn().mockResolvedValue([]),
  uploadSessionFile: vi.fn(),
  deleteSessionFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/clients/agent-generator-client", () => ({
  listAgents: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/clients/research-activity-client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/clients/research-activity-client")
  >()),
  listResearchActivity: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/clients/mcp-resources-client", () => ({
  mcpResourcesClient: {
    listServers: vi.fn(),
    listResources: vi.fn(),
    listImports: vi.fn(),
    importResource: vi.fn(),
  },
}));

vi.mock("@/lib/clients/mcp-interactions-client", () => ({
  mcpInteractionsClient: {
    list: vi.fn().mockResolvedValue({ interactions: [] }),
    respond: vi.fn(),
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

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

type Transcript = Awaited<ReturnType<typeof mockListChatMessages>>;
type ChatMessage = Transcript["messages"][number];
type DispatchResponse = Awaited<ReturnType<typeof mockPostSessionMessage>>;

const SESSION_A: SessionSummary = {
  id: "sess-a",
  title: "Alpha",
  status: "active",
  activityType: "chat",
  createdAt: "2026-09-26T10:00:00.000Z",
  updatedAt: "2026-09-26T10:00:00.000Z",
};

const SESSION_B: SessionSummary = {
  ...SESSION_A,
  id: "sess-b",
  title: "Bravo",
};

const AGENTS_TARGET: SessionMessageTarget = {
  kind: "agents",
  agentNames: ["analyst"],
};

const ALPHA_QUESTION = "What does Alpha need?";
const ALPHA_PREVIEW = "Alpha is drafting";
const ALPHA_REPLY = "Alpha needs a second reviewer.";

/** What the server holds for each session; read by every transcript load. */
const transcripts = new Map<string, ChatMessage[]>();

function question(id: string, text: string): ChatMessage {
  return { id, role: "user", text, createdAt: "2026-09-26T10:00:01.000Z" };
}

function answer(id: string, text: string): ChatMessage {
  return {
    id,
    role: "assistant",
    text,
    createdAt: "2026-09-26T10:00:02.000Z",
    speaker: { type: "agent", id: "analyst", name: "analyst" },
  };
}

function dispatched(user: ChatMessage, reply: ChatMessage): DispatchResponse {
  return {
    user,
    dispatch: { kind: "agents", agentNames: ["analyst"] },
    meta: { replies: [] },
    replayed: false,
    messages: [reply],
  };
}

function frame(cursor: number, text: string): AgentTextStreamDelivery {
  return {
    type: "delta",
    channelId: "channel-1",
    cursor,
    replyId: "analyst:0",
    channel: "text",
    text,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Capture the panel's preview subscription.
 *
 * `opened` resolves when the panel subscribes, handing back the callback the
 * test drives frames through. The subscription then stays open until the panel
 * aborts it, as the real stream does.
 */
function captureStream(): {
  opened: Promise<(delivery: AgentTextStreamDelivery) => void>;
} {
  const opened = deferred<(delivery: AgentTextStreamDelivery) => void>();
  vi.mocked(mockOpenAgentTextStream).mockImplementation(async (params) => {
    opened.resolve(params.onDelivery);
    await new Promise<void>((resolve) => {
      params.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  return { opened: opened.promise };
}

/**
 * Hold the next turn's POST open until the test settles it, as a slow model
 * would. `sent` resolves with the turn id the panel minted for it.
 */
function holdReply(): {
  sent: Promise<string>;
  settle: (response: DispatchResponse) => Promise<void>;
} {
  const sent = deferred<string>();
  const reply = deferred<DispatchResponse>();
  vi.mocked(mockPostSessionMessage).mockImplementationOnce(
    (_sessionId, _text, input) => {
      sent.resolve(input?.turnId ?? "");
      return reply.promise;
    },
  );
  return {
    sent: sent.promise,
    // Synchronised on the resolved request itself: the panel's own
    // continuation is queued on the same promise ahead of this one, so by the
    // time the await returns the panel has handled the reply, and `act`
    // commits whatever it rendered.
    settle: async (response) => {
      await act(async () => {
        reply.resolve(response);
        await reply.promise;
      });
    },
  };
}

async function send(text: string): Promise<void> {
  const composer = await screen.findByRole("textbox");
  await userEvent.type(composer, text);
  await userEvent.keyboard("{Enter}");
}

describe("ChatPanel — one send, from keypress to settled reply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transcripts.clear();
    vi.mocked(mockListChatMessages).mockImplementation(async (sessionId) => ({
      messages: transcripts.get(sessionId) ?? [],
      outcomes: [],
      modelChoices: [],
    }));
  });

  it("lands a reply that settles after a switch in its own conversation and leaves the one on screen alone", async () => {
    transcripts.set(SESSION_B.id, [
      question("b-q", "How is Bravo going?"),
      answer("b-a", "Bravo is on schedule."),
    ]);
    const stream = captureStream();
    const reply = holdReply();
    const view = render(
      <ChatPanel session={SESSION_A} target={AGENTS_TARGET} />,
    );

    await send(ALPHA_QUESTION);
    const deliver = await stream.opened;
    act(() => deliver(frame(0, ALPHA_PREVIEW)));
    expect(await screen.findByText(ALPHA_PREVIEW)).toBeInTheDocument();

    view.rerender(<ChatPanel session={SESSION_B} target={AGENTS_TARGET} />);
    expect(await screen.findByText("Bravo is on schedule.")).toBeInTheDocument();

    // The server finishes Alpha's turn while Bravo is on screen.
    const alphaQuestion = question(`${await reply.sent}:user`, ALPHA_QUESTION);
    const alphaReply = answer("a-a", ALPHA_REPLY);
    transcripts.set(SESSION_A.id, [alphaQuestion, alphaReply]);
    await reply.settle(dispatched(alphaQuestion, alphaReply));

    expect(screen.getByText("How is Bravo going?")).toBeInTheDocument();
    expect(screen.getByText("Bravo is on schedule.")).toBeInTheDocument();
    expect(screen.queryByText(ALPHA_QUESTION)).not.toBeInTheDocument();
    expect(screen.queryByText(ALPHA_REPLY)).not.toBeInTheDocument();

    // Back on Alpha, the reply is there once, read from Alpha's own record.
    view.rerender(<ChatPanel session={SESSION_A} target={AGENTS_TARGET} />);
    expect(await screen.findByText(ALPHA_REPLY)).toBeInTheDocument();
    expect(screen.getAllByText(ALPHA_QUESTION)).toHaveLength(1);
    expect(screen.getAllByText(ALPHA_REPLY)).toHaveLength(1);
    expect(screen.queryByText("Bravo is on schedule.")).not.toBeInTheDocument();
  });

  it("holds the whole composer while a send is in flight, across a switch, and lets go when it settles", async () => {
    captureStream();
    const reply = holdReply();
    const view = render(
      <ChatPanel session={SESSION_A} target={AGENTS_TARGET} />,
    );

    await send(ALPHA_QUESTION);

    // On Alpha, the reply is its own: Send has become Stop, and nothing else
    // can be typed or re-pointed at another model until it settles.
    expect(
      await screen.findByRole("button", { name: "Stop generation" }),
    ).toBeEnabled();
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByLabelText("Run chat model")).toBeDisabled();

    // The flag is the panel's, not the session's: Bravo cannot send either,
    // and it offers no Stop for a reply that is not its own.
    view.rerender(<ChatPanel session={SESSION_B} target={AGENTS_TARGET} />);
    expect(
      screen.getByRole("button", { name: "Waiting for response" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Stop generation" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByLabelText("Run chat model")).toBeDisabled();

    await reply.settle(
      dispatched(
        question(`${await reply.sent}:user`, ALPHA_QUESTION),
        answer("a-a", ALPHA_REPLY),
      ),
    );

    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(screen.getByLabelText("Run chat model")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  });

  it("tells its owner the reply is pending from send to settle, naming the session that sent it", async () => {
    const stream = captureStream();
    const reply = holdReply();
    const onPendingResponseChange = vi.fn();
    const view = render(
      <ChatPanel
        session={SESSION_A}
        target={AGENTS_TARGET}
        onPendingResponseChange={onPendingResponseChange}
      />,
    );

    await send(ALPHA_QUESTION);
    await stream.opened;
    expect(onPendingResponseChange.mock.calls).toEqual([[SESSION_A.id, true]]);

    // Arriving on Bravo says nothing about Bravo.
    view.rerender(
      <ChatPanel
        session={SESSION_B}
        target={AGENTS_TARGET}
        onPendingResponseChange={onPendingResponseChange}
      />,
    );
    expect(onPendingResponseChange.mock.calls).toEqual([[SESSION_A.id, true]]);

    await reply.settle(
      dispatched(
        question(`${await reply.sent}:user`, ALPHA_QUESTION),
        answer("a-a", ALPHA_REPLY),
      ),
    );

    expect(onPendingResponseChange.mock.calls).toEqual([
      [SESSION_A.id, true],
      [SESSION_A.id, false],
    ]);
  });

  it("sends once, subscribes once and shows the reply once under StrictMode", async () => {
    const stream = captureStream();
    const reply = holdReply();
    const onPendingResponseChange = vi.fn();
    render(
      <StrictMode>
        <ChatPanel
          session={SESSION_A}
          target={AGENTS_TARGET}
          onPendingResponseChange={onPendingResponseChange}
        />
      </StrictMode>,
    );

    await send(ALPHA_QUESTION);
    const deliver = await stream.opened;
    act(() => deliver(frame(0, ALPHA_PREVIEW)));
    expect(await screen.findAllByText(ALPHA_PREVIEW)).toHaveLength(1);

    const alphaQuestion = question(`${await reply.sent}:user`, ALPHA_QUESTION);
    await reply.settle(dispatched(alphaQuestion, answer("a-a", ALPHA_REPLY)));

    expect(screen.getAllByText(ALPHA_QUESTION)).toHaveLength(1);
    expect(screen.getAllByText(ALPHA_REPLY)).toHaveLength(1);
    expect(screen.queryByText(ALPHA_PREVIEW)).not.toBeInTheDocument();
    // One request each way: the POST that sends the turn, and the stream
    // that previews it.
    expect(mockPostSessionMessage).toHaveBeenCalledOnce();
    expect(mockOpenAgentTextStream).toHaveBeenCalledOnce();
    expect(onPendingResponseChange.mock.calls).toEqual([
      [SESSION_A.id, true],
      [SESSION_A.id, false],
    ]);
  });

  // A reply that just landed is itself a result the next turn may carry, so
  // the panel asks the owner of the results list to read it again.
  it("asks its owner to refresh the results once a reply lands, and not before", async () => {
    captureStream();
    const reply = holdReply();
    const refresh = vi.fn();
    render(
      <ChatPanel
        session={SESSION_A}
        target={AGENTS_TARGET}
        contextResults={{ ...NO_CONTEXT_RESULTS, refresh }}
      />,
    );

    await send(ALPHA_QUESTION);
    const turnId = await reply.sent;
    expect(refresh).not.toHaveBeenCalled();

    await reply.settle(
      dispatched(question(`${turnId}:user`, ALPHA_QUESTION), answer("a-a", ALPHA_REPLY)),
    );

    expect(screen.getByText(ALPHA_REPLY)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not ask for a results refresh when the send fails", async () => {
    captureStream();
    vi.mocked(mockPostSessionMessage).mockRejectedValueOnce(
      new Error("The provider is unavailable."),
    );
    const refresh = vi.fn();
    render(
      <ChatPanel
        session={SESSION_A}
        target={AGENTS_TARGET}
        contextResults={{ ...NO_CONTEXT_RESULTS, refresh }}
      />,
    );

    await send(ALPHA_QUESTION);

    expect(
      await screen.findByText("The provider is unavailable."),
    ).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
