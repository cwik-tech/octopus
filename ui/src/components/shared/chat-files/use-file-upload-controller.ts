import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { FileUploadApi } from "@/components/shared/file-upload";
import type { SessionFile } from "@/lib/models/session-model";

export type FileTimelineItemState = "uploading" | "current" | "error";

/**
 * Display-only projection of a file record (or an in-flight upload attempt).
 * Never sent back through a chat API; chat messages remain the only
 * conversation truth.
 */
export type FileTimelineItem = {
  key: string;
  ownerId: string;
  filename: string;
  size: number;
  occurredAt: string;
  state: FileTimelineItemState;
  file?: SessionFile | undefined;
  error?: string;
  retryFile?: File;
};

export const authoritativeFileItemKey = (
  ownerId: string,
  file: SessionFile,
): string => `file:${ownerId}:${file.name}:${file.uploadedAt}`;

const optimisticFileItemKey = (ownerId: string, attemptId: string): string =>
  `attempt:${ownerId}:${attemptId}`;

export const toFileTimelineItem = (
  ownerId: string,
  file: SessionFile,
): FileTimelineItem => ({
  key: authoritativeFileItemKey(ownerId, file),
  ownerId,
  filename: file.name,
  size: file.size,
  occurredAt: file.uploadedAt,
  state: "current",
  file,
});

export interface FileUploadControllerOptions {
  /** Nullable: the controller is inactive while no owner is selected. */
  ownerId: string | null;
  api: FileUploadApi;
  /** Poll cadence while an authoritative file reports pending/parsing. */
  pollIntervalMs?: number;
}

export interface FileUploadController {
  /** Authoritative current files plus optimistic attempts, sorted by time. */
  items: FileTimelineItem[];
  /** Authoritative files only — the data behind the icon row. */
  currentFiles: SessionFile[];
  loading: boolean;
  uploading: boolean;
  error: string | null;
  upload: (files: File[] | FileList) => Promise<void>;
  retry: (key: string) => Promise<void>;
  dismiss: (key: string) => void;
  remove: (filename: string) => Promise<boolean>;
  /** Waits for deletions, then locally freezes files for the submitted turn. */
  prepareForSubmit: () => Promise<boolean>;
  refresh: () => Promise<void>;
  clearError: () => void;
  reportError: (message: string) => void;
}

interface UploadBatch {
  remaining: number;
  settled: boolean;
  needsRefresh: boolean;
  resolve: () => void;
}

interface UploadJob {
  file: File;
  attempt: FileTimelineItem;
  batch: UploadBatch;
}

interface OwnerGeneration {
  id: number;
  ownerId: string;
  api: FileUploadApi;
  active: boolean;
  draining: boolean;
  refreshRequestId: number;
  queue: UploadJob[];
  inFlight: UploadJob | null;
}

