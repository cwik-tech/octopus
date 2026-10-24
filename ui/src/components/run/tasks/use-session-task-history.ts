import { startTransition, useEffect, useRef } from "react";

import type { RunEvent } from "@/components/run/stage-renderers/index";
import {
  hasDeliverySelection,
  toSnapshotRunEvent,
  toTaskRunEntry,
} from "@/components/run/tasks/task-run-model";
import type { TaskEventStreamController } from "@/components/run/tasks/use-task-event-stream";
import type { TaskRunStore } from "@/components/run/tasks/use-task-run-store";
import type { TaskMode } from "@/components/run/tasks/task-strip";
import { listSessionTasks } from "@/lib/clients/session-client";
import { fetchRunEventsSnapshot } from "@/lib/clients/runtime-client";
import type { SessionSummary, SessionTask } from "@/lib/models/session-model";

const QUEUED_TASK_REFRESH_INTERVAL_MS = 1_000;

/**
 * Whether the renderer should keep reading this task's record.
 *
 * Every status here is stopped without being finished, and every one of them
 * can move for a reason no open stream will report.
 *
 * `interrupted` is the one that costs the most to leave out. Its live stream is
 * aborted the moment the run is interrupted and never reopened, and an
 * automatic recovery is admitted when the task queue starts — so nothing inside
 * a mounted session can hear the run come back, be resumed from another window,
 * or be cancelled. Stop reading and the composer's own notice ("waiting to
 * resume") becomes unfalsifiable: it stays shut on a run the server has already
 * finished, and its Stop — the one way out the notice offers — answers 409.
 */
export function shouldRefreshTaskStatus(
  status: TaskMode,
): boolean {
  return (
    status === 'queued' ||
    status === 'awaiting_input' ||
    status === 'awaiting_model_choice' ||
    status === 'interrupted'
  );
}

/**
 * A task's recorded events, or none when they cannot be read.
 *
 * A task that has not finished may simply have written nothing yet, so only a
 * finished one is worth a warning.
 */
async function readTaskEvents(record: SessionTask): Promise<RunEvent[]> {
  try {
    const snapshot = await fetchRunEventsSnapshot(record.runId);
    return snapshot.events.map(toSnapshotRunEvent);
  } catch (error) {
    if (
      record.status === "done" ||
      record.status === "failed" ||
      record.status === "blocked" ||
      record.status === "cancelled"
    ) {
      console.warn("[RunPanel] Failed to restore task events", record.id, error);
    }
    return [];
  }
}

