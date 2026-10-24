/**
 * A finished research group belongs to its own run.
 *
 * Research activity that never acquired an answer still has to settle and
 * collapse on its own. Crucially, resolution is derived from that group's own
 * activities: starting a later, unrelated turn must not reopen it. Deriving
 * resolution from session-wide turn state reopens every old disclosure.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatPanel from "@/components/run/chat/chat-panel";
import { listResearchActivity as mockListResearchActivity } from "@/lib/clients/research-activity-client";
import type { ResearchActivity } from "@/lib/clients/research-activity-client";
import type { SessionSummary } from "@/lib/models/session-model";

vi.mock("@/lib/clients/session-client", () => ({
  listSessionResults: vi.fn().mockResolvedValue([]),
  postSessionMessage: vi.fn().mockResolvedValue({
    dispatch: { kind: 'coordinator' },
    user: {
      id: 'u1',
      role: 'user',
      text: 'test',
      createdAt: '2026-05-01T12:00:00.000Z',
    },
    messages: [
      {
        id: 'a1',
        role: 'assistant',
        text: 'reply',
        createdAt: '2026-05-01T12:00:01.000Z',
      },
    ],
    plan: {
      id: 'plan-1',
      goal: 'test',
      summary: 'test',
      status: 'needs_input',
      requiredInputs: [],
      actions: [],
      warnings: [],
      createdAt: '2026-05-01T12:00:00.000Z',
    },
    meta: { model: 'test-model', fallback: false },
    replayed: false,
  }),
  listChatMessages: vi.fn().mockResolvedValue({ messages: [], outcomes: [] }),
  openAgentTextStream: vi.fn(),
  updateSessionTitle: vi.fn(),
  listSessionFiles: vi.fn().mockResolvedValue([]),
  uploadSessionFile: vi.fn(),
  deleteSessionFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/clients/research-activity-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clients/research-activity-client")>()),
  listResearchActivity: vi.fn(),
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

/** A completed step from an older run that never acquired an answer message. */
function finishedActivity(): ResearchActivity {
  return {
    activityId: "old-activity",
    sessionId: "sess-1",
    runId: "old-run",
    assignmentId: "old-assignment",
    agentPath: "agents/web-researcher",
    toolCallId: "old-call",
    source: "browser",
    action: "open",
    kind: "page",
    state: "completed",
    createdAt: "2026-05-01T12:00:00.000Z",
    updatedAt: "2026-05-01T12:00:01.000Z",
    url: "https://example.com/report",
    title: "Old report",
  };
}

describe("ChatPanel — research group resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.ResizeObserver = class ResizeObserver {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    };
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("keeps a finished unclaimed research group collapsed while the session is busy", async () => {
    vi.mocked(mockListResearchActivity).mockResolvedValue([finishedActivity()]);

    const view = render(
      <ChatPanel
        session={SESSION_FIXTURE}
        researchActivityActive={false}
      />,
    );

    // The group's own steps are all terminal, so it settles and closes itself
    // even though no answer ever claimed it.
    const trigger = await screen.findByRole("button", {
      name: /research activity: /i,
    });
    await waitFor(
      () => expect(trigger).toHaveAttribute("aria-expanded", "false"),
      { timeout: 6_000 },
    );

    // Session-wide browser liveness goes true, standing in for any later run.
    // An implementation that derived resolution from this flag rather than from
    // the group's own steps would reopen the disclosure here.
    view.rerender(
      <ChatPanel
        session={SESSION_FIXTURE}
        researchActivityActive
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /research activity: /i }))
        .toHaveAttribute("aria-expanded", "false"));
  }, 15_000);
});
