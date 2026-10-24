import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  WorkspaceProjectStore,
  WorkspaceProjectStoreError,
} from "../../domains/projects/project-store.js";

const firstProjectId = "11111111-1111-4111-8111-111111111111";
const secondProjectId = "22222222-2222-4222-8222-222222222222";

test("project store persists normalized records and lists active projects deterministically", async () => {
  const fixture = await makeFixture();
  try {
    const first = await fixture.store.create({
      name: "  Acme Startup  ",
      description: "  Launch research  ",
    });
    fixture.advance();
    const second = await fixture.store.create({ name: "Northwind" });

    assert.equal(first.id, firstProjectId);
    assert.equal(first.name, "Acme Startup");
    assert.equal(first.description, "Launch research");
    assert.equal(first.status, "active");
    assert.deepEqual(
      (await fixture.store.list()).map((project) => project.id),
      [second.id, first.id],
    );

    const restarted = new WorkspaceProjectStore({
      workspacePath: fixture.workspacePath,
    });
    assert.deepEqual(await restarted.get(first.id), first);
  } finally {
    await fixture.cleanup();
  }
});

test("project store archives, restores, updates, and hard-deletes a project", async () => {
  const fixture = await makeFixture();
  try {
    const project = await fixture.store.create({ name: "Acme" });
    fixture.advance();
    const updated = await fixture.store.update(project.id, {
      name: "Acme Labs",
      description: "New brief",
    });
    assert.equal(updated?.name, "Acme Labs");

    fixture.advance();
    const archived = await fixture.store.archive(project.id);
    assert.equal(archived?.status, "archived");
    assert.equal((await fixture.store.list()).length, 0);
    assert.equal((await fixture.store.list({ includeArchived: true })).length, 1);

    fixture.advance();
    assert.equal((await fixture.store.restore(project.id))?.status, "active");
    assert.equal(await fixture.store.hardDelete(project.id), true);
    assert.equal(await fixture.store.get(project.id), null);
  } finally {
    await fixture.cleanup();
  }
});

test("project store rejects invalid records and reports corrupt persisted projects", async () => {
  const fixture = await makeFixture();
  try {
    await assert.rejects(
      fixture.store.create({ name: "   " }),
      hasProjectStoreError("invalid_project"),
    );
    await assert.rejects(
      fixture.store.get("../escape"),
      hasProjectStoreError("invalid_project_id"),
    );

    const corruptDir = path.join(
      fixture.workspacePath,
      "projects",
      secondProjectId,
    );
    await fs.mkdir(corruptDir, { recursive: true });
    await fs.writeFile(path.join(corruptDir, "project.json"), "{broken\n");

    const snapshot = await fixture.store.listWithDiagnostics({
      includeArchived: true,
    });
    assert.deepEqual(snapshot.projects, []);
    assert.deepEqual(snapshot.diagnostics, [
      {
        code: "corrupt_project",
        projectId: secondProjectId,
      },
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("project store fails closed when the projects root is a symlink", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink permissions differ on Windows");
    return;
  }
  const fixture = await makeFixture();
  const outsidePath = await fs.mkdtemp(path.join(os.tmpdir(), "project-store-outside-"));
  try {
    await fs.symlink(outsidePath, path.join(fixture.workspacePath, "projects"));
    await assert.rejects(
      fixture.store.create({ name: "Escaped" }),
      hasProjectStoreError("unsafe_storage"),
    );
    assert.deepEqual(await fs.readdir(outsidePath), []);
  } finally {
    await fs.rm(outsidePath, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

function hasProjectStoreError(code: WorkspaceProjectStoreError["code"]) {
  return (error: unknown): boolean =>
    error instanceof WorkspaceProjectStoreError && error.code === code;
}

async function makeFixture() {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "project-store-"));
  const times = [
    new Date("2026-08-04T10:00:00.000Z"),
    new Date("2026-08-04T10:01:00.000Z"),
    new Date("2026-08-04T10:02:00.000Z"),
    new Date("2026-08-04T10:03:00.000Z"),
  ];
  const ids = [firstProjectId, secondProjectId];
  let timeIndex = 0;
  let idIndex = 0;
  const store = new WorkspaceProjectStore({
    workspacePath,
    now: () => times[timeIndex]!,
    randomUUID: () => ids[idIndex++]!,
  });
  return {
    workspacePath,
    store,
    advance() {
      timeIndex += 1;
    },
    cleanup: () => fs.rm(workspacePath, { recursive: true, force: true }),
  };
}
