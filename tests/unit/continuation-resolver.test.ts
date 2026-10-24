import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  MAX_RESULT_READ_BYTES,
  ensureResultReferences,
  resolveContinuationContext,
} from "../../services/continuation-resolver.js";
import { TEAM_CHAT_MESSAGE_EVENT_TYPE } from "../../contracts/team-chat-messages.js";
import type { ChatMessage, SessionTask } from "../../contracts/sessions.js";
import type { ResultReference } from "../../contracts/schemas/result-reference.js";

/**
 * The shell reads only what selection returned. An earlier version read every
 * completed task's artifact in full and then chose three, so the rendered block
 * was bounded while the disk reads were not.
 */

const SESSION = "session-1";

function task(overrides: Partial<SessionTask> & { id: string }): SessionTask {
  return {
    sessionId: SESSION,
    runId: `run-${overrides.id}`,
    workflowId: "discussion-to-writing3",
    brief: "Decompose the launch decision.",
    status: "done",
    createdAt: "2026-09-09T09:00:00.000Z",
    completedAt: "2026-09-09T10:00:00.000Z",
    cwd: "/tmp/run",
    ...overrides,
  };
}

/** The store's own rule: an id is written again only to add provenance. */
function upgradesProvenance(
  held: ResultReference,
  incoming: ResultReference,
): boolean {
  if (held.producerTaskId === undefined && incoming.producerTaskId !== undefined) {
    return true;
  }
  const heldDigest =
    held.source.kind === "artifact" ? held.source.digest : undefined;
  const incomingDigest =
    incoming.source.kind === "artifact" ? incoming.source.digest : undefined;
  return heldDigest === undefined && incomingDigest !== undefined;
}

/**
 * A store that records what was published, so idempotence is observable.
 *
 * It mirrors the durable store's contract rather than approximating it: an id
 * already held is written again only to add provenance it lacked, and the
 * listing keeps the last record for an id. `tests/unit/result-references.test.ts`
 * pins those rules against the real store.
 */
function fakeStore(input: {
  tasks?: SessionTask[];
  messages?: ChatMessage[];
  published?: ResultReference[];
  /** Authoritative publication artifacts, keyed `taskId:attemptId`. */
  publication?: Record<
    string,
    readonly {
      role: "primary" | "secondary";
      childRunId: string;
      path: string;
      byteLength: number;
      sha256: string;
    }[]
  >;
}) {
  const published = [...(input.published ?? [])];
  const latest = () => {
    const byId = new Map<string, ResultReference>();
    for (const reference of published) byId.set(reference.id, reference);
    return [...byId.values()];
  };
  return {
    get published() {
      return latest();
    },
    resolveTaskPublication: async (
      _sessionId: string,
      taskId: string,
      executionAttemptId: string,
    ) => {
      const artifacts = (input.publication ?? {})[
        `${taskId}:${executionAttemptId}`
      ];
      return artifacts
        ? { status: "ready" as const, artifacts }
        : {
            status: "failed" as const,
            code: "verified_publication_missing" as const,
            detail: "no marker",
          };
    },
    listTaskRecords: async () => input.tasks ?? [],
    listChatMessages: async () => input.messages ?? [],
    listResultReferences: async () => latest(),
    publishResultReference: async (_id: string, reference: ResultReference) => {
      const held = latest().find((entry) => entry.id === reference.id);
      if (held && !upgradesProvenance(held, reference)) return false;
      published.push(reference);
      return true;
    },
  };
}

test("a completed run becomes an offerable result exactly once", async () => {
  const store = fakeStore({ tasks: [task({ id: "task-1", teamId: "board" })] });

  const first = await ensureResultReferences({
    sessionId: SESSION,
    sessionStore: store,
  });
  const second = await ensureResultReferences({
    sessionId: SESSION,
    sessionStore: store,
  });

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(store.published.length, 1, "the second pass published nothing");
});

