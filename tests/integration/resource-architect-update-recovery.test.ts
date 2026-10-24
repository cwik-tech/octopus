/**
 * Durability of the update executor across process exits and concurrent edits.
 *
 * The happy path is covered by the outer acceptance journey. These cases cover
 * what the user cannot see directly: a build that dies between publishing the
 * generated Agent and writing the Team, a build that dies after the Team write,
 * and a Team someone edited between proposal and apply.
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
import { computeTeamRevision } from "../../domains/resource-architect/resource-revision.js";
import {
  createResourceBuildSnapshot,
  runResourceBuild,
  type ResourceArchitectStorePort,
} from "../../services/resource-architect-service.js";

const TEAM_ID = "contract-review-team";
const SEEDED = "michigan-contract-lawyer";
const LIBRARY_AGENT = "scoping-lawyer";
const NEW_AGENT = "drafting-completeness-lawyer";

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

function makeRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "update-recovery-"));
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
  const teamDir = path.join(repoRoot, "teams", TEAM_ID);
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, "team.yaml"),
    [
      "team:",
      `  name: "${TEAM_ID}"`,
      "  description: >",
      "    Reviews contracts.",
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
      "    experience_enabled: true",
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
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(repoRoot, "teams.yaml"),
    [
      `${TEAM_ID}:`,
      "  type: team",
      "  description: Reviews contracts.",
      `  team_path: ./teams/${TEAM_ID}`,
      "  tags: []",
      "",
    ].join("\n"),
  );
  return repoRoot;
}

function makePlan(repoRoot: string): ResourceUpdatePlan {
  return {
    id: "recovery-plan",
    kind: "resource_updates",
    operations: [{
      kind: "add_team_agents",
      target: { kind: "team", id: TEAM_ID },
      expectedRevision: computeTeamRevision(repoRoot, TEAM_ID),
      libraryAgentsToAdd: [{
        name: LIBRARY_AGENT,
        role: "Scope reviewer",
        rationale: "Reuse.",
      }],
      newAgentsToCreate: [{
        name: NEW_AGENT,
        role: "Drafting reviewer",
        description: "Checks drafting completeness.",
        rationale: "No existing Agent covers drafting gaps.",
      }],
    }],
  };
}

function makeStore(plan: ResourceUpdatePlan): ResourceArchitectStorePort {
  const jobs = new Map<string, ResourceBuildJobSnapshot>();
  return {
    savePlan: async () => undefined,
    getPlan: async (planId) => (planId === plan.id ? plan : null),
    claimPlan: () => () => undefined,
    saveJob: async (job) => {
      jobs.set(job.jobId, JSON.parse(JSON.stringify(job)) as ResourceBuildJobSnapshot);
    },
    getJob: async (jobId) => jobs.get(jobId) ?? null,
    listJobs: async () => [...jobs.values()],
  };
}

async function startGenerationProvider(): Promise<{ url: string; close(): Promise<void> }> {
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
      const plannedName =
        lastUser.match(/Planned Agent name:\s*`([^`]+)`/i)?.[1] ?? NEW_AGENT;
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
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

/** Whether a privately staged package for `agentName` is still recoverable. */
function stagedAgentPackageExists(repoRoot: string, agentName: string): boolean {
  const root = path.join(repoRoot, ".create-orchestrator", "staged-agents");
  if (!fs.existsSync(root)) return false;
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .some((entry) =>
      fs.existsSync(
        path.join(root, entry.name, "repo", "agents", agentName, `${agentName}.md`),
      ),
    );
}

function rosterNames(yaml: string): string[] {
  return [...yaml.matchAll(/^ {2}- name: "([^"]+)"$/gmu)].map((match) => match[1]!);
}

