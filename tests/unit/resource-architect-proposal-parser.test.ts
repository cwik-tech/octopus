/**
 * What the Agent Architect will accept from a provider.
 *
 * The provider's answer is untrusted text. Every field of every outcome is
 * rebuilt here from `unknown`, so a proposal that reaches the server describes
 * only values this parser constructed. These cases fix what "constructed"
 * means: a list with one unusable entry is not a shorter list, an extra field
 * the model invented is not carried on, and a pointer that writes nothing
 * carries nothing to write with.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { PlannedAgentSpec } from "../../contracts/agent-generator.js";
import { parseProposalTurn } from "../../domains/resource-architect/resource-architect-proposal-parser.js";

function answer(outcome: unknown, message = "Here is the proposal."): string {
  return JSON.stringify({ message, warnings: [], outcome });
}

function plannedAgent(name: string): Record<string, unknown> {
  return {
    name,
    role: "Reviewer",
    summary: `Checks contracts for ${name}.`,
    description: `${name} checks contracts.`,
    rationale: "No existing Agent covers this.",
  };
}

function libraryAgent(name: string): Record<string, unknown> {
  return { name, role: "Reviewer", rationale: "Reuse." };
}

test("a proposal preserves the architect's internet access recommendation", () => {
  const outcome = {
    id: "proposal", kind: "standalone_agents",
    agents: [{ ...plannedAgent("product-reviewer"), webResearchEnabled: true }],
  };
  const result = parseProposalTurn(answer(outcome));
  assert.ok(result.ok);
  assert.deepEqual(result.value.outcome, outcome);
});

test("a proposal rejects a non-boolean internet access recommendation", () => {
  const result = parseProposalTurn(answer({
    id: "proposal", kind: "standalone_agents",
    agents: [{ ...plannedAgent("product-reviewer"), webResearchEnabled: "true" }],
  }));
  assert.equal(result.ok, false);
});

test("a pointer to an existing resource carries only the resource it points at", () => {
  const result = parseProposalTurn(
    answer({
      kind: "edit_existing",
      target: { kind: "team", id: "contract-review-team" },
    }),
  );

  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return;
  assert.deepEqual(result.value.outcome, {
    kind: "edit_existing",
    target: { kind: "team", id: "contract-review-team" },
  });
});

test("a revision attached to a pointer is dropped rather than carried on", () => {
  // The pointer writes nothing, so nothing checks a revision against anything.
  // Carrying one would put a value in the answer that reads like a guarantee.
  const result = parseProposalTurn(
    answer({
      kind: "edit_existing",
      target: { kind: "agent", id: "scoping-lawyer" },
      expectedRevision: "sha256:whatever-the-model-invented",
    }),
  );

  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return;
  assert.deepEqual(Object.keys(result.value.outcome).sort(), ["kind", "target"]);
});

test("a pointer with no usable target is refused", () => {
  for (const outcome of [
    { kind: "edit_existing", target: { kind: "workflow", id: "x" } },
    { kind: "edit_existing", target: { kind: "team", id: "" } },
    { kind: "edit_existing" },
  ]) {
    const result = parseProposalTurn(answer(outcome));
    assert.equal(result.ok, false, JSON.stringify(outcome));
  }
});

test("one unusable Agent refuses the whole standalone proposal", () => {
  const result = parseProposalTurn(
    answer({
      id: "proposal",
      kind: "standalone_agents",
      agents: [plannedAgent("scoping-lawyer"), { name: "no-role-lawyer" }],
    }),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "outcome is invalid");
});

test("one unusable operation refuses the whole update proposal", () => {
  const result = parseProposalTurn(
    answer({
      id: "proposal",
      kind: "resource_updates",
      operations: [
        {
          kind: "add_team_agents",
          target: { kind: "team", id: "contract-review-team" },
          libraryAgentsToAdd: [libraryAgent("scoping-lawyer")],
          newAgentsToCreate: [],
        },
        {
          kind: "add_team_agents",
          target: { kind: "team", id: "diligence-team" },
          libraryAgentsToAdd: [{ name: "half-described-lawyer" }],
          newAgentsToCreate: [],
        },
      ],
    }),
  );

  assert.equal(result.ok, false);
});

test("an update operation keeps only the fields the contract defines", () => {
  const result = parseProposalTurn(
    answer({
      id: "proposal",
      kind: "resource_updates",
      operations: [{
        kind: "add_team_agents",
        target: { kind: "team", id: "contract-review-team", extra: "ignored" },
        expectedRevision: "sha256:invented",
        libraryAgentsToAdd: [{ ...libraryAgent("scoping-lawyer"), extra: "ignored" }],
        newAgentsToCreate: [plannedAgent("drafting-completeness-lawyer")],
      }],
    }),
  );

  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok || result.value.outcome.kind !== "resource_updates") {
    assert.fail("expected an update proposal");
  }
  const operation = result.value.outcome.operations[0];
  assert.ok(operation);
  assert.deepEqual(Object.keys(operation).sort(), [
    "kind",
    "libraryAgentsToAdd",
    "newAgentsToCreate",
    "target",
  ]);
  assert.deepEqual(Object.keys(operation.target).sort(), ["id", "kind"]);
  if (operation.kind !== "add_team_agents") assert.fail("expected add_team_agents");
  assert.deepEqual(Object.keys(operation.libraryAgentsToAdd[0] ?? {}).sort(), [
    "name",
    "rationale",
    "role",
  ]);
});

test("one unusable document domain refuses the whole Team proposal", () => {
  const result = parseProposalTurn(
    answer({
      id: "proposal",
      kind: "team",
      team: {
        teamId: "contract-review-team",
        description: "Reviews contracts.",
        tags: [],
        existingAgents: [],
        newAgents: [plannedAgent("drafting-completeness-lawyer")],
        documentDomains: [
          { domain: "Contract drafting", evidenceAnchors: ["limitation period"] },
          { domain: "Anchorless domain", evidenceAnchors: [] },
        ],
        questionsResolved: [],
      },
    }),
  );

  assert.equal(result.ok, false);
});

test("a Team that declares no document domains keeps the rest of its proposal", () => {
  // Codex requires the key on every team, so `null` is how a team with no
  // document domains says so. Reading it as malformed would lose the proposal.
  const result = parseProposalTurn(
    answer({
      id: "proposal",
      kind: "team",
      team: {
        teamId: "contract-review-team",
        description: "Reviews contracts.",
        tags: ["legal"],
        existingAgents: [libraryAgent("scoping-lawyer")],
        newAgents: [plannedAgent("drafting-completeness-lawyer")],
        documentDomains: null,
        questionsResolved: [],
      },
    }),
  );

  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok || result.value.outcome.kind !== "team") {
    assert.fail("expected a Team proposal");
  }
  assert.equal("documentDomains" in result.value.outcome.team, false);
  assert.deepEqual(
    result.value.outcome.team.newAgents.map((agent) => agent.name),
    ["drafting-completeness-lawyer"],
  );
});

test("one unusable new Agent refuses the whole Team proposal", () => {
  const result = parseProposalTurn(
    answer({
      id: "proposal",
      kind: "team",
      team: {
        teamId: "contract-review-team",
        description: "Reviews contracts.",
        tags: [],
        existingAgents: [],
        newAgents: [
          plannedAgent("drafting-completeness-lawyer"),
          { ...plannedAgent("specialized-lawyer"), documentSpecialization: { focus: "" } },
        ],
        questionsResolved: [],
      },
    }),
  );

  assert.equal(result.ok, false);
});

test("a new Agent name longer than the build boundary allows refuses the proposal", () => {
  const result = parseProposalTurn(
    answer({
      id: "proposal",
      kind: "team",
      team: {
        teamId: "workplace-safety-team",
        description: "Reviews workplace safety requirements.",
        tags: ["safety"],
        existingAgents: [],
        newAgents: [plannedAgent("safety-environmental-compliance-specialist")],
        documentDomains: null,
        questionsResolved: [],
      },
    }),
  );

  assert.equal(result.ok, false);
});

test("a required list the model did not send as a list refuses the outcome", () => {
  // The schema requires both addition lists on every operation. Reading a
  // string as an empty list would accept a plan that silently drops the very
  // Agent the user asked to reuse.
  const result = parseProposalTurn(
    answer({
      id: "proposal",
      kind: "resource_updates",
      operations: [{
        kind: "add_team_agents",
        target: { kind: "team", id: "contract-review-team" },
        libraryAgentsToAdd: "scoping-lawyer",
        newAgentsToCreate: [plannedAgent("drafting-completeness-lawyer")],
      }],
    }),
  );

  assert.equal(result.ok, false);
});

test("a required list a Team proposal omits refuses the outcome", () => {
  const result = parseProposalTurn(
    answer({
      id: "proposal",
      kind: "team",
      team: {
        teamId: "contract-review-team",
        description: "Reviews contracts.",
        tags: [],
        newAgents: [plannedAgent("drafting-completeness-lawyer")],
        questionsResolved: [],
      },
    }),
  );

  assert.equal(result.ok, false);
});

test("one unusable entry in a required string list refuses the outcome", () => {
  // Dropping the entry would accept a shorter list than the model sent, which
  // is the same silent rewrite the entry-level rule exists to prevent.
  for (const tags of [["legal", 7], ["legal", ""], "legal"]) {
    const result = parseProposalTurn(
      answer({
        id: "proposal",
        kind: "team",
        team: {
          teamId: "contract-review-team",
          description: "Reviews contracts.",
          tags,
          existingAgents: [],
          newAgents: [plannedAgent("drafting-completeness-lawyer")],
          questionsResolved: [],
        },
      }),
    );
    assert.equal(result.ok, false, JSON.stringify(tags));
  }
});

test("warnings are response metadata and stay tolerant", () => {
  // Warnings describe the answer, not the resources it proposes. A malformed
  // one loses a note; refusing the proposal over it would lose the work.
  const result = parseProposalTurn(
    JSON.stringify({
      message: "Here is the proposal.",
      warnings: ["watch the limitation period", 7, ""],
      outcome: { kind: "discussion" },
    }),
  );

  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return;
  assert.deepEqual(result.value.warnings, ["watch the limitation period"]);
});

test("a proposal that names no grade is accepted", () => {
  // Grades are no longer part of authoring, so the model is not asked for one
  // and a proposal without one is complete. Refusing it — which is what this
  // parser used to do — would make every proposal the current prompt produces
  // unusable.
  const standalone = parseProposalTurn(
    answer({
      id: "proposal",
      kind: "standalone_agents",
      agents: [plannedAgent("scoping-lawyer")],
    }),
  );

  assert.equal(standalone.ok, true, standalone.ok ? "" : standalone.reason);
  if (!standalone.ok || standalone.value.outcome.kind !== "standalone_agents") {
    assert.fail("expected a standalone proposal");
  }
  assert.deepEqual(
    standalone.value.outcome.agents.map((agent) => agent.name),
    ["scoping-lawyer"],
  );
});

test("a grade the model volunteers anyway is dropped from the plan", () => {
  // The prompt no longer shows one, but a model can still write whatever it
  // likes. It is dropped here rather than carried into a plan that has nowhere
  // to put it — and dropping it is not the same as refusing the proposal.
  for (const tier of ["specialist", "", 3]) {
    const standalone = parseProposalTurn(
      answer({
        id: "proposal",
        kind: "standalone_agents",
        agents: [{ ...plannedAgent("scoping-lawyer"), tier }],
      }),
    );

    assert.equal(standalone.ok, true, `standalone tier ${JSON.stringify(tier)}`);
    if (!standalone.ok || standalone.value.outcome.kind !== "standalone_agents") {
      assert.fail("expected a standalone proposal");
    }
    assert.deepEqual(Object.keys(standalone.value.outcome.agents[0] ?? {}).sort(), [
      "description",
      "name",
      "rationale",
      "role",
      "summary",
    ]);

    const update = parseProposalTurn(
      answer({
        id: "proposal",
        kind: "resource_updates",
        operations: [{
          kind: "add_team_agents",
          target: { kind: "team", id: "contract-review-team" },
          libraryAgentsToAdd: [{ ...libraryAgent("scoping-lawyer"), tier }],
          newAgentsToCreate: [],
        }],
      }),
    );
    assert.equal(update.ok, true, `library tier ${JSON.stringify(tier)}`);
    if (!update.ok || update.value.outcome.kind !== "resource_updates") {
      assert.fail("expected an update proposal");
    }
    const operation = update.value.outcome.operations[0];
    assert.ok(operation && operation.kind === "add_team_agents");
    assert.deepEqual(Object.keys(operation.libraryAgentsToAdd[0] ?? {}).sort(), [
      "name",
      "rationale",
      "role",
    ]);
  }
});

/** A team proposal with whatever shape field the case under test supplies. */
function teamProposalText(shape: unknown): string {
  return answer({
    id: "proposal",
    kind: "team",
    team: {
      teamId: "debate-team",
      description: "A team that argues about a decision.",
      tags: [],
      // A proposal describes the team as it will finally be, so the roster is
      // real. An empty one cannot satisfy any shape's role rules, and a fixture
      // with no members would only be testing that nothing is checked.
      existingAgents: [
        { name: "lead", role: "Lead", rationale: "Already available." },
      ],
      newAgents: [{
        name: "spotter",
        role: "Risk reviewer",
        summary: "Spots the contract clauses that carry risk.",
        description: "Finds risky clauses.",
        rationale: "Needed.",
      }],
      documentDomains: null,
      questionsResolved: [],
      ...(shape === MISSING ? {} : { shape }),
    },
  });
}

