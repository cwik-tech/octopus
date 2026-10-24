/**
 * A batch of update operations, and what the job must still be able to say
 * about it afterwards.
 *
 * Covers the contracts a single-operation journey cannot express: a partly
 * finished batch that is retried, durable evidence that does not describe this
 * operation, a store that refuses writes, out-of-order persistence, and the one
 * provider budget every generation in the job shares.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";


import type {
  ResourceBuildJobSnapshot,
  ResourceUpdatePlan,
} from "../../contracts/resource-architect.js";
import { ConcurrencySemaphore } from "../../core/rate-limiter.js";
import { computeAgentPackageHashes } from "../../domains/agent-generator/agent-package-digest.js";
import { reservePlannedAgentName } from "../../domains/agent-generator/agent-name-reservation.js";
import { createResourceUpdateGate } from "../../services/resource-update-gate.js";
import { computeTeamRevision } from "../../domains/resource-architect/resource-revision.js";
import { digestResourceUpdateOperation } from "../../domains/resource-architect/resource-update-operation-digest.js";
import {
  createResourceBuildSnapshot,
  launchBackgroundResourceBuild,
  runResourceBuild,
  type ResourceArchitectStorePort,
} from "../../services/resource-architect-service.js";
import { ResourceUpdateEvidenceError } from "../../services/resource-update-executor.js";

const FIRST_TEAM = "contract-review-team";
const SECOND_TEAM = "diligence-team";
const SEEDED = "michigan-contract-lawyer";
const LIBRARY_AGENT = "scoping-lawyer";
const PLAN_ID = "batch-plan";

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
  ].join("\n");
}

function teamYaml(teamId: string): string {
  return [
    "team:",
    `  name: "${teamId}"`,
    "workflow:",
    "  entry_level: review",
    "agents:",
    `  - name: "${SEEDED}"`,
    "    type: agent",
    "    role: >",
    "      Michigan contract reviewer",
    "    tier: strategic",
    "    tools: []",
    `    agent_file: "../../agents/${SEEDED}/${SEEDED}.md"`,
    "levels:",
    "  - id: review",
    "    name: Review",
    "    order: 0",
    "    stage:",
    "      type: discussion",
    `      coordinator: "${SEEDED}"`,
    "      participants:",
    `        - "${SEEDED}"`,
    "      config:",
    "        mode: brainstorm",
    "",
  ].join("\n");
}

function makeRepo(teamIds: readonly string[]): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "update-batch-"));
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
      "---\nprovider: openai\nmodel: local-test-model\n---\n\n" + ("Create one complete Agent package from the brief.\n"),
    );
  }
  for (const name of [SEEDED, LIBRARY_AGENT]) {
    const agentDir = path.join(repoRoot, "agents", name);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, `${name}.md`), persona(name));
  }
  const registry: string[] = [];
  for (const teamId of teamIds) {
    const teamDir = path.join(repoRoot, "teams", teamId);
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(path.join(teamDir, "team.yaml"), teamYaml(teamId));
    registry.push(
      `${teamId}:`,
      "  type: team",
      "  description: A team.",
      `  team_path: ./teams/${teamId}`,
      "  tags: []",
    );
  }
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), `${registry.join("\n")}\n`);
  return repoRoot;
}

/**
 * Where this plan's manifest must land.
 *
 * The directory name is derived the way a contained identifier has to be: from
 * a digest of the plan id, never from the id's own characters.
 */
function plannedManifestFile(repoRoot: string, index: number): string {
  return path.join(
    repoRoot,
    ".create-orchestrator",
    "resource-updates",
    createHash("sha256").update(PLAN_ID, "utf8").digest("hex"),
    `${index}.json`,
  );
}

/** Deliberately short: a long name would trip a separate naming defect. */
function newAgentFor(teamId: string): string {
  return teamId === FIRST_TEAM ? "first-drafting-lawyer" : "second-drafting-lawyer";
}

/** A second new Agent, so one operation can hold more than one provider slot. */
function extraAgentFor(teamId: string): string {
  return teamId === FIRST_TEAM ? "first-risk-lawyer" : "second-risk-lawyer";
}

function makeOperation(repoRoot: string, teamId: string) {
  return {
    kind: "add_team_agents" as const,
    target: { kind: "team" as const, id: teamId },
    expectedRevision: computeTeamRevision(repoRoot, teamId),
    libraryAgentsToAdd: [{
      name: LIBRARY_AGENT,
      role: "Scope reviewer",
      tier: "strategic",
      rationale: "Reuse.",
    }],
    newAgentsToCreate: [{
      name: newAgentFor(teamId),
      role: "Drafting reviewer",
      tier: "strategic",
      description: "Checks drafting completeness.",
      rationale: "No existing Agent covers drafting gaps.",
    }],
  };
}

function makeTwoAgentOperation(repoRoot: string, teamId: string) {
  const base = makeOperation(repoRoot, teamId);
  return {
    ...base,
    newAgentsToCreate: [
      ...base.newAgentsToCreate,
      {
        name: extraAgentFor(teamId),
        role: "Risk reviewer",
        tier: "strategic",
        description: "Checks commercial risk.",
        rationale: "No existing Agent covers risk.",
      },
    ],
  };
}

function makePlan(repoRoot: string, teamIds: readonly string[]): ResourceUpdatePlan {
  return {
    id: PLAN_ID,
    kind: "resource_updates",
    operations: teamIds.map((teamId) => makeOperation(repoRoot, teamId)),
  };
}

interface RecordingStore extends ResourceArchitectStorePort {
  saved(): ResourceBuildJobSnapshot[];
}

/** A promise a test resolves explicitly, so no case waits on a clock. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: () => settle?.() };
}

function makeStore(
  plan: ResourceUpdatePlan,
  options: {
    /** Rejects the first save this predicate selects; later saves succeed. */
    failSaveWhen?: (job: ResourceBuildJobSnapshot) => boolean;
    /**
     * Rejects a save with exactly the value returned, as often as it matches.
     *
     * Separate from `failSaveWhen` because a store may reject with something
     * that is not an Error — including nothing at all — and a case about that
     * has to be able to name the value.
     */
    rejectSaveWith?: (
      job: ResourceBuildJobSnapshot,
      call: number,
    ) => { reason: unknown } | undefined;
    /** Called with every snapshot as it is persisted, in save order. */
    observeSave?: (job: ResourceBuildJobSnapshot) => void;
    /**
     * Holds each save until the returned promise resolves. Returning
     * undefined lets the save complete immediately.
     */
    holdSave?: (
      job: ResourceBuildJobSnapshot,
      call: number,
    ) => Promise<void> | undefined;
  } = {},
): RecordingStore {
  const jobs = new Map<string, ResourceBuildJobSnapshot>();
  const saved: ResourceBuildJobSnapshot[] = [];
  let saveCount = 0;
  let alreadyFailed = false;
  return {
    savePlan: async () => undefined,
    getPlan: async (planId) => (planId === plan.id ? plan : null),
    claimPlan: () => () => undefined,
    saveJob: async (job) => {
      const call = saveCount++;
      const clone = structuredClone(job);
      if (!alreadyFailed && options.failSaveWhen?.(clone)) {
        alreadyFailed = true;
        throw new Error("job store is unavailable");
      }
      const rejection = options.rejectSaveWith?.(clone, call);
      // Thrown exactly as given. A store that rejects with no value has still
      // refused the write, and reporting it as one that did not fail would
      // finish a job whose record never landed.
      if (rejection) throw rejection.reason;
      // Awaited only when the hook actually returns a promise. Awaiting an
      // undefined result would still yield a microtask turn and let a held
      // older save resume before this newer clone is appended.
      options.observeSave?.(clone);
      const hold = options.holdSave?.(clone, call);
      if (hold) await hold;
      saved.push(clone);
      jobs.set(clone.jobId, clone);
    },
    getJob: async (jobId) => jobs.get(jobId) ?? null,
    listJobs: async () => [...jobs.values()],
    saved: () => saved,
  };
}

interface ProviderHarness {
  url: string;
  close(): Promise<void>;
  maxConcurrent(): number;
  arrivals(): number;
  /** Resolves once `count` generation requests have arrived. */
  whenArrived(count: number): Promise<void>;
  releaseAll(): void;
  releaseOne(): void;
}

