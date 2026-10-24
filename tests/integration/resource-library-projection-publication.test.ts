import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { projectAgentSkills } from "../../domains/resource-library/agent-projection.js";
import { ResourceLibraryStore } from "../../domains/resource-library/resource-library-store.js";
import { ResourceLibraryService } from "../../services/resource-library-service.js";

test("a rejected detach restores the original projection and catalog on restart", async () => {
  const fixture = await makeFixture();
  try {
    const initial = await fixture.store.getSnapshot();
    fixture.failPublication();

    await assert.rejects(fixture.store.detachSkill({
      agentId: "alpha", alias: "research", expectedGeneration: initial.generation,
    }), /injected publication failure/);

    const restarted = new ResourceLibraryStore({ repoRoot: fixture.repoRoot, rootPath: fixture.libraryRoot });
    await restarted.migrateLegacyResources();
    assert.deepEqual(await restarted.getSnapshot(), initial);
    assert.equal(await fs.readFile(fixture.documentPath, "utf8"), document("research"));
  } finally { await fixture.cleanup(); }
});

test("attaching another skill rejects external drift without losing the edited bytes", async () => {
  const fixture = await makeFixture();
  try {
    const initial = await fixture.store.getSnapshot();
    const created = await fixture.store.createSkill({
      slug: "planning", changeNote: "Plan", expectedGeneration: initial.generation,
      files: new Map([["SKILL.md", { contents: Buffer.from(document("planning")), mode: 0o644, executable: false }]]),
    });
    const before = await fixture.store.getSnapshot();
    const external = `${document("research")}External edit\n`;
    await fs.writeFile(fixture.documentPath, external);

    await assert.rejects(fixture.store.attachSkill({
      agentId: "alpha", skillId: created.skill.id, revisionId: created.revision.id,
      alias: "planning", expectedGeneration: before.generation,
    }), /drift/i);

    assert.deepEqual(await fixture.store.getSnapshot(), before);
    assert.equal(await fs.readFile(fixture.documentPath, "utf8"), external);
  } finally { await fixture.cleanup(); }
});

test("restart restores the projection when the process exits before catalog commit", async () => {
  const fixture = await makeFixture();
  try {
    const before = await fixture.store.getSnapshot();
    exitBeforeCommit(fixture);

    const restarted = new ResourceLibraryStore({ repoRoot: fixture.repoRoot, rootPath: fixture.libraryRoot });
    await restarted.migrateLegacyResources();
    assert.deepEqual(await restarted.getSnapshot(), before);
    assert.equal(await fs.readFile(fixture.documentPath, "utf8"), document("research"));
  } finally { await fixture.cleanup(); }
});

test("an already initialized service recovers a crashed projection before publishing an Agent", async () => {
  const fixture = await makeFixture();
  try {
    const service = new ResourceLibraryService({ requireMigrationApproval: false, repoRootPath: fixture.repoRoot, rootPath: fixture.libraryRoot });
    await service.initialize();
    exitBeforeCommit(fixture);
    await service.publishAgent("alpha", async () => {
      assert.equal(await fs.readFile(fixture.documentPath, "utf8"), document("research"));
    });
    const after = await service.store.getSnapshot();
    assert.equal(after.agents.find((agent) => agent.id === "alpha")?.attachments.length, 1);
  } finally { await fixture.cleanup(); }
});

function exitBeforeCommit(fixture: { repoRoot: string; libraryRoot: string }): void {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { ResourceLibraryStore } from ${JSON.stringify(new URL("../../domains/resource-library/resource-library-store.js", import.meta.url).href)};
      import { projectAgentSkills } from ${JSON.stringify(new URL("../../domains/resource-library/agent-projection.js", import.meta.url).href)};
      const repoRoot = process.env.REVIEW_REPO;
      const store = new ResourceLibraryStore({ repoRoot, rootPath: process.env.REVIEW_LIBRARY,
        projectAgent: projection => projectAgentSkills({ repoRoot, projection }),
        onPersistenceBoundary: boundary => { if (boundary === "catalog_staged") process.exit(71); },
      });
      const current = await store.getSnapshot();
      await store.detachSkill({ agentId: "alpha", alias: "research", expectedGeneration: current.generation });
    `], { env: { ...process.env, REVIEW_REPO: fixture.repoRoot, REVIEW_LIBRARY: fixture.libraryRoot }, timeout: 5000, encoding: "utf8" });
  assert.equal(child.status, 71, child.stderr);

}

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "resource-projection-publication-"));
  const repoRoot = path.join(root, "project");
  const libraryRoot = path.join(root, "library");
  const documentPath = path.join(repoRoot, "agents/alpha/skills/research/SKILL.md");
  await fs.mkdir(path.dirname(documentPath), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "agents/alpha/alpha.md"), "# Alpha\n");
  await fs.writeFile(documentPath, document("research"));
  let fail = false;
  const store = new ResourceLibraryStore({
    repoRoot, rootPath: libraryRoot,
    projectAgent: (projection) => projectAgentSkills({ repoRoot, projection }),
    onPersistenceBoundary: (boundary) => {
      if (fail && boundary === "catalog_staged") throw new Error("injected publication failure");
    },
  });
  await store.migrateLegacyResources();
  return { repoRoot, libraryRoot, documentPath, store,
    failPublication: () => { fail = true; },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

function document(name: string): string {
  return `---\nname: ${name}\ndescription: Researches exactly. Use when research is needed.\n---\n\n# Instructions\n`;
}
