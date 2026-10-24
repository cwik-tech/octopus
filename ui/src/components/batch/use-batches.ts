import { useCallback, useEffect, useRef, useState } from "react";

import type {
  BatchDefinitionInput,
  BatchExecutionItemPage,
  BatchPatch,
  BatchPreflight,
  BatchView,
} from "@contracts/batches";
import {
  cancelBatchExecution,
  clearBatchExecutionResults,
  createBatch,
  deleteBatch,
  getBatchExecution,
  listBatches,
  preflightBatch,
  runBatchNow,
  updateBatch,
} from "@/lib/clients/batches-client";

const REFRESH_INTERVAL_MS = 10_000;

export interface BatchesState {
  batches: BatchView[];
  executionDetails: Record<string, BatchExecutionItemPage | undefined>;
  loadingMoreExecutionIds?: ReadonlySet<string>;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  create(input: BatchDefinitionInput): Promise<BatchView>;
  update(id: string, input: BatchDefinitionInput): Promise<BatchView>;
  remove(id: string): Promise<void>;
  preflight(id: string): Promise<BatchPreflight>;
  runNow(id: string): Promise<{ executionId: string }>;
  cancel(batchId: string, executionId: string): Promise<void>;
  clearResults(batchId: string, executionId: string): Promise<void>;
  loadExecution(batchId: string, executionId: string): Promise<void>;
  loadMoreItems(batchId: string, executionId: string): Promise<void>;
}

