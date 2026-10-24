import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  WorkspaceProjectMembershipStore,
  WorkspaceProjectMembershipStoreError,
} from "../../domains/projects/project-membership-store.js";

const sessionId = "33333333-3333-4333-8333-333333333333";
const firstProjectId = "11111111-1111-4111-8111-111111111111";
const secondProjectId = "22222222-2222-4222-8222-222222222222";

test("membership store assigns, idempotently reassigns, moves, and removes one session record", async () => {
  const fixture = await makeFixture();
  try {
    const assigned = await fixture.store.assign(sessionId, firstProjectId);
    fixture.advance();
    const repeated = await fixture.store.assign(sessionId, firstProjectId);
    assert.equal(repeated.assignedAt, assigned.assignedAt);
    assert.equal(repeated.updatedAt, assigned.updatedAt);

    const moved = await fixture.store.assign(sessionId, secondProjectId);
    assert.equal(moved.projectId, secondProjectId);
    assert.equal(moved.assignedAt, assigned.assignedAt);
    assert.equal(moved.updatedAt, "2026-08-04T10:01:00.000Z");

    assert.equal((await fixture.store.list())[0]?.projectId, secondProjectId);
    assert.equal(await fixture.store.remove(sessionId), true);
    assert.equal(await fixture.store.get(sessionId), null);
  } finally {
    await fixture.cleanup();
  }
});

test("concurrent membership moves publish exactly one valid owner record", async () => {
  const fixture = await makeFixture();
  try {
    const secondStore = new WorkspaceProjectMembershipStore({
      workspacePath: fixture.workspacePath,
      now: () => new Date("2026-08-04T10:02:00.000Z"),
    });
    await Promise.all([
      fixture.store.assign(sessionId, firstProjectId),
      secondStore.assign(sessionId, secondProjectId),
    ]);

    const records = await fixture.store.list();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.sessionId, sessionId);
    assert.ok(
      records[0]?.projectId === firstProjectId ||
        records[0]?.projectId === secondProjectId,
    );
    const persisted = JSON.parse(
      await fs.readFile(
        path.join(
          fixture.workspacePath,
          "project-memberships",
          `${sessionId}.json`,
        ),
        "utf8",
      ),
    ) as { projectId: string };
    assert.equal(persisted.projectId, records[0]?.projectId);
  } finally {
    await fixture.cleanup();
  }
});

test("membership store rejects unsafe ids and reports corrupt records", async () => {
  const fixture = await makeFixture();
  try {
    await assert.rejects(
      fixture.store.assign("../session", firstProjectId),
      hasMembershipStoreError("invalid_session_id"),
    );
    await assert.rejects(
      fixture.store.assign(sessionId, "../project"),
      hasMembershipStoreError("invalid_project_id"),
    );
    const root = path.join(fixture.workspacePath, "project-memberships");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, `${sessionId}.json`), "{broken\n");

    const snapshot = await fixture.store.listWithDiagnostics();
    assert.deepEqual(snapshot.memberships, []);
    assert.deepEqual(snapshot.diagnostics, [
      { code: "corrupt_membership", sessionId },
    ]);
  } finally {
    await fixture.cleanup();
  }
});

function hasMembershipStoreError(
  code: WorkspaceProjectMembershipStoreError["code"],
) {
  return (error: unknown): boolean =>
    error instanceof WorkspaceProjectMembershipStoreError &&
    error.code === code;
}

async function makeFixture() {
  const workspacePath = await fs.mkdtemp(
    path.join(os.tmpdir(), "project-membership-store-"),
  );
  const times = [
    new Date("2026-08-04T10:00:00.000Z"),
    new Date("2026-08-04T10:01:00.000Z"),
  ];
  let timeIndex = 0;
  const store = new WorkspaceProjectMembershipStore({
    workspacePath,
    now: () => times[timeIndex]!,
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
