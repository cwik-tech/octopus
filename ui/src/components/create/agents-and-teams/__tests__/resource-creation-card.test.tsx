import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AgentBuildBriefDialog } from "@/components/create/agents-and-teams/agent-build-brief-dialog";
import {
  AgentCreationCard,
  TeamCreationCard,
} from "@/components/create/agents-and-teams/resource-creation-card";
import type {
  PlannedAgentSpec,
  ResourceBuildEvent,
} from "@/lib/models/resource-architect-model";

const agent: PlannedAgentSpec = {
  name: "michigan-contract-lawyer",
  role: "Michigan reviewer",
  description: "Reviews Michigan contract law.",
  rationale: "Requested for the legal review.",
};

/** Appears only in the detailed build brief, never in any card copy. */
const BRIEF_MARKER = "ONLY-IN-THE-FULL-BUILD-BRIEF";

const LONG_BRIEF = [
  "Build an Agent that audits supplier agreements before procurement signs them.",
  "",
  "Run order:",
  "1. Find every renewal clause and quote it exactly.",
  "2. Compare each liability cap with the playbook position.",
  "",
  `Final check: ${BRIEF_MARKER}. Confirm every clause family has a verdict.`,
].join("\n");

const AUDITOR_SUMMARY = "Flags the supplier contract terms procurement should negotiate before signing.";

const auditor: PlannedAgentSpec = {
  name: "supplier-contract-auditor",
  role: "Supplier contract auditor",
  summary: AUDITOR_SUMMARY,
  description: LONG_BRIEF,
  rationale: "Requested to audit supplier agreements.",
};

const VIEW_AUDITOR_BRIEF = "View build brief for Supplier Contract Auditor";

/** The same Agent as a plan saved before proposals carried a card summary. */
const legacyAuditor: PlannedAgentSpec = {
  name: auditor.name,
  role: auditor.role,
  description: LONG_BRIEF,
  rationale: auditor.rationale,
};

describe("planned Agent card copy", () => {
  it("shows the Agent's summary and keeps its build brief out of the card", () => {
    render(<AgentCreationCard agent={auditor} onOpen={vi.fn()} />);

    const card = screen.getByLabelText("Agent supplier-contract-auditor");
    expect(
      within(card).getByText("Flags the supplier contract terms procurement should negotiate before signing."),
    ).toBeInTheDocument();
    expect(card).not.toHaveTextContent(BRIEF_MARKER);
    expect(card).not.toHaveTextContent("Run order:");
  });

  it("shows the first sentence of the brief for a plan saved before card summaries", () => {
    render(<AgentCreationCard agent={legacyAuditor} onOpen={vi.fn()} />);

    const card = screen.getByLabelText("Agent supplier-contract-auditor");
    expect(
      within(card).getByText("Build an Agent that audits supplier agreements before procurement signs them."),
    ).toBeInTheDocument();
    expect(card).not.toHaveTextContent(BRIEF_MARKER);
    expect(within(card).getByRole("button", { name: VIEW_AUDITOR_BRIEF })).toBeInTheDocument();
  });

  it("offers no build brief when the brief says nothing the card does not", () => {
    render(<AgentCreationCard agent={agent} onOpen={vi.fn()} />);

    const card = screen.getByLabelText("Agent michigan-contract-lawyer");
    expect(within(card).getByText("Reviews Michigan contract law.")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /^View build brief/ })).not.toBeInTheDocument();
  });

  // The card reads a legacy brief with its whitespace collapsed, so a brief
  // that differs from the card only in spacing says nothing more.
  it("offers no build brief when the brief differs from the card only in spacing", () => {
    render(
      <AgentCreationCard
        agent={{ ...agent, description: "Reviews  Michigan\tcontract law.\n" }}
        onOpen={vi.fn()}
      />,
    );

    const card = screen.getByLabelText("Agent michigan-contract-lawyer");
    expect(within(card).getByText("Reviews Michigan contract law.")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /^View build brief/ })).not.toBeInTheDocument();
  });

  // A saved brief of nothing but whitespace leaves the card showing the role,
  // and a button there would open an empty dialog.
  it("offers no build brief when the saved brief is blank", () => {
    render(<AgentCreationCard agent={{ ...agent, description: "  \n\t" }} onOpen={vi.fn()} />);

    const card = screen.getByLabelText("Agent michigan-contract-lawyer");
    expect(within(card).getByText("Michigan reviewer")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /^View build brief/ })).not.toBeInTheDocument();
  });

  it("opens the complete build brief from the card on request", async () => {
    const user = userEvent.setup();
    render(<AgentCreationCard agent={auditor} onOpen={vi.fn()} />);

    await user.click(
      within(screen.getByLabelText("Agent supplier-contract-auditor"))
        .getByRole("button", { name: VIEW_AUDITOR_BRIEF }),
    );

    const dialog = screen.getByRole("dialog", { name: "Build brief for Supplier Contract Auditor" });
    expect(within(dialog).getByText(BRIEF_MARKER, { exact: false }).textContent).toBe(LONG_BRIEF);
  });

  // The card caps its summary at three lines, and a narrow chat column cuts a
  // long valid summary short. The cut words must still be readable somewhere.
  it("keeps the whole summary readable when the card cuts it short", async () => {
    const user = userEvent.setup();
    render(<AgentCreationCard agent={auditor} onOpen={vi.fn()} />);
    const card = screen.getByLabelText("Agent supplier-contract-auditor");

    expect(within(card).getByText(AUDITOR_SUMMARY)).toHaveAttribute("title", AUDITOR_SUMMARY);

    await user.click(within(card).getByRole("button", { name: VIEW_AUDITOR_BRIEF }));

    expect(screen.getByRole("dialog", { name: "Build brief for Supplier Contract Auditor" }))
      .toHaveAccessibleDescription(AUDITOR_SUMMARY);
  });

  // A batch puts one of these buttons on every card, and a list of buttons
  // read out without the card around them has to say whose brief each opens.
  it("names the Agent in each card's build brief button", () => {
    render(
      <>
        <AgentCreationCard agent={auditor} onOpen={vi.fn()} />
        <AgentCreationCard
          agent={{ ...auditor, name: "renewal-risk-reviewer", role: "Renewal risk reviewer" }}
          onOpen={vi.fn()}
        />
      </>,
    );

    expect(screen.getByRole("button", { name: "View build brief for Supplier Contract Auditor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View build brief for Renewal Risk Reviewer" })).toBeInTheDocument();
  });
});

