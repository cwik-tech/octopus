import test from "node:test";
import assert from "node:assert/strict";

import { createRunPlan } from "../../domains/run-orchestrator/orchestrator.js";
import {
  applyDeepResearchIntakeDecision,
  DEEP_RESEARCH_INTAKE_REQUIRED_INPUT,
  enforceDeepResearchPlanReadiness,
  RESEARCH_PLAN_REQUIRED_INPUT,
} from "../../domains/run-orchestrator/deep-research.js";

const workflows = [
  {
    id: "discussion-to-writing",
    description: "Think through a problem, then create a written deliverable.",
    tags: ["discussion", "writing"],
    capabilities: ["analysis", "writing"],
  },
  {
    id: "venture-diligence",
    description: "Screen venture deals and founder diligence requests.",
    tags: ["venture", "diligence"],
    capabilities: ["investment", "startup"],
  },
];

test("run orchestrator creates a ready plan for an explicitly selected workflow", () => {
  const plan = createRunPlan({
    goal: "Write a concise one-page brief about warehouse automation.",
    workflowId: "discussion-to-writing",
    workflows,
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.selectedWorkflow?.id, "discussion-to-writing");
  assert.equal(plan.selectedWorkflow?.confidence, "high");
  assert.equal(plan.actions.at(-1)?.type, "launch_workflow");
  assert.equal(plan.actions.at(-1)?.status, "ready");
});

test("Deep Research stays blocked until its explicit intake is complete", () => {
  const initial = createRunPlan({
    goal: "Research local ice cream businesses in Ann Arbor for a market report.",
    workflowId: "deep-research-report",
    workflows: [
      {
        id: "deep-research-report",
        description: "Create a source-traceable research report.",
      },
    ],
  });

  assert.equal(initial.status, "needs_input");
  assert.equal(initial.deepResearchIntakeComplete, false);
  assert.deepEqual(initial.requiredInputs, [
    DEEP_RESEARCH_INTAKE_REQUIRED_INPUT,
    RESEARCH_PLAN_REQUIRED_INPUT,
  ]);

  const partlyAnswered = applyDeepResearchIntakeDecision(initial, [
    "jurisdiction or no geographic constraint",
    "exclusions or no exclusions",
  ]);
  assert.equal(partlyAnswered.deepResearchIntakeComplete, false);
  assert.deepEqual(partlyAnswered.requiredInputs, [
    "jurisdiction or no geographic constraint",
    "exclusions or no exclusions",
    RESEARCH_PLAN_REQUIRED_INPUT,
  ]);

  const intakeComplete = applyDeepResearchIntakeDecision(partlyAnswered, []);
  assert.equal(intakeComplete.deepResearchIntakeComplete, true);
  assert.deepEqual(intakeComplete.requiredInputs, [RESEARCH_PLAN_REQUIRED_INPUT]);
  assert.equal(intakeComplete.status, "needs_input");
  assert.match(intakeComplete.summary, /section and task plan/i);
});

test("Deep Research safely re-gates legacy freshness and combined exclusion state", () => {
  const legacy = enforceDeepResearchPlanReadiness({
    id: "legacy-intake",
    goal: "Research local ice cream businesses.",
    summary: "Clarification required",
    status: "needs_input",
    selectedWorkflow: {
      id: "deep-research-report",
      rationale: "Deep research requested.",
      confidence: "high",
    },
    deepResearchIntakeComplete: false,
    requiredInputs: [
      "freshness boundary",
      "must-includes and exclusions",
      RESEARCH_PLAN_REQUIRED_INPUT,
    ],
    actions: [],
    warnings: [],
    createdAt: "2026-07-17T12:00:00.000Z",
  });

  assert.deepEqual(legacy.requiredInputs, [
    DEEP_RESEARCH_INTAKE_REQUIRED_INPUT,
    RESEARCH_PLAN_REQUIRED_INPUT,
  ]);
});

test("run orchestrator asks for input before launching an empty run", () => {
  const plan = createRunPlan({
    goal: "",
    workflows,
  });

  assert.equal(plan.status, "needs_input");
  assert.ok(plan.requiredInputs.includes("task brief"));
  assert.equal(
    plan.actions.some(
      (action) =>
        action.type === "collect_input" && action.status === "needs_input",
    ),
    true,
  );
});

test("run orchestrator keeps generic workflow requests in setup", () => {
  const plan = createRunPlan({
    goal: "I would like to create a site structure.",
    workflowId: "discussion-to-writing",
    workflows,
  });

  assert.equal(plan.status, "needs_input");
  assert.equal(plan.selectedWorkflow?.id, "discussion-to-writing");
  assert.ok(plan.requiredInputs.includes("specific task details"));
  assert.equal(plan.actions.at(-1)?.type, "launch_workflow");
  assert.equal(plan.actions.at(-1)?.status, "pending");
});

test("run orchestrator accepts a non-empty conversational brief for Team chat", () => {
  const plan = createRunPlan({
    goal: "What should I invest in manufacturing?",
    workflowId: "venture-diligence",
    workflows,
    briefReadinessPolicy: "non-empty",
  });

  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.requiredInputs, []);
  assert.equal(plan.actions.at(-1)?.status, "ready");
});

