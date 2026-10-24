import {
  isHelperModelSelection,
  type ModelSelectionRecord,
} from "@contracts/agent-model-selection";
import type { RunEvent } from "@/components/run/stage-renderers";
import type { TaskRunEntry } from "@/components/run/tasks/task-strip";
import type {
  PendingWorkflowAgent,
  WorkflowChatMessage,
} from "@/lib/utils/workflow-chat-events";
import type { WorkflowStageInfo } from "@/lib/models/session-model";
import type {
  WorkspaceJourneyStage,
  WorkspaceJourneyStageState,
} from "@/components/run/shared/workspace-journey";
import { formatDisplayName } from "@/lib/utils/display-name";

export type DiscussionJourneyStageId =
  | "brief"
  | `round-${number}`
  | "writing"
  | "delivery";

export interface DiscussionJourneyStage
  extends WorkspaceJourneyStage<DiscussionJourneyStageId> {
  anchorId: string;
}

/**
 * One member of the Team as it is configured, before anything runs.
 *
 * The provider and model are already resolved by the shared runtime-selection
 * rule, so the rail shows the pair the run will actually use rather than
 * whatever the first event happened to report.
 */
export interface ConfiguredTeamMember {
  model?: string;
  name: string;
  provider?: string;
  /** `Coordinator` only for the lead a discussion level declares. */
  role: "Coordinator" | "Participant";
}

export interface DiscussionParticipant {
  id: string;
  model?: string | undefined;
  name: string;
  provider?: string | undefined;
  /**
   * How this participant's pair was decided, as the run recorded it.
   *
   * Present only once the run has actually started the participant, because
   * before that there is no execution to describe.
   */
  modelSelection?: ModelSelectionRecord | undefined;
  role: "Coordinator" | "Participant";
  /**
   * Membership in this run's roster.
   *
   * Decided once by the coordinator's recorded choice. Activity never changes
   * it, so a card cannot enter or leave the selected group by starting to
   * think or by finishing an answer.
   */
  selected: boolean;
  /** Position in the coordinator's chosen order; absent when unselected. */
  selectionOrder?: number;
  status: "active" | "complete" | "stopped" | "waiting" | "awaiting_input" | "answer_received";
}

/** Configured runtime loaded from Team detail when the catalog has names only. */
export interface DiscussionRosterRuntime {
  name: string;
  model?: string;
  provider?: string;
}

export interface DiscussionJourneyModel {
  liveStageId: DiscussionJourneyStageId;
  participants: DiscussionParticipant[];
  stages: DiscussionJourneyStage[];
  taskId: string;
}