async function startGenerationProvider(
  options: { hold?: boolean; failFor?: string } = {},
): Promise<ProviderHarness> {
  let active = 0;
  let maxConcurrent = 0;
  let arrivals = 0;
  const holds: Array<() => void> = [];
  let releasedNow = !options.hold;
  const arrivalWaiters: Array<{ count: number; resolve: () => void }> = [];
  const noteArrival = (): void => {
    arrivals += 1;
    for (const waiter of [...arrivalWaiters]) {
      if (arrivals >= waiter.count) {
        arrivalWaiters.splice(arrivalWaiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const lastUser = [...(body.messages ?? [])]
        .reverse()
        .find((message) => message.role === "user")?.content ?? "";
      const plannedName = lastUser.match(/Planned Agent name:\s*`([^`]+)`/i)?.[1] ?? "";
      if (options.failFor && plannedName === options.failFor) {
        // A draft that names a different Agent is refused by the identity
        // check, so this generation fails without reaching staging.
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          model: "local-test-model",
          choices: [{
            message: {
              content: JSON.stringify({
                message: "Created someone else.",
                suggestedName: "a-different-lawyer",
                personaMarkdown: persona("a-different-lawyer"),
                generatedSkills: [],
              }),
            },
          }],
        }));
        return;
      }
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      noteArrival();
      if (!releasedNow) {
        const hold = deferred();
        holds.push(hold.resolve);
        await hold.promise;
      }
      active -= 1;
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
                  "  Review a contract draft for missing clauses. Use when a",
                  "  draft needs a completeness pass before signature.",
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
  const releaseOne = (): void => {
    const next = holds.shift();
    if (next) next();
  };
  const releaseAll = (): void => {
    releasedNow = true;
    while (holds.length > 0) releaseOne();
  };
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    maxConcurrent: () => maxConcurrent,
    arrivals: () => arrivals,
    whenArrived: (count) =>
      arrivals >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => arrivalWaiters.push({ count, resolve })),
    releaseAll,
    releaseOne,
    close: () => new Promise<void>((resolve, reject) => {
      releaseAll();
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    }),
  };
}

async function withHarness(
  teamIds: readonly string[],
  run: (context: {
    repoRoot: string;
    plan: ResourceUpdatePlan;
    provider: ProviderHarness;
    build: (options?: {
      store?: ResourceArchitectStorePort;
      maxConcurrency?: number;
      jobId?: string;
      onPersistenceBoundary?: (boundary: string) => void | Promise<void>;
      generationGate?: { acquire(): Promise<void>; release(): void };
      signal?: AbortSignal;
    }) => Promise<ResourceBuildJobSnapshot>;
  }) => Promise<void>,
  providerOptions: { hold?: boolean; failFor?: string } = {},
): Promise<void> {
  const repoRoot = makeRepo(teamIds);
  const provider = await startGenerationProvider(providerOptions);
  let jobCounter = 0;
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousApiUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
  const previousCap = process.env.RESOURCE_ARCHITECT_MAX_CONCURRENT_REQUESTS;
  process.env.OPENAI_API_KEY = "local-test-key";
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = provider.url;
  const plan = makePlan(repoRoot, teamIds);
  try {
    await run({
      repoRoot,
      plan,
      provider,
      build: async (options = {}) => {
        const jobId = options.jobId ?? `batch-job-${++jobCounter}`;
        const job = createResourceBuildSnapshot({ plan, jobId });
        if (options.maxConcurrency !== undefined) {
          process.env.RESOURCE_ARCHITECT_MAX_CONCURRENT_REQUESTS = String(
            options.maxConcurrency,
          );
        }
        await runResourceBuild({
          repoRoot,
          plan,
          job,
          store: options.store ?? makeStore(plan),
          provider: "openai",
          model: "local-test-model",
          ...(options.onPersistenceBoundary
            ? { onPersistenceBoundary: options.onPersistenceBoundary }
            : {}),
          ...(options.generationGate
            ? { generationGate: options.generationGate }
            : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        return job;
      },
    });
  } finally {
    await provider.close();
    restoreEnv("OPENAI_API_KEY", previousApiKey);
    restoreEnv("WORKFLOW_GENERATOR_OPENAI_API_URL", previousApiUrl);
    restoreEnv("RESOURCE_ARCHITECT_MAX_CONCURRENT_REQUESTS", previousCap);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

function rosterNames(repoRoot: string, teamId: string): string[] {
  const yaml = fs.readFileSync(
    path.join(repoRoot, "teams", teamId, "team.yaml"),
    "utf8",
  );
  return [...yaml.matchAll(/^ {2}- name: "([^"]+)"$/gmu)].map((match) => match[1] ?? "");
}

/** The operation's manifest, found without assuming a naming scheme. */
function manifestFile(repoRoot: string, index: number): string | null {
  const root = path.join(repoRoot, ".create-orchestrator", "resource-updates");
  if (!fs.existsSync(root)) return null;
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, `${index}.json`))
    .find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** Where this plan's manifests are written, whether or not any exist yet. */
function manifestPlanDirectories(repoRoot: string): string[] {
  const root = path.join(repoRoot, ".create-orchestrator", "resource-updates");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

test("a retry of a partly finished batch recognizes the operation that already succeeded", async () => {
  await withHarness([FIRST_TEAM, SECOND_TEAM], async ({ repoRoot, plan, build }) => {
    // The second operation is pinned to a revision that no longer matches, so
    // it conflicts while the first succeeds.
    plan.operations[1] = {
      ...makeOperation(repoRoot, SECOND_TEAM),
      expectedRevision: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    };

    const first = await build();
    assert.equal(first.status, "partially_completed", JSON.stringify(first, null, 2));
    assert.deepEqual(first.items.map((item) => item.status), ["updated", "failed"]);
    const firstTeamAfter = fs.readFileSync(
      path.join(repoRoot, "teams", FIRST_TEAM, "team.yaml"),
      "utf8",
    );
    assert.notEqual(
      manifestFile(repoRoot, 0),
      null,
      "a partly finished batch keeps the successful operation's receipt",
    );

    // A retry replays the whole plan. The successful operation must be
    // recognized from its receipt rather than conflicting against its own write.
    const retried = await build();

    assert.deepEqual(retried.items.map((item) => item.status), ["updated", "failed"]);
    assert.equal(
      fs.readFileSync(path.join(repoRoot, "teams", FIRST_TEAM, "team.yaml"), "utf8"),
      firstTeamAfter,
      "a recognized operation is not written a second time",
    );
    assert.deepEqual(rosterNames(repoRoot, FIRST_TEAM), [
      SEEDED,
      LIBRARY_AGENT,
      newAgentFor(FIRST_TEAM),
    ]);
  });
});

test("durable evidence that describes another operation fails the job closed", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, build }) => {
    const before = fs.readFileSync(
      path.join(repoRoot, "teams", FIRST_TEAM, "team.yaml"),
      "utf8",
    );
    const foreign = plannedManifestFile(repoRoot, 0);
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(
      foreign,
      `${JSON.stringify({
        version: 1,
        planId: PLAN_ID,
        operationIndex: 0,
        target: { kind: "team", id: "a-completely-different-team" },
        expectedRevision: "sha256:abc",
        intendedRevision: null,
        agentsToAdd: [],
        stagedPackages: {},
        state: "staged",
      })}\n`,
    );

    await assert.rejects(build(), /does not describe this operation/);

    assert.equal(
      fs.readFileSync(path.join(repoRoot, "teams", FIRST_TEAM, "team.yaml"), "utf8"),
      before,
      "mismatched evidence must never be silently overwritten",
    );
  });
});

test("corrupt durable evidence fails the job closed", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, build }) => {
    const corrupt = plannedManifestFile(repoRoot, 0);
    fs.mkdirSync(path.dirname(corrupt), { recursive: true });
    fs.writeFileSync(corrupt, "{ this is not json\n");

    await assert.rejects(build(), /not valid JSON/);
  });
});

test("a persistence failure inside an operation is never reported as a finished build", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, plan, build }) => {
    // Exactly one mid-operation save fails, selected by what the snapshot says
    // rather than by a call count; every later save succeeds. A swallowed
    // rejection would let the job finish and be persisted as ordinary success.
    const store = makeStore(plan, {
      failSaveWhen: (job) =>
        job.events.some((event) => event.type === "agent_generating"),
    });

    const teamYamlPath = path.join(repoRoot, "teams", FIRST_TEAM, "team.yaml");
    const before = fs.readFileSync(teamYamlPath, "utf8");

    await assert.rejects(build({ store }), /job store is unavailable/);

    assert.notEqual(
      store.saved().at(-1)?.status,
      "completed",
      "a build whose persistence failed must not be recorded as completed",
    );
    assert.equal(
      fs.readFileSync(teamYamlPath, "utf8"),
      before,
      "a build that could not record itself must not have written the Team",
    );
    assert.equal(
      fs.existsSync(path.join(repoRoot, "agents", newAgentFor(FIRST_TEAM))),
      false,
      "a build that could not record itself must not have published an Agent",
    );
  });
});

/** Runs a build and reports how it settled, including a value-less rejection. */
async function settleBuild(
  run: () => Promise<ResourceBuildJobSnapshot>,
): Promise<{ rejected: boolean; reason: unknown }> {
  try {
    await run();
    return { rejected: false, reason: undefined };
  } catch (error) {
    return { rejected: true, reason: error };
  }
}

test("a job store that rejects with no reason still fails the build", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, plan, build }) => {
    // The very first save this operation makes is refused with no value at
    // all. A rejection with nothing in it is still a refusal: the job's record
    // never landed, so the build cannot report an ordinary outcome.
    let refusals = 0;
    const store = makeStore(plan, {
      rejectSaveWith: (job) => {
        if (refusals > 0) return undefined;
        if (!job.items.some((item) => item.status === "generating")) return undefined;
        refusals += 1;
        return { reason: undefined };
      },
    });
    const teamYamlPath = path.join(repoRoot, "teams", FIRST_TEAM, "team.yaml");
    const before = fs.readFileSync(teamYamlPath, "utf8");

    const settled = await settleBuild(() => build({ store }));

    assert.equal(refusals, 1, "fixture check: exactly one save was refused");
    assert.equal(settled.rejected, true, "a refused write is not a finished build");
    assert.equal(
      settled.reason,
      undefined,
      "the rejection the store raised is the one the executor reports",
    );
    assert.equal(store.saved().at(-1)?.status, "failed");
    assert.match(
      store.saved().at(-1)?.error ?? "",
      /without reporting a reason/u,
      "the recorded failure says something a person can act on",
    );
    assert.equal(
      fs.readFileSync(teamYamlPath, "utf8"),
      before,
      "a build that could not record itself must not have written the Team",
    );
    assert.equal(
      fs.existsSync(path.join(repoRoot, "agents", newAgentFor(FIRST_TEAM))),
      false,
    );
  });
});

test("a job store that rejects with null still fails the build", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, plan, build }) => {
    // `null` is a value a store can genuinely reject with, and it must not be
    // read as "no failure" any more than `undefined` is.
    let refusals = 0;
    const store = makeStore(plan, {
      rejectSaveWith: (job) => {
        if (refusals > 0) return undefined;
        if (!job.items.some((item) => item.status === "generating")) return undefined;
        refusals += 1;
        return { reason: null };
      },
    });
    const teamYamlPath = path.join(repoRoot, "teams", FIRST_TEAM, "team.yaml");
    const before = fs.readFileSync(teamYamlPath, "utf8");

    const settled = await settleBuild(() => build({ store }));

    assert.equal(refusals, 1, "fixture check: exactly one save was refused");
    assert.equal(settled.rejected, true, "a refused write is not a finished build");
    assert.equal(
      settled.reason,
      null,
      "the rejection the store raised is the one the executor reports",
    );
    assert.equal(store.saved().at(-1)?.status, "failed");
    assert.match(
      store.saved().at(-1)?.error ?? "",
      /without reporting a reason/u,
      "the recorded failure says something a person can act on",
    );
    assert.equal(
      fs.readFileSync(teamYamlPath, "utf8"),
      before,
      "a build that could not record itself must not have written the Team",
    );
    assert.equal(
      fs.existsSync(path.join(repoRoot, "agents", newAgentFor(FIRST_TEAM))),
      false,
    );
  });
});

test("the first swallowed rejection is reported, even when it carried no reason", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, plan, build }) => {
    plan.operations[0] = makeTwoAgentOperation(repoRoot, FIRST_TEAM);
    // Generation observers swallow reporting errors, so both of these are
    // recorded by the journal rather than raised where they happen. The first
    // one carried no value; the second is an ordinary Error. The build must
    // still answer for the one that happened first.
    let reservations = 0;
    const store = makeStore(plan, {
      rejectSaveWith: (job) => {
        if (job.events.at(-1)?.type !== "name_reserved") return undefined;
        reservations += 1;
        if (reservations === 1) return { reason: undefined };
        if (reservations === 2) return { reason: new Error("a later store failure") };
        return undefined;
      },
    });

    const settled = await settleBuild(() => build({ store }));

    assert.equal(reservations >= 2, true, "fixture check: both saves were refused");
    assert.equal(settled.rejected, true);
    assert.equal(
      settled.reason,
      undefined,
      "the first rejection is preserved, not replaced by the one that followed",
    );
    assert.equal(
      fs.existsSync(path.join(repoRoot, "agents", newAgentFor(FIRST_TEAM))),
      false,
    );
  });
});

test("the failure a job answers for is the first one that happened", async () => {
  await withHarness([FIRST_TEAM, SECOND_TEAM], async ({ repoRoot, plan, build }) => {
    // Durable evidence describing another operation, which the second operation
    // raises the moment it reads it. Raised loudly, and raised second.
    const foreign = plannedManifestFile(repoRoot, 1);
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(
      foreign,
      `${JSON.stringify({
        version: 1,
        planId: PLAN_ID,
        operationIndex: 1,
        target: { kind: "team", id: "a-completely-different-team" },
        expectedRevision:
          "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        intendedRevision: null,
        agentsToAdd: [],
        stagedPackages: {},
        publishedPackages: [],
        state: "staged",
      })}\n`,
    );
    // The first failure is a save the generation observers swallow, so nothing
    // else will ever report it. One operation at a time, so it is recorded
    // before the second operation reads its evidence at all.
    let swallowed = 0;
    const store = makeStore(plan, {
      rejectSaveWith: (job) => {
        const last = job.events.at(-1);
        if (last?.type !== "name_reserved") return undefined;
        if (!last.message.includes(newAgentFor(FIRST_TEAM))) return undefined;
        swallowed += 1;
        return { reason: new Error("the first store failure") };
      },
    });

    const settled = await settleBuild(() => build({ store, maxConcurrency: 1 }));

    assert.equal(swallowed, 1, "fixture check: the first failure was swallowed");
    assert.equal(settled.rejected, true);
    assert.ok(settled.reason instanceof Error, String(settled.reason));
    assert.equal(
      settled.reason.message,
      "the first store failure",
      "the earliest failure is the one reported, not the one raised loudest",
    );
    assert.match(store.saved().at(-1)?.error ?? "", /the first store failure/u);
  });
});

test("out-of-order persistence never erases a later event", async () => {
  await withHarness([FIRST_TEAM, SECOND_TEAM], async ({ plan, build }) => {
    // The first save is held open until a later save is attempted, then the
    // two are completed newest-first. Unserialized, the older snapshot would
    // land last and erase the newer one's events.
    // The first snapshot that already carries an event is held for exactly one
    // event-loop turn; every later call finishes immediately. Serialized, the
    // held call completes before the next one starts and the counts stay
    // monotonic. Unserialized, a later snapshot is appended while this one is
    // still held and the older snapshot lands last.
    let heldOnce = false;
    const store = makeStore(plan, {
      holdSave: (job) => {
        if (heldOnce || job.events.length !== 1) return undefined;
        heldOnce = true;
        return new Promise<void>((resolve) => setImmediate(resolve));
      },
    });

    const job = await build({ store, maxConcurrency: 2 });

    assert.equal(job.status, "completed", JSON.stringify(job, null, 2));
    const persisted = store.saved();
    const eventCounts = persisted.map((snapshot) => snapshot.events.length);
    assert.deepEqual(
      eventCounts,
      [...eventCounts].sort((left, right) => left - right),
      `each persisted snapshot must carry at least the events of the one before it: ${
        eventCounts.join(", ")
      }`,
    );
    assert.equal(persisted.at(-1)?.status, "completed");
  });
});

test("every generation in an update job shares one provider budget", async () => {
  await withHarness(
    [FIRST_TEAM, SECOND_TEAM],
    async ({ repoRoot, plan, provider, build }) => {
      // Two operations, two new Agents each, one budget of two. The job is
      // handed the budget it must use, so sharing is observable directly
      // rather than inferred from how many requests happened to be in flight.
      plan.operations = [
        makeTwoAgentOperation(repoRoot, FIRST_TEAM),
        makeTwoAgentOperation(repoRoot, SECOND_TEAM),
      ];
      let acquireCalls = 0;
      const budget = new ConcurrencySemaphore(2);
      const generationGate = {
        acquire: async () => {
          acquireCalls += 1;
          await budget.acquire();
        },
        release: () => budget.release(),
      };

      const running = build({ maxConcurrency: 2, generationGate });
      await provider.whenArrived(2);
      const acquiredWhileBlocked = acquireCalls;
      provider.releaseAll();
      const job = await running;

      assert.ok(
        acquiredWhileBlocked > 0,
        "every provider generation must draw on the job's shared budget",
      );
      assert.ok(
        provider.maxConcurrent() <= 2,
        `operations must not multiply the shared budget: ${provider.maxConcurrent()} concurrent`,
      );
      assert.equal(job.status, "completed", JSON.stringify(job, null, 2));
    },
    { hold: true },
  );
});

test("recovered evidence is not reported as updated while the roster lacks a member", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, build }) => {
    // A receipt this operation really did author: same plan, index, target,
    // revision and authorized names, recorded as published at the Team's
    // current content. The roster nevertheless holds neither addition, so the
    // claimed membership is not there and recovery must not confirm it.
    seedReceipt(repoRoot, {
      intendedRevision: computeTeamRevision(repoRoot, FIRST_TEAM),
      state: "published",
    });

    const job = await build();

    assert.deepEqual(
      rosterNames(repoRoot, FIRST_TEAM),
      [SEEDED],
      "fixture check: neither requested member is on the roster",
    );
    assert.notEqual(
      job.items[0]?.status,
      "updated",
      "an operation must not confirm members the roster does not hold",
    );
  });
});

test("a plan id of `..` cannot write its manifest outside the manifest root", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, plan, build }) => {
    // `encodeURIComponent("..")` is `..`, so percent-encoding the plan id is
    // not containment: this id escapes the manifest root by one directory.
    Object.assign(plan, { id: ".." });

    const manifestRoot = path.join(repoRoot, ".create-orchestrator", "resource-updates");
    // An initialized record, so the observation needs no assertion to read and
    // a boundary that never fired is visible as `reached: false`.
    const observed = {
      reached: false,
      escaped: false,
      directories: [] as string[],
    };
    // A successful operation removes its manifest, so the evidence is read at
    // the boundary and the operation is then aborted with a sentinel.
    const job = await build({
      onPersistenceBoundary: (boundary) => {
        if (boundary !== "after_update_manifest_staged") return;
        observed.reached = true;
        observed.escaped = fs.existsSync(
          path.join(path.dirname(manifestRoot), "0.json"),
        );
        observed.directories = manifestPlanDirectories(repoRoot);
        throw new Error("manifest-containment-probe");
      },
    });

    assert.equal(
      observed.reached,
      true,
      `fixture check: the manifest boundary must be reached: ${JSON.stringify(job.items)}`,
    );
    assert.equal(
      observed.escaped,
      false,
      "a manifest must never be written above its own root",
    );
    assert.deepEqual(
      observed.directories.filter((name) => !/^[0-9a-f]{64}$/.test(name)),
      [],
      `every manifest directory must be a contained digest: ${observed.directories.join(", ")}`,
    );
  });
});

/** Writes a receipt for operation 0, overriding selected fields. */
function seedReceipt(
  repoRoot: string,
  overrides: Record<string, unknown>,
): void {
  const file = plannedManifestFile(repoRoot, 0);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      version: 1,
      planId: PLAN_ID,
      operationIndex: 0,
      target: { kind: "team", id: FIRST_TEAM },
      expectedRevision: computeTeamRevision(repoRoot, FIRST_TEAM),
      // A receipt is evidence for the exact operation it was written for, so
      // a seeded one has to carry that operation's own identity.
      operationDigest: digestResourceUpdateOperation(makeOperation(repoRoot, FIRST_TEAM)),
      intendedRevision: null,
      agentsToAdd: [LIBRARY_AGENT, newAgentFor(FIRST_TEAM)],
      stagedPackages: {},
      publishedPackages: [],
      state: "staged",
      ...overrides,
    })}\n`,
  );
}

test("a receipt pinned to a different revision cannot authorize this operation", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, build }) => {
    seedReceipt(repoRoot, {
      expectedRevision:
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    });

    await assert.rejects(build(), /does not describe this operation/);
  });
});

