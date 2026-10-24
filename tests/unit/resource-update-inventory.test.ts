/**
 * The shell that reads the repository an update plan is decided against.
 *
 * This is the looking, kept apart from the deciding. It reads only the targets
 * a draft actually names — parsing every registered Team and every Agent in
 * the library to answer a question about one of them would be work the
 * proposal never asked for — and it answers what the policy needs: does this
 * target exist, what revision is it at, and which of its skills are there and
 * readable.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ResourceUpdateOperationDraft } from "../../contracts/resource-architect.js";
import { computeAgentRevision } from "../../domains/agent-generator/agent-revision.js";
import { readResourceUpdateInventory } from "../../domains/resource-architect/resource-update-plan.js";

const AGENT_ID = "michigan-contract-lawyer";
const OTHER_AGENT_ID = "scoping-lawyer";
const READABLE_SKILL = "indemnity-clause-review";
const UNREADABLE_SKILL = "governing-law-review";

function makeRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "update-inventory-"));
}

function writeAgent(repoRoot: string, name: string): string {
  const agentDir = path.join(repoRoot, "agents", name);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} description.\ntier: strategic\n---\n\n# ${name}\n`,
  );
  return agentDir;
}

function skillOperation(agentId: string): ResourceUpdateOperationDraft {
  return {
    kind: "update_agent_skills",
    target: { kind: "agent", id: agentId },
    skillUpdates: [{ action: "create", name: "termination-clause-review", instruction: "Go." }],
  };
}

function withRepo(run: (repoRoot: string) => void): void {
  const repoRoot = makeRepo();
  try {
    run(repoRoot);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

test("an Agent the draft names is read with the revision of its package", () => {
  withRepo((repoRoot) => {
    const agentDir = writeAgent(repoRoot, AGENT_ID);
    fs.mkdirSync(path.join(agentDir, "skills", READABLE_SKILL), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "skills", READABLE_SKILL, "SKILL.md"),
      `---\nname: ${READABLE_SKILL}\n---\n\nBody.\n`,
    );

    const inventory = readResourceUpdateInventory(repoRoot, [skillOperation(AGENT_ID)]);

    const snapshot = inventory.agents.get(AGENT_ID);
    assert.ok(snapshot, "the named Agent must be in the snapshot");
    assert.equal(snapshot.id, AGENT_ID);
    assert.equal(snapshot.revision, computeAgentRevision(repoRoot, AGENT_ID));
    assert.deepEqual([...snapshot.skillFolderNames].sort(), [READABLE_SKILL]);
    assert.deepEqual([...snapshot.readableSkillNames].sort(), [READABLE_SKILL]);
  });
});

test("only the Agents the draft names are read", () => {
  withRepo((repoRoot) => {
    writeAgent(repoRoot, AGENT_ID);
    writeAgent(repoRoot, OTHER_AGENT_ID);

    const inventory = readResourceUpdateInventory(repoRoot, [skillOperation(AGENT_ID)]);

    assert.deepEqual([...inventory.agents.keys()], [AGENT_ID]);
  });
});

test("an Agent with no package on disk is simply absent from the snapshot", () => {
  withRepo((repoRoot) => {
    writeAgent(repoRoot, AGENT_ID);

    const inventory = readResourceUpdateInventory(repoRoot, [
      skillOperation("nobody-wrote-this-agent"),
    ]);

    assert.equal(inventory.agents.has("nobody-wrote-this-agent"), false);
  });
});

test("an Agent id that points outside agents/ is absent, never resolved", () => {
  withRepo((repoRoot) => {
    writeAgent(repoRoot, AGENT_ID);

    const inventory = readResourceUpdateInventory(repoRoot, [
      skillOperation(`../agents/${AGENT_ID}`),
    ]);

    assert.equal(inventory.agents.size, 0);
  });
});

/**
 * A skill folder is present whether or not its document can be read, because
 * the folder still occupies the name a `create` would want. Only `update`
 * needs the bytes, and it needs them as context, so an unreadable document
 * makes the skill present but not updatable.
 */
