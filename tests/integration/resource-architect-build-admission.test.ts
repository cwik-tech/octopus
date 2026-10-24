/**
 * Admitting a build has to see the same plan the user was shown.
 *
 * The amendment endpoint reads, checks a revision and writes inside
 * `withPlanLock`. Admission read the plan and claimed it outside that lock and
 * never looked at a revision at all, so a build could be admitted against the
 * plan as it was before an accepted amendment — and the team built would not be
 * the team the card described.
 *
 * The contender here is never required to enter a held lock. It is started
 * outside the critical section, unrelated work is observed proceeding while the
 * lock is held, and only after release is its outcome asserted.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import type { ResourceArchitectPlan } from "../../contracts/resource-architect.js";
import type { TeamShape } from "../../contracts/schemas/team-shape.js";
import { CreateJobRegistry } from "../../server/create-job-registry.js";
import { ResourceArchitectStore } from "../../server/resource-architect-store.js";
import { handleResourceArchitectRoutes } from "../../server/routes/resource-architect.js";

const discussion: TeamShape = {
  kind: "discussion",
  rationale: "They disagree usefully.",
  depth: "standard",
  coordinator: "risk-lead",
  participants: ["risk-spotter"],
};

const review: TeamShape = {
  kind: "review",
  rationale: "One writes, one checks.",
  depth: "quick",
  producer: "risk-lead",
  reviewer: "risk-spotter",
};

function teamPlan(id: string, shape: TeamShape): ResourceArchitectPlan {
  return {
    id,
    kind: "team",
    team: {
      teamId: `team-${id}`,
      description: "Reviews contracts.",
      tags: [],
      existingAgents: [
        { name: "risk-lead", role: "Lead", rationale: "Already available." },
      ],
      newAgents: [{
        name: "risk-spotter",
        role: "Risk reviewer",
        description: "Finds risky clauses.",
        rationale: "Needed.",
      }],
      questionsResolved: [],
      shape,
    },
  };
}

/**
 * A repo the build route can start from.
 *
 * The architect team must exist or the route fails before admission is even
 * reached, which would make every assertion here about the wrong thing. Copied
 * from `resource-architect-build-route.test.ts`, which starts the same route.
 */
function makeRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "build-admission-"));
  const teamDir = path.join(repoRoot, "teams", "resource-architect");
  const agentDir = path.join(repoRoot, "agents", "resource-architect");
  fs.mkdirSync(teamDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, "team.yaml"),
    [
      "team:",
      "  name: resource-architect",
      "agents:",
      "  - name: resource-architect",
      "    agent_file: ../../agents/resource-architect/resource-architect.md",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(agentDir, "resource-architect.md"),
    "---\nprovider: openai\nmodel: local-test-model\n---\n\nDesign one workflow from the brief.\n",
  );
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
  return repoRoot;
}

/**
 * A stored plan whose shape was read back as unbuildable.
 *
 * The key is omitted rather than set to `undefined`: the revision digest is
 * canonical JSON, which refuses an explicit undefined, and a record on disk
 * never carries one either.
 */
function rejectedShapePlan(id: string): ResourceArchitectPlan {
  const plan = teamPlan(id, discussion);
  assert.ok(plan.kind === "team");
  const { shape: _unbuildable, ...team } = plan.team;
  return { ...plan, team: { ...team, shapeRejected: true } };
}

interface Harness {
  url: string;
  store: ResourceArchitectStore;
  repoRoot: string;
  /** Resolves once a build request for this plan has reached the server. */
  buildRequestReached(planId: string): Promise<void>;
  close(): Promise<void>;
}

async function startHarness(
  plans: ResourceArchitectPlan[],
  provided?: ResourceArchitectStore,
): Promise<Harness> {
  const repoRoot = makeRepo();
  const store = provided ?? new ResourceArchitectStore();
  const registry = new CreateJobRegistry();
  // An empty list means "use what is already on disk", which is what a
  // restart does: the stored plan is the authority, not a fresh copy.
  for (const plan of plans) await store.savePlan(plan);

  const arrived = new Map<string, () => void>();
  const arrivals = new Set<string>();
  const noteArrival = (planId: string): void => {
    arrivals.add(planId);
    arrived.get(planId)?.();
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname.endsWith("/jobs")) {
      // The body is read by the route, so the plan id is recovered from the
      // job id the test supplies rather than by consuming the stream here.
      noteArrival(req.headers["x-test-plan"] as string);
    }
    void handleResourceArchitectRoutes({
      req,
      res,
      url,
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
        if (!res.writableEnded) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    store,
    repoRoot,
    buildRequestReached: (planId: string) =>
      arrivals.has(planId)
        ? Promise.resolve()
        : new Promise<void>((resolve) => arrived.set(planId, resolve)),
    close: () =>
      new Promise<void>((resolve, reject) => {
        registry.close();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }).finally(() => fs.rmSync(repoRoot, { recursive: true, force: true })),
  };
}

async function postBuild(
  harness: Harness,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${harness.url}/create/resource-architect/jobs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-plan": String(body.planId),
    },
    body: JSON.stringify(body),
  });
  const parsed: unknown = await response.json().catch(() => ({}));
  return {
    status: response.status,
    body: parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {},
  };
}

