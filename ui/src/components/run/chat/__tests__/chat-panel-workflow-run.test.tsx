/**
 * The composer while a Workflow run is under way.
 *
 * A Team run already states itself and offers a Stop. A Workflow run said
 * nothing: the box kept its ordinary placeholder and its Send, so a message
 * meant for the run went to the General Agent instead, and the only way to end
 * the run was three navigations away in the Queue overview.
 *
 * Steering a moving run is not on offer here, so the composer must not look as
 * if it were. It says the run is working, refuses the turn, and offers Stop.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatPanel from "@/components/run/chat/chat-panel";
import {
  listChatMessages as mockListChatMessages,
  postSessionMessage as mockPostSessionMessage,
} from "@/lib/clients/session-client";
import type { SessionSummary } from "@/lib/models/session-model";

vi.mock("@/lib/clients/session-client", () => ({
  listSessionResults: vi.fn().mockResolvedValue([]),
  // Answers, so a turn that slipped past the run's refusal would be accepted
  // and the draft cleared — the refusal is then the only thing keeping the
  // user's words on screen.
  postSessionMessage: vi.fn().mockResolvedValue({
    dispatch: { kind: "coordinator" },
    user: {
      id: "u1",
      role: "user",
      text: "add a chapter on funding",
      createdAt: "2026-05-01T12:00:00.000Z",
    },
    messages: [
      {
        id: "a1",
        role: "assistant",
        text: "Added.",
        createdAt: "2026-05-01T12:00:01.000Z",
      },
    ],
    meta: { model: "test-model", fallback: false },
    replayed: false,
  }),
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

const SESSION_FIXTURE: SessionSummary = {
  id: "sess-1",
  title: "Workflow Session",
  status: "active",
  activityType: "workflow",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const RUN_NOTICE =
  "Deep Research Report is running. Chat is paused until it finishes, or until you stop the run.";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("ChatPanel during a Workflow run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockListChatMessages).mockResolvedValue({
      messages: [],
      outcomes: [],
      modelChoices: [],
    });
  });

  it("says the run is working instead of taking a message it will never read", async () => {
    render(
      <ChatPanel session={SESSION_FIXTURE} workflowRunNotice={RUN_NOTICE} />,
    );

    expect(await screen.findByText(RUN_NOTICE)).toHaveAttribute(
      "role",
      "status",
    );
    const composer = screen.getByRole("textbox");
    expect(composer).toBeDisabled();
    expect(composer).toHaveAttribute(
      "placeholder",
      "Wait for the workflow to finish, or stop it...",
    );
  });

  it("hands Stop to the run's owner instead of sending the user to the Queue", async () => {
    const stop = deferred();
    const onStopWorkflowRun = vi.fn(() => stop.promise);
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        workflowRunNotice={RUN_NOTICE}
        onStopWorkflowRun={onStopWorkflowRun}
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Stop workflow run" }),
    );

    expect(onStopWorkflowRun).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: "Send message" }),
    ).not.toBeInTheDocument();
    // Shutting a run down takes as long as its process takes to exit. Until
    // then a second press would ask for the same thing again.
    expect(
      screen.getByRole("button", { name: "Stopping workflow run" }),
    ).toBeDisabled();

    stop.resolve();

    // A run that outlived its stop can be stopped again.
    expect(
      await screen.findByRole("button", { name: "Stop workflow run" }),
    ).toBeEnabled();
  });

  /**
   * The refusal is the lock; the greyed-out textarea is only how it looks.
   *
   * `PromptInput` takes the text on the keypress and hands the turn over a
   * microtask later, so a run that starts in that gap meets a composer that
   * was free when the user pressed Enter. The message must not slip through
   * to the General Agent, and the words the user typed must come back to them
   * rather than vanish into a turn nobody answered.
   */
  it("refuses a turn a run claimed while it was in flight, and hands the draft back", async () => {
    const draft = "add a chapter on funding";
    const { rerender } = render(<ChatPanel session={SESSION_FIXTURE} />);
    const composer = await screen.findByRole("textbox");
    await userEvent.type(composer, draft);
    const form = composer.closest("form");
    if (!form) throw new Error("the composer has no form to submit");

    fireEvent.submit(form);
    rerender(
      <ChatPanel
        session={SESSION_FIXTURE}
        workflowRunNotice={RUN_NOTICE}
        onStopWorkflowRun={vi.fn()}
      />,
    );

    // The draft coming back is the refusal: nothing else writes the textarea.
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(draft));
    expect(mockPostSessionMessage).not.toHaveBeenCalled();
    expect(screen.getByText(RUN_NOTICE)).toBeInTheDocument();
  });

  it("gives the composer back when the run ends", async () => {
    const { rerender } = render(
      <ChatPanel
        session={SESSION_FIXTURE}
        workflowRunNotice={RUN_NOTICE}
        onStopWorkflowRun={vi.fn()}
      />,
    );
    expect(await screen.findByRole("textbox")).toBeDisabled();

    rerender(
      <ChatPanel session={SESSION_FIXTURE} workflowRunNotice={null} />,
    );

    expect(await screen.findByRole("textbox")).toBeEnabled();
    expect(screen.queryByText(RUN_NOTICE)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Send message" }),
    ).toBeInTheDocument();
  });
});
