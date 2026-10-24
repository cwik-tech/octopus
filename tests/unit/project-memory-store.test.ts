import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { WorkspaceProjectMemoryStore } from "../../domains/projects/project-memory-store.js";
import { WorkspaceProjectStore } from "../../domains/projects/project-store.js";

test("project memory proposals require an explicit durable decision", async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "project-memory-"));
  try {
    const project = await new WorkspaceProjectStore({ workspacePath }).create({
      name: "Memory owner",
    });
    const store = new WorkspaceProjectMemoryStore({ workspacePath });

    const pending = await store.propose(project.id, {
      content: "  The launch region is Europe.  ",
      sourceSessionId: "11111111-1111-4111-8111-111111111111",
    });
    assert.equal(pending.content, "The launch region is Europe.");
    assert.equal(pending.status, "pending");
    assert.equal((await store.list(project.id, { status: "approved" })).length, 0);

    const approved = await store.decide(project.id, pending.id, "approved");
    assert.equal(approved.status, "approved");
    assert.match(approved.decidedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(await store.list(project.id, { status: "approved" }), [approved]);
    await assert.rejects(
      store.decide(project.id, pending.id, "rejected"),
      /already decided/i,
    );

    const persistedPath = path.join(
      workspacePath,
      "projects",
      project.id,
      "context",
      "memory-proposals",
      `${pending.id}.json`,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(persistedPath, "utf8")), approved);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});