export function useSessionTaskHistory({
  clearResumingTaskIds,
  onLatestTaskWorkflowChange,
  resetWorkflowSelection,
  session,
  sessionIsDraft = false,
  store,
  stream,
  taskRefreshKey,
}: {
  clearResumingTaskIds: () => void;
  onLatestTaskWorkflowChange: (
    sessionId: string,
    isDeepResearch: boolean,
  ) => void;
  resetWorkflowSelection: () => void;
  session: SessionSummary | null;
  /** Skip every task read while the session exists only on the client. */
  sessionIsDraft?: boolean;
  store: TaskRunStore;
  stream: TaskEventStreamController;
  taskRefreshKey: number;
}) {
  const {
    appendTaskEvent,
    replaceTaskEvents,
    resetTaskEvents,
    setActiveTaskId,
    setTasks,
    taskEventsRef,
    tasks,
  } = store;
  const { abortAllStreams, openTaskStream } = stream;

  useEffect(() => {
    abortAllStreams();
    startTransition(() => {
      setTasks([]);
      setActiveTaskId(null);
      replaceTaskEvents({});
      clearResumingTaskIds();
      resetWorkflowSelection();
    });

    if (!session?.id || sessionIsDraft) return;
    let cancelled = false;
    const sessionId = session.id;

    void listSessionTasks(sessionId)
      .then(async (records) => {
        onLatestTaskWorkflowChange(
          sessionId,
          records.at(-1)?.workflowId === "deep-research-report",
        );
        const restored = await Promise.all(
          records.map(async (record) => {
            const events = await readTaskEvents(record);
            return { entry: toTaskRunEntry(record, events), events };
          }),
        );

        if (cancelled) return;
        startTransition(() => {
          setTasks(restored.map((item) => item.entry));
          replaceTaskEvents(
            Object.fromEntries(
              restored.map((item) => [item.entry.taskId, item.events]),
            ),
          );
          setActiveTaskId(restored.at(-1)?.entry.taskId ?? null);
        });

        for (const item of restored) {
          if (cancelled) break;
          if (item.entry.mode === "queued" || item.entry.mode === "running") {
            openTaskStream({
              taskId: item.entry.taskId,
              runId: item.entry.runId,
              fromIndex: item.events.length,
              initialHasDelivery: hasDeliverySelection(
                item.events,
                item.entry.runId,
              ),
            });
          }
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.error("[RunPanel] Failed to load session tasks", error);
        }
      });

    return () => {
      cancelled = true;
      abortAllStreams();
    };
  }, [
    abortAllStreams,
    clearResumingTaskIds,
    onLatestTaskWorkflowChange,
    openTaskStream,
    replaceTaskEvents,
    resetWorkflowSelection,
    session?.id,
    sessionIsDraft,
    setActiveTaskId,
    setTasks,
  ]);

  /**
   * A task started from inside this session, usually by a follow-up message.
   *
   * Merged into what is already on screen rather than read back from scratch.
   * A Team run's replies are rebuilt from its events, so clearing them to
   * reload made every earlier answer vanish, could drop the Team workspace for
   * a plain chat, and held the new run's live stream until every finished
   * run's history had been downloaded again. Only tasks this view has not
   * seen are read; the ones it holds keep their events and open streams.
   */
  const handledRefreshKeyRef = useRef(taskRefreshKey);
  useEffect(() => {
    if (handledRefreshKeyRef.current === taskRefreshKey) return;
    handledRefreshKeyRef.current = taskRefreshKey;
    if (!session?.id || sessionIsDraft) return;
    let cancelled = false;
    const sessionId = session.id;

    void listSessionTasks(sessionId)
      .then(async (records) => {
        onLatestTaskWorkflowChange(
          sessionId,
          records.at(-1)?.workflowId === "deep-research-report",
        );
        const added = await Promise.all(
          records
            .filter((record) => taskEventsRef.current[record.id] === undefined)
            .map(async (record) => ({
              record,
              events: await readTaskEvents(record),
            })),
        );
        if (cancelled) return;
        const addedEvents = new Map(
          added.map(({ record, events }) => [record.id, events]),
        );
        const eventsFor = (taskId: string) =>
          addedEvents.get(taskId) ?? taskEventsRef.current[taskId] ?? [];

        startTransition(() => {
          setTasks((current) => {
            const shown = new Map(current.map((entry) => [entry.taskId, entry]));
            return records.map((record) => {
              const refreshed = toTaskRunEntry(record, eventsFor(record.id));
              const entry = shown.get(record.id);
              return entry ? { ...entry, ...refreshed } : refreshed;
            });
          });
          for (const { record, events } of added) {
            resetTaskEvents(record.id);
            for (const event of events) appendTaskEvent(record.id, event);
          }
          setActiveTaskId(records.at(-1)?.id ?? null);
        });

        for (const record of records) {
          const entry = toTaskRunEntry(record, eventsFor(record.id));
          if (entry.mode === "queued" || entry.mode === "running") {
            const events = eventsFor(record.id);
            openTaskStream({
              taskId: record.id,
              runId: record.runId,
              fromIndex: events.length,
              initialHasDelivery: hasDeliverySelection(events, record.runId),
            });
          }
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.error("[RunPanel] Failed to refresh session tasks", error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    appendTaskEvent,
    onLatestTaskWorkflowChange,
    openTaskStream,
    resetTaskEvents,
    session?.id,
    sessionIsDraft,
    setActiveTaskId,
    setTasks,
    taskEventsRef,
    taskRefreshKey,
  ]);

  const hasPollableTasks = tasks.some((task) => shouldRefreshTaskStatus(task.mode));

  useEffect(() => {
    if (!session?.id || sessionIsDraft || !hasPollableTasks) return;
    let cancelled = false;
    let refreshing = false;
    const sessionId = session.id;

    const refreshQueuedTasks = async () => {
      if (refreshing || document.visibilityState !== "visible") return;
      refreshing = true;
      try {
        const records = await listSessionTasks(sessionId);
        if (cancelled) return;
        const recordsById = new Map(records.map((record) => [record.id, record]));

        startTransition(() => {
          setTasks((current) =>
            current.map((entry) => {
              if (!shouldRefreshTaskStatus(entry.mode)) return entry;
              const record = recordsById.get(entry.taskId);
              if (!record) return entry;
              return {
                ...entry,
                ...toTaskRunEntry(
                  record,
                  taskEventsRef.current[entry.taskId] ?? [],
                ),
              };
            }),
          );
        });

        for (const record of records) {
          const bufferedEvents = taskEventsRef.current[record.id] ?? [];
          const refreshed = toTaskRunEntry(record, bufferedEvents);
          if (refreshed.mode === "queued" || refreshed.mode === "running") {
            openTaskStream({
              taskId: refreshed.taskId,
              runId: refreshed.runId,
              fromIndex: bufferedEvents.length,
              initialHasDelivery: hasDeliverySelection(
                bufferedEvents,
                refreshed.runId,
              ),
            });
          }
        }
      } catch (error) {
        if (!cancelled) {
          console.warn("[RunPanel] Failed to refresh queued tasks", error);
        }
      } finally {
        refreshing = false;
      }
    };

    const intervalId = window.setInterval(
      () => void refreshQueuedTasks(),
      QUEUED_TASK_REFRESH_INTERVAL_MS,
    );
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshQueuedTasks();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    hasPollableTasks,
    openTaskStream,
    session?.id,
    sessionIsDraft,
    setTasks,
    taskEventsRef,
  ]);

  useEffect(() => abortAllStreams, [abortAllStreams]);
}
