/**
 * The server-owned optimistic revision of an Agent package.
 *
 * It answers one question: has anything a skill update depends on changed
 * since the proposal was made? So it covers the persona and every skill file,
 * and deliberately covers nothing else — runtime experience and the ownership
 * marker move on their own schedule, and a proposal that went stale every time
 * an Agent finished a session would be unusable.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  computeAgentRevision,
  digestAgentRevisionFiles,
  readAgentRevisionFiles,
} from "../../domains/agent-generator/agent-revision.js";

const AGENT_ID = "michigan-contract-lawyer";

function makeRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-revision-"));
}

function write(repoRoot: string, relativePath: string, contents: string): string {
  const target = path.join(repoRoot, "agents", AGENT_ID, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

function seedAgent(repoRoot: string): void {
  write(repoRoot, `${AGENT_ID}.md`, "---\nname: michigan-contract-lawyer\n---\n\n# Persona\n");
  write(repoRoot, "skills/indemnity-clause-review/SKILL.md", "---\nname: indemnity\n---\n\nBody.\n");
  write(repoRoot, "skills/indemnity-clause-review/references/caps.md", "Caps.\n");
  write(repoRoot, "experience/session-1.md", "Learned something.\n");
  write(repoRoot, ".create-orchestrator", "plan-1\n");
}

test("the revision is a sha256 digest that is stable across repeated reads", () => {
  const repoRoot = makeRepo();
  try {
    seedAgent(repoRoot);

    const first = computeAgentRevision(repoRoot, AGENT_ID);
    const second = computeAgentRevision(repoRoot, AGENT_ID);

    assert.match(first, /^sha256:[0-9a-f]{64}$/);
    assert.equal(first, second);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a changed persona changes the revision", () => {
  const repoRoot = makeRepo();
  try {
    seedAgent(repoRoot);
    const before = computeAgentRevision(repoRoot, AGENT_ID);

    write(repoRoot, `${AGENT_ID}.md`, "---\nname: michigan-contract-lawyer\n---\n\n# Rewritten\n");

    assert.notEqual(computeAgentRevision(repoRoot, AGENT_ID), before);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("any change under skills changes the revision", () => {
  const repoRoot = makeRepo();
  try {
    seedAgent(repoRoot);
    const before = computeAgentRevision(repoRoot, AGENT_ID);

    write(repoRoot, "skills/indemnity-clause-review/references/caps.md", "Different caps.\n");
    const afterEdit = computeAgentRevision(repoRoot, AGENT_ID);
    write(repoRoot, "skills/termination-clause-review/SKILL.md", "---\nname: termination\n---\n\nBody.\n");
    const afterAdd = computeAgentRevision(repoRoot, AGENT_ID);

    assert.notEqual(afterEdit, before);
    assert.notEqual(afterAdd, afterEdit);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

/**
 * Regression: an Agent that finished a session, or whose ownership marker was
 * rewritten, has not changed anything a skill update was authorized against.
 * Covering those files would stale every stored plan the moment the Agent ran.
 */
