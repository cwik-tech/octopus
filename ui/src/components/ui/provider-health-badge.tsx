import { HealthBadge } from "@/components/ui/health-badge";
import type { AgentProviderHealth } from "@/lib/models/agent-generator-model";
import { summarizeAgentProviderHealth } from "@contracts/health";

interface ProviderHealthBadgeProps {
  health?: AgentProviderHealth | undefined;
  loading?: boolean;
  className?: string;
  fallbackMessage?: string;
}

/**
 * The agent editor's model-status badge.
 *
 * Kept as its own name because the model picker plugs it into a `currentStatus`
 * slot, but it owns no drawing of its own: the icon, the colours, and the
 * tooltip are `HealthBadge`'s, so this badge and a sidebar row can never
 * disagree about what the same health means. It differs only in what it is
 * for — a single field the user is editing, where a healthy answer is worth
 * an icon and an unchecked one has to be distinguishable from a bad one. The
 * words go in the tooltip, so the picker keeps its width for the model name.
 */
export function ProviderHealthBadge({
  health,
  loading = false,
  className,
  fallbackMessage = "Provider status has not been checked yet.",
}: ProviderHealthBadgeProps) {
  const summary = health
    ? summarizeAgentProviderHealth(health)
    : {
        status: "unknown" as const,
        diagnostics: [
          {
            severity: "warning" as const,
            kind: "config" as const,
            message: fallbackMessage,
            subject: {},
          },
        ],
      };

  return (
    <HealthBadge
      className={className}
      loading={loading}
      stateInTooltip
      subject="Provider"
      summary={summary}
      tooltip
    />
  );
}
