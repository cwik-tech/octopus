import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TeamCreationCard } from "@/components/create/agents-and-teams/resource-creation-card";
import type { ResourceTeamPlan } from "@/lib/models/resource-architect-model";

const basePlan: ResourceTeamPlan = {
  teamId: "contract-review-team",
  description: "Reviews contracts.",
  tags: [],
  existingAgents: [],
  newAgents: [
    {
      name: "risk-spotter",
      role: "Risk reviewer",
      description: "Finds clauses that expose you.",
      rationale: "No existing Agent covers this.",
    },
  ],
  questionsResolved: [],
};

function renderCard(shape: ResourceTeamPlan["shape"]) {
  render(
    <TeamCreationCard
      team={shape ? { ...basePlan, shape } : basePlan}
      onOpen={vi.fn()}
    />,
  );
}

describe("how a proposed team works together", () => {
  it.each([
    { shape: { kind: "chain", rationale: "Sequential", depth: "standard", order: ["risk-lead", "risk-spotter"] }, roles: "Starts with: Risk Lead. Final result: Risk Spotter. No separate lead." },
    { shape: { kind: "discussion", rationale: "Discuss", depth: "standard", coordinator: "risk-lead", participants: ["risk-spotter"] }, roles: "Lead: Risk Lead. Receives the assignment and guides the discussion." },
    { shape: { kind: "review", rationale: "Check", depth: "standard", producer: "risk-lead", reviewer: "risk-spotter" }, roles: "Writer: Risk Lead. Checker: Risk Spotter. No separate lead." },
  ] satisfies { shape: NonNullable<ResourceTeamPlan["shape"]>; roles: string }[])("shows the actual assignment roles for $shape.kind", ({ shape, roles }) => {
    renderCard(shape);
    expect(screen.getByText(roles)).toBeInTheDocument();
  });
  it("says what the team will do in words, never a stage type", () => {
    renderCard({
      kind: "discussion",
      rationale: "These agents disagree usefully.",
      depth: "standard",
      coordinator: "risk-lead",
      participants: ["risk-spotter"],
    });

    expect(screen.getByText("How they work together")).toBeInTheDocument();
    expect(screen.getByText("They take turns discussing it")).toBeInTheDocument();
    // The engine's vocabulary never reaches the person who described a
    // problem. A stage type is a bare label, so nothing may be labelled with
    // one — the ordinary English word inside a sentence is a different thing.
    for (const stageType of ["chain", "discussion", "review", "routing", "broadcast", "pipeline"]) {
      expect(
        screen.queryByText((_, element) => element?.textContent?.trim() === stageType),
      ).not.toBeInTheDocument();
    }
    expect(screen.queryByText(/stage type/i)).not.toBeInTheDocument();
  });

  it("gives the reason the shape was chosen, as the Architect wrote it", () => {
    renderCard({
      kind: "review",
      rationale: "One drafts and the other has the standing to say no.",
      depth: "quick",
      producer: "risk-spotter",
      reviewer: "plain-english",
    });

    expect(
      screen.getByText("One drafts, another checks it before it counts"),
    ).toBeInTheDocument();
    // The Architect's own sentence, joined onto "Chosen because" the way the
    // per-Agent rationale already reads.
    expect(
      screen.getByRole("region", { name: "How they work together" }).textContent,
    ).toContain(
      "Chosen because one drafts and the other has the standing to say no.",
    );
  });

  it("describes depth as how far they may go, not as a number of turns", () => {
    renderCard({
      kind: "discussion",
      rationale: "They disagree usefully.",
      depth: "thorough",
      coordinator: "risk-lead",
      participants: ["risk-spotter"],
    });

    expect(
      screen.getByText("They go back and forth up to five times"),
    ).toBeInTheDocument();
    // Nothing detects convergence outside Team Chat, so nothing may promise it.
    expect(screen.queryByText(/until (they|it) (settles?|converges?)/i)).not.toBeInTheDocument();
  });

  it("warns that a discussion saves different things in the two modes", () => {
    renderCard({
      kind: "discussion",
      rationale: "They disagree usefully.",
      depth: "quick",
      coordinator: "risk-lead",
      participants: ["risk-spotter"],
    });

    expect(
      screen.getByText(
        "A workflow run saves the full discussion; a chat run saves the summary.",
      ),
    ).toBeInTheDocument();
  });

  it("says nothing about how a chain saves its work, because it is the same either way", () => {
    renderCard({
      kind: "chain",
      rationale: "Each one improves what the last produced.",
      depth: "standard",
      order: ["risk-spotter"],
    });

    expect(screen.getByText("Each builds on the last")).toBeInTheDocument();
    expect(screen.queryByText(/a chat run saves the summary/)).not.toBeInTheDocument();
  });

  it("shows no shape block at all when the plan carries no shape", () => {
    renderCard(undefined);

    expect(screen.queryByText("How they work together")).not.toBeInTheDocument();
  });
});