export function useBatches(enabled: boolean): BatchesState {
  const [batches, setBatches] = useState<BatchView[]>([]);
  const [executionDetails, setExecutionDetails] = useState<Record<string, BatchExecutionItemPage | undefined>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingMoreExecutionIds, setLoadingMoreExecutionIds] = useState<ReadonlySet<string>>(() => new Set());
  const controller = useRef<AbortController | null>(null);
  const refreshPromise = useRef<Promise<void> | null>(null);
  const executionDetailsRef = useRef<Record<string, BatchExecutionItemPage | undefined>>({});
  const executionLoads = useRef(new Map<string, Promise<void>>());
  const executionLoadFailures = useRef(new Set<string>());
  const executionControllers = useRef(new Map<string, AbortController>());
  const loadMoreOperations = useRef(new Map<string, Promise<void>>());

  const updateExecutionDetails = useCallback((
    update: (current: Record<string, BatchExecutionItemPage | undefined>) => Record<string, BatchExecutionItemPage | undefined>,
  ) => {
    setExecutionDetails((current) => {
      const next = update(current);
      executionDetailsRef.current = next;
      return next;
    });
  }, []);

  const abortExecutionRequests = useCallback(() => {
    for (const activeController of executionControllers.current.values()) activeController.abort();
    executionControllers.current.clear();
    executionLoads.current.clear();
    loadMoreOperations.current.clear();
  }, []);

  const refresh = useCallback(async () => {
    if (refreshPromise.current) return refreshPromise.current;
    setLoading(true);
    const nextController = new AbortController();
    controller.current = nextController;
    const request = listBatches(nextController.signal)
      .then((next) => {
        if (!nextController.signal.aborted) {
          setBatches(next);
          setError(null);
        }
      })
      .catch((requestError: unknown) => {
        if (!nextController.signal.aborted) setError(message(requestError));
      })
      .finally(() => {
        if (controller.current === nextController) controller.current = null;
        if (refreshPromise.current === request) refreshPromise.current = null;
        if (!nextController.signal.aborted) setLoading(false);
      });
    refreshPromise.current = request;
    return request;
  }, []);

  useEffect(() => {
    if (!enabled) {
      controller.current?.abort();
      abortExecutionRequests();
      controller.current = null;
      refreshPromise.current = null;
      return;
    }
    const initial = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      controller.current?.abort();
      abortExecutionRequests();
      controller.current = null;
      refreshPromise.current = null;
    };
  }, [abortExecutionRequests, enabled, refresh]);

  const create = useCallback(async (input: BatchDefinitionInput) => {
    const created = await createBatch(input);
    setBatches((current) => [...current, created]);
    return created;
  }, []);
  const update = useCallback(async (id: string, input: BatchDefinitionInput) => {
    const current = batches.find((batch) => batch.id === id);
    if (!current) throw new Error("Batch is no longer available.");
    const patch: BatchPatch = {
      ...input,
      expectedRevision: current.revision,
      projectId: input.projectId ?? null,
    };
    const updated = await updateBatch(id, patch);
    setBatches((entries) => entries.map((entry) => entry.id === id ? updated : entry));
    return updated;
  }, [batches]);
  const remove = useCallback(async (id: string) => {
    await deleteBatch(id);
    setBatches((current) => current.filter((batch) => batch.id !== id));
  }, []);
  const preflight = useCallback((id: string) => preflightBatch(id), []);
  const runNow = useCallback(async (id: string) => {
    const result = await runBatchNow(id);
    void refresh();
    return result;
  }, [refresh]);
  const cancel = useCallback(async (batchId: string, executionId: string) => {
    await cancelBatchExecution(batchId, executionId);
    void refresh();
  }, [refresh]);
  const clearResults = useCallback(async (batchId: string, executionId: string) => {
    await clearBatchExecutionResults(batchId, executionId);
    updateExecutionDetails((current) => {
      const detail = current[executionId];
      return detail ? {
        ...current,
        [executionId]: {
          ...detail,
          execution: { ...detail.execution, retainedResultBytes: 0, resultsClearedAt: new Date().toISOString() },
        },
      } : current;
    });
    void refresh();
  }, [refresh, updateExecutionDetails]);
  const loadExecution = useCallback((batchId: string, executionId: string): Promise<void> => {
    if (executionLoadFailures.current.has(executionId)) return Promise.resolve();
    const existingOperation = executionLoads.current.get(executionId);
    if (existingOperation) return existingOperation;
    const nextController = new AbortController();
    executionControllers.current.set(executionId, nextController);
    const operation = getBatchExecution(batchId, executionId, undefined, nextController.signal)
      .then((detail) => {
        if (!nextController.signal.aborted) {
          updateExecutionDetails((current) => ({ ...current, [executionId]: detail }));
        }
      })
      .catch((loadError: unknown) => {
        if (nextController.signal.aborted) return;
        if (isHttpStatus(loadError, 404)) {
          executionLoadFailures.current.add(executionId);
        }
        setError(message(loadError));
      })
      .finally(() => {
        if (executionControllers.current.get(executionId) === nextController) {
          executionControllers.current.delete(executionId);
        }
        if (executionLoads.current.get(executionId) === operation) {
          executionLoads.current.delete(executionId);
        }
      });
    executionLoads.current.set(executionId, operation);
    return operation;
  }, [updateExecutionDetails]);
  const loadMoreItems = useCallback((batchId: string, executionId: string): Promise<void> => {
    const existing = executionDetailsRef.current[executionId];
    if (!existing?.nextCursor) return Promise.resolve();
    const requestKey = `${executionId}:${existing.nextCursor}`;
    const existingOperation = loadMoreOperations.current.get(requestKey);
    if (existingOperation) return existingOperation;
    const nextController = new AbortController();
    executionControllers.current.set(requestKey, nextController);
    setLoadingMoreExecutionIds((current) => new Set(current).add(executionId));
    const operation = getBatchExecution(batchId, executionId, existing.nextCursor, nextController.signal)
      .then((page) => {
        if (nextController.signal.aborted) return;
        updateExecutionDetails((current) => {
          const latest = current[executionId];
          if (!latest || latest.nextCursor !== existing.nextCursor) return current;
          const seen = new Set(latest.items.map((item) => item.id));
          const nextItems = page.items.filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
          });
          return {
            ...current,
            [executionId]: { ...page, items: [...latest.items, ...nextItems] },
          };
        });
      })
      .catch((loadError: unknown) => {
        if (!nextController.signal.aborted) setError(message(loadError));
      })
      .finally(() => {
        if (executionControllers.current.get(requestKey) === nextController) {
          executionControllers.current.delete(requestKey);
        }
        loadMoreOperations.current.delete(requestKey);
        setLoadingMoreExecutionIds((current) => {
          const next = new Set(current);
          next.delete(executionId);
          return next;
        });
      });
    loadMoreOperations.current.set(requestKey, operation);
    return operation;
  }, [updateExecutionDetails]);

  return { batches, executionDetails, loadingMoreExecutionIds, loading, error, refresh, create, update, remove, preflight, runNow, cancel, clearResults, loadExecution, loadMoreItems };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Batches could not be loaded.";
}

function isHttpStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === status;
}
