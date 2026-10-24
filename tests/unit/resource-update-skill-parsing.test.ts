/**
 * Reading a skill update, from the model and from disk.
 *
 * Two boundaries, one set of rules. What the provider sends is rebuilt field by
 * field so an invented revision or an extra key cannot reach the persisted
 * plan, and a plan file read back has to satisfy the same structural
 * invariants the proposal boundary applied — otherwise a file that reached the
 * disk some other way could hand the executor a skill name the proposal would
 * never have accepted.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { parseProposalTurn } from "../../domains/resource-architect/resource-architect-proposal-parser.js";
import {
  parseResourceArchitectPlanRecord,
  parseResourceBuildJobRecord,
} from "../../server/resource-architect-durable-records.js";

const AGENT_ID = "michigan-contract-lawyer";

function proposalText(operation: unknown): string {
  return JSON.stringify({
    message: "Here is the update.",
    warnings: [],
    outcome: { id: "proposal", kind: "resource_updates", operations: [operation] },
  });
}

function skillOperation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "update_agent_skills",
    target: { kind: "agent", id: AGENT_ID },
    skillUpdates: [
      { action: "create", name: "termination-clause-review", instruction: "Author it." },
    ],
    ...overrides,
  };
}

function persistedPlan(skillUpdates: unknown): unknown {
  return {
    id: "plan-1",
    kind: "resource_updates",
    operations: [{
      kind: "update_agent_skills",
      target: { kind: "agent", id: AGENT_ID },
      expectedRevision: `sha256:${"a".repeat(64)}`,
      skillUpdates,
    }],
  };
}

test("a well-formed skill update is read back exactly as the model sent it", () => {
  const result = parseProposalTurn(proposalText(skillOperation()));

  assert.ok(result.ok, result.ok ? "" : result.reason);
  assert.equal(result.value.outcome.kind, "resource_updates");
  if (result.value.outcome.kind !== "resource_updates") return;
  assert.deepEqual(result.value.outcome.operations, [{
    kind: "update_agent_skills",
    target: { kind: "agent", id: AGENT_ID },
    skillUpdates: [
      { action: "create", name: "termination-clause-review", instruction: "Author it." },
    ],
  }]);
});

test("a revision the model attached to a skill update never reaches the plan", () => {
  const result = parseProposalTurn(
    proposalText(skillOperation({ expectedRevision: `sha256:${"f".repeat(64)}` })),
  );

  assert.ok(result.ok, result.ok ? "" : result.reason);
  if (!result.ok || result.value.outcome.kind !== "resource_updates") return;
  const operation = result.value.outcome.operations[0]!;
  assert.equal("expectedRevision" in operation, false);
});

test("a skill update whose target is not an Agent is not an outcome", () => {
  const result = parseProposalTurn(
    proposalText(skillOperation({ target: { kind: "team", id: "contract-review-team" } })),
  );

  assert.equal(result.ok, false);
});

test("a skill entry missing a required field ends the whole outcome", () => {
  for (
    const entry of [
      { action: "create", name: "termination-clause-review" },
      { action: "sideways", name: "termination-clause-review", instruction: "Author it." },
      { action: "create", name: "", instruction: "Author it." },
      "termination-clause-review",
    ]
  ) {
    assert.equal(
      parseProposalTurn(proposalText(skillOperation({ skillUpdates: [entry] }))).ok,
      false,
      `expected ${JSON.stringify(entry)} to end the outcome`,
    );
  }
});

/**
 * A skill name is a folder name and the `name` its frontmatter must carry, so
 * it is identity, not prose. Trimming it here would turn a name the policy
 * would refuse into a valid filesystem identity before the policy ever sees
 * it, and the name that was validated would not be the name that was
 * published.
 */
test("a skill name is read exactly as sent, never trimmed into a valid one", () => {
  const result = parseProposalTurn(
    proposalText(skillOperation({
      skillUpdates: [
        { action: "create", name: " termination-clause-review ", instruction: "Author it." },
      ],
    })),
  );

  assert.ok(result.ok, result.ok ? "" : result.reason);
  if (!result.ok || result.value.outcome.kind !== "resource_updates") return;
  const operation = result.value.outcome.operations[0]!;
  assert.equal(operation.kind, "update_agent_skills");
  if (operation.kind !== "update_agent_skills") return;
  assert.equal(operation.skillUpdates[0]?.name, " termination-clause-review ");
});

