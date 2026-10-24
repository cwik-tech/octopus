import { SidebarItemButton } from "@/components/sidebar/sidebar-item-button";
import {
  HealthBadge,
  HealthDiagnosticList,
  healthRowStatus,
} from "@/components/ui/health-badge";
import { ProviderModelIcon } from "@/components/ui/provider-model-icon";
import type { TeamBuilderHealth } from "@/lib/models/team-builder-model";
import { summarizeTeamBuilderHealth } from "@contracts/health";

interface TeamItemProps {
  /** Display name, already formatted for reading. */
  label: string;
  provider?: string | undefined;
  model?: string | undefined;
  descriptionTooltip?: string | undefined;
  /** Build health. Only a team that cannot run is drawn. */
  health?: TeamBuilderHealth | undefined;
  meta?: string | null | undefined;
  /**
   * Set in a single-choice list, where the row reports itself as a radio.
   * Left unset, the row is a navigation target that merely looks selected.
   */
  checked?: boolean;
  selected?: boolean;
  onSelect: () => void;
  onDelete?: () => void;
  deleting?: boolean;
}

/**
 * The one team row used by both the Create sidebar and the Run team picker.
 * It is the team counterpart of {@link AgentItem}: same row chrome, same
 * hover description, same negative-only health, so a team reads the same
 * whichever list it appears in.
 */
export function TeamItem({
  label,
  provider,
  model,
  descriptionTooltip,
  health,
  meta,
  checked,
  selected = false,
  onSelect,
  onDelete,
  deleting = false,
}: TeamItemProps) {
  const summary = summarizeTeamBuilderHealth(health);
  const unhealthy = summary.status !== "ok";

  return (
    <SidebarItemButton
      label={label}
      checked={checked}
      labelTrailing={
        <>
          {provider ? (
            <ProviderModelIcon model={model} provider={provider} />
          ) : null}
          <HealthBadge subject="Team" summary={summary} />
        </>
      }
      rowTooltip={
        unhealthy ? <HealthDiagnosticList summary={summary} /> : undefined
      }
      rowStatus={healthRowStatus(summary, "Team")}
      descriptionTooltip={descriptionTooltip}
      meta={meta}
      selected={selected}
      onClick={onSelect}
      onDelete={onDelete}
      deleting={deleting}
    />
  );
}
