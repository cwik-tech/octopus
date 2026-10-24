/**
 * Changing the shape the Architect proposed.
 *
 * The card states a shape rather than asking for one, so the whole value of
 * that choice rests on the user being able to say "no, that one". This is the
 * endpoint behind `[change]`: it takes the revision the card was rendered from,
 * refuses an edit written against a stale one, refuses a shape whose roles do
 * not match the roster, and refuses to move a plan a build is already applying.
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

const PLAN_ID = "shape-plan";

function teamPlan(shape?: TeamShape): ResourceArchitectPlan {
  return {
    id: PLAN_ID,
    kind: "team",
    team: {
      teamId: "contract-review-team",
      description: "Reviews contracts.",
      tags: [],
      existingAgents: [
        { name: "risk-lead", role: "Lead", rationale: "Already available." },
      ],
      newAgents: [
        {
          name: "risk-spotter",
          role: "Risk reviewer",
          description: "Finds clauses that expose you.",
          rationale: "No existing Agent covers this.",
        },
      ],
      questionsResolved: [],
      ...(shape ? { shape } : {}),
    },
  };
}

const validShape: TeamShape = {
  kind: "discussion",
  rationale: "They disagree usefully.",
  depth: "standard",
  coordinator: "risk-lead",
  participants: ["risk-spotter"],
};

interface Harness {
  url: string;
  store: ResourceArchitectStore;
  registry: CreateJobRegistry;
  close(): Promise<void>;
}

async function startHarness(
  plan: ResourceArchitectPlan | null = teamPlan(),
  store: ResourceArchitectStore = new ResourceArchitectStore(),
): Promise<Harness> {
  const registry = new CreateJobRegistry();
  // `null` means "read whatever is already there", which is what a restart
  // does: the plan on disk is the authority, not a fresh copy.
  if (plan) await store.savePlan(plan);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleResourceArchitectRoutes({
      req,
      res,
      url,
      options: {
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
    registry,
    close: () =>
      new Promise<void>((resolve, reject) => {
        registry.close();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

async function amend(
  harness: Harness,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(
    `${harness.url}/create/resource-architect/plans/${PLAN_ID}/shape`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const parsed: unknown = await response.json();
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  return { status: response.status, body: parsed as Record<string, unknown> };
}

/** The revision the card would have been rendered from. */
async function currentRevision(harness: Harness): Promise<string> {
  const response = await fetch(
    `${harness.url}/create/resource-architect/plans/${PLAN_ID}/shape`,
  );
  const parsed = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 200, JSON.stringify(parsed));
  return String(parsed.revision);
}

test("an amendment written against the current revision is applied", async () => {
  const harness = await startHarness();
  try {
    const revision = await currentRevision(harness);
    const result = await amend(harness, { shape: validShape, expectedRevision: revision });

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body.shape, validShape);
    assert.notEqual(result.body.revision, revision, "the revision did not move");

    // The build reads the plan back from the store, so that is where the
    // change has to be, not only in the response. Durability across a real
    // store and server recreation is a separate test below: this one shares
    // the instance and cannot speak to it.
    const stored = await harness.store.getPlan(PLAN_ID);
    assert.ok(stored?.kind === "team");
    assert.deepEqual(stored.team.shape, validShape);
  } finally {
    await harness.close();
  }
});

