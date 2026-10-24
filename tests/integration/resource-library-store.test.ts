import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ResourceLibraryStore } from "../../domains/resource-library/resource-library-store.js";

test("migration replay and restart retain exact variants and Agent pins", async () => {
  const fixture = makeFixture();
  try {
    writeSkill(fixture.repoRoot, "skills/research", "Shared instructions", "shared script");
    writeSkill(fixture.repoRoot, "agents/alpha/skills/research", "Shared instructions", "shared script");
    writeSkill(fixture.repoRoot, "agents/beta/skills/research", "Beta instructions", "beta script");
    writeAgent(fixture.repoRoot, "alpha");
    writeAgent(fixture.repoRoot, "beta");

    const firstStore = new ResourceLibraryStore({
      repoRoot: fixture.repoRoot,
      rootPath: fixture.libraryRoot,
      now: () => new Date("2026-10-18T10:00:00.000Z"),
    });
    const firstReceipt = await firstStore.migrateLegacyResources();
    const migrated = await firstStore.getSnapshot();

    assert.equal(firstReceipt.alreadyMigrated, false);
    assert.equal(migrated.generation, 1);
    assert.equal(migrated.skills.length, 2);
    const alpha = migrated.agents.find((agent) => agent.id === "alpha");
    const beta = migrated.agents.find((agent) => agent.id === "beta");
    assert.ok(alpha);
    assert.ok(beta);
    assert.equal(alpha.attachments.length, 1);
    assert.equal(beta.attachments.length, 1);
    const alphaAttachment = alpha.attachments[0];
    const betaAttachment = beta.attachments[0];
    assert.ok(alphaAttachment);
    assert.ok(betaAttachment);
    assert.equal(alphaAttachment.alias, "research");
    assert.equal(betaAttachment.alias, "research");
    assert.notEqual(alphaAttachment.skillId, betaAttachment.skillId);
    assert.notEqual(alphaAttachment.revisionId, betaAttachment.revisionId);

    const betaFiles = await firstStore.readSkillRevisionFiles(
      betaAttachment.skillId,
      betaAttachment.revisionId,
    );
    assert.equal(betaFiles.get("SKILL.md")?.toString("utf8"), skillDocument("Beta instructions"));
    assert.equal(betaFiles.get("scripts/run.mjs")?.toString("utf8"), "beta script\n");
    assert.equal(
      fs.readFileSync(path.join(fixture.repoRoot, "agents/beta/skills/research/SKILL.md"), "utf8"),
      skillDocument("Beta instructions"),
    );

    const pointerBefore = fs.readFileSync(path.join(fixture.libraryRoot, "current.json"), "utf8");
    const restartedStore = new ResourceLibraryStore({
      repoRoot: fixture.repoRoot,
      rootPath: fixture.libraryRoot,
      now: () => new Date("2026-10-18T11:00:00.000Z"),
    });
    const replayReceipt = await restartedStore.migrateLegacyResources();
    const restarted = await restartedStore.getSnapshot();

    assert.equal(replayReceipt.alreadyMigrated, true);
    assert.equal(fs.readFileSync(path.join(fixture.libraryRoot, "current.json"), "utf8"), pointerBefore);
    assert.deepEqual(restarted, migrated);
  } finally {
    fixture.cleanup();
  }
});

function makeFixture(): { repoRoot: string; libraryRoot: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resource-library-store-"));
  return {
    repoRoot: path.join(root, "project"),
    libraryRoot: path.join(root, "library"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function writeAgent(repoRoot: string, agentName: string): void {
  const agentDir = path.join(repoRoot, "agents", agentName);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, `${agentName}.md`), `# ${agentName}\n`);
}

function writeSkill(repoRoot: string, relativeRoot: string, instructions: string, script: string): void {
  const skillDir = path.join(repoRoot, relativeRoot);
  fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillDocument(instructions));
  fs.writeFileSync(path.join(skillDir, "scripts", "run.mjs"), `${script}\n`);
}

function skillDocument(instructions: string): string {
  return `---\nname: research\ndescription: Researches exactly.\n---\n\n# ${instructions}\n`;
}

test('migration inventories preserved same-name variants inside their grouping folders', async () => {
  const fixture = makeFixture();
  try {
    writeAgent(fixture.repoRoot, 'alpha');
    writeSkill(fixture.repoRoot, 'skills/research', 'Primary instructions', 'primary script');
    writeSkill(fixture.repoRoot, 'skills/research-preserved/research', 'Preserved instructions', 'preserved script');
    const store = new ResourceLibraryStore({ repoRoot: fixture.repoRoot, rootPath: fixture.libraryRoot });
    const receipt = await store.migrateLegacyResources();
    assert.equal(receipt.importedSourceCount, 2);
    const snapshot = await store.getSnapshot();
    const variant = snapshot.skills.find((item) => item.provenance.includes('skills/research-preserved/research'));
    assert.ok(variant);
    assert.equal((await store.readSkillRevisionSnapshot(variant.id, variant.currentRevisionId)).get('scripts/run.mjs')?.contents.toString(), 'preserved script\n');
  } finally { fixture.cleanup(); }
});
