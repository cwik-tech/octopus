import {
  ArrowDown,
  ListChecks,
  Network,
  Users,
  Workflow,
} from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  PanelCard,
  PanelContent,
  PanelEmptyState,
  PanelHeader,
  PanelItem,
} from "@/components/ui/card";
import { cn } from "@/lib/utils/utils";
import { formatDisplayName } from "@/lib/utils/display-name";
import {
  WorkflowStageIcon,
} from "@/components/workflow/workflow-stage-icon";
import { isWorkflowStageType } from "@/components/workflow/workflow-stage-types";
import { Button } from "@/components/ui/button";
import type {
  LevelEntry,
  LevelOverride,
  StepDraft,
  TeamEntry,
  WorkflowDraft,
  WorkflowGeneratorRegistry,
} from "@/lib/models/workflow-generator-model";

interface WorkflowStepProps {
  draft: WorkflowDraft | null;
  registry: WorkflowGeneratorRegistry | null;
  registryError?: string | null;
  selectedStepId: string | null;
  onStepSelect: (stepId: string) => void;
  onReviewMaxIterationsChange?: (
    stepId: string,
    levelId: string,
    maxIterations: number,
  ) => void;
}

function WorkflowStepsCard({
  draft,
  registry,
  registryError,
  selectedStepId,
  onStepSelect,
}: WorkflowStepProps) {
  return (
    <PanelCard className="min-h-0">
      <PanelHeader
        icon={<ListChecks className="size-4 text-muted-foreground" />}
        title="Workflow Steps"
      />
      <PanelContent className="min-h-0 overflow-y-auto p-3">
        {!draft ? (
          <PanelEmptyState className="flex h-16 items-center justify-center text-sm text-muted-foreground">
            No workflow loaded.
          </PanelEmptyState>
        ) : draft.steps.length === 0 ? (
          <PanelEmptyState className="flex h-16 items-center justify-center text-sm text-muted-foreground">
            No workflow steps yet.
          </PanelEmptyState>
        ) : (
          <div className="space-y-1">
            {draft.steps.map((step, index) => {
              const team = step.team ? findTeam(registry, step.team) : null;
              const selected = selectedStepId === step.id;
              return (
                <div key={step.id}>
                  <Button
                    variant="ghost"
                    onClick={() => onStepSelect(step.id)}
                    className={cn(
                      "h-auto w-full flex-col items-stretch gap-0 border px-3 py-2.5 text-left font-normal",
                      selected
                        ? "border-primary/35 bg-primary/8 hover:bg-primary/8"
                        : "border-border/60 bg-background/70 hover:bg-muted/45",
                    )}
                  >
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          Step {index + 1}
                        </div>
                        <div className="mt-1 truncate text-sm font-medium text-foreground">
                          {formatTitle(step.id)}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {step.type === "human-in-the-loop"
                            ? "Human feedback boundary"
                            : `Team: ${formatTitle(team?.id ?? step.team ?? "Unassigned")}`}
                        </div>
                      </div>
                      <StageTypeBadges step={step} team={team} />
                    </div>
                  </Button>
                  {index < draft.steps.length - 1 ? (
                    <div className="flex items-center gap-2 py-1 pl-5 text-muted-foreground">
                      <ArrowDown className="size-3.5" />
                    </div>
                  ) : null}
                </div>
              );
            })}
            <div className="flex items-center gap-2 py-1 pl-5 text-muted-foreground">
              <ArrowDown className="size-3.5" />
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/25 px-3 py-2.5">
              <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Workflow output
              </div>
              <div className="mt-1 text-sm font-medium text-foreground">
                {formatArtifactTitle(draft.output.artifact)}
              </div>
            </div>
          </div>
        )}
        {registryError ? (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-xs text-amber-700">
            Team registry failed to load: {registryError}
          </div>
        ) : null}
      </PanelContent>
    </PanelCard>
  );
}

