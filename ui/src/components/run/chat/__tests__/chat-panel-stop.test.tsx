/**
 * The composer's Stop control.
 *
 * While work the user started is still generating, Send becomes Stop, so it can
 * be ended from where it was asked for without opening the run pane. Two kinds
 * of work qualify: an agent reply this panel is waiting on, and a running Team,
 * which the panel above owns. A Team's launch request is neither yet.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMessageTarget } from "@contracts/schemas/session-requests";

import ChatPanel from "@/components/run/chat/chat-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  cancelAgentChatTurn as mockCancelAgentChatTurn,
  listChatMessages as mockListChatMessages,
  postSessionMessage as mockPostSessionMessage,
} from "@/lib/clients/session-client";
import type { SessionSummary } from "@/lib/models/session-model";

vi.mock("@/lib/clients/session-client", () => ({
  listSessionResults: vi.fn().mockResolvedValue([]),
  postSessionMessage: vi.fn(),
  cancelAgentChatTurn: vi.fn().mockResolvedValue(undefined),
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
  title: "Stop Session",
  status: "active",
  activityType: "chat",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const WORKFLOW_RUN_NOTICE =
  "Writing Workflow is running. Chat is paused until it finishes, " +
  "or until you stop the run.";

const TEAM_TARGET: SessionMessageTarget = {
  kind: "team",
  teamId: "problem-thinking-board",
};

type Transcript = Awaited<ReturnType<typeof mockListChatMessages>>;

/** What the server keeps for a turn whose request was dropped. */
function cancelledTranscript(turnId: string, question: string): Transcript {
  return {
    messages: [
      {
        id: `${turnId}:user`,
        role: "user",
        text: question,
        createdAt: "2026-09-10T09:00:00.000Z",
        turnId,
      },
    ],
    outcomes: [
      { turnId, state: "cancelled", code: "cancelled", retryable: false },
    ],
    modelChoices: [],
  };
}

/**
 * A reply that runs until its request is aborted, which is all the server sees
 * of Stop. It keeps the question and records the turn as cancelled, so the next
 * transcript read returns both.
 */
