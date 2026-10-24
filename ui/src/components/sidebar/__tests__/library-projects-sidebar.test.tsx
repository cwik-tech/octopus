import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import { LibraryProjectsSidebar } from "@/components/sidebar/library-projects-sidebar";
import type { WorkspaceProjectSummary } from "@/lib/models/session-model";

const projects: WorkspaceProjectSummary[] = [
  makeProject("11111111-1111-4111-8111-111111111111", "Active work", "active"),
  makeProject("22222222-2222-4222-8222-222222222222", "Past work", "archived"),
  makeProject("33333333-3333-4333-8333-333333333333", "Older work", "archived"),
];

test("shows the archived project count in a closed-by-default accordion", async () => {
  const user = userEvent.setup();

  render(
    <LibraryProjectsSidebar
      projects={projects}
      loading={false}
      error={null}
      selectedProjectId={null}
      onCreateProject={vi.fn()}
      onOverviewSelect={vi.fn()}
      onProjectSelect={vi.fn()}
    />,
  );

  const archiveTrigger = screen.getByRole("button", { name: "Archive (2)" });
  expect(archiveTrigger).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("button", { name: /Past work/ })).not.toBeInTheDocument();

  await user.click(archiveTrigger);

  expect(archiveTrigger).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: /Past work/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Older work/ })).toBeInTheDocument();
});

function makeProject(
  id: string,
  name: string,
  status: WorkspaceProjectSummary["status"],
): WorkspaceProjectSummary {
  return {
    version: 1,
    id,
    name,
    status,
    createdAt: "2026-08-05T08:00:00.000Z",
    updatedAt: "2026-08-05T08:00:00.000Z",
    ...(status === "archived"
      ? { archivedAt: "2026-08-05T09:00:00.000Z" }
      : {}),
    sessionCount: 0,
    activeSessionCount: 0,
  };
}