test("an eight-member chain can become a discussion with every specialist still eligible", async () => {
  const coordinator = "legal-contract-lead";
  const participants = [
    "web-researcher", "legal-michigan-specialist", "legal-ip-counsel",
    "legal-privacy-counsel", "legal-risk-counsel", "legal-leverage-strategist", "writer",
  ];
  const roster = [coordinator, ...participants];
  const plan: ResourceArchitectPlan = {
    id: PLAN_ID,
    kind: "team",
    team: {
      teamId: "michigan-contracts-team",
      description: "Reviews Michigan contracts.",
      tags: [],
      existingAgents: roster.map((name) => ({ name, role: name, rationale: "Needed for contracts." })),
      newAgents: [],
      questionsResolved: [],
      shape: { kind: "chain", rationale: "In order.", depth: "quick", order: roster },
    },
  };
  const shape: TeamShape = {
    kind: "discussion", rationale: "The lead selects the right specialists.",
    depth: "standard", coordinator, participants,
  };
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "large-discussion-"));
  const harness = await startHarness(plan, new ResourceArchitectStore(workspace));
  try {
    const revision = await currentRevision(harness);
    const result = await amend(harness, { shape, expectedRevision: revision });

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body.shape, shape);
    const stored = await new ResourceArchitectStore(workspace).getPlan(PLAN_ID);
    assert.ok(stored?.kind === "team");
    assert.deepEqual(stored.team.shape, shape);
  } finally {
    await harness.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("an amendment written against a stale revision is refused, and says what the shape is now", async () => {
  const harness = await startHarness();
  try {
    const stale = await currentRevision(harness);
    await amend(harness, { shape: validShape, expectedRevision: stale });

    const second: TeamShape = {
      kind: "chain",
      rationale: "Each improves the last.",
      depth: "quick",
      order: ["risk-lead", "risk-spotter"],
    };
    const result = await amend(harness, { shape: second, expectedRevision: stale });

    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.error, "plan_revision_conflict");
    // The card can redraw from this without a second request.
    assert.deepEqual(result.body.currentShape, validShape);
    assert.equal(typeof result.body.currentRevision, "string");

    const stored = await harness.store.getPlan(PLAN_ID);
    assert.ok(stored?.kind === "team");
    assert.deepEqual(stored.team.shape, validShape, "the stale write took effect");
  } finally {
    await harness.close();
  }
});

test("a shape whose roles do not cover the roster is refused, and names who", async () => {
  const harness = await startHarness();
  try {
    const revision = await currentRevision(harness);
    const result = await amend(harness, {
      expectedRevision: revision,
      shape: {
        kind: "discussion",
        rationale: "One of them has nothing to do.",
        depth: "quick",
        coordinator: "risk-lead",
        participants: ["risk-lead"],
      },
    });

    assert.equal(result.status, 422, JSON.stringify(result.body));
    assert.equal(result.body.error, "invalid_shape");
    assert.equal(typeof result.body.reason, "string");
    assert.deepEqual(result.body.offendingNames, ["risk-lead", "risk-spotter"]);
  } finally {
    await harness.close();
  }
});

test("a shape the contract does not describe is refused before the roster is considered", async () => {
  const harness = await startHarness();
  try {
    const revision = await currentRevision(harness);
    const result = await amend(harness, {
      expectedRevision: revision,
      shape: { kind: "broadcast", rationale: "Everyone at once.", depth: "quick" },
    });
    assert.equal(result.status, 422, JSON.stringify(result.body));
    assert.equal(result.body.error, "invalid_shape");
  } finally {
    await harness.close();
  }
});

test("a plan a build is already applying cannot have its shape moved under it", async () => {
  const harness = await startHarness();
  try {
    const revision = await currentRevision(harness);
    const release = harness.store.claimPlan(PLAN_ID);
    try {
      const result = await amend(harness, { shape: validShape, expectedRevision: revision });
      assert.equal(result.status, 409, JSON.stringify(result.body));
      assert.equal(result.body.error, "plan_being_built");
    } finally {
      release();
    }
    // Released, so the same amendment now applies.
    const after = await amend(harness, { shape: validShape, expectedRevision: revision });
    assert.equal(after.status, 200, JSON.stringify(after.body));
  } finally {
    await harness.close();
  }
});

test("a plan that is not a team has no shape to change", async () => {
  const harness = await startHarness({
    id: PLAN_ID,
    kind: "standalone_agents",
    agents: [
      {
        name: "lone-agent",
        role: "Reviewer",
        description: "Reviews things.",
        rationale: "Asked for.",
      },
    ],
  });
  try {
    const result = await amend(harness, { shape: validShape, expectedRevision: "anything" });
    assert.equal(result.status, 422, JSON.stringify(result.body));
    assert.equal(result.body.error, "invalid_shape");
  } finally {
    await harness.close();
  }
});