test("an Agent target id is read exactly as sent, never trimmed into a valid one", () => {
  const result = parseProposalTurn(
    proposalText(skillOperation({ target: { kind: "agent", id: ` ${AGENT_ID} ` } })),
  );

  assert.ok(result.ok, result.ok ? "" : result.reason);
  if (!result.ok || result.value.outcome.kind !== "resource_updates") return;
  assert.equal(result.value.outcome.operations[0]?.target.id, ` ${AGENT_ID} `);
});

test("an instruction is prose, so surrounding whitespace is normalized away", () => {
  const result = parseProposalTurn(
    proposalText(skillOperation({
      skillUpdates: [
        { action: "create", name: "termination-clause-review", instruction: "  Author it.  " },
      ],
    })),
  );

  assert.ok(result.ok, result.ok ? "" : result.reason);
  if (!result.ok || result.value.outcome.kind !== "resource_updates") return;
  const operation = result.value.outcome.operations[0]!;
  if (operation.kind !== "update_agent_skills") return;
  assert.equal(operation.skillUpdates[0]?.instruction, "Author it.");
});

test("a skillUpdates value that is not a list is not read as no skills", () => {
  assert.equal(
    parseProposalTurn(proposalText(skillOperation({ skillUpdates: "create one" }))).ok,
    false,
  );
});

test("a persisted skill update that satisfies every invariant is a plan", () => {
  const plan = parseResourceArchitectPlanRecord(
    persistedPlan([
      { action: "create", name: "termination-clause-review", instruction: "Author it." },
      { action: "update", name: "indemnity-clause-review", instruction: "Rewrite it." },
    ]),
  );

  assert.ok(plan);
  assert.equal(plan.kind, "resource_updates");
});

test("a persisted skill update that breaks a structural invariant is not a plan", () => {
  const cases: Array<[string, unknown]> = [
    ["no skills at all", []],
    ["a duplicated name", [
      { action: "create", name: "termination-clause-review", instruction: "Author it." },
      { action: "update", name: "termination-clause-review", instruction: "Rewrite it." },
    ]],
    ["a name that is not exact kebab-case", [
      { action: "create", name: "Termination Review", instruction: "Author it." },
    ]],
    ["a name that would escape the skills folder", [
      { action: "create", name: "../escape", instruction: "Author it." },
    ]],
    ["an instruction that says nothing", [
      { action: "create", name: "termination-clause-review", instruction: "   " },
    ]],
  ];

  for (const [description, skillUpdates] of cases) {
    assert.equal(
      parseResourceArchitectPlanRecord(persistedPlan(skillUpdates)),
      null,
      `expected ${description} to be refused`,
    );
  }
});

/**
 * The durable contract says revisions are server-owned sha256 digests. A
 * persisted operation carrying anything else was not written by this server,
 * and running it would check the Agent against a revision nothing calculated.
 */
test("a persisted skill update whose revision is not a server digest is not a plan", () => {
  for (
    const expectedRevision of [
      "",
      "not-a-digest",
      "sha256:short",
      `sha1:${"a".repeat(40)}`,
      `sha256:${"A".repeat(64)}`,
    ]
  ) {
    assert.equal(
      parseResourceArchitectPlanRecord({
        id: "plan-1",
        kind: "resource_updates",
        operations: [{
          kind: "update_agent_skills",
          target: { kind: "agent", id: AGENT_ID },
          expectedRevision,
          skillUpdates: [
            { action: "create", name: "termination-clause-review", instruction: "Author it." },
          ],
        }],
      }),
      null,
      `expected the revision ${JSON.stringify(expectedRevision)} to be refused`,
    );
  }
});

test("a persisted plan may update one Agent only once", () => {
  const operation = {
    kind: "update_agent_skills",
    target: { kind: "agent", id: AGENT_ID },
    expectedRevision: `sha256:${"a".repeat(64)}`,
    skillUpdates: [
      { action: "create", name: "termination-clause-review", instruction: "Author it." },
    ],
  };

  assert.equal(
    parseResourceArchitectPlanRecord({
      id: "plan-1",
      kind: "resource_updates",
      operations: [operation, { ...operation, skillUpdates: [
        { action: "update", name: "indemnity-clause-review", instruction: "Rewrite it." },
      ] }],
    }),
    null,
  );
});