function participantNames(yaml: string): string[] {
  const lines = yaml.split("\n");
  const keyIndex = lines.findIndex((line) => /^\s*participants:\s*$/.test(line));
  if (keyIndex < 0) return [];
  const keyIndent = lines[keyIndex]!.match(/^\s*/)![0].length;
  const names: string[] = [];
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const entry = lines[index]!.match(/^(\s*)- (.*)$/);
    if (!entry || entry[1]!.length <= keyIndent) break;
    names.push(entry[2]!.trim().replace(/"/g, ""));
  }
  return names;
}

async function withHarness(
  run: (context: {
    repoRoot: string;
    teamYamlPath: string;
    plan: ResourceUpdatePlan;
    store: ResourceArchitectStorePort;
    editTeamDuring: (boundary: string) => (reached: string) => Promise<void>;
    build: (options?: {
      onPersistenceBoundary?: (boundary: string) => void | Promise<void>;
      jobId?: string;
      signal?: AbortSignal;
    }) => Promise<ResourceBuildJobSnapshot>;
  }) => Promise<void>,
): Promise<void> {
  const repoRoot = makeRepo();
  const provider = await startGenerationProvider();
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousApiUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
  process.env.OPENAI_API_KEY = "local-test-key";
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = provider.url;
  const plan = makePlan(repoRoot);
  const store = makeStore(plan);
  try {
    await run({
      repoRoot,
      teamYamlPath: path.join(repoRoot, "teams", TEAM_ID, "team.yaml"),
      plan,
      store,
      editTeamDuring: (boundary: string) => async (reached: string) => {
        if (reached !== boundary) return;
        const teamYamlPath = path.join(repoRoot, "teams", TEAM_ID, "team.yaml");
        fs.writeFileSync(
          teamYamlPath,
          `${fs.readFileSync(teamYamlPath, "utf8")}# edited by someone else\n`,
        );
      },
      build: async (options = {}) => {
        const jobId = options.jobId ?? `job-${Math.random().toString(36).slice(2)}`;
        const job = createResourceBuildSnapshot({ plan, jobId });
        await runResourceBuild({
          repoRoot,
          plan,
          job,
          store,
          provider: "openai",
          model: "local-test-model",
          ...(options.onPersistenceBoundary
            ? { onPersistenceBoundary: options.onPersistenceBoundary }
            : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        return job;
      },
    });
  } finally {
    await provider.close();
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousApiUrl === undefined) {
      delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
    } else {
      process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousApiUrl;
    }
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

test("a retry after the process exits before the Team write finishes the update exactly once", async () => {
  await withHarness(async ({ repoRoot, teamYamlPath, build }) => {
    const before = fs.readFileSync(teamYamlPath, "utf8");

    const interrupted = await build({
      onPersistenceBoundary: (boundary) => {
        if (boundary === "after_update_agents_staged") {
          throw new Error("process exited before the Team write");
        }
      },
    });

    assert.notEqual(interrupted.status, "completed");
    assert.equal(
      fs.readFileSync(teamYamlPath, "utf8"),
      before,
      "the Team must be untouched when the process dies before its write",
    );
    assert.equal(
      fs.existsSync(path.join(repoRoot, "agents", NEW_AGENT)),
      false,
      "an Agent stays unpublished until the Team write is authorized",
    );
    assert.equal(
      stagedAgentPackageExists(repoRoot, NEW_AGENT),
      true,
      "durable staged output survives the interruption",
    );

    const retried = await build();

    assert.equal(retried.status, "completed", JSON.stringify(retried, null, 2));
    assert.deepEqual(retried.items.map((item) => item.status), ["updated"]);
    const yaml = fs.readFileSync(teamYamlPath, "utf8");
    assert.deepEqual(rosterNames(yaml), [SEEDED, LIBRARY_AGENT, NEW_AGENT]);
    assert.deepEqual(participantNames(yaml), [SEEDED, LIBRARY_AGENT, NEW_AGENT]);
  });
});

test("a retry after the Team write recognizes its own result and rewrites nothing", async () => {
  await withHarness(async ({ teamYamlPath, build }) => {
    const interrupted = await build({
      onPersistenceBoundary: (boundary) => {
        if (boundary === "after_update_target_published") {
          throw new Error("process exited after the Team write");
        }
      },
    });
    assert.notEqual(interrupted.status, "completed");
    const afterFirst = fs.readFileSync(teamYamlPath, "utf8");
    assert.deepEqual(rosterNames(afterFirst), [SEEDED, LIBRARY_AGENT, NEW_AGENT]);

    const retried = await build();

    assert.equal(retried.status, "completed", JSON.stringify(retried, null, 2));
    assert.deepEqual(retried.items.map((item) => item.status), ["updated"]);
    assert.equal(
      fs.readFileSync(teamYamlPath, "utf8"),
      afterFirst,
      "a recognized result is not rewritten",
    );
  });
});

test("a Team edited after the proposal fails the operation without changing team.yaml", async () => {
  await withHarness(async ({ teamYamlPath, build }) => {
    const edited = `${fs.readFileSync(teamYamlPath, "utf8")}# edited by someone else\n`;
    fs.writeFileSync(teamYamlPath, edited);

    const job = await build();

    assert.equal(job.status, "failed", JSON.stringify(job, null, 2));
    assert.deepEqual(job.items.map((item) => item.status), ["failed"]);
    assert.ok(
      job.events.some((event) => event.type === "resource_update_conflict"),
      `expected a conflict event: ${job.events.map((event) => event.type).join(", ")}`,
    );
    assert.match(job.items[0]?.error ?? "", new RegExp(TEAM_ID));
    assert.equal(
      fs.readFileSync(teamYamlPath, "utf8"),
      edited,
      "a stale operation must not overwrite the newer Team",
    );
  });
});

test("a stale revision is refused before any Agent is generated", async () => {
  await withHarness(async ({ repoRoot, teamYamlPath, build }) => {
    fs.writeFileSync(
      teamYamlPath,
      `${fs.readFileSync(teamYamlPath, "utf8")}# edited by someone else\n`,
    );

    await build();

    assert.equal(
      fs.existsSync(path.join(repoRoot, "agents", NEW_AGENT)),
      false,
      "a conflict must be detected before provider work publishes an Agent",
    );
  });
});

test("a cancelled update names the update, not an Agent that was never touched", async () => {
  await withHarness(async ({ teamYamlPath, build }) => {
    const before = fs.readFileSync(teamYamlPath, "utf8");
    const controller = new AbortController();
    controller.abort();

    const job = await build({ signal: controller.signal });

    assert.equal(job.status, "cancelled", JSON.stringify(job, null, 2));
    assert.deepEqual(job.items.map((item) => item.status), ["cancelled"]);
    const eventTypes = job.events.map((event) => event.type);
    assert.ok(
      eventTypes.includes("resource_update_cancelled"),
      `expected a cancelled update event: ${eventTypes.join(", ")}`,
    );
    assert.equal(
      eventTypes.includes("agent_cancelled"),
      false,
      "a Team update must not report a cancelled Agent it never started",
    );
    assert.equal(fs.readFileSync(teamYamlPath, "utf8"), before);
  });
});

test("a Team edited while the Agent is generating leaves no Agent folder and no Team write", async () => {
  await withHarness(async ({ repoRoot, teamYamlPath, build, editTeamDuring }) => {
    const before = fs.readFileSync(teamYamlPath, "utf8");

    // The Agent package is generated and staged, then someone edits the Team
    // before publication. The operation must lose the race without leaving an
    // Agent nobody authorized.
    const job = await build({
      onPersistenceBoundary: editTeamDuring("after_update_agents_staged"),
    });

    assert.equal(job.status, "failed", JSON.stringify(job, null, 2));
    assert.ok(
      job.events.some((event) => event.type === "resource_update_conflict"),
      `expected a conflict event: ${job.events.map((event) => event.type).join(", ")}`,
    );
    assert.equal(
      fs.existsSync(path.join(repoRoot, "agents", NEW_AGENT)),
      false,
      "a conflicted operation must publish no Agent folder",
    );
    assert.equal(
      fs.readFileSync(teamYamlPath, "utf8"),
      `${before}# edited by someone else\n`,
      "the newer Team content survives untouched",
    );
  });
});

test("a retry after a conflict during staging publishes the Agent and the Team exactly once", async () => {
  await withHarness(async ({ repoRoot, teamYamlPath, plan, build, editTeamDuring }) => {
    await build({
      onPersistenceBoundary: editTeamDuring("after_update_agents_staged"),
    });

    // A conflict is not retryable: the server issues a fresh proposal, which
    // carries its own plan id and pins the Team as it now stands. The stale
    // plan's evidence stays where it is and must not be reused.
    Object.assign(plan, { id: "recovery-plan-second-proposal" });
    const operation = plan.operations[0];
    assert.ok(operation);
    operation.expectedRevision = computeTeamRevision(repoRoot, TEAM_ID);
    const retried = await build();

    assert.equal(retried.status, "completed", JSON.stringify(retried, null, 2));
    assert.deepEqual(retried.items.map((item) => item.status), ["updated"]);
    const yaml = fs.readFileSync(teamYamlPath, "utf8");
    assert.deepEqual(rosterNames(yaml), [SEEDED, LIBRARY_AGENT, NEW_AGENT]);
    assert.equal(fs.existsSync(path.join(repoRoot, "agents", NEW_AGENT)), true);
  });
});

test("the published receipt keeps the revision written under the lock, not a later edit", async () => {
  await withHarness(async ({ repoRoot, teamYamlPath, plan, build }) => {
    let underLockRevision: string | null = null;
    let raceBoundaryReached = false;

    const job = await build({
      onPersistenceBoundary: async (boundary) => {
        if (boundary === "after_update_intended_revision_recorded") {
          underLockRevision = readReceiptRevision(repoRoot, plan.id, 0);
          return;
        }
        // Another writer edits the Team the instant the lock is released. A
        // revision recomputed here would describe that edit instead of the
        // bytes this operation actually wrote.
        if (boundary !== "after_update_team_written") return;
        raceBoundaryReached = true;
        fs.writeFileSync(
          teamYamlPath,
          `${fs.readFileSync(teamYamlPath, "utf8")}# a later, unrelated edit\n`,
        );
      },
    });

    assert.equal(job.status, "completed", JSON.stringify(job, null, 2));
    assert.equal(
      raceBoundaryReached,
      true,
      "fixture check: the post-lock race boundary must actually fire",
    );
    assert.notEqual(underLockRevision, null, "the under-lock revision was recorded");
    assert.equal(
      readReceiptRevision(repoRoot, plan.id, 0),
      underLockRevision,
      "the published receipt must retain the exact revision supplied under the lock",
    );
  });
});

/** The `intendedRevision` this operation's receipt currently holds. */
function readReceiptRevision(
  repoRoot: string,
  planId: string,
  index: number,
): string | null {
  const file = path.join(
    repoRoot,
    ".create-orchestrator",
    "resource-updates",
    createHash("sha256").update(planId, "utf8").digest("hex"),
    `${index}.json`,
  );
  if (!fs.existsSync(file)) return null;
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null) return null;
  if (!("intendedRevision" in parsed)) return null;
  const revision = parsed.intendedRevision;
  return typeof revision === "string" ? revision : null;
}

test("a failure while recording the intended revision publishes no Agent", async () => {
  await withHarness(async ({ repoRoot, teamYamlPath, build }) => {
    const before = fs.readFileSync(teamYamlPath, "utf8");

    // Recording the revision this write will produce is the last thing that can
    // fail before the Team changes. If a package is already public by then, the
    // failure leaves an Agent nobody authorized beside an unchanged Team.
    const job = await build({
      onPersistenceBoundary: (boundary) => {
        if (boundary !== "after_update_intended_revision_recorded") return;
        throw new Error("durable evidence could not be recorded");
      },
    });

    assert.notEqual(job.status, "completed", JSON.stringify(job, null, 2));
    assert.equal(
      fs.readFileSync(teamYamlPath, "utf8"),
      before,
      "the Team must be unchanged when its evidence could not be recorded",
    );
    assert.equal(
      fs.existsSync(path.join(repoRoot, "agents", NEW_AGENT)),
      false,
      "no Agent may be public when the update that authorizes it was never recorded",
    );
  });
});

test("a conflict after staging releases its reservation and discards its transaction", async () => {
  await withHarness(async ({ repoRoot, build, editTeamDuring }) => {
    // A transaction owned by a different plan, which this operation must not
    // touch no matter what it cleans up.
    const foreign = path.join(
      repoRoot,
      ".create-orchestrator",
      "staged-agents",
      "foreign-transaction",
    );
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, "receipt.json"), `${JSON.stringify({
      version: 1,
      state: "ready",
      ownerPid: process.pid,
      createdAt: new Date().toISOString(),
      orchestratorKey: "some-other-plan",
      requestedName: "foreign-lawyer",
      agentName: "foreign-lawyer",
    })}\n`);

    // The Team changes while the Agent is being generated, so this operation
    // has already reserved a name and staged a package when it loses the race.
    let ownedBeforeConflict: { reservations: string[]; transactions: string[] } = {
      reservations: [],
      transactions: [],
    };
    const job = await build({
      onPersistenceBoundary: async (boundary) => {
        if (boundary === "after_update_agents_staged") {
          ownedBeforeConflict = {
            reservations: remainingReservations(repoRoot),
            transactions: remainingStagedTransactions(repoRoot),
          };
        }
        await editTeamDuring("after_update_agents_staged")(boundary);
      },
    });

    assert.ok(
      ownedBeforeConflict.reservations.includes(NEW_AGENT),
      `fixture check: the name was reserved before the conflict: ${ownedBeforeConflict.reservations.join(", ")}`,
    );
    assert.ok(
      ownedBeforeConflict.transactions.length > 1,
      "fixture check: this operation staged a transaction beside the foreign one",
    );

    assert.equal(job.status, "failed", JSON.stringify(job, null, 2));
    assert.ok(
      job.events.some((event) => event.type === "resource_update_conflict"),
      "the conflict is still reported",
    );
    // A revision conflict cannot succeed by retrying the same proposal, so
    // nothing this operation owned may block the fresh proposal that follows.
    assert.deepEqual(
      remainingReservations(repoRoot),
      [],
      "a conflicted operation owns no Agent name afterwards",
    );
    assert.deepEqual(
      remainingStagedTransactions(repoRoot),
      ["foreign-transaction"],
      "only this operation's own transaction is discarded; foreign evidence stays",
    );
  });
});

/** Reservation receipts still on disk, by the Agent name each one names. */
function remainingReservations(repoRoot: string): string[] {
  const root = path.join(repoRoot, ".create-orchestrator", "agent-name-reservations");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, entry), "utf8"));
      if (typeof parsed !== "object" || parsed === null) return entry;
      if (!("name" in parsed)) return entry;
      return typeof parsed.name === "string" ? parsed.name : entry;
    })
    .sort();
}

