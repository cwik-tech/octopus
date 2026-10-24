import { act, getConfig, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useResourceArchitectChat } from "@/components/create/agents-and-teams/use-resource-architect-chat";
import { cancelAgentJob } from "@/lib/clients/agent-generator-client";
import { openAgentTextStreamAt } from "@/lib/clients/agent-text-stream-client";
import {
  listResourceArchitectMetrics,
  listResourceBuildJobs,
  postResourceArchitectTurn,
  readResourceBuildJob,
  readTeamShape,
  retryResourceBuildJob,
  startResourceBuildJob,
} from "@/lib/clients/resource-architect-client";
import type { ResourceBuildJobSnapshot } from "@/lib/models/resource-architect-model";
import type { AgentTextStreamDelivery } from "@contracts/agent-text-stream";

vi.mock("@/lib/clients/resource-architect-client", () => ({
  listResourceArchitectMetrics: vi.fn(() => Promise.resolve([])),
  listResourceBuildJobs: vi.fn(() => Promise.resolve([])),
  postResourceArchitectTurn: vi.fn(),
  readResourceBuildJob: vi.fn(),
  readTeamShape: vi.fn(),
  amendTeamShape: vi.fn(),
  retryResourceBuildJob: vi.fn(),
  startResourceBuildJob: vi.fn(),
}));

vi.mock("@/lib/clients/agent-generator-client", () => ({
  cancelAgentJob: vi.fn(),
}));

vi.mock("@/lib/clients/agent-text-stream-client", () => ({
  openAgentTextStreamAt: vi.fn(),
}));

const plan = {
  id: "plan-1",
  kind: "standalone_agents" as const,
  agents: ["michigan-contract-lawyer", "commercial-risk-lawyer", "drafting-lawyer"].map(
    (name) => ({
      name,
      role: "Reviewer",
      tier: "specialist",
      description: `Creates ${name}`,
      rationale: "Requested by the user",
    }),
  ),
};

