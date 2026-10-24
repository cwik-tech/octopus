import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResourceArchitectConversationStore } from "../../server/resource-architect-conversation-store.js";
import { parseResourceArchitectTurnBody } from "../../services/resource-architect-service.js";

const startedAt = "2026-09-20T16:00:00.000Z";
const finishedAt = "2026-09-20T16:01:00.000Z";
const request = {
  draftId: "furniture-draft", jobId: "first-turn", operation: "conversation" as const,
  history: [{ role: "user" as const, text: "Design a furniture team." }],
  planId: null, selectedResource: null, documentReader: null, updatedAt: startedAt,
};

async function fixture(run: (directory: string, store: ResourceArchitectConversationStore) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "create-conversation-"));
  try { await run(directory, new ResourceArchitectConversationStore(directory)); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

/** Admits a turn and checks that start() handed back exactly what it saved. */
async function admit(
  directory: string,
  store: ResourceArchitectConversationStore,
  input: Parameters<ResourceArchitectConversationStore["start"]>[0],
) {
  const admitted = await store.start(input);
  assert.deepEqual(admitted, await new ResourceArchitectConversationStore(directory).read());
}

test("an unfinished Create conversation survives a new store and keeps its complete history", async () => {
  await fixture(async (directory, store) => {
    await admit(directory, store, request);
    await store.settle({ draftId: request.draftId, jobId: request.jobId, status: "completed",
      assistant: { role: "assistant", text: "Which materials?" }, updatedAt: finishedAt });
    const restarted = new ResourceArchitectConversationStore(directory);
    assert.deepEqual((await restarted.read())?.history.map(({ role, text }) => ({ role, text })), [
      { role: "user", text: "Design a furniture team." },
      { role: "assistant", text: "Which materials?" },
    ]);
    // The model receives bounded context. That must not truncate the saved transcript.
    await admit(directory, restarted, { ...request, jobId: "next-turn", history: [{ role: "user", text: "Solid wood." }] });
    assert.deepEqual((await new ResourceArchitectConversationStore(directory).read())?.history.map(({ role, text }) => ({ role, text })), [
      { role: "user", text: "Design a furniture team." },
      { role: "assistant", text: "Which materials?" },
      { role: "user", text: "Solid wood." },
    ]);
  });
});

test("New clears the draft durably and a late reply cannot restore it", async () => {
  await fixture(async (directory, store) => {
    await admit(directory, store, request);
    await store.clear(request.draftId);
    await store.settle({ draftId: request.draftId, jobId: request.jobId, status: "completed",
      assistant: { role: "assistant", text: "Late answer." }, updatedAt: finishedAt });
    assert.equal(await new ResourceArchitectConversationStore(directory).read(), null);
  });
});

test("an old reply or completed build cannot overwrite a newer draft", async () => {
  await fixture(async (directory, store) => {
    await admit(directory, store, request);
    await admit(directory, store, { ...request, draftId: "new-draft", jobId: "new-turn", history: [{ role: "user", text: "Different team." }] });
    await store.clear(request.draftId);
    await store.settle({ draftId: request.draftId, jobId: request.jobId, status: "completed",
      assistant: { role: "assistant", text: "Obsolete answer." }, updatedAt: finishedAt });
    assert.deepEqual((await new ResourceArchitectConversationStore(directory).read())?.history.map(({ role, text }) => ({ role, text })),
      [{ role: "user", text: "Different team." }]);
  });
});

test("a proposal retains its conversation and durable plan identity", async () => {
  await fixture(async (directory, store) => {
    await admit(directory, store, request);
    await store.settle({ draftId: request.draftId, jobId: request.jobId, status: "completed",
      assistant: { role: "assistant", text: "Preparing the proposal." }, updatedAt: finishedAt });
    await admit(directory, store, { ...request, jobId: "proposal-turn", operation: "proposal" });
    await store.settle({ draftId: request.draftId, jobId: "proposal-turn", status: "completed",
      assistant: { role: "assistant", text: "Team ready to build." }, planId: "furniture-plan", updatedAt: finishedAt });
    const restored = await new ResourceArchitectConversationStore(directory).read();
    assert.equal(restored?.planId, "furniture-plan");
    assert.equal(restored?.history.length, 3);
  });
});

test("a turn after its build ended lets go of that build in the same save as the new message", async () => {
  await fixture(async (directory, store) => {
    await admit(directory, store, request);
    await store.settle({ draftId: request.draftId, jobId: request.jobId, status: "completed",
      assistant: { role: "assistant", text: "Team ready to build." }, planId: "furniture-plan", updatedAt: finishedAt });
    await store.attachBuild(request.draftId, "furniture-plan", "failed-build");

    await admit(directory, store, { ...request, jobId: "follow-up", planId: "furniture-plan",
      history: [...request.history, { role: "user", text: "Why did it fail?" }], releaseEndedBuildJobId: "failed-build" });

    const saved = await new ResourceArchitectConversationStore(directory).read();
    assert.equal(saved?.buildJobId, null);
    assert.equal(saved?.history.at(-1)?.text, "Why did it fail?");
  });
});

test("a turn keeps a build other than the one it was asked to let go of", async () => {
  await fixture(async (directory, store) => {
    await admit(directory, store, request);
    await store.settle({ draftId: request.draftId, jobId: request.jobId, status: "completed",
      assistant: { role: "assistant", text: "Team ready to build." }, planId: "furniture-plan", updatedAt: finishedAt });
    await store.attachBuild(request.draftId, "furniture-plan", "retried-build");

    await admit(directory, store, { ...request, jobId: "follow-up", planId: "furniture-plan",
      history: [...request.history, { role: "user", text: "Is it done yet?" }], releaseEndedBuildJobId: "failed-build" });

    assert.equal((await new ResourceArchitectConversationStore(directory).read())?.buildJobId, "retried-build");
  });
});

test("a malformed saved conversation is reported without silently replacing it", async () => {
  await fixture(async (directory, store) => {
    await admit(directory, store, request);
    const file = join(directory, "resource-architect-conversation", "active.json");
    await writeFile(file, '{"schemaVersion":1,"history":"broken"}');
    await assert.rejects(new ResourceArchitectConversationStore(directory).read(), /saved Create conversation/);
    assert.equal(await readFile(file, "utf8"), '{"schemaVersion":1,"history":"broken"}');
  });
});

test("restored messages keep the chronology used by the chat timeline", async () => {
  await fixture(async (directory, store) => {
    await admit(directory, store, request);
    await store.settle({ draftId: request.draftId, jobId: request.jobId, status: "completed",
      assistant: { role: "assistant", text: "Which materials?" }, updatedAt: finishedAt });
    await admit(directory, store, { ...request, jobId: "next-turn", updatedAt: "2026-09-20T16:02:00.000Z",
      history: [{ role: "user", text: "Solid wood." }] });
    assert.deepEqual((await new ResourceArchitectConversationStore(directory).read())?.history.map((turn) => turn.createdAt),
      ["2026-09-20T16:00:00.000Z", "2026-09-20T16:01:00.000Z", "2026-09-20T16:02:00.000Z"]);
  });
});

test("turn admission returns the exact saved conversation, with server turn times rather than client ones", async () => {
  await fixture(async (directory, store) => {
    // The public request boundary rebuilds each turn from role and text only.
    const forged = parseResourceArchitectTurnBody({
      jobId: request.jobId, draftId: request.draftId, operation: "conversation", currentPlan: null,
      history: [{ role: "user", text: "Design a furniture team.", createdAt: "2020-01-01T00:00:00.000Z" }],
    });
    const admitted = await store.start({ ...request, history: forged.history });
    assert.deepEqual(admitted, await new ResourceArchitectConversationStore(directory).read());
    assert.deepEqual(admitted.history.map((turn) => turn.createdAt), [startedAt]);

    await store.settle({ draftId: request.draftId, jobId: request.jobId, status: "completed",
      assistant: { role: "assistant", text: "Which materials?" }, updatedAt: finishedAt });
    const nextTurnAt = "2026-09-20T16:02:00.000Z";
    const next = await store.start({ ...request, jobId: "next-turn", updatedAt: nextTurnAt,
      history: [{ role: "user", text: "Solid wood." }] });
    assert.deepEqual(next, await new ResourceArchitectConversationStore(directory).read());
    assert.deepEqual(next.history.map(({ role, text, createdAt }) => ({ role, text, createdAt })), [
      { role: "user", text: "Design a furniture team.", createdAt: startedAt },
      { role: "assistant", text: "Which materials?", createdAt: finishedAt },
      { role: "user", text: "Solid wood.", createdAt: nextTurnAt },
    ]);
  });
});
