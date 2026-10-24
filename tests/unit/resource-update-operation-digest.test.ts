/**
 * The identity of one update operation, as durable evidence records it.
 *
 * A receipt is only evidence for the operation it was written for. Two
 * proposals can agree on the plan, the index, the target, the revision, and
 * even the names involved while asking for different work — a different
 * instruction for a skill, a different role or description for an Agent. If
 * the receipt cannot tell them apart, a retry of one can adopt bytes authored
 * for the other and publish work nobody approved.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { ResourceUpdateOperation } from "../../contracts/resource-architect.js";
import { digestResourceUpdateOperation } from "../../domains/resource-architect/resource-update-operation-digest.js";

const REVISION = `sha256:${"a".repeat(64)}`;

function skillOperation(
  instruction = "Author the termination review.",
): ResourceUpdateOperation {
  return {
    kind: "update_agent_skills",
    target: { kind: "agent", id: "michigan-contract-lawyer" },
    expectedRevision: REVISION,
    skillUpdates: [
      { action: "create", name: "termination-clause-review", instruction },
      { action: "update", name: "indemnity-clause-review", instruction: "Cap it." },
    ],
  };
}

function teamOperation(
  overrides: Partial<{
    role: string;
    description: string;
    rationale: string;
  }> = {},
): ResourceUpdateOperation {
  return {
    kind: "add_team_agents",
    target: { kind: "team", id: "contract-review-team" },
    expectedRevision: REVISION,
    libraryAgentsToAdd: [
      { name: "scoping-lawyer", role: "Scope reviewer", rationale: "Reuse." },
    ],
    newAgentsToCreate: [{
      name: "drafting-completeness-lawyer",
      role: overrides.role ?? "Drafting reviewer",
      description: overrides.description ?? "Checks drafting completeness.",
      rationale: overrides.rationale ?? "No existing Agent covers drafting gaps.",
    }],
  };
}

test("the same operation always digests to the same value", () => {
  const digest = digestResourceUpdateOperation(skillOperation());

  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(digest, digestResourceUpdateOperation(skillOperation()));
});

test("the order fields were written in does not change the identity", () => {
  const ordered = skillOperation();
  const reordered: ResourceUpdateOperation = {
    expectedRevision: ordered.expectedRevision,
    target: { id: "michigan-contract-lawyer", kind: "agent" },
    skillUpdates: ordered.kind === "update_agent_skills" ? ordered.skillUpdates : [],
    kind: "update_agent_skills",
  };

  assert.equal(
    digestResourceUpdateOperation(reordered),
    digestResourceUpdateOperation(ordered),
  );
});

test("a changed skill instruction is a different operation", () => {
  assert.notEqual(
    digestResourceUpdateOperation(skillOperation("Something else entirely.")),
    digestResourceUpdateOperation(skillOperation()),
  );
});

test("a changed action or skill order is a different operation", () => {
  const base = skillOperation();
  assert.equal(base.kind, "update_agent_skills");
  if (base.kind !== "update_agent_skills") return;
  const swapped: ResourceUpdateOperation = {
    ...base,
    skillUpdates: [...base.skillUpdates].reverse(),
  };
  const relabelled: ResourceUpdateOperation = {
    ...base,
    skillUpdates: base.skillUpdates.map((update, index) =>
      index === 0 ? { ...update, action: "update" as const } : update
    ),
  };

  assert.notEqual(digestResourceUpdateOperation(swapped), digestResourceUpdateOperation(base));
  assert.notEqual(digestResourceUpdateOperation(relabelled), digestResourceUpdateOperation(base));
});

/**
 * A Team receipt bound only to the ordered Agent names would accept a retry
 * whose new Agent keeps its name and changes what that Agent is meant to be.
 * The package staged for one brief is not the package the other asked for.
 */
test("a changed new-Agent brief is a different operation, even under the same name", () => {
  const base = digestResourceUpdateOperation(teamOperation());

  for (
    const overrides of [
      { role: "Something else" },
      { description: "A different job entirely." },
      { rationale: "A different reason." },
    ]
  ) {
    assert.notEqual(
      digestResourceUpdateOperation(teamOperation(overrides)),
      base,
      `expected ${JSON.stringify(overrides)} to change the operation's identity`,
    );
  }
});

test("a changed document specialization is a different operation", () => {
  const base = teamOperation();
  assert.equal(base.kind, "add_team_agents");
  if (base.kind !== "add_team_agents") return;
  const specialized: ResourceUpdateOperation = {
    ...base,
    newAgentsToCreate: base.newAgentsToCreate.map((agent) => ({
      ...agent,
      documentSpecialization: {
        expertiseDomain: "Contracts",
        focus: "Completeness",
        evidenceAnchors: ["clause"],
        assessmentTargets: ["draft"],
        outOfScope: ["pricing"],
      },
    })),
  };

  assert.notEqual(
    digestResourceUpdateOperation(specialized),
    digestResourceUpdateOperation(base),
  );
});

test("two different target kinds are never the same operation", () => {
  assert.notEqual(
    digestResourceUpdateOperation(skillOperation()),
    digestResourceUpdateOperation(teamOperation()),
  );
});

test("a changed expected revision is a different operation", () => {
  assert.notEqual(
    digestResourceUpdateOperation({
      ...skillOperation(),
      expectedRevision: `sha256:${"b".repeat(64)}`,
    }),
    digestResourceUpdateOperation(skillOperation()),
  );
});