describe("useResourceArchitectChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // This hook fixture has no local API. Replace its new recovery endpoint at
    // the HTTP boundary; the Electron restart test uses the real API and disk.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("null", { headers: { "content-type": "application/json" } })));
    // The preview subscription is optional on every other test here: it opens
    // and simply never speaks.
    vi.mocked(openAgentTextStreamAt).mockImplementation(
      () => new Promise(() => {}),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not submit while the displayed composer pair is unresolved", async () => {
    const { result } = renderHook(() => useResourceArchitectChat({ model: null }));

    await act(async () => result.current.submit("I need some contract help"));

    expect(postResourceArchitectTurn).not.toHaveBeenCalled();
    expect(result.current.history).toEqual([]);
  });

  it("keeps the captured default through proposal preparation after the displayed pair changes", async () => {
    type TurnResult = Awaited<ReturnType<typeof postResourceArchitectTurn>>;
    let resolveConversation: (result: TurnResult) => void = () => {
      throw new Error("Conversation response is not pending");
    };
    const conversation = new Promise<TurnResult>((resolve) => { resolveConversation = resolve; });
    vi.mocked(postResourceArchitectTurn)
      .mockReturnValueOnce(conversation)
      .mockResolvedValueOnce({
        jobId: "proposal-1", operation: "proposal", message: "Proposal ready.",
        outcome: plan, warnings: [], meta: testMeta("medium"),
      });
    const initialModel = { provider: "openai", model: "displayed-default" };
    const { result, rerender } = renderHook(({ model }) => useResourceArchitectChat({
      model, modelOrigin: "default",
    }), { initialProps: { model: initialModel } });
    let completion: Promise<void> | undefined;
    act(() => { completion = result.current.submit("Create a contract team"); });
    await waitFor(() => expect(postResourceArchitectTurn).toHaveBeenCalledTimes(1));

    rerender({ model: { provider: "anthropic", model: "changed-default" } });
    // Mutating the original object also must not alter the captured snapshot.
    initialModel.model = "late-mutation";
    await act(async () => {
      resolveConversation({
        jobId: "conversation-1", operation: "conversation", message: "Proposal requested.",
        proposalRequested: true, warnings: [], meta: testMeta("low"),
      });
      await completion;
    });

    const expected = {
      provider: "openai", model: "displayed-default",
      composerSelection: { provider: "openai", model: "displayed-default", origin: "default" },
    };
    expect(postResourceArchitectTurn).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ ...expected, operation: "conversation" }));
    expect(postResourceArchitectTurn).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ ...expected, operation: "proposal" }));
    expect(result.current.pendingPlan).toEqual(plan);
  });

  it("posts the pair a person actually picked", async () => {
    vi.mocked(postResourceArchitectTurn).mockResolvedValue({
      jobId: "conversation-turn",
      operation: "conversation",
      message: "Let us clarify the audience first.",
      warnings: [],
      meta: testMeta("low"),
    });
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      }),
    );

    await act(async () => result.current.submit("I need some contract help"));

    expect(postResourceArchitectTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      }),
    );
  });

  it("keeps ordinary composer submissions conversational and never starts a build", async () => {
    vi.mocked(postResourceArchitectTurn).mockResolvedValue({
      jobId: "conversation-turn",
      operation: "conversation",
      message: "Let us clarify the audience first.",
      warnings: [],
      meta: testMeta("low"),
    });
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
      }),
    );

    await act(async () => result.current.submit("I need some contract help"));

    expect(postResourceArchitectTurn).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "conversation" }),
    );
    expect(result.current.pendingPlan).toBeNull();
    expect(startResourceBuildJob).not.toHaveBeenCalled();
    expect(result.current.history.at(-1)?.text).toBe("Let us clarify the audience first.");
  });

  it("chains one proposal turn when the Architect requests proposal preparation", async () => {
    vi.mocked(postResourceArchitectTurn)
      .mockResolvedValueOnce({
        jobId: "turn-1",
        operation: "conversation",
        message: "I have enough information for a proposal.",
        warnings: [],
        meta: testMeta("low"),
      })
      .mockResolvedValueOnce({
        jobId: "turn-2",
        operation: "conversation",
        message: "Understood — preparing the proposal for your review.",
        warnings: [],
        proposalRequested: true,
        meta: testMeta("low"),
      })
      .mockResolvedValueOnce({
        jobId: "proposal-1",
        operation: "proposal",
        message: "Proposal ready for review.",
        outcome: plan,
        warnings: [],
        meta: testMeta("medium"),
      });
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
      }),
    );

    await act(async () => result.current.submit("Create the other three lawyers"));
    await act(async () => result.current.submit("build it"));

    expect(postResourceArchitectTurn).toHaveBeenCalledTimes(3);
    const calls = vi.mocked(postResourceArchitectTurn).mock.calls;
    expect(calls[0]![0].operation).toBe("conversation");
    expect(calls[1]![0].operation).toBe("conversation");
    expect(calls[2]![0].operation).toBe("proposal");
    expect(calls[2]![0].history.map((turn) => [turn.role, turn.text])).toEqual([
      ["user", "Create the other three lawyers"],
      ["assistant", "I have enough information for a proposal."],
      ["user", "build it"],
      ["assistant", "Understood — preparing the proposal for your review."],
    ]);
    expect(result.current.pendingPlan).toEqual(plan);
    expect(startResourceBuildJob).not.toHaveBeenCalled();
    expect(result.current.submitting).toBe(false);
  });

  it("keeps submitting continuous and cancellable across the chained proposal", async () => {
    type TurnResult = Awaited<ReturnType<typeof postResourceArchitectTurn>>;
    let resolveProposal!: (value: TurnResult) => void;
    vi.mocked(postResourceArchitectTurn)
      .mockResolvedValueOnce({
        jobId: "turn-1",
        operation: "conversation",
        message: "Understood — preparing the proposal for your review.",
        warnings: [],
        proposalRequested: true,
        meta: testMeta("low"),
      })
      .mockReturnValueOnce(
        new Promise<TurnResult>((resolve) => {
          resolveProposal = resolve;
        }),
      );
    vi.mocked(cancelAgentJob).mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
      }),
    );

    let submitPromise!: Promise<void>;
    act(() => {
      submitPromise = result.current.submit("build it");
    });
    await waitFor(() => expect(postResourceArchitectTurn).toHaveBeenCalledTimes(2));
    expect(result.current.submitting).toBe(true);

    await act(async () => result.current.stop());
    expect(cancelAgentJob).toHaveBeenCalledTimes(1);
    expect(result.current.submitting).toBe(false);

    await act(async () => {
      resolveProposal({
        jobId: "proposal-1",
        operation: "proposal",
        message: "Proposal ready for review.",
        outcome: plan,
        warnings: [],
        meta: testMeta("medium"),
      });
      await submitPromise;
    });

    expect(result.current.pendingPlan).toBeNull();
    expect(result.current.submitting).toBe(false);
    expect(startResourceBuildJob).not.toHaveBeenCalled();
  });

  it("prepares a proposal separately and waits for explicit build confirmation", async () => {
    vi.mocked(postResourceArchitectTurn)
      .mockResolvedValueOnce({
        jobId: "conversation-before-proposal",
        operation: "conversation",
        message: "I have enough information for a proposal.",
        warnings: [],
        meta: testMeta("low"),
      })
      .mockResolvedValueOnce({
        jobId: "conversation-proposal-request",
        operation: "conversation",
        message: "Understood — preparing the proposal for your review.",
        warnings: [],
        proposalRequested: true,
        meta: testMeta("low"),
      })
      .mockResolvedValueOnce({
        jobId: "proposal-turn",
        operation: "proposal",
        message: "Review this proposal.",
        outcome: plan,
        warnings: [],
        meta: testMeta("medium"),
      });
    vi.mocked(startResourceBuildJob).mockResolvedValue({
      jobId: "build-after-confirmation",
      cancelled: true,
    });
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
      }),
    );

    await act(async () => result.current.submit("Create a contract reviewer"));
    await act(async () => result.current.submit("build it"));

    expect(postResourceArchitectTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: "proposal" }),
    );
    expect(result.current.pendingPlan).toEqual(plan);
    expect(startResourceBuildJob).not.toHaveBeenCalled();

    await act(async () => result.current.createPlan());
    expect(startResourceBuildJob).toHaveBeenCalledWith(
      expect.objectContaining({ planId: plan.id }),
    );
  });

  it("publishes proposed names before explicit build completion and selects the terminal resource", async () => {
    let finishBuild!: (value: { jobId: string; job: ResourceBuildJobSnapshot }) => void;
    const pendingBuild = new Promise<{ jobId: string; job: ResourceBuildJobSnapshot }>(
      (resolve) => {
        finishBuild = resolve;
      },
    );
    vi.mocked(postResourceArchitectTurn)
      .mockResolvedValueOnce({
        jobId: "turn-1",
        operation: "conversation",
        message: "I have enough information for a proposal.",
        warnings: [],
        meta: testMeta("low"),
      })
      .mockResolvedValueOnce({
        jobId: "turn-2",
        operation: "conversation",
        message: "Understood — preparing the proposal for your review.",
        warnings: [],
        proposalRequested: true,
        meta: testMeta("low"),
      })
      .mockResolvedValueOnce({
        jobId: "proposal-1",
        operation: "proposal",
        message: "Review these three Agents.",
        outcome: plan,
        warnings: [],
        meta: testMeta("medium"),
      });
    vi.mocked(startResourceBuildJob).mockReturnValue(pendingBuild);
    const onSelectResource = vi.fn();
    const onResourcesChanged = vi.fn();
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
        onSelectResource,
        onResourcesChanged,
      }),
    );
    const initialDraftId = result.current.draftId;

    await act(async () => result.current.submit("Create the other three lawyers"));
    await act(async () => result.current.submit("build it"));

    await waitFor(() => {
      expect(result.current.pendingPlan).toEqual(plan);
    });
    expect(startResourceBuildJob).not.toHaveBeenCalled();
    expect(onSelectResource).not.toHaveBeenCalled();

    let buildPromise!: Promise<void>;
    act(() => {
      buildPromise = result.current.createPlan();
    });
    expect(startResourceBuildJob).toHaveBeenCalledWith(
      expect.objectContaining({ planId: "plan-1", draftId: initialDraftId }),
    );

    const completed: ResourceBuildJobSnapshot = {
      jobId: "build-1",
      planId: plan.id,
      status: "completed",
      items: plan.agents.map((agent, planIndex) => ({
        plannedResource: { kind: "agent", id: agent.name },
        resource: { kind: "agent", id: agent.name },
        planIndex,
        status: "created",
      })),
      selectedResource: { kind: "agent", id: plan.agents[0]!.name },
      events: [],
    };
    finishBuild({ jobId: completed.jobId, job: completed });
    await act(async () => buildPromise);

    expect(onResourcesChanged).toHaveBeenCalledTimes(1);
    expect(onSelectResource).toHaveBeenCalledWith(completed.selectedResource);
    expect(result.current.draftId).not.toBe(initialDraftId);
  });

  it("closes the transcript with the Architect's word once Agents are built", async () => {
    const completed: ResourceBuildJobSnapshot = {
      jobId: "build-agent-completion",
      planId: plan.id,
      status: "completed",
      items: plan.agents.map((agent, planIndex) => ({
        plannedResource: { kind: "agent", id: agent.name },
        resource: { kind: "agent", id: agent.name },
        planIndex,
        status: "created",
      })),
      selectedResource: { kind: "agent", id: plan.agents[0]!.name },
      events: [],
    };
    vi.mocked(startResourceBuildJob).mockResolvedValue({
      jobId: completed.jobId,
      job: completed,
    });
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
      }),
    );

    await act(async () => result.current.createPlan(plan));

    expect(result.current.history.at(-1)).toEqual(
      expect.objectContaining({
        role: "assistant",
        text:
          "Done — 3 Agents are ready: `michigan-contract-lawyer`, " +
          "`commercial-risk-lawyer`, `drafting-lawyer`. You will find them in the " +
          "Agents list in the left sidebar.",
      }),
    );
  });

  it("names the built Team and its roster composition in the closing word", async () => {
    const teamPlan = {
      id: "plan-team-completion",
      kind: "team" as const,
      team: {
        teamId: "contract-review-team",
        description: "Reviews contracts.",
        tags: [],
        existingAgents: [],
        newAgents: [],
        questionsResolved: [],
      },
    };
    const completed: ResourceBuildJobSnapshot = {
      jobId: "build-team-completion",
      planId: teamPlan.id,
      status: "completed",
      items: [{
        plannedResource: { kind: "team", id: "contract-review-team" },
        resource: { kind: "team", id: "contract-review-team" },
        planIndex: 0,
        status: "created",
      }],
      selectedResource: { kind: "team", id: "contract-review-team" },
      events: [
        { id: 1, type: "team_created", message: "Created Team shell." },
        {
          id: 2,
          type: "agent_reused",
          plannedResource: { kind: "agent", id: "pragmatist" },
          message: "Reused Agent.",
        },
        {
          id: 3,
          type: "agent_added",
          plannedResource: { kind: "agent", id: "pragmatist" },
          message: "Added Agent.",
        },
        {
          id: 4,
          type: "agent_created",
          plannedResource: { kind: "agent", id: "contract-lead" },
          message: "Created Agent.",
        },
        {
          id: 5,
          type: "agent_added",
          plannedResource: { kind: "agent", id: "contract-lead" },
          message: "Added Agent.",
        },
      ],
    };
    vi.mocked(startResourceBuildJob).mockResolvedValue({
      jobId: completed.jobId,
      job: completed,
    });
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
      }),
    );

    await act(async () => result.current.createPlan(teamPlan));

    expect(result.current.history.at(-1)).toEqual(
      expect.objectContaining({
        role: "assistant",
        text:
          "Done — Team `contract-review-team` is ready. Its roster holds 2 Agents " +
          "(1 created, 1 reused). You will find it in the Teams list in the left sidebar.",
      }),
    );
  });

  it("clears the optimistic planned snapshot when build startup fails", async () => {
    vi.mocked(startResourceBuildJob).mockRejectedValue(new Error("build start failed"));
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
      }),
    );

    await act(async () => result.current.createPlan(plan));

    expect(result.current.buildJob).toBeNull();
    expect(result.current.error).toBe("build start failed");
    expect(result.current.submitting).toBe(false);
  });

  it("clears the optimistic planned snapshot when build startup is cancelled", async () => {
    vi.mocked(startResourceBuildJob).mockResolvedValue({
      jobId: "cancelled-build",
      cancelled: true,
    });
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
      }),
    );

    await act(async () => result.current.createPlan(plan));

    expect(result.current.buildJob).toBeNull();
    expect(result.current.submitting).toBe(false);
  });

  it("refreshes the terminal resource snapshot after stopping an active build", async () => {
    const running: ResourceBuildJobSnapshot = {
      jobId: "build-1",
      planId: plan.id,
      status: "running",
      items: [{
        plannedResource: { kind: "agent", id: plan.agents[0]!.name },
        planIndex: 0,
        status: "generating",
      }],
      selectedResource: null,
      events: [],
    };
    const cancelled: ResourceBuildJobSnapshot = {
      ...running,
      status: "cancelled",
      items: [{ ...running.items[0]!, status: "cancelled" }],
      events: [{ id: 1, type: "build_cancelled", message: "Build cancelled." }],
    };
    vi.mocked(startResourceBuildJob).mockResolvedValue({
      jobId: running.jobId,
      job: running,
    });
    vi.mocked(cancelAgentJob).mockResolvedValue(undefined);
    vi.mocked(readResourceBuildJob).mockResolvedValue(cancelled);
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
      }),
    );

    await act(async () => result.current.createPlan(plan));
    await act(async () => result.current.stop());

    expect(cancelAgentJob).toHaveBeenCalledWith(running.jobId);
    expect(readResourceBuildJob).toHaveBeenCalledWith(running.jobId);
    expect(result.current.buildJob).toEqual(cancelled);
    expect(result.current.submitting).toBe(false);
  });

  it("refreshes the resource sidebar each time a running build publishes a new agent", async () => {
    vi.useFakeTimers();
    const runningWith = (
      events: ResourceBuildJobSnapshot["events"],
    ): ResourceBuildJobSnapshot => ({
      jobId: "build-1",
      planId: plan.id,
      status: "running",
      items: plan.agents.map((agent, planIndex) => ({
        plannedResource: { kind: "agent", id: agent.name },
        planIndex,
        status: "planned",
      })),
      selectedResource: null,
      events,
    });
    const createdEvent = (
      id: number,
      name: string,
    ): ResourceBuildJobSnapshot["events"][number] => ({
      id,
      type: "agent_created",
      plannedResource: { kind: "agent", id: name },
      resource: { kind: "agent", id: name },
      message: `Created ${name}`,
    });
    const firstCreated = runningWith([createdEvent(1, plan.agents[0]!.name)]);
    const secondCreated = runningWith([
      ...firstCreated.events,
      createdEvent(2, plan.agents[1]!.name),
    ]);
    vi.mocked(startResourceBuildJob).mockResolvedValue({
      jobId: "build-1",
      job: runningWith([]),
    });
    vi.mocked(readResourceBuildJob)
      .mockResolvedValueOnce(firstCreated)
      .mockResolvedValueOnce(firstCreated)
      .mockResolvedValue(secondCreated);
    const onResourcesChanged = vi.fn();
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
        onResourcesChanged,
      }),
    );

    await act(async () => result.current.createPlan(plan));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(onResourcesChanged).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(onResourcesChanged).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(onResourcesChanged).toHaveBeenCalledTimes(2);
  });

  it("refreshes the resource sidebar once when the terminal snapshot also publishes an agent", async () => {
    vi.useFakeTimers();
    const items = plan.agents.map((agent, planIndex) => ({
      plannedResource: { kind: "agent" as const, id: agent.name },
      planIndex,
      status: "planned" as const,
    }));
    const running: ResourceBuildJobSnapshot = {
      jobId: "build-1",
      planId: plan.id,
      status: "running",
      items,
      selectedResource: null,
      events: [],
    };
    const completed: ResourceBuildJobSnapshot = {
      ...running,
      status: "completed",
      selectedResource: { kind: "agent", id: plan.agents[0]!.name },
      events: [
        {
          id: 1,
          type: "agent_created",
          plannedResource: { kind: "agent", id: plan.agents[0]!.name },
          resource: { kind: "agent", id: plan.agents[0]!.name },
          message: `Created ${plan.agents[0]!.name}`,
        },
        { id: 2, type: "build_completed", message: "Finished creating all planned Agents." },
      ],
    };
    vi.mocked(startResourceBuildJob).mockResolvedValue({
      jobId: running.jobId,
      job: running,
    });
    vi.mocked(readResourceBuildJob).mockResolvedValue(completed);
    const onResourcesChanged = vi.fn();
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
        onResourcesChanged,
      }),
    );

    await act(async () => result.current.createPlan(plan));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.buildJob).toEqual(completed);
    expect(onResourcesChanged).toHaveBeenCalledTimes(1);
  });

  it("keeps polling a running build when a mid-build sidebar refresh fails", async () => {
    vi.useFakeTimers();
    const runningWith = (
      events: ResourceBuildJobSnapshot["events"],
    ): ResourceBuildJobSnapshot => ({
      jobId: "build-1",
      planId: plan.id,
      status: "running",
      items: plan.agents.map((agent, planIndex) => ({
        plannedResource: { kind: "agent", id: agent.name },
        planIndex,
        status: "planned",
      })),
      selectedResource: null,
      events,
    });
    const created = runningWith([{
      id: 1,
      type: "agent_created",
      plannedResource: { kind: "agent", id: plan.agents[0]!.name },
      resource: { kind: "agent", id: plan.agents[0]!.name },
      message: `Created ${plan.agents[0]!.name}`,
    }]);
    vi.mocked(startResourceBuildJob).mockResolvedValue({
      jobId: "build-1",
      job: runningWith([]),
    });
    vi.mocked(readResourceBuildJob).mockResolvedValue(created);
    const onResourcesChanged = vi.fn(() => Promise.reject(new Error("sidebar offline")));
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
        onResourcesChanged,
      }),
    );

    await act(async () => result.current.createPlan(plan));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(onResourcesChanged).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(readResourceBuildJob).toHaveBeenCalledTimes(2);
    expect(result.current.submitting).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("refreshes the resource sidebar when a running build publishes a team", async () => {
    vi.useFakeTimers();
    const running: ResourceBuildJobSnapshot = {
      jobId: "team-build-1",
      planId: plan.id,
      status: "running",
      items: [{
        plannedResource: { kind: "team", id: "michigan-legal-team" },
        planIndex: 0,
        status: "planned",
      }],
      selectedResource: null,
      events: [{
        id: 1,
        type: "team_created",
        plannedResource: { kind: "team", id: "michigan-legal-team" },
        resource: { kind: "team", id: "michigan-legal-team" },
        message: "Created michigan-legal-team",
      }],
    };
    vi.mocked(startResourceBuildJob).mockResolvedValue({
      jobId: running.jobId,
      job: { ...running, events: [] },
    });
    vi.mocked(readResourceBuildJob).mockResolvedValue(running);
    const onResourcesChanged = vi.fn();
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
        onResourcesChanged,
      }),
    );

    await act(async () => result.current.createPlan(plan));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(onResourcesChanged).toHaveBeenCalledTimes(1);
  });

  it("reconciles a stalled active job through the list endpoint while single-job polling stays running", async () => {
    vi.useFakeTimers();
    const running: ResourceBuildJobSnapshot = {
      jobId: "restarted-build",
      planId: plan.id,
      status: "running",
      items: [{
        plannedResource: { kind: "agent", id: plan.agents[0]!.name },
        planIndex: 0,
        status: "generating",
      }],
      selectedResource: null,
      events: [],
    };
    const recovered: ResourceBuildJobSnapshot = {
      ...running,
      status: "failed",
      items: [{
        ...running.items[0]!,
        status: "failed",
        error: "Resource build was interrupted by an API restart.",
      }],
      error: "Resource build was interrupted by an API restart.",
    };
    vi.mocked(startResourceBuildJob).mockResolvedValue({
      jobId: running.jobId,
      job: running,
    });
    vi.mocked(readResourceBuildJob).mockResolvedValue(running);
    vi.mocked(listResourceBuildJobs).mockResolvedValue([]);
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
      }),
    );

    await act(async () => result.current.createPlan(plan));
    vi.mocked(listResourceBuildJobs).mockResolvedValue([recovered]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(listResourceBuildJobs).toHaveBeenCalled();
    expect(result.current.buildJob).toEqual(recovered);
    expect(result.current.submitting).toBe(false);
  });

  it("clears a half-written reply the moment Stop is pressed, before the cancel answers", async () => {
    // The turn is still generating and the cancel never answers: a hung or
    // merely slow parent must not be able to leave partial text on screen.
    let deliver: ((delivery: AgentTextStreamDelivery) => void) | undefined;
    let streamSignal: AbortSignal | undefined;
    vi.mocked(openAgentTextStreamAt).mockImplementation(async (options) => {
      deliver = options.onDelivery;
      streamSignal = options.signal;
      await new Promise(() => {});
    });
    vi.mocked(postResourceArchitectTurn).mockImplementation(
      () => new Promise(() => {}),
    );
    vi.mocked(cancelAgentJob).mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
      }),
    );

    void act(() => {
      void result.current.submit("Design me a reviewer");
    });
    await waitFor(() => expect(deliver).toBeDefined());
    act(() => {
      deliver?.({
        type: "delta",
        replyId: "assistant:0",
        channel: "text",
        text: "Half an ans",
        channelId: "channel",
        cursor: 0,
      });
    });
    await waitFor(() =>
      expect(result.current.streamedTurn.replies.at(0)?.text).toBe("Half an ans"),
    );

    void act(() => {
      void result.current.stop();
    });

    // Nothing here waits on the cancel: the preview is gone and the
    // subscription is aborted as soon as Stop is pressed.
    await waitFor(() => expect(result.current.streamedTurn.replies).toHaveLength(0));
    expect(streamSignal?.aborted).toBe(true);
  });

  it("shows an update proposal without starting any build until it is applied", async () => {
    vi.mocked(postResourceArchitectTurn).mockResolvedValue({
      jobId: "proposal-update",
      operation: "proposal",
      message: "I will add two Agents to contract-review-team.",
      outcome: updatePlan,
      warnings: [],
      meta: testMeta("medium"),
    });
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
      }),
    );

    await act(async () =>
      result.current.submit("Add scoping-lawyer to contract-review-team"),
    );

    expect(result.current.pendingPlan).toEqual(updatePlan);
    expect(startResourceBuildJob).not.toHaveBeenCalled();
  });

  it("starts exactly one stored-plan build when the user applies the update", async () => {
    vi.mocked(startResourceBuildJob).mockResolvedValue({
      jobId: "update-job",
      job: runningUpdateJob,
    });
    vi.mocked(readResourceBuildJob).mockResolvedValue(runningUpdateJob);
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
      }),
    );

    await act(async () => result.current.createPlan(updatePlan));

    expect(startResourceBuildJob).toHaveBeenCalledTimes(1);
    expect(startResourceBuildJob).toHaveBeenCalledWith(
      expect.objectContaining({ planId: updatePlan.id }),
    );
  });

  it("closes a finished update with update wording and selects the updated Team", async () => {
    const onSelectResource = vi.fn();
    vi.mocked(startResourceBuildJob).mockResolvedValue({
      jobId: "update-job",
      job: completedUpdateJob,
    });
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
        onSelectResource,
      }),
    );

    await act(async () => result.current.createPlan(updatePlan));

    const closing = result.current.history.at(-1)?.text ?? "";
    expect(closing).toContain("contract-review-team");
    expect(closing).toMatch(/updated/i);
    expect(closing).not.toMatch(/\bcreated\b/i);
    expect(onSelectResource).toHaveBeenCalledWith({
      kind: "team",
      id: "contract-review-team",
    });
  });

  /**
   * One plan may add the same library Agent to two Teams. Those are two
   * memberships, and the closing line has to say so rather than collapsing
   * them into one because the Agent shares a name with itself.
   */
  it("counts one Agent added to two Teams as two roster additions", async () => {
    vi.mocked(startResourceBuildJob).mockResolvedValue({
      jobId: "update-job",
      job: twoTeamUpdateJob,
    });
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
      }),
    );

    await act(async () => result.current.createPlan(twoTeamUpdatePlan));

    expect(result.current.history.at(-1)?.text ?? "").toContain("2 Agents are now on the roster");
  });

  /**
   * A retry replays the operation, so the same membership can be reported
   * twice. It is still one membership.
   */
  it("counts a repeated event for one operation once", async () => {
    vi.mocked(startResourceBuildJob).mockResolvedValue({
      jobId: "update-job",
      job: {
        ...completedUpdateJob,
        events: [
          ...completedUpdateJob.events,
          {
            id: 5,
            type: "agent_added",
            plannedResource: { kind: "team", id: "contract-review-team" },
            resource: { kind: "agent", id: "scoping-lawyer" },
            planIndex: 0,
            message: "Added `scoping-lawyer` to `contract-review-team`.",
          },
        ],
      },
    });
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
      }),
    );

    await act(async () => result.current.createPlan(updatePlan));

    expect(result.current.history.at(-1)?.text ?? "").toContain("2 Agents are now on the roster");
  });

  it("closes an Agent skill update without mentioning rosters or the Teams list", async () => {
    const onSelectResource = vi.fn();
    vi.mocked(startResourceBuildJob).mockResolvedValue({
      jobId: "skill-job",
      job: completedSkillUpdateJob,
    });
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
        onSelectResource,
      }),
    );

    await act(async () => result.current.createPlan(skillUpdatePlan));

    const closing = result.current.history.at(-1)?.text ?? "";
    expect(closing).toContain("michigan-contract-lawyer");
    expect(closing).toMatch(/Agent/);
    expect(closing).toMatch(/updated/i);
    expect(closing).not.toMatch(/roster/i);
    expect(closing).not.toMatch(/Teams list/i);
    expect(closing).not.toMatch(/\bTeam\b/);
    expect(onSelectResource).toHaveBeenCalledWith({
      kind: "agent",
      id: "michigan-contract-lawyer",
    });
  });

  it("names both kinds of target when one plan updated a Team and an Agent", async () => {
    vi.mocked(startResourceBuildJob).mockResolvedValue({
      jobId: "mixed-job",
      job: completedMixedUpdateJob,
    });
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
      }),
    );

    await act(async () => result.current.createPlan(mixedUpdatePlan));

    const closing = result.current.history.at(-1)?.text ?? "";
    expect(closing).toContain("contract-review-team");
    expect(closing).toContain("michigan-contract-lawyer");
    expect(closing).toMatch(/Team/);
    expect(closing).toMatch(/Agent/);
  });

  /**
   * A revision conflict cannot succeed by retrying the same stored plan: the
   * revision it was authorized against is gone. Offering Retry would send the
   * user round a loop that can only fail.
   */
  it("tells the user a stale conflict needs a fresh proposal instead of a retry", async () => {
    vi.mocked(startResourceBuildJob).mockResolvedValue({
      jobId: "conflict-job",
      job: partialConflictUpdateJob,
    });
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
      }),
    );

    await act(async () => result.current.createPlan(twoTeamUpdatePlan));

    const closing = result.current.history.at(-1)?.text ?? "";
    expect(closing).toMatch(/fresh proposal/i);
    expect(closing).not.toMatch(/Use Retry/i);
  });

  it("tells the user an unusable Agent name needs a fresh proposal too", async () => {
    vi.mocked(startResourceBuildJob).mockResolvedValue({
      jobId: "needs-input-job",
      job: partialNeedsInputUpdateJob,
    });
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
      }),
    );

    await act(async () => result.current.createPlan(twoTeamUpdatePlan));

    const closing = result.current.history.at(-1)?.text ?? "";
    expect(closing).toMatch(/fresh proposal/i);
    expect(closing).not.toMatch(/Use Retry/i);
    // Nothing conflicted, so the line must not blame a revision.
    expect(closing).not.toMatch(/revision/i);
    // The builder raises needs-input for any Agent it cannot draft, so the
    // line must not name one cause as though it were the only one.
    expect(closing).not.toMatch(/under that name/i);
  });

  it("still offers Retry when the remaining failure is recoverable", async () => {
    vi.mocked(startResourceBuildJob).mockResolvedValue({
      jobId: "partial-job",
      job: partialRecoverableUpdateJob,
    });
    const { result } = renderHook(() =>
      useResourceArchitectChat({
        model: { provider: "openai", model: "test-model" },
      }),
    );

    await act(async () => result.current.createPlan(twoTeamUpdatePlan));

    const closing = result.current.history.at(-1)?.text ?? "";
    expect(closing).toMatch(/Use Retry/i);
    expect(closing).not.toMatch(/fresh proposal/i);
  });

  // A build that stopped while Create was closed still has work the user can
  // finish. Reopening puts its card back, drawn from the plan the server still
  // holds rather than from anything the page remembered.
  it("restores the card for a build that stopped while Create was closed", async () => {
    const teamPlan = {
      id: "plan-team",
      kind: "team" as const,
      team: {
        teamId: "contract-review-team",
        description: "Reviews contracts.",
        tags: [] as string[],
        existingAgents: [
          { name: "risk-lead", role: "Lead", rationale: "Already available." },
        ],
        newAgents: [],
        questionsResolved: [] as string[],
      },
    };
    const stopped: ResourceBuildJobSnapshot = {
      jobId: "job-stopped",
      planId: "plan-team",
      admittedRevision: "sha256:admitted",
      startedAt: "2026-09-13T10:00:00.000Z",
      status: "interrupted",
      items: [{
        plannedResource: { kind: "team", id: "contract-review-team" },
        resource: { kind: "team", id: "contract-review-team" },
        planIndex: 0,
        status: "interrupted",
      }],
      selectedResource: null,
      events: [],
      error: "Resource build was interrupted by an API restart. Retry the build to continue.",
    };
    vi.mocked(listResourceBuildJobs).mockResolvedValue([stopped]);
    vi.mocked(readTeamShape).mockResolvedValue({
      planId: "plan-team",
      revision: "sha256:admitted",
      plan: teamPlan,
      admitted: { jobId: "job-stopped", revision: "sha256:admitted" },
    });

    const { result } = renderHook(() => useResourceArchitectChat({ model: { provider: "openai", model: "test-model" }, modelOrigin: "default" }));

    await waitFor(() => {
      expect(result.current.pendingPlan).toMatchObject({ id: "plan-team" });
    });
    expect(result.current.buildJob?.jobId).toBe("job-stopped");
    // This plan has already been built against, so its shape is settled.
    expect(result.current.planAdmitted).toEqual({
      jobId: "job-stopped",
      revision: "sha256:admitted",
    });
    expect(result.current.canChangeShape).toBe(false);
    // Still unfinished work, so it stays mounted across workspace navigation,
    // and the reason it stopped is said where the user reads errors.
    expect(result.current.retainOnNavigation).toBe(true);
    expect(result.current.error).toBe(
      "Resource build was interrupted by an API restart. Retry the build to continue.",
    );
  });

  it.each(["failed", "cancelled"] as const)(
    "a %s build releases navigation retention while its card stays on the current screen",
    async (status) => {
      vi.mocked(postResourceArchitectTurn).mockResolvedValue({
        jobId: "turn-1",
        operation: "proposal",
        message: "Proposal ready for review.",
        outcome: plan,
        warnings: [],
        meta: testMeta("medium"),
      });
      vi.mocked(readTeamShape).mockResolvedValue({ planId: plan.id, revision: "sha256:one", plan });
      vi.mocked(startResourceBuildJob).mockResolvedValue({
        jobId: "job-ended",
        job: {
          jobId: "job-ended",
          planId: plan.id,
          startedAt: "2026-09-13T12:00:00.000Z",
          status,
          items: [{
            plannedResource: { kind: "agent", id: plan.agents[0]!.name },
            planIndex: 0,
            status,
          }],
          selectedResource: null,
          events: [],
        },
      });
      const { result } = renderHook(() => useResourceArchitectChat({ model: { provider: "openai", model: "test-model" } }));
      await act(async () => {
        await result.current.submit("Create a contract reviewer");
      });
      expect(result.current.retainOnNavigation).toBe(true);

      await act(async () => result.current.createPlan(plan));

      // Readable now, with its Retry, but not carried to the next Create.
      expect(result.current.retainOnNavigation).toBe(false);
      expect(result.current.buildJob?.status).toBe(status);
      expect(result.current.pendingPlan).toMatchObject({ id: plan.id });
    },
  );

  it("a message after a failed build keeps Create mounted while it runs, then lets the failed card go with navigation", async () => {
    type TurnResult = Awaited<ReturnType<typeof postResourceArchitectTurn>>;
    let answerFollowUp: (result: TurnResult) => void = () => {
      throw new Error("The follow-up reply is not pending");
    };
    let followUpStarted: () => void = () => {};
    const followUpPosted = new Promise<void>((resolve) => { followUpStarted = resolve; });
    vi.mocked(postResourceArchitectTurn)
      .mockResolvedValueOnce({
        jobId: "turn-1", operation: "proposal", message: "Proposal ready for review.",
        outcome: plan, warnings: [], meta: testMeta("medium"),
      })
      .mockImplementationOnce(() => {
        followUpStarted();
        return new Promise<TurnResult>((resolve) => { answerFollowUp = resolve; });
      });
    vi.mocked(readTeamShape).mockResolvedValue({ planId: plan.id, revision: "sha256:one", plan });
    vi.mocked(startResourceBuildJob).mockResolvedValue({
      jobId: "job-failed",
      job: {
        jobId: "job-failed", planId: plan.id, startedAt: "2026-09-13T12:00:00.000Z", status: "failed",
        items: [{ plannedResource: { kind: "agent", id: plan.agents[0]!.name }, planIndex: 0, status: "failed" }],
        selectedResource: null, events: [], error: "The skill author did not answer.",
      },
    });
    const { result } = renderHook(() => useResourceArchitectChat({ model: { provider: "openai", model: "test-model" } }));
    await act(async () => {
      await result.current.submit("Create a contract reviewer");
    });
    await act(async () => result.current.createPlan(plan));
    expect(result.current.retainOnNavigation).toBe(false);

    let followUp: Promise<void> | undefined;
    await act(async () => {
      followUp = result.current.submit("Why did it fail?");
      await followUpPosted;
    });
    // A reply in flight is work in progress, kept across navigation.
    expect(result.current.submitting).toBe(true);
    expect(result.current.retainOnNavigation).toBe(true);

    await act(async () => {
      answerFollowUp({
        jobId: "turn-2", operation: "conversation", message: "The skill author timed out.",
        warnings: [], meta: testMeta("low"),
      });
      await followUp;
    });

    // The failed card and its Retry stay on this screen, but the screen is not
    // kept for the next visit. The conversation itself comes back from disk.
    expect(result.current.buildJob?.status).toBe("failed");
    expect(result.current.history.at(-1)?.text).toBe("The skill author timed out.");
    expect(result.current.retainOnNavigation).toBe(false);
  });

  // Stop ends a reply as surely as an answer does. The failed card stays on
  // this screen, and a stopped reply must not hold it there for the next visit.
  it("stopping a message after a failed build still lets the failed card go with navigation", async () => {
    vi.mocked(cancelAgentJob).mockResolvedValue(undefined);
    const { result, answerFollowUp, followUp } = await failSkillUpdateThenAskWhy();

    await act(async () => result.current.stop());
    await act(async () => {
      // How the server answers a turn that was stopped.
      answerFollowUp({ jobId: "turn-2", operation: "conversation", cancelled: true });
      await followUp();
    });

    expect(result.current.submitting).toBe(false);
    expect(result.current.buildJob?.status).toBe("failed");
    expect(result.current.retainOnNavigation).toBe(false);
  });

  // Retry stays pressable while a reply runs. The build it starts is unfinished
  // work, and the reply landing afterwards must not let it go.
  it("a build retried while a message runs stays mounted after the reply lands", async () => {
    vi.mocked(retryResourceBuildJob).mockResolvedValue({
      jobId: "skill-job-retried",
      job: {
        jobId: "skill-job-retried",
        planId: skillUpdatePlan.id,
        startedAt: "2026-09-13T12:10:00.000Z",
        status: "running",
        items: [{
          plannedResource: { kind: "agent", id: "michigan-contract-lawyer" },
          planIndex: 0,
          status: "generating",
        }],
        selectedResource: null,
        events: [],
      },
    });
    // Every later read of the retried build finds it still running.
    vi.mocked(readResourceBuildJob).mockImplementation(() => new Promise(() => {}));
    const { result, answerFollowUp, followUp } = await failSkillUpdateThenAskWhy();

    await act(async () => result.current.retry());
    expect(result.current.buildJob?.status).toBe("running");
    expect(result.current.retainOnNavigation).toBe(true);

    await act(async () => {
      answerFollowUp({
        jobId: "turn-2", operation: "conversation", message: "The skill author timed out.",
        warnings: [], meta: testMeta("low"),
      });
      await followUp();
    });

    expect(result.current.buildJob?.status).toBe("running");
    expect(result.current.retainOnNavigation).toBe(true);
  });

  it("reopens a conversation that went on after its build ended with its messages, not the ended card", async () => {
    const saved = {
      schemaVersion: 1,
      draftId: "draft-after-failure",
      history: [
        { role: "user", text: "Create a contract reviewer", createdAt: "2026-09-13T11:00:00.000Z" },
        { role: "assistant", text: "Proposal ready for review.", createdAt: "2026-09-13T11:00:01.000Z" },
        { role: "user", text: "Why did it fail?", createdAt: "2026-09-13T12:05:00.000Z" },
        { role: "assistant", text: "The skill author timed out.", createdAt: "2026-09-13T12:05:01.000Z" },
      ],
      planId: plan.id,
      // Let go of when the follow-up was admitted.
      buildJobId: null,
      selectedResource: null,
      documentReader: null,
      updatedAt: "2026-09-13T12:05:01.000Z",
      turn: { jobId: "turn-2", operation: "conversation", status: "completed" },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(saved), { headers: { "content-type": "application/json" } })));
    vi.mocked(listResourceBuildJobs).mockResolvedValue([{
      jobId: "job-failed", planId: plan.id, startedAt: "2026-09-13T12:00:00.000Z", status: "failed",
      items: [], selectedResource: null, events: [], error: "The skill author did not answer.",
    }]);
    vi.mocked(readTeamShape).mockResolvedValue({ planId: plan.id, revision: "sha256:one", plan });

    const { result, restored } = renderSettledRestore();
    await restored();

    expect(result.current.history.map((turn) => turn.text)).toEqual(saved.history.map((turn) => turn.text));
    expect(result.current.pendingPlan).toBeNull();
    expect(result.current.buildJob).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("reopening a conversation whose build ended since it was saved shows how it ended, once", async () => {
    // The conversation route saw this build still running; by the time the
    // jobs list reconciled it, every Agent had been published.
    const saved = {
      schemaVersion: 1,
      draftId: "draft-racing",
      history: [{ role: "user", text: "Create a contract reviewer", createdAt: "2026-09-13T11:00:00.000Z" }],
      planId: plan.id,
      buildJobId: "job-finished",
      selectedResource: null,
      documentReader: null,
      updatedAt: "2026-09-13T11:00:01.000Z",
      turn: { jobId: "turn-1", operation: "proposal", status: "completed" },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(saved), { headers: { "content-type": "application/json" } })));
    vi.mocked(listResourceBuildJobs).mockResolvedValue([{
      jobId: "job-finished", planId: plan.id, startedAt: "2026-09-13T12:00:00.000Z", status: "completed",
      items: [{
        plannedResource: { kind: "agent", id: plan.agents[0]!.name },
        resource: { kind: "agent", id: plan.agents[0]!.name },
        planIndex: 0, status: "created",
      }],
      selectedResource: { kind: "agent", id: plan.agents[0]!.name }, events: [],
    }]);
    vi.mocked(readTeamShape).mockResolvedValue({ planId: plan.id, revision: "sha256:one", plan });

    const { result, restored } = renderSettledRestore();
    await restored();

    // The card shows the finished build, so it offers no Apply for a plan that
    // was already built, and the screen is not kept for the next visit.
    await waitFor(() => expect(result.current.pendingPlan).toMatchObject({ id: plan.id }));
    expect(result.current.buildJob?.status).toBe("completed");
    expect(result.current.retainOnNavigation).toBe(false);
  });

  // A conversation can be saved without naming a build its plan still has to
  // finish: a partly finished build hands the next message a fresh draft, and
  // New over an unfinished build restores it without a draft of its own. The
  // plan's newest build decides what comes back, not the conversation's field.
  it.each(["partially_completed", "interrupted"] as const)(
    "reopens a conversation that does not name its plan's %s build with that build and its Retry",
    async (status) => {
      const saved = {
        schemaVersion: 1,
        draftId: "draft-beside-build",
        history: [
          { role: "user", text: "Create a contract reviewer", createdAt: "2026-09-13T11:00:00.000Z" },
          { role: "assistant", text: "Proposal ready for review.", createdAt: "2026-09-13T11:00:01.000Z" },
          { role: "user", text: "What is left to build?", createdAt: "2026-09-13T12:05:00.000Z" },
          { role: "assistant", text: "Two Agents did not finish.", createdAt: "2026-09-13T12:05:01.000Z" },
        ],
        planId: plan.id,
        buildJobId: null,
        selectedResource: null,
        documentReader: null,
        updatedAt: "2026-09-13T12:05:01.000Z",
        turn: { jobId: "turn-2", operation: "conversation", status: "completed" },
      };
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(saved), { headers: { "content-type": "application/json" } })));
      const item = (
        planIndex: number,
        itemStatus: ResourceBuildJobSnapshot["items"][number]["status"],
      ): ResourceBuildJobSnapshot["items"][number] => ({
        plannedResource: { kind: "agent", id: plan.agents[planIndex]?.name ?? "missing-agent" },
        planIndex,
        status: itemStatus,
      });
      vi.mocked(listResourceBuildJobs).mockResolvedValue([{
        jobId: "job-unfinished", planId: plan.id, admittedRevision: "sha256:one",
        startedAt: "2026-09-13T12:00:00.000Z", status,
        // Only the partly finished build published an Agent before it stopped.
        items: [
          item(0, status === "partially_completed" ? "created" : "interrupted"),
          item(1, "interrupted"),
          item(2, "interrupted"),
        ],
        selectedResource: null, events: [],
      }]);
      vi.mocked(readTeamShape).mockResolvedValue({
        planId: plan.id, revision: "sha256:one", plan,
        admitted: { jobId: "job-unfinished", revision: "sha256:one" },
      });
      vi.mocked(retryResourceBuildJob).mockResolvedValue({
        jobId: "job-retried",
        job: {
          jobId: "job-retried", planId: plan.id, admittedRevision: "sha256:one",
          startedAt: "2026-09-13T12:10:00.000Z", status: "running",
          items: [item(0, "generating"), item(1, "generating"), item(2, "generating")],
          selectedResource: null, events: [],
        },
      });
      // Every later read of the retried build finds it still running.
      vi.mocked(readResourceBuildJob).mockImplementation(() => new Promise(() => {}));

      const { result, restored } = renderSettledRestore();
      await restored();

      // The card comes back with the build it was admitted for, so it offers
      // Retry rather than a Create the server would refuse.
      expect(result.current.pendingPlan).toMatchObject({ id: plan.id });
      expect(result.current.buildJob?.jobId).toBe("job-unfinished");
      expect(result.current.retainOnNavigation).toBe(true);

      await act(async () => result.current.retry());

      expect(retryResourceBuildJob).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: "job-unfinished" }),
      );
      expect(result.current.buildJob?.jobId).toBe("job-retried");
    },
  );

  // The draft that followed a partly finished build already saved the build's
  // closing message. Reopening it must not say it again or start yet another
  // draft, or every reload would add one more copy to the saved conversation.
  it("reopens a conversation that moved on past its partly finished build without repeating the build's closing message", async () => {
    const saved = {
      schemaVersion: 1,
      draftId: "draft-after-partial-build",
      history: [
        { role: "user", text: "Create a contract reviewer", createdAt: "2026-09-13T11:00:00.000Z" },
        { role: "assistant", text: "Proposal ready for review.", createdAt: "2026-09-13T11:00:01.000Z" },
        { role: "assistant", text: "The build's closing message, saved with the next draft.", createdAt: "2026-09-13T12:01:00.000Z" },
        { role: "user", text: "What is left to build?", createdAt: "2026-09-13T12:05:00.000Z" },
        { role: "assistant", text: "Two Agents did not finish.", createdAt: "2026-09-13T12:05:01.000Z" },
      ],
      planId: plan.id,
      buildJobId: null,
      selectedResource: null,
      documentReader: null,
      updatedAt: "2026-09-13T12:05:01.000Z",
      turn: { jobId: "turn-2", operation: "conversation", status: "completed" },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(saved), { headers: { "content-type": "application/json" } })));
    vi.mocked(listResourceBuildJobs).mockResolvedValue([{
      jobId: "job-partial", planId: plan.id, admittedRevision: "sha256:one",
      startedAt: "2026-09-13T12:00:00.000Z", status: "partially_completed",
      items: [
        { plannedResource: { kind: "agent", id: plan.agents[0]?.name ?? "missing-agent" }, planIndex: 0, status: "created" },
        { plannedResource: { kind: "agent", id: plan.agents[1]?.name ?? "missing-agent" }, planIndex: 1, status: "interrupted" },
      ],
      selectedResource: null, events: [],
    }]);
    vi.mocked(readTeamShape).mockResolvedValue({
      planId: plan.id, revision: "sha256:one", plan,
      admitted: { jobId: "job-partial", revision: "sha256:one" },
    });

    const { result, restored } = renderSettledRestore();
    await restored();

    expect(result.current.buildJob?.jobId).toBe("job-partial");
    expect(result.current.history.map((turn) => turn.text)).toEqual(saved.history.map((turn) => turn.text));
    expect(result.current.draftId).toBe("draft-after-partial-build");
  });

  it("reopens empty over a newest failed build, even with an older interrupted build behind it", async () => {
    vi.mocked(listResourceBuildJobs).mockResolvedValue([
      {
        jobId: "older-interrupted",
        planId: "plan-older",
        startedAt: "2026-09-13T08:00:00.000Z",
        status: "interrupted",
        items: [],
        selectedResource: null,
        events: [],
        error: "Resource build was interrupted by an API restart. Retry the build to continue.",
      },
      {
        jobId: "newer-failed",
        planId: "plan-newer",
        startedAt: "2026-09-13T09:00:00.000Z",
        status: "failed",
        items: [],
        selectedResource: null,
        events: [],
        error: "The skill author did not answer.",
      },
    ]);
    vi.mocked(readTeamShape).mockImplementation((planId: string) =>
      Promise.resolve({
        planId,
        revision: "sha256:one",
        plan: { id: planId, kind: "standalone_agents", agents: [] },
      }),
    );

    const { result, restored } = renderSettledRestore();
    await restored();

    expect(result.current.pendingPlan).toBeNull();
    expect(result.current.buildJob).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.retainOnNavigation).toBe(false);
  });

  // Which build gets restored is decided by when it was admitted, not by the
  // job id. Ids are random, so their order says nothing — here the newer build
  // has the id that sorts first, and the older one would win on id alone.
  it("restores the build that was admitted most recently, not the first id", async () => {
    const job = (
      jobId: string,
      planId: string,
      startedAt: string,
    ): ResourceBuildJobSnapshot => ({
      jobId,
      planId,
      startedAt,
      status: "interrupted",
      items: [],
      selectedResource: null,
      events: [],
    });
    vi.mocked(listResourceBuildJobs).mockResolvedValue([
      job("0a0e1f2c-0000-4000-8000-000000000001", "plan-older", "2026-09-13T08:00:00.000Z"),
      job("ff9e1f2c-0000-4000-8000-000000000002", "plan-newer", "2026-09-13T11:00:00.000Z"),
    ]);
    vi.mocked(readTeamShape).mockImplementation((planId: string) =>
      Promise.resolve({
        planId,
        revision: "sha256:one",
        plan: { id: planId, kind: "standalone_agents", agents: [] },
      }),
    );

    const { result } = renderHook(() => useResourceArchitectChat({ model: { provider: "openai", model: "test-model" }, modelOrigin: "default" }));

    await waitFor(() => {
      expect(result.current.pendingPlan).toMatchObject({ id: "plan-newer" });
    });
    expect(result.current.buildJob?.planId).toBe("plan-newer");
  });

  // Stopping a build ends it. Its card stayed on the screen where it was
  // stopped; a reopened Create starts clean, and nothing is restarted. The
  // receipt and any Team shell stay on disk.
  it("reopens empty over a cancelled build without restarting it", async () => {
    vi.mocked(listResourceBuildJobs).mockResolvedValue([{
      jobId: "job-cancelled",
      planId: "plan-cancelled",
      startedAt: "2026-09-13T08:00:00.000Z",
      status: "cancelled",
      items: [{
        plannedResource: { kind: "team", id: "stopped-team" },
        resource: { kind: "team", id: "stopped-team" },
        planIndex: 0,
        status: "cancelled",
      }],
      selectedResource: null,
      events: [],
    }]);
    vi.mocked(readTeamShape).mockResolvedValue({
      planId: "plan-cancelled",
      revision: "sha256:one",
      plan: { id: "plan-cancelled", kind: "standalone_agents", agents: [] },
    });

    const { result, restored } = renderSettledRestore();
    await restored();

    expect(result.current.pendingPlan).toBeNull();
    expect(result.current.buildJob).toBeNull();
    // Nothing was restarted, and nothing is waiting.
    expect(result.current.submitting).toBe(false);
    expect(startResourceBuildJob).not.toHaveBeenCalled();
  });

  it("leaves Create empty when a completed build names a Team that no longer exists", async () => {
    const missingTeamJob: ResourceBuildJobSnapshot = {
      jobId: "job-missing-team",
      planId: "plan-missing-team",
      startedAt: "2026-09-17T10:00:00.000Z",
      status: "completed",
      items: [{
        plannedResource: { kind: "team", id: "exampleco-commercialization-team" },
        resource: { kind: "team", id: "exampleco-commercialization-team" },
        planIndex: 0,
        status: "created",
      }],
      selectedResource: { kind: "team", id: "exampleco-commercialization-team" },
      events: [],
    };
    vi.mocked(listResourceBuildJobs).mockResolvedValue([missingTeamJob]);
    vi.mocked(readTeamShape).mockResolvedValue({
      planId: "plan-missing-team",
      revision: "sha256:missing",
      plan: {
        id: "plan-missing-team",
        kind: "team",
        team: {
          teamId: "exampleco-commercialization-team",
          description: "Commercializes ExampleCo.",
          tags: [],
          existingAgents: [],
          newAgents: [],
          questionsResolved: [],
        },
      },
    });
    vi.mocked(listResourceArchitectMetrics).mockResolvedValue([{
      schemaVersion: 1,
      recordedAt: "2026-09-17T09:59:00.000Z",
      jobId: "architect-turn",
      operation: "proposal",
      status: "completed",
      provider: "anthropic",
      model: "claude-opus-4-8",
      selection: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        source: "app-default",
        reason: "agent-default",
        caller: "authoring",
      },
      reasoning: "medium",
      outcomeKind: "team",
      fallback: false,
      timing: testMeta("medium").timing,
    }]);
    const onSelectResource = vi.fn();

    const { result } = renderHook(() =>
      useResourceArchitectChat({ model: { provider: "openai", model: "test-model" }, modelOrigin: "default", onSelectResource }),
    );

    await waitFor(() => expect(listResourceBuildJobs).toHaveBeenCalledOnce());
    await waitFor(() => expect(listResourceArchitectMetrics).toHaveBeenCalledOnce());
    expect(result.current.history).toEqual([]);
    expect(result.current.modelSelections).toEqual([]);
    expect(result.current.pendingPlan).toBeNull();
    expect(result.current.buildJob).toBeNull();
    expect(onSelectResource).not.toHaveBeenCalled();
  });

  // A build the user just started settles the shape as surely as a restored
  // one does. The receipt says which revision it was admitted against, and
  // until the card reads that, it kept offering a change the server refuses.
  it("settles the shape once the build it started has been admitted", async () => {
    const teamPlan = {
      id: "plan-team",
      kind: "team" as const,
      team: {
        teamId: "contract-review-team",
        description: "Reviews contracts.",
        tags: [] as string[],
        existingAgents: [
          { name: "risk-lead", role: "Lead", rationale: "Already available." },
        ],
        newAgents: [],
        questionsResolved: [] as string[],
        shape: {
          kind: "chain" as const,
          rationale: "Sequential.",
          depth: "quick" as const,
          order: ["risk-lead"],
        },
      },
    };
    vi.mocked(postResourceArchitectTurn).mockResolvedValue({
      jobId: "turn-1",
      operation: "proposal",
      message: "Proposal ready for review.",
      outcome: teamPlan,
      warnings: [],
      meta: testMeta("medium"),
    });
    vi.mocked(readTeamShape).mockResolvedValue({
      planId: "plan-team",
      revision: "sha256:admitted",
      plan: teamPlan,
    });
    vi.mocked(startResourceBuildJob).mockResolvedValue({
      jobId: "job-1",
      job: {
        jobId: "job-1",
        planId: "plan-team",
        admittedRevision: "sha256:admitted",
        startedAt: "2026-09-13T12:00:00.000Z",
        status: "failed",
        items: [{
          plannedResource: { kind: "team", id: "contract-review-team" },
          resource: { kind: "team", id: "contract-review-team" },
          planIndex: 0,
          status: "failed",
        }],
        selectedResource: null,
        events: [],
        error: "Provider request failed.",
      },
    });

    const { result } = renderHook(() => useResourceArchitectChat({ model: { provider: "openai", model: "test-model" }, modelOrigin: "default" }));
    await act(async () => {
      await result.current.submit("A contract review team, please.");
    });
    await waitFor(() => expect(result.current.canChangeShape).toBe(true));

    await act(async () => {
      await result.current.createPlan(teamPlan);
    });

    expect(result.current.planAdmitted).toEqual({
      jobId: "job-1",
      revision: "sha256:admitted",
    });
    expect(result.current.canChangeShape).toBe(false);
  });

  // Restoration belongs to opening Create. A parent that hands the hook a new
  // callback re-runs its effects, and a restore that started over at that point
  // captured the generation as it stood — so it no longer saw the conversation
  // the user had already had, and attached an old build to it.
  it("does not restore again when a parent callback changes", async () => {
    vi.mocked(listResourceBuildJobs).mockResolvedValue([{
      jobId: "old-job",
      planId: "plan-old",
      startedAt: "2026-09-13T09:00:00.000Z",
      status: "interrupted",
      items: [],
      selectedResource: null,
      events: [],
    }]);
    vi.mocked(readTeamShape).mockResolvedValue({
      planId: "plan-old",
      revision: "sha256:old",
      plan: { id: "plan-old", kind: "standalone_agents", agents: [] },
    });
    vi.mocked(postResourceArchitectTurn).mockResolvedValue({
      jobId: "turn-1",
      operation: "conversation",
      message: "Who is the audience?",
      warnings: [],
      meta: testMeta("medium"),
    });

    const { result, rerender } = renderHook(
      (props: { onResourcesChanged: () => void }) =>
        useResourceArchitectChat({ model: { provider: "openai", model: "test-model" }, modelOrigin: "default", ...props }),
      { initialProps: { onResourcesChanged: () => {} } },
    );
    await act(async () => {
      await result.current.submit("Two lawyers, please.");
    });
    expect(result.current.pendingPlan).toBeNull();

    // A new callback identity, which is all it takes to re-run the effect.
    await act(async () => {
      rerender({ onResourcesChanged: () => {} });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.pendingPlan).toBeNull();
    expect(result.current.buildJob).toBeNull();
  });

  // React mounts twice in development, and the first mount's cleanup cancels
  // the restore it started. The second mount has to start a replacement — the
  // user has done nothing, so there is nothing to protect.
  it("restores under StrictMode, where the first attempt is cancelled", async () => {
    vi.mocked(listResourceBuildJobs).mockResolvedValue([{
      jobId: "job-cancelled",
      planId: "plan-cancelled",
      startedAt: "2026-09-13T08:00:00.000Z",
      status: "interrupted",
      items: [],
      selectedResource: null,
      events: [],
    }]);
    vi.mocked(readTeamShape).mockResolvedValue({
      planId: "plan-cancelled",
      revision: "sha256:one",
      plan: { id: "plan-cancelled", kind: "standalone_agents", agents: [] },
    });

    const { result } = renderHook(
      () => useResourceArchitectChat({ model: { provider: "openai", model: "test-model" }, modelOrigin: "default" }),
      { wrapper: StrictMode },
    );

    await waitFor(() => {
      expect(result.current.pendingPlan).toMatchObject({ id: "plan-cancelled" });
    });
  });

  // Discarding one attempt throws away what the whole plan built. Falling back
  // to an older attempt of the same plan would put a card back offering to
  // rebuild exactly what the user removed.
  it("restores no attempt of a plan whose build was discarded", async () => {
    // Both attempts are interrupted, a status Create would otherwise restore,
    // so only the discard can be what keeps them off the screen.
    const attempt = (
      jobId: string,
      startedAt: string,
      discarded?: true,
    ): ResourceBuildJobSnapshot => ({
      jobId,
      planId: "plan-discarded",
      startedAt,
      status: "interrupted",
      items: [],
      selectedResource: null,
      events: [],
      ...(discarded ? { discarded } : {}),
    });
    vi.mocked(listResourceBuildJobs).mockResolvedValue([
      attempt("first-attempt", "2026-09-13T08:00:00.000Z"),
      attempt("second-attempt", "2026-09-13T09:00:00.000Z", true),
    ]);
    vi.mocked(readTeamShape).mockResolvedValue({
      planId: "plan-discarded",
      revision: "sha256:one",
      plan: { id: "plan-discarded", kind: "standalone_agents", agents: [] },
    });

    const { result, restored } = renderSettledRestore();
    await restored();

    expect(result.current.pendingPlan).toBeNull();
    expect(result.current.buildJob).toBeNull();
    expect(result.current.retainOnNavigation).toBe(false);
  });

  // The restore is a read that can land late. Work started while it was in
  // flight is newer, and must not be replaced — or interrupted — by the record
  // of a build that already stopped.
  it("does not let a late restore replace a newer proposal", async () => {
    let answerRestore = (): void => {};
    let restoreStarted = (): void => {};
    const restoreHasStarted = new Promise<void>((resolve) => {
      restoreStarted = resolve;
    });
    vi.mocked(listResourceBuildJobs).mockResolvedValue([{
      jobId: "job-old",
      planId: "plan-old",
      startedAt: "2026-09-13T09:00:00.000Z",
      status: "interrupted",
      items: [],
      selectedResource: null,
      events: [],
    }]);
    vi.mocked(readTeamShape).mockImplementation(
      () =>
        new Promise((resolve) => {
          answerRestore = () =>
            resolve({
              planId: "plan-old",
              revision: "sha256:old",
              plan: { id: "plan-old", kind: "standalone_agents", agents: [] },
            });
          // The old read is proven to be in flight before anything newer
          // starts, so this cannot pass by never having begun.
          restoreStarted();
        }),
    );
    vi.mocked(postResourceArchitectTurn).mockResolvedValue({
      jobId: "turn-1",
      operation: "proposal",
      message: "Proposal ready for review.",
      outcome: plan,
      warnings: [],
      meta: testMeta("medium"),
    });

    // The turn is held open, so the late restore arrives while a request is
    // still outstanding and no plan has been displayed yet.
    let answerTurn = (): void => {};
    vi.mocked(postResourceArchitectTurn).mockImplementation(
      () =>
        new Promise((resolve) => {
          answerTurn = () =>
            resolve({
              jobId: "turn-1",
              operation: "proposal",
              message: "Proposal ready for review.",
              outcome: plan,
              warnings: [],
              meta: testMeta("medium"),
            });
        }),
    );

    const { result } = renderHook(() => useResourceArchitectChat({ model: { provider: "openai", model: "test-model" }, modelOrigin: "default" }));
    await act(async () => {
      await restoreHasStarted;
    });

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit("Two lawyers, please.");
      await Promise.resolve();
    });
    expect(result.current.submitting).toBe(true);

    // The older read answers while the new turn is still waiting.
    await act(async () => {
      answerRestore();
      await Promise.resolve();
    });
    expect(result.current.pendingPlan).toBeNull();
    // And it did not clear the state the outstanding turn owns.
    expect(result.current.submitting).toBe(true);

    await act(async () => {
      answerTurn();
      await submitted;
    });
    expect(result.current.pendingPlan).toMatchObject({ id: "plan-1" });
  });

  // The same read, landing after the new work has already finished. Nothing is
  // in flight by then, so "is something running now" is not the question: the
  // read was started before that work existed and is stale either way.
  it("does not let a restore land after newer work has already answered", async () => {
    let answerRestore = (): void => {};
    let restoreStarted = (): void => {};
    const restoreHasStarted = new Promise<void>((resolve) => {
      restoreStarted = resolve;
    });
    vi.mocked(listResourceBuildJobs).mockResolvedValue([{
      jobId: "old-job",
      planId: "plan-old",
      startedAt: "2026-09-13T09:00:00.000Z",
      status: "interrupted",
      items: [],
      selectedResource: null,
      events: [],
    }]);
    vi.mocked(readTeamShape).mockImplementation(
      () =>
        new Promise((resolve) => {
          answerRestore = () =>
            resolve({
              planId: "plan-old",
              revision: "sha256:old",
              plan: { id: "plan-old", kind: "standalone_agents", agents: [] },
            });
          restoreStarted();
        }),
    );
    // A conversational answer, which leaves no plan behind. The card is empty
    // afterwards, and the stale restore must not fill it.
    vi.mocked(postResourceArchitectTurn).mockResolvedValue({
      jobId: "turn-1",
      operation: "conversation",
      message: "Who is the audience?",
      warnings: [],
      meta: testMeta("medium"),
    });

    const { result } = renderHook(() => useResourceArchitectChat({ model: { provider: "openai", model: "test-model" }, modelOrigin: "default" }));
    await act(async () => {
      await restoreHasStarted;
    });

    await act(async () => {
      await result.current.submit("Two lawyers, please.");
    });
    expect(result.current.submitting).toBe(false);

    await act(async () => {
      answerRestore();
      await Promise.resolve();
    });

    expect(result.current.pendingPlan).toBeNull();
    expect(result.current.buildJob).toBeNull();
  });

});