test("a receipt naming different additions cannot authorize this operation", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, build }) => {
    seedReceipt(repoRoot, { agentsToAdd: ["some-other-lawyer"] });

    await assert.rejects(build(), /does not describe this operation/);
  });
});

test("a receipt with no package evidence field is refused", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, build }) => {
    const file = plannedManifestFile(repoRoot, 0);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const complete = {
      version: 1,
      planId: PLAN_ID,
      operationIndex: 0,
      target: { kind: "team", id: FIRST_TEAM },
      expectedRevision: computeTeamRevision(repoRoot, FIRST_TEAM),
      // A receipt is evidence for the exact operation it was written for, so
      // a seeded one has to carry that operation's own identity.
      operationDigest: digestResourceUpdateOperation(makeOperation(repoRoot, FIRST_TEAM)),
      intendedRevision: null,
      agentsToAdd: [LIBRARY_AGENT, newAgentFor(FIRST_TEAM)],
      publishedPackages: [],
      state: "staged",
    };
    fs.writeFileSync(file, `${JSON.stringify(complete)}\n`);

    await assert.rejects(build(), /does not describe this operation/);
  });
});

test("a receipt with no publication evidence field is refused", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, build }) => {
    const file = plannedManifestFile(repoRoot, 0);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Complete but for the record of which packages went public. A receipt
    // that never recorded that cannot be read as one that recorded none.
    const complete = {
      version: 1,
      planId: PLAN_ID,
      operationIndex: 0,
      target: { kind: "team", id: FIRST_TEAM },
      expectedRevision: computeTeamRevision(repoRoot, FIRST_TEAM),
      // A receipt is evidence for the exact operation it was written for, so
      // a seeded one has to carry that operation's own identity.
      operationDigest: digestResourceUpdateOperation(makeOperation(repoRoot, FIRST_TEAM)),
      intendedRevision: null,
      agentsToAdd: [LIBRARY_AGENT, newAgentFor(FIRST_TEAM)],
      stagedPackages: {},
      state: "staged",
    };
    fs.writeFileSync(file, `${JSON.stringify(complete)}\n`);

    await assert.rejects(build(), /does not describe this operation/);
  });
});

