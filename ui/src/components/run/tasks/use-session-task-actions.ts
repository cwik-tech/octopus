import { startTransition, useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { GENERAL_AGENT_LABEL } from "@contracts/front-door";

import { hasDeliverySelection, toTaskRunEntry } from "@/components/run/tasks/task-run-model";
import type { TaskEventStreamController } from "@/components/run/tasks/use-task-event-stream";
import type { TaskRunStore } from "@/components/run/tasks/use-task-run-store";
import {
  cancelSessionTask,
  resumeSessionTask,
  startSessionTask,
  SessionTaskStartError,
} from "@/lib/clients/session-client";
import type {
  RunPlan,
  SessionSummary,
  WorkspaceProjectContextSelection,
} from "@/lib/models/session-model";
import type { SessionTask } from "@contracts/sessions";
import type { StoredChatLine } from "@/components/run/chat/use-conversation-stream";

export function useSessionTaskActions({
  onInjectChatMessage,
  onRunPlanUpdated,
  onSessionActivityStarted,
  session,
  store,
  stream,
}: {
  onInjectChatMessage: (
    text: string,
    role?: "user" | "assistant" | "system",
    stored?: StoredChatLine,
  ) => void;
  onRunPlanUpdated: (sessionId: string, plan: RunPlan) => void;
  onSessionActivityStarted?: ((sessionId: string) => void) | undefined;
  session: SessionSummary | null;
  store: TaskRunStore;
  stream: TaskEventStreamController;
}) {
  const [isStarting, setIsStarting] = useState(false);
  const [resumingTaskIds, setResumingTaskIds] = useState<Set<string>>(
    () => new Set(),
  );
  const cancelRequestsRef = useRef<Set<string>>(new Set());
  const resumeRequestsRef = useRef<Set<string>>(new Set());
  const startingRef = useRef(false);
  const { closeTaskStream, openTaskStream } = stream;

  const clearResumingTaskIds = useCallback(() => {
    setResumingTaskIds(new Set());
  }, []);

  const startTask = useCallback(
    async (
      workflowId: string,
      projectContext?: WorkspaceProjectContextSelection,
      /**
       * Completed results this launch carries forward.
       *
       * Passed through rather than read here: the selection belongs to the
       * composer, and Begin workflow is a different control in a different
       * component. It reached the server as `[]` while the chips said
       * otherwise.
       */
      contextResultIds?: readonly string[],
    ) => {
      if (!session || startingRef.current) return;
      startingRef.current = true;
      setIsStarting(true);
      try {
        const task = await startSessionTask(
          session.id,
          { workflowId },
          undefined,
          projectContext,
          contextResultIds,
        );
        onSessionActivityStarted?.(session.id);
        const entry = toTaskRunEntry(task, []);
        startTransition(() => {
          store.setTasks((current) => [...current, entry]);
          store.setActiveTaskId(task.id);
          store.resetTaskEvents(task.id);
        });
        onInjectChatMessage(`[system] Active task: ${task.id}`);
        if (entry.mode === "queued" || entry.mode === "running") {
          openTaskStream({ taskId: task.id, runId: task.runId });
        }
        if (entry.mode === "queued") {
          toast.success("Task queued", {
            description:
              "Waiting for execution capacity. It will start automatically.",
          });
        } else {
          toast.success("Task started", {
            description: `Workflow "${workflowId}" is now running.`,
          });
        }
      } catch (error) {
        if (error instanceof SessionTaskStartError && error.plan) {
          onRunPlanUpdated(session.id, error.plan);
        }
        if (error instanceof SessionTaskStartError && error.assistant) {
          // The server has stored this reply; passing it keeps the chat from
          // showing it twice once the transcript is read again.
          onInjectChatMessage(error.assistant.text, "assistant", error.assistant);
          toast.error("Brief required", {
            description:
              `Tell the ${GENERAL_AGENT_LABEL} what this work should be about first.`,
          });
          return;
        }
        toast.error("Failed to start task", {
          description:
            error instanceof SessionTaskStartError && error.detail
              ? error.detail
              : error instanceof Error
                ? error.message
                : String(error),
        });
      } finally {
        startingRef.current = false;
        setIsStarting(false);
      }
    },
    [
      onInjectChatMessage,
      onRunPlanUpdated,
      onSessionActivityStarted,
      openTaskStream,
      session,
      store,
    ],
  );

  const sessionId = session?.id ?? null;
  const cancelTask = useCallback(
    async (taskId: string) => {
      if (!sessionId || cancelRequestsRef.current.has(taskId)) return;
      cancelRequestsRef.current.add(taskId);
      try {
        const cancelledTask = await cancelSessionTask(sessionId, taskId);
        closeTaskStream(taskId);
        const parsedCompletedAt = cancelledTask.completedAt
          ? Date.parse(cancelledTask.completedAt)
          : Number.NaN;
        startTransition(() => {
          store.setTasks((current) =>
            current.map((task) =>
              task.taskId === taskId
                ? {
                    ...task,
                    mode: "cancelled",
                    completedAt: Number.isNaN(parsedCompletedAt)
                      ? Date.now()
                      : parsedCompletedAt,
                    errorMessage: cancelledTask.error,
                  }
                : task,
            ),
          );
        });
        toast.success("Task cancelled", {
          description:
            cancelledTask.error ?? "The workflow process was stopped.",
        });
      } catch (error) {
        toast.error("Failed to cancel task", {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        cancelRequestsRef.current.delete(taskId);
      }
    },
    [closeTaskStream, sessionId, store],
  );

  const resumeTask = useCallback(
    async (taskId: string) => {
      if (!sessionId || resumeRequestsRef.current.has(taskId)) return;
      resumeRequestsRef.current.add(taskId);
      setResumingTaskIds((current) => new Set(current).add(taskId));
      try {
        const resumedTask = await resumeSessionTask(sessionId, taskId);
        const resumedEntry = toTaskRunEntry(resumedTask, []);
        closeTaskStream(taskId);
        startTransition(() => {
          store.setTasks((current) =>
            current.map((task) =>
              task.taskId === taskId ? { ...task, ...resumedEntry } : task,
            ),
          );
        });
        if (resumedEntry.mode === "queued" || resumedEntry.mode === "running") {
          const bufferedEvents = store.taskEventsRef.current[taskId] ?? [];
          openTaskStream({
            taskId,
            runId: resumedTask.runId,
            fromIndex: bufferedEvents.length,
            initialHasDelivery: hasDeliverySelection(
              bufferedEvents,
              resumedTask.runId,
            ),
          });
        }
        if (resumedEntry.mode === "queued") {
          toast.success("Resume queued", {
            description:
              "Waiting for execution capacity. It will start automatically.",
          });
        } else {
          toast.success("Task resumed", {
            description: resumedTask.executionAttemptNumber
              ? `Execution attempt ${resumedTask.executionAttemptNumber} is running.`
              : "A new execution attempt is running.",
          });
        }
      } catch (error) {
        toast.error("Failed to resume task", {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        resumeRequestsRef.current.delete(taskId);
        setResumingTaskIds((current) => {
          const next = new Set(current);
          next.delete(taskId);
          return next;
        });
      }
    },
    [closeTaskStream, openTaskStream, sessionId, store],
  );

  /**
   * Adopts the task an approved model choice produced.
   *
   * The approval response already carried this task, validated at the client
   * boundary, so there is nothing left to ask the server for. Waiting for the
   * next status poll instead would show a stopped run for up to a second after
   * the person acted, with the continuation's events going nowhere.
   *
   * The continuation stream opens from the events already buffered, so what the
   * pane has shown is not replayed under it.
   */
  const applyApprovedModelChoice = useCallback(
    (approvedTask: SessionTask) => {
      const taskId = approvedTask.id;
      const bufferedEvents = store.taskEventsRef.current[taskId] ?? [];
      const approvedEntry = toTaskRunEntry(approvedTask, bufferedEvents);
      closeTaskStream(taskId);
      startTransition(() => {
        store.setTasks((current) =>
          current.map((task) =>
            task.taskId === taskId ? { ...task, ...approvedEntry } : task,
          ),
        );
      });
      // A repeated approval of the same offer is answered idempotently, and by
      // then the run may already be over. Only a run that can still speak gets
      // a stream.
      //
      // The waiting status counts too, but only with the continuation in hand.
      // `enqueueContinuation` commits a *pending* admission and returns the
      // record as it then stands (`services/task-queue.ts:494-520`), so the
      // task this approval hands back is still `awaiting_model_choice`. Waiting
      // to be admitted is not the same as not being admitted, and without this
      // the run's own events would never reach the pane. Anything else in that
      // status is a run nobody authorized to continue.
      const admission = approvedTask.admission;
      const admittedContinuation =
        approvedEntry.mode === "awaiting_model_choice" &&
        admission !== undefined &&
        (admission.phase === "pending" || admission.phase === "granted") &&
        admission.executionKind === "continuation" &&
        admission.source === "model_choice";
      if (
        approvedEntry.mode === "queued" ||
        approvedEntry.mode === "running" ||
        admittedContinuation
      ) {
        openTaskStream({
          taskId,
          runId: approvedTask.runId,
          fromIndex: bufferedEvents.length,
          initialHasDelivery: hasDeliverySelection(
            bufferedEvents,
            approvedTask.runId,
          ),
        });
      }
    },
    [closeTaskStream, openTaskStream, store],
  );

  return {
    applyApprovedModelChoice,
    cancelTask,
    clearResumingTaskIds,
    isStarting,
    resumingTaskIds,
    resumeTask,
    startTask,
  };
}