function replyUntilStopped() {
  vi.mocked(mockPostSessionMessage).mockImplementationOnce(
    (_sessionId, text, input) => {
      const turnId = input?.turnId ?? "";
      const signal = input?.signal;
      return new Promise((_resolve, reject) => {
        const settle = () => {
          vi.mocked(mockListChatMessages).mockResolvedValue(cancelledTranscript(turnId, text));
          reject(new Error("The server cancelled this turn."));
        };
        signal?.addEventListener("abort", settle, { once: true });
        vi.mocked(mockCancelAgentChatTurn).mockImplementationOnce(async () => { settle(); });
      });
    },
  );
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function sendMessage(text: string) {
  const composer = await screen.findByRole("textbox");
  await userEvent.type(composer, text);
  await userEvent.keyboard("{Enter}");
}

describe("ChatPanel stop control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockListChatMessages).mockResolvedValue({
      messages: [],
      outcomes: [],
      modelChoices: [],
    });
  });

  it("turns Send into Stop while an agent reply is generating", async () => {
    vi.mocked(mockPostSessionMessage).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    render(<ChatPanel session={SESSION_FIXTURE} />);
    expect(
      await screen.findByRole("button", { name: "Send message" }),
    ).toBeInTheDocument();

    await sendMessage("summarise the plan");

    expect(
      await screen.findByRole("button", { name: "Stop generation" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Send message" }),
    ).not.toBeInTheDocument();
  });

  it("names the Stop action in a tooltip", async () => {
    vi.mocked(mockPostSessionMessage).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    render(<ChatPanel session={SESSION_FIXTURE} />, {
      wrapper: TooltipProvider,
    });
    await sendMessage("summarise the plan");

    await userEvent.hover(
      await screen.findByRole("button", { name: "Stop generation" }),
    );

    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Stop generation",
    );
  });

  it("stops the reply without an error and leaves the question to the transcript", async () => {
    replyUntilStopped();
    render(<ChatPanel session={SESSION_FIXTURE} />);
    await sendMessage("summarise the plan");

    await userEvent.click(
      await screen.findByRole("button", { name: "Stop generation" }),
    );

    // The server's own record of the stop, read back once the request ends.
    expect(await screen.findByText("Response cancelled")).toBeInTheDocument();
    expect(screen.getByText("summarise the plan")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Send message" }),
    ).toBeInTheDocument();
    // A stop is not a failure. Nothing is reported, and the question is not
    // handed back to the composer, because the transcript already holds it.
    expect(
      screen.queryByText("The operation was aborted."),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("offers an enabled Stop for the next reply after a stopped one", async () => {
    replyUntilStopped();
    render(<ChatPanel session={SESSION_FIXTURE} />);
    await sendMessage("summarise the plan");
    await userEvent.click(
      await screen.findByRole("button", { name: "Stop generation" }),
    );
    // The stopped reply has settled: the transcript read after it has landed
    // and Send is back.
    expect(await screen.findByText("Response cancelled")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Send message" }),
    ).toBeInTheDocument();

    replyUntilStopped();
    await sendMessage("list the open risks");

    const stop = await screen.findByRole("button", { name: "Stop generation" });
    expect(stop).toBeEnabled();

    // Stopping this one too is what releases its request.
    await userEvent.click(stop);
    expect(
      await screen.findByRole("button", { name: "Send message" }),
    ).toBeInTheDocument();
  });

  it("hands Stop to the Team's owner while the addressed Team is running", async () => {
    const stop = deferred();
    const onStopTeamRun = vi.fn(() => stop.promise);
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={TEAM_TARGET}
        teamRunActive
        onStopTeamRun={onStopTeamRun}
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Stop Team run" }),
    );

    expect(onStopTeamRun).toHaveBeenCalledOnce();
    // Shutting a run down takes as long as its process takes to exit. Until
    // then a second press would ask for the same thing again.
    expect(
      screen.getByRole("button", { name: "Stopping Team run" }),
    ).toBeDisabled();

    stop.resolve();

    // A run that outlived its stop can be stopped again.
    expect(
      await screen.findByRole("button", { name: "Stop Team run" }),
    ).toBeEnabled();
  });

  /**
   * One Stop, and the line above it decides what it means.
   *
   * A run can claim the conversation while a General Agent reply is still
   * settling: the notice appears the moment the task is seen, and the reply's
   * own request is still open. The composer then said "Chat is paused until it
   * finishes, or until you stop the run" above a button that aborted the reply
   * and left the run going — the one promise on screen, broken by the only
   * control offered for it.
   */
  it("hands Stop to a Workflow run that claims the conversation mid-reply", async () => {
    const onStopWorkflowRun = vi.fn(() => Promise.resolve());
    vi.mocked(mockPostSessionMessage).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    const { rerender } = render(<ChatPanel session={SESSION_FIXTURE} />);
    await sendMessage("summarise the plan");
    expect(
      await screen.findByRole("button", { name: "Stop generation" }),
    ).toBeEnabled();

    rerender(
      <ChatPanel
        session={SESSION_FIXTURE}
        workflowRunNotice={WORKFLOW_RUN_NOTICE}
        onStopWorkflowRun={onStopWorkflowRun}
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Stop workflow run" }),
    );
    expect(onStopWorkflowRun).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: "Stop generation" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the launch spinner while a Team is being started", async () => {
    vi.mocked(mockPostSessionMessage).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={TEAM_TARGET}
        onStopTeamRun={vi.fn()}
      />,
    );

    await sendMessage("compare desktop runtimes");

    // Aborting the launch request could not promise the Team would not start,
    // so Stop waits until there is a run to stop.
    expect(
      await screen.findByRole("status", {
        name: "Problem Thinking Board is responding",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Waiting for response" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Stop generation" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Stop Team run" }),
    ).not.toBeInTheDocument();
  });
});
