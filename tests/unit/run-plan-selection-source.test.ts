import test from "node:test";
import assert from "node:assert/strict";

import { isRunPlan, type RunPlan } from "../../contracts/run-plan.js";

function makePlanRecord(selection: unknown): Record<string, unknown> {
  return {
    id: "run-plan-1",
    goal: "Write a brief",
    summary: "Selected workflow",
    status: "ready",
    selectedWorkflow: selection,
    requiredInputs: [],
    actions: [],
    warnings: [],
    createdAt: "2026-08-28T00:00:00.000Z",
  };
}

const BASE_SELECTION = {
  id: "discussion-to-writing3",
  rationale: "Chosen for the test",
  confidence: "high",
};

test("a plan written before selection provenance existed stays readable", () => {
  assert.equal(isRunPlan(makePlanRecord(BASE_SELECTION)), true);
});

test("both selection provenance values are accepted", () => {
  assert.equal(
    isRunPlan(makePlanRecord({ ...BASE_SELECTION, selectionSource: "user" })),
    true,
  );
  assert.equal(
    isRunPlan(
      makePlanRecord({ ...BASE_SELECTION, selectionSource: "coordinator" }),
    ),
    true,
  );
});

test("an unrecognised selection provenance is refused rather than read as user intent", () => {
  assert.equal(
    isRunPlan(makePlanRecord({ ...BASE_SELECTION, selectionSource: "model" })),
    false,
  );
  assert.equal(
    isRunPlan(makePlanRecord({ ...BASE_SELECTION, selectionSource: true })),
    false,
  );
});

test("a parsed provenance survives onto the typed plan", () => {
  const record: unknown = makePlanRecord({
    ...BASE_SELECTION,
    selectionSource: "user",
  });
  assert.ok(isRunPlan(record));
  const plan: RunPlan = record;
  assert.equal(plan.selectedWorkflow?.selectionSource, "user");
});
