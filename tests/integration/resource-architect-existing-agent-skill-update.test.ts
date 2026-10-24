/**
 * Outer acceptance loop for vertical capability 2: creating and updating the
 * skills of an existing Agent from chat.
 *
 * One coherent user journey: the user names an existing Agent and the skill
 * work it needs, reviews the returned update proposal, authorizes it with a
 * stored-plan build request, and finds one new skill folder and one rewritten
 * skill on that Agent — discovered by the real Agent loader — while the
 * persona, the unrelated skill, the runtime experience files, and the
 * ownership marker are byte-for-byte what they were.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { startApiServer } from "../../server/api-server.js";
import { FileSystemRunStore } from "../../domains/run/run-store.js";
import { parseTeamConfig } from "../../parsers/team-config.js";
import { loadAgent } from "../../parsers/load-agent.js";
import type { ResourceBuildJobSnapshot } from "../../contracts/resource-architect.js";
import type { PersistedResourceUpdatePlan } from "../../contracts/resource-architect-persisted.js";
import { computeAgentRevision } from "../../domains/agent-generator/agent-revision.js";
import { ResourceArchitectStore } from "../../server/resource-architect-store.js";
import { parseResourceBuildJobRecord } from "../../server/resource-architect-durable-records.js";
import { createResourceBuildSnapshot } from "../../services/resource-architect-service.js";
import {
  runResourceUpdateBuild,
  type ResourceUpdatePersistenceObserver,
} from "../../services/resource-update-executor.js";

const EXISTING_AGENT = "michigan-contract-lawyer";
const HOST_TEAM_ID = "contract-review-team";
const NEW_SKILL = "termination-clause-review";
const UPDATED_SKILL = "indemnity-clause-review";
const UNRELATED_SKILL = "governing-law-review";
const THIRD_SKILL = "cure-period-review";

interface ResourceBuildJobView {
  status: string;
  error?: string;
  selectedResource: { kind: string; id: string } | null;
  items: Array<{
    planIndex: number;
    status: string;
    plannedResource: { kind: string; id: string };
    resource?: { kind: string; id: string };
    error?: string;
  }>;
  events: Array<{ id: number; type: string; message: string }>;
}

function makeDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function persona(name: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${name} description.`,
    "tier: strategic",
    "provider: openai",
    "model: local-test-model",
    "thinking: medium",
    "tools: none",
    "---",
    "",
    `# ${name}`,
    "",
    "## Skills",
    "",
    "{{SKILLS_BLOCK}}",
    "",
  ].join("\n");
}

/** A conforming `SKILL.md` for a skill this test did not ask to change. */
function skillDocument(name: string, summary: string): string {
  return [
    "---",
    `name: ${name}`,
    "description: >",
    `  ${summary} Use when a contract draft reaches the ${name} review step and`,
    "  the reviewer needs the clause-by-clause procedure.",
    "---",
    "",
    `# ${name}`,
    "",
    `Work through the ${name} checklist.`,
    "",
  ].join("\n");
}

function writeSkill(repoRoot: string, agent: string, name: string, body: string): void {
  const skillDir = path.join(repoRoot, "agents", agent, "skills", name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), body);
}

function writeArchitectConfig(repoRoot: string): void {
  for (const architect of ["workflow-architect", "resource-architect"]) {
    const teamDir = path.join(repoRoot, "teams", architect);
    const agentDir = path.join(repoRoot, "agents", architect);
    fs.mkdirSync(teamDir, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, "team.yaml"),
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
      path.join(agentDir, `${architect}.md`),
      // The architect runs with its own agent file's pair.
      "---\nprovider: openai\nmodel: local-test-model\n---\n\n" + (architect === "resource-architect"
        ? "RESOURCE_ARCHITECT_RESPONSE_SCHEMA\n"
        : "Create one complete Agent package from the brief.\n"),
    );
  }
}

/**
 * An Agent the update path did not create: two conforming skills, accumulated
 * runtime experience, and an ownership marker no skill update may disturb.
 */
function writeExistingAgent(repoRoot: string): void {
  const agentDir = path.join(repoRoot, "agents", EXISTING_AGENT);
  fs.mkdirSync(path.join(agentDir, "experience"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, `${EXISTING_AGENT}.md`), persona(EXISTING_AGENT));
  fs.writeFileSync(
    path.join(agentDir, "experience", "session-1.md"),
    "Learned that Michigan indemnity caps are usually negotiated late.\n",
  );
  fs.writeFileSync(path.join(agentDir, ".create-orchestrator"), "seed-orchestrator\n");
  writeSkill(
    repoRoot,
    EXISTING_AGENT,
    UPDATED_SKILL,
    skillDocument(UPDATED_SKILL, "Review indemnity clauses for uncapped exposure."),
  );
  writeSkill(
    repoRoot,
    EXISTING_AGENT,
    UNRELATED_SKILL,
    skillDocument(UNRELATED_SKILL, "Review governing-law clauses for forum risk."),
  );
}

/** A Team that carries the Agent, so the real loader can be asked about it. */
function writeHostTeam(repoRoot: string): void {
  const teamDir = path.join(repoRoot, "teams", HOST_TEAM_ID);
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, "team.yaml"),
    [
      "team:",
      `  name: "${HOST_TEAM_ID}"`,
      "  description: Reviews contracts.",
      '  version: "0.1.0"',
      "agents:",
      `  - name: "${EXISTING_AGENT}"`,
      "    type: agent",
      "    role: Michigan contract reviewer",
      "    tier: strategic",
      "    tools: []",
      `    agent_file: "../../agents/${EXISTING_AGENT}/${EXISTING_AGENT}.md"`,
      "    experience_enabled: true",
      "levels:",
      "  - id: review",
      "    name: Review",
      "    order: 0",
      "    stage:",
      "      type: discussion",
      `      coordinator: "${EXISTING_AGENT}"`,
      "      participants:",
      `        - "${EXISTING_AGENT}"`,
      "      config:",
      "        mode: brainstorm",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(repoRoot, "teams.yaml"),
    [
      `${HOST_TEAM_ID}:`,
      "  type: team",
      "  description: Reviews contracts.",
      `  team_path: ./teams/${HOST_TEAM_ID}`,
      "  tags: []",
      "",
    ].join("\n"),
  );
}

