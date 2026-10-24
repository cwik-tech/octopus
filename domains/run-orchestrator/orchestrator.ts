import { whenDefined } from "../../core/optional-properties.js"
import { randomUUID } from "node:crypto";

import type { ChatMessage, SessionFile } from "../../contracts/sessions.js";
import type { WorkflowSummaryWithTags } from "../../contracts/workflows.js";
import type {
  RunPlan,
  RunPlanSelectionSource,
  RunPlanAction,
  RunPlanEvent,
  RunPlanWorkflowSelection,
} from "./types.js";
import { significantTextTokens } from "../../core/text-tokens.js";
import { enforceDeepResearchPlanReadiness } from "./deep-research.js";

export type BriefReadinessPolicy = "detailed" | "non-empty";

export interface CreateRunPlanInput {
  goal: string;
  workflows: WorkflowSummaryWithTags[];
  workflowId?: string;
  workflowSelection?: RunPlanWorkflowSelection;
  /**
   * Who chose the workflow, when this call is making the choice.
   *
   * Absent leaves an existing selection's provenance untouched, so a Coordinator
   * turn re-planning around a user's pick cannot quietly demote it.
   */
  selectionSource?: RunPlanSelectionSource;
  briefReadinessPolicy?: BriefReadinessPolicy;
  history?: ChatMessage[];
  files?: SessionFile[];
}

export function createRunPlan(input: CreateRunPlanInput): RunPlan {
  const goal = input.goal.trim();
  const contextText = buildContextText(goal, input.history);
  const userContextText = buildUserContextText(goal, input.history);
  const warnings: string[] = [];
  const requiredInputs: string[] = [];
  const actions: RunPlanAction[] = [];
  const requestedWorkflowId =
    input.workflowSelection?.id ?? input.workflowId;

  const selectedWorkflow = resolveExplicitWorkflowSelection({
    workflows: input.workflows,
    ...whenDefined(requestedWorkflowId, (definedValue) => ({ workflowId: definedValue })),
    ...whenDefined(input.workflowSelection, (definedValue) => ({ workflowSelection: definedValue })),
    ...whenDefined(input.selectionSource, (definedValue) => ({ selectionSource: definedValue })),
  });
  const briefReadiness = assessBriefReadiness({
    ...whenDefined(input.files, (definedValue) => ({ files: definedValue })),
    ...whenDefined(selectedWorkflow, (definedValue) => ({ selectedWorkflow: definedValue })),
    policy: input.briefReadinessPolicy ?? "detailed",
    userContextText,
  });

  if (!briefReadiness.ready) {
    requiredInputs.push(...briefReadiness.requiredInputs);
    actions.push({
      id: "collect-input",
      type: "collect_input",
      status: "needs_input",
      title: "Collect task details",
      rationale: briefReadiness.rationale,
    });
  }

  if (input.workflows.length === 0) {
    warnings.push("No workflows are registered.");
    requiredInputs.push("registered workflow");
  } else if (!selectedWorkflow) {
    if (requestedWorkflowId) {
      warnings.push(`Requested workflow ${requestedWorkflowId} is not registered.`);
    }
    requiredInputs.push("workflow selection");
    actions.push({
      id: "select-workflow",
      type: "select_workflow",
      status: "needs_input",
      title: "Select workflow",
      rationale: "No workflow has been selected.",
    });
  } else {
    actions.push({
      id: "select-workflow",
      type: "select_workflow",
      status: "completed",
      title: `Select ${selectedWorkflow.id}`,
      rationale: selectedWorkflow.rationale,
      workflowId: selectedWorkflow.id,
    });
  }

  actions.push({
    id: "launch-workflow",
    type: "launch_workflow",
    status: selectedWorkflow && briefReadiness.ready ? "ready" : "pending",
    title: selectedWorkflow
      ? `Launch ${selectedWorkflow.id}`
      : "Launch selected workflow",
    rationale: selectedWorkflow
      ? "The selected workflow can execute deterministically once applied."
      : "Workflow launch is pending a workflow selection.",
    ...whenDefined(selectedWorkflow?.id, (definedValue) => ({ workflowId: definedValue })),
  });

  const status = selectedWorkflow && briefReadiness.ready ? "ready" : "needs_input";

  return enforceDeepResearchPlanReadiness({
    id: `run-plan-${randomUUID()}`,
    goal,
    summary: summarizeRunPlan(selectedWorkflow, requiredInputs),
    status,
    ...whenDefined(selectedWorkflow, (definedValue) => ({ selectedWorkflow: definedValue })),
    requiredInputs: Array.from(new Set(requiredInputs)),
    ...whenDefined(contextText || undefined, (definedValue) => ({ brief: definedValue })),
    actions,
    warnings,
    createdAt: new Date().toISOString(),
  });
}

