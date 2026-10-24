import { afterEach, describe, expect, it, vi } from "vitest";

import {
  amendTeamShape,
  readTeamShape,
} from "@/lib/clients/resource-architect-client";
import type { TeamShape } from "@contracts/schemas/team-shape";

const shape: TeamShape = {
  kind: "discussion",
  rationale: "They disagree usefully.",
  depth: "standard",
  coordinator: "risk-lead",
  participants: ["risk-spotter"],
};

/** A complete, valid plan, which every snapshot answer has to carry. */
function wholePlan() {
  return {
    id: "plan-1",
    kind: "team" as const,
    team: {
      teamId: "contract-review-team",
      description: "Reviews contracts.",
      tags: [] as string[],
      existingAgents: [
        { name: "risk-lead", role: "Lead", rationale: "Already available." },
      ],
      newAgents: [{
        name: "risk-spotter",
        role: "Risk reviewer",
        description: "Finds risky clauses.",
        rationale: "Needed.",
      }],
      questionsResolved: [] as string[],
      shape,
    },
  };
}

function respondWith(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The same object without one key, so a fixture can leave it out. */
function without<T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

describe("changing a proposed team shape", () => {
  it("returns the new shape and the revision to write against next", async () => {
    respondWith(200, {
      planId: "plan-1",
      revision: "sha256:new",
      shape,
      plan: wholePlan(),
    });

    const result = await amendTeamShape({
      planId: "plan-1",
      shape,
      expectedRevision: "sha256:old",
    });

    expect(result).toMatchObject({ ok: true, revision: "sha256:new", shape });
  });

  // The card has to redraw from this rather than telling the user their change
  // worked. The server sends the current shape so no second request is needed.
  it("reports a revision conflict with what the shape is now", async () => {
    respondWith(409, {
      error: "plan_revision_conflict",
      currentRevision: "sha256:theirs",
      currentShape: shape,
      plan: wholePlan(),
    });

    const result = await amendTeamShape({
      planId: "plan-1",
      shape,
      expectedRevision: "sha256:mine",
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "conflict",
      currentRevision: "sha256:theirs",
      currentShape: shape,
    });
  });

  // The names matter: "someone has no role" is not actionable, and
  // "risk-spotter has no role" is.
  it("reports an invalid shape with the members it names wrongly", async () => {
    respondWith(422, {
      error: "invalid_shape",
      reason: "Every team member must appear in exactly one role.",
      offendingNames: ["risk-spotter"],
    });

    const result = await amendTeamShape({
      planId: "plan-1",
      shape,
      expectedRevision: "sha256:old",
    });

    expect(result).toEqual({
      ok: false,
      reason: "invalid",
      message: "Every team member must appear in exactly one role.",
      offendingNames: ["risk-spotter"],
    });
  });

  it("reports a build in progress as its own answer, not as a generic failure", async () => {
    respondWith(409, {
      error: "plan_being_built",
      reason: "This team is being built. Wait for it to finish, then change it.",
    });

    const result = await amendTeamShape({
      planId: "plan-1",
      shape,
      expectedRevision: "sha256:old",
    });

    expect(result).toEqual({
      ok: false,
      reason: "building",
      message: "This team is being built. Wait for it to finish, then change it.",
    });
  });

  it("reads the revision the card must write against", async () => {
    respondWith(200, {
      planId: "plan-1",
      revision: "sha256:current",
      shape,
      plan: wholePlan(),
    });

    const snapshot = await readTeamShape("plan-1");
    expect(snapshot.revision).toBe("sha256:current");
    expect(snapshot.shape).toEqual(shape);
    expect(snapshot.plan).toMatchObject({ id: "plan-1" });
  });

  // A plan with no shape yet is not an error; it is a plan proposed before
  // shapes existed, and it builds the chain it always built.
  it("reads a plan that carries no shape", async () => {
    const team = without(wholePlan().team, "shape");
    respondWith(200, {
      planId: "plan-1",
      revision: "sha256:current",
      plan: { ...wholePlan(), team },
    });

    const snapshot = await readTeamShape("plan-1");
    expect(snapshot.shape).toBeUndefined();
    expect(snapshot.plan).toMatchObject({ id: "plan-1" });
  });
});

describe("reading a plan whose saved shape cannot be built", () => {
  // The build refuses this plan. The renderer has to know that to offer the
  // repair, and it must not read as a plan that never chose a shape.
  it("reports the rejection alongside the revision", async () => {
    const team = without(wholePlan().team, "shape");
    respondWith(200, {
      planId: "plan-1",
      revision: "sha256:current",
      shapeRejected: true,
      plan: { ...wholePlan(), team },
    });

    const snapshot = await readTeamShape("plan-1");
    expect(snapshot.shapeRejected).toBe(true);
    expect(snapshot.plan).toMatchObject({ id: "plan-1" });
  });

  it("does not invent a rejection for a plan that simply has no shape", async () => {
    const team = without(wholePlan().team, "shape");
    respondWith(200, {
      planId: "plan-1",
      revision: "sha256:current",
      plan: { ...wholePlan(), team },
    });

    const snapshot = await readTeamShape("plan-1");
    expect(snapshot.shapeRejected).toBeUndefined();
  });
});

describe("the snapshot a read or an amendment must return", () => {
  const fullPlan = {
    id: "plan-1",
    kind: "team",
    team: {
      teamId: "contract-review-team",
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

  // The plan and the revision are one answer. A reply carrying a revision with
  // no plan advances the authority the card holds while leaving it showing
  // whatever it had, so the two silently describe different things.
  it("refuses a read that carries no plan", async () => {
    respondWith(200, { planId: "plan-1", revision: "sha256:current", shape });
    await expect(readTeamShape("plan-1")).rejects.toThrow();
  });

  it("refuses a read whose plan does not describe the plan asked for", async () => {
    respondWith(200, {
      planId: "plan-1",
      revision: "sha256:current",
      plan: { ...fullPlan, id: "plan-other" },
    });
    await expect(readTeamShape("plan-1")).rejects.toThrow();
  });

  it("refuses a read whose plan is not one this app can hold", async () => {
    respondWith(200, {
      planId: "plan-1",
      revision: "sha256:current",
      plan: { ...fullPlan, team: { ...fullPlan.team, description: 7 } },
    });
    await expect(readTeamShape("plan-1")).rejects.toThrow();
  });

  it("accepts a read that carries the whole plan", async () => {
    respondWith(200, { planId: "plan-1", revision: "sha256:current", plan: fullPlan });
    const snapshot = await readTeamShape("plan-1");
    expect(snapshot.planId).toBe("plan-1");
    expect(snapshot.revision).toBe("sha256:current");
    expect(snapshot.plan).toMatchObject({ id: "plan-1", kind: "team" });
  });

  // A plan that never chose a shape is still a whole, valid plan. Its shape is
  // absent inside a complete snapshot, which is a different thing from a reply
  // that omits the plan.
  it("accepts a whole plan whose team simply has no shape", async () => {
    const team = without(fullPlan.team, "shape");
    respondWith(200, {
      planId: "plan-1",
      revision: "sha256:current",
      plan: { ...fullPlan, team },
    });
    const snapshot = await readTeamShape("plan-1");
    expect(snapshot.shape).toBeUndefined();
    expect(snapshot.plan).toMatchObject({ id: "plan-1" });
  });

  it("requires the same whole plan from an accepted amendment", async () => {
    respondWith(200, { planId: "plan-1", revision: "sha256:new", shape });
    await expect(
      amendTeamShape({ planId: "plan-1", shape, expectedRevision: "sha256:old" }),
    ).rejects.toThrow();
  });

  it("requires the same whole plan from a refused amendment", async () => {
    respondWith(409, {
      error: "plan_revision_conflict",
      currentRevision: "sha256:theirs",
      currentShape: shape,
    });
    await expect(
      amendTeamShape({ planId: "plan-1", shape, expectedRevision: "sha256:mine" }),
    ).rejects.toThrow();
  });

  it("accepts an amendment that answers with the whole plan", async () => {
    respondWith(200, { planId: "plan-1", revision: "sha256:new", shape, plan: fullPlan });
    const result = await amendTeamShape({
      planId: "plan-1",
      shape,
      expectedRevision: "sha256:old",
    });
    expect(result).toMatchObject({ ok: true, revision: "sha256:new" });
  });
});

// Once a build has been admitted, the plan can no longer be amended. The card
// has to be able to say what happened instead of reporting a generic failure,
// so the refusal is read as a state rather than thrown.
describe("a plan whose build was already admitted", () => {
  it("reports the admitted build rather than throwing", async () => {
    respondWith(409, {
      error: "plan_already_admitted",
      jobId: "job-1",
      admittedRevision: "sha256:admitted",
      reason: "This team has already been built from this plan.",
    });

    const result = await amendTeamShape({
      planId: "plan-1",
      shape,
      expectedRevision: "sha256:admitted",
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "admitted",
      jobId: "job-1",
      admittedRevision: "sha256:admitted",
    });
  });

  it("carries the admitted build on the snapshot a reader gets", async () => {
    respondWith(200, {
      planId: "plan-1",
      revision: "sha256:admitted",
      shape,
      plan: wholePlan(),
      admitted: { jobId: "job-1", revision: "sha256:admitted" },
    });

    const snapshot = await readTeamShape("plan-1");

    expect(snapshot.admitted).toEqual({
      jobId: "job-1",
      revision: "sha256:admitted",
    });
  });

  // A plan nobody has built yet says so plainly, so the card never has to read
  // "no field" as "not admitted".
  it("reports no admitted build when the plan has none", async () => {
    respondWith(200, {
      planId: "plan-1",
      revision: "sha256:one",
      shape,
      plan: wholePlan(),
      admitted: null,
    });

    const snapshot = await readTeamShape("plan-1");

    expect(snapshot.admitted).toBeUndefined();
  });

  // Absence means unadmitted. A value that is present but not readable means
  // the state is unknown, and unknown must not be rendered as "free to edit".
  it("refuses an answer whose admitted build cannot be read", async () => {
    respondWith(200, {
      planId: "plan-1",
      revision: "sha256:one",
      shape,
      plan: wholePlan(),
      admitted: { jobId: "job-1" },
    });

    await expect(readTeamShape("plan-1")).rejects.toThrow();
  });

  it("refuses an accepted change whose admitted build cannot be read", async () => {
    respondWith(200, {
      planId: "plan-1",
      revision: "sha256:two",
      shape,
      plan: wholePlan(),
      admitted: { revision: "" },
    });

    await expect(
      amendTeamShape({ planId: "plan-1", shape, expectedRevision: "sha256:one" }),
    ).rejects.toThrow();
  });
});
