import { useMemo, useState, type ReactNode } from "react";
import { FileText, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type ExecutionTimelineItem,
  formatTimestamp,
} from "@/lib/models/runtime-model";
import { cn } from "@/lib/utils/utils";
import { formatDisplayName } from "@/lib/utils/display-name";

export interface ProcessTimelineArtifactTarget {
  path: string;
  runId: string;
}

function humanizeTeamName(value: string | null | undefined): string {
  if (!value) return "System";
  return formatDisplayName(value);
}

function hashString(value: string): number {
  let hash = 0;
  for (const char of value) {
    hash = (hash << 5) - hash + char.charCodeAt(0);
    hash |= 0;
  }
  return Math.abs(hash);
}

/**
 * Ordered hues (matching the chat palette order) so each agent receives a
 * visibly distinct accent before any hue repeats.
 */
const AGENT_ACCENT_HUES = [
  217, 160, 262, 38, 350, 189, 292, 173, 25, 243, 85, 330,
];

function buildActorAccentMap(items: ExecutionTimelineItem[]): Map<string, string> {
  const accents = new Map<string, string>();
  for (const item of items) {
    const actorId = item.actor?.id;
    if (!actorId || accents.has(actorId)) continue;
    accents.set(
      actorId,
      `hsl(${AGENT_ACCENT_HUES[accents.size % AGENT_ACCENT_HUES.length]} 52% 42%)`,
    );
  }
  return accents;
}

/** A row for something that broke. */
const TIMELINE_ERROR_ACCENT = "hsl(8 72% 52%)";
/** A row for something the runtime declined. Deliberately not the error red. */
const TIMELINE_REFUSAL_ACCENT = "hsl(38 84% 44%)";

/**
 * Colour identifies the agent when a row is attributed to one, so parallel
 * specialists sharing a run (e.g. Deep Research) stay distinguishable. Rows
 * without an actor fall back to the run, not the team: a root workflow run
 * emits some events tagged with its own name and others tagged with the
 * delegate team that executes the step, so keying on team makes one run's
 * rows alternate between two colours. Keying on the run keeps every
 * unattributed row of a run in one colour, with indentation showing
 * delegation depth.
 */
function getTimelineAccent(
  item: ExecutionTimelineItem,
  actorAccents: ReadonlyMap<string, string>,
): string {
  if (item.kind === "error") return TIMELINE_ERROR_ACCENT;
  // Amber, and never the error red. A refused tool call broke nothing — the
  // runtime declined it, the run carries on — so a row that says "the repeat
  // was dropped" or "the work carries on in the new stage" must not be the
  // same colour as a run that failed. It is still the runtime saying no, so it
  // does not take the agent's own colour either.
  if (item.kind === "refusal") return TIMELINE_REFUSAL_ACCENT;
  const actorId = item.actor?.id;
  if (actorId) {
    const agentAccent = actorAccents.get(actorId);
    if (agentAccent) return agentAccent;
  }
  const hue = hashString(item.runId || item.team || "system") % 360;
  return `hsl(${hue} 52% 42%)`;
}

function getTimelineStepSummary(item: ExecutionTimelineItem): string {
  return item.title;
}

const ALL_AGENTS = "__all_agents__";

function getAgentTooltip(item: ExecutionTimelineItem) {
  if (!item.actor) {
    return {
      label: `Team: ${humanizeTeamName(item.team)}`,
      content: humanizeTeamName(item.team),
    };
  }
  const details = [
    item.actor.baseName ? `Base: ${item.actor.baseName}` : null,
    item.actor.activityScopeId
      ? `Lane: ${item.actor.activityScopeId}`
      : null,
    item.team ? `Team: ${humanizeTeamName(item.team)}` : null,
    item.actor.emitterName
      ? `Emitter: ${item.actor.emitterName}`
      : null,
  ].filter((detail): detail is string => Boolean(detail));
  return {
    label: `Agent: ${formatDisplayName(item.actor.name)}`,
    content: (
      <span className="flex flex-col">
        <span>{formatDisplayName(item.actor.name)}</span>
        {details.map((detail) => (
          <span className="opacity-80" key={detail}>
            {detail}
          </span>
        ))}
      </span>
    ),
  };
}