describe("the change control on the card", () => {
  const planShape: NonNullable<ResourceTeamPlan["shape"]> = {
    kind: "discussion",
    rationale: "They disagree usefully.",
    depth: "standard",
    coordinator: "risk-lead",
    participants: ["risk-spotter"],
  };

  function renderChangeable(onShapeChange = vi.fn()) {
    render(
      <TeamCreationCard
        team={{
          ...basePlan,
          existingAgents: [
            { name: "risk-lead", role: "Lead", rationale: "Already available." },
          ],
          shape: planShape,
        }}
        onOpen={vi.fn()}
        onShapeChange={onShapeChange}
      />,
    );
    return onShapeChange;
  }

  it("offers the change beside the shape it proposes", () => {
    renderChangeable();
    expect(screen.getByRole("tablist", { name: "How they work together" })).toBeInTheDocument();
  });

  // The roster the chooser assigns roles from is the one the card shows, so a
  // user sees the same names in the same order the roles are taken in.
  it("hands the chosen shape back with roles from the roster on the card", async () => {
    const onShapeChange = renderChangeable();
    await userEvent.click(
      screen.getByRole("tab", { name: /Draft and review/ }),
    );

    expect(onShapeChange).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "review",
        producer: "risk-lead",
        reviewer: "risk-spotter",
      }),
    );
  });

  // A card with nothing to call cannot offer a change that would go nowhere.
  it("shows no change control when there is nothing to change it with", () => {
    render(
      <TeamCreationCard team={{ ...basePlan, shape: planShape }} onOpen={vi.fn()} />,
    );
    expect(screen.queryByRole("tablist", { name: "How they work together" })).not.toBeInTheDocument();
  });
});

// A refused change has to reach the person who made it. Silence would read as
// "applied", and the build would then not match what they think they chose.
it("shows what a refused change had to say", () => {
  render(
    <TeamCreationCard
      team={{
        ...basePlan,
        shape: {
          kind: "discussion",
          rationale: "They disagree usefully.",
          depth: "standard",
          coordinator: "risk-lead",
          participants: ["risk-spotter"],
        },
      }}
      onOpen={vi.fn()}
      shapeNotice="This team is being built. Wait for it to finish, then change it."
    />,
  );

  expect(screen.getByRole("status")).toHaveTextContent(
    "This team is being built. Wait for it to finish, then change it.",
  );
});

describe("depth wording is true for the shape it describes", () => {
  // A chain has no rounds. `renderStageBody`'s chain branch writes no depth at
  // all and `engines/chain.ts` runs the sequence once, so promising that they
  // "go back and forth" describes a team the build will not produce.
  it("never promises a chain repetition it does not run", () => {
    render(
      <TeamCreationCard
        team={{
          ...basePlan,
          shape: {
            kind: "chain",
            rationale: "Each improves the last.",
            depth: "thorough",
            order: ["risk-spotter"],
          },
        }}
        onOpen={vi.fn()}
      />,
    );

    const section = screen.getByRole("region", { name: "How they work together" });
    expect(section.textContent).not.toMatch(/back and forth/i);
    expect(section.textContent).not.toMatch(/five times/i);
    expect(section.textContent).toMatch(/each agent works once, in order/i);
  });

  it("still describes how far a discussion may go", () => {
    render(
      <TeamCreationCard
        team={{
          ...basePlan,
          shape: {
            kind: "discussion",
            rationale: "They disagree usefully.",
            depth: "thorough",
            coordinator: "risk-lead",
            participants: ["risk-spotter"],
          },
        }}
        onOpen={vi.fn()}
      />,
    );

    expect(
      screen.getByText("They go back and forth up to five times"),
    ).toBeInTheDocument();
  });
});