test("nothing selected reads nothing at all", async () => {
  let reads = 0;
  const store = fakeStore({ tasks: [task({ id: "task-1" })] });

  const resolved = await resolveContinuationContext({
    sessionId: SESSION,
    selectedIds: [],
    sessionStore: store,
    runStore: {
      readArtifact: async () => {
        reads += 1;
        return null;
      },
      listRunEvents: async () => {
        reads += 1;
        return [];
      },
    },
  });

  assert.equal(resolved.context, undefined);
  assert.equal(reads, 0, "an unselected result must not be opened");
});

test("only the selected result is read, not every completed one", async () => {
  const store = fakeStore({
    tasks: [
      task({ id: "task-1", teamId: "board-one" }),
      task({ id: "task-2", teamId: "board-two" }),
      task({ id: "task-3", teamId: "board-three" }),
    ],
  });
  const references = await ensureResultReferences({
    sessionId: SESSION,
    sessionStore: store,
  });
  const chosen = references.find((entry) => entry.producer.id === "board-two");
  assert.ok(chosen);

  const opened: string[] = [];
  await resolveContinuationContext({
    sessionId: SESSION,
    selectedIds: [chosen.id],
    sessionStore: store,
    runStore: {
      readArtifact: async () => null,
      listRunEvents: async (runId: string) => {
        opened.push(runId);
        return [];
      },
    },
  });

  assert.deepEqual(opened, ["run-task-2"]);
});

test("a chat-only Team's accepted messages are its result", async () => {
  const store = fakeStore({
    tasks: [
      task({
        id: "task-1",
        teamId: "problem-thinking-board",
        workflowId: "chat-team-problem-thinking-board",
      }),
    ],
  });
  const [reference] = await ensureResultReferences({
    sessionId: SESSION,
    sessionStore: store,
  });
  assert.ok(reference);
  assert.equal(reference.source.kind, "run-summary");

  const resolved = await resolveContinuationContext({
    sessionId: SESSION,
    selectedIds: [reference.id],
    sessionStore: store,
    runStore: {
      readArtifact: async () => null,
      listRunEvents: async () => [
        {
          type: TEAM_CHAT_MESSAGE_EVENT_TYPE,
          run_id: "run-task-1",
          payload: { agent_name: "contrarian", text: "TEAM-CONCLUSION-ONE" },
        },
        {
          type: TEAM_CHAT_MESSAGE_EVENT_TYPE,
          run_id: "run-task-1",
          payload: { agent_name: "futurist", text: "TEAM-CONCLUSION-TWO" },
        },
      ] as never,
    },
  });

  assert.ok(resolved.context);
  assert.match(resolved.context, /contrarian: TEAM-CONCLUSION-ONE/);
  assert.match(resolved.context, /futurist: TEAM-CONCLUSION-TWO/);
});

test("a Team run with no accepted messages says so rather than reading as empty", async () => {
  const store = fakeStore({
    tasks: [task({ id: "task-1", teamId: "board" })],
  });
  const [reference] = await ensureResultReferences({
    sessionId: SESSION,
    sessionStore: store,
  });
  assert.ok(reference);

  const resolved = await resolveContinuationContext({
    sessionId: SESSION,
    selectedIds: [reference.id],
    sessionStore: store,
    runStore: { readArtifact: async () => null, listRunEvents: async () => [] },
  });

  assert.ok(resolved.context);
  assert.match(resolved.context, /recorded no accepted messages/);
});

const CEILING_TEXT = "THE-DELIVERED-TEXT";

