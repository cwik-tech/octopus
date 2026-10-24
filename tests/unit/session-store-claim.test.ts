/**
 * The claim a client-minted session id is published with.
 *
 * A claim is what lets a retry after a lost response be handed back the session
 * it already made, instead of colliding with it. These tests cover the two
 * places that entitlement can quietly break: a token that does not survive the
 * session's later writes, and a replay that gets cleaned up as though this call
 * had created it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import {
  FileSystemSessionStore,
  SessionStoreError,
} from "../../domains/sessions/session-store.js";
import { WorkspaceProjectService } from "../../domains/projects/workspace-project-service.js";
import { WorkspaceProjectStore } from "../../domains/projects/project-store.js";
import { WorkspaceProjectMembershipStore } from "../../domains/projects/project-membership-store.js";

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "session-claim-"));
}

test("a claim outlives the session's own metadata rewrites", async () => {
  const workspacePath = makeWorkspace();
  try {
    const store = new FileSystemSessionStore(workspacePath);
    const claim = { id: randomUUID(), creationToken: randomUUID() };

    const created = await store.createSessionWithClaim(claim);
    assert.equal(created.outcome, "created");
    await store.updateSessionTitle(claim.id, "Renamed after the create");

    const replay = await store.createSessionWithClaim(claim);
    assert.equal(replay.outcome, "replayed");
    assert.equal(replay.session.title, "Renamed after the create");
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("the creation token is never part of the session summary", async () => {
  const workspacePath = makeWorkspace();
  try {
    const store = new FileSystemSessionStore(workspacePath);
    const claim = { id: randomUUID(), creationToken: randomUUID() };
    const created = await store.createSessionWithClaim(claim);

    assert.ok(
      !Object.keys(created.session).includes("creationToken"),
      "summary must not carry the token",
    );
    const listed = await store.listSessions();
    assert.equal(JSON.stringify(listed).includes(claim.creationToken), false);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("an empty pre-existing session directory cannot be claimed", async () => {
  const workspacePath = makeWorkspace();
  try {
    const store = new FileSystemSessionStore(workspacePath);
    const claim = { id: randomUUID(), creationToken: randomUUID() };
    const existingDirectory = path.join(workspacePath, "sessions", claim.id);
    fs.mkdirSync(existingDirectory, { recursive: true });

    await assert.rejects(
      () => store.createSessionWithClaim(claim),
      (error: unknown) => {
        assert.ok(error instanceof SessionStoreError);
        assert.equal(error.code, "session_id_conflict");
        return true;
      },
    );
    assert.deepEqual(fs.readdirSync(existingDirectory), []);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("a failed project assignment does not delete a session the call only replayed", async () => {
  const workspacePath = makeWorkspace();
  try {
    const sessionStore = new FileSystemSessionStore(workspacePath);
    const projectStore = new WorkspaceProjectStore({ workspacePath });
    const membershipStore = new WorkspaceProjectMembershipStore({
      workspacePath,
    });
    const service = new WorkspaceProjectService({
      projectStore,
      membershipStore,
      sessionStore,
    });

    const claim = { id: randomUUID(), creationToken: randomUUID() };
    await sessionStore.createSessionWithClaim({ ...claim, title: "Already mine" });
    const project = await projectStore.create({ name: "Destination" });

    // A corrupt membership record makes the assignment inside the create
    // transaction fail after the store has already answered "replayed".
    const membershipRoot = path.join(workspacePath, "project-memberships");
    fs.mkdirSync(membershipRoot, { recursive: true });
    fs.writeFileSync(
      path.join(membershipRoot, `${claim.id}.json`),
      "{ not valid json",
    );

    await assert.rejects(() =>
      service.createSessionWithClaim({ ...claim, projectId: project.id }),
    );

    const survivor = await sessionStore.getSession(claim.id);
    assert.ok(survivor, "a replayed session must survive a failed assignment");
    assert.equal(survivor.title, "Already mine");
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});
