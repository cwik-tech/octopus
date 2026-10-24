/**
 * What a build was admitted to do, recorded durably and never quietly replaced.
 *
 * A plan id alone does not identify an approved build. The same plan can be
 * submitted twice, submitted under a job id that already belongs to another
 * plan, or retried after it failed — and until admission was recorded, all
 * three landed on the same job file and overwrote whatever was there. A
 * completed build could be turned into a failed one by resending the identical
 * request, and a job's persisted record could change which plan it belonged to.
 *
 * Everything here runs the real route, registry, store and team writer against
 * a temporary repository. The plans carry only agents that already exist, so a
 * build reaches publication without a single model call. The one exception is
 * the skill-update retry, whose skills come from a loopback skill author.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import type {
  ResourceArchitectPlan,
  ResourceBuildJobSnapshot,
  ResourcePlanAdmission,
} from "../../contracts/resource-architect.js";
import { CreateJobRegistry } from "../../server/create-job-registry.js";
import { ResourceArchitectStore } from "../../server/resource-architect-store.js";
import { handleResourceArchitectRoutes } from "../../server/routes/resource-architect.js";
import {
  addTeamBuilderAgent,
  finishTeamBuilderPublication,
  teamPublishedBy,
} from "../../domains/agent-generator/team-manager.js";
import { withFileMutationLock } from "../../core/file-mutation.js";
import {
  ServiceError,
  statusCodeForServiceError,
} from "../../services/service-errors.js";
import {
  createResourceBuildSnapshot,
  releaseDeadPlanAdmissions,
} from "../../services/resource-architect-service.js";
import { restorableResourceBuildJob } from "../../contracts/resource-build-recovery.js";
import { createTeamBuildShell } from "../../domains/resource-architect/team-build-shell.js";
import { computeAgentRevision } from "../../domains/agent-generator/agent-revision.js";
import { parseResourceBuildJobRecord } from "../../server/resource-architect-durable-records.js";

function teamPlan(planId: string, teamId: string): ResourceArchitectPlan {
  return {
    id: planId,
    kind: "team",
    team: {
      teamId,
      description: "Build once.",
      tags: [],
      existingAgents: [{ name: "alpha", role: "Writer", rationale: "Available." }],
      newAgents: [],
      questionsResolved: [],
      shape: { kind: "chain", rationale: "Sequential.", depth: "quick", order: ["alpha"] },
    },
  };
}

/**
 * A store that announces every job record reaching a terminal status.
 *
 * The build runs in the background after the route has answered, so the test
 * waits on the durable write that ends it rather than on a clock.
 */
class ObservedStore extends ResourceArchitectStore {
  private readonly settled = new Map<string, ResourceBuildJobSnapshot>();
  private readonly waiting = new Map<
    string,
    (job: ResourceBuildJobSnapshot) => void
  >();

  /** How many times each job id has been written in a terminal status. */
  readonly terminalWrites = new Map<string, number>();
  private discardIntent: (() => void) | null = null;

  override async savePlanAdmission(
    admission: ResourcePlanAdmission,
  ): Promise<void> {
    await super.savePlanAdmission(admission);
    if (!admission.discarded) return;
    const waiter = this.discardIntent;
    this.discardIntent = null;
    waiter?.();
  }

  /** Resolves when a discard's decision reaches the disk. */
  discardIntentRecorded(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.discardIntent = resolve;
    });
  }

  override async saveJob(job: ResourceBuildJobSnapshot): Promise<void> {
    await super.saveJob(job);
    if (job.status === "running") return;
    this.terminalWrites.set(job.jobId, (this.terminalWrites.get(job.jobId) ?? 0) + 1);
    const record = structuredClone(job);
    this.settled.set(record.jobId, record);
    const waiter = this.waiting.get(record.jobId);
    if (waiter) {
      this.waiting.delete(record.jobId);
      waiter(record);
    }
  }

  /**
   * Resolves once this job id has been written in a terminal status.
   *
   * Named, because more than one build can be in flight: a promise for
   * "whatever settles next" would hand one test the other build's outcome.
   */
  terminalJob(jobId: string): Promise<ResourceBuildJobSnapshot> {
    const already = this.settled.get(jobId);
    if (already) return Promise.resolve(already);
    return new Promise<ResourceBuildJobSnapshot>((resolve) => {
      this.waiting.set(jobId, resolve);
    });
  }
}

interface Harness {
  origin: string;
  store: ObservedStore;
  /** The live job registry, so a test can hold an id the way a build does. */
  registry: CreateJobRegistry;
  repoRoot: string;
  workspacePath: string;
  close: () => Promise<void>;
}

function makeRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "admission-lineage-"));
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
  for (const name of ["resource-architect", "alpha"]) {
    const agentDir = path.join(repoRoot, "agents", name);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, `${name}.md`),
      `---\nname: ${name}\ndescription: ${name}.\ntier: strategic\nprovider: openai\nmodel: local-test-model\n---\n\n# ${name}\n`,
    );
  }
  const architectDir = path.join(repoRoot, "teams", "resource-architect");
  fs.mkdirSync(architectDir, { recursive: true });
  fs.writeFileSync(
    path.join(architectDir, "team.yaml"),
    [
      "team:",
      "  name: resource-architect",
      "agents:",
      "  - name: resource-architect",
      "    agent_file: ../../agents/resource-architect/resource-architect.md",
      "",
    ].join("\n"),
  );
  return repoRoot;
}

