/**
 * ChatPanel: transcript reads, sends and local notes that land out of order.
 *
 * Three findings recorded when the conversation moved into its own hook
 * (docs/adr/2026-09-26-ChatPanel-Conversation-Stream-Hook.md), each stated here
 * as what a person sees:
 *
 * - a transcript read started for one conversation never replaces another
 *   conversation that is on screen by the time it lands;
 * - coming back to a conversation before its reply settles still shows the
 *   reply once it settles (the desktop remounts the panel for each session, so
 *   the panel that sent the turn is gone by then);
 * - a note the app adds right after asking for a transcript read, as the task
 *   event stream does when a run finishes, stays where it was added when that
 *   read lands, and when a later one does.
 */
import { createRef } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMessageTarget } from "@contracts/schemas/session-requests";

import ChatPanel, { type ChatPanelHandle } from "@/components/run/chat/chat-panel";
import {
  listChatMessages as mockListChatMessages,
  postSessionMessage as mockPostSessionMessage,
} from "@/lib/clients/session-client";
import type { SessionSummary } from "@/lib/models/session-model";

vi.mock("@/lib/clients/session-client", () => ({
  listSessionResults: vi.fn().mockResolvedValue([]),
  postSessionMessage: vi.fn(),
  listChatMessages: vi.fn(),
  // Resolved, not bare: the panel chains `.catch` onto this call.
  openAgentTextStream: vi.fn().mockResolvedValue(undefined),
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
const ALPHA_REPLY = "Alpha needs a second reviewer.";
const DONE_NOTE =
  "✅ Done. What’s next? You can run another workflow or ask me about the results.";

/** What the server holds for each session; read by every transcript load. */
const transcripts = new Map<string, ChatMessage[]>();

function question(id: string, text: string, at = "2026-09-26T10:00:01.000Z"): ChatMessage {
  return { id, role: "user", text, createdAt: at };
}

function answer(id: string, text: string, at = "2026-09-26T10:00:02.000Z"): ChatMessage {
  return {
    id,
    role: "assistant",
    text,
    createdAt: at,
    speaker: { type: "agent", id: "analyst", name: "analyst" },
  };
}

function transcript(messages: ChatMessage[]): Transcript {
  return { messages, outcomes: [], modelChoices: [] };
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Hold the next transcript read open until the test settles it.
 *
 * `requested` resolves with the session the read was for. `settle` waits on the
 * held promise itself: the panel's continuation is queued on it first, so by
 * the time the await returns the panel has handled the read, and `act`
 * commits what it rendered.
 */
function holdNextRead(): {
  requested: Promise<string>;
  settle: (value: Transcript) => Promise<void>;
} {
  const requested = deferred<string>();
  const read = deferred<Transcript>();
  vi.mocked(mockListChatMessages).mockImplementationOnce((sessionId) => {
    requested.resolve(sessionId);
    return read.promise;
  });
  return {
    requested: requested.promise,
    settle: async (value) => {
      await act(async () => {
        read.resolve(value);
        await read.promise;
      });
    },
  };
}

/** Hold the next turn's POST open until the test settles it, as a slow model would. */
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

/** Whether `first` is rendered before `second` in the document. */
function renderedBefore(first: HTMLElement, second: HTMLElement): boolean {
  return Boolean(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

describe("ChatPanel — reads, sends and notes that land out of order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transcripts.clear();
    transcripts.set(SESSION_A.id, [
      question("a-q1", "Start the review."),
      answer("a-a1", "Review started."),
    ]);
    transcripts.set(SESSION_B.id, [
      question("b-q1", "How is Bravo going?"),
      answer("b-a1", "Bravo is on schedule."),
    ]);
    vi.mocked(mockListChatMessages).mockImplementation(async (sessionId) =>
      transcript(transcripts.get(sessionId) ?? []),
    );
  });

  it("does not let a read started for one conversation replace the conversation shown when it lands", async () => {
    const chat = createRef<ChatPanelHandle>();
    const view = render(
      <ChatPanel ref={chat} session={SESSION_A} target={AGENTS_TARGET} />,
    );
    expect(await screen.findByText("Review started.")).toBeInTheDocument();

    // A run publishes something to Alpha, and the panel is asked to read
    // Alpha's transcript again; the read is slow.
    const alphaRead = holdNextRead();
    act(() => chat.current?.reloadMessages());
    expect(await alphaRead.requested).toBe(SESSION_A.id);

    // The person switches to Bravo before that read lands.
    view.rerender(
      <ChatPanel ref={chat} session={SESSION_B} target={AGENTS_TARGET} />,
    );
    expect(await screen.findByText("Bravo is on schedule.")).toBeInTheDocument();

    await alphaRead.settle(transcript(transcripts.get(SESSION_A.id) ?? []));

    expect(screen.getByText("How is Bravo going?")).toBeInTheDocument();
    expect(screen.getByText("Bravo is on schedule.")).toBeInTheDocument();
    expect(screen.queryByText("Start the review.")).not.toBeInTheDocument();
    expect(screen.queryByText("Review started.")).not.toBeInTheDocument();
  });

  it("shows a reply that settles after the person has come back to its conversation", async () => {
    const reply = holdReply();
    // The desktop remounts the panel for each session, as the keys do here.
    const view = render(
      <ChatPanel key="alpha-first" session={SESSION_A} target={AGENTS_TARGET} />,
    );
    expect(await screen.findByText("Review started.")).toBeInTheDocument();
    await send(ALPHA_QUESTION);
    const turnId = await reply.sent;

    view.rerender(
      <ChatPanel key="bravo" session={SESSION_B} target={AGENTS_TARGET} />,
    );
    expect(await screen.findByText("Bravo is on schedule.")).toBeInTheDocument();

    // The server has stored Alpha's question but not its reply yet.
    const alphaQuestion = question(`${turnId}:user`, ALPHA_QUESTION, "2026-09-26T10:00:03.000Z");
    transcripts.set(SESSION_A.id, [
      ...(transcripts.get(SESSION_A.id) ?? []),
      alphaQuestion,
    ]);
    view.rerender(
      <ChatPanel key="alpha-again" session={SESSION_A} target={AGENTS_TARGET} />,
    );
    expect(await screen.findByText(ALPHA_QUESTION)).toBeInTheDocument();

    // Alpha's turn finishes while Alpha is on screen again.
    const alphaReply = answer("a-a2", ALPHA_REPLY, "2026-09-26T10:00:04.000Z");
    transcripts.set(SESSION_A.id, [
      ...(transcripts.get(SESSION_A.id) ?? []),
      alphaReply,
    ]);
    await reply.settle(dispatched(alphaQuestion, alphaReply));

    expect(await screen.findByText(ALPHA_REPLY)).toBeInTheDocument();
    expect(screen.getAllByText(ALPHA_QUESTION)).toHaveLength(1);
    expect(screen.getAllByText(ALPHA_REPLY)).toHaveLength(1);
    expect(screen.queryByText("Bravo is on schedule.")).not.toBeInTheDocument();
  });

  it("keeps a note added right after a read was asked for when that read lands", async () => {
    const chat = createRef<ChatPanelHandle>();
    render(<ChatPanel ref={chat} session={SESSION_A} target={AGENTS_TARGET} />);
    expect(await screen.findByText("Review started.")).toBeInTheDocument();

    // What the task event stream does when a run finishes with no delivery:
    // ask for the transcript again, then add its own note at once.
    const read = holdNextRead();
    act(() => chat.current?.reloadMessages());
    act(() =>
      chat.current?.injectMessage({ role: "assistant", text: DONE_NOTE }),
    );
    expect(screen.getByText(DONE_NOTE)).toBeInTheDocument();

    await read.settle(transcript(transcripts.get(SESSION_A.id) ?? []));

    expect(screen.getByText(DONE_NOTE)).toBeInTheDocument();
    expect(screen.getByText("Review started.")).toBeInTheDocument();
  });

  it("shows a line once when the app adds a message the server has already stored", async () => {
    const chat = createRef<ChatPanelHandle>();
    render(<ChatPanel ref={chat} session={SESSION_A} target={AGENTS_TARGET} />);
    expect(await screen.findByText("Review started.")).toBeInTheDocument();

    // What a refused task start does: the server stores its reply and returns
    // it, and the app shows that stored message at once.
    const briefRequired = "What would you like this work to be about?";
    const stored = answer("a-brief", briefRequired, "2026-09-26T10:00:05.000Z");
    transcripts.set(SESSION_A.id, [
      ...(transcripts.get(SESSION_A.id) ?? []),
      stored,
    ]);
    act(() =>
      chat.current?.injectMessage({
        role: "assistant",
        text: briefRequired,
        id: stored.id,
        createdAt: stored.createdAt,
      }),
    );
    expect(screen.getAllByText(briefRequired)).toHaveLength(1);

    const read = holdNextRead();
    act(() => chat.current?.reloadMessages());
    await read.settle(transcript(transcripts.get(SESSION_A.id) ?? []));

    expect(screen.getAllByText(briefRequired)).toHaveLength(1);
    expect(screen.getByText("Review started.")).toBeInTheDocument();
  });

  it("keeps a note of its own beside a stored line that happens to say the same", async () => {
    const chat = createRef<ChatPanelHandle>();
    render(<ChatPanel ref={chat} session={SESSION_A} target={AGENTS_TARGET} />);
    expect(await screen.findByText("Review started.")).toBeInTheDocument();

    // Two different lines with the same words: one the server stored, one the
    // app added and never stored.
    const sameWords = "The run finished.";
    transcripts.set(SESSION_A.id, [
      ...(transcripts.get(SESSION_A.id) ?? []),
      answer("a-finished", sameWords, "2026-09-26T10:00:05.000Z"),
    ]);
    act(() =>
      chat.current?.injectMessage({ role: "assistant", text: sameWords }),
    );

    const read = holdNextRead();
    act(() => chat.current?.reloadMessages());
    await read.settle(transcript(transcripts.get(SESSION_A.id) ?? []));

    expect(screen.getAllByText(sameWords)).toHaveLength(2);
  });

  it("keeps a note where it was added when a later read brings newer messages", async () => {
    // One test clock for every timestamp in this case: the note is stamped
    // at NOTE_AT by the panel's own clock, after the earlier reply, and the
    // server records the delivery a minute later. Only `Date` is replaced;
    // timers, promises and events stay real.
    const noteAt = Date.parse("2026-09-26T10:00:03.000Z");
    const deliveryAt = new Date(noteAt + 60_000).toISOString();
    vi.useFakeTimers({ toFake: ["Date"], now: noteAt });
    try {
      const chat = createRef<ChatPanelHandle>();
      render(<ChatPanel ref={chat} session={SESSION_A} target={AGENTS_TARGET} />);
      expect(await screen.findByText("Review started.")).toBeInTheDocument();

      act(() =>
        chat.current?.injectMessage({ role: "assistant", text: DONE_NOTE }),
      );
      expect(screen.getByText(DONE_NOTE)).toBeInTheDocument();

      transcripts.set(SESSION_A.id, [
        ...(transcripts.get(SESSION_A.id) ?? []),
        answer("a-d1", "The report is ready: review.md", deliveryAt),
      ]);
      const read = holdNextRead();
      act(() => chat.current?.reloadMessages());
      await read.settle(transcript(transcripts.get(SESSION_A.id) ?? []));

      const note = screen.getByText(DONE_NOTE);
      const delivery = screen.getByText("The report is ready: review.md");
      expect(renderedBefore(screen.getByText("Review started."), note)).toBe(true);
      expect(renderedBefore(note, delivery)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
