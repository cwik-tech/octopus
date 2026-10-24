import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cancelBatchExecution,
  getBatchExecution,
  listBatches,
} from "@/lib/clients/batches-client";

afterEach(() => vi.unstubAllGlobals());

const NO_ITEMS = Object.fromEntries(
  [
    "skipped",
    "pending",
    "preparing",
    "queued",
    "running",
    "recovering",
    "publishing",
    "done",
    "failed",
    "blocked",
    "cancelled",
    "setup_failed",
    "artifact_failed",
  ].map((status) => [status, 0]),
);

describe("batches-client", () => {
  it("rejects a successful response that violates the Batch wire contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      batches: [{ id: 42, name: "Invalid" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    await expect(listBatches()).rejects.toThrow(/invalid Batch response/i);
  });

  it("preserves the distinct internal Batch error code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "Batch request failed.",
      code: "internal_batch_error",
    }), {
      status: 500,
      statusText: "Internal Server Error",
      headers: { "content-type": "application/json" },
    })));

    await expect(listBatches()).rejects.toMatchObject({
      status: 500,
      code: "internal_batch_error",
    });
  });

  // The server leaves optional fields out rather than sending them empty.
  it("lists a Batch in no project whose run has not finished", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      batches: [{
        id: "batch-1",
        revision: 1,
        name: "Two pitch decks",
        workflowId: "pitch-deck-evaluation",
        folderPath: "/tmp/pitch-decks",
        fileExtensions: ["pdf"],
        rerunPolicy: "new_only",
        createdAt: "2026-09-11T00:00:00.000Z",
        updatedAt: "2026-09-11T00:00:00.000Z",
        latestExecution: {
          id: "execution-1",
          batchId: "batch-1",
          status: "running",
          counts: NO_ITEMS,
          retainedResultBytes: 0,
          startedAt: "2026-09-11T00:00:01.000Z",
          updatedAt: "2026-09-11T00:00:02.000Z",
        },
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    const [batch] = await listBatches();

    expect(batch?.name).toBe("Two pitch decks");
    expect(batch?.projectId).toBeUndefined();
    expect(batch?.latestExecution?.completedAt).toBeUndefined();
    expect(batch?.latestExecution?.resultsClearedAt).toBeUndefined();
  });

  it("accepts a cancel response that carries no cancel time", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      executionId: "execution-1",
      status: "draining",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    await expect(cancelBatchExecution("batch-1", "execution-1")).resolves.toBeUndefined();
  });
});

describe("batches-client abort signal", () => {
  function okJson(body: unknown): Promise<Response> {
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  }

  const EXECUTION_PAGE = {
    execution: {
      id: "execution-1",
      batchId: "batch-1",
      status: "running",
      counts: NO_ITEMS,
      retainedResultBytes: 0,
      startedAt: "2026-09-11T00:00:01.000Z",
      updatedAt: "2026-09-11T00:00:02.000Z",
    },
    items: [],
  };

  it("hands the caller's abort signal to fetch when listing Batches", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => okJson({ batches: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await expect(listBatches(controller.signal)).resolves.toStrictEqual([]);

    expect(fetchMock.mock.lastCall?.[0]).toBe("/api/batches");
    expect(fetchMock.mock.lastCall?.[1]?.signal).toBe(controller.signal);
  });

  it("lists Batches when the caller passes no abort signal", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => okJson({ batches: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listBatches()).resolves.toStrictEqual([]);

    expect(fetchMock.mock.lastCall?.[0]).toBe("/api/batches");
  });

  it("hands the caller's abort signal to fetch when reading a Batch execution page", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => okJson(EXECUTION_PAGE));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await expect(
      getBatchExecution("batch-1", "execution-1", "cursor-2", controller.signal),
    ).resolves.toStrictEqual({
      execution: {
        id: "execution-1",
        batchId: "batch-1",
        status: "running",
        counts: NO_ITEMS,
        retainedResultBytes: 0,
        startedAt: "2026-09-11T00:00:01.000Z",
        updatedAt: "2026-09-11T00:00:02.000Z",
      },
      items: [],
    });

    expect(fetchMock.mock.lastCall?.[0]).toBe(
      "/api/batches/batch-1/executions/execution-1?cursor=cursor-2",
    );
    expect(fetchMock.mock.lastCall?.[1]?.signal).toBe(controller.signal);
  });

  it("reads a Batch execution page when the caller passes no abort signal", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => okJson(EXECUTION_PAGE));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getBatchExecution("batch-1", "execution-1")).resolves.toMatchObject({
      execution: { id: "execution-1", batchId: "batch-1" },
      items: [],
    });

    expect(fetchMock.mock.lastCall?.[0]).toBe("/api/batches/batch-1/executions/execution-1");
  });
});