test("a receipt whose revision is not a sha256 digest is refused", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, build }) => {
    seedReceipt(repoRoot, { expectedRevision: "not-a-digest" });

    await assert.rejects(build(), /does not describe this operation/);
  });
});

test("no Agent success is recorded before the Team write that authorizes it", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, plan, build }) => {
    // A success event persisted before the Team write would be durable
    // evidence of an Agent the Team does not yet reference. Rolling a durable
    // Team write back is not possible, so the ordering itself is the contract.
    let teamWritten = false;
    const agentSuccessBeforeTeamWrite: string[] = [];
    const store = makeStore(plan, {
      observeSave: (job) => {
        if (teamWritten) return;
        for (const event of job.events) {
          if (event.type === "agent_created") agentSuccessBeforeTeamWrite.push(event.message);
        }
      },
    });

    const job = await build({
      store,
      onPersistenceBoundary: (boundary) => {
        if (boundary === "after_update_team_written") teamWritten = true;
      },
    });

    assert.equal(
      teamWritten,
      true,
      "fixture check: the Team write boundary must be reached",
    );
    assert.deepEqual(
      agentSuccessBeforeTeamWrite,
      [],
      "no persisted snapshot may carry a created-Agent event before the Team write",
    );

    // And the state the operation does reach is consistent.
    assert.equal(job.status, "completed", JSON.stringify(job, null, 2));
    assert.deepEqual(rosterNames(repoRoot, FIRST_TEAM), [
      SEEDED,
      LIBRARY_AGENT,
      newAgentFor(FIRST_TEAM),
    ]);
    assert.equal(
      fs.existsSync(path.join(repoRoot, "agents", newAgentFor(FIRST_TEAM))),
      true,
    );
    assert.notEqual(
      manifestFile(repoRoot, 0),
      null,
      "the published receipt remains available for recovery",
    );
  });
});