test("an artifact is read under an explicit byte ceiling", async () => {
  const store = fakeStore({
    tasks: [task({ id: "task-1" })],
    messages: [
      {
        id: "delivery-1",
        role: "assistant",
        text: "Done.",
        createdAt: "2026-09-09T10:00:01.000Z",
        delivery: {
          taskId: "task-1",
          artifacts: [
            {
              runId: "run-task-1",
              path: "output/final.md",
              role: "final",
              digest: createHash("sha256")
                .update(CEILING_TEXT, "utf8")
                .digest("hex"),
            },
          ],
        },
      },
    ],
  });
  const references = await ensureResultReferences({
    sessionId: SESSION,
    sessionStore: store,
  });
  const chosen = references.find(
    (entry) => entry.source.kind === "artifact",
  );
  assert.ok(chosen);

  let seenLimit: number | undefined;
  const resolved = await resolveContinuationContext({
    sessionId: SESSION,
    selectedIds: [chosen.id],
    sessionStore: store,
    runStore: {
      readArtifact: async (
        _runId: string,
        _path: string,
        options?: { maxBytes?: number },
      ) => {
        seenLimit = options?.maxBytes;
        return { content: CEILING_TEXT, contentType: "text/markdown" };
      },
      listRunEvents: async () => [],
    },
  });

  assert.equal(seenLimit, MAX_RESULT_READ_BYTES);
  assert.match(resolved.context ?? "", /THE-DELIVERED-TEXT/);
});

test("an oversized or missing artifact says so instead of failing the turn", async () => {
  const store = fakeStore({
    tasks: [task({ id: "task-1" })],
    messages: [
      {
        id: "delivery-1",
        role: "assistant",
        text: "Done.",
        createdAt: "2026-09-09T10:00:01.000Z",
        delivery: {
          taskId: "task-1",
          artifacts: [
            {
              runId: "run-task-1",
              path: "output/final.md",
              role: "final",
              digest: "b".repeat(64),
            },
          ],
        },
      },
    ],
  });
  const references = await ensureResultReferences({
    sessionId: SESSION,
    sessionStore: store,
  });
  const chosen = references.find((entry) => entry.source.kind === "artifact");
  assert.ok(chosen);

  const resolved = await resolveContinuationContext({
    sessionId: SESSION,
    selectedIds: [chosen.id],
    sessionStore: store,
    runStore: { readArtifact: async () => null, listRunEvents: async () => [] },
  });

  assert.match(resolved.context ?? "", /missing or too large to inline/);
});

test("an id the session does not hold is reported, not silently dropped", async () => {
  const resolved = await resolveContinuationContext({
    sessionId: SESSION,
    selectedIds: ["result-from-another-session"],
    sessionStore: fakeStore({}),
  });

  assert.equal(resolved.context, undefined);
  assert.deepEqual(resolved.rejected, [
    { id: "result-from-another-session", reason: "unknown" },
  ]);
});

test("an aborted turn stops reading rather than finishing the block", async () => {
  const store = fakeStore({
    tasks: [task({ id: "task-1", teamId: "board" })],
  });
  const [reference] = await ensureResultReferences({
    sessionId: SESSION,
    sessionStore: store,
  });
  assert.ok(reference);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    resolveContinuationContext({
      sessionId: SESSION,
      selectedIds: [reference.id],
      sessionStore: store,
      runStore: {
        readArtifact: async () => null,
        listRunEvents: async () => {
          throw new Error("must not be reached");
        },
      },
      signal: controller.signal,
    }),
  );
});

/**
 * A reference is followed, and the state it points into can move. Trusting it
 * because it was true once supplies the responder whatever is at that path now
 * under the identity of the result the user chose.
 */
test("a result whose task was retried under a new attempt is refused", async () => {
  const store = fakeStore({
    tasks: [task({ id: "task-1", teamId: "board", executionAttemptId: "attempt-1" })],
  });
  const [reference] = await ensureResultReferences({
    sessionId: SESSION,
    sessionStore: store,
  });
  assert.ok(reference);

  const retried = fakeStore({
    tasks: [task({ id: "task-1", teamId: "board", executionAttemptId: "attempt-2" })],
    published: [reference],
  });
  const resolved = await resolveContinuationContext({
    sessionId: SESSION,
    selectedIds: [reference.id],
    sessionStore: retried,
    runStore: { readArtifact: async () => null, listRunEvents: async () => [] },
  });

  assert.equal(resolved.context, undefined);
  assert.deepEqual(resolved.rejected, [{ id: reference.id, reason: "changed" }]);
});

