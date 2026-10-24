import { X } from "lucide-react";

import { SidebarItemButton } from "@/components/sidebar/sidebar-item-button";
import {
  HealthBadge,
  HealthDiagnosticList,
  healthRowStatus,
} from "@/components/ui/health-badge";
import { ProviderModelIcon } from "@/components/ui/provider-model-icon";
import type { AgentProviderHealth } from "@/lib/models/agent-generator-model";
import { summarizeAgentProviderHealth } from "@contracts/health";

interface AgentItemProps {
  /** Display name, already formatted for reading. */
  label: string;
  provider?: string | undefined;
  model?: string | undefined;
  descriptionTooltip?: string | undefined;
  /** Provider reachability. Only an unreachable provider is drawn. */
  health?: AgentProviderHealth | undefined;
  /** True while the provider check is still in flight; draws nothing. */
  statusLoading?: boolean | undefined;
  /** Renders the multi-select box and reports the row as a toggle. */
  selectable?: boolean;
  selected?: boolean;
  /** Drops the selected fill where the tick box already carries the state. */
  quietSelection?: boolean;
  onSelect: () => void;
  /** Takes the row out of a selection. Draws an ✕; never deletes the agent. */
  onRemove?: (() => void) | undefined;
  onDelete?: () => void;
  deleting?: boolean;
}

/**
 * The one agent row used by both the Create sidebar and the Run agent picker.
 * Status is negative-only: a healthy or unchecked provider shows no icon, so
 * the list stays quiet until something actually needs attention.
 */
export function AgentItem({
  label,
  provider,
  model,
  descriptionTooltip,
  health,
  statusLoading = false,
  selectable = false,
  selected = false,
  quietSelection = false,
  onSelect,
  onRemove,
  onDelete,
  deleting = false,
}: AgentItemProps) {
  // A check still in flight claims nothing: the row stays as it was rather
  // than flickering a spinner in every entry of a long list.
  const summary = summarizeAgentProviderHealth(
    statusLoading ? undefined : health,
  );
  const unhealthy = summary.status !== "ok";

  return (
    <SidebarItemButton
      label={label}
      leading={selectable ? <AgentSelectionBox selected={selected} /> : undefined}
      pressed={selectable ? selected : undefined}
      labelTrailing={
        <>
          {provider ? (
            <ProviderModelIcon model={model} provider={provider} />
          ) : null}
          <HealthBadge subject="Agent" summary={summary} />
        </>
      }
      rowTooltip={
        unhealthy ? <HealthDiagnosticList summary={summary} /> : undefined
      }
      rowStatus={healthRowStatus(summary, "Agent")}
      descriptionTooltip={descriptionTooltip}
      selected={selected && !quietSelection}
      onClick={onSelect}
      onAuxiliaryAction={onRemove}
      auxiliaryActionIcon={<X className="size-3" />}
      auxiliaryActionLabel={`Remove ${label} from selection`}
      auxiliaryActionAlwaysVisible={Boolean(onRemove)}
      onDelete={onDelete}
      deleting={deleting}
    />
  );
}

function AgentSelectionBox({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden
      className={[
        "inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm border",
        selected
          ? "border-sidebar-primary bg-sidebar-primary"
          : "border-sidebar-foreground/35 bg-card",
      ].join(" ")}
    >
      {selected ? (
        <span className="size-1.5 rounded-xs bg-sidebar" />
      ) : null}
    </span>
  );
}
