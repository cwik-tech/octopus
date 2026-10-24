import {
  CircleAlert,
  CircleCheck,
  CircleHelp,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import type { ReactNode } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils/utils";
import type { HealthStatus, HealthSummary } from "@contracts/health";

/**
 * The one health icon in the app.
 *
 * Agent rows, Team rows and the agent editor each used to draw their own, with
 * their own icon vocabulary and their own orange, so the same fault looked like
 * three different things depending on where you met it. One drawing, driven by
 * severity alone:
 *
 * - something is broken → a red circle
 * - something needs attention → an amber triangle
 * - nothing could be determined → a muted question mark
 * - nothing is wrong → nothing at all, unless a label was asked for
 *
 * Negative by default: a list of healthy agents stays quiet, so an icon in it
 * means something.
 */

interface HealthBadgeProps {
  /** What the state belongs to, e.g. `Agent`, `Team`, `Provider`. */
  subject: string;
  summary: HealthSummary | undefined;
  /** A check is in flight; nothing is claimed about the outcome yet. */
  loading?: boolean;
  /**
   * Carry the reasons in a tooltip of the badge's own.
   *
   * Left off inside a sidebar row, where the row already owns one tooltip for
   * its whole surface and a second would fight it for the pointer.
   */
  tooltip?: boolean;
  /** Add the state in words, for a surface with no row label to carry it. */
  showLabel?: boolean;
  /**
   * Draw the icon even when nothing is wrong, and put the state in words in
   * the tooltip rather than beside the icon. Needs `tooltip`.
   */
  stateInTooltip?: boolean;
  className?: string | undefined;
}

const STATUS_WORDS: Record<HealthStatus, string> = {
  ok: "Available",
  warning: "Warning",
  error: "Issue",
  unknown: "Unknown",
};

export function HealthBadge({
  subject,
  summary,
  loading = false,
  tooltip = false,
  showLabel = false,
  stateInTooltip = false,
  className,
}: HealthBadgeProps) {
  const status = summary?.status ?? "ok";
  const diagnostics = summary?.diagnostics ?? [];

  if (!loading && status === "ok" && !showLabel && !stateInTooltip) return null;

  // A tab stop is only worth taking when stopping there reveals something.
  const ownsTooltip = tooltip && (diagnostics.length > 0 || stateInTooltip);
  const stateName = loading
    ? `Checking ${subject} status`
    : healthStatusName(summary, subject) ?? `${subject} available`;

  const icon = loading ? (
    <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
  ) : (
    STATUS_ICONS[status]
  );

  const badge = (
    <span
      aria-label={stateName}
      className={cn(
        "inline-flex shrink-0 items-center gap-1",
        loading ? "text-muted-foreground" : STATUS_TEXT[status],
        className,
      )}
      data-health-status={loading ? "checking" : status}
      role="img"
      {...(ownsTooltip ? { tabIndex: 0 } : {})}
    >
      {icon}
      {showLabel ? (loading ? "Checking" : STATUS_WORDS[status]) : null}
    </span>
  );

  if (!ownsTooltip) return badge;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={badge} />
        <TooltipContent
          align="start"
          className="max-w-sm whitespace-normal text-left leading-snug"
          role="tooltip"
          side="top"
        >
          {stateInTooltip && (loading || status === "ok") ? (
            stateName
          ) : (
            <HealthDiagnosticList summary={summary} />
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const STATUS_ICONS: Record<HealthStatus, ReactNode> = {
  ok: <CircleCheck className="size-3.5 shrink-0" />,
  warning: <TriangleAlert className="size-3.5 shrink-0" />,
  error: <CircleAlert className="size-3.5 shrink-0" />,
  unknown: <CircleHelp className="size-3.5 shrink-0" />,
};

const STATUS_TEXT: Record<HealthStatus, string> = {
  // No success token exists yet, and one healthy tick does not justify adding
  // a colour to the theme; every attention state is on semantic tokens.
  ok: "text-emerald-600 dark:text-emerald-400",
  warning: "text-warning",
  error: "text-destructive",
  unknown: "text-muted-foreground",
};

/**
 * What is wrong, in reading order, as the tooltip shows it.
 *
 * One reason reads as a sentence; several read as a list, because a reader
 * scanning for the one they can act on should not have to parse a paragraph.
 */
export function HealthDiagnosticList({
  summary,
}: {
  summary: HealthSummary | undefined;
}) {
  const messages = healthMessages(summary);
  if (messages.length === 0) return null;
  return messages.length === 1 ? (
    messages[0]
  ) : (
    <ul className="list-disc space-y-1 pl-4">
      {messages.map((message) => (
        <li key={message}>{message}</li>
      ))}
    </ul>
  );
}

/**
 * The status half of an unhealthy row's accessible name.
 *
 * A row's own `aria-label` replaces everything nested inside it, so the
 * badge's label never reaches assistive technology on its own. The row joins
 * this onto its name instead.
 */
export function healthStatusName(
  summary: HealthSummary | undefined,
  subject: string,
): string | undefined {
  switch (summary?.status) {
    case "error":
      return `${subject} issue`;
    case "warning":
      return `${subject} warning`;
    case "unknown":
      return `${subject} status unknown`;
    default:
      return undefined;
  }
}

/** The reasons a row carries as its accessible description. */
export function healthDescription(
  summary: HealthSummary | undefined,
): string | undefined {
  const messages = healthMessages(summary);
  return messages.length > 0 ? messages.join(" ") : undefined;
}

/** The name and description an unhealthy sidebar row delegates to the badge. */
export function healthRowStatus(
  summary: HealthSummary | undefined,
  subject: string,
): { name: string; description: string } | undefined {
  const name = healthStatusName(summary, subject);
  const description = healthDescription(summary);
  if (!name || !description) return undefined;
  return { name, description };
}

/**
 * An unhealthy subject always says something, so a status with no collected
 * diagnostic still reads as needing attention rather than as blank.
 */
function healthMessages(summary: HealthSummary | undefined): string[] {
  if (!summary || summary.status === "ok") return [];
  const messages = summary.diagnostics.map((diagnostic) => diagnostic.message);
  return messages.length > 0 ? messages : ["Configuration needs attention"];
}
