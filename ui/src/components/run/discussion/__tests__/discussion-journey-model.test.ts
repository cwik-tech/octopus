import { describe, expect, it } from "vitest";
import { agentQuestionViewSchema } from '@contracts/agent-questions';

import type { RunEvent } from "@/components/run/stage-renderers";
import type { TaskRunEntry } from "@/components/run/tasks/task-strip";
import { toRunEvent } from "@/components/run/tasks/task-run-model";
import type { WorkflowChatMessage } from "@/lib/utils/workflow-chat-events";
import { buildWorkflowChatMessages } from "@/lib/utils/workflow-chat-events";

import { buildDiscussionJourneyModel } from "../discussion-journey-model";

const task: TaskRunEntry = {
  label: "Clarify, discuss, and write",
  mode: "running",
  runId: "run-1",
  taskId: "task-1",
  workflowId: "clarify-debate-write",
};

const stages = [
  {
    id: "clarify",
    team: "reception-desk",
  },
  {
    id: "discuss",
    team: "problem-thinking-board",
    discussions: [
      {
        levelId: "discussion",
        maxRounds: 2,
        minRounds: 2,
        participants: ["contrarian", "pragmatist"],
      },
    ],
  },
  {
    id: "write",
    team: "writing-team",
  },
];

function message({
  id,
  messageType,
  model,
  name,
  provider,
  round,
}: {
  id: string;
  messageType: "framing" | "position";
  model?: string;
  name: string;
  provider?: string;
  round: number;
}): WorkflowChatMessage {
  return {
    createdAt: `2026-07-26T12:00:0${id}.000Z`,
    id,
    role: "assistant",
    speaker: { id: name.toLowerCase(), name, type: "agent" },
    text: `${name} response`,
    workflow: {
      messageType,
      model,
      provider,
      round,
      taskId: task.taskId,
    },
  };
}

const teamMembers = [
  {
    model: "gpt-5.4",
    name: "problem-decomposer",
    provider: "openai",
    role: "Coordinator" as const,
  },
  {
    model: "claude-haiku-4-5-20251001",
    name: "contrarian",
    provider: "claude",
    role: "Participant" as const,
  },
  {
    model: "gpt-5.4",
    name: "pragmatist",
    provider: "openai",
    role: "Participant" as const,
  },
];

function event(
  id: string,
  type: RunEvent["type"],
  overrides: Partial<RunEvent> = {},
): RunEvent {
  return { id, ts: Date.now(), type, ...overrides };
}

