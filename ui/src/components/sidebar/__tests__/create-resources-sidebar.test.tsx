import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/clients/agent-generator-client", () => ({
  checkAgentProviderHealth: vi.fn(),
}));

import { CreateResourcesSidebar } from "@/components/sidebar/create-resources-sidebar";
import { checkAgentProviderHealth } from "@/lib/clients/agent-generator-client";

const createData = {
  workflows: [
    {
      id: "deep-research",
      description: "Research pipeline",
    },
  ],
  agents: [
    {
      name: "scoping-lawyer",
      description: "Defines the engagement scope",
      skills: [],
      usedInTeams: [],
    },
    {
      name: "michigan-contract-lawyer",
      description: "Reviews Michigan contracts",
      skills: [],
      usedInTeams: [],
    },
  ],
  teams: [
    {
      id: "legal-review-team",
      name: "Legal Review Team",
      description: "Coordinates legal review",
      tags: [],
      agentCount: 2,
      health: {
        status: "warning" as const,
        errors: [],
        warnings: ["Budget cap is advisory until enforcement is enabled"],
      },
    },
  ],
};

function renderSidebar(props: {
  createTab: "agents" | "teams" | "workflows";
  onCreateTabChange?: (tab: "agents" | "teams" | "workflows") => void;
}) {
  return render(
    <CreateResourcesSidebar
      createData={createData}
      createError={null}
      createLoading={false}
      createTab={props.createTab}
      onCreateTabChange={props.onCreateTabChange}
      deletingSidebarItem={null}
      selectedCreateWorkflowId={null}
      selectedCreateTeamId={null}
      selectedCreateAgentName={null}
      onWorkflowSelect={vi.fn()}
      onTeamSelect={vi.fn()}
      onAgentSelect={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
}

describe("CreateResourcesSidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkAgentProviderHealth).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("hides the Workflows tab unless the build enables workflows", () => {
    vi.stubEnv("VITE_ENABLE_WORKFLOWS", "");
    renderSidebar({ createTab: "agents" });

    const tablist = screen.getByRole("tablist", { name: "Resource type" });
    expect(
      within(tablist).getAllByRole("tab").map((tab) => tab.textContent),
    ).toEqual(["Teams", "Agents"]);
  });

  it("shows the same agent provider state the Run picker shows", async () => {
    // Create and Run list the same agents from the same catalog. Before this,
    // only Run asked whether their providers worked, so the tab where you fix
    // an agent was the one tab that never told you it was broken.
    const diagnosticMessage =
      "Agent 'scoping-lawyer' (openai): This provider account has no remaining quota or credits. Check billing.";
    vi.mocked(checkAgentProviderHealth).mockResolvedValue([
      {
        agentName: "scoping-lawyer",
        provider: "openai",
        model: "gpt-5.4",
        status: "error",
        message: diagnosticMessage,
        checkedAt: "2026-09-11T00:00:00.000Z",
        diagnostics: [
          {
            severity: "error",
            kind: "billing",
            message: diagnosticMessage,
            subject: {
              agentName: "scoping-lawyer",
              provider: "openai",
              model: "gpt-5.4",
            },
          },
        ],
      },
    ]);

    renderSidebar({ createTab: "agents" });

    await waitFor(() => {
      expect(vi.mocked(checkAgentProviderHealth)).toHaveBeenCalledWith({
        agentNames: ["scoping-lawyer", "michigan-contract-lawyer"],
      });
    });

    const row = await screen.findByRole("button", {
      name: "Scoping Lawyer — Agent issue",
    });
    expect(row).toHaveAccessibleDescription(diagnosticMessage);
    expect(screen.getByRole("img", { name: "Agent issue" })).toBeInTheDocument();
    // The healthy agent stays quiet, exactly as it does in the Run picker.
    expect(
      screen.getByRole("button", { name: "Michigan Contract Lawyer" }),
    ).toBeInTheDocument();
  });

  it("shows a Team warning beside the name and explains it on hover", async () => {
    const user = userEvent.setup();
    renderSidebar({ createTab: "teams" });

    const warning = screen.getByRole("img", { name: "Team warning" });
    await user.hover(warning);

    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Budget cap is advisory until enforcement is enabled",
    );
  });

  it("shows the Team warning when keyboard focus reaches the Team row", async () => {
    const user = userEvent.setup();
    renderSidebar({ createTab: "teams" });

    const row = screen.getByRole("button", {
      name: "Legal Review Team — Team warning",
    });
    screen.getByRole("button", { name: "Search Teams" }).focus();
    await user.tab();
    await user.tab();
    await user.tab();

    expect(row).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Budget cap is advisory until enforcement is enabled",
    );
  });

  it("names an unhealthy Team row as a warning and describes it with the reason", async () => {
    // The row's own aria-label replaces everything nested inside it, so the
    // indicator's label never reaches a screen reader on its own.
    renderSidebar({ createTab: "teams" });

    const row = screen.getByRole("button", {
      name: "Legal Review Team — Team warning",
    });

    expect(row).toHaveAccessibleDescription(
      "Budget cap is advisory until enforcement is enabled",
    );
  });

  it("keeps the shared search header outside the scrollable Agent and Team rows", async () => {
    const user = userEvent.setup();
    const { container } = renderSidebar({ createTab: "agents" });

    await user.click(screen.getByRole("button", { name: "Search Agents" }));
    const scrollViewport = container.querySelector(".desktop-sidebar-scroll");
    const search = screen.getByRole("searchbox", { name: "Search Agents" });
    expect(scrollViewport).not.toContainElement(search);
    expect(scrollViewport).toContainElement(screen.getByText("Scoping Lawyer"));
    expect(search.closest("form")).toHaveClass("w-full");
  });

  it("exposes Agents, Teams and Workflows tabs and lists the matching resources", async () => {
    const user = userEvent.setup();
    const onCreateTabChange = vi.fn();
    const { rerender } = renderSidebar({ createTab: "agents", onCreateTabChange });

    expect(screen.getByRole("tab", { name: "Agents" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Teams" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Workflows" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Workflows" }));
    expect(onCreateTabChange).toHaveBeenCalledWith("workflows");

    rerender(
      <CreateResourcesSidebar
        createData={createData}
        createError={null}
        createLoading={false}
        createTab="workflows"
        onCreateTabChange={onCreateTabChange}
        deletingSidebarItem={null}
        selectedCreateWorkflowId={null}
        selectedCreateTeamId={null}
        selectedCreateAgentName={null}
        onWorkflowSelect={vi.fn()}
        onTeamSelect={vi.fn()}
        onAgentSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByRole("tab", { name: "Workflows" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Deep Research")).toBeInTheDocument();
    expect(screen.queryByText("Scoping Lawyer")).not.toBeInTheDocument();
  });

  it("switches between Agent and Team lists while preserving separate searches", async () => {
    const user = userEvent.setup();
    const onCreateTabChange = vi.fn();
    const { rerender } = renderSidebar({ createTab: "agents", onCreateTabChange });

    await user.click(screen.getByRole("button", { name: "Search Agents" }));
    await user.type(screen.getByRole("searchbox", { name: "Search Agents" }), "michigan");
    expect(screen.queryByText("Scoping Lawyer")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Teams" }));
    expect(onCreateTabChange).toHaveBeenLastCalledWith("teams");
    rerender(
      <CreateResourcesSidebar
        createData={createData}
        createError={null}
        createLoading={false}
        createTab="teams"
        onCreateTabChange={onCreateTabChange}
        deletingSidebarItem={null}
        selectedCreateWorkflowId={null}
        selectedCreateTeamId={null}
        selectedCreateAgentName={null}
        onWorkflowSelect={vi.fn()}
        onTeamSelect={vi.fn()}
        onAgentSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("Legal Review Team")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Search Teams" }));
    await user.type(screen.getByRole("searchbox", { name: "Search Teams" }), "review");

    await user.click(screen.getByRole("tab", { name: "Agents" }));
    expect(onCreateTabChange).toHaveBeenLastCalledWith("agents");
    rerender(
      <CreateResourcesSidebar
        createData={createData}
        createError={null}
        createLoading={false}
        createTab="agents"
        onCreateTabChange={onCreateTabChange}
        deletingSidebarItem={null}
        selectedCreateWorkflowId={null}
        selectedCreateTeamId={null}
        selectedCreateAgentName={null}
        onWorkflowSelect={vi.fn()}
        onTeamSelect={vi.fn()}
        onAgentSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.queryByText("Scoping Lawyer")).not.toBeInTheDocument();
    expect(screen.getByText("Michigan Contract Lawyer")).toBeInTheDocument();
  });
});
