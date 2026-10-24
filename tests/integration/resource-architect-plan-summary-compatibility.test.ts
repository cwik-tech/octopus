/**
 * A plan saved before card summaries existed, read and built for real.
 *
 * Plans written before `summary` joined the planned Agent contract hold only
 * the detailed build brief in `description`. They must still load as they are
 * stored and build from the brief they hold, and the revision the card was
 * shown must still be the one the build is admitted against. The revision is a
 * digest over the stored record, so a reader that wrote a derived summary back,
 * or a build that did, would move it. What the card shows for such a plan is
 * the card's own test, through the renderer's plan reader.
 *
 * Everything here is real except the model: the filesystem plan store, the
 * plan and build routes, the build service and a loopback generation provider
 * that records what each generation was asked. The build is awaited on the
 * registry's own completion promise for the job, so no step waits on time.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { PlannedAgentSpec } from "../../contracts/agent-generator.js";
import type { ResourceArchitectPlan } from "../../contracts/resource-architect.js";
import {
  toAuthoredPlannedAgent,
  toAuthoredTeamNewAgentPlan,
} from "../../contracts/resource-architect-persisted.js";
import {
  buildPlannedAgents,
  createFallbackSkill,
} from "../../domains/agent-generator/planned-agent-builder.js";
import { computeTeamRevision } from "../../domains/resource-architect/resource-revision.js";
import {
  CreateJobRegistry,
  type CreateJobStartResult,
} from "../../server/create-job-registry.js";
import { ResourceArchitectStore } from "../../server/resource-architect-store.js";
import { handleResourceArchitectRoutes } from "../../server/routes/resource-architect.js";
import {
  createResourceBuildSnapshot,
  runResourceBuild,
} from "../../services/resource-architect-service.js";

const LEGACY_PLAN_ID = "legacy-summary-plan";
const LEGACY_AGENT = "renewal-risk-reviewer";
const BRIEF_MARKER = "BRIEF-MARKER-7F3A";

/**
 * A detailed brief as an older proposal wrote it: long, multi-line, with its
 * marker well past the first sentence and past the card limit, so a summary
 * substituted for it cannot carry the marker.
 */
const LEGACY_BRIEF = [
  "Reviews supplier contracts for renewal risk and tells procurement which clauses to renegotiate first.",
  "",
  "For every contract:",
  "1. Find each renewal, notice, and price-escalation clause and quote it exactly.",
  "2. Record the notice window in days and the date it closes.",
  `3. Rank the clauses by the money at stake and mark the top three with ${BRIEF_MARKER}.`,
  "",
  "Never  advise on clauses outside renewal terms.",
].join("\n");

/** The Agent exactly as the older server stored it: no `summary` key. */
function legacyAgent(): PlannedAgentSpec {
  return {
    name: LEGACY_AGENT,
    role: "Renewal risk reviewer",
    description: LEGACY_BRIEF,
    rationale: "No existing Agent reviews renewal terms.",
  };
}

function persona(name: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${name} description.`,
    "provider: openai",
    "model: local-test-model",
    "thinking: medium",
    "tools: none",
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n");
}

function seedRepo(repoRoot: string): void {
  for (const architect of ["workflow-architect", "resource-architect"]) {
    fs.mkdirSync(path.join(repoRoot, "teams", architect), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "agents", architect), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "teams", architect, "team.yaml"),
      [
        "team:",
        `  name: ${architect}`,
        "agents:",
        `  - name: ${architect}`,
        `    agent_file: ../../agents/${architect}/${architect}.md`,
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(repoRoot, "agents", architect, `${architect}.md`),
      "---\nprovider: openai\nmodel: local-test-model\n---\n\nCreate one complete Agent package from the brief.\n",
    );
  }
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
}

/** Where `ResourceArchitectStore` keeps a plan, so the fixture can seed one. */
function planFilePath(workspacePath: string, planId: string): string {
  return path.join(
    workspacePath,
    "resource-architect-plans",
    `${createHash("sha256").update(planId, "utf8").digest("hex")}.json`,
  );
}

function writePlanFile(workspacePath: string, plan: { id: string }): void {
  const file = planFilePath(workspacePath, plan.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`);
}

