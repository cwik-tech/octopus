import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ResourceUpdateCard } from "@/components/create/agents-and-teams/resource-update-card";
import type {
  ResourceBuildEvent,
  ResourceUpdateOperation,
} from "@/lib/models/resource-architect-model";

const operation: ResourceUpdateOperation = {
  kind: "add_team_agents",
  target: { kind: "team", id: "contract-review-team" },
  expectedRevision: "sha256:abc",
  libraryAgentsToAdd: [
    {
      name: "scoping-lawyer",
      role: "Scope reviewer",
      rationale: "Reuse the existing scope specialist.",
    },
  ],
  newAgentsToCreate: [
    {
      name: "drafting-completeness-lawyer",
      role: "Drafting reviewer",
      description: "Checks drafting completeness.",
      rationale: "No existing Agent covers drafting gaps.",
    },
  ],
};

const skillOperation: ResourceUpdateOperation = {
  kind: "update_agent_skills",
  target: { kind: "agent", id: "michigan-contract-lawyer" },
  expectedRevision: "sha256:def",
  skillUpdates: [
    {
      action: "create",
      name: "termination-clause-review",
      instruction: "Author the termination review.",
    },
    {
      action: "update",
      name: "indemnity-clause-review",
      instruction: "Require a liability cap check.",
    },
  ],
};

const threeSkillOperation: ResourceUpdateOperation = {
  kind: "update_agent_skills",
  target: { kind: "agent", id: "michigan-contract-lawyer" },
  expectedRevision: "sha256:def",
  skillUpdates: [
    { action: "create", name: "termination-clause-review", instruction: "Author it." },
    { action: "update", name: "indemnity-clause-review", instruction: "Rewrite it." },
    { action: "create", name: "cure-period-review", instruction: "Author it." },
  ],
};

/** A skill-scoped event, shaped the way the update executor records one. */
function skillEvent(
  id: number,
  type: ResourceBuildEvent["type"],
  planIndex: number,
  name: string,
  action: "create" | "update",
  message = `${type} ${name}`,
): ResourceBuildEvent {
  return {
    id,
    type,
    plannedResource: { kind: "agent", id: "michigan-contract-lawyer" },
    planIndex,
    skill: { name, action },
    message,
  };
}

/**
 * The shape the update executor actually emits.
 *
 * An update event names the operation's target as its planned resource and the
 * Agent it is about in `resource` — the Agent is never the planned resource,
 * because the operation was planned against the Team.
 */
function updateEvent(
  id: number,
  type: ResourceBuildEvent["type"],
  planIndex: number,
  teamId: string,
  agentId?: string,
): ResourceBuildEvent {
  return {
    id,
    type,
    plannedResource: { kind: "team", id: teamId },
    ...(agentId ? { resource: { kind: "agent" as const, id: agentId } } : {}),
    planIndex,
    message: `${type} ${agentId ?? teamId}`,
  };
}

