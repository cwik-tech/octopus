import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import {
  getTaskLaunchState,
  type WorkflowSelectionState,
} from "@/components/run/tasks/task-launch-model";
import { selectSessionWorkflow } from "@/lib/clients/session-client";
import type { RunPlan, SessionSummary } from "@/lib/models/session-model";

export function useSessionWorkflowSelection({
  hasUserMessage,
  isStarting,
  onRunPlanUpdated,
  runPlan,
  session,
}: {
  hasUserMessage: boolean;
  isStarting: boolean;
  onRunPlanUpdated: (sessionId: string, plan: RunPlan) => void;
  runPlan: RunPlan | null;
  session: SessionSummary | null;
}) {
  const [workflowSelection, setWorkflowSelection] =
    useState<WorkflowSelectionState | null>(null);
  const [isSelectingWorkflow, setIsSelectingWorkflow] = useState(false);
  const selectingWorkflowRef = useRef(false);
  const planWorkflowId = runPlan?.selectedWorkflow?.id ?? null;
  const launchState = getTaskLaunchState({
    hasUserMessage,
    isSelectingWorkflow,
    isStarting,
    runPlan,
    sessionId: session?.id ?? null,
    workflowSelection,
  });

  const resetWorkflowSelection = useCallback(() => {
    setWorkflowSelection(null);
  }, []);

  const selectWorkflow = useCallback(
    (workflowId: string) => {
      if (!session || selectingWorkflowRef.current) return;
      setWorkflowSelection({
        workflowId,
        sessionId: session.id,
        planWorkflowId,
      });
      if (!runPlan) return;
      selectingWorkflowRef.current = true;
      setIsSelectingWorkflow(true);
      void selectSessionWorkflow(session.id, workflowId, runPlan.id)
        .then((plan) => {
          setWorkflowSelection(null);
          onRunPlanUpdated(session.id, plan);
        })
        .catch((error: unknown) => {
          setWorkflowSelection((current) =>
            current?.sessionId === session.id &&
            current.workflowId === workflowId
              ? null
              : current,
          );
          toast.error("Failed to select workflow", {
            description: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          selectingWorkflowRef.current = false;
          setIsSelectingWorkflow(false);
        });
    },
    [onRunPlanUpdated, planWorkflowId, runPlan, session],
  );

  return {
    ...launchState,
    isSelectingWorkflow,
    resetWorkflowSelection,
    selectWorkflow,
  };
}
