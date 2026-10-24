import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { QueueOverview } from "@/components/run/queue/queue-overview";
import type { SchedulingQueueSnapshot } from "@/lib/clients/scheduling-queue-client";

const cancelSessionTask = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("@/lib/clients/session-client", () => ({ cancelSessionTask }));

const snapshot: SchedulingQueueSnapshot = {
  version: 1,
  status: "ready",
  maximumConcurrentTasks: 2,
  slotsInUse: 1,
  availableSlots: 1,
  waitingCount: 1,
  observedAt: "2026-07-14T12:00:00.000Z",
  items: [
    {
      sessionId: "active-session",
      taskId: "active-task",
      runId: "active-run",
      workflowId: "research-workflow",
      state: "running",
      executionKind: "initial",
      source: "scheduled",
      requestedAt: "2026-07-14T11:58:00.000Z",
      startedAt: "2026-07-14T11:59:00.000Z",
    },
    {
      sessionId: "waiting-session",
      taskId: "waiting-task",
      runId: "waiting-run",
      workflowId: "delivery-workflow",
      state: "waiting",
      executionKind: "recovery",
      source: "manual_resume",
      requestedAt: "2026-07-14T11:57:00.000Z",
    },
  ],
};

it("shows live capacity, opens sessions, and confirms queued cancellation", async () => {
  cancelSessionTask.mockClear();
  const user = userEvent.setup();
  const onOpenSession = vi.fn();
  const onOpenSettings = vi.fn();
  const onRefresh = vi.fn(async () => undefined);
  render(
    <QueueOverview
      error={null}
      loading={false}
      onOpenSession={onOpenSession}
      onOpenSettings={onOpenSettings}
      onRefresh={onRefresh}
      sessions={[
        session("active-session", "Research launch"),
        session("waiting-session", "Delivery launch"),
      ]}
      snapshot={snapshot}
    />,
  );

  expect(screen.getByText("1 / 2")).toBeInTheDocument();
  expect(screen.getByText("Research launch")).toBeInTheDocument();
  expect(screen.getByText("Scheduled")).toBeInTheDocument();
  expect(screen.getByText("Delivery launch")).toBeInTheDocument();
  expect(screen.getByText("Delivery Workflow · recovery")).toBeInTheDocument();

  const runningSection = screen.getByRole("heading", { name: "Running" }).closest("section");
  expect(runningSection).not.toBeNull();
  await user.click(
    within(runningSection!).getByRole("button", { name: "Open Research launch" }),
  );
  expect(onOpenSession).toHaveBeenCalledWith("active-session");

  await user.click(screen.getByRole("button", { name: "Scheduling" }));
  expect(onOpenSettings).toHaveBeenCalledOnce();

  const waitingSection = screen.getByRole("heading", { name: "Waiting" }).closest("section");
  expect(waitingSection).not.toBeNull();
  await user.click(
    within(waitingSection!).getByRole("button", { name: "Cancel Delivery launch" }),
  );
  expect(screen.getByRole("heading", { name: "Cancel this workflow?" })).toBeInTheDocument();
  expect(screen.getByText(/removed from the FIFO queue/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Yes, cancel" }));

  expect(cancelSessionTask).toHaveBeenCalledWith("waiting-session", "waiting-task");
  expect(onRefresh).toHaveBeenCalledOnce();
});

it("labels tasks admitted by a Batch without changing other source labels", () => {
  render(
    <QueueOverview
      error={null}
      loading={false}
      onOpenSession={() => undefined}
      onOpenSettings={() => undefined}
      onRefresh={async () => undefined}
      sessions={[session("batch-session", "Batch file") ]}
      snapshot={{
        ...snapshot,
        items: [{
          ...snapshot.items[0]!,
          sessionId: "batch-session",
          taskId: "batch-task",
          source: "batch",
        }],
      }}
    />,
  );
  expect(screen.getByText("Batch")).toBeInTheDocument();
});

function session(id: string, title: string) {
  return {
    id,
    title,
    status: "active" as const,
    activityType: "workflow" as const,
    createdAt: "2026-07-14T11:00:00.000Z",
    updatedAt: "2026-07-14T12:00:00.000Z",
  };
}
