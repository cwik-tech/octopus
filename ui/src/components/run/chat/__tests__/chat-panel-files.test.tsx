/**
 * Integration tests for ChatPanel chat-native file uploads.
 *
 * Covers plan §13.3 for Run chat: picker/drop/paste delegation to the session
 * file client with original File identity, optimistic reconciliation, reload
 * reconstruction, delete-after-confirm, MCP import refresh (no chat turn),
 * icon-bar scrolling, and session-switch isolation.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatPanel from "@/components/run/chat/chat-panel";
import { mcpResourcesClient as mockMcpResourcesClient } from "@/lib/clients/mcp-resources-client";
import {
  deleteSessionFile as mockDeleteSessionFile,
  listChatMessages as mockListChatMessages,
  listSessionFiles as mockListSessionFiles,
  postSessionMessage as mockPostSessionMessage,
  uploadSessionFile as mockUploadSessionFile,
} from "@/lib/clients/session-client";
import type {
  RunPlan,
  SessionFile,
  SessionSummary,
} from "@/lib/models/session-model";

// ── Mock heavy deps (client module boundary) ──────────────────────────────

vi.mock("@/lib/clients/session-client", () => ({
  listSessionResults: vi.fn().mockResolvedValue([]),
  postSessionMessage: vi.fn(),
  listChatMessages: vi.fn().mockResolvedValue({ messages: [], outcomes: [] }),
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
  fetchArtifact: vi.fn().mockResolvedValue("# Report\n\nThe delivered body."),
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

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────

const SESSION_FIXTURE: SessionSummary = {
  id: "sess-1",
  title: "Test Session",
  status: "active",
  activityType: "chat",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const OTHER_SESSION_FIXTURE: SessionSummary = {
  ...SESSION_FIXTURE,
  id: "sess-2",
  title: "Other Session",
};

const RUN_PLAN_FIXTURE: RunPlan = {
  id: "plan-1",
  goal: "First reply",
  summary: "First reply",
  status: "needs_input",
  requiredInputs: [],
  actions: [],
  warnings: [],
  createdAt: "2026-05-01T12:00:00.000Z",
};

function makeSessionFile(name: string, overrides = {}): SessionFile {
  return {
    name,
    size: 128,
    uploadedAt: "2026-05-01T12:00:00.000Z",
    parseStatus: "parsed",
    ...overrides,
  };
}

function makeFile(name: string, type = "text/plain", size = 128): File {
  return new File([new Uint8Array(size)], name, { type });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("ChatPanel — file uploads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.ResizeObserver = class ResizeObserver {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    };
    vi.mocked(mockListSessionFiles).mockResolvedValue([]);
    vi.mocked(mockDeleteSessionFile).mockResolvedValue(undefined);
  });

  it("sends a picker-selected file to the upload client with original File identity", async () => {
    const sessionFile = makeSessionFile("notes.txt");
    vi.mocked(mockUploadSessionFile).mockResolvedValue(sessionFile);
    vi.mocked(mockListSessionFiles)
      .mockResolvedValueOnce([])
      .mockResolvedValue([sessionFile]);
    const { container } = render(<ChatPanel session={SESSION_FIXTURE} />);
    await waitFor(() =>
      expect(mockListSessionFiles).toHaveBeenCalledWith("sess-1"),
    );

    const input = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    expect(input).not.toBeNull();
    const file = makeFile("notes.txt");
    fireEvent.change(input!, { target: { files: [file] } });

    await waitFor(() =>
      expect(mockUploadSessionFile).toHaveBeenCalledWith("sess-1", file),
    );
    // The exact original File object reached the client.
    expect(vi.mocked(mockUploadSessionFile).mock.calls[0]?.[1]).toBe(file);

    // Optimistic card reconciles into the authoritative SessionFile card.
    expect(await screen.findByTestId("file-message-card")).toHaveAttribute(
      "data-state",
      "current",
    );
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByText(/parsed ✓/)).toBeInTheDocument();
  });

  it("shows an optimistic uploading card that reconciles with the SessionFile", async () => {
    const sessionFile = makeSessionFile("slow.txt");
    const pendingUpload = deferred<SessionFile>();
    vi.mocked(mockUploadSessionFile).mockReturnValue(pendingUpload.promise);
    vi.mocked(mockListSessionFiles)
      .mockResolvedValueOnce([])
      .mockResolvedValue([sessionFile]);
    const { container } = render(<ChatPanel session={SESSION_FIXTURE} />);
    await waitFor(() =>
      expect(mockListSessionFiles).toHaveBeenCalledWith("sess-1"),
    );

    const file = makeFile("slow.txt");
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });

    // Optimistic state while the upload is in flight.
    const optimisticCard = await screen.findByTestId("file-message-card");
    expect(optimisticCard).toHaveAttribute("data-state", "uploading");
    expect(optimisticCard).toHaveTextContent("uploading…");

    pendingUpload.resolve(sessionFile);
    await waitFor(() =>
      expect(screen.getByTestId("file-message-card")).toHaveAttribute(
        "data-state",
        "current",
      ),
    );
  });

  it("uploads a dropped file immediately without a text message", async () => {
    const sessionFile = makeSessionFile("dropped.txt");
    vi.mocked(mockUploadSessionFile).mockResolvedValue(sessionFile);
    vi.mocked(mockListSessionFiles)
      .mockResolvedValueOnce([])
      .mockResolvedValue([sessionFile]);
    const { container } = render(<ChatPanel session={SESSION_FIXTURE} />);
    await waitFor(() =>
      expect(mockListSessionFiles).toHaveBeenCalledWith("sess-1"),
    );

    const form = container.querySelector("form")!;
    const file = makeFile("dropped.txt");
    fireEvent.drop(form, { dataTransfer: { files: [file], types: ["Files"] } });

    await waitFor(() =>
      expect(mockUploadSessionFile).toHaveBeenCalledWith("sess-1", file),
    );
    expect(mockPostSessionMessage).not.toHaveBeenCalled();
    expect(await screen.findByText("dropped.txt")).toBeInTheDocument();
  });

  it("uploads a pasted file through the same delegation path", async () => {
    const sessionFile = makeSessionFile("pasted.txt");
    vi.mocked(mockUploadSessionFile).mockResolvedValue(sessionFile);
    vi.mocked(mockListSessionFiles)
      .mockResolvedValueOnce([])
      .mockResolvedValue([sessionFile]);
    render(<ChatPanel session={SESSION_FIXTURE} />);
    const textarea = await screen.findByRole("textbox");

    const file = makeFile("pasted.txt");
    fireEvent.paste(textarea, {
      clipboardData: {
        items: [{ kind: "file", getAsFile: () => file }],
      },
    });

    await waitFor(() =>
      expect(mockUploadSessionFile).toHaveBeenCalledWith("sess-1", file),
    );
    expect(await screen.findByText("pasted.txt")).toBeInTheDocument();
  });

  it("reconstructs current file cards and the icon row from the list on mount", async () => {
    vi.mocked(mockListSessionFiles).mockResolvedValue([
      makeSessionFile("report.pdf"),
      makeSessionFile("data.xlsx"),
    ]);
    render(<ChatPanel session={SESSION_FIXTURE} />);

    expect(await screen.findByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByText("data.xlsx")).toBeInTheDocument();
    expect(screen.getAllByTestId("file-message-card")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Scroll to report.pdf" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Scroll to data.xlsx" }),
    ).toBeInTheDocument();
  });

  it("calls the existing delete endpoint and removes the card only after success", async () => {
    const sessionFile = makeSessionFile("delete-me.txt");
    vi.mocked(mockListSessionFiles)
      .mockResolvedValueOnce([sessionFile])
      .mockResolvedValue([]);
    const pendingDelete = deferred<void>();
    vi.mocked(mockDeleteSessionFile).mockReturnValue(pendingDelete.promise);
    const user = userEvent.setup();
    render(<ChatPanel session={SESSION_FIXTURE} />);

    const deleteButton = await screen.findByRole("button", {
      name: "Delete delete-me.txt",
    });
    await user.click(deleteButton);
    expect(mockDeleteSessionFile).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: /^Delete$/ }),
    );

    await waitFor(() =>
      expect(mockDeleteSessionFile).toHaveBeenCalledWith(
        "sess-1",
        "delete-me.txt",
      ),
    );
    // Card stays until the server confirms deletion.
    expect(screen.getByText("delete-me.txt")).toBeInTheDocument();

    pendingDelete.resolve(undefined);
    await waitFor(() =>
      expect(screen.queryByText("delete-me.txt")).not.toBeInTheDocument(),
    );
  });

  it("keeps the card when deletion fails", async () => {
    const sessionFile = makeSessionFile("keep-me.txt");
    vi.mocked(mockListSessionFiles).mockResolvedValue([sessionFile]);
    vi.mocked(mockDeleteSessionFile).mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<ChatPanel session={SESSION_FIXTURE} />);

    await user.click(
      await screen.findByRole("button", { name: "Delete keep-me.txt" }),
    );
    await user.click(
      screen.getByRole("button", { name: /^Delete$/ }),
    );

    await waitFor(() =>
      expect(mockDeleteSessionFile).toHaveBeenCalledWith(
        "sess-1",
        "keep-me.txt",
      ),
    );
    expect(screen.getByText("keep-me.txt")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("refreshes the file list after an MCP import without adding a chat turn", async () => {
    const capturedAt = "2026-07-12T12:00:00.000Z";
    vi.mocked(mockMcpResourcesClient.listServers).mockResolvedValue([
      { id: "documents", name: "Documents" },
    ]);
    vi.mocked(mockMcpResourcesClient.listResources).mockResolvedValue({
      resources: [
        {
          id: "resource-1",
          serverId: "documents",
          serverName: "Documents",
          uri: "docs://report",
          name: "Report",
          mimeType: "text/plain",
          disposition: "text",
        },
      ],
    });
    vi.mocked(mockMcpResourcesClient.importResource).mockResolvedValue({
      files: [makeSessionFile("report.txt", { uploadedAt: capturedAt })],
      import: {
        version: 1,
        snapshotId: "snapshot-1",
        sessionId: "sess-1",
        capturedAt,
        server: { id: "documents", name: "Documents" },
        resource: { id: "resource-1", uri: "docs://report", name: "Report" },
        totalBytes: 8,
        contents: [],
      },
    });
    const user = userEvent.setup();
    render(<ChatPanel session={SESSION_FIXTURE} />);

    await waitFor(() =>
      expect(mockListSessionFiles).toHaveBeenCalledTimes(1),
    );
    expect(mockListChatMessages).toHaveBeenCalledTimes(1);

    await user.click(
      screen.getByRole("button", { name: "Add files or MCP resources" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Add from MCP/ }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Import Report" }),
    );

    await waitFor(() =>
      expect(mockMcpResourcesClient.importResource).toHaveBeenCalled(),
    );
    // The same file controller refreshes; no chat turn is appended.
    await waitFor(() =>
      expect(mockListSessionFiles).toHaveBeenCalledTimes(2),
    );
    expect(mockPostSessionMessage).not.toHaveBeenCalled();
    expect(mockListChatMessages).toHaveBeenCalledTimes(1);
  });

  it("opens the native picker from the Add Files menu item", async () => {
    const user = userEvent.setup();
    const { container } = render(<ChatPanel session={SESSION_FIXTURE} />);
    await waitFor(() =>
      expect(mockListSessionFiles).toHaveBeenCalledWith("sess-1"),
    );
    const input = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    )!;
    const clickSpy = vi.spyOn(input, "click");

    await user.click(
      screen.getByRole("button", { name: "Add files or MCP resources" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Add Files/ }),
    );

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("still posts exactly one user message for a normal text submit", async () => {
    vi.mocked(mockPostSessionMessage).mockResolvedValueOnce({
      user: {
        id: "server-user-1",
        role: "user",
        text: "Hello there",
        createdAt: "2026-05-01T12:00:00.000Z",
      },
      dispatch: { kind: 'coordinator' },
      messages: [{
        id: "server-assistant-1",
        role: "assistant",
        text: "Hi!",
        createdAt: "2026-05-01T12:00:01.000Z",
      }],
      meta: { model: 'test-model', fallback: false },
      replayed: false,
      plan: RUN_PLAN_FIXTURE,
    });
    render(<ChatPanel session={SESSION_FIXTURE} />);
    const textarea = await screen.findByRole("textbox");

    fireEvent.change(textarea, { target: { value: "Hello there" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() =>
      expect(mockPostSessionMessage).toHaveBeenCalledTimes(1),
    );
    await waitFor(() => expect(screen.getByText("Hi!")).toBeInTheDocument());
    expect(screen.getAllByText("Hello there")).toHaveLength(1);
    expect(mockUploadSessionFile).not.toHaveBeenCalled();
  });

  it("scrolls to the matching card from the icon row", async () => {
    const scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    vi.mocked(mockListSessionFiles).mockResolvedValue([
      makeSessionFile("report.pdf"),
    ]);
    const user = userEvent.setup();
    render(<ChatPanel session={SESSION_FIXTURE} />);

    await user.click(
      await screen.findByRole("button", { name: "Scroll to report.pdf" }),
    );

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    const card = screen.getByTestId("file-message-card");
    expect(scrollIntoView.mock.instances[0]).toBe(card);
  });

  it("clears the old session's files and ignores late completions on switch", async () => {
    const oldFile = makeSessionFile("old-session.txt");
    const pendingUpload = deferred<SessionFile>();
    vi.mocked(mockUploadSessionFile).mockReturnValue(pendingUpload.promise);
    vi.mocked(mockListSessionFiles).mockImplementation((id: string) =>
      Promise.resolve(id === "sess-1" ? [oldFile] : []),
    );
    const { container, rerender } = render(
      <ChatPanel session={SESSION_FIXTURE} />,
    );
    expect(await screen.findByText("old-session.txt")).toBeInTheDocument();

    // Start an upload on the old session, then switch before it completes.
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [makeFile("in-flight.txt")] },
    });
    await waitFor(() =>
      expect(mockUploadSessionFile).toHaveBeenCalledWith(
        "sess-1",
        expect.any(File),
      ),
    );

    rerender(<ChatPanel session={OTHER_SESSION_FIXTURE} />);
    await waitFor(() =>
      expect(mockListSessionFiles).toHaveBeenCalledWith("sess-2"),
    );
    await waitFor(() =>
      expect(screen.queryByText("old-session.txt")).not.toBeInTheDocument(),
    );

    // Late completion from the old session must not leak into the new one.
    pendingUpload.resolve(makeSessionFile("in-flight.txt"));
    await waitFor(() =>
      expect(mockListSessionFiles).toHaveBeenCalledWith("sess-2"),
    );
    expect(screen.queryByText("in-flight.txt")).not.toBeInTheDocument();
    expect(screen.queryByText("old-session.txt")).not.toBeInTheDocument();
  });
});
