import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { ProjectAssignmentDialog } from "@/components/library/project-assignment-dialog";
import type { SessionSummary } from "@/lib/models/session-model";

type FetchMock = (input: string, init?: RequestInit) => Promise<Response>;

const firstProjectId = "11111111-1111-4111-8111-111111111111";
const secondProjectId = "22222222-2222-4222-8222-222222222222";
const archivedProjectId = "33333333-3333-4333-8333-333333333333";
const session: SessionSummary = {
  id: "44444444-4444-4444-8444-444444444444",
  projectId: firstProjectId,
  title: "Launch research",
  status: "idle",
  activityType: "chat",
  createdAt: "2026-08-04T12:00:00.000Z",
  updatedAt: "2026-08-04T12:00:00.000Z",
};

const projects = [
  makeProject(firstProjectId, "Current project", "active"),
  makeProject(secondProjectId, "Destination", "active"),
  makeProject(archivedProjectId, "Archived project", "archived"),
];

afterEach(() => {
  vi.restoreAllMocks();
});

test("assignment dialog moves a session and closes only after success", async () => {
  let resolveAssignment!: () => void;
  const assignmentPending = new Promise<void>((resolve) => {
    resolveAssignment = resolve;
  });
  const fetchMock = vi.fn<FetchMock>(async (url, init) => {
    if (url === "/api/projects" || url === "/api/projects?includeArchived=true") {
      return new Response(JSON.stringify({ projects }), { status: 200 });
    }
    await assignmentPending;
    return new Response(
      JSON.stringify({
        version: 1,
        sessionId: session.id,
        projectId: secondProjectId,
        assignedAt: "2026-08-04T12:00:00.000Z",
        updatedAt: "2026-08-04T12:01:00.000Z",
      }),
      { status: init?.method === "PUT" ? 200 : 500 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  const onOpenChange = vi.fn();
  const onSessionUpdated = vi.fn();
  const user = userEvent.setup();

  render(
    <ProjectAssignmentDialog
      open
      session={session}
      onOpenChange={onOpenChange}
      onSessionUpdated={onSessionUpdated}
    />,
  );

  expect(await screen.findByRole("button", { name: /Current project/ })).toHaveTextContent(
    "Current",
  );
  expect(screen.queryByRole("button", { name: /Archived project/ })).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith("/api/projects");

  await user.click(screen.getByRole("button", { name: /Destination/ }));
  expect(screen.getByRole("button", { name: /Destination/ })).toBeDisabled();
  expect(onOpenChange).not.toHaveBeenCalledWith(false);

  resolveAssignment();
  await waitFor(() => {
    expect(onSessionUpdated).toHaveBeenCalledWith({
      ...session,
      projectId: secondProjectId,
    });
  });
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(fetchMock).toHaveBeenLastCalledWith(
    `/api/projects/${secondProjectId}/sessions/${session.id}`,
    { method: "PUT" },
  );
});

test("assignment dialog keeps errors visible and allows removing membership", async () => {
  let rejectAssignment = true;
  const fetchMock = vi.fn<FetchMock>(async (url, init) => {
    if (url === "/api/projects" || url === "/api/projects?includeArchived=true") {
      return new Response(JSON.stringify({ projects }), { status: 200 });
    }
    if (rejectAssignment && init?.method === "PUT") {
      return new Response(JSON.stringify({ error: "Assignment failed" }), {
        status: 409,
      });
    }
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal("fetch", fetchMock);
  const onOpenChange = vi.fn();
  const onSessionUpdated = vi.fn<(updated: SessionSummary) => void>();
  const user = userEvent.setup();

  render(
    <ProjectAssignmentDialog
      open
      session={session}
      onOpenChange={onOpenChange}
      onSessionUpdated={onSessionUpdated}
    />,
  );

  await user.click(await screen.findByRole("button", { name: /Destination/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Assignment failed");
  expect(onOpenChange).not.toHaveBeenCalledWith(false);

  rejectAssignment = false;
  await user.click(screen.getByRole("button", { name: "Remove from project" }));
  // A session outside every project has no projectId at all: the schema keeps
  // a missing optional field missing, and strict equality tells the two apart.
  await waitFor(() => {
    expect(onSessionUpdated.mock.lastCall?.[0]).toStrictEqual({
      id: "44444444-4444-4444-8444-444444444444",
      title: "Launch research",
      status: "idle",
      activityType: "chat",
      createdAt: "2026-08-04T12:00:00.000Z",
      updatedAt: "2026-08-04T12:00:00.000Z",
    });
  });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

function makeProject(
  id: string,
  name: string,
  status: "active" | "archived",
) {
  return {
    version: 1 as const,
    id,
    name,
    status,
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:00:00.000Z",
    sessionCount: 0,
    activeSessionCount: 0,
  };
}
