import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { RunSessionsSidebar } from "@/components/sidebar/run-sessions-sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SessionSummary } from "@/lib/models/session-model";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Reopening a past conversation is the only way back to it after a restart.
 *
 * The desktop journey that proves a transcript survives a restart has to reach
 * the prior session the way a person does, and it used to do that by looking for
 * an `li` containing the title. That passes whether or not the row is something
 * anyone can operate — it matches the markup, not the affordance — so the row
 * could stop being a button, or lose its label, and the journey would still be
 * green while the product had become unusable.
 *
 * This is the contract that journey now relies on, pinned where it costs a
 * second to check rather than a minute: a Recent session is reachable by its
 * title, and operating it opens that session.
 */
test("a recent session is reachable and operable by its title alone", async () => {
  const session: SessionSummary = {
    id: "22222222-2222-4222-8222-222222222222",
    title: "Reload me after a restart please",
    status: "idle",
    activityType: "chat",
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:00:00.000Z",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ projects: [] }), { status: 200 })),
  );
  const onSelect = vi.fn();
  const user = userEvent.setup();

  render(
    <TooltipProvider>
      <RunSessionsSidebar
        sessions={[session]}
        loading={false}
        error={null}
        selectedSessionId={null}
        deletingSidebarItem={null}
        queueError={null}
        queueLoading={false}
        queueSnapshot={null}
        runWorkspaceView="session"
        onSelect={onSelect}
        onDelete={vi.fn()}
        onQueueSelect={vi.fn()}
        onSchedulesSelect={vi.fn()}
        onSessionUpdated={vi.fn()}
      />
    </TooltipProvider>,
  );

  // Anchored at the start of the accessible name. The row's own controls —
  // "Project actions for <title>", "Delete session <title>" — all contain the
  // title too, so a plain substring match is ambiguous and would either fail
  // outright or, worse, be silenced with `.first()` and start operating
  // whichever control happened to come first.
  const row = screen.getByRole("button", {
    name: new RegExp(`^${session.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  });
  await user.click(row);
  expect(onSelect).toHaveBeenCalledWith(session.id);
});
