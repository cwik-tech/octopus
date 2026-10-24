/**
 * ChatPanel: the first turn of a draft must show the question once.
 *
 * Sending from a draft publishes the session, which flips `isDraft` and makes
 * the panel re-read the transcript while the turn it just started is still in
 * flight. The server writes the user message at the start of the turn, so that
 * read can legitimately come back holding the same question the optimistic
 * bubble is already showing. Both are the same line and must render as one.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMessageTarget } from "@contracts/schemas/session-requests";
import { conversationTurnMessageId } from "@contracts/sessions";

import ChatPanel from "@/components/run/chat/chat-panel";
import {
  listChatMessages as mockListChatMessages,
  openAgentTextStream as mockOpenAgentTextStream,
  postSessionMessage as mockPostSessionMessage,
} from "@/lib/clients/session-client";
import type { ChatMessage, SessionSummary } from "@/lib/models/session-model";

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
  id: "sess-draft-1",
  title: "Untitled session",
  status: "active",
  activityType: "chat",
  createdAt: "2026-05-01T12:00:00.000Z",
  updatedAt: "2026-05-01T12:00:00.000Z",
};

const AGENTS_TARGET: SessionMessageTarget = {
  kind: "agents",
  agentNames: ["analyst"],
};

const QUESTION = "what should i do about my holidays";

/** The line the server writes when it starts the turn the client minted. */
function durableUserMessage(turnId: string): ChatMessage {
  return {
    id: conversationTurnMessageId(turnId, "user"),
    role: "user",
    text: QUESTION,
    // The server's own clock: never the millisecond the optimistic copy used.
    createdAt: "2026-05-01T12:00:03.000Z",
  };
}

/**
 * A draft that publishes itself on the first send, the way `useRunSessions`
 * does: the id never changes, `isDraft` flips to false, and that flip is what
 * makes the panel re-read the transcript mid-turn.
 */
function DraftConversation({
  onUserMessagePresenceChange,
}: {
  onUserMessagePresenceChange: (sessionId: string, present: boolean) => void;
}) {
  const [isDraft, setIsDraft] = useState(true);
  const ensureSession = useCallback(async () => {
    setIsDraft(false);
    return SESSION_FIXTURE.id;
  }, []);

  return (
    <ChatPanel
      session={SESSION_FIXTURE}
      target={AGENTS_TARGET}
      isDraft={isDraft}
      ensureSession={ensureSession}
      onUserMessagePresenceChange={onUserMessagePresenceChange}
    />
  );
}

/** Capture the panel's stream subscription: it carries the minted turn id. */
function captureStream() {
  const captured: { channelId?: string } = {};

  vi.mocked(mockOpenAgentTextStream).mockImplementation(async (params) => {
    captured.channelId = params.channelId;
    await new Promise<void>((resolve) => {
      params.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });

  return captured;
}

/** Hold every transcript read open, so the test decides when each answers. */
function captureTranscriptReads() {
  const pending: Array<(messages: ChatMessage[]) => void> = [];

  vi.mocked(mockListChatMessages).mockImplementation(
    () =>
      new Promise((resolve) => {
        pending.push((messages) =>
          resolve({ messages, outcomes: [], modelChoices: [] }),
        );
      }),
  );

  return {
    get count() {
      return pending.length;
    },
    answerAll(messages: ChatMessage[]) {
      while (pending.length > 0) pending.shift()?.(messages);
    },
  };
}

async function sendQuestion(): Promise<void> {
  const input = await screen.findByPlaceholderText(
    /Send a message to the selected agents/i,
  );
  await userEvent.type(input, QUESTION);
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
}

describe("ChatPanel — first turn of a draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.ResizeObserver = class ResizeObserver {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    };
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("shows the question once when the mid-turn read already holds it", async () => {
    const stream = captureStream();
    const reads = captureTranscriptReads();
    // Reported once for the optimistic append and again for every completed
    // transcript read, so the second call is the read landing in state.
    const presence = vi.fn();
    vi.mocked(mockPostSessionMessage).mockImplementation(
      async () => new Promise(() => {}),
    );

    render(<DraftConversation onUserMessagePresenceChange={presence} />);
    await sendQuestion();

    // The turn is open: its id is minted, so the durable line's id is known.
    await waitFor(() => expect(stream.channelId).toBeDefined());
    await waitFor(() => expect(reads.count).toBeGreaterThan(0));
    await waitFor(() => expect(presence).toHaveBeenCalledTimes(1));

    reads.answerAll([durableUserMessage(stream.channelId ?? "")]);
    await waitFor(() => expect(presence).toHaveBeenCalledTimes(2));

    // The turn is still running, and the question it asked is on screen once.
    // Waited on the visible status rather than taken from the presence
    // callback: `loadMessages` reports presence outside the transition that
    // commits this render, so the second call does not mean the render landed.
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveAccessibleName(
        /analyst is responding/i,
      ),
    );
    expect(screen.getAllByText(QUESTION)).toHaveLength(1);
  });

  it("still shows it once after the turn's own reply arrives", async () => {
    const stream = captureStream();
    const reads = captureTranscriptReads();
    let releasePost: () => void = () => {};
    vi.mocked(mockPostSessionMessage).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releasePost = resolve;
      });
      return {
        user: durableUserMessage(stream.channelId ?? ""),
        dispatch: { kind: "agents", agentNames: ["analyst"] },
        meta: { replies: [] },
        replayed: false,
        messages: [
          {
            id: "reply-1",
            role: "assistant" as const,
            text: "Take the week off.",
            createdAt: "2026-05-01T12:00:04.000Z",
            speaker: { type: "agent" as const, id: "analyst", name: "analyst" },
          },
        ],
      };
    });

    const presence = vi.fn();
    render(<DraftConversation onUserMessagePresenceChange={presence} />);
    await sendQuestion();

    await waitFor(() => expect(stream.channelId).toBeDefined());
    await waitFor(() => expect(reads.count).toBeGreaterThan(0));
    await waitFor(() => expect(presence).toHaveBeenCalledTimes(1));
    reads.answerAll([durableUserMessage(stream.channelId ?? "")]);
    await waitFor(() => expect(presence).toHaveBeenCalledTimes(2));

    releasePost();

    expect(await screen.findByText("Take the week off.")).toBeInTheDocument();
    expect(screen.getAllByText(QUESTION)).toHaveLength(1);
  });
});
