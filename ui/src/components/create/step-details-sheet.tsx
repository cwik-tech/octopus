import {
  ArrowRight,
  FolderOpen,
  Users,
} from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { toast } from "sonner";

import WorkflowDiagram from "@/components/create/workflow-diagram";
import { formatDisplayName } from "@/lib/utils/display-name";
import { Badge } from "@/components/ui/badge";
import { ResizableRightSheetContent } from "@/components/ui/resizable-right-sheet";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { revealGeneratorArtifact } from "@/lib/clients/workflow-generator-client";
import type {
  AgentEntry,
  LevelEntry,
  LevelOverride,
  StepDraft,
  TeamEntry,
  WorkflowDraft,
  WorkflowGeneratorRegistry,
} from "@/lib/models/workflow-generator-model";

interface StepDetailsSheetProps {
  draft: WorkflowDraft | null;
  open: boolean;
  registry: WorkflowGeneratorRegistry | null;
  registryError: string | null;
  selectedStepId?: string | null;
  loading?: boolean;
  previewError?: string | null;
  onOpenChange: (open: boolean) => void;
}

function StepDetailsSheet({
  draft,
  open,
  registry,
  registryError,
  selectedStepId,
  loading = false,
  previewError,
  onOpenChange,
}: StepDetailsSheetProps) {
  const selected = findSelectedStep(draft, selectedStepId);
  const step = selected?.step ?? null;
  const selectedIndex = selected?.index ?? -1;
  const team = step
    ? registry?.teams.find((entry) => entry.id === step.team) ?? null
    : null;
  const handleRevealArtifact = async (artifactPath: string) => {
    try {
      await revealGeneratorArtifact({ artifactPath });
      toast.success("Opened file location", {
        description: artifactPath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missingArtifact = message.includes("Artifact file does not exist yet");
      toast.error(
        missingArtifact ? "Artifact has not been created yet" : "Could not open file location",
        {
          description: missingArtifact ? artifactPath : message,
        },
      );
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <ResizableRightSheetContent
        defaultWidth={672}
        open={open}
        resizeLabel="Resize workflow details sheet"
      >
        <SheetHeader>
          <SheetTitle>
            {step
              ? `Step ${humanizeStepName(step.id)}`
              : draft
                ? `Workflow ${formatDisplayName(draft.id)}`
                : "Workflow preview"}
          </SheetTitle>
          <SheetDescription>
            {step
              ? step.type === "human-in-the-loop"
                ? step.prompt ?? "Human feedback boundary"
                : team?.description ?? formatDisplayName(step.team ?? "Unassigned")
              : draft?.description ?? "Select a workflow to inspect."}
          </SheetDescription>
        </SheetHeader>

        {loading ? (
          <div className="flex flex-1 items-center justify-center px-5 text-sm text-muted-foreground">
            Loading workflow preview...
          </div>
        ) : previewError && !draft ? (
          <div className="flex flex-1 items-center justify-center px-5 text-sm text-destructive">
            Failed to load workflow preview: {previewError}
          </div>
        ) : !draft ? (
          <div className="flex flex-1 items-center justify-center px-5 text-sm text-muted-foreground">
            No workflow selected.
          </div>
        ) : !step ? (
          <WorkflowDetailsContent
            draft={draft}
            registry={registry}
            registryError={registryError}
            onRevealArtifact={handleRevealArtifact}
          />
        ) : (
          <Tabs defaultValue="overview" className="min-h-0 flex-1 px-5 py-4">
            <TabsList variant="line" className="w-full justify-start">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              {step.type !== "human-in-the-loop" ? (
                <TabsTrigger value="agents">Agents</TabsTrigger>
              ) : null}
              <TabsTrigger value="artifacts">Artifact Flow</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="min-h-0 overflow-y-auto pt-4">
              <OverviewTab
                draft={draft}
                index={selectedIndex}
                step={step}
                team={team}
                onRevealArtifact={handleRevealArtifact}
              />
            </TabsContent>

            {step.type !== "human-in-the-loop" ? (
              <TabsContent
                value="agents"
                className="min-h-0 overflow-y-auto pt-4"
              >
                <AgentsTab
                  registryError={registryError}
                  step={step}
                  team={team}
                  onRevealArtifact={handleRevealArtifact}
                />
              </TabsContent>
            ) : null}

            <TabsContent value="artifacts" className="min-h-0 overflow-y-auto pt-4">
              <ArtifactsTab
                draft={draft}
                index={selectedIndex}
                step={step}
                onRevealArtifact={handleRevealArtifact}
              />
            </TabsContent>
          </Tabs>
        )}
      </ResizableRightSheetContent>
    </Sheet>
  );
}

function WorkflowDetailsContent({
  draft,
  registry,
  registryError,
  onRevealArtifact,
}: {
  draft: WorkflowDraft;
  registry: WorkflowGeneratorRegistry | null;
  registryError: string | null;
  onRevealArtifact: (artifactPath: string) => void | Promise<void>;
}) {
  return (
    <Tabs defaultValue="overview" className="min-h-0 flex-1 px-5 py-4">
      <TabsList variant="line" className="w-full justify-start">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="agents">Agents</TabsTrigger>
        <TabsTrigger value="artifacts">Artifact Flow</TabsTrigger>
      </TabsList>

      <TabsContent value="overview" className="min-h-0 overflow-y-auto pt-4">
        <WorkflowOverviewTab draft={draft} registry={registry} />
      </TabsContent>

      <TabsContent value="agents" className="min-h-0 overflow-y-auto pt-4">
        <WorkflowAgentsTab
          draft={draft}
          registry={registry}
          registryError={registryError}
          onRevealArtifact={onRevealArtifact}
        />
      </TabsContent>

      <TabsContent value="artifacts" className="min-h-0 overflow-y-auto pt-4">
        <WorkflowArtifactsTab draft={draft} onRevealArtifact={onRevealArtifact} />
      </TabsContent>
    </Tabs>
  );
}

function WorkflowOverviewTab({
  draft,
  registry,
}: {
  draft: WorkflowDraft;
  registry: WorkflowGeneratorRegistry | null;
}) {
  return (
    <div className="space-y-4">
      <Section title="Flow" icon={<ArrowRight className="size-4" />}>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          {describeWorkflowFlow(draft, registry)}
        </p>
        <WorkflowDiagram
          source={buildWorkflowOverviewMermaid(draft, registry)}
          steps={draft.steps}
          className="min-h-65"
        />
      </Section>

      <Section title="Workflow" icon={<Users className="size-4" />}>
        <FieldGrid
          fields={[
            ["Name", draft.id],
            ["Steps", String(draft.steps.length)],
            ["Input", draft.input.artifact],
            ["Output", draft.output.artifact],
          ]}
        />
        {draft.matches && draft.matches.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {draft.matches.map((match) => (
              <Badge key={match} variant="outline">
                {match}
              </Badge>
            ))}
          </div>
        ) : null}
      </Section>
    </div>
  );
}

function OverviewTab({
  draft,
  index,
  onRevealArtifact,
  step,
  team,
}: {
  draft: WorkflowDraft | null;
  index: number;
  onRevealArtifact: (artifactPath: string) => void | Promise<void>;
  step: StepDraft;
  team: TeamEntry | null;
}) {
  const isFinalOutput = draft?.output.from_step === step.id;
  const diagram = buildStepOverviewMermaid(step, team);

  return (
    <div className="space-y-4">
      <Section title="Flow" icon={<ArrowRight className="size-4" />}>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          {describeStepFlow(step, team)}
        </p>
        <WorkflowDiagram
          source={diagram}
          className="min-h-60"
        />
      </Section>

      {step.type === "human-in-the-loop" ? (
        <Section title="Human-in-the-loop" icon={<Users className="size-4" />}>
          <FieldGrid
            fields={[
              ["Step type", "human-in-the-loop"],
              ["Prompt", step.prompt ?? "Review the previous result."],
            ]}
          />
        </Section>
      ) : team ? (
        <Section title="Team" icon={<Users className="size-4" />}>
          <FieldGrid
            fields={[
              ["Team name", step.team ?? team.id],
              ["Step type", step.type],
            ]}
          />
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            {team.description ?? "No team description registered."}
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {(team.tags ?? []).map((tag) => (
              <Badge key={tag} variant="outline">
                {tag}
              </Badge>
            ))}
          </div>
        </Section>
      ) : (
        <Notice tone="warning">
          Team metadata is unavailable. The workflow may reference an unknown team
          or the registry failed to load.
        </Notice>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <KeyValue
          label="Input file"
          value={step.input_artifact}
          onReveal={() => onRevealArtifact(step.input_artifact)}
        />
        <KeyValue
          label="Result file"
          value={step.result_artifact}
          onReveal={() => onRevealArtifact(step.result_artifact)}
        />
        <KeyValue
          label="Position"
          value={`${index + 1} of ${draft?.steps.length ?? 0}`}
        />
        <KeyValue label="Final output" value={isFinalOutput ? "Yes" : "No"} />
      </div>

      {step.handoff ? (
        <Section title="Handoff" icon={<ArrowRight className="size-4" />}>
          <FlowLine
            from={`${step.handoff.from_step}: ${step.handoff.from_artifact}`}
            to={step.handoff.to_artifact}
          />
        </Section>
      ) : index > 0 ? (
        <Notice tone="warning">
          This chained step has no explicit handoff block.
        </Notice>
      ) : null}
    </div>
  );
}

function AgentsTab({
  registryError,
  step,
  team,
  onRevealArtifact,
}: {
  registryError: string | null;
  step: StepDraft;
  team: TeamEntry | null;
  onRevealArtifact: (artifactPath: string) => void | Promise<void>;
}) {
  if (registryError) {
    return <Notice tone="warning">Failed to load team registry: {registryError}</Notice>;
  }

  if (!team) {
    return (
      <Notice tone="warning">
        No registered team metadata for <code>{step.team}</code>.
      </Notice>
    );
  }

  const activeNames = getActiveAgentNames(step, team);
  const activeAgents = team.agents.filter((agent) => activeNames.has(agent.name));
  const availableAgents = team.agents.filter((agent) => !activeNames.has(agent.name));

  return (
    <div className="space-y-4">
      <Section title="Active in this step" icon={<Users className="size-4" />}>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          These agents are selected by this workflow step through discussion
          participants, chain sequence, or review producer/reviewer settings.
        </p>
        {activeAgents.length > 0 ? (
          <AgentList agents={activeAgents} onRevealArtifact={onRevealArtifact} />
        ) : (
          <Notice tone="warning">
            No active agents could be inferred from this step configuration.
          </Notice>
        )}
      </Section>

      <Section title="Available on this team" icon={<Users className="size-4" />}>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          These agents belong to the team but are not explicitly selected by the
          current workflow step.
        </p>
        {availableAgents.length > 0 ? (
          <AgentList agents={availableAgents} onRevealArtifact={onRevealArtifact} />
        ) : (
          <div className="text-sm text-muted-foreground">
            All registered team agents are active in this step.
          </div>
        )}
      </Section>
    </div>
  );
}

function WorkflowAgentsTab({
  draft,
  registry,
  registryError,
  onRevealArtifact,
}: {
  draft: WorkflowDraft;
  registry: WorkflowGeneratorRegistry | null;
  registryError: string | null;
  onRevealArtifact: (artifactPath: string) => void | Promise<void>;
}) {
  if (registryError) {
    return <Notice tone="warning">Failed to load team registry: {registryError}</Notice>;
  }

  return (
    <div className="space-y-4">
      {draft.steps.filter((step) => step.type !== "human-in-the-loop").map((step) => {
        const team = registry?.teams.find((entry) => entry.id === step.team) ?? null;
        const activeNames = team ? getActiveAgentNames(step, team) : new Set<string>();
        const agents = team?.agents.filter((agent) => activeNames.has(agent.name)) ?? [];

        return (
          <Section
            key={step.id}
            title={`${formatDisplayName(step.id)} · ${formatDisplayName(step.team ?? "Unassigned")}`}
            icon={<Users className="size-4" />}
          >
            {team ? (
              <>
                <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
                  {team.description ?? "No team description registered."}
                </p>
                {agents.length > 0 ? (
                  <AgentList agents={agents} onRevealArtifact={onRevealArtifact} />
                ) : (
                  <Notice tone="warning">
                    No active agents could be inferred from this step configuration.
                  </Notice>
                )}
              </>
            ) : (
              <Notice tone="warning">
                No registered team metadata for{" "}
                <code>{formatDisplayName(step.team ?? "Unassigned")}</code>.
              </Notice>
            )}
          </Section>
        );
      })}
    </div>
  );
}

function AgentList({
  agents,
  onRevealArtifact,
}: {
  agents: AgentEntry[];
  onRevealArtifact: (artifactPath: string) => void | Promise<void>;
}) {
  return (
    <div className="space-y-2">
      {agents.map((agent) => (
        <Button
          key={agent.name}
          variant="ghost"
          disabled={!agent.agent_file}
          onClick={() => {
            if (agent.agent_file) void onRevealArtifact(agent.agent_file);
          }}
          className="h-auto w-full flex-col items-stretch gap-0 border border-border/60 bg-muted/20 px-3 py-2 text-left font-normal hover:bg-muted/45 disabled:cursor-default disabled:opacity-100"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              {formatDisplayName(agent.name)}
            </span>
            {agent.agent_file ? (
              <span className="ml-auto flex items-center gap-1 font-mono text-xs text-muted-foreground">
                <FolderOpen className="size-3.5" />
                {agent.agent_file}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {agent.role || "No role description registered."}
          </p>
        </Button>
      ))}
    </div>
  );
}

function WorkflowArtifactsTab({
  draft,
  onRevealArtifact,
}: {
  draft: WorkflowDraft;
  onRevealArtifact: (artifactPath: string) => void | Promise<void>;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-muted-foreground">
        This follows files from the workflow input through each step and onward
        to the final workflow output.
      </p>
      <div className="space-y-0">
        <ArtifactFlowItem
          label="Workflow starts with"
          value={draft.input.artifact}
          onReveal={() => onRevealArtifact(draft.input.artifact)}
        />
        {draft.steps.map((step, index) => (
          <Fragment key={step.id}>
            <ArtifactFlowConnector label={index === 0 ? "first step input" : "next step input"} />
            <ArtifactFlowItem
              label={`${formatDisplayName(step.id)} receives`}
              value={step.input_artifact}
              onReveal={() => onRevealArtifact(step.input_artifact)}
            />
            <ArtifactFlowConnector />
            <ArtifactFlowItem
              label={`${formatDisplayName(step.id)} produces`}
              value={step.result_artifact}
              onReveal={() => onRevealArtifact(step.result_artifact)}
            />
          </Fragment>
        ))}
        <ArtifactFlowConnector label="workflow output" />
        <ArtifactFlowItem
          label="Final output"
          value={draft.output.artifact}
          onReveal={() => onRevealArtifact(draft.output.artifact)}
        />
      </div>
    </div>
  );
}

function ArtifactsTab({
  draft,
  index,
  onRevealArtifact,
  step,
}: {
  draft: WorkflowDraft | null;
  index: number;
  onRevealArtifact: (artifactPath: string) => void | Promise<void>;
  step: StepDraft;
}) {
  const previousStep = draft?.steps[index - 1] ?? null;
  const nextStep = draft?.steps[index + 1] ?? null;
  const isFinalOutput = draft?.output.from_step === step.id;
  const workflowOutput = draft?.output.artifact ?? step.result_artifact;
  const handoff = step.handoff;

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
          This follows the files into this step, through this step, and onward
          to the next step or final workflow output.
        </p>
        <div className="space-y-0">
          <ArtifactFlowItem
            label="Workflow starts with"
            value={draft?.input.artifact ?? "Not set"}
            onReveal={
              draft?.input.artifact
                ? () => onRevealArtifact(draft.input.artifact)
                : undefined
            }
          />
          {handoff ? (
            <>
              <ArtifactFlowConnector />
              <ArtifactFlowItem
                label={`${formatDisplayName(handoff.from_step)} produces`}
                value={handoff.from_artifact}
                onReveal={() => onRevealArtifact(handoff.from_artifact)}
              />
              <ArtifactFlowConnector label="handoff as" />
              <ArtifactFlowItem
                label={`${formatDisplayName(step.id)} receives`}
                value={handoff.to_artifact}
                onReveal={() => onRevealArtifact(handoff.to_artifact)}
              />
            </>
          ) : previousStep ? (
            <>
              <ArtifactFlowConnector />
              <ArtifactFlowItem
                label={`${formatDisplayName(previousStep.id)} produces`}
                value={previousStep.result_artifact}
                onReveal={() => onRevealArtifact(previousStep.result_artifact)}
              />
              <ArtifactFlowConnector label="inferred input" />
              <ArtifactFlowItem
                label={`${formatDisplayName(step.id)} receives`}
                value={step.input_artifact}
                onReveal={() => onRevealArtifact(step.input_artifact)}
              />
            </>
          ) : (
            <>
              <ArtifactFlowConnector />
              <ArtifactFlowItem
                label={`${formatDisplayName(step.id)} receives`}
                value={step.input_artifact}
                onReveal={() => onRevealArtifact(step.input_artifact)}
              />
            </>
          )}

          <ArtifactFlowConnector />
          <ArtifactFlowItem
            label={`${formatDisplayName(step.id)} produces`}
            value={step.result_artifact}
            onReveal={() => onRevealArtifact(step.result_artifact)}
          />

          {nextStep ? (
            <>
              <ArtifactFlowConnector label="next step input" />
              <ArtifactFlowItem
                label={`${formatDisplayName(nextStep.id)} receives`}
                value={nextStep.input_artifact}
                onReveal={() => onRevealArtifact(nextStep.input_artifact)}
              />
            </>
          ) : isFinalOutput ? (
            <>
              <ArtifactFlowConnector label="workflow output" />
              <ArtifactFlowItem
                label="Final output"
                value={workflowOutput}
                onReveal={() => onRevealArtifact(workflowOutput)}
              />
            </>
          ) : null}
        </div>
      </div>

      {step.handoff ? (
        <Section title="Handoff Rule" icon={<ArrowRight className="size-4" />}>
          <p className="text-sm leading-relaxed text-muted-foreground">
            <code className="font-mono text-foreground">
              {step.handoff.from_artifact}
            </code>{" "}
            from <code className="font-mono text-foreground">{step.handoff.from_step}</code>{" "}
            is passed into <code className="font-mono text-foreground">{step.id}</code>{" "}
            as <code className="font-mono text-foreground">{step.handoff.to_artifact}</code>.
          </p>
        </Section>
      ) : index > 0 ? (
        <Notice tone="warning">
          The prior result may not be wired into this step because no handoff is
          defined.
        </Notice>
      ) : null}
    </div>
  );
}

function ArtifactFlowItem({
  label,
  onReveal,
  value,
}: {
  label: string;
  onReveal?: (() => void | Promise<void>) | undefined;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
      <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1">
        <ArtifactPill path={value} onReveal={onReveal} />
      </div>
    </div>
  );
}

function ArtifactFlowConnector({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-1 pl-4 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
      <div className="h-5 w-px bg-border" />
      <ArrowRight className="size-3.5 rotate-90" />
      {label ? <span>{label}</span> : null}
    </div>
  );
}

function FieldGrid({ fields }: { fields: Array<[string, string]> }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {fields.map(([label, value]) => (
        <KeyValue key={label} label={label} value={value} />
      ))}
    </div>
  );
}

function KeyValue({
  label,
  onReveal,
  value,
}: {
  label: string;
  onReveal?: () => void | Promise<void>;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
      <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      {onReveal ? (
        <Button
          variant="link"
          onClick={() => void onReveal()}
          className="mt-1 h-auto min-w-0 justify-start gap-1.5 p-0 font-mono text-xs text-foreground no-underline"
        >
          <FolderOpen className="text-muted-foreground" />
          <span className="min-w-0 break-all">{value}</span>
        </Button>
      ) : (
        <div className="mt-1 break-words font-mono text-xs text-foreground">
          {value}
        </div>
      )}
    </div>
  );
}

function FlowLine({
  from,
  onRevealFrom,
  onRevealTo,
  to,
}: {
  from: string;
  onRevealFrom?: () => void | Promise<void>;
  onRevealTo?: () => void | Promise<void>;
  to: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs">
      <ArtifactPill path={from} onReveal={onRevealFrom} />
      <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
      <ArtifactPill path={to} onReveal={onRevealTo} />
    </div>
  );
}

function ArtifactPill({
  onReveal,
  path,
}: {
  onReveal?: (() => void | Promise<void>) | undefined;
  path: string;
}) {
  const className =
    "min-w-0 flex-1 break-words rounded-md bg-muted px-2 py-1 font-mono text-foreground";
  if (!onReveal) {
    return <code className={className}>{path}</code>;
  }
  return (
    <Button
      variant="link"
      onClick={() => void onReveal()}
      className={`${className} h-auto justify-start gap-1.5 p-0 text-left no-underline`}
    >
      <FolderOpen className="text-muted-foreground" />
      <span className="min-w-0 break-all">{path}</span>
    </Button>
  );
}

function Section({
  children,
  icon,
  title,
}: {
  children: ReactNode;
  icon: ReactNode;
  title: string;
}) {
  return (
    <section className="rounded-lg border border-border/60 bg-background/70 p-3">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
        <span className="text-muted-foreground">{icon}</span>
        {title}
      </div>
      {children}
    </section>
  );
}

function Notice({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "warning";
}) {
  return (
    <div
      className={[
        "rounded-lg border px-3 py-2 text-sm",
        tone === "warning"
          ? "border-amber-500/30 bg-amber-500/8 text-amber-700"
          : "",
      ].join(" ")}
    >
      {children}
    </div>
  );
}

function findSelectedStep(
  draft: WorkflowDraft | null,
  selectedStepId: string | null | undefined,
): { step: StepDraft; index: number } | null {
  if (!draft || !selectedStepId) return null;
  const index = draft.steps.findIndex((step) => step.id === selectedStepId);
  if (index < 0) return null;
  const step = draft.steps[index];
  return step === undefined ? null : { step, index };
}

function getActiveAgentNames(step: StepDraft, team: TeamEntry): Set<string> {
  const active = new Set<string>();
  for (const level of team.levels ?? []) {
    const override = step.runtime_overrides?.levels?.[level.id];
    const participants = override?.discussion?.participants ?? level.participants ?? [];
    for (const participant of participants) active.add(participant);
    for (const agent of level.sequence ?? []) active.add(agent);
    if (level.coordinator) active.add(level.coordinator);
    if (level.producer) active.add(level.producer);
    if (level.reviewer) active.add(level.reviewer);
  }
  return active;
}

function describeWorkflowFlow(
  draft: WorkflowDraft,
  registry: WorkflowGeneratorRegistry | null,
): string {
  const stepNames = draft.steps
    .map((step) => formatDisplayName(step.id))
    .join(", then ");
  const loops = draft.steps
    .map((step) => {
      const team = registry?.teams.find((entry) => entry.id === step.team) ?? null;
      return team ? describeTeamLoop(step, team) : null;
    })
    .filter(Boolean);

  const loopText =
    loops.length > 0
      ? ` Feedback loops are shown on the step that owns them: ${loops.join("; ")}.`
      : "";

  return `This workflow runs ${draft.steps.length} step${draft.steps.length === 1 ? "" : "s"}: ${stepNames || "no steps"}.${loopText}`;
}

function describeStepFlow(step: StepDraft, team: TeamEntry | null): string {
  if (step.type === "human-in-the-loop") {
    return `This step pauses the workflow for human feedback and writes ${step.result_artifact}.`;
  }
  if (!team) {
    return `This step invokes ${formatDisplayName(step.team ?? "Unassigned")} and writes ${step.result_artifact}. Team flow metadata is unavailable.`;
  }
  const levels = team.levels ?? [];
  const levelNames = levels.map((level) =>
    formatDisplayName(level.name ?? level.id)
  );
  const loop = describeTeamLoop(step, team);
  return `This step invokes ${formatDisplayName(step.team ?? team.id)}${levelNames.length > 0 ? ` through ${levelNames.join(", then ")}` : ""} and writes ${step.result_artifact}.${loop ? ` ${loop}.` : ""}`;
}

function buildWorkflowOverviewMermaid(
  draft: WorkflowDraft,
  registry: WorkflowGeneratorRegistry | null,
): string {
  const lines = [
    "flowchart LR",
    `  start(["Input<br/>${mermaidLabel(draft.input.artifact)}"])`,
  ];

  let previousNode = "start";
  draft.steps.forEach((step, index) => {
    const nodeId = mermaidNodeId(`step_${step.id}_${index}`);
    const team = registry?.teams.find((entry) => entry.id === step.team) ?? null;
    lines.push(
      `  ${nodeId}["${mermaidLabel(formatDisplayName(step.id))}<br/>${mermaidLabel(step.type === "human-in-the-loop" ? "Human-in-the-loop" : formatDisplayName(step.team ?? "Unassigned"))}"]`,
      `  ${previousNode} -->|${mermaidLabel(step.input_artifact)}| ${nodeId}`,
    );
    const loop = describeTeamLoop(step, team);
    if (loop) {
      lines.push(`  ${nodeId} -. "${mermaidLabel(loop)}" .-> ${nodeId}`);
    }
    previousNode = nodeId;
  });

  lines.push(
    `  finish(["Output<br/>${mermaidLabel(draft.output.artifact)}"])`,
    `  ${previousNode} -->|${mermaidLabel(draft.output.artifact)}| finish`,
  );

  return lines.join("\n");
}

function buildStepOverviewMermaid(step: StepDraft, team: TeamEntry | null): string {
  const levels = team?.levels ?? [];
  const lines = [
    "flowchart LR",
    `  input(["Receives<br/>${mermaidLabel(step.input_artifact)}"])`,
  ];

  if (step.type === "human-in-the-loop") {
    lines.push(
      `  work["${mermaidLabel(formatDisplayName(step.id))}<br/>Human-in-the-loop"]`,
      "  input --> work",
      `  output(["Produces<br/>${mermaidLabel(step.result_artifact)}"])`,
      "  work --> output",
    );
    return lines.join("\n");
  }

  if (levels.length === 0) {
    lines.push(
      `  work["${mermaidLabel(formatDisplayName(step.id))}<br/>${mermaidLabel(formatDisplayName(step.team ?? "Unassigned"))}"]`,
      "  input --> work",
      `  output(["Produces<br/>${mermaidLabel(step.result_artifact)}"])`,
      "  work --> output",
    );
    return lines.join("\n");
  }

  let previousNode = "input";
  levels.forEach((level, index) => {
    const override = step.runtime_overrides?.levels?.[level.id];
    const nodeId = mermaidNodeId(`level_${level.id}_${index}`);
    lines.push(
      `  ${nodeId}["${mermaidLabel(formatDisplayName(level.name ?? level.id))}<br/>${mermaidLabel(formatDisplayName(level.stage_type))}"]`,
      `  ${previousNode} --> ${nodeId}`,
    );
    const loop = describeLevelLoop(level, override);
    if (loop) {
      lines.push(`  ${nodeId} -. "${mermaidLabel(loop)}" .-> ${nodeId}`);
    }
    previousNode = nodeId;
  });

  lines.push(
    `  output(["Produces<br/>${mermaidLabel(step.result_artifact)}"])`,
    `  ${previousNode} --> output`,
  );

  return lines.join("\n");
}

function describeTeamLoop(step: StepDraft, team: TeamEntry | null): string | null {
  if (!team) return null;
  for (const level of team.levels ?? []) {
    const loop = describeLevelLoop(
      level,
      step.runtime_overrides?.levels?.[level.id],
    );
    if (loop) return loop;
  }
  return null;
}

function describeLevelLoop(
  level: LevelEntry,
  override: LevelOverride | undefined,
): string | null {
  if (level.stage_type === "discussion") {
    return `discussion rounds ${roundsValue(
      override?.discussion?.min_rounds ?? level.min_rounds,
      override?.discussion?.max_rounds ?? level.max_rounds,
    )}`;
  }

  if (level.stage_type === "review") {
    const iterations = override?.review?.max_iterations ?? level.max_iterations;
    return iterations
      ? `review loop up to ${iterations} iteration${iterations === 1 ? "" : "s"}`
      : "review feedback loop";
  }

  return null;
}

function mermaidNodeId(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_]/g, "_");
  if (cleaned === "" || /^\d/.test(cleaned)) return `n_${cleaned || "x"}`;
  return cleaned;
}

function mermaidLabel(value: string): string {
  return value
    .replace(/"/g, "'")
    .replace(/[{}]/g, "")
    .replace(/\[/g, "")
    .replace(/\]/g, "")
    .slice(0, 120);
}

function roundsValue(min: number | undefined, max: number | undefined): string {
  if (min == null && max == null) return "Not set";
  return `${min ?? "?"} to ${max ?? "?"}`;
}

function humanizeStepName(id: string): string {
  return formatDisplayName(id);
}

export default StepDetailsSheet;
