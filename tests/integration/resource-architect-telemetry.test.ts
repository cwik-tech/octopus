import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { ResourceArchitectTurnMetric } from "../../contracts/resource-architect.js";
import { FileSystemRunStore } from "../../domains/run/run-store.js";
import { startApiServer } from "../../server/api-server.js";

/**
 * Waits for a startup barrier, but fails fast if the operation it is meant to
 * synchronize with finishes or rejects first. Without this an unreachable
 * barrier hangs the whole suite instead of reporting what went wrong.
 */
async function raceStartupBarrier(
  barrier: Promise<void>,
  operation: Promise<unknown>,
): Promise<void> {
  const reached = await Promise.race([
    barrier.then(() => "barrier" as const),
    operation.then(
      () => "operation" as const,
      () => "operation" as const,
    ),
  ]);
  if (reached === "barrier") return;
  const settled = await operation.then(
    (value) => `resolved with ${JSON.stringify(value)}`,
    (error: unknown) => `rejected with ${error instanceof Error ? error.message : String(error)}`,
  );
  assert.fail(`the operation finished before reaching the provider: ${settled}`);
}

test("a cancelled conversation is durably recorded without prompt or document content", async () => {
  const fixture = await startTelemetryFixture({ holdProviderResponse: true });
  try {
    const jobId = "cancelled-telemetry-turn";
    const turnPromise = postTurn(fixture.apiUrl, {
      jobId,
      operation: "conversation",
      history: [{ role: "user", text: "PRIVATE_PROMPT_MUST_NOT_BE_RECORDED" }],
      currentPlan: null,
      provider: "openai",
      model: "local-test-model",
    });
    // Cancelling is only meaningful once a provider request is in flight. If
    // the turn instead settles first, say why rather than waiting forever.
    await raceStartupBarrier(fixture.providerRequestStarted, turnPromise);

    const cancelResponse = await fetch(
      `${fixture.apiUrl}/create/jobs/${jobId}/cancel`,
      { method: "POST" },
    );
    assert.equal(cancelResponse.status, 200);
    const turnResponse = await turnPromise;
    assert.equal(turnResponse.cancelled, true);

    const metrics = await readMetrics(fixture.apiUrl);
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0]?.jobId, jobId);
    assert.equal(metrics[0]?.status, "cancelled");
    assert.equal(metrics[0]?.operation, "conversation");
    assert.equal(metrics[0]?.provider, "openai");
    assert.equal(metrics[0]?.model, "local-test-model");
    assert.equal(metrics[0]?.reasoning, "low");
    assert.ok((metrics[0]?.timing.totalDurationMs ?? 0) > 0);
    const persisted = fs.readFileSync(
      path.join(
        fixture.workspacePath,
        "resource-architect-telemetry",
        "turns.json",
      ),
      "utf8",
    );
    assert.equal(persisted.includes("PRIVATE_PROMPT_MUST_NOT_BE_RECORDED"), false);
  } finally {
    await fixture.close();
  }
});