export function buildDiscussionJourneyModel({
  events,
  messages,
  pendingAgents,
  rosterRuntimes = [],
  stages,
  task,
  teamMembers,
}: {
  events: readonly RunEvent[];
  messages: readonly WorkflowChatMessage[];
  pendingAgents: readonly PendingWorkflowAgent[];
  rosterRuntimes?: readonly DiscussionRosterRuntime[];
  stages: readonly WorkflowStageInfo[];
  task: TaskRunEntry;
  teamMembers?: readonly ConfiguredTeamMember[];
}): DiscussionJourneyModel | null {
  const discussionStageIndex = stages.findIndex(
    (stage) => (stage.discussions?.length ?? 0) > 0,
  );
  const discussion = discussionStageIndex >= 0
    ? stages[discussionStageIndex]?.discussions?.[0]
    : undefined;
  const taskMessages = messages.filter(
    (message) => message.workflow.taskId === task.taskId,
  );
  const taskPendingAgents = pendingAgents.filter(
    (agent) => agent.taskId === task.taskId,
  );
  const selectedParticipants = events.find(
      (event) =>
        event.type === "discussion.roster.selected" &&
        event.participants !== undefined,
    )?.participants;
  const hasDiscussionEvents = taskMessages.length > 0 ||
    events.some(
      (event) =>
        event.type === "discussion.message" ||
        event.stageType === "discussion",
    );
  if (!discussion && !hasDiscussionEvents) return null;

  const observedRounds = taskMessages
    .map((message) => message.workflow.round)
    .filter(
      (round): round is number =>
        typeof round === "number" && Number.isInteger(round) && round > 0,
    );
  const latestObservedRound = Math.max(0, ...observedRounds);
  const configuredRounds = discussion?.maxRounds ?? discussion?.minRounds ?? 0;
  const completedStepIndices = new Set(
    events
      .filter((event) => event.type === "workflow.step.completed")
      .map((event) => event.stepIndex)
      .filter((index): index is number => index !== undefined),
  );
  const startedStepIndices = new Set(
    events
      .filter((event) => event.type === "workflow.step.started")
      .map((event) => event.stepIndex)
      .filter((index): index is number => index !== undefined),
  );
  const inferredDiscussionIndex = discussionStageIndex >= 0
    ? discussionStageIndex
    : inferDiscussionStepIndex(events);
  const writingStepIndex = inferredDiscussionIndex >= 0
    ? inferredDiscussionIndex + 1
    : -1;
  const hasDelivery = events.some(
    (event) =>
      event.type === "artifact.delivery_selected" &&
      (!event.runId || event.runId === task.runId),
  ) || task.mode === "done";
  const discussionComplete = inferredDiscussionIndex >= 0
    ? completedStepIndices.has(inferredDiscussionIndex)
    : writingStepIndex >= 0 && startedStepIndices.has(writingStepIndex);
  const writingStarted = writingStepIndex >= 0 &&
    (startedStepIndices.has(writingStepIndex) ||
      completedStepIndices.has(writingStepIndex));
  const writingComplete = hasDelivery ||
    (writingStepIndex >= 0 && completedStepIndices.has(writingStepIndex));
  const discussionBlocked = task.mode === "blocked" || task.mode === "error";
  const roundCount = discussionComplete
    ? latestObservedRound
    : Math.max(
        configuredRounds,
        latestObservedRound,
        hasDiscussionEvents ? 1 : 0,
      );

  const journeyStages: [DiscussionJourneyStage, ...DiscussionJourneyStage[]] = [
    {
      anchorId: `workflow-brief-${task.taskId}`,
      id: "brief",
      label: "Initial brief",
      meta: taskMessages.length > 0 ? "Prepared" : "Preparing",
      reachable: true,
      state: taskMessages.length > 0 ? "completed" : "current",
    },
    ...Array.from({ length: roundCount }, (_, index) => {
      const round = index + 1;
      const state = roundState({
        discussionBlocked,
        discussionComplete,
        latestObservedRound,
        round,
      });
      return {
        anchorId: `workflow-round-${task.taskId}-${round}`,
        id: `round-${round}` as const,
        label: `Round ${round}`,
        meta: state === "locked"
          ? "Not started"
          : roundMeta(
              taskMessages,
              round,
              discussion?.participants?.length,
            ),
        reachable: state !== "locked",
        state,
      };
    }),
    {
      anchorId: `workflow-writing-${task.taskId}`,
      id: "writing",
      label: "Writing",
      meta: writingComplete ? "Draft completed" : "Synthesis and drafting",
      reachable: discussionComplete || writingStarted || writingComplete,
      state: writingComplete
        ? "completed"
        : writingStarted || discussionComplete
          ? "current"
          : "locked",
    },
    {
      anchorId: `workflow-delivery-${task.taskId}`,
      id: "delivery",
      label: "Final delivery",
      meta: hasDelivery ? "Delivered" : "Awaiting draft",
      reachable: hasDelivery || writingComplete,
      state: hasDelivery
        ? "completed"
        : writingComplete
          ? "current"
          : "locked",
    },
  ];
  if (task.mode === "cancelled") {
    markCancelledStage(journeyStages);
  }
  const liveStage = journeyStages.find(
    (stage) => stage.state === "blocked" || stage.state === "current",
  ) ?? [...journeyStages].reverse().find((stage) => stage.reachable) ??
    journeyStages[0];

  return {
    liveStageId: liveStage.id,
    participants: buildParticipants({
      configuredMembers:
        teamMembers && teamMembers.length > 0
          ? teamMembers
          : inferredMembers(discussion?.participants ?? selectedParticipants),
      rosterRuntimes,
      selectedParticipants: selectedParticipants ?? [],
      events,
      messages: taskMessages,
      pendingAgents: taskPendingAgents,
      taskCancelled: task.mode === "cancelled",
    }),
    stages: journeyStages,
    taskId: task.taskId,
  };
}

function roundState({
  discussionBlocked,
  discussionComplete,
  latestObservedRound,
  round,
}: {
  discussionBlocked: boolean;
  discussionComplete: boolean;
  latestObservedRound: number;
  round: number;
}): WorkspaceJourneyStageState {
  if (
    round < latestObservedRound ||
    (discussionComplete && round <= latestObservedRound)
  ) {
    return "completed";
  }
  if (latestObservedRound === 0 && !discussionBlocked) return "locked";
  if (discussionBlocked && round === Math.max(latestObservedRound, 1)) {
    return "blocked";
  }
  if (round === Math.max(latestObservedRound, 1)) return "current";
  return "locked";
}

function roundMeta(
  messages: readonly WorkflowChatMessage[],
  round: number,
  configuredParticipantCount?: number,
): string {
  const speakers = new Set(
    messages
      .filter((message) => message.workflow.round === round)
      .map((message) => message.speaker?.id)
      .filter((id): id is string => Boolean(id)),
  );
  const participantCount = Math.max(
    speakers.size,
    configuredParticipantCount ?? 0,
  );
  return participantCount > 0
    ? `${participantCount} ${participantCount === 1 ? "participant" : "participants"}`
    : "Discussion";
}

