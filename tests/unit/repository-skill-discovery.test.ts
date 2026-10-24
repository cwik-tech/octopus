import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { collectRepositorySkillDirectories } from "../../scripts/collect-repository-skills.js";

test("source skill discovery excludes generated desktop revision snapshots and retains authored skills", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repository-skill-discovery-"));
  try {
    const authored = path.join(root, "agents/demo/skills/research");
    const generated = path.join(root, "test-results/desktop/user-data/resource-library/revisions/revision-one");
    fs.mkdirSync(authored, { recursive: true });
    fs.mkdirSync(generated, { recursive: true });
    fs.writeFileSync(path.join(authored, "SKILL.md"), "source skill");
    fs.writeFileSync(path.join(generated, "SKILL.md"), "runtime snapshot");

    assert.deepEqual(collectRepositorySkillDirectories(root), [authored]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an authored skill named test-results is still inspected", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "authored-test-results-"));
  try {
    const authored = path.join(root, "skills/test-results");
    fs.mkdirSync(authored, { recursive: true });
    fs.writeFileSync(path.join(authored, "SKILL.md"), "authored skill with a colliding folder name");
    assert.deepEqual(collectRepositorySkillDirectories(root), [authored]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