/** Serves the real routes over an existing repository and workspace. */
async function serve(params: {
  repoRoot: string;
  workspacePath: string;
  /** Where the registry keeps its durable state, when the test needs it to. */
  registryWorkspacePath?: string;
}): Promise<Harness> {
  const store = new ObservedStore(params.workspacePath);
  const registry = new CreateJobRegistry(
    params.registryWorkspacePath === undefined
      ? {}
      : { workspacePath: params.registryWorkspacePath },
  );
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleResourceArchitectRoutes({
      req,
      res,
      url,
      options: {
        repoRootPath: params.repoRoot,
        resourceArchitectStore: store,
        createJobRegistry: registry,
        isAbortLike: () => false,
      },
    }).then(
      (handled) => {
        if (!handled && !res.writableEnded) res.writeHead(404).end();
      },
      (error: unknown) => {
        if (res.writableEnded) return;
        // Answered the way the real server answers, so a refusal the product
        // states as a conflict is not read here as a crash.
        const status = error instanceof ServiceError
          ? statusCodeForServiceError(error)
          : 500;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    store,
    registry,
    repoRoot: params.repoRoot,
    workspacePath: params.workspacePath,
    close: () =>
      new Promise<void>((resolve, reject) => {
        registry.close();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

async function withHarness(fn: (harness: Harness) => Promise<void>): Promise<void> {
  const repoRoot = makeRepo();
  const workspacePath = path.join(repoRoot, "workspace");
  const harness = await serve({ repoRoot, workspacePath });
  try {
    await fn(harness);
  } finally {
    await harness.close();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

/** Writes one agent persona into the repository. */
function writeAgent(harness: Harness, name: string): void {
  const agentDir = path.join(harness.repoRoot, "agents", name);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name}.\ntier: strategic\nprovider: openai\nmodel: local-test-model\n---\n\n# ${name}\n`,
  );
}

/**
 * Takes an agent persona away, and hands back the means to put it back.
 *
 * A build whose roster is missing fails for a reason the product actually has,
 * without a provider and without reaching into the build's internals.
 */
function removeAgent(harness: Harness, name: string): { restore: () => void } {
  const agentDir = path.join(harness.repoRoot, "agents", name);
  fs.rmSync(agentDir, { recursive: true, force: true });
  return { restore: () => writeAgent(harness, name) };
}

async function revisionOf(harness: Harness, planId: string): Promise<string> {
  const response = await fetch(
    `${harness.origin}/create/resource-architect/plans/${planId}/shape`,
  );
  const parsed = (await response.json()) as Record<string, unknown>;
  return String(parsed.revision);
}

async function postBuild(
  harness: Harness,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${harness.origin}/create/resource-architect/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed: unknown = await response.json().catch(() => ({}));
  return {
    status: response.status,
    body: parsed && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : {},
  };
}

/** Starts a build and waits for the record that ends it. */
async function buildToCompletion(
  harness: Harness,
  body: Record<string, unknown>,
): Promise<ResourceBuildJobSnapshot> {
  const settled = harness.store.terminalJob(String(body.jobId));
  const answer = await postBuild(harness, body);
  assert.equal(answer.status, 202, JSON.stringify(answer.body));
  const job = await settled;
  assert.equal(job.status, "completed", JSON.stringify(job));
  return job;
}

test("a replayed build request answers with the job it already built", async () => {
  await withHarness(async (harness) => {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    const revision = await revisionOf(harness, "plan-replay");
    const request = {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    };
    await buildToCompletion(harness, request);

    // The identical request again. Nothing new was authorized, so nothing is
    // rebuilt and — the part that failed — the finished record stands.
    const replay = await postBuild(harness, request);
    assert.equal(replay.status, 202, JSON.stringify(replay.body));
    const saved = await harness.store.getJob("same-job");
    assert.equal(saved?.status, "completed", JSON.stringify(saved));
    assert.equal(saved?.planId, "plan-replay");
    assert.equal(saved?.error, undefined);
  });
});

test("a job id that already belongs to another plan is refused", async () => {
  await withHarness(async (harness) => {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    await harness.store.savePlan(teamPlan("plan-other", "other-team"));
    const revision = await revisionOf(harness, "plan-replay");
    await buildToCompletion(harness, {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    });

    const stolen = await postBuild(harness, {
      planId: "plan-other",
      jobId: "same-job",
      expectedRevision: await revisionOf(harness, "plan-other"),
    });
    assert.equal(stolen.status, 409, JSON.stringify(stolen.body));
    assert.equal(stolen.body.error, "job_id_conflict");

    // Neither record moved: the finished job still belongs to the plan that
    // built it, and the other plan was never admitted under that id.
    const saved = await harness.store.getJob("same-job");
    assert.equal(saved?.planId, "plan-replay");
    assert.equal(saved?.status, "completed");

    // And the refused plan is free to build under an id of its own.
    const fresh = await buildToCompletion(harness, {
      planId: "plan-other",
      jobId: "other-job",
      expectedRevision: await revisionOf(harness, "plan-other"),
    });
    assert.equal(fresh.planId, "plan-other");
  });
});

test("a competing submission for an admitted plan is refused by name", async () => {
  await withHarness(async (harness) => {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    const revision = await revisionOf(harness, "plan-replay");
    await buildToCompletion(harness, {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    });

    const competing = await postBuild(harness, {
      planId: "plan-replay",
      jobId: "a-second-submission",
      expectedRevision: revision,
    });
    assert.equal(competing.status, 409, JSON.stringify(competing.body));
    assert.equal(competing.body.error, "plan_already_admitted");
    assert.equal(competing.body.jobId, "same-job");
    assert.equal(competing.body.admittedRevision, revision);
    assert.equal(await harness.store.getJob("a-second-submission"), null);
  });
});

test("admission records the revision the build was approved against", async () => {
  await withHarness(async (harness) => {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    const revision = await revisionOf(harness, "plan-replay");
    const job = await buildToCompletion(harness, {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    });
    assert.equal(job.admittedRevision, revision);

    // And the team it published says which attempt published it, so a later
    // reading cannot mistake one attempt's work for another's.
    const teamYaml = fs.readFileSync(
      path.join(harness.repoRoot, "teams", "replay-team", "team.yaml"),
      "utf8",
    );
    assert.match(teamYaml, new RegExp(`published_by:\\s*"?plan-replay@${revision}"?`));
  });
});

test("a failed attempt retries through to a published team", async () => {
  await withHarness(async (harness) => {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    const revision = await revisionOf(harness, "plan-replay");

    // A build that really fails: the agent the plan names is not there when it
    // runs, so the shell is created and the roster never assembled.
    const withoutAlpha = removeAgent(harness, "alpha");
    const failedSettled = harness.store.terminalJob("same-job");
    const admitted = await postBuild(harness, {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    const failed = await failedSettled;
    assert.equal(failed.status, "failed", JSON.stringify(failed));
    withoutAlpha.restore();

    const response = await fetch(
      `${harness.origin}/create/resource-architect/jobs/same-job/retry`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    const parsed = (await response.json()) as Record<string, unknown>;
    assert.equal(response.status, 202, JSON.stringify(parsed));
    const retryJobId = String(parsed.jobId);
    assert.notEqual(retryJobId, "same-job");

    // The outcome, not merely the admission: an interrupted build has to be
    // able to finish, and 202 alone says nothing about whether it did.
    const retried = await harness.store.terminalJob(retryJobId);
    assert.equal(retried.status, "completed", JSON.stringify(retried));
    // Bound to what was admitted, not to whatever the plan says now.
    assert.equal(retried.admittedRevision, revision);

    const teamYaml = fs.readFileSync(
      path.join(harness.repoRoot, "teams", "replay-team", "team.yaml"),
      "utf8",
    );
    assert.match(teamYaml, /- name: "?alpha"?/);
    assert.match(teamYaml, new RegExp(`published_by:\\s*"?plan-replay@${revision}"?`));
    assert.doesNotMatch(teamYaml, /building: true/);
  });
});

// A retry rebuilds work that was already approved, and stamps the team with the
// revision it was approved at. If the stored plan has moved since, retrying
// would build something else and certify it with the old digest.
test("a retry is refused when the admitted plan is no longer what is stored", async () => {
  await withHarness(async (harness) => {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    const revision = await revisionOf(harness, "plan-replay");

    const withoutAlpha = removeAgent(harness, "alpha");
    const failedSettled = harness.store.terminalJob("same-job");
    await postBuild(harness, {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    });
    assert.equal((await failedSettled).status, "failed");
    withoutAlpha.restore();

    // The persisted plan changes underneath the admitted lineage. This models
    // changed bytes on disk, not an amendment the card was allowed to make.
    writeAgent(harness, "beta");
    const stored = await harness.store.getPlan("plan-replay");
    assert.ok(stored?.kind === "team");
    await harness.store.savePlan({
      ...stored,
      team: {
        ...stored.team,
        existingAgents: [
          ...stored.team.existingAgents,
          { name: "beta", role: "Checker", rationale: "Added later." },
        ],
        shape: {
          kind: "chain",
          rationale: "Sequential.",
          depth: "quick",
          order: ["alpha", "beta"],
        },
      },
    });

    const response = await fetch(
      `${harness.origin}/create/resource-architect/jobs/same-job/retry`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    const parsed = (await response.json()) as Record<string, unknown>;
    assert.equal(response.status, 409, JSON.stringify(parsed));
    assert.equal(parsed.error, "plan_revision_conflict");

    // Refused before anything was written: no new job, and the team on disk
    // never gained the member the changed plan named.
    const teamYaml = fs.readFileSync(
      path.join(harness.repoRoot, "teams", "replay-team", "team.yaml"),
      "utf8",
    );
    assert.doesNotMatch(teamYaml, /beta/);
    assert.doesNotMatch(teamYaml, new RegExp("published_by"));
  });
});

test("changing the shape after a build was admitted is refused", async () => {
  await withHarness(async (harness) => {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    const revision = await revisionOf(harness, "plan-replay");
    await buildToCompletion(harness, {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    });

    const response = await fetch(
      `${harness.origin}/create/resource-architect/plans/plan-replay/shape`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: revision,
          shape: {
            kind: "review",
            rationale: "Too late.",
            depth: "quick",
            producer: "alpha",
            reviewer: "alpha",
          },
        }),
      },
    );
    const parsed = (await response.json()) as Record<string, unknown>;
    assert.equal(response.status, 409, JSON.stringify(parsed));
    assert.equal(parsed.error, "plan_already_admitted");
    assert.equal(parsed.jobId, "same-job");
    assert.equal(parsed.admittedRevision, revision);
  });
});

test("admission survives a restart of the server", async () => {
  const repoRoot = makeRepo();
  const workspacePath = path.join(repoRoot, "workspace");
  const first = await serve({ repoRoot, workspacePath });
  let revision = "";
  try {
    await first.store.savePlan(teamPlan("plan-replay", "replay-team"));
    revision = await revisionOf(first, "plan-replay");
    await buildToCompletion(first, {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    });
  } finally {
    await first.close();
  }

  // A second process over the same workspace: nothing in memory, everything
  // from the files the first one wrote.
  const second = await serve({ repoRoot, workspacePath });
  try {
    const replay = await postBuild(second, {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    });
    assert.equal(replay.status, 202, JSON.stringify(replay.body));
    const saved = await second.store.getJob("same-job");
    assert.equal(saved?.status, "completed", JSON.stringify(saved));

    const competing = await postBuild(second, {
      planId: "plan-replay",
      jobId: "a-cold-second-submission",
      expectedRevision: revision,
    });
    assert.equal(competing.status, 409, JSON.stringify(competing.body));
    assert.equal(competing.body.error, "plan_already_admitted");
  } finally {
    await second.close();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// A crash between recording the admission and creating its job leaves a plan
// nothing can build: the admission holds it for an attempt that does not
// exist. Reconciliation releases exactly that, and nothing else.
test("an admission whose build never started is released by reconciliation", async () => {
  await withHarness(async (harness) => {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    const revision = await revisionOf(harness, "plan-replay");
    // What the crash left behind: the record, and no job to go with it.
    await harness.store.savePlanAdmission({
      planId: "plan-replay",
      jobId: "a-job-that-never-existed",
      revision,
      priorJobIds: [],
    });

    const stuck = await postBuild(harness, {
      planId: "plan-replay",
      jobId: "a-real-job",
      expectedRevision: revision,
    });
    assert.equal(stuck.status, 409, JSON.stringify(stuck.body));
    assert.equal(stuck.body.error, "plan_already_admitted");

    // The boot-time reconciliation the panel already performs.
    const reconciled = await fetch(
      `${harness.origin}/create/resource-architect/jobs`,
    );
    assert.equal(reconciled.status, 200);
    await reconciled.json();

    const job = await buildToCompletion(harness, {
      planId: "plan-replay",
      jobId: "a-real-job",
      expectedRevision: revision,
    });
    assert.equal(job.jobId, "a-real-job");
  });
});

// And an admission whose build has not created its job *yet* is not dead. The
// plan claim is taken in the same critical section that writes the admission,
// so it is held for exactly the window where no job record exists.
test("an admission held by a build in flight is not released", async () => {
  await withHarness(async (harness) => {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    const revision = await revisionOf(harness, "plan-replay");
    await harness.store.savePlanAdmission({
      planId: "plan-replay",
      jobId: "starting-job",
      revision,
      priorJobIds: [],
    });
    const release = harness.store.claimPlan("plan-replay");
    try {
      await releaseDeadPlanAdmissions(harness.store);
      const held = await harness.store.getPlanAdmission("plan-replay");
      assert.equal(held?.jobId, "starting-job");
    } finally {
      release();
    }
  });
});

// Two plans submitted at the same instant under one job id. Each holds only its
// own plan's critical section, so nothing serializes them but the job id
// itself. The one that loses must be left exactly as it was found: a plan it
// never got to build is a plan it must not still be holding.
test("a submission that loses a job id race leaves its plan free", async () => {
  await withHarness(async (harness) => {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    await harness.store.savePlan(teamPlan("plan-other", "other-team"));
    const revisions = {
      "plan-replay": await revisionOf(harness, "plan-replay"),
      "plan-other": await revisionOf(harness, "plan-other"),
    };

    const answers = await Promise.all(
      (["plan-replay", "plan-other"] as const).map(async (planId) => ({
        planId,
        ...await postBuild(harness, {
          planId,
          jobId: "same-job",
          expectedRevision: revisions[planId],
        }),
      })),
    );
    const winner = answers.find((answer) => answer.status === 202);
    const loser = answers.find((answer) => answer.status !== 202);
    assert.ok(winner, JSON.stringify(answers));
    assert.ok(loser, JSON.stringify(answers));

    // Nothing was reserved for the build that never started.
    assert.equal(await harness.store.getPlanAdmission(loser.planId), null);

    // And the proof that matters to the user: the refused plan can still be
    // built, under an id of its own, without any reconciliation first.
    const built = await buildToCompletion(harness, {
      planId: loser.planId,
      jobId: "a-job-of-its-own",
      expectedRevision: revisions[loser.planId],
    });
    assert.equal(built.planId, loser.planId);
  });
});

// A stale admission pointing at a job id that another plan's build owns is not
// evidence that this plan's build exists. Reading any job with that id as
// proof left the refused plan held forever.
test("an admission whose job id belongs to another plan is released", async () => {
  await withHarness(async (harness) => {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    await harness.store.savePlan(teamPlan("plan-other", "other-team"));
    const revision = await revisionOf(harness, "plan-replay");
    await buildToCompletion(harness, {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    });
    // What the lost race used to leave behind.
    await harness.store.savePlanAdmission({
      planId: "plan-other",
      jobId: "same-job",
      revision: await revisionOf(harness, "plan-other"),
      priorJobIds: [],
    });

    await releaseDeadPlanAdmissions(harness.store);

    assert.equal(await harness.store.getPlanAdmission("plan-other"), null);
    // And the admission that does own its job is untouched.
    const kept = await harness.store.getPlanAdmission("plan-replay");
    assert.equal(kept?.jobId, "same-job");
  });
});

// Reserving the job id can fail on its own: the registry records it durably,
// and that write can be refused by the filesystem. Whatever it leaves behind,
// it must not leave the plan claimed — a plan held by a build that never
// started refuses every later attempt with "already being applied".
test("a build refused by the registry's own durable write leaves the plan free", async () => {
  const repoRoot = makeRepo();
  const workspacePath = path.join(repoRoot, "workspace");
  const registryWorkspacePath = path.join(repoRoot, "registry");
  fs.mkdirSync(registryWorkspacePath, { recursive: true });
  const harness = await serve({ repoRoot, workspacePath, registryWorkspacePath });
  try {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    const revision = await revisionOf(harness, "plan-replay");
    // The directory the registry writes into, occupied by a file. Planted
    // after the registry has started, which is when a disk can turn hostile.
    fs.writeFileSync(path.join(registryWorkspacePath, "create-jobs"), "not a directory");
    const refused = await postBuild(harness, {
      planId: "plan-replay",
      jobId: "first-job",
      expectedRevision: revision,
    });
    assert.notEqual(refused.status, 202, JSON.stringify(refused.body));

    // The obstruction removed, the very next attempt has to work.
    fs.rmSync(path.join(registryWorkspacePath, "create-jobs"), { force: true });
    const built = await buildToCompletion(harness, {
      planId: "plan-replay",
      jobId: "second-job",
      expectedRevision: revision,
    });
    assert.equal(built.status, "completed");
  } finally {
    await harness.close();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// The same request twice at once — a double click, or a client that retried
// because the first answer was slow. Both must be answered with the one
// admitted build, and only one build may run. This is not the different-plan
// race: here the plan, the job id and the revision are identical.
test("two identical requests in flight are answered by one admitted build", async () => {
  await withHarness(async (harness) => {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    const revision = await revisionOf(harness, "plan-replay");
    const request = {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    };

    const settled = harness.store.terminalJob("same-job");
    const answers = await Promise.all([
      postBuild(harness, request),
      postBuild(harness, request),
    ]);
    for (const answer of answers) {
      assert.equal(answer.status, 202, JSON.stringify(answer.body));
      assert.equal(answer.body.jobId, "same-job");
    }

    const job = await settled;
    assert.equal(job.status, "completed", JSON.stringify(job));
    // One build, not two racing to write the same receipt.
    assert.equal(harness.store.terminalWrites.get("same-job"), 1);
  });
});

/** Where the store keeps one job's record, by the same rule the store uses. */
function jobRecordPath(workspacePath: string, jobId: string): string {
  return path.join(
    workspacePath,
    "resource-build-jobs",
    `${createHash("sha256").update(jobId, "utf8").digest("hex")}.json`,
  );
}

// A retry whose own receipt cannot be written must not erase the attempt it was
// retrying. The plan has been built against once — there is a shell on disk —
// so forgetting that would unfreeze the shape and let the user amend a plan
// that no longer matches what exists.
test("a retry that cannot record its receipt keeps the plan admitted", async () => {
  const repoRoot = makeRepo();
  const workspacePath = path.join(repoRoot, "workspace");
  const harness = await serve({ repoRoot, workspacePath });
  let revision = "";
  try {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    revision = await revisionOf(harness, "plan-replay");

    const withoutAlpha = removeAgent(harness, "alpha");
    const failedSettled = harness.store.terminalJob("same-job");
    await postBuild(harness, {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    });
    assert.equal((await failedSettled).status, "failed");
    withoutAlpha.restore();

    // The retry's own receipt path, occupied by a directory.
    const blocked = jobRecordPath(workspacePath, "retry-receipt-fails");
    fs.mkdirSync(blocked, { recursive: true });
    const refused = await fetch(
      `${harness.origin}/create/resource-architect/jobs/same-job/retry`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: "retry-receipt-fails" }),
      },
    );
    assert.notEqual(refused.status, 202, await refused.text());

    // The lineage is back where it was, at the attempt that does have a record.
    const held = await harness.store.getPlanAdmission("plan-replay");
    assert.equal(held?.jobId, "same-job", JSON.stringify(held));
    assert.equal(held?.revision, revision);

    // Reconciliation must not release it either.
    await (await fetch(`${harness.origin}/create/resource-architect/jobs`)).json();
    const afterReconcile = await harness.store.getPlanAdmission("plan-replay");
    assert.equal(afterReconcile?.jobId, "same-job", JSON.stringify(afterReconcile));

    // And the freeze still holds.
    const amendment = await fetch(
      `${harness.origin}/create/resource-architect/plans/plan-replay/shape`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: revision,
          shape: {
            kind: "review",
            rationale: "Too late.",
            depth: "quick",
            producer: "alpha",
            reviewer: "alpha",
          },
        }),
      },
    );
    const refusal = (await amendment.json()) as Record<string, unknown>;
    assert.equal(amendment.status, 409, JSON.stringify(refusal));
    assert.equal(refusal.error, "plan_already_admitted");

    fs.rmSync(blocked, { recursive: true, force: true });
  } finally {
    await harness.close();
  }

  // The same answers after a restart, from the files alone.
  const restarted = await serve({ repoRoot, workspacePath });
  try {
    const amendment = await fetch(
      `${restarted.origin}/create/resource-architect/plans/plan-replay/shape`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: revision,
          shape: {
            kind: "review",
            rationale: "Still too late.",
            depth: "quick",
            producer: "alpha",
            reviewer: "alpha",
          },
        }),
      },
    );
    assert.equal(
      amendment.status,
      409,
      JSON.stringify(await amendment.json()),
    );

    // The obstruction gone, the authorized retry finishes.
    const response = await fetch(
      `${restarted.origin}/create/resource-architect/jobs/same-job/retry`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: "retry-receipt-fails" }),
      },
    );
    const parsed = (await response.json()) as Record<string, unknown>;
    assert.equal(response.status, 202, JSON.stringify(parsed));
    const finished = await restarted.store.terminalJob("retry-receipt-fails");
    assert.equal(finished.status, "completed", JSON.stringify(finished));
    assert.equal(finished.admittedRevision, revision);
  } finally {
    await restarted.close();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// The same rollback, reached the way a stopped process reaches it: nothing ran
// the request's own cleanup, so the orphaned admission is on disk and only
// reconciliation can put the lineage back.
test("reconciliation rolls an orphaned retry admission back to its last real attempt", async () => {
  const repoRoot = makeRepo();
  const workspacePath = path.join(repoRoot, "workspace");
  const first = await serve({ repoRoot, workspacePath });
  let revision = "";
  try {
    await first.store.savePlan(teamPlan("plan-replay", "replay-team"));
    revision = await revisionOf(first, "plan-replay");
    const withoutAlpha = removeAgent(first, "alpha");
    const failedSettled = first.store.terminalJob("same-job");
    await postBuild(first, {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    });
    assert.equal((await failedSettled).status, "failed");
    withoutAlpha.restore();
    // What a stop between recording the retry's admission and writing its
    // receipt leaves on disk. Written directly, because a process that dies
    // there runs no cleanup of its own.
    await first.store.savePlanAdmission({
      planId: "plan-replay",
      jobId: "orphaned-retry",
      revision,
      priorJobIds: ["same-job"],
    });
  } finally {
    await first.close();
  }

  const second = await serve({ repoRoot, workspacePath });
  try {
    await releaseDeadPlanAdmissions(second.store);

    // Rolled back, not released: the plan has been built against, and the
    // attempt that has a receipt is the one that holds it.
    const held = await second.store.getPlanAdmission("plan-replay");
    assert.equal(held?.jobId, "same-job", JSON.stringify(held));
    assert.equal(held?.revision, revision);
    assert.deepEqual(held?.priorJobIds, []);

    // And that lineage can still be retried through to a published team.
    const response = await fetch(
      `${second.origin}/create/resource-architect/jobs/same-job/retry`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: "a-second-attempt" }),
      },
    );
    assert.equal(response.status, 202, JSON.stringify(await response.json()));
    const finished = await second.store.terminalJob("a-second-attempt");
    assert.equal(finished.status, "completed", JSON.stringify(finished));
  } finally {
    await second.close();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Restoring an interrupted build is only worth anything if its Retry works. A
// build the API stopped mid-work is recorded as `interrupted`, and retrying
// that attempt must be admitted and finish the team it left half-built.
test("a Team build the API restart interrupted is retried through to publication", async () => {
  const repoRoot = makeRepo();
  const workspacePath = path.join(repoRoot, "workspace");
  const plan = teamPlan("plan-restart", "restart-team");
  assert.ok(plan.kind === "team");
  const first = await serve({ repoRoot, workspacePath });
  let revision = "";
  try {
    await first.store.savePlan(plan);
    revision = await revisionOf(first, plan.id);
    // What a process killed mid-build leaves on disk: the admission, the Team
    // shell the build had already made, and a job record still `running`.
    // Written directly, because a killed process runs no cleanup of its own.
    await first.store.savePlanAdmission({
      planId: plan.id,
      jobId: "killed-job",
      revision,
      priorJobIds: [],
    });
    const shell = await createTeamBuildShell({
      repoRoot,
      plan: plan.team,
      orchestratorKey: plan.id,
    });
    const killed = createResourceBuildSnapshot({
      plan,
      jobId: "killed-job",
      admittedRevision: revision,
    });
    killed.items[0] = { ...killed.items[0]!, status: "generating" };
    killed.events.push({
      id: killed.events.length + 1,
      type: "team_created",
      plannedResource: { kind: "team", id: shell.id },
      message: `Created Team shell \`${shell.id}\`.`,
    });
    await first.store.saveJob(killed);
  } finally {
    await first.close();
  }

  const second = await serve({ repoRoot, workspacePath });
  try {
    // Listing the jobs is where a restarted API reconciles them.
    assert.equal(
      (await fetch(`${second.origin}/create/resource-architect/jobs`)).status,
      200,
    );
    const interrupted = await second.store.getJob("killed-job");
    assert.equal(interrupted?.status, "interrupted", JSON.stringify(interrupted));
    // The attempt Create puts back on screen, with its Retry.
    assert.equal(
      restorableResourceBuildJob(await second.store.listJobs())?.jobId,
      "killed-job",
    );

    const settled = second.store.terminalJob("retried-after-restart");
    const response = await fetch(
      `${second.origin}/create/resource-architect/jobs/killed-job/retry`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: "retried-after-restart" }),
      },
    );
    assert.equal(response.status, 202, await response.text());
    const finished = await settled;
    assert.equal(finished.status, "completed", JSON.stringify(finished));
    assert.equal(finished.admittedRevision, revision);
    assert.notEqual(
      teamPublishedBy(repoRoot, "restart-team"),
      undefined,
      "the retried team was never published",
    );
  } finally {
    await second.close();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// A build that stopped leaves a Team shell on disk that nobody can use and
// nothing lists. Discarding it is the other half of what the restored card
// offers, and it is the one delete that must be allowed while a team is still
// marked as being built — every other write to such a team is refused.
test("a stopped build's shell can be discarded, and only by the build that made it", async () => {
  await withHarness(async (harness) => {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    await harness.store.savePlan(teamPlan("plan-other", "other-team"));
    const revision = await revisionOf(harness, "plan-replay");

    const withoutAlpha = removeAgent(harness, "alpha");
    const failedSettled = harness.store.terminalJob("same-job");
    await postBuild(harness, {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    });
    assert.equal((await failedSettled).status, "failed");
    withoutAlpha.restore();

    const shellPath = path.join(harness.repoRoot, "teams", "replay-team");
    assert.equal(fs.existsSync(shellPath), true, "the stopped build left no shell");

    // Another plan's job cannot discard it.
    const otherJobResponse = await postBuild(harness, {
      planId: "plan-other",
      jobId: "other-job",
      expectedRevision: await revisionOf(harness, "plan-other"),
    });
    assert.equal(otherJobResponse.status, 202);
    const trespass = await fetch(
      `${harness.origin}/create/resource-architect/jobs/other-job/discard`,
      { method: "POST" },
    );
    assert.notEqual(trespass.status, 200, await trespass.text());
    assert.equal(fs.existsSync(shellPath), true, "another plan's job deleted this shell");

    const discarded = await fetch(
      `${harness.origin}/create/resource-architect/jobs/same-job/discard`,
      { method: "POST" },
    );
    const body = (await discarded.json()) as Record<string, unknown>;
    assert.equal(discarded.status, 200, JSON.stringify(body));
    assert.equal(fs.existsSync(shellPath), false, "the shell was not removed");

    // The receipt says so, so the card stops offering to finish it.
    const job = await harness.store.getJob("same-job");
    assert.equal(job?.status, "cancelled", JSON.stringify(job));
    assert.equal(job?.items[0]?.resource, undefined, JSON.stringify(job?.items));
  });
});

// A published team is somebody's team. Discard is for what a build left behind,
// not a way around the delete rules.
test("a published team cannot be discarded through the build that made it", async () => {
  await withHarness(async (harness) => {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    const revision = await revisionOf(harness, "plan-replay");
    await buildToCompletion(harness, {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    });

    const refused = await fetch(
      `${harness.origin}/create/resource-architect/jobs/same-job/discard`,
      { method: "POST" },
    );
    assert.notEqual(refused.status, 200, await refused.text());
    assert.equal(
      fs.existsSync(path.join(harness.repoRoot, "teams", "replay-team")),
      true,
      "a published team was deleted by discard",
    );
  });
});

// Discard is about what an attempt left behind. A newer attempt of the same
// lineage owns the shell now, so an older receipt must not delete it out from
// under the attempt the user is actually waiting on.
test("an older attempt cannot discard the shell a newer retry owns", async () => {
  await withHarness(async (harness) => {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    const revision = await revisionOf(harness, "plan-replay");

    const withoutAlpha = removeAgent(harness, "alpha");
    const firstSettled = harness.store.terminalJob("same-job");
    await postBuild(harness, {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    });
    assert.equal((await firstSettled).status, "failed");

    // A retry, still failing, so both attempts have receipts naming the shell.
    const retrySettled = harness.store.terminalJob("second-attempt");
    const retried = await fetch(
      `${harness.origin}/create/resource-architect/jobs/same-job/retry`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: "second-attempt" }),
      },
    );
    assert.equal(retried.status, 202, JSON.stringify(await retried.json()));
    await retrySettled;
    withoutAlpha.restore();

    const stale = await fetch(
      `${harness.origin}/create/resource-architect/jobs/same-job/discard`,
      { method: "POST" },
    );
    assert.notEqual(stale.status, 200, await stale.text());
    assert.equal(
      fs.existsSync(path.join(harness.repoRoot, "teams", "replay-team")),
      true,
      "an older attempt deleted the shell the newer one owns",
    );
  });
});