/** Distinguishes "no shape key at all" from an explicit value under test. */
const MISSING = Symbol("missing");

/** The team plan a proposal turn produced, or a readable failure. */
function teamPlanFrom(text: string) {
  const result = parseProposalTurn(text);
  if (!result.ok) throw new Error(result.reason);
  const outcome = result.value.outcome;
  assert.equal(outcome?.kind, "team");
  if (outcome?.kind !== "team") throw new Error("not a team proposal");
  return outcome.team;
}

test("a proposed shape is carried onto the plan, rebuilt from unknown", () => {
  const team = teamPlanFrom(
    teamProposalText({
      kind: "discussion",
      rationale: "They disagree usefully.",
      depth: "thorough",
      coordinator: "lead",
      participants: ["spotter"],
    }),
  );
  assert.deepEqual(team.shape, {
    kind: "discussion",
    rationale: "They disagree usefully.",
    depth: "thorough",
    coordinator: "lead",
    participants: ["spotter"],
  });
});

// A malformed shape is refused by name, not dropped. Dropping it built the
// legacy chain while the card described something else, and said nothing.
test("a shape the contract does not describe is refused, and the reason names it", () => {
  for (const [bad, expected] of [
    [{ kind: "broadcast", rationale: "r", depth: "quick" }, /broadcast/u],
    [{ kind: "discussion", rationale: "r", depth: "quick", coordinator: "lead" }, /discussion/u],
    [{ kind: "chain", rationale: "", depth: "quick", order: ["lead"] }, /chain/u],
    [{ kind: "review", rationale: "r", depth: "forever", producer: "lead", reviewer: "spotter" }, /review/u],
    ["discussion", /work together/u],
    [42, /work together/u],
  ] as const) {
    const result = parseProposalTurn(teamProposalText(bad));
    assert.equal(result.ok, false, JSON.stringify(bad));
    if (result.ok) continue;
    // The reason is quoted to the model in the repair turn, so it has to say
    // what to fix rather than "outcome is invalid".
    assert.match(result.reason, expected, JSON.stringify(bad));
  }
});