/** The skill catalog the runtime builds for this Agent, through the real loader. */
function loadedSkillCatalog(repoRoot: string): string {
  const parsed = parseTeamConfig(path.join(repoRoot, "teams", HOST_TEAM_ID, "team.yaml"));
  assert.ok(parsed.config, `team config failed to parse: ${parsed.errors.join("; ")}`);
  const rosterEntry = parsed.config.agents.find((agent) => agent.name === EXISTING_AGENT);
  assert.ok(rosterEntry, "the host Team must carry the Agent under test");
  const loaded = loadAgent(rosterEntry, parsed.config, 0);
  assert.ok(loaded, "the real loader must find the Agent");
  return loaded.skillsContent;
}

interface ProviderHarness {
  close(): Promise<void>;
  url: string;
  skillGenerationCount(): number;
}

/** A conforming skill the provider "authors" for one requested name. */
function generatedSkill(name: string): string {
  return [
    "---",
    `name: ${name}`,
    "description: >",
    `  Walk a contract draft through the ${name} procedure clause by clause.`,
    `  Use when a draft reaches ${name} and the reviewer needs the current`,
    "  checklist rather than general drafting advice.",
    "---",
    "",
    `# ${name}`,
    "",
    "1. Locate the clause.",
    "2. Compare it against the negotiated position.",
    "",
  ].join("\n");
}