function StepPreviewCard({
  draft,
  registry,
  registryError,
  selectedStepId,
  onReviewMaxIterationsChange,
}: Omit<WorkflowStepProps, "onStepSelect">) {
  const selectedStep =
    draft?.steps.find((step) => step.id === selectedStepId) ??
    draft?.steps[0] ??
    null;
  const selectedIndex = selectedStep
    ? draft?.steps.findIndex((step) => step.id === selectedStep.id) ?? -1
    : -1;
  const selectedTeam = selectedStep?.team
    ? findTeam(registry, selectedStep.team)
    : null;

  return (
    <PanelCard className="min-h-0">
      <PanelHeader
        icon={<Workflow className="size-4 text-muted-foreground" />}
        title="Step Preview"
      />
      <PanelContent className="min-h-0 overflow-y-auto p-3">
        {!draft ? (
          <PanelEmptyState className="flex h-16 items-center justify-center text-sm text-muted-foreground">
            Select or create a workflow to inspect its steps.
          </PanelEmptyState>
        ) : !selectedStep ? (
          <PanelEmptyState className="flex h-16 items-center justify-center text-sm text-muted-foreground">
            Add a workflow step to preview its team stages.
          </PanelEmptyState>
        ) : (
          <div className="min-h-0">
            <PanelItem className="min-h-0">
              <div className="mb-3 flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    Step {selectedIndex + 1}
                  </div>
                  <div className="mt-1 truncate text-base font-medium text-foreground">
                    {formatTitle(selectedStep.id)}
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    {selectedStep.type === "human-in-the-loop"
                      ? "Human feedback boundary"
                      : `Team: ${formatTitle(selectedTeam?.id ?? selectedStep.team ?? "Unassigned")}`}
                  </div>
                </div>
                <StageTypeBadges step={selectedStep} team={selectedTeam} />
              </div>
              <StageList
                step={selectedStep}
                team={selectedTeam}
                onReviewMaxIterationsChange={onReviewMaxIterationsChange}
              />
            </PanelItem>
          </div>
        )}
        {registryError ? (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-xs text-amber-700">
            Team registry failed to load: {registryError}
          </div>
        ) : null}
      </PanelContent>
    </PanelCard>
  );
}

function StageTypeBadges({
  step,
  team,
}: {
  step: StepDraft;
  team: TeamEntry | null;
}) {
  if (step.type === "human-in-the-loop") {
    return <Badge variant="secondary">Human-in-the-loop</Badge>;
  }
  const labels = getStageTypeLabels(step, team);
  if (labels.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-wrap justify-end gap-1">
      {labels.map((label) => (
        <Badge key={label} variant="secondary">
          {isWorkflowStageType(label) ? (
            <WorkflowStageIcon
              type={label}
              decorative
              className="mr-1 size-3"
            />
          ) : null}
          {label}
        </Badge>
      ))}
    </div>
  );
}