// Absence is the legacy case and stays non-fatal: it builds the chain that
// generated teams have always built.
test("a proposal with no shape at all is still accepted", () => {
  const team = teamPlanFrom(teamProposalText(MISSING));
  assert.equal(team.shape, undefined);
  assert.equal(team.teamId, "debate-team");
});

// Null is the wire form the provider schema offers for "not chosen". It means
// the same as absence and is not a rejection.
test("a proposal whose shape is explicitly null reads as no shape", () => {
  const team = teamPlanFrom(teamProposalText(null));
  assert.equal(team.shape, undefined);
});

// The roles must partition the final roster, exactly as they must at
// amendment. A coordinator who is not on the team names an agent that will
// never exist, and the emitted team.yaml would fail to parse at run time.
test("a proposal naming someone who is not on the team is refused", () => {
  const result = parseProposalTurn(
    teamProposalText({
      kind: "discussion",
      rationale: "Independent perspectives.",
      depth: "standard",
      coordinator: "outsider",
      participants: ["spotter"],
    }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /outsider/u);
});

// Leaving a member out is the other half of the partition rule: that agent
// joins the team and never runs.
test("a proposal that leaves a team member with no role is refused", () => {
  const result = parseProposalTurn(
    teamProposalText({
      kind: "chain",
      rationale: "Just the one.",
      depth: "quick",
      order: ["lead"],
    }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /spotter/u);
});

// A review is exactly two members, so a third is refused here too rather than
// joining a roster it can never run in.
test("a proposal whose review leaves a spare member is refused", () => {
  const result = parseProposalTurn(
    teamProposalText({
      kind: "review",
      rationale: "One writes, one checks.",
      depth: "quick",
      producer: "lead",
      reviewer: "spotter",
    }),
  );
  // lead and spotter are the whole roster, so this one is valid.
  assert.equal(result.ok, true);
});

// The roles the model names are not trusted to be complete. An extra key on a
// shape is a value nobody validated, and carrying it would put it in front of
// the emitter.
test("a shape carrying an invented field does not reach the plan with it", () => {
  const team = teamPlanFrom(
    teamProposalText({
      kind: "review",
      rationale: "One writes, one checks.",
      depth: "quick",
      producer: "lead",
      reviewer: "spotter",
      escalateTo: "nobody@example.com",
    }),
  );
  assert.deepEqual(Object.keys(team.shape ?? {}).sort(), [
    "depth",
    "kind",
    "producer",
    "rationale",
    "reviewer",
  ]);
});

/** One proposal of each shape that creates `agent`, for rules every shape shares. */
function newAgentProposals(agent: Record<string, unknown>): Array<[string, unknown]> {
  return [
    ["standalone", { id: "proposal", kind: "standalone_agents", agents: [agent] }],
    ["team", {
      id: "proposal",
      kind: "team",
      team: {
        teamId: "renewal-review-team",
        description: "Reviews supplier contract renewals.",
        tags: [],
        existingAgents: [],
        newAgents: [{ ...agent, documentSpecialization: null }],
        documentDomains: null,
        questionsResolved: [],
      },
    }],
    ["team update", {
      id: "proposal",
      kind: "resource_updates",
      operations: [{
        kind: "add_team_agents",
        target: { kind: "team", id: "supplier-review-team" },
        libraryAgentsToAdd: [],
        newAgentsToCreate: [{ ...agent, documentSpecialization: null }],
      }],
    }],
  ];
}

/** The new Agents a parsed outcome proposes, whatever its shape. */
function proposedNewAgents(text: string): PlannedAgentSpec[] {
  const result = parseProposalTurn(text);
  if (!result.ok) assert.fail(result.reason);
  const outcome = result.value.outcome;
  if (outcome.kind === "standalone_agents") return [...outcome.agents];
  if (outcome.kind === "team") return [...outcome.team.newAgents];
  if (outcome.kind === "resource_updates") {
    return outcome.operations.flatMap((operation) =>
      operation.kind === "add_team_agents" ? operation.newAgentsToCreate : [],
    );
  }
  return assert.fail(`no new Agents in ${outcome.kind}`);
}

test("a new Agent keeps its card summary beside its build brief in every proposal shape", () => {
  const brief = "BRIEF-MARKER: read every renewal clause, list notice windows, and flag escalators.";
  for (const [shape, outcome] of newAgentProposals({
    ...plannedAgent("renewal-risk-reviewer"),
    summary: "  Flags supplier renewal clauses worth renegotiating.  ",
    description: brief,
  })) {
    const [agent] = proposedNewAgents(answer(outcome));
    assert.equal(agent?.summary, "Flags supplier renewal clauses worth renegotiating.", shape);
    assert.equal(agent?.description, brief, shape);
  }
});

test("a missing, blank, or oversized summary refuses the proposal and says which Agent", () => {
  const withSummary = (summary: unknown): Record<string, unknown> => {
    const { summary: _valid, ...agent } = plannedAgent("renewal-risk-reviewer");
    return summary === undefined ? agent : { ...agent, summary };
  };
  for (const [label, summary] of [
    ["missing", undefined],
    ["blank", "   "],
    ["not text", 7],
    ["241 characters", "a".repeat(241)],
  ] as const) {
    for (const [shape, outcome] of newAgentProposals(withSummary(summary))) {
      const result = parseProposalTurn(answer(outcome));
      assert.equal(result.ok, false, `${shape}: ${label} summary was accepted`);
      if (result.ok) continue;
      // Quoted to the model in the repair turn, so it names what to fix.
      assert.match(result.reason, /summary/u, `${shape}: ${label}`);
      assert.match(result.reason, /renewal-risk-reviewer/u, `${shape}: ${label}`);
    }
  }
});

// The reviewer never sees proposal JSON, so the parser is the only place a
// summary that is just the brief again can be caught and sent to repair.
test("a summary that copies the build brief, whole or cut off mid-sentence, refuses the proposal and says which Agent", () => {
  const brief = "Reviews supplier contracts for renewal risk. Step 1: read every renewal clause and list its notice window. Step 2: flag price escalators.";
  for (const [label, summary, description] of [
    ["the whole brief", "Reviews supplier contracts for renewal risk.", "Reviews supplier contracts for renewal risk."],
    ["the whole brief, rewrapped", "Reviews supplier contracts for renewal risk.", "Reviews supplier contracts\n  for renewal risk."],
    ["the whole brief without its full stop", "Reviews supplier contracts for renewal risk", "Reviews supplier contracts for renewal risk."],
    ["the whole brief in lower case", "reviews supplier contracts for renewal risk.", "Reviews supplier contracts for renewal risk."],
    ["the opening cut inside a word, in lower case", "reviews supplier contracts for renewal risk. step 1: read ev", brief],
    ["the opening cut at a word", "Reviews supplier contracts for renewal risk. Step 1: read every renewal clause and list its", brief],
    ["the opening cut inside a word", "Reviews supplier contracts for renewal risk. Step 1: read ev", brief],
    ["the opening cut and marked with dots", "Reviews supplier contracts for renewal risk. Step 1: read every renewal clause...", brief],
    ["the opening cut and marked with an ellipsis", "Reviews supplier contracts for renewal risk. Step 1: read every renewal clause…", brief],
  ] as const) {
    for (const [shape, outcome] of newAgentProposals({ ...plannedAgent("renewal-risk-reviewer"), summary, description })) {
      const result = parseProposalTurn(answer(outcome));
      assert.equal(result.ok, false, `${shape}: a summary that is ${label} was accepted`);
      if (result.ok) continue;
      assert.match(result.reason, /summary/u, `${shape}: ${label}`);
      assert.match(result.reason, /renewal-risk-reviewer/u, `${shape}: ${label}`);
    }
  }
});

test("a brief may open with the summary sentence and go on from there", () => {
  const brief = "Reviews supplier contracts for renewal risk. Step 1: read every renewal clause and list its notice window.";
  for (const summary of [
    "Reviews supplier contracts for renewal risk.",
    // The same sentence without its full stop still ends where the brief's first sentence ends.
    "Reviews supplier contracts for renewal risk",
  ]) {
    for (const [shape, outcome] of newAgentProposals({ ...plannedAgent("renewal-risk-reviewer"), summary, description: brief })) {
      const [agent] = proposedNewAgents(answer(outcome));
      assert.equal(agent?.summary, summary, shape);
      assert.equal(agent?.description, brief, shape);
    }
  }
});

test("a summary is measured in characters as the schema counts them, after trimming", () => {
  // Each emoji is one character to JSON Schema's maxLength and two UTF-16
  // units to String.length. Counting units would refuse output the provider
  // schema had already accepted.
  const exact = "\u{1F9FE}".repeat(240);
  const [agent] = proposedNewAgents(answer({
    id: "proposal",
    kind: "standalone_agents",
    agents: [{ ...plannedAgent("renewal-risk-reviewer"), summary: ` ${exact} ` }],
  }));
  assert.equal(agent?.summary, exact);

  const over = parseProposalTurn(answer({
    id: "proposal",
    kind: "standalone_agents",
    agents: [{ ...plannedAgent("renewal-risk-reviewer"), summary: `${exact}\u{1F9FE}` }],
  }));
  assert.equal(over.ok, false);
});
