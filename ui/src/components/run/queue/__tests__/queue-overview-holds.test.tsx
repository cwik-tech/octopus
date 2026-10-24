import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { QueueOverview } from "@/components/run/queue/queue-overview";
import type {
  SchedulingQueueItem,
  SchedulingQueueSnapshot,
} from "@/lib/clients/scheduling-queue-client";

// A5.2: the queue view names the task that holds a slot, and why. Rendered
// from the props the Run workspace gives it (the live snapshot and the
// session list); nothing is mocked.

function item(overrides: Partial<SchedulingQueueItem> = {}): SchedulingQueueItem {
  return {
    sessionId: "held-session",
    taskId: "held-task",
    runId: "held-run",
    workflowId: "research-workflow",
    state: "finishing",
    executionKind: "initial",
    source: "apply",
    requestedAt: "2026-07-14T11:58:00.000Z",
    ...overrides,
  };
}

function snapshotOf(
  status: SchedulingQueueSnapshot["status"],
  items: SchedulingQueueItem[],
): SchedulingQueueSnapshot {
  return {
    version: 1,
    status,
    maximumConcurrentTasks: 1,
    slotsInUse: 1,
    availableSlots: 0,
    waitingCount: 1,
    observedAt: "2026-07-14T12:00:00.000Z",
    items,
  };
}

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

function renderQueue(snapshot: SchedulingQueueSnapshot, onOpenSession = vi.fn()) {
  render(
    <QueueOverview
      error={null}
      loading={false}
      onOpenSession={onOpenSession}
      onOpenSettings={() => undefined}
      onRefresh={async () => undefined}
      sessions={[
        session("held-session", "Research launch"),
        session("waiting-session", "Delivery launch"),
      ]}
      snapshot={snapshot}
    />,
  );
  return onOpenSession;
}

const waiting = item({
  sessionId: "waiting-session",
  taskId: "waiting-task",
  workflowId: "delivery-workflow",
  state: "waiting",
});

it("names the task whose worker cannot be confirmed, why new work waits, and the process as a detail after them", async () => {
  const user = userEvent.setup();
  const onOpenSession = renderQueue(snapshotOf("blocked", [
    item({ hold: { reason: "unverified_live_process", blocksDispatch: true, processId: 4312 } }),
    waiting,
  ]));

  const alert = screen.getByRole("alert");
  const text = alert.textContent ?? "";
  expect(text).toContain("Research launch");
  expect(text).toContain("Research Workflow");
  expect(text).toContain(
    "Its recorded worker is still running but cannot be confirmed as this task's, so it is not stopped automatically. New work starts once it exits.",
  );
  expect(text).toContain("Process 4312");
  expect(text.indexOf("Research launch")).toBeLessThan(text.indexOf("cannot be confirmed"));
  expect(text.indexOf("cannot be confirmed")).toBeLessThan(text.indexOf("Process 4312"));
  expect(text).not.toContain("Delivery launch");

  await user.click(within(alert).getByRole("button", { name: "Open Research launch" }));
  expect(onOpenSession).toHaveBeenCalledWith("held-session");

  const finishing = screen.getByRole("heading", { name: "Finishing" }).closest("section");
  expect(finishing).not.toBeNull();
  expect(within(finishing!).getByText("Held")).toBeInTheDocument();
});

it("counts the process groups that carry a task's identity, as a detail", () => {
  renderQueue(snapshotOf("blocked", [
    item({ hold: { reason: "ambiguous_marker", blocksDispatch: true, processGroupCount: 2 } }),
    waiting,
  ]));

  const text = screen.getByRole("alert").textContent ?? "";
  expect(text).toContain(
    "More than one running process group carries this task's identity, so none of them is stopped automatically. New work starts once they exit.",
  );
  expect(text).toContain("2 process groups");
});

it("marks a wait held for its descendants as held, without saying dispatch is blocked", () => {
  renderQueue(snapshotOf("ready", [
    item({
      state: "starting",
      hold: {
        reason: "descendants_unverified_without_scope",
        blocksDispatch: false,
        since: "2026-07-14T11:59:00.000Z",
      },
    }),
  ]));

  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  const starting = screen.getByRole("heading", { name: "Starting" }).closest("section");
  expect(starting).not.toBeNull();
  expect(within(starting!).getByText("Held")).toBeInTheDocument();
  expect(
    within(starting!).getByText("Processes this task started may still be running; its slot stays in use until they stop."),
  ).toBeInTheDocument();
});

it("names only the tasks that block dispatch, not a wait held beside them for its descendants", () => {
  renderQueue(snapshotOf("blocked", [
    item({ hold: { reason: "unverified_live_process", blocksDispatch: true, processId: 4312 } }),
    item({
      sessionId: "waiting-session",
      taskId: "held-wait",
      workflowId: "delivery-workflow",
      state: "running",
      hold: {
        reason: "owned_processes_unverified",
        blocksDispatch: false,
        since: "2026-07-14T11:59:00.000Z",
      },
    }),
  ]));

  const alert = screen.getByRole("alert");
  expect(within(alert).getAllByRole("listitem").map((entry) => entry.textContent)).toEqual([
    expect.stringContaining("Research launch"),
  ]);
  const running = screen.getByRole("heading", { name: "Running" }).closest("section");
  expect(running).not.toBeNull();
  expect(within(running!).getByText("Held")).toBeInTheDocument();
});

it("shows no hold when no task holds a slot", () => {
  renderQueue(snapshotOf("ready", [item({ state: "running" }), waiting]));

  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByText("Held")).not.toBeInTheDocument();
});
