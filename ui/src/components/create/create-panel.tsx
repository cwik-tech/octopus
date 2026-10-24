import { useCallback, useState } from "react";

import AgentsAndTeamsPanel from "@/components/create/agents-and-teams/agents-and-teams-panel";
import WorkflowArchitectPanel from "@/components/create/workflow-architect-panel";
import type { CreateListTab } from "@/hooks/use-create-workspace-controller";

export interface CreateSelectionRequest {
  id: string;
  requestId: string;
}

interface CreateHandoffPrompt {
  id: string;
  text: string;
}
interface AgentSelectionRequest {
  id: string;
  agentName: string;
}

function CreatePanel({
  agentSelectionRequest,
  createTab,
  detailsOpen = false,
  onDetailsOpenChange,
  onCreateTabChange,
  onOpenAgent,
  onClearAgentSelection,
  onOpenTeam,
  onResourcesChanged,
  onConversationRetentionChange,
  onWorkflowDirtyChange,
  onWorkflowSelectionBlocked,
  teamSelectionRequest,
  workflowSelectionRequest,
}: {
  agentSelectionRequest?: AgentSelectionRequest | null;
  createTab?: CreateListTab;
  detailsOpen?: boolean;
  onDetailsOpenChange?: (open: boolean) => void;
  onCreateTabChange?: (tab: CreateListTab) => void;
  onOpenAgent?: (agentName: string) => void;
  onClearAgentSelection?: () => void;
  onOpenTeam?: (teamId: string) => void;
  onResourcesChanged?: () => Promise<void> | void;
  onConversationRetentionChange?: (retain: boolean) => void;
  onWorkflowDirtyChange?: (dirty: boolean) => void;
  onWorkflowSelectionBlocked?: (currentWorkflowId: string | null) => void;
  teamSelectionRequest?: CreateSelectionRequest | null;
  workflowSelectionRequest?: CreateSelectionRequest | null;
}) {
  const [internalTab, setInternalTab] = useState<CreateListTab>(() => {
    if (agentSelectionRequest) return "agents";
    if (teamSelectionRequest) return "teams";
    return "workflows";
  });
  const activeTab = createTab ?? internalTab;
  const handleTabChange = useCallback(
    (nextTab: CreateListTab) => {
      if (onCreateTabChange) {
        onCreateTabChange(nextTab);
        return;
      }
      setInternalTab(nextTab);
    },
    [onCreateTabChange],
  );
  const [teamHandoffPrompt, setTeamHandoffPrompt] =
    useState<CreateHandoffPrompt | null>(null);

  return (
    <div className="h-full min-h-0">
      {activeTab === "workflows" ? (
        <WorkflowArchitectPanel
          detailsOpen={detailsOpen}
          onDirtyChange={onWorkflowDirtyChange}
          topOffsetRem={0}
          onResourcesChanged={onResourcesChanged}
          workflowSelectionRequest={workflowSelectionRequest}
          onWorkflowSelectionBlocked={onWorkflowSelectionBlocked}
          onTeamHandoff={(prompt) => {
            setTeamHandoffPrompt({ id: crypto.randomUUID(), text: prompt });
            handleTabChange("teams");
          }}
        />
      ) : (
        <AgentsAndTeamsPanel
          onConversationRetentionChange={onConversationRetentionChange}
          agentSelectionRequest={agentSelectionRequest}
          detailsOpen={detailsOpen}
          inspectorTab={activeTab === "teams" ? "teams" : "agents"}
          topOffsetRem={0}
          handoffPrompt={teamHandoffPrompt}
          onHandoffConsumed={(id) => {
            setTeamHandoffPrompt((current) => current?.id === id ? null : current);
          }}
          onDetailsOpenChange={onDetailsOpenChange}
          onOpenAgent={onOpenAgent}
          onClearAgentSelection={onClearAgentSelection}
          onOpenTeam={onOpenTeam}
          onResourcesChanged={onResourcesChanged}
          teamSelectionRequest={teamSelectionRequest}
        />
      )}
    </div>
  );
}

export default CreatePanel;
