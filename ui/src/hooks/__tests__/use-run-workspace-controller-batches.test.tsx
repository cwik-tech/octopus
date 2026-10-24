import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { useBatches } from "@/components/batch/use-batches";

const listBatches = vi.hoisted(() => vi.fn(async () => []));
const getBatchExecution = vi.hoisted(() => vi.fn());

vi.mock("@/lib/clients/batches-client", () => ({
  listBatches,
  createBatch: vi.fn(), updateBatch: vi.fn(), deleteBatch: vi.fn(),
  preflightBatch: vi.fn(), runBatchNow: vi.fn(), cancelBatchExecution: vi.fn(),
  clearBatchExecutionResults: vi.fn(), getBatchExecution,
}));

beforeEach(() => {
  vi.useFakeTimers();
  listBatches.mockReset();
  listBatches.mockResolvedValue([]);
  getBatchExecution.mockReset();
});

afterEach(() => vi.useRealTimers());

it("starts Batch polling only while the Run tab is enabled", async () => {
  const { rerender } = renderHook(({ enabled }) => useBatches(enabled), {
    initialProps: { enabled: false },
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(listBatches).not.toHaveBeenCalled();

  rerender({ enabled: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(listBatches).toHaveBeenCalledTimes(1);

  rerender({ enabled: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(listBatches).toHaveBeenCalledTimes(1);
});

it("aborts an in-flight Batch poll when the Run tab is disabled", async () => {
  let observedSignal: AbortSignal | undefined;
  listBatches.mockImplementation((signal?: AbortSignal) => {
    observedSignal = signal;
    return new Promise(() => undefined);
  });
  const { rerender } = renderHook(({ enabled }) => useBatches(enabled), {
    initialProps: { enabled: true },
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });

  rerender({ enabled: false });

  expect(observedSignal?.aborted).toBe(true);
});

it("shows loading during a manual refresh", async () => {
  const { result } = renderHook(() => useBatches(true));
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(result.current.loading).toBe(false);
  let release!: (value: never[]) => void;
  listBatches.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));

  let refresh!: Promise<void>;
  act(() => { refresh = result.current.refresh(); });

  expect(result.current.loading).toBe(true);
  await act(async () => { release([]); await refresh; });
});

it("joins concurrent item-page requests and appends each item once", async () => {
  getBatchExecution.mockResolvedValueOnce({
    execution: { id: "execution-1" },
    items: [{ id: "item-1" }],
    nextCursor: "cursor-1",
  });
  let releasePage!: (value: unknown) => void;
  getBatchExecution.mockImplementationOnce(() => new Promise((resolve) => { releasePage = resolve; }));
  const { result } = renderHook(() => useBatches(false));
  await act(async () => { await result.current.loadExecution("batch-1", "execution-1"); });

  let first!: Promise<void>;
  let second!: Promise<void>;
  act(() => {
    first = result.current.loadMoreItems("batch-1", "execution-1");
    second = result.current.loadMoreItems("batch-1", "execution-1");
  });

  expect(getBatchExecution).toHaveBeenCalledTimes(2);
  await act(async () => {
    releasePage({
      execution: { id: "execution-1" },
      items: [{ id: "item-2" }, { id: "item-2" }],
    });
    await Promise.all([first, second]);
  });
  expect(result.current.executionDetails["execution-1"]?.items.map((item) => item.id)).toEqual([
    "item-1",
    "item-2",
  ]);
});

it("records a missing execution without rejecting or retrying it", async () => {
  getBatchExecution.mockRejectedValue(Object.assign(new Error("Missing"), { status: 404 }));
  const { result } = renderHook(() => useBatches(false));

  await act(async () => {
    await expect(result.current.loadExecution("batch-1", "execution-1")).resolves.toBeUndefined();
    await expect(result.current.loadExecution("batch-1", "execution-1")).resolves.toBeUndefined();
  });

  expect(getBatchExecution).toHaveBeenCalledTimes(1);
});

it("retries an execution detail after a transient load failure", async () => {
  getBatchExecution
    .mockRejectedValueOnce(Object.assign(new Error("Unavailable"), { status: 503 }))
    .mockResolvedValueOnce({
      execution: { id: "execution-1" },
      items: [],
    });
  const { result } = renderHook(() => useBatches(false));

  await act(async () => {
    await result.current.loadExecution("batch-1", "execution-1");
    await result.current.loadExecution("batch-1", "execution-1");
  });

  expect(getBatchExecution).toHaveBeenCalledTimes(2);
  expect(result.current.executionDetails["execution-1"]?.execution.id).toBe("execution-1");
});
