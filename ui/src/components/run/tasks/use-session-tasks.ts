import { useSessionTaskActions } from "@/components/run/tasks/use-session-task-actions";
import { useSessionTaskHistory } from "@/components/run/tasks/use-session-task-history";
import { useSessionWorkflowSelection } from "@/components/run/tasks/use-session-workflow-selection";
import { useTaskEventStream } from "@/components/run/tasks/use-task-event-stream";
import { useTaskRunStore } from "@/components/run/tasks/use-task-run-store";
import type { RunPlan, SessionSummary } from "@/lib/models/session-model";
import type { StoredChatLine } from "@/components/run/chat/use-conversation-stream";

export interface UseSessionTasksOptions {
  hasUserMessage: boolean;
  runPlan: RunPlan | null;
  session: SessionSummary | null;
  /** True while the session exists only on the client, so reads are skipped. */
  sessionIsDraft?: boolean;
  taskRefreshKey: number;
  onInjectChatMessage: (
    text: string,
    role?: "user" | "assistant" | "system",
    stored?: StoredChatLine,
  ) => void;
  onLatestTaskWorkflowChange: (
    sessionId: string,
    isDeepResearch: boolean,
  ) => void;
  onReloadChatMessages: () => void;
  onRunPlanUpdated: (sessionId: string, plan: RunPlan) => void;
  onSessionActivityStarted?: ((sessionId: string) => void) | undefined;
}

/** Composes task state, persistence, live events, selection, and mutations. */
export function useSessionTasks(options: UseSessionTasksOptions) {
  const store = useTaskRunStore();
  const stream = useTaskEventStream({
    appendTaskEvent: store.appendTaskEvent,
    onInjectChatMessage: options.onInjectChatMessage,
    onReloadChatMessages: options.onReloadChatMessages,
    setTasks: store.setTasks,
  });
  const actions = useSessionTaskActions({
    onInjectChatMessage: options.onInjectChatMessage,
    onRunPlanUpdated: options.onRunPlanUpdated,
    onSessionActivityStarted: options.onSessionActivityStarted,
    session: options.session,
    store,
    stream,
  });
  const workflow = useSessionWorkflowSelection({
    hasUserMessage: options.hasUserMessage,
    isStarting: actions.isStarting,
    onRunPlanUpdated: options.onRunPlanUpdated,
    runPlan: options.runPlan,
    session: options.session,
  });

  useSessionTaskHistory({
    clearResumingTaskIds: actions.clearResumingTaskIds,
    onLatestTaskWorkflowChange: options.onLatestTaskWorkflowChange,
    resetWorkflowSelection: workflow.resetWorkflowSelection,
    session: options.session,
    sessionIsDraft: options.sessionIsDraft ?? false,
    store,
    stream,
    taskRefreshKey: options.taskRefreshKey,
  });

  const activeTask =
    store.tasks.find((task) => task.taskId === store.activeTaskId) ?? null;
  const activeEvents = store.activeTaskId
    ? (store.taskEvents[store.activeTaskId] ?? [])
    : [];

  return {
    activeEvents,
    activeTask,
    activeTaskId: store.activeTaskId,
    activeWorkflowId: workflow.activeWorkflowId,
    canStartRun: workflow.canStartRun,
    handleCancel: actions.cancelTask,
    handleModelChoiceApproved: actions.applyApprovedModelChoice,
    handleResume: actions.resumeTask,
    handleSelectWorkflow: workflow.selectWorkflow,
    handleStartTask: actions.startTask,
    isLaunchReady: workflow.isLaunchReady,
    isSelectingWorkflow: workflow.isSelectingWorkflow,
    isStarting: actions.isStarting,
    manualWorkflowId: workflow.manualWorkflowId,
    resumingTaskIds: actions.resumingTaskIds,
    setActiveTaskId: store.setActiveTaskId,
    taskEvents: store.taskEvents,
    tasks: store.tasks,
  };
}

export type SessionTasksController = ReturnType<typeof useSessionTasks>;
