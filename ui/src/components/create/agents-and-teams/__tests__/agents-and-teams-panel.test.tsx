import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AgentsAndTeamsPanel from "@/components/create/agents-and-teams/agents-and-teams-panel";
import {
  listResourceArchitectMetrics,
  postResourceArchitectTurn,
  readResourceBuildJob,
  startResourceBuildJob,
} from "@/lib/clients/resource-architect-client";
import type { ResourceBuildJobSnapshot } from "@/lib/models/resource-architect-model";

let chatMounts = 0;
let renderedChatProps: {
  history: Array<{ role: "user" | "assistant"; text: string; createdAt?: string }>;
  additionalTimelineItems?: Array<{ id: string; occurredAt: string; content: React.ReactNode }>;
  footerContent?: React.ReactNode;
} | null = null;
vi.mock("@/components/create/workflow-generator-chat", () => ({
  default: function Chat(props: {
    onSubmit: (text: string) => Promise<void> | void;
    history: Array<{ role: "user" | "assistant"; text: string; createdAt?: string }>;
    additionalTimelineItems?: Array<{ id: string; occurredAt: string; content: React.ReactNode }>;
    fileComposer?: { ownerId: string | null };
    footerContent?: React.ReactNode;
  }) {
    renderedChatProps = props;
    const [mountId] = useState(() => ++chatMounts);
    return (
      <div data-testid="resource-chat" data-mount-id={mountId}>
        <span>File owner: {props.fileComposer?.ownerId ?? "none"}</span>
        <button type="button" onClick={() => void props.onSubmit("Create three lawyers")}>
          Submit resource request
        </button>
        <button type="button" onClick={() => void props.onSubmit("build it")}>
          Submit build confirmation
        </button>
        {props.footerContent}
        {props.additionalTimelineItems?.map((item) => (
          <div key={item.id}>{item.content}</div>
        ))}
      </div>
    );
  },
}));
vi.mock("@/components/create/agent-architect-panel", () => ({
  default: ({
    agentSelectionRequest,
    onDirtyChange,
  }: {
    agentSelectionRequest?: { agentName: string };
    onDirtyChange?: (dirty: boolean) => void;
  }) => (
    <div>
      Agent inspector: {agentSelectionRequest?.agentName}
      <button type="button" onClick={() => onDirtyChange?.(true)}>
        Make inspector dirty
      </button>
    </div>
  ),
}));
vi.mock("@/components/create/team-architect-panel", () => ({
  default: () => <div>Team inspector</div>,
}));
vi.mock("@/lib/clients/chat-defaults-client", () => ({
  fetchChatDefaults: vi.fn(() =>
    Promise.resolve({ team: { provider: "openai", model: "test-model" } }),
  ),
}));
vi.mock("@/lib/clients/resource-architect-client", () => ({
  listResourceArchitectMetrics: vi.fn(() => Promise.resolve([])),
  listResourceBuildJobs: vi.fn(() => Promise.resolve([])),
  postResourceArchitectTurn: vi.fn(),
  readResourceBuildJob: vi.fn(),
  retryResourceBuildJob: vi.fn(),
  startResourceBuildJob: vi.fn(),
}));

const names = ["michigan-contract-lawyer", "commercial-risk-lawyer", "drafting-lawyer"];
const plan = {
  id: "plan-panel",
  kind: "standalone_agents" as const,
  agents: names.map((name) => ({
    name,
    role: "Reviewer",
    tier: "specialist",
    description: `Creates ${name}`,
    rationale: "Requested",
  })),
};

const updatePlan = {
  id: "plan-panel-update",
  kind: "resource_updates" as const,
  operations: [{
    kind: "add_team_agents" as const,
    target: { kind: "team" as const, id: "contract-review-team" },
    expectedRevision: "sha256:abc",
    libraryAgentsToAdd: [{
      name: "scoping-lawyer",
      role: "Scope reviewer",
      tier: "strategic",
      rationale: "Reuse.",
    }],
    newAgentsToCreate: [{
      name: "drafting-completeness-lawyer",
      role: "Drafting reviewer",
      tier: "strategic",
      description: "Checks drafting completeness.",
      rationale: "No existing Agent covers drafting gaps.",
    }],
  }],
};

