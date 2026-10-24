import { describe, expect, it } from "vitest";

import type { WorkflowGeneratorRegistry } from "@/lib/models/workflow-generator-model";
import {
  addWorkflowStep,
  assignWorkflowStepAgent,
  buildWorkflowYaml,
  convertWorkflowStepToHumanInput,
  createWorkflowDraft,
  insertWorkflowHumanInputStep,
  removeWorkflowStep,
  renameWorkflowStep,
  selectWorkflowStepStage,
  updateWorkflowHumanInputPrompt,
} from "@/lib/utils/workflow-yaml-helpers";

const registry: WorkflowGeneratorRegistry = {
  teams: [
    {
      id: "problem-thinking-board",
      default_input_artifact: "incoming-brief.md",
      default_output_artifact: "output/decomposition-plan.md",
      has_discussion_level: true,
      has_review_level: false,
      level_ids: ["deliberation"],
      levels: [
        {
          id: "deliberation",
          stage_type: "discussion",
          output_format: "output/decomposition-plan.md",
        },
      ],
      agents: [{ name: "contrarian", role: "Challenges assumptions" }],
    },
    {
      id: "writing-team",
      default_input_artifact: "incoming-brief.md",
      default_output_artifact: "final-draft.md",
      has_discussion_level: false,
      has_review_level: true,
      level_ids: ["brief-and-draft", "editorial-review"],
      levels: [
        {
          id: "brief-and-draft",
          stage_type: "chain",
          output_format: "draft-package.md",
        },
        {
          id: "editorial-review",
          stage_type: "review",
          output_format: "final-draft.md",
        },
      ],
      agents: [
        { name: "writer", role: "Writes drafts" },
        { name: "editor", role: "Reviews drafts" },
      ],
    },
  ],
};

describe("visual workflow draft operations", () => {
  it("creates schema-complete steps and keeps linear handoffs and output wired", () => {
    const initial = createWorkflowDraft(registry);
    expect(initial).not.toBeNull();
    expect(initial?.steps[0]).toMatchObject({
      type: "team",
      team: "problem-thinking-board",
      stage_type: "discussion",
      input_artifact: "incoming-brief.md",
      result_artifact: "output/decomposition-plan.md",
    });

    const added = addWorkflowStep(initial!, registry);
    expect(added.steps).toHaveLength(2);
    expect(added.steps[1]?.handoff).toEqual({
      from_step: "step-1",
      from_artifact: "output/decomposition-plan.md",
      to_artifact: "incoming-brief.md",
    });
    expect(added.output).toEqual({
      from_step: "step-2",
      artifact: "output/decomposition-plan.md",
    });

    const renamed = renameWorkflowStep(added, "step-1", "research");
    expect(renamed.steps[1]?.handoff?.from_step).toBe("research");

    const removed = removeWorkflowStep(renamed, "research");
    expect(removed).not.toBeNull();
    expect(removed?.steps).toHaveLength(1);
    expect(removed?.steps[0]?.handoff).toBeUndefined();
    expect(removed?.output.from_step).toBe("step-2");
    expect(removeWorkflowStep(removed!, "step-2")).toBeNull();
  });

  it("persists stage selection and a concrete hosted agent in emitted YAML", () => {
    const initial = createWorkflowDraft(registry)!;
    const chain = selectWorkflowStepStage(initial, registry, "step-1", "chain");
    expect(chain.steps[0]).toMatchObject({
      type: "team",
      team: "writing-team",
      stage_type: "chain",
      result_artifact: "draft-package.md",
    });

    const assigned = assignWorkflowStepAgent(
      chain,
      registry,
      "step-1",
      "writing-team",
      "writer",
    );
    expect(assigned.steps[0]).toMatchObject({
      type: "agent",
      team: "writing-team",
      agent: "writer",
      stage_type: "chain",
      result_artifact: "step-1-result.md",
    });

    const yaml = buildWorkflowYaml(assigned);
    expect(yaml).toContain("type: agent");
    expect(yaml).toContain("agent: writer");
    expect(yaml).toContain("stage_type: chain");
    expect(yaml).toContain("result_artifact: step-1-result.md");
  });

  it("inserts a human feedback boundary and rewires the successor", () => {
    const twoStep = addWorkflowStep(createWorkflowDraft(registry)!, registry);
    const inserted = insertWorkflowHumanInputStep(twoStep, "step-1");

    expect(inserted.steps).toHaveLength(3);
    expect(inserted.steps[1]).toEqual({
      id: "human-feedback-1",
      type: "human-in-the-loop",
      prompt: "Review the previous result and provide guidance for the next step.",
      input_artifact: "review/step-1.md",
      result_artifact: "feedback/human-feedback-1.json",
      handoff: {
        from_step: "step-1",
        from_artifact: "output/decomposition-plan.md",
        to_artifact: "review/step-1.md",
      },
    });
    expect(inserted.steps[2]?.handoff).toEqual({
      from_step: "human-feedback-1",
      from_artifact: "feedback/human-feedback-1.json",
      to_artifact: "incoming-brief.md",
    });
    expect(buildWorkflowYaml(inserted)).not.toContain(
      "type: human-in-the-loop\n      team:",
    );
    const prompted = updateWorkflowHumanInputPrompt(
      inserted,
      "human-feedback-1",
      "Focus on delivery risk.",
    );
    expect(buildWorkflowYaml(prompted)).toContain("prompt: Focus on delivery risk.");
  });

  it("turns the selected terminal step into a human boundary and preserves its execution as the successor", () => {
    const twoStep = addWorkflowStep(createWorkflowDraft(registry)!, registry);
    const converted = convertWorkflowStepToHumanInput(twoStep, "step-2");

    expect(converted.steps.map((step) => [step.id, step.type])).toEqual([
      ["step-1", "team"],
      ["step-2", "human-in-the-loop"],
      ["step-3", "team"],
    ]);
    expect(converted.steps[1]).toEqual({
      id: "step-2",
      type: "human-in-the-loop",
      prompt: "Review the previous result and provide guidance for the next step.",
      input_artifact: "review/step-1.md",
      result_artifact: "feedback/step-2.json",
      handoff: {
        from_step: "step-1",
        from_artifact: "output/decomposition-plan.md",
        to_artifact: "review/step-1.md",
      },
    });
    expect(converted.steps[2]).toMatchObject({
      id: "step-3",
      type: "team",
      team: "problem-thinking-board",
      stage_type: "discussion",
      handoff: {
        from_step: "step-2",
        from_artifact: "feedback/step-2.json",
        to_artifact: "incoming-brief.md",
      },
    });
    expect(converted.output.from_step).toBe("step-3");
    expect(convertWorkflowStepToHumanInput(twoStep, "step-1")).toBe(twoStep);
  });
});