// End to end, one of two concurrent amendments is refused. What serialises
// them is `withPlanLock`, and this cannot prove that: a test that forced the
// two handlers to overlap would deadlock exactly when the lock is correct, so
// the lock is proven at its own boundary in
// `tests/unit/resource-architect-plan-lock.test.ts` instead.
test("two amendments racing on one plan cannot both win", async () => {
  const harness = await startHarness();
  try {
    const revision = await currentRevision(harness);
    const other: TeamShape = {
      kind: "chain",
      rationale: "Each improves the last.",
      depth: "quick",
      order: ["risk-lead", "risk-spotter"],
    };
    const [first, second] = await Promise.all([
      amend(harness, { shape: validShape, expectedRevision: revision }),
      amend(harness, { shape: other, expectedRevision: revision }),
    ]);

    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409], JSON.stringify([first.body, second.body]));

    // Whichever won, the stored plan is one of the two and never a mixture.
    const stored = await harness.store.getPlan(PLAN_ID);
    assert.ok(stored?.kind === "team");
    const winner = first.status === 200 ? validShape : other;
    assert.deepEqual(stored.team.shape, winner);
  } finally {
    await harness.close();
  }
});

/** What an answer about a stored plan must carry, whatever prompted it. */
function assertAuthoritativeSnapshot(
  body: Record<string, unknown>,
  expected: { description: string; shapeKind: string; revision?: string },
): void {
  assert.equal(typeof body.revision, "string", JSON.stringify(body));
  if (expected.revision) assert.equal(body.revision, expected.revision);
  const plan = body.plan;
  assert.ok(
    plan && typeof plan === "object" && !Array.isArray(plan),
    `no plan in the answer: ${JSON.stringify(body)}`,
  );
  const record = plan as Record<string, unknown>;
  assert.equal(record.kind, "team");
  const team = record.team as Record<string, unknown>;
  // A non-shape field, so a shape-only refresh cannot satisfy this.
  assert.equal(team.description, expected.description);
  assert.ok(Array.isArray(team.existingAgents));
  assert.ok(Array.isArray(team.newAgents));
  const shape = team.shape as Record<string, unknown> | undefined;
  assert.equal(shape?.kind, expected.shapeKind);
}

// The revision is a digest of the whole plan, so it moves when anything moves.
// An answer that sends a revision beside a shape alone lets the card bind a new
// revision to a description and roster it is already showing, and the two then
// disagree with no way to notice.
test("reading a plan's shape returns the whole plan it describes", async () => {
  const harness = await startHarness(teamPlan(validShape));
  try {
    // A change to something that is not the shape at all.
    const stored = await harness.store.getPlan(PLAN_ID);
    assert.ok(stored?.kind === "team");
    await harness.store.savePlan({
      ...stored,
      team: { ...stored.team, description: "Reviews contracts, carefully." },
    });

    const response = await fetch(
      `${harness.url}/create/resource-architect/plans/${PLAN_ID}/shape`,
    );
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(response.status, 200, JSON.stringify(body));
    assertAuthoritativeSnapshot(body, {
      description: "Reviews contracts, carefully.",
      shapeKind: "discussion",
    });
  } finally {
    await harness.close();
  }
});

test("an accepted amendment answers with the whole plan as it now stands", async () => {
  const harness = await startHarness(teamPlan());
  try {
    const stored = await harness.store.getPlan(PLAN_ID);
    assert.ok(stored?.kind === "team");
    await harness.store.savePlan({
      ...stored,
      team: { ...stored.team, description: "Reviews contracts, carefully." },
    });
    const revision = await currentRevision(harness);

    const result = await amend(harness, { shape: validShape, expectedRevision: revision });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assertAuthoritativeSnapshot(result.body, {
      description: "Reviews contracts, carefully.",
      shapeKind: "discussion",
      revision: String(result.body.revision),
    });
  } finally {
    await harness.close();
  }
});

test("a refused amendment answers with the whole plan the writer must redraw from", async () => {
  const harness = await startHarness(teamPlan(validShape));
  try {
    const stale = await currentRevision(harness);
    const stored = await harness.store.getPlan(PLAN_ID);
    assert.ok(stored?.kind === "team");
    // Someone else changed the description, not the shape.
    await harness.store.savePlan({
      ...stored,
      team: { ...stored.team, description: "Reviews contracts, carefully." },
    });

    const result = await amend(harness, {
      shape: validShape,
      expectedRevision: stale,
    });
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.error, "plan_revision_conflict");
    assertAuthoritativeSnapshot(result.body, {
      description: "Reviews contracts, carefully.",
      shapeKind: "discussion",
      revision: String(result.body.currentRevision),
    });
  } finally {
    await harness.close();
  }
});

