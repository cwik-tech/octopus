import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { FileSystemSessionStore } from "../../domains/sessions/session-store.js";

test("session summary reads do not invoke task recovery", async () => {
  const workspacePath = await fs.mkdtemp(
    path.join(os.tmpdir(), "session-read-model-"),
  );
  try {
    const store = new FileSystemSessionStore(workspacePath);
    const session = await store.createSession({ title: "Read-only summary" });
    let reconciliationCalls = 0;
    store.reconcileTaskRecords = async () => {
      reconciliationCalls += 1;
      return [];
    };

    const sessions = await store.listSessions();
    const detail = await store.getSession(session.id);

    assert.deepEqual(sessions.map((entry) => entry.id), [session.id]);
    assert.equal(detail?.id, session.id);
    assert.equal(reconciliationCalls, 0);
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});