test("a failed generation releases its own name and leaves the staged one reserved", async () => {
  await withHarness(
    [FIRST_TEAM],
    async ({ repoRoot, plan, build }) => {
      plan.operations = [makeTwoAgentOperation(repoRoot, FIRST_TEAM)];

      const job = await build();

      assert.equal(job.status, "failed", JSON.stringify(job, null, 2));
      // The generation that failed produced nothing, so its name goes back at
      // once. The one that finished staging left a package a retry of this same
      // plan can still publish; handing that name back while the package is on
      // disk would let a different plan claim the exact name it holds.
      assert.deepEqual(
        remainingReservations(repoRoot),
        [newAgentFor(FIRST_TEAM)],
        "only the name whose package is still staged stays reserved",
      );
      assert.deepEqual(
        readyStagedPackages(repoRoot).map((entry) => entry.agentName),
        [newAgentFor(FIRST_TEAM)],
        "the retained name belongs to a package that is still on disk",
      );
    },
    { failFor: extraAgentFor(FIRST_TEAM) },
  );
});

/** Reservation receipts still on disk, by the Agent name each one names. */
function remainingReservations(repoRoot: string): string[] {
  const root = path.join(
    repoRoot,
    ".create-orchestrator",
    "agent-name-reservations",
  );
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(path.join(root, entry), "utf8"),
      );
      if (typeof parsed !== "object" || parsed === null) return entry;
      if (!("name" in parsed)) return entry;
      return typeof parsed.name === "string" ? parsed.name : entry;
    })
    .sort();
}

test("a save failure on the first created-Agent snapshot converges on retry", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, plan, build }) => {
    // Captured the first time a snapshot carries a created-Agent event. At
    // that instant the Team write must already have landed, so the Agent, the
    // roster and the receipt describe one finished update.
    const atFirstCreatedEvent = {
      observed: false,
      agentPublic: false,
      roster: [] as string[],
      receiptRevision: null as string | null,
      teamRevision: null as string | null,
      receiptPackages: [] as string[],
    };
    const failing = makeStore(plan, {
      failSaveWhen: (job) => {
        if (!job.events.some((event) => event.type === "agent_created")) return false;
        if (!atFirstCreatedEvent.observed) {
          atFirstCreatedEvent.observed = true;
          atFirstCreatedEvent.agentPublic = fs.existsSync(
            path.join(repoRoot, "agents", newAgentFor(FIRST_TEAM)),
          );
          atFirstCreatedEvent.roster = rosterNames(repoRoot, FIRST_TEAM);
          const receipt = readManifestRecord(manifestFile(repoRoot, 0) ?? "");
          atFirstCreatedEvent.receiptRevision = receipt?.intendedRevision ?? null;
          atFirstCreatedEvent.receiptPackages = Object.keys(receipt?.stagedPackages ?? {});
          atFirstCreatedEvent.teamRevision = computeTeamRevision(repoRoot, FIRST_TEAM);
        }
        return true;
      },
    });

    await assert.rejects(build({ store: failing }), /job store is unavailable/);

    assert.equal(
      atFirstCreatedEvent.observed,
      true,
      "fixture check: a created-Agent snapshot was offered to the store",
    );
    assert.equal(
      atFirstCreatedEvent.agentPublic,
      true,
      "the Agent was already public when its success was first reported",
    );
    assert.deepEqual(
      atFirstCreatedEvent.roster,
      [SEEDED, LIBRARY_AGENT, newAgentFor(FIRST_TEAM)],
      "the Team already carried the addition when its success was first reported",
    );
    assert.equal(
      atFirstCreatedEvent.receiptRevision,
      atFirstCreatedEvent.teamRevision,
      "the receipt already named the Team content on disk",
    );
    assert.deepEqual(
      atFirstCreatedEvent.receiptPackages,
      [newAgentFor(FIRST_TEAM)],
      "the receipt already carried package evidence for the published Agent",
    );

    // The failed attempt must already be self-consistent: the event that could
    // not be saved is reported only after the Team write, so the Agent, the
    // roster and the receipt all describe the same finished update.
    // A retry of the same plan then converges: the Team carries the addition
    // exactly once and the Agent is published once.
    const retried = await build();

    assert.equal(retried.status, "completed", JSON.stringify(retried, null, 2));
    assert.deepEqual(rosterNames(repoRoot, FIRST_TEAM), [
      SEEDED,
      LIBRARY_AGENT,
      newAgentFor(FIRST_TEAM),
    ]);
    assert.equal(
      fs.existsSync(path.join(repoRoot, "agents", newAgentFor(FIRST_TEAM))),
      true,
    );
    assert.notEqual(
      manifestFile(repoRoot, 0),
      null,
      "the receipt describing the converged result remains available",
    );
  });
});

test("recovery verifies every new Agent package before reporting the update applied", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, plan, build }) => {
    const first = await build();
    assert.equal(first.status, "completed", JSON.stringify(first, null, 2));

    // The Team still matches the recorded intended revision, but the Agent
    // package it references has been damaged. Reporting the update as applied
    // would confirm content that is no longer there.
    fs.writeFileSync(
      path.join(repoRoot, "agents", newAgentFor(FIRST_TEAM), `${newAgentFor(FIRST_TEAM)}.md`),
      "---\nname: tampered\n---\n",
    );

    const replayed = await build();

    assert.notEqual(
      replayed.items[0]?.status,
      "updated",
      "a damaged Agent package must not be confirmed as an applied update",
    );
  });
});

/** A manifest record read through an explicit shape guard. */
function readManifestRecord(
  file: string,
): { intendedRevision: string | null; stagedPackages: Record<string, unknown> } | null {
  if (!file || !fs.existsSync(file)) return null;
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null) return null;
  const revision = "intendedRevision" in parsed ? parsed.intendedRevision : null;
  const packages = "stagedPackages" in parsed ? parsed.stagedPackages : {};
  return {
    intendedRevision: typeof revision === "string" ? revision : null,
    stagedPackages:
      typeof packages === "object" && packages !== null && !Array.isArray(packages)
        ? { ...packages }
        : {},
  };
}

test("recovery refuses an applied update whose package evidence is incomplete", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, plan, build }) => {
    const first = await build();
    assert.equal(first.status, "completed", JSON.stringify(first, null, 2));

    // The Team still matches its intended revision, but the receipt no longer
    // carries evidence for the Agent it created, and the package is gone.
    const receiptPath = manifestFile(repoRoot, 0);
    assert.notEqual(receiptPath, null);
    const receipt: unknown = JSON.parse(fs.readFileSync(receiptPath ?? "", "utf8"));
    assert.ok(typeof receipt === "object" && receipt !== null);
    fs.writeFileSync(
      receiptPath ?? "",
      `${JSON.stringify({ ...receipt, stagedPackages: {} })}\n`,
    );
    fs.rmSync(path.join(repoRoot, "agents", newAgentFor(FIRST_TEAM)), {
      recursive: true,
      force: true,
    });

    const replayed = await build();

    assert.notEqual(
      replayed.items[0]?.status,
      "updated",
      "an update with no evidence for an Agent it created must not be confirmed",
    );
  });
});

test("a background build that rejects does not become an unhandled rejection", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, plan }) => {
    // Corrupt durable evidence makes the executor reject rather than settle an
    // operation. Launched as a background promise, that rejection must be
    // terminated at the boundary instead of escaping the process.
    const corrupt = plannedManifestFile(repoRoot, 0);
    fs.mkdirSync(path.dirname(corrupt), { recursive: true });
    fs.writeFileSync(corrupt, "{ not json\n");

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const job = createResourceBuildSnapshot({ plan, jobId: "background-job" });
      const store = makeStore(plan);
      // Exactly how the route launches it today.
      const failures: unknown[] = [];
      launchBackgroundResourceBuild(
        {
          repoRoot,
          plan,
          job,
          store,
          provider: "openai",
          model: "local-test-model",
        },
        { onFailure: (error) => failures.push(error) },
      );
      // Let the rejection settle and any unhandled-rejection callback run.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.deepEqual(
        unhandled,
        [],
        "a background build failure must be terminated, not left unhandled",
      );
      assert.equal(failures.length, 1, "the failure reaches the required handler");
      assert.match(
        failures[0] instanceof Error ? failures[0].message : String(failures[0]),
        /not valid JSON/,
        "the handler receives the original failure, not a substitute",
      );
      const persisted = await store.getJob("background-job");
      assert.equal(
        persisted?.status,
        "failed",
        "the already-recorded failed job is preserved, not rewritten as success",
      );
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

