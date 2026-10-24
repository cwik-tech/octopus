/**
 * What a restart may say about a build that was running when the API stopped.
 *
 * The API cannot know how far a build got, so it reads the durable evidence the
 * build left and reports only what that evidence supports. A job whose items
 * all reached a published state is finished, not partly finished; a job with
 * unfinished items is partly finished and retryable; and a name whose staged
 * package is still on disk belongs to the plan that staged it until that plan
 * publishes or gives it up.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  ResourceArchitectPlan,
  ResourceBuildItem,
  ResourceBuildJobSnapshot,
  ResourceUpdateOperation,
} from "../../contracts/resource-architect.js";
import {
  reconcileInterruptedResourceBuilds,
  type ResourceArchitectStorePort,
} from "../../services/resource-architect-service.js";
import { stagePlannedAgentDraft } from "../../domains/agent-generator/planned-agent-persistence.js";
import { reservePlannedAgentName } from "../../domains/agent-generator/agent-name-reservation.js";

const PLAN_ID = "restart-plan";
const FIRST_TEAM = "contract-review-team";
const SECOND_TEAM = "diligence-team";
const STAGED_AGENT = "drafting-lawyer";
const ABANDONED_AGENT = "risk-lawyer";

function withTempRepo(run: (repoRoot: string) => Promise<void>): Promise<void> {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "restart-reconcile-"));
  fs.mkdirSync(path.join(repoRoot, "agents"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
  return run(repoRoot).finally(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
}

function makeOperation(teamId: string, agentName: string): ResourceUpdateOperation {
  return {
    kind: "add_team_agents",
    target: { kind: "team", id: teamId },
    expectedRevision:
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    libraryAgentsToAdd: [],
    newAgentsToCreate: [{
      name: agentName,
      role: "Reviewer",
      description: `Reviews for ${teamId}.`,
      rationale: "No existing Agent covers this.",
    }],
  };
}

function makeUpdatePlan(
  operations: ResourceUpdateOperation[] = [
    makeOperation(FIRST_TEAM, STAGED_AGENT),
    makeOperation(SECOND_TEAM, ABANDONED_AGENT),
  ],
): ResourceArchitectPlan {
  return { id: PLAN_ID, kind: "resource_updates", operations };
}

/** One item per operation, exactly as a stored update snapshot carries them. */
function teamItem(
  teamId: string,
  planIndex: number,
  status: ResourceBuildItem["status"],
): ResourceBuildItem {
  const target = { kind: "team" as const, id: teamId };
  return {
    plannedResource: target,
    planIndex,
    status,
    ...(status === "updated" ? { resource: target } : {}),
  };
}

function makeJob(items: ResourceBuildItem[]): ResourceBuildJobSnapshot {
  return {
    jobId: "restart-job",
    planId: PLAN_ID,
    status: "running",
    items,
    selectedResource: null,
    events: [{
      id: 1,
      type: "build_started",
      message: `Started resource plan \`${PLAN_ID}\`.`,
    }],
  };
}

function makeStore(
  plan: ResourceArchitectPlan | null,
  job: ResourceBuildJobSnapshot,
): ResourceArchitectStorePort & { saved(): ResourceBuildJobSnapshot[] } {
  const saved: ResourceBuildJobSnapshot[] = [];
  return {
    savePlan: async () => undefined,
    getPlan: async (planId) => (plan && planId === plan.id ? plan : null),
    claimPlan: () => () => undefined,
    saveJob: async (snapshot) => {
      saved.push(structuredClone(snapshot));
    },
    getJob: async () => null,
    listJobs: async () => [job],
    saved: () => saved,
  };
}

/** Reservation receipts still on disk, by the Agent name each one names. */
function remainingReservations(repoRoot: string): string[] {
  const root = path.join(repoRoot, ".create-orchestrator", "agent-name-reservations");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, entry), "utf8"));
      if (typeof parsed !== "object" || parsed === null || !("name" in parsed)) {
        return entry;
      }
      return typeof parsed.name === "string" ? parsed.name : entry;
    })
    .sort();
}

/** Where one Agent name's reservation receipt lives. */
function reservationFileFor(repoRoot: string, name: string): string {
  return path.join(
    repoRoot,
    ".create-orchestrator",
    "agent-name-reservations",
    `${createHash("sha256").update(name, "utf8").digest("hex")}.json`,
  );
}

