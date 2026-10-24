import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import AgentArchitectPanel from "@/components/create/agent-architect-panel";
import TeamArchitectPanel from "@/components/create/team-architect-panel";
import WorkflowGeneratorChat from "@/components/create/workflow-generator-chat";
import { ChatWorkspace } from "@/components/shared/chat-shell";
// import { ModelSelectionNotice } from "@/components/run/chat/model-selection-notice";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { fetchChatDefaults } from "@/lib/clients/chat-defaults-client";
import {
  TEAM_CONTEXT_FILE_ACCEPT,
  teamFileUploadApi,
} from "@/lib/clients/team-file-client";
import type { CreateResourceRef } from "@/lib/models/resource-architect-model";
import { DEFAULT_MODEL_CHOICE, type ModelChoice } from "@/lib/utils/model-catalog";
import { AgentCreationCard, TeamCreationCard } from "./resource-creation-card";
import { hasPlannedWebResearchChoice, isPublishedResourceBuildItemStatus } from "@contracts/resource-architect";
import { ResourceUpdateCard } from "./resource-update-card";
import { useResourceArchitectChat } from "./use-resource-architect-chat";
import { withoutProposedDiagrams } from "./resource-chat-presentation";

const HEADER_HEIGHT_REM = 2.75;

export interface AgentsAndTeamsPanelProps {
  agentSelectionRequest?: { id: string; agentName: string } | null | undefined;
  teamSelectionRequest?: { id: string; requestId: string } | null | undefined;
  detailsOpen?: boolean;
  inspectorTab?: "agents" | "teams";
  topOffsetRem?: number;
  onDetailsOpenChange?: ((open: boolean) => void) | undefined;
  onOpenAgent?: ((agentName: string) => void) | undefined;
  onClearAgentSelection?: (() => void) | undefined;
  onOpenTeam?: ((teamId: string) => void) | undefined;
  onResourcesChanged?: (() => Promise<void> | void) | undefined;
  onConversationRetentionChange?: ((retain: boolean) => void) | undefined;
  handoffPrompt?: { id: string; text: string } | null;
  onHandoffConsumed?: (id: string) => void;
}