function assessBriefReadiness(params: {
  files?: SessionFile[];
  policy: BriefReadinessPolicy;
  selectedWorkflow?: RunPlanWorkflowSelection;
  userContextText: string;
}): {
  ready: boolean;
  requiredInputs: string[];
  rationale: string;
} {
  if ((params.files?.length ?? 0) > 0) {
    return {
      ready: true,
      requiredInputs: [],
      rationale: "Uploaded files provide source context for the run.",
    };
  }

  const trimmed = params.userContextText.trim();
  if (!trimmed) {
    return {
      ready: false,
      requiredInputs: ["task brief"],
      rationale: "The run needs a user goal, chat context, or uploaded file before launching.",
    };
  }

  if (params.policy === "non-empty") {
    return {
      ready: true,
      requiredInputs: [],
      rationale: "The conversational prompt is ready for Team chat.",
    };
  }

  const tokens = meaningfulBriefTokens(trimmed);
  if (tokens.length >= 5 || trimmed.length >= 120) {
    return {
      ready: true,
      requiredInputs: [],
      rationale: "The user brief contains enough concrete context to launch.",
    };
  }

  return {
    ready: false,
    requiredInputs: params.selectedWorkflow
      ? ["specific task details"]
      : ["specific task details", "workflow selection"],
    rationale:
      "The selected workflow has a thin brief; ask for concrete topic, audience, goal, constraints, or source context before launch.",
  };
}

export function markRunPlanApplying(plan: RunPlan): RunPlan {
  return {
    ...plan,
    status: "applying",
    updatedAt: new Date().toISOString(),
    actions: plan.actions.map((action) =>
      action.type === "launch_workflow"
        ? { ...action, status: "running" }
        : action,
    ),
  };
}

export function markRunPlanQueued(plan: RunPlan, taskId: string): RunPlan {
  return {
    ...withoutApplyClaim(plan),
    status: "queued",
    taskId,
    updatedAt: new Date().toISOString(),
    actions: plan.actions.map((action) =>
      action.type === "launch_workflow"
        ? { ...action, status: "queued" }
        : action,
    ),
  };
}

export function markRunPlanRunning(plan: RunPlan, taskId?: string): RunPlan {
  return {
    ...withoutApplyClaim(plan),
    status: "running",
    ...(taskId ? { taskId } : {}),
    updatedAt: new Date().toISOString(),
    actions: plan.actions.map((action) =>
      action.type === "launch_workflow"
        ? { ...action, status: "completed" }
        : action,
    ),
  };
}

export function markRunPlanNeedsInput(plan: RunPlan): RunPlan {
  return {
    ...withoutApplyClaim(plan),
    status: "needs_input",
    updatedAt: new Date().toISOString(),
    actions: plan.actions.map((action) =>
      action.type === "collect_input"
        ? { ...action, status: "needs_input" }
        : action,
    ),
  };
}

export function markRunPlanFailed(plan: RunPlan): RunPlan {
  return markRunPlanTerminal(plan, "failed");
}

export function markRunPlanTerminal(
  plan: RunPlan,
  status: "completed" | "failed" | "blocked" | "cancelled",
  error?: string,
): RunPlan {
  const completedAt = new Date().toISOString();
  return {
    ...withoutApplyClaim(plan),
    status,
    updatedAt: completedAt,
    completedAt,
    ...(error ? { error } : {}),
    actions: plan.actions.map((action) =>
      action.type === "launch_workflow"
        ? { ...action, status }
        : action,
    ),
  };
}