describe("the roster is shown in the order the team will run", () => {
  const roster = {
    existingAgents: [
      { name: "risk-lead", role: "Lead", rationale: "Already available." },
    ],
    newAgents: [
      {
        name: "risk-spotter",
        role: "Risk reviewer",
        description: "Finds risky clauses.",
        rationale: "Needed.",
      },
    ],
  };

  function rosterNames(): string[] {
    return screen
      .getAllByRole("listitem")
      .map((item) => item.textContent ?? "")
      .filter((text) => /Risk (Lead|Spotter)/.test(text));
  }

  // A chain's order is load-bearing: the last member writes the deliverable.
  // Listing agents as existing-then-new shows an order the team will not run.
  it("numbers a chain in its chosen order, not the order agents were planned", () => {
    render(
      <TeamCreationCard
        team={{
          ...basePlan,
          ...roster,
          shape: {
            kind: "chain",
            rationale: "Spotter drafts, lead refines.",
            depth: "standard",
            order: ["risk-spotter", "risk-lead"],
          },
        }}
        onOpen={vi.fn()}
      />,
    );

    const shown = rosterNames();
    expect(shown[0]).toMatch(/Risk Spotter/);
    expect(shown[1]).toMatch(/Risk Lead/);
    // Numbered, because the position is what the order means.
    expect(shown[0]).toMatch(/^1\./);
    expect(shown[1]).toMatch(/^2\./);
  });

  // A discussion speaks in list order and later speakers read earlier replies,
  // so the order is shown without implying a numbered hand-off.
  it("lists a discussion unnumbered, coordinator first, and says order matters", () => {
    render(
      <TeamCreationCard
        team={{
          ...basePlan,
          ...roster,
          shape: {
            kind: "discussion",
            rationale: "They disagree usefully.",
            depth: "standard",
            coordinator: "risk-lead",
            participants: ["risk-spotter"],
          },
        }}
        onOpen={vi.fn()}
      />,
    );

    const shown = rosterNames();
    expect(shown[0]).toMatch(/Risk Lead/);
    expect(shown[0]).not.toMatch(/^1\./);
    expect(
      screen.getByText(/speak in the order shown, and later ones can see earlier replies/i),
    ).toBeInTheDocument();
  });

  it("says nothing about order for a review, which has none", () => {
    render(
      <TeamCreationCard
        team={{
          ...basePlan,
          ...roster,
          shape: {
            kind: "review",
            rationale: "One writes, one checks.",
            depth: "quick",
            producer: "risk-lead",
            reviewer: "risk-spotter",
          },
        }}
        onOpen={vi.fn()}
      />,
    );

    expect(rosterNames()[0]).not.toMatch(/^1\./);
    expect(screen.queryByText(/later ones can see earlier replies/i)).not.toBeInTheDocument();
  });
});