describe("resource update card", () => {
  it("names the Team being updated and every Agent the update adds", () => {
    render(
      <ResourceUpdateCard operation={operation} planIndex={0} onOpen={vi.fn()} />,
    );

    expect(
      screen.getByLabelText("Update team contract-review-team"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Update Team Contract Review Team"),
    ).toBeInTheDocument();
    expect(screen.getByText("Scoping Lawyer")).toBeInTheDocument();
    expect(screen.getByText("Drafting Completeness Lawyer")).toBeInTheDocument();
  });

  it("authorizes the update only when the user presses Apply update", async () => {
    const onApply = vi.fn();
    render(
      <ResourceUpdateCard
        operation={operation}
        planIndex={0}
        onOpen={vi.fn()}
        onApply={onApply}
      />,
    );

    expect(onApply).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Apply update" }));

    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("reports a finished operation as updated rather than created", () => {
    render(
      <ResourceUpdateCard
        operation={operation}
        planIndex={0}
        item={{
          plannedResource: { kind: "team", id: "contract-review-team" },
          resource: { kind: "team", id: "contract-review-team" },
          planIndex: 0,
          status: "updated",
        }}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByText("updated")).toBeInTheDocument();
    expect(screen.queryByText("created")).not.toBeInTheDocument();
  });

  it("shows the conflict that stopped an update", () => {
    const events: ResourceBuildEvent[] = [
      {
        id: 1,
        type: "resource_update_conflict",
        plannedResource: { kind: "team", id: "contract-review-team" },
        planIndex: 0,
        message: "Could not update `contract-review-team`: revision changed.",
      },
    ];

    render(
      <ResourceUpdateCard
        operation={operation}
        planIndex={0}
        events={events}
        item={{
          plannedResource: { kind: "team", id: "contract-review-team" },
          planIndex: 0,
          status: "failed",
          error: "Could not update `contract-review-team`: revision changed.",
        }}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(
      screen.getByText(/Could not update `contract-review-team`: revision changed\./),
    ).toBeInTheDocument();
  });

  it("reads an Agent's status from the resource an update event names", () => {
    render(
      <ResourceUpdateCard
        operation={operation}
        planIndex={0}
        events={[
          updateEvent(1, "resource_update_started", 0, "contract-review-team"),
          updateEvent(2, "agent_reused", 0, "contract-review-team", "scoping-lawyer"),
          updateEvent(
            3,
            "agent_created",
            0,
            "contract-review-team",
            "drafting-completeness-lawyer",
          ),
        ]}
        onOpen={vi.fn()}
      />,
    );

    expect(
      screen.getByLabelText("Scoping Lawyer reused"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Drafting Completeness Lawyer created"),
    ).toBeInTheDocument();
  });

  /**
   * The same library Agent can join two Teams in one plan. Each card answers
   * for its own operation, so one operation's progress must never appear on
   * the other's card.
   */
  it("does not read another operation's events for the same Agent id", () => {
    const events: ResourceBuildEvent[] = [
      updateEvent(1, "agent_reused", 0, "contract-review-team", "scoping-lawyer"),
      updateEvent(2, "agent_added", 0, "contract-review-team", "scoping-lawyer"),
    ];
    const secondOperation: ResourceUpdateOperation = {
      ...operation,
      target: { kind: "team", id: "diligence-team" },
      newAgentsToCreate: [],
    };

    render(
      <ResourceUpdateCard
        operation={secondOperation}
        planIndex={1}
        events={events}
        onOpen={vi.fn()}
      />,
    );

    expect(
      screen.getByLabelText("Scoping Lawyer planned"),
      ).toBeInTheDocument();
    expect(screen.queryByLabelText("Scoping Lawyer reused")).not.toBeInTheDocument();
  });

  /**
   * Generation events come from the shared planned-Agent builder, which plans
   * against the Agent itself and carries no `resource` until the package
   * exists. That shape still has to resolve.
   */
  it("still reads a creation-shaped generation event for the Agent it names", () => {
    render(
      <ResourceUpdateCard
        operation={operation}
        planIndex={0}
        events={[{
          id: 1,
          type: "agent_generating",
          plannedResource: { kind: "agent", id: "drafting-completeness-lawyer" },
          planIndex: 0,
          message: "Generating Agent `drafting-completeness-lawyer`.",
        }]}
        onOpen={vi.fn()}
      />,
    );

    expect(
      screen.getByLabelText("Drafting Completeness Lawyer generating"),
    ).toBeInTheDocument();
  });

  it("ignores a creation-shaped event that belongs to another operation", () => {
    render(
      <ResourceUpdateCard
        operation={operation}
        planIndex={0}
        events={[{
          id: 1,
          type: "agent_failed",
          plannedResource: { kind: "agent", id: "drafting-completeness-lawyer" },
          planIndex: 3,
          message: "Could not create `drafting-completeness-lawyer`.",
        }]}
        onOpen={vi.fn()}
      />,
    );

    expect(
      screen.getByLabelText("Drafting Completeness Lawyer planned"),
    ).toBeInTheDocument();
  });

  it("stops showing an Agent as generating when its Team update has failed", () => {
    render(
      <ResourceUpdateCard
        operation={operation}
        planIndex={0}
        item={{
          plannedResource: operation.target,
          planIndex: 0,
          status: "failed",
          error: "Another requested Agent failed; the update was not applied.",
        }}
        events={[{
          id: 1,
          type: "agent_generating",
          plannedResource: { kind: "agent", id: "drafting-completeness-lawyer" },
          planIndex: 0,
          message: "Generating Agent `drafting-completeness-lawyer`.",
        }]}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Drafting Completeness Lawyer interrupted")).toBeInTheDocument();
    expect(screen.queryByLabelText("Drafting Completeness Lawyer generating")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Drafting Completeness Lawyer created")).not.toBeInTheDocument();
  });

  it("names the Agent being updated and every skill action by name", () => {
    render(
      <ResourceUpdateCard operation={skillOperation} planIndex={0} onOpen={vi.fn()} />,
    );

    expect(
      screen.getByLabelText("Update agent michigan-contract-lawyer"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Update Agent Michigan Contract Lawyer"),
    ).toBeInTheDocument();
    const createRow = screen.getByLabelText("Create skill termination-clause-review planned");
    const updateRow = screen.getByLabelText("Update skill indemnity-clause-review planned");
    expect(within(createRow).getByText("termination-clause-review")).toBeInTheDocument();
    expect(within(createRow).getByText("create")).toBeInTheDocument();
    expect(within(updateRow).getByText("indemnity-clause-review")).toBeInTheDocument();
    expect(within(updateRow).getByText("update")).toBeInTheDocument();
  });

  it("shows every skill's proposed action beside a separate planned status before the update runs", () => {
    render(
      <ResourceUpdateCard operation={threeSkillOperation} planIndex={0} onOpen={vi.fn()} />,
    );

    for (const [label, action] of [
      ["Create skill termination-clause-review planned", "create"],
      ["Update skill indemnity-clause-review planned", "update"],
      ["Create skill cure-period-review planned", "create"],
    ] as const) {
      const row = screen.getByLabelText(label);
      expect(within(row).getByText(action)).toBeInTheDocument();
      expect(within(row).getByText("planned")).toBeInTheDocument();
    }
  });

  it("marks only the skill whose author failed, keeps earlier skills staged and later ones planned", () => {
    render(
      <ResourceUpdateCard
        operation={threeSkillOperation}
        planIndex={0}
        item={{
          plannedResource: { kind: "agent", id: "michigan-contract-lawyer" },
          planIndex: 0,
          status: "failed",
          error: "The skill author did not answer: the provider stalled.",
        }}
        events={[
          skillEvent(1, "skill_generating", 0, "termination-clause-review", "create"),
          skillEvent(2, "skill_staged", 0, "termination-clause-review", "create"),
          skillEvent(3, "skill_generating", 0, "indemnity-clause-review", "update"),
          skillEvent(
            4,
            "skill_failed",
            0,
            "indemnity-clause-review",
            "update",
            "Could not author skill `indemnity-clause-review`: the provider stalled.",
          ),
        ]}
        onOpen={vi.fn()}
      />,
    );

    const staged = screen.getByLabelText("Create skill termination-clause-review staged");
    const failed = screen.getByLabelText("Update skill indemnity-clause-review failed");
    const planned = screen.getByLabelText("Create skill cure-period-review planned");
    expect(within(failed).getByRole("alert")).toHaveTextContent(
      "Could not author skill `indemnity-clause-review`: the provider stalled.",
    );
    expect(within(staged).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(planned).queryByRole("alert")).not.toBeInTheDocument();
    // The Agent-level error stays on the card.
    expect(
      screen.getByText("The skill author did not answer: the provider stalled."),
    ).toBeInTheDocument();
  });

  it("leaves every skill at its last proven status when the whole update failed", () => {
    render(
      <ResourceUpdateCard
        operation={threeSkillOperation}
        planIndex={0}
        item={{
          plannedResource: { kind: "agent", id: "michigan-contract-lawyer" },
          planIndex: 0,
          status: "failed",
          error: "Agent 'michigan-contract-lawyer' changed since the update was proposed.",
        }}
        events={[
          skillEvent(1, "skill_generating", 0, "termination-clause-review", "create"),
          skillEvent(2, "skill_staged", 0, "termination-clause-review", "create"),
          updateEvent(3, "resource_update_conflict", 0, "michigan-contract-lawyer"),
        ]}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Create skill termination-clause-review staged")).toBeInTheDocument();
    expect(screen.getByLabelText("Update skill indemnity-clause-review planned")).toBeInTheDocument();
    expect(screen.getByLabelText("Create skill cure-period-review planned")).toBeInTheDocument();
    expect(screen.queryByLabelText(/skill .* failed$/)).not.toBeInTheDocument();
  });

  it("says a skill is updated only once the update event for it arrives", () => {
    render(
      <ResourceUpdateCard
        operation={skillOperation}
        planIndex={0}
        item={{
          plannedResource: { kind: "agent", id: "michigan-contract-lawyer" },
          planIndex: 0,
          status: "generating",
        }}
        events={[
          skillEvent(1, "skill_staged", 0, "termination-clause-review", "create"),
          skillEvent(2, "skill_staged", 0, "indemnity-clause-review", "update"),
          skillEvent(3, "skill_updated", 0, "termination-clause-review", "create"),
        ]}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Create skill termination-clause-review updated")).toBeInTheDocument();
    expect(screen.getByLabelText("Update skill indemnity-clause-review staged")).toBeInTheDocument();
  });

  it("reads a skill from its own operation only, when another operation has one of the same name", () => {
    render(
      <ResourceUpdateCard
        operation={skillOperation}
        planIndex={1}
        item={{
          plannedResource: { kind: "agent", id: "michigan-contract-lawyer" },
          planIndex: 1,
          status: "generating",
        }}
        events={[
          skillEvent(1, "skill_failed", 0, "termination-clause-review", "create", "Other operation."),
          skillEvent(2, "skill_updated", 0, "indemnity-clause-review", "update"),
          skillEvent(3, "skill_generating", 1, "termination-clause-review", "create"),
        ]}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Create skill termination-clause-review generating")).toBeInTheDocument();
    expect(screen.getByLabelText("Update skill indemnity-clause-review planned")).toBeInTheDocument();
    expect(screen.queryByText("Other operation.")).not.toBeInTheDocument();
  });

  it("names the skill that was being authored when the build stopped", () => {
    const { rerender } = render(
      <ResourceUpdateCard
        operation={threeSkillOperation}
        planIndex={0}
        item={{
          plannedResource: { kind: "agent", id: "michigan-contract-lawyer" },
          planIndex: 0,
          status: "interrupted",
          error: "Resource build was interrupted by an API restart. Retry the build to continue.",
        }}
        events={[
          skillEvent(1, "skill_staged", 0, "termination-clause-review", "create"),
          skillEvent(2, "skill_generating", 0, "indemnity-clause-review", "update"),
        ]}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Create skill termination-clause-review staged")).toBeInTheDocument();
    expect(screen.getByLabelText("Update skill indemnity-clause-review interrupted")).toBeInTheDocument();
    expect(screen.getByLabelText("Create skill cure-period-review planned")).toBeInTheDocument();

    rerender(
      <ResourceUpdateCard
        operation={threeSkillOperation}
        planIndex={0}
        item={{
          plannedResource: { kind: "agent", id: "michigan-contract-lawyer" },
          planIndex: 0,
          status: "cancelled",
          error: "Skill update cancelled",
        }}
        events={[
          skillEvent(1, "skill_staged", 0, "termination-clause-review", "create"),
          skillEvent(2, "skill_generating", 0, "indemnity-clause-review", "update"),
          skillEvent(3, "skill_cancelled", 0, "indemnity-clause-review", "update"),
        ]}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Update skill indemnity-clause-review cancelled")).toBeInTheDocument();
    expect(screen.getByLabelText("Create skill cure-period-review planned")).toBeInTheDocument();
  });

  it("does not describe an Agent skill update as a roster change", () => {
    render(
      <ResourceUpdateCard operation={skillOperation} planIndex={0} onOpen={vi.fn()} />,
    );

    const card = screen.getByLabelText("Update agent michigan-contract-lawyer");
    expect(card.textContent ?? "").not.toMatch(/roster|Team/i);
  });

  /**
   * A cancelled job does not un-finish the operations that already succeeded.
   *
   * A multi-operation plan can be withdrawn after one target was updated, and
   * the executor marks the whole job cancelled. The card that already reported
   * `updated` describes a change that is on disk, so it keeps saying so.
   */
  it("keeps a finished operation's status when the build was cancelled", () => {
  render(
    <ResourceUpdateCard
      operation={operation}
      planIndex={0}
      item={{
        plannedResource: { kind: "team", id: "contract-review-team" },
        resource: { kind: "team", id: "contract-review-team" },
        planIndex: 0,
        status: "updated",
      }}
      events={[{
        id: 9,
        type: "build_cancelled",
        message: "Cancelled the update batch.",
      }]}
      onOpen={vi.fn()}
    />,
  );

    const card = screen.getByLabelText("Update team contract-review-team");
    expect(card.textContent ?? "").toContain("updated");
    expect(card.textContent ?? "").not.toContain("cancelled");
});

  it("still reports an unfinished operation as cancelled when the build was", () => {
  render(
    <ResourceUpdateCard
      operation={operation}
      planIndex={1}
      item={{
        plannedResource: { kind: "team", id: "diligence-team" },
        planIndex: 1,
        status: "generating",
      }}
      events={[{
        id: 9,
        type: "build_cancelled",
        message: "Cancelled the update batch.",
      }]}
      onOpen={vi.fn()}
    />,
  );

    const card = screen.getByLabelText("Update team contract-review-team");
    expect(card.textContent ?? "").toContain("cancelled");
    expect(card.textContent ?? "").not.toContain("generating");
});
});