function StageList({
  onReviewMaxIterationsChange,
  step,
  team,
}: {
  onReviewMaxIterationsChange?: ((
    stepId: string,
    levelId: string,
    maxIterations: number,
  ) => void) | undefined;
  step: StepDraft;
  team: TeamEntry | null;
}) {
  if (step.type === "human-in-the-loop") {
    return (
      <div className="rounded-lg border border-border/70 bg-muted/25 px-3 py-3 text-sm text-muted-foreground">
        {step.prompt ?? "Review the previous result and provide feedback."}
      </div>
    );
  }
  if (!team) {
    return (
      <div className="rounded-lg border border-dashed border-border/70 bg-muted/25 px-3 py-3 text-sm text-muted-foreground">
        No registered team metadata for {formatTitle(step.team ?? "Unassigned")}.
      </div>
    );
  }

  const levels = team.levels ?? [];
  if (levels.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/70 bg-muted/25 px-3 py-3 text-sm text-muted-foreground">
        This team has no registered stages.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {levels.map((level, index) => {
        const override = step.runtime_overrides?.levels?.[level.id];
        return (
          <div
            key={level.id}
            className="rounded-lg border border-border/60 bg-background/60 px-3 py-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                {index + 1}
              </span>
              <span className="text-xs font-medium text-foreground">
                {formatTitle(level.name ?? level.id)}
              </span>
              <Badge variant="outline">
                {isWorkflowStageType(level.stage_type) ? (
                  <WorkflowStageIcon
                    type={level.stage_type}
                    decorative
                    className="mr-1 size-3"
                  />
                ) : null}
                {level.stage_type}
              </Badge>
              {override ? <Badge variant="secondary">override</Badge> : null}
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 text-xs text-muted-foreground md:grid-cols-2">
              <StageFact
                icon={<Users className="size-3.5" />}
                value={describeActors(level, override)}
              />
              <StageFact
                icon={<Network className="size-3.5" />}
                value={describeStageControl(level, override)}
              />
            </div>
            {level.stage_type === "review" ? (
              <ReviewMaxIterationsControl
                level={level}
                override={override}
                step={step}
                onChange={onReviewMaxIterationsChange}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function StageFact({
  icon,
  value,
}: {
  icon: ReactNode;
  value: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-1.5">
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 break-words">{value}</span>
    </div>
  );
}

function ReviewMaxIterationsControl({
  level,
  onChange,
  override,
  step,
}: {
  level: LevelEntry;
  onChange?: ((stepId: string, levelId: string, maxIterations: number) => void) | undefined;
  override: LevelOverride | undefined;
  step: StepDraft;
}) {
  const value = override?.review?.max_iterations ?? level.max_iterations ?? 1;
  return (
    <div className="mt-3 grid gap-1.5">
      <label
        htmlFor={`review-max-${step.id}-${level.id}`}
        className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground"
      >
        Max iterations
      </label>
      <Input
        id={`review-max-${step.id}-${level.id}`}
        type="number"
        min={1}
        value={value}
        onChange={(event) => {
          const next = Number.parseInt(event.target.value, 10);
          if (Number.isFinite(next) && next > 0) {
            onChange?.(step.id, level.id, next);
          }
        }}
        className="h-8 max-w-32 text-xs"
      />
    </div>
  );
}

function findTeam(
  registry: WorkflowGeneratorRegistry | null,
  teamId: string,
): TeamEntry | null {
  return registry?.teams.find((team) => team.id === teamId) ?? null;
}

function getStageTypeLabels(step: StepDraft, team: TeamEntry | null): string[] {
  const values = new Set<string>();
  for (const level of team?.levels ?? []) values.add(level.stage_type);
  for (const overrideLevel of Object.keys(step.runtime_overrides?.levels ?? {})) {
    if (!team?.level_ids.includes(overrideLevel)) values.add(overrideLevel);
  }
  return Array.from(values);
}

function describeActors(
  level: LevelEntry,
  override: LevelOverride | undefined,
): string {
  if (level.stage_type === "discussion") {
    const participants =
      override?.discussion?.participants ?? level.participants ?? [];
    return participants.length > 0
      ? `Participants: ${participants.map(formatTitle).join(", ")}`
      : "Participants not set";
  }
  if (level.stage_type === "chain") {
    return level.sequence?.length
      ? `Sequence: ${level.sequence.map(formatTitle).join(" -> ")}`
      : "Sequence not set";
  }
  if (level.stage_type === "review") {
    const actors = [level.producer, level.reviewer].filter(
      (actor): actor is string => Boolean(actor),
    );
    return actors.length
      ? `Review: ${actors.map(formatTitle).join(" -> ")}`
      : "Review actors not set";
  }
  if (level.stage_type === "broadcast") {
    return "Fan-out stage";
  }
  if (level.coordinator) return `Coordinator: ${formatTitle(level.coordinator)}`;
  return "Actors not set";
}

function describeStageControl(
  level: LevelEntry,
  override: LevelOverride | undefined,
): string {
  if (level.stage_type === "discussion") {
    const min = override?.discussion?.min_rounds ?? level.min_rounds;
    const max = override?.discussion?.max_rounds ?? level.max_rounds;
    const required =
      override?.discussion?.min_successful_participants ??
      level.min_successful_participants;
    return `Rounds: ${rangeValue(min, max)}${
      required ? `; required: ${required}` : ""
    }`;
  }
  if (level.stage_type === "review") {
    const iterations = override?.review?.max_iterations ?? level.max_iterations;
    return iterations
      ? `Max iterations: ${iterations}`
      : "Max iterations not set";
  }
  if (level.stage_type === "chain") return "Sequential handoff";
  if (level.stage_type === "pipeline") return "Task graph execution";
  if (level.stage_type === "broadcast") return "Parallel fan-out";
  return "Runtime controlled";
}

function rangeValue(
  min: number | undefined,
  max: number | undefined,
): string {
  if (min == null && max == null) return "not set";
  if (min === max) return String(min);
  return `${min ?? "?"}-${max ?? "?"}`;
}

function formatTitle(value: string): string {
  return formatDisplayName(value);
}

function formatArtifactTitle(value: string): string {
  const filename = value.split("/").pop() ?? value;
  return formatTitle(filename.replace(/\.[^.]+$/, ""));
}

export { StepPreviewCard, WorkflowStepsCard };
