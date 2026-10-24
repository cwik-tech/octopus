import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ScheduleForm } from "@/components/schedule/schedule-form";
import type { Schedule } from "@/lib/clients/schedules-client";

vi.mock("@/lib/clients/agent-generator-client", () => ({
  listAgents: vi.fn(async () => [
    { name: "summarizer", uiHidden: false, browserEnabled: false },
    { name: "web-researcher", uiHidden: false, browserEnabled: true },
  ]),
}));

vi.mock("@/lib/clients/session-client", () => ({
  listSessionResults: vi.fn().mockResolvedValue([]),
  listWorkflows: vi.fn(async () => [{ id: "daily-brief" }]),
}));

vi.mock("@/lib/clients/project-client", () => ({
  listProjects: vi.fn(async () => [
    {
      version: 1,
      id: "11111111-1111-4111-8111-111111111111",
      name: "Acme",
      status: "active",
      createdAt: "2026-08-04T10:00:00.000Z",
      updatedAt: "2026-08-04T10:00:00.000Z",
      sessionCount: 0,
      activeSessionCount: 0,
    },
    {
      version: 1,
      id: "22222222-2222-4222-8222-222222222222",
      name: "Past work",
      status: "archived",
      createdAt: "2026-08-04T10:00:00.000Z",
      updatedAt: "2026-08-04T10:00:00.000Z",
      archivedAt: "2026-08-04T11:00:00.000Z",
      sessionCount: 1,
      activeSessionCount: 0,
    },
  ]),
  getProjectBrief: vi.fn(async () => ({ content: "Brief", updatedAt: "2026-08-04T10:00:00.000Z" })),
  listProjectFiles: vi.fn(async () => []),
  createProject: vi.fn(async (input: { name: string; description?: string }) => ({
    version: 1,
    id: "33333333-3333-4333-8333-333333333333",
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    status: "active",
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:00:00.000Z",
  })),
}));

describe("ScheduleForm target select", () => {
  it("lists agents, then workflows, then agents again when switching run kind", async () => {
    const user = userEvent.setup();
    render(<ScheduleForm onCancel={() => undefined} onSave={async () => undefined} />);

    const trigger = screen.getByRole("combobox", { name: "Agent" });
    await waitFor(() => expect(trigger).not.toBeDisabled());

    await user.click(trigger);
    const researcher = await screen.findByRole("option", { name: /Web Researcher/i });
    expect(
      within(researcher).getByRole("img", { name: "Agent can browse internet" }),
    ).toBeTruthy();
    // The mock returns Summarizer first; the picker must still lead with the
    // agent that can open a website.
    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Web Researcher", "Summarizer"]);
    const summarizer = screen.getByRole("option", { name: /Summarizer/i });
    expect(
      within(summarizer).getByRole("img", { name: "Agent cannot browse internet" }),
    ).toBeTruthy();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("switch", { name: /entire workflow/i }));

    const workflowTrigger = screen.getByRole("combobox", { name: "Workflow" });
    await user.click(workflowTrigger);
    expect(await screen.findByRole("option", { name: "Daily Brief" })).toBeTruthy();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Agent" }));

    const agentTrigger = screen.getByRole("combobox", { name: "Agent" });
    await user.click(agentTrigger);
    expect(
      await screen.findByRole("option", { name: /Web Researcher/i }),
    ).toBeTruthy();
  });

  it("explains the globe on hover, inside the open agent list", async () => {
    const user = userEvent.setup();
    render(<ScheduleForm onCancel={() => undefined} onSave={async () => undefined} />);

    const trigger = screen.getByRole("combobox", { name: "Agent" });
    await waitFor(() => expect(trigger).not.toBeDisabled());
    await user.click(trigger);

    const summarizer = await screen.findByRole("option", { name: /Summarizer/i });
    await user.hover(
      within(summarizer).getByRole("img", { name: "Agent cannot browse internet" }),
    );

    expect(
      await screen.findByText("Agent cannot browse internet", {
        selector: '[data-slot="tooltip-content"], [data-slot="tooltip-content"] *',
      }),
    ).toBeTruthy();
  });

  it("preserves an explicit versioned project context when editing a schedule", async () => {
    const onSave = vi.fn(async () => undefined);
    render(
      <ScheduleForm
        schedule={projectSchedule()}
        onCancel={() => undefined}
        onSave={onSave}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Project" })).not.toBeDisabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "11111111-1111-4111-8111-111111111111",
          projectContext: {
            version: 1,
            includeBrief: true,
            fileNames: [],
          },
        }),
      );
    });
  });

  it("shows the archived owner instead of mislabeling an existing schedule as unowned", async () => {
    render(
      <ScheduleForm
        schedule={{
          ...projectScheduleWithoutContext(),
          projectId: "22222222-2222-4222-8222-222222222222",
        }}
        onCancel={() => undefined}
        onSave={async () => undefined}
      />,
    );

    const project = screen.getByRole("combobox", { name: "Project" });
    await waitFor(() => expect(project).not.toBeDisabled());
    expect(project).toHaveTextContent("Past work (Archived)");
    expect(screen.getByText(/restore it before changing its project context/i)).toBeInTheDocument();
  });

  it("creates a project from the picker and selects it without leaving the form", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => undefined);
    render(<ScheduleForm onCancel={() => undefined} onSave={onSave} />);

    const picker = screen.getByRole("combobox", { name: "Project" });
    await waitFor(() => expect(picker).not.toBeDisabled());
    await user.click(picker);
    await user.click(await screen.findByRole("option", { name: /New project/i }));

    // The action must not masquerade as a selection.
    expect(picker).toHaveTextContent("No project");

    await user.type(
      await screen.findByRole("textbox", { name: "Project name" }),
      "Launch plan",
    );
    await user.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(picker).toHaveTextContent("Launch plan"));

    await user.type(screen.getByLabelText("Name"), "Weekly brief");
    await user.click(screen.getByRole("combobox", { name: "Agent" }));
    await user.click(await screen.findByRole("option", { name: /Summarizer/i }));
    await user.type(screen.getByLabelText(/Prompt/), "Summarise the week.");
    await user.click(screen.getByRole("button", { name: "Create schedule" }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "33333333-3333-4333-8333-333333333333",
        }),
      ),
    );
  });
});

function projectSchedule(): Schedule {
  return {
    ...projectScheduleWithoutContext(),
    projectContext: { version: 1, includeBrief: true, fileNames: [] },
  };
}

function projectScheduleWithoutContext(): Schedule {
  return {
    id: "schedule-1",
    name: "Project report",
    kind: "workflow",
    target: "daily-brief",
    prompt: "Prepare the report.",
    cron: "0 9 * * *",
    timezone: "UTC",
    scheduleLabel: "Every day at 09:00",
    overlap: "skip",
    notifyOnFailure: false,
    enabled: true,
    createdAt: "2026-08-04T10:00:00.000Z",
    updatedAt: "2026-08-04T10:00:00.000Z",
    projectId: "11111111-1111-4111-8111-111111111111",
    runtime: {},
  };
}