/** Staged transaction directories still present under the plan's staging root. */
function remainingStagedTransactions(repoRoot: string): string[] {
  const root = path.join(repoRoot, ".create-orchestrator", "staged-agents");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

test("a throwing background handler is contained rather than escaping the process", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, plan }) => {
    const corrupt = plannedManifestFile(repoRoot, 0);
    fs.mkdirSync(path.dirname(corrupt), { recursive: true });
    fs.writeFileSync(corrupt, "{ not json\n");

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      launchBackgroundResourceBuild(
        {
          repoRoot,
          plan,
          job: createResourceBuildSnapshot({ plan, jobId: "throwing-handler-job" }),
          store: makeStore(plan),
          provider: "openai",
          model: "local-test-model",
        },
        {
          // A reporting boundary that itself fails must not turn a recorded
          // failure into a process-level crash.
          onFailure: () => {
            throw new Error("the failure handler itself failed");
          },
          onSettled: () => {
            throw new Error("the settled handler itself failed");
          },
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.deepEqual(
        unhandled,
        [],
        "a throwing handler must be contained at the launch boundary",
      );
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

test("a generation cancelled while queued releases its name and writes nothing", async () => {
  await withHarness(
    [FIRST_TEAM],
    async ({ repoRoot, plan, provider, build }) => {
      plan.operations = [makeTwoAgentOperation(repoRoot, FIRST_TEAM)];
      const teamYamlPath = path.join(repoRoot, "teams", FIRST_TEAM, "team.yaml");
      const before = fs.readFileSync(teamYamlPath, "utf8");
      const controller = new AbortController();

      // A budget of one holds the second Agent as an unadmitted waiter while
      // the provider holds the first. Cancelling there must not leave the
      // queued Agent's name owned by a job that is over.
      let releases = 0;
      const budget = createResourceUpdateGate(1);
      const generationGate = {
        acquire: (signal?: AbortSignal) => budget.acquire(signal),
        release: () => {
          releases += 1;
          budget.release();
        },
      };

      const running = build({
        maxConcurrency: 1,
        signal: controller.signal,
        generationGate,
      });
      await provider.whenArrived(1);
      // Both names are reserved up front; only one has been admitted, so the
      // second is genuinely queued behind the held provider slot.
      const reservedWhileQueued = remainingReservations(repoRoot);
      assert.deepEqual(
        reservedWhileQueued,
        [newAgentFor(FIRST_TEAM), extraAgentFor(FIRST_TEAM)].sort(),
        "both Agent names were reserved and one is waiting",
      );
      const releasesBeforeAbort = releases;

      controller.abort();
      provider.releaseAll();
      const job = await running;

      assert.notEqual(job.status, "completed", JSON.stringify(job, null, 2));
      assert.deepEqual(
        remainingReservations(repoRoot),
        [],
        "a cancelled job owns no Agent name, admitted or queued",
      );
      assert.deepEqual(
        remainingStagedTransactions(repoRoot),
        [],
        "a cancelled job leaves no staged transaction behind",
      );
      assert.equal(
        fs.readFileSync(teamYamlPath, "utf8"),
        before,
        "a cancelled job writes no Team change",
      );
      for (const name of [newAgentFor(FIRST_TEAM), extraAgentFor(FIRST_TEAM)]) {
        assert.equal(
          fs.existsSync(path.join(repoRoot, "agents", name)),
          false,
          `a cancelled job publishes no Agent (${name})`,
        );
      }
      assert.equal(
        releases - releasesBeforeAbort,
        1,
        "only the admitted generation returned a permit; the queued waiter held none",
      );
    },
    { hold: true },
  );
});

/** The exact durable evidence one operation's receipt carries. */
function readUpdateReceipt(file: string | null): {
  intendedRevision: string | null;
  stagedPackages: Record<string, Record<string, string>>;
  publishedPackages: string[];
} {
  assert.notEqual(file, null, "the operation wrote no receipt");
  const parsed: unknown = JSON.parse(fs.readFileSync(file ?? "", "utf8"));
  assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  const record: Record<string, unknown> = { ...parsed };
  const staged = record.stagedPackages;
  const published = record.publishedPackages;
  const revision = record.intendedRevision;
  const stagedPackages: Record<string, Record<string, string>> = {};
  if (typeof staged === "object" && staged !== null && !Array.isArray(staged)) {
    for (const [name, hashes] of Object.entries(staged)) {
      const entry: Record<string, string> = {};
      if (typeof hashes === "object" && hashes !== null && !Array.isArray(hashes)) {
        for (const [relativePath, digest] of Object.entries(hashes)) {
          if (typeof digest === "string") entry[relativePath] = digest;
        }
      }
      stagedPackages[name] = entry;
    }
  }
  return {
    intendedRevision: typeof revision === "string" ? revision : null,
    stagedPackages,
    publishedPackages: Array.isArray(published)
      ? published.filter((name): name is string => typeof name === "string")
      : [],
  };
}

/** Ready staged packages under the staging root, with the evidence each holds. */
function readyStagedPackages(repoRoot: string): Array<{
  orchestratorKey: string;
  agentName: string;
  packagePath: string;
  personaNames: string | null;
}> {
  const root = path.join(repoRoot, ".create-orchestrator", "staged-agents");
  if (!fs.existsSync(root)) return [];
  const found: Array<{
    orchestratorKey: string;
    agentName: string;
    packagePath: string;
    personaNames: string | null;
  }> = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const receiptPath = path.join(root, entry.name, "receipt.json");
    if (!fs.existsSync(receiptPath)) continue;
    const parsed: unknown = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const receipt: Record<string, unknown> = { ...parsed };
    if (receipt.state !== "ready") continue;
    const agentName = typeof receipt.agentName === "string" ? receipt.agentName : "";
    const packagePath = path.join(root, entry.name, "repo", "agents", agentName);
    const personaPath = path.join(packagePath, `${agentName}.md`);
    found.push({
      orchestratorKey:
        typeof receipt.orchestratorKey === "string" ? receipt.orchestratorKey : "",
      agentName,
      packagePath,
      personaNames: fs.existsSync(personaPath)
        ? fs.readFileSync(personaPath, "utf8").match(/^name:\s*(\S+)$/mu)?.[1] ?? null
        : null,
    });
  }
  return found.sort((left, right) => left.agentName.localeCompare(right.agentName));
}

/** Writes reservation evidence for one name, exactly as given. */
function writeReservationFile(repoRoot: string, name: string, contents: string): void {
  const digest = createHash("sha256").update(name, "utf8").digest("hex");
  const file = path.join(
    repoRoot,
    ".create-orchestrator",
    "agent-name-reservations",
    `${digest}.json`,
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

/** Reservation files on disk, by file name, whatever they contain. */
function reservationFiles(repoRoot: string): string[] {
  const root = path.join(repoRoot, ".create-orchestrator", "agent-name-reservations");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).sort();
}

/** The reservation file one Agent name maps to, whether or not it exists. */
function reservationFileFor(name: string): string {
  return `${createHash("sha256").update(name, "utf8").digest("hex")}.json`;
}

/** Durable evidence another plan owns, which this one must never disturb. */
function writeForeignReservation(repoRoot: string, name: string): void {
  writeReservationFile(
    repoRoot,
    name,
    `${JSON.stringify({
      version: 1,
      planId: "a-different-plan",
      jobId: "a-different-job",
      name,
      createdAt: "2026-01-01T00:00:00.000Z",
    })}\n`,
  );
}

/** The messages one job reported as Agent creations, in event order. */
function createdAgentMessages(job: ResourceBuildJobSnapshot): string[] {
  return job.events
    .filter((event) => event.type === "agent_created")
    .map((event) => event.message);
}

test("an update interrupted between two Agent publications converges on the same plan", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, plan, build }) => {
    plan.operations[0] = makeTwoAgentOperation(repoRoot, FIRST_TEAM);
    const first = newAgentFor(FIRST_TEAM);
    const second = extraAgentFor(FIRST_TEAM);
    const teamYamlPath = path.join(repoRoot, "teams", FIRST_TEAM, "team.yaml");
    const teamBefore = fs.readFileSync(teamYamlPath, "utf8");
    writeForeignReservation(repoRoot, "foreign-lawyer");

    // Publication moves one package at a time; no filesystem transaction spans
    // two renames. This attempt fails the instant the first package reaches
    // `agents/`, so the second never renames and the Team is never written.
    let publications = 0;
    const interrupted = await build({
      onPersistenceBoundary: (boundary) => {
        if (boundary !== "after_update_agent_published") return;
        publications += 1;
        if (publications === 1) {
          throw new Error("publication was interrupted after the first package");
        }
      },
    });

    assert.equal(publications, 1, "fixture check: exactly one package was published");
    assert.equal(interrupted.status, "failed", JSON.stringify(interrupted, null, 2));
    assert.equal(
      fs.readFileSync(teamYamlPath, "utf8"),
      teamBefore,
      "an interrupted publication writes no Team change",
    );
    assert.deepEqual(
      createdAgentMessages(interrupted),
      [],
      "no Agent success is reported without the Team write that authorizes it",
    );

    const afterInterruption = readUpdateReceipt(manifestFile(repoRoot, 0));
    assert.deepEqual(
      afterInterruption.publishedPackages,
      [first],
      "the receipt names exactly the package that reached agents/",
    );
    assert.deepEqual(
      Object.keys(afterInterruption.stagedPackages).sort(),
      [first, second].sort(),
      "content evidence is kept for both packages",
    );
    assert.deepEqual(
      // Spread rather than compared directly: package evidence is built on a
      // null prototype so a file named `__proto__` cannot vanish from it, and
      // `deepStrictEqual` compares prototypes as well as entries.
      { ...(await computeAgentPackageHashes(path.join(repoRoot, "agents", first))) },
      { ...afterInterruption.stagedPackages[first] },
      "the published package still holds exactly the bytes the receipt recorded",
    );

    // The package that never published is still ready to publish, owned by this
    // plan, and its name is still reserved for it. A retry has to be able to
    // take both over; a name handed back while the package remains would let a
    // different plan claim it.
    const stagedAfterInterruption = readyStagedPackages(repoRoot);
    assert.deepEqual(
      stagedAfterInterruption.map((entry) => entry.agentName),
      [second],
      "exactly one package is left staged",
    );
    assert.equal(stagedAfterInterruption[0]?.orchestratorKey, PLAN_ID);
    assert.equal(stagedAfterInterruption[0]?.personaNames, second);
    assert.deepEqual(
      { ...(await computeAgentPackageHashes(stagedAfterInterruption[0]?.packagePath ?? "")) },
      { ...afterInterruption.stagedPackages[second] },
      "the staged package matches the evidence the receipt recorded for it",
    );
    // Only the private package needs its name held. The published one is
    // already protected by the ownership marker in its final folder, so keeping
    // a receipt for it as well would be a second claim nothing gives back.
    assert.deepEqual(
      remainingReservations(repoRoot),
      ["foreign-lawyer", second].sort(),
      "the staged package keeps its name; the published one needs no receipt",
    );

    let teamWrites = 0;
    let retryPublications = 0;
    const retried = await build({
      onPersistenceBoundary: (boundary) => {
        if (boundary === "after_update_team_written") teamWrites += 1;
        if (boundary === "after_update_agent_published") retryPublications += 1;
      },
    });

    assert.equal(retried.status, "completed", JSON.stringify(retried, null, 2));
    assert.deepEqual(retried.items.map((item) => item.status), ["updated"]);
    assert.equal(
      retryPublications,
      1,
      "the retry publishes only the package that was still staged",
    );
    assert.equal(teamWrites, 1, "the retry writes the Team exactly once");
    assert.deepEqual(rosterNames(repoRoot, FIRST_TEAM), [
      SEEDED,
      LIBRARY_AGENT,
      first,
      second,
    ]);
    assert.equal(fs.existsSync(path.join(repoRoot, "agents", second)), true);

    const afterRetry = readUpdateReceipt(manifestFile(repoRoot, 0));
    assert.deepEqual(
      afterRetry.publishedPackages,
      [first, second],
      "the receipt names both packages exactly once, in plan order",
    );
    assert.deepEqual(
      afterRetry.stagedPackages[first],
      afterInterruption.stagedPackages[first],
      "the retry keeps the exact hashes recorded for the package it recovered",
    );
    assert.deepEqual(
      { ...(await computeAgentPackageHashes(path.join(repoRoot, "agents", first))) },
      { ...afterRetry.stagedPackages[first] },
      "the recovered package is still the package this operation published",
    );
    assert.deepEqual(
      Object.keys(afterRetry.stagedPackages).sort(),
      [first, second].sort(),
      "the retry records content evidence for both packages",
    );

    // The package this operation published in the interrupted attempt is its
    // own work, not a library Agent someone else already owned.
    assert.deepEqual(
      retried.events
        .filter((event) => event.type === "agent_reused")
        .map((event) => event.resource?.id),
      [LIBRARY_AGENT],
      "only the library Agent is reported as reused",
    );
    const created = createdAgentMessages(retried);
    assert.equal(created.length, 2, JSON.stringify(created));
    assert.match(
      created.find((message) => message.includes(`\`${first}\``)) ?? "",
      /earlier attempt/u,
      "the recovered package says it came from this update's earlier attempt",
    );
    assert.match(
      created.find((message) => message.includes(`\`${second}\``)) ?? "",
      /^Created Agent/u,
      "the package published now is reported as created now",
    );

    assert.deepEqual(
      remainingReservations(repoRoot),
      ["foreign-lawyer"],
      "converging gives back every name this plan owned and touches no other",
    );
    assert.deepEqual(
      readyStagedPackages(repoRoot).map((entry) => entry.agentName),
      [],
      "converging leaves no staged package behind",
    );
  });
});