// The amendment has to outlive the process that accepted it. The test above
// reads back through the same store instance, which proves the write reached
// memory and nothing about the disk.
test("an amended shape is read back from disk by a new store and server", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "shape-durable-"));
  try {
    const first = await startHarness(
      teamPlan(),
      new ResourceArchitectStore(workspace),
    );
    let revision: string;
    try {
      revision = await currentRevision(first);
      const result = await amend(first, { shape: validShape, expectedRevision: revision });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      revision = String(result.body.revision);
    } finally {
      await first.close();
    }

    // A different store over the same workspace, behind a different server:
    // nothing of the first process is reachable except what it wrote.
    const second = await startHarness(null, new ResourceArchitectStore(workspace));
    try {
      const response = await fetch(
        `${second.url}/create/resource-architect/plans/${PLAN_ID}/shape`,
      );
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.deepEqual(body.shape, validShape);
      // The revision the first process reported still describes it, so a card
      // rendered before the restart can still author against it.
      assert.equal(body.revision, revision);

      // The persisted plan carries it too, which is what a build will read.
      const stored = await second.store.getPlan(PLAN_ID);
      assert.ok(stored?.kind === "team");
      assert.deepEqual(stored.team.shape, validShape);
    } finally {
      await second.close();
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// A request that never said which version it was written against is a
// malformed request, not a stale one, and a conflict is the wrong answer to it:
// it carries the plan as it now stands, which describes nothing the caller got
// wrong. It was also the opposite of what the saved-team route answers for the
// same mistake, so one client could not be written against both.
test("an amendment that says no revision is refused as incomplete, not as stale", async () => {
  const harness = await startHarness();
  try {
    const before = await harness.store.getPlan(PLAN_ID);
    for (
      const body of [
        { shape: validShape },
        { shape: validShape, expectedRevision: null },
        { shape: validShape, expectedRevision: 7 },
        { shape: validShape, expectedRevision: { was: "an object" } },
      ]
    ) {
      const result = await amend(harness, body);
      assert.equal(
        result.status,
        400,
        `${JSON.stringify(body)} -> ${JSON.stringify(result.body)}`,
      );
      assert.equal(result.body.error, "missing_revision");
      assert.equal(typeof result.body.reason, "string");
    }

    // Nothing was written by any of them.
    const after = await harness.store.getPlan(PLAN_ID);
    assert.deepEqual(after, before, "an incomplete request changed the plan");
  } finally {
    await harness.close();
  }
});

// The other half of the same boundary: a revision that is a string and simply
// out of date is still a conflict, and still carries what the plan is now.
test("an amendment written against a revision that is merely old is still a conflict", async () => {
  const harness = await startHarness();
  try {
    const result = await amend(harness, {
      shape: validShape,
      expectedRevision: `sha256:${"0".repeat(64)}`,
    });
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.error, "plan_revision_conflict");
    assert.equal(typeof result.body.currentRevision, "string");
  } finally {
    await harness.close();
  }
});

// A current plan's new Agents carry the summary the Architect wrote for the
// card. Changing the shape rewrites the stored plan, and the plan it answers
// and the plan a restart reads must both still hold that summary exactly.
test("a shape change keeps each new Agent's card summary exactly", async () => {
  const summary = "Finds the contract clauses that expose you, before you sign.";
  const plan: ResourceArchitectPlan = {
    id: PLAN_ID,
    kind: "team",
    team: {
      teamId: "contract-review-team",
      description: "Reviews contracts.",
      tags: [],
      existingAgents: [
        { name: "risk-lead", role: "Lead", rationale: "Already available." },
      ],
      newAgents: [
        {
          name: "risk-spotter",
          role: "Risk reviewer",
          summary,
          description: "Finds clauses that expose you.",
          rationale: "No existing Agent covers this.",
        },
      ],
      questionsResolved: [],
    },
  };
  const expected: ResourceArchitectPlan = { ...plan, team: { ...plan.team, shape: validShape } };
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "shape-summary-"));
  const harness = await startHarness(plan, new ResourceArchitectStore(workspace));
  try {
    const result = await amend(harness, { shape: validShape, expectedRevision: await currentRevision(harness) });

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body.plan, expected);
    assert.deepEqual(await new ResourceArchitectStore(workspace).getPlan(PLAN_ID), expected);
  } finally {
    await harness.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