interface GenerationProvider {
  readonly url: string;
  /** The user message of every generation request, in arrival order. */
  readonly briefs: () => string[];
  readonly close: () => Promise<void>;
}

/** The only endpoint a generation in this file may reach. */
async function startGenerationProvider(): Promise<GenerationProvider> {
  const briefs: string[] = [];
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const lastUser = lastUserMessage(body);
      briefs.push(lastUser);
      const plannedName =
        lastUser.match(/Planned Agent name:\s*`([^`]+)`/u)?.[1] ??
        lastUser.match(/Create the missing agent\s*`([^`]+)`/u)?.[1] ??
        "unnamed-agent";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        model: "local-test-model",
        choices: [{
          message: {
            content: JSON.stringify({
              message: `Created ${plannedName}.`,
              suggestedName: plannedName,
              personaMarkdown: persona(plannedName),
              generatedSkills: [{
                name: `${plannedName}-review`,
                body: [
                  "---",
                  `name: ${plannedName}-review`,
                  "description: >",
                  "  Review a supplier contract for renewal exposure. Use when a",
                  "  contract needs its renewal and notice terms ranked.",
                  "---",
                  "",
                  "# Review",
                  "",
                ].join("\n"),
              }],
            }),
          },
        }],
      }));
    })().catch((error: unknown) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    briefs: () => [...briefs],
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    }),
  };
}

function lastUserMessage(body: unknown): string {
  if (typeof body !== "object" || body === null || !("messages" in body)) return "";
  const messages = body.messages;
  if (!Array.isArray(messages)) return "";
  const users = messages.flatMap((entry: unknown) =>
    typeof entry === "object" && entry !== null &&
      "role" in entry && entry.role === "user" &&
      "content" in entry && typeof entry.content === "string"
      ? [entry.content]
      : []);
  return users.at(-1) ?? "";
}

/**
 * The registry the routes already use, reporting when a job it started is
 * finished. The route finishes a build's job only once the build has settled
 * and recorded its outcome, so that call is the signal the test waits on, not
 * a poll of the job record.
 */
class ObservedJobRegistry extends CreateJobRegistry {
  private readonly finishedJobs = new Map<string, { promise: Promise<void>; resolve: () => void }>();

  override start(jobId: string): CreateJobStartResult {
    const result = super.start(jobId);
    if (result.status === "started") {
      let resolve: () => void = () => {};
      const promise = new Promise<void>((settle) => { resolve = settle; });
      this.finishedJobs.set(jobId, { promise, resolve });
    }
    return result;
  }

  override finish(jobId: string): void {
    super.finish(jobId);
    this.finishedJobs.get(jobId)?.resolve();
  }

  finished(jobId: string): Promise<void> {
    const finished = this.finishedJobs.get(jobId);
    assert.ok(finished, `no build was started for ${jobId}`);
    return finished.promise;
  }
}

