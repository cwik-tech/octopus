import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BatchOverview } from "@/components/batch/batch-overview";
import type { BatchesState } from "@/components/batch/use-batches";

function makeState(): BatchesState {
  const execution = {
    id: "execution-1",
    batchId: "batch-1",
    status: "completed" as const,
    counts: {
      skipped: 0, pending: 0, preparing: 0, queued: 0, running: 0,
      recovering: 0, publishing: 0, done: 1, failed: 0, blocked: 0,
      cancelled: 0, setup_failed: 0, artifact_failed: 0,
    },
    retainedResultBytes: 2048,
    startedAt: "2026-08-06T10:00:00.000Z",
    updatedAt: "2026-08-06T10:02:00.000Z",
    completedAt: "2026-08-06T10:02:00.000Z",
  };
  return {
    batches: [{
      id: "batch-1",
      revision: 1,
      name: "Quarterly files",
      workflowId: "eligible-workflow",
      folderPath: "/external/files",
      fileExtensions: [".pdf"],
      rerunPolicy: "new_and_changed",
      createdAt: "2026-08-06T09:00:00.000Z",
      updatedAt: "2026-08-06T09:00:00.000Z",
      latestExecution: execution,
    }],
    executionDetails: {
      "execution-1": {
        execution,
        items: [{
          id: "item-1",
          ordinal: 0,
          fileName: "report.pdf",
          sourceSize: 123,
          sourceMtime: "2026-08-06T09:00:00.000Z",
          sourceSha256: "a".repeat(64),
          status: "done",
          sessionId: "session-1",
          resultArtifacts: [{
            role: "final",
            sourceRunId: "run-1",
            sourcePath: "report.docx",
            byteLength: 20,
            sha256: "b".repeat(64),
          }],
          createdAt: "2026-08-06T10:00:00.000Z",
          updatedAt: "2026-08-06T10:02:00.000Z",
        }],
      },
    },
    loading: false,
    error: null,
    refresh: vi.fn(async () => undefined),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(async () => undefined),
    preflight: vi.fn(async () => ({
      canonicalFolderPath: "/external/files",
      fileCount: 11,
      selectedCount: 11,
      totalBytes: 1024,
      extensionCounts: { ".pdf": 11 },
      requiresConfirmation: true,
      sourceSnapshotSha256: "c".repeat(64),
      files: [],
    })),
    runNow: vi.fn(async () => ({ executionId: "execution-2" })),
    cancel: vi.fn(),
    clearResults: vi.fn(async () => undefined),
    loadExecution: vi.fn(async () => undefined),
    loadMoreItems: vi.fn(async () => undefined),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("BatchOverview", () => {
  it("confirms a large preflight before running and exposes retained results", async () => {
    const user = userEvent.setup();
    const state = makeState();
    render(<BatchOverview state={state} onEdit={() => undefined} onNew={() => undefined} onOpenSession={() => undefined} />);

    expect(screen.getByText("2.0 KB retained")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open session for report.pdf" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download final result for report.pdf" })).toHaveAttribute("href", expect.stringContaining("/artifacts/0"));
    await user.click(screen.getByRole("button", { name: "Run Quarterly files" }));
    expect(await screen.findByRole("heading", { name: "Run 11 files?" })).toBeInTheDocument();
    expect(state.runNow).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Run Batch" }));
    await waitFor(() => expect(state.runNow).toHaveBeenCalledWith("batch-1"));
  });

  it("warns separately before clearing copied results and deleting rerun history", async () => {
    const user = userEvent.setup();
    const state = makeState();
    render(<BatchOverview state={state} onEdit={() => undefined} onNew={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "Clear copied results for Quarterly files" }));
    expect(screen.getByText(/journals, rerun history, sessions, and original run artifacts stay/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear copied results" }));
    await waitFor(() => expect(state.clearResults).toHaveBeenCalledWith("batch-1", "execution-1"));

    await user.click(screen.getByRole("button", { name: "Delete Quarterly files" }));
    expect(screen.getByText(/may repeat paid work/i)).toBeInTheDocument();
  });

  it("replaces cleared artifact downloads with a distinct cleared state", () => {
    const state = makeState();
    const clearedAt = "2026-08-06T10:03:00.000Z";
    state.batches[0] = {
      ...state.batches[0]!,
      latestExecution: {
        ...state.batches[0]!.latestExecution!,
        retainedResultBytes: 0,
        resultsClearedAt: clearedAt,
      },
    };
    state.executionDetails["execution-1"] = {
      ...state.executionDetails["execution-1"]!,
      execution: {
        ...state.executionDetails["execution-1"]!.execution,
        retainedResultBytes: 0,
        resultsClearedAt: clearedAt,
      },
    };

    render(<BatchOverview state={state} onEdit={() => undefined} onNew={() => undefined} />);

    expect(screen.queryByRole("link", { name: "Download final result for report.pdf" })).not.toBeInTheDocument();
    expect(screen.getByText(/copied result cleared/i)).toBeInTheDocument();
  });

  it("keeps every Batch action disabled while that Batch has an in-flight action", async () => {
    const user = userEvent.setup();
    const state = makeState();
    const firstPreflight = deferred<Awaited<ReturnType<BatchesState["preflight"]>>>();
    const secondPreflight = deferred<Awaited<ReturnType<BatchesState["preflight"]>>>();
    const secondExecution = {
      ...state.batches[0]!.latestExecution!,
      id: "execution-2",
      batchId: "batch-2",
    };
    state.batches.push({
      ...state.batches[0]!,
      id: "batch-2",
      name: "Annual files",
      latestExecution: secondExecution,
    });
    state.executionDetails[secondExecution.id] = {
      ...state.executionDetails["execution-1"]!,
      execution: secondExecution,
    };
    state.preflight = vi.fn((batchId: string) =>
      batchId === "batch-1" ? firstPreflight.promise : secondPreflight.promise,
    );

    render(<BatchOverview state={state} onEdit={() => undefined} onNew={() => undefined} />);
    const firstRun = screen.getByRole("button", { name: "Run Quarterly files" });
    const secondRun = screen.getByRole("button", { name: "Run Annual files" });

    await user.click(firstRun);
    await user.click(secondRun);

    expect(firstRun).toBeDisabled();
    expect(secondRun).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit Quarterly files" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Quarterly files" })).toBeDisabled();

    firstPreflight.resolve({
      canonicalFolderPath: "/external/files",
      fileCount: 0,
      selectedCount: 0,
      totalBytes: 0,
      extensionCounts: {},
      requiresConfirmation: false,
      sourceSnapshotSha256: "d".repeat(64),
      files: [],
    });
    secondPreflight.resolve({
      canonicalFolderPath: "/external/files",
      fileCount: 0,
      selectedCount: 0,
      totalBytes: 0,
      extensionCounts: {},
      requiresConfirmation: false,
      sourceSnapshotSha256: "e".repeat(64),
      files: [],
    });
    await waitFor(() => expect(firstRun).not.toBeDisabled());
  });

  it("formats multi-gigabyte retained results in GB", () => {
    const state = makeState();
    state.batches[0] = {
      ...state.batches[0]!,
      latestExecution: {
        ...state.batches[0]!.latestExecution!,
        retainedResultBytes: 5 * 1024 * 1024 * 1024,
      },
    };

    render(<BatchOverview state={state} onEdit={() => undefined} onNew={() => undefined} />);

    expect(screen.getByText("5.0 GB retained")).toBeInTheDocument();
  });

  it("labels a mixed terminal Batch as partially completed", () => {
    const state = makeState();
    state.batches[0] = {
      ...state.batches[0]!,
      latestExecution: {
        ...state.batches[0]!.latestExecution!,
        status: "partially_completed",
        counts: {
          ...state.batches[0]!.latestExecution!.counts,
          blocked: 1,
        },
      },
    };

    render(<BatchOverview state={state} onEdit={() => undefined} onNew={() => undefined} />);

    expect(screen.getByText("Partially completed")).toBeInTheDocument();
  });
});
