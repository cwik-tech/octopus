const workflowStageTypes = [
  "routing",
  "discussion",
  "pipeline",
  "chain",
  "broadcast",
  "review",
] as const;

export type WorkflowStageType = (typeof workflowStageTypes)[number];

export const WORKFLOW_STAGE_ICON_META: Record<
  WorkflowStageType,
  { label: string; description: string }
> = {
  routing: {
    label: "Routing",
    description: "Classifies incoming work and delegates it to the right path.",
  },
  discussion: {
    label: "Discussion",
    description: "Agents exchange perspectives in moderated rounds.",
  },
  pipeline: {
    label: "Pipeline",
    description: "Executes dependent tasks in serial and parallel paths.",
  },
  chain: {
    label: "Chain",
    description: "Hands work from one agent to the next in sequence.",
  },
  broadcast: {
    label: "Broadcast",
    description: "Fans one prompt out to multiple agents and gathers their responses.",
  },
  review: {
    label: "Review",
    description: "Cycles work through production, evaluation, and revision.",
  },
};

export function isWorkflowStageType(value: string): value is WorkflowStageType {
  return (workflowStageTypes as readonly string[]).includes(value);
}
