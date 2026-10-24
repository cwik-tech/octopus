import type {
  McpWorkflowCapabilityRequirement,
  StepDraft,
  TeamEntry,
  WorkflowDraft,
  WorkflowGeneratorRegistry,
  WorkflowStageType,
} from "@/lib/models/workflow-generator-model";

export function createWorkflowDraft(
  registry: WorkflowGeneratorRegistry | null,
): WorkflowDraft | null {
  const team = registry?.teams[0];
  if (!team) return null;
  const step = createStep("step-1", team);
  return {
    id: "new-workflow",
    description: "A new workflow",
    input: { artifact: "incoming-request.md" },
    steps: [step],
    output: { from_step: step.id, artifact: step.result_artifact },
    on_blocked: "stop",
    on_failed: "stop",
  };
}

export function addWorkflowStep(
  draft: WorkflowDraft,
  registry: WorkflowGeneratorRegistry | null,
): WorkflowDraft {
  const team = registry?.teams[0];
  if (!team) return draft;
  const step = createStep(nextStepId(draft), team);
  return rewireLinearWorkflow({
    ...draft,
    steps: [...draft.steps, step],
  });
}

export function insertWorkflowHumanInputStep(
  draft: WorkflowDraft,
  afterStepId: string,
): WorkflowDraft {
  const afterIndex = draft.steps.findIndex((step) => step.id === afterStepId);
  const previous = draft.steps[afterIndex];
  if (!previous || afterIndex >= draft.steps.length - 1) return draft;
  const id = nextHumanInputStepId(draft);
  const step: StepDraft = {
    id,
    type: "human-in-the-loop",
    prompt: "Review the previous result and provide guidance for the next step.",
    input_artifact: `review/${previous.id}.md`,
    result_artifact: `feedback/${id}.json`,
  };
  return rewireLinearWorkflow({
    ...draft,
    steps: [
      ...draft.steps.slice(0, afterIndex + 1),
      step,
      ...draft.steps.slice(afterIndex + 1),
    ],
  });
}

export function convertWorkflowStepToHumanInput(
  draft: WorkflowDraft,
  stepId: string,
): WorkflowDraft {
  const stepIndex = draft.steps.findIndex((step) => step.id === stepId);
  if (stepIndex < 1) return draft;

  const current = draft.steps[stepIndex];
  const previous = draft.steps[stepIndex - 1];
  if (!current || !previous || current.type === "human-in-the-loop") return draft;

  const humanInput: StepDraft = {
    id: current.id,
    type: "human-in-the-loop",
    prompt: "Review the previous result and provide guidance for the next step.",
    input_artifact: `review/${previous.id}.md`,
    result_artifact: `feedback/${current.id}.json`,
  };
  const isTerminal = stepIndex === draft.steps.length - 1;
  const continuationId = isTerminal ? nextStepId(draft) : null;
  const continuation = continuationId
    ? {
        ...current,
        id: continuationId,
        result_artifact:
          current.result_artifact === `${current.id}-result.md`
            ? `${continuationId}-result.md`
            : current.result_artifact,
        handoff: undefined,
      }
    : null;

  return rewireLinearWorkflow({
    ...draft,
    steps: [
      ...draft.steps.slice(0, stepIndex),
      humanInput,
      ...(continuation ? [continuation] : draft.steps.slice(stepIndex + 1)),
    ],
  });
}

export function updateWorkflowHumanInputPrompt(
  draft: WorkflowDraft,
  stepId: string,
  prompt: string,
): WorkflowDraft {
  return {
    ...draft,
    steps: draft.steps.map((step) =>
      step.id === stepId && step.type === "human-in-the-loop"
        ? { ...step, prompt }
        : step,
    ),
  };
}

export function removeWorkflowStep(
  draft: WorkflowDraft,
  stepId: string,
): WorkflowDraft | null {
  if (!draft.steps.some((step) => step.id === stepId)) return draft;
  if (draft.steps.length === 1) return null;
  return rewireLinearWorkflow({
    ...draft,
    steps: draft.steps.filter((step) => step.id !== stepId),
  });
}

export function renameWorkflowStep(
  draft: WorkflowDraft,
  stepId: string,
  newId: string,
): WorkflowDraft {
  if (
    !newId ||
    draft.steps.some((step) => step.id === newId && step.id !== stepId)
  ) {
    return draft;
  }
  return rewireLinearWorkflow({
    ...draft,
    steps: draft.steps.map((step) =>
      step.id === stepId ? { ...step, id: newId } : step,
    ),
  });
}

export function assignWorkflowStepTeam(
  draft: WorkflowDraft,
  registry: WorkflowGeneratorRegistry | null,
  stepId: string,
  teamId: string,
): WorkflowDraft {
  const team = registry?.teams.find((candidate) => candidate.id === teamId);
  if (!team) return draft;
  return updateTarget(draft, stepId, (step) =>
    applyTeamTarget(step, team, step.stage_type),
  );
}

