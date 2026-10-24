import { afterEach, describe, expect, it, vi } from "vitest";

import { changeProposedTeamShape } from "@/components/create/agents-and-teams/change-proposed-team-shape";
import type { ResourceArchitectPlan } from "@/lib/models/resource-architect-model";
import type { TeamShape } from "@contracts/schemas/team-shape";

const discussion: TeamShape = {
  kind: "discussion",
  rationale: "They disagree usefully.",
  depth: "standard",
  coordinator: "risk-lead",
  participants: ["risk-spotter"],
};

const review: TeamShape = {
  kind: "review",
  rationale: "you chose it.",
  depth: "standard",
  producer: "risk-lead",
  reviewer: "risk-spotter",
};

const plan: ResourceArchitectPlan = {
  id: "plan-1",
  kind: "team",
  team: {
    teamId: "contract-review-team",
    description: "Reviews contracts.",
    tags: [],
    existingAgents: [{ name: "risk-lead", role: "Lead", rationale: "Reuse." }],
    newAgents: [
      {
        name: "risk-spotter",
        role: "Risk reviewer",
        description: "Finds risky clauses.",
        rationale: "Needed.",
      },
    ],
    questionsResolved: [],
    shape: discussion,
  },
};

afterEach(() => vi.restoreAllMocks());

describe("applying a shape the user chose", () => {
  it("writes against the revision the card was rendered from, not a fresher one", async () => {
    const amend = vi.fn(async () => ({
      ok: true as const,
      revision: "sha256:after",
      shape: review,
      // The whole plan the server now holds, which is what the card redraws
      // from rather than patching the copy it was already showing.
      plan: { ...plan, team: { ...plan.team, shape: review } },
    }));

    const result = await changeProposedTeamShape({
      plan,
      shape: review,
      revision: "sha256:rendered",
      amend,
    });

    expect(amend).toHaveBeenCalledWith({
      planId: "plan-1",
      shape: review,
      expectedRevision: "sha256:rendered",
    });
    expect(result.plan.kind).toBe("team");
    expect(result.plan.kind === "team" && result.plan.team.shape).toEqual(review);
    expect(result.revision).toBe("sha256:after");
    expect(result.notice).toBeUndefined();
  });

  // The user's change was not applied, so the card must show what is really
  // stored rather than the shape they picked.
  it("redraws from the stored shape when someone else changed the plan first", async () => {
    const theirs: TeamShape = {
      kind: "chain",
      rationale: "Each improves the last.",
      depth: "quick",
      order: ["risk-lead", "risk-spotter"],
    };
    const amend = vi.fn(async () => ({
      ok: false as const,
      reason: "conflict" as const,
      currentRevision: "sha256:theirs",
      currentShape: theirs,
      currentPlan: { ...plan, team: { ...plan.team, shape: theirs } },
    }));

    const result = await changeProposedTeamShape({
      plan,
      shape: review,
      revision: "sha256:rendered",
      amend,
    });

    expect(result.plan.kind === "team" && result.plan.team.shape).toEqual(theirs);
    expect(result.revision).toBe("sha256:theirs");
    expect(result.notice).toMatch(/changed/i);
  });

  it("leaves the plan alone and explains when a build already holds it", async () => {
    const amend = vi.fn(async () => ({
      ok: false as const,
      reason: "building" as const,
      message: "This team is being built. Wait for it to finish, then change it.",
    }));

    const result = await changeProposedTeamShape({
      plan,
      shape: review,
      revision: "sha256:rendered",
      amend,
    });

    expect(result.plan).toBe(plan);
    expect(result.revision).toBe("sha256:rendered");
    expect(result.notice).toBe(
      "This team is being built. Wait for it to finish, then change it.",
    );
  });

  it("names the members a refused shape got wrong", async () => {
    const amend = vi.fn(async () => ({
      ok: false as const,
      reason: "invalid" as const,
      message: "Every team member must appear in exactly one role.",
      offendingNames: ["risk-spotter"],
    }));

    const result = await changeProposedTeamShape({
      plan,
      shape: review,
      revision: "sha256:rendered",
      amend,
    });

    expect(result.plan).toBe(plan);
    expect(result.notice).toContain("Every team member must appear in exactly one role.");
    expect(result.notice).toContain("Risk Spotter");
  });

  it("does nothing to a plan that is not a team", async () => {
    const amend = vi.fn();
    const agentsPlan: ResourceArchitectPlan = {
      id: "plan-2",
      kind: "standalone_agents",
      agents: [
        { name: "solo", role: "R", description: "D", rationale: "Why." },
      ],
    };

    const result = await changeProposedTeamShape({
      plan: agentsPlan,
      shape: review,
      revision: "sha256:rendered",
      amend,
    });

    expect(amend).not.toHaveBeenCalled();
    expect(result.plan).toBe(agentsPlan);
  });
});
