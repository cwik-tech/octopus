import {
  useCallback,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import type { CreateSelectionRequest } from "@/components/create/create-panel";
import { useCreateSidebar } from "@/hooks/use-create-sidebar";
import type { NavigationTab } from "@/lib/utils/app-navigation";
import { confirmWorkflowDraftDiscard } from "@/lib/utils/workflow-draft-guard";
import { clearResourceArchitectConversation } from "@/lib/clients/resource-architect-conversation-client";
import { toast } from "sonner";

export interface CreateAgentSelectionRequest {
  id: string;
  agentName: string;
}

export type CreateListTab = "agents" | "teams" | "workflows";

export type CreateResourceSelection =
  | { kind: "agent"; id: string; requestId: string }
  | { kind: "team"; id: string; requestId: string }
  | null;

export function useCreateWorkspaceController({
  activeTab,
  setActiveTab,
}: {
  activeTab: NavigationTab;
  setActiveTab: Dispatch<SetStateAction<NavigationTab>>;
}) {
  const [createTab, setCreateTabState] = useState<CreateListTab>("teams");
  const [isWorkflowDraftDirty, setIsWorkflowDraftDirty] = useState(false);
  const [resourceSelection, setResourceSelection] =
    useState<CreateResourceSelection>(null);
  const [workflowSelectionRequest, setWorkflowSelectionRequest] =
    useState<CreateSelectionRequest | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(
    null,
  );
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [workspaceKey, setWorkspaceKey] = useState(0);
  const sidebar = useCreateSidebar(activeTab);
  // Memoized so unrelated App re-renders (e.g. the Run sidebar's session
  // poll) never mint a fresh request object; inspectors key reload effects
  // off these identities.
  const agentSelectionRequest = useMemo<CreateAgentSelectionRequest | null>(
    () =>
      resourceSelection?.kind === "agent"
        ? { id: resourceSelection.requestId, agentName: resourceSelection.id }
        : null,
    [resourceSelection],
  );
  const teamSelectionRequest = useMemo<CreateSelectionRequest | null>(
    () =>
      resourceSelection?.kind === "team"
        ? { id: resourceSelection.id, requestId: resourceSelection.requestId }
        : null,
    [resourceSelection],
  );
  const selectedAgentName = resourceSelection?.kind === "agent"
    ? resourceSelection.id
    : null;
  const selectedTeamId = resourceSelection?.kind === "team"
    ? resourceSelection.id
    : null;

  const setAgentSelectionRequest: Dispatch<
    SetStateAction<CreateAgentSelectionRequest | null>
  > = useCallback((value) => {
    setResourceSelection((current) => {
      const currentRequest = current?.kind === "agent"
        ? { id: current.requestId, agentName: current.id }
        : null;
      const next = typeof value === "function" ? value(currentRequest) : value;
      return next
        ? { kind: "agent", id: next.agentName, requestId: next.id }
        : null;
    });
  }, []);
  const setTeamSelectionRequest = useCallback(
    (request: CreateSelectionRequest | null) => {
      setResourceSelection(request
        ? { kind: "team", id: request.id, requestId: request.requestId }
        : null);
    },
    [],
  );
  const setSelectedAgentName = useCallback((agentName: string | null) => {
    setResourceSelection((current) => {
      if (!agentName) return current?.kind === "agent" ? null : current;
      return {
        kind: "agent",
        id: agentName,
        requestId: current?.kind === "agent"
          ? current.requestId
          : crypto.randomUUID(),
      };
    });
  }, []);
  const setSelectedTeamId = useCallback((teamId: string | null) => {
    setResourceSelection((current) => {
      if (!teamId) return current?.kind === "team" ? null : current;
      return {
        kind: "team",
        id: teamId,
        requestId: current?.kind === "team"
          ? current.requestId
          : crypto.randomUUID(),
      };
    });
  }, []);

  const changeCreateTab = useCallback(
    (nextTab: CreateListTab) => {
      if (nextTab === createTab) return;
      if (
        createTab === "workflows" &&
        !confirmWorkflowDraftDiscard(isWorkflowDraftDirty)
      ) {
        return;
      }
      if (createTab === "workflows") {
        setIsWorkflowDraftDirty(false);
        setWorkflowSelectionRequest(null);
      }
      setCreateTabState(nextTab);
      setInspectorOpen(true);
      if (nextTab === "workflows" && selectedWorkflowId) {
        setWorkflowSelectionRequest({
          id: selectedWorkflowId,
          requestId: crypto.randomUUID(),
        });
      }
    },
    [createTab, isWorkflowDraftDirty, selectedWorkflowId],
  );

  const confirmLeave = useCallback(() => {
    if (createTab !== "workflows") return true;
    if (!confirmWorkflowDraftDiscard(isWorkflowDraftDirty)) return false;
    setIsWorkflowDraftDirty(false);
    return true;
  }, [createTab, isWorkflowDraftDirty]);

  const selectWorkflow = useCallback(
    (workflowId: string) => {
      setSelectedWorkflowId(workflowId);
      setWorkflowSelectionRequest({
        id: workflowId,
        requestId: crypto.randomUUID(),
      });
      setCreateTabState("workflows");
      setInspectorOpen(true);
      setActiveTab("create");
    },
    [setActiveTab],
  );

  const selectTeam = useCallback(
    (teamId: string) => {
      setResourceSelection({
        kind: "team",
        id: teamId,
        requestId: crypto.randomUUID(),
      });
      setCreateTabState("teams");
      setActiveTab("create");
    },
    [setActiveTab],
  );

  const selectAgent = useCallback(
    (agentName: string) => {
      setResourceSelection({
        kind: "agent",
        id: agentName,
        requestId: crypto.randomUUID(),
      });
      setCreateTabState("agents");
      setInspectorOpen(true);
      setActiveTab("create");
    },
    [setActiveTab],
  );

  const createNewItem = useCallback(() => {
    if (
      createTab === "workflows" &&
      !confirmWorkflowDraftDiscard(isWorkflowDraftDirty)
    ) {
      return;
    }
    const resetWorkspace = () => {
      setIsWorkflowDraftDirty(false);
      setSelectedWorkflowId(null);
      setWorkflowSelectionRequest(null);
      setResourceSelection(null);
      setInspectorOpen(true);
      setWorkspaceKey((current) => current + 1);
    };
    if (createTab === "workflows") resetWorkspace();
    // Clear durably before mounting a fresh chat, which immediately restores.
    else void clearResourceArchitectConversation().then(resetWorkspace).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : "The Create conversation could not be cleared.");
    });
  }, [createTab, isWorkflowDraftDirty]);

  return {
    agentSelectionRequest,
    changeCreateTab,
    confirmLeave,
    createNewItem,
    createTab,
    inspectorOpen,
    isWorkflowDraftDirty,
    resourceSelection,
    selectAgent,
    selectTeam,
    selectWorkflow,
    selectedAgentName,
    selectedTeamId,
    selectedWorkflowId,
    setAgentSelectionRequest,
    setInspectorOpen,
    setIsWorkflowDraftDirty,
    setSelectedAgentName,
    setSelectedTeamId,
    setSelectedWorkflowId,
    setTeamSelectionRequest,
    setWorkflowSelectionRequest,
    sidebar,
    teamSelectionRequest,
    workflowSelectionRequest,
    workspaceKey,
  };
}

export type CreateWorkspaceController = ReturnType<
  typeof useCreateWorkspaceController
>;
