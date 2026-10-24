import { AgentItem } from "@/components/sidebar/agent-item";
import type { PendingSidebarDelete } from "@/components/sidebar/desktop-sidebar";
import { SidebarEmptyLabel } from "@/components/sidebar/sidebar-empty-label";
import { SidebarError } from "@/components/sidebar/sidebar-error";
import { SidebarSectionHeader } from "@/components/sidebar/sidebar-section-header";
import { SidebarSkeleton } from "@/components/sidebar/sidebar-skeleton";
import { TeamItem } from "@/components/sidebar/team-item";
import type { AgentProviderHealth } from "@/lib/models/agent-generator-model";
import type { TeamBuilderHealth } from "@/lib/models/team-builder-model";

export type CreateSidebarItemKind = "agent" | "team" | "workflow";

export interface CreateSidebarItem {
  id: string;
  label: string;
  descriptionTooltip?: string;
  meta?: string;
  model?: string | undefined;
  provider?: string | undefined;
  teamHealth?: TeamBuilderHealth;
  /** Provider reachability, the same answer the Run agent picker draws. */
  agentHealth?: AgentProviderHealth | undefined;
  agentHealthLoading?: boolean;
  searchText?: string | undefined;
  deleteTarget: PendingSidebarDelete;
}

export function CreateSidebarSection({
  emptyLabel,
  itemKind,
  items,
  deletingSidebarItem,
  error = null,
  loading = false,
  onDelete,
  onItemSelect,
  onSearch,
  selectedId,
  title,
}: {
  emptyLabel: string;
  itemKind: CreateSidebarItemKind;
  items: CreateSidebarItem[];
  deletingSidebarItem: string | null;
  error?: string | null;
  loading?: boolean;
  onDelete: (target: PendingSidebarDelete) => void;
  onItemSelect: (id: string) => void;
  onSearch: (query: string) => void;
  selectedId: string | null;
  title: string;
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col pt-3">
      {/* The tab strip above already names the list, so the row carries the
          search trigger alone. */}
      <SidebarSectionHeader searchLabel={title} onSearch={onSearch} />
      <div className="desktop-sidebar-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {loading ? (
          <SidebarSkeleton />
        ) : items.length === 0 ? (
          <SidebarEmptyLabel>{emptyLabel}</SidebarEmptyLabel>
        ) : (
          <ul className="space-y-1">
            {items.map((item) => {
              return (
                <li key={item.id}>
                  {itemKind === "agent" ? (
                    <AgentItem
                      label={item.label}
                      provider={item.provider}
                      model={item.model}
                      health={item.agentHealth}
                      statusLoading={item.agentHealthLoading}
                      descriptionTooltip={item.descriptionTooltip}
                      selected={item.id === selectedId}
                      onSelect={() => onItemSelect(item.id)}
                      onDelete={() => onDelete(item.deleteTarget)}
                      deleting={deletingSidebarItem === item.id}
                    />
                  ) : (
                    <TeamItem
                      label={item.label}
                      provider={item.provider}
                      model={item.model}
                      health={item.teamHealth}
                      descriptionTooltip={item.descriptionTooltip}
                      meta={item.meta}
                      selected={item.id === selectedId}
                      onSelect={() => onItemSelect(item.id)}
                      onDelete={() => onDelete(item.deleteTarget)}
                      deleting={deletingSidebarItem === item.id}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <SidebarError message={error} />
      </div>
    </section>
  );
}