export function assignWorkflowStepAgent(
  draft: WorkflowDraft,
  registry: WorkflowGeneratorRegistry | null,
  stepId: string,
  teamId: string,
  agent: string,
): WorkflowDraft {
  const team = registry?.teams.find((candidate) => candidate.id === teamId);
  if (!team?.agents.some((candidate) => candidate.name === agent)) return draft;
  return updateTarget(draft, stepId, (step) => {
    const resultArtifact = `${step.id}-result.md`;
    return {
      ...step,
      type: "agent",
      team: team.id,
      agent,
      stage_type:
        step.stage_type ??
        asWorkflowStageType(team.levels?.[0]?.stage_type) ??
        "pipeline",
      input_artifact:
        team.default_input_artifact ?? step.input_artifact ?? "incoming-brief.md",
      result_artifact: resultArtifact,
      requested_result_type: `artifact:${resultArtifact}`,
      runtime_overrides: undefined,
    };
  });
}

export function selectWorkflowStepStage(
  draft: WorkflowDraft,
  registry: WorkflowGeneratorRegistry | null,
  stepId: string,
  stageType: WorkflowStageType,
): WorkflowDraft {
  const current = draft.steps.find((step) => step.id === stepId);
  if (!current) return draft;
  if (current.type === "agent") {
    return updateTarget(draft, stepId, (step) => ({
      ...step,
      stage_type: stageType,
      runtime_overrides: undefined,
    }));
  }
  const currentTeam = registry?.teams.find((team) => team.id === current.team);
  const team = currentTeam?.levels?.some(
    (level) => level.stage_type === stageType,
  )
    ? currentTeam
    : registry?.teams.find((candidate) =>
        candidate.levels?.some((level) => level.stage_type === stageType),
      );
  if (!team) return draft;

  return updateTarget(draft, stepId, (step) =>
    applyTeamTarget(step, team, stageType),
  );
}

function updateTarget(
  draft: WorkflowDraft,
  stepId: string,
  update: (step: StepDraft) => StepDraft,
): WorkflowDraft {
  return rewireLinearWorkflow({
    ...draft,
    steps: draft.steps.map((step) =>
      step.id === stepId ? update(step) : step,
    ),
  });
}

function createStep(id: string, team: TeamEntry): StepDraft {
  return applyTeamTarget(
    {
      id,
      type: "team",
      team: team.id,
      input_artifact: team.default_input_artifact ?? "incoming-brief.md",
      result_artifact:
        team.default_output_artifact ?? `${id}-result.md`,
    },
    team,
  );
}

function applyTeamTarget(
  step: StepDraft,
  team: TeamEntry,
  preferredStage?: WorkflowStageType,
): StepDraft {
  const level =
    (preferredStage
      ? team.levels?.find((candidate) => candidate.stage_type === preferredStage)
      : undefined) ?? team.levels?.[0];
  const resultArtifact =
    level?.output_format ??
    team.default_output_artifact ??
    `${step.id}-result.md`;
  return {
    ...step,
    type: "team",
    team: team.id,
    agent: undefined,
    stage_type: asWorkflowStageType(level?.stage_type),
    input_artifact:
      team.default_input_artifact ?? step.input_artifact ?? "incoming-brief.md",
    result_artifact: resultArtifact,
    requested_result_type: `artifact:${resultArtifact}`,
    runtime_overrides: undefined,
  };
}

function asWorkflowStageType(
  value: string | undefined,
): WorkflowStageType | undefined {
  if (
    value === "routing" ||
    value === "discussion" ||
    value === "pipeline" ||
    value === "chain" ||
    value === "broadcast" ||
    value === "review"
  ) {
    return value;
  }
  return undefined;
}

function rewireLinearWorkflow(draft: WorkflowDraft): WorkflowDraft {
  const steps = draft.steps.map((step, index, allSteps) => {
    const previous = allSteps[index - 1];
    if (previous === undefined) return { ...step, handoff: undefined };
    return {
      ...step,
      handoff: {
        from_step: previous.id,
        from_artifact: previous.result_artifact,
        to_artifact: step.input_artifact,
      },
    };
  });
  const terminal = steps[steps.length - 1];
  return {
    ...draft,
    steps,
    output: terminal
      ? { from_step: terminal.id, artifact: terminal.result_artifact }
      : draft.output,
  };
}

function nextStepId(draft: WorkflowDraft): string {
  const ids = new Set(draft.steps.map((step) => step.id));
  let suffix = draft.steps.length + 1;
  while (ids.has(`step-${suffix}`)) suffix += 1;
  return `step-${suffix}`;
}

function nextHumanInputStepId(draft: WorkflowDraft): string {
  const ids = new Set(draft.steps.map((step) => step.id));
  let suffix = 1;
  while (ids.has(`human-feedback-${suffix}`)) suffix += 1;
  return `human-feedback-${suffix}`;
}

