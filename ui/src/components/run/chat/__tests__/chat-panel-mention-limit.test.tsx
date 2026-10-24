/**
 * ChatPanel: a first turn refused over its mentions must not create its draft.
 *
 * The mention limit is decided by the composer's own text and needs nothing
 * from the server. Deciding it after the draft was published left an empty
 * session behind for a message nobody sent, and publishing flips `isDraft`,
 * whose effect cleared the limit error before the user could read it.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatPanel from "@/components/run/chat/chat-panel";
import { postSessionMessage as mockPostSessionMessage } from "@/lib/clients/session-client";
import type { SessionSummary } from "@/lib/models/session-model";

// Hoisted with the mocks that return it.
const { NINE_AGENTS } = vi.hoisted(() => ({
  NINE_AGENTS: Array.from({ length: 9 }, (_unused, index) => ({
    name: `agent-${index + 1}`,
  })),
}));

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

vi.mock("@/lib/clients/agent-generator-client", () => ({
  listAgents: vi.fn().mockResolvedValue(NINE_AGENTS),
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
  id: "sess-draft-mentions",
  title: "Untitled session",
  status: "active",
  activityType: "chat",
  createdAt: "2026-05-01T12:00:00.000Z",
  updatedAt: "2026-05-01T12:00:00.000Z",
};

const LIMIT_ERROR = "A message can mention up to 8 agents.";

/** A draft that publishes itself the way `useRunSessions` does. */
function DraftConversation({
  ensureSession,
}: {
  ensureSession: () => Promise<string>;
}) {
  const [isDraft, setIsDraft] = useState(true);
  const publish = useCallback(async () => {
    setIsDraft(false);
    return ensureSession();
  }, [ensureSession]);

  return (
    <ChatPanel
      session={SESSION_FIXTURE}
      isDraft={isDraft}
      ensureSession={publish}
    />
  );
}

describe("ChatPanel — mention limit on a draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.ResizeObserver = class ResizeObserver {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    };
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("refuses a ninth mention without creating the draft's session", async () => {
    const ensureSession = vi.fn(async () => SESSION_FIXTURE.id);
    render(<DraftConversation ensureSession={ensureSession} />);

    const input = await screen.findByPlaceholderText(/Send a message/i);
    // Wait for the catalog that the mention limit is counted against.
    await userEvent.type(input, "@");
    await screen.findByRole("option", { name: "Agent 1" });
    await userEvent.keyboard("{Escape}");
    await userEvent.clear(input);
    const user = userEvent.setup();
    await user.click(input);
    await user.paste(
      `${NINE_AGENTS.map((agent) => `@${agent.name}`).join(" ")} review this`,
    );
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText(LIMIT_ERROR)).toBeInTheDocument();
    expect(ensureSession).not.toHaveBeenCalled();
    expect(mockPostSessionMessage).not.toHaveBeenCalled();
  });
});
