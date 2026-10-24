/**
 * The request boundary a follow-up Resource Architect turn crosses.
 *
 * A turn carries the plan the user is still looking at, so whatever the server
 * persisted has to be able to come back. A boundary that accepts only one kind
 * of update operation makes the other kind unusable the moment the user says
 * anything else: the proposal is on screen, and the next message is refused.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { parseResourceArchitectTurnBody } from "../../services/resource-architect-service.js";

const REVISION = `sha256:${"a".repeat(64)}`;

function turnBody(currentPlan: unknown): Record<string, unknown> {
  return {
    operation: "conversation",
    history: [{ role: "user", text: "Also rename the second skill." }],
    currentPlan,
  };
}

function skillPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "plan-1",
    kind: "resource_updates",
    operations: [{
      kind: "update_agent_skills",
      target: { kind: "agent", id: "michigan-contract-lawyer" },
      expectedRevision: REVISION,
      skillUpdates: [{
        action: "create",
        name: "termination-clause-review",
        instruction: "Author the termination review.",
      }],
      ...overrides,
    }],
  };
}

test("half an ad hoc pair is refused instead of being completed from elsewhere", () => {
  // provider and model are one choice, not two settings. Accepting a model on
  // its own leaves the turn running that model against whichever provider the
  // Architect Agent happens to name, and recording the Architect's own pair as
  // the provenance -- a hybrid nobody selected, described as something else.
  for (const half of [
    { model: "claude-sonnet-4-6" },
    { provider: "anthropic" },
  ]) {
    assert.throws(
      () => parseResourceArchitectTurnBody({ ...turnBody(null), ...half }),
      `expected ${JSON.stringify(half)} to be refused`,
    );
  }
  // Both halves together are an ordinary ad hoc choice and must still work.
  assert.deepEqual(
    parseResourceArchitectTurnBody({
      ...turnBody(null),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    }).provider,
    "anthropic",
  );
});

test("a persisted Agent skill plan comes back on the next turn", () => {
  const parsed = parseResourceArchitectTurnBody(turnBody(skillPlan()));

  const plan = parsed.currentPlan;
  assert.ok(plan);
  assert.equal(plan.kind, "resource_updates");
  if (plan.kind !== "resource_updates") return;
  const operation = plan.operations[0];
  assert.ok(operation);
  assert.equal(operation.kind, "update_agent_skills");
  if (operation.kind !== "update_agent_skills") return;
  // Every identity value survives exactly as it was persisted.
  assert.deepEqual(operation.target, { kind: "agent", id: "michigan-contract-lawyer" });
  assert.equal(operation.expectedRevision, REVISION);
  assert.deepEqual(operation.skillUpdates, [{
    action: "create",
    name: "termination-clause-review",
    instruction: "Author the termination review.",
  }]);
});

test("a persisted Team addition plan still comes back on the next turn", () => {
  const parsed = parseResourceArchitectTurnBody(turnBody({
    id: "plan-2",
    kind: "resource_updates",
    operations: [{
      kind: "add_team_agents",
      target: { kind: "team", id: "contract-review-team" },
      expectedRevision: REVISION,
      libraryAgentsToAdd: [{
        name: "scoping-lawyer",
        role: "Scope reviewer",
        tier: "strategic",
        rationale: "Reuse.",
      }],
      newAgentsToCreate: [],
    }],
  }));

  const plan = parsed.currentPlan;
  assert.ok(plan);
  assert.equal(plan.kind, "resource_updates");
  if (plan.kind !== "resource_updates") return;
  assert.equal(plan.operations[0]?.kind, "add_team_agents");
});

test("a skill operation that is not one is refused rather than reshaped", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["an action that is neither create nor update", {
      skillUpdates: [{ action: "delete", name: "x", instruction: "Go." }],
    }],
    ["a Team target on a skill operation", {
      target: { kind: "team", id: "contract-review-team" },
    }],
    ["a skill with no name", {
      skillUpdates: [{ action: "create", name: "", instruction: "Go." }],
    }],
    ["a skill with no instruction", {
      skillUpdates: [{ action: "create", name: "termination-clause-review", instruction: "" }],
    }],
    ["no revision at all", { expectedRevision: "" }],
    ["no skill actions", { skillUpdates: [] }],
  ];

  for (const [description, overrides] of cases) {
    assert.throws(
      () => parseResourceArchitectTurnBody(turnBody(skillPlan(overrides))),
      `expected ${description} to be refused`,
    );
  }
});

/**
 * A wrong-typed list is not an empty one.
 *
 * Coercing anything that is not an array to `[]` silently rewrites the plan
 * the user is looking at: the additions disappear and the turn continues as
 * though the proposal had never named them.
 */