async function startProviderHarness(): Promise<ProviderHarness> {
  let skillGenerationCount = 0;
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const system = body.messages?.find((message) => message.role === "system")
        ?.content ?? "";
      const lastUser = [...(body.messages ?? [])]
        .reverse()
        .find((message) => message.role === "user")?.content ?? "";

      let content: string;
      if (system.trimStart().startsWith("RESOURCE_ARCHITECT_RESPONSE_SCHEMA")) {
        content = JSON.stringify({
          message: `I will change two skills on ${EXISTING_AGENT}.`,
          // No `expectedRevision` anywhere: the server owns Agent revisions.
          outcome: {
            id: "agent-skill-update-proposal",
            kind: "resource_updates",
            operations: [
              {
                kind: "update_agent_skills",
                target: { kind: "agent", id: EXISTING_AGENT },
                skillUpdates: [
                  {
                    action: "create",
                    name: NEW_SKILL,
                    instruction:
                      "Author a termination-clause review procedure covering notice periods and cure rights.",
                  },
                  {
                    action: "update",
                    name: UPDATED_SKILL,
                    instruction:
                      "Rewrite the indemnity review to require an explicit liability cap check.",
                  },
                ],
              },
            ],
          },
          warnings: [],
        });
      } else {
        skillGenerationCount += 1;
        const requestedName =
          lastUser.match(/Skill folder name:\s*`([^`]+)`/i)?.[1] ?? NEW_SKILL;
        content = JSON.stringify({
          name: requestedName,
          body: generatedSkill(requestedName),
        });
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "local-test-model",
          choices: [{ message: { content } }],
        }),
      );
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    skillGenerationCount: () => skillGenerationCount,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

test("chat creates and rewrites the skills of an existing Agent only after the user applies the update", async () => {
  const workspacePath = makeDirectory("agent-skill-update-workspace-");
  const repoRoot = makeDirectory("agent-skill-update-repo-");
  const provider = await startProviderHarness();
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousApiUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
  process.env.OPENAI_API_KEY = "local-test-key";
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = provider.url;
  writeArchitectConfig(repoRoot);
  writeExistingAgent(repoRoot);
  writeHostTeam(repoRoot);

  const agentDir = path.join(repoRoot, "agents", EXISTING_AGENT);
  const personaPath = path.join(agentDir, `${EXISTING_AGENT}.md`);
  const markerPath = path.join(agentDir, ".create-orchestrator");
  const experiencePath = path.join(agentDir, "experience", "session-1.md");
  const unrelatedSkillPath = path.join(agentDir, "skills", UNRELATED_SKILL, "SKILL.md");
  const updatedSkillPath = path.join(agentDir, "skills", UPDATED_SKILL, "SKILL.md");
  const newSkillPath = path.join(agentDir, "skills", NEW_SKILL, "SKILL.md");
  const originalPersona = fs.readFileSync(personaPath, "utf8");
  const originalMarker = fs.readFileSync(markerPath, "utf8");
  const originalExperience = fs.readFileSync(experiencePath, "utf8");
  const originalUnrelated = fs.readFileSync(unrelatedSkillPath, "utf8");
  const originalUpdated = fs.readFileSync(updatedSkillPath, "utf8");

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

  try {
    // Arrange / Act — the proposal turn.
    const turnResponse = await fetch(`${api.url}/create/resource-architect/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "proposal",
        history: [{
          role: "user",
          text:
            `Give ${EXISTING_AGENT} a new ${NEW_SKILL} skill and rewrite its ${UPDATED_SKILL} skill.`,
        }],
      }),
    });
    const turn = (await turnResponse.json()) as {
      outcome: {
        id: string;
        kind: string;
        operations: Array<{
          kind: string;
          target: { kind: string; id: string };
          expectedRevision: string;
          skillUpdates: Array<{ action: string; name: string; instruction: string }>;
        }>;
      };
    };

    // Assert — a buildable skill-update plan, with a server-owned revision.
    assert.equal(turnResponse.status, 200);
    assert.equal(turn.outcome.kind, "resource_updates", JSON.stringify(turn, null, 2));
    assert.equal(turn.outcome.operations.length, 1);
    const operation = turn.outcome.operations[0]!;
    assert.equal(operation.kind, "update_agent_skills");
    assert.deepEqual(operation.target, { kind: "agent", id: EXISTING_AGENT });
    assert.match(operation.expectedRevision, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(
      operation.skillUpdates.map((skill) => [skill.action, skill.name]),
      [["create", NEW_SKILL], ["update", UPDATED_SKILL]],
    );

    // Assert — nothing was written before the user authorized the update.
    assert.equal(fs.existsSync(newSkillPath), false);
    assert.equal(fs.readFileSync(updatedSkillPath, "utf8"), originalUpdated);
    assert.equal(provider.skillGenerationCount(), 0);

    // Act — the user applies the update.
    const buildResponse = await fetch(`${api.url}/create/resource-architect/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId: turn.outcome.id }),
    });
    assert.equal(buildResponse.status, 202);
    const build = (await buildResponse.json()) as { jobId: string };

    let job: ResourceBuildJobView | null = null;
    for (let attempt = 0; attempt < 1_500; attempt += 1) {
      const response = await fetch(
        `${api.url}/create/resource-architect/jobs/${encodeURIComponent(build.jobId)}`,
      );
      job = ((await response.json()) as { job: ResourceBuildJobView }).job;
      if (job.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // Assert — the job reports the update truthfully.
    assert.equal(job?.status, "completed", JSON.stringify(job, null, 2));
    assert.deepEqual(
      job?.items.map((item) => ({
        planned: item.plannedResource,
        status: item.status,
        resource: item.resource,
      })),
      [{
        planned: { kind: "agent", id: EXISTING_AGENT },
        status: "updated",
        resource: { kind: "agent", id: EXISTING_AGENT },
      }],
    );
    assert.deepEqual(job?.selectedResource, { kind: "agent", id: EXISTING_AGENT });
    const eventTypes = job?.events.map((event) => event.type) ?? [];
    assert.ok(
      eventTypes.includes("resource_update_started"),
      `expected a started update event: ${eventTypes.join(", ")}`,
    );
    assert.ok(
      eventTypes.includes("resource_update_applied"),
      `expected an applied update event: ${eventTypes.join(", ")}`,
    );
    assert.equal(
      eventTypes.includes("agent_created"),
      false,
      "a skill update must never claim it created the Agent",
    );

    // Assert — exactly the two named skills were published, and they conform.
    const publishedNew = fs.readFileSync(newSkillPath, "utf8");
    const publishedUpdated = fs.readFileSync(updatedSkillPath, "utf8");
    assert.match(publishedNew, /^---\nname: termination-clause-review\n/);
    assert.ok(
      publishedNew.includes("Use when"),
      "a published skill states when to use it",
    );
    assert.notEqual(
      publishedUpdated,
      originalUpdated,
      "the requested update must replace the existing skill",
    );
    assert.match(publishedUpdated, /^---\nname: indemnity-clause-review\n/);

    // Assert — nothing the user did not name was touched.
    assert.equal(fs.readFileSync(personaPath, "utf8"), originalPersona);
    assert.equal(fs.readFileSync(markerPath, "utf8"), originalMarker);
    assert.equal(fs.readFileSync(experiencePath, "utf8"), originalExperience);
    assert.equal(fs.readFileSync(unrelatedSkillPath, "utf8"), originalUnrelated);
    assert.deepEqual(
      fs.readdirSync(path.join(agentDir, "skills")).sort(),
      [UPDATED_SKILL, UNRELATED_SKILL, NEW_SKILL].sort(),
      "an update publishes only the skill folders it named",
    );
    assert.deepEqual(
      fs.readdirSync(path.join(repoRoot, "agents")).sort(),
      [EXISTING_AGENT, "resource-architect", "workflow-architect"],
      "a skill update must not create or remove an Agent",
    );

    // Assert — the runtime discovers both skills through the real loader.
    const catalog = loadedSkillCatalog(repoRoot);
    assert.ok(
      catalog.includes(`### ${NEW_SKILL}`),
      `the created skill must be discoverable: ${catalog}`,
    );
    assert.ok(
      catalog.includes(`### ${UPDATED_SKILL}`),
      `the updated skill must stay discoverable: ${catalog}`,
    );
    assert.ok(
      catalog.includes("Use when a draft reaches indemnity-clause-review"),
      `the loader must serve the rewritten description: ${catalog}`,
    );
  } finally {
    await api.close();
    await provider.close();
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousApiUrl === undefined) {
      delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
    } else {
      process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousApiUrl;
    }
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

/**
 * A skill author whose answers the test decides, one skill at a time.
 *
 * `fail` refuses the first request for each skill it names with a server error. `hold`
 * never answers requests for that skill, so the test can act while the author
 * is still working on it; `requestArrived` resolves when such a request comes
 * in. Every other request is answered with a conforming document.
 */
interface ScriptedAuthor {
  url: string;
  requestedSkills(): string[];
  requestArrived(name: string): Promise<void>;
  close(): Promise<void>;
}