/**
 * Renders the hook and resolves once its opening restoration has settled.
 *
 * The signal is the hook's own `restoring` flag turning false, taken from an
 * effect of the render that shows it, so nothing waits on time or on internal
 * call counts. An effect, not the render itself: renderHook only updates
 * `result.current` once a render commits, and React can run a render before
 * committing it, which let a wait resolved during render read the previous
 * render's values.
 */
function renderSettledRestore() {
  let settle = (): void => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const rendered = renderHook(() => {
    const chat = useResourceArchitectChat({ model: { provider: "openai", model: "test-model" }, modelOrigin: "default" });
    const settledNow = !chat.restoring;
    useEffect(() => {
      if (settledNow) settle();
    }, [settledNow]);
    return chat;
  });
  return {
    ...rendered,
    // React defers rendering inside act(), so the render that carries the
    // signal has to happen outside it. asyncWrapper is Testing Library's hook
    // for running exactly that kind of wait.
    restored: () => getConfig().asyncWrapper(() => settled),
  };
}

/**
 * Fails a skill update of an existing Agent, then asks about it.
 *
 * Resolves once the follow-up has been posted. Its reply is held until the test
 * answers it, so the test decides how the reply ends.
 */
async function failSkillUpdateThenAskWhy() {
  type TurnResult = Awaited<ReturnType<typeof postResourceArchitectTurn>>;
  let answer: (result: TurnResult) => void = () => {
    throw new Error("The follow-up reply is not pending");
  };
  let posted: () => void = () => {};
  const followUpPosted = new Promise<void>((resolve) => { posted = resolve; });
  vi.mocked(postResourceArchitectTurn)
    .mockResolvedValueOnce({
      jobId: "turn-1", operation: "proposal", message: "Update ready for review.",
      outcome: skillUpdatePlan, warnings: [], meta: testMeta("medium"),
    })
    .mockImplementationOnce(() => {
      posted();
      return new Promise<TurnResult>((resolve) => { answer = resolve; });
    });
  vi.mocked(readTeamShape).mockResolvedValue({
    planId: skillUpdatePlan.id, revision: "sha256:one", plan: skillUpdatePlan,
  });
  vi.mocked(startResourceBuildJob).mockResolvedValue({
    jobId: failedSkillUpdateJob.jobId,
    job: failedSkillUpdateJob,
  });
  const rendered = renderHook(() =>
    useResourceArchitectChat({ model: { provider: "openai", model: "test-model" } }));
  await act(async () => {
    await rendered.result.current.submit("Give the lawyer two new skills");
  });
  await act(async () => rendered.result.current.createPlan(skillUpdatePlan));
  expect(rendered.result.current.buildJob?.status).toBe("failed");
  expect(rendered.result.current.retainOnNavigation).toBe(false);

  let followUp: Promise<void> = Promise.resolve();
  await act(async () => {
    followUp = rendered.result.current.submit("Why did it fail?");
    await followUpPosted;
  });
  // A reply in flight is work in progress, kept across navigation.
  expect(rendered.result.current.submitting).toBe(true);
  expect(rendered.result.current.retainOnNavigation).toBe(true);
  return {
    ...rendered,
    answerFollowUp: (result: TurnResult) => answer(result),
    followUp: () => followUp,
  };
}

