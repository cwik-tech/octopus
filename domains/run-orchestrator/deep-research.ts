import {
  hashUnapprovedResearchPlan,
  isResearchPlanApprovalValid,
} from "../deep-research/deep-research-approval.js";
import type { RunPlan, RunPlanAction } from "./types.js";

export const DEEP_RESEARCH_WORKFLOW_ID = "deep-research-report" as const;
export const DEEP_RESEARCH_INTAKE_REQUIRED_INPUT =
  "deep research brief details" as const;
export const RESEARCH_PLAN_REQUIRED_INPUT = "research plan" as const;
export const RESEARCH_PLAN_APPROVAL_REQUIRED_INPUT =
  "research plan approval" as const;
export const DEFAULT_DEEP_RESEARCH_LOOKBACK_MONTHS = 24;

export const DEEP_RESEARCH_INTAKE_FIELDS = [
  "target audience",
  "research objective and output",
  "scope and comparison criteria",
  "jurisdiction or no geographic constraint",
  "exclusions or no exclusions",
] as const;

export type DeepResearchIntakeField =
  (typeof DEEP_RESEARCH_INTAKE_FIELDS)[number];

const RESEARCH_INPUTS = new Set<string>([
  RESEARCH_PLAN_REQUIRED_INPUT,
  RESEARCH_PLAN_APPROVAL_REQUIRED_INPUT,
]);

const LEGACY_DEEP_RESEARCH_INTAKE_FIELDS = [
  "freshness boundary",
  "must-includes and exclusions",
] as const;

const MANAGED_DEEP_RESEARCH_INPUTS = new Set<string>([
  "task brief",
  "specific task details",
  DEEP_RESEARCH_INTAKE_REQUIRED_INPUT,
  ...DEEP_RESEARCH_INTAKE_FIELDS,
  ...LEGACY_DEEP_RESEARCH_INTAKE_FIELDS,
  ...RESEARCH_INPUTS,
]);

/**
 * Make Deep Research readiness derive from the persisted proposal and its
 * cryptographic approval, never from a client-supplied status flag.
 */
export function enforceDeepResearchPlanReadiness(plan: RunPlan): RunPlan {
  if (plan.selectedWorkflow?.id !== DEEP_RESEARCH_WORKFLOW_ID) return plan;
  if (!["draft", "ready", "needs_input"].includes(plan.status)) return plan;

  const intakeComplete = isDeepResearchIntakeComplete(plan);
  const ordinaryInputs = plan.requiredInputs.filter(
    (input) => !MANAGED_DEEP_RESEARCH_INPUTS.has(input),
  );
  const intakeInputs = intakeComplete
    ? []
    : plan.requiredInputs.filter((input) =>
        DEEP_RESEARCH_INTAKE_FIELDS.includes(
          input as DeepResearchIntakeField,
        ),
      );
  const researchInput = requiredResearchInput(plan);
  const requiredInputs = [
    ...ordinaryInputs,
    ...(intakeComplete
      ? []
      : intakeInputs.length > 0
        ? intakeInputs
        : [DEEP_RESEARCH_INTAKE_REQUIRED_INPUT]),
    ...(researchInput ? [researchInput] : []),
  ];
  const ready = requiredInputs.length === 0;

  return {
    ...plan,
    deepResearchIntakeComplete: intakeComplete,
    status: ready ? "ready" : "needs_input",
    requiredInputs,
    summary: ready
      ? "Deep Research plan approved and ready to launch."
      : !intakeComplete
        ? "Deep Research needs a confirmed research brief before planning."
        : researchInput === RESEARCH_PLAN_REQUIRED_INPUT
          ? "Deep Research needs a section and task plan before launch."
          : researchInput === RESEARCH_PLAN_APPROVAL_REQUIRED_INPUT
            ? "Deep Research plan is waiting for exact user approval."
            : plan.summary,
    actions: updateLaunchAction(plan.actions, ready),
  };
}

/** Replace heuristic brief inputs with the receptionist's explicit intake result. */
export function applyDeepResearchIntakeDecision(
  plan: RunPlan,
  missingInputs: readonly DeepResearchIntakeField[],
): RunPlan {
  if (!isDeepResearchRunPlan(plan)) return plan;
  const unmanagedInputs = plan.requiredInputs.filter(
    (input) => !MANAGED_DEEP_RESEARCH_INPUTS.has(input),
  );
  return enforceDeepResearchPlanReadiness({
    ...plan,
    deepResearchIntakeComplete: missingInputs.length === 0,
    requiredInputs: [...unmanagedInputs, ...missingInputs],
  });
}

export function isDeepResearchIntakeComplete(plan: RunPlan): boolean {
  return plan.deepResearchIntakeComplete === true;
}

export function isDeepResearchRunPlan(plan: RunPlan): boolean {
  return plan.selectedWorkflow?.id === DEEP_RESEARCH_WORKFLOW_ID;
}

function requiredResearchInput(plan: RunPlan): string | undefined {
  if (!plan.researchPlan || !plan.researchPlanProposalHash) {
    return RESEARCH_PLAN_REQUIRED_INPUT;
  }

  let currentHash: string;
  try {
    currentHash = hashUnapprovedResearchPlan(plan.researchPlan);
  } catch {
    return RESEARCH_PLAN_REQUIRED_INPUT;
  }

  if (
    currentHash !== plan.researchPlanProposalHash ||
    !isResearchPlanApprovalValid(plan.researchPlan)
  ) {
    return RESEARCH_PLAN_APPROVAL_REQUIRED_INPUT;
  }
  return undefined;
}

function updateLaunchAction(
  actions: RunPlanAction[],
  ready: boolean,
): RunPlanAction[] {
  return actions.map((action) =>
    action.type === "launch_workflow"
      ? {
          ...action,
          status: ready ? "ready" : "pending",
          rationale: ready
            ? "The exact approved Deep Research plan is ready for execution."
            : "Launch is blocked until the Deep Research plan is generated and approved.",
        }
      : action,
  );
}