test("half an ad hoc pair is refused before anything is dispatched", async () => {
  // The refusal has to happen at the boundary. A turn that reaches the provider
  // and only then discovers it cannot describe what it ran has already run it.
  const fixture = await startTelemetryFixture({ providerText: "Hello." });
  try {
    const response = await fetch(`${fixture.apiUrl}/create/resource-architect/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobId: "partial-pair-turn",
        operation: "conversation",
        history: [{ role: "user", text: "What can you build?" }],
        currentPlan: null,
        model: "some-other-model",
      }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(fixture.providerRequests, []);
  } finally {
    await fixture.close();
  }
});

test("a turn records how its model was decided before the provider answers", async () => {
  // The disclosure has to exist while the default is in use, not once the turn
  // is over. A gated or slow provider showed nothing at all, and a crash before
  // the reply left no record anywhere — so the one moment a person most needs
  // to know which model is running was the one moment nothing could say.
  const fixture = await startTelemetryFixture({ holdProviderResponse: true });
  try {
    const jobId = "pending-disclosure-turn";
    const turnPromise = postTurn(fixture.apiUrl, {
      jobId,
      operation: "conversation",
      history: [{ role: "user", text: "What can you build?" }],
      currentPlan: null,
    });
    await raceStartupBarrier(fixture.providerRequestStarted, turnPromise);

    // Read while the provider is still held, and from disk rather than from
    // the endpoint, which answers out of this process's own cache.
    const pending = readStoredMetrics(fixture.workspacePath).find(
      (metric) => metric.jobId === jobId,
    );
    assert.ok(pending, "the pending turn recorded its model choice");
    assert.equal(pending.status, "running");
    assert.deepEqual(pending.selection, {
      provider: "openai",
      model: "local-test-model",
      source: "agent",
      reason: "explicit-agent-choice",
      caller: "authoring",
    });

    await fetch(`${fixture.apiUrl}/create/jobs/${jobId}/cancel`, { method: "POST" });
    await turnPromise;
  } finally {
    await fixture.close();
  }
});

test("a refused duplicate does not erase the running turn's disclosure", async () => {
  // A second POST for a job already running is refused, and refusing it is
  // right. Recording that refusal under the running job's own id is not: the
  // original turn is still working, and its record is the only thing that can
  // say which model it is working with.
  const fixture = await startTelemetryFixture({ holdProviderResponse: true });
  try {
    const jobId = "duplicate-post-turn";
    const turnPromise = postTurn(fixture.apiUrl, {
      jobId,
      operation: "conversation",
      history: [{ role: "user", text: "What can you build?" }],
      currentPlan: null,
    });
    await raceStartupBarrier(fixture.providerRequestStarted, turnPromise);

    const duplicate = await fetch(`${fixture.apiUrl}/create/resource-architect/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobId,
        operation: "conversation",
        history: [{ role: "user", text: "What can you build?" }],
        currentPlan: null,
      }),
    });
    assert.equal(duplicate.status, 409);

    // A refused request never owned a model invocation, so it owns no turn
    // record either — under this job's id or under any id derived from it. A
    // synthesized id would land in the same namespace real jobs use, and a job
    // genuinely named that would then have its own disclosure overwritten.
    const afterDuplicate = readStoredMetrics(fixture.workspacePath);
    assert.deepEqual(
      afterDuplicate
        .map((metric) => metric.jobId)
        .filter((id) => id.startsWith(jobId)),
      [jobId],
      "the refusal wrote no turn record of its own",
    );
    const stored = afterDuplicate.filter((metric) => metric.jobId === jobId);
    assert.equal(stored.length, 1, "the running turn still owns its one record");
    assert.equal(stored[0]?.status, "running");
    assert.ok(stored[0]?.selection, "and it still says how its model was chosen");

    await fetch(`${fixture.apiUrl}/create/jobs/${jobId}/cancel`, { method: "POST" });
    await turnPromise;

    // Cancelling has no result to report, but the turn had already said what
    // it was running on, and an outcome does not erase that.
    const settled = readStoredMetrics(fixture.workspacePath).filter(
      (metric) => metric.jobId === jobId,
    );
    assert.equal(settled.length, 1);
    assert.equal(settled[0]?.status, "cancelled");
    assert.deepEqual(settled[0]?.selection, {
      provider: "openai",
      model: "local-test-model",
      source: "agent",
      reason: "explicit-agent-choice",
      caller: "authoring",
    });
  } finally {
    await fixture.close();
  }
});

test("the durable turn record says how the model was decided, not only which one", async () => {
  // provider/model alone cannot answer "did this run on the default?". The
  // authoring turn is the owning operation for a helper, so its own durable
  // record has to carry the provenance; otherwise the only place that can
  // answer is Settings as they stand when someone later looks.
  const fixture = await startTelemetryFixture({ providerText: "Hello." });
  try {
    const turnResponse = await postTurn(fixture.apiUrl, {
      jobId: "provenance-telemetry-turn",
      operation: "conversation",
      history: [{ role: "user", text: "What can you build?" }],
      currentPlan: null,
    });
    assert.equal(turnResponse.cancelled, undefined);

    const metrics = await readMetrics(fixture.apiUrl);
    assert.equal(metrics.length, 1);
    assert.deepEqual(metrics[0]?.selection, {
      provider: "openai",
      model: "local-test-model",
      source: "agent",
      reason: "explicit-agent-choice",
      caller: "authoring",
    });
  } finally {
    await fixture.close();
  }
});

