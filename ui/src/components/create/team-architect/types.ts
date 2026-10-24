import type { CreateSelectionRequest } from "@/components/create/create-panel";

export interface TeamArchitectPanelProps {
  detailsOpen?: boolean;
  onDetailsOpenChange?: ((open: boolean) => void) | undefined;
  onResourcesChanged?: (() => Promise<void> | void) | undefined;
  teamSelectionRequest?: CreateSelectionRequest | null;
}

export interface TeamDraft {
  id: string;
  description: string;
  tagsInput: string;
}

export interface AddTeamAgentInput {
  agentName: string;
}
