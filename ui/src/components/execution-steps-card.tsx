import { ArrowRight, RotateCcw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  PanelCard,
  PanelContent,
  PanelEmptyState,
  PanelHeader,
  PanelItem,
  PanelItemButton,
} from "@/components/ui/card";
import type {
  ExecutionRunNode,
  RunExecutionState,
  RunTeamFlow,
} from "@/lib/models/runtime-model";
import { formatDisplayName } from "@/lib/utils/display-name";

function humanizeTeamName(value: string | null | undefined): string {
  if (!value) return "System";
  return formatDisplayName(value);
}

function humanizeStageType(value: string | null | undefined): string {
  if (!value) return "unknown";
  return formatDisplayName(value);
}

function ExecutionStateBadge({ state }: { state: RunExecutionState }) {
  const variant =
    state === "running"
      ? "default"
      : state === "waiting"
        ? "outline"
        : state === "completed"
          ? "secondary"
          : state === "failed" || state === "blocked"
            ? "destructive"
            : "outline";

  return (
    <Badge
      className={
        state === "incomplete"
          ? "border-amber-300 text-amber-700 capitalize"
          : "capitalize"
      }
      variant={variant}
    >
      {state}
    </Badge>
  );
}

/** A run node as this card reads it. A node with no recorded team reads as "System". */
export type ExecutionStepsRunNode = Omit<ExecutionRunNode, "team"> & {
  team?: string | null | undefined;
};

