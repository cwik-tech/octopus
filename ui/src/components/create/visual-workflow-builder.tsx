import { ChevronDown, Loader2, Plus, Trash2, UserRound } from "lucide-react";
import { useMemo, useState } from "react";

import { SidebarSearch } from "@/components/sidebar/sidebar-search";
import { WorkflowStageIcon } from "@/components/workflow/workflow-stage-icon";
import {
  WORKFLOW_STAGE_ICON_META,
  isWorkflowStageType,
  type WorkflowStageType,
} from "@/components/workflow/workflow-stage-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils/utils";
import { formatDisplayName } from "@/lib/utils/display-name";
import type {
  AgentEntry,
  StepDraft,
  TeamEntry,
  WorkflowDraft,
  WorkflowGeneratorRegistry,
} from "@/lib/models/workflow-generator-model";
import YamlPreview, {
  type YamlPreviewProps,
} from "@/components/create/yaml-preview";

type BuilderMode = "builder" | "yaml";
type AssigneeTab = "teams" | "agents";

interface VisualWorkflowBuilderProps {
  draft: WorkflowDraft | null;
  registry: WorkflowGeneratorRegistry | null;
  registryError?: string | null;
  onWorkflowTitleChange: (title: string) => void;
  onStepIdChange: (stepId: string, newId: string) => boolean;
  onStepTeamChange: (stepId: string, teamId: string) => void;
  onStepAgentChange: (stepId: string, teamId: string, agent: string) => void;
  onStepStageChange: (stepId: string, stageType: WorkflowStageType) => void;
  onConvertStepToHumanInput: (stepId: string) => void;
  onHumanInputPromptChange: (stepId: string, prompt: string) => void;
  onAddStep: () => void;
  onRemoveStep: (stepId: string) => void;
  onSaveWorkflow: () => void;
  saveDisabled?: boolean;
  yamlPreviewProps: YamlPreviewProps;
}

export default function VisualWorkflowBuilder({
  draft,
  registry,
  registryError,
  onWorkflowTitleChange,
  onStepIdChange,
  onStepTeamChange,
  onStepAgentChange,
  onStepStageChange,
  onConvertStepToHumanInput,
  onHumanInputPromptChange,
  onAddStep,
  onRemoveStep,
  onSaveWorkflow,
  saveDisabled = false,
  yamlPreviewProps,
}: VisualWorkflowBuilderProps) {
  const [mode, setMode] = useState<BuilderMode>("builder");

  if (mode === "yaml") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <BuilderHeader mode={mode} onModeChange={setMode} />
        <div className="min-h-0 flex-1 p-3">
          <YamlPreview {...yamlPreviewProps} className="h-full min-h-0" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <BuilderHeader mode={mode} onModeChange={setMode} />
      <div className="desktop-sidebar-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {!draft ? (
          <div className="flex h-full items-center justify-center px-4 text-center">
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                No workflow yet. Add a step to start building, or describe what
                you want in the chat.
              </p>
              <Button size="sm" onClick={onAddStep} className="gap-1.5">
                <Plus className="size-3.5" />
                Add first step
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            <WorkflowTitleField
              key={draft.id}
              workflowId={draft.id}
              onWorkflowTitleChange={onWorkflowTitleChange}
            />
            {draft.steps.map((step, index) => {
              const team = step.team ? findTeam(registry, step.team) : null;
              return (
                <div key={step.id}>
                  <BuilderStepCard
                    step={step}
                    stepIndex={index}
                    team={team}
                    registry={registry}
                    onStepIdChange={onStepIdChange}
                    onStepTeamChange={onStepTeamChange}
                    onStepAgentChange={onStepAgentChange}
                    onStepStageChange={onStepStageChange}
                    canConvertStepToHumanInput={
                      index > 0 && step.type !== "human-in-the-loop"
                    }
                    onConvertStepToHumanInput={onConvertStepToHumanInput}
                    onHumanInputPromptChange={onHumanInputPromptChange}
                    onRemove={onRemoveStep}
                  />
                  {index < draft.steps.length - 1 ? (
                    <div className="flex items-center py-1 pl-5 text-muted-foreground">
                      <ChevronDown className="size-3.5 rotate-0" />
                    </div>
                  ) : null}
                </div>
              );
            })}

            <div className="py-1 pl-5 text-muted-foreground">
              <ChevronDown className="size-3.5" />
            </div>

            <Button
              variant="outline"
              onClick={onAddStep}
              className="h-auto w-full border-dashed bg-transparent py-3 text-muted-foreground hover:border-primary hover:bg-transparent hover:text-primary-text"
            >
              <Plus />
              Add Step
            </Button>

            <div className="py-1 pl-5 text-muted-foreground">
              <ChevronDown className="size-3.5" />
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
      </div>

      <div className="shrink-0 border-t border-border/70 p-3">
        <Button
          className="w-full gap-1.5"
          onClick={onSaveWorkflow}
          disabled={!draft || saveDisabled}
        >
          {yamlPreviewProps.saving ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : null}
          Save Workflow
        </Button>
      </div>
    </div>
  );
}

