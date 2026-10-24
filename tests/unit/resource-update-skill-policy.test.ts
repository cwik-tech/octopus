/**
 * The rules that decide whether a proposed skill update may exist.
 *
 * Like the Team rules beside them, these are a pure function of the draft, the
 * user's own words, and a snapshot of the repository, so every precondition is
 * examined here without an Agent on disk.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type {
  ResourceSkillUpdate,
  ResourceUpdateOperationDraft,
} from "../../contracts/resource-architect.js";
import {
  planResourceUpdates,
  ResourceUpdatePlanError,
  type ResourceUpdateInventory,
} from "../../domains/resource-architect/resource-update-policy.js";

const AGENT_ID = "michigan-contract-lawyer";
const SECOND_AGENT_ID = "scoping-lawyer";
const EXISTING_SKILL = "indemnity-clause-review";
const NONCONFORMANT_SKILL = "legacy-clause-review";
const NEW_SKILL = "termination-clause-review";
const AGENT_REVISION = `sha256:${"a".repeat(64)}`;
const SECOND_AGENT_REVISION = `sha256:${"b".repeat(64)}`;

function inventory(): ResourceUpdateInventory {
  return {
    teams: new Map(),
    libraryAgentNames: new Set([AGENT_ID, SECOND_AGENT_ID]),
    agents: new Map([
      [
        AGENT_ID,
        {
          id: AGENT_ID,
          revision: AGENT_REVISION,
          skillFolderNames: new Set([EXISTING_SKILL, NONCONFORMANT_SKILL]),
          // `legacy-clause-review` is readable and does not conform. It is
          // still an updatable skill: repairing it is the point.
          readableSkillNames: new Set([EXISTING_SKILL, NONCONFORMANT_SKILL]),
        },
      ],
      [
        SECOND_AGENT_ID,
        {
          id: SECOND_AGENT_ID,
          revision: SECOND_AGENT_REVISION,
          skillFolderNames: new Set<string>(),
          readableSkillNames: new Set<string>(),
        },
      ],
    ]),
  };
}

function skillOperation(
  agentId: string,
  skillUpdates: ResourceSkillUpdate[],
): ResourceUpdateOperationDraft {
  return { kind: "update_agent_skills", target: { kind: "agent", id: agentId }, skillUpdates };
}

function skill(
  action: "create" | "update",
  name: string,
  instruction = "Author the clause review procedure.",
): ResourceSkillUpdate {
  return { action, name, instruction };
}

function plan(operations: ResourceUpdateOperationDraft[], requested: string) {
  return planResourceUpdates({
    inventory: inventory(),
    draft: { id: "proposal-1", kind: "resource_updates", operations },
    history: [{ role: "user", text: requested }],
  });
}

function rejection(
  operations: ResourceUpdateOperationDraft[],
  requested: string,
): ResourceUpdatePlanError {
  try {
    plan(operations, requested);
  } catch (error) {
    assert.ok(error instanceof ResourceUpdatePlanError, `unexpected error: ${String(error)}`);
    return error;
  }
  return assert.fail("expected the plan to be rejected");
}

test("a skill operation is stamped with the revision of the Agent it targets", () => {
  const result = plan(
    [
      skillOperation(AGENT_ID, [skill("create", NEW_SKILL)]),
      skillOperation(SECOND_AGENT_ID, [skill("create", NEW_SKILL)]),
    ],
    `Add ${NEW_SKILL} to ${AGENT_ID} and to ${SECOND_AGENT_ID}.`,
  );

  assert.deepEqual(
    result.operations.map((operation) => operation.expectedRevision),
    [AGENT_REVISION, SECOND_AGENT_REVISION],
  );
});

test("an Agent missing from the snapshot does not exist", () => {
  assert.equal(
    rejection(
      [skillOperation("nobody-registered-this", [skill("create", NEW_SKILL)])],
      "Give nobody-registered-this a skill.",
    ).message,
    "Agent not found: nobody-registered-this",
  );
});

test("an Agent the user never named cannot be updated", () => {
  assert.match(
    rejection(
      [skillOperation(AGENT_ID, [skill("create", NEW_SKILL)])],
      "Please improve the agent I am looking at.",
    ).message,
    /never named in the request/,
  );
});

test("a skill operation must change at least one skill", () => {
  assert.match(
    rejection([skillOperation(AGENT_ID, [])], `Change skills on ${AGENT_ID}.`).message,
    /must change at least one skill/,
  );
});

test("one operation may not name the same skill twice", () => {
  assert.match(
    rejection(
      [skillOperation(AGENT_ID, [skill("create", NEW_SKILL), skill("update", NEW_SKILL)])],
      `Change ${NEW_SKILL} on ${AGENT_ID}.`,
    ).message,
    /Duplicate skill in one update operation: termination-clause-review/,
  );
});

test("creating a skill requires the folder to be absent", () => {
  assert.equal(
    rejection(
      [skillOperation(AGENT_ID, [skill("create", EXISTING_SKILL)])],
      `Create ${EXISTING_SKILL} on ${AGENT_ID}.`,
    ).message,
    `Agent '${AGENT_ID}' already has a skill named '${EXISTING_SKILL}'`,
  );
});

test("updating a skill requires the folder to exist", () => {
  assert.equal(
    rejection(
      [skillOperation(AGENT_ID, [skill("update", NEW_SKILL)])],
      `Update ${NEW_SKILL} on ${AGENT_ID}.`,
    ).message,
    `Agent '${AGENT_ID}' has no skill named '${NEW_SKILL}' to update`,
  );
});

/**
 * Correction: a skill whose current `SKILL.md` breaks the specification is
 * exactly the skill a user asks to have rewritten. The precondition for
 * `update` is that the file is there and readable, never that it already
 * conforms — requiring conformance would lock the repair out of the one path
 * that can perform it.
 */