const updatePlan = {
  id: "update-plan-1",
  kind: "resource_updates" as const,
  operations: [{
    kind: "add_team_agents" as const,
    target: { kind: "team" as const, id: "contract-review-team" },
    expectedRevision: "sha256:abc",
    libraryAgentsToAdd: [{
      name: "scoping-lawyer",
      role: "Scope reviewer",
      tier: "strategic",
      rationale: "Reuse the existing scope specialist.",
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

const runningUpdateJob: ResourceBuildJobSnapshot = {
  jobId: "update-job",
  planId: updatePlan.id,
  status: "running",
  items: [{
    plannedResource: { kind: "team", id: "contract-review-team" },
    planIndex: 0,
    status: "generating",
  }],
  selectedResource: null,
  events: [],
};

const completedUpdateJob: ResourceBuildJobSnapshot = {
  jobId: "update-job",
  planId: updatePlan.id,
  status: "completed",
  items: [{
    plannedResource: { kind: "team", id: "contract-review-team" },
    resource: { kind: "team", id: "contract-review-team" },
    planIndex: 0,
    status: "updated",
  }],
  selectedResource: { kind: "team", id: "contract-review-team" },
  // The shape the update executor emits: the operation is planned against its
  // target, and the Agent an event is about is named in `resource`.
  events: [
    {
      id: 1,
      type: "resource_update_started",
      plannedResource: { kind: "team", id: "contract-review-team" },
      planIndex: 0,
      message: "Updating Team `contract-review-team`.",
    },
    {
      id: 2,
      type: "agent_added",
      plannedResource: { kind: "team", id: "contract-review-team" },
      resource: { kind: "agent", id: "scoping-lawyer" },
      planIndex: 0,
      message: "Added `scoping-lawyer` to `contract-review-team`.",
    },
    {
      id: 3,
      type: "agent_added",
      plannedResource: { kind: "team", id: "contract-review-team" },
      resource: { kind: "agent", id: "drafting-completeness-lawyer" },
      planIndex: 0,
      message: "Added `drafting-completeness-lawyer` to `contract-review-team`.",
    },
    {
      id: 4,
      type: "resource_update_applied",
      plannedResource: { kind: "team", id: "contract-review-team" },
      resource: { kind: "team", id: "contract-review-team" },
      planIndex: 0,
      message: "Updated Team `contract-review-team`.",
    },
  ],
};

const skillUpdatePlan = {
  id: "skill-update-plan-1",
  kind: "resource_updates" as const,
  operations: [{
    kind: "update_agent_skills" as const,
    target: { kind: "agent" as const, id: "michigan-contract-lawyer" },
    expectedRevision: "sha256:def",
    skillUpdates: [
      {
        action: "create" as const,
        name: "termination-clause-review",
        instruction: "Author the termination review.",
      },
      {
        action: "update" as const,
        name: "indemnity-clause-review",
        instruction: "Require a liability cap check.",
      },
    ],
  }],
};

const completedSkillUpdateJob: ResourceBuildJobSnapshot = {
  jobId: "skill-job",
  planId: skillUpdatePlan.id,
  status: "completed",
  items: [{
    plannedResource: { kind: "agent", id: "michigan-contract-lawyer" },
    resource: { kind: "agent", id: "michigan-contract-lawyer" },
    planIndex: 0,
    status: "updated",
  }],
  selectedResource: { kind: "agent", id: "michigan-contract-lawyer" },
  events: [
    {
      id: 1,
      type: "resource_update_started",
      plannedResource: { kind: "agent", id: "michigan-contract-lawyer" },
      planIndex: 0,
      message: "Updating Agent `michigan-contract-lawyer`.",
    },
    {
      id: 2,
      type: "resource_update_applied",
      plannedResource: { kind: "agent", id: "michigan-contract-lawyer" },
      resource: { kind: "agent", id: "michigan-contract-lawyer" },
      planIndex: 0,
      message:
        "Updated 2 skills on Agent `michigan-contract-lawyer`: termination-clause-review, indemnity-clause-review.",
    },
  ],
};

/** A skill update whose author never answered. */
const failedSkillUpdateJob: ResourceBuildJobSnapshot = {
  jobId: "skill-job-failed",
  planId: skillUpdatePlan.id,
  startedAt: "2026-09-13T12:00:00.000Z",
  status: "failed",
  items: [{
    plannedResource: { kind: "agent", id: "michigan-contract-lawyer" },
    planIndex: 0,
    status: "failed",
    error: "The skill author did not answer.",
  }],
  selectedResource: null,
  events: [],
  error: "The skill author did not answer.",
};

const twoTeamUpdatePlan = {
  id: "two-team-update-plan",
  kind: "resource_updates" as const,
  operations: [
    {
      kind: "add_team_agents" as const,
      target: { kind: "team" as const, id: "contract-review-team" },
      expectedRevision: "sha256:abc",
      libraryAgentsToAdd: [{
        name: "scoping-lawyer",
        role: "Scope reviewer",
        tier: "strategic",
        rationale: "Reuse the existing scope specialist.",
      }],
      newAgentsToCreate: [],
    },
    {
      kind: "add_team_agents" as const,
      target: { kind: "team" as const, id: "diligence-team" },
      expectedRevision: "sha256:bcd",
      libraryAgentsToAdd: [{
        name: "scoping-lawyer",
        role: "Scope reviewer",
        tier: "strategic",
        rationale: "The same specialist, on a second Team.",
      }],
      newAgentsToCreate: [],
    },
  ],
};

/** One library Agent joining two Teams: two memberships, not one. */
const twoTeamUpdateJob: ResourceBuildJobSnapshot = {
  jobId: "update-job",
  planId: twoTeamUpdatePlan.id,
  status: "completed",
  items: [
    {
      plannedResource: { kind: "team", id: "contract-review-team" },
      resource: { kind: "team", id: "contract-review-team" },
      planIndex: 0,
      status: "updated",
    },
    {
      plannedResource: { kind: "team", id: "diligence-team" },
      resource: { kind: "team", id: "diligence-team" },
      planIndex: 1,
      status: "updated",
    },
  ],
  selectedResource: { kind: "team", id: "contract-review-team" },
  events: [
    {
      id: 1,
      type: "agent_added",
      plannedResource: { kind: "team", id: "contract-review-team" },
      resource: { kind: "agent", id: "scoping-lawyer" },
      planIndex: 0,
      message: "Added `scoping-lawyer` to `contract-review-team`.",
    },
    {
      id: 2,
      type: "agent_added",
      plannedResource: { kind: "team", id: "diligence-team" },
      resource: { kind: "agent", id: "scoping-lawyer" },
      planIndex: 1,
      message: "Added `scoping-lawyer` to `diligence-team`.",
    },
  ],
};

const mixedUpdatePlan = {
  id: "mixed-update-plan",
  kind: "resource_updates" as const,
  operations: [
    twoTeamUpdatePlan.operations[0]!,
    skillUpdatePlan.operations[0]!,
  ],
};

const completedMixedUpdateJob: ResourceBuildJobSnapshot = {
  jobId: "mixed-job",
  planId: mixedUpdatePlan.id,
  status: "completed",
  items: [
    {
      plannedResource: { kind: "team", id: "contract-review-team" },
      resource: { kind: "team", id: "contract-review-team" },
      planIndex: 0,
      status: "updated",
    },
    {
      plannedResource: { kind: "agent", id: "michigan-contract-lawyer" },
      resource: { kind: "agent", id: "michigan-contract-lawyer" },
      planIndex: 1,
      status: "updated",
    },
  ],
  selectedResource: { kind: "team", id: "contract-review-team" },
  events: [{
    id: 1,
    type: "agent_added",
    plannedResource: { kind: "team", id: "contract-review-team" },
    resource: { kind: "agent", id: "scoping-lawyer" },
    planIndex: 0,
    message: "Added `scoping-lawyer` to `contract-review-team`.",
  }],
};

/** One operation applied, the other refused because the Team moved on. */
const partialConflictUpdateJob: ResourceBuildJobSnapshot = {
  jobId: "conflict-job",
  planId: twoTeamUpdatePlan.id,
  status: "partially_completed",
  items: [
    {
      plannedResource: { kind: "team", id: "contract-review-team" },
      resource: { kind: "team", id: "contract-review-team" },
      planIndex: 0,
      status: "updated",
    },
    {
      plannedResource: { kind: "team", id: "diligence-team" },
      planIndex: 1,
      status: "failed",
      error: "Team 'diligence-team' changed since the update was proposed.",
    },
  ],
  selectedResource: { kind: "team", id: "contract-review-team" },
  events: [{
    id: 1,
    type: "resource_update_conflict",
    plannedResource: { kind: "team", id: "diligence-team" },
    planIndex: 1,
    message: "Could not update `diligence-team`: revision changed.",
  }],
};

/** One operation applied, the other blocked by a name this plan cannot have. */
const partialNeedsInputUpdateJob: ResourceBuildJobSnapshot = {
  ...partialConflictUpdateJob,
  jobId: "needs-input-job",
  events: [{
    id: 1,
    type: "agent_needs_input",
    plannedResource: { kind: "agent", id: "drafting-completeness-lawyer" },
    planIndex: 1,
    message: "Agent `drafting-completeness-lawyer` needs a revised name.",
  }],
};

/** One operation applied, the other failed for a reason a retry can clear. */
const partialRecoverableUpdateJob: ResourceBuildJobSnapshot = {
  ...partialConflictUpdateJob,
  jobId: "partial-job",
  events: [{
    id: 1,
    type: "resource_update_failed",
    plannedResource: { kind: "team", id: "diligence-team" },
    planIndex: 1,
    message: "Could not update `diligence-team`: the Agent provider was unreachable.",
  }],
};

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