test("run orchestrator leaves semantic workflow selection to the receptionist LLM", () => {
  const plan = createRunPlan({
    goal: "I need startup investment diligence and founder screening.",
    workflows,
  });

  assert.equal(plan.status, "needs_input");
  assert.equal(plan.selectedWorkflow, undefined);
  assert.ok(plan.requiredInputs.includes("workflow selection"));
});

test("run orchestrator does not let assistant proposal text satisfy a thin user brief", () => {
  const plan = createRunPlan({
    goal: "Yes, that workflow is right.",
    workflows,
    workflowSelection: {
      id: "discussion-to-writing",
      confidence: "high",
      rationale: "Persisted selection",
    },
    history: [
      {
        id: "1",
        role: "user",
        text: "I would like to create a site structure.",
        createdAt: "2026-05-30T00:00:00.000Z",
      },
      {
        id: "2",
        role: "assistant",
        text: "Selected workflow: discussion-to-writing. Stages: discuss and write a structured final draft.",
        createdAt: "2026-05-30T00:00:01.000Z",
      },
      {
        id: "3",
        role: "user",
        text: "Yes, that workflow is right.",
        createdAt: "2026-05-30T00:00:02.000Z",
      },
    ],
  });

  assert.equal(plan.status, "needs_input");
  assert.equal(plan.selectedWorkflow?.id, "discussion-to-writing");
  assert.ok(plan.requiredInputs.includes("specific task details"));
});

