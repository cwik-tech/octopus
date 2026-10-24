import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResourceArchitectStore } from "../../server/resource-architect-store.js";
import { CreateJobRegistry } from "../../server/create-job-registry.js";
import { handleResourceArchitectRoutes } from "../../server/routes/resource-architect.js";
import { resourceArchitectConversationSchema } from "../../contracts/schemas/resource-architect-conversation.js";
import type { ResourceBuildJobSnapshot } from "../../contracts/resource-architect.js";

async function readConversation(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200);
  const value: unknown = await response.json();
  return resourceArchitectConversationSchema.nullable().parse(value);
}

/** Admits a turn and checks that start() handed back exactly what it saved. */
async function admit(store: ResourceArchitectStore, input: Parameters<ResourceArchitectStore["conversation"]["start"]>[0]) {
  const admitted = await store.conversation.start(input);
  assert.deepEqual(admitted, await store.conversation.read());
}

async function fixture(run: (input: { url: string; store: ResourceArchitectStore; registry: CreateJobRegistry; directory: string }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "create-conversation-route-"));
  const store = new ResourceArchitectStore(directory);
  const registry = new CreateJobRegistry();
  const server = createServer((req, res) => {
    // The HTTP server owns completion and reports unexpected route failures.
    void handleResourceArchitectRoutes({ req, res, url: new URL(req.url ?? "/", "http://localhost"),
      options: { resourceArchitectStore: store, createJobRegistry: registry, isAbortLike: () => false },
    }).then((handled) => { if (!handled) res.writeHead(404).end(); })
      .catch(() => res.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try { await run({ store, registry, directory, url: `http://127.0.0.1:${address.port}/create/resource-architect/conversation` }); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

test("Create reports whether a saved turn is still running or was interrupted by shutdown", async () => {
  await fixture(async ({ store, registry, url }) => {
    await admit(store, { draftId: "draft", jobId: "turn", operation: "conversation",
      history: [{ role: "user", text: "Furniture team" }], planId: null,
      documentReader: null, selectedResource: null, updatedAt: "2026-09-20T16:00:00.000Z" });
    registry.start("turn");
    assert.deepEqual((await readConversation(url))?.turn, { jobId: "turn", operation: "conversation", status: "running" });
    registry.finish("turn");
    assert.deepEqual((await readConversation(url))?.turn, { jobId: "turn", operation: "conversation", status: "interrupted" });
  });
});

test("an older completed build does not hide a new conversation and New clears it", async () => {
  await fixture(async ({ store, url }) => {
    await store.saveJob({ jobId: "old-build", planId: "old-plan", status: "completed", items: [], selectedResource: null, events: [] });
    await admit(store, { draftId: "new-draft", jobId: "turn", operation: "conversation",
      history: [{ role: "user", text: "Furniture team" }], planId: null,
      documentReader: null, selectedResource: null, updatedAt: "2026-09-20T16:00:00.000Z" });
    assert.equal((await readConversation(url))?.draftId, "new-draft");
    assert.equal((await fetch(url, { method: "DELETE", signal: AbortSignal.timeout(2000) })).status, 200);
    assert.equal(await readConversation(url), null);
  });
});

test("only the draft's own completed build retires its conversation", async () => {
  await fixture(async ({ store, url }) => {
    await admit(store, { draftId: "draft", jobId: "turn", operation: "proposal",
      history: [{ role: "user", text: "Furniture team" }], planId: "plan",
      documentReader: null, selectedResource: null, updatedAt: "2026-09-20T16:00:00.000Z" });
    await store.saveJob({ jobId: "build", planId: "plan", status: "completed", items: [], selectedResource: null, events: [] });
    await store.conversation.attachBuild("draft", "plan", "build");
    assert.equal(await readConversation(url), null);
    assert.equal(await store.conversation.read(), null);
  });
});

test("discussing an already built plan keeps the new conversation unfinished", async () => {
  await fixture(async ({ store, url }) => {
    await store.saveJob({ jobId: "old-build", planId: "plan", status: "completed", items: [], selectedResource: null, events: [] });
    await admit(store, { draftId: "new-draft", jobId: "new-turn", operation: "conversation",
      history: [{ role: "user", text: "Add a furniture specialist to this team." }], planId: "plan",
      documentReader: null, selectedResource: null, updatedAt: "2026-09-20T17:00:00.000Z" });
    assert.equal((await readConversation(url))?.draftId, "new-draft");
  });
});

/** A saved draft whose own build is the job described. */
async function conversationOwningBuild(
  store: ResourceArchitectStore,
  build: Pick<ResourceBuildJobSnapshot, "status" | "discarded">,
) {
  await store.conversation.start({ draftId: "draft", jobId: "turn", operation: "proposal",
    history: [{ role: "user", text: "Furniture team" }], planId: "plan",
    documentReader: null, selectedResource: null, updatedAt: "2026-09-20T16:00:00.000Z" });
  await store.saveJob({ jobId: "build", planId: "plan", items: [], selectedResource: null, events: [], ...build });
  await store.conversation.attachBuild("draft", "plan", "build");
}

test("a conversation whose build is still unfinished stays readable", async () => {
  for (const status of ["running", "interrupted", "partially_completed"] as const) {
    await fixture(async ({ store, url }) => {
      await conversationOwningBuild(store, { status });
      assert.equal((await readConversation(url))?.draftId, "draft", status);
    });
  }
});

test("a conversation whose build ended or was discarded is cleared while the receipt stays on disk", async () => {
  const endedBuilds: Array<Pick<ResourceBuildJobSnapshot, "status" | "discarded">> = [
    { status: "failed" },
    { status: "cancelled" },
    { status: "completed" },
    { status: "running", discarded: true },
    { status: "interrupted", discarded: true },
    { status: "partially_completed", discarded: true },
  ];
  for (const build of endedBuilds) {
    await fixture(async ({ store, url, directory }) => {
      await conversationOwningBuild(store, build);
      assert.equal(await readConversation(url), null, JSON.stringify(build));
      assert.equal(await store.conversation.read(), null, JSON.stringify(build));
      // Hidden from Create, not deleted: a fresh reader still finds the receipt.
      assert.equal((await new ResourceArchitectStore(directory).getJob("build"))?.status, build.status);
    });
  }
});

/** Sends one more user message in the saved draft through the real turn route. */
async function sendFollowUp(url: string, text: string) {
  // Whatever becomes of the reply, the message is now part of the conversation.
  await fetch(url.replace(/\/conversation$/, "/turn"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      draftId: "draft", jobId: "follow-up-turn", operation: "conversation", currentPlan: null,
      history: [{ role: "user", text: "Furniture team" }, { role: "user", text }],
    }),
    signal: AbortSignal.timeout(5000),
  });
}

test("a message sent after the build failed keeps the conversation, which no longer owns that build", async () => {
  await fixture(async ({ store, url, directory }) => {
    await conversationOwningBuild(store, { status: "failed" });

    await sendFollowUp(url, "Why did the build fail?");

    // A reload or restart reads it back, question included.
    const conversation = await readConversation(url);
    assert.equal(conversation?.draftId, "draft");
    assert.deepEqual(conversation?.history.map((turn) => turn.text), ["Furniture team", "Why did the build fail?"]);
    assert.equal(conversation?.buildJobId, null);
    // Letting go of the failed build is not deleting it.
    assert.equal((await new ResourceArchitectStore(directory).getJob("build"))?.status, "failed");
  });
});

test("a message sent beside an unfinished build keeps that build with the conversation", async () => {
  await fixture(async ({ store, url }) => {
    await conversationOwningBuild(store, { status: "interrupted" });

    await sendFollowUp(url, "Is it safe to retry?");

    // Still the user's unfinished work, so a reload brings its card back.
    const conversation = await readConversation(url);
    assert.equal(conversation?.buildJobId, "build");
    assert.equal(conversation?.history.at(-1)?.text, "Is it safe to retry?");
  });
});