test("a list that is not a list is refused rather than read as empty", () => {
  for (const libraryAgentsToAdd of ["scoping-lawyer", 7, {}, null]) {
    assert.throws(
      () =>
        parseResourceArchitectTurnBody(turnBody({
          id: "plan-1",
          kind: "resource_updates",
          operations: [{
            kind: "add_team_agents",
            target: { kind: "team", id: "contract-review-team" },
            expectedRevision: REVISION,
            libraryAgentsToAdd,
            newAgentsToCreate: [],
          }],
        })),
      `expected ${JSON.stringify(libraryAgentsToAdd)} to be refused`,
    );
  }
});

/**
 * Identity is not prose.
 *
 * Trimming a target id, an Agent name, a skill name, or a revision at this
 * boundary turns a padded alias into the id of something that really exists,
 * which is exactly what the provider parser refuses to do.
 */
test("a padded identity is refused, never trimmed onto a real target", () => {
  const cases: Array<[string, unknown]> = [
    ["a padded Agent target", skillPlan({ target: { kind: "agent", id: " michigan-contract-lawyer " } })],
    ["a padded skill name", skillPlan({
      skillUpdates: [{
        action: "create",
        name: " termination-clause-review ",
        instruction: "Author it.",
      }],
    })],
    ["a padded revision", skillPlan({ expectedRevision: ` ${REVISION} ` })],
    ["a padded Team target", {
      id: "plan-1",
      kind: "resource_updates",
      operations: [{
        kind: "add_team_agents",
        target: { kind: "team", id: " contract-review-team " },
        expectedRevision: REVISION,
        libraryAgentsToAdd: [],
        newAgentsToCreate: [],
      }],
    }],
    ["a padded Agent addition name", {
      id: "plan-1",
      kind: "resource_updates",
      operations: [{
        kind: "add_team_agents",
        target: { kind: "team", id: "contract-review-team" },
        expectedRevision: REVISION,
        libraryAgentsToAdd: [{
          name: " scoping-lawyer ",
          role: "Scope reviewer",
          tier: "strategic",
          rationale: "Reuse.",
        }],
        newAgentsToCreate: [],
      }],
    }],
  ];

  for (const [description, currentPlan] of cases) {
    assert.throws(
      () => parseResourceArchitectTurnBody(turnBody(currentPlan)),
      `expected ${description} to be refused`,
    );
  }
});

test("prose around an identity is still normalized", () => {
  const parsed = parseResourceArchitectTurnBody(turnBody(skillPlan({
    skillUpdates: [{
      action: "create",
      name: "termination-clause-review",
      instruction: "  Author the termination review.  ",
    }],
  })));

  const plan = parsed.currentPlan;
  assert.ok(plan);
  if (plan?.kind !== "resource_updates") return;
  const operation = plan.operations[0];
  if (operation?.kind !== "update_agent_skills") return;
  assert.equal(operation.skillUpdates[0]?.instruction, "Author the termination review.");
});

const CARD_SUMMARY = "Flags supplier renewal clauses worth renegotiating.";

/** A new Agent as the plan on screen holds it, with or without a card summary. */
function echoedAgent(summary: { summary?: unknown } = {}): Record<string, unknown> {
  return {
    name: "renewal-reviewer",
    role: "Renewal reviewer",
    ...summary,
    description: "Reads every renewal clause and lists its notice window.",
    rationale: "No existing Agent reviews renewals.",
  };
}

/** The same Agent in each place an echoed plan can hold a new one. */
function plansHolding(agent: Record<string, unknown>): Array<Record<string, unknown>> {
  return [
    { id: "plan-standalone", kind: "standalone_agents", agents: [agent] },
    {
      id: "plan-team",
      kind: "team",
      team: {
        teamId: "renewal-team",
        description: "Reviews renewals.",
        tags: [],
        existingAgents: [],
        newAgents: [agent],
        questionsResolved: [],
      },
    },
    {
      id: "plan-update",
      kind: "resource_updates",
      operations: [{
        kind: "add_team_agents",
        target: { kind: "team", id: "renewal-team" },
        expectedRevision: REVISION,
        libraryAgentsToAdd: [],
        newAgentsToCreate: [agent],
      }],
    },
  ];
}