async function startScriptedAuthor(script: {
  fail?: string | readonly string[];
  hold?: string;
} = {}): Promise<ScriptedAuthor> {
  const requestedSkills: string[] = [];
  const failing = new Set(typeof script.fail === "string" ? [script.fail] : script.fail ?? []);
  const failed = new Set<string>();
  const arrivals = new Map<string, () => void>();
  const arrived = new Map<string, Promise<void>>();
  const arrivalFor = (name: string): Promise<void> => {
    const known = arrived.get(name);
    if (known) return known;
    const promise = new Promise<void>((resolve) => arrivals.set(name, resolve));
    arrived.set(name, promise);
    return promise;
  };
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const lastUser = lastUserMessage(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const name = lastUser.match(/Skill folder name:\s*`([^`]+)`/i)?.[1] ?? "";
      requestedSkills.push(name);
      void arrivalFor(name);
      arrivals.get(name)?.();
      if (name === script.hold) return;
      if (failing.has(name) && !failed.has(name)) {
        failed.add(name);
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("the skill author stalled");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        model: "local-test-model",
        choices: [{
          message: { content: JSON.stringify({ name, body: generatedSkill(name) }) },
        }],
      }));
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    requestedSkills: () => [...requestedSkills],
    requestArrived: arrivalFor,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      // A held request is still open; nothing else will ever end it.
      server.closeAllConnections();
    }),
  };
}

interface ExecutorHarness {
  repoRoot: string;
  workspacePath: string;
  author: ScriptedAuthor;
  plan: PersistedResourceUpdatePlan;
}

/**
 * The executor, the real skill-update operation, a real file-backed job store,
 * and a loopback skill author, around one update of the seeded Agent.
 */
async function withExecutorHarness(
  params: {
    skills: Array<{ action: "create" | "update"; name: string }>;
    script?: { fail?: string | readonly string[]; hold?: string };
  },
  run: (harness: ExecutorHarness) => Promise<void>,
): Promise<void> {
  const repoRoot = makeDirectory("skill-progress-repo-");
  const workspacePath = makeDirectory("skill-progress-workspace-");
  const author = await startScriptedAuthor(params.script);
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousApiUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
  process.env.OPENAI_API_KEY = "local-test-key";
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = author.url;
  writeArchitectConfig(repoRoot);
  writeExistingAgent(repoRoot);
  const plan: PersistedResourceUpdatePlan = {
    id: "skill-progress-plan",
    kind: "resource_updates",
    operations: [{
      kind: "update_agent_skills",
      target: { kind: "agent", id: EXISTING_AGENT },
      expectedRevision: computeAgentRevision(repoRoot, EXISTING_AGENT),
      skillUpdates: params.skills.map((skill) => ({
        ...skill,
        instruction: `Author the ${skill.name} procedure.`,
      })),
    }],
  };
  try {
    await run({ repoRoot, workspacePath, author, plan });
  } finally {
    await author.close();
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousApiUrl === undefined) delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
    else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousApiUrl;
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

/**
 * Runs one build of the harness plan to its end, then reads the job back
 * through a fresh store, so what is asserted is what reached the disk.
 */
async function buildAndReadBack(
  harness: ExecutorHarness,
  jobId: string,
  options: { signal?: AbortSignal; onPersistenceBoundary?: ResourceUpdatePersistenceObserver } = {},
): Promise<ResourceBuildJobSnapshot> {
  const job = createResourceBuildSnapshot({ plan: harness.plan, jobId });
  await runResourceUpdateBuild({
    repoRoot: harness.repoRoot,
    plan: harness.plan,
    job,
    store: new ResourceArchitectStore(harness.workspacePath),
    maxConcurrency: 1,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onPersistenceBoundary
      ? { onPersistenceBoundary: options.onPersistenceBoundary }
      : {}),
  }).catch(() => undefined);
  const stored = await new ResourceArchitectStore(harness.workspacePath).getJob(jobId);
  assert.ok(stored, `job ${jobId} must read back from disk`);
  return stored;
}

/** The skill-scoped events of a job, as [type, skill, action] in order. */
function skillEvents(job: ResourceBuildJobSnapshot): Array<[string, string, string]> {
  return job.events.flatMap<[string, string, string]>((event) =>
    event.skill ? [[event.type, event.skill.name, event.skill.action]] : []
  );
}

/** The last user message of a chat-completions request body. */
function lastUserMessage(body: unknown): string {
  if (typeof body !== "object" || body === null || !("messages" in body)) return "";
  const messages: unknown = body.messages;
  if (!Array.isArray(messages)) return "";
  for (const message of [...messages].reverse()) {
    if (
      typeof message === "object" && message !== null &&
      "role" in message && message.role === "user" &&
      "content" in message && typeof message.content === "string"
    ) {
      return message.content;
    }
  }
  return "";
}

function eventIndex(job: ResourceBuildJobSnapshot, type: string): number {
  return job.events.findIndex((event) => event.type === type);
}

test("an Agent update records each skill's progress durably and in order, and a retry starts from the receipt", async () => {
  await withExecutorHarness({
    skills: [
      { action: "create", name: NEW_SKILL },
      { action: "update", name: UPDATED_SKILL },
    ],
    script: { fail: UPDATED_SKILL },
  }, async (harness) => {
    const failed = await buildAndReadBack(harness, "job-1");

    assert.equal(failed.status, "failed");
    assert.deepEqual(skillEvents(failed), [
      ["skill_generating", NEW_SKILL, "create"],
      ["skill_staged", NEW_SKILL, "create"],
      ["skill_generating", UPDATED_SKILL, "update"],
      ["skill_failed", UPDATED_SKILL, "update"],
    ]);
    const skillFailure = failed.events.find((event) => event.type === "skill_failed");
    assert.match(skillFailure?.message ?? "", /The skill author did not answer/);
    assert.ok(
      eventIndex(failed, "skill_failed") < eventIndex(failed, "resource_update_failed"),
      "the row-level failure is recorded before the Agent-level one",
    );

    const retried = await buildAndReadBack(harness, "job-2");

    assert.equal(retried.status, "completed");
    assert.deepEqual(skillEvents(retried), [
      ["skill_staged", NEW_SKILL, "create"],
      ["skill_generating", UPDATED_SKILL, "update"],
      ["skill_staged", UPDATED_SKILL, "update"],
      ["skill_updated", NEW_SKILL, "create"],
      ["skill_updated", UPDATED_SKILL, "update"],
    ]);
    assert.deepEqual(
      harness.author.requestedSkills(),
      [NEW_SKILL, UPDATED_SKILL, UPDATED_SKILL],
      "the retry authors only the skill that failed",
    );
  });
});

test("a retry shows the skills its receipt staged before their operation's turn comes", async () => {
  const OTHER_AGENT = "michigan-lease-lawyer";
  const OTHER_SKILL = "rent-escalation-review";
  await withExecutorHarness({
    skills: [
      { action: "create", name: NEW_SKILL },
      { action: "update", name: UPDATED_SKILL },
    ],
    script: { fail: [OTHER_SKILL, UPDATED_SKILL] },
  }, async (harness) => {
    // A second Agent whose update runs first and calls the provider on every
    // attempt, so the skill update above waits behind it.
    const otherDir = path.join(harness.repoRoot, "agents", OTHER_AGENT);
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, `${OTHER_AGENT}.md`), persona(OTHER_AGENT));
    const plan: PersistedResourceUpdatePlan = {
      ...harness.plan,
      operations: [
        {
          kind: "update_agent_skills",
          target: { kind: "agent", id: OTHER_AGENT },
          expectedRevision: computeAgentRevision(harness.repoRoot, OTHER_AGENT),
          skillUpdates: [{
            action: "create",
            name: OTHER_SKILL,
            instruction: `Author the ${OTHER_SKILL} procedure.`,
          }],
        },
        ...harness.plan.operations,
      ],
    };
    const store = new ResourceArchitectStore(harness.workspacePath);
    await runResourceUpdateBuild({
      repoRoot: harness.repoRoot,
      plan,
      job: createResourceBuildSnapshot({ plan, jobId: "job-1" }),
      store,
      maxConcurrency: 1,
    }).catch(() => undefined);

    // The retry's author holds the first operation's call open.
    const retryAuthor = await startScriptedAuthor({ hold: OTHER_SKILL });
    process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = retryAuthor.url;
    const controller = new AbortController();
    try {
      const retry = runResourceUpdateBuild({
        repoRoot: harness.repoRoot,
        plan,
        job: createResourceBuildSnapshot({ plan, jobId: "job-2" }),
        store,
        maxConcurrency: 1,
        signal: controller.signal,
      }).catch(() => undefined);
      await retryAuthor.requestArrived(OTHER_SKILL);

      const midway = await new ResourceArchitectStore(harness.workspacePath).getJob("job-2");
      assert.equal(midway?.items[1]?.status, "planned", "the skill update has not started");
      assert.deepEqual(
        midway?.events.flatMap((event) =>
          event.skill && event.planIndex === 1 ? [[event.type, event.skill.name]] : []
        ),
        [["skill_staged", NEW_SKILL]],
      );
      controller.abort();
      await retry;
    } finally {
      await retryAuthor.close();
    }
  });
});

test("cancelling an Agent update marks only the skill being authored cancelled", async () => {
  await withExecutorHarness({
    skills: [
      { action: "create", name: NEW_SKILL },
      { action: "update", name: UPDATED_SKILL },
      { action: "create", name: THIRD_SKILL },
    ],
    script: { hold: UPDATED_SKILL },
  }, async (harness) => {
    const updatedPath = path.join(
      harness.repoRoot, "agents", EXISTING_AGENT, "skills", UPDATED_SKILL, "SKILL.md",
    );
    const updatedBefore = fs.readFileSync(updatedPath, "utf8");
    const controller = new AbortController();
    void harness.author.requestArrived(UPDATED_SKILL).then(() => controller.abort());

    const cancelled = await buildAndReadBack(harness, "job-1", { signal: controller.signal });

    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(skillEvents(cancelled), [
      ["skill_generating", NEW_SKILL, "create"],
      ["skill_staged", NEW_SKILL, "create"],
      ["skill_generating", UPDATED_SKILL, "update"],
      ["skill_cancelled", UPDATED_SKILL, "update"],
    ]);
    assert.deepEqual(harness.author.requestedSkills(), [NEW_SKILL, UPDATED_SKILL]);
    assert.equal(fs.readFileSync(updatedPath, "utf8"), updatedBefore);
    assert.equal(
      fs.existsSync(path.join(harness.repoRoot, "agents", EXISTING_AGENT, "skills", NEW_SKILL)),
      false,
    );
  });
});

test("skill authoring that cannot reach a provider fails the update without naming a skill", async () => {
  await withExecutorHarness({
    skills: [
      { action: "create", name: NEW_SKILL },
      { action: "update", name: UPDATED_SKILL },
    ],
  }, async (harness) => {
    // Nothing about either skill is wrong: no provider can be reached at all.
    // The harness puts the key back when the test ends.
    delete process.env.OPENAI_API_KEY;

    const failed = await buildAndReadBack(harness, "job-1");

    assert.equal(failed.status, "failed");
    assert.match(failed.items[0]?.error ?? "", /OPENAI_API_KEY is not set/);
    assert.deepEqual(skillEvents(failed), [], "no row is blamed for a missing API key");
    assert.deepEqual(harness.author.requestedSkills(), []);
  });
});

test("a publication interrupted after one skill keeps that skill updated and the rest staged", async () => {
  await withExecutorHarness({
    skills: [
      { action: "create", name: NEW_SKILL },
      { action: "update", name: UPDATED_SKILL },
    ],
  }, async (harness) => {
    let publications = 0;
    const interrupted = await buildAndReadBack(harness, "job-1", {
      onPersistenceBoundary: (boundary) => {
        if (boundary !== "after_skill_file_published") return;
        publications += 1;
        if (publications === 1) throw new Error("process exited mid-publication");
      },
    });

    assert.deepEqual(skillEvents(interrupted), [
      ["skill_generating", NEW_SKILL, "create"],
      ["skill_staged", NEW_SKILL, "create"],
      ["skill_generating", UPDATED_SKILL, "update"],
      ["skill_staged", UPDATED_SKILL, "update"],
      ["skill_updated", NEW_SKILL, "create"],
    ]);

    const recovered = await buildAndReadBack(harness, "job-2");

    assert.equal(recovered.status, "completed");
    assert.deepEqual(skillEvents(recovered), [
      ["skill_updated", NEW_SKILL, "create"],
      ["skill_staged", UPDATED_SKILL, "update"],
      ["skill_updated", UPDATED_SKILL, "update"],
    ]);
    assert.deepEqual(harness.author.requestedSkills(), [NEW_SKILL, UPDATED_SKILL]);
  });
});

/**
 * A job store that stops recording at one save, the way a process that exits
 * right after a receipt write leaves the job file: nothing from that save on
 * reaches the disk.
 */
class StoreThatExitsAt extends ResourceArchitectStore {
  private exited = false;

  constructor(
    workspacePath: string,
    private readonly exitsAt: (job: ResourceBuildJobSnapshot) => boolean,
  ) {
    super(workspacePath);
  }

  override async saveJob(job: ResourceBuildJobSnapshot): Promise<void> {
    if (this.exited || this.exitsAt(job)) {
      this.exited = true;
      throw new Error("the process exited");
    }
    await super.saveJob(job);
  }
}

/** The receipt of the harness plan's only operation. */
function receiptPath(repoRoot: string, planId: string): string {
  return path.join(
    repoRoot,
    ".create-orchestrator",
    "resource-updates",
    "skills",
    createHash("sha256").update(planId, "utf8").digest("hex"),
    "0.json",
  );
}

function sha256Digest(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

test("a staged skill that breaks the specification at publication is the row that fails", async () => {
  await withExecutorHarness({
    skills: [
      { action: "create", name: NEW_SKILL },
      { action: "update", name: UPDATED_SKILL },
    ],
    script: { fail: UPDATED_SKILL },
  }, async (harness) => {
    const skillsRoot = path.join(harness.repoRoot, "agents", EXISTING_AGENT, "skills");
    const updatedBefore = fs.readFileSync(path.join(skillsRoot, UPDATED_SKILL, "SKILL.md"), "utf8");
    await buildAndReadBack(harness, "job-1");
    // What an earlier release could have staged under older rules: a
    // description that never says when to use the skill. The receipt records
    // these bytes, so the retry reuses them instead of authoring them again.
    const staged = stagedSkillPath(harness.repoRoot, harness.plan.id, NEW_SKILL);
    const authored = fs.readFileSync(staged);
    const nonconforming = [
      "---",
      `name: ${NEW_SKILL}`,
      "description: Termination clause checklist.",
      "---",
      "",
      `# ${NEW_SKILL}`,
      "",
    ].join("\n");
    fs.writeFileSync(staged, nonconforming);
    const receiptFile = receiptPath(harness.repoRoot, harness.plan.id);
    fs.writeFileSync(
      receiptFile,
      fs.readFileSync(receiptFile, "utf8").replace(sha256Digest(authored), sha256Digest(nonconforming)),
    );

    const retried = await buildAndReadBack(harness, "job-2");

    assert.equal(retried.status, "failed");
    assert.deepEqual(skillEvents(retried), [
      ["skill_staged", NEW_SKILL, "create"],
      ["skill_generating", UPDATED_SKILL, "update"],
      ["skill_staged", UPDATED_SKILL, "update"],
      ["skill_failed", NEW_SKILL, "create"],
    ]);
    const skillFailure = retried.events.find((event) => event.type === "skill_failed");
    assert.match(skillFailure?.message ?? "", /not when to use it/);
    // Publication checks the whole batch before its first write.
    assert.equal(fs.existsSync(path.join(skillsRoot, NEW_SKILL)), false);
    assert.equal(
      fs.readFileSync(path.join(skillsRoot, UPDATED_SKILL, "SKILL.md"), "utf8"),
      updatedBefore,
    );
  });
});