export default function AgentsAndTeamsPanel({
  agentSelectionRequest = null,
  teamSelectionRequest = null,
  detailsOpen = false,
  inspectorTab = "agents",
  topOffsetRem = 0,
  onDetailsOpenChange,
  onOpenAgent,
  onClearAgentSelection,
  onOpenTeam,
  onResourcesChanged,
  onConversationRetentionChange,
  handoffPrompt = null,
  onHandoffConsumed,
}: AgentsAndTeamsPanelProps) {
  const [model, setModel] = useState<ModelChoice>(DEFAULT_MODEL_CHOICE);
  // The picker is prefilled from Settings so a person can see what will run.
  // That prefill is not a choice, and a turn must not be recorded as one.
  const [modelChosen, setModelChosen] = useState(false);
  // Read by the prefill, which is an async response with no ordering guarantee
  // and cannot see the state as of when it lands.
  const modelChosenRef = useRef(false);
  const chooseModel = useCallback((choice: ModelChoice) => {
    modelChosenRef.current = true;
    setModelChosen(true);
    setModel(choice);
  }, []);
  const [inspectorDirty, setInspectorDirty] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void fetchChatDefaults()
      .then((defaults) => {
        // A prefill that arrives after someone has picked is stale. Writing it
        // in would replace their choice while the panel still counts it as one,
        // so the turn would go out claiming they chose this pair.
        if (!cancelled && !modelChosenRef.current) setModel(defaults.team);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const openResource = useCallback((resource: CreateResourceRef) => {
    if (resource.kind === "agent") onOpenAgent?.(resource.id);
    else onOpenTeam?.(resource.id);
    onDetailsOpenChange?.(true);
  }, [onDetailsOpenChange, onOpenAgent, onOpenTeam]);
  const autoOpenResource = useCallback((resource: CreateResourceRef) => {
    if (!inspectorDirty) openResource(resource);
  }, [inspectorDirty, openResource]);
  // Only the resource the visible inspector is editing counts as selected, so
  // an agent left over from the Agents tab never leaks into a Teams turn.
  const selectedResource = useMemo<CreateResourceRef | undefined>(() => {
    if (inspectorTab === "teams") {
      return teamSelectionRequest
        ? { kind: "team", id: teamSelectionRequest.id }
        : undefined;
    }
    return agentSelectionRequest
      ? { kind: "agent", id: agentSelectionRequest.agentName }
      : undefined;
  }, [agentSelectionRequest, inspectorTab, teamSelectionRequest]);
  const chat = useResourceArchitectChat({
    model,
    modelOrigin: modelChosen ? "user-choice" : "default",
    selectedResource,
    onResourcesChanged,
    onSelectResource: autoOpenResource,
  });
  const clearPreviousAgentOnInput = (text: string) => {
    // Do not dismiss an editor with unsaved changes or a failed save.
    if (inspectorTab !== "agents" || inspectorDirty || !text.trim() || !onClearAgentSelection) return;
    chat.clearRestoredSelection();
    onClearAgentSelection();
  };
  useEffect(() => {
    onConversationRetentionChange?.(chat.retainOnNavigation);
    return () => onConversationRetentionChange?.(false);
  }, [chat.retainOnNavigation, onConversationRetentionChange]);
  const {
    buildJob,
    canChangeShape,
    changeShape,
    changeWebResearch,
    planRevision,
    planAdmitted,
    shapeChangePending,
    createPlan,
    discard,
    pendingPlan,
    pendingPlanCreatedAt,
    retry,
    retryShapeRead,
    shapeReadFailed,
    shapeReadRetrying,
    submit,
    submitting,
  } = chat;
  // What the last attempt to change the shape had to say, when it had
  // something to say. A refused change is a state to report, not an error to
  // throw away — and it clears as soon as the plan itself changes.
  // Kept with the plan it is about, rather than cleared when the plan changes:
  // a refusal belongs to one plan, and deriving that is simpler than an effect
  // that has to fire before the next render to be correct.
  const [lastShapeNotice, setShapeNotice] = useState<
    { planId: string; text: string } | null
  >(null);
  const shapeNotice = lastShapeNotice && lastShapeNotice.planId === pendingPlan?.id
    ? lastShapeNotice.text
    : null;
  const [lastWebResearchNotice, setWebResearchNotice] = useState<{
    planId: string; agentName: string; text: string;
  } | null>(null);
  const webResearchNotice = lastWebResearchNotice?.planId === pendingPlan?.id ? lastWebResearchNotice : null;
  const changeInternetAccess = useCallback(async (agentName: string, enabled: boolean) => {
    if (!pendingPlan) return;
    setWebResearchNotice(null);
    const notice = await changeWebResearch(agentName, enabled);
    if (notice) setWebResearchNotice({ planId: pendingPlan.id, agentName, text: notice });
  }, [pendingPlan, changeWebResearch]);
  /**
   * What the card says about the shape, when the control is not offered.
   *
   * A plan with an admitted build has been built from, so changing the shape
   * here would describe something other than what exists. What the user should
   * do next depends on what that build left behind, and the two are not the
   * same: a published team can be edited, while an unfinished one is
   * deliberately not openable or editable and is reached only by retrying.
   */
  const publishedATeam = buildJob?.items.some(
    (item) =>
      item.resource?.kind === "team" &&
      isPublishedResourceBuildItemStatus(item.status),
  ) ?? false;
  const settledShapeNotice = planAdmitted
    ? publishedATeam
      ? "This team has already been built from this plan. Edit the team itself, or start a new plan to work differently."
      : "This plan has already been built from, and that build did not finish. Retry it, or start a new plan to work differently."
    : null;
  const displayedShapeNotice = shapeNotice ?? settledShapeNotice;
  // Two different things arrive on one prop. A refused change is a problem; a
  // plan that has already been built from is simply settled, and saying it in
  // the colour of an error reads as something having gone wrong.
  const shapeNoticeTone = shapeNotice ? "error" as const : "info" as const;

  // Create stays mounted once a plan card exists and only reports that the
  // build already started, so the pressed action is never yanked out of reach.
  // Also while the plan cannot actually be built: its revision is still being
  // read, or a shape change is outstanding. Both make `createPlan` a no-op, and
  // a button that looks pressable but does nothing is worse than a disabled one.
  const createDisabled =
    Boolean(buildJob) ||
    submitting ||
    shapeChangePending ||
    (!planRevision && Boolean(pendingPlan && hasPlannedWebResearchChoice(pendingPlan))) ||
    // A saved shape this app cannot build is refused by name, so the plan is
    // unbuildable until the shape has been chosen again and that repair has
    // been written. Absence of `shape` does not say this on its own: a plan
    // that never chose one builds the chain it was planned as.
    (pendingPlan?.kind === "team" && pendingPlan.team.shapeRejected === true) ||
    (pendingPlan?.kind === "team" &&
      Boolean(pendingPlan.team.shape) &&
      !canChangeShape);
  const consumedHandoffIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!handoffPrompt || consumedHandoffIdRef.current === handoffPrompt.id) return;
    if (!model.provider || !model.model) return;
    consumedHandoffIdRef.current = handoffPrompt.id;
    onHandoffConsumed?.(handoffPrompt.id);
    void submit(handoffPrompt.text);
  }, [handoffPrompt, model.model, model.provider, onHandoffConsumed, submit]);

  // Outside the transcript, beside the reply it belongs to. It is a status
  // note about how this turn was run, not something the Architect said.
  /* Default-model cards are intentionally hidden. Keep provenance in the hook
     and the renderer below for a future optional diagnostics view.
  const disclosureItems = useMemo(
    () =>
      chat.modelSelections.map((entry) => ({
        id: entry.id,
        occurredAt: entry.occurredAt,
        content: (
          // Carries the turn's own identity, so a note can be matched to the
          // operation it describes rather than found by position or counted.
          <div
            // Temporarily hide these Create-chat cards without deleting their
            // rendering path or the durable provenance they read from.
            className="hidden"
            data-architect-job-id={entry.jobId}
            data-architect-operation={entry.operation}
          >
            <ModelSelectionNotice
              selections={[
                { speaker: "Agent Architect", selection: entry.selection },
              ]}
            />
          </div>
        ),
      })),
    [chat.modelSelections],
  );
  */
  const timelineItems = useMemo(() => {
    const plan = pendingPlan;
    if (!plan) return [];
    /**
     * The revision read failed, or the user has asked for it again.
     *
     * Built here rather than above, so the memo can depend on the two flags
     * behind it instead of on an object rebuilt every render. Depending on
     * neither is what let a failure change the hook's state while the card on
     * screen stayed the one built before it, with no message and no way back.
     *
     * A first read still in flight is neither of these: the card waits for it
     * and announces nothing, because nothing has gone wrong yet.
     */
    const shapeUnavailable = shapeReadFailed || shapeReadRetrying
      ? {
          onRetry: retryShapeRead,
          ...(shapeReadRetrying ? { retrying: true as const } : {}),
        }
      : null;
    // The plan discriminator decides which card to render. An update is never
    // inferred from a separately supplied list of Team ids.
    if (plan.kind === "resource_updates") {
      // Two ways a stored plan becomes unusable, and neither is fixed by
      // running it again: a revision it pinned has moved on, or it names an
      // Agent whose name it cannot have. The plan itself carries the value
      // that does not work. One Apply and one Retry answer for the whole plan,
      // so both live on the first card.
      const unusable = buildJob?.events.some(
        (event) =>
          event.type === "resource_update_conflict" ||
          event.type === "agent_needs_input",
      ) ?? false;
      const retryable = Boolean(buildJob) &&
        buildJob?.status !== "running" &&
        buildJob?.status !== "completed" &&
        !unusable;
      return plan.operations.map((operation, planIndex) => {
        const item = buildJob?.items.find(
          (candidate) => candidate.planIndex === planIndex,
        );
        return {
          id: `resource-plan:${plan.id}:update:${operation.target.kind}:${operation.target.id}`,
          occurredAt: pendingPlanCreatedAt ?? "9999-12-31T23:59:59.999Z",
          content: (
            <ResourceUpdateCard
              operation={operation}
              planIndex={planIndex}
              item={item}
              events={buildJob?.events}
              onOpen={openResource}
              onWebResearchChange={(name, enabled) => { void changeInternetAccess(name, enabled); }}
              webResearchNotice={webResearchNotice}
              webResearchDisabled={Boolean(buildJob) || submitting || !canChangeShape}
              onApply={planIndex === 0 ? () => void createPlan(plan) : undefined}
              applyDisabled={createDisabled}
              onRetry={planIndex === 0 && retryable ? () => void retry() : undefined}
              retryBlockedReason={planIndex === 0 && unusable
                ? "This update cannot be applied as it stands. Ask for a fresh proposal — retrying this plan cannot succeed."
                : undefined}
            />
          ),
        };
      });
    }
    if (plan.kind === "team") {
      const item = buildJob?.items[0];
      return [{
        id: `resource-plan:${plan.id}:team`,
        occurredAt: pendingPlanCreatedAt ?? "9999-12-31T23:59:59.999Z",
        content: (
          <TeamCreationCard
            team={plan.team}
            item={item}
            events={buildJob?.events}
            onOpen={openResource}
            onWebResearchChange={(name, enabled) => { void changeInternetAccess(name, enabled); }}
            webResearchNotice={webResearchNotice}
            webResearchDisabled={Boolean(buildJob) || submitting || !canChangeShape}
            onCreate={() => void createPlan(plan)}
            createDisabled={createDisabled}
            {...(displayedShapeNotice
              ? { shapeNotice: displayedShapeNotice, shapeNoticeTone }
              : {})}
            {...(shapeUnavailable ? { shapeUnavailable } : {})}
            {...(canChangeShape
              ? {
                  onShapeChange: async (shape) => {
                    // Cleared first: a successful change must not leave the
                    // previous refusal sitting under the new shape.
                    setShapeNotice(null);
                    const notice = await changeShape(shape);
                    // Recorded against the plan it is about, so a refusal
                    // cannot outlive the plan that caused it.
                    if (notice) setShapeNotice({ planId: plan.id, text: notice });
                  },
                  shapeChangePending,
                }
              : {})}
            // A discarded build has nothing left to finish and nothing left to
            // throw away: the server refuses both, and the team is gone.
            onRetry={buildJob && !buildJob.discarded &&
                buildJob.status !== "running" && buildJob.status !== "completed"
              ? () => void retry()
              : undefined}
            {...(buildJob && buildJob.status !== "running" && !buildJob.discarded
              ? { onDiscard: () => void discard() }
              : {})}
          />
        ),
      }];
    }
    return plan.agents.map((agent, planIndex) => {
      const item = buildJob?.items.find((candidate) => candidate.planIndex === planIndex);
      return {
        id: `resource-plan:${plan.id}:agent:${agent.name}`,
        occurredAt: pendingPlanCreatedAt ?? "9999-12-31T23:59:59.999Z",
        content: (
          <AgentCreationCard
            agent={agent}
            item={item}
            onOpen={openResource}
            onWebResearchChange={(name, enabled) => { void changeInternetAccess(name, enabled); }}
            webResearchNotice={webResearchNotice}
            webResearchDisabled={Boolean(buildJob) || submitting || !canChangeShape}
            onCreate={planIndex === 0 ? () => void createPlan(plan) : undefined}
            createDisabled={createDisabled}
            onRetry={planIndex === 0 && buildJob && buildJob.status !== "running" && buildJob.status !== "completed" ? () => void retry() : undefined}
          />
        ),
      };
    });
  }, [
    buildJob,
    canChangeShape,
    changeShape,
    changeInternetAccess,
    webResearchNotice,
    createDisabled,
    createPlan,
    discard,
    openResource,
    displayedShapeNotice,
    pendingPlan,
    pendingPlanCreatedAt,
    retry,
    retryShapeRead,
    shapeChangePending,
    shapeNoticeTone,
    shapeReadFailed,
    shapeReadRetrying,
    submitting,
  ]);
  const reviewTimelineItems = useMemo(() => chat.restoredReviewNotices.map((entry) => ({
    id: entry.id,
    occurredAt: entry.occurredAt,
    content: (
      <Alert role="note" aria-label="Agent Architect review" data-architect-job-id={entry.jobId}>
        <AlertDescription>{entry.warnings.join(" ")}</AlertDescription>
      </Alert>
    ),
  })), [chat.restoredReviewNotices]);

  return (
    <>
      <ChatWorkspace
        className="canvas-glow pt-2 lg:pt-2"
        style={{ height: `calc(100dvh - ${HEADER_HEIGHT_REM + topOffsetRem}rem)` }}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {chat.connectionStatus ? (
            <Alert role="status" aria-label="Agent Architect connection" className="mb-2 shrink-0">
              <AlertDescription>{chat.error}</AlertDescription>
              {chat.connectionStatus === "unavailable" ? (
                <Button size="sm" variant="outline" className="mt-2 w-fit" onClick={() => void chat.checkConnection()}>
                  Check again
                </Button>
              ) : null}
            </Alert>
          ) : null}
          {pendingPlan?.kind !== "team" && (shapeReadFailed || shapeReadRetrying) ? (
            <div className="flex items-center gap-2 p-3" role="status">
              <p className="text-xs text-destructive">The current proposal settings could not be read.</p>
              <Button size="sm" variant="outline" disabled={shapeReadRetrying} onClick={retryShapeRead}>
                {shapeReadRetrying ? "Trying again…" : "Try again"}
              </Button>
            </div>
          ) : null}
          <WorkflowGeneratorChat
            title="Agent Architect"
            botLabel="Agent Architect"
            emptyMessage="Describe the Agents or Team you need. I will decide whether to create standalone Agents or a Team, show the planned names first, and then build them."
            inputPlaceholder="Describe the Agents or Team you need…"
            // Proposed diagrams are not compiled into the team. Hide them in
            // both saved replies and live previews; keep the source untouched.
            history={chat.history.map((turn) => turn.role === "assistant"
              ? { ...turn, text: withoutProposedDiagrams(turn.text) }
              : turn)}
            streamedTurn={{ ...chat.streamedTurn, replies: chat.streamedTurn.replies.map((reply) => ({
              ...reply, text: withoutProposedDiagrams(reply.text),
            })) }}
            additionalTimelineItems={[...reviewTimelineItems, ...timelineItems]}
            submitting={chat.submitting}
            inputDisabled={chat.restoring || chat.connectionStatus !== null}
            stopping={chat.stopping}
            error={chat.connectionStatus ? null : chat.error}
            onSubmit={chat.submit}
            onInputChange={clearPreviousAgentOnInput}
            onStop={chat.submitting ? chat.stop : undefined}
            modelProvider={model.provider}
            model={model.model}
            onModelChange={chooseModel}
            // Automatic prefill runs the displayed pair with default provenance.
            onModelAutoSelect={setModel}
            fileComposer={{
              api: teamFileUploadApi,
              ownerId: chat.draftId,
              accept: TEAM_CONTEXT_FILE_ACCEPT,
              maxFiles: 8,
              disabled: chat.submitting || chat.restoring,
              refreshRevision: chat.documentUploadRevision,
            }}
          />
        </div>
      </ChatWorkspace>

      {inspectorTab === "teams" ? (
        <TeamArchitectPanel
          detailsOpen={detailsOpen}
          teamSelectionRequest={teamSelectionRequest}
          onDetailsOpenChange={onDetailsOpenChange}
          onResourcesChanged={onResourcesChanged}
        />
      ) : (
        <AgentArchitectPanel
          detailsOnly
          detailsOpen={detailsOpen}
          agentSelectionRequest={agentSelectionRequest}
          onDirtyChange={setInspectorDirty}
          onResourcesChanged={onResourcesChanged}
        />
      )}
    </>
  );
}
