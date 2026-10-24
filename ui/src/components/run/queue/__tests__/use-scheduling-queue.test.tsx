import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { useSchedulingQueue } from "@/components/run/queue/use-scheduling-queue";
import type { SchedulingQueueSnapshot } from "@/lib/clients/scheduling-queue-client";

const fetchSchedulingQueue = vi.hoisted(() => vi.fn());

vi.mock("@/lib/clients/scheduling-queue-client", () => ({ fetchSchedulingQueue }));

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

beforeEach(() => {
  vi.useFakeTimers();
  fetchSchedulingQueue.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

it("polls once per second without overlap and aborts when Run becomes inactive", async () => {
  const first = deferred<SchedulingQueueSnapshot>();
  const second = deferred<SchedulingQueueSnapshot>();
  fetchSchedulingQueue
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);

  const { rerender, result } = renderHook(
    ({ enabled }: { enabled: boolean }) => useSchedulingQueue(enabled),
    { initialProps: { enabled: true } },
  );

  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(fetchSchedulingQueue).toHaveBeenCalledTimes(1);

  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(fetchSchedulingQueue).toHaveBeenCalledTimes(1);

  await act(async () => first.resolve(snapshot));
  expect(result.current.snapshot).toEqual(snapshot);

  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(fetchSchedulingQueue).toHaveBeenCalledTimes(2);
  const secondSignal = fetchSchedulingQueue.mock.calls[1]?.[0] as AbortSignal;
  expect(secondSignal.aborted).toBe(false);

  rerender({ enabled: false });
  expect(secondSignal.aborted).toBe(true);
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
