/**
 * The update policy decides; it does not look.
 *
 * Every rule about whether a proposed plan may exist is a function of the
 * draft, the user's own words, and a snapshot of the repository. These cases
 * pass that snapshot directly, so what the policy decides can be examined
 * without a repository on disk at all — which is the point of keeping the
 * looking in `resource-update-plan.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type {
  ChatTurn,
  ResourceUpdateOperationDraft,
} from "../../contracts/resource-architect.js";
import {
  planResourceUpdates,
  ResourceUpdatePlanError,
  ResourceUpdateTargetConfirmationRequired,
  type ResourceUpdateInventory,
} from "../../domains/resource-architect/resource-update-policy.js";

const TEAM_ID = "contract-review-team";
const SECOND_TEAM_ID = "diligence-team";
const COOKING_TEAM_ID = "cooking-team";
const LIBRARY_AGENT = "scoping-lawyer";
const NEW_AGENT = "drafting-completeness-lawyer";
const FIRST_REVISION = `sha256:${"1".repeat(64)}`;
const SECOND_REVISION = `sha256:${"2".repeat(64)}`;

function inventory(): ResourceUpdateInventory {
  return {
    teams: new Map([
      [
        TEAM_ID,
        {
          id: TEAM_ID,
          rosterAgentNames: new Set(["michigan-contract-lawyer"]),
          revision: FIRST_REVISION,
        },
      ],
      [
        SECOND_TEAM_ID,
        {
          id: SECOND_TEAM_ID,
          rosterAgentNames: new Set<string>(),
          revision: SECOND_REVISION,
        },
      ],
      [
        COOKING_TEAM_ID,
        {
          id: COOKING_TEAM_ID,
          rosterAgentNames: new Set(["french-cuisine-cook", "german-cuisine-cook"]),
          revision: SECOND_REVISION,
        },
      ],
    ]),
    libraryAgentNames: new Set([LIBRARY_AGENT, "michigan-contract-lawyer"]),
    agents: new Map(),
  };
}

function addLibraryAgent(teamId: string): ResourceUpdateOperationDraft {
  return {
    kind: "add_team_agents",
    target: { kind: "team", id: teamId },
    libraryAgentsToAdd: [
      { name: LIBRARY_AGENT, role: "Scope reviewer", rationale: "Reuse." },
    ],
    newAgentsToCreate: [],
  };
}

function createAgent(teamId: string, name: string): ResourceUpdateOperationDraft {
  return {
    kind: "add_team_agents",
    target: { kind: "team", id: teamId },
    libraryAgentsToAdd: [],
    newAgentsToCreate: [{
      name,
      role: "Drafting reviewer",
      description: "Checks drafting completeness.",
      rationale: "No existing Agent covers drafting gaps.",
    }],
  };
}

function plan(operations: ResourceUpdateOperationDraft[], requested: string) {
  return planFromHistory(operations, [{ role: "user", text: requested }]);
}

function planFromHistory(
  operations: ResourceUpdateOperationDraft[],
  history: ChatTurn[],
) {
  return planResourceUpdates({
    inventory: inventory(),
    draft: { id: "proposal-1", kind: "resource_updates", operations },
    history,
  });
}

test("each operation is stamped with the revision of the Team it targets", () => {
  const result = plan(
    [addLibraryAgent(TEAM_ID), createAgent(SECOND_TEAM_ID, NEW_AGENT)],
    `Add ${LIBRARY_AGENT} to ${TEAM_ID} and ${NEW_AGENT} to ${SECOND_TEAM_ID}.`,
  );

  assert.deepEqual(
    result.operations.map((operation) => operation.expectedRevision),
    [FIRST_REVISION, SECOND_REVISION],
  );
});

test("the visible Cooking Team name authorizes its canonical hyphenated id", () => {
  const result = plan(
    [createAgent(COOKING_TEAM_ID, "polish-cuisine-cook")],
    "I would like to add to the cooking team. A Polish cuisine specialist or cook.",
  );

  assert.equal(result.operations[0]?.target.id, COOKING_TEAM_ID);
});

function architectureInventory(teamIds = ["software-architecture-board"]): ResourceUpdateInventory {
  return {
    ...inventory(),
    teams: new Map(teamIds.map((id) => [id, {
      id, rosterAgentNames: new Set<string>(), revision: FIRST_REVISION,
    }])),
  };
}

test("an inferred Board requires confirmation even when its Team name is unique", () => {
  assert.throws(() => planResourceUpdates({
    inventory: architectureInventory(),
    draft: {
      id: "proposal-architecture", kind: "resource_updates",
      operations: [createAgent("software-architecture-board", "architect-software-design")],
    },
    history: [
      { role: "assistant", text: "Add the specialists to software-architecture-board." },
      { role: "user", text: "Create those two agents and add it to the software architecture team." },
      { role: "user", text: "create them" },
    ],
  }), /Did you mean Team `software-architecture-board`\?/);
});

test("similar registered Team names still require confirmation of the inferred Board ID", () => {
  assert.throws(() => planResourceUpdates({
    inventory: architectureInventory(["software-architecture-board", "software-architecture-team"]),
    draft: {
      id: "proposal-architecture", kind: "resource_updates",
      operations: [createAgent("software-architecture-board", "architect-software-design")],
    },
    history: [{ role: "user", text: "Add the specialist to the software architecture team." }],
  }), /Did you mean Team `software-architecture-board`\?/);
});

test("an assistant-only Board name and an unnamed user confirmation carry no authority", () => {
  assert.throws(() => planResourceUpdates({
    inventory: architectureInventory(),
    draft: {
      id: "proposal-architecture", kind: "resource_updates",
      operations: [createAgent("software-architecture-board", "architect-software-design")],
    },
    history: [
      { role: "assistant", text: "Add the specialist to software-architecture-board." },
      { role: "user", text: "create them" },
    ],
  }), /Did you mean Team `software-architecture-board`\?/);
});

test("an explicitly named Board prepares a proposal even when another Team has a similar name", () => {
  const result = planResourceUpdates({
    inventory: architectureInventory(["software-architecture-board", "software-architecture-team"]),
    draft: {
      id: "proposal-architecture", kind: "resource_updates",
      operations: [createAgent("software-architecture-board", "architect-software-design")],
    },
    history: [{ role: "user", text: "Add the specialist to Software Architecture Board." }],
  });

  assert.equal(result.operations[0]?.target.id, "software-architecture-board");
});

test("a longer name does not confirm the inferred Board", () => {
  assert.throws(() => planResourceUpdates({
    inventory: architectureInventory(),
    draft: {
      id: "proposal-architecture", kind: "resource_updates",
      operations: [createAgent("software-architecture-board", "architect-software-design")],
    },
    history: [{ role: "user", text: "Add the specialist to the software architecture teamwork group." }],
  }), /Did you mean Team `software-architecture-board`\?/);
});

for (const confirmation of [
  { answer: "yes", notes: "" },
  { answer: "yes", notes: "\n\nContext notes:\n- A document could not be read." },
  { answer: "software-architecture-board", notes: "" },
]) {
  test(`'${confirmation.answer}' confirms only the exact Team in the question${confirmation.notes ? " with context notes" : ""}`, () => {
    const result = planResourceUpdates({
      inventory: architectureInventory(["software-architecture-board", "software-architecture-team"]),
      draft: {
        id: "proposal-architecture", kind: "resource_updates",
        operations: [createAgent("software-architecture-board", "architect-software-design")],
      },
      history: [
        { role: "user", text: "Add the specialists to the architecture team." },
        { role: "assistant", text: `Did you mean Team \`software-architecture-board\`? Reply yes to confirm, or give the exact Team ID you meant.${confirmation.notes}` },
        { role: "user", text: confirmation.answer },
        { role: "assistant", text: "Preparing the proposal for your review." },
      ],
    });

    assert.equal(result.operations[0]?.target.id, "software-architecture-board");
  });
}

for (const answer of ["no", "yes, but use the other team", "not yet", "no, not software-architecture-board"]) {
  test(`the answer '${answer}' does not confirm the suggested Team`, () => {
    assert.throws(() => planResourceUpdates({
      inventory: architectureInventory(),
      draft: {
        id: "proposal-architecture", kind: "resource_updates",
        operations: [createAgent("software-architecture-board", "architect-software-design")],
      },
      history: [
        { role: "assistant", text: "Did you mean Team `software-architecture-board`? Reply yes to confirm, or give the exact Team ID you meant." },
        { role: "user", text: answer },
      ],
    }), /Did you mean Team `software-architecture-board`\?/);
  });
}

test("yes to a question about a similar Team cannot confirm the Board", () => {
  assert.throws(() => planResourceUpdates({
    inventory: architectureInventory(["software-architecture-board", "software-architecture-team"]),
    draft: {
      id: "proposal-architecture", kind: "resource_updates",
      operations: [createAgent("software-architecture-board", "architect-software-design")],
    },
    history: [
      { role: "assistant", text: "Did you mean Team `software-architecture-team`? Reply yes to confirm, or give the exact Team ID you meant." },
      { role: "user", text: "yes" },
    ],
  }), /Did you mean Team `software-architecture-board`\?/);
});

test("a confirmation for several Teams permits only that exact set of targets", () => {
  const operations = [addLibraryAgent(TEAM_ID), addLibraryAgent(SECOND_TEAM_ID)];
  const history: ChatTurn[] = [
    { role: "user", text: "Add the reviewer to both Teams." },
    { role: "assistant", text: "Did you mean Team `contract-review-team` and Team `diligence-team`? Reply yes to confirm, or give the exact Team ID you meant." },
    { role: "user", text: "yes" },
  ];

  const result = planFromHistory(operations, history);

  assert.deepEqual(result.operations.map((operation) => operation.target.id), [TEAM_ID, SECOND_TEAM_ID]);
  assert.throws(() => planFromHistory([addLibraryAgent(TEAM_ID)], history), ResourceUpdateTargetConfirmationRequired);
});

test("giving a different exact Team ID prepares that Team's proposal", () => {
  const result = planFromHistory([addLibraryAgent(SECOND_TEAM_ID)], [
    { role: "user", text: "Add the reviewer to the Team we discussed." },
    { role: "assistant", text: "Did you mean Team `contract-review-team`? Reply yes to confirm, or give the exact Team ID you meant." },
    { role: "user", text: SECOND_TEAM_ID },
  ]);

  assert.equal(result.operations[0]?.target.id, SECOND_TEAM_ID);
});

test("a longer name that only starts with the visible Team name carries no authority", () => {
  assert.throws(
    () => plan(
      [addLibraryAgent(TEAM_ID)],
      `Add ${LIBRARY_AGENT} to the Contract Review Teamwork group.`,
    ),
    (error: unknown) =>
      error instanceof ResourceUpdateTargetConfirmationRequired &&
      error.question === `Did you mean Team \`${TEAM_ID}\`? Reply yes to confirm, or give the exact Team ID you meant.`,
  );
});

test("target words split across separate user turns carry no authority", () => {
  assert.throws(
    () => planFromHistory(
      [addLibraryAgent(TEAM_ID)],
      [
        { role: "user", text: "Add the reviewer to the Contract" },
        { role: "user", text: "Review Team." },
      ],
    ),
    (error: unknown) =>
      error instanceof ResourceUpdateTargetConfirmationRequired &&
      error.question === `Did you mean Team \`${TEAM_ID}\`? Reply yes to confirm, or give the exact Team ID you meant.`,
  );
});

test("a Team missing from the snapshot does not exist", () => {
  assert.throws(
    () => plan([addLibraryAgent("a-team-nobody-registered")], "Add to a-team-nobody-registered."),
    (error: unknown) =>
      error instanceof ResourceUpdatePlanError &&
      error.code === "bad_request" &&
      error.message === "Team not found: a-team-nobody-registered",
  );
});

test("two operations on one Team are refused before either is stamped", () => {
  assert.throws(
    () => plan([addLibraryAgent(TEAM_ID), createAgent(TEAM_ID, NEW_AGENT)], `Update ${TEAM_ID}.`),
    (error: unknown) =>
      error instanceof ResourceUpdatePlanError &&
      error.message === `A plan may update Team '${TEAM_ID}' only once`,
  );
});

test("one Agent name may be created once in a plan, and referenced anywhere", () => {
  assert.throws(
    () =>
      plan(
        [createAgent(TEAM_ID, NEW_AGENT), createAgent(SECOND_TEAM_ID, NEW_AGENT)],
        `Add ${NEW_AGENT} to ${TEAM_ID} and ${SECOND_TEAM_ID}.`,
      ),
    (error: unknown) =>
      error instanceof ResourceUpdatePlanError &&
      error.message === `A plan may create Agent '${NEW_AGENT}' only once`,
  );

  const reused = plan(
    [addLibraryAgent(TEAM_ID), addLibraryAgent(SECOND_TEAM_ID)],
    `Add ${LIBRARY_AGENT} to ${TEAM_ID} and ${SECOND_TEAM_ID}.`,
  );
  assert.deepEqual(
    reused.operations.map((operation) =>
      operation.kind === "add_team_agents"
        ? operation.libraryAgentsToAdd.map((agent) => agent.name)
        : [],
    ),
    [[LIBRARY_AGENT], [LIBRARY_AGENT]],
  );
});

test("a new Agent keeps its card summary beside its build brief when the update is materialized", () => {
  const result = plan(
    [{
      kind: "add_team_agents",
      target: { kind: "team", id: TEAM_ID },
      libraryAgentsToAdd: [],
      newAgentsToCreate: [{
        name: NEW_AGENT,
        role: "Drafting reviewer",
        summary: "Finds drafting gaps before a contract is signed.",
        description: "BRIEF-MARKER: check every clause reference and defined term.",
        rationale: "No existing Agent covers drafting gaps.",
      }],
    }],
    `Add ${NEW_AGENT} to ${TEAM_ID}.`,
  );

  const operation = result.operations[0];
  assert.ok(operation?.kind === "add_team_agents");
  assert.equal(operation.newAgentsToCreate[0]?.summary, "Finds drafting gaps before a contract is signed.");
  assert.equal(
    operation.newAgentsToCreate[0]?.description,
    "BRIEF-MARKER: check every clause reference and defined term.",
  );
});