function withoutApplyClaim(plan: RunPlan): RunPlan {
  const next = { ...plan };
  delete next.applyClaimId;
  delete next.applyClaimOwnerInstanceId;
  delete next.applyClaimOwnerPid;
  delete next.applyClaimedAt;
  return next;
}

export function pushRunPlanEvent(
  events: RunPlanEvent[],
  event: Omit<RunPlanEvent, "id">,
): void {
  events.push({ id: events.length + 1, ...event });
}

function resolveExplicitWorkflowSelection(params: {
  workflows: WorkflowSummaryWithTags[];
  workflowId?: string;
  workflowSelection?: RunPlanWorkflowSelection;
  selectionSource?: RunPlanSelectionSource;
}): RunPlanWorkflowSelection | undefined {
  if (!params.workflowId) return undefined;
  const direct = params.workflows.find(
    (workflow) => workflow.id === params.workflowId,
  );
  if (!direct) return undefined;
  if (params.workflowSelection?.id === direct.id) {
    // An explicit provenance on this call wins; otherwise the carried
    // selection keeps whatever it already recorded, so re-planning around a
    // user's pick cannot silently turn it into a recommendation.
    return {
      ...params.workflowSelection,
      ...whenDefined(params.selectionSource, (selectionSource) => ({
        selectionSource,
      })),
    };
  }
  return {
    id: direct.id,
    confidence: "high",
    rationale: `Workflow ${direct.id} was explicitly selected.`,
    ...whenDefined(params.selectionSource, (selectionSource) => ({
      selectionSource,
    })),
  };
}

function buildContextText(goal: string, history?: ChatMessage[]): string {
  const chatContext = (history ?? [])
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-12)
    .map((message) => `${message.role.toUpperCase()}: ${message.text}`)
    .join("\n\n");
  const trimmedGoal = goal.trim();
  if (!trimmedGoal) return chatContext.trim();
  if (!chatContext.trim()) return trimmedGoal;

  const lastUserMessage = [...(history ?? [])]
    .reverse()
    .find((message) => message.role === "user");
  if (lastUserMessage?.text.trim() === trimmedGoal) {
    return chatContext.trim();
  }
  return `${chatContext.trim()}\n\nCURRENT USER REQUEST: ${trimmedGoal}`;
}

function buildUserContextText(goal: string, history?: ChatMessage[]): string {
  const userContext = (history ?? [])
    .filter((message) => message.role === "user")
    .slice(-8)
    .map((message) => message.text)
    .join("\n\n");
  const trimmedGoal = goal.trim();
  if (!trimmedGoal) return userContext.trim();
  if (!userContext.trim()) return trimmedGoal;

  const lastUserMessage = [...(history ?? [])]
    .reverse()
    .find((message) => message.role === "user");
  if (lastUserMessage?.text.trim() === trimmedGoal) {
    return userContext.trim();
  }
  return `${userContext.trim()}\n\n${trimmedGoal}`;
}

function meaningfulBriefTokens(text: string): string[] {
  return significantTextTokens(text).filter(
    (token) =>
      ![
        "build",
        "creating",
        "generate",
        "good",
        "like",
        "make",
        "okay",
        "plan",
        "planning",
        "right",
        "site",
        "start",
        "structure",
        "sure",
        "website",
        "want",
        "yes",
      ].includes(token),
  );
}

function summarizeRunPlan(
  selectedWorkflow: RunPlanWorkflowSelection | undefined,
  requiredInputs: string[],
): string {
  if (selectedWorkflow && requiredInputs.length === 0) {
    return `Ready to launch workflow ${selectedWorkflow.id}.`;
  }
  if (selectedWorkflow) {
    return `Workflow ${selectedWorkflow.id} is selected, but more input is required.`;
  }
  return "Run needs more input before a workflow can be launched.";
}