describe("AgentsAndTeamsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` forgets calls but keeps implementations, so a resolved
    // value one test sets would answer the calls of every test after it.
    vi.mocked(postResourceArchitectTurn).mockReset();
    vi.mocked(listResourceArchitectMetrics).mockResolvedValue([]);
    renderedChatProps = null;
  });

  it("omits default-model cards even when the record arrives late", async () => {
    const metricFor = (jobId: string) => ({
      schemaVersion: 1 as const,
      recordedAt: "2026-09-05T10:00:00.000Z",
      jobId,
      operation: "conversation" as const,
      status: "completed" as const,
      provider: "openai",
      model: "test-model",
      reasoning: "low" as const,
      outcomeKind: null,
      fallback: false,
      selection: {
        provider: "openai",
        model: "test-model",
        source: "app-default" as const,
        reason: "agent-default" as const,
        caller: "authoring" as const,
      },
      timing: testMeta("low").timing,
    });
    let releaseMetrics!: (value: ReturnType<typeof metricFor>[]) => void;
    vi.mocked(listResourceArchitectMetrics).mockReturnValue(
      new Promise((resolve) => {
        releaseMetrics = resolve as (value: ReturnType<typeof metricFor>[]) => void;
      }),
    );
    vi.mocked(postResourceArchitectTurn).mockResolvedValue({
      jobId: "live-turn",
      operation: "conversation",
      message: "Understood.",
      warnings: [],
      meta: {
        ...testMeta("low"),
        selection: {
          provider: "openai",
          model: "test-model",
          source: "app-default",
          reason: "agent-default",
          caller: "authoring",
        } as const,
      },
    });
    const user = userEvent.setup();
    render(<AgentsAndTeamsPanel />);

    await user.click(screen.getByRole("button", { name: "Submit resource request" }));
    await waitFor(() => expect(renderedChatProps?.history.at(-1)?.text).toBe("Understood."));
    await waitFor(() =>
      expect(
        (renderedChatProps?.additionalTimelineItems ?? []).filter((item) =>
          item.id.startsWith("architect-model-selection:"),
        ),
      ).toHaveLength(0),
    );
    const posted = vi.mocked(postResourceArchitectTurn).mock.calls[0]![0];

    // The server recorded the very turn that just ran, and the record lands
    // after it. Neither source should add a card.
    releaseMetrics([metricFor(posted.jobId)]);
    await waitFor(() => expect(listResourceArchitectMetrics).toHaveBeenCalled());

    await waitFor(() =>
      expect(
        (renderedChatProps?.additionalTimelineItems ?? []).filter((item) =>
          item.id.startsWith("architect-model-selection:"),
        ),
      ).toHaveLength(0),
    );
  });

  it("omits default-model cards when the record arrives before the reply", async () => {
    const metricFor = (jobId: string) => ({
      schemaVersion: 1 as const,
      recordedAt: "2026-09-05T10:00:00.000Z",
      jobId,
      operation: "conversation" as const,
      status: "completed" as const,
      provider: "openai",
      model: "test-model",
      reasoning: "low" as const,
      outcomeKind: null,
      fallback: false,
      selection: {
        provider: "openai",
        model: "test-model",
        source: "app-default" as const,
        reason: "agent-default" as const,
        caller: "authoring" as const,
      },
      timing: testMeta("low").timing,
    });
    let releaseMetrics!: (value: ReturnType<typeof metricFor>[]) => void;
    vi.mocked(listResourceArchitectMetrics).mockReturnValue(
      new Promise((resolve) => {
        releaseMetrics = resolve as (value: ReturnType<typeof metricFor>[]) => void;
      }),
    );
    // The record lands while the turn is still in flight, carrying that turn's
    // own id, and only then does the reply arrive.
    vi.mocked(postResourceArchitectTurn).mockImplementation(async (input) => {
      releaseMetrics([metricFor(input.jobId)]);
      await Promise.resolve();
      return {
        jobId: input.jobId,
        operation: "conversation" as const,
        message: "Understood.",
        warnings: [],
        meta: {
          ...testMeta("low"),
          selection: {
            provider: "openai",
            model: "test-model",
            source: "app-default",
            reason: "agent-default",
            caller: "authoring",
          } as const,
        },
      };
    });
    const user = userEvent.setup();
    render(<AgentsAndTeamsPanel />);

    await user.click(screen.getByRole("button", { name: "Submit resource request" }));
    await waitFor(() => expect(postResourceArchitectTurn).toHaveBeenCalled());

    await waitFor(() =>
      expect(
        (renderedChatProps?.additionalTimelineItems ?? []).filter((item) =>
          item.id.startsWith("architect-model-selection:"),
        ),
      ).toHaveLength(0),
    );
  });

  it("renders an update proposal as an update card and authorizes only on Apply update", async () => {
    const user = userEvent.setup();
    vi.mocked(startResourceBuildJob).mockReturnValue(new Promise(() => undefined));
    vi.mocked(postResourceArchitectTurn).mockResolvedValueOnce({
      jobId: "turn-update-proposal",
      operation: "proposal",
      message: "I will add two Agents to contract-review-team.",
      outcome: updatePlan,
      warnings: [],
      meta: testMeta("medium"),
    });
    render(<AgentsAndTeamsPanel />);

    await user.click(screen.getByRole("button", { name: "Submit resource request" }));

    const card = await screen.findByLabelText("Update team contract-review-team");
    expect(card).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create" })).not.toBeInTheDocument();
    expect(startResourceBuildJob).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Apply update" }));

    expect(startResourceBuildJob).toHaveBeenCalledTimes(1);
    expect(startResourceBuildJob).toHaveBeenCalledWith(
      expect.objectContaining({ planId: updatePlan.id }),
    );
  });

  /**
   * A revision conflict is pinned to a revision that has moved on, so retrying
   * the same stored plan can only fail again. The button that promises
   * otherwise is removed, and the card says what would actually help.
   */
  it("offers no Retry for a stale conflict, and says a fresh proposal is needed", async () => {
    const user = userEvent.setup();
    const conflicted: ResourceBuildJobSnapshot = {
      jobId: "conflict-job",
      planId: updatePlan.id,
      status: "failed",
      items: [{
        plannedResource: { kind: "team", id: "contract-review-team" },
        planIndex: 0,
        status: "failed",
        error: "Team 'contract-review-team' changed since the update was proposed.",
      }],
      selectedResource: null,
      events: [{
        id: 1,
        type: "resource_update_conflict",
        plannedResource: { kind: "team", id: "contract-review-team" },
        planIndex: 0,
        message: "Could not update `contract-review-team`: revision changed.",
      }],
    };
    vi.mocked(startResourceBuildJob).mockResolvedValue({
      jobId: "conflict-job",
      job: conflicted,
    });
    vi.mocked(readResourceBuildJob).mockResolvedValue(conflicted);
    vi.mocked(postResourceArchitectTurn).mockResolvedValueOnce({
      jobId: "turn-conflict",
      operation: "proposal",
      message: "I will add two Agents to contract-review-team.",
      outcome: updatePlan,
      warnings: [],
      meta: testMeta("medium"),
    });
    render(<AgentsAndTeamsPanel />);
    await user.click(screen.getByRole("button", { name: "Submit resource request" }));
    const card = await screen.findByLabelText("Update team contract-review-team");

    await user.click(within(card).getByRole("button", { name: "Apply update" }));

    await waitFor(() =>
      expect(within(card).getByText(/fresh proposal/i)).toBeInTheDocument()
    );
    expect(within(card).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  /**
   * A name this plan cannot have is as final as a stale revision. The plan
   * carries the value that does not work, so retrying it changes nothing.
   */
  it("offers no Retry when an Agent in the plan needs a different name", async () => {
    const user = userEvent.setup();
    const needsInput: ResourceBuildJobSnapshot = {
      jobId: "needs-input-job",
      planId: updatePlan.id,
      status: "failed",
      items: [{
        plannedResource: { kind: "team", id: "contract-review-team" },
        planIndex: 0,
        status: "failed",
        error: "Ask for a fresh proposal: drafting-completeness-lawyer (needs_input).",
      }],
      selectedResource: null,
      events: [{
        id: 1,
        type: "agent_needs_input",
        plannedResource: { kind: "agent", id: "drafting-completeness-lawyer" },
        planIndex: 0,
        message: "Agent `drafting-completeness-lawyer` needs a revised name.",
      }],
    };
    vi.mocked(startResourceBuildJob).mockResolvedValue({
      jobId: "needs-input-job",
      job: needsInput,
    });
    vi.mocked(readResourceBuildJob).mockResolvedValue(needsInput);
    vi.mocked(postResourceArchitectTurn).mockResolvedValueOnce({
      jobId: "turn-needs-input",
      operation: "proposal",
      message: "I will add two Agents to contract-review-team.",
      outcome: updatePlan,
      warnings: [],
      meta: testMeta("medium"),
    });
    render(<AgentsAndTeamsPanel />);
    await user.click(screen.getByRole("button", { name: "Submit resource request" }));
    const card = await screen.findByLabelText("Update team contract-review-team");

    await user.click(within(card).getByRole("button", { name: "Apply update" }));

    await waitFor(() =>
      expect(
        within(card).getByText(/retrying this plan cannot succeed/i),
      ).toBeInTheDocument()
    );
    expect(within(card).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    // The reason is not a revision conflict, so the card must not claim one.
    expect(within(card).queryByText(/revision/i)).not.toBeInTheDocument();
  });

  it("keeps Retry for an update failure a retry can still clear", async () => {
    const user = userEvent.setup();
    const recoverable: ResourceBuildJobSnapshot = {
      jobId: "recoverable-job",
      planId: updatePlan.id,
      status: "failed",
      items: [{
        plannedResource: { kind: "team", id: "contract-review-team" },
        planIndex: 0,
        status: "failed",
        error: "Could not update `contract-review-team`: the provider was unreachable.",
      }],
      selectedResource: null,
      events: [{
        id: 1,
        type: "resource_update_failed",
        plannedResource: { kind: "team", id: "contract-review-team" },
        planIndex: 0,
        message: "Could not update `contract-review-team`: the provider was unreachable.",
      }],
    };
    vi.mocked(startResourceBuildJob).mockResolvedValue({
      jobId: "recoverable-job",
      job: recoverable,
    });
    vi.mocked(readResourceBuildJob).mockResolvedValue(recoverable);
    vi.mocked(postResourceArchitectTurn).mockResolvedValueOnce({
      jobId: "turn-recoverable",
      operation: "proposal",
      message: "I will add two Agents to contract-review-team.",
      outcome: updatePlan,
      warnings: [],
      meta: testMeta("medium"),
    });
    render(<AgentsAndTeamsPanel />);
    await user.click(screen.getByRole("button", { name: "Submit resource request" }));
    const card = await screen.findByLabelText("Update team contract-review-team");

    await user.click(within(card).getByRole("button", { name: "Apply update" }));

    await waitFor(() =>
      expect(within(card).getByRole("button", { name: "Retry" })).toBeInTheDocument()
    );
    expect(within(card).queryByText(/fresh proposal/i)).not.toBeInTheDocument();
  });

  it("shows the Team inspector on the Teams tab and the Agent inspector on the Agents tab", () => {
    const { rerender } = render(
      <AgentsAndTeamsPanel detailsOpen inspectorTab="teams" />,
    );
    expect(screen.getByText("Team inspector")).toBeInTheDocument();
    expect(screen.queryByText(/Agent inspector/)).not.toBeInTheDocument();

    rerender(<AgentsAndTeamsPanel detailsOpen inspectorTab="agents" />);
    expect(screen.getByText(/Agent inspector/)).toBeInTheDocument();
    expect(screen.queryByText("Team inspector")).not.toBeInTheDocument();
  });

  it("drives the proposal from a conversational confirmation, with no footer button", async () => {
    const user = userEvent.setup();
    vi.mocked(postResourceArchitectTurn)
      .mockResolvedValueOnce({
        jobId: "turn-before-proposal-visibility",
        operation: "conversation",
        message: "I can prepare a proposal.",
        warnings: [],
        meta: testMeta("low"),
      })
      .mockResolvedValueOnce({
        jobId: "turn-proposal-request",
        operation: "conversation",
        message: "Understood — preparing the proposal for your review.",
        warnings: [],
        proposalRequested: true,
        meta: testMeta("low"),
      })
      .mockResolvedValueOnce({
        jobId: "turn-proposal-visibility",
        operation: "proposal",
        message: "Here is the proposed plan.",
        outcome: plan,
        warnings: [],
        meta: testMeta("medium"),
      });
    render(<AgentsAndTeamsPanel />);

    expect(
      screen.queryByRole("button", { name: "Prepare proposal" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Submit resource request" }));
    await waitFor(() => expect(renderedChatProps?.history).toHaveLength(2));
    expect(
      screen.queryByRole("button", { name: "Prepare proposal" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Submit build confirmation" }));

    expect(await screen.findByRole("button", { name: "Create" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Prepare proposal" }),
    ).not.toBeInTheDocument();
  });

  it("keeps Create visible but disabled once the build has been started", async () => {
    const user = userEvent.setup();
    vi.mocked(startResourceBuildJob).mockReturnValue(new Promise(() => undefined));
    vi.mocked(postResourceArchitectTurn)
      .mockResolvedValueOnce({
        jobId: "turn-before-create-disabled",
        operation: "conversation",
        message: "I can prepare a proposal.",
        warnings: [],
        meta: testMeta("low"),
      })
      .mockResolvedValueOnce({
        jobId: "turn-request-create-disabled",
        operation: "conversation",
        message: "Understood — preparing the proposal for your review.",
        warnings: [],
        proposalRequested: true,
        meta: testMeta("low"),
      })
      .mockResolvedValueOnce({
        jobId: "turn-proposal-create-disabled",
        operation: "proposal",
        message: "Here is the proposed plan.",
        outcome: plan,
        warnings: [],
        meta: testMeta("medium"),
      });
    render(<AgentsAndTeamsPanel />);

    await user.click(screen.getByRole("button", { name: "Submit resource request" }));
    await user.click(screen.getByRole("button", { name: "Submit build confirmation" }));

    const create = await screen.findByRole("button", { name: "Create" });
    expect(create).toBeEnabled();

    await user.click(create);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create" })).toBeDisabled(),
    );
  });

  it("sends no selected resource when the visible inspector is not editing it", async () => {
    const user = userEvent.setup();
    vi.mocked(postResourceArchitectTurn).mockResolvedValue({
      jobId: "turn-selection",
      operation: "conversation",
      message: "No creation yet.",
      warnings: [],
      meta: testMeta("low"),
    });

    // An agent stays selected from the Agents tab, but the Teams tab is showing
    // an empty Team inspector, so the turn must not claim that agent.
    render(
      <AgentsAndTeamsPanel
        detailsOpen
        inspectorTab="teams"
        agentSelectionRequest={{ id: "req-1", agentName: "scoping-lawyer" }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Submit resource request" }));

    await waitFor(() => {
      expect(postResourceArchitectTurn).toHaveBeenCalledWith(
        expect.objectContaining({ selectedResource: undefined }),
      );
    });
  });

  it("uses one uploaded-document draft for resource planning", async () => {
    const user = userEvent.setup();
    vi.mocked(postResourceArchitectTurn).mockResolvedValue({
      jobId: "turn-documents",
      operation: "conversation",
      message: "No creation yet.",
      warnings: [],
      meta: testMeta("low"),
    });

    render(<AgentsAndTeamsPanel />);
    const ownerText = await screen.findByText(/^File owner: /);
    const draftId = ownerText.textContent?.replace("File owner: ", "");
    expect(draftId).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Submit resource request" }));

    await waitFor(() => {
      expect(postResourceArchitectTurn).toHaveBeenCalledWith(
        expect.objectContaining({ draftId }),
      );
    });
  });

  it("keeps the creation chat mounted while completed Agent cards drive the inspector", async () => {
    const user = userEvent.setup();
    let finishBuild!: (value: { jobId: string; job: ResourceBuildJobSnapshot }) => void;
    vi.mocked(startResourceBuildJob).mockReturnValue(
      new Promise((resolve) => {
        finishBuild = resolve;
      }),
    );
    vi.mocked(postResourceArchitectTurn)
      .mockResolvedValueOnce({
        jobId: "turn-panel",
        operation: "conversation",
        message: "I can prepare the three-lawyer proposal.",
        warnings: [],
        meta: testMeta("low"),
      })
      .mockResolvedValueOnce({
        jobId: "turn-panel-request",
        operation: "conversation",
        message: "Understood — preparing the proposal for your review.",
        warnings: [],
        proposalRequested: true,
        meta: testMeta("low"),
      })
      .mockResolvedValueOnce({
        jobId: "proposal-panel",
        operation: "proposal",
        message: "Review the proposed lawyers.",
        outcome: plan,
        warnings: [],
        meta: testMeta("medium"),
      });
    const opened: string[] = [];

    function Harness() {
      const [agentName, setAgentName] = useState("scoping-lawyer");
      return (
        <AgentsAndTeamsPanel
          detailsOpen
          agentSelectionRequest={{ id: agentName, agentName }}
          onOpenAgent={(name) => {
            opened.push(name);
            setAgentName(name);
          }}
        />
      );
    }

    render(<Harness />);
    const firstMount = screen.getByTestId("resource-chat").dataset.mountId;
    await user.click(screen.getByRole("button", { name: "Submit resource request" }));
    await user.click(screen.getByRole("button", { name: "Submit build confirmation" }));

    for (const name of names) {
      expect(await screen.findByText(name)).toBeInTheDocument();
    }
    expect(screen.getByText("Agent inspector: scoping-lawyer")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create" }));

    const completed: ResourceBuildJobSnapshot = {
      jobId: "build-panel",
      planId: plan.id,
      status: "completed",
      items: names.map((name, planIndex) => ({
        plannedResource: { kind: "agent", id: name },
        resource: { kind: "agent", id: name },
        planIndex,
        status: "created",
      })),
      selectedResource: { kind: "agent", id: names[0]! },
      events: [],
    };
    await act(async () => finishBuild({ jobId: completed.jobId, job: completed }));
    await waitFor(() => expect(opened).toContain(names[0]));
    expect(screen.getByTestId("resource-chat").dataset.mountId).toBe(firstMount);

    await user.click(screen.getByRole("button", { name: `Open ${names[1]}` }));
    expect(screen.getByText(`Agent inspector: ${names[1]}`)).toBeInTheDocument();
    expect(screen.getByTestId("resource-chat").dataset.mountId).toBe(firstMount);
  });

  it("does not auto-select a completed resource over unsaved inspector edits", async () => {
    const user = userEvent.setup();
    let finishBuild!: (value: { jobId: string; job: ResourceBuildJobSnapshot }) => void;
    vi.mocked(startResourceBuildJob).mockReturnValue(
      new Promise((resolve) => {
        finishBuild = resolve;
      }),
    );
    vi.mocked(postResourceArchitectTurn)
      .mockResolvedValueOnce({
        jobId: "turn-dirty-inspector",
        operation: "conversation",
        message: "I can prepare a proposal.",
        warnings: [],
        meta: testMeta("low"),
      })
      .mockResolvedValueOnce({
        jobId: "turn-dirty-inspector-request",
        operation: "conversation",
        message: "Understood — preparing the proposal for your review.",
        warnings: [],
        proposalRequested: true,
        meta: testMeta("low"),
      })
      .mockResolvedValueOnce({
        jobId: "proposal-dirty-inspector",
        operation: "proposal",
        message: "Review the proposed lawyers.",
        outcome: plan,
        warnings: [],
        meta: testMeta("medium"),
      });
    const onOpenAgent = vi.fn();
    render(
      <AgentsAndTeamsPanel
        detailsOpen
        agentSelectionRequest={{ id: "selected", agentName: "scoping-lawyer" }}
        onOpenAgent={onOpenAgent}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Make inspector dirty" }));
    await user.click(screen.getByRole("button", { name: "Submit resource request" }));
    await user.click(screen.getByRole("button", { name: "Submit build confirmation" }));
    await user.click(await screen.findByRole("button", { name: "Create" }));
    const completed: ResourceBuildJobSnapshot = {
      jobId: "build-dirty-inspector",
      planId: plan.id,
      status: "completed",
      items: names.map((name, planIndex) => ({
        plannedResource: { kind: "agent", id: name },
        resource: { kind: "agent", id: name },
        planIndex,
        status: "created",
      })),
      selectedResource: { kind: "agent", id: names[0]! },
      events: [],
    };

    await act(async () => finishBuild({ jobId: completed.jobId, job: completed }));

    expect(onOpenAgent).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: `Open ${names[0]}` })).toBeInTheDocument();
  });

  it("places resource cards at the plan turn instead of after later discussion", async () => {
    const user = userEvent.setup();
    vi.mocked(postResourceArchitectTurn)
      .mockResolvedValueOnce({
        jobId: "turn-discussion-before-proposal",
        operation: "conversation",
        message: "I can prepare the proposal.",
        warnings: [],
        meta: testMeta("low"),
      })
      .mockResolvedValueOnce({
        jobId: "turn-proposal-request",
        operation: "conversation",
        message: "Understood — preparing the proposal for your review.",
        warnings: [],
        proposalRequested: true,
        meta: testMeta("low"),
      })
      .mockResolvedValueOnce({
        jobId: "turn-proposal",
        operation: "proposal",
        message: "Here is the proposed plan.",
        outcome: plan,
        warnings: [],
        meta: testMeta("medium"),
      })
      .mockResolvedValueOnce({
        jobId: "turn-discussion",
        operation: "conversation",
        message: "We can discuss it further.",
        warnings: [],
        meta: testMeta("low"),
      });
    render(<AgentsAndTeamsPanel />);

    await user.click(screen.getByRole("button", { name: "Submit resource request" }));
    await waitFor(() => expect(renderedChatProps?.history).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "Submit build confirmation" }));
    await waitFor(() => expect(renderedChatProps?.history).toHaveLength(5));
    const planTurnTime = renderedChatProps?.history[4]?.createdAt;
    expect(planTurnTime).toBeTruthy();
    expect(renderedChatProps?.additionalTimelineItems?.[0]?.occurredAt).toBe(planTurnTime);

    await user.click(screen.getByRole("button", { name: "Submit resource request" }));
    await waitFor(() => expect(renderedChatProps?.history).toHaveLength(7));
    expect(renderedChatProps?.additionalTimelineItems?.[0]?.occurredAt).toBe(planTurnTime);
  });
});

function testMeta(reasoning: "low" | "medium") {
  return {
    provider: "openai",
    model: "test-model",
    fallback: false,
    reasoning,
    timing: {
      contextAssemblyMs: 1,
      providerDurationMs: 1,
      processSpawnMs: null,
      firstProviderEventMs: null,
      firstTextMs: 1,
      parseDurationMs: 0,
      repairOccurred: false,
      repairDurationMs: 0,
      totalDurationMs: 2,
      context: {
        instructionsChars: 1,
        operationChars: 1,
        uploadedDocumentPolicyChars: 1,
        visualizationPolicyChars: 1,
        teamLibraryChars: 1,
        agentLibraryChars: 1,
        totalChars: 6,
        historyChars: 1,
      },
    },
  };
}
