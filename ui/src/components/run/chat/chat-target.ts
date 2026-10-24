import type { SessionMessageTarget } from "@contracts/schemas/session-requests";
import type { RunPlanSelectionSource } from "@/lib/models/session-model";

/**
 * What a chat message is addressed to. Agents and a team are mutually
 * exclusive: a team already carries its own roster, so mixing the two would
 * leave the run with two competing definitions of who answers.
 */
export interface ChatTargetSelection {
  agentNames: string[];
  teamId: string | null;
}

export function emptyChatTarget(): ChatTargetSelection {
  return { agentNames: [], teamId: null };
}

export function selectChatAgents(
  current: ChatTargetSelection,
  agentNames: string[],
): ChatTargetSelection {
  return { ...current, agentNames, teamId: null };
}

export function selectChatTeam(
  current: ChatTargetSelection,
  teamId: string | null,
): ChatTargetSelection {
  return { ...current, agentNames: [], teamId };
}

/**
 * The picker selection, as the target a message carries.
 *
 * A Team wins over individually picked Agents: a Team brings its own roster, so
 * addressing both would leave the turn with two competing definitions of who
 * answers. `selectChatTeam` already clears the agents, so this only decides
 * what a stale pairing means rather than inventing a new rule.
 */
export function toSessionMessageTarget(
  selection: ChatTargetSelection,
): SessionMessageTarget | undefined {
  if (selection.teamId !== null) {
    return { kind: "team", teamId: selection.teamId };
  }
  if (selection.agentNames.length > 0) {
    return { kind: "agents", agentNames: [...selection.agentNames] };
  }
  return undefined;
}

/**
 * The Workflow target a turn carries because the user picked one the plan does
 * not yet record as theirs.
 *
 * Selection is normally persisted the moment it is made, but that needs a plan
 * to compare against, and a conversation has none until its first turn. Without
 * this the pick would be dropped: the next message would arrive untargeted and
 * be answered as though the user had chosen nothing.
 *
 * A Workflow the Coordinator merely recommended is not the user's choice, so
 * picking it still counts as an act the next turn has to carry.
 *
 * It stops riding along while the picker is persisting the same choice: both
 * would compare-and-set the same plan against the same expectation, and one of
 * them would be rejected for work the user did once. Picking before the first
 * plan starts no such request, which is exactly the case this exists for.
 */
export function pendingWorkflowTarget(params: {
  manualWorkflowId: string | null;
  planId: string | null;
  planWorkflowId: string | null;
  planSelectionSource: RunPlanSelectionSource | undefined;
  isPersisting?: boolean;
}): SessionMessageTarget | undefined {
  if (params.isPersisting) return undefined;
  if (!params.manualWorkflowId) return undefined;
  const alreadyOurs =
    params.planSelectionSource === "user" &&
    params.planWorkflowId === params.manualWorkflowId;
  if (alreadyOurs) return undefined;
  return {
    kind: "workflow",
    workflowId: params.manualWorkflowId,
    expectedPlanId: params.planId,
  };
}

/**
 * The team-run workspace shows the level-by-level discussion around the chat.
 *
 * Derived from what the session is actually doing rather than from which
 * sidebar tab is open: a Team the user targeted, a Team run already in the
 * task history, or a Workflow run under way. The active tab is a filter over
 * what can be picked, and it must not decide what the conversation shows.
 */
export function showsTeamRunWorkspace(params: {
  teamId: string | null;
  hasTeamChatTask?: boolean;
  hasWorkflowRun?: boolean;
}): boolean {
  return (
    params.teamId !== null ||
    params.hasTeamChatTask === true ||
    params.hasWorkflowRun === true
  );
}

/** Whether the discussion around the chat is a Team's or a Workflow's. */
export function discussionWorkspacePresentation(params: {
  teamId: string | null;
  hasTeamChatTask?: boolean;
}): "team-chat" | "workflow" {
  return params.teamId !== null || params.hasTeamChatTask === true
    ? "team-chat"
    : "workflow";
}

/**
 * Whether to offer `Begin workflow`.
 *
 * Readiness alone is not enough. The General Agent may recommend a Workflow
 * and mark the plan ready during an ordinary conversation, and offering to
 * launch that would turn a suggestion into an instruction the user never gave.
 * So the card appears only for a Workflow the user selected themselves, on a
 * ready plan that still names it, and only until a task has consumed it.
 *
 * A legacy plan carries no provenance, and an unproven selection is read as a
 * recommendation for exactly the same reason.
 */
export function showsWorkflowLaunchConfirmation(params: {
  hasTasks: boolean;
  isLaunchReady: boolean;
  activeWorkflowId: string | null;
  selectedWorkflowId: string | null | undefined;
  selectionSource: RunPlanSelectionSource | undefined;
}): boolean {
  if (params.hasTasks || !params.isLaunchReady) return false;
  if (params.activeWorkflowId === null) return false;
  // No workflow on the plan means nothing recommended one, and the only way a
  // workflow is active here is that the user picked it by hand.
  if (!params.selectedWorkflowId) return true;
  return (
    params.selectionSource === "user" &&
    params.selectedWorkflowId === params.activeWorkflowId
  );
}