describe("discussion journey model", () => {
  it("keeps the Team runtime's status notice out of the participant roster", () => {
    // The notice is built from the real blocked event through the same mapper
    // the chat uses, so the speaker under test is the one the runtime emits.
    const notice = buildWorkflowChatMessages([
      {
        events: [event("blocked", "run.blocked")],
        targetKind: "team-chat",
        taskId: task.taskId,
        taskRunId: task.runId,
      },
    ]);
    expect(notice[0]?.speaker?.id).toBe("team-runtime");

    const model = buildDiscussionJourneyModel({
      events: [],
      messages: notice,
      pendingAgents: [],
      stages,
      task: { ...task, mode: "blocked" },
      teamMembers,
    });

    expect(
      model?.participants.map((participant) => participant.id),
    ).not.toContain("team-runtime");
  });

  it('keeps an asking agent waiting even when its partial response and start event exist', () => {
    const partial = message({ id: '1', messageType: 'position', name: 'Pragmatist', round: 1 })
    partial.agentQuestion = agentQuestionViewSchema.parse({
      interactionId: 'question-one', revision: 0, taskId: task.taskId, sessionId: 'session-one',
      requestDigest: 'a'.repeat(64), requestedAt: partial.createdAt, questionIds: ['recipient'],
      agentId: 'pragmatist', agentDisplayName: 'Pragmatist', dispatchId: 'dispatch-one', childRunId: 'child-one',
      status: 'pending', canSubmit: true,
      request: { progress: 'I need the recipient.', questions: [{ question: 'Who?', reason: 'Required.' }] },
    })
    const model = buildDiscussionJourneyModel({
      task, stages, teamMembers, messages: [partial], pendingAgents: [],
      events: [event('start', 'agent.start', { agentName: 'pragmatist' })],
    })
    expect(model?.participants.find((entry) => entry.id === 'pragmatist')?.status).toBe('awaiting_input')
    expect(model?.participants.find((entry) => entry.id === 'contrarian')?.status).toBe('waiting')
  });

  it('shows a terminal question blocker as stopped', () => {
    const partial = message({ id: '1', messageType: 'position', name: 'Pragmatist', round: 1 })
    partial.agentQuestion = agentQuestionViewSchema.parse({
      interactionId: 'question-one', revision: 0, taskId: task.taskId, sessionId: 'session-one',
      requestDigest: 'a'.repeat(64), requestedAt: partial.createdAt, questionIds: ['recipient'],
      agentId: 'pragmatist', agentDisplayName: 'Pragmatist', dispatchId: 'dispatch-one', childRunId: 'child-one',
      status: 'blocked', blockCode: 'question_limit_reached', canSubmit: false,
      request: { progress: 'I need the recipient.', questions: [{ question: 'Who?', reason: 'Required.' }] },
    })
    const model = buildDiscussionJourneyModel({
      task, stages, teamMembers, messages: [partial], pendingAgents: [],
      events: [event('start', 'agent.start', { agentName: 'pragmatist' })],
    })
    expect(model?.participants.find((entry) => entry.id === 'pragmatist')?.status).toBe('stopped')
    expect(model?.participants.find((entry) => entry.id === 'contrarian')?.status).toBe('waiting')
  });

  it("uses the configured round count and observed participants", () => {
    const model = buildDiscussionJourneyModel({
      events: [
        event("contrarian-start", "agent.start", {
          agentName: "Contrarian",
          model: "gpt-5.4",
          provider: "openai",
        }),
      ],
      messages: [
        message({
          id: "1",
          messageType: "framing",
          name: "Problem Decomposer",
          round: 1,
        }),
        message({
          id: "2",
          messageType: "position",
          name: "Contrarian",
          round: 1,
        }),
      ],
      pendingAgents: [],
      stages,
      task,
    });

    expect(model?.stages.map(({ id, state }) => [id, state])).toEqual([
      ["brief", "completed"],
      ["round-1", "current"],
      ["round-2", "locked"],
      ["writing", "locked"],
      ["delivery", "locked"],
    ]);
    expect(
      model?.stages.find((stage) => stage.id === "round-2")?.meta,
    ).toBe("Not started");
    expect(model?.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Problem Decomposer",
          role: "Coordinator",
          status: "complete",
        }),
        expect.objectContaining({
          name: "Contrarian",
          model: "gpt-5.4",
          provider: "openai",
          role: "Participant",
          status: "complete",
        }),
        expect.objectContaining({
          name: "Pragmatist",
          status: "waiting",
        }),
      ]),
    );
  });

  it("shows the configured lead and every member with its runtime before anything runs", () => {
    const model = buildDiscussionJourneyModel({
      events: [],
      messages: [],
      pendingAgents: [],
      stages,
      task,
      teamMembers,
    });

    expect(model?.participants).toEqual([
      {
        id: "problem-decomposer",
        model: "gpt-5.4",
        name: "Problem Decomposer",
        provider: "openai",
        role: "Coordinator",
        selected: false,
        status: "waiting",
      },
      {
        id: "contrarian",
        model: "claude-haiku-4-5-20251001",
        name: "Contrarian",
        provider: "claude",
        role: "Participant",
        selected: false,
        status: "waiting",
      },
      {
        id: "pragmatist",
        model: "gpt-5.4",
        name: "Pragmatist",
        provider: "openai",
        role: "Participant",
        selected: false,
        status: "waiting",
      },
    ]);
  });

  it("keeps the full Team roster while marking only the orchestrator selection", () => {
    const model = buildDiscussionJourneyModel({
      events: [
        event("roster", "discussion.roster.selected", {
          participants: ["pragmatist"],
          stageType: "discussion",
        }),
      ],
      messages: [],
      pendingAgents: [],
      stages,
      task,
      teamMembers: [
        ...teamMembers,
        { name: "systems-thinker", role: "Participant" as const },
      ],
    });

    expect(model?.participants).toEqual([
      expect.objectContaining({ name: "Problem Decomposer", role: "Coordinator", selected: false }),
      expect.objectContaining({ name: "Contrarian", selected: false, status: "waiting" }),
      expect.objectContaining({ name: "Pragmatist", selected: true, status: "waiting" }),
      expect.objectContaining({ name: "Systems Thinker", selected: false, status: "waiting" }),
    ]);
  });

  it("keeps selected membership fixed while activity moves from idle through thinking to replied", () => {
    const rosterEvent = event("roster", "discussion.roster.selected", {
      participants: ["pragmatist"],
      stageType: "discussion",
    });
    const thinking = buildDiscussionJourneyModel({
      events: [rosterEvent],
      messages: [],
      pendingAgents: [
        {
          id: "pending-pragmatist",
          name: "Pragmatist",
          speakerId: "pragmatist",
          taskId: task.taskId,
        },
      ],
      stages,
      task,
      teamMembers,
    });
    const replied = buildDiscussionJourneyModel({
      events: [rosterEvent],
      messages: [
        message({ id: "1", messageType: "position", name: "Pragmatist", round: 1 }),
      ],
      pendingAgents: [],
      stages,
      task,
      teamMembers,
    });

    const membership = (
      model: ReturnType<typeof buildDiscussionJourneyModel>,
    ) => model?.participants.map(({ name, selected }) => [name, selected]);
    expect(membership(thinking)).toEqual(membership(replied));
    expect(membership(thinking)).toEqual([
      ["Problem Decomposer", false],
      ["Contrarian", false],
      ["Pragmatist", true],
    ]);
    expect(
      thinking?.participants.find((one) => one.name === "Pragmatist")?.status,
    ).toBe("active");
    expect(
      replied?.participants.find((one) => one.name === "Pragmatist")?.status,
    ).toBe("complete");
  });

  it("never promotes an unselected member into the roster when it speaks", () => {
    const model = buildDiscussionJourneyModel({
      events: [
        event("roster", "discussion.roster.selected", {
          participants: ["pragmatist"],
          stageType: "discussion",
        }),
      ],
      messages: [
        message({ id: "1", messageType: "position", name: "Contrarian", round: 1 }),
      ],
      pendingAgents: [],
      stages,
      task,
      teamMembers,
    });

    expect(
      model?.participants.find((one) => one.name === "Contrarian"),
    ).toEqual(
      expect.objectContaining({ selected: false, status: "complete" }),
    );
  });

  it("shows the configured runtime first and adopts the one an event actually reports", () => {
    const configured = buildDiscussionJourneyModel({
      events: [],
      messages: [],
      pendingAgents: [],
      stages,
      task,
      teamMembers,
    });
    expect(
      configured?.participants.find((one) => one.name === "Pragmatist"),
    ).toEqual(expect.objectContaining({ model: "gpt-5.4", provider: "openai" }));

    // A fallback or a routing decision can put the dispatch on another pair.
    // Once the run says so, the rail shows what actually ran.
    const dispatched = buildDiscussionJourneyModel({
      events: [
        event("pragmatist-start", "agent.start", {
          agentName: "Pragmatist",
          model: "claude-haiku-4-5-20251001",
          provider: "claude",
        }),
      ],
      messages: [],
      pendingAgents: [],
      stages,
      task,
      teamMembers,
    });

    expect(
      dispatched?.participants.find((one) => one.name === "Pragmatist"),
    ).toEqual(
      expect.objectContaining({
        model: "claude-haiku-4-5-20251001",
        provider: "claude",
      }),
    );
  });

  it("fills an idle member runtime from the loaded Team roster", () => {
    const model = buildDiscussionJourneyModel({
      events: [
        event("roster", "discussion.roster.selected", {
          participants: ["pragmatist"],
          stageType: "discussion",
        }),
      ],
      messages: [],
      pendingAgents: [],
      rosterRuntimes: [
        { model: "gpt-5.4", name: "contrarian", provider: "openai" },
        {
          model: "claude-opus-4.7",
          name: "systems-thinker",
          provider: "anthropic",
        },
      ],
      stages,
      task,
      teamMembers: [
        { name: "contrarian", role: "Participant" },
        { name: "pragmatist", role: "Participant" },
        { name: "systems-thinker", role: "Participant" },
      ],
    });

    expect(model?.participants).toEqual([
      expect.objectContaining({
        model: "gpt-5.4",
        name: "Contrarian",
        provider: "openai",
        status: "waiting",
      }),
      expect.objectContaining({ name: "Pragmatist", selected: true }),
      expect.objectContaining({
        model: "claude-opus-4.7",
        name: "Systems Thinker",
        provider: "anthropic",
        status: "waiting",
      }),
    ]);
  });

  it("keeps an observed runtime ahead of the loaded Team roster", () => {
    const model = buildDiscussionJourneyModel({
      events: [
        event("contrarian-start", "agent.start", {
          agentName: "Contrarian",
          model: "gpt-5.5",
          provider: "openai",
        }),
      ],
      messages: [],
      pendingAgents: [],
      rosterRuntimes: [
        {
          model: "claude-opus-4.7",
          name: "contrarian",
          provider: "anthropic",
        },
      ],
      stages,
      task,
      teamMembers: [{ name: "contrarian", role: "Participant" }],
    });

    expect(model?.participants).toEqual([
      expect.objectContaining({
        model: "gpt-5.5",
        name: "Contrarian",
        provider: "openai",
      }),
    ]);
  });

  it("keeps the direct Team selection when a nested discussion also selects a roster", () => {
    const model = buildDiscussionJourneyModel({
      events: [
        event("direct-roster", "discussion.roster.selected", {
          participants: ["pragmatist"],
          stageType: "discussion",
        }),
        event("nested-roster", "discussion.roster.selected", {
          participants: ["contrarian"],
          stageType: "discussion",
        }),
      ],
      messages: [],
      pendingAgents: [],
      stages,
      task,
      teamMembers,
    });

    expect(
      model?.participants.filter((participant) => participant.selected)
        .map((participant) => participant.name),
    ).toEqual(["Pragmatist"]);
  });

  it("falls back to the runtime selection when Team catalog roster metadata is unavailable", () => {
    const model = buildDiscussionJourneyModel({
      events: [
        event("roster", "discussion.roster.selected", {
          participants: ["pragmatist"],
          stageType: "discussion",
        }),
      ],
      messages: [],
      pendingAgents: [],
      stages,
      task,
      teamMembers: [],
    });

    expect(model?.participants.map((participant) => participant.name)).toEqual([
      "Contrarian",
      "Pragmatist",
    ]);
    expect(model?.participants).toContainEqual(
      expect.objectContaining({ name: "Pragmatist", selected: true }),
    );
  });

  it("moves from completed rounds through writing to delivery from runtime events", () => {
    const writing = buildDiscussionJourneyModel({
      events: [
        event("discussion-done", "workflow.step.completed", { stepIndex: 1 }),
        event("writing-started", "workflow.step.started", { stepIndex: 2 }),
      ],
      messages: [
        message({
          id: "1",
          messageType: "position",
          name: "Contrarian",
          round: 2,
        }),
      ],
      pendingAgents: [],
      stages,
      task,
    });
    expect(
      writing?.stages.find((stage) => stage.id === "writing")?.state,
    ).toBe("current");
    expect(
      writing?.stages.filter((stage) => stage.id.startsWith("round-"))
        .every((stage) => stage.state === "completed"),
    ).toBe(true);

    const delivered = buildDiscussionJourneyModel({
      events: [
        event("discussion-done", "workflow.step.completed", { stepIndex: 1 }),
        event("writing-done", "workflow.step.completed", { stepIndex: 2 }),
        event("delivery", "artifact.delivery_selected", { runId: task.runId }),
      ],
      messages: [
        message({
          id: "1",
          messageType: "position",
          name: "Contrarian",
          round: 2,
        }),
      ],
      pendingAgents: [],
      stages,
      task,
    });

    expect(delivered?.liveStageId).toBe("delivery");
    expect(
      delivered?.stages.find((stage) => stage.id === "delivery")?.state,
    ).toBe("completed");
  });

  it("omits configured rounds that never ran after early convergence", () => {
    const model = buildDiscussionJourneyModel({
      events: [
        event("discussion-done", "workflow.step.completed", { stepIndex: 1 }),
      ],
      messages: [
        message({
          id: "1",
          messageType: "position",
          name: "Contrarian",
          round: 1,
        }),
        message({
          id: "2",
          messageType: "position",
          name: "Pragmatist",
          round: 2,
        }),
      ],
      pendingAgents: [],
      stages: stages.map((stage) =>
        stage.id === "discuss" && stage.discussions
          ? {
              ...stage,
              discussions: stage.discussions.map((discussion) => ({
                ...discussion,
                maxRounds: 3,
              })),
            }
          : stage
      ),
      task,
    });

    expect(
      model?.stages
        .filter((stage) => stage.id.startsWith("round-"))
        .map(({ id, state }) => [id, state]),
    ).toEqual([
      ["round-1", "completed"],
      ["round-2", "completed"],
    ]);
  });

  it("keeps a member's own selection when a delegated job is named on its run", () => {
    // Built from the envelopes the runtime actually writes, through the real
    // `toRunEvent`, because the collision only exists in that mapping: a
    // delegation event carries no `agent_id`, so `agentId` falls back to the
    // run id — which is also the identity a host turn and its transcript
    // speaker use. Naming a delegated job is the routing stage's own work; if
    // it folded in here the rail would tell the reader this member ran on the
    // title helper's model.
    const hostStart = toRunEvent(
      "host-start",
      {
        schema_version: 1,
        timestamp: "2026-09-09T10:00:00.000Z",
        tenant_id: "local",
        category: "runtime",
        type: "host.agent_start",
        run_id: "child-run",
        payload: {
          coordinator: "reviewer",
          host_provider: "anthropic",
          host_model: "chosen-agent-model",
          model: "chosen-agent-model",
          provider: "anthropic",
          host_model_selection: {
            provider: "anthropic",
            model: "chosen-agent-model",
            source: "app-default",
            reason: "agent-default",
            caller: "agent",
          },
        },
      },
    );
    const jobTitleNaming = toRunEvent(
      "job-title",
      {
        schema_version: 1,
        timestamp: "2026-09-09T10:00:01.000Z",
        tenant_id: "local",
        category: "delegation",
        type: "delegation.job_title_selected",
        run_id: "child-run",
        payload: {
          event: "delegation.job_title_selected",
          job_id: "child-run:writing-team:1",
          delegation_id: "child-run:writing-team:1",
          session_id: "child-run",
          status: "naming",
          model_selection: {
            provider: "openai",
            model: "job-title-model",
            source: "app-default",
            reason: "agent-default",
            caller: "title",
          },
        },
      },
    );
    // The mapping itself is what makes them collide; asserting it here keeps
    // the regression honest if `toRunEvent` ever stops falling back.
    expect(jobTitleNaming.agentId).toBe("child-run");
    expect(jobTitleNaming.modelSelection?.caller).toBe("title");

    const model = buildDiscussionJourneyModel({
      events: [hostStart, jobTitleNaming],
      messages: [
        {
          createdAt: "2026-09-09T10:00:02.000Z",
          id: "reviewer-1",
          role: "assistant",
          speaker: { id: "child-run", name: "Reviewer", type: "agent" },
          text: "Reviewer response",
          workflow: {
            messageType: "position",
            round: 1,
            taskId: task.taskId,
          },
        },
      ],
      pendingAgents: [],
      stages,
      task,
      teamMembers,
    });

    expect(
      model?.participants.find((one) => one.name === "Reviewer"),
    ).toMatchObject({
      model: "chosen-agent-model",
      modelSelection: {
        caller: "agent",
        model: "chosen-agent-model",
        provider: "anthropic",
      },
      provider: "anthropic",
    });
  });

  it("keeps a member's own selection when a background helper runs on its run", () => {
    // The same collision as the job title, at the two other helpers. Compressing
    // a discussion and writing its minutes are recorded against the runtime, and
    // a member's transcript speaker can carry that same id — so folding their
    // selections in here would put a model the member never ran on into the rail.
    const hostStart = toRunEvent("host-start", {
      schema_version: 1,
      timestamp: "2026-09-09T10:00:00.000Z",
      tenant_id: "local",
      category: "runtime",
      type: "host.agent_start",
      run_id: "child-run",
      payload: {
        coordinator: "reviewer",
        model: "chosen-agent-model",
        provider: "anthropic",
        host_model_selection: {
          provider: "anthropic",
          model: "chosen-agent-model",
          source: "app-default",
          reason: "agent-default",
          caller: "agent",
        },
      },
    });
    const helperEvents = (["compression", "minutes"] as const).map((helper, index) =>
      toRunEvent(`helper-${helper}`, {
        schema_version: 1,
        timestamp: `2026-09-09T10:00:0${index + 1}.000Z`,
        tenant_id: "local",
        category: "runtime",
        type: "runtime.helper_model_selected",
        run_id: "child-run",
        payload: {
          event: "runtime.helper_model_selected",
          helper,
          session_id: "child-run",
          model_selection: {
            provider: "openai",
            model: `${helper}-model`,
            source: "app-default",
            reason: "agent-default",
            caller: helper,
          },
        },
      }),
    );

    const model = buildDiscussionJourneyModel({
      events: [hostStart, ...helperEvents],
      messages: [
        {
          createdAt: "2026-09-09T10:00:03.000Z",
          id: "reviewer-1",
          role: "assistant",
          speaker: { id: "child-run", name: "Reviewer", type: "agent" },
          text: "Reviewer response",
          workflow: {
            messageType: "position",
            round: 1,
            taskId: task.taskId,
          },
        },
      ],
      pendingAgents: [],
      stages,
      task,
      teamMembers,
    });

    expect(
      model?.participants.find((one) => one.name === "Reviewer"),
    ).toMatchObject({
      model: "chosen-agent-model",
      modelSelection: {
        caller: "agent",
        model: "chosen-agent-model",
      },
    });
  });

  it("keeps a member's own selection when a helper's provider telemetry lands on its run", () => {
    // The helper's own record is excluded by its `caller`, but the request it
    // makes is also reported by provider telemetry — and that report carries a
    // model and a provider with no selection and no agent name at all. So the
    // exclusion above never sees it, `toRunEvent` falls back to the run id, and
    // the helper's pair lands on whichever member shares that id.
    //
    // Only reachable since the helpers began passing an assignment to write to:
    // `logProviderLifecycle` returns early without one, so before that these
    // events did not exist for a helper.
    const hostStart = toRunEvent("host-start", {
      schema_version: 1,
      timestamp: "2026-09-09T10:00:00.000Z",
      tenant_id: "local",
      category: "runtime",
      type: "host.agent_start",
      run_id: "child-run",
      payload: {
        coordinator: "reviewer",
        model: "chosen-agent-model",
        provider: "anthropic",
        host_model_selection: {
          provider: "anthropic",
          model: "chosen-agent-model",
          source: "agent",
          reason: "explicit-agent-choice",
          caller: "agent",
        },
      },
    });
    // Exactly what `providers/telemetry.ts` publishes for a helper: the pair,
    // the assignment, no `agent_name`, no selection.
    const helperTelemetry = (["start", "end"] as const).map((phase, index) =>
      toRunEvent(`helper-request-${phase}`, {
        schema_version: 1,
        timestamp: `2026-09-09T10:00:0${index + 1}.000Z`,
        tenant_id: "local",
        category: "runtime",
        type: `provider.request.${phase}`,
        run_id: "child-run",
        payload: {
          event: `request.${phase}`,
          provider: "openai",
          model: "compression-model",
          session_id: "child-run",
          assignment_path: "/tmp/assignment",
        },
      }),
    );

    const model = buildDiscussionJourneyModel({
      events: [hostStart, ...helperTelemetry],
      messages: [
        {
          createdAt: "2026-09-09T10:00:03.000Z",
          id: "reviewer-1",
          role: "assistant",
          speaker: { id: "child-run", name: "Reviewer", type: "agent" },
          text: "Reviewer response",
          workflow: {
            messageType: "position",
            round: 1,
            taskId: task.taskId,
          },
        },
      ],
      pendingAgents: [],
      stages,
      task,
      teamMembers,
    });

    const reviewer = model?.participants.find((one) => one.name === "Reviewer");
    expect(reviewer).toEqual(
      expect.objectContaining({
        model: "chosen-agent-model",
        provider: "anthropic",
      }),
    );
    // Stated on its own, because the pair is what a person reads off the rail.
    expect(reviewer?.model).not.toBe("compression-model");
  });

  it("shows the model a gate validator decided on", () => {
    // A gate validator is a Team member doing work in the run, and its dispatch
    // is recorded the way every other Agent's is — `agent.start` carrying the
    // pair and the selection. So the rail reports it with no reader change at
    // all, which is the point: this is disclosure by reuse, not a new notice.
    const validatorStart = toRunEvent("gate-start", {
      schema_version: 1,
      timestamp: "2026-09-09T10:00:00.000Z",
      tenant_id: "local",
      category: "agent",
      type: "agent.start",
      run_id: "run-1",
      payload: {
        agent_name: "pragmatist",
        agent_type: "agent",
        model: "gate-decided-model",
        provider: "anthropic",
        model_selection: {
          provider: "anthropic",
          model: "gate-decided-model",
          source: "app-default",
          reason: "agent-default",
          caller: "agent",
        },
      },
    });

    const model = buildDiscussionJourneyModel({
      events: [validatorStart],
      messages: [],
      pendingAgents: [],
      stages,
      task,
      teamMembers,
    });

    expect(
      model?.participants.find((one) => one.name === "Pragmatist"),
    ).toMatchObject({
      model: "gate-decided-model",
      provider: "anthropic",
      modelSelection: {
        caller: "agent",
        source: "app-default",
      },
    });
  });

  it("does not claim a discussion workspace without config or discussion events", () => {
    expect(
      buildDiscussionJourneyModel({
        events: [],
        messages: [],
        pendingAgents: [],
        stages: [{ id: "write", team: "writing-team" }],
        task,
      }),
    ).toBeNull();
  });

  it("marks unfinished participants and the live stage as stopped after cancellation", () => {
    const model = buildDiscussionJourneyModel({
      events: [],
      messages: [
        message({
          id: "1",
          messageType: "position",
          name: "Contrarian",
          round: 1,
        }),
      ],
      pendingAgents: [
        {
          id: "pending-domain-researcher",
          name: "Domain Researcher",
          speakerId: "domain-researcher",
          taskId: task.taskId,
        },
      ],
      stages: stages.map((stage) =>
        stage.id === "discuss" && stage.discussions
          ? {
              ...stage,
              discussions: stage.discussions.map((discussion) => ({
                ...discussion,
                participants: [
                  ...discussion.participants,
                  "domain-researcher",
                ],
              })),
            }
          : stage
      ),
      task: { ...task, mode: "cancelled" },
    });

    expect(model?.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Contrarian",
          status: "complete",
        }),
        expect.objectContaining({
          name: "Domain Researcher",
          status: "stopped",
        }),
        expect.objectContaining({
          name: "Pragmatist",
          status: "stopped",
        }),
      ]),
    );
    expect(
      model?.stages.find((stage) => stage.id === model.liveStageId),
    ).toMatchObject({
      liveLabel: "Cancelled",
      state: "blocked",
    });
  });
});
