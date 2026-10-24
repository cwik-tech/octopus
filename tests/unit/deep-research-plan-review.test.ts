import assert from "node:assert/strict";
import test from "node:test";

import { hashUnapprovedResearchPlan } from "../../domains/deep-research/deep-research-approval.js";
import {
  classifyDeepResearchPlanningRoute,
  createAmendedDeepResearchPlanningRevision,
  createInitialDeepResearchPlanningRevision,
  diffResearchPlans,
  hasBlockingResearchPlanFindings,
} from "../../domains/deep-research/deep-research-plan-review.js";
import { makePlan, TEST_TIME } from "./deep-research-fixtures.js";

test("planning route selection is deterministic and amendments always require Sol", () => {
  const initial = createInitialDeepResearchPlanningRevision(TEST_TIME);
  assert.equal(
    classifyDeepResearchPlanningRoute({ revision: initial }),
    "terra_only",
  );
  assert.equal(
    classifyDeepResearchPlanningRoute({
      revision: initial,
      draftFailure: "blocking_findings",
    }),
    "sol_validation_fallback",
  );
  assert.equal(
    classifyDeepResearchPlanningRoute({
      revision: initial,
      draftFailure: "unusable_output",
    }),
    "sol_validation_fallback",
  );
  assert.equal(
    classifyDeepResearchPlanningRoute({
      revision: initial,
      draftFailure: "timeout",
    }),
    "sol_timeout_fallback",
  );

  const plan = makePlan();
  const proposalHash = hashUnapprovedResearchPlan(plan);
  const amendment = createAmendedDeepResearchPlanningRevision({
    previous: initial,
    previousPlan: plan,
    previousProposalHash: proposalHash,
    messageId: "message-1",
    createdAt: TEST_TIME,
  });
  assert.equal(
    classifyDeepResearchPlanningRoute({ revision: amendment }),
    "sol_amendment_review",
  );
  assert.equal(
    classifyDeepResearchPlanningRoute({
      revision: amendment,
      draftFailure: "timeout",
    }),
    "sol_amendment_review",
  );
  assert.equal(amendment.sourceProposalHash, proposalHash);
  assert.deepEqual(amendment.sourceProposalSnapshot, plan);
  assert.notEqual(amendment.sourceProposalSnapshot, plan);
});

test("unverified source proposals are never retained as amendment snapshots", () => {
  const plan = makePlan();
  const amendment = createAmendedDeepResearchPlanningRevision({
    previous: undefined,
    previousPlan: plan,
    previousProposalHash: "0".repeat(64),
    messageId: "message-1",
    createdAt: TEST_TIME,
  });

  assert.equal(amendment.sourceProposalHash, undefined);
  assert.equal(amendment.sourceProposalSnapshot, undefined);
  assert.equal(amendment.requiresSolReview, true);
});

test("blocking findings and deterministic diffs stay code-owned", () => {
  assert.equal(
    hasBlockingResearchPlanFindings([
      {
        code: "clarity",
        severity: "warning",
        field: "plan.sections",
        summary: "A section title could be clearer.",
      },
    ]),
    false,
  );
  assert.equal(
    hasBlockingResearchPlanFindings([
      {
        code: "invalid_reference",
        severity: "blocking",
        field: "plan.tasks[0].workerSpecId",
        summary: "A task references a missing worker.",
      },
    ]),
    true,
  );

  const base = makePlan();
  const source = {
    ...base,
    sections: [
      ...base.sections,
      {
        ...base.sections[0]!,
        id: "section-two",
        title: "Risks",
        taskIds: ["task-two"],
      },
    ],
    tasks: [
      ...base.tasks,
      {
        ...base.tasks[0]!,
        id: "task-two",
        sectionId: "section-two",
        title: "Risk evidence",
      },
    ],
  };
  const current = {
    ...structuredClone(source),
    request: {
      ...source.request,
      includedScope: [
        ...source.request.includedScope,
        "Public-sector adoption",
      ],
    },
    sections: [...source.sections].reverse(),
    tasks: [...source.tasks].reverse(),
    maxDurationMinutes: source.maxDurationMinutes + 5,
    workerSpecs: [
      ...source.workerSpecs,
      {
        ...structuredClone(source.workerSpecs[0]!),
        id: "additional-worker",
        laneId: "additional-worker-lane",
      },
    ],
  };

  const diff = diffResearchPlans(source, current);
  assert.match(diff.scope.join("\n"), /Public-sector adoption/u);
  assert.match(diff.sections.join("\n"), /order changed/u);
  assert.match(diff.tasks.join("\n"), /order changed/u);
  assert.match(diff.workers.join("\n"), /1 → 2/u);
  assert.match(diff.budgets.join("\n"), /Duration limit/u);
});
