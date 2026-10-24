import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { RunSessionsSidebar } from "@/components/sidebar/run-sessions-sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SessionSummary } from "@/lib/models/session-model";

afterEach(() => {
  vi.restoreAllMocks();
});

test("keeps Queue, Schedule & Batches and the Sessions header outside the scrollable session rows", () => {
  const session: SessionSummary = {
    id: "33333333-3333-4333-8333-333333333333",
    title: "A long-running conversation",
    status: "idle",
    activityType: "chat",
    createdAt: "2026-09-17T12:00:00.000Z",
    updatedAt: "2026-09-17T12:00:00.000Z",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ projects: [] }), { status: 200 })),
  );

  const { container } = render(
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
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        onQueueSelect={vi.fn()}
        onSchedulesSelect={vi.fn()}
      />
    </TooltipProvider>,
  );

  const scrollViewport = container.querySelector(".desktop-sidebar-scroll");
  expect(scrollViewport).not.toContainElement(
    screen.getByRole("button", { name: /Queue overview/ }),
  );
  expect(scrollViewport).not.toContainElement(
    screen.getByRole("button", { name: /Schedule & Batches/ }),
  );
  expect(scrollViewport).not.toContainElement(
    screen.getByRole("heading", { name: "Sessions" }),
  );
  expect(scrollViewport).not.toContainElement(
    screen.getByRole("button", { name: "Search Sessions" }),
  );
  expect(scrollViewport).toContainElement(
    screen.getByRole("button", { name: /^A long-running conversation/ }),
  );
});
