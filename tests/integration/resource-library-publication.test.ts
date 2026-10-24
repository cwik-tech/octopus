import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ResourceLibraryService } from "../../services/resource-library-service.js";

test("Create overwrite retains the complete pre-overwrite skill even after external edits", async () => {
  const fixture = makeFixture();
  try {
    writeAgent(fixture.repoRoot, "alpha");
    writeSkill(fixture.repoRoot, "alpha", "research", "Original instructions");
    const service = new ResourceLibraryService({ requireMigrationApproval: false, repoRootPath: fixture.repoRoot, rootPath: fixture.libraryRoot });
    await service.initialize();
    const skillRoot = path.join(fixture.repoRoot, "agents/alpha/skills/research");
    fs.mkdirSync(path.join(skillRoot, "scripts"));
    fs.writeFileSync(path.join(skillRoot, "scripts/external.mjs"), "retained external bytes\n");

    await service.publishAgent("alpha", async () => {
      fs.rmSync(skillRoot, { recursive: true });
      writeSkill(fixture.repoRoot, "alpha", "research", "New instructions");
    });

    const snapshot = await service.store.getSnapshot();
    const research = snapshot.skills.find((skill) => skill.slug === "research");
    assert.ok(research);
    const retained = research.revisions.find((revision) => revision.files.some((file) => file.path === "scripts/external.mjs"));
    assert.ok(retained, "pre-overwrite external files must be retained before the writer deletes them");
    const files = await service.store.readSkillRevisionFiles(research.id, retained.id);
    assert.equal(files.get("scripts/external.mjs")?.toString(), "retained external bytes\n");
  } finally { fixture.cleanup(); }
});

test("Agent publication ingests a new revision only for the authoring Agent", async () => {
  const fixture = makeFixture();
  try {
    writeAgent(fixture.repoRoot, "alpha");
    writeAgent(fixture.repoRoot, "beta");
    writeSkill(fixture.repoRoot, "alpha", "research", "Original instructions");
    writeSkill(fixture.repoRoot, "beta", "research", "Original instructions");
    const service = new ResourceLibraryService({ requireMigrationApproval: false,
      repoRootPath: fixture.repoRoot,
      rootPath: fixture.libraryRoot,
    });
    const initial = await service.getBrowserSnapshot();
    const skill = initial.skills.find((candidate) => candidate.slug === "research");
    assert.ok(skill);
    const originalRevisionId = skill.currentRevisionId;
    fs.writeFileSync(
      path.join(fixture.repoRoot, "agents", "alpha", "skills", "research", "SKILL.md"),
      skillDocument("research", "Updated instructions"),
    );
    writeSkill(fixture.repoRoot, "alpha", "planning", "Plan carefully");

    await service.ingestAgentSkills("alpha");

    const snapshot = await service.getBrowserSnapshot();
    const updatedSkill = snapshot.skills.find((candidate) => candidate.id === skill.id);
    assert.equal(updatedSkill?.revisions.length, 2);
    assert.notEqual(updatedSkill?.currentRevisionId, originalRevisionId);
    assert.equal(snapshot.agents.find((agent) => agent.id === "alpha")?.attachments.find((attachment) => attachment.alias === "research")?.revisionId, updatedSkill?.currentRevisionId);
    assert.equal(snapshot.agents.find((agent) => agent.id === "beta")?.attachments[0]?.revisionId, originalRevisionId);
    assert.ok(snapshot.agents.find((agent) => agent.id === "alpha")?.attachments.some((attachment) => attachment.alias === "planning"));
    assert.equal(
      fs.readFileSync(path.join(fixture.repoRoot, "agents", "beta", "skills", "research", "SKILL.md"), "utf8"),
      skillDocument("research", "Original instructions"),
    );
  } finally {
    fixture.cleanup();
  }
});

function makeFixture(): { repoRoot: string; libraryRoot: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resource-library-publication-"));
  const repoRoot = path.join(root, "project");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
  return {
    repoRoot,
    libraryRoot: path.join(root, "library"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function writeAgent(repoRoot: string, agentName: string): void {
  const agentDir = path.join(repoRoot, "agents", agentName);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, `${agentName}.md`), `# ${agentName}\n`);
}

function writeSkill(repoRoot: string, agentName: string, skillName: string, instructions: string): void {
  const skillDir = path.join(repoRoot, "agents", agentName, "skills", skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillDocument(skillName, instructions));
}

function skillDocument(skillName: string, instructions: string): string {
  return `---\nname: ${skillName}\ndescription: Researches exactly. Use when exact research is needed.\n---\n\n# ${instructions}\n`;
}
