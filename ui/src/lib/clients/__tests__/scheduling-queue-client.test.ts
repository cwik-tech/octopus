import { afterEach, expect, it, vi } from "vitest";

import {
  fetchSchedulingQueue,
  SchedulingQueueClientError,
  type SchedulingQueueSnapshot,
} from "@/lib/clients/scheduling-queue-client";

const snapshot: SchedulingQueueSnapshot = {
  version: 1,
  status: "ready",
  maximumConcurrentTasks: 2,
  slotsInUse: 1,
  availableSlots: 1,
  waitingCount: 0,
  observedAt: "2026-07-14T12:00:00.000Z",
  items: [],
};

afterEach(() => vi.unstubAllGlobals());

it("loads the public queue snapshot with cancellation support", async () => {
  const fetchMock = vi.fn(async () => jsonResponse(snapshot));
  vi.stubGlobal("fetch", fetchMock);
  const controller = new AbortController();

  await expect(fetchSchedulingQueue(controller.signal)).resolves.toEqual(snapshot);
  expect(fetchMock).toHaveBeenCalledWith("/api/scheduling/queue", {
    signal: controller.signal,
  });
});

it("preserves stable queue error metadata", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse(
        {
          error: "Scheduling and Queue are unavailable.",
          code: "scheduling_unavailable",
          retryable: true,
        },
        503,
      ),
    ),
  );

  await expect(fetchSchedulingQueue()).rejects.toMatchObject({
    name: "SchedulingQueueClientError",
    message: "Scheduling and Queue are unavailable.",
    status: 503,
    code: "scheduling_unavailable",
    retryable: true,
  } satisfies Partial<SchedulingQueueClientError>);
});

const heldItem = {
  sessionId: "held-session",
  taskId: "held-task",
  runId: "held-run",
  workflowId: "research-workflow",
  state: "finishing",
  executionKind: "initial",
  source: "apply",
  requestedAt: "2026-07-14T11:58:00.000Z",
  hold: { reason: "unverified_live_process", blocksDispatch: true, processId: 4312 },
};

it("reads the reason a task holds its slot", async () => {
  const held = { ...snapshot, status: "blocked", items: [heldItem] };
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(held)));

  await expect(fetchSchedulingQueue()).resolves.toEqual(held);
});

// The item the queue serves for a continuation it has admitted: an answered
// question, an answered agent question, or an approved model choice
// (services/task-queue.ts, enqueueContinuation; the item copies the
// admission's source and execution kind).
it.each(["human_input", "agent_question", "model_choice"])(
  "reads a continuation the queue admitted from %s",
  async (source) => {
    const continuation = {
      ...snapshot,
      waitingCount: 1,
      items: [{
        sessionId: "answered-session",
        taskId: "answered-task",
        runId: "answered-run",
        workflowId: "research-workflow",
        state: "waiting",
        executionKind: "continuation",
        source,
        requestedAt: "2026-07-14T11:59:00.000Z",
      }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(continuation)));

    await expect(fetchSchedulingQueue()).resolves.toEqual(continuation);
  },
);

it.each([
  ["a hold with an unknown reason", { ...heldItem, hold: { reason: "unknown", blocksDispatch: true } }],
  ["a hold that does not say whether it blocks dispatch", { ...heldItem, hold: { reason: "ambiguous_marker" } }],
  ["a hold whose group count is not a number", { ...heldItem, hold: { reason: "ambiguous_marker", blocksDispatch: true, processGroupCount: "2" } }],
  ["an item with no task id", { ...heldItem, taskId: undefined }],
])("refuses a snapshot carrying %s", async (_label, item) => {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ...snapshot, items: [item] })));

  await expect(fetchSchedulingQueue()).rejects.toThrow("Invalid scheduling queue response");
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