test("a result whose task is no longer terminal is refused", async () => {
  const store = fakeStore({ tasks: [task({ id: "task-1", teamId: "board" })] });
  const [reference] = await ensureResultReferences({
    sessionId: SESSION,
    sessionStore: store,
  });
  assert.ok(reference);

  const rerunning = fakeStore({
    tasks: [task({ id: "task-1", teamId: "board", status: "running" })],
    published: [reference],
  });
  const resolved = await resolveContinuationContext({
    sessionId: SESSION,
    selectedIds: [reference.id],
    sessionStore: rerunning,
    runStore: { readArtifact: async () => null, listRunEvents: async () => [] },
  });

  assert.deepEqual(resolved.rejected, [{ id: reference.id, reason: "changed" }]);
});

test("a result whose run now publishes a different artifact is refused", async () => {
  const content = "THE-PUBLISHED-TEXT";
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  const delivery = (path: string) => ({
    id: "delivery-1",
    role: "assistant" as const,
    text: "Done.",
    createdAt: "2026-09-09T10:00:01.000Z",
    delivery: {
      taskId: "task-1",
      executionAttemptId: "attempt-1",
      artifacts: [{ runId: "run-task-1", path, role: "final" as const }],
    },
  });
  const publication = (path: string) => ({
    "task-1:attempt-1": [
      {
        role: "primary" as const,
        childRunId: "run-task-1",
        path,
        byteLength: content.length,
        sha256: digest,
      },
    ],
  });
  const store = fakeStore({
    tasks: [task({ id: "task-1", executionAttemptId: "attempt-1" })],
    messages: [delivery("output/final-draft.md")],
    publication: publication("output/final-draft.md"),
  });
  const [reference] = await ensureResultReferences({
    sessionId: SESSION,
    sessionStore: store,
  });
  assert.ok(reference);

  const replaced = fakeStore({
    tasks: [task({ id: "task-1", executionAttemptId: "attempt-1" })],
    messages: [delivery("output/something-else.md")],
    publication: publication("output/something-else.md"),
    published: [reference],
  });
  const resolved = await resolveContinuationContext({
    sessionId: SESSION,
    selectedIds: [reference.id],
    sessionStore: replaced,
    runStore: {
      readArtifact: async () => ({
        content: "DIFFERENT-BYTES",
        contentType: "text/markdown",
      }),
      listRunEvents: async () => [],
    },
  });

  assert.equal(resolved.context, undefined);
  assert.deepEqual(resolved.rejected, [{ id: reference.id, reason: "changed" }]);
});

test("an unchanged result is still admitted", async () => {
  const store = fakeStore({ tasks: [task({ id: "task-1", teamId: "board" })] });
  const [reference] = await ensureResultReferences({
    sessionId: SESSION,
    sessionStore: store,
  });
  assert.ok(reference);

  const resolved = await resolveContinuationContext({
    sessionId: SESSION,
    selectedIds: [reference.id],
    sessionStore: store,
    runStore: {
      readArtifact: async () => null,
      listRunEvents: async () => [
        {
          type: TEAM_CHAT_MESSAGE_EVENT_TYPE,
          run_id: "run-task-1",
          payload: { agent_name: "contrarian", text: "STILL-VALID" },
        },
      ] as never,
    },
  });

  assert.deepEqual(resolved.rejected, []);
  assert.match(resolved.context ?? "", /STILL-VALID/);
});

/**
 * A record written before provenance was recorded cannot be checked at use
 * time. Treating a missing task id as proof of an Agent reply let every one of
 * them walk past the validation that was just added.
 */
test("a legacy Team record is repaired rather than trusted", async () => {
  const legacy: ResultReference = {
    schemaVersion: 1,
    id: "team:task-1",
    sessionId: SESSION,
    producer: { kind: "team", id: "board", label: "board" },
    status: "done",
    completedAt: "2026-09-09T10:00:00.000Z",
    source: { kind: "run-summary", runId: "run-task-1" },
  };
  const store = fakeStore({
    tasks: [task({ id: "task-1", teamId: "board" })],
    published: [legacy],
  });

  const references = await ensureResultReferences({
    sessionId: SESSION,
    sessionStore: store,
  });

  const repaired = references.find((entry) => entry.id === legacy.id);
  assert.ok(repaired, "the legacy id is still offered");
  assert.equal(repaired.producerTaskId, "task-1", "and it now names its run");
});

