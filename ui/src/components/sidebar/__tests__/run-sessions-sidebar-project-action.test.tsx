import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { RunSessionsSidebar } from "@/components/sidebar/run-sessions-sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SessionSummary } from "@/lib/models/session-model";

type FetchMock = (input: string, init?: RequestInit) => Promise<Response>;

afterEach(() => {
  vi.restoreAllMocks();
});

test("assigns and moves a session through its actions menu", async () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const archivedProjectId = "33333333-3333-4333-8333-333333333333";
  const session: SessionSummary = {
    id: "22222222-2222-4222-8222-222222222222",
    title: "Recent session",
    status: "idle",
    activityType: "chat",
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:00:00.000Z",
  };
  // The component environment has no API server; Electron covers the real boundary.
  vi.stubGlobal(
    "fetch",
    vi.fn<FetchMock>(async (url, init) => {
      if (url === "/api/projects") {
        return new Response(
          JSON.stringify({
            projects: [
              {
                version: 1,
                id: projectId,
                name: "Acme",
                status: "active",
                createdAt: "2026-08-04T12:00:00.000Z",
                updatedAt: "2026-08-04T12:00:00.000Z",
                sessionCount: 0,
                activeSessionCount: 0,
              },
              {
                version: 1,
                id: archivedProjectId,
                name: "Past work",
                status: "archived",
                createdAt: "2026-08-04T12:00:00.000Z",
                updatedAt: "2026-08-04T12:00:00.000Z",
                sessionCount: 0,
                activeSessionCount: 0,
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          version: 1,
          projectId,
          sessionId: session.id,
          assignedAt: "2026-08-04T12:00:00.000Z",
          updatedAt: "2026-08-04T12:00:00.000Z",
        }),
        { status: init?.method === "PUT" ? 200 : 500 },
      );
    }),
  );
  const onSelect = vi.fn();
  const onSessionUpdated = vi.fn();
  const user = userEvent.setup();

  function Harness() {
    const [currentSession, setCurrentSession] = useState(session);
    return (
      <TooltipProvider>
        <RunSessionsSidebar
          sessions={[currentSession]}
          loading={false}
          error={null}
          selectedSessionId={currentSession.id}
          deletingSidebarItem={null}
          queueError={null}
          queueLoading={false}
          queueSnapshot={null}
          runWorkspaceView="session"
          onSelect={onSelect}
          onDelete={vi.fn()}
          onQueueSelect={vi.fn()}
          onSchedulesSelect={vi.fn()}
          onSessionUpdated={(updated) => {
            setCurrentSession(updated);
            onSessionUpdated(updated);
          }}
        />
      </TooltipProvider>
    );
  }

  render(<Harness />);

  expect(screen.getByRole("button", { name: /Queue overview/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Schedule & Batches/ })).toBeInTheDocument();
  expect(screen.getByText("Sessions")).toBeInTheDocument();
  expect(screen.getByText("Recent session")).toBeInTheDocument();
  expect(screen.queryByText("Projects")).not.toBeInTheDocument();
  expect(screen.queryByText("Ungrouped")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Session actions for Recent session" }));
  await user.click(await screen.findByRole("menuitem", { name: "Add to Project" }));
  expect(await screen.findByRole("dialog", { name: "Add to Project" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Past work/ })).not.toBeInTheDocument();
  await user.click(await screen.findByRole("button", { name: "Acme" }));

  await waitFor(() => {
    expect(onSessionUpdated).toHaveBeenCalledWith({
      ...session,
      projectId,
    });
  });
  await user.click(screen.getByRole("button", { name: "Session actions for Recent session" }));
  await user.click(await screen.findByRole("menuitem", { name: "Assign to Different Project" }));
  expect(await screen.findByRole("dialog", { name: "Add to Project" })).toBeInTheDocument();
  expect(onSelect).not.toHaveBeenCalled();
});