test("a skill folder whose SKILL.md cannot be read is present but not readable", () => {
  withRepo((repoRoot) => {
    const agentDir = writeAgent(repoRoot, AGENT_ID);
    fs.mkdirSync(path.join(agentDir, "skills", READABLE_SKILL), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "skills", READABLE_SKILL, "SKILL.md"),
      `---\nname: ${READABLE_SKILL}\n---\n\nBody.\n`,
    );
    // A directory where the document belongs: present, and unreadable.
    fs.mkdirSync(path.join(agentDir, "skills", UNREADABLE_SKILL, "SKILL.md"), {
      recursive: true,
    });

    const snapshot = readResourceUpdateInventory(repoRoot, [skillOperation(AGENT_ID)])
      .agents.get(AGENT_ID);

    assert.ok(snapshot);
    assert.deepEqual(
      [...snapshot.skillFolderNames].sort(),
      [READABLE_SKILL, UNREADABLE_SKILL].sort(),
    );
    assert.deepEqual([...snapshot.readableSkillNames].sort(), [READABLE_SKILL]);
  });
});

/**
 * A skill whose current document does not conform is still readable, and so
 * still updatable. Rewriting it is the whole point of the capability.
 */
test("a skill whose SKILL.md does not conform is still readable", () => {
  withRepo((repoRoot) => {
    const agentDir = writeAgent(repoRoot, AGENT_ID);
    fs.mkdirSync(path.join(agentDir, "skills", READABLE_SKILL), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "skills", READABLE_SKILL, "SKILL.md"),
      "no frontmatter at all, and a name that matches nothing\n",
    );

    const snapshot = readResourceUpdateInventory(repoRoot, [skillOperation(AGENT_ID)])
      .agents.get(AGENT_ID);

    assert.ok(snapshot);
    assert.deepEqual([...snapshot.readableSkillNames], [READABLE_SKILL]);
  });
});

/**
 * A package that is there but cannot be described is not a package that is
 * missing. Reported as "Agent not found", the user would be told to create an
 * Agent that already exists, and the real problem — a symlinked persona, a
 * `skills` entry that is not a folder, an unreadable file — would never be
 * named. Only genuine absence may read as absence.
 */
test("a package that exists but cannot be read is not reported as a missing Agent", () => {
  withRepo((repoRoot) => {
    const agentDir = writeAgent(repoRoot, AGENT_ID);
    const outside = path.join(repoRoot, "outside-persona.md");
    fs.writeFileSync(outside, "---\nname: borrowed\n---\n\nBody.\n");
    fs.rmSync(path.join(agentDir, `${AGENT_ID}.md`), { force: true });
    fs.symlinkSync(outside, path.join(agentDir, `${AGENT_ID}.md`));

    assert.throws(
      () => readResourceUpdateInventory(repoRoot, [skillOperation(AGENT_ID)]),
      /symbolic link/i,
    );
  });
});

test("a skills entry that is not a folder fails rather than reading as a missing Agent", () => {
  withRepo((repoRoot) => {
    const agentDir = writeAgent(repoRoot, AGENT_ID);
    fs.writeFileSync(path.join(agentDir, "skills"), "not a folder\n");

    assert.throws(
      () => readResourceUpdateInventory(repoRoot, [skillOperation(AGENT_ID)]),
      /skills/,
    );
  });
});

/**
 * A regular file at `skills/<name>` occupies the exact path a `create` would
 * write into. Counting only directories would let the proposal authorize a
 * create that cannot land, and the collision would surface during publication
 * instead of before anything was promised.
 */
test("a regular file occupying a skill path is recorded as an occupied name", () => {
  withRepo((repoRoot) => {
    const agentDir = writeAgent(repoRoot, AGENT_ID);
    fs.mkdirSync(path.join(agentDir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "skills", "termination-clause-review"), "occupied\n");

    const snapshot = readResourceUpdateInventory(repoRoot, [skillOperation(AGENT_ID)])
      .agents.get(AGENT_ID);

    assert.ok(snapshot);
    assert.deepEqual([...snapshot.skillFolderNames], ["termination-clause-review"]);
    assert.deepEqual([...snapshot.readableSkillNames], []);
  });
});

test("an Agent with no skills folder reports no skills and still has a revision", () => {
  withRepo((repoRoot) => {
    writeAgent(repoRoot, AGENT_ID);

    const snapshot = readResourceUpdateInventory(repoRoot, [skillOperation(AGENT_ID)])
      .agents.get(AGENT_ID);

    assert.ok(snapshot);
    assert.equal(snapshot.skillFolderNames.size, 0);
    assert.match(snapshot.revision, /^sha256:[0-9a-f]{64}$/);
  });
});
