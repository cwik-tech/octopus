/**
 * ChatPanel: reading a conversation's transcript.
 *
 * Characterization ahead of moving the transcript load out of the panel. Each
 * test pins one thing the user sees while a read is still open: the panel says
 * it is loading rather than showing the conversation it just left, a read for
 * a session the panel has moved on from does not overwrite the one on screen,
 * and a question sent before the first read answers is not hidden behind it.
 *
 * A switch here is a new `session` prop on the same panel, which the component
 * supports. The desktop app remounts the panel for each session instead.
 */
import { act, render, screen } from "@testing-library/react";
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

const LOADING = "Loading messages…";
const ALPHA_QUESTION = "What does Alpha need?";
const ALPHA_REPLY = "Alpha needs a second reviewer.";
const BRAVO_QUESTION = "How is Bravo going?";
const BRAVO_REPLY = "Bravo is on schedule.";

/** What the server holds for each session; read by every transcript load. */
const transcripts = new Map<string, ChatMessage[]>();

function userMessage(id: string, text: string): ChatMessage {
  return { id, role: "user", text, createdAt: "2026-09-26T10:00:01.000Z" };
}

function agentMessage(id: string, text: string): ChatMessage {
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Hold the next transcript read open, whichever session it is for, until the
 * test releases it with what the server held.
 */
function holdNextRead(): {
  release: (messages: ChatMessage[]) => Promise<void>;
} {
  const read = deferred<Transcript>();
  vi.mocked(mockListChatMessages).mockImplementationOnce(() => read.promise);
  return {
    // Synchronised on the resolved read itself: the panel's continuation is
    // queued on the same promise ahead of this one, so by the time the await
    // returns the panel has handled the transcript, and `act` commits
    // whatever it rendered.
    release: async (messages) => {
      await act(async () => {
        read.resolve({ messages, outcomes: [], modelChoices: [] });
        await read.promise;
      });
    },
  };
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

describe("ChatPanel — reading a conversation's transcript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transcripts.clear();
    vi.mocked(mockListChatMessages).mockImplementation(async (sessionId) => ({
      messages: transcripts.get(sessionId) ?? [],
      outcomes: [],
      modelChoices: [],
    }));
  });

  it("shows the loading line, not the previous conversation, while the next one is read, and a read for a session left behind does not replace the one on screen", async () => {
    transcripts.set(SESSION_A.id, [
      userMessage("a-q", ALPHA_QUESTION),
      agentMessage("a-a", ALPHA_REPLY),
    ]);
    const view = render(<ChatPanel session={SESSION_A} />);
    expect(await screen.findByText(ALPHA_REPLY)).toBeInTheDocument();

    // Bravo's transcript is still on its way when the panel arrives there.
    const bravoRead = holdNextRead();
    view.rerender(<ChatPanel session={SESSION_B} />);
    expect(await screen.findByText(LOADING)).toBeInTheDocument();
    expect(screen.queryByText(ALPHA_QUESTION)).not.toBeInTheDocument();
    expect(screen.queryByText(ALPHA_REPLY)).not.toBeInTheDocument();

    // The user goes back to Alpha before Bravo's read answers.
    view.rerender(<ChatPanel session={SESSION_A} />);
    expect(await screen.findByText(ALPHA_REPLY)).toBeInTheDocument();

    await bravoRead.release([
      userMessage("b-q", BRAVO_QUESTION),
      agentMessage("b-a", BRAVO_REPLY),
    ]);

    expect(screen.getByText(ALPHA_QUESTION)).toBeInTheDocument();
    expect(screen.getByText(ALPHA_REPLY)).toBeInTheDocument();
    expect(screen.queryByText(BRAVO_QUESTION)).not.toBeInTheDocument();
    expect(screen.queryByText(BRAVO_REPLY)).not.toBeInTheDocument();
  });

  it("shows a question sent while the first read is still held at once", async () => {
    const firstRead = holdNextRead();
    const reply = holdReply();
    render(<ChatPanel session={SESSION_A} target={AGENTS_TARGET} />);
    expect(await screen.findByText(LOADING)).toBeInTheDocument();

    await send(ALPHA_QUESTION);

    // Neither the read nor the reply has answered yet.
    expect(await screen.findByText(ALPHA_QUESTION)).toBeInTheDocument();
    expect(screen.queryByText(LOADING)).not.toBeInTheDocument();

    // Release both: the read that was open before the question was asked,
    // then the turn itself.
    await firstRead.release([]);
    await reply.settle(
      dispatched(
        userMessage(`${await reply.sent}:user`, ALPHA_QUESTION),
        agentMessage("a-a", ALPHA_REPLY),
      ),
    );
    expect(screen.getByText(ALPHA_REPLY)).toBeInTheDocument();
  });
});
