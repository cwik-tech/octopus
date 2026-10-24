import {
  ClipboardList,
  FileCheck2,
  MessageSquareText,
  PenLine,
} from "lucide-react";
import {
  startTransition,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { describeModelSelection } from "@contracts/agent-model-selection";
import { resolveRosterAgentRuntime } from "@/components/create/team-architect/team-models";
import { AgentIdentity } from "@/components/run/shared/agent-identity";
import {
  WorkspaceCompactJourneyNav,
  WorkspaceJourneyRail,
  WorkspaceRailSection,
  WorkspaceSurfaceCard,
  type WorkspaceJourneyStage,
} from "@/components/run/shared/workspace-journey";
import type { TaskRunEntry } from "@/components/run/tasks/task-strip";
import { ProviderModelIcon } from "@/components/ui/provider-model-icon";
import { useProviderCatalog } from "@/contexts/provider-catalog-context";
import { readTeamBuilderTeam } from "@/lib/clients/team-builder-client";
import { getWorkflowStages } from "@/lib/clients/session-client";
import type { WorkflowStageInfo } from "@/lib/models/session-model";
import type {
  PendingWorkflowAgent,
  WorkflowChatMessage,
  WorkflowTaskEventGroup,
} from "@/lib/utils/workflow-chat-events";
import {
  agentColorKey,
  buildAgentColorMapFromSpeakers,
} from "@/lib/utils/agent-chat-colors";
import { cn } from "@/lib/utils/utils";
import { formatDisplayName } from "@/lib/utils/display-name";

import {
  buildDiscussionJourneyModel,
  participantIdentityKey,
  type ConfiguredTeamMember,
  type DiscussionParticipant,
  type DiscussionJourneyStageId,
  type DiscussionRosterRuntime,
} from "./discussion-journey-model";

export function DiscussionWorkspace({
  children,
  eventGroups,
  messages,
  pendingAgents,
  presentation = "workflow",
  teamId = null,
  teamMembers = [],
  tasks,
}: {
  children: ReactNode;
  eventGroups: readonly WorkflowTaskEventGroup[];
  messages: readonly WorkflowChatMessage[];
  pendingAgents: readonly PendingWorkflowAgent[];
  presentation?: "workflow" | "team-chat";
  teamId?: string | null;
  /** The Team exactly as configured, resolved before the first turn. */
  teamMembers?: readonly ConfiguredTeamMember[];
  tasks: readonly TaskRunEntry[];
}) {
  const task = tasks.at(-1) ?? null;
  const { defaultModelState } = useProviderCatalog();
  const [declaredStages, setDeclaredStages] = useState<WorkflowStageInfo[]>([]);
  const [loadedWorkflowId, setLoadedWorkflowId] = useState<string | null>(null);
  const [rosterRuntimes, setRosterRuntimes] = useState<
    DiscussionRosterRuntime[]
  >([]);

  useEffect(() => {
    let cancelled = false;
    const workflowId = task?.workflowId;
    startTransition(() => {
      setDeclaredStages([]);
      setLoadedWorkflowId(null);
    });
    if (!workflowId) return () => {
      cancelled = true;
    };

    void getWorkflowStages(workflowId)
      .then((stages) => {
        if (cancelled) return;
        startTransition(() => {
          setDeclaredStages(stages);
          setLoadedWorkflowId(workflowId);
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.warn(
          `[DiscussionWorkspace] Failed to load stages for workflow ${workflowId}; using event inference.`,
          error,
        );
        startTransition(() => {
          setDeclaredStages([]);
          setLoadedWorkflowId(workflowId);
        });
      });

    return () => {
      cancelled = true;
    };
  }, [task?.taskId, task?.workflowId]);

  const rosterTeamId = teamId ??
    task?.teamId ??
    declaredStages.find((stage) => (stage.discussions?.length ?? 0) > 0)
      ?.team ??
    null;
  useEffect(() => {
    let cancelled = false;
    if (!rosterTeamId) {
      startTransition(() => setRosterRuntimes([]));
      return () => {
        cancelled = true;
      };
    }

    void readTeamBuilderTeam(rosterTeamId)
      .then((team) => {
        if (cancelled) return;
        startTransition(() => {
          setRosterRuntimes(
            team.agents
              .filter((agent) => agent.type === "agent")
              .map((agent) => {
                const runtime = resolveRosterAgentRuntime(
                  agent,
                  defaultModelState,
                );
                return {
                  name: agent.name,
                  ...(runtime.model ? { model: runtime.model } : {}),
                  ...(runtime.provider ? { provider: runtime.provider } : {}),
                };
              }),
          );
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.warn(
          `[DiscussionWorkspace] Failed to load roster runtimes for team ${rosterTeamId}; participants show runtime providers only.`,
          error,
        );
        startTransition(() => setRosterRuntimes([]));
      });

    return () => {
      cancelled = true;
    };
  }, [defaultModelState, rosterTeamId]);

  const events = useMemo(
    () =>
      task
        ? eventGroups.find((group) => group.taskId === task.taskId)?.events ?? []
        : [],
    [eventGroups, task],
  );
  const model = useMemo(
    () =>
      task
        ? buildDiscussionJourneyModel({
            events,
            messages,
            pendingAgents,
            rosterRuntimes,
            stages:
              loadedWorkflowId === task.workflowId ? declaredStages : [],
            task,
            teamMembers,
          })
        : null,
    [
      declaredStages,
      events,
      loadedWorkflowId,
      messages,
      pendingAgents,
      rosterRuntimes,
      task,
      teamMembers,
    ],
  );
  const [requestedStage, setRequestedStage] = useState<{
    stageId: DiscussionJourneyStageId;
    taskId: string;
  } | null>(null);
  const requestedStageId = requestedStage &&
    requestedStage.taskId === model?.taskId
    ? requestedStage.stageId
    : null;
  const selectedStageId = model?.stages.some(
    (stage) => stage.id === requestedStageId && stage.reachable,
  )
    ? requestedStageId
    : model?.liveStageId;
  const rosterRuntimeByKey = useMemo(
    () =>
      new Map(
        rosterRuntimes.map((runtime) => [
          participantIdentityKey(runtime.name),
          runtime,
        ]),
      ),
    [rosterRuntimes],
  );
  const visibleParticipants = useMemo<DiscussionParticipant[]>(
    () =>
      model?.participants ?? teamMembers.map((member) => {
        const rosterRuntime = rosterRuntimeByKey.get(
          participantIdentityKey(member.name),
        );
        const model = member.model ?? rosterRuntime?.model;
        const provider = member.provider ?? rosterRuntime?.provider;
        return {
          id: member.name,
          ...(model === undefined ? {} : { model }),
          name: formatDisplayName(member.name),
          ...(provider === undefined ? {} : { provider }),
          role: member.role,
          selected: false,
          status: "waiting" as const,
        };
      }),
    [model?.participants, rosterRuntimeByKey, teamMembers],
  );
  const participantColorByKey = useMemo(
    () =>
      buildAgentColorMapFromSpeakers([
        ...messages.flatMap((message) =>
          message.speaker?.type === "agent" ? [message.speaker] : []
        ),
        ...pendingAgents.map((agent) => ({
          id: agent.speakerId,
          name: agent.name,
        })),
        ...visibleParticipants,
      ]),
    [messages, pendingAgents, visibleParticipants],
  );

  const showsIdleTeamRoster = presentation === "team-chat" &&
    visibleParticipants.length > 0;
  if ((!model || !selectedStageId) && !showsIdleTeamRoster) return <>{children}</>;

  const selectStage = (stageId: DiscussionJourneyStageId) => {
    if (!model) return;
    setRequestedStage(
      stageId === model.liveStageId
        ? null
        : { stageId, taskId: model.taskId },
    );
    const stage = model.stages.find((candidate) => candidate.id === stageId);
    if (!stage) return;
    requestAnimationFrame(() => {
      document.getElementById(stage.anchorId)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  };
  const renderParticipant = (participant: DiscussionParticipant) => {
    const status = participant.status === 'awaiting_input' ? 'Waiting for your answer'
      : participant.status === 'answer_received' ? 'Answer received; waiting to continue'
      : presentation === "team-chat"
      ? participant.status === "active"
        ? "thinking"
        : participant.status === "complete"
          ? "replied"
          : participant.status === "waiting"
            ? "idle"
            : participant.status
      : participant.status;
    return (
      <WorkspaceSurfaceCard
        className={cn(
          "p-2.5 shadow-none",
          participant.status === "active" &&
            (presentation === "team-chat"
              ? "motion-safe:animate-pulse border-orange-500/60 bg-orange-500/10 ring-2 ring-orange-500/15 dark:border-orange-400/60 dark:bg-orange-400/10"
              : "border-primary/35 bg-primary/[0.035] dark:border-primary/45"),
          presentation === "team-chat" &&
            participant.selected &&
            participant.status === "waiting" &&
            "border-primary/35 bg-primary/[0.035] dark:border-primary/45",
        )}
        key={participant.id}
      >
        <AgentIdentity
          avatarSize="md"
          className="text-xs"
          colorClass={
            participantColorByKey.get(
              agentColorKey({
                id: participant.id,
                name: participant.name,
              }),
            ) ?? null
          }
          name={participant.name}
          secondary={
            <span className="text-xs">
              {participant.role} · {status}
              {participant.modelSelection?.source === "app-default" ? (
                <>
                  {" · "}
                  <span title={describeModelSelection(
                    participant.name,
                    participant.modelSelection,
                  )}>
                    app default
                  </span>
                </>
              ) : null}
            </span>
          }
          trailing={
            participant.provider ? (
              <ProviderModelIcon
                className="self-start"
                model={participant.model}
                provider={participant.provider}
              />
            ) : null
          }
        />
      </WorkspaceSurfaceCard>
    );
  };
  const leadParticipants = visibleParticipants.filter(
    (participant) => participant.role === "Coordinator",
  );
  const selectedParticipants = visibleParticipants
    .filter(isSelectedTeamParticipant)
    .sort(
      (left, right) =>
        (left.selectionOrder ?? 0) - (right.selectionOrder ?? 0),
    );
  const remainingParticipants = visibleParticipants.filter(
    (participant) =>
      participant.role === "Participant" &&
      !isSelectedTeamParticipant(participant),
  );
  // Only a discussion Team has a lead and a convened subset. Every other mode
  // runs its whole bench, so showing those two sections would advertise a
  // selection that will never happen.
  const showsDiscussionRoster = leadParticipants.length > 0;
  const participants = visibleParticipants.length > 0 ? (
    presentation === "team-chat" ? (
      showsDiscussionRoster ? (
        <div className="space-y-4">
          <WorkspaceRailSection title="Discussion lead">
            {leadParticipants.map(renderParticipant)}
          </WorkspaceRailSection>
          <WorkspaceRailSection title="Selected participants">
            {selectedParticipants.map(renderParticipant)}
          </WorkspaceRailSection>
          <WorkspaceRailSection title="Team">
            {remainingParticipants.map(renderParticipant)}
          </WorkspaceRailSection>
        </div>
      ) : (
        <WorkspaceRailSection title="Team">
          {visibleParticipants.map(renderParticipant)}
        </WorkspaceRailSection>
      )
    ) : (
      <WorkspaceRailSection title="Participants">
        {visibleParticipants.map(renderParticipant)}
      </WorkspaceRailSection>
    )
  ) : null;

  return (
    <div
      className={cn(
        "flex h-full min-h-0 min-w-0 overflow-hidden",
        presentation === "workflow" && "dark:bg-surface-sunken",
      )}
      data-testid="discussion-workspace"
    >
      {presentation === "team-chat" ? (
        /* Keep the agent cards at their existing width, with a separate gap
           to the conversation equal to two thirds of the former five-step gutter. */
        <aside
          aria-label="Team participants"
          className="mr-[calc(var(--spacing)*5*2/3)] hidden h-full w-54.5 shrink-0 overflow-y-auto py-3 xl:block"
        >
          {participants}
        </aside>
      ) : (
        model && selectedStageId ? <WorkspaceJourneyRail
          ariaLabel="Discussion Journey"
          footer={participants ?? undefined}
          liveStageId={model.liveStageId}
          onSelect={selectStage}
          progressLabel={discussionProgressLabel(model.stages)}
          renderIcon={(stage) => discussionStageIcon(stage.id)}
          selectedStageId={selectedStageId}
          stages={model.stages}
          title="Discussion Flow"
        /> : null
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {presentation === "workflow" && model && selectedStageId ? (
          <WorkspaceCompactJourneyNav
            onSelect={selectStage}
            renderIcon={(stage) => discussionStageIcon(stage.id)}
            selectedStageId={selectedStageId}
            stages={model.stages}
          />
        ) : null}
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}

/**
 * Membership, not activity.
 *
 * A card belongs to the convened roster because the coordinator chose it, and
 * it stays there for the rest of the run. Reading activity here is what used
 * to make members appear and disappear as they started and finished.
 */
function isSelectedTeamParticipant(
  participant: DiscussionParticipant,
): boolean {
  return participant.role === "Participant" && participant.selected;
}

function discussionProgressLabel(
  stages: readonly WorkspaceJourneyStage<DiscussionJourneyStageId>[],
): string {
  const completed = stages.filter((stage) => stage.state === "completed").length;
  return `${completed} of ${stages.length} phases completed`;
}

function discussionStageIcon(stageId: DiscussionJourneyStageId) {
  if (stageId === "brief") return <ClipboardList className="size-3.5" />;
  if (stageId === "writing") return <PenLine className="size-3.5" />;
  if (stageId === "delivery") return <FileCheck2 className="size-3.5" />;
  return <MessageSquareText className="size-3.5" />;
}
