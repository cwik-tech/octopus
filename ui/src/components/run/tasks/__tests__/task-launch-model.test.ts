import { describe, expect, it } from "vitest";

import { getTaskLaunchState } from "@/components/run/tasks/task-launch-model";
import type { RunPlan } from "@/lib/models/session-model";

function runPlan(overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    id: "plan-1",
    goal: "Complete the work",
    summary: "Ready",
    status: "ready",
    selectedWorkflow: {
      id: "workflow-1",
      confidence: "high",
      rationale: "Selected",
    },
    requiredInputs: [],
    actions: [],
    warnings: [],
    createdAt: "2026-07-21T12:00:00.000Z",
    ...overrides,
  };
}

describe("getTaskLaunchState", () => {
  it("requires a ready plan without unresolved task details", () => {
    expect(
      getTaskLaunchState({
        hasUserMessage: true,
        isSelectingWorkflow: false,
        isStarting: false,
        runPlan: runPlan({ requiredInputs: ["audience"] }),
        sessionId: "session-1",
        workflowSelection: null,
      }),
    ).toEqual({
      activeWorkflowId: "workflow-1",
      manualWorkflowId: null,
      canStartRun: false,
      isLaunchReady: false,
    });
  });

  it("uses a manual selection only for the same session and plan workflow", () => {
    const state = getTaskLaunchState({
      hasUserMessage: true,
      isSelectingWorkflow: false,
      isStarting: false,
      runPlan: runPlan(),
      sessionId: "session-1",
      workflowSelection: {
        workflowId: "manual-workflow",
        sessionId: "session-1",
        planWorkflowId: "stale-plan-workflow",
      },
    });
    expect(state.activeWorkflowId).toBe("workflow-1");
    expect(state.canStartRun).toBe(true);
    expect(state.isLaunchReady).toBe(true);
  });

  it("keeps a ready launch visible while its request is in flight", () => {
    expect(
      getTaskLaunchState({
        hasUserMessage: true,
        isSelectingWorkflow: false,
        isStarting: true,
        runPlan: runPlan(),
        sessionId: "session-1",
        workflowSelection: null,
      }),
    ).toEqual({
      activeWorkflowId: "workflow-1",
      manualWorkflowId: null,
      canStartRun: false,
      isLaunchReady: true,
    });
  });

  it("keeps Deep Research blocked until the approved hash matches", () => {
    const state = getTaskLaunchState({
      hasUserMessage: true,
      isSelectingWorkflow: false,
      isStarting: false,
      runPlan: runPlan({
        selectedWorkflow: {
          id: "deep-research-report",
          confidence: "high",
          rationale: "Research requested",
        },
        deepResearchIntakeComplete: true,
        researchPlanProposalHash: "proposal-hash",
      }),
      sessionId: "session-1",
      workflowSelection: null,
    });
    expect(state).toEqual({
      activeWorkflowId: "deep-research-report",
      manualWorkflowId: null,
      canStartRun: false,
      isLaunchReady: false,
    });
  });
});
