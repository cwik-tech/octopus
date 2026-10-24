/**
 * ChatPanel's imperative handle, as the Run panel uses it.
 *
 * The Run panel keeps a ref to the chat and calls it from outside the render:
 * task actions inject local lines ("Active task …", an error a launch
 * returned), and the task event stream reloads the transcript when a run has
 * published something to it. Characterization ahead of moving the send path
 * out of the panel: both methods must keep doing this afterwards.
 */
import { createRef } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const SESSION: SessionSummary = {
  id: "sess-a",
  title: "Alpha",
  status: "active",
  activityType: "chat",
  createdAt: "2026-09-26T10:00:00.000Z",
  updatedAt: "2026-09-26T10:00:00.000Z",
};

const EARLIER_QUESTION: ChatMessage = {
  id: "q1",
  role: "user",
  text: "Start the review.",
  createdAt: "2026-09-26T10:00:01.000Z",
};

const EARLIER_REPLY: ChatMessage = {
  id: "a1",
  role: "assistant",
  text: "Review started.",
  createdAt: "2026-09-26T10:00:02.000Z",
};

/** What the server holds for the session; read by every transcript load. */
let serverMessages: ChatMessage[] = [];

describe("ChatPanel — imperative handle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverMessages = [EARLIER_QUESTION, EARLIER_REPLY];
    vi.mocked(mockListChatMessages).mockImplementation(async () => ({
      messages: serverMessages,
      outcomes: [],
      modelChoices: [],
    }));
  });

  it("injectMessage shows a local line in the conversation once, however often it is repeated", async () => {
    const chat = createRef<ChatPanelHandle>();
    render(<ChatPanel ref={chat} session={SESSION} />);
    expect(await screen.findByText("Review started.")).toBeInTheDocument();

    const note: Parameters<ChatPanelHandle["injectMessage"]>[0] = {
      role: "system",
      text: "[system] Active task: task-7",
    };
    act(() => chat.current?.injectMessage(note));
    act(() => chat.current?.injectMessage(note));
    act(() =>
      chat.current?.injectMessage({
        role: "assistant",
        text: "The launch was refused: no workflow is selected.",
      }),
    );

    expect(
      await screen.findByText("The launch was refused: no workflow is selected."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("[system] Active task: task-7")).toHaveLength(1);
    expect(screen.getByText("Review started.")).toBeInTheDocument();
  });

  it("reloadMessages shows what the server holds now and keeps a question still in flight", async () => {
    vi.mocked(mockPostSessionMessage).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    const chat = createRef<ChatPanelHandle>();
    render(<ChatPanel ref={chat} session={SESSION} />);
    expect(await screen.findByText("Review started.")).toBeInTheDocument();

    const composer = screen.getByRole("textbox");
    await userEvent.type(composer, "Is the report ready?");
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByText("Is the report ready?")).toBeInTheDocument();

    // A run publishes its delivery while the question is still unanswered, and
    // the server's record does not hold that question yet.
    serverMessages = [
      EARLIER_QUESTION,
      EARLIER_REPLY,
      {
        id: "d1",
        role: "assistant",
        text: "The report is ready: review.md",
        createdAt: "2026-09-26T10:00:03.000Z",
      },
    ];
    act(() => chat.current?.reloadMessages());

    expect(
      await screen.findByText("The report is ready: review.md"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Is the report ready?")).toBeInTheDocument();
    expect(screen.getByText("Review started.")).toBeInTheDocument();
  });
});
