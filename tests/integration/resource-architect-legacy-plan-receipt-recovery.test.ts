/**
 * A plan file older than the retirement of model grades, recovered for real.
 *
 * Authoring no longer produces a grade, and nothing new writes one. Files
 * written before that still hold one, and an update operation is identified by
 * a digest over the operation exactly as stored. So a stored grade is not
 * decoration: it is part of the identity the run's own receipt names. Read the
 * file back without it and the digest changes, `readManifest` refuses the
 * receipt, and an update that already published its Agent and wrote its Team
 * can neither finish nor be retried.
 *
 * The parser control beside this one (`resource-update-legacy-record-identity`)
 * shows the digest is stable across a read. It cannot show that the executor
 * accepts the receipt, that recovery adopts published work instead of
 * regenerating it, or that a different plan cannot claim the same receipt.
 * That is what this fixture is for, and it uses the real filesystem store, a
 * real repository, a real receipt written by a real interrupted run, and a
 * second store instance that has never seen any of it.
 *
 * The provider is a loopback this test owns, and every generation is counted.
 * A recovery that quietly regenerated the Agent would still produce a passing
 * Team, so the count is the only thing that can tell the two apart.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { PersistedResourceUpdatePlan } from "../../contracts/resource-architect-persisted.js";
import { digestResourceUpdateOperation } from "../../domains/resource-architect/resource-update-operation-digest.js";
import { computeTeamRevision } from "../../domains/resource-architect/resource-revision.js";
import { ResourceArchitectStore } from "../../server/resource-architect-store.js";
import {
  createResourceBuildSnapshot,
  runResourceBuild,
} from "../../services/resource-architect-service.js";

const TEAM_ID = "contract-review-team";
const SEEDED = "michigan-contract-lawyer";
const LIBRARY_AGENT = "scoping-lawyer";
const NEW_AGENT = "drafting-completeness-lawyer";
const PLAN_ID = "legacy-grade-plan";

/** The grade an older proposal recorded. Nothing new writes this. */
const LEGACY_GRADE = "strategic";

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
  for (const name of [SEEDED, LIBRARY_AGENT]) {
    fs.mkdirSync(path.join(repoRoot, "agents", name), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "agents", name, `${name}.md`), persona(name));
  }
  fs.mkdirSync(path.join(repoRoot, "teams", TEAM_ID), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "teams", TEAM_ID, "team.yaml"),
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
}

/**
 * The plan as an older server wrote it: a grade on every planned Agent.
 *
 * Built through the persisted contract rather than forced past the authoring
 * types, which is the point of that contract existing.
 */
function legacyPlan(repoRoot: string): PersistedResourceUpdatePlan {
  return {
    id: PLAN_ID,
    kind: "resource_updates",
    operations: [{
      kind: "add_team_agents",
      target: { kind: "team", id: TEAM_ID },
      expectedRevision: computeTeamRevision(repoRoot, TEAM_ID),
      libraryAgentsToAdd: [{
        name: LIBRARY_AGENT,
        role: "Scope reviewer",
        rationale: "Reuse.",
        tier: LEGACY_GRADE,
      }],
      newAgentsToCreate: [{
        name: NEW_AGENT,
        role: "Drafting reviewer",
        description: "Checks drafting completeness.",
        rationale: "No existing Agent covers drafting gaps.",
        tier: LEGACY_GRADE,
      }],
    }],
  };
}

/**
 * The same stored plan with one Agent's text changed and nothing else.
 *
 * Derived from the original rather than rebuilt, because rebuilding would
 * recompute `expectedRevision` against the Team the first attempt has already
 * written. A control carrying a second difference proves nothing about the
 * digest: `readManifest` refuses a mismatched revision on its own, and would
 * keep refusing with the digest comparison deleted.
 */
function withChangedAgentText(
  plan: PersistedResourceUpdatePlan,
  overrides: { role?: string; description?: string },
): PersistedResourceUpdatePlan {
  const operation = plan.operations[0]!;
  assert.equal(operation.kind, "add_team_agents");
  assert.ok(operation.kind === "add_team_agents");
  const planned = operation.newAgentsToCreate[0]!;
  return {
    ...plan,
    operations: [{
      ...operation,
      newAgentsToCreate: [{
        ...planned,
        ...(overrides.role === undefined ? {} : { role: overrides.role }),
        ...(overrides.description === undefined
          ? {}
          : { description: overrides.description }),
      }],
    }],
  };
}

