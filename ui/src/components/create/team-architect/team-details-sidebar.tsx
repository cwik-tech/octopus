import { useEffect, useState } from "react";

import AgentArchitectPanel from "@/components/create/agent-architect-panel";
import { WorkspaceRightSidebarContent } from "@/components/sidebar/workspace-right-sidebar";
import type { ProviderCatalogGroup } from "@/lib/clients/provider-settings-client";
import { readTeamBuilderTeam } from "@/lib/clients/team-builder-client";
import { AddTeamAgentDialog } from "./add-team-agent-dialog";
import { DeleteTeamDialog } from "./delete-team-dialog";
import { TeamDetailsEditor } from "./team-details-editor";
import { TeamRosterEditor } from "./team-roster-editor";
import { getTeamYaml, renderTeamYamlPreview } from "./team-yaml";
import { TeamYamlPreviewDialog } from "./team-yaml-preview-dialog";
import type { TeamArchitectPanelProps } from "./types";
import type { TeamEditorController } from "./use-team-editor";

export function TeamDetailsSidebar(props: {
  detailsOpen: boolean;
  teamSelectionRequest: TeamArchitectPanelProps["teamSelectionRequest"];
  modelGroups: ProviderCatalogGroup[];
  editor: TeamEditorController;
}) {
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [agentsToDelete, setAgentsToDelete] = useState<Set<string>>(
    () => new Set(),
  );
  const [yamlPreviewOpen, setYamlPreviewOpen] = useState(false);
  const [yamlPreviewYaml, setYamlPreviewYaml] = useState<string | null>(null);
  const [yamlPreviewLoading, setYamlPreviewLoading] = useState(false);
  const [yamlPreviewError, setYamlPreviewError] = useState<string | null>(null);
  // A roster agent opened from this team. It belongs to the selection on screen
  // when it was opened, so picking a team in the list shows that team again.
  const [openAgent, setOpenAgent] = useState<{
    id: string;
    agentName: string;
    teamRequestId: string | null;
  } | null>(null);
  const teamRequestId = props.teamSelectionRequest?.requestId ?? null;
  const rosterAgent =
    openAgent?.teamRequestId === teamRequestId ? openAgent : null;

  useEffect(() => {
    if (!props.teamSelectionRequest) return;
    const timeout = window.setTimeout(() => setDeleteConfirmOpen(false), 0);
    return () => window.clearTimeout(timeout);
  }, [props.teamSelectionRequest]);

  async function openYamlPreview() {
    const teamId = props.editor.selectedTeamId ?? props.editor.detail?.id;
    if (!teamId) return;
    setYamlPreviewOpen(true);
    setYamlPreviewLoading(true);
    setYamlPreviewError(null);
    setYamlPreviewYaml(
      props.editor.detail ? getTeamYaml(props.editor.detail) : null,
    );
    try {
      const team = await readTeamBuilderTeam(teamId);
      props.editor.setDetail(team);
      setYamlPreviewYaml(getTeamYaml(team));
    } catch (error) {
      setYamlPreviewError(error instanceof Error ? error.message : String(error));
      if (props.editor.detail) {
        setYamlPreviewYaml(renderTeamYamlPreview(props.editor.detail));
      }
    } finally {
      setYamlPreviewLoading(false);
    }
  }

  // A saved persona can change the agent's model or role, which the roster
  // shows once the person goes back. The save already succeeded, so a failed
  // re-read leaves the roster as it was rather than reporting a save error.
  async function refreshTeamAfterAgentSave() {
    const teamId = props.editor.selectedTeamId ?? props.editor.detail?.id;
    if (teamId) {
      await readTeamBuilderTeam(teamId).then(
        props.editor.setDetail,
        () => undefined,
      );
    }
    await props.editor.refreshTeamsAfterMutation();
  }

  return (
    <>
      {rosterAgent ? (
        <AgentArchitectPanel
          detailsOnly
          detailsOpen={props.detailsOpen}
          agentSelectionRequest={rosterAgent}
          onResourcesChanged={refreshTeamAfterAgentSave}
          back={{ label: "Back to team", onClick: () => setOpenAgent(null) }}
        />
      ) : null}
      <WorkspaceRightSidebarContent active={props.detailsOpen && !rosterAgent}>
        <div className="flex min-h-full min-w-0 flex-col gap-3 px-2">
          <TeamDetailsEditor
            editor={props.editor}
            onOpenYamlPreview={() => void openYamlPreview()}
            onOpenDelete={() => {
              setAgentsToDelete(new Set());
              setDeleteConfirmOpen(true);
            }}
          />
          <TeamRosterEditor
            editor={props.editor}
            onOpenAddAgent={() => setAddAgentOpen(true)}
            onOpenAgent={(agentName) =>
              setOpenAgent({
                id: crypto.randomUUID(),
                agentName,
                teamRequestId,
              })
            }
          />
        </div>
      </WorkspaceRightSidebarContent>

      <AddTeamAgentDialog
        open={addAgentOpen}
        onOpenChange={setAddAgentOpen}
        editor={props.editor}
      />
      <DeleteTeamDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        editor={props.editor}
        agentsToDelete={agentsToDelete}
        onAgentsToDeleteChange={setAgentsToDelete}
      />
      <TeamYamlPreviewDialog
        open={yamlPreviewOpen}
        onOpenChange={setYamlPreviewOpen}
        yaml={yamlPreviewYaml}
        loading={yamlPreviewLoading}
        error={yamlPreviewError}
      />
    </>
  );
}