interface Harness {
  readonly repoRoot: string;
  readonly workspacePath: string;
  readonly provider: GenerationProvider;
  readonly registry: ObservedJobRegistry;
  readonly url: string;
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "plan-summary-compatibility-")),
  );
  const repoRoot = path.join(directory, "project");
  const workspacePath = path.join(directory, "workspace");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  seedRepo(repoRoot);
  const provider = await startGenerationProvider();
  const registry = new ObservedJobRegistry();
  const store = new ResourceArchitectStore(workspacePath);
  const server = http.createServer((req, res) => {
    void handleResourceArchitectRoutes({
      req,
      res,
      url: new URL(req.url ?? "/", "http://127.0.0.1"),
      options: {
        repoRootPath: repoRoot,
        createJobRegistry: registry,
        resourceArchitectStore: store,
        isAbortLike: () => false,
      },
    }).then(
      (handled) => {
        if (!handled && !res.writableEnded) res.writeHead(404).end();
      },
      (error: unknown) => {
        if (!res.writableEnded) res.writeHead(500).end(String(error));
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousApiUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
  process.env.OPENAI_API_KEY = "local-test-key";
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = provider.url;
  try {
    await run({
      repoRoot,
      workspacePath,
      provider,
      registry,
      url: `http://127.0.0.1:${address.port}`,
    });
  } finally {
    registry.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    await provider.close();
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousApiUrl === undefined) delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
    else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousApiUrl;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** The plan and revision the card reads, exactly as the route answers them. */
async function readPlanSnapshot(
  url: string,
  planId: string,
): Promise<{ revision: string; plan: Record<string, unknown> }> {
  const response = await fetch(
    `${url}/create/resource-architect/plans/${encodeURIComponent(planId)}/shape`,
  );
  assert.equal(response.status, 200, await response.clone().text());
  const body: unknown = await response.json();
  assert.ok(
    body && typeof body === "object" &&
      "revision" in body && typeof body.revision === "string" &&
      "plan" in body && body.plan && typeof body.plan === "object",
    `the plan read did not answer a plan and a revision: ${JSON.stringify(body)}`,
  );
  return { revision: body.revision, plan: { ...body.plan } };
}

function standaloneAgents(plan: Record<string, unknown>): PlannedAgentSpec[] {
  assert.equal(plan.kind, "standalone_agents");
  assert.ok(Array.isArray(plan.agents));
  return plan.agents.map((agent: unknown) => {
    assert.ok(agent && typeof agent === "object");
    assert.ok("name" in agent && typeof agent.name === "string");
    assert.ok("role" in agent && typeof agent.role === "string");
    assert.ok("description" in agent && typeof agent.description === "string");
    assert.ok("rationale" in agent && typeof agent.rationale === "string");
    assert.ok(!("summary" in agent) || typeof agent.summary === "string");
    return {
      name: agent.name,
      role: agent.role,
      ...("summary" in agent && typeof agent.summary === "string" ? { summary: agent.summary } : {}),
      description: agent.description,
      rationale: agent.rationale,
    };
  });
}

test("a plan saved before card summaries loads as stored and builds from its unchanged brief under the same revision", { timeout: 60_000 }, async () => {
  await withHarness(async ({ repoRoot, workspacePath, provider, registry, url }) => {
    // Arrange: the plan file an older server wrote, pinned byte for byte.
    const stored = { id: LEGACY_PLAN_ID, kind: "standalone_agents", agents: [legacyAgent()] };
    writePlanFile(workspacePath, stored);
    const planFileBytes = fs.readFileSync(planFilePath(workspacePath, LEGACY_PLAN_ID));

    // Act and assert: the card's read.
    const shown = await readPlanSnapshot(url, LEGACY_PLAN_ID);
    const [agent] = standaloneAgents(shown.plan);
    assert.ok(agent);
    assert.deepEqual(agent, legacyAgent(), "the legacy Agent must be served as it is stored");

    // Act: build it, admitted against the revision the card was shown.
    const jobId = "legacy-summary-build";
    const started = await fetch(`${url}/create/resource-architect/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        planId: LEGACY_PLAN_ID,
        jobId,
        provider: "openai",
        model: "local-test-model",
        expectedRevision: shown.revision,
      }),
    });
    assert.equal(started.status, 202, await started.clone().text());
    await registry.finished(jobId);

    // Assert: it built, under the revision it was admitted with.
    const job = await new ResourceArchitectStore(workspacePath).getJob(jobId);
    assert.equal(job?.status, "completed", JSON.stringify(job, null, 2));
    assert.equal(job.admittedRevision, shown.revision);
    assert.deepEqual(job.items.map((item) => item.status), ["created"]);
    assert.equal(
      fs.existsSync(path.join(repoRoot, "agents", LEGACY_AGENT, `${LEGACY_AGENT}.md`)),
      true,
    );

    // Assert: the generator was given the whole brief, not the card copy.
    const briefs = provider.briefs();
    assert.equal(briefs.length, 1, "the Agent is generated once");
    assert.ok(
      briefs[0]!.includes(LEGACY_BRIEF),
      `the generation request lost the stored brief:\n${briefs[0]}`,
    );

    // Assert: nothing wrote a derived summary back.
    const after = await readPlanSnapshot(url, LEGACY_PLAN_ID);
    assert.equal(after.revision, shown.revision, "building a legacy plan moved its revision");
    assert.deepEqual(after.plan, shown.plan);
    assert.deepEqual(
      fs.readFileSync(planFilePath(workspacePath, LEGACY_PLAN_ID)),
      planFileBytes,
      "reading and building a legacy plan must leave its file exactly as it was",
    );
  });
});

/*
 * A current plan carries a card summary beside the brief. Generation must
 * still be handed the brief, byte for byte, on every path that builds a new
 * Agent: the builder's own default renderer, the three renderers the Resource
 * Architect build passes in (standalone Agents, a new Team, and a Team update),
 * and the fallback skill. The summary and the brief carry different markers,
 * so a path that substituted one for the other fails by name.
 */

const CARD_MARKER = "CARD-SUMMARY-MARKER";
const EXISTING_TEAM = "supplier-review-team";
const EXISTING_MEMBER = "contract-lead";

/** A new Agent as a current proposal stores it. */
function currentAgent(name: string): PlannedAgentSpec {
  return {
    name,
    role: "Renewal risk reviewer",
    summary: `${CARD_MARKER}: flags the renewal clauses worth renegotiating.`,
    description: [
      `Reviews supplier contracts for ${name}.`,
      "",
      "1. Quote every renewal and notice clause exactly.",
      `2. Rank them by the money at stake and mark the top three with ${BRIEF_MARKER}.`,
    ].join("\n"),
    rationale: "No existing Agent reviews renewal terms.",
  };
}

/** A registered Team a Team update can add an Agent to. */
function seedExistingTeam(repoRoot: string): void {
  fs.mkdirSync(path.join(repoRoot, "agents", EXISTING_MEMBER), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "agents", EXISTING_MEMBER, `${EXISTING_MEMBER}.md`),
    persona(EXISTING_MEMBER),
  );
  fs.mkdirSync(path.join(repoRoot, "teams", EXISTING_TEAM), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "teams", EXISTING_TEAM, "team.yaml"),
    [
      "team:",
      `  name: "${EXISTING_TEAM}"`,
      "  description: >",
      "    Reviews supplier contracts.",
      "workflow:",
      "  entry_level: review",
      "agents:",
      `  - name: "${EXISTING_MEMBER}"`,
      "    type: agent",
      "    role: >",
      "      Contract lead",
      "    tools: []",
      `    agent_file: "../../agents/${EXISTING_MEMBER}/${EXISTING_MEMBER}.md"`,
      "    experience_enabled: true",
      "levels:",
      "  - id: review",
      "    name: Review",
      "    order: 0",
      "    stage:",
      "      type: discussion",
      `      coordinator: "${EXISTING_MEMBER}"`,
      "      participants:",
      `        - "${EXISTING_MEMBER}"`,
      "      config:",
      "        mode: brainstorm",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(repoRoot, "teams.yaml"),
    [
      `${EXISTING_TEAM}:`,
      "  type: team",
      "  description: Reviews supplier contracts.",
      `  team_path: ./teams/${EXISTING_TEAM}`,
      "  tags: []",
      "",
    ].join("\n"),
  );
}

/** Asserts one generation was asked for exactly `agent`'s brief and never its summary. */
function assertGeneratedFromBrief(provider: GenerationProvider, agent: PlannedAgentSpec): void {
  const briefs = provider.briefs();
  assert.equal(briefs.length, 1, "the Agent is generated once");
  assert.ok(
    briefs[0]!.includes(agent.description),
    `the generation request lost the stored brief:\n${briefs[0]}`,
  );
  assert.equal(
    briefs[0]!.includes(CARD_MARKER),
    false,
    `the generation request carried the card summary:\n${briefs[0]}`,
  );
}

/** Builds a stored plan through the Resource Architect build service. */
async function buildStoredPlan(
  harness: Harness,
  plan: ResourceArchitectPlan,
): Promise<ReturnType<typeof createResourceBuildSnapshot>> {
  const store = new ResourceArchitectStore(harness.workspacePath);
  await store.savePlan(plan);
  const stored = await new ResourceArchitectStore(harness.workspacePath).getPlan(plan.id);
  assert.ok(stored, "the plan must read back from disk");
  const job = createResourceBuildSnapshot({ plan: stored, jobId: `${plan.id}-build` });
  await runResourceBuild({
    repoRoot: harness.repoRoot,
    plan: stored,
    job,
    store,
    provider: "openai",
    model: "local-test-model",
  });
  // Nothing in a build writes the plan, so the card and a retry read the same
  // summaries afterwards.
  assert.deepEqual(
    await new ResourceArchitectStore(harness.workspacePath).getPlan(plan.id),
    plan,
    "building a plan changed its stored copy",
  );
  return job;
}

test("the builder's default renderer hands the generator the stored brief, not the card summary", { timeout: 60_000 }, async () => {
  await withHarness(async (harness) => {
    const agent = currentAgent("default-renderer-reviewer");

    const result = await buildPlannedAgents({
      repoRoot: harness.repoRoot,
      planId: "default-renderer-plan",
      jobId: "default-renderer-build",
      agents: [toAuthoredPlannedAgent(agent)],
      maxConcurrency: 1,
      provider: "openai",
      model: "local-test-model",
    });

    assert.deepEqual(result.items.map((item) => item.status), ["created"]);
    assertGeneratedFromBrief(harness.provider, agent);
  });
});

test("a standalone Agent build hands the generator the stored brief, not the card summary", { timeout: 60_000 }, async () => {
  await withHarness(async (harness) => {
    const agent = currentAgent("standalone-reviewer");

    const job = await buildStoredPlan(harness, {
      id: "standalone-summary-plan",
      kind: "standalone_agents",
      agents: [agent],
    });

    assert.equal(job.status, "completed", JSON.stringify(job, null, 2));
    assertGeneratedFromBrief(harness.provider, agent);
  });
});

test("a new Team build hands the generator each new Agent's stored brief, not its card summary", { timeout: 60_000 }, async () => {
  await withHarness(async (harness) => {
    const agent = currentAgent("team-reviewer");

    const job = await buildStoredPlan(harness, {
      id: "team-summary-plan",
      kind: "team",
      team: {
        teamId: "renewal-review-team",
        description: "Reviews supplier renewals.",
        tags: [],
        existingAgents: [],
        newAgents: [agent],
        questionsResolved: [],
      },
    });

    assert.equal(job.status, "completed", JSON.stringify(job, null, 2));
    assertGeneratedFromBrief(harness.provider, agent);
  });
});

test("a Team update hands the generator each new Agent's stored brief, not its card summary", { timeout: 60_000 }, async () => {
  await withHarness(async (harness) => {
    seedExistingTeam(harness.repoRoot);
    const agent = currentAgent("update-reviewer");

    const job = await buildStoredPlan(harness, {
      id: "update-summary-plan",
      kind: "resource_updates",
      operations: [{
        kind: "add_team_agents",
        target: { kind: "team", id: EXISTING_TEAM },
        expectedRevision: computeTeamRevision(harness.repoRoot, EXISTING_TEAM),
        libraryAgentsToAdd: [],
        newAgentsToCreate: [agent],
      }],
    });

    assert.equal(job.status, "completed", JSON.stringify(job, null, 2));
    assertGeneratedFromBrief(harness.provider, agent);
  });
});

test("the fallback skill carries the stored brief, not the card summary", () => {
  const agent = currentAgent("fallback-reviewer");

  for (const projected of [toAuthoredPlannedAgent(agent), toAuthoredTeamNewAgentPlan(agent)]) {
    const skill = createFallbackSkill(projected);

    assert.ok(
      skill.body.includes(`\n${agent.description}\n`),
      `the fallback skill lost the stored brief:\n${skill.body}`,
    );
    assert.equal(skill.body.includes(CARD_MARKER), false, `the fallback skill carried the card summary:\n${skill.body}`);
  }
});