// Throwing the team away is a decision, and it has to survive the page. A
// discarded attempt is not offered for retry and is not put back on screen.
test("a discarded build is not retried and is not restored", async () => {
  const repoRoot = makeRepo();
  const workspacePath = path.join(repoRoot, "workspace");
  const harness = await serve({ repoRoot, workspacePath });
  try {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    const revision = await revisionOf(harness, "plan-replay");
    const withoutAlpha = removeAgent(harness, "alpha");
    const settled = harness.store.terminalJob("same-job");
    await postBuild(harness, {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    });
    assert.equal((await settled).status, "failed");
    withoutAlpha.restore();

    const discarded = await fetch(
      `${harness.origin}/create/resource-architect/jobs/same-job/discard`,
      { method: "POST" },
    );
    assert.equal(discarded.status, 200, await discarded.text());

    // The one shared Agent the plan reused is not the build's to remove.
    assert.equal(
      fs.existsSync(path.join(repoRoot, "agents", "alpha")),
      true,
      "discard removed a shared Agent",
    );
    // The registry entry goes with the directory.
    assert.doesNotMatch(
      fs.readFileSync(path.join(repoRoot, "teams.yaml"), "utf8"),
      /replay-team/u,
    );

    const retried = await fetch(
      `${harness.origin}/create/resource-architect/jobs/same-job/retry`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    assert.notEqual(retried.status, 202, await retried.text());
    assert.equal(
      fs.existsSync(path.join(repoRoot, "teams", "replay-team")),
      false,
      "retrying a discarded build rebuilt the shell",
    );

    // And the record says it was discarded, so a reopened Create knows.
    const job = await harness.store.getJob("same-job");
    assert.equal(job?.discarded, true, JSON.stringify(job));
  } finally {
    await harness.close();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// The decision has to survive the process. A cancelled receipt alone is not
// one: a second server reading the same files would take it for an attempt
// worth retrying and rebuild the shell the user removed.
test("a discarded build stays discarded after a restart", async () => {
  const repoRoot = makeRepo();
  const workspacePath = path.join(repoRoot, "workspace");
  const first = await serve({ repoRoot, workspacePath });
  try {
    await first.store.savePlan(teamPlan("plan-replay", "replay-team"));
    const revision = await revisionOf(first, "plan-replay");
    const withoutAlpha = removeAgent(first, "alpha");
    const settled = first.store.terminalJob("same-job");
    await postBuild(first, {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    });
    assert.equal((await settled).status, "failed");
    withoutAlpha.restore();

    const discarded = await fetch(
      `${first.origin}/create/resource-architect/jobs/same-job/discard`,
      { method: "POST" },
    );
    assert.equal(discarded.status, 200, await discarded.text());
  } finally {
    await first.close();
  }

  // A second process over the same files, with nothing in memory.
  const second = await serve({ repoRoot, workspacePath });
  try {
    const retried = await fetch(
      `${second.origin}/create/resource-architect/jobs/same-job/retry`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    assert.notEqual(retried.status, 202, await retried.text());
    assert.equal(
      fs.existsSync(path.join(repoRoot, "teams", "replay-team")),
      false,
      "a cold retry rebuilt a discarded shell",
    );
  } finally {
    await second.close();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// One plan's lineage has many receipts, and every one of them was a way back.
// Discarding the latest attempt has to close all of them, including after a
// restart, or retrying the first attempt rebuilds what the user removed.
test("discarding one attempt closes every earlier attempt of the same plan", async () => {
  const repoRoot = makeRepo();
  const workspacePath = path.join(repoRoot, "workspace");
  const first = await serve({ repoRoot, workspacePath });
  try {
    await first.store.savePlan(teamPlan("plan-replay", "replay-team"));
    const revision = await revisionOf(first, "plan-replay");
    const withoutAlpha = removeAgent(first, "alpha");

    const firstSettled = first.store.terminalJob("first-attempt");
    await postBuild(first, {
      planId: "plan-replay",
      jobId: "first-attempt",
      expectedRevision: revision,
    });
    assert.equal((await firstSettled).status, "failed");

    const secondSettled = first.store.terminalJob("second-attempt");
    const retried = await fetch(
      `${first.origin}/create/resource-architect/jobs/first-attempt/retry`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: "second-attempt" }),
      },
    );
    assert.equal(retried.status, 202, JSON.stringify(await retried.json()));
    assert.equal((await secondSettled).status, "failed");
    withoutAlpha.restore();

    const discarded = await fetch(
      `${first.origin}/create/resource-architect/jobs/second-attempt/discard`,
      { method: "POST" },
    );
    assert.equal(discarded.status, 200, await discarded.text());
  } finally {
    await first.close();
  }

  const second = await serve({ repoRoot, workspacePath });
  try {
    // The ancestor, which carries no discard flag of its own.
    const ancestor = await fetch(
      `${second.origin}/create/resource-architect/jobs/first-attempt/retry`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    assert.notEqual(ancestor.status, 202, await ancestor.text());
    assert.equal(
      fs.existsSync(path.join(repoRoot, "teams", "replay-team")),
      false,
      "retrying an ancestor rebuilt a discarded shell",
    );

    // And a fresh submission for the same plan is refused for the same reason.
    const fresh = await postBuild(second, {
      planId: "plan-replay",
      jobId: "a-third-attempt",
      expectedRevision: await revisionOf(second, "plan-replay"),
    });
    assert.equal(fresh.status, 409, JSON.stringify(fresh.body));
    assert.equal(fresh.body.error, "build_discarded");
  } finally {
    await second.close();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Discard destroys something. The decision has to be on disk before the
// destruction, or a failure in between leaves a team that is gone and a plan
// that still thinks it can be retried — which rebuilds what the user removed.
test("a discard that cannot record its decision destroys nothing", async () => {
  const repoRoot = makeRepo();
  const workspacePath = path.join(repoRoot, "workspace");
  const first = await serve({ repoRoot, workspacePath });
  const admissionsDir = path.join(workspacePath, "resource-plan-admissions");
  try {
    await first.store.savePlan(teamPlan("plan-replay", "replay-team"));
    const revision = await revisionOf(first, "plan-replay");
    const withoutAlpha = removeAgent(first, "alpha");
    const settled = first.store.terminalJob("same-job");
    await postBuild(first, {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    });
    assert.equal((await settled).status, "failed");
    withoutAlpha.restore();

    // The admission record's own directory, replaced by a file. Nothing can be
    // written there until it is put back.
    fs.rmSync(admissionsDir, { recursive: true, force: true });
    fs.writeFileSync(admissionsDir, "not a directory");

    const refused = await fetch(
      `${first.origin}/create/resource-architect/jobs/same-job/discard`,
      { method: "POST" },
    );
    assert.notEqual(refused.status, 200, await refused.text());
    assert.equal(
      fs.existsSync(path.join(repoRoot, "teams", "replay-team")),
      true,
      "a discard that could not be recorded deleted the team anyway",
    );

    // Repaired, the same action finishes.
    fs.rmSync(admissionsDir, { force: true });
    const discarded = await fetch(
      `${first.origin}/create/resource-architect/jobs/same-job/discard`,
      { method: "POST" },
    );
    assert.equal(discarded.status, 200, await discarded.text());
    assert.equal(fs.existsSync(path.join(repoRoot, "teams", "replay-team")), false);
  } finally {
    await first.close();
  }

  // And a second process agrees.
  const second = await serve({ repoRoot, workspacePath });
  try {
    const retried = await fetch(
      `${second.origin}/create/resource-architect/jobs/same-job/retry`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    assert.notEqual(retried.status, 202, await retried.text());
    assert.equal(
      fs.existsSync(path.join(repoRoot, "teams", "replay-team")),
      false,
      "a cold retry rebuilt a discarded shell",
    );
  } finally {
    await second.close();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// A discard whose later writes fail leaves a team that is gone and a receipt
// that does not say so. Asking again finishes the job rather than refusing it.
test("discarding again finishes a cleanup that was interrupted", async () => {
  await withHarness(async (harness) => {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    const revision = await revisionOf(harness, "plan-replay");
    const withoutAlpha = removeAgent(harness, "alpha");
    const settled = harness.store.terminalJob("same-job");
    await postBuild(harness, {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    });
    assert.equal((await settled).status, "failed");
    withoutAlpha.restore();

    // The state a stop between the deletion and the receipt leaves: the
    // decision is recorded, the team is gone, the receipt still says failed.
    const admission = await harness.store.getPlanAdmission("plan-replay");
    assert.ok(admission);
    await harness.store.savePlanAdmission({ ...admission, discarded: true });
    fs.rmSync(path.join(harness.repoRoot, "teams", "replay-team"), {
      recursive: true,
      force: true,
    });

    const finished = await fetch(
      `${harness.origin}/create/resource-architect/jobs/same-job/discard`,
      { method: "POST" },
    );
    assert.equal(finished.status, 200, await finished.text());
    const job = await harness.store.getJob("same-job");
    assert.equal(job?.discarded, true, JSON.stringify(job));
    // Both halves, not just the one that happened to be done already. An entry
    // left naming a team that is gone is a catalog that lies.
    assert.doesNotMatch(
      fs.readFileSync(path.join(harness.repoRoot, "teams.yaml"), "utf8"),
      /replay-team/u,
    );
  });
});

// Missing provenance is not permission. A team whose file no longer says who
// built it, or no longer says it is being built, is not this build's to remove
// — and a file nobody can read proves nothing at all.
test("a team that no longer says this build made it is not discarded", async () => {
  for (
    const [name, edit] of [
      [
        "no longer owned",
        (yaml: string) => yaml.replace(/^\s*created_by_orchestrator:.*$/mu, ""),
      ],
      ["no longer building", (yaml: string) => yaml.replace(/^\s*building: true\n/mu, "")],
      ["unreadable", () => "team:\n  name: [unclosed\n"],
    ] as const
  ) {
    await withHarness(async (harness) => {
      await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
      const revision = await revisionOf(harness, "plan-replay");
      const withoutAlpha = removeAgent(harness, "alpha");
      const settled = harness.store.terminalJob("same-job");
      await postBuild(harness, {
        planId: "plan-replay",
        jobId: "same-job",
        expectedRevision: revision,
      });
      assert.equal((await settled).status, "failed");
      withoutAlpha.restore();

      const teamYamlPath = path.join(
        harness.repoRoot,
        "teams",
        "replay-team",
        "team.yaml",
      );
      fs.writeFileSync(teamYamlPath, edit(fs.readFileSync(teamYamlPath, "utf8")));

      const refused = await fetch(
        `${harness.origin}/create/resource-architect/jobs/same-job/discard`,
        { method: "POST" },
      );
      assert.notEqual(refused.status, 200, `${name}: ${await refused.text()}`);
      assert.equal(
        fs.existsSync(path.join(harness.repoRoot, "teams", "replay-team")),
        true,
        `${name}: the directory was deleted anyway`,
      );
    });
  }
});

// A team that is simply not there is only finishable when the decision to
// discard it is already recorded. Otherwise "gone" is just something that
// happened, and reporting a discard would be inventing one.
test("a build whose team is already missing is not reported as discarded", async () => {
  await withHarness(async (harness) => {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    const revision = await revisionOf(harness, "plan-replay");
    const withoutAlpha = removeAgent(harness, "alpha");
    const settled = harness.store.terminalJob("same-job");
    await postBuild(harness, {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    });
    assert.equal((await settled).status, "failed");
    withoutAlpha.restore();

    // Removed by something else entirely, with no discard recorded.
    fs.rmSync(path.join(harness.repoRoot, "teams", "replay-team"), {
      recursive: true,
      force: true,
    });

    const refused = await fetch(
      `${harness.origin}/create/resource-architect/jobs/same-job/discard`,
      { method: "POST" },
    );
    assert.notEqual(refused.status, 200, await refused.text());
    const job = await harness.store.getJob("same-job");
    assert.notEqual(job?.discarded, true, JSON.stringify(job));
  });
});

/**
 * Whether file permissions can stop this process at all.
 *
 * The two tests below take a directory's write permission away and expect the
 * removal inside it to be refused. Root is not refused by a mode bit, so under
 * root the removal succeeds and the test fails for a reason that says nothing
 * about the product. Skipped there, and only there: for an ordinary user the
 * refusal is exactly what is being asserted, so an actual failure is never
 * masked by this.
 */
const PERMISSIONS_RESTRAIN_THIS_PROCESS =
  typeof process.geteuid !== "function" || process.geteuid() !== 0;
const ROOT_SKIP = PERMISSIONS_RESTRAIN_THIS_PROCESS
  ? false
  : "running as root: directory permissions do not refuse this process";

// The registry write and the folder removal are two things, and the second can
// fail on its own. Reporting the discard as done then leaves a folder nothing
// points at and nothing left to ask again.
test("a discard whose folder cannot be removed says so, and finishes later", { skip: ROOT_SKIP }, async () => {
  await withHarness(async (harness) => {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    const revision = await revisionOf(harness, "plan-replay");
    const withoutAlpha = removeAgent(harness, "alpha");
    const settled = harness.store.terminalJob("same-job");
    await postBuild(harness, {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    });
    assert.equal((await settled).status, "failed");
    withoutAlpha.restore();

    // The folder's own parent made read-only, so its entry cannot be unlinked.
    const teamsRoot = path.join(harness.repoRoot, "teams");
    const teamPath = path.join(teamsRoot, "replay-team");
    fs.chmodSync(teamsRoot, 0o555);
    try {
      const refused = await fetch(
        `${harness.origin}/create/resource-architect/jobs/same-job/discard`,
        { method: "POST" },
      );
      assert.notEqual(refused.status, 200, await refused.text());
      assert.equal(fs.existsSync(teamPath), true);
      const stranded = await harness.store.getJob("same-job");
      assert.notEqual(stranded?.discarded, true, JSON.stringify(stranded));
    } finally {
      fs.chmodSync(teamsRoot, 0o755);
    }

    // Permissions restored, asking again finishes what was started — including
    // the registry entry, which the first attempt had already removed.
    const finished = await fetch(
      `${harness.origin}/create/resource-architect/jobs/same-job/discard`,
      { method: "POST" },
    );
    assert.equal(finished.status, 200, await finished.text());
    assert.equal(fs.existsSync(teamPath), false);
    assert.doesNotMatch(
      fs.readFileSync(path.join(harness.repoRoot, "teams.yaml"), "utf8"),
      /replay-team/u,
    );
    const job = await harness.store.getJob("same-job");
    assert.equal(job?.discarded, true, JSON.stringify(job));
  });
});

// A path that cannot be examined is not a path that is empty. Reading "no" from
// a permission error let a discard report success over a folder that was still
// there, and the retry that would have finished it was then refused.
test("a discard that cannot examine the team says so rather than assuming it is gone", { skip: ROOT_SKIP }, async () => {
  await withHarness(async (harness) => {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    const revision = await revisionOf(harness, "plan-replay");
    const withoutAlpha = removeAgent(harness, "alpha");
    const settled = harness.store.terminalJob("same-job");
    await postBuild(harness, {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    });
    assert.equal((await settled).status, "failed");
    withoutAlpha.restore();

    // Exactly what an earlier attempt that got as far as the registry leaves:
    // the decision recorded, the entry gone, the folder still there.
    const admission = await harness.store.getPlanAdmission("plan-replay");
    assert.ok(admission);
    await harness.store.savePlanAdmission({ ...admission, discarded: true });
    fs.writeFileSync(path.join(harness.repoRoot, "teams.yaml"), "");

    const teamsRoot = path.join(harness.repoRoot, "teams");
    fs.chmodSync(teamsRoot, 0o000);
    try {
      const refused = await fetch(
        `${harness.origin}/create/resource-architect/jobs/same-job/discard`,
        { method: "POST" },
      );
      assert.notEqual(refused.status, 200, await refused.text());
      const job = await harness.store.getJob("same-job");
      assert.notEqual(job?.discarded, true, JSON.stringify(job));
    } finally {
      fs.chmodSync(teamsRoot, 0o755);
    }

    // The folder was there all along, and asking again finishes the cleanup.
    assert.equal(fs.existsSync(path.join(teamsRoot, "replay-team")), true);
    const finished = await fetch(
      `${harness.origin}/create/resource-architect/jobs/same-job/discard`,
      { method: "POST" },
    );
    assert.equal(finished.status, 200, await finished.text());
    assert.equal(fs.existsSync(path.join(teamsRoot, "replay-team")), false);
    const job = await harness.store.getJob("same-job");
    assert.equal(job?.discarded, true, JSON.stringify(job));
  });
});

// Discard reads who owns the team and whether it is finished, and then removes
// it. A publication landing between those two moments turns the thing being
// removed into a real team — so the check has to be inside the same critical
// section as the removal, not before it.
test("a publication that lands mid-discard stops the removal", async () => {
  await withHarness(async (harness) => {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    const revision = await revisionOf(harness, "plan-replay");
    const withoutAlpha = removeAgent(harness, "alpha");
    const settled = harness.store.terminalJob("same-job");
    await postBuild(harness, {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    });
    assert.equal((await settled).status, "failed");
    withoutAlpha.restore();

    // The shell is completed by hand, the way a build finishing would.
    await addTeamBuilderAgent({
      repoRoot: harness.repoRoot,
      teamId: "replay-team",
      agentName: "alpha",
    });

    // The registry writer is held, so publication and discard are forced to
    // queue on it rather than interleave by luck.
    const registryPath = path.join(harness.repoRoot, "teams.yaml");
    let releaseWriter = (): void => {};
    const writerHeld = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const holding = withFileMutationLock(registryPath, () => writerHeld);

    let answer: Response;
    try {
      // The decision reaching the disk is the signal, announced by the store
      // itself: nothing here waits on a clock.
      const intentRecorded = harness.store.discardIntentRecorded();
      const publishing = finishTeamBuilderPublication(
        harness.repoRoot,
        "replay-team",
        { admittedRevision: revision },
      );
      const discarding = fetch(
        `${harness.origin}/create/resource-architect/jobs/same-job/discard`,
        { method: "POST", signal: AbortSignal.timeout(30_000) },
      );
      // The discard has read the team and recorded its intent; the publication
      // is still queued behind the writer.
      await intentRecorded;
      releaseWriter();
      await holding;
      await publishing;
      answer = await discarding;
    } finally {
      // Whatever went wrong above, the writer is not left held: every later
      // test and every later gate would queue behind it forever.
      releaseWriter();
    }
    // `publishing` resolving is the evidence, not a later read: publication
    // writes its record inside the lock, so a read afterwards would find
    // nothing precisely when the defect has occurred.
    assert.equal(
      fs.existsSync(path.join(harness.repoRoot, "teams", "replay-team")),
      true,
      "a published team was deleted by a discard that began before it",
    );
    // A known state of the team, answered as one.
    assert.equal(answer.status, 409, await answer.text());
    assert.notEqual(
      teamPublishedBy(harness.repoRoot, "replay-team"),
      undefined,
      "the team survived but its publication record did not",
    );
  });
});



// The exact job id of a discarded build, submitted again.
//
// Replay answered first: a request carrying an id that already has a record was
// handed that record back, and a discarded receipt is a record. So the reply
// was 202 with `discarded: true` — which reads as a build in progress — and
// nothing said the plan had been thrown away. The durable decision has to be
// read before any fast path answers, because every receipt in the lineage is
// otherwise a way back to the shell the user removed.
test("a discarded plan refuses its own job id rather than replaying it", async () => {
  await withHarness(async (harness) => {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    const revision = await revisionOf(harness, "plan-replay");

    const withoutAlpha = removeAgent(harness, "alpha");
    const failed = harness.store.terminalJob("same-job");
    const request = {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    };
    await postBuild(harness, request);
    assert.equal((await failed).status, "failed");
    withoutAlpha.restore();

    const shellPath = path.join(harness.repoRoot, "teams", "replay-team");
    assert.equal(fs.existsSync(shellPath), true, "the stopped build left no shell");
    const discarded = await fetch(
      `${harness.origin}/create/resource-architect/jobs/same-job/discard`,
      { method: "POST" },
    );
    assert.equal(discarded.status, 200, await discarded.text());
    assert.equal(fs.existsSync(shellPath), false, "the shell was not removed");

    // The identical request again, under the very id that was discarded.
    const replay = await postBuild(harness, request);
    assert.equal(replay.status, 409, JSON.stringify(replay.body));
    assert.equal(replay.body.error, "build_discarded");

    // Nothing was rebuilt and no receipt was rewritten: the team stays gone
    // and the record still says it was thrown away.
    assert.equal(fs.existsSync(shellPath), false, "the discarded team came back");
    const job = await harness.store.getJob("same-job");
    assert.equal(job?.discarded, true, JSON.stringify(job));
    assert.equal(job?.status, "cancelled", JSON.stringify(job));
  });
});

// The same refusal, reached down the other road in. When the registry still
// holds the id — a build the user has just stopped, say — the section answers
// before it reads the plan at all, and that path had no discard check either.
test("a discarded plan refuses a submission the registry is still holding", async () => {
  await withHarness(async (harness) => {
    await harness.store.savePlan(teamPlan("plan-replay", "replay-team"));
    const revision = await revisionOf(harness, "plan-replay");

    const withoutAlpha = removeAgent(harness, "alpha");
    const failed = harness.store.terminalJob("same-job");
    await postBuild(harness, {
      planId: "plan-replay",
      jobId: "same-job",
      expectedRevision: revision,
    });
    assert.equal((await failed).status, "failed");
    withoutAlpha.restore();

    const discarded = await fetch(
      `${harness.origin}/create/resource-architect/jobs/same-job/discard`,
      { method: "POST" },
    );
    assert.equal(discarded.status, 200, await discarded.text());

    // A fresh id for the same discarded plan, with the id held by the registry
    // so the busy path is the one that answers.
    const held = harness.registry.start("held-job");
    assert.equal(held.status, "started");
    try {
      const replay = await postBuild(harness, {
        planId: "plan-replay",
        jobId: "held-job",
        expectedRevision: revision,
      });
      assert.equal(replay.status, 409, JSON.stringify(replay.body));
      assert.equal(replay.body.error, "build_discarded");
    } finally {
      harness.registry.finish("held-job");
    }
  });
});

/**
 * A loopback skill author for a skill-update retry.
 *
 * It refuses the first request for `failOnce`, holds the next request for that
 * skill until `release()`, and answers every other request with a conforming
 * document. `heldRequestArrived` resolves when the held request comes in, so a
 * test can look at the job while that provider call is still open.
 */
async function startRetryingSkillAuthor(failOnce: string): Promise<{
  url: string;
  requestedSkills: () => string[];
  heldRequestArrived: Promise<void>;
  release: () => void;
  close: () => Promise<void>;
}> {
  const requestedSkills: string[] = [];
  const held: Array<() => void> = [];
  let released = false;
  let announceHeld = (): void => undefined;
  const heldRequestArrived = new Promise<void>((resolve) => {
    announceHeld = resolve;
  });
  const answer = (response: http.ServerResponse, name: string): void => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      model: "local-test-model",
      choices: [{
        message: {
          content: JSON.stringify({
            name,
            body: [
              "---",
              `name: ${name}`,
              "description: >",
              `  Walk a contract draft through the ${name} procedure clause by clause.`,
              `  Use when a draft reaches ${name} and the reviewer needs the checklist.`,
              "---",
              "",
              `# ${name}`,
              "",
            ].join("\n"),
          }),
        },
      }],
    }));
  };
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const lastUser = lastUserMessage(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const name = lastUser.match(/Skill folder name:\s*`([^`]+)`/i)?.[1] ?? "";
      requestedSkills.push(name);
      const attempts = requestedSkills.filter((requested) => requested === name).length;
      if (name === failOnce && attempts === 1) {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("the skill author stalled");
        return;
      }
      if (name === failOnce && attempts === 2 && !released) {
        held.push(() => answer(response, name));
        announceHeld();
        return;
      }
      answer(response, name);
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
    heldRequestArrived,
    release: () => {
      released = true;
      for (const reply of held.splice(0)) reply();
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    }),
  };
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

/** The skill-scoped events of a job, as [type, skill] in order. */
function skillProgress(job: ResourceBuildJobSnapshot): Array<[string, string]> {
  return job.events.flatMap<[string, string]>((event) =>
    event.skill ? [[event.type, event.skill.name]] : []
  );
}

/** The job a job route answered with, read by the same parser the store uses. */
function jobFrom(body: unknown): ResourceBuildJobSnapshot {
  const job = typeof body === "object" && body !== null && "job" in body
    ? parseResourceBuildJobRecord(body.job)
    : null;
  assert.ok(job, `expected a job in ${JSON.stringify(body)}`);
  return job;
}

test("a skill-update retry starts from the skills its receipt already staged", async () => {
  await withHarness(async (harness) => {
    const FIRST = "termination-clause-review";
    const SECOND = "indemnity-clause-review";
    // The skill author is configured the way the application configures it.
    const workflowArchitect = path.join(harness.repoRoot, "teams", "workflow-architect");
    fs.mkdirSync(workflowArchitect, { recursive: true });
    fs.writeFileSync(
      path.join(workflowArchitect, "team.yaml"),
      [
        "team:",
        "  name: workflow-architect",
        "agents:",
        "  - name: resource-architect",
        "    agent_file: ../../agents/resource-architect/resource-architect.md",
        "",
      ].join("\n"),
    );
    const author = await startRetryingSkillAuthor(SECOND);
    const previousKey = process.env.OPENAI_API_KEY;
    const previousUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
    process.env.OPENAI_API_KEY = "local-test-key";
    process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = author.url;
    try {
      await harness.store.savePlan({
        id: "skill-retry-plan",
        kind: "resource_updates",
        operations: [{
          kind: "update_agent_skills",
          target: { kind: "agent", id: "alpha" },
          expectedRevision: computeAgentRevision(harness.repoRoot, "alpha"),
          skillUpdates: [
            { action: "create", name: FIRST, instruction: "Author the termination review." },
            { action: "create", name: SECOND, instruction: "Author the indemnity review." },
          ],
        }],
      });
      const failedSettled = harness.store.terminalJob("skill-job");
      const admitted = await postBuild(harness, { planId: "skill-retry-plan", jobId: "skill-job" });
      assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
      const failed = await failedSettled;
      assert.equal(failed.status, "failed", JSON.stringify(failed));

      const response = await fetch(
        `${harness.origin}/create/resource-architect/jobs/skill-job/retry`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );
      const parsed: unknown = await response.json();
      assert.equal(response.status, 202, JSON.stringify(parsed));
      const retryJobId = typeof parsed === "object" && parsed !== null && "jobId" in parsed
        ? String(parsed.jobId)
        : "";

      // While the retry's only provider call is open, the replacement job
      // already reports the skill its receipt staged.
      await author.heldRequestArrived;
      const midway = await fetch(
        `${harness.origin}/create/resource-architect/jobs/${encodeURIComponent(retryJobId)}`,
      );
      const job = jobFrom(await midway.json());
      assert.deepEqual(skillProgress(job), [
        ["skill_staged", FIRST],
        ["skill_generating", SECOND],
      ]);
      assert.deepEqual(author.requestedSkills(), [FIRST, SECOND, SECOND]);

      const completedSettled = harness.store.terminalJob(retryJobId);
      author.release();
      const completed = await completedSettled;
      assert.equal(completed.status, "completed", JSON.stringify(completed));
      assert.deepEqual(skillProgress(completed), [
        ["skill_staged", FIRST],
        ["skill_generating", SECOND],
        ["skill_staged", SECOND],
        ["skill_updated", FIRST],
        ["skill_updated", SECOND],
      ]);
    } finally {
      author.release();
      await author.close();
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
      if (previousUrl === undefined) delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
      else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousUrl;
    }
  });
});