interface PendingDelete {
  generation: OwnerGeneration;
  promise: Promise<boolean>;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const finishBatchJob = (batch: UploadBatch): boolean => {
  if (batch.settled) return false;
  batch.remaining -= 1;
  return batch.remaining === 0;
};

const settleBatch = (batch: UploadBatch): void => {
  if (batch.settled) return;
  batch.settled = true;
  batch.resolve();
};

const cancelGeneration = (generation: OwnerGeneration | null): void => {
  if (!generation) return;
  generation.active = false;
  const batches = new Set<UploadBatch>();
  if (generation.inFlight) batches.add(generation.inFlight.batch);
  for (const job of generation.queue) batches.add(job.batch);
  generation.queue = [];
  for (const batch of batches) {
    if (batch.settled) continue;
    batch.settled = true;
    batch.resolve();
  }
};

export function useFileUploadController({
  ownerId,
  api,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: FileUploadControllerOptions): FileUploadController {
  const [files, setFiles] = useState<SessionFile[]>([]);
  const [authoritativeItems, setAuthoritativeItems] = useState<
    FileTimelineItem[]
  >([]);
  const [attempts, setAttempts] = useState<FileTimelineItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filesRef = useRef<SessionFile[]>([]);
  const attemptsRef = useRef<FileTimelineItem[]>([]);
  const generationCounterRef = useRef(0);
  const generationRef = useRef<OwnerGeneration | null>(null);
  const attemptCounterRef = useRef(0);
  const attemptRevisionBeforeRef = useRef(new Map<string, string | null>());
  const pendingDeletesRef = useRef(new Set<PendingDelete>());

  const commitFiles = useCallback(
    (next: SessionFile[]) => {
      filesRef.current = next;
      setFiles(next);
      setAuthoritativeItems((current) => {
        if (!ownerId) return [];
        const currentByKey = new Map(current.map((item) => [item.key, item]));
        const nextItems = next.map((file) => {
          const key = authoritativeFileItemKey(ownerId, file);
          const cached = currentByKey.get(key);
          return cached?.file &&
            JSON.stringify(cached.file) === JSON.stringify(file)
            ? cached
            : toFileTimelineItem(ownerId, file);
        });
        return nextItems.length === current.length &&
          nextItems.every((item, index) => item === current[index])
          ? current
          : nextItems;
      });
    },
    [ownerId],
  );

  const updateAttempts = useCallback(
    (
      update:
        | FileTimelineItem[]
        | ((current: FileTimelineItem[]) => FileTimelineItem[]),
    ) => {
      const next =
        typeof update === "function" ? update(attemptsRef.current) : update;
      attemptsRef.current = next;
      setAttempts(next);
    },
    [],
  );

  const isCurrentGeneration = useCallback(
    (generation: OwnerGeneration): boolean =>
      generation.active && generationRef.current === generation,
    [],
  );

  const reconcileMaterializedAttempts = useCallback(
    (nextFiles: SessionFile[]) => {
      updateAttempts((current) =>
        current.filter((attempt) => {
          if (!attemptRevisionBeforeRef.current.has(attempt.key)) return true;
          const revisionBefore =
            attemptRevisionBeforeRef.current.get(attempt.key) ?? null;
          const revisionAfter =
            nextFiles.find((file) => file.name === attempt.filename)
              ?.uploadedAt ?? null;
          const materialized =
            revisionAfter !== null && revisionAfter !== revisionBefore;
          if (materialized) {
            attemptRevisionBeforeRef.current.delete(attempt.key);
          }
          return !materialized;
        }),
      );
    },
    [updateAttempts],
  );

  const refreshGeneration = useCallback(
    async (generation: OwnerGeneration): Promise<SessionFile[] | null> => {
      const requestId = ++generation.refreshRequestId;
      try {
        const next = await generation.api.list(generation.ownerId);
        if (
          !isCurrentGeneration(generation) ||
          requestId !== generation.refreshRequestId
        ) {
          return null;
        }
        commitFiles(next);
        reconcileMaterializedAttempts(next);
        setError(null);
        return next;
      } catch (err) {
        if (
          !isCurrentGeneration(generation) ||
          requestId !== generation.refreshRequestId
        ) {
          return null;
        }
        setError(errorMessage(err));
        return null;
      }
    },
    [commitFiles, isCurrentGeneration, reconcileMaterializedAttempts],
  );

  const drainGeneration = useCallback(
    async (generation: OwnerGeneration): Promise<void> => {
      if (!generation.active || generation.draining) return;
      generation.draining = true;
      if (isCurrentGeneration(generation)) setUploading(true);
      try {
        while (generation.active && generation.queue.length > 0) {
          const job = generation.queue.shift();
          if (!job) continue;
          generation.inFlight = job;
          const revisionBefore =
            filesRef.current.find((entry) => entry.name === job.file.name)
              ?.uploadedAt ?? null;
          attemptRevisionBeforeRef.current.set(job.attempt.key, revisionBefore);
          try {
            const uploaded = await generation.api.upload(
              generation.ownerId,
              job.file,
            );
            if (!isCurrentGeneration(generation)) continue;
            attemptRevisionBeforeRef.current.delete(job.attempt.key);
            updateAttempts((current) =>
              current.filter((attempt) => attempt.key !== job.attempt.key),
            );
            commitFiles([
              ...filesRef.current.filter(
                (entry) => entry.name !== uploaded.name,
              ),
              uploaded,
            ]);
            job.batch.needsRefresh = true;
          } catch (err) {
            if (!isCurrentGeneration(generation)) continue;
            const refreshed = await refreshGeneration(generation);
            if (refreshed) job.batch.needsRefresh = false;
            if (!isCurrentGeneration(generation)) continue;
            updateAttempts((current) =>
              current.map((attempt) =>
                attempt.key === job.attempt.key
                  ? {
                      ...attempt,
                      state: "error",
                      error: errorMessage(err),
                    }
                  : attempt,
              ),
            );
          } finally {
            const batchFinished = finishBatchJob(job.batch);
            if (
              batchFinished &&
              job.batch.needsRefresh &&
              isCurrentGeneration(generation)
            ) {
              await refreshGeneration(generation);
              job.batch.needsRefresh = false;
            }
            if (batchFinished) settleBatch(job.batch);
            generation.inFlight = null;
          }
        }
      } finally {
        generation.draining = false;
        if (isCurrentGeneration(generation)) {
          setUploading(generation.queue.length > 0);
          if (generation.queue.length > 0) {
            void drainGeneration(generation);
          }
        }
      }
    },
    [commitFiles, isCurrentGeneration, refreshGeneration, updateAttempts],
  );

  // Owner (or API) change creates an isolated generation. Late completions
  // cannot mutate or unlock the replacement owner's queue.
  useEffect(() => {
    cancelGeneration(generationRef.current);
    generationCounterRef.current += 1;
    attemptRevisionBeforeRef.current.clear();
    const generation = ownerId
      ? {
          id: generationCounterRef.current,
          ownerId,
          api,
          active: true,
          draining: false,
          refreshRequestId: 0,
          queue: [],
          inFlight: null,
        }
      : null;
    generationRef.current = generation;
    filesRef.current = [];
    attemptsRef.current = [];
    startTransition(() => {
      setAttempts([]);
      setFiles([]);
      setAuthoritativeItems([]);
      setError(null);
      setUploading(false);
      setLoading(Boolean(generation));
    });
    if (!generation) return;
    void refreshGeneration(generation).finally(() => {
      if (isCurrentGeneration(generation)) setLoading(false);
    });
    return () => cancelGeneration(generation);
  }, [api, isCurrentGeneration, ownerId, refreshGeneration]);

  const upload = useCallback(
    (incoming: File[] | FileList): Promise<void> => {
      const generation = generationRef.current;
      const list = Array.from(incoming);
      if (!generation || !isCurrentGeneration(generation) || list.length === 0) {
        return Promise.resolve();
      }

      let resolveBatch!: () => void;
      const promise = new Promise<void>((resolve) => {
        resolveBatch = resolve;
      });
      const batch: UploadBatch = {
        remaining: list.length,
        settled: false,
        needsRefresh: false,
        resolve: resolveBatch,
      };
      const jobs = list.map((file) => {
        attemptCounterRef.current += 1;
        const attempt: FileTimelineItem = {
          key: optimisticFileItemKey(
            generation.ownerId,
            String(attemptCounterRef.current),
          ),
          ownerId: generation.ownerId,
          filename: file.name,
          size: file.size,
          occurredAt: new Date().toISOString(),
          state: "uploading",
          retryFile: file,
        };
        return { file, attempt, batch };
      });
      updateAttempts((current) => [
        ...current,
        ...jobs.map((job) => job.attempt),
      ]);
      generation.queue.push(...jobs);
      setUploading(true);
      void drainGeneration(generation);
      return promise;
    },
    [drainGeneration, isCurrentGeneration, updateAttempts],
  );

  const retry = useCallback(
    async (key: string) => {
      const attempt = attemptsRef.current.find((item) => item.key === key);
      if (!attempt?.retryFile || attempt.state !== "error") return;
      attemptRevisionBeforeRef.current.delete(key);
      updateAttempts((current) =>
        current.filter((item) => item.key !== key),
      );
      await upload([attempt.retryFile]);
    },
    [updateAttempts, upload],
  );

  const dismiss = useCallback(
    (key: string) => {
      attemptRevisionBeforeRef.current.delete(key);
      updateAttempts((current) =>
        current.filter((attempt) => attempt.key !== key),
      );
    },
    [updateAttempts],
  );

  const remove = useCallback(
    (filename: string): Promise<boolean> => {
      const generation = generationRef.current;
      if (!generation || !isCurrentGeneration(generation)) {
        return Promise.resolve(false);
      }
      const operation = (async (): Promise<boolean> => {
        try {
          await generation.api.delete(generation.ownerId, filename);
        } catch (err) {
          if (isCurrentGeneration(generation)) setError(errorMessage(err));
          return false;
        }
        if (!isCurrentGeneration(generation)) return false;
        commitFiles(
          filesRef.current.filter((entry) => entry.name !== filename),
        );
        await refreshGeneration(generation);
        return true;
      })();
      const pending = { generation, promise: operation };
      pendingDeletesRef.current.add(pending);
      void operation.finally(() => pendingDeletesRef.current.delete(pending));
      return operation;
    },
    [commitFiles, isCurrentGeneration, refreshGeneration],
  );

  const prepareForSubmit = useCallback(async (): Promise<boolean> => {
    const generation = generationRef.current;
    if (!generation) return true;
    if (!isCurrentGeneration(generation)) return false;

    while (true) {
      const pending = [...pendingDeletesRef.current].filter(
        (entry) => entry.generation === generation,
      );
      if (pending.length === 0) break;
      const results = await Promise.all(pending.map((entry) => entry.promise));
      if (results.some((deleted) => !deleted)) return false;
      if (!isCurrentGeneration(generation)) return false;
    }

    const usedAt = new Date().toISOString();
    let changed = false;
    const next = filesRef.current.map((file) => {
      if (file.usedAt) return file;
      changed = true;
      return { ...file, usedAt };
    });
    if (changed) commitFiles(next);
    return true;
  }, [commitFiles, isCurrentGeneration]);

  const refresh = useCallback(async () => {
    const generation = generationRef.current;
    if (!generation || !isCurrentGeneration(generation)) return;
    await refreshGeneration(generation);
  }, [isCurrentGeneration, refreshGeneration]);

  const clearError = useCallback(() => setError(null), []);
  const reportError = useCallback((message: string) => setError(message), []);

  const parsingActive = files.some(
    (file) => file.parseStatus === "pending" || file.parseStatus === "parsing",
  );

  // Poll only while an authoritative file reports pending or parsing.
  useEffect(() => {
    const generation = generationRef.current;
    if (!generation || !isCurrentGeneration(generation) || !parsingActive) {
      return;
    }
    const timer = setInterval(() => {
      void refreshGeneration(generation);
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [isCurrentGeneration, parsingActive, pollIntervalMs, refreshGeneration]);

  const items = useMemo(() => {
    const currentItems = ownerId
      ? [
          ...authoritativeItems.filter((item) => item.ownerId === ownerId),
          ...attempts.filter((item) => item.ownerId === ownerId),
        ]
      : [];
    return currentItems.sort((a, b) =>
      a.occurredAt.localeCompare(b.occurredAt),
    );
  }, [attempts, authoritativeItems, ownerId]);

  return {
    items,
    currentFiles: files,
    loading,
    uploading,
    error,
    upload,
    retry,
    dismiss,
    remove,
    prepareForSubmit,
    refresh,
    clearError,
    reportError,
  };
}