test("a rejected proposal outcome is durably recorded as a sanitized failure", async () => {
  const fixture = await startTelemetryFixture({
    providerText: JSON.stringify({
      message: "Invalid proposal",
      warnings: [],
      outcome: {
        kind: "standalone_agents",
        agents: [
          {
            name: "duplicate-reviewer",
            role: "Reviewer",
            tier: "specialist",
            summary: "The first duplicate reviewer.",
            description: "First duplicate.",
            rationale: "Exercise materialization validation.",
          },
          {
            name: "duplicate-reviewer",
            role: "Reviewer",
            tier: "specialist",
            summary: "The second duplicate reviewer.",
            description: "Second duplicate.",
            rationale: "Exercise materialization validation.",
          },
        ],
      },
    }),
  });
  try {
    const response = await fetch(
      `${fixture.apiUrl}/create/resource-architect/turn`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jobId: "failed-telemetry-turn",
          operation: "proposal",
          history: [{ role: "user", text: "PRIVATE_FAILURE_PROMPT" }],
          currentPlan: null,
          provider: "openai",
          model: "local-test-model",
        }),
      },
    );
    assert.equal(response.status, 400);

    const metrics = await readMetrics(fixture.apiUrl);
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0]?.status, "failed");
    assert.equal(metrics[0]?.operation, "proposal");
    assert.equal(metrics[0]?.outcomeKind, "standalone_agents");
    assert.equal(metrics[0]?.errorCode, "bad_request");
    assert.equal(JSON.stringify(metrics).includes("PRIVATE_FAILURE_PROMPT"), false);
  } finally {
    await fixture.close();
  }
});

async function postTurn(apiUrl: string, body: object): Promise<Record<string, unknown>> {
  const response = await fetch(`${apiUrl}/create/resource-architect/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return await response.json() as Record<string, unknown>;
}

/** What actually survives a restart, read from the file rather than a cache. */
function readStoredMetrics(workspacePath: string): ResourceArchitectTurnMetric[] {
  const file = path.join(
    workspacePath,
    "resource-architect-telemetry",
    "turns.json",
  );
  if (!fs.existsSync(file)) return [];
  return (
    JSON.parse(fs.readFileSync(file, "utf8")) as {
      metrics: ResourceArchitectTurnMetric[];
    }
  ).metrics;
}

async function readMetrics(apiUrl: string): Promise<ResourceArchitectTurnMetric[]> {
  const response = await fetch(`${apiUrl}/create/resource-architect/metrics`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { metrics: ResourceArchitectTurnMetric[] }).metrics;
}

async function startTelemetryFixture(options: {
  holdProviderResponse?: boolean;
  providerText?: string;
}) {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "resource-telemetry-workspace-"));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resource-telemetry-repo-"));
  writeArchitectConfig(repoRoot);
  let markProviderRequestStarted!: () => void;
  const providerRequestStarted = new Promise<void>((resolve) => {
    markProviderRequestStarted = resolve;
  });
  const providerRequests: string[] = [];
  const provider = http.createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume the real request body.
    }
    providerRequests.push(request.url ?? "");
    markProviderRequestStarted();
    if (options.holdProviderResponse) return;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      model: "local-test-model",
      choices: [{ message: { content: options.providerText ?? "Hello." } }],
    }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Provider did not listen");
  const previousKey = process.env.OPENAI_API_KEY;
  const previousUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
  process.env.OPENAI_API_KEY = "local-test-key";
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  const api = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 1, cwd: workspacePath };
      },
    },
    workspacePath,
    repoRootPath: repoRoot,
  });
  return {
    apiUrl: api.url,
    providerRequests,
    providerRequestStarted,
    workspacePath,
    async close() {
      await api.close();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
      if (previousUrl === undefined) delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
      else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousUrl;
      fs.rmSync(workspacePath, { recursive: true, force: true });
      fs.rmSync(repoRoot, { recursive: true, force: true });
    },
  };
}

function writeArchitectConfig(repoRoot: string): void {
  fs.mkdirSync(path.join(repoRoot, "teams", "resource-architect"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "agents", "resource-architect"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "teams", "resource-architect", "team.yaml"),
    [
      "team:",
      "  name: resource-architect",
      "agents:",
      "  - name: resource-architect",
      "    agent_file: ../../agents/resource-architect/resource-architect.md",
      "",
    ].join("\n"),
  );
  // The architect's own file names the pair it runs with; the team declares
  // no model, because a team no longer decides one.
  fs.writeFileSync(
    path.join(repoRoot, "agents", "resource-architect", "resource-architect.md"),
    [
      "---",
      "provider: openai",
      "model: local-test-model",
      "thinking: medium",
      "---",
      "",
      "Return concise responses.",
      "",
    ].join("\n"),
  );
}