/**
 * A Team target is identity too.
 *
 * The skill branch keeps `target.id` exactly as it arrived so the policy can
 * refuse a name this repository would never publish. The Team branch trimmed
 * it, which turns a padded alias into the id of a Team that really exists —
 * the model names one thing and the server mutates another.
 */
test("a Team target id is read exactly as sent, never trimmed onto a real Team", () => {
  const result = parseProposalTurn(JSON.stringify({
    message: "Here is the update.",
    warnings: [],
    outcome: {
      id: "proposal",
      kind: "resource_updates",
      operations: [{
        kind: "add_team_agents",
        target: { kind: "team", id: " contract-review-team " },
        libraryAgentsToAdd: [{
          name: "scoping-lawyer",
          role: "Scope reviewer",
          tier: "strategic",
          rationale: "Reuse.",
        }],
        newAgentsToCreate: [],
      }],
    },
  }));

  assert.ok(result.ok, result.ok ? "" : result.reason);
  if (!result.ok || result.value.outcome.kind !== "resource_updates") return;
  assert.equal(result.value.outcome.operations[0]?.target.id, " contract-review-team ");
});

/**
 * A persisted target id is executed, not interpreted.
 *
 * The Team writer sanitizes the id it is given — lowercasing it and replacing
 * anything outside `a-z0-9_-` — so a plan file naming ` Contract-Review-Team `
 * would be accepted here and then mutate `contract-review-team`. A plan that
 * names one target and changes another is not a plan.
 */
test("a persisted plan whose target id is an alias is not a plan", () => {
  const aliases = [
    " contract-review-team ",
    "Contract-Review-Team",
    "contract review team",
    "contract-review-team/",
    "../contract-review-team",
  ];

  for (const id of aliases) {
    assert.equal(
      parseResourceArchitectPlanRecord({
        id: "plan-1",
        kind: "resource_updates",
        operations: [{
          kind: "add_team_agents",
          target: { kind: "team", id },
          expectedRevision: `sha256:${"a".repeat(64)}`,
          libraryAgentsToAdd: [{
            name: "scoping-lawyer",
            role: "Scope reviewer",
            tier: "strategic",
            rationale: "Reuse.",
          }],
          newAgentsToCreate: [],
        }],
      }),
      null,
      `expected the Team alias ${JSON.stringify(id)} to be refused`,
    );
  }

  for (const id of aliases.map((alias) => alias.replace("contract-review-team", "michigan-contract-lawyer"))) {
    assert.equal(
      parseResourceArchitectPlanRecord(persistedPlanFor(id)),
      null,
      `expected the Agent alias ${JSON.stringify(id)} to be refused`,
    );
  }
});

test("a persisted plan naming its targets exactly is still a plan", () => {
  assert.ok(parseResourceArchitectPlanRecord(persistedPlanFor(AGENT_ID)));
});

function persistedPlanFor(agentId: string): unknown {
  return {
    id: "plan-1",
    kind: "resource_updates",
    operations: [{
      kind: "update_agent_skills",
      target: { kind: "agent", id: agentId },
      expectedRevision: `sha256:${"a".repeat(64)}`,
      skillUpdates: [
        { action: "create", name: "termination-clause-review", instruction: "Author it." },
      ],
    }],
  };
}

/**
 * The Agent names a persisted addition carries are executed too.
 *
 * The Team writer sanitizes each addition name before it looks the Agent up
 * and writes the roster entry, so a plan file naming ' scoping-lawyer ' or
 * 'Scoping Lawyer' would add `scoping-lawyer`. The plan would name one Agent
 * and the Team would gain another.
 */
test("a persisted addition whose Agent name is an alias is not a plan", () => {
  for (const name of [" scoping-lawyer ", "Scoping Lawyer", "scoping_lawyer!", ""]) {
    assert.equal(
      parseResourceArchitectPlanRecord(teamAdditionPlan({ libraryName: name })),
      null,
      `expected the library alias ${JSON.stringify(name)} to be refused`,
    );
    assert.equal(
      parseResourceArchitectPlanRecord(teamAdditionPlan({ newName: name })),
      null,
      `expected the new-Agent alias ${JSON.stringify(name)} to be refused`,
    );
  }
});

test("a persisted addition naming its Agents exactly is still a plan", () => {
  assert.ok(parseResourceArchitectPlanRecord(teamAdditionPlan({})));
});

