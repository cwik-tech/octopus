import { whenDefined } from '../../core/optional-properties.js'
import type { RunPlan } from "../../contracts/run-plan.js";
import type {
  SessionTask,
  TaskStatus,
} from "../../contracts/sessions.js";
import type { TaskRecordCompareAndSetOptions } from "./session-task-repository.js";

export function resetRunPlanApplyClaim(
  plan: RunPlan,
  updatedAt: string,
): RunPlan {
  const next = clearRunPlanApplyClaim({
    ...plan,
    status: "ready",
    updatedAt,
    actions: plan.actions.map((action) =>
      action.type === "launch_workflow"
        ? { ...action, status: "ready" }
        : action,
    ),
  });
  delete next.taskId;
  delete next.completedAt;
  delete next.error;
  return next;
}

export function clearRunPlanApplyClaim(plan: RunPlan): RunPlan {
  const next = { ...plan };
  delete next.applyClaimId;
  delete next.applyClaimOwnerInstanceId;
  delete next.applyClaimOwnerPid;
  delete next.applyClaimedAt;
  return next;
}

export function isTerminalRunPlanStatus(status: RunPlan["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "blocked" ||
    status === "cancelled"
  );
}

export function isRunPlanRevisionBlocked(status: RunPlan["status"]): boolean {
  return status === "applying" || status === "queued" || status === "running";
}

export function taskStatusToRunPlanStatus(
  status: TaskStatus,
): "completed" | "failed" | "blocked" | "cancelled" {
  if (status === "done") return "completed";
  if (status === "blocked") return "blocked";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

export function taskAdmissionFence(
  task: SessionTask,
): TaskRecordCompareAndSetOptions {
  return {
    ...whenDefined(task.executionAttemptId, (expectedExecutionAttemptId) => ({ expectedExecutionAttemptId })),
    ...(task.admission
      ? {
          expectedAdmissionRequestId: task.admission.requestId,
          expectedAdmissionPhase: task.admission.phase,
          ...(task.admission.phase === "granted"
            ? {
                expectedAdmissionGrantId: task.admission.grantId,
                expectedAdmissionOwnerEpoch: task.admission.ownerEpoch,
              }
            : {}),
        }
      : {}),
  };
}
