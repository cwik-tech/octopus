/**
 * ChatPanel dispatch when the chat is pointed at a team rather than at agents.
 *
 * A team carries its own roster and stage machinery, so the message must start
 * a team run through the task path instead of fanning out to selected agents.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatPanel from "@/components/run/chat/chat-panel";
import {
  listChatMessages as mockListChatMessages,
  postSessionMessage as mockPostSessionMessage,
} from "@/lib/clients/session-client";
import { listAgents as mockListAgents } from "@/lib/clients/agent-generator-client";
import type { SessionSummary } from "@/lib/models/session-model";

vi.mock("@/lib/clients/session-client", () => ({
  listSessionResults: vi.fn().mockResolvedValue([]),
  postSessionMessage: vi.fn().mockResolvedValue({
    dispatch: { kind: "team", teamId: "problem-thinking-board" },
    user: {
      id: "u1",
      role: "user",
      text: "brief",
      createdAt: "2026-05-01T12:00:00.000Z",
    },
    messages: [],
    plan: {
      id: "plan-1",
      goal: "brief",
      summary: "queued",
      status: "queued",
      requiredInputs: [],
      actions: [],
      warnings: [],
      createdAt: "2026-05-01T12:00:00.000Z",
    },
    task: {
      id: "task-1",
      sessionId: "sess-1",
      runId: "run-1",
      workflowId: "team-chat-problem-thinking-board",
      brief: "brief",
      status: "running",
      createdAt: "2026-05-01T12:00:00.000Z",
      cwd: "/workspace",
    },
    replayed: false,
  }),
  fetchSession: vi.fn().mockResolvedValue({
    id: "sess-1",
    title: "Compare Desktop Runtimes",
    status: "active",
    activityType: "chat",
    createdAt: "2026-05-01T12:00:00.000Z",
    updatedAt: "2026-05-01T12:00:00.000Z",
    messages: [],
  }),
  listChatMessages: vi.fn().mockResolvedValue({ messages: [], outcomes: [] }),
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

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const SESSION_FIXTURE: SessionSummary = {
  id: "sess-1",
  title: "Test Session",
  status: "active",
  activityType: "chat",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

async function sendMessage(text: string) {
  const composer = await screen.findByRole("textbox");
  // Paste complete prompts: typing @ now deliberately focuses the picker.
  const user = userEvent.setup();
  await user.click(composer);
  await user.paste(text);
  await user.keyboard("{Enter}");
}

describe("ChatPanel team target", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockListAgents).mockResolvedValue([
      { name: "market-analyst", skills: [], usedInTeams: [] },
      { name: "deal-evaluator", skills: [], usedInTeams: [] },
      { name: "outside-agent", skills: [], usedInTeams: [] },
    ]);
  });

  it("starts a team run instead of fanning out to agents", async () => {
    const onTaskStarted = vi.fn();
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: "team", teamId: "problem-thinking-board" }}
        onTaskStarted={onTaskStarted}
      />,
    );

    await sendMessage("help me choose between Tauri and Electron");

    await waitFor(() =>
      expect(mockPostSessionMessage).toHaveBeenCalledWith(
        "sess-1",
        "help me choose between Tauri and Electron",
        expect.objectContaining({
          target: { kind: "team", teamId: "problem-thinking-board" },
        }),
      ),
    );
  });

  it("passes the message through as the run brief", async () => {
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: "team", teamId: "problem-thinking-board" }}
      />,
    );

    await sendMessage("compare storage engines");

    await waitFor(() => expect(mockPostSessionMessage).toHaveBeenCalled());
    expect(vi.mocked(mockPostSessionMessage).mock.calls[0]?.[1]).toBe(
      "compare storage engines",
    );
  });

  it("identifies the selected Team while its launch is pending", async () => {
    vi.mocked(mockPostSessionMessage).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: "team", teamId: "problem-thinking-board" }}
      />,
    );

    await sendMessage("compare desktop runtimes");

    expect(
      await screen.findByRole("status", {
        name: "Problem Thinking Board is responding",
      }),
    ).toHaveTextContent("Starting the Team…");
  });

  it("publishes the generated Team-chat title the launch response carried", async () => {
    const onSessionUpdated = vi.fn();
    // The launch response now carries the renamed session, so the title
    // arrives with the turn instead of costing a second round trip.
    vi.mocked(mockPostSessionMessage).mockResolvedValueOnce({
      dispatch: { kind: "team", teamId: "problem-thinking-board" },
      user: {
        id: "u1",
        role: "user",
        text: "compare desktop runtimes",
        createdAt: "2026-05-01T12:00:00.000Z",
      },
      messages: [],
      plan: {
        id: "plan-1",
        goal: "brief",
        summary: "queued",
        status: "queued",
        requiredInputs: [],
        actions: [],
        warnings: [],
        createdAt: "2026-05-01T12:00:00.000Z",
      },
      task: {
        id: "task-1",
        sessionId: "sess-1",
        runId: "run-1",
        workflowId: "team-chat-problem-thinking-board",
        brief: "brief",
        status: "running",
        createdAt: "2026-05-01T12:00:00.000Z",
        cwd: "/workspace",
      },
      session: {
        id: "sess-1",
        title: "Compare Desktop Runtimes",
        status: "active",
        activityType: "chat",
        createdAt: "2026-05-01T12:00:00.000Z",
        updatedAt: "2026-05-01T12:00:02.000Z",
      },
      replayed: false,
    });
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: "team", teamId: "problem-thinking-board" }}
        onSessionUpdated={onSessionUpdated}
      />,
    );

    await sendMessage("compare desktop runtimes");

    await waitFor(() =>
      expect(onSessionUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Compare Desktop Runtimes" }),
      ),
    );
  });

  it("does not apply agent mention readiness checks to a team prompt", async () => {
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: "team", teamId: "problem-thinking-board" }}
      />,
    );

    await sendMessage("compare the proposal from @architect with the evidence");

    // A Team brings its own roster, so a mention inside a Team prompt is
    // ordinary text: it must not be resolved into an Agents target, and it
    // must not gate the send on the mention catalog being loaded.
    await waitFor(() => expect(mockPostSessionMessage).toHaveBeenCalled());
    expect(vi.mocked(mockPostSessionMessage).mock.calls[0]?.[2]).toMatchObject({
      target: { kind: "team", teamId: "problem-thinking-board" },
    });
  });

  it("keeps a rejected Team follow-up in the composer for retry", async () => {
    vi.mocked(mockPostSessionMessage).mockRejectedValueOnce(
      new Error("A Team run is already active"),
    );
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: "team", teamId: "problem-thinking-board" }}
      />,
    );

    const followUp = "@market-analyst what do you think?";
    await sendMessage(followUp);

    expect(await screen.findByText("A Team run is already active")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue(followUp);
  });

  it("keeps the composer unavailable while the selected Team is still responding", async () => {
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: "team", teamId: "problem-thinking-board" }}
        teamRunActive
      />,
    );

    expect(await screen.findByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("textbox")).toHaveAttribute(
      "placeholder",
      "Wait for the current Team response to finish...",
    );
  });

  it("offers every Team member in the mention picker and excludes non-members", async () => {
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: "team", teamId: "problem-thinking-board" }}
        teamMemberNames={["market-analyst", "deal-evaluator"]}
      />,
    );

    await userEvent.type(await screen.findByRole("textbox"), "@");

    expect(await screen.findByRole("option", { name: /Market Analyst/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Deal Evaluator/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Outside Agent/ })).not.toBeInTheDocument();
  });

  it("answers as the addressed Agent while a Team discussion is on screen", async () => {
    vi.mocked(mockPostSessionMessage).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: "agents", agentNames: ["pragmatist"] }}
        presentationTeamId="problem-thinking-board"
        showWorkflowMessages
        workflowMessages={[
          {
            id: "wf-1",
            role: "assistant",
            text: "Tauri wins on binary size.",
            createdAt: "2026-05-01T12:00:02.000Z",
            speaker: { type: "agent", id: "spec-alpha", name: "Spec Alpha" },
            workflow: { taskId: "task-1", runId: "run-1", round: 1 },
          },
        ]}
      />,
    );

    // The Team's discussion is what the transcript remembers; it is not who
    // this turn is for.
    expect(
      await screen.findByText("Tauri wins on binary size."),
    ).toBeInTheDocument();
    await sendMessage("what is the biggest risk?");

    await waitFor(() => expect(mockPostSessionMessage).toHaveBeenCalled());
    expect(vi.mocked(mockPostSessionMessage).mock.calls[0]?.[2]).toMatchObject({
      target: { kind: "agents", agentNames: ["pragmatist"] },
    });
    expect(
      await screen.findByRole("status", { name: "pragmatist is responding" }),
    ).toHaveTextContent("Preparing a response…");
  });

  it("resolves a mention globally when the Team on screen is only history", async () => {
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        presentationTeamId="problem-thinking-board"
        teamMemberNames={["market-analyst", "deal-evaluator"]}
        showWorkflowMessages
      />,
    );

    await sendMessage("@outside-agent what did they miss?");

    // Team-scoped mentions belong to a Team the user is addressing. A finished
    // discussion is not that, so the whole Agent catalog is in scope again.
    await waitFor(() => expect(mockPostSessionMessage).toHaveBeenCalled());
    expect(vi.mocked(mockPostSessionMessage).mock.calls[0]?.[2]).toMatchObject({
      target: { kind: "agents", agentNames: ["outside-agent"] },
    });
  });

  it("suggests the whole Agent catalog when the Team on screen is only history", async () => {
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        presentationTeamId="problem-thinking-board"
        teamMemberNames={["market-analyst", "deal-evaluator"]}
        showWorkflowMessages
      />,
    );

    await userEvent.type(await screen.findByRole("textbox"), "@");

    // Only a Team the user is addressing narrows the picker to its roster.
    expect(await screen.findByRole("option", { name: /Outside Agent/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Market Analyst/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Deal Evaluator/ })).toBeInTheDocument();
  });

  it("addresses the picked agents when no team is selected", async () => {
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: "agents", agentNames: ["pragmatist"] }}
      />,
    );

    await sendMessage("hello");

    await waitFor(() => expect(mockPostSessionMessage).toHaveBeenCalled());
    expect(vi.mocked(mockPostSessionMessage).mock.calls[0]?.[2]).toMatchObject({
      target: { kind: "agents", agentNames: ["pragmatist"] },
    });
  });
});

describe("ChatPanel team transcript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders team replies in the conversation, not only in the journey rail", async () => {
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: "team", teamId: "problem-thinking-board" }}
        workflowMessages={[
          {
            id: "wf-1",
            role: "assistant",
            text: "Tauri wins on binary size.",
            createdAt: "2026-05-01T12:00:02.000Z",
            speaker: { type: "agent", id: "spec-alpha", name: "Spec Alpha" },
            workflow: { taskId: "task-1", runId: "run-1", round: 1 },
          },
        ]}
      />,
    );

    expect(
      await screen.findByText("Tauri wins on binary size."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Round 1")).not.toBeInTheDocument();
  });

  it("shows the active Team agent as thinking", async () => {
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: "team", teamId: "problem-thinking-board" }}
        workflowPendingAgents={[
          {
            id: "pending-spec-alpha",
            name: "Spec Alpha",
            speakerId: "spec-alpha",
            taskId: "task-1",
          },
        ]}
      />,
    );

    expect(
      await screen.findByRole("status", { name: "Spec Alpha is thinking" }),
    ).toHaveTextContent("Thinking…");
  });

  it("describes coordinator work as selecting Team members", async () => {
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: "team", teamId: "problem-thinking-board" }}
        workflowPendingAgents={[
          {
            activity: "selecting-team-members",
            id: "pending-coordinator",
            name: "Deal Evaluator",
            speakerId: "deal-evaluator",
            taskId: "task-1",
          },
        ]}
      />,
    );

    expect(
      await screen.findByRole("status", {
        name: "Deal Evaluator is selecting Team members",
      }),
    ).toHaveTextContent("Selecting the right Team members…");
  });

  it("says why a Team member's step failed", async () => {
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: "team", teamId: "problem-thinking-board" }}
        teamStreamHandoffs={[
          {
            kind: "handoff",
            dispatchId: "call#1#brief-builder",
            agentName: "brief-builder",
            label: "failed",
            detail:
              "You've hit your provider usage limit. It resets on Sep 14, 2026 at 9:45 PM.",
          },
        ]}
      />,
    );

    const bubble = await screen.findByTestId("stream-handoff");
    expect(bubble).toHaveTextContent(/did not complete/i);
    expect(bubble).toHaveTextContent("It resets on Sep 14, 2026 at 9:45 PM.");
  });

  it("keeps team replies out of a plain agent chat", async () => {
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        workflowMessages={[
          {
            id: "wf-1",
            role: "assistant",
            text: "Tauri wins on binary size.",
            createdAt: "2026-05-01T12:00:02.000Z",
            speaker: { type: "agent", id: "spec-alpha", name: "Spec Alpha" },
            workflow: { taskId: "task-1", runId: "run-1", round: 1 },
          },
        ]}
      />,
    );

    await waitFor(() => expect(mockListChatMessages).toHaveBeenCalled());
    expect(
      screen.queryByText("Tauri wins on binary size."),
    ).not.toBeInTheDocument();
  });
});

describe("ChatPanel team launch reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reloads the transcript after a team launch so the prompt survives", async () => {
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: "team", teamId: "problem-thinking-board" }}
      />,
    );
    await waitFor(() => expect(mockListChatMessages).toHaveBeenCalledTimes(1));

    await sendMessage("compare desktop runtimes for this project");

    await waitFor(() => expect(mockPostSessionMessage).toHaveBeenCalled());
    // The server persists the launching message; the client must pick it up
    // rather than leaving an optimistic message that dies with the session.
    await waitFor(() =>
      expect(mockListChatMessages).toHaveBeenCalledTimes(2),
    );
  });
});
