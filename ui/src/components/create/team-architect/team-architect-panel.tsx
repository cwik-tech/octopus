import { useProviderCatalog } from "@/contexts/provider-catalog-context";
import { TeamDetailsSidebar } from "./team-details-sidebar";
import type { TeamArchitectPanelProps } from "./types";
import { useTeamEditor } from "./use-team-editor";

export default function TeamArchitectPanel({
  detailsOpen = false,
  onDetailsOpenChange,
  onResourcesChanged,
  teamSelectionRequest = null,
}: TeamArchitectPanelProps) {
  const { groups: modelGroups } = useProviderCatalog();
  const editor = useTeamEditor({
    onDetailsOpenChange,
    onResourcesChanged,
    teamSelectionRequest,
  });

  return (
    <TeamDetailsSidebar
      detailsOpen={detailsOpen}
      teamSelectionRequest={teamSelectionRequest}
      modelGroups={modelGroups}
      editor={editor}
    />
  );
}
