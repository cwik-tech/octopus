/**
 * What the pane does with the task an approved model choice hands back.
 *
 * The approval response already carries the admitted task. Discarding it and
 * waiting for the next status poll would leave the run looking stopped for up
 * to a second after the person acted, and would leave the continuation stream
 * closed for that whole time. The continuation opens from the events already
 * buffered, so resuming does not replay what the pane has shown.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RunEvent } from "@/components/run/stage-renderers/index";
import { useSessionTaskActions } from "@/components/run/tasks/use-session-task-actions";
import { useTaskRunStore } from "@/components/run/tasks/use-task-run-store";
import type { SessionSummary } from "@/lib/models/session-model";
import type { SessionTask } from "@contracts/sessions";

const SESSION: SessionSummary = {
  id: "sess-1",
  title: "Model choice",
  status: "active",
  activityType: "workflow",
  createdAt: "2026-09-06T10:00:00.000Z",
  updatedAt: "2026-09-06T10:00:00.000Z",
};

/** Two events already on screen, so the resume index is not trivially zero. */
const buffered: RunEvent[] = [
  {
    id: "evt-1",
    runId: "run-1",
    type: "workflow.step.started",
    ts: 1_757_155_200_000,
  },
  {
    id: "evt-2",
    runId: "run-1",
    type: "workflow.step.completed",
    ts: 1_757_155_201_000,
  },
];

const approvedTask: SessionTask = {
  id: "task-1",
  sessionId: "sess-1",
  runId: "run-1",
  workflowId: "packaged-smoke",
  brief: "Finalise the note.",
  status: "queued",
  createdAt: "2026-09-06T10:00:00.000Z",
  updatedAt: "2026-09-06T10:00:05.000Z",
  cwd: "/tmp/task-1",
};

function renderActions() {
  const stream = {
    abortAllStreams: vi.fn(),
    closeTaskStream: vi.fn(),
    openTaskStream: vi.fn(),
  };
  const rendered = renderHook(() => {
    const store = useTaskRunStore();
    const actions = useSessionTaskActions({
      onInjectChatMessage: vi.fn(),
      onRunPlanUpdated: vi.fn(),
      session: SESSION,
      store,
      stream,
    });
    return { actions, store };
  });
  act(() => {
    rendered.result.current.store.setTasks([
      {
        taskId: "task-1",
        runId: "run-1",
        workflowId: "packaged-smoke",
        label: "Recovery task",
        mode: "awaiting_model_choice",
      },
    ]);
    rendered.result.current.store.replaceTaskEvents({ "task-1": buffered });
  });
  return { ...rendered, stream };
}

