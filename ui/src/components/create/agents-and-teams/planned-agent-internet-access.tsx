import { Switch } from "@/components/ui/switch";
import type { PlannedAgentSpec } from "@/lib/models/resource-architect-model";
import { formatDisplayName } from "@/lib/utils/display-name";

export interface PlannedInternetAccessProps {
  onWebResearchChange?: ((agentName: string, enabled: boolean) => void) | undefined;
  webResearchDisabled?: boolean | undefined;
  webResearchNotice?: { agentName: string; text: string } | null | undefined;
}

export function PlannedAgentInternetAccess({ agent, onWebResearchChange, webResearchDisabled, webResearchNotice, showName = false }: PlannedInternetAccessProps & {
  agent: PlannedAgentSpec;
  showName?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="space-y-1">
        {showName ? <p className="text-xs font-medium">Internet access for {formatDisplayName(agent.name)}</p> : null}
        <p className="text-xs">Enable internet access</p>
        <p className="text-xs text-muted-foreground">Allows web research for current sources.</p>
        {webResearchNotice?.agentName === agent.name ? (
          <p role="status" className="text-xs text-muted-foreground">{webResearchNotice.text}</p>
        ) : null}
      </div>
      <Switch
        aria-label={`Enable internet access for ${formatDisplayName(agent.name)}`}
        checked={agent.webResearchEnabled === true}
        disabled={webResearchDisabled || !onWebResearchChange}
        onCheckedChange={(enabled) => onWebResearchChange?.(agent.name, enabled)}
      />
    </div>
  );
}