/**
 * A job store whose save fails once, at the first job that matches, and works
 * again afterwards: a transient write error such as EBUSY on the rename.
 */
class StoreThatFailsOnceAt extends ResourceArchitectStore {
  private failed = false;

  constructor(
    workspacePath: string,
    private readonly failsAt: (job: ResourceBuildJobSnapshot) => boolean,
  ) {
    super(workspacePath);
  }

  override async saveJob(job: ResourceBuildJobSnapshot): Promise<void> {
    if (!this.failed && this.failsAt(job)) {
      this.failed = true;
      throw new Error("job file write failed");
    }
    await super.saveJob(job);
  }
}

test("a job save that fails during publication still publishes every named skill", async () => {
  await withExecutorHarness({
    skills: [
      { action: "create", name: NEW_SKILL },
      { action: "update", name: UPDATED_SKILL },
    ],
  }, async (harness) => {
    const skillsRoot = path.join(harness.repoRoot, "agents", EXISTING_AGENT, "skills");
    const job = createResourceBuildSnapshot({ plan: harness.plan, jobId: "job-1" });

    await assert.rejects(
      runResourceUpdateBuild({
        repoRoot: harness.repoRoot,
        plan: harness.plan,
        job,
        store: new StoreThatFailsOnceAt(
          harness.workspacePath,
          (saved) => saved.events.some((event) => event.type === "skill_updated"),
        ),
        maxConcurrency: 1,
      }),
      /job file write failed/,
    );

    // The first skill was live when its event could not be saved. Stopping
    // there would leave the Agent with one new skill and one old one.
    assert.equal(
      fs.readFileSync(path.join(skillsRoot, NEW_SKILL, "SKILL.md"), "utf8"),
      generatedSkill(NEW_SKILL),
    );
    assert.equal(
      fs.readFileSync(path.join(skillsRoot, UPDATED_SKILL, "SKILL.md"), "utf8"),
      generatedSkill(UPDATED_SKILL),
    );
    // The lost save is still answered for, once the batch is published.
    const stored = await new ResourceArchitectStore(harness.workspacePath).getJob("job-1");
    assert.equal(stored?.status, "failed");
    assert.match(stored?.error ?? "", /job file write failed/);
  });
});

