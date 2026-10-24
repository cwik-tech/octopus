/**
 * The structural rules a skill update must satisfy, at their own boundary.
 *
 * These are shared by the proposal boundary and by the parser that reads a
 * plan back from disk, so they are exercised here directly rather than only
 * through one of those callers. A rule that only ever ran on the proposal path
 * would leave a hand-written plan file able to name a skill the proposal would
 * have refused.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import type { ResourceSkillUpdate } from "../../contracts/resource-architect.js";
import {
  agentSkillFolderPath,
  findSkillNameViolation,
  findSkillUpdateStructureViolation,
  skillDocumentRelativePath,
} from "../../domains/resource-architect/skill-update-rules.js";

const REPO_ROOT = "/tmp/example-repo";
const AGENT_ID = "michigan-contract-lawyer";

function skill(
  action: "create" | "update",
  name: string,
  instruction = "Author the clause review procedure.",
): ResourceSkillUpdate {
  return { action, name, instruction };
}

test("a well-formed list of skill actions breaks no rule", () => {
  assert.equal(
    findSkillUpdateStructureViolation([
      skill("create", "termination-clause-review"),
      skill("update", "indemnity-clause-review"),
    ]),
    null,
  );
});

test("an empty list of skill actions is not an operation", () => {
  assert.match(
    findSkillUpdateStructureViolation([]) ?? "",
    /must change at least one skill/,
  );
});

test("the same skill named twice in one operation is refused", () => {
  assert.match(
    findSkillUpdateStructureViolation([
      skill("create", "termination-clause-review"),
      skill("update", "termination-clause-review"),
    ]) ?? "",
    /Duplicate skill in one update operation: termination-clause-review/,
  );
});

test("an action that is neither create nor update is refused", () => {
  const rogue = { action: "delete", name: "termination-clause-review", instruction: "Go." };
  assert.match(
    findSkillUpdateStructureViolation([rogue as unknown as ResourceSkillUpdate]) ?? "",
    /must be create or update/,
  );
});

test("a skill with nothing to author it from is refused", () => {
  assert.match(
    findSkillUpdateStructureViolation([skill("create", "termination-clause-review", "  \n ")]) ?? "",
    /no instruction/,
  );
});

test("an exact kebab-case skill name breaks no naming rule", () => {
  assert.equal(findSkillNameViolation("termination-clause-review"), null);
  assert.equal(findSkillNameViolation("a1"), null);
});

test("a name that is not exact kebab-case is refused for what it is", () => {
  for (
    const [name, pattern] of [
      ["Termination Review", /kebab-case/],
      ["termination_review", /kebab-case/],
      ["-leading", /kebab-case/],
      ["trailing-", /kebab-case/],
      ["double--hyphen", /kebab-case/],
      ["", /required/],
      ["a".repeat(65), /kebab-case|over the 64-char limit/],
    ] as const
  ) {
    assert.match(findSkillNameViolation(name) ?? "", pattern, `expected ${name} to be refused`);
  }
});

test("a name that is not a string at all is refused", () => {
  assert.match(findSkillNameViolation(undefined) ?? "", /required/);
  assert.match(findSkillNameViolation(42) ?? "", /required/);
});

test("a name that could leave the skills folder is refused", () => {
  for (const name of ["../escape", "nested/skill", ".", "..", "skills/../../etc", "/absolute"]) {
    assert.notEqual(
      findSkillNameViolation(name),
      null,
      `expected ${name} to be refused`,
    );
  }
});

test("a skill folder resolves inside the Agent's own skills folder", () => {
  assert.equal(
    agentSkillFolderPath({
      repoRoot: REPO_ROOT,
      agentId: AGENT_ID,
      skillName: "termination-clause-review",
    }),
    path.join(REPO_ROOT, "agents", AGENT_ID, "skills", "termination-clause-review"),
  );
});

test("a skill folder that would leave the Agent is never resolved", () => {
  for (const skillName of ["../escape", "nested/skill", "..", "/absolute"]) {
    assert.throws(
      () => agentSkillFolderPath({ repoRoot: REPO_ROOT, agentId: AGENT_ID, skillName }),
      `expected ${skillName} to be refused`,
    );
  }
});

test("a skill folder is never resolved under an aliased Agent id", () => {
  for (const agentId of [`elsewhere/../${AGENT_ID}`, `${AGENT_ID}/`, "Michigan-Contract"]) {
    assert.throws(
      () =>
        agentSkillFolderPath({
          repoRoot: REPO_ROOT,
          agentId,
          skillName: "termination-clause-review",
        }),
      `expected the Agent id ${agentId} to be refused`,
    );
  }
});

test("the document one action writes is the skill's own SKILL.md", () => {
  assert.equal(
    skillDocumentRelativePath("termination-clause-review"),
    "skills/termination-clause-review/SKILL.md",
  );
});

test("no document path is produced for a name that breaks the naming rule", () => {
  assert.throws(() => skillDocumentRelativePath("../escape"));
});