test("run orchestrator preserves the authoritative prior selection without parsing confirmation phrases", () => {
  const plan = createRunPlan({
    goal: "Everything is settled on my side; take it from here.",
    workflows,
    workflowSelection: {
      id: "venture-diligence",
      confidence: "high",
      rationale: "Persisted selection",
    },
    history: [
      {
        id: "1",
        role: "user",
        text: "I need startup investment diligence and founder screening.",
        createdAt: "2026-05-30T00:00:00.000Z",
      },
      {
        id: "2",
        role: "assistant",
        text: "Selected workflow: venture-diligence.",
        createdAt: "2026-05-30T00:00:01.000Z",
      },
      {
        id: "3",
        role: "user",
        text: "Everything is settled on my side; take it from here.",
        createdAt: "2026-05-30T00:00:02.000Z",
      },
    ],
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.selectedWorkflow?.id, "venture-diligence");
});

test("run orchestrator preserves the workflow selection supplied by the receptionist", () => {
  const plan = createRunPlan({
    goal: "It will be a customer discovery website for students, and I want to help them with interviews.",
    workflows: [
      {
        id: "clarify-debate-write3",
        description:
          "Collect your request, ask clarifying questions via the reception desk, then pressure-test with a strategic board discussion.",
        capabilities: ["ask_debate_write", "structured_deliberation"],
      },
      {
        id: "plan-site-structure",
        description:
          "Plan the information architecture and structure for a new website by pressure-testing assumptions, then produce a structured site blueprint.",
        capabilities: ["site_structure_planning", "website_ia", "site_map"],
      },
    ],
    workflowSelection: {
      id: "plan-site-structure",
      confidence: "high",
      rationale: "Receptionist selected the site workflow",
    },
    history: [
      {
        id: "1",
        role: "user",
        text: "hi",
        createdAt: "2026-07-06T00:00:00.000Z",
      },
      {
        id: "2",
        role: "assistant",
        text: "Hi! Happy to help set up a run. What is the task?",
        createdAt: "2026-07-06T00:00:01.000Z",
      },
      {
        id: "3",
        role: "user",
        text: "I would like to create a website structure.",
        createdAt: "2026-07-06T00:00:02.000Z",
      },
      {
        id: "4",
        role: "assistant",
        text: "Got it — **plan-site-structure** is the right workflow for this. Missing details: purpose, audience, content areas, constraints.",
        createdAt: "2026-07-06T00:00:03.000Z",
      },
      {
        id: "5",
        role: "user",
        text: "It will be a customer discovery website for students, and I want to help them with interviews.",
        createdAt: "2026-07-06T00:00:04.000Z",
      },
    ],
  });

  assert.equal(plan.selectedWorkflow?.id, "plan-site-structure");
  assert.equal(plan.status, "ready");
  assert.equal(
    plan.selectedWorkflow?.rationale,
    "Receptionist selected the site workflow",
  );
});

test("run orchestrator does not infer a workflow from earlier conversation history", () => {
  const plan = createRunPlan({
    goal: "Judge whether this abstract painting uses color effectively.",
    workflows,
    history: [{
      id: "1",
      role: "user",
      text: "Perform venture diligence on this startup.",
      createdAt: "2026-07-06T00:00:00.000Z",
    }],
  });

  assert.equal(plan.selectedWorkflow, undefined);
  assert.ok(plan.requiredInputs.includes("workflow selection"));
});

test("run orchestrator does not auto-select an exact workflow-id token", () => {
  const plan = createRunPlan({
    goal: "Review this art and explain the composition in a detailed critique.",
    workflows: [
      { id: "art", description: "Critique visual artwork." },
      {
        id: "maps",
        description: "Analyze cartography and geographic maps.",
        tags: ["cartography"],
      },
    ],
  });

  assert.equal(plan.selectedWorkflow, undefined);
  assert.ok(plan.requiredInputs.includes("workflow selection"));
});

test("run orchestrator does not auto-select from rich metadata", () => {
  const plan = createRunPlan({
    goal: "Evaluate cartography methods for a detailed geographic map.",
    workflows: [
      { id: "art", description: "Critique visual artwork." },
      {
        id: "maps",
        description: "Analyze cartography and geographic maps.",
        tags: ["cartography"],
      },
    ],
  });

  assert.equal(plan.selectedWorkflow, undefined);
  assert.ok(plan.requiredInputs.includes("workflow selection"));
});

test("run orchestrator ignores assistant workflow prose without persisted selection", () => {
  const plan = createRunPlan({
    goal: "Yes, please continue.",
    workflows,
    history: [
      {
        id: "1",
        role: "user",
        text: "Please help me choose.",
        createdAt: "2026-07-06T00:00:00.000Z",
      },
      {
        id: "2",
        role: "assistant",
        text: "Selected workflow: venture-diligence.",
        createdAt: "2026-07-06T00:00:01.000Z",
      },
      {
        id: "3",
        role: "user",
        text: "Yes, please continue.",
        createdAt: "2026-07-06T00:00:02.000Z",
      },
    ],
  });

  assert.equal(plan.selectedWorkflow, undefined);
  assert.ok(plan.requiredInputs.includes("workflow selection"));
});

test("run orchestrator requires an LLM or explicit choice for ambiguous workflows", () => {
  const plan = createRunPlan({
    goal:
      "Compare market analysis and market research options for our retail strategy.",
    workflows: [
      {
        id: "market-analysis",
        description: "Analyze a market.",
        tags: ["market", "analysis"],
      },
      {
        id: "market-research",
        description: "Research a market.",
        tags: ["market", "research"],
      },
    ],
  });

  assert.equal(plan.selectedWorkflow, undefined);
  assert.ok(plan.requiredInputs.includes("workflow selection"));
});

test("run orchestrator does not auto-select from a weak description token", () => {
  const plan = createRunPlan({
    goal: "Help me with screening and suggest what to do next.",
    workflows,
  });

  assert.equal(plan.selectedWorkflow, undefined);
  assert.ok(plan.requiredInputs.includes("workflow selection"));
});

test("run orchestrator does not use the dormant matcher for strong metadata", () => {
  const plan = createRunPlan({
    goal: "Perform a legal contract review for the supplier agreement.",
    workflows: [
      {
        id: "people-operations",
        description: "Coordinate paralegal staffing and onboarding.",
      },
      {
        id: "contract-review",
        description: "Perform legal review of supplier contracts.",
      },
    ],
  });

  assert.equal(plan.selectedWorkflow, undefined);
  assert.ok(plan.requiredInputs.includes("workflow selection"));
});

test("run orchestrator reports an explicitly requested unknown workflow", () => {
  const plan = createRunPlan({
    goal: "Prepare a detailed investment diligence report.",
    workflowId: "missing-workflow",
    workflows,
  });

  assert.equal(plan.selectedWorkflow, undefined);
  assert.ok(plan.warnings.some((warning) => warning.includes("missing-workflow")));
});