/** Where the operation stages one skill's document, inside the plan's own folder. */
function stagedSkillPath(repoRoot: string, planId: string, skillName: string): string {
  return path.join(
    repoRoot,
    ".create-orchestrator",
    "resource-updates",
    "skills",
    createHash("sha256").update(planId, "utf8").digest("hex"),
    "0-staged",
    "skills",
    skillName,
    "SKILL.md",
  );
}

/** Every job the jobs route lists, read by the same parser the store uses. */
async function listJobsThroughTheApi(harness: ExecutorHarness): Promise<ResourceBuildJobSnapshot[]> {
  const api = await startApiServer({
    store: new FileSystemRunStore(harness.workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 1, cwd: harness.workspacePath };
      },
    },
    workspacePath: harness.workspacePath,
    repoRootPath: harness.repoRoot,
  });
  try {
    const response = await fetch(`${api.url}/create/resource-architect/jobs`);
    assert.equal(response.status, 200);
    const listed: unknown = await response.json();
    const entries: unknown = typeof listed === "object" && listed !== null && "jobs" in listed
      ? listed.jobs
      : null;
    assert.ok(Array.isArray(entries), `expected a job list in ${JSON.stringify(listed)}`);
    return entries.flatMap((entry) => {
      const job = parseResourceBuildJobRecord(entry);
      return job ? [job] : [];
    });
  } finally {
    await api.close();
  }
}

