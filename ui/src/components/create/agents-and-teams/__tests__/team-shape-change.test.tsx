import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TeamShapeChooser } from "@/components/create/agents-and-teams/team-shape-chooser";
import type { TeamShape } from "@contracts/schemas/team-shape";

const discussion: TeamShape = {
  kind: "discussion",
  rationale: "They disagree usefully.",
  depth: "standard",
  coordinator: "risk-lead",
  participants: ["risk-spotter"],
};

function renderChooser(overrides: {
  roster?: string[];
  onChoose?: (shape: TeamShape) => Promise<void> | void;
  shape?: TeamShape;
} = {}) {
  const onChoose = overrides.onChoose ?? vi.fn();
  render(
    <TeamShapeChooser
      shape={overrides.shape ?? discussion}
      roster={overrides.roster ?? ["risk-lead", "risk-spotter"]}
      onChoose={onChoose}
    />,
  );
  return { onChoose };
}

describe("changing how a team works together", () => {
  it("offers all three choices immediately, with the current choice selected", () => {
    renderChooser();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { name: "Group discussion" })).toHaveAttribute("aria-selected", "true");
  });

  it("names each option the way the card does, never as a stage type", async () => {
    renderChooser();

    for (const label of [
      "One after another",
      "Group discussion",
      "Draft and review",
    ]) {
      expect(screen.getByRole("tab", { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it("marks the shape the team already has as the one in effect", async () => {
    renderChooser();

    expect(
      screen.getByRole("tab", { name: /Group discussion/ }),
    ).toHaveAttribute("aria-selected", "true");
  });

  // Roles come from the roster in the order it is shown, so the user never has
  // to assign them by hand for a change they described in one sentence.
  it("fills the roles of the chosen shape from the roster", async () => {
    const onChoose = vi.fn();
    renderChooser({ onChoose });
    await userEvent.click(
      screen.getByRole("tab", { name: /Draft and review/ }),
    );

    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "review",
        producer: "risk-lead",
        reviewer: "risk-spotter",
        depth: "standard",
      }),
    );
  });

  // A review is exactly two members. Offering it to a team of three would
  // produce a refusal the user could not have predicted.
  it("refuses a shape this roster cannot take, and says why", async () => {
    const onChoose = vi.fn();
    renderChooser({
      roster: ["risk-lead", "risk-spotter", "plain-english"],
      onChoose,
    });

    const review = screen.getByRole("tab", {
      name: /Draft and review/,
    });
    expect(review).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText("A review team is one writer and one checker."),
    ).toBeInTheDocument();

    await userEvent.click(review);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("keeps the rationale honest by saying the user chose it", async () => {
    const onChoose = vi.fn();
    renderChooser({ onChoose });
    await userEvent.click(screen.getByRole("tab", { name: /One after another/ }));

    await waitFor(() => expect(onChoose).toHaveBeenCalled());
    const [chosen] = onChoose.mock.calls[0] as [TeamShape];
    // Not the Architect's reason for a different shape: that sentence
    // explained a choice this one replaces.
    expect(chosen.rationale).not.toBe(discussion.rationale);
    expect(chosen.rationale).toMatch(/you chose/i);
  });

  it("keeps the choices visible and waits for the saved selection", async () => {
    renderChooser();
    await userEvent.click(screen.getByRole("tab", { name: /One after another/ }));

    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { name: "Group discussion" })).toHaveAttribute("aria-selected", "true");
  });

  // A chain runs each member once; it has no rounds, and the depth reported
  // for one is a description of that, not a setting to carry. Carrying it made
  // every chain changed into a discussion a one-round discussion.
  it("does not carry a chain's depth into the shape it is changed to", async () => {
    const { onChoose } = renderChooser({
      shape: {
        kind: "chain",
        rationale: "One after another.",
        depth: "quick",
        order: ["risk-lead", "risk-spotter"],
      },
    });

    await userEvent.click(
      screen.getByRole("tab", { name: /Group discussion/ }),
    );

    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "discussion", depth: "standard" }),
    );
  });

  // A depth the user did choose is theirs, and is kept.
  it("keeps the depth a discussion already had when it becomes a review", async () => {
    const { onChoose } = renderChooser({
      shape: {
        kind: "discussion",
        rationale: "They disagree usefully.",
        depth: "thorough",
        coordinator: "risk-lead",
        participants: ["risk-spotter"],
      },
    });

    await userEvent.click(
      screen.getByRole("tab", { name: /Draft and review/ }),
    );

    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "review", depth: "thorough" }),
    );
  });
});

/**
 * Two choosers on one page, each about a different team.
 *
 * Radios with the same `name` are one group to the browser, however far apart
 * they are rendered. Both choosers named their group `team-shape`, so opening
 * a second one and choosing in it cleared the first one's selection — the user
 * saw a team they had just set change its mind on its own.
 */
describe("more than one chooser on screen", () => {
  it("keeps each team's selection to itself", async () => {
    const first = vi.fn();
    const second = vi.fn();
    render(
      <div>
        <div aria-label="first team">
          <TeamShapeChooser
            shape={discussion}
            roster={["risk-lead", "risk-spotter"]}
            onChoose={first}
          />
        </div>
        <div aria-label="second team">
          <TeamShapeChooser
            shape={{
              kind: "discussion",
              rationale: "They disagree usefully.",
              depth: "standard",
              // Its own members. A shape whose roles name another team's
              // roster is not a valid starting point for this one.
              coordinator: "cost-lead",
              participants: ["cost-spotter"],
            }}
            roster={["cost-lead", "cost-spotter"]}
            onChoose={second}
          />
        </div>
      </div>,
    );

    const firstGroup = screen.getByLabelText("first team");
    const secondGroup = screen.getByLabelText("second team");
    const firstChain = screen.getAllByRole("tab").filter(
      (radio) => firstGroup.contains(radio),
    );
    const secondChain = screen.getAllByRole("tab").filter(
      (radio) => secondGroup.contains(radio),
    );

    // Each starts on the discussion its own team is set to.
    expect(firstChain[1]).toHaveAttribute("aria-selected", "true");
    expect(secondChain[1]).toHaveAttribute("aria-selected", "true");

    // Choosing in the second team says nothing about the first.
    await userEvent.click(secondChain[0]!);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(firstChain[1]).toHaveAttribute("aria-selected", "true");
  });
});