test("an unrepairable legacy record is refused rather than carried", async () => {
  const legacy: ResultReference = {
    schemaVersion: 1,
    id: "team:vanished",
    sessionId: SESSION,
    producer: { kind: "team", id: "board", label: "board" },
    status: "done",
    completedAt: "2026-09-09T10:00:00.000Z",
    source: { kind: "run-summary", runId: "run-vanished" },
  };
  // Its task is gone, so nothing can prove what it points at.
  const store = fakeStore({ tasks: [], published: [legacy] });

  const resolved = await resolveContinuationContext({
    sessionId: SESSION,
    selectedIds: [legacy.id],
    sessionStore: store,
    runStore: { readArtifact: async () => null, listRunEvents: async () => [] },
  });

  assert.equal(resolved.context, undefined);
  assert.deepEqual(resolved.rejected, [{ id: legacy.id, reason: "changed" }]);
});

/**
 * The bytes at a path are not proof of what was published there. Without a
 * digest comparison a rewritten artifact reaches the responder under the
 * identity of the result the user chose.
 */
test("an artifact whose bytes changed since publication is not carried", async () => {
  const store = fakeStore({
    tasks: [task({ id: "task-1" })],
    messages: [
      {
        id: "delivery-1",
        role: "assistant",
        text: "Done.",
        createdAt: "2026-09-09T10:00:01.000Z",
        delivery: {
          taskId: "task-1",
          artifacts: [
            {
              runId: "run-task-1",
              path: "output/final.md",
              role: "final",
              digest: "0".repeat(64),
            },
          ],
        },
      },
    ],
  });
  const references = await ensureResultReferences({
    sessionId: SESSION,
    sessionStore: store,
  });
  const chosen = references.find((entry) => entry.source.kind === "artifact");
  assert.ok(chosen);

  const resolved = await resolveContinuationContext({
    sessionId: SESSION,
    selectedIds: [chosen.id],
    sessionStore: store,
    runStore: {
      readArtifact: async () => ({
        content: "REWRITTEN-BYTES",
        contentType: "text/markdown",
      }),
      listRunEvents: async () => [],
    },
  });

  // A refusal, not a note in the block: the turn must not run as though it
  // carried the result while the composer still shows it attached.
  assert.equal(resolved.context, undefined);
  assert.deepEqual(resolved.rejected, [{ id: chosen.id, reason: "changed" }]);
});

/**
 * The attempt is what names the publication marker, so a result that records
 * one is a result whose digest may yet be recovered. It stays on offer and is
 * refused at use time; a result with no attempt at all is withheld instead.
 */
test("an artifact with no provable digest is refused rather than inlined", async () => {
  const store = fakeStore({
    tasks: [task({ id: "task-1", executionAttemptId: "attempt-1" })],
    messages: [
      {
        id: "delivery-1",
        role: "assistant",
        text: "Done.",
        createdAt: "2026-09-09T10:00:01.000Z",
        delivery: {
          taskId: "task-1",
          executionAttemptId: "attempt-1",
          artifacts: [
            { runId: "run-task-1", path: "output/final.md", role: "final" },
          ],
        },
      },
    ],
    // No publication marker, so nothing can establish what was published.
  });
  const references = await ensureResultReferences({
    sessionId: SESSION,
    sessionStore: store,
  });
  const chosen = references.find((entry) => entry.source.kind === "artifact");
  assert.ok(chosen);

  const resolved = await resolveContinuationContext({
    sessionId: SESSION,
    selectedIds: [chosen.id],
    sessionStore: store,
    runStore: {
      readArtifact: async () => ({
        content: "UNVERIFIED-BYTES",
        contentType: "text/markdown",
      }),
      listRunEvents: async () => [],
    },
  });

  assert.equal(resolved.context, undefined);
  assert.deepEqual(resolved.rejected, [
    { id: chosen.id, reason: "unverifiable" },
  ]);
});