/** The exact interruption message the earlier restart reconciliation saved. */
const LEGACY_RESTART_INTERRUPTION =
  "Resource build was interrupted by an API restart. Retry the build to continue.";

/** A skill update as an earlier release's restart reconciliation saved it: no skill events. */
function legacyInterruptedSkillJob(
  plan: PersistedResourceUpdatePlan,
  jobId: string,
  startedAt: string,
): ResourceBuildJobSnapshot {
  return {
    jobId,
    planId: plan.id,
    startedAt,
    status: "failed",
    items: [{
      plannedResource: { kind: "agent", id: EXISTING_AGENT },
      planIndex: 0,
      status: "failed",
      error: LEGACY_RESTART_INTERRUPTION,
    }],
    selectedResource: null,
    events: [
      { id: 1, type: "build_started", message: `Started resource plan \`${plan.id}\`.` },
      {
        id: 2,
        type: "resource_update_started",
        plannedResource: { kind: "agent", id: EXISTING_AGENT },
        planIndex: 0,
        message: `Updating Agent \`${EXISTING_AGENT}\`.`,
      },
      { id: 3, type: "build_failed", message: LEGACY_RESTART_INTERRUPTION },
    ],
    error: LEGACY_RESTART_INTERRUPTION,
  };
}

test("an interruption an earlier release saved shows what its receipt proves, once", async () => {
  await withExecutorHarness({
    skills: [
      { action: "create", name: NEW_SKILL },
      { action: "update", name: UPDATED_SKILL },
    ],
  }, async (harness) => {
    // The receipt a restart during publication leaves: the first skill live,
    // the second staged. Built in a workspace of its own, so the only jobs
    // this workspace holds are the ones saved below.
    const scratchWorkspace = makeDirectory("skill-progress-scratch-");
    try {
      let publications = 0;
      await runResourceUpdateBuild({
        repoRoot: harness.repoRoot,
        plan: harness.plan,
        job: createResourceBuildSnapshot({ plan: harness.plan, jobId: "scratch-job" }),
        store: new ResourceArchitectStore(scratchWorkspace),
        maxConcurrency: 1,
        onPersistenceBoundary: (boundary) => {
          if (boundary !== "after_skill_file_published") return;
          publications += 1;
          if (publications === 1) throw new Error("process exited mid-publication");
        },
      }).catch(() => undefined);
    } finally {
      fs.rmSync(scratchWorkspace, { recursive: true, force: true });
    }
    const store = new ResourceArchitectStore(harness.workspacePath);
    await store.savePlan(harness.plan);
    // The attempt the receipt describes, and an older one it superseded.
    await store.saveJob(
      legacyInterruptedSkillJob(harness.plan, "superseded-job", "2026-09-19T09:00:00.000Z"),
    );
    await store.saveJob(
      legacyInterruptedSkillJob(harness.plan, "legacy-job", "2026-09-19T10:00:00.000Z"),
    );

    const listed = await listJobsThroughTheApi(harness);

    const legacy = listed.find((job) => job.jobId === "legacy-job");
    assert.equal(legacy?.status, "interrupted");
    assert.deepEqual(legacy && skillEvents(legacy), [
      ["skill_updated", NEW_SKILL, "create"],
      ["skill_staged", UPDATED_SKILL, "update"],
    ]);
    const superseded = listed.find((job) => job.jobId === "superseded-job");
    assert.deepEqual(
      superseded && skillEvents(superseded),
      [],
      "a later attempt's work is not the superseded job's",
    );
    // Saved with the job, and not added a second time by the next listing.
    const relisted = await listJobsThroughTheApi(harness);
    const stored = await new ResourceArchitectStore(harness.workspacePath).getJob("legacy-job");
    assert.deepEqual(stored && skillEvents(stored), [
      ["skill_updated", NEW_SKILL, "create"],
      ["skill_staged", UPDATED_SKILL, "update"],
    ]);
    const again = relisted.find((job) => job.jobId === "legacy-job");
    assert.deepEqual(again && skillEvents(again), [
      ["skill_updated", NEW_SKILL, "create"],
      ["skill_staged", UPDATED_SKILL, "update"],
    ]);
  });
});