test("a package published before the receipt could name it is still recognized", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, plan, build }) => {
    plan.operations[0] = makeTwoAgentOperation(repoRoot, FIRST_TEAM);
    const first = newAgentFor(FIRST_TEAM);
    const second = extraAgentFor(FIRST_TEAM);

    let publications = 0;
    await build({
      onPersistenceBoundary: (boundary) => {
        if (boundary !== "after_update_agent_published") return;
        publications += 1;
        if (publications === 1) {
          throw new Error("publication was interrupted after the first package");
        }
      },
    });

    // A rename and the record that names it are two steps. This is the state a
    // process that exits between them leaves: the package is public and its
    // hashes are recorded, but the receipt never got as far as naming it.
    const receiptPath = manifestFile(repoRoot, 0);
    assert.notEqual(receiptPath, null);
    const stored: unknown = JSON.parse(fs.readFileSync(receiptPath ?? "", "utf8"));
    assert.ok(typeof stored === "object" && stored !== null && !Array.isArray(stored));
    fs.writeFileSync(
      receiptPath ?? "",
      `${JSON.stringify({ ...stored, publishedPackages: [] })}\n`,
    );

    let retryPublications = 0;
    const retried = await build({
      onPersistenceBoundary: (boundary) => {
        if (boundary === "after_update_agent_published") retryPublications += 1;
      },
    });

    assert.equal(retried.status, "completed", JSON.stringify(retried, null, 2));
    assert.equal(
      retryPublications,
      1,
      "a package already on disk is recognized rather than published again",
    );
    assert.deepEqual(
      readUpdateReceipt(manifestFile(repoRoot, 0)).publishedPackages,
      [first, second],
      "the receipt ends up naming both packages, in plan order",
    );
    assert.deepEqual(rosterNames(repoRoot, FIRST_TEAM), [
      SEEDED,
      LIBRARY_AGENT,
      first,
      second,
    ]);
  });
});

