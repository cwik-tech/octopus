import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import type { PlannedAgentSpec } from "../../contracts/agent-generator.js";
import type { ResourceArchitectPlan } from "../../contracts/resource-architect.js";
import { ResourceArchitectStore } from "../../server/resource-architect-store.js";
import { CreateJobRegistry } from "../../server/create-job-registry.js";
import { handleResourceArchitectRoutes } from "../../server/routes/resource-architect.js";
import { buildPlannedAgents } from "../../domains/agent-generator/planned-agent-builder.js";
import { toAuthoredPlannedAgent } from "../../contracts/resource-architect-persisted.js";
import { applyPlannedWebResearch } from "../../domains/agent-generator/planned-agent-web-research.js";
import { readAcquisitionAgentPolicy } from "../../domains/acquisition/acquisition-policy.js";
import { parseAgentFrontmatter } from "../../parsers/load-agent.js";

test("an approved list-form persona grants research to the runtime and retains its other tools", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "list-persona-policy-"));
  const folder = path.join(root, "agents/reviewer");
  const file = path.join(folder, "reviewer.md");
  try {
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(file, applyPlannedWebResearch("---\nname: reviewer\ntools:\n  - generate_word\nmodel: fixture\n---\nBody", true));
    assert.equal(readAcquisitionAgentPolicy(root, "agents/reviewer").enabled, true);
    assert.deepEqual(parseAgentFrontmatter(file).frontmatter, {
      name: "reviewer", tools: "generate_word, research_web", model: "fixture",
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

function agent(name = "product-reviewer") {
  return { name, role: "Reviewer", description: "Reviews current product prices.", rationale: "Needs current sources." };
}

function standalonePlan(): ResourceArchitectPlan {
  return { id: "web-plan", kind: "standalone_agents", agents: [agent()] };
}

async function startHarness(plan = standalonePlan()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "planned-web-research-"));
  const store = new ResourceArchitectStore(root);
  const registry = new CreateJobRegistry();
  await store.savePlan(plan);
  const server = http.createServer((req, res) => {
    void handleResourceArchitectRoutes({ req, res, url: new URL(req.url ?? "/", "http://localhost"),
      options: { createJobRegistry: registry, resourceArchitectStore: store, isAbortLike: () => false },
    }).then((handled) => { if (!handled) res.writeHead(404).end(); }, (error: unknown) => {
      res.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/create/resource-architect/plans/web-plan`;
  return {
    root, store,
    async revision() {
      const response = await fetch(`${base}/shape`, { signal: AbortSignal.timeout(2000) });
      const body: unknown = await response.json();
      assert.ok(body && typeof body === "object" && "revision" in body && typeof body.revision === "string");
      return body.revision;
    },
    amend(body: unknown) {
      return fetch(`${base}/web-research`, { method: "POST", headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(2000), body: JSON.stringify(body) });
    },
    async close() {
      registry.close();
      await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test("internet access choices persist across restart and control the created persona", async () => {
  const harness = await startHarness();
  try {
    const response = await harness.amend({ agentName: "product-reviewer", enabled: true, expectedRevision: await harness.revision() });
    assert.equal(response.status, 200, await response.text());
    const plan = await new ResourceArchitectStore(harness.root).getPlan("web-plan");
    assert.ok(plan?.kind === "standalone_agents");
    assert.deepEqual(plan.agents, [{ ...agent(), webResearchEnabled: true }]);
    const built = await buildPlannedAgents({ repoRoot: harness.root, planId: plan.id, jobId: "build", agents: plan.agents.map(toAuthoredPlannedAgent), maxConcurrency: 1, allowFallback: true });
    assert.equal(built.items[0]?.status, "created", JSON.stringify(built.items));
    assert.match(await fs.readFile(path.join(harness.root, "agents/product-reviewer/product-reviewer.md"), "utf8"), /^tools: research_web$/m);
  } finally { await harness.close(); }
});

test("declining the recommendation persists without changing the other Agent", async () => {
  const harness = await startHarness({ id: "web-plan", kind: "standalone_agents", agents: [{ ...agent(), webResearchEnabled: true }, agent("writer")] });
  try {
    const response = await harness.amend({ agentName: "product-reviewer", enabled: false, expectedRevision: await harness.revision() });
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(await new ResourceArchitectStore(harness.root).getPlan("web-plan"), {
      id: "web-plan", kind: "standalone_agents", agents: [{ ...agent(), webResearchEnabled: false }, agent("writer")],
    });
  } finally { await harness.close(); }
});

const teamPlan: ResourceArchitectPlan = { id: "web-plan", kind: "team", team: {
  teamId: "review", description: "Reviews products.", tags: [], questionsResolved: [],
  existingAgents: [{ name: "writer", role: "Writer", rationale: "Already exists." }], newAgents: [agent()],
} };
const updatePlan: ResourceArchitectPlan = { id: "web-plan", kind: "resource_updates", operations: [{
  kind: "add_team_agents", target: { kind: "team", id: "review" }, expectedRevision: `sha256:${"a".repeat(64)}`,
  libraryAgentsToAdd: [{ name: "writer", role: "Writer", rationale: "Already exists." }], newAgentsToCreate: [agent()],
}] };

for (const plan of [teamPlan, updatePlan]) {
  test(`${plan.kind} proposals change new Agents and refuse to change reused Agents`, async () => {
    const harness = await startHarness(plan);
    try {
      const response = await harness.amend({ agentName: "product-reviewer", enabled: true, expectedRevision: await harness.revision() });
      assert.equal(response.status, 200, await response.text());
      const saved = await new ResourceArchitectStore(harness.root).getPlan("web-plan");
      assert.match(JSON.stringify(saved), /"webResearchEnabled":true/);
      const refused = await harness.amend({ agentName: "writer", enabled: true, expectedRevision: await harness.revision() });
      assert.equal(refused.status, 422);
      assert.deepEqual(await harness.store.getPlan("web-plan"), saved);
    } finally { await harness.close(); }
  });
}

for (const invalid of ["true", null, 1]) {
  test(`rejects the non-boolean internet choice ${JSON.stringify(invalid)}`, async () => {
    const harness = await startHarness();
    try {
      const response = await harness.amend({ agentName: "product-reviewer", enabled: invalid, expectedRevision: await harness.revision() });
      assert.equal(response.status, 400);
      assert.deepEqual(await harness.store.getPlan("web-plan"), standalonePlan());
    } finally { await harness.close(); }
  });
}

test("a stale internet choice cannot overwrite a newer proposal", async () => {
  const harness = await startHarness();
  try {
    const revision = await harness.revision();
    const current = { ...standalonePlan(), agents: [agent("new-reviewer")] };
    await harness.store.savePlan(current);
    const response = await harness.amend({ agentName: "product-reviewer", enabled: true, expectedRevision: revision });
    assert.equal(response.status, 409);
    assert.deepEqual(await harness.store.getPlan("web-plan"), current);
  } finally { await harness.close(); }
});

// A plan saved before card summaries has no summary on its new Agents. The
// first write it accepts moves its revision, like any write does, and must not
// quietly add a derived summary on the way. The card adopts the plan and the
// revision from that one answer, and a card still holding the old revision is
// refused with the current snapshot instead of writing over it.
test("the first accepted change to a plan saved before summaries answers its new plan and revision together", async () => {
  const harness = await startHarness();
  try {
    const before = await harness.revision();

    const accepted = await harness.amend({ agentName: "product-reviewer", enabled: true, expectedRevision: before });

    assert.equal(accepted.status, 200);
    const answer: unknown = await accepted.json();
    assert.ok(answer && typeof answer === "object" && "revision" in answer && "plan" in answer);
    assert.notEqual(answer.revision, before, "an accepted write must move the revision");
    assert.equal(answer.revision, await harness.revision(), "the answered revision must describe the stored plan");
    assert.deepEqual(answer.plan, { ...standalonePlan(), agents: [{ ...agent(), webResearchEnabled: true }] });
    assert.deepEqual(await new ResourceArchitectStore(harness.root).getPlan("web-plan"), answer.plan);

    const stale = await harness.amend({ agentName: "product-reviewer", enabled: false, expectedRevision: before });

    assert.equal(stale.status, 409);
    const refusal: unknown = await stale.json();
    assert.ok(refusal && typeof refusal === "object" && "error" in refusal && "revision" in refusal && "plan" in refusal);
    assert.equal(refusal.error, "plan_revision_conflict");
    assert.equal(refusal.revision, answer.revision);
    assert.deepEqual(refusal.plan, answer.plan);
    assert.deepEqual(await harness.store.getPlan("web-plan"), answer.plan);
  } finally { await harness.close(); }
});

/** The same new Agent in each kind of plan that proposes one. */
function plansWithNewAgent(newAgent: PlannedAgentSpec): ResourceArchitectPlan[] {
  const writer = { name: "writer", role: "Writer", rationale: "Already exists." };
  return [
    { id: "web-plan", kind: "standalone_agents", agents: [newAgent] },
    { id: "web-plan", kind: "team", team: {
      teamId: "review", description: "Reviews products.", tags: [], questionsResolved: [],
      existingAgents: [writer], newAgents: [newAgent],
    } },
    { id: "web-plan", kind: "resource_updates", operations: [{
      kind: "add_team_agents", target: { kind: "team", id: "review" }, expectedRevision: `sha256:${"a".repeat(64)}`,
      libraryAgentsToAdd: [writer], newAgentsToCreate: [newAgent],
    }] },
  ];
}

// A current plan's new Agents carry the summary the Architect wrote for the
// card. The write answers the plan the card adopts and saves the plan a
// restart reads, and both must still hold that summary exactly.
const withSummary: PlannedAgentSpec = { ...agent(), summary: "Checks current product prices against named sources." };
const summaryPlansAfterChange = plansWithNewAgent({ ...withSummary, webResearchEnabled: true });
plansWithNewAgent(withSummary).forEach((plan, index) => {
  test(`an internet access change keeps the card summary of a new Agent in a ${plan.kind} plan`, async () => {
    const harness = await startHarness(plan);
    try {
      const response = await harness.amend({ agentName: "product-reviewer", enabled: true, expectedRevision: await harness.revision() });

      assert.equal(response.status, 200);
      const answer: unknown = await response.json();
      assert.ok(answer && typeof answer === "object" && "plan" in answer);
      assert.deepEqual(answer.plan, summaryPlansAfterChange[index]);
      assert.deepEqual(await new ResourceArchitectStore(harness.root).getPlan("web-plan"), summaryPlansAfterChange[index]);
    } finally { await harness.close(); }
  });
});

test("internet access cannot change once creation has been admitted", async () => {
  const harness = await startHarness();
  try {
    const revision = await harness.revision();
    await harness.store.savePlanAdmission({ planId: "web-plan", jobId: "started", revision, priorJobIds: [] });
    const response = await harness.amend({ agentName: "product-reviewer", enabled: true, expectedRevision: revision });
    assert.equal(response.status, 409);
    assert.deepEqual(await harness.store.getPlan("web-plan"), standalonePlan());
  } finally { await harness.close(); }
});
