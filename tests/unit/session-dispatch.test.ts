import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveSessionDispatch,
  type SessionDispatchDecision,
  type SessionMessageTarget,
} from "../../domains/sessions/session-dispatch.js";
import type { RunPlan, RunPlanSelectionSource } from "../../contracts/run-plan.js";

/**
 * A plan carrying a workflow selection with the provenance under test.
 *
 * `selectionSource` is deliberately optional here so a legacy record — one
 * written before provenance existed — can be expressed as the absence of the
 * field rather than as a guessed value.
 */
function makePlanWithSelection(
  workflowId: string,
  selectionSource?: RunPlanSelectionSource,
  overrides: Partial<RunPlan> = {},
): RunPlan {
  return {
    id: "run-plan-1",
    goal: "Write a brief",
    summary: "Selected workflow",
    status: "ready",
    selectedWorkflow: {
      id: workflowId,
      rationale: "Chosen for the test",
      confidence: "high",
      ...(selectionSource ? { selectionSource } : {}),
    },
    requiredInputs: [],
    actions: [],
    warnings: [],
    createdAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  };
}

const AGENTS_TARGET: SessionMessageTarget = {
  kind: "agents",
  agentNames: ["analyst"],
};
const TEAM_TARGET: SessionMessageTarget = {
  kind: "team",
  teamId: "problem-thinking-board",
};
const WORKFLOW_TARGET: SessionMessageTarget = {
  kind: "workflow",
  workflowId: "discussion-to-writing3",
  expectedPlanId: "run-plan-1",
};

test("an untargeted turn with no plan goes to the General Agent", () => {
  const decision = resolveSessionDispatch({});

  assert.deepEqual(decision, {
    kind: "general-agent",
  } satisfies SessionDispatchDecision);
});

test("an explicit Agent target wins over a user-selected Workflow", () => {
  const decision = resolveSessionDispatch({
    target: AGENTS_TARGET,
    plan: makePlanWithSelection("deep-research-report", "user"),
  });

  assert.deepEqual(decision, {
    kind: "agents",
    agentNames: ["analyst"],
  } satisfies SessionDispatchDecision);
});

test("an explicit Team target wins over a user-selected Workflow", () => {
  const decision = resolveSessionDispatch({
    target: TEAM_TARGET,
    plan: makePlanWithSelection("deep-research-report", "user"),
  });

  assert.deepEqual(decision, {
    kind: "team",
    teamId: "problem-thinking-board",
  } satisfies SessionDispatchDecision);
});

test("an explicit Workflow target wins over a different user-selected Workflow", () => {
  const decision = resolveSessionDispatch({
    target: WORKFLOW_TARGET,
    plan: makePlanWithSelection("deep-research-report", "user"),
  });

  assert.deepEqual(decision, {
    kind: "workflow",
    workflowId: "discussion-to-writing3",
  } satisfies SessionDispatchDecision);
});

test("an untargeted turn runs the Coordinator against a user-selected Workflow", () => {
  const decision = resolveSessionDispatch({
    plan: makePlanWithSelection("deep-research-report", "user"),
  });

  assert.deepEqual(decision, {
    kind: "coordinator",
    selectedWorkflowId: "deep-research-report",
  } satisfies SessionDispatchDecision);
});

test("a Coordinator recommendation does not govern the next untargeted turn", () => {
  const decision = resolveSessionDispatch({
    plan: makePlanWithSelection("deep-research-report", "coordinator"),
  });

  assert.deepEqual(decision, {
    kind: "general-agent",
  } satisfies SessionDispatchDecision);
});

test("a legacy selection without provenance is read as a recommendation", () => {
  const decision = resolveSessionDispatch({
    plan: makePlanWithSelection("deep-research-report"),
  });

  assert.deepEqual(decision, {
    kind: "general-agent",
  } satisfies SessionDispatchDecision);
});

test("a plan with no workflow selection leaves the turn with the General Agent", () => {
  const decision = resolveSessionDispatch({
    plan: {
      id: "run-plan-2",
      goal: "",
      summary: "",
      status: "needs_input",
      requiredInputs: ["workflow selection"],
      actions: [],
      warnings: [],
      createdAt: "2026-08-28T00:00:00.000Z",
    },
  });

  assert.deepEqual(decision, {
    kind: "general-agent",
  } satisfies SessionDispatchDecision);
});

test("an Agent target keeps its roster order and membership", () => {
  const decision = resolveSessionDispatch({
    target: { kind: "agents", agentNames: ["writer", "analyst"] },
  });

  assert.deepEqual(decision, {
    kind: "agents",
    agentNames: ["writer", "analyst"],
  } satisfies SessionDispatchDecision);
});

test("an explicit target is honoured while the selected plan is running", () => {
  const decision = resolveSessionDispatch({
    target: AGENTS_TARGET,
    plan: makePlanWithSelection("deep-research-report", "user", {
      status: "running",
    }),
  });

  assert.deepEqual(decision, {
    kind: "agents",
    agentNames: ["analyst"],
  } satisfies SessionDispatchDecision);
});

test("a null plan is treated exactly like a missing plan", () => {
  assert.deepEqual(
    resolveSessionDispatch({ plan: null }),
    resolveSessionDispatch({}),
  );
});

test("a turn the Coordinator admitted replays through the Coordinator", () => {
  const decision = resolveSessionDispatch({ admittedResponder: "coordinator" });

  assert.deepEqual(decision, {
    kind: "coordinator",
  } satisfies SessionDispatchDecision);
});

test("a turn the General Agent admitted replays through the General Agent", () => {
  const decision = resolveSessionDispatch({
    plan: makePlanWithSelection("deep-research-report", "user"),
    admittedResponder: "agents",
  });

  assert.deepEqual(decision, {
    kind: "general-agent",
  } satisfies SessionDispatchDecision);
});

test("an admitted responder never overrides an explicit target", () => {
  const decision = resolveSessionDispatch({
    target: AGENTS_TARGET,
    admittedResponder: "coordinator",
  });

  assert.deepEqual(decision, {
    kind: "agents",
    agentNames: ["analyst"],
  } satisfies SessionDispatchDecision);
});

test("an admitted Coordinator turn keeps its selected workflow on replay", () => {
  const decision = resolveSessionDispatch({
    plan: makePlanWithSelection("deep-research-report", "user"),
    admittedResponder: "coordinator",
  });

  assert.deepEqual(decision, {
    kind: "coordinator",
    selectedWorkflowId: "deep-research-report",
  } satisfies SessionDispatchDecision);
});

test("a deployment without the persona keeps its untargeted turns", () => {
  const decision = resolveSessionDispatch({ frontDoorAvailable: false });

  assert.deepEqual(decision, {
    kind: "coordinator",
  } satisfies SessionDispatchDecision);
});

test("a turn the General Agent admitted stays its turn even with the persona gone", () => {
  const decision = resolveSessionDispatch({
    admittedResponder: "agents",
    frontDoorAvailable: false,
  });

  assert.deepEqual(decision, {
    kind: "general-agent",
  } satisfies SessionDispatchDecision);
});
