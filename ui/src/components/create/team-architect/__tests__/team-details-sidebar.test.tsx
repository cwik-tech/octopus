import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readTeamBuilderTeam } from "@/lib/clients/team-builder-client";
import { TeamDetailsSidebar } from "../team-details-sidebar";
import type { TeamEditorController } from "../use-team-editor";

vi.mock("@/contexts/provider-catalog-context", () => ({
  useProviderCatalog: () => ({
    groups: [],
    defaultModel: { provider: "openai", model: "gpt-5.5" },
    defaultModelState: {
      status: "available",
      provider: "openai",
      model: "gpt-5.5",
    },
    loading: false,
    error: null,
    refresh: async () => undefined,
  }),
}));

vi.mock("@/lib/clients/team-builder-client", () => ({
  readTeamBuilderTeam: vi.fn(),
}));

vi.mock("@/components/create/agent-architect-panel", () => ({
  default: (props: {
    agentSelectionRequest?: { id: string; agentName: string } | null;
    detailsOpen?: boolean;
    back?: { label: string; onClick: () => void };
    onResourcesChanged?: () => Promise<void> | void;
  }) =>
    props.detailsOpen ? (
      <div>
        {props.back ? (
          <button
            type="button"
            aria-label={props.back.label}
            onClick={props.back.onClick}
          />
        ) : null}
        <div data-testid="agent-inspector">
          {props.agentSelectionRequest?.agentName}
        </div>
        <button type="button" onClick={() => void props.onResourcesChanged?.()}>
          Save agent
        </button>
      </div>
    ) : null,
}));

vi.mock("../team-details-editor", () => ({
  TeamDetailsEditor: () => <div>Team details</div>,
}));
vi.mock("../add-team-agent-dialog", () => ({ AddTeamAgentDialog: () => null }));
vi.mock("../delete-team-dialog", () => ({ DeleteTeamDialog: () => null }));
vi.mock("../team-yaml-preview-dialog", () => ({
  TeamYamlPreviewDialog: () => null,
}));

const TEAM_REQUEST = { id: "data-engineering-team", requestId: "request-1" };

describe("TeamDetailsSidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens a roster agent in the right pane and goes back to the team", async () => {
    const user = userEvent.setup();
    renderSidebar(teamEditor());

    await user.click(screen.getByText("Data Pipeline Engineer"));

    expect(screen.getByTestId("agent-inspector")).toHaveTextContent(
      "data-pipeline-engineer",
    );
    expect(screen.queryByText("Team details")).not.toBeInTheDocument();
    expect(screen.queryByText("Agent Roster")).not.toBeInTheDocument();

    await user.click(screen.getByLabelText("Back to team"));

    expect(screen.queryByTestId("agent-inspector")).not.toBeInTheDocument();
    expect(screen.getByText("Team details")).toBeInTheDocument();
    expect(screen.getByText("Agent Roster")).toBeInTheDocument();
  });

  it("shows the team again when another team is selected", async () => {
    const user = userEvent.setup();
    const editor = teamEditor();
    const { rerender } = renderSidebar(editor);

    await user.click(screen.getByText("Data Pipeline Engineer"));
    rerender(
      <TeamDetailsSidebar
        detailsOpen
        teamSelectionRequest={{ id: "research-team", requestId: "request-2" }}
        modelGroups={[]}
        editor={editor}
      />,
    );

    expect(screen.queryByTestId("agent-inspector")).not.toBeInTheDocument();
    expect(screen.getByText("Team details")).toBeInTheDocument();
  });

  it("re-reads the team after the open agent is saved", async () => {
    const user = userEvent.setup();
    const editor = teamEditor();
    const refreshed = { id: "data-engineering-team", agents: [] };
    vi.mocked(readTeamBuilderTeam).mockResolvedValue(
      refreshed as unknown as Awaited<ReturnType<typeof readTeamBuilderTeam>>,
    );
    renderSidebar(editor);

    await user.click(screen.getByText("Data Pipeline Engineer"));
    await user.click(screen.getByText("Save agent"));

    // A saved persona can change the agent's model or role, which the roster
    // shows once the person goes back.
    expect(readTeamBuilderTeam).toHaveBeenCalledWith("data-engineering-team");
    expect(editor.setDetail).toHaveBeenCalledWith(refreshed);
    expect(editor.refreshTeamsAfterMutation).toHaveBeenCalled();
  });
});

function renderSidebar(editor: TeamEditorController) {
  return render(
    <TeamDetailsSidebar
      detailsOpen
      teamSelectionRequest={TEAM_REQUEST}
      modelGroups={[]}
      editor={editor}
    />,
  );
}

function teamEditor(): TeamEditorController {
  return {
    creating: false,
    selectedTeamId: "data-engineering-team",
    detail: {
      id: "data-engineering-team",
      agents: [
        {
          name: "data-pipeline-engineer",
          type: "agent",
          role: "Owns batch and streaming ingestion.",
          tier: "strategic",
          tools: [],
          referenced: true,
        },
      ],
    },
    removeAgent: vi.fn(),
    refreshTeamsAfterMutation: vi.fn(async () => undefined),
    setDetail: vi.fn(),
    saving: false,
  } as unknown as TeamEditorController;
}