test("a job whose every item is published is reconciled as finished, not partly finished", async () => {
  await withTempRepo(async (repoRoot) => {
    // Stored out of plan order, so the selection cannot come from array order.
    const job = makeJob([
      teamItem(SECOND_TEAM, 1, "updated"),
      teamItem(FIRST_TEAM, 0, "updated"),
    ]);
    const store = makeStore(makeUpdatePlan(), job);

    const [reconciled] = await reconcileInterruptedResourceBuilds({
      repoRoot,
      store,
      isActive: () => false,
    });

    assert.ok(reconciled);
    assert.equal(reconciled.status, "completed", JSON.stringify(reconciled, null, 2));
    assert.equal(
      reconciled.error,
      undefined,
      "a finished job carries no interruption to retry",
    );
    assert.deepEqual(
      reconciled.selectedResource,
      { kind: "team", id: FIRST_TEAM },
      "the first published item in plan order is selected",
    );
    assert.deepEqual(
      reconciled.events.map((event) => event.type),
      ["build_started", "build_completed"],
      JSON.stringify(reconciled.events, null, 2),
    );
    assert.equal(store.saved().at(-1)?.status, "completed");
    assert.equal(store.saved().at(-1)?.error, undefined);
  });
});

test("a Team plan's single item is not read as the whole build", async () => {
  await withTempRepo(async (repoRoot) => {
    // A Team plan has one item for the Team; the Agents it plans are not items
    // at all. A shell that exists therefore says nothing about whether the
    // Agents inside it were ever built, so this job stays retryable.
    const teamPlan: ResourceArchitectPlan = {
      id: PLAN_ID,
      kind: "team",
      team: {
        teamId: FIRST_TEAM,
        description: "Reviews contracts.",
        tags: ["review"],
        existingAgents: [],
        newAgents: [{
          name: STAGED_AGENT,
          role: "Reviewer",
          description: "Reviews drafting completeness.",
          rationale: "No existing Agent covers this.",
        }],
        questionsResolved: [],
      },
    };
    const job = makeJob([{
      plannedResource: { kind: "team", id: FIRST_TEAM },
      resource: { kind: "team", id: FIRST_TEAM },
      planIndex: 0,
      status: "created",
    }]);
    const store = makeStore(teamPlan, job);

    const [reconciled] = await reconcileInterruptedResourceBuilds({
      repoRoot,
      store,
      isActive: () => false,
    });

    assert.ok(reconciled);
    assert.equal(reconciled.status, "partially_completed");
    assert.match(reconciled.error ?? "", /Retry the build to continue/u);
  });
});

test("a job with an unfinished item stays partly finished with retryable evidence", async () => {
  await withTempRepo(async (repoRoot) => {
    const job = makeJob([
      teamItem(FIRST_TEAM, 0, "updated"),
      teamItem(SECOND_TEAM, 1, "generating"),
    ]);
    const store = makeStore(makeUpdatePlan(), job);

    const [reconciled] = await reconcileInterruptedResourceBuilds({
      repoRoot,
      store,
      isActive: () => false,
    });

    assert.ok(reconciled);
    assert.equal(reconciled.status, "partially_completed");
    assert.match(reconciled.error ?? "", /Retry the build to continue/u);
    assert.equal(reconciled.items[1]?.status, "interrupted");
    assert.match(reconciled.items[1]?.error ?? "", /Retry the build to continue/u);
    assert.deepEqual(
      reconciled.events.map((event) => event.type),
      ["build_started", "build_partially_completed"],
    );
  });
});

/** Writes one staged-transaction directory exactly as given. */
function writeStagedTransaction(
  repoRoot: string,
  directory: string,
  files: Record<string, string>,
): void {
  const root = path.join(repoRoot, ".create-orchestrator", "staged-agents", directory);
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  fs.mkdirSync(root, { recursive: true });
}

