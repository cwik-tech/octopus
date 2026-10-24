import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { SettingsDialog } from "@/components/settings/settings-dialog";

vi.mock("@/components/settings/provider-settings", () => ({
  ProviderSettings: () => <div>Provider settings content</div>,
}));

vi.mock("@/components/settings/mcp-settings", () => ({
  McpSettings: () => <div>MCP settings content</div>,
}));

vi.mock("@/components/settings/scheduling-queue-settings", () => ({
  SchedulingQueueSettings: () => <div>Scheduling and Queue settings content</div>,
}));

vi.mock("@/components/settings/batch-folder-settings", () => ({
  BatchFolderSettings: () => <div>Batch folder settings content</div>,
}));

vi.mock("@/components/settings/research-acquisition-settings", () => ({
  ResearchAcquisitionSettings: () => (
    <div>Research and acquisition settings content</div>
  ),
}));

it("orders the consolidated settings sections and switches them by keyboard", async () => {
  const user = userEvent.setup();
  render(<SettingsDialog open onOpenChange={vi.fn()} />);

  const navigation = screen.getByRole("navigation", { name: "Settings sections" });
  const sectionButtons = within(navigation).getAllByRole("button");
  expect(sectionButtons.map((button) => button.textContent?.trim())).toEqual([
    "AI Providers",
    "Research & Acquisition",
    "MCPs",
    "Scheduling and Queue",
    "Batch folders",
    "Shared folders",
  ]);
  expect(screen.getByRole("button", { name: "AI Providers" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(screen.getByText("Provider settings content")).toBeInTheDocument();

  const providersButton = screen.getByRole("button", { name: "AI Providers" });
  const researchButton = screen.getByRole("button", {
    name: "Research & Acquisition",
  });
  const mcpButton = screen.getByRole("button", { name: "MCPs" });
  const schedulingButton = screen.getByRole("button", {
    name: "Scheduling and Queue",
  });
  await waitFor(() => expect(providersButton).toHaveFocus());
  await user.tab();
  expect(researchButton).toHaveFocus();
  await user.keyboard("{Enter}");

  expect(researchButton).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("heading", { name: "Research & Acquisition" }))
    .toBeInTheDocument();
  expect(screen.getByText("Research and acquisition settings content"))
    .toBeInTheDocument();

  await user.tab();
  expect(mcpButton).toHaveFocus();
  await user.keyboard("{Enter}");

  expect(mcpButton).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("heading", { name: "MCPs" })).toBeInTheDocument();
  expect(screen.getByText("MCP settings content")).toBeInTheDocument();
  expect(screen.queryByText("Research and acquisition settings content"))
    .not.toBeInTheDocument();

  await user.tab();
  expect(schedulingButton).toHaveFocus();
  await user.keyboard("{Enter}");

  expect(schedulingButton).toHaveAttribute("aria-current", "page");
  expect(mcpButton).not.toHaveAttribute("aria-current");
  expect(
    screen.getByRole("heading", { name: "Scheduling and Queue" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Scheduling and Queue settings content"),
  ).toBeInTheDocument();
  expect(screen.queryByText("MCP settings content")).not.toBeInTheDocument();
});

it("opens a requested settings section directly", () => {
  render(
    <SettingsDialog
      open
      onOpenChange={vi.fn()}
      initialSection="scheduling-queue"
    />,
  );

  expect(
    screen.getByRole("button", { name: "Scheduling and Queue" }),
  ).toHaveAttribute("aria-current", "page");
  expect(
    screen.getByRole("heading", { name: "Scheduling and Queue" }),
  ).toBeInTheDocument();
});