describe("a plan whose saved shape can no longer be built", () => {
  const roster = {
    existingAgents: [
      { name: "risk-lead", role: "Lead", rationale: "Already available." },
    ],
    newAgents: [{
      name: "risk-spotter",
      role: "Risk reviewer",
      description: "Finds risky clauses.",
      rationale: "Needed.",
    }],
  };

  // A plan restored from disk can carry a shape this app cannot build. The
  // build refuses it, so the card has to say so and offer the repair. Showing
  // nothing looks exactly like a plan that never chose a shape, and the user
  // presses Create and collects the same refusal again.
  it("says the shape needs choosing again, and offers the change control", () => {
    render(
      <TeamCreationCard
        team={{ ...basePlan, ...roster, shapeRejected: true }}
        onOpen={vi.fn()}
        onShapeChange={vi.fn()}
      />,
    );

    expect(screen.getByText("How they work together")).toBeInTheDocument();
    expect(
      screen.getByText(/saved way of working together is no longer one this app can build/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "How they work together" })).toBeInTheDocument();
  });

  // The roster is not the broken part and must still be visible, or the repair
  // asks the user to reassign roles among members they cannot see.
  it("still shows the roster it would be repaired onto", () => {
    render(
      <TeamCreationCard
        team={{ ...basePlan, ...roster, shapeRejected: true }}
        onOpen={vi.fn()}
        onShapeChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("listitem", { name: /Risk Lead/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("listitem", { name: /Risk Spotter/ }),
    ).toBeInTheDocument();
  });

  // Legacy absence is a different thing: that plan builds the chain it was
  // planned as and there is nothing to repair.
  it("says nothing of the sort for a plan that simply never chose one", () => {
    render(
      <TeamCreationCard
        team={{ ...basePlan, ...roster }}
        onOpen={vi.fn()}
        onShapeChange={vi.fn()}
      />,
    );

    expect(screen.queryByText("How they work together")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/no longer one this app can build/i),
    ).not.toBeInTheDocument();
  });

  // The repair has to be usable, not merely present. A one-member team can only
  // be a chain, so that option must be selectable and must hand back a shape
  // the roster actually satisfies.
  it("lets a one-member rejected plan be repaired to a chain", async () => {
    const onShapeChange = vi.fn();
    render(
      <TeamCreationCard
        team={{
          ...basePlan,
          existingAgents: [],
          newAgents: [{
            name: "risk-spotter",
            role: "Risk reviewer",
            description: "Finds risky clauses.",
            rationale: "Needed.",
          }],
          shapeRejected: true,
        }}
        onOpen={vi.fn()}
        onShapeChange={onShapeChange}
      />,
    );


    // Nothing is in effect, so nothing is preselected.
    for (const option of screen.getAllByRole("tab")) {
      expect(option).toHaveAttribute("aria-selected", "false");
    }
    const chain = screen.getByRole("tab", { name: /One after another/ });
    expect(chain).toBeEnabled();
    // And the two that a single member cannot satisfy are refused with a reason.
    expect(
      screen.getByRole("tab", { name: /Group discussion/ }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("tab", { name: /Draft and review/ }),
    ).toHaveAttribute("aria-disabled", "true");

    await userEvent.click(chain);

    expect(onShapeChange).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "chain", order: ["risk-spotter"] }),
    );
  });
});

describe("a plan whose revision could not be read", () => {
  const roster = {
    existingAgents: [
      { name: "risk-lead", role: "Risk Lead", rationale: "Already available." },
    ],
  };

  // Create is disabled until the revision is known, and until now the card
  // said nothing about why. The user was left with a proposal they could
  // neither build nor change, and describing the team again was the only way
  // out — which throws away a proposal that was never what failed.
  it("says the plan could not be read, and offers to read it again", async () => {
    const onRetry = vi.fn();
    render(
      <TeamCreationCard
        team={{
          ...basePlan,
          ...roster,
          shape: {
            kind: "discussion",
            rationale: "They disagree usefully.",
            depth: "standard",
            coordinator: "risk-lead",
            participants: ["risk-spotter"],
          },
        }}
        onOpen={vi.fn()}
        shapeUnavailable={{ onRetry }}
      />,
    );

    expect(
      screen.getByText(/could not be read, so how this team works together cannot be changed yet/i),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("says a read is under way rather than offering the same button twice", () => {
    render(
      <TeamCreationCard
        team={{ ...basePlan, ...roster }}
        onOpen={vi.fn()}
        shapeUnavailable={{ onRetry: vi.fn(), retrying: true }}
      />,
    );

    const button = screen.getByRole("button", { name: /Trying again/ });
    expect(button).toBeDisabled();
  });
});
