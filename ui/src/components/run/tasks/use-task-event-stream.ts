import {
  startTransition,
  useCallback,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";

import type { TaskRunEntry } from "@/components/run/tasks/task-strip";
import {
  isEventEnvelopeForTaskRun,
  toRunEvent,
} from "@/components/run/tasks/task-run-model";
import type { RunEvent } from "@/components/run/stage-renderers/index";
import { openRunEventStream } from "@/lib/clients/runtime-client";

export interface OpenTaskStreamOptions {
  fromIndex?: number;
  initialHasDelivery?: boolean;
  runId: string;
  taskId: string;
}

export function useTaskEventStream({
  appendTaskEvent,
  onInjectChatMessage,
  onReloadChatMessages,
  setTasks,
}: {
  appendTaskEvent: (taskId: string, event: RunEvent) => void;
  onInjectChatMessage: (text: string, role?: "user" | "assistant" | "system") => void;
  onReloadChatMessages: () => void;
  setTasks: Dispatch<SetStateAction<TaskRunEntry[]>>;
}) {
  // ── SSE AbortControllers keyed by taskId ─────────────────────────────────
  // Using a ref (not state) so mutations don't trigger re-renders.
  const sseControllersRef = useRef<Map<string, AbortController>>(new Map());

  const abortAllStreams = useCallback(() => {
    for (const controller of sseControllersRef.current.values()) {
      controller.abort();
    }
    sseControllersRef.current.clear();
  }, []);

  const closeTaskStream = useCallback((taskId: string) => {
    const controller = sseControllersRef.current.get(taskId);
    if (!controller) return;
    controller.abort();
    sseControllersRef.current.delete(taskId);
  }, []);

  const openTaskStream = useCallback(
    ({
      fromIndex = 0,
      initialHasDelivery = false,
      runId,
      taskId,
    }: OpenTaskStreamOptions) => {
      if (sseControllersRef.current.has(taskId)) return;

      let deliverySelectedForRun = initialHasDelivery;
      const controller = new AbortController();
      sseControllersRef.current.set(taskId, controller);

      void openRunEventStream({
        runId,
        fromIndex,
        signal: controller.signal,
        onStatus: () => {
          // Status changes (connecting → live) are informational.
        },
        onEvent: (id, envelope) => {
          const event = toRunEvent(id, envelope);

          const deliverySelected =
            event.artifactPath &&
            envelope.type === "artifact.delivery_selected" &&
            isEventEnvelopeForTaskRun(envelope, runId);
          if (deliverySelected) {
            deliverySelectedForRun = true;
            // The server persists the delivery as a chat message; reload so the
            // card appears without a manual refresh.
            onReloadChatMessages();
          }

          startTransition(() => {
            appendTaskEvent(taskId, event);
          });

          if (
            envelope.type === "session_task.workflow_started" &&
            isEventEnvelopeForTaskRun(envelope, runId)
          ) {
            const workerStartedAt = Number.isNaN(event.ts) ? Date.now() : event.ts;
            startTransition(() => {
              setTasks((prev) =>
                prev.map((task): TaskRunEntry =>
                  task.taskId === taskId &&
                  Boolean(event.executionAttemptId) &&
                  event.executionAttemptId === task.executionAttemptId
                    ? {
                        ...task,
                        mode: "running",
                        startedAt: task.startedAt ?? workerStartedAt,
                      }
                    : task,
                ),
              );
            });
          } else if (
            envelope.type === "run.awaiting_input" &&
            isEventEnvelopeForTaskRun(envelope, runId)
          ) {
            startTransition(() => {
              setTasks((prev) =>
                prev.map((task): TaskRunEntry =>
                  task.taskId === taskId
                    ? { ...task, mode: "awaiting_input" }
                    : task,
                ),
              );
            });
          } else if (
            envelope.type === "run.awaiting_model_choice" &&
            isEventEnvelopeForTaskRun(envelope, runId)
          ) {
            startTransition(() => {
              setTasks((prev) =>
                prev.map((task): TaskRunEntry =>
                  task.taskId === taskId
                    ? { ...task, mode: "awaiting_model_choice" }
                    : task,
                ),
              );
            });
            // Unlike human input, this wait releases the worker: the run will
            // not speak again until someone decides, and the continuation runs
            // as a new attempt. Keeping the registration would make that
            // continuation stream unopenable, since opening is refused while a
            // stream for this task is still registered.
            controller.abort();
            sseControllersRef.current.delete(taskId);
          } else if (
            envelope.type === "run.interrupted" &&
            isEventEnvelopeForTaskRun(envelope, runId)
          ) {
            const interruptedAt = Number.isNaN(event.ts) ? Date.now() : event.ts;
            const payload = envelope.payload as Record<string, unknown>;
            const recoveryDisposition =
              payload.recovery_disposition === "automatic" ||
              payload.recovery_disposition === "manual" ||
              payload.recovery_disposition === "not_resumable"
                ? payload.recovery_disposition
                : undefined;
            startTransition(() => {
              setTasks((prev) =>
                prev.map((task): TaskRunEntry =>
                  task.taskId === taskId
                    ? {
                        ...task,
                        mode: "interrupted",
                        completedAt: interruptedAt,
                        executionAttemptId:
                          typeof payload.execution_attempt_id === "string"
                            ? payload.execution_attempt_id
                            : task.executionAttemptId,
                        recoveryDisposition,
                        recoveryReason:
                          typeof payload.recovery_reason === "string"
                            ? payload.recovery_reason
                            : "The workflow worker stopped before completion.",
                      }
                    : task,
                ),
              );
            });
            controller.abort();
            sseControllersRef.current.delete(taskId);
          } else if (
            envelope.type === "run.completed" &&
            isEventEnvelopeForTaskRun(envelope, runId)
          ) {
            const completedAt = Number.isNaN(event.ts) ? Date.now() : event.ts;
            startTransition(() => {
              setTasks((prev) =>
                prev.map((t): TaskRunEntry =>
                  t.taskId === taskId
                    ? {
                        ...t,
                        mode: "done",
                        completedAt,
                      }
                    : t,
                ),
              );
            });
            onReloadChatMessages();
            if (!deliverySelectedForRun) {
              // No delivery was selected, so there is no persisted delivery
              // message for the reload to surface — keep the local note.
              onInjectChatMessage(
                "✅ Done. What’s next? You can run another workflow or ask me about the results.",
                "assistant",
              );
            }
            controller.abort();
            sseControllersRef.current.delete(taskId);
          } else if (
            envelope.type === "run.failed" &&
            isEventEnvelopeForTaskRun(envelope, runId)
          ) {
            const completedAt = Number.isNaN(event.ts) ? Date.now() : event.ts;
            startTransition(() => {
              setTasks((prev) =>
                prev.map((t): TaskRunEntry =>
                  t.taskId === taskId
                    ? {
                        ...t,
                        mode: "error",
                        completedAt,
                        errorMessage: event.errorMessage,
                      }
                    : t,
                ),
              );
            });
            onReloadChatMessages();
            controller.abort();
            sseControllersRef.current.delete(taskId);
          } else if (
            envelope.type === "run.blocked" &&
            isEventEnvelopeForTaskRun(envelope, runId)
          ) {
            const completedAt = Number.isNaN(event.ts) ? Date.now() : event.ts;
            startTransition(() => {
              setTasks((prev) =>
                prev.map((task): TaskRunEntry =>
                  task.taskId === taskId
                    ? {
                        ...task,
                        mode: "blocked",
                        completedAt,
                        errorMessage: event.errorMessage,
                      }
                    : task,
                ),
              );
            });
            onReloadChatMessages();
            controller.abort();
            sseControllersRef.current.delete(taskId);
          } else if (
            envelope.type === "run.cancelled" &&
            isEventEnvelopeForTaskRun(envelope, runId)
          ) {
            const completedAt = Number.isNaN(event.ts) ? Date.now() : event.ts;
            startTransition(() => {
              setTasks((prev) =>
                prev.map((task): TaskRunEntry =>
                  task.taskId === taskId
                    ? {
                        ...task,
                        mode: "cancelled",
                        completedAt,
                        errorMessage: event.errorMessage,
                      }
                    : task,
                ),
              );
            });
            controller.abort();
            sseControllersRef.current.delete(taskId);
          }
        },
      }).catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("[RunPanel] SSE error for task", taskId, err);
        startTransition(() => {
          setTasks((prev) =>
            prev.map((t): TaskRunEntry =>
              t.taskId === taskId && t.mode === "running"
                ? {
                    ...t,
                    mode: "error",
                    errorMessage:
                      err instanceof Error ? err.message : String(err),
                  }
                : t,
            ),
          );
        });
        sseControllersRef.current.delete(taskId);
      });
    },
    [appendTaskEvent, onInjectChatMessage, onReloadChatMessages, setTasks],
  );

  return { abortAllStreams, closeTaskStream, openTaskStream };
}

export type TaskEventStreamController = ReturnType<typeof useTaskEventStream>;