test("a skill whose current SKILL.md does not conform is still updatable", () => {
  const result = plan(
    [skillOperation(AGENT_ID, [skill("update", NONCONFORMANT_SKILL)])],
    `Fix the ${NONCONFORMANT_SKILL} skill on ${AGENT_ID}.`,
  );

  const operation = result.operations[0]!;
  assert.equal(operation.kind, "update_agent_skills");
  if (operation.kind !== "update_agent_skills") return;
  assert.deepEqual(
    operation.skillUpdates.map((entry) => [entry.action, entry.name]),
    [["update", NONCONFORMANT_SKILL]],
  );
});

test("a skill whose SKILL.md cannot be read is not an updatable skill", () => {
  const unreadable: ResourceUpdateInventory = {
    teams: new Map(),
    libraryAgentNames: new Set([AGENT_ID]),
    agents: new Map([[
      AGENT_ID,
      {
        id: AGENT_ID,
        revision: AGENT_REVISION,
        skillFolderNames: new Set([EXISTING_SKILL]),
        readableSkillNames: new Set<string>(),
      },
    ]]),
  };

  assert.throws(
    () =>
      planResourceUpdates({
        inventory: unreadable,
        draft: {
          id: "proposal-1",
          kind: "resource_updates",
          operations: [skillOperation(AGENT_ID, [skill("update", EXISTING_SKILL)])],
        },
        history: [{ role: "user", text: `Update ${EXISTING_SKILL} on ${AGENT_ID}.` }],
      }),
    /has no readable SKILL.md/,
  );
});

test("a skill name that is not exact kebab-case is refused", () => {
  for (const name of ["Termination Review", "termination_review", "-leading", "double--hyphen"]) {
    assert.match(
      rejection(
        [skillOperation(AGENT_ID, [skill("create", name)])],
        `Create ${name} on ${AGENT_ID}.`,
      ).message,
      /kebab-case/,
      `expected ${name} to be refused`,
    );
  }
});

test("a skill name that could escape the Agent's skills folder is refused", () => {
  for (const name of ["../escape", "nested/skill", ".", "..", "skills/../../etc"]) {
    assert.match(
      rejection(
        [skillOperation(AGENT_ID, [skill("create", name)])],
        `Create ${name} on ${AGENT_ID}.`,
      ).message,
      /Skill name '.+' (must be lowercase kebab-case|would not stay inside)/,
      `expected ${name} to be refused for what it is`,
    );
  }
});

test("a skill name wrapped in whitespace is refused, not trimmed into a valid one", () => {
  assert.match(
    rejection(
      [skillOperation(AGENT_ID, [skill("create", ` ${NEW_SKILL} `)])],
      `Create ${NEW_SKILL} on ${AGENT_ID}.`,
    ).message,
    /kebab-case/,
  );
});

test("an Agent id wrapped in whitespace names no Agent", () => {
  // The padded id appears in the request, so the authorization rule passes and
  // what is under test is whether the padded string resolves to the Agent.
  assert.equal(
    rejection(
      [skillOperation(` ${AGENT_ID} `, [skill("create", NEW_SKILL)])],
      `Create ${NEW_SKILL} on  ${AGENT_ID} .`,
    ).message,
    `Agent not found:  ${AGENT_ID} `,
  );
});

test("a skill instruction is required, because it is what gets authored", () => {
  assert.match(
    rejection(
      [skillOperation(AGENT_ID, [skill("create", NEW_SKILL, "   ")])],
      `Create ${NEW_SKILL} on ${AGENT_ID}.`,
    ).message,
    /instruction/,
  );
});

test("a plan may update one Agent only once", () => {
  assert.match(
    rejection(
      [
        skillOperation(AGENT_ID, [skill("create", NEW_SKILL)]),
        skillOperation(AGENT_ID, [skill("update", EXISTING_SKILL)]),
      ],
      `Change ${NEW_SKILL} and ${EXISTING_SKILL} on ${AGENT_ID}.`,
    ).message,
    /may update Agent '.*' only once/,
  );
});
