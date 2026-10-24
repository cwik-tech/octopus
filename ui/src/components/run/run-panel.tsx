import { useWindowSessionReport } from "@/hooks/use-window-session-report";
import { CanvasSession } from '@/components/canvas/canvas-session'
import { CanvasSplit } from '@/components/canvas/canvas-split'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import ChatPanel, { type ChatPanelHandle } from "@/components/run/chat/chat-panel";
import type { AgentChatMode } from "@/components/run/pickers/agent-chat-mode-picker";
import { AGENT_DIALOGUE_MAX_AGENTS, AGENT_DIALOGUE_MIN_AGENTS } from "@contracts/agent-dialogue";
import type { StoredChatLine } from "@/components/run/chat/use-conversation-stream";
import { useAgentQuestions } from '@/components/run/chat/use-agent-questions';
import { WorkflowLaunchConfirmation } from "@/components/run/chat/workflow-launch-confirmation";
import { shouldRenderDeepResearchWorkspace } from "@/components/run/deep-research/deep-research-journey-model";
import {
  emptyChatTarget,
  selectChatAgents,
  selectChatTeam,
  discussionWorkspacePresentation,
  pendingWorkflowTarget,
  showsTeamRunWorkspace,
  toSessionMessageTarget,
  showsWorkflowLaunchConfirmation,
  type ChatTargetSelection,
} from "@/components/run/chat/chat-target";
import { DeepResearchWorkspace } from "@/components/run/deep-research/deep-research-workspace";
import { configuredTeamMembers } from "@/components/run/discussion/configured-team-members";
import { DiscussionWorkspace } from "@/components/run/discussion/discussion-workspace";
import { QueueOverview } from "@/components/run/queue/queue-overview";
import type { HelperModelSelection, TimelineTask } from "@/lib/utils/chat-timeline";
import { collectHelperModelSelections } from "@/lib/utils/helper-model-selections";
import {
  RunTargetSidebar,
  type RunTarget,
} from "@/components/run/run-target-sidebar";
import { SessionsSidebar } from "@/components/run/sessions/sessions-sidebar";
import { useRunSessions } from "@/components/run/sessions/use-run-sessions";
import { RightPane } from "@/components/run/tasks/right-pane";
import { getScheduledChatState } from "@/components/run/tasks/scheduled-chat-state";
import { getWorkflowRunState } from "@/components/run/tasks/workflow-run-state";
import type { TaskRunEntry } from "@/components/run/tasks/task-strip";
import { applyQueueSnapshot } from "@/components/run/tasks/task-run-model";
import {
  useSessionTasks,
  type SessionTasksController,
  type UseSessionTasksOptions,
} from "@/components/run/tasks/use-session-tasks";
import { SchedulesWorkspace } from "@/components/schedule/schedules-workspace";
import type { SchedulesState } from "@/components/schedule/use-schedules";
import type { BatchesState } from "@/components/batch/use-batches";
import { WorkspaceRunSidebarContent } from "@/components/sidebar/workspace-run-sidebar";
import { ChatWorkspace } from "@/components/shared/chat-shell";
import { PanelCard } from "@/components/ui/card";
import { useProviderCatalog } from "@/contexts/provider-catalog-context";
import { useRunPlans } from "@/hooks/use-run-plans";
import { useVoiceSessionRefresh } from "@/hooks/use-voice-session-refresh";
import { useContextResults } from "@/components/run/chat/use-context-results";
import type { SchedulingQueueSnapshot } from "@/lib/clients/scheduling-queue-client";
import {
  listCachedTeamBuilderTeams,
  subscribeToTeamBuilderTeams,
} from "@/lib/clients/team-builder-client";
import type { TeamBuilderSummary } from "@/lib/models/team-builder-model";
import { buildTeamStreamDispatches } from "@/lib/chat/team-stream-dispatches";
import {
  resolveTeamStreamHandoff,
  type TeamStreamHandoff,
} from "@/lib/chat/team-stream-handoff";
import { useTeamTextStream } from "@/lib/chat/use-team-text-stream";
import type {
  RunPlan,
  SessionSummary,
  SessionTask,
  WorkspaceProjectContextSelection,
} from "@/lib/models/session-model";
import {
  buildWorkflowChatMessages,
  findPendingWorkflowAgents,
  type PendingWorkflowAgent,
} from "@/lib/utils/workflow-chat-events";

// ── Constants ──────────────────────────────────────────────────────────────

const DESKTOP_HEADER_HEIGHT_REM = 2.75;
// Overview panels (Queue, Schedules & Batches) sit flush against this padding.
// Horizontal is a step wider than vertical so it matches the *optical* top gap:
// the heading's line-height already adds ~6px of leading above its cap height.
const OVERVIEW_PANEL_PADDING = "px-5 py-3 lg:px-6 lg:py-4";

export type RunWorkspaceView = "session" | "queue" | "schedule";
export type RunTargetLockReason = "scheduled-research" | "team-history";

// ── RunPanel ───────────────────────────────────────────────────────────────

