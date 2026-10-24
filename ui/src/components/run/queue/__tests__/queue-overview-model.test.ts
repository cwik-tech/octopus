import { expect, it } from "vitest";

import { buildQueueSessionSummaries } from "@/components/run/queue/queue-overview-model";
import type { SchedulingQueueSnapshot } from "@/lib/clients/scheduling-queue-client";

it("groups live tasks by session and orders the strongest state first", () => {
  const snapshot: SchedulingQueueSnapshot = {
    version: 1,
    status: "ready",
    maximumConcurrentTasks: 3,
    slotsInUse: 3,
    availableSlots: 0,
    waitingCount: 2,
    observedAt: "2026-07-14T12:00:00.000Z",
    items: [
      queueItem("session-running", "task-running", "running"),
      queueItem("session-starting", "task-starting", "starting"),
      queueItem("session-finishing", "task-finishing", "finishing"),
      queueItem("session-running", "task-waiting-same-session", "waiting"),
      queueItem("session-waiting", "task-waiting", "waiting"),
    ],
  };

  expect(buildQueueSessionSummaries(snapshot)).toEqual([
    {
      sessionId: "session-running",
      state: "running",
      taskCount: 2,
      firstQueueIndex: 0,
    },
    {
      sessionId: "session-starting",
      state: "starting",
      taskCount: 1,
      firstQueueIndex: 1,
    },
    {
      sessionId: "session-finishing",
      state: "finishing",
      taskCount: 1,
      firstQueueIndex: 2,
    },
    {
      sessionId: "session-waiting",
      state: "waiting",
      taskCount: 1,
      firstQueueIndex: 4,
    },
  ]);
});

function queueItem(
  sessionId: string,
  taskId: string,
  state: "waiting" | "starting" | "running" | "finishing",
) {
  return {
    sessionId,
    taskId,
    runId: `run-${taskId}`,
    workflowId: "test-workflow",
    state,
    executionKind: "initial" as const,
    source: "apply" as const,
    requestedAt: "2026-07-14T11:59:00.000Z",
  };
}
