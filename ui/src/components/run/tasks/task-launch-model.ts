import type { RunPlan } from "@/lib/models/session-model";

export interface WorkflowSelectionState {
  workflowId: string;
  sessionId: string;
  planWorkflowId: string | null;
}

export interface TaskLaunchState {
  activeWorkflowId: string | null;
  /** The user's own pick, before the plan has recorded it. */
  manualWorkflowId: string | null;
  canStartRun: boolean;
  isLaunchReady: boolean;
}

export function getTaskLaunchState({
  hasUserMessage,
  isSelectingWorkflow,
  isStarting,
  runPlan,
  sessionId,
  workflowSelection,
}: {
  hasUserMessage: boolean;
  isSelectingWorkflow: boolean;
  isStarting: boolean;
  runPlan: RunPlan | null;
  sessionId: string | null;
  workflowSelection: WorkflowSelectionState | null;
}): TaskLaunchState {
  const planWorkflowId = runPlan?.selectedWorkflow?.id ?? null;
  const manualWorkflowId =
    workflowSelection &&
    workflowSelection.sessionId === sessionId &&
    workflowSelection.planWorkflowId === planWorkflowId
      ? workflowSelection.workflowId
      : null;
  const activeWorkflowId = manualWorkflowId ?? planWorkflowId;
  const hasMissingLaunchDetails =
    runPlan?.requiredInputs.some((input) => input !== "workflow selection") ??
    false;
  const isRunPlanReady = runPlan
    ? runPlan.status === "ready" && !hasMissingLaunchDetails
    : false;
  const isManualLaunchReady = !runPlan && hasUserMessage;
  const isDeepResearchApprovalReady =
    activeWorkflowId !== "deep-research-report" ||
    Boolean(
      runPlan?.deepResearchIntakeComplete === true &&
        runPlan.researchPlan?.approvedAt &&
        runPlan.researchPlan.approvalHash &&
        runPlan.researchPlan.approvalHash ===
          runPlan.researchPlanProposalHash,
    );
  const isLaunchReady = Boolean(
    activeWorkflowId &&
      (isRunPlanReady || isManualLaunchReady) &&
      isDeepResearchApprovalReady,
  );

  return {
    activeWorkflowId,
    manualWorkflowId,
    canStartRun: isLaunchReady && !isStarting && !isSelectingWorkflow,
    isLaunchReady,
  };
}