test("runtime experience and the ownership marker do not stale a plan", () => {
  const repoRoot = makeRepo();
  try {
    seedAgent(repoRoot);
    const before = computeAgentRevision(repoRoot, AGENT_ID);

    write(repoRoot, "experience/session-1.md", "Learned something else entirely.\n");
    write(repoRoot, "experience/session-2.md", "A second session.\n");
    write(repoRoot, ".create-orchestrator", "plan-2\n");

    assert.equal(computeAgentRevision(repoRoot, AGENT_ID), before);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("two identical files at different paths are not interchangeable", () => {
  const repoRoot = makeRepo();
  try {
    seedAgent(repoRoot);
    write(repoRoot, "skills/first-review/SKILL.md", "---\nname: shared\n---\n\nSame bytes.\n");
    const before = computeAgentRevision(repoRoot, AGENT_ID);

    fs.rmSync(path.join(repoRoot, "agents", AGENT_ID, "skills", "first-review"), {
      recursive: true,
      force: true,
    });
    write(repoRoot, "skills/second-review/SKILL.md", "---\nname: shared\n---\n\nSame bytes.\n");

    assert.notEqual(
      computeAgentRevision(repoRoot, AGENT_ID),
      before,
      "the path is hashed with the bytes, so moving a file is a change",
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a symlink inside the package is refused rather than followed", () => {
  const repoRoot = makeRepo();
  try {
    seedAgent(repoRoot);
    const outside = path.join(repoRoot, "outside.md");
    fs.writeFileSync(outside, "Content the package does not own.\n");
    fs.symlinkSync(
      outside,
      path.join(repoRoot, "agents", AGENT_ID, "skills", "indemnity-clause-review", "linked.md"),
    );

    assert.throws(() => computeAgentRevision(repoRoot, AGENT_ID), /symbolic link/i);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("an Agent with no persona file has no revision to report", () => {
  const repoRoot = makeRepo();
  try {
    fs.mkdirSync(path.join(repoRoot, "agents", AGENT_ID), { recursive: true });

    assert.throws(() => computeAgentRevision(repoRoot, AGENT_ID), /persona/i);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("the Agent package root is refused when it is a symbolic link", () => {
  const repoRoot = makeRepo();
  try {
    const real = path.join(repoRoot, "elsewhere");
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, `${AGENT_ID}.md`), "---\nname: x\n---\n\nBody.\n");
    fs.mkdirSync(path.join(repoRoot, "agents"), { recursive: true });
    fs.symlinkSync(real, path.join(repoRoot, "agents", AGENT_ID));

    assert.throws(() => computeAgentRevision(repoRoot, AGENT_ID), /symbolic link/i);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("the skills folder is refused when it is a symbolic link", () => {
  const repoRoot = makeRepo();
  try {
    seedAgent(repoRoot);
    const packageRoot = path.join(repoRoot, "agents", AGENT_ID);
    const real = path.join(repoRoot, "other-skills");
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, "borrowed.md"), "Content the package does not own.\n");
    fs.rmSync(path.join(packageRoot, "skills"), { recursive: true, force: true });
    fs.symlinkSync(real, path.join(packageRoot, "skills"));

    assert.throws(() => computeAgentRevision(repoRoot, AGENT_ID), /symbolic link/i);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

/**
 * A regular file where `skills/` belongs is not an Agent with no skills. Read
 * that way, every skill the revision was meant to cover would silently drop
 * out of it and a stale plan would look current.
 */
test("a regular file where the skills folder belongs fails rather than reading as no skills", () => {
  const repoRoot = makeRepo();
  try {
    seedAgent(repoRoot);
    const packageRoot = path.join(repoRoot, "agents", AGENT_ID);
    fs.rmSync(path.join(packageRoot, "skills"), { recursive: true, force: true });
    fs.writeFileSync(path.join(packageRoot, "skills"), "not a folder\n");

    assert.throws(() => computeAgentRevision(repoRoot, AGENT_ID), /skills/);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("an Agent with no skills folder at all still has a revision", () => {
  const repoRoot = makeRepo();
  try {
    write(repoRoot, `${AGENT_ID}.md`, "---\nname: michigan-contract-lawyer\n---\n\n# Persona\n");

    assert.match(computeAgentRevision(repoRoot, AGENT_ID), /^sha256:[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

/**
 * A persona that is a symlink is not a missing persona. Reporting it as absent
 * would turn "this package is not one I can describe" into "this Agent does
 * not exist", and the two lead somewhere different.
 */
test("a persona that is not a regular file is refused, not reported as absent", () => {
  const repoRoot = makeRepo();
  try {
    seedAgent(repoRoot);
    const personaPath = path.join(repoRoot, "agents", AGENT_ID, `${AGENT_ID}.md`);
    const outside = path.join(repoRoot, "outside-persona.md");
    fs.writeFileSync(outside, "---\nname: borrowed\n---\n\nBody.\n");
    fs.rmSync(personaPath, { force: true });
    fs.symlinkSync(outside, personaPath);

    assert.throws(() => computeAgentRevision(repoRoot, AGENT_ID), /symbolic link/i);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

/**
 * The file map and the digest are the same answer in two forms. Recovery needs
 * the map so it can substitute the state a partly published operation is
 * moving between and ask what revision that state digests to, so the map holds
 * the exact bytes the revision is framed over — never a digest of a digest.
 */
test("the digest of the file map equals the revision read from disk", () => {
  const repoRoot = makeRepo();
  try {
    seedAgent(repoRoot);

    const files = readAgentRevisionFiles(repoRoot, AGENT_ID);

    assert.deepEqual(
      [...files.keys()].sort(),
      [
        `${AGENT_ID}.md`,
        "skills/indemnity-clause-review/SKILL.md",
        "skills/indemnity-clause-review/references/caps.md",
      ].sort(),
    );
    assert.deepEqual(
      files.get("skills/indemnity-clause-review/references/caps.md"),
      Buffer.from("Caps.\n"),
      "the map holds the exact file bytes the revision is framed over",
    );
    assert.equal(digestAgentRevisionFiles(files), computeAgentRevision(repoRoot, AGENT_ID));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

/**
 * An independent worked example of the framing the plan specifies: each
 * normalized path and that file's exact bytes, in sorted path order, with the
 * byte length of each part written before it so no part can be mistaken for
 * the start of the next one.
 */
test("the revision is the sha256 of each normalized path and its exact bytes", () => {
  const repoRoot = makeRepo();
  try {
    write(repoRoot, `${AGENT_ID}.md`, "PERSONA");
    write(repoRoot, "skills/alpha/SKILL.md", "ALPHA");

    const expected = createHash("sha256");
    for (const [relative, contents] of [
      [`${AGENT_ID}.md`, "PERSONA"],
      ["skills/alpha/SKILL.md", "ALPHA"],
    ] as const) {
      const pathBytes = Buffer.from(relative, "utf8");
      const contentBytes = Buffer.from(contents);
      expected.update(`${pathBytes.byteLength}:`, "utf8");
      expected.update(pathBytes);
      expected.update(`${contentBytes.byteLength}:`, "utf8");
      expected.update(contentBytes);
    }

    assert.equal(
      computeAgentRevision(repoRoot, AGENT_ID),
      `sha256:${expected.digest("hex")}`,
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

/**
 * Regression: file content is arbitrary bytes, so it can spell whatever
 * separator the framing uses. One file holding `X<sep>b<sep>Y` and two files
 * holding `X` and `Y` are different packages, and a frame a file's own bytes
 * can imitate would give them one revision — a changed Agent that still looks
 * exactly as the proposal pinned it.
 */
test("file bytes cannot imitate the frame that separates two files", () => {
  const collidingContent = Buffer.concat([
    Buffer.from("X"),
    Buffer.from([0x0a]),
    Buffer.from("skills/b/SKILL.md"),
    Buffer.from([0x00]),
    Buffer.from("Y"),
  ]);
  const oneFile = new Map([["skills/a/SKILL.md", collidingContent]]);
  const twoFiles = new Map([
    ["skills/a/SKILL.md", Buffer.from("X")],
    ["skills/b/SKILL.md", Buffer.from("Y")],
  ]);

  assert.notEqual(
    digestAgentRevisionFiles(oneFile),
    digestAgentRevisionFiles(twoFiles),
    "two different packages must not share one revision",
  );
});

/**
 * A path is bytes too. Framing that lets a path run into its own content, or
 * into the next path, has the same failure in a different place.
 */
test("a path cannot run into the content that follows it", () => {
  assert.notEqual(
    digestAgentRevisionFiles(new Map([["skills/ab/SKILL.md", Buffer.from("C")]])),
    digestAgentRevisionFiles(new Map([["skills/a/SKILL.md", Buffer.from("bC")]])),
  );
});

test("an Agent id that normalizes into another package is refused", () => {
  const repoRoot = makeRepo();
  try {
    seedAgent(repoRoot);

    for (const alias of [
      `elsewhere/../${AGENT_ID}`,
      `${AGENT_ID}/`,
      `./${AGENT_ID}`,
      `${AGENT_ID}/.`,
    ]) {
      assert.throws(
        () => computeAgentRevision(repoRoot, alias),
        /Agent id/,
        `expected the alias ${alias} to be refused`,
      );
    }
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("an Agent id that breaks the repository naming rule is refused", () => {
  const repoRoot = makeRepo();
  try {
    seedAgent(repoRoot);

    for (const identifier of ["Michigan-Contract-Lawyer", "-leading", "under_score", ""]) {
      assert.throws(
        () => computeAgentRevision(repoRoot, identifier),
        /Agent id/,
        `expected ${identifier} to be refused`,
      );
    }
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