function teamAdditionPlan(
  overrides: {
    libraryName?: string;
    newName?: string;
    empty?: boolean;
    duplicate?: boolean;
  },
): unknown {
  const library = {
    name: overrides.libraryName ?? "scoping-lawyer",
    role: "Scope reviewer",
    tier: "strategic",
    rationale: "Reuse.",
  };
  return {
    id: "plan-1",
    kind: "resource_updates",
    operations: [{
      kind: "add_team_agents",
      target: { kind: "team", id: "contract-review-team" },
      expectedRevision: `sha256:${"a".repeat(64)}`,
      libraryAgentsToAdd: overrides.empty
        ? []
        : overrides.duplicate
          ? [library, library]
          : [library],
      newAgentsToCreate: overrides.newName === undefined ? [] : [{
        name: overrides.newName,
        role: "Drafting reviewer",
        tier: "strategic",
        description: "Checks drafting completeness.",
        rationale: "No existing Agent covers drafting gaps.",
      }],
    }],
  };
}

/**
 * An Agent an update adds is identity too.
 *
 * The policy checks a library addition against the Agent library and validates
 * a new name against the repository rule. Trimming first means a padded
 * ` scoping-lawyer ` is checked as `scoping-lawyer` and then added as one —
 * the model names something that does not exist and a real Agent joins the
 * Team. Creation plans are unchanged; this is about the update operation.
 */
test("an Agent an update operation adds is read exactly as sent", () => {
  for (const key of ["libraryAgentsToAdd", "newAgentsToCreate"] as const) {
    const result = parseProposalTurn(JSON.stringify({
      message: "Here is the update.",
      warnings: [],
      outcome: {
        id: "proposal",
        kind: "resource_updates",
        operations: [{
          kind: "add_team_agents",
          target: { kind: "team", id: "contract-review-team" },
          libraryAgentsToAdd: key === "libraryAgentsToAdd"
            ? [{
              name: " scoping-lawyer ",
              role: "Scope reviewer",
              tier: "strategic",
              rationale: "Reuse.",
            }]
            : [],
          newAgentsToCreate: key === "newAgentsToCreate"
            ? [{
              name: " drafting-completeness-lawyer ",
              role: "Drafting reviewer",
              tier: "strategic",
              summary: "Finds drafting gaps before a contract is signed.",
              description: "Checks drafting completeness.",
              rationale: "No existing Agent covers drafting gaps.",
              documentSpecialization: null,
            }]
            : [],
        }],
      },
    }));

    assert.ok(result.ok, result.ok ? "" : result.reason);
    if (!result.ok || result.value.outcome.kind !== "resource_updates") return;
    const operation = result.value.outcome.operations[0];
    assert.ok(operation && operation.kind === "add_team_agents");
    const names = [
      ...operation.libraryAgentsToAdd.map((agent) => agent.name),
      ...operation.newAgentsToCreate.map((agent) => agent.name),
    ];
    assert.ok(
      names.some((name) => name.startsWith(" ") && name.endsWith(" ")),
      `expected ${key} to keep its exact name, got ${JSON.stringify(names)}`,
    );
  }
});

/**
 * A Team addition that adds nothing, or adds one Agent twice, is not a plan.
 *
 * The proposal boundary refuses both. A plan file that reached the disk some
 * other way carries no such guarantee: an operation with two empty lists
 * reaches the executor with no names at all and can be journaled as `updated`
 * having changed no roster, and a duplicate reaches the Team writer twice.
 */
test("a persisted Team addition that adds nothing is not a plan", () => {
  assert.equal(
    parseResourceArchitectPlanRecord(teamAdditionPlan({ empty: true })),
    null,
  );
});

test("a persisted Team addition naming one Agent twice is not a plan", () => {
  assert.equal(
    parseResourceArchitectPlanRecord(teamAdditionPlan({ duplicate: true })),
    null,
  );
});

/** One library Agent may still join two different Teams in one plan. */
test("the same library Agent may be added to two Teams in one persisted plan", () => {
  const operation = (teamId: string) => ({
    kind: "add_team_agents",
    target: { kind: "team", id: teamId },
    expectedRevision: `sha256:${"a".repeat(64)}`,
    libraryAgentsToAdd: [{
      name: "scoping-lawyer",
      role: "Scope reviewer",
      tier: "strategic",
      rationale: "Reuse.",
    }],
    newAgentsToCreate: [],
  });

  assert.ok(parseResourceArchitectPlanRecord({
    id: "plan-1",
    kind: "resource_updates",
    operations: [operation("contract-review-team"), operation("diligence-team")],
  }));
});