function WorkflowTitleField({
  workflowId,
  onWorkflowTitleChange,
}: {
  workflowId: string;
  onWorkflowTitleChange: (title: string) => void;
}) {
  const [titleDraft, setTitleDraft] = useState(formatTitle(workflowId));

  const commitTitle = () => {
    const nextId = slugify(titleDraft);
    if (nextId && nextId !== workflowId) {
      onWorkflowTitleChange(nextId);
      return;
    }
    setTitleDraft(formatTitle(workflowId));
  };

  return (
    <div className="mb-3 rounded-lg border border-border/60 bg-card/80 px-3 py-2.5">
      <label
        htmlFor="workflow-title"
        className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground"
      >
        Title
      </label>
      <input
        id="workflow-title"
        aria-label="Workflow title"
        type="text"
        value={titleDraft}
        onChange={(event) => setTitleDraft(event.target.value)}
        onBlur={commitTitle}
        className="w-full rounded-sm border-none bg-transparent px-1.5 py-0.5 text-sm font-semibold text-foreground outline-none transition-colors hover:bg-muted focus:bg-background focus:ring-1 focus:ring-primary"
      />
    </div>
  );
}

function BuilderHeader({
  mode,
  onModeChange,
}: {
  mode: BuilderMode;
  onModeChange: (mode: BuilderMode) => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between border-b border-border/70 px-4 py-2.5">
      <span className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
        Visual Builder
      </span>
      <Tabs
        value={mode}
        onValueChange={(value) => onModeChange(value === "yaml" ? "yaml" : "builder")}
      >
        <TabsList aria-label="Builder mode" className="h-7">
          <TabsTrigger value="builder" className="px-2.5 text-xs">Builder</TabsTrigger>
          <TabsTrigger value="yaml" className="px-2.5 text-xs">YAML</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}

function BuilderStepCard({
  step,
  stepIndex,
  team,
  registry,
  onStepIdChange,
  onStepTeamChange,
  onStepAgentChange,
  onStepStageChange,
  canConvertStepToHumanInput,
  onConvertStepToHumanInput,
  onHumanInputPromptChange,
  onRemove,
}: {
  step: StepDraft;
  stepIndex: number;
  team: TeamEntry | null;
  registry: WorkflowGeneratorRegistry | null;
  onStepIdChange: (stepId: string, newId: string) => boolean;
  onStepTeamChange: (stepId: string, teamId: string) => void;
  onStepAgentChange: (stepId: string, teamId: string, agent: string) => void;
  onStepStageChange: (stepId: string, stageType: WorkflowStageType) => void;
  canConvertStepToHumanInput: boolean;
  onConvertStepToHumanInput: (stepId: string) => void;
  onHumanInputPromptChange: (stepId: string, prompt: string) => void;
  onRemove: (stepId: string) => void;
}) {
  const isHumanInput = step.type === "human-in-the-loop";
  const [expanded, setExpanded] = useState(true);
  const [assigneeTab, setAssigneeTab] = useState<AssigneeTab>("teams");
  const [searchQuery, setSearchQuery] = useState("");
  const [titleDraft, setTitleDraft] = useState(formatTitle(step.id));

  const activeStageTypes = useMemo(() => {
    const types = new Set<string>();
    for (const level of team?.levels ?? []) {
      if (isWorkflowStageType(level.stage_type)) {
        types.add(level.stage_type);
      }
    }
    return types;
  }, [team]);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border transition-colors",
        expanded
          ? "border-primary/35 bg-primary/[0.03]"
          : "border-border/60 bg-card/80",
      )}
    >
      <div
        className="flex cursor-pointer items-start justify-between gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40"
        onClick={() => setExpanded((e) => !e)}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {isHumanInput ? (
              <UserRound className="size-4.5 shrink-0 text-primary-text" aria-hidden />
            ) : step.stage_type || activeStageTypes.size > 0 ? (
              <span className="shrink-0 text-primary-text">
                <WorkflowStageIcon
                  type={
                    step.stage_type ??
                    (Array.from(activeStageTypes)[0] as WorkflowStageType)
                  }
                  decorative
                  className="size-4.5"
                />
              </span>
            ) : null}
            <input
              aria-label="Step name"
              type="text"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => {
                const newId = slugify(titleDraft);
                if (newId && newId !== step.id) {
                  if (!onStepIdChange(step.id, newId)) {
                    setTitleDraft(formatTitle(step.id));
                  }
                } else {
                  setTitleDraft(formatTitle(step.id));
                }
              }}
              onClick={(e) => e.stopPropagation()}
              className="min-w-0 flex-1 rounded-sm border-none bg-transparent px-1.5 py-0.5 text-sm font-semibold text-foreground outline-none transition-colors hover:bg-muted focus:bg-card focus:ring-1 focus:ring-primary"
            />
          </div>
          {isHumanInput ? (
            <div className="mt-1 text-xs text-muted-foreground">
              Human-in-the-loop boundary
            </div>
          ) : step.type === "agent" && step.agent ? (
            <div className="mt-1 text-xs text-muted-foreground">
              Agent: {formatTitle(step.agent)}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Remove step"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(step.id);
            }}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-3" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={expanded ? "Collapse" : "Expand"}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((e) => !e);
            }}
            className="text-muted-foreground"
          >
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform",
                !expanded && "-rotate-90",
              )}
            />
          </Button>
        </div>
      </div>

      {expanded ? (
        <div className="space-y-3 border-t border-border/50 px-3 py-3">
          {isHumanInput ? (
            <div>
              <label
                htmlFor={`human-input-prompt-${step.id}`}
                className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground"
              >
                Human-in-the-loop prompt
              </label>
              <Textarea
                id={`human-input-prompt-${step.id}`}
                aria-label="Human-in-the-loop prompt"
                value={step.prompt ?? ""}
                onChange={(event) =>
                  onHumanInputPromptChange(step.id, event.target.value)
                }
                rows={3}
              />
            </div>
          ) : (
            <>
              <StageTypePicker
                selectedFilter={step.stage_type ?? null}
                activeTypes={activeStageTypes}
                onSelectFilter={(stageType) =>
                  onStepStageChange(step.id, stageType)
                }
                canSetHumanInput={canConvertStepToHumanInput}
                stepNumber={stepIndex + 1}
                onSetHumanInput={() => onConvertStepToHumanInput(step.id)}
              />
              <AssigneeSelector
                tab={assigneeTab}
                onTabChange={setAssigneeTab}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                registry={registry}
                selectedTeamId={step.team ?? ""}
                selectedAgentName={step.type === "agent" ? step.agent : undefined}
                stageFilter={step.stage_type ?? null}
                onSelectTeam={(teamId) => onStepTeamChange(step.id, teamId)}
                onSelectAgent={(teamId, agent) =>
                  onStepAgentChange(step.id, teamId, agent)
                }
              />
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function StageTypePicker({
  selectedFilter,
  activeTypes,
  onSelectFilter,
  canSetHumanInput,
  stepNumber,
  onSetHumanInput,
}: {
  selectedFilter: WorkflowStageType | null;
  activeTypes: Set<string>;
  onSelectFilter: (type: WorkflowStageType) => void;
  canSetHumanInput: boolean;
  stepNumber: number;
  onSetHumanInput: () => void;
}) {
  const stageTypes = Object.keys(WORKFLOW_STAGE_ICON_META) as WorkflowStageType[];

  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Stage Type
      </div>
      <TooltipProvider>
        <div className="grid grid-cols-3 gap-1.5">
          {stageTypes.map((type) => {
            const meta = WORKFLOW_STAGE_ICON_META[type];
            const isSelected = selectedFilter === type;
            const isActive = activeTypes.has(type);
            return (
              <Tooltip key={type}>
                <TooltipTrigger
                  type="button"
                  onClick={() => onSelectFilter(type)}
                  className={cn(
                    "relative flex flex-col items-center rounded-lg border-2 px-1 py-2 transition-all",
                    isSelected
                      ? "border-primary bg-primary/[0.08]"
                      : isActive
                        ? "border-primary/30 bg-primary/[0.04]"
                        : "border-border bg-background hover:border-muted-foreground hover:bg-muted",
                  )}
                >
                  <WorkflowStageIcon
                    type={type}
                    decorative
                    className={cn(
                      "mb-1 size-6.5",
                      isSelected || isActive
                        ? "text-primary-text"
                        : "text-muted-foreground",
                    )}
                  />
                  <span className="text-xs font-medium text-foreground">
                    {meta.label}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-50">
                  <div>
                    <div className="font-semibold">{meta.label}</div>
                    <div className="text-muted-foreground">{meta.description}</div>
                  </div>
                </TooltipContent>
              </Tooltip>
            );
          })}
          {canSetHumanInput ? (
            <Tooltip>
              <TooltipTrigger
                type="button"
                aria-label={`Set Step ${stepNumber} type to human-in-the-loop`}
                onClick={onSetHumanInput}
                className="relative flex flex-col items-center rounded-lg border-2 border-border bg-background px-1 py-2 transition-all hover:border-muted-foreground hover:bg-muted"
              >
                <UserRound
                  className="mb-1 size-6.5 text-muted-foreground"
                  aria-hidden
                />
                <span className="text-center text-xs font-medium text-foreground">
                  Human-in-the-loop
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-50">
                <div>
                  <div className="font-semibold">Human-in-the-loop</div>
                  <div className="text-muted-foreground">
                    Make this step a human feedback boundary.
                  </div>
                </div>
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </TooltipProvider>
    </div>
  );
}

function AssigneeSelector({
  tab,
  onTabChange,
  searchQuery,
  onSearchChange,
  registry,
  selectedTeamId,
  selectedAgentName,
  stageFilter,
  onSelectTeam,
  onSelectAgent,
}: {
  tab: AssigneeTab;
  onTabChange: (tab: AssigneeTab) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  registry: WorkflowGeneratorRegistry | null;
  selectedTeamId: string;
  selectedAgentName?: string | undefined;
  stageFilter: WorkflowStageType | null;
  onSelectTeam: (teamId: string) => void;
  onSelectAgent: (teamId: string, agent: string) => void;
}) {
  const filteredTeams = useMemo(() => {
    let teams = registry?.teams ?? [];
    if (stageFilter) {
      teams = teams.filter((t) =>
        t.levels?.some((l) => l.stage_type === stageFilter),
      );
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      teams = teams.filter(
        (t) =>
          t.id.toLowerCase().includes(q) ||
          t.description?.toLowerCase().includes(q),
      );
    }
    return teams;
  }, [registry, stageFilter, searchQuery]);

  const allAgents = useMemo(() => {
    const agents: Array<{ agent: AgentEntry; teamId: string }> = [];
    for (const team of registry?.teams ?? []) {
      for (const agent of team.agents ?? []) {
        agents.push({ agent, teamId: team.id });
      }
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      return agents.filter(
        ({ agent, teamId }) =>
          agent.name.toLowerCase().includes(q) ||
          agent.role?.toLowerCase().includes(q) ||
          teamId.toLowerCase().includes(q),
      );
    }
    return agents;
  }, [registry, searchQuery]);

  return (
    <div>
      <div className="flex items-center gap-2">
        <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Assignee
        </div>
      </div>

      <div className="mt-1.5 flex items-center gap-1 border-b border-border">
        <Tabs
          value={tab}
          onValueChange={(value) => onTabChange(value === "agents" ? "agents" : "teams")}
        >
          <TabsList variant="line" aria-label="Assignee kind" className="h-auto gap-1 p-0">
            <TabsTrigger value="teams" className="h-auto flex-none px-3 py-1.5 text-xs">
              Teams
            </TabsTrigger>
            <TabsTrigger value="agents" className="h-auto flex-none px-3 py-1.5 text-xs">
              Agents
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <SidebarSearch
          label={tab === "teams" ? "teams" : "agents"}
          onSearch={onSearchChange}
        />
      </div>

      <div className="mt-2 max-h-70 space-y-1 overflow-y-auto">
        {tab === "teams"
          ? filteredTeams.map((team) => (
              <AssigneeItem
                key={team.id}
                name={formatTitle(team.id)}
                description={team.description}
                selected={team.id === selectedTeamId}
                badges={getTeamStageBadges(team)}
                onSelect={() => onSelectTeam(team.id)}
              />
            ))
          : allAgents.map(({ agent, teamId }) => (
              <AssigneeItem
                key={`${teamId}:${agent.name}`}
                name={formatTitle(agent.name)}
                description={`${agent.role} · ${formatTitle(teamId)}`}
                selected={
                  agent.name === selectedAgentName && teamId === selectedTeamId
                }
                onSelect={() => onSelectAgent(teamId, agent.name)}
              />
            ))}
        {tab === "teams" && filteredTeams.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
            No teams found.
          </div>
        ) : null}
        {tab === "agents" && allAgents.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
            No agents found.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AssigneeItem({
  name,
  description,
  selected,
  badges,
  onSelect,
}: {
  name: string;
  description?: string | undefined;
  selected: boolean;
  badges?: string[];
  onSelect: () => void;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onSelect}
      className={cn(
        "h-auto w-full justify-start gap-2.5 border px-2.5 py-2 text-left",
        selected
          ? "border-primary bg-primary/8 hover:bg-primary/8"
          : "border-border/60 bg-background hover:border-muted-foreground hover:bg-muted",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground">
            {name}
          </div>
          {description ? (
            <div className="truncate text-xs text-muted-foreground">
              {description}
            </div>
          ) : null}
        </div>
        {badges && badges.length > 0 ? (
          <div className="flex shrink-0 gap-1">
            {badges.slice(0, 2).map((badge) =>
              isWorkflowStageType(badge) ? (
                <Badge key={badge} variant="outline" className="gap-1 px-1.5 py-0 text-xs">
                  <WorkflowStageIcon type={badge} decorative className="size-2.5" />
                  {badge}
                </Badge>
              ) : null,
            )}
          </div>
        ) : null}
      </div>
      {selected ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-4.5 shrink-0 text-primary-text"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : null}
    </Button>
  );
}

function findTeam(
  registry: WorkflowGeneratorRegistry | null,
  teamId: string,
): TeamEntry | null {
  return registry?.teams.find((t) => t.id === teamId) ?? null;
}

function getTeamStageBadges(team: TeamEntry): string[] {
  const types = new Set<string>();
  for (const level of team.levels ?? []) {
    types.add(level.stage_type);
  }
  return Array.from(types);
}

function formatTitle(value: string): string {
  return formatDisplayName(value);
}

function formatArtifactTitle(value: string): string {
  const filename = value.split("/").pop() ?? value;
  return formatTitle(filename.replace(/\.[^.]+$/, ""));
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