/** Names with no configuration behind them are ordinary participants. */
function inferredMembers(
  names: readonly string[] | undefined,
): ConfiguredTeamMember[] {
  return (names ?? []).map((name) => ({ name, role: "Participant" as const }));
}

/**
 * The rail's roster: who is on the Team, who this run convened, and what each
 * one is doing right now.
 *
 * The three are deliberately separate. Role and runtime come from the Team's
 * configuration, membership from the coordinator's one recorded choice, and
 * only `status` follows the live events. A member that starts thinking
 * therefore changes its status and nothing else.
 */
function buildParticipants({
  configuredMembers,
  events,
  messages,
  pendingAgents,
  rosterRuntimes,
  selectedParticipants,
  taskCancelled,
}: {
  configuredMembers: readonly ConfiguredTeamMember[];
  events: readonly RunEvent[];
  messages: readonly WorkflowChatMessage[];
  pendingAgents: readonly PendingWorkflowAgent[];
  rosterRuntimes: readonly DiscussionRosterRuntime[];
  selectedParticipants: readonly string[];
  taskCancelled: boolean;
}): DiscussionParticipant[] {
  const rosterByParticipant = new Map<
    string,
    { model?: string; provider?: string }
  >();
  for (const rosterRuntime of rosterRuntimes) {
    const identityKey = participantIdentityKey(rosterRuntime.name);
    if (identityKey) rosterByParticipant.set(identityKey, rosterRuntime);
  }
  const records = new Map<string, DiscussionParticipant>();
  const runtimeByParticipant = new Map<
    string,
    {
      model?: string | undefined;
      provider?: string | undefined;
      modelSelection?: ModelSelectionRecord | undefined;
    }
  >();
  for (const event of events) {
    if (!event.model && !event.provider && !event.modelSelection) continue;
    // Provider telemetry describes a request, never a participant. It carries a
    // model and a provider but no selection and, for the application's own
    // helpers, no agent name either — so the exclusion below cannot see it and
    // `toRunEvent` falls back to the run id, the same identity a host turn and
    // its transcript speaker use. A helper's compression would then put its
    // pair on whichever member shares that id. Every dispatch these events
    // describe already has its own record here, so dropping them costs the rail
    // nothing.
    if (event.type.startsWith("provider.")) continue;
    // A helper's own selection is not a participant's. Naming a delegated job,
    // compressing a discussion and writing its minutes are all the
    // application's own work, and none of their events carries an `agent_id` —
    // so `toRunEvent` falls back to the run id, the same identity a host turn
    // and its transcript speaker use. Folding one in here would put a helper's
    // pair on whichever member shares that id, and the rail would report a
    // default the member never ran on. Each has its own notice in the
    // conversation instead.
    if (
      event.modelSelection &&
      isHelperModelSelection(event.modelSelection.caller)
    ) {
      continue;
    }
    const identityKey = participantIdentityKey(event.agentId, event.agentName);
    if (!identityKey) continue;
    const current = runtimeByParticipant.get(identityKey);
    runtimeByParticipant.set(identityKey, {
      model: event.model ?? current?.model,
      provider: event.provider ?? current?.provider,
      modelSelection: event.modelSelection ?? current?.modelSelection,
    });
  }
  const hasConfiguredCoordinator = configuredMembers.some(
    (member) => member.role === "Coordinator",
  );
  // Only used when the Team's own configuration is unavailable, such as a
  // workflow discussion that never went through the Team catalog.
  const coordinatorIds = new Set(
    messages
      .filter((message) =>
        message.workflow.messageType === "framing" ||
        message.workflow.messageType === "probe"
      )
      .map((message) =>
        participantIdentityKey(message.speaker?.id, message.speaker?.name)
      )
      .filter(Boolean),
  );
  const completedIds = new Set(
    messages
      .filter((message) => !message.agentQuestion)
      .map((message) =>
        participantIdentityKey(message.speaker?.id, message.speaker?.name)
      )
      .filter(Boolean),
  );
  const questionStatusByParticipant = new Map<string, DiscussionParticipant['status']>()
  for (const message of messages) {
    const question = message.agentQuestion
    if (!question || question.status === 'resolved') continue
    questionStatusByParticipant.set(participantIdentityKey(question.agentId),
      question.status === 'cancelled' || question.status === 'blocked' ? 'stopped' : question.status === 'pending' ? 'awaiting_input' :
        question.status === 'submitted' ? 'answer_received' : 'active')
  }
  const activeIds = new Set(
    pendingAgents
      .map((agent) => participantIdentityKey(agent.speakerId, agent.name))
      .filter(Boolean),
  );
  const selectionOrderByKey = new Map(
    selectedParticipants.map((participant, index) => [
      participantIdentityKey(participant),
      index,
    ]),
  );

  for (const member of configuredMembers) {
    const identityKey = participantIdentityKey(member.name);
    const runtime = runtimeByParticipant.get(identityKey);
    const rosterRuntime = rosterByParticipant.get(identityKey);
    const selectionOrder = selectionOrderByKey.get(identityKey);
    records.set(identityKey, {
      id: member.name,
      // Configured is what the rail shows until the run says otherwise. A
      // fallback or a routing decision can dispatch on a different pair, and
      // once an event reports one, that is what actually ran.
      model: runtime?.model ?? member.model ?? rosterRuntime?.model,
      name: displayAgentName(member.name),
      provider: runtime?.provider ?? member.provider ?? rosterRuntime?.provider,
      ...(runtime?.modelSelection
        ? { modelSelection: runtime.modelSelection }
        : {}),
      role: member.role,
      selected: selectionOrder !== undefined,
      ...(selectionOrder === undefined ? {} : { selectionOrder }),
      status: "waiting",
    });
  }
  for (const message of messages) {
    const speaker = message.speaker;
    // Only a Team member can join the roster. The runtime's own notices (a
    // blocked or failed run) speak as "assistant", and the rail is membership,
    // not the conversation — folding them in would seat the runtime itself.
    if (!speaker || speaker.type !== "agent") continue;
    const identityKey = participantIdentityKey(speaker.id, speaker.name);
    const existing = records.get(identityKey);
    const runtime = runtimeByParticipant.get(identityKey);
    const selectionOrder = selectionOrderByKey.get(identityKey);
    records.set(identityKey, {
      id: existing?.id ?? speaker.id,
      model:
        message.workflow.model ??
        runtime?.model ??
        existing?.model,
      name: existing?.name ?? speaker.name,
      provider:
        message.workflow.provider ??
        runtime?.provider ??
        existing?.provider,
      ...(runtime?.modelSelection ?? existing?.modelSelection
        ? {
            modelSelection: runtime?.modelSelection ?? existing?.modelSelection,
          }
        : {}),
      role: existing?.role ??
        (!hasConfiguredCoordinator && coordinatorIds.has(identityKey)
          ? "Coordinator"
          : "Participant"),
      selected: existing?.selected ?? selectionOrder !== undefined,
      ...(selectionOrder === undefined ? {} : { selectionOrder }),
      status: "complete",
    });
  }
  for (const agent of pendingAgents) {
    const identityKey = participantIdentityKey(agent.speakerId, agent.name);
    const existing = records.get(identityKey);
    const runtime = runtimeByParticipant.get(identityKey);
    const selectionOrder = selectionOrderByKey.get(identityKey);
    records.set(identityKey, {
      id: existing?.id ?? agent.speakerId,
      model: agent.model ?? runtime?.model ?? existing?.model,
      name: existing?.name ?? agent.name,
      provider: agent.provider ?? runtime?.provider ?? existing?.provider,
      ...(runtime?.modelSelection ?? existing?.modelSelection
        ? {
            modelSelection: runtime?.modelSelection ?? existing?.modelSelection,
          }
        : {}),
      role: existing?.role ??
        (!hasConfiguredCoordinator &&
            (agent.activity === "selecting-team-members" ||
              coordinatorIds.has(identityKey))
          ? "Coordinator"
          : "Participant"),
      selected: existing?.selected ?? selectionOrder !== undefined,
      ...(selectionOrder === undefined ? {} : { selectionOrder }),
      status: "active",
    });
  }

  return [...records.entries()].map(([identityKey, participant]) => ({
    ...participant,
    status: taskCancelled && activeIds.has(identityKey)
      ? "stopped"
      : questionStatusByParticipant.get(identityKey) ?? (activeIds.has(identityKey)
        ? "active"
        : completedIds.has(identityKey)
        ? "complete"
        : taskCancelled
          ? "stopped"
          : participant.status),
  }));
}

function markCancelledStage(stages: DiscussionJourneyStage[]): void {
  const activeStage = [...stages].reverse().find(
    (stage) => stage.state === "current" || stage.state === "blocked",
  );
  if (!activeStage) return;
  activeStage.liveLabel = "Cancelled";
  activeStage.meta = "Cancelled";
  activeStage.reachable = true;
  activeStage.state = "blocked";
}

export function participantIdentityKey(...values: Array<string | undefined>): string {
  const value = values.find((candidate) => candidate?.trim());
  return value?.toLocaleLowerCase().replaceAll(/[^a-z0-9]/g, "") ?? "";
}

function displayAgentName(id: string): string {
  return formatDisplayName(id);
}

function inferDiscussionStepIndex(events: readonly RunEvent[]): number {
  return events.find(
    (event) =>
      event.type === "discussion.message" && event.stepIndex !== undefined,
  )?.stepIndex ?? -1;
}