/** A persisted skill-update job carrying the given events. */
function persistedSkillJob(events: unknown[]): Record<string, unknown> {
  return {
    jobId: "job-1",
    planId: "plan-1",
    status: "failed",
    items: [{
      plannedResource: { kind: "agent", id: AGENT_ID },
      planIndex: 0,
      status: "failed",
      error: "The skill author did not answer.",
    }],
    selectedResource: null,
    events: [{ id: 1, type: "build_started", message: "Started." }, ...events],
    error: "The skill author did not answer.",
  };
}

function skillEvent(
  id: number,
  type: string,
  skill: unknown = { name: "termination-clause-review", action: "create" },
): Record<string, unknown> {
  return {
    id,
    type,
    plannedResource: { kind: "agent", id: AGENT_ID },
    planIndex: 0,
    skill,
    message: `${type} termination-clause-review`,
  };
}

test("a persisted job reads back every skill-scoped event with the skill it names", () => {
  const events = [
    skillEvent(2, "skill_generating"),
    skillEvent(3, "skill_staged"),
    skillEvent(4, "skill_updated"),
    skillEvent(5, "skill_failed", { name: "indemnity-clause-review", action: "update" }),
    skillEvent(6, "skill_cancelled", { name: "cure-period-review", action: "create" }),
  ];

  const job = parseResourceBuildJobRecord(persistedSkillJob(events));

  assert.ok(job, "a job with well-formed skill events is a job");
  assert.deepEqual(
    job.events.slice(1).map((event) => [event.type, event.skill?.name, event.skill?.action]),
    [
      ["skill_generating", "termination-clause-review", "create"],
      ["skill_staged", "termination-clause-review", "create"],
      ["skill_updated", "termination-clause-review", "create"],
      ["skill_failed", "indemnity-clause-review", "update"],
      ["skill_cancelled", "cure-period-review", "create"],
    ],
  );
});

test("a skill-scoped event whose skill identity is missing or malformed is not a job", () => {
  const malformed: Array<[string, unknown]> = [
    ["no identity", undefined],
    ["an identity that is not an object", "termination-clause-review"],
    ["a blank skill name", { name: "", action: "create" }],
    ["a skill name that is not a string", { name: 7, action: "create" }],
    ["an action that is not create or update", { name: "termination-clause-review", action: "delete" }],
    ["no action", { name: "termination-clause-review" }],
  ];
  for (const [description, skill] of malformed) {
    const event = skillEvent(2, "skill_staged", skill);
    if (skill === undefined) delete event.skill;

    assert.equal(
      parseResourceBuildJobRecord(persistedSkillJob([event])),
      null,
      `expected a skill event with ${description} to refuse the job`,
    );
  }
});

test("a skill-scoped event that names no operation is not a job", () => {
  // The card places a skill by plan index and name. Without the index the
  // event reaches no row, so the job cannot say where that skill stands.
  const event = skillEvent(2, "skill_failed");
  delete event.planIndex;

  assert.equal(parseResourceBuildJobRecord(persistedSkillJob([event])), null);
});

test("a skill identity on an event that is not about one skill is not a job", () => {
  const event = skillEvent(2, "resource_update_failed");

  assert.equal(parseResourceBuildJobRecord(persistedSkillJob([event])), null);
});

test("a job recorded before skill events existed still reads back whole", () => {
  const legacy = persistedSkillJob([
    {
      id: 2,
      type: "resource_update_started",
      plannedResource: { kind: "agent", id: AGENT_ID },
      planIndex: 0,
      message: `Updating Agent \`${AGENT_ID}\`.`,
    },
    {
      id: 3,
      type: "resource_update_failed",
      plannedResource: { kind: "agent", id: AGENT_ID },
      planIndex: 0,
      message: "Could not update it.",
    },
  ]);

  const job = parseResourceBuildJobRecord(legacy);

  assert.ok(job);
  assert.deepEqual(job.events.map((event) => event.type), [
    "build_started",
    "resource_update_started",
    "resource_update_failed",
  ]);
  assert.equal(job.events.some((event) => event.skill !== undefined), false);
});