test("restart reconciliation records a published skill the job never heard about, and repeats nothing it has", async () => {
  await withExecutorHarness({
    skills: [
      { action: "create", name: NEW_SKILL },
      { action: "update", name: UPDATED_SKILL },
    ],
  }, async (harness) => {
    await new ResourceArchitectStore(harness.workspacePath).savePlan(harness.plan);
    // The first skill goes live and the receipt records it, then the process
    // exits before the job file hears about it.
    let publications = 0;
    await assert.rejects(runResourceUpdateBuild({
      repoRoot: harness.repoRoot,
      plan: harness.plan,
      job: createResourceBuildSnapshot({ plan: harness.plan, jobId: "job-1" }),
      store: new StoreThatExitsAt(
        harness.workspacePath,
        (saved) => saved.events.some((event) => event.type === "skill_updated"),
      ),
      maxConcurrency: 1,
      onPersistenceBoundary: (boundary) => {
        if (boundary !== "after_skill_file_published") return;
        publications += 1;
        if (publications === 1) throw new Error("process exited mid-publication");
      },
    }));
    const beforeRestart = await new ResourceArchitectStore(harness.workspacePath).getJob("job-1");
    assert.deepEqual(beforeRestart && skillEvents(beforeRestart), [
      ["skill_generating", NEW_SKILL, "create"],
      ["skill_staged", NEW_SKILL, "create"],
      ["skill_generating", UPDATED_SKILL, "update"],
      ["skill_staged", UPDATED_SKILL, "update"],
    ]);

    const reconciled = (await listJobsThroughTheApi(harness))
      .find((job) => job.jobId === "job-1");

    assert.equal(reconciled?.status, "interrupted");
    assert.deepEqual(reconciled && skillEvents(reconciled), [
      ["skill_generating", NEW_SKILL, "create"],
      ["skill_staged", NEW_SKILL, "create"],
      ["skill_generating", UPDATED_SKILL, "update"],
      ["skill_staged", UPDATED_SKILL, "update"],
      ["skill_updated", NEW_SKILL, "create"],
    ]);
  });
});

test("restart reconciliation ignores a recorded staged file whose bytes changed", async () => {
  await withExecutorHarness({
    skills: [
      { action: "create", name: NEW_SKILL },
      { action: "update", name: UPDATED_SKILL },
    ],
  }, async (harness) => {
    await new ResourceArchitectStore(harness.workspacePath).savePlan(harness.plan);
    // The receipt records the first skill, then the process exits before the
    // job file hears about it.
    await assert.rejects(runResourceUpdateBuild({
      repoRoot: harness.repoRoot,
      plan: harness.plan,
      job: createResourceBuildSnapshot({ plan: harness.plan, jobId: "job-1" }),
      store: new StoreThatExitsAt(
        harness.workspacePath,
        (saved) => saved.events.some((event) => event.type === "skill_staged"),
      ),
      maxConcurrency: 1,
    }));
    // The bytes the receipt vouches for are no longer the bytes on disk.
    fs.writeFileSync(
      stagedSkillPath(harness.repoRoot, harness.plan.id, NEW_SKILL),
      `${generatedSkill(NEW_SKILL)}\nTampered.\n`,
    );

    const reconciled = (await listJobsThroughTheApi(harness))
      .find((job) => job.jobId === "job-1");

    assert.equal(reconciled?.status, "interrupted");
    assert.deepEqual(reconciled && skillEvents(reconciled), [
      ["skill_generating", NEW_SKILL, "create"],
    ]);
  });
});

test("restart reconciliation restores staged progress from the receipt and ignores an unrecorded staged file", async () => {
  await withExecutorHarness({
    skills: [
      { action: "create", name: NEW_SKILL },
      { action: "update", name: UPDATED_SKILL },
    ],
  }, async (harness) => {
    await new ResourceArchitectStore(harness.workspacePath).savePlan(harness.plan);
    const job = createResourceBuildSnapshot({ plan: harness.plan, jobId: "job-1" });
    // The receipt records the first skill, then the process exits before the
    // job file hears about it.
    const store = new StoreThatExitsAt(
      harness.workspacePath,
      (saved) => saved.events.some((event) => event.type === "skill_staged"),
    );
    await assert.rejects(runResourceUpdateBuild({
      repoRoot: harness.repoRoot,
      plan: harness.plan,
      job,
      store,
      maxConcurrency: 1,
    }));
    // A staged document nothing recorded: bytes on disk, no receipt entry.
    const orphan = stagedSkillPath(harness.repoRoot, harness.plan.id, UPDATED_SKILL);
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, generatedSkill(UPDATED_SKILL));
    const beforeRestart = await new ResourceArchitectStore(harness.workspacePath).getJob("job-1");
    assert.deepEqual(beforeRestart && skillEvents(beforeRestart), [
      ["skill_generating", NEW_SKILL, "create"],
    ]);

    const api = await startApiServer({
      store: new FileSystemRunStore(harness.workspacePath),
      launcher: {
        async startRun() {
          return { launched: true as const, pid: 1, cwd: harness.workspacePath };
        },
      },
      workspacePath: harness.workspacePath,
      repoRootPath: harness.repoRoot,
    });
    try {
      const response = await fetch(`${api.url}/create/resource-architect/jobs`);
      assert.equal(response.status, 200);
      const listed: unknown = await response.json();
      const entries: unknown = typeof listed === "object" && listed !== null && "jobs" in listed
        ? listed.jobs
        : null;
      assert.ok(Array.isArray(entries), `expected a job list in ${JSON.stringify(listed)}`);
      // Read by the same parser the store uses, so the listing is held to it.
      const reconciled = entries
        .map((entry) => parseResourceBuildJobRecord(entry))
        .find((candidate) => candidate?.jobId === "job-1");

      assert.equal(reconciled?.status, "interrupted");
      assert.deepEqual(reconciled && skillEvents(reconciled), [
        ["skill_generating", NEW_SKILL, "create"],
        ["skill_staged", NEW_SKILL, "create"],
      ]);
    } finally {
      await api.close();
    }
  });
});