describe("the build brief dialog", () => {
  it("shows nothing of the brief until it is asked for", () => {
    render(<AgentBuildBriefDialog agentName="supplier-contract-auditor" summary={AUDITOR_SUMMARY} brief={LONG_BRIEF} />);

    expect(screen.getByRole("button", { name: VIEW_AUDITOR_BRIEF })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(BRIEF_MARKER);
  });

  it("names the Agent and keeps every character and line break of the brief", async () => {
    const user = userEvent.setup();
    render(<AgentBuildBriefDialog agentName="supplier-contract-auditor" summary={AUDITOR_SUMMARY} brief={LONG_BRIEF} />);

    await user.click(screen.getByRole("button", { name: VIEW_AUDITOR_BRIEF }));

    const dialog = screen.getByRole("dialog", { name: "Build brief for Supplier Contract Auditor" });
    expect(within(dialog).getByText(BRIEF_MARKER, { exact: false }).textContent).toBe(LONG_BRIEF);
  });

  it("describes itself with the Agent's whole summary", async () => {
    const user = userEvent.setup();
    render(<AgentBuildBriefDialog agentName="supplier-contract-auditor" summary={AUDITOR_SUMMARY} brief={LONG_BRIEF} />);

    await user.click(screen.getByRole("button", { name: VIEW_AUDITOR_BRIEF }));

    expect(screen.getByRole("dialog", { name: "Build brief for Supplier Contract Auditor" }))
      .toHaveAccessibleDescription(AUDITOR_SUMMARY);
  });

  it("closes with Escape and returns focus to the button that opened it", async () => {
    const user = userEvent.setup();
    render(<AgentBuildBriefDialog agentName="supplier-contract-auditor" summary={AUDITOR_SUMMARY} brief={LONG_BRIEF} />);
    const open = screen.getByRole("button", { name: VIEW_AUDITOR_BRIEF });
    await user.click(open);
    const closed = removedFromDocument(screen.getByRole("dialog"));
    const refocused = new Promise((resolve) => open.addEventListener("focus", resolve, { once: true }));

    await user.keyboard("{Escape}");

    await Promise.all([closed, refocused]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(open).toHaveFocus();
  });
});

/**
 * Settles when the element leaves the document. Base UI unmounts a closed
 * dialog after the keyboard event has been handled, so the test waits on
 * that DOM change itself rather than on time.
 */
function removedFromDocument(element: Element): Promise<void> {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (element.isConnected) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

describe("resource creation cards", () => {
  it("shows the failure that prevented a planned Agent from being published", () => {
    render(
      <AgentCreationCard
        agent={agent}
        item={{
          plannedResource: { kind: "agent", id: agent.name },
          planIndex: 0,
          status: "failed",
          error: "Provider request failed.",
        }}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText("Provider request failed.")).toBeInTheDocument();
  });

  it("shows each Team roster member's live build status and failure detail", () => {
    const events: ResourceBuildEvent[] = [
      {
        id: 1,
        type: "agent_reused",
        plannedResource: { kind: "agent", id: "scoping-lawyer" },
        resource: { kind: "agent", id: "scoping-lawyer" },
        message: "Reused Agent `scoping-lawyer`.",
      },
      {
        id: 2,
        type: "agent_generating",
        plannedResource: { kind: "agent", id: agent.name },
        planIndex: 0,
        message: "Generating Agent `michigan-contract-lawyer`.",
      },
      {
        id: 3,
        type: "agent_failed",
        plannedResource: { kind: "agent", id: "commercial-risk-lawyer" },
        planIndex: 1,
        message: "Failed Agent `commercial-risk-lawyer`: provider unavailable.",
      },
    ];
    render(
      <TeamCreationCard
        team={{
          teamId: "contract-review-team",
          description: "Reviews contracts.",
          tags: ["legal"],
          existingAgents: [{
            name: "scoping-lawyer",
            role: "Scope reviewer",
            rationale: "Already available.",
          }],
          newAgents: [
            agent,
            { ...agent, name: "commercial-risk-lawyer" },
          ],
          questionsResolved: [],
        }}
        item={{
          plannedResource: { kind: "team", id: "contract-review-team" },
          planIndex: 0,
          status: "generating",
        }}
        events={events}
        onOpen={vi.fn()}
      />,
    );

    expect(within(screen.getByRole("listitem", { name: "Scoping Lawyer reused" })).getByText("reused")).toBeInTheDocument();
    expect(within(screen.getByRole("listitem", { name: "Michigan Contract Lawyer generating" })).getByText("generating")).toBeInTheDocument();
    const failed = screen.getByRole("listitem", {
      name: "Commercial Risk Lawyer failed",
    });
    expect(within(failed).getByText("failed")).toBeInTheDocument();
    expect(within(failed).getByText(/provider unavailable/)).toBeInTheDocument();
  });

  it("keeps a roster member generating while one of its skills is repaired", () => {
    const events: ResourceBuildEvent[] = [
      {
        id: 1,
        type: "agent_generating",
        plannedResource: { kind: "agent", id: agent.name },
        planIndex: 0,
        message: "Generating Agent `michigan-contract-lawyer`.",
      },
      {
        id: 2,
        type: "skill_repaired",
        plannedResource: { kind: "agent", id: agent.name },
        planIndex: 0,
        message:
          "Repaired skill `termination-clause-review` to satisfy the Agent Skills specification.",
      },
    ];
    render(
      <TeamCreationCard
        team={{
          teamId: "contract-review-team",
          description: "Reviews contracts.",
          tags: ["legal"],
          existingAgents: [],
          newAgents: [agent],
          questionsResolved: [],
        }}
        item={{
          plannedResource: { kind: "team", id: "contract-review-team" },
          planIndex: 0,
          status: "generating",
        }}
        events={events}
        onOpen={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("listitem", { name: "Michigan Contract Lawyer generating" }),
    ).toBeInTheDocument();
  });

  it("shows a roster member created once a repaired skill is published", () => {
    const events: ResourceBuildEvent[] = [
      {
        id: 1,
        type: "skill_repaired",
        plannedResource: { kind: "agent", id: agent.name },
        planIndex: 0,
        message:
          "Repaired skill `termination-clause-review` to satisfy the Agent Skills specification.",
      },
      {
        id: 2,
        type: "agent_created",
        plannedResource: { kind: "agent", id: agent.name },
        resource: { kind: "agent", id: agent.name },
        planIndex: 0,
        message: "Created Agent `michigan-contract-lawyer`.",
      },
    ];
    render(
      <TeamCreationCard
        team={{
          teamId: "contract-review-team",
          description: "Reviews contracts.",
          tags: ["legal"],
          existingAgents: [],
          newAgents: [agent],
          questionsResolved: [],
        }}
        item={{
          plannedResource: { kind: "team", id: "contract-review-team" },
          planIndex: 0,
          status: "generating",
        }}
        events={events}
        onOpen={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("listitem", { name: "Michigan Contract Lawyer created" }),
    ).toBeInTheDocument();
  });

  it("shows a cancelled Team and marks only unfinished roster members cancelled", () => {
    const events: ResourceBuildEvent[] = [
      {
        id: 1,
        type: "agent_created",
        plannedResource: { kind: "agent", id: "completed-lawyer" },
        resource: { kind: "agent", id: "completed-lawyer" },
        message: "Created Agent `completed-lawyer`.",
      },
      {
        id: 2,
        type: "agent_failed",
        plannedResource: { kind: "agent", id: "failed-lawyer" },
        message: "Failed Agent `failed-lawyer`: provider unavailable.",
      },
      {
        id: 3,
        type: "agent_generating",
        plannedResource: { kind: "agent", id: "generating-lawyer" },
        message: "Generating Agent `generating-lawyer`.",
      },
      {
        id: 4,
        type: "build_cancelled",
        message: "Build cancelled.",
      },
    ];
    render(
      <TeamCreationCard
        team={{
          teamId: "contract-review-team",
          description: "Reviews contracts.",
          tags: ["legal"],
          existingAgents: [],
          newAgents: [
            { ...agent, name: "completed-lawyer" },
            { ...agent, name: "failed-lawyer" },
            { ...agent, name: "generating-lawyer" },
            { ...agent, name: "planned-lawyer" },
          ],
          questionsResolved: [],
        }}
        item={{
          plannedResource: { kind: "team", id: "contract-review-team" },
          planIndex: 0,
          status: "generating",
        }}
        events={events}
        onOpen={vi.fn()}
      />,
    );

    const card = screen.getByLabelText("Team contract-review-team");
    expect(within(card).getAllByText("cancelled")).toHaveLength(3);
    expect(screen.getByRole("listitem", { name: "Completed Lawyer created" })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Failed Lawyer failed" })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Generating Lawyer cancelled" })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Planned Lawyer cancelled" })).toBeInTheDocument();
  });

  // A build that stopped still records which shell it made, because retry and
  // discard need it. That reference is an identity, not an outcome: the team
  // behind it has no roster and fails the moment it runs, so there is nothing
  // to open.
  it("does not offer to open a Team whose build never published it", () => {
    render(
      <TeamCreationCard
        team={{
          teamId: "contract-review-team",
          description: "Reviews contracts.",
          tags: [],
          existingAgents: [
            { name: "risk-lead", role: "Lead", rationale: "Available." },
          ],
          newAgents: [],
          questionsResolved: [],
        }}
        item={{
          plannedResource: { kind: "team", id: "contract-review-team" },
          resource: { kind: "team", id: "contract-review-team" },
          planIndex: 0,
          status: "failed",
          error: "Resource build was interrupted by an API restart.",
        }}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /^Open / })).not.toBeInTheDocument();
  });

  it("offers to open a Team once its build published it", () => {
    render(
      <TeamCreationCard
        team={{
          teamId: "contract-review-team",
          description: "Reviews contracts.",
          tags: [],
          existingAgents: [
            { name: "risk-lead", role: "Lead", rationale: "Available." },
          ],
          newAgents: [],
          questionsResolved: [],
        }}
        item={{
          plannedResource: { kind: "team", id: "contract-review-team" },
          resource: { kind: "team", id: "contract-review-team" },
          planIndex: 0,
          status: "created",
        }}
        onOpen={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Open contract-review-team" }),
    ).toBeInTheDocument();
  });

  // The same rule for a standalone Agent: a reference kept for retry is not a
  // package anybody can open.
  it("does not offer to open an Agent whose build never published it", () => {
    render(
      <AgentCreationCard
        agent={agent}
        item={{
          plannedResource: { kind: "agent", id: agent.name },
          resource: { kind: "agent", id: agent.name },
          planIndex: 0,
          status: "failed",
          error: "Provider request failed.",
        }}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /^Open / })).not.toBeInTheDocument();
  });

  // The other half of what a stopped build offers. The shell it left behind is
  // not a team anybody can use, so throwing it away has to be reachable.
  it("offers to discard the unfinished Team a stopped build left behind", async () => {
    const onDiscard = vi.fn();
    render(
      <TeamCreationCard
        team={{
          teamId: "contract-review-team",
          description: "Reviews contracts.",
          tags: [],
          existingAgents: [
            { name: "risk-lead", role: "Lead", rationale: "Available." },
          ],
          newAgents: [],
          questionsResolved: [],
        }}
        item={{
          plannedResource: { kind: "team", id: "contract-review-team" },
          resource: { kind: "team", id: "contract-review-team" },
          planIndex: 0,
          status: "failed",
          error: "Resource build was interrupted by an API restart.",
        }}
        onOpen={vi.fn()}
        onRetry={vi.fn()}
        onDiscard={onDiscard}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("does not offer to discard a Team its build published", () => {
    render(
      <TeamCreationCard
        team={{
          teamId: "contract-review-team",
          description: "Reviews contracts.",
          tags: [],
          existingAgents: [
            { name: "risk-lead", role: "Lead", rationale: "Available." },
          ],
          newAgents: [],
          questionsResolved: [],
        }}
        item={{
          plannedResource: { kind: "team", id: "contract-review-team" },
          resource: { kind: "team", id: "contract-review-team" },
          planIndex: 0,
          status: "created",
        }}
        onOpen={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Discard" }),
    ).not.toBeInTheDocument();
  });
});