export function ExecutionStepsCard(props: {
  flow: RunTeamFlow | null;
  flowLoading?: boolean;
  onRunSelect: (runId: string) => void;
  runNodes: ExecutionStepsRunNode[];
  selectedRunId: string | null;
}) {
  const { flow, flowLoading = false, onRunSelect, runNodes, selectedRunId } =
    props;
  const selectedRunNode =
    runNodes.find((node) => node.runId === selectedRunId) ?? null;
  const currentLevelIndex =
    flow && selectedRunNode?.currentLevelId
      ? flow.levels.findIndex(
          (level) => level.id === selectedRunNode.currentLevelId,
        )
      : -1;

  return (
    <div className="space-y-4">
      <PanelCard variant="inset">
        <PanelHeader title="Execution Steps" />
        <PanelContent className="p-3">
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            {runNodes.map((node, index) => (
              <div key={node.id} className="flex shrink-0 items-center gap-2">
                {index > 0 ? (
                  <ArrowRight className="size-4 text-muted-foreground/70" />
                ) : null}
                <PanelItemButton
                  type="button"
                  selected={selectedRunId === node.runId}
                  className="flex min-w-44 items-center justify-between gap-3 py-3"
                  onClick={() => onRunSelect(node.runId)}
                >
                  <span className="truncate font-medium text-foreground">
                    {humanizeTeamName(node.team)}
                  </span>
                  <ExecutionStateBadge state={node.executionState} />
                </PanelItemButton>
              </div>
            ))}
          </div>
        </PanelContent>
      </PanelCard>

      {!selectedRunNode ? null : (
        <PanelCard variant="inset">
          <PanelContent className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="font-heading text-lg text-foreground">
                  {humanizeTeamName(selectedRunNode.team)}
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {selectedRunNode.currentLevelId
                    ? humanizeStageType(selectedRunNode.currentLevelId)
                    : "No active level yet"}
                  {selectedRunNode.currentStageType
                    ? ` · ${humanizeStageType(selectedRunNode.currentStageType)}`
                    : ""}
                </div>
              </div>
              <ExecutionStateBadge state={selectedRunNode.executionState} />
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <PanelItem>
                <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                  Current level
                </div>
                <div className="mt-2 text-sm font-medium text-foreground">
                  {selectedRunNode.currentLevelId
                    ? formatDisplayName(selectedRunNode.currentLevelId)
                    : "n/a"}
                </div>
              </PanelItem>
              <PanelItem>
                <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                  Current stage
                </div>
                <div className="mt-2 text-sm font-medium text-foreground">
                  {selectedRunNode.currentStageType
                    ? formatDisplayName(selectedRunNode.currentStageType)
                    : "n/a"}
                </div>
              </PanelItem>
              <PanelItem>
                <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                  Active agents
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {selectedRunNode.activeAgentNames.length > 0 ? (
                    selectedRunNode.activeAgentNames.map((agentName) => (
                      <Badge key={agentName} variant="secondary">
                        {formatDisplayName(agentName)}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">none</span>
                  )}
                </div>
              </PanelItem>
            </div>

            {flow ? (
              <div className="mt-4 overflow-x-auto pb-1">
                <div className="flex min-w-max items-start gap-3">
                  {flow.levels.map((level, index) => {
                    const transition = flow.transitions.find(
                      (item) => item.from === level.id && !item.isLoopback,
                    );
                    const loopbacks = flow.transitions.filter(
                      (item) => item.from === level.id && item.isLoopback,
                    );
                    const isCurrent =
                      level.id === selectedRunNode.currentLevelId;
                    const isCompleted =
                      currentLevelIndex !== -1 && index < currentLevelIndex;
                    const isPending =
                      currentLevelIndex !== -1 && index > currentLevelIndex;
                    const activeAgents = isCurrent
                      ? selectedRunNode.activeAgentNames.filter((agentName) =>
                          level.actorNames.includes(agentName),
                        )
                      : [];

                    return (
                      <div key={level.id} className="flex items-start gap-3">
                        <PanelItem
                          selected={isCurrent}
                          className={[
                            "w-62 px-4 py-4",
                            isCompleted && !isCurrent ? "bg-muted/45" : "",
                            isPending && !isCurrent ? "bg-background/60" : "",
                          ].join(" ")}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="font-medium text-foreground">
                                {level.name}
                              </div>
                              <div className="mt-1 text-xs uppercase tracking-[0.16em] text-muted-foreground">
                                {humanizeStageType(level.stageType)}
                              </div>
                            </div>
                            {isCurrent ? (
                              <Badge variant="default">Current</Badge>
                            ) : null}
                          </div>

                          <div className="mt-3">
                            <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                              Actors
                            </div>
                            <div className="mt-2 flex flex-wrap gap-2">
                              {level.actorNames.map((actorName) => (
                                <Badge
                                  key={`${level.id}:${actorName}`}
                                  variant="outline"
                                >
                                  {actorName}
                                </Badge>
                              ))}
                            </div>
                          </div>

                          {activeAgents.length > 0 ? (
                            <div className="mt-3">
                              <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                                Active now
                              </div>
                              <div className="mt-2 flex flex-wrap gap-2">
                                {activeAgents.map((agentName) => (
                                  <Badge
                                    key={`${level.id}:${agentName}:active`}
                                    variant="secondary"
                                  >
                                    {formatDisplayName(agentName)}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          ) : null}

                          {level.loopLabel ? (
                            <div className="mt-3 flex items-start gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                              <RotateCcw className="mt-0.5 size-3.5 shrink-0" />
                              <span>{level.loopLabel}</span>
                            </div>
                          ) : null}

                          {loopbacks.length > 0 ? (
                            <div className="mt-3 space-y-1">
                              {loopbacks.map((loopback) => (
                                <div
                                  key={`${level.id}:${loopback.to}:${loopback.label}`}
                                  className="text-xs text-muted-foreground"
                                >
                                  Loopback to{" "}
                                  <span className="font-medium text-foreground">
                                    {loopback.to}
                                  </span>
                                  : {loopback.label}
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </PanelItem>

                        {index < flow.levels.length - 1 ? (
                          <div className="flex w-33 shrink-0 flex-col items-center gap-2 pt-14 text-center">
                            <ArrowRight className="size-5 text-muted-foreground/70" />
                            <div className="text-xs text-muted-foreground">
                              {transition?.label ?? "advance"}
                            </div>
                          </div>
                        ) : transition ? (
                          <div className="flex w-38 shrink-0 flex-col items-center gap-2 pt-12 text-center">
                            <ArrowRight className="size-5 text-muted-foreground/70" />
                            <PanelItem className="bg-muted/45 px-3 py-3 text-center">
                              <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                                Done
                              </div>
                              <div className="mt-2 text-xs text-foreground">
                                {transition.label}
                              </div>
                            </PanelItem>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : flowLoading ? (
              <PanelEmptyState className="mt-4 text-sm text-muted-foreground">
                Loading team flow...
              </PanelEmptyState>
            ) : (
              <PanelEmptyState className="mt-4 text-sm text-muted-foreground">
                No team flow metadata found for this run.
              </PanelEmptyState>
            )}
          </PanelContent>
        </PanelCard>
      )}
    </div>
  );
}
