import { TaskBody } from "@/components/run/tasks/task-body";
import TaskSetupControls from "@/components/run/tasks/task-setup-controls";
import type { SessionTasksController } from "@/components/run/tasks/use-session-tasks";
import { PanelEmptyState } from "@/components/ui/card";
import type { SessionSummary } from "@/lib/models/session-model";

/**
 * Right-hand pane of the Run tab.
 *
 * Renders the task lifecycle: setup, running, interrupted, and terminal states,
 * via TaskBody. Task lifecycle state and SSE subscriptions keyed by
 * taskId (not tied to the active tab) live in `useSessionTasks`.
 */
export function RightPane({
  session,
  tasksController,
  agentQuestionWaitTaskIds,
  agentQuestionReadTaskIds,
}: {
  session: SessionSummary | null;
  tasksController: SessionTasksController;
  /** Tasks the conversation has read as still waiting on an agent question. */
  agentQuestionWaitTaskIds?: ReadonlySet<string>;
  /** Tasks whose question list has been read at the current revision. */
  agentQuestionReadTaskIds?: ReadonlySet<string>;
}) {
  const {
    activeEvents,
    activeTask,
    activeWorkflowId,
    handleCancel,
    handleModelChoiceApproved,
    handleResume,
    handleSelectWorkflow,
    resumingTaskIds,
    tasks,
  } = tasksController;

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* ── Main content area ── */}
      {!session ? (
        // No session selected
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
          <PanelEmptyState>
            <div className="text-sm font-medium text-foreground">
              No session selected
            </div>
            <div className="mt-1.5 text-xs text-muted-foreground">
              Pick a session in the sidebar or start a new one.
            </div>
          </PanelEmptyState>
        </div>
      ) : tasks.length === 0 ? (
        // Empty state — no tasks started yet; guide user through the setup flow
        <div className="flex flex-1 flex-col overflow-y-auto">
          <TaskSetupControls
            selectedWorkflow={activeWorkflowId}
            onSelectWorkflow={handleSelectWorkflow}
          />
        </div>
      ) : activeTask ? (
        // Task body — handles running/done/error/cancelled/setup modes
        <TaskBody
          task={activeTask}
          sessionId={session.id}
          runName={session.title}
          onCancelTask={(taskId) => void handleCancel(taskId)}
          onResumeTask={(taskId) => void handleResume(taskId)}
          onModelChoiceApproved={handleModelChoiceApproved}
          isResuming={resumingTaskIds.has(activeTask.taskId)}
          events={activeEvents}
          {...(agentQuestionWaitTaskIds ? { agentQuestionWaitTaskIds } : {})}
          {...(agentQuestionReadTaskIds ? { agentQuestionReadTaskIds } : {})}
        />
      ) : (
        // Tasks exist but no current task is available.
        <div className="flex flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
          No current task is available.
        </div>
      )}
    </aside>
  );
}