async function currentRevision(harness: Harness, planId: string): Promise<string> {
  const response = await fetch(
    `${harness.url}/create/resource-architect/plans/${planId}/shape`,
  );
  const parsed = (await response.json()) as Record<string, unknown>;
  return String(parsed.revision);
}

/** A promise plus the handle that settles it, so nothing waits on a clock. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test("a build admitted against a revision that has since moved is refused", async () => {
  const harness = await startHarness([
    teamPlan("plan-a", discussion),
    teamPlan("plan-other", discussion),
  ]);
  try {
    const stale = await currentRevision(harness, "plan-a");

    // The amendment's critical section, held open. The contender is started
    // outside it and is never asked to enter it while it is held.
    const entered = deferred();
    const release = deferred();
    // The write happens only AFTER the contender has reached the server. So a
    // route that read the plan outside this lock would still see the old plan,
    // match the stale revision, and be admitted — which is what makes this a
    // test of mutual exclusion rather than only of the revision comparison.
    const amended = harness.store.withPlanLock("plan-a", async () => {
      entered.resolve();
      await release.promise;
      const plan = await harness.store.getPlan("plan-a");
      assert.ok(plan?.kind === "team");
      await harness.store.savePlan({
        ...plan,
        team: { ...plan.team, shape: review },
      });
    });
    await entered.promise;

    const contender = postBuild(harness, {
      planId: "plan-a",
      jobId: "job-stale",
      expectedRevision: stale,
    });
    // Proven to have reached the real request boundary, not merely scheduled.
    await harness.buildRequestReached("plan-a");

    // Unrelated work proceeds while the lock is held: the lock is scoped to one
    // plan and does not stall the server.
    const otherResponse = await fetch(
      `${harness.url}/create/resource-architect/plans/plan-other/shape`,
    );
    assert.equal(otherResponse.status, 200);
    const otherBody = (await otherResponse.json()) as Record<string, unknown>;
    assert.equal(typeof otherBody.revision, "string");
    assert.match(String(otherBody.revision), /^sha256:/u);

    release.resolve();
    await amended;

    const result = await contender;
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.error, "plan_revision_conflict");
    // The card can redraw from what is actually stored.
    assert.equal(typeof result.body.currentRevision, "string");
    assert.notEqual(result.body.currentRevision, stale);
  } finally {
    await harness.close();
  }
});

// Retry sends no revision, because it rebuilds the lineage already admitted
// rather than a plan the user is looking at. Requiring one would break it.
test("a build with no expected revision is still admitted", async () => {
  const harness = await startHarness([teamPlan("plan-b", discussion)]);
  try {
    const result = await postBuild(harness, { planId: "plan-b", jobId: "job-b" });
    assert.equal(result.status, 202, JSON.stringify(result.body));
  } finally {
    await harness.close();
  }
});

// A stored shape that no longer parses must not build the legacy chain in its
// place. The plan stays loadable so it can be repaired by amendment.
test("a plan whose stored shape was rejected is not built as a chain", async () => {
  const harness = await startHarness([]);
  try {
    // What a hand-edited or older file can hold.
    await harness.store.savePlan(rejectedShapePlan("plan-c"));

    const result = await postBuild(harness, { planId: "plan-c", jobId: "job-c" });
    assert.equal(result.status, 422, JSON.stringify(result.body));
    assert.equal(result.body.error, "invalid_shape");
  } finally {
    await harness.close();
  }
});

// Anything that can throw between taking the plan claim and launching the build
// has to give the claim back, or the plan can never be applied again — and the
// user is told it is "already being applied" by a build that never started.
test("a configuration failure gives the plan claim back, so a repaired retry works", async () => {
  const harness = await startHarness([teamPlan("plan-d", discussion)]);
  try {
    const architectTeamYaml = path.join(
      harness.repoRoot,
      "teams",
      "resource-architect",
      "team.yaml",
    );
    const saved = fs.readFileSync(architectTeamYaml, "utf8");
    fs.rmSync(architectTeamYaml);

    const failed = await postBuild(harness, { planId: "plan-d", jobId: "job-d1" });
    assert.notEqual(failed.status, 202, JSON.stringify(failed.body));
    assert.equal(
      harness.store.isPlanBeingApplied("plan-d"),
      false,
      "the failed build kept the plan claim",
    );

    fs.writeFileSync(architectTeamYaml, saved);
    const retried = await postBuild(harness, { planId: "plan-d", jobId: "job-d2" });
    assert.equal(retried.status, 202, JSON.stringify(retried.body));
  } finally {
    await harness.close();
  }
});

// Amendment is the repair route for a plan whose stored shape no longer parses.
// Accepting a valid one has to clear the rejection, or the build keeps refusing
// and the user is told to choose again after they already did.
test("an accepted amendment clears a stored shape rejection", async () => {
  const harness = await startHarness([]);
  try {
    await harness.store.savePlan(rejectedShapePlan("plan-e"));

    const revision = await currentRevision(harness, "plan-e");
    const response = await fetch(
      `${harness.url}/create/resource-architect/plans/plan-e/shape`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shape: discussion, expectedRevision: revision }),
      },
    );
    assert.equal(response.status, 200, await response.text());

    const stored = await harness.store.getPlan("plan-e");
    assert.ok(stored?.kind === "team");
    assert.deepEqual(stored.team.shape, discussion);
    assert.equal(stored.team.shapeRejected, undefined, "the rejection survived a repair");

    const built = await postBuild(harness, { planId: "plan-e", jobId: "job-e" });
    assert.equal(built.status, 202, JSON.stringify(built.body));
  } finally {
    await harness.close();
  }
});

// A stored shape can be structurally valid and still name an agent the team
// does not have. The provider parser refuses that at proposal time, but a
// durable record can reach the build another way — hand-edited, or written
// before that rule existed — so admission checks the roster itself, before any
// job or shell exists.
test("a stored shape whose roles do not fit the roster is refused at admission", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "admission-roster-"));
  try {
    const writer = new ResourceArchitectStore(workspace);
    const plan = teamPlan("plan-f", discussion);
    assert.ok(plan.kind === "team");
    await writer.savePlan({
      ...plan,
      team: {
        ...plan.team,
        shape: {
          kind: "discussion",
          rationale: "Independent perspectives.",
          depth: "standard",
          coordinator: "outsider",
          participants: ["risk-spotter"],
        },
      },
    });

    // A cold store, so the plan is read from disk exactly as a restart would.
    const harness = await startHarness([], new ResourceArchitectStore(workspace));
    try {
      const revision = await currentRevision(harness, "plan-f");
      const result = await postBuild(harness, {
        planId: "plan-f",
        jobId: "job-f",
        expectedRevision: revision,
      });
      assert.equal(result.status, 422, JSON.stringify(result.body));
      assert.equal(result.body.error, "invalid_shape");
      assert.match(String(result.body.reason ?? ""), /outsider/u);
    } finally {
      await harness.close();
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// Retry goes through the same admission, so it has to answer the same refusals
// rather than turning them into a generic failure.
test("a retry of a plan whose stored shape was rejected is refused in the same words", async () => {
  const harness = await startHarness([]);
  try {
    await harness.store.savePlan(rejectedShapePlan("plan-g"));
    await harness.store.saveJob({
      jobId: "job-g",
      planId: "plan-g",
      status: "failed",
      items: [],
      events: [],
      selectedResource: null,
    });

    const response = await fetch(
      `${harness.url}/create/resource-architect/jobs/job-g/retry`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: "job-g-retry" }),
      },
    );
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.equal(body.error, "invalid_shape");
  } finally {
    await harness.close();
  }
});

// And a retry that does carry a revision is held to it, so the modern path can
// send the snapshot it displayed without losing the lineage behaviour.
test("a retry carrying a stale revision is refused", async () => {
  const harness = await startHarness([teamPlan("plan-h", discussion)]);
  try {
    await harness.store.saveJob({
      jobId: "job-h",
      planId: "plan-h",
      status: "failed",
      items: [],
      events: [],
      selectedResource: null,
    });

    const response = await fetch(
      `${harness.url}/create/resource-architect/jobs/job-h/retry`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jobId: "job-h-retry",
          expectedRevision: "sha256:not-the-stored-one",
        }),
      },
    );
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal(body.error, "plan_revision_conflict");
  } finally {
    await harness.close();
  }
});

// Reading the amended plan back is not the same as building it. A retry after a
// restart has to be admitted against the shape the user chose, not the one the
// Architect first proposed, and the revision reported before the restart has to
// still authorize it.
test("a retry after a restart is admitted with the amended shape and the pre-restart revision", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "admission-restart-"));
  try {
    let amendedRevision: string;
    const before = await startHarness(
      [teamPlan("plan-restart", discussion)],
      new ResourceArchitectStore(workspace),
    );
    try {
      const revision = await currentRevision(before, "plan-restart");
      const response = await fetch(
        `${before.url}/create/resource-architect/plans/plan-restart/shape`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ shape: review, expectedRevision: revision }),
        },
      );
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(response.status, 200, JSON.stringify(body));
      amendedRevision = String(body.revision);
      await before.store.saveJob({
        jobId: "job-restart",
        planId: "plan-restart",
        status: "failed",
        items: [],
        events: [],
        selectedResource: null,
      });
    } finally {
      await before.close();
    }

    // A new store and server over the same workspace: only what reached disk.
    const after = await startHarness([], new ResourceArchitectStore(workspace));
    try {
      const retried = await fetch(
        `${after.url}/create/resource-architect/jobs/job-restart/retry`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jobId: "job-restart-2",
            // The revision the card reported before the restart still describes
            // the stored plan, so it still authorizes this build.
            expectedRevision: amendedRevision,
          }),
        },
      );
      const body = (await retried.json()) as Record<string, unknown>;
      assert.equal(retried.status, 202, JSON.stringify(body));

      // And what it admitted is the amended shape.
      const stored = await after.store.getPlan("plan-restart");
      assert.ok(stored?.kind === "team");
      assert.deepEqual(stored.team.shape, review);
    } finally {
      await after.close();
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
