import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ResourceLibraryConflictError,
  ResourceLibraryStore,
} from "../../domains/resource-library/resource-library-store.js";
import type { ResourceSkillFiles } from "../../domains/resource-library/skill-files.js";

test("script edit and restore-as-new retain history and other Agent pins", async () => {
  const fixture = makeFixture();
  try {
    const store = new ResourceLibraryStore({
      repoRoot: fixture.repoRoot,
      rootPath: fixture.libraryRoot,
      now: () => new Date("2026-10-18T10:00:00.000Z"),
    });
    const created = await store.createSkill({
      slug: "research",
      files: skillFiles("Initial instructions", "old script"),
      changeNote: "Initial skill",
      expectedGeneration: 0,
    });
    assert.equal(created.skill.revisions.length, 1);

    const edited = await store.saveSkillRevision({
      skillId: created.skill.id,
      baseRevisionId: created.revision.id,
      files: skillFiles("Initial instructions", "new script"),
      changeNote: "Update only the script",
      expectedGeneration: 1,
    });
    assert.equal(edited.unchanged, false);
    assert.equal(edited.revision.sequence, 2);
    assert.equal(edited.revision.parentRevisionId, created.revision.id);
    assert.equal(edited.skill.revisions.length, 2);
    assert.equal(edited.revision.files.find((file) => file.path === "scripts/run.mjs")?.executable, true);

    const unchanged = await store.saveSkillRevision({
      skillId: created.skill.id,
      baseRevisionId: edited.revision.id,
      files: skillFiles("Initial instructions", "new script"),
      changeNote: "No actual change",
      expectedGeneration: 2,
    });
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.skill.revisions.length, 2);
    assert.equal((await store.getSnapshot()).generation, 2);

    const restored = await store.restoreSkillRevision({
      skillId: created.skill.id,
      sourceRevisionId: created.revision.id,
      baseRevisionId: edited.revision.id,
      changeNote: "Restore the original script",
      expectedGeneration: 2,
    });
    assert.equal(restored.revision.sequence, 3);
    assert.equal(restored.revision.parentRevisionId, edited.revision.id);
    assert.equal(restored.revision.restoredFromRevisionId, created.revision.id);
    assert.equal(restored.revision.digest, created.revision.digest);
    assert.equal(restored.skill.revisions.length, 3);
    const restoredFiles = await store.readSkillRevisionFiles(
      created.skill.id,
      restored.revision.id,
    );
    assert.equal(restoredFiles.get("scripts/run.mjs")?.toString("utf8"), "old script\n");

    await assert.rejects(
      store.saveSkillRevision({
        skillId: created.skill.id,
        baseRevisionId: edited.revision.id,
        files: skillFiles("Initial instructions", "stale script"),
        changeNote: "Stale window",
        expectedGeneration: 2,
      }),
      (error: unknown) => error instanceof ResourceLibraryConflictError &&
        error.code === "generation_conflict",
    );
    assert.equal((await store.getSnapshot()).generation, 3);
  } finally {
    fixture.cleanup();
  }
});

test("a failure after catalog staging leaves the previous generation authoritative", async () => {
  const fixture = makeFixture();
  try {
    const store = new ResourceLibraryStore({
      repoRoot: fixture.repoRoot,
      rootPath: fixture.libraryRoot,
    });
    const created = await store.createSkill({
      slug: "research",
      files: skillFiles("Initial instructions", "old script"),
      changeNote: "Initial skill",
      expectedGeneration: 0,
    });
    const pointerBefore = fs.readFileSync(path.join(fixture.libraryRoot, "current.json"), "utf8");
    let ids = 0;
    const failingStore = new ResourceLibraryStore({
      repoRoot: fixture.repoRoot,
      rootPath: fixture.libraryRoot,
      createId: () => `staged-${++ids}`,
      onPersistenceBoundary: (boundary) => {
        if (boundary === "catalog_staged") throw new Error("simulated crash");
      },
    });

    await assert.rejects(
      failingStore.saveSkillRevision({
        skillId: created.skill.id,
        baseRevisionId: created.revision.id,
        files: skillFiles("Initial instructions", "new script"),
        changeNote: "Must not become visible",
        expectedGeneration: 1,
      }),
      /simulated crash/,
    );
    assert.equal((await store.getSnapshot()).generation, 1);
    assert.equal(
      fs.readFileSync(path.join(fixture.libraryRoot, "current.json"), "utf8"),
      pointerBefore,
    );

    const recovered = await store.saveSkillRevision({
      skillId: created.skill.id,
      baseRevisionId: created.revision.id,
      files: skillFiles("Initial instructions", "new script"),
      changeNote: "Retry after crash",
      expectedGeneration: 1,
    });
    assert.equal(recovered.revision.sequence, 2);
    assert.equal((await store.getSnapshot()).generation, 2);
  } finally {
    fixture.cleanup();
  }
});

function makeFixture(): { repoRoot: string; libraryRoot: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-revisions-"));
  fs.mkdirSync(path.join(root, "project"), { recursive: true });
  return {
    repoRoot: path.join(root, "project"),
    libraryRoot: path.join(root, "library"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function skillFiles(instructions: string, script: string): ResourceSkillFiles {
  return new Map([
    ["SKILL.md", {
      contents: Buffer.from(
        `---\nname: research\ndescription: Researches exactly. Use when exact research is needed.\n---\n\n# ${instructions}\n`,
      ),
      mode: 0o644,
      executable: false,
    }],
    ["scripts/run.mjs", {
      contents: Buffer.from(`${script}\n`),
      mode: 0o755,
      executable: true,
    }],
  ]);
}
