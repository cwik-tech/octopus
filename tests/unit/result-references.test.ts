import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FileSystemSessionStore } from "../../domains/sessions/session-store.js";
import {
  parseResultReference,
  resultReferenceId,
  type ResultReference,
} from "../../contracts/schemas/result-reference.js";

/**
 * A result reference points at output that already exists. Publication is
 * idempotent by producer and execution attempt, because a recovery sweep
 * revisiting a finished run and a replay of the turn that started it both
 * arrive at the same completed work.
 */

function reference(
  sessionId: string,
  overrides: Partial<ResultReference> = {},
): ResultReference {
  return {
    schemaVersion: 1,
    id: resultReferenceId({
      producerKind: "team",
      producerId: "problem-thinking-board",
      executionAttemptId: "attempt-1",
    }),
    sessionId,
    producer: {
      kind: "team",
      id: "problem-thinking-board",
      label: "Problem Thinking Board",
    },
    status: "done",
    completedAt: "2026-09-09T10:00:00.000Z",
    brief: "Decompose the launch decision.",
    source: { kind: "run-summary", runId: "run-1" },
    ...overrides,
  };
}

async function withStore(
  run: (store: FileSystemSessionStore, sessionId: string, workspace: string) => Promise<void>,
): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "result-refs-"));
  try {
    const store = new FileSystemSessionStore(workspace);
    const session = await store.createSession({ title: "Results" });
    await run(store, session.id, workspace);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

test("a session with no results offers none", async () => {
  await withStore(async (store, sessionId) => {
    assert.deepEqual(await store.listResultReferences(sessionId), []);
  });
});

test("a published result is readable back", async () => {
  await withStore(async (store, sessionId) => {
    assert.equal(
      await store.publishResultReference(sessionId, reference(sessionId)),
      true,
    );

    const stored = await store.listResultReferences(sessionId);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.producer.label, "Problem Thinking Board");
    assert.deepEqual(stored[0]?.source, { kind: "run-summary", runId: "run-1" });
  });
});

test("publishing the same producer and attempt twice records it once", async () => {
  await withStore(async (store, sessionId) => {
    assert.equal(
      await store.publishResultReference(sessionId, reference(sessionId)),
      true,
    );
    assert.equal(
      await store.publishResultReference(sessionId, reference(sessionId)),
      false,
      "the second publication is a no-op, not a second record",
    );

    assert.equal((await store.listResultReferences(sessionId)).length, 1);
  });
});

test("a second attempt of the same producer is a different result", async () => {
  await withStore(async (store, sessionId) => {
    await store.publishResultReference(sessionId, reference(sessionId));
    await store.publishResultReference(
      sessionId,
      reference(sessionId, {
        id: resultReferenceId({
          producerKind: "team",
          producerId: "problem-thinking-board",
          executionAttemptId: "attempt-2",
        }),
      }),
    );

    assert.equal((await store.listResultReferences(sessionId)).length, 2);
  });
});

test("a reference belonging to another session is refused", async () => {
  await withStore(async (store, sessionId) => {
    assert.equal(
      await store.publishResultReference(
        sessionId,
        reference("00000000-0000-4000-8000-000000000000"),
      ),
      false,
    );
    assert.deepEqual(await store.listResultReferences(sessionId), []);
  });
});

test("an unreadable record costs its own continuation, not the session", async () => {
  await withStore(async (store, sessionId, workspace) => {
    await store.publishResultReference(sessionId, reference(sessionId));
    const resultsPath = path.join(
      workspace,
      "sessions",
      sessionId,
      "results.jsonl",
    );
    fs.appendFileSync(
      resultsPath,
      `{"schemaVersion":99,"id":"from-a-later-build"}\n{ not json\n`,
      "utf8",
    );

    const stored = await store.listResultReferences(sessionId);
    assert.equal(stored.length, 1, "the readable record survives its neighbours");
  });
});

test("the schema refuses a record missing its pointer", () => {
  assert.equal(
    parseResultReference({
      schemaVersion: 1,
      id: "team:board",
      sessionId: "session-1",
      producer: { kind: "team", id: "board", label: "Board" },
      status: "done",
      completedAt: "2026-09-09T10:00:00.000Z",
    }),
    undefined,
  );
});

/**
 * A record written before provenance was recorded cannot be re-verified at use
 * time, so it has to be repairable. The log stays append-only; the reader keeps
 * the last record for an id.
 */
test("a held record is rewritten only to add provenance it lacked", async () => {
  await withStore(async (store, sessionId) => {
    const legacy = reference(sessionId);
    delete (legacy as { producerTaskId?: string }).producerTaskId;
    assert.equal(await store.publishResultReference(sessionId, legacy), true);

    const repaired = reference(sessionId, { producerTaskId: "task-1" });
    assert.equal(
      await store.publishResultReference(sessionId, repaired),
      true,
      "an upgrade is written",
    );
    assert.equal(
      await store.publishResultReference(sessionId, repaired),
      false,
      "and re-offering the same record adds nothing",
    );

    const stored = await store.listResultReferences(sessionId);
    assert.equal(stored.length, 1, "the reader keeps one record per id");
    assert.equal(stored[0]?.producerTaskId, "task-1");
  });
});

test("a held record is rewritten to add a digest it lacked", async () => {
  await withStore(async (store, sessionId) => {
    const withoutDigest = reference(sessionId, {
      producerTaskId: "task-1",
      source: { kind: "artifact", runId: "run-1", path: "output/final.md" },
    });
    await store.publishResultReference(sessionId, withoutDigest);

    const withDigest = reference(sessionId, {
      producerTaskId: "task-1",
      source: {
        kind: "artifact",
        runId: "run-1",
        path: "output/final.md",
        digest: "a".repeat(64),
      },
    });
    assert.equal(await store.publishResultReference(sessionId, withDigest), true);

    const stored = await store.listResultReferences(sessionId);
    assert.equal(stored.length, 1);
    assert.equal(
      stored[0]?.source.kind === "artifact"
        ? stored[0].source.digest
        : undefined,
      "a".repeat(64),
    );
  });
});

test("a record that adds nothing is not written a second time", async () => {
  await withStore(async (store, sessionId) => {
    const complete = reference(sessionId, { producerTaskId: "task-1" });
    assert.equal(await store.publishResultReference(sessionId, complete), true);
    assert.equal(await store.publishResultReference(sessionId, complete), false);

    assert.equal((await store.listResultReferences(sessionId)).length, 1);
  });
});
