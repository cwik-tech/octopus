import {
  AlertTriangle,
  ArrowUpRight,
  Circle,
  FileText,
  MessageSquareText,
  PenLine,
  Search,
} from "lucide-react";
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import {
  WorkspaceCompactJourneyNav,
  WorkspaceJourneyRail,
} from "@/components/run/shared/workspace-journey";
import {
  fetchDeepResearchJourney,
  type DeepResearchJourneySnapshot,
} from "@/lib/clients/deep-research-journey-client";
import { listSessionTasks } from "@/lib/clients/session-client";
import type {
  RunPlan,
  SessionTask,
  WorkspaceProjectContextSelection,
} from "@/lib/models/session-model";

import {
  DeepResearchDeliveryStage,
  DeepResearchEditorialStage,
  DeepResearchEscalationStage,
  DeepResearchResearchStage,
} from "./deep-research-stages";
import { DeepResearchPlanning } from "./deep-research-planning";
import {
  buildDeepResearchJourneyModel,
  resolveDeepResearchJourneyView,
  type DeepResearchJourneyStageId,
} from "./deep-research-journey-model";

const DEEP_RESEARCH_WORKFLOW_ID = "deep-research-report";
const ACTIVE_REFRESH_INTERVAL_MS = 1_200;

export function DeepResearchWorkspace({
  onRunPlanUpdated,
  onTaskStarted,
  renderPlanningChat,
  runPlan,
  sessionId,
  taskRefreshKey,
  projectContext,
  contextResultIds,
}: {
  onRunPlanUpdated: (plan: RunPlan) => void;
  onTaskStarted: (task: SessionTask) => void;
  renderPlanningChat: (append: ReactNode) => ReactNode;
  runPlan: RunPlan | null;
  sessionId: string;
  taskRefreshKey: number;
  projectContext?: WorkspaceProjectContextSelection | undefined;
  /** Completed results the approved workflow carries forward. */
  contextResultIds?: readonly string[];
}) {
  const [activeTask, setActiveTask] = useState<SessionTask | null>(null);
  const [snapshot, setSnapshot] =
    useState<DeepResearchJourneySnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [requestedStageId, setRequestedStageId] =
    useState<DeepResearchJourneyStageId | null>(null);

  const refresh = useCallback(async () => {
    const tasks = await listSessionTasks(sessionId);
    const latestTask = tasks.at(-1) ?? null;
    const nextTask =
      latestTask?.workflowId === DEEP_RESEARCH_WORKFLOW_ID &&
      taskBelongsToRunPlan(latestTask, runPlan)
        ? latestTask
        : null;

    setActiveTask(nextTask);
    if (!nextTask) {
      setSnapshot(null);
      setSnapshotError(null);
      return null;
    }

    try {
      const nextSnapshot = await fetchDeepResearchJourney(
        sessionId,
        nextTask.id,
      );
      startTransition(() => {
        setSnapshot(nextSnapshot);
        setSnapshotError(null);
      });
    } catch (error) {
      setSnapshotError(error instanceof Error ? error.message : String(error));
    }
    return nextTask;
  }, [runPlan, sessionId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void refresh().catch((error: unknown) => {
        setSnapshotError(error instanceof Error ? error.message : String(error));
      });
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [refresh, taskRefreshKey]);

  const currentTask =
    activeTask && taskBelongsToRunPlan(activeTask, runPlan)
      ? activeTask
      : null;
  const currentSnapshot =
    currentTask && snapshot?.taskId === currentTask.id ? snapshot : null;

  const taskIsActive =
    currentTask?.status === "queued" ||
    currentTask?.status === "running" ||
    currentTask?.status === "interrupted";

  useEffect(() => {
    if (!taskIsActive) return undefined;
    const interval = window.setInterval(() => {
      void refresh().catch((error: unknown) => {
        setSnapshotError(error instanceof Error ? error.message : String(error));
      });
    }, ACTIVE_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refresh, taskIsActive]);

  const authoritativePhase =
    currentSnapshot?.phase ?? fallbackPhase(currentTask);
  const journeyModel = useMemo(
    () =>
      buildDeepResearchJourneyModel({
        correctionWave: currentSnapshot?.research?.correctionWave,
        phase: authoritativePhase,
        researchStatus: currentSnapshot?.research?.status,
      }),
    [authoritativePhase, currentSnapshot?.research?.correctionWave, currentSnapshot?.research?.status],
  );
  const journeyView = useMemo(
    () => resolveDeepResearchJourneyView(journeyModel, requestedStageId),
    [journeyModel, requestedStageId],
  );
  const selectedStage = journeyModel.stages.find(
    (stage) => stage.id === journeyView.selectedStageId,
  );

  const planningAppend = (
    <DeepResearchPlanning
      activeTask={currentTask}
      onRunPlanUpdated={onRunPlanUpdated}
      onTaskStarted={(task) => {
        setActiveTask(task);
        setRequestedStageId(null);
        onTaskStarted(task);
        void refresh();
      }}
      runPlan={runPlan}
      sessionId={sessionId}
      projectContext={projectContext}
      contextResultIds={contextResultIds}
    />
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 overflow-hidden" data-testid="deep-research-workspace">
      <WorkspaceJourneyRail
        ariaLabel="Deep Research Journey"
        liveStageId={journeyView.liveStageId}
        onSelect={(stageId) =>
          setRequestedStageId(
            stageId === journeyView.liveStageId ? null : stageId,
          )
        }
        renderIcon={(stage) => stageIcon(stage.id)}
        selectedStageId={journeyView.selectedStageId}
        stages={journeyModel.stages}
        title="Research Journey"
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-3 sm:px-4">
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-foreground">
              Deep Research
              <span className="mx-1.5 text-muted-foreground">/</span>
              {selectedStage?.label ?? "Journey"}
            </div>
            <div className="text-xs text-muted-foreground xl:hidden">
              Step {selectedStage?.stepNumber ?? 1} of {journeyModel.totalStageCount}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {currentSnapshot?.integrity === "partial" ? (
              <span className="hidden items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400 sm:flex">
                <AlertTriangle className="size-3" />
                Partial runtime data
              </span>
            ) : null}
            {journeyView.canReturnToLive ? (
              <Button
                onClick={() => setRequestedStageId(null)}
                size="sm"
                type="button"
                variant="outline"
              >
                Return to live
                <ArrowUpRight className="size-3.5" />
              </Button>
            ) : (
              <span
                className={[
                  "inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-semibold uppercase tracking-wide",
                  authoritativePhase === "escalation"
                    ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                    : "bg-orange-500/10 text-orange-600 ring-1 ring-orange-500/30 dark:text-orange-400",
                ].join(" ")}
              >
                <span
                  className={[
                    "size-1.5 rounded-full",
                    authoritativePhase === "escalation"
                      ? "bg-amber-500"
                      : "animate-pulse bg-orange-500 motion-reduce:animate-none",
                  ].join(" ")}
                />
                {authoritativePhase === "escalation"
                  ? "Attention Required"
                  : "Live Stage"}
              </span>
            )}
          </div>
        </div>

        <WorkspaceCompactJourneyNav
          onSelect={(stageId) =>
            setRequestedStageId(
              stageId === journeyView.liveStageId ? null : stageId,
            )
          }
          renderIcon={(stage) => stageIcon(stage.id)}
          selectedStageId={journeyView.selectedStageId}
          stages={journeyModel.stages}
        />

        {snapshotError && currentTask ? (
          <div className="shrink-0 border-b border-amber-500/25 bg-amber-500/8 px-4 py-2 text-xs text-amber-800 dark:text-amber-300" role="status">
            The durable journey snapshot is temporarily unavailable. Showing the
            last verified stage: {snapshotError}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-hidden">
          {journeyView.selectedStageId === "planning"
            ? renderPlanningChat(planningAppend)
            : null}
          {journeyView.selectedStageId === "research" ? (
            <DeepResearchResearchStage
              snapshot={currentSnapshot}
              taskRunId={currentTask?.runId ?? null}
            />
          ) : null}
          {journeyView.selectedStageId === "editorial" ? (
            <DeepResearchEditorialStage snapshot={currentSnapshot} />
          ) : null}
          {journeyView.selectedStageId === "escalation" ? (
            <DeepResearchEscalationStage snapshot={currentSnapshot} />
          ) : null}
          {journeyView.selectedStageId === "delivery" ? (
            <DeepResearchDeliveryStage snapshot={currentSnapshot} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function stageIcon(stageId: DeepResearchJourneyStageId) {
  switch (stageId) {
    case "planning":
      return <MessageSquareText className="size-3.5" />;
    case "research":
      return <Search className="size-3.5" />;
    case "editorial":
      return <PenLine className="size-3.5" />;
    case "escalation":
      return <AlertTriangle className="size-3.5" />;
    case "delivery":
      return <FileText className="size-3.5" />;
    default:
      return <Circle className="size-3.5" />;
  }
}

function fallbackPhase(task: SessionTask | null): DeepResearchJourneyStageId {
  if (!task) return "planning";
  if (task.status === "done") return "delivery";
  return "research";
}

function taskBelongsToRunPlan(
  task: SessionTask,
  runPlan: RunPlan | null,
): boolean {
  if (task.runPlanId) return !runPlan || task.runPlanId === runPlan.id;
  if (!runPlan) return true;
  if (["done", "failed", "blocked", "cancelled"].includes(task.status)) {
    return runPlan.status === "completed" || runPlan.status === "failed";
  }
  return ["applying", "queued", "running"].includes(runPlan.status);
}