/** Where `ResourceArchitectStore` keeps a plan, so the fixture can seed one. */
function planFilePath(workspacePath: string, planId: string): string {
  return path.join(
    workspacePath,
    "resource-architect-plans",
    `${createHash("sha256").update(planId, "utf8").digest("hex")}.json`,
  );
}

/** Where the executor keeps this operation's receipt. */
function receiptPath(repoRoot: string, planId: string, index: number): string {
  return path.join(
    repoRoot,
    ".create-orchestrator",
    "resource-updates",
    createHash("sha256").update(planId, "utf8").digest("hex"),
    `${index}.json`,
  );
}

function writePlanFile(workspacePath: string, plan: PersistedResourceUpdatePlan): void {
  const file = planFilePath(workspacePath, plan.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`);
}

interface Provider {
  readonly url: string;
  readonly generationCount: () => number;
  readonly close: () => Promise<void>;
}

/** The only endpoint any generation in this test may reach. */
async function startGenerationProvider(): Promise<Provider> {
  let generations = 0;
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
      generations += 1;
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
    generationCount: () => generations,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

interface Harness {
  readonly repoRoot: string;
  readonly workspacePath: string;
  readonly teamYamlPath: string;
  readonly provider: Provider;
  /**
   * One attempt, through a store instance that has never been used before.
   *
   * A fresh store is what makes this a reload: the first attempt's plan is
   * still in another store's memory map, so a shared instance would answer from
   * there and never touch the file the test wrote.
   */
  readonly attempt: (options?: {
    jobId?: string;
    onPersistenceBoundary?: (boundary: string) => void | Promise<void>;
  }) => Promise<ReturnType<typeof createResourceBuildSnapshot>>;
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "legacy-plan-recovery-")),
  );
  const repoRoot = path.join(directory, "project");
  const workspacePath = path.join(directory, "workspace");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  seedRepo(repoRoot);
  const provider = await startGenerationProvider();
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousApiUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
  process.env.OPENAI_API_KEY = "local-test-key";
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = provider.url;
  try {
    await run({
      repoRoot,
      workspacePath,
      teamYamlPath: path.join(repoRoot, "teams", TEAM_ID, "team.yaml"),
      provider,
      attempt: async (options = {}) => {
        const store = new ResourceArchitectStore(workspacePath);
        const plan = await store.getPlan(PLAN_ID);
        assert.ok(plan, "the seeded plan file must be readable");
        const job = createResourceBuildSnapshot({
          plan,
          jobId: options.jobId ?? "job-1",
        });
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
        });
        return job;
      },
    });
  } finally {
    await provider.close();
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousApiUrl === undefined) delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
    else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousApiUrl;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function rosterNames(yaml: string): string[] {
  return [...yaml.matchAll(/^ {2}- name: "([^"]+)"$/gmu)].map((match) => match[1]!);
}

function readReceipt(repoRoot: string): { operationDigest?: unknown; state?: unknown } {
  return JSON.parse(fs.readFileSync(receiptPath(repoRoot, PLAN_ID, 0), "utf8")) as {
    operationDigest?: unknown;
    state?: unknown;
  };
}

test("a legacy plan reloaded from disk adopts the receipt its own interrupted run wrote", async () => {
  await withHarness(async ({ repoRoot, workspacePath, teamYamlPath, provider, attempt }) => {
    const stored = legacyPlan(repoRoot);
    writePlanFile(workspacePath, stored);
    // Pinned so "no migration" is something this test can fail on. Reading a
    // legacy plan must never rewrite it into the current shape: the bytes on
    // disk are the operation's identity, and a helpful rewrite would silently
    // invalidate every receipt already written against them.
    const planFileBytes = fs.readFileSync(planFilePath(workspacePath, PLAN_ID));

    // The first attempt writes the Team and publishes the Agent, then stops the
    // way a process exit does: after the receipt says `published` and before
    // the operation could be reported finished. The failure is the operation's,
    // not the executor's, so the job comes back unfinished rather than raising.
    const interrupted = await attempt({
      jobId: "job-interrupted",
      onPersistenceBoundary: (boundary) => {
        if (boundary === "after_update_target_published") {
          throw new Error("process exited after the Team write");
        }
      },
    });
    assert.notEqual(interrupted.status, "completed", JSON.stringify(interrupted, null, 2));

    const publishedTeam = fs.readFileSync(teamYamlPath, "utf8");
    const publishedPersona = fs.readFileSync(
      path.join(repoRoot, "agents", NEW_AGENT, `${NEW_AGENT}.md`),
      "utf8",
    );
    assert.deepEqual(rosterNames(publishedTeam), [SEEDED, LIBRARY_AGENT, NEW_AGENT]);
    assert.equal(provider.generationCount(), 1, "the Agent is generated once");

    // The receipt names the operation as it is stored, grade included. This is
    // the assertion the legacy field exists for: the digest is computed here
    // from the literal the fixture wrote to disk, so a reader that dropped the
    // field would produce a receipt this cannot match.
    const receipt = readReceipt(repoRoot);
    assert.equal(receipt.state, "published");
    assert.equal(
      receipt.operationDigest,
      digestResourceUpdateOperation(stored.operations[0]!),
      "the receipt must name the operation exactly as the plan file stores it",
    );

    // A new store, a new job: nothing carried over in memory.
    const recovered = await attempt({ jobId: "job-recovered" });

    assert.equal(recovered.status, "completed", JSON.stringify(recovered, null, 2));
    assert.deepEqual(recovered.items.map((item) => item.status), ["updated"]);
    assert.equal(
      provider.generationCount(),
      1,
      "recovery must adopt the published Agent, not generate a second one",
    );
    assert.equal(
      fs.readFileSync(teamYamlPath, "utf8"),
      publishedTeam,
      "recovery must not rewrite the Team it already wrote",
    );
    assert.equal(
      fs.readFileSync(
        path.join(repoRoot, "agents", NEW_AGENT, `${NEW_AGENT}.md`),
        "utf8",
      ),
      publishedPersona,
      "recovery must not rewrite the Agent package it already published",
    );
    assert.deepEqual(
      fs.readFileSync(planFilePath(workspacePath, PLAN_ID)),
      planFileBytes,
      "reading a legacy plan must leave the stored file exactly as it was",
    );
  });
});

for (const control of [
  { label: "role", overrides: { role: "Completeness reviewer" } },
  { label: "brief", overrides: { description: "Checks indemnity clauses." } },
] as const) {
  test(
    `a plan whose ${control.label} changed cannot claim the receipt`,
    async () => {
      await withHarness(
        async ({ repoRoot, workspacePath, teamYamlPath, provider, attempt }) => {
          const stored = legacyPlan(repoRoot);
          writePlanFile(workspacePath, stored);
          const interrupted = await attempt({
            jobId: "job-interrupted",
            onPersistenceBoundary: (boundary) => {
              if (boundary === "after_update_target_published") {
                throw new Error("process exited after the Team write");
              }
            },
          });
          assert.notEqual(interrupted.status, "completed");
          const publishedTeam = fs.readFileSync(teamYamlPath, "utf8");
          const generationsBefore = provider.generationCount();

          // Same plan id, same Agent names, same stored grade, same pinned
          // revision: only the text that describes the Agent differs. Every
          // other check `readManifest` makes still passes, so the digest is the
          // only thing left that can refuse this.
          const substituted = withChangedAgentText(stored, control.overrides);
          assert.equal(
            substituted.operations[0]!.expectedRevision,
            stored.operations[0]!.expectedRevision,
            "the control must differ from the stored plan in one way only",
          );
          assert.notEqual(
            digestResourceUpdateOperation(substituted.operations[0]!),
            digestResourceUpdateOperation(stored.operations[0]!),
            "the control must actually change the operation's identity",
          );
          writePlanFile(workspacePath, substituted);

          await assert.rejects(
            attempt({ jobId: "job-substituted" }),
            /does not describe this operation/u,
          );

          assert.equal(
            fs.readFileSync(teamYamlPath, "utf8"),
            publishedTeam,
            "a plan that cannot claim the receipt must not write the Team",
          );
          assert.equal(
            provider.generationCount(),
            generationsBefore,
            "a refused operation must not generate anything",
          );
        },
      );
    },
  );
}
