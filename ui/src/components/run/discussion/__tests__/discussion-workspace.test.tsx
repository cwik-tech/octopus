import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DiscussionWorkspace } from "../discussion-workspace";
import type { ConfiguredTeamMember } from "../discussion-journey-model";

vi.mock("@/lib/clients/session-client", () => ({
  listSessionResults: vi.fn().mockResolvedValue([]),
  getWorkflowStages: vi.fn().mockResolvedValue([
    {
      id: "discuss",
      team: "problem-thinking-board",
      discussions: [
        {
          levelId: "deliberation",
          maxRounds: 1,
          minRounds: 1,
          participants: ["spec-alpha", "spec-beta"],
        },
      ],
    },
  ]),
}));

vi.mock("@/lib/clients/team-builder-client", () => ({
  readTeamBuilderTeam: vi.fn().mockResolvedValue({
    agentCount: 3,
    agents: [
      {
        name: "spec-alpha",
        personaModel: "gpt-5.4",
        personaProvider: "openai",
        referenced: false,
        role: "Participant",
        tier: "strategic",
        tools: [],
        type: "agent",
      },
      {
        name: "spec-beta",
        personaModel: "gpt-5.4",
        personaProvider: "openai",
        referenced: false,
        role: "Participant",
        tier: "strategic",
        tools: [],
        type: "agent",
      },
      {
        name: "spec-gamma",
        personaModel: "claude-opus-4.7",
        personaProvider: "anthropic",
        referenced: false,
        role: "Participant",
        tier: "strategic",
        tools: [],
        type: "agent",
      },
    ],
    id: "problem-thinking-board",
    models: {},
    name: "Problem Thinking Board",
    tags: [],
    teamPath: "teams/problem-thinking-board",
    warnings: [],
    yaml: "",
  }),
}));

const boardMembers: ConfiguredTeamMember[] = [
  {
    model: "gpt-5.4",
    name: "board-lead",
    provider: "openai",
    role: "Coordinator",
  },
  {
    model: "gpt-5.4-mini",
    name: "spec-alpha",
    provider: "openai",
    role: "Participant",
  },
  {
    model: "claude-haiku-4-5-20251001",
    name: "spec-beta",
    provider: "claude",
    role: "Participant",
  },
  {
    model: "gpt-5.4-mini",
    name: "spec-gamma",
    provider: "openai",
    role: "Participant",
  },
];

const gammaReply = {
  createdAt: "2026-08-31T12:00:00.000Z",
  id: "gamma-1",
  role: "assistant" as const,
  speaker: { id: "spec-gamma", name: "Spec Gamma", type: "agent" as const },
  text: "Spec Gamma answered without being convened.",
  workflow: { round: 1, taskId: "task-1" },
};

const runningTask = {
  label: "Board Team",
  mode: "running" as const,
  runId: "run-1",
  taskId: "task-1",
  workflowId: "team-chat-board-team",
};

function sectionFor(name: string): HTMLElement {
  const section = screen.getByRole("heading", { name }).closest("section");
  if (!section) throw new Error(`Missing rail section: ${name}`);
  return section;
}

