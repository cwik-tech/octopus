import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";

import {
  RunTargetSidebar,
  type RunTarget,
} from "@/components/run/run-target-sidebar";

const teamPickerMount = vi.hoisted(() => vi.fn());

vi.mock("@/components/run/pickers/agent-picker", () => ({
  default: ({ query }: { query: string }) => (
    <div data-query={query} data-testid="agent-picker" />
  ),
}));

vi.mock("@/components/run/pickers/team-picker", async () => {
  const { useEffect } = await vi.importActual<typeof import("react")>("react");
  return {
    TeamPicker: ({ query }: { query: string }) => {
      useEffect(() => {
        teamPickerMount();
      }, []);
      return <div data-query={query} data-testid="team-picker" />;
    },
  };
});

/** Mirrors how RunPanel owns the tab so the derived run mode stays single-sourced. */
function Harness({
  initialTarget = "agents",
  onTargetChange,
  selectedTeamId = null,
  selectedAgentNames = [],
  onSelectedAgentNamesChange = vi.fn(),
  onSelectedTeamIdChange = vi.fn(),
}: {
  initialTarget?: RunTarget;
  onTargetChange?: (target: RunTarget) => void;
  selectedTeamId?: string | null;
  selectedAgentNames?: string[];
  onSelectedAgentNamesChange?: (names: string[]) => void;
  onSelectedTeamIdChange?: (teamId: string | null) => void;
}) {
  const [target, setTarget] = useState<RunTarget>(initialTarget);
  return (
    <RunTargetSidebar
      target={target}
      onTargetChange={(next) => {
        onTargetChange?.(next);
        setTarget(next);
      }}
      workflowPane={<div data-testid="workflow-pane" />}
      selectedAgentNames={selectedAgentNames}
      onSelectedAgentNamesChange={onSelectedAgentNamesChange}
      selectedTeamId={selectedTeamId}
      onSelectedTeamIdChange={onSelectedTeamIdChange}
    />
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

it("hides the Workflows tab unless the build enables workflows", () => {
  vi.stubEnv("VITE_ENABLE_WORKFLOWS", "");
  render(<Harness />);

  const tablist = screen.getByRole("tablist", { name: "Run target type" });
  expect(
    within(tablist).getAllByRole("tab").map((tab) => tab.textContent),
  ).toEqual(["Agents", "Teams"]);
});

it("offers the same three tabs as the Create sidebar", () => {
  render(<Harness />);

  const tablist = screen.getByRole("tablist", { name: "Run target type" });
  for (const name of ["Agents", "Teams", "Workflows"]) {
    expect(tablist).toContainElement(screen.getByRole("tab", { name }));
  }
});

it("reports the selected tab to its owner", () => {
  const onTargetChange = vi.fn();
  render(<Harness onTargetChange={onTargetChange} />);

  fireEvent.click(screen.getByRole("tab", { name: "Workflows" }));
  expect(onTargetChange).toHaveBeenCalledWith("workflows");

  fireEvent.click(screen.getByRole("tab", { name: "Teams" }));
  expect(onTargetChange).toHaveBeenCalledWith("teams");
});

it("shows the agent picker on the Agents tab", () => {
  render(<Harness />);

  expect(screen.getByRole("tab", { name: "Agents" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByTestId("agent-picker")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Search Agents" })).toBeVisible();
  expect(screen.queryByTestId("team-picker")).not.toBeInTheDocument();
});

it("swaps to the team picker when the Teams tab is selected", () => {
  render(<Harness />);

  fireEvent.click(screen.getByRole("tab", { name: "Teams" }));

  expect(screen.getByRole("tab", { name: "Teams" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByTestId("team-picker")).toBeInTheDocument();
  expect(screen.queryByTestId("agent-picker")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Search Teams" })).toBeVisible();
});

it("reveals the workflow pane only on the Workflows tab", () => {
  render(<Harness />);

  expect(screen.getByTestId("workflow-pane")).not.toBeVisible();

  fireEvent.click(screen.getByRole("tab", { name: "Workflows" }));

  expect(screen.getByRole("tab", { name: "Workflows" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByTestId("workflow-pane")).toBeVisible();
  expect(screen.queryByTestId("agent-picker")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Search Agents" }),
  ).not.toBeInTheDocument();
});

it("keeps the workflow pane mounted while chat targets are browsed", () => {
  render(<Harness />);

  fireEvent.click(screen.getByRole("tab", { name: "Workflows" }));
  fireEvent.click(screen.getByRole("tab", { name: "Agents" }));

  // Task lifecycle state lives in the pane's owner, but its subscriptions must
  // not churn every time the user peeks at the agent roster.
  expect(screen.getByTestId("workflow-pane")).toBeInTheDocument();
});

it("offers search without a section heading above the agent roster", () => {
  // The tab strip already says what the list is, so the roster starts right
  // under it and search keeps its own row.
  render(<Harness />);

  expect(screen.queryByRole("heading", { name: "Select Agents" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Search Agents" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search Agents" }), {
    target: { value: "domain" },
  });

  expect(screen.getByTestId("agent-picker")).toHaveAttribute(
    "data-query",
    "domain",
  );
});

it("renders only the agent picker; file sources now live in the chat composer", () => {
  render(<Harness selectedAgentNames={["researcher"]} />);

  expect(screen.getByTestId("agent-picker")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Add from MCP" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Upload Files")).not.toBeInTheDocument();
});

it("keeps a separate search query per tab", () => {
  render(<Harness />);

  fireEvent.click(screen.getByRole("button", { name: "Search Agents" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search Agents" }), {
    target: { value: "domain" },
  });

  fireEvent.click(screen.getByRole("tab", { name: "Teams" }));
  fireEvent.click(screen.getByRole("button", { name: "Search Teams" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search Teams" }), {
    target: { value: "board" },
  });
  expect(screen.getByTestId("team-picker")).toHaveAttribute(
    "data-query",
    "board",
  );

  fireEvent.click(screen.getByRole("tab", { name: "Agents" }));
  expect(screen.getByTestId("agent-picker")).toHaveAttribute(
    "data-query",
    "domain",
  );
});

it("keeps the loaded Team catalog mounted across tab toggles", () => {
  teamPickerMount.mockClear();
  render(<Harness />);

  fireEvent.click(screen.getByRole("tab", { name: "Teams" }));
  fireEvent.click(screen.getByRole("tab", { name: "Agents" }));
  fireEvent.click(screen.getByRole("tab", { name: "Teams" }));

  expect(teamPickerMount).toHaveBeenCalledTimes(1);
});

it("mounts the Team picker for a session that already targets a team", () => {
  teamPickerMount.mockClear();
  render(<Harness initialTarget="teams" selectedTeamId="problem-thinking-board" />);

  expect(screen.getByRole("tab", { name: "Teams" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByTestId("team-picker")).toBeInTheDocument();
});

it("keeps the active Team selected while browsing the Agents tab", () => {
  const onSelectedAgentNamesChange = vi.fn();
  const onSelectedTeamIdChange = vi.fn();
  render(
    <Harness
      initialTarget="teams"
      selectedTeamId="venture-capital-team"
      onSelectedAgentNamesChange={onSelectedAgentNamesChange}
      onSelectedTeamIdChange={onSelectedTeamIdChange}
    />,
  );

  fireEvent.click(screen.getByRole("tab", { name: "Agents" }));

  expect(screen.getByRole("tab", { name: "Agents" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByTestId("agent-picker")).toBeInTheDocument();
  expect(onSelectedAgentNamesChange).not.toHaveBeenCalled();
  expect(onSelectedTeamIdChange).not.toHaveBeenCalled();
});

it("does not clear anything when the active tab is re-clicked", () => {
  const onSelectedAgentNamesChange = vi.fn();
  const onSelectedTeamIdChange = vi.fn();
  render(
    <Harness
      selectedAgentNames={["pragmatist"]}
      onSelectedAgentNamesChange={onSelectedAgentNamesChange}
      onSelectedTeamIdChange={onSelectedTeamIdChange}
    />,
  );

  fireEvent.click(screen.getByRole("tab", { name: "Agents" }));
  expect(onSelectedAgentNamesChange).not.toHaveBeenCalled();
  expect(onSelectedTeamIdChange).not.toHaveBeenCalled();
});

it("insets the teams list by the same gutter the search header uses", () => {
  render(<Harness initialTarget="teams" />);

  // The left sidebar pads its header and list by the same amount, so a team
  // card must stop short of the panel edge rather than butting against it.
  const teamsScroll = screen.getByTestId("team-picker").parentElement;
  expect(teamsScroll).toHaveClass("px-2");
  const search = screen.getByRole("button", { name: "Search Teams" });
  expect(search.closest(".px-2")).not.toBeNull();
});