/** Every new Agent the parsed plan holds, whichever kind of plan it is. */
function echoedNewAgents(plan: ReturnType<typeof parseResourceArchitectTurnBody>["currentPlan"]) {
  assert.ok(plan);
  if (plan.kind === "standalone_agents") return plan.agents;
  if (plan.kind === "team") return plan.team.newAgents;
  return plan.operations.flatMap((operation) =>
    operation.kind === "add_team_agents" ? operation.newAgentsToCreate : []);
}

// The echoed plan is what the model is shown on the next turn. Stripping the
// card summary would show it a plan missing copy it wrote, and a revision of
// that plan would have to author the summary again from nothing.
test("a plan echoed on the next turn keeps the card summary of every new Agent", () => {
  for (const plan of plansHolding(echoedAgent({ summary: CARD_SUMMARY }))) {
    const parsed = parseResourceArchitectTurnBody(turnBody(plan));

    assert.deepEqual(
      echoedNewAgents(parsed.currentPlan).map((agent) => agent.summary),
      [CARD_SUMMARY],
      `${String(plan.kind)} lost its card summary`,
    );
  }
});

test("a plan saved before summaries is echoed without one", () => {
  for (const plan of plansHolding(echoedAgent())) {
    const parsed = parseResourceArchitectTurnBody(turnBody(plan));

    const [agent] = echoedNewAgents(parsed.currentPlan);
    assert.ok(agent, `${String(plan.kind)} lost its Agent`);
    assert.equal("summary" in agent, false, `${String(plan.kind)} was given a summary`);
  }
});

test("an echoed Agent whose card summary is present but not usable text is refused", () => {
  for (const summary of [7, null, "   ", { text: CARD_SUMMARY }]) {
    for (const plan of plansHolding(echoedAgent({ summary }))) {
      assert.throws(
        () => parseResourceArchitectTurnBody(turnBody(plan)),
        /summary/u,
        `${String(plan.kind)} accepted the summary ${JSON.stringify(summary)}`,
      );
    }
  }
});

/** A team plan echoed back as `currentPlan` on a follow-up turn. */
function teamPlan(shape?: unknown): Record<string, unknown> {
  return {
    id: "plan-1",
    kind: "team",
    team: {
      teamId: "contract-review-team",
      description: "Reviews contracts.",
      tags: [],
      existingAgents: [
        { name: "risk-lead", role: "Lead", rationale: "Already available." },
      ],
      newAgents: [{
        name: "risk-spotter",
        role: "Risk reviewer",
        description: "Finds clauses that expose you.",
        rationale: "No existing Agent covers this.",
      }],
      questionsResolved: [],
      ...(shape === undefined ? {} : { shape }),
    },
  };
}

// The echoed plan is what the model is shown on the next turn. A reader that
// strips the shape asks the Architect to continue from a plan with the user's
// chosen topology erased, so the next proposal can silently revert it.
test("a Team plan echoed on the next turn keeps the shape the user chose", () => {
  const shape = {
    kind: "discussion",
    rationale: "They disagree usefully.",
    depth: "thorough",
    coordinator: "risk-lead",
    participants: ["risk-spotter"],
  };
  const parsed = parseResourceArchitectTurnBody(turnBody(teamPlan(shape)));
  assert.ok(parsed.currentPlan && parsed.currentPlan.kind === "team");
  assert.deepEqual(parsed.currentPlan.team.shape, shape);
});

// A plan proposed before shapes existed carries no such field and must still
// round-trip, or every older conversation stops being continuable.
test("a Team plan echoed with no shape still round-trips", () => {
  const parsed = parseResourceArchitectTurnBody(turnBody(teamPlan()));
  assert.ok(parsed.currentPlan && parsed.currentPlan.kind === "team");
  assert.equal(parsed.currentPlan.team.shape, undefined);
  assert.equal(parsed.currentPlan.team.teamId, "contract-review-team");
})

// Null is the wire form of "no shape chosen", which is what the provider schema
// offers the model. It means the same as absence and must not be a rejection.
test("a Team plan echoed with an explicit null shape reads as no shape", () => {
  const parsed = parseResourceArchitectTurnBody(turnBody(teamPlan(null)));
  assert.ok(parsed.currentPlan && parsed.currentPlan.kind === "team");
  assert.equal(parsed.currentPlan.team.shape, undefined);
});

test("a Team plan echoed with a shape this app cannot build is refused", () => {
  assert.throws(
    () => parseResourceArchitectTurnBody(
      turnBody(teamPlan({ kind: "broadcast", rationale: "All at once.", depth: "quick" })),
    ),
  );
});
