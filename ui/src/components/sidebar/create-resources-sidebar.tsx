import { useMemo, useState } from "react";

import {
  CreateSidebarSection,
  type CreateSidebarItem,
  type CreateSidebarItemKind,
} from "@/components/sidebar/create-sidebar-section";
import type { PendingSidebarDelete } from "@/components/sidebar/desktop-sidebar";
import { Button } from "@/components/ui/button";
import { useAgentProviderHealth } from "@/hooks/use-agent-provider-health";
import type { CreateListTab } from "@/hooks/use-create-workspace-controller";
import type { CreateSidebarData } from "@/hooks/use-create-sidebar";
import { formatDisplayName } from "@/lib/utils/display-name";
import { filterSidebarItems } from "@/lib/utils/sidebar-utils";
import { cn } from "@/lib/utils/utils";
import { workflowsEnabled } from "@/lib/utils/workflows-enabled";

interface CreateSidebarSectionConfig {
  emptyLabel: string;
  itemKind: CreateSidebarItemKind;
  items: CreateSidebarItem[];
  onItemSelect: (id: string) => void;
  selectedId: string | null;
  title: string;
}

const CREATE_LIST_TABS: { value: CreateListTab; label: string }[] = [
  { value: "teams", label: "Teams" },
  { value: "agents", label: "Agents" },
  { value: "workflows", label: "Workflows" },
];

export function CreateResourcesSidebar({
  createData,
  createError,
  createLoading,
  createTab,
  onCreateTabChange,
  deletingSidebarItem,
  selectedCreateWorkflowId,
  selectedCreateTeamId,
  selectedCreateAgentName,
  onWorkflowSelect,
  onTeamSelect,
  onAgentSelect,
  onDelete,
}: {
  createData: CreateSidebarData;
  createError: string | null;
  createLoading: boolean;
  createTab: CreateListTab;
  onCreateTabChange?: ((tab: CreateListTab) => void) | undefined;
  deletingSidebarItem: string | null;
  selectedCreateWorkflowId: string | null;
  selectedCreateTeamId: string | null;
  selectedCreateAgentName: string | null;
  onWorkflowSelect: (workflowId: string) => void;
  onTeamSelect: (teamId: string) => void;
  onAgentSelect: (agentName: string) => void;
  onDelete: (target: PendingSidebarDelete) => void;
}) {
  const [searchQueries, setSearchQueries] = useState<
    Record<CreateListTab, string>
  >({ agents: "", teams: "", workflows: "" });
  const searchQuery = searchQueries[createTab];
  const setSearchQuery = (query: string) => {
    setSearchQueries((current) => ({ ...current, [createTab]: query }));
  };
  // Asked only while the Agents list is on screen. The check pings real
  // providers, so the Teams and Workflows tabs must not pay for it.
  const healthTargets = useMemo(
    () =>
      createTab === "agents" ? createData.agents.map((agent) => agent.name) : [],
    [createTab, createData.agents],
  );
  const agentHealth = useAgentProviderHealth(healthTargets);
  const section: CreateSidebarSectionConfig =
    createTab === "workflows"
      ? {
          emptyLabel: "No workflows",
          itemKind: "workflow" as const,
          items: createData.workflows.map((workflow) => ({
            id: workflow.id,
            label: formatDisplayName(workflow.id),
            descriptionTooltip: workflow.description || "No description.",
            searchText: workflow.description,
            deleteTarget: {
              id: workflow.id,
              kind: "workflow" as const,
              label: `workflow “${formatDisplayName(workflow.id)}”`,
              allowSkipConfirmation: false,
            },
          })),
          onItemSelect: onWorkflowSelect,
          selectedId: selectedCreateWorkflowId,
          title: "Workflows",
        }
      : createTab === "teams"
        ? {
            emptyLabel: "No teams",
            itemKind: "team" as const,
            items: createData.teams.map((team) => ({
              id: team.id,
              label: formatDisplayName(team.name),
              teamHealth: team.health,
              descriptionTooltip: team.description || "No description.",
              searchText: [team.description, ...team.tags].filter(Boolean).join(" "),
              deleteTarget: {
                id: team.id,
                kind: "team" as const,
                label: `team “${formatDisplayName(team.name)}”`,
                allowSkipConfirmation: false,
                // Captured with the row, so the confirmation deletes the
                // version the person saw; nothing is read before the delete.
                revision: team.revision,
              },
            })),
            onItemSelect: onTeamSelect,
            selectedId: selectedCreateTeamId,
            title: "Teams",
          }
        : {
            emptyLabel: "No agents",
            itemKind: "agent" as const,
            items: createData.agents.map((agent) => ({
              id: agent.name,
              label: formatDisplayName(agent.name),
              model: agent.model,
              provider: agent.provider,
              agentHealth: agentHealth.byAgentName[agent.name],
              agentHealthLoading:
                agentHealth.loading && !agentHealth.byAgentName[agent.name],
              descriptionTooltip: agent.description || "No description.",
              searchText: [
                agent.description,
                agent.model,
                agent.provider,
                ...agent.skills,
              ]
                .filter(Boolean)
                .join(" "),
              deleteTarget: {
                id: agent.name,
                kind: "agent" as const,
                label: `agent “${formatDisplayName(agent.name)}”`,
                allowSkipConfirmation: false,
              },
            })),
            onItemSelect: onAgentSelect,
            selectedId: selectedCreateAgentName,
            title: "Agents",
          };
  const showWorkflows = workflowsEnabled();
  const listTabs = showWorkflows
    ? CREATE_LIST_TABS
    : CREATE_LIST_TABS.filter((tab) => tab.value !== "workflows");
  const visibleItems = filterSidebarItems(
    section.items,
    searchQuery,
    (item) => [item.label, item.searchText],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-sidebar">
      <div
        className={cn(
          "mx-3 mt-3 grid rounded-lg bg-sidebar-accent/50 p-0.5",
          showWorkflows ? "grid-cols-3" : "grid-cols-2",
        )}
        role="tablist"
        aria-label="Resource type"
      >
        {listTabs.map((tab) => (
          <Button
            key={tab.value}
            variant="ghost"
            size="xs"
            role="tab"
            aria-selected={createTab === tab.value}
            className="px-2 py-1 aria-selected:bg-card aria-selected:text-foreground aria-selected:shadow-sm"
            onClick={() => onCreateTabChange?.(tab.value)}
          >
            {tab.label}
          </Button>
        ))}
      </div>
      <CreateSidebarSection
        {...section}
        items={visibleItems}
        deletingSidebarItem={deletingSidebarItem}
        error={createError}
        loading={createLoading}
        onDelete={onDelete}
        onSearch={setSearchQuery}
      />
    </div>
  );
}