/** Staged transaction directories still present, by directory name. */
function stagedTransactionDirectories(repoRoot: string): string[] {
  const root = path.join(repoRoot, ".create-orchestrator", "staged-agents");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function stagedPersona(name: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${name} description.`,
    "tier: strategic",
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n");
}

function ownershipMarker(orchestratorKey: string, requestedName: string): string {
  return `${JSON.stringify({ orchestratorKey, requestedName })}\n`;
}

function readyReceipt(agentName: string, orchestratorKey: string): string {
  return `${JSON.stringify({
    version: 1,
    state: "ready",
    ownerPid: process.pid,
    createdAt: "2026-01-01T00:00:00.000Z",
    orchestratorKey,
    requestedName: agentName,
    agentName,
  })}\n`;
}

test("evidence about nothing this plan named does not hold any name", async () => {
  await withTempRepo(async (repoRoot) => {
    for (const name of [STAGED_AGENT, ABANDONED_AGENT]) {
      await reservePlannedAgentName({
        repoRoot,
        planId: PLAN_ID,
        jobId: "restart-job",
        name,
      });
    }
    // A transaction whose receipt cannot be read names nobody. It has to be
    // dealt with where a package is staged, not by holding every name in the
    // plan hostage to it.
    writeStagedTransaction(repoRoot, "unreadable-transaction", {
      "receipt.json": "not a receipt\n",
      "repo/agents/someone-else/someone-else.md": "---\nname: someone-else\n---\n",
    });

    const job = makeJob([
      teamItem(FIRST_TEAM, 0, "generating"),
      teamItem(SECOND_TEAM, 1, "generating"),
    ]);
    const store = makeStore(makeUpdatePlan(), job);

    await reconcileInterruptedResourceBuilds({ repoRoot, store, isActive: () => false });

    assert.deepEqual(
      remainingReservations(repoRoot),
      [],
      "no name is held by evidence that names none of them",
    );
    assert.deepEqual(
      stagedTransactionDirectories(repoRoot),
      ["unreadable-transaction"],
      "evidence this query cannot read is left exactly where it is",
    );
  });
});

test("a ready receipt with no package behind it does not hold its name", async () => {
  await withTempRepo(async (repoRoot) => {
    await reservePlannedAgentName({
      repoRoot,
      planId: PLAN_ID,
      jobId: "restart-job",
      name: STAGED_AGENT,
    });
    // The receipt claims a finished package, but there is none to publish, so
    // there is no work for a retry to take over and no reason to keep the name.
    writeStagedTransaction(repoRoot, "empty-claim", {
      "receipt.json": readyReceipt(STAGED_AGENT, PLAN_ID),
    });

    const job = makeJob([teamItem(FIRST_TEAM, 0, "generating")]);
    const store = makeStore(
      makeUpdatePlan([makeOperation(FIRST_TEAM, STAGED_AGENT)]),
      job,
    );

    await reconcileInterruptedResourceBuilds({ repoRoot, store, isActive: () => false });

    assert.deepEqual(remainingReservations(repoRoot), []);
  });
});

test("a staged package whose persona names another Agent does not hold the name", async () => {
  await withTempRepo(async (repoRoot) => {
    await reservePlannedAgentName({
      repoRoot,
      planId: PLAN_ID,
      jobId: "restart-job",
      name: STAGED_AGENT,
    });
    // The receipt and the folder both say `drafting-lawyer`, but the persona
    // inside is somebody else. A package that is not the Agent it claims to be
    // is not work a retry can publish under that name.
    writeStagedTransaction(repoRoot, "wrong-persona", {
      "receipt.json": readyReceipt(STAGED_AGENT, PLAN_ID),
      [`repo/agents/${STAGED_AGENT}/${STAGED_AGENT}.md`]: stagedPersona("someone-else"),
      [`repo/agents/${STAGED_AGENT}/.create-orchestrator`]: ownershipMarker(
        PLAN_ID,
        STAGED_AGENT,
      ),
    });

    const job = makeJob([teamItem(FIRST_TEAM, 0, "generating")]);
    const store = makeStore(
      makeUpdatePlan([makeOperation(FIRST_TEAM, STAGED_AGENT)]),
      job,
    );

    await reconcileInterruptedResourceBuilds({ repoRoot, store, isActive: () => false });

    assert.deepEqual(remainingReservations(repoRoot), []);
    assert.deepEqual(
      stagedTransactionDirectories(repoRoot),
      ["wrong-persona"],
      "the evidence itself is left for whoever has to look at it",
    );
  });
});

test("a staged package whose marker names another plan does not hold the name", async () => {
  await withTempRepo(async (repoRoot) => {
    await reservePlannedAgentName({
      repoRoot,
      planId: PLAN_ID,
      jobId: "restart-job",
      name: STAGED_AGENT,
    });
    // The receipt names this plan; the marker inside the package names another.
    // Ownership that disagrees with itself is not a claim this plan can act on.
    writeStagedTransaction(repoRoot, "wrong-marker", {
      "receipt.json": readyReceipt(STAGED_AGENT, PLAN_ID),
      [`repo/agents/${STAGED_AGENT}/${STAGED_AGENT}.md`]: stagedPersona(STAGED_AGENT),
      [`repo/agents/${STAGED_AGENT}/.create-orchestrator`]: ownershipMarker(
        "a-different-plan",
        STAGED_AGENT,
      ),
    });

    const job = makeJob([teamItem(FIRST_TEAM, 0, "generating")]);
    const store = makeStore(
      makeUpdatePlan([makeOperation(FIRST_TEAM, STAGED_AGENT)]),
      job,
    );

    await reconcileInterruptedResourceBuilds({ repoRoot, store, isActive: () => false });

    assert.deepEqual(remainingReservations(repoRoot), []);
    assert.deepEqual(
      stagedTransactionDirectories(repoRoot),
      ["wrong-marker"],
      "the evidence itself is left for whoever has to look at it",
    );
  });
});

test("a staging root that cannot be read leaves every reservation where it is", async () => {
  await withTempRepo(async (repoRoot) => {
    await reservePlannedAgentName({
      repoRoot,
      planId: PLAN_ID,
      jobId: "restart-job",
      name: STAGED_AGENT,
    });
    const before = fs.readFileSync(reservationFileFor(repoRoot, STAGED_AGENT), "utf8");
    // The staging root is not a directory, so whether anything is staged cannot
    // be answered at all. Reading that as "nothing is staged" would hand back a
    // name whose package may be sitting right there.
    fs.mkdirSync(path.join(repoRoot, ".create-orchestrator"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, ".create-orchestrator", "staged-agents"),
      "not a directory\n",
    );

    const job = makeJob([teamItem(FIRST_TEAM, 0, "generating")]);
    const store = makeStore(
      makeUpdatePlan([makeOperation(FIRST_TEAM, STAGED_AGENT)]),
      job,
    );

    await assert.rejects(
      reconcileInterruptedResourceBuilds({ repoRoot, store, isActive: () => false }),
    );

    assert.equal(
      fs.readFileSync(reservationFileFor(repoRoot, STAGED_AGENT), "utf8"),
      before,
      "the reservation is left byte-for-byte as it was",
    );
    assert.deepEqual(
      store.saved(),
      [],
      "no job is rewritten on evidence nobody could read",
    );
    assert.equal(job.status, "running", "the stored job is left as it was");
  });
});

test("a name whose staged package is still on disk is kept for the plan that staged it", async () => {
  await withTempRepo(async (repoRoot) => {
    for (const name of [STAGED_AGENT, ABANDONED_AGENT]) {
      await reservePlannedAgentName({
        repoRoot,
        planId: PLAN_ID,
        jobId: "restart-job",
        name,
      });
    }
    // One package finished staging before the API stopped; the other never
    // produced anything.
    await stagePlannedAgentDraft({
      repoRoot,
      orchestratorKey: PLAN_ID,
      requestedName: STAGED_AGENT,
      personaMarkdown: [
        "---",
        `name: ${STAGED_AGENT}`,
        "description: Reviews drafting completeness.",
        "tier: strategic",
        "---",
        "",
        `# ${STAGED_AGENT}`,
        "",
      ].join("\n"),
      generatedSkills: [{
        name: "drafting-review",
        body: [
          "---",
          "name: drafting-review",
          "description: >",
          "  Review a contract draft for missing clauses. Use when a draft needs",
          "  a completeness pass before signature.",
          "---",
          "",
          "# Review",
          "",
        ].join("\n"),
      }],
    });

    const job = makeJob([
      teamItem(FIRST_TEAM, 0, "generating"),
      teamItem(SECOND_TEAM, 1, "generating"),
    ]);
    const store = makeStore(makeUpdatePlan(), job);

    await reconcileInterruptedResourceBuilds({ repoRoot, store, isActive: () => false });

    assert.deepEqual(
      remainingReservations(repoRoot),
      [STAGED_AGENT],
      "the name of the package still on disk stays with it; the other is given back",
    );
    // A retry of the same plan has to be able to take the retained name over.
    assert.deepEqual(
      await reservePlannedAgentName({
        repoRoot,
        planId: PLAN_ID,
        jobId: "a-later-job",
        name: STAGED_AGENT,
      }),
      { status: "reserved" },
    );
  });
});