describe("applyApprovedModelChoice", () => {
  it("applies the admitted task at once instead of waiting for the next poll", async () => {
    const { result } = renderActions();

    act(() => {
      result.current.actions.applyApprovedModelChoice(approvedTask);
    });

    await waitFor(() => {
      expect(result.current.store.tasks[0]?.mode).toBe("queued");
    });
  });

  it("opens the continuation from the events already buffered", async () => {
    const { result, stream } = renderActions();

    act(() => {
      result.current.actions.applyApprovedModelChoice(approvedTask);
    });

    await waitFor(() => expect(stream.openTaskStream).toHaveBeenCalledTimes(1));
    expect(stream.openTaskStream).toHaveBeenCalledWith({
      taskId: "task-1",
      runId: "run-1",
      fromIndex: buffered.length,
      initialHasDelivery: false,
    });
    // Any registration left from the stopped attempt is released first, or the
    // continuation would be refused by the duplicate-open guard.
    expect(stream.closeTaskStream).toHaveBeenCalledWith("task-1");
  });

  // A second approval of the same offer is answered idempotently, and by then
  // the run may already be finished. Opening a stream for a finished run would
  // reconnect to something that will never speak again.
  it("adopts a replayed answer without opening a stream for a finished run", async () => {
    const { result, stream } = renderActions();

    act(() => {
      result.current.actions.applyApprovedModelChoice({
        ...approvedTask,
        status: "done",
        completedAt: "2026-09-06T10:01:00.000Z",
      });
    });

    await waitFor(() => {
      expect(result.current.store.tasks[0]?.mode).toBe("done");
    });
    expect(stream.openTaskStream).not.toHaveBeenCalled();
  });

  // What the approval endpoint really returns.
  //
  // `enqueueContinuation` commits a *pending* admission and returns the record
  // as it then stands (`services/task-queue.ts:494-520`), so its status is
  // still `awaiting_model_choice` — the queue has not admitted the attempt yet.
  // The route hands exactly that record back in the 202
  // (`server/routes/sessions.ts:1139-1150`). A continuation that only opens a
  // stream for `queued` or `running` therefore opens none at all, and the run's
  // own events never reach the pane.
  const continuationAdmission = {
    version: 1 as const,
    requestId: "continuation-request-1",
    order: "2",
    requestedAt: "2026-09-06T10:00:03.000Z",
    executionKind: "continuation" as const,
    source: "model_choice" as const,
    expectedExecutionAttemptId: "attempt-one",
    phase: "pending" as const,
  };

  it("opens the continuation for the pending admission the approval returns", async () => {
    const { result, stream } = renderActions();

    act(() => {
      result.current.actions.applyApprovedModelChoice({
        ...approvedTask,
        status: "awaiting_model_choice",
        admission: continuationAdmission,
      });
    });

    await waitFor(() => expect(stream.openTaskStream).toHaveBeenCalledTimes(1));
    expect(stream.openTaskStream).toHaveBeenCalledWith({
      taskId: "task-1",
      runId: "run-1",
      fromIndex: buffered.length,
      initialHasDelivery: false,
    });
  });

  // Waiting is not admission. A record still in this status opens a stream only
  // because it carries the continuation the approval just created; anything
  // else in that status is a run nobody has authorized to continue.
  for (const unqualified of [
    { name: "no admission at all", admission: undefined },
    {
      name: "a continuation admitted for human input",
      admission: { ...continuationAdmission, source: "human_input" as const },
    },
    {
      name: "a model-choice admission that is not a continuation",
      admission: {
        ...continuationAdmission,
        executionKind: "recovery" as const,
      },
    },
  ]) {
    it(`opens nothing for a waiting task with ${unqualified.name}`, async () => {
      const { result, stream } = renderActions();

      act(() => {
        result.current.actions.applyApprovedModelChoice({
          ...approvedTask,
          status: "awaiting_model_choice",
          ...(unqualified.admission
            ? { admission: unqualified.admission }
            : {}),
        });
      });

      await waitFor(() => {
        expect(result.current.store.tasks[0]?.mode).toBe(
          "awaiting_model_choice",
        );
      });
      expect(stream.openTaskStream).not.toHaveBeenCalled();
    });
  }

  // A replayed approval can come back with the run already finished and its
  // continuation admission still on the record. Finished is finished: the
  // admission does not reopen a run that has nothing left to say.
  it("opens nothing for a finished task that still carries its continuation", async () => {
    const { result, stream } = renderActions();

    act(() => {
      result.current.actions.applyApprovedModelChoice({
        ...approvedTask,
        status: "done",
        completedAt: "2026-09-06T10:01:00.000Z",
        admission: {
          ...continuationAdmission,
          phase: "granted",
          grantId: "grant-1",
          ownerEpoch: "1",
          grantedAt: "2026-09-06T10:00:04.000Z",
          executionAttemptId: "attempt-two",
        },
      });
    });

    await waitFor(() => {
      expect(result.current.store.tasks[0]?.mode).toBe("done");
    });
    expect(stream.openTaskStream).not.toHaveBeenCalled();
  });

  // Staged is a request the queue has not committed. Only an admission it has
  // actually taken on says a continuation is coming.
  it("opens nothing for a waiting task whose continuation is only staged", async () => {
    const { result, stream } = renderActions();

    act(() => {
      result.current.actions.applyApprovedModelChoice({
        ...approvedTask,
        status: "awaiting_model_choice",
        admission: { ...continuationAdmission, phase: "staged" },
      });
    });

    await waitFor(() => {
      expect(result.current.store.tasks[0]?.mode).toBe("awaiting_model_choice");
    });
    expect(stream.openTaskStream).not.toHaveBeenCalled();
  });

  it("leaves other tasks alone", async () => {
    const { result } = renderActions();
    act(() => {
      result.current.store.setTasks((current) => [
        ...current,
        {
          taskId: "task-2",
          runId: "run-2",
          workflowId: "packaged-smoke",
          label: "Other task",
          mode: "running",
        },
      ]);
    });

    act(() => {
      result.current.actions.applyApprovedModelChoice(approvedTask);
    });

    await waitFor(() => {
      expect(result.current.store.tasks[0]?.mode).toBe("queued");
    });
    expect(result.current.store.tasks[1]?.mode).toBe("running");
  });
});