/**
 * A card written before deliveries carried a digest is never rewritten, so the
 * card cannot be the source of one. The publication marker records each child
 * artifact's own SHA-256, and that is what a stored reference is repaired from.
 */
test("a digest missing from the card is recovered from the publication", async () => {
  const content = "THE-PUBLISHED-TEXT";
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  const store = fakeStore({
    tasks: [task({ id: "task-1", executionAttemptId: "attempt-1" })],
    messages: [
      {
        id: "delivery-1",
        role: "assistant",
        text: "Done.",
        createdAt: "2026-09-09T10:00:01.000Z",
        delivery: {
          taskId: "task-1",
          executionAttemptId: "attempt-1",
          artifacts: [
            { runId: "run-task-1", path: "output/final.md", role: "final" },
          ],
        },
      },
    ],
    publication: {
      "task-1:attempt-1": [
        {
          role: "primary",
          childRunId: "run-task-1",
          path: "output/final.md",
          byteLength: content.length,
          sha256: digest,
        },
      ],
    },
  });

  const references = await ensureResultReferences({
    sessionId: SESSION,
    sessionStore: store,
  });
  const chosen = references.find((entry) => entry.source.kind === "artifact");
  assert.ok(chosen);
  assert.equal(
    chosen.source.kind === "artifact" ? chosen.source.digest : undefined,
    digest,
  );

  const resolved = await resolveContinuationContext({
    sessionId: SESSION,
    selectedIds: [chosen.id],
    sessionStore: store,
    runStore: {
      readArtifact: async () => ({ content, contentType: "text/markdown" }),
      listRunEvents: async () => [],
    },
  });

  assert.deepEqual(resolved.rejected, []);
  assert.match(resolved.context ?? "", /THE-PUBLISHED-TEXT/);
});

test("a stored reference with a task id but no digest is still repaired", async () => {
  const content = "THE-PUBLISHED-TEXT";
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  const stale: ResultReference = {
    schemaVersion: 1,
    id: "workflow:task-1:attempt-1",
    sessionId: SESSION,
    producer: { kind: "workflow", id: "wf", label: "wf" },
    status: "done",
    completedAt: "2026-09-09T10:00:00.000Z",
    producerTaskId: "task-1",
    executionAttemptId: "attempt-1",
    source: { kind: "artifact", runId: "run-task-1", path: "output/final.md" },
  };
  const store = fakeStore({
    tasks: [task({ id: "task-1", executionAttemptId: "attempt-1" })],
    messages: [
      {
        id: "delivery-1",
        role: "assistant",
        text: "Done.",
        createdAt: "2026-09-09T10:00:01.000Z",
        delivery: {
          taskId: "task-1",
          executionAttemptId: "attempt-1",
          artifacts: [
            { runId: "run-task-1", path: "output/final.md", role: "final" },
          ],
        },
      },
    ],
    published: [stale],
    publication: {
      "task-1:attempt-1": [
        {
          role: "primary",
          childRunId: "run-task-1",
          path: "output/final.md",
          byteLength: content.length,
          sha256: digest,
        },
      ],
    },
  });

  const references = await ensureResultReferences({
    sessionId: SESSION,
    sessionStore: store,
  });
  const repaired = references.find((entry) => entry.id === stale.id);

  assert.ok(repaired);
  assert.equal(
    repaired.source.kind === "artifact" ? repaired.source.digest : undefined,
    digest,
    "a held record with a task id but no digest is repaired too",
  );
});