function RunPanel({
  batchesState,
  inspectorOpen = true,
  onSessionActivityStarted,
  onCreateSessionActionChange,
  onOpenQueueSession,
  onOpenSchedulingSettings,
  onQueueRefresh,
  onRunTargetLockChange,
  onSessionCreated,
  queueError = null,
  queueLoading = false,
  queueSessions = [],
  queueSnapshot = null,
  schedulesState,
  sidebarOpen = true,
  sessionDeletionRequest,
  sessionSelectionRequest,
  workspaceView = "session",
}: {
  batchesState?: BatchesState;
  inspectorOpen?: boolean;
  onSessionActivityStarted?: (sessionId: string) => void;
  onCreateSessionActionChange?: (action: (() => void) | null) => void;
  onOpenQueueSession?: (sessionId: string) => void;
  onOpenSchedulingSettings?: () => void;
  onQueueRefresh?: () => Promise<void>;
  /**
   * Reports why the picker is unavailable so the shell can close it and
   * explain the restriction on its window-level toggle.
   */
  onRunTargetLockChange?: (reason: RunTargetLockReason | null) => void;
  onSessionCreated?: (sessionId: string) => void;
  queueError?: string | null;
  queueLoading?: boolean;
  queueSessions?: SessionSummary[];
  queueSnapshot?: SchedulingQueueSnapshot | null;
  schedulesState?: SchedulesState;
  sidebarOpen?: boolean;
  sessionDeletionRequest?: { id: string; requestId: string } | null;
  sessionSelectionRequest?: { id: string; requestId: string } | null;
  workspaceView?: RunWorkspaceView;
}) {
  // Agents, Teams, and Workflows are target/filter tabs. They choose what can
  // be picked; they never change what kind of conversation this is.
  const [runTarget, setRunTarget] = useState<RunTarget>("agents");
  const [hasUserMessageBySessionId, setHasUserMessageBySessionId] = useState<Record<string, boolean>>({});
  const [runPlanBySessionId, setRunPlanBySessionId] = useState<Record<string, RunPlan>>({});
  const [taskRefreshBySessionId, setTaskRefreshBySessionId] = useState<Record<string, number>>({});
  const [
    latestTaskIsDeepResearchBySessionId,
    setLatestTaskIsDeepResearchBySessionId,
  ] = useState<Record<string, boolean>>({});
  const [chatTargetBySessionId, setChatTargetBySessionId] =
    useState<Record<string, ChatTargetSelection>>({});
  const [agentChatModeBySessionId, setAgentChatModeBySessionId] =
    useState<Record<string, AgentChatMode>>({});
  const [dialogueActiveBySessionId, setDialogueActiveBySessionId] =
    useState<Record<string, boolean>>({});
  const [teamCatalog, setTeamCatalog] = useState<TeamBuilderSummary[]>([]);
  // The app-wide default from Settings → AI Providers, the last layer of the
  // runtime-selection rule the Team roster icons are resolved with.
  const { defaultModelState } = useProviderCatalog();
  const [projectContextBySessionId, setProjectContextBySessionId] = useState<
    Record<string, WorkspaceProjectContextSelection | undefined>
  >({});

  // Ref to ChatPanel imperative handle — used to inject system messages.
  const chatPanelRef = useRef<ChatPanelHandle>(null);

  /**
   * Prune per-session keyed state for an id nothing will name again — a deleted
   * session, or a draft abandoned before it was ever created. Every map is
   * cleared, not the three that used to be: an entry left behind under a dead
   * id is a slow leak, and repeated New would keep adding to it.
   */
  const handleSessionDeleted = useCallback((id: string) => {
    const withoutSession = <T,>(
      current: Record<string, T>,
    ): Record<string, T> => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    };
    setRunPlanBySessionId(withoutSession);
    setChatTargetBySessionId(withoutSession);
    setAgentChatModeBySessionId(withoutSession);
    setDialogueActiveBySessionId(withoutSession);
    setProjectContextBySessionId(withoutSession);
    setHasUserMessageBySessionId(withoutSession);
    setTaskRefreshBySessionId(withoutSession);
    setLatestTaskIsDeepResearchBySessionId(withoutSession);
  }, []);

  const {
    creatingSession,
    ensureSession,
    isDraftSession,
    handleCreateSession,
    handleDeleteSession,
    handleSessionUpdated,
    selectedSession,
    selectedSessionId,
    sessions,
    sessionsError,
    sessionsLoading,
    selectSession,
  } = useRunSessions({
    onCreateSessionActionChange,
    onSessionCreated,
    onSessionDeleted: handleSessionDeleted,
    sessionDeletionRequest,
    sessionSelectionRequest,
  });

  const refreshExternalChat = useCallback(() => {
    chatPanelRef.current?.reloadMessages();
    if (selectedSessionId) {
      setTaskRefreshBySessionId((current) => ({ ...current, [selectedSessionId]: (current[selectedSessionId] ?? 0) + 1 }));
    }
  }, [selectedSessionId]);
  useVoiceSessionRefresh(selectedSessionId, refreshExternalChat);

  useEffect(() => {
    if (sessionSelectionRequest?.id !== selectedSessionId) return;
    // A voice "show" request can target the chat already open. Its new request
    // identity still means reload the transcript and discover external work.
    chatPanelRef.current?.reloadMessages();
  }, [selectedSessionId, sessionSelectionRequest]);

  const selectedSessionIsDraft = selectedSessionId
    ? isDraftSession(selectedSessionId)
    : false;
  useWindowSessionReport(workspaceView === 'session' && !selectedSessionIsDraft ? selectedSessionId : null);
  const { handleRunPlanUpdated: storeRunPlanUpdated } = useRunPlans({
    selectedSessionId,
    selectedSessionIsDraft,
    setRunPlanBySessionId,
  });
  const handleRunPlanUpdated = useCallback(
    (sessionId: string, plan: RunPlan) => {
      setProjectContextBySessionId((current) => ({
        ...current,
        [sessionId]: plan.projectContext,
      }));
      storeRunPlanUpdated(sessionId, plan);
    },
    [storeRunPlanUpdated],
  );

  const selectedSessionHasUserMessage = selectedSession
    ? Boolean(hasUserMessageBySessionId[selectedSession.id])
    : false;
  // Lifted out of the composer: Begin workflow is a different control in a
  // different component, and it was launching with `[]` while the chips beside
  // the composer said a result was attached.
  //
  // A draft is passed as no session at all. It exists only in the renderer
  // until its first turn, so asking the server for its results answers 404.
  const contextResults = useContextResults(
    selectedSession && !selectedSessionIsDraft ? selectedSession.id : null,
  );
  const selectedRunPlan = selectedSession
    ? runPlanBySessionId[selectedSession.id] ?? null
    : null;
  // A run reaching a terminal state moves the plan, and the composer is usually
  // still open when it does. Without this, work that finished while the user
  // watched never became selectable until they left the conversation.
  const runPlanStatus = selectedRunPlan?.status ?? null;
  const refreshContextResults = contextResults.refresh;
  useEffect(() => {
    refreshContextResults();
  }, [runPlanStatus, refreshContextResults]);
  const chatTarget = selectedSession
    ? chatTargetBySessionId[selectedSession.id] ?? emptyChatTarget()
    : emptyChatTarget();
  const selectedAgentNames = chatTarget.agentNames;
  const agentChatMode = selectedSession
    ? agentChatModeBySessionId[selectedSession.id] ?? "discussion"
    : "discussion";
  const dialogueActive = selectedSession ? dialogueActiveBySessionId[selectedSession.id] ?? false : false;
  const selectedTeamId = chatTarget.teamId;
  useEffect(() => {
    let cancelled = false;
    // Only the newest request may apply — see the note in team-picker.tsx.
    let latestRequest = 0;
    const load = () => {
      const request = ++latestRequest;
      void listCachedTeamBuilderTeams()
        .then((teams) => {
          if (cancelled || request !== latestRequest) return;
          setTeamCatalog(teams);
        })
        .catch(() => {
          if (cancelled || request !== latestRequest) return;
          setTeamCatalog([]);
        });
    };
    load();
    // Teams built by the Architect appear without this panel remounting.
    const unsubscribe = subscribeToTeamBuilderTeams(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  const selectedProjectContext = selectedSession
    ? Object.prototype.hasOwnProperty.call(
        projectContextBySessionId,
        selectedSession.id,
      )
      ? projectContextBySessionId[selectedSession.id]
      : selectedRunPlan?.projectContext
    : undefined;

  /**
   * Show a line in the chat panel. Defaults to system role. `stored` is the
   * server's own copy when it already holds this line, so the chat shows it
   * once.
   */
  const handleInjectChatMessage = useCallback(
    (
      text: string,
      role: "user" | "assistant" | "system" = "system",
      stored?: StoredChatLine,
    ) => {
      chatPanelRef.current?.injectMessage({
        role,
        text,
        ...(stored ? { id: stored.id, createdAt: stored.createdAt } : {}),
      });
    },
    [],
  );
  /** Re-fetch persisted chat messages (e.g. after a delivery is persisted). */
  const handleReloadChatMessages = useCallback(() => {
    chatPanelRef.current?.reloadMessages();
  }, []);
  const handleUserMessagePresenceChange = useCallback((sessionId: string, hasUserMessage: boolean) => {
    setHasUserMessageBySessionId((current) => {
      if (current[sessionId] === hasUserMessage) return current;
      return { ...current, [sessionId]: hasUserMessage };
    });
  }, []);
  const [pendingCoordinatorBySessionId, setPendingCoordinatorBySessionId] =
    useState<Record<string, boolean>>({});
  const handlePendingResponseChange = useCallback(
    (sessionId: string, pending: boolean) => {
      setPendingCoordinatorBySessionId((current) => {
        if (current[sessionId] === pending) return current;
        return { ...current, [sessionId]: pending };
      });
    },
    [],
  );
  const handleTaskStarted = useCallback((sessionId: string, task?: SessionTask) => {
    onSessionActivityStarted?.(sessionId);
    if (task?.workflowId === "deep-research-report") {
      setLatestTaskIsDeepResearchBySessionId((current) => ({
        ...current,
        [sessionId]: true,
      }));
    }
    setTaskRefreshBySessionId((current) => ({
      ...current,
      [sessionId]: (current[sessionId] ?? 0) + 1,
    }));
  }, [onSessionActivityStarted]);

  const handleLatestTaskWorkflowChange = useCallback(
    (sessionId: string, isDeepResearch: boolean) => {
      setLatestTaskIsDeepResearchBySessionId((current) => {
        if (current[sessionId] === isDeepResearch) return current;
        return { ...current, [sessionId]: isDeepResearch };
      });
    },
    [],
  );
  const handleSelectedAgentNamesChange = useCallback(
    (names: string[]) => {
      if (!selectedSession) return;
      if (names.length < AGENT_DIALOGUE_MIN_AGENTS || names.length > AGENT_DIALOGUE_MAX_AGENTS) {
        setAgentChatModeBySessionId((current) => ({ ...current, [selectedSession.id]: "discussion" }));
      }
      setChatTargetBySessionId((current) => ({
        ...current,
        [selectedSession.id]: selectChatAgents(
          current[selectedSession.id] ?? emptyChatTarget(),
          names,
        ),
      }));
    },
    [selectedSession],
  );
  const handleAgentChatModeChange = useCallback((mode: AgentChatMode) => {
    if (!selectedSession || dialogueActive) return;
    setAgentChatModeBySessionId((current) => ({ ...current, [selectedSession.id]: mode }));
  }, [dialogueActive, selectedSession]);
  const handleDialogueActiveChange = useCallback((sessionId: string, agents: string[] | null) => {
    const active = agents !== null;
    setDialogueActiveBySessionId((current) => current[sessionId] === active ? current : { ...current, [sessionId]: active });
    if (!agents) return;
    setChatTargetBySessionId((current) => {
      const selected = current[sessionId] ?? emptyChatTarget();
      if (selected.teamId === null && selected.agentNames.length === agents.length && selected.agentNames.every((name, index) => name === agents[index])) return current;
      return { ...current, [sessionId]: selectChatAgents(selected, agents) };
    });
  }, []);
  const handleSelectedTeamIdChange = useCallback(
    (teamId: string | null) => {
      if (!selectedSession) return;
      setChatTargetBySessionId((current) => ({
        ...current,
        [selectedSession.id]: selectChatTeam(
          current[selectedSession.id] ?? emptyChatTarget(),
          teamId,
        ),
      }));
    },
    [selectedSession],
  );
  const handleProjectContextChange = useCallback(
    (selection: WorkspaceProjectContextSelection | undefined) => {
      if (!selectedSession) return;
      setProjectContextBySessionId((current) => ({
        ...current,
        [selectedSession.id]: selection,
      }));
    },
    [selectedSession],
  );
  const isDeepResearchWorkspace = Boolean(
    selectedSession &&
      shouldRenderDeepResearchWorkspace({
        latestTaskIsDeepResearch: Boolean(
          latestTaskIsDeepResearchBySessionId[selectedSession.id],
        ),
        selectedWorkflowId: selectedRunPlan?.selectedWorkflow?.id,
        ...(selectedRunPlan?.selectedWorkflow?.selectionSource
          ? { selectionSource: selectedRunPlan.selectedWorkflow.selectionSource }
          : {}),
      }),
  );

  if (workspaceView === "queue") {
    return (
      <div
        className={`min-h-0 overflow-hidden ${OVERVIEW_PANEL_PADDING}`}
        style={{ height: `calc(100dvh - ${DESKTOP_HEADER_HEIGHT_REM}rem)` }}
      >
        <QueueOverview
          error={queueError}
          loading={queueLoading}
          onOpenSession={onOpenQueueSession ?? selectSession}
          onOpenSettings={onOpenSchedulingSettings ?? (() => undefined)}
          onRefresh={onQueueRefresh ?? (async () => undefined)}
          sessions={queueSessions}
          snapshot={queueSnapshot}
        />
      </div>
    );
  }

  if (workspaceView === "schedule") {
    return (
      <div
        className={`min-h-0 overflow-hidden ${OVERVIEW_PANEL_PADDING}`}
        style={{ height: `calc(100dvh - ${DESKTOP_HEADER_HEIGHT_REM}rem)` }}
      >
        {schedulesState ? (
          <SchedulesWorkspace
            batchesState={batchesState}
            state={schedulesState}
            onOpenSession={onOpenQueueSession ?? selectSession}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Schedules are unavailable.
          </div>
        )}
      </div>
    );
  }

  return (
    <SessionTaskRuntime
      // Keyed by the selected id, which a draft already has, so materialization
      // does not remount this subtree and take the composer's text with it.
      key={selectedSessionId ?? "no-session"}
      hasUserMessage={selectedSessionHasUserMessage}
      runPlan={selectedRunPlan}
      session={selectedSession}
      sessionIsDraft={selectedSessionIsDraft}
      taskRefreshKey={
        selectedSession
          ? taskRefreshBySessionId[selectedSession.id] ?? 0
          : 0
      }
      onInjectChatMessage={handleInjectChatMessage}
      onLatestTaskWorkflowChange={handleLatestTaskWorkflowChange}
      onReloadChatMessages={handleReloadChatMessages}
      onRunPlanUpdated={handleRunPlanUpdated}
      onRunTargetLockChange={onRunTargetLockChange}
      onSessionActivityStarted={onSessionActivityStarted}
    >
      {({
        agentQuestionWaitTaskIds,
        agentQuestionReadTaskIds,
        pendingAgents,
        teamRun,
        teamStreamHandoffs,
        helperSelections,
        taskEventGroups,
        tasksController,
        timelineTasks,
        scheduledChat,
        workflowMessages,
      }) => {
        const latestTask = tasksController.tasks.at(-1);
        const hasTeamChatTask = teamRun.hasTeamChatTask;
        const historyTeamId = teamRun.teamId;
        // The Team the user is addressing now. Only their own pick counts: a
        // Team is a thing you choose to convene, and a transcript that happens
        // to hold one is not that choice.
        const targetTeamId = selectedTeamId;
        // The Team whose discussion the transcript is showing. It survives the
        // run that produced it, and it routes nothing. The run that happened
        // wins over any later pick: those members are the ones who spoke, and
        // relabelling them with another roster would rewrite the transcript.
        const presentationTeamId = historyTeamId ?? targetTeamId;
        // A Team cannot be convened twice at once. That is a statement about
        // the Team being addressed, so an unrelated run — or a finished one —
        // must not stand in the way of an Agent turn.
        const targetTeamRunActive =
          targetTeamId !== null &&
          historyTeamId === targetTeamId &&
          (latestTask?.mode === "queued" || latestTask?.mode === "running");
        const presentationTeam = teamCatalog.find(
          (team) => team.id === presentationTeamId,
        );
        const targetTeam = teamCatalog.find((team) => team.id === targetTeamId);
        // Team-scoped mentions belong to the Team being addressed, so an
        // unaddressed Team on screen must not narrow the mention catalog.
        const teamMemberNames = targetTeam?.agentNames ?? [];
        const teamMembers = configuredTeamMembers(presentationTeam, defaultModelState);
        const hasWorkflowRun =
          tasksController.tasks.length > 0 && !hasTeamChatTask;
        // A Workflow run owns the conversation while it lasts. Without this the
        // composer looked idle through a whole multi-step run: a message typed
        // into it reached the General Agent, which knows nothing about the run,
        // and the only way to end the run was the Queue overview.
        const workflowRun = getWorkflowRunState({
          tasks: tasksController.tasks,
          hasTeamChatTask,
          scheduledNotice: scheduledChat.notice,
        });
        const stoppableWorkflowTaskId = workflowRun.taskId;
        // An Agent or Team pick is a one-turn override and wins. Otherwise a
        // Workflow the user picked but the plan has not recorded yet rides
        // along, so choosing one before the first turn is not silently lost.
        const chatDispatchTarget =
          toSessionMessageTarget(chatTarget) ??
          pendingWorkflowTarget({
            manualWorkflowId: tasksController.manualWorkflowId,
            planId: selectedRunPlan?.id ?? null,
            planWorkflowId: selectedRunPlan?.selectedWorkflow?.id ?? null,
            planSelectionSource:
              selectedRunPlan?.selectedWorkflow?.selectionSource,
            isPersisting: tasksController.isSelectingWorkflow,
          });
        // Who this session's composer addresses, resolved once. Every center
        // workspace renders the same conversation, so a workspace that built
        // its own routing props could disagree with the sidebar the user
        // selected in — which is how a Deep Research turn lost its Agent.
        const chatRouting = {
          agentChatMode,
          onDialogueActiveChange: handleDialogueActiveChange,
          scheduledRunNotice: scheduledChat.notice,
          target: chatDispatchTarget,
          presentationTeamId,
          teamMemberNames,
          teamRunActive: targetTeamRunActive,
          // The run pane's Stop, reachable while the pane is closed. Offered
          // only while the addressed Team is running, so it can only ever end
          // that Team's task.
          ...(targetTeamRunActive && latestTask
            ? {
                onStopTeamRun: () =>
                  tasksController.handleCancel(latestTask.taskId),
              }
            : {}),
          // The same Stop the Queue overview offers, in the place the run was
          // started from and under the name the user chose it by.
          workflowRunNotice: workflowRun.notice,
          ...(stoppableWorkflowTaskId
            ? {
                onStopWorkflowRun: () =>
                  tasksController.handleCancel(stoppableWorkflowTaskId),
              }
            : {}),
          // The composer says what Send will do, and the answer depends on the
          // plan as much as on the target.
          runPlan: selectedRunPlan,
          contextResults,
        };
        const workflowLaunchId = showsWorkflowLaunchConfirmation({
          hasTasks: tasksController.tasks.length > 0,
          isLaunchReady: tasksController.isLaunchReady,
          activeWorkflowId: tasksController.activeWorkflowId,
          selectedWorkflowId: selectedRunPlan?.selectedWorkflow?.id ?? null,
          selectionSource: selectedRunPlan?.selectedWorkflow?.selectionSource,
        })
          ? tasksController.activeWorkflowId
          : null;
        const launchConfirmation =
          selectedSession && workflowLaunchId ? (
            <WorkflowLaunchConfirmation
              canBegin={
                tasksController.canStartRun &&
                !pendingCoordinatorBySessionId[selectedSession.id]
              }
              confirmationId={
                selectedRunPlan?.id ??
                `${selectedSession.id}:${tasksController.activeWorkflowId}`
              }
              isStarting={tasksController.isStarting}
              onBegin={() => {
                const workflowId = tasksController.activeWorkflowId;
                if (workflowId) {
                  void tasksController.handleStartTask(
                    workflowId,
                    selectedProjectContext,
                    contextResults.selectedIds,
                  );
                }
              }}
              summary={selectedRunPlan?.summary}
              workflowId={workflowLaunchId}
            />
          ) : null;
        return (
        <CanvasSession sessionId={selectedSessionIsDraft ? null : selectedSession?.id ?? null}>
        <div
          className="flex min-h-0 flex-col overflow-hidden"
          style={{ height: `calc(100dvh - ${DESKTOP_HEADER_HEIGHT_REM}rem)` }}
        >
          <ChatWorkspace className="canvas-glow">
            <div
              className={[
                "shrink-0 transition-[width,margin-right] duration-200 ease-out",
                sidebarOpen ? "mr-3 w-75 overflow-visible" : "mr-0 w-0 overflow-hidden",
              ].join(" ")}
            >
              <PanelCard className="h-full w-75">
                <SessionsSidebar
                  sessions={sessions}
                  loading={sessionsLoading}
                  error={sessionsError}
                  creating={creatingSession}
                  selectedId={selectedSessionId}
                  onSelect={selectSession}
                  onCreate={handleCreateSession}
                  onDelete={(id) => void handleDeleteSession(id)}
                />
              </PanelCard>
            </div>

            <CanvasSplit>
              <div className="h-full min-w-0 flex-1">
                {isDeepResearchWorkspace && selectedSession ? (
                  <DeepResearchWorkspace
                    key={selectedSession.id}
                    sessionId={selectedSession.id}
                    runPlan={selectedRunPlan}
                    taskRefreshKey={
                      taskRefreshBySessionId[selectedSession.id] ?? 0
                    }
                    projectContext={selectedProjectContext}
                    contextResultIds={contextResults.selectedIds}
                    onRunPlanUpdated={(plan) =>
                      handleRunPlanUpdated(selectedSession.id, plan)
                    }
                    onTaskStarted={(task) =>
                      handleTaskStarted(selectedSession.id, task)
                    }
                    renderPlanningChat={(append) => (
                      <ChatPanel
                        ref={chatPanelRef}
                        {...chatRouting}
                        researchActivityVisibility="conversation"
                        composerPlaceholder="Adjust the brief or research plan..."
                        conversationAppend={append}
                        emptyMessage="Tell me what decision or question needs evidence. I’ll turn it into a bounded brief and a research plan for your approval."
                        session={selectedSession}
                        isDraft={selectedSessionIsDraft}
                        ensureSession={ensureSession}
                        selectionPending={tasksController.isSelectingWorkflow}
                        onSessionUpdated={handleSessionUpdated}
                        onUserMessagePresenceChange={handleUserMessagePresenceChange}
                        onPendingResponseChange={handlePendingResponseChange}
                        onRunPlanUpdated={handleRunPlanUpdated}
                        onSessionActivityStarted={onSessionActivityStarted}
                        onTaskStarted={handleTaskStarted}
                        sessionTasks={timelineTasks}
                        helperSelections={helperSelections}
                        projectContext={selectedProjectContext}
                        onProjectContextChange={handleProjectContextChange}
                        workflowMessages={workflowMessages}
                        workflowPendingAgents={pendingAgents}
                        teamStreamHandoffs={teamStreamHandoffs}
                      />
                    )}
                  />
                ) : showsTeamRunWorkspace({
                    teamId: presentationTeamId,
                    hasTeamChatTask,
                    hasWorkflowRun,
                  }) ? (
                  <DiscussionWorkspace
                    eventGroups={taskEventGroups}
                    messages={workflowMessages}
                    pendingAgents={pendingAgents}
                    presentation={discussionWorkspacePresentation({
                      teamId: presentationTeamId,
                      hasTeamChatTask,
                    })}
                    teamId={presentationTeamId}
                    teamMembers={teamMembers}
                    tasks={tasksController.tasks}
                  >
                    <ChatPanel
                      ref={chatPanelRef}
                      {...chatRouting}
                      conversationAppend={launchConfirmation}
                      session={selectedSession}
                      isDraft={selectedSessionIsDraft}
                      ensureSession={ensureSession}
                      selectionPending={tasksController.isSelectingWorkflow}
                      showWorkflowMessages={hasTeamChatTask || hasWorkflowRun}
                      onSessionUpdated={handleSessionUpdated}
                      onUserMessagePresenceChange={handleUserMessagePresenceChange}
                      onPendingResponseChange={handlePendingResponseChange}
                      onSessionActivityStarted={onSessionActivityStarted}
                      onRunPlanUpdated={handleRunPlanUpdated}
                      onTaskStarted={handleTaskStarted}
                      sessionTasks={timelineTasks}
                      helperSelections={helperSelections}
                      projectContext={selectedProjectContext}
                      onProjectContextChange={handleProjectContextChange}
                      workflowMessages={workflowMessages}
                      workflowPendingAgents={pendingAgents}
                      teamStreamHandoffs={teamStreamHandoffs}
                    />
                  </DiscussionWorkspace>
                ) : (
                  <ChatPanel
                    ref={chatPanelRef}
                    {...chatRouting}
                    conversationAppend={launchConfirmation}
                    session={selectedSession}
                    isDraft={selectedSessionIsDraft}
                    ensureSession={ensureSession}
                    selectionPending={tasksController.isSelectingWorkflow}
                    onSessionUpdated={handleSessionUpdated}
                    onUserMessagePresenceChange={handleUserMessagePresenceChange}
                    onPendingResponseChange={handlePendingResponseChange}
                    onSessionActivityStarted={onSessionActivityStarted}
                    onRunPlanUpdated={handleRunPlanUpdated}
                    onTaskStarted={handleTaskStarted}
                    sessionTasks={timelineTasks}
                    helperSelections={helperSelections}
                    projectContext={selectedProjectContext}
                    onProjectContextChange={handleProjectContextChange}
                    workflowMessages={[]}
                    workflowPendingAgents={[]}
                  />
                )}
              </div>
            </CanvasSplit>
          </ChatWorkspace>

          <WorkspaceRunSidebarContent active={inspectorOpen && scheduledChat.notice === null}>
            <div
              aria-label="Run activity"
              className="h-full min-w-0"
              role="region"
            >
              <RunTargetSidebar
                key={selectedSession?.id}
                target={runTarget}
                onTargetChange={setRunTarget}
                workflowPane={
                  <RightPane
                    session={selectedSession}
                    tasksController={withQueueHolds(tasksController, queueSnapshot)}
                    agentQuestionWaitTaskIds={agentQuestionWaitTaskIds}
                    agentQuestionReadTaskIds={agentQuestionReadTaskIds}
                  />
                }
                selectedAgentNames={selectedAgentNames}
                agentChatMode={dialogueActive ? "dialogue" : agentChatMode}
                agentChatModeLocked={dialogueActive}
                onAgentChatModeChange={handleAgentChatModeChange}
                onSelectedAgentNamesChange={handleSelectedAgentNamesChange}
                selectedTeamId={targetTeamId}
                onSelectedTeamIdChange={handleSelectedTeamIdChange}
              />
            </div>
          </WorkspaceRunSidebarContent>
        </div>
        </CanvasSession>
        );
      }}
    </SessionTaskRuntime>
  );
}

function SessionTaskRuntime({
  children,
  onRunTargetLockChange,
  ...options
}: UseSessionTasksOptions & {
  children: (state: {
    pendingAgents: PendingWorkflowAgent[];
    taskEventGroups: ReturnType<typeof buildTaskEventGroups>;
    /** What each of this run's own background helpers ran on. */
    helperSelections: readonly HelperModelSelection[];
    tasksController: SessionTasksController;
    scheduledChat: ReturnType<typeof getScheduledChatState>;
    teamRun: TeamRunInHistory;
    teamStreamHandoffs: TeamStreamHandoff[];
    /** Tasks whose durable agent question is still unresolved. */
    agentQuestionWaitTaskIds: ReadonlySet<string>;
    /** Tasks whose question list has been read at the current revision. */
    agentQuestionReadTaskIds: ReadonlySet<string>;
    /** Just enough of each task for the transcript to place a naming notice. */
    timelineTasks: readonly TimelineTask[];
    workflowMessages: ReturnType<typeof buildWorkflowChatMessages>;
  }) => ReactNode;
  onRunTargetLockChange?: ((reason: RunTargetLockReason | null) => void) | undefined;
}) {
  const tasksController = useSessionTasks(options);
  /**
   * What the conversation needs to know about this session's tasks.
   *
   * A Team launch records which model named the session against the task it
   * admitted, and only the task knows which question asked for it. Narrowed to
   * those two facts on the way in, so the transcript cannot start depending on
   * the rest of a task record.
   */
  const timelineTasks = useMemo(
    () =>
      tasksController.tasks.map((task) => ({
        id: task.taskId,
        ...(task.sourceTurn ? { sourceTurn: task.sourceTurn } : {}),
      })),
    [tasksController.tasks],
  );
  const scheduledChat = getScheduledChatState(options.session, tasksController.tasks);
  const teamRun = useMemo(
    () => teamRunInHistory(tasksController.tasks),
    [tasksController.tasks],
  );
  const runTargetLockReason: RunTargetLockReason | null =
    scheduledChat.notice !== null
      ? "scheduled-research"
      : teamRun.hasTeamChatTask
        ? "team-history"
        : null;
  useLayoutEffect(() => {
    onRunTargetLockChange?.(runTargetLockReason);
    // A session view takes its lock with it when it goes away.
    return () => onRunTargetLockChange?.(null);
  }, [onRunTargetLockChange, runTargetLockReason]);
  const taskEventGroups = useMemo(
    () => buildTaskEventGroups(tasksController),
    [tasksController],
  );
  /**
   * What each of this run's own background helpers ran on.
   *
   * Read from the run's own recorded events, which carry the account each
   * helper wrote before it asked anything. Attributed to the work, never folded
   * in with a participant's own selection: naming a delegated job, compressing
   * a discussion and writing its minutes are the application's own work, not
   * any member's.
   */
  const helperSelections = useMemo(
    () => collectHelperModelSelections(taskEventGroups),
    [taskEventGroups],
  );
  const { messages: questionMessages, waitingTaskIds: agentQuestionWaitTaskIds, readTaskIds: agentQuestionReadTaskIds } = useAgentQuestions(options.session?.id, taskEventGroups.map((group) => `${group.taskId}:${group.taskActive}:${group.events.length}`).join('|'));
  const workflowMessages = useMemo(
    () => [...buildWorkflowChatMessages(taskEventGroups), ...questionMessages],
    [taskEventGroups, questionMessages],
  );
  const pendingAgents = useMemo(
    () => findPendingWorkflowAgents(taskEventGroups, { retainUntilOutcome: true }),
    [taskEventGroups],
  );
  // The run tells the UI which channel to read and which attempts exist in it,
  // so nothing here has to be requested or persisted separately.
  const teamStream = useMemo(
    () =>
      // Passed as groups, not flattened: the projection reads the newest run
      // that announced a channel, and a flat list would let a finished task's
      // ending close the run being watched now.
      buildTeamStreamDispatches(taskEventGroups),
    [taskEventGroups],
  );
  const streamedTurn = useTeamTextStream({
    sessionId: options.session?.id,
    channelId: teamStream.channelId,
  });
  const teamStreamHandoffs = useMemo(
    () =>
      resolveTeamStreamHandoff({
        streamedTurn,
        dispatches: teamStream.dispatches,
      }),
    [streamedTurn, teamStream.dispatches],
  );

  return children({
    agentQuestionWaitTaskIds,
    agentQuestionReadTaskIds,
    pendingAgents,
    taskEventGroups,
    helperSelections,
    tasksController,
    scheduledChat,
    teamRun,
    teamStreamHandoffs,
    timelineTasks,
    workflowMessages,
  });
}

/** The Team whose run this session's transcript already holds, if any. */
interface TeamRunInHistory {
  hasTeamChatTask: boolean;
  teamId: string | null;
}

/**
 * Read from the newest task alone: a Team that ran before an ordinary workflow
 * is no longer what the session is doing.
 */
function teamRunInHistory(tasks: readonly TaskRunEntry[]): TeamRunInHistory {
  const latestTask = tasks.at(-1);
  if (latestTask?.targetKind !== "team-chat") {
    return { hasTeamChatTask: false, teamId: null };
  }
  return { hasTeamChatTask: true, teamId: latestTask.teamId ?? null };
}

/**
 * The session's task entries as the live queue snapshot says their slots
 * stand, for the Run card: its reason for each held slot, and no notice for
 * a slot it no longer lists (applyQueueSnapshot).
 */
function withQueueHolds(
  tasksController: SessionTasksController,
  snapshot: SchedulingQueueSnapshot | null,
): SessionTasksController {
  if (!snapshot) return tasksController;
  return {
    ...tasksController,
    tasks: tasksController.tasks.map((task) => applyQueueSnapshot(task, snapshot)),
    activeTask: tasksController.activeTask
      ? applyQueueSnapshot(tasksController.activeTask, snapshot)
      : tasksController.activeTask,
  };
}

function buildTaskEventGroups(tasksController: SessionTasksController) {
  return tasksController.tasks.map((task) => ({
    taskActive: task.mode === "queued" || task.mode === "running",
    taskStatus: task.mode,
    taskId: task.taskId,
    taskRunId: task.runId,
    ...(task.targetKind ? { targetKind: task.targetKind } : {}),
    events: tasksController.taskEvents[task.taskId] ?? [],
  }));
}

export default RunPanel;
