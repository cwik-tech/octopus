import {
  useCallback,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import type { CreateSelectionRequest } from "@/components/create/create-panel";
import type { PendingSidebarDelete } from "@/components/sidebar/desktop-sidebar";
import { deleteAgent } from "@/lib/clients/agent-generator-client";
import { deleteSession, deleteWorkflow } from "@/lib/clients/session-client";
import {
  deleteTeamBuilderTeam,
  TeamRevisionConflictError,
} from "@/lib/clients/team-builder-client";
import type { SessionSummary } from "@/lib/models/session-model";
import {
  setDeleteConfirmationSkipped,
  shouldConfirmDelete,
} from "@/lib/utils/delete-confirmation";
import type { CreateSidebarData } from "@/hooks/use-create-sidebar";

interface SessionRequest {
  id: string;
  requestId: string;
}

export function useSidebarDeletion({
  selectedSidebarSessionId,
  selectedCreateWorkflowId,
  selectedCreateTeamId,
  selectedCreateAgentName,
  setSidebarSessions,
  setSidebarSessionsError,
  setSelectedSidebarSessionId,
  setRunSessionSelectionRequest,
  setRunSessionDeletionRequest,
  setCreateSidebarData,
  setCreateSidebarError,
  setSelectedCreateWorkflowId,
  setWorkflowSelectionRequest,
  setSelectedCreateTeamId,
  setTeamSelectionRequest,
  setSelectedCreateAgentName,
  setCreateAgentSelectionRequest,
  setCreateInspectorOpen,
}: {
  selectedSidebarSessionId: string | null;
  selectedCreateWorkflowId: string | null;
  selectedCreateTeamId: string | null;
  selectedCreateAgentName: string | null;
  setSidebarSessions: Dispatch<SetStateAction<SessionSummary[]>>;
  setSidebarSessionsError: (error: string | null) => void;
  setSelectedSidebarSessionId: (sessionId: string | null) => void;
  setRunSessionSelectionRequest: (request: SessionRequest | null) => void;
  setRunSessionDeletionRequest: (request: SessionRequest | null) => void;
  setCreateSidebarData: Dispatch<SetStateAction<CreateSidebarData>>;
  setCreateSidebarError: (error: string | null) => void;
  setSelectedCreateWorkflowId: (workflowId: string | null) => void;
  setWorkflowSelectionRequest: (request: CreateSelectionRequest | null) => void;
  setSelectedCreateTeamId: (teamId: string | null) => void;
  setTeamSelectionRequest: (request: CreateSelectionRequest | null) => void;
  setSelectedCreateAgentName: (agentName: string | null) => void;
  setCreateAgentSelectionRequest: Dispatch<
    SetStateAction<{ id: string; agentName: string } | null>
  >;
  setCreateInspectorOpen: (open: boolean) => void;
}) {
  const [pendingSidebarDelete, setPendingSidebarDelete] =
    useState<PendingSidebarDelete | null>(null);
  const [deletingSidebarItem, setDeletingSidebarItem] = useState<string | null>(
    null,
  );
  const [sidebarDeleteError, setSidebarDeleteError] = useState<string | null>(
    null,
  );

  const deleteSidebarItem = useCallback(
    async (target: PendingSidebarDelete, neverAskAgain = false) => {
      setDeletingSidebarItem(target.id);
      setSidebarDeleteError(null);
      try {
        if (target.kind === "session") {
          await deleteSession(target.id);
          setSidebarSessions((current) =>
            current.filter((session) => session.id !== target.id),
          );
          setRunSessionDeletionRequest({
            id: target.id,
            requestId: crypto.randomUUID(),
          });
          if (selectedSidebarSessionId === target.id) {
            setSelectedSidebarSessionId(null);
            setRunSessionSelectionRequest(null);
          }
          if (neverAskAgain) {
            setDeleteConfirmationSkipped("run-session", true);
          }
        } else if (target.kind === "workflow") {
          await deleteWorkflow(target.id);
          setCreateSidebarData((current) => ({
            ...current,
            workflows: current.workflows.filter(
              (workflow) => workflow.id !== target.id,
            ),
          }));
          if (selectedCreateWorkflowId === target.id) {
            setSelectedCreateWorkflowId(null);
            setWorkflowSelectionRequest(null);
            setCreateInspectorOpen(false);
          }
        } else if (target.kind === "team") {
          await deleteTeamBuilderTeam(target.id, target.revision);
          setCreateSidebarData((current) => ({
            ...current,
            teams: current.teams.filter((team) => team.id !== target.id),
          }));
          if (selectedCreateTeamId === target.id) {
            setSelectedCreateTeamId(null);
            setTeamSelectionRequest(null);
            setCreateInspectorOpen(false);
          }
        } else {
          await deleteAgent({ agentName: target.id, deleteSkills: false });
          setCreateSidebarData((current) => ({
            ...current,
            agents: current.agents.filter((agent) => agent.name !== target.id),
          }));
          if (selectedCreateAgentName === target.id) {
            setSelectedCreateAgentName(null);
            setCreateAgentSelectionRequest(null);
          }
        }

        setPendingSidebarDelete(null);
      } catch (error) {
        if (error instanceof TeamRevisionConflictError) {
          // The server's words, and the row redrawn from the team as it now
          // stands. The open confirmation keeps the revision of the row the
          // person confirmed, so saying yes again is refused again: the
          // current version is deleted only from a new confirmation of the
          // updated row, once this one is closed.
          const refused = error.team;
          setCreateSidebarData((current) => ({
            ...current,
            teams: current.teams.map((team) => (team.id === refused.id ? refused : team)),
          }));
        }
        const message = error instanceof Error ? error.message : String(error);
        setSidebarDeleteError(message);
        if (target.kind === "session") {
          setSidebarSessionsError(message);
        } else {
          setCreateSidebarError(message);
        }
      } finally {
        setDeletingSidebarItem(null);
      }
    },
    [
      selectedCreateAgentName,
      selectedCreateTeamId,
      selectedCreateWorkflowId,
      selectedSidebarSessionId,
      setCreateAgentSelectionRequest,
      setCreateInspectorOpen,
      setCreateSidebarData,
      setCreateSidebarError,
      setRunSessionDeletionRequest,
      setRunSessionSelectionRequest,
      setSelectedCreateAgentName,
      setSelectedCreateTeamId,
      setSelectedCreateWorkflowId,
      setSelectedSidebarSessionId,
      setSidebarSessions,
      setSidebarSessionsError,
      setTeamSelectionRequest,
      setWorkflowSelectionRequest,
    ],
  );

  const requestSidebarDelete = useCallback(
    (target: PendingSidebarDelete) => {
      setSidebarDeleteError(null);
      if (
        target.kind === "session" &&
        target.allowSkipConfirmation &&
        !shouldConfirmDelete("run-session")
      ) {
        void deleteSidebarItem(target);
        return;
      }
      setPendingSidebarDelete(target);
    },
    [deleteSidebarItem],
  );

  return {
    pendingSidebarDelete,
    setPendingSidebarDelete,
    deletingSidebarItem,
    sidebarDeleteError,
    setSidebarDeleteError,
    deleteSidebarItem,
    requestSidebarDelete,
  };
}