export function buildWorkflowYaml(draft: WorkflowDraft): string {
  const lines = [
    "workflow:",
    `  id: ${quote(draft.id)}`,
    ...emitText("description", draft.description, 2),
  ];
  if (draft.matches?.length) {
    lines.push("  matches:", ...draft.matches.map((item) => `    - ${quote(item)}`));
  }
  lines.push(...emitMcpRequirements(draft.mcp_requirements, 2));
  lines.push("  input:", `    artifact: ${quote(draft.input.artifact)}`, "  steps:");
  for (const step of draft.steps) lines.push(...emitStep(step));
  lines.push(
    "  output:",
    `    from_step: ${quote(draft.output.from_step)}`,
    `    artifact: ${quote(draft.output.artifact)}`,
    `  on_blocked: ${draft.on_blocked}`,
    `  on_failed: ${draft.on_failed}`,
  );
  return `${lines.join("\n")}\n`;
}

function emitStep(step: StepDraft): string[] {
  const lines = [
    `    - id: ${quote(step.id)}`,
    `      type: ${step.type}`,
  ];
  if (step.team) lines.push(`      team: ${quote(step.team)}`);
  if (step.agent) lines.push(`      agent: ${quote(step.agent)}`);
  if (step.prompt) lines.push(...emitText("prompt", step.prompt, 6));
  if (step.stage_type) lines.push(`      stage_type: ${step.stage_type}`);
  lines.push(...emitMcpRequirements(step.mcp_requirements, 6));
  lines.push(
    `      input_artifact: ${quote(step.input_artifact)}`,
    `      result_artifact: ${quote(step.result_artifact)}`,
  );
  if (step.requested_result_type) {
    lines.push(`      requested_result_type: ${quote(step.requested_result_type)}`);
  }
  if (step.brief_prefix) lines.push(...emitText("brief_prefix", step.brief_prefix, 6));
  if (step.brief_suffix) lines.push(...emitText("brief_suffix", step.brief_suffix, 6));
  if (step.include_initial_brief !== undefined) {
    lines.push(`      include_initial_brief: ${step.include_initial_brief}`);
  }
  if (step.recovery_policy) {
    lines.push(`      recovery_policy: ${step.recovery_policy}`);
  }
  const levels = step.runtime_overrides?.levels;
  if (levels && Object.keys(levels).length > 0) {
    lines.push("      runtime_overrides:", "        levels:");
    for (const [levelId, override] of Object.entries(levels)) {
      lines.push(`          ${quote(levelId)}:`);
      if (override.discussion) {
        const discussion = override.discussion;
        lines.push("            discussion:");
        if (discussion.participants?.length) {
          lines.push(
            "              participants:",
            ...discussion.participants.map((item) => `                - ${quote(item)}`),
          );
        }
        for (const key of [
          "min_rounds",
          "max_rounds",
          "min_successful_participants",
        ] as const) {
          if (discussion[key] !== undefined) {
            lines.push(`              ${key}: ${discussion[key]}`);
          }
        }
      }
      if (override.review) {
        lines.push("            review:");
        if (override.review.max_iterations !== undefined) {
          lines.push(
            `              max_iterations: ${override.review.max_iterations}`,
          );
        }
      }
    }
  }
  if (step.handoff) {
    lines.push(
      "      handoff:",
      `        from_step: ${quote(step.handoff.from_step)}`,
      `        from_artifact: ${quote(step.handoff.from_artifact)}`,
      `        to_artifact: ${quote(step.handoff.to_artifact)}`,
    );
  }
  return lines;
}

function emitMcpRequirements(
  requirements: McpWorkflowCapabilityRequirement[] | undefined,
  indent: number,
): string[] {
  if (!requirements?.length) return [];
  const pad = " ".repeat(indent);
  const lines = [`${pad}mcp_requirements:`];
  for (const requirement of requirements) {
    lines.push(
      `${pad}  - capability: ${quote(requirement.capability)}`,
      `${pad}    access: ${requirement.access}`,
      `${pad}    necessity: ${requirement.necessity}`,
    );
    if (requirement.rationale) {
      lines.push(...emitText("rationale", requirement.rationale, indent + 4));
    }
  }
  return lines;
}

function emitText(key: string, value: string, indent: number): string[] {
  const pad = " ".repeat(indent);
  if (!value.includes("\n")) return [`${pad}${key}: ${quote(value)}`];
  return [
    `${pad}${key}: |`,
    ...value.replace(/\n+$/, "").split("\n").map((line) => `${pad}  ${line}`),
  ];
}

function quote(value: string): string {
  if (value === "") return "''";
  const hasYamlSyntax = [...value].some((character) =>
    ":#&*!|>'\"%@`{}[],".includes(character),
  );
  if (
    /^(true|false|null|yes|no|on|off)$/i.test(value) ||
    /^-?\d+(\.\d+)?$/.test(value) ||
    /^\s|\s$/.test(value) ||
    hasYamlSyntax
  ) {
    return `'${value.replaceAll("'", "''")}'`;
  }
  return value;
}