describe("DiscussionWorkspace Team-chat presentation", () => {
  it("shows the configured lead and every member with its model icon before the first turn", () => {
    render(
      <DiscussionWorkspace
        eventGroups={[]}
        messages={[]}
        pendingAgents={[]}
        presentation="team-chat"
        tasks={[]}
        teamMembers={boardMembers}
      >
        <div>Conversation</div>
      </DiscussionWorkspace>,
    );

    expect(
      screen.getAllByRole("heading").map((heading) => heading.textContent),
    ).toEqual(["Discussion lead", "Selected participants", "Team"]);

    const lead = sectionFor("Discussion lead");
    expect(lead).toHaveTextContent("Board Lead");
    expect(within(lead).getByLabelText("Model: gpt-5.4")).toBeInTheDocument();

    expect(sectionFor("Selected participants")).not.toHaveTextContent("Spec");

    const team = sectionFor("Team");
    expect(team).toHaveTextContent("Spec Alpha");
    expect(team).toHaveTextContent("Spec Beta");
    expect(team).toHaveTextContent("Spec Gamma");
    expect(team).not.toHaveTextContent("Board Lead");
    expect(
      within(team).getAllByLabelText("Model: gpt-5.4-mini"),
    ).toHaveLength(2);
    expect(
      within(team).getByLabelText("Model: claude-haiku-4-5-20251001"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Team participants")).toHaveTextContent(
      "Participant · idle",
    );
  });

  it("keeps every card in its section as a selected member starts thinking", async () => {
    const rosterSelected = {
      id: "roster-selected",
      participants: ["spec-beta"],
      stageType: "discussion",
      ts: 0,
      type: "discussion.roster.selected",
    };
    const { rerender } = render(
      <DiscussionWorkspace
        eventGroups={[
          {
            taskActive: true,
            taskId: "task-1",
            taskRunId: "run-1",
            events: [rosterSelected],
          },
        ]}
        messages={[]}
        pendingAgents={[]}
        presentation="team-chat"
        tasks={[runningTask]}
        teamMembers={boardMembers}
      >
        <div>Conversation</div>
      </DiscussionWorkspace>,
    );

    await screen.findByLabelText("Team participants");
    expect(sectionFor("Discussion lead")).toHaveTextContent("Board Lead");
    expect(sectionFor("Selected participants")).toHaveTextContent("Spec Beta");
    const idleTeam = sectionFor("Team");
    expect(idleTeam).toHaveTextContent("Spec Alpha");
    expect(idleTeam).toHaveTextContent("Spec Gamma");
    expect(idleTeam).not.toHaveTextContent("Spec Beta");

    rerender(
      <DiscussionWorkspace
        eventGroups={[
          {
            taskActive: true,
            taskId: "task-1",
            taskRunId: "run-1",
            events: [rosterSelected],
          },
        ]}
        messages={[gammaReply]}
        pendingAgents={[
          {
            id: "pending-spec-beta",
            name: "Spec Beta",
            speakerId: "spec-beta",
            taskId: "task-1",
          },
        ]}
        presentation="team-chat"
        tasks={[runningTask]}
        teamMembers={boardMembers}
      >
        <div>Conversation</div>
      </DiscussionWorkspace>,
    );

    const selected = sectionFor("Selected participants");
    expect(selected).toHaveTextContent("Spec Beta");
    expect(selected).toHaveTextContent("thinking");
    expect(selected).not.toHaveTextContent("Spec Gamma");
    const thinkingTeam = sectionFor("Team");
    expect(thinkingTeam).toHaveTextContent("Spec Alpha");
    // Spec Gamma answered without being convened. Speaking is activity, not
    // membership, so it stays on the bench and reads as replied.
    expect(thinkingTeam).toHaveTextContent("Spec Gamma");
    expect(thinkingTeam).toHaveTextContent("replied");
    expect(thinkingTeam).not.toHaveTextContent("Spec Beta");
    expect(screen.getByText("Spec Beta").closest("section")).toHaveClass(
      "motion-safe:animate-pulse",
      "border-orange-500/60",
    );
    expect(screen.queryByText("Discussion Flow")).not.toBeInTheDocument();
  });

  it("shows a Team without a discussion lead as one roster", () => {
    render(
      <DiscussionWorkspace
        eventGroups={[]}
        messages={[]}
        pendingAgents={[]}
        presentation="team-chat"
        tasks={[]}
        teamMembers={[
          {
            model: "gpt-5.4-mini",
            name: "line-one",
            provider: "openai",
            role: "Participant" as const,
          },
          {
            model: "gpt-5.4-mini",
            name: "line-two",
            provider: "openai",
            role: "Participant" as const,
          },
        ]}
      >
        <div>Conversation</div>
      </DiscussionWorkspace>,
    );

    expect(
      screen.getAllByRole("heading").map((heading) => heading.textContent),
    ).toEqual(["Team"]);
    const team = sectionFor("Team");
    expect(team).toHaveTextContent("Line One");
    expect(team).toHaveTextContent("Line Two");
    expect(within(team).getAllByLabelText("Model: gpt-5.4-mini")).toHaveLength(2);
  });

  it("loads model badges when configured members provide names only", async () => {
    render(
      <DiscussionWorkspace
        eventGroups={[]}
        messages={[]}
        pendingAgents={[]}
        presentation="team-chat"
        teamId="problem-thinking-board"
        teamMembers={[
          { name: "spec-alpha", role: "Participant" },
          { name: "spec-beta", role: "Participant" },
          { name: "spec-gamma", role: "Participant" },
        ]}
        tasks={[]}
      >
        <div>Conversation</div>
      </DiscussionWorkspace>,
    );

    const participants = screen.getByLabelText("Team participants");
    expect(await within(participants).findAllByLabelText(/^Model:/)).toHaveLength(3);
    expect(
      within(participants).getByLabelText("Model: claude-opus-4.7"),
    ).toBeInTheDocument();
  });

});