/** Staged transaction directories still present under the staging root. */
function remainingStagedTransactions(repoRoot: string): string[] {
  const root = path.join(repoRoot, ".create-orchestrator", "staged-agents");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

test("a published package that does not match its evidence fails before the Team write", async () => {
  await withHarness(async ({ repoRoot, teamYamlPath, plan, build }) => {
    // A first attempt stages and publishes the Agent, then dies before the
    // Team write.
    await build({
      onPersistenceBoundary: (boundary) => {
        if (boundary === "after_update_team_written") {
          throw new Error("process exited before the Team could be recorded");
        }
      },
    });
    const before = fs.readFileSync(teamYamlPath, "utf8");
    assert.equal(fs.existsSync(path.join(repoRoot, "agents", NEW_AGENT)), true);

    // Its ownership marker and persona still check out, but a skill file in the
    // package has been changed. Reuse must not accept it on the strength of the
    // marker alone.
    fs.writeFileSync(
      path.join(repoRoot, "agents", NEW_AGENT, "skills", `${NEW_AGENT}-review`, "SKILL.md"),
      "---\nname: tampered\ndescription: Not what was published.\n---\n",
    );

    const retried = await build();

    assert.notEqual(retried.status, "completed", JSON.stringify(retried, null, 2));
    assert.equal(
      fs.readFileSync(teamYamlPath, "utf8"),
      before,
      "the Team must not be written against a package that no longer matches",
    );
  });
});

test("a package tampered with after publication fails before the Team is written", async () => {
  await withHarness(async ({ repoRoot, teamYamlPath, build }) => {
    const before = fs.readFileSync(teamYamlPath, "utf8");
    let tampered = false;

    // The package reaches `agents/` and is changed before this same attempt
    // writes the Team. Nothing may be written against bytes that are no longer
    // the ones this operation staged.
    const job = await build({
      onPersistenceBoundary: (boundary) => {
        if (boundary !== "after_update_agent_published" || tampered) return;
        tampered = true;
        fs.writeFileSync(
          path.join(repoRoot, "agents", NEW_AGENT, `${NEW_AGENT}.md`),
          "---\nname: tampered\n---\n",
        );
      },
    });

    assert.equal(
      tampered,
      true,
      `fixture check: the publish boundary fired: ${JSON.stringify(job.events.map((event) => event.type))} ${JSON.stringify(job.items)}`,
    );
    assert.notEqual(job.status, "completed", JSON.stringify(job, null, 2));
    assert.equal(
      fs.readFileSync(teamYamlPath, "utf8"),
      before,
      "the Team must not be written against a package that changed after publication",
    );
  });
});

/**
 * A receipt is evidence for one operation, not for a shape that resembles it.
 *
 * Two proposals can agree on the Team, the revision, and the names being
 * added while describing a different Agent: same name, different role, tier,
 * description, or rationale. A package staged for one brief is not the package
 * the other asked for, and a retry that could not tell them apart would
 * publish an Agent nobody approved and add it to the Team.
 */
test("a receipt does not authorize an operation whose new Agent was described differently", async () => {
  await withHarness(async ({ repoRoot, teamYamlPath, plan, store }) => {
    const before = fs.readFileSync(teamYamlPath, "utf8");
    const interrupted = createResourceBuildSnapshot({ plan, jobId: "job-1" });
    await runResourceBuild({
      repoRoot,
      plan,
      job: interrupted,
      store,
      provider: "openai",
      model: "local-test-model",
      onPersistenceBoundary: (boundary) => {
        if (boundary === "after_update_agents_staged") {
          throw new Error("process exited before the Team write");
        }
      },
    }).catch(() => undefined);
    assert.equal(stagedAgentPackageExists(repoRoot, NEW_AGENT), true);

    const operation = plan.operations[0]!;
    assert.equal(operation.kind, "add_team_agents");
    if (operation.kind !== "add_team_agents") return;
    const reworded: ResourceUpdatePlan = {
      ...plan,
      operations: [{
        ...operation,
        newAgentsToCreate: operation.newAgentsToCreate.map((agent) => ({
          ...agent,
          role: "A completely different job",
        })),
      }],
    };
    const job = createResourceBuildSnapshot({ plan: reworded, jobId: "job-2" });

    await assert.rejects(
      runResourceBuild({
        repoRoot,
        plan: reworded,
        job,
        store,
        provider: "openai",
        model: "local-test-model",
      }),
      /does not describe this operation/,
    );

    assert.equal(
      fs.readFileSync(teamYamlPath, "utf8"),
      before,
      "evidence this operation does not own authorizes no Team write",
    );
    assert.equal(
      fs.existsSync(path.join(repoRoot, "agents", NEW_AGENT)),
      false,
      "and publishes no Agent package",
    );
  });
});


test("a staged Team update retains its new Agent skills under one Library publication scope", { timeout: 10000 }, async () => {
  // Paid generation is replaced only at the HTTP boundary by the existing loopback provider.
  await withHarness(async ({ repoRoot, teamYamlPath, plan, store }) => {
    const { ResourceLibraryService } = await import("../../services/resource-library-service.js");
    const library = new ResourceLibraryService({ repoRootPath: repoRoot, rootPath: path.join(repoRoot, ".test-library"), requireMigrationApproval: false });
    await library.initialize();
    const job = createResourceBuildSnapshot({ plan, jobId: "scoped-team-update" });
    await runResourceBuild({ repoRoot, plan, job, store, resourcePublisher: library, provider: "openai", model: "local-test-model" });
    assert.equal(job.status, "completed", job.error);
    assert.ok(fs.readFileSync(teamYamlPath, "utf8").includes(NEW_AGENT));
    const snapshot = await library.store.getSnapshot();
    assert.ok(snapshot.agents.find((agent) => agent.id === NEW_AGENT)?.attachments.some((pin) => pin.alias === `${NEW_AGENT}-review`));
  });
});