test("a name a killed job reserved is given back once its package is recognized", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, plan, build }) => {
    plan.operations[0] = makeTwoAgentOperation(repoRoot, FIRST_TEAM);
    const first = newAgentFor(FIRST_TEAM);
    const second = extraAgentFor(FIRST_TEAM);
    writeForeignReservation(repoRoot, "foreign-lawyer");
    // Evidence this module cannot read belongs to nobody this plan can speak
    // for, so it must survive untouched.
    writeReservationFile(repoRoot, "unreadable-lawyer", "not json\n");

    let publications = 0;
    await build({
      onPersistenceBoundary: (boundary) => {
        if (boundary !== "after_update_agent_published") return;
        publications += 1;
        if (publications === 1) {
          throw new Error("publication was interrupted after the first package");
        }
      },
    });

    // A job that is killed never runs its own cleanup, so the name it reserved
    // for the package it did publish is still recorded as owned by that job. A
    // later job of the same plan is the only thing that can give it back.
    writeReservationFile(
      repoRoot,
      first,
      `${JSON.stringify({
        version: 1,
        planId: PLAN_ID,
        jobId: "a-job-that-was-killed",
        name: first,
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );

    const retried = await build();

    assert.equal(retried.status, "completed", JSON.stringify(retried, null, 2));
    assert.deepEqual(rosterNames(repoRoot, FIRST_TEAM), [
      SEEDED,
      LIBRARY_AGENT,
      first,
      second,
    ]);
    const files = reservationFiles(repoRoot);
    assert.equal(
      files.includes(reservationFileFor(first)),
      false,
      "the killed job's reservation for the recovered package is given back",
    );
    assert.equal(
      files.includes(reservationFileFor(second)),
      false,
      "the name this attempt published is given back too",
    );
    assert.equal(
      files.includes(reservationFileFor("foreign-lawyer")),
      true,
      "another plan's reservation is untouched",
    );
    assert.equal(
      files.includes(reservationFileFor("unreadable-lawyer")),
      true,
      "evidence this module cannot read is never removed",
    );
  });
});

test("a retry interrupted while restaging keeps the evidence it inherited", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, plan, build }) => {
    plan.operations[0] = makeTwoAgentOperation(repoRoot, FIRST_TEAM);
    const first = newAgentFor(FIRST_TEAM);
    const second = extraAgentFor(FIRST_TEAM);

    let publications = 0;
    await build({
      onPersistenceBoundary: (boundary) => {
        if (boundary !== "after_update_agent_published") return;
        publications += 1;
        if (publications === 1) {
          throw new Error("publication was interrupted after the first package");
        }
      },
    });

    // The retry rewrites its receipt before it restages anything. If that write
    // dropped the hashes its earlier attempt recorded, the package already in
    // `agents/` would stop being recognizable and no later attempt could
    // finish. This attempt stops in exactly that window.
    const interruptedRetry = await build({
      onPersistenceBoundary: (boundary) => {
        if (boundary === "after_update_manifest_staged") {
          throw new Error("the retry was interrupted while restaging");
        }
      },
    });
    assert.equal(interruptedRetry.status, "failed", JSON.stringify(interruptedRetry, null, 2));

    const finished = await build();

    assert.equal(finished.status, "completed", JSON.stringify(finished, null, 2));
    assert.deepEqual(rosterNames(repoRoot, FIRST_TEAM), [
      SEEDED,
      LIBRARY_AGENT,
      first,
      second,
    ]);
    assert.deepEqual(
      readUpdateReceipt(manifestFile(repoRoot, 0)).publishedPackages,
      [first, second],
    );
  });
});

test("a converged two-Agent update reports the same result when the plan is applied again", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, plan, build }) => {
    plan.operations[0] = makeTwoAgentOperation(repoRoot, FIRST_TEAM);
    const first = newAgentFor(FIRST_TEAM);
    const second = extraAgentFor(FIRST_TEAM);

    let publications = 0;
    await build({
      onPersistenceBoundary: (boundary) => {
        if (boundary !== "after_update_agent_published") return;
        publications += 1;
        if (publications === 1) {
          throw new Error("publication was interrupted after the first package");
        }
      },
    });
    const converged = await build();
    assert.equal(converged.status, "completed", JSON.stringify(converged, null, 2));
    const teamAfter = fs.readFileSync(
      path.join(repoRoot, "teams", FIRST_TEAM, "team.yaml"),
      "utf8",
    );

    // The Team already matches the revision this operation recorded, so the
    // replay must recognize both packages it created rather than checking
    // evidence that no longer describes what it published.
    const replayed = await build();

    assert.equal(replayed.status, "completed", JSON.stringify(replayed, null, 2));
    assert.deepEqual(replayed.items.map((item) => item.status), ["updated"]);
    assert.equal(
      fs.readFileSync(path.join(repoRoot, "teams", FIRST_TEAM, "team.yaml"), "utf8"),
      teamAfter,
      "a recognized update is not written a second time",
    );
    assert.deepEqual(rosterNames(repoRoot, FIRST_TEAM), [
      SEEDED,
      LIBRARY_AGENT,
      first,
      second,
    ]);
    assert.ok(
      replayed.events.some(
        (event) =>
          event.type === "resource_update_applied" &&
          event.message.includes("already carries this update"),
      ),
      JSON.stringify(replayed.events, null, 2),
    );
  });
});

/**
 * A cancelled reservation phase gives every name back.
 *
 * Names are reserved one at a time, and the abort check sits outside the loop
 * body. A withdrawal after the first name is reserved therefore threw before
 * anything could be staged, and the executor can only release what reached its
 * staged list — so the first name stayed reserved for good. A terminal
 * cancelled job is not restart-reconciled, so nothing would ever clear it and
 * the user's next proposal could not use that name.
 */
test("a withdrawal during the reservation phase leaves no name reserved", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, plan }) => {
    const twoAgentPlan: ResourceUpdatePlan = {
      ...plan,
      operations: [makeTwoAgentOperation(repoRoot, FIRST_TEAM)],
    };
    const controller = new AbortController();
    const inner = makeStore(twoAgentPlan);
    // Withdrawn the moment the first name is reserved, which is exactly the
    // window where the loop can throw between two reservations.
    const store: ResourceArchitectStorePort = {
      ...inner,
      saveJob: async (job) => {
        await inner.saveJob(job);
        if (job.events.some((event) => event.type === "name_reserved")) {
          controller.abort();
        }
      },
    };
    const job = createResourceBuildSnapshot({ plan: twoAgentPlan, jobId: "cancelled-job" });

    await runResourceBuild({
      repoRoot,
      plan: twoAgentPlan,
      job,
      store,
      provider: "openai",
      model: "local-test-model",
      signal: controller.signal,
    }).catch(() => undefined);

    assert.deepEqual(
      remainingReservations(repoRoot),
      [],
      "a cancelled build holds no Agent name",
    );
  });
});

/**
 * An operation that cannot be fixed by retrying gives its names back.
 *
 * A second Agent whose name is unavailable, or whose brief the model has to
 * revise, needs a fresh proposal — this stored plan carries the name that is
 * already taken. Keeping the first Agent's staged package and reservation
 * would then strand the user: the old plan still owns that name, so the new
 * proposal cannot claim it and neither plan can finish.
 */
test("an unusable name in one operation releases the whole operation's work", async () => {
  await withHarness([FIRST_TEAM], async ({ repoRoot, plan }) => {
    const twoAgentPlan: ResourceUpdatePlan = {
      ...plan,
      operations: [makeTwoAgentOperation(repoRoot, FIRST_TEAM)],
    };
    const store = makeStore(twoAgentPlan);
    const operation = twoAgentPlan.operations[0];
    assert.ok(operation && operation.kind === "add_team_agents");
    const blockedName = operation.newAgentsToCreate[1]?.name;
    assert.ok(blockedName, "fixture check: the operation creates a second Agent");
    // Somebody else's live plan already holds the second name, so this plan
    // can never reserve it.
    await reservePlannedAgentName({
      repoRoot,
      planId: "another-live-plan",
      jobId: "another-job",
      name: blockedName,
    });
    const job = createResourceBuildSnapshot({ plan: twoAgentPlan, jobId: "needs-input-job" });

    await runResourceBuild({
      repoRoot,
      plan: twoAgentPlan,
      job,
      store,
      provider: "openai",
      model: "local-test-model",
    }).catch(() => undefined);

    assert.deepEqual(
      remainingStagedTransactions(repoRoot),
      [],
      "the first Agent's staged package is given back, not kept for a retry",
    );
    assert.deepEqual(
      remainingReservations(repoRoot).filter((name) => name !== blockedName),
      [],
      "and so is its name",
    );
    assert.ok(
      job.events.some((event) => /fresh proposal/i.test(event.message)),
      `expected the job to say a fresh proposal is needed: ${
        job.events.map((event) => event.message).join(" | ")
      }`,
    );
  });
});