test("an artifact matching its published digest is carried", async () => {
  const content = "THE-PUBLISHED-TEXT";
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  const store = fakeStore({
    tasks: [task({ id: "task-1" })],
    messages: [
      {
        id: "delivery-1",
        role: "assistant",
        text: "Done.",
        createdAt: "2026-09-09T10:00:01.000Z",
        delivery: {
          taskId: "task-1",
          artifacts: [
            { runId: "run-task-1", path: "output/final.md", role: "final", digest },
          ],
        },
      },
    ],
  });
  const references = await ensureResultReferences({
    sessionId: SESSION,
    sessionStore: store,
  });
  const chosen = references.find((entry) => entry.source.kind === "artifact");
  assert.ok(chosen);

  const resolved = await resolveContinuationContext({
    sessionId: SESSION,
    selectedIds: [chosen.id],
    sessionStore: store,
    runStore: {
      readArtifact: async () => ({ content, contentType: "text/markdown" }),
      listRunEvents: async () => [],
    },
  });

  assert.deepEqual(resolved.rejected, []);
  assert.match(resolved.context ?? "", /THE-PUBLISHED-TEXT/);
});

/**
 * Two callers project the same records from the same empty list. Returning
 * only the records this caller managed to write made the loser answer with
 * nothing, and the later response hid results the earlier one had offered.
 */
test("overlapping discovery both return the full persisted list", async () => {
  const store = fakeStore({ tasks: [task({ id: "task-1", teamId: "board" })] });

  const [first, second] = await Promise.all([
    ensureResultReferences({ sessionId: SESSION, sessionStore: store }),
    ensureResultReferences({ sessionId: SESSION, sessionStore: store }),
  ]);

  assert.equal(first.length, 1, "the winner reports the result");
  assert.equal(second.length, 1, "and so does the caller that lost the write");
  assert.equal(store.published.length, 1);
});

/**
 * A result whose digest can never be established is a dead entry in the
 * picker: the user can attach it, and the turn refuses it, for ever.
 *
 * The digest comes from the publication marker, and the marker is named by the
 * execution attempt. A completed task that never recorded one has no marker to
 * recover a digest from, and no later call changes that.
 */
test("a result that can never be verified is not offered", async () => {
  const store = fakeStore({
    tasks: [task({ id: "task-1" })],
    messages: [
      {
        id: "delivery-1",
        role: "assistant",
        text: "Done.",
        createdAt: "2026-09-09T10:00:01.000Z",
        delivery: {
          taskId: "task-1",
          artifacts: [
            { runId: "run-task-1", path: "output/final.md", role: "final" },
          ],
        },
      },
    ],
  });

  const first = await ensureResultReferences({
    sessionId: SESSION,
    sessionStore: store,
  });
  const second = await ensureResultReferences({
    sessionId: SESSION,
    sessionStore: store,
  });

  assert.deepEqual(first, [], "an unreadable result must not fill the picker");
  assert.deepEqual(second, []);
  assert.equal(
    store.published.length,
    0,
    "and must not be rewritten on every listing",
  );
});

test("a record an older build already stored the same way stops being offered", async () => {
  const stranded: ResultReference = {
    schemaVersion: 1,
    id: "team:task-1",
    sessionId: SESSION,
    producer: { kind: "team", id: "board", label: "board" },
    status: "done",
    completedAt: "2026-09-09T10:00:00.000Z",
    producerTaskId: "task-1",
    source: { kind: "artifact", runId: "run-task-1", path: "output/final.md" },
  };
  const store = fakeStore({ tasks: [], published: [stranded] });

  const references = await ensureResultReferences({
    sessionId: SESSION,
    sessionStore: store,
  });

  assert.deepEqual(references, []);
});

test("a failed re-read still answers with what this call published", async () => {
  const inner = fakeStore({ tasks: [task({ id: "task-1", teamId: "board" })] });
  let didPublish = false;
  const store = {
    ...inner,
    publishResultReference: async (id: string, reference: ResultReference) => {
      didPublish = true;
      return inner.publishResultReference(id, reference);
    },
    listResultReferences: async (_id: string) => {
      // The re-read after publishing is the one that fails.
      if (didPublish) throw new Error("listing unavailable");
      return inner.listResultReferences();
    },
  };

  const references = await ensureResultReferences({
    sessionId: SESSION,
    sessionStore: store,
  });

  assert.equal(references.length, 1, "the record this call wrote is still its answer");
  assert.equal(references[0]?.producer.id, "board");
});