export function ProcessTimelineTable(props: {
  items: ExecutionTimelineItem[];
  anchorByIndex: (index: number) => string;
  containerClassName?: string;
  isArtifactSelected: (target: ProcessTimelineArtifactTarget) => boolean;
  onArtifactSelect: (target: ProcessTimelineArtifactTarget) => void;
  toolbarStart?: ReactNode;
}) {
  const {
    items,
    anchorByIndex,
    containerClassName,
    isArtifactSelected,
    onArtifactSelect,
    toolbarStart,
  } = props;
  const [selectedAgentId, setSelectedAgentId] = useState(ALL_AGENTS);
  const actorAccents = useMemo(() => buildActorAccentMap(items), [items]);
  const agentOptions = useMemo(() => {
    const actors = new Map<string, { id: string; name: string }>();
    for (const item of items) {
      if (item.actor) actors.set(item.actor.id, {
        id: item.actor.id,
        name: item.actor.name,
      });
    }
    const nameCounts = new Map<string, number>();
    for (const actor of actors.values()) {
      nameCounts.set(actor.name, (nameCounts.get(actor.name) ?? 0) + 1);
    }
    return [...actors.values()]
      .map((actor) => ({
        ...actor,
        label:
          (nameCounts.get(actor.name) ?? 0) > 1
            ? `${formatDisplayName(actor.name)} · ${formatDisplayName(actor.id)}`
            : formatDisplayName(actor.name),
      }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [items]);
  const effectiveAgentId =
    selectedAgentId === ALL_AGENTS ||
    agentOptions.some((actor) => actor.id === selectedAgentId)
      ? selectedAgentId
      : ALL_AGENTS;
  const selectedAgentLabel =
    effectiveAgentId === ALL_AGENTS
      ? "All agents"
      : agentOptions.find((actor) => actor.id === effectiveAgentId)?.label ??
        "All agents";
  const displayItems = items
    .filter(
      (item) =>
        effectiveAgentId === ALL_AGENTS ||
        item.actor?.id === effectiveAgentId,
    )
    .map((item, index) => ({ item, index }))
    .reverse();

  return (
    <TooltipProvider>
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div
          className="flex shrink-0 items-center justify-between gap-3"
          data-slot="process-timeline-toolbar"
        >
          <div className="flex min-w-0 items-center gap-1">
            {toolbarStart}
          </div>
          <Select
            value={effectiveAgentId}
            onValueChange={(value) => {
              if (typeof value === "string") setSelectedAgentId(value);
            }}
          >
            <SelectTrigger
              aria-label="Filter events by agent"
              className="max-w-56 shrink-0 text-xs"
              size="sm"
            >
              <SelectValue>
                {() => <span className="truncate">{selectedAgentLabel}</span>}
              </SelectValue>
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value={ALL_AGENTS}>All agents</SelectItem>
              {agentOptions.map((actor) => (
                <SelectItem key={actor.id} value={actor.id}>
                  {actor.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Table
          className="min-w-[28rem] table-fixed"
          containerClassName={cn(
            "min-h-0 flex-1 overflow-auto",
            containerClassName,
          )}
        >
        <TableHeader className="sticky top-0 z-10 bg-background [&_tr]:bg-background">
          <TableRow className="hover:bg-transparent">
            <TableHead>Event</TableHead>
            <TableHead className="w-12 text-center" aria-label="Agent" />
            <TableHead className="w-16 text-center" aria-label="Artifacts" />
            <TableHead className="w-32.5 text-right">Time</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {displayItems.map(({ item, index }) => {
            const accent = getTimelineAccent(item, actorAccents);
            const agentTooltip = getAgentTooltip(item);
            const eventSummary = getTimelineStepSummary(item);
            return (
              <TableRow
                key={item.id}
                id={anchorByIndex(index)}
                className="scroll-mt-24 border-l-3 border-solid hover:bg-muted/30"
                style={{ borderLeftColor: accent }}
              >
                <TableCell
                  className="min-w-0 overflow-hidden whitespace-nowrap text-xs font-normal text-muted-foreground"
                  style={{ paddingLeft: `${10 + item.depth * 14}px` }}
                >
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          aria-label={eventSummary}
                          className="block truncate outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          tabIndex={0}
                        />
                      }
                    >
                      {eventSummary}
                    </TooltipTrigger>
                    <TooltipContent
                      align="start"
                      className="max-w-sm whitespace-normal"
                      side="top"
                    >
                      {eventSummary}
                    </TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell className="text-center">
                  <Tooltip>
                    <TooltipTrigger
                      aria-label={agentTooltip.label}
                      render={
                        <span
                          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          role="img"
                          tabIndex={0}
                        />
                      }
                    >
                      <Users className="size-3.5" style={{ color: accent }} />
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {agentTooltip.content}
                    </TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell className="text-center">
                  {item.artifactRefs.length > 0 ? (
                    <div className="flex flex-wrap justify-center gap-1">
                      {item.artifactRefs.map((artifactRef) => {
                        const target = {
                          runId: artifactRef.runId,
                          path: artifactRef.path,
                        };
                        return (
                          <Tooltip
                            key={`${item.id}:${artifactRef.runId}:${artifactRef.path}:${artifactRef.label}`}
                          >
                            <TooltipTrigger
                              render={
                                <Button
                                  aria-label={`Open artifact: ${artifactRef.label}`}
                                  className={
                                    isArtifactSelected(target)
                                      ? "border-primary/25 bg-primary/10 text-foreground"
                                      : "text-muted-foreground"
                                  }
                                  size="icon-xs"
                                  type="button"
                                  variant="ghost"
                                  onClick={() => onArtifactSelect(target)}
                                />
                              }
                            >
                              <FileText className="size-3.5" />
                            </TooltipTrigger>
                            <TooltipContent side="top">
                              {artifactRef.label}
                            </TooltipContent>
                          </Tooltip>
                        );
                      })}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right text-xs text-muted-foreground whitespace-nowrap">
                  {formatTimestamp(item.timestamp)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
        </Table>
      </div>
    </TooltipProvider>
  );
}
