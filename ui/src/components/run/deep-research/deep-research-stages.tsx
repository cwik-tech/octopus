import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Clock3,
  Download,
  ExternalLink,
  FileCheck2,
  FileText,
  Loader2,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@/components/ai-elements/file-tree";
import {
  Plan,
  PlanContent,
  PlanDescription,
  PlanHeader,
  PlanTitle,
} from "@/components/ai-elements/plan";
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from "@/components/ai-elements/sources";
import {
  Task,
  TaskContent,
  TaskItem,
  TaskItemFile,
  TaskTrigger,
} from "@/components/ai-elements/task";
import { ResearchActivity } from "@/components/run/chat/research-activity-list";
import { ArtifactPreviewSheet } from "@/components/run/pickers/artifact-preview-sheet";
import { WorkspaceSurfaceCard } from "@/components/run/shared/workspace-journey";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ResizableRightSheetContent } from "@/components/ui/resizable-right-sheet";
import { useResearchActivities } from "@/hooks/use-research-activities";
import type {
  DeepResearchJourneySnapshot,
  DeepResearchJourneyWorkerStatus,
} from "@/lib/clients/deep-research-journey-client";
import { artifactUrl } from "@/lib/clients/runtime-client";
import { ResearchAgentPrompt } from "./research-agent-prompt";

type JourneyArtifact = DeepResearchJourneySnapshot["artifacts"][number];
type JourneyPlan = NonNullable<DeepResearchJourneySnapshot["plan"]>;
type JourneyResearchTask = JourneyPlan["tasks"][number];
type JourneyWorkerSpec = JourneyPlan["workerSpecs"][number];

interface ResearchActivitySelection {
  readonly status: DeepResearchJourneyWorkerStatus;
  readonly task: JourneyResearchTask;
  readonly taskNumber: number;
  readonly worker: JourneyWorkerSpec | null;
}

const EVIDENCE_KINDS = new Set<JourneyArtifact["kind"]>([
  "plan",
  "evidence",
  "evidence_graph",
  "section_dossier",
  "adaptive_decision",
  "amendment",
  "synthesis",
  "quality",
  "research_report",
]);

const RESEARCH_PHASES = [
  "Researching",
  "Drafting sections",
  "Synthesizing",
  "Reviewing",
  "Approved",
] as const;

export function DeepResearchResearchStage({
  snapshot,
  taskRunId,
}: {
  snapshot: DeepResearchJourneySnapshot | null;
  taskRunId: string | null;
}) {
  const plan = snapshot?.plan ?? null;
  const workers = useMemo(
    () => snapshot?.research?.workers ?? [],
    [snapshot?.research?.workers],
  );
  const quality = snapshot?.quality ?? null;
  const evidenceArtifacts = (snapshot?.artifacts ?? []).filter((artifact) =>
    EVIDENCE_KINDS.has(artifact.kind),
  );
  const correctionWave = snapshot?.research?.correctionWave ?? 0;
  const qualityPrecedesActiveCorrection = Boolean(
    quality && quality.correctionWave < correctionWave,
  );
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const selectedWorker = plan?.workerSpecs.find(
    (worker) => worker.id === selectedWorkerId,
  ) ?? null;
  const [selectedActivityTaskId, setSelectedActivityTaskId] = useState<
    string | null
  >(null);
  const selectedActivity = useMemo<ResearchActivitySelection | null>(() => {
    if (!plan || !selectedActivityTaskId) return null;
    const taskIndex = plan.tasks.findIndex(
      (task) => task.id === selectedActivityTaskId,
    );
    if (taskIndex < 0) return null;
    const task = plan.tasks[taskIndex];
    if (!task) return null;
    const worker = workers.find((candidate) => candidate.taskId === task.id);
    const workerSpec = plan.workerSpecs.find(
      (candidate) => candidate.id === task.workerSpecId,
    );
    return {
      status: worker?.status ?? "pending",
      task,
      taskNumber: taskIndex + 1,
      worker: workerSpec ?? null,
    };
  }, [plan, selectedActivityTaskId, workers]);

  return (
    <StageShell
      description="Assignment-scoped researchers collect claim-traceable evidence in parallel. Synthesis and the evidence-critic run automatically after collection."
      eyebrow="Step 2 · research-team"
      icon={<Search className="size-5" />}
      subheading={researchSubheading(snapshot)}
      title="Research in Progress"
    >
      <ResearchPhaseProgress snapshot={snapshot} />

      {qualityPrecedesActiveCorrection && snapshot ? (
        <QualitySummary snapshot={snapshot} />
      ) : null}

      {correctionWave > 0 ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-400">
            <AlertTriangle className="size-4" />
            Targeted Correction Wave {correctionWave}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            The reviewer requested focused corrections. This remains part of
            Research and will be audited again automatically.
          </p>
        </div>
      ) : null}

      {correctionWave > 0 ? (
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Correction tasks · Wave {correctionWave}
        </div>
      ) : null}

      <div className="grid gap-3 xl:grid-cols-2">
        {(plan?.tasks ?? []).map((task, index) => {
          const workerSpec = plan?.workerSpecs.find(
            (candidate) => candidate.id === task.workerSpecId,
          );
          const worker = workers.find((candidate) => candidate.taskId === task.id);
          const status = worker?.status ?? "pending";
          return (
            <Task
              className={[
                "rounded-xl border bg-card p-4 shadow-xs",
                status === "running" ? "border-primary/40" : "border-border/70",
              ].join(" ")}
              defaultOpen={false}
              key={task.id}
            >
              <div className="w-full text-left">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h3 className="text-sm font-semibold text-foreground">
                    Task {index + 1}. {task.title}
                  </h3>
                  <WorkerStatus
                    onClick={() => setSelectedActivityTaskId(task.id)}
                    status={status}
                    taskLabel={`Task ${index + 1}. ${task.title}`}
                  />
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {task.question}
                </p>
                <Button
                  variant="link"
                  size="xs"
                  className="mt-3 h-auto p-0 no-underline"
                  onClick={() => setSelectedWorkerId(workerSpec?.id ?? null)}
                >
                  Assigned Agent: {workerSpec?.displayRole ?? worker?.displayRole ?? "Web Researcher"}
                </Button>
              </div>
            </Task>
          );
        })}
      </div>

      <ResearchWorkerSheet
        onOpenChange={(open) => {
          if (!open) setSelectedWorkerId(null);
        }}
        worker={selectedWorker}
      />

      <ResearchActivitySheet
        assignmentId={snapshot?.workflow.steps.find(
          (step) => step.id === "research",
        )?.runId ?? null}
        onOpenChange={(open) => {
          if (!open) setSelectedActivityTaskId(null);
        }}
        rootRunId={taskRunId}
        selection={selectedActivity}
        sessionId={snapshot?.sessionId ?? null}
      />

      {quality && snapshot && !qualityPrecedesActiveCorrection ? (
        <QualitySummary snapshot={snapshot} />
      ) : null}

      <EvidenceSources artifacts={evidenceArtifacts} />
    </StageShell>
  );
}

function ResearchPhaseProgress({
  snapshot,
}: {
  snapshot: DeepResearchJourneySnapshot | null;
}) {
  const status = snapshot?.research?.status ?? "not_started";
  const currentIndex = researchPhaseIndex(snapshot);
  const started = status !== "not_started";

  return (
    <section
      aria-label="Research progress"
      className="rounded-xl border border-border/70 bg-card px-3 py-4 shadow-xs sm:px-4"
    >
      <div className="mb-3 text-xs font-semibold text-foreground">
        Research workflow
      </div>
      <ol aria-label="Research progress steps" className="grid grid-cols-5">
        {RESEARCH_PHASES.map((label, index) => {
          const isCurrent = started && index === currentIndex;
          const isCompleted = status === "approved" || index < currentIndex;
          const state = isCompleted ? "complete" : isCurrent ? "active" : "pending";
          const leftComplete = status === "approved" || index <= currentIndex;
          const rightComplete = status === "approved" || index < currentIndex;

          return (
            <li
              aria-current={isCurrent ? "step" : undefined}
              aria-label={`${label}: ${state}`}
              className="min-w-0 text-center"
              key={label}
            >
              <div className="flex w-full items-center">
                <span
                  aria-hidden="true"
                  className={[
                    "h-px min-w-0 flex-1",
                    index === 0
                      ? "invisible"
                      : leftComplete
                        ? "bg-emerald-500/60"
                        : "bg-border",
                  ].join(" ")}
                />
                <span
                  aria-hidden="true"
                  className={[
                    "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums sm:size-8 sm:text-xs",
                    isCompleted
                      ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-500"
                      : isCurrent
                        ? "animate-pulse border-orange-500/60 bg-orange-500/10 text-orange-500 ring-2 ring-orange-500/15 motion-reduce:animate-none"
                        : "border-border/60 bg-muted/30 text-muted-foreground/60",
                  ].join(" ")}
                >
                  {index + 1}
                </span>
                <span
                  aria-hidden="true"
                  className={[
                    "h-px min-w-0 flex-1",
                    index === RESEARCH_PHASES.length - 1
                      ? "invisible"
                      : rightComplete
                        ? "bg-emerald-500/60"
                        : "bg-border",
                  ].join(" ")}
                />
              </div>
              <div
                aria-hidden="true"
                className={[
                  "mt-2 px-0.5 text-xs font-medium leading-tight sm:text-xs",
                  isCompleted
                    ? "text-emerald-600 dark:text-emerald-400"
                    : isCurrent
                      ? "text-orange-600 dark:text-orange-400"
                      : "text-muted-foreground/70",
                ].join(" ")}
              >
                {label}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function ResearchWorkerSheet({
  onOpenChange,
  worker,
}: {
  onOpenChange: (open: boolean) => void;
  worker: NonNullable<DeepResearchJourneySnapshot["plan"]>["workerSpecs"][number] | null;
}) {
  return (
    <Sheet open={worker !== null} onOpenChange={onOpenChange}>
      <ResizableRightSheetContent
        open={worker !== null}
        resizeLabel="Resize research assignment sheet"
      >
        <SheetHeader>
          <SheetTitle>{worker?.displayRole ?? "Research Assignment"}</SheetTitle>
          <SheetDescription>
            The reusable Web Researcher follows this approved analytical contract.
          </SheetDescription>
        </SheetHeader>
        {worker ? (
          <div className="space-y-4 overflow-y-auto px-5 pb-5 text-sm">
            <ResearchAgentPrompt worker={worker} />
          </div>
        ) : null}
      </ResizableRightSheetContent>
    </Sheet>
  );
}

function ResearchActivitySheet({
  assignmentId,
  onOpenChange,
  rootRunId,
  selection,
  sessionId,
}: {
  assignmentId: string | null;
  onOpenChange: (open: boolean) => void;
  rootRunId: string | null;
  selection: ResearchActivitySelection | null;
  sessionId: string | null;
}) {
  const open = selection !== null;
  const activities = useResearchActivities(
    open ? sessionId : null,
    selection?.status === "running",
    false,
  );
  const scopedActivities = useMemo(() => {
    if (!selection?.worker || !rootRunId || !assignmentId) return [];
    return activities.filter(
      (activity) =>
        activity.runId === rootRunId &&
        activity.assignmentId === assignmentId &&
        activity.activityScopeId === selection.worker?.laneId,
    );
  }, [activities, assignmentId, rootRunId, selection]);
  const title = selection?.worker?.displayRole ?? "Web Researcher";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <ResizableRightSheetContent
        closeLabel="Close research activity sheet"
        open={open}
        resizeLabel="Resize research activity sheet"
      >
        <SheetHeader>
          <SheetTitle>{title} research activity</SheetTitle>
          <SheetDescription>
            {selection
              ? `Task ${selection.taskNumber}. ${selection.task.title}`
              : "Task-scoped research activity"}
          </SheetDescription>
        </SheetHeader>
        {open ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {scopedActivities.length > 0 ? (
              <ResearchActivity
                activities={scopedActivities}
                expandedByDefault
                resolved={selection?.status !== "running"}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                No research activity was recorded for this research task.
              </p>
            )}
          </div>
        ) : null}
      </ResizableRightSheetContent>
    </Sheet>
  );
}

export function DeepResearchEditorialStage({
  snapshot,
}: {
  snapshot: DeepResearchJourneySnapshot | null;
}) {
  const editorial = snapshot?.workflow.steps.find((step) => step.id === "editorial");
  const editorialArtifacts = (snapshot?.artifacts ?? []).filter(
    (artifact) =>
      artifact.kind === "editorial_draft" ||
      artifact.kind === "publication_audit",
  );

  return (
    <StageShell
      description="The publication team converts the audited research package into a coherent report, with deterministic claim and citation checks on every repair."
      eyebrow="Step 3 · deep-research-publication-team · automated"
      icon={<Sparkles className="size-5" />}
      status={editorial?.status === "completed" ? "Approved" : "Writing & review"}
      title="Editorial Review"
    >
      <Plan className="border-border/70 bg-card" defaultOpen>
        <PlanHeader>
          <div>
            <PlanTitle>Evidence-sealed publication workflow</PlanTitle>
            <PlanDescription>
              Draft, deterministic provenance audit, semantic review, and bounded repair.
            </PlanDescription>
          </div>
        </PlanHeader>
        <PlanContent className="space-y-3">
          <EditorialTask
            description="Transforms the research package into the audience, structure, and decision format approved in the brief."
            label="Evidence package"
            state={editorial?.status}
          />
          <EditorialTask
            description="Drafts only from the sealed evidence package and retains claim-level source references."
            label="Publication writer"
            state={editorial?.status}
          />
          <EditorialTask
            description="Checks report-level coherence after runtime validation of sources, numerals, caveats, graph links, and numeric citations."
            label="Publication editor"
            state={editorial?.status}
          />
        </PlanContent>
      </Plan>

      <div className="grid gap-3 sm:grid-cols-2">
        <Guarantee>Supported claims remain traceable to source evidence.</Guarantee>
        <Guarantee>Contradictions and uncertainty remain explicitly qualified.</Guarantee>
        <Guarantee>No unsupported factual claims may be introduced.</Guarantee>
        <Guarantee>At most three audited repair iterations run before publication blocks.</Guarantee>
      </div>

      <EvidenceSources artifacts={editorialArtifacts} label="Editorial files" />
      <AutomationNotice>
        Publication starts automatically when the editor approves the final draft.
      </AutomationNotice>
    </StageShell>
  );
}

export function DeepResearchEscalationStage({
  snapshot,
}: {
  snapshot: DeepResearchJourneySnapshot | null;
}) {
  const quality = snapshot?.quality ?? null;
  const escalationArtifact = snapshot?.artifacts.find(
    (artifact) => artifact.kind === "escalation",
  );
  const block = snapshot?.research?.block ?? null;
  const executionBlock = block?.kind === "execution";

  return (
    <StageShell
      description={executionBlock
        ? "Research execution stopped before the next synthesis and evidence review could complete. The latest completed audit remains visible, but it is not the terminal cause."
        : "The evidence-critic found a material issue that cannot be corrected safely within the approved scope. Research is paused for your decision."}
      eyebrow={executionBlock
        ? "Conditional step · execution block"
        : "Conditional step · evidence-critic"}
      icon={<AlertTriangle className="size-5" />}
      status="Action needed"
      title="Attention Required"
      tone="warning"
    >
      <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-4">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-amber-700 dark:text-amber-400">
          {executionBlock
            ? "Execution decision · BLOCKED"
            : `Quality decision · ${quality?.decision ?? "ESCALATE"}`}
        </div>
        <p className="mt-2 text-sm leading-relaxed text-foreground">
          {executionBlock
            ? block.message
            : "Review the blocking findings below, then discuss a scope correction in chat. The existing run remains immutable and inspectable."}
        </p>
      </div>

      <div className="space-y-2">
        {(quality?.findings ?? []).map((finding, index) => (
          <div
            className="rounded-xl border border-border/70 bg-card p-4"
            key={`${finding.code}:${index}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-destructive">
                {finding.severity}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {finding.code}
              </span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-foreground">
              {finding.message}
            </p>
            {finding.taskIds.length ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Affected tasks: {finding.taskIds.join(", ")}
              </p>
            ) : null}
          </div>
        ))}
      </div>

      {quality?.correctionRequests.length ? (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">
            Reviewer Requests
          </h3>
          {quality.correctionRequests.map((request) => (
            <Task className="rounded-xl border border-border/70 bg-card p-3" key={request.id}>
              <TaskTrigger title={request.question ?? request.type.replaceAll("_", " ")} />
              <TaskContent>
                {request.acceptanceCriteria.map((criterion) => (
                  <TaskItem className="text-xs" key={criterion}>
                    {criterion}
                  </TaskItem>
                ))}
              </TaskContent>
            </Task>
          ))}
        </div>
      ) : null}

      {escalationArtifact ? (
        <Button
          className="w-fit"
          nativeButton={false}
          render={
            <a
              href={artifactUrl(escalationArtifact.runId, escalationArtifact.relativePath)}
              rel="noreferrer"
              target="_blank"
            />
          }
          variant="outline"
        >
            <FileText className="size-4" />
            Open escalation brief
            <ExternalLink className="size-3.5" />
        </Button>
      ) : null}
    </StageShell>
  );
}

export function DeepResearchDeliveryStage({
  snapshot,
}: {
  snapshot: DeepResearchJourneySnapshot | null;
}) {
  const [preview, setPreview] = useState<{
    artifactPath: string;
    runId: string;
  } | null>(null);
  const artifacts = useMemo(() => snapshot?.artifacts ?? [], [snapshot?.artifacts]);
  const markdown = artifacts.find((artifact) => artifact.kind === "final_markdown");
  const docx = artifacts.find((artifact) => artifact.kind === "final_docx");
  const presentation = deliveryPresentation(snapshot, Boolean(markdown && docx));
  const tree = useMemo(() => buildArtifactTree(artifacts), [artifacts]);
  const defaultExpanded = useMemo(
    () => new Set(tree.filter((node) => node.children.length > 0).map((node) => node.path)),
    [tree],
  );

  const openArtifact = (path: string) => {
    const artifact = artifacts.find((candidate) => candidate.relativePath === path);
    if (!artifact || artifact.kind === "final_docx") return;
    setPreview({ artifactPath: artifact.relativePath, runId: artifact.runId });
  };

  return (
    <>
      <StageShell
        description={presentation.description}
        eyebrow={presentation.eyebrow}
        icon={<FileCheck2 className="size-5" />}
        status={presentation.status}
        title="Final Documentation"
        tone={presentation.tone}
      >
        <div className="grid gap-3 lg:grid-cols-2">
          <DeliverableCard
            action={
              markdown ? (
                <Button
                  onClick={() =>
                    setPreview({
                      artifactPath: markdown.relativePath,
                      runId: markdown.runId,
                    })
                  }
                  size="sm"
                  type="button"
                >
                  Open report
                  <ExternalLink className="size-3.5" />
                </Button>
              ) : null
            }
            artifact={markdown}
            icon={<FileText className="size-5" />}
            title="Markdown Report"
          />
          <DeliverableCard
            action={
              docx ? (
                <Button
                  nativeButton={false}
                  render={
                    <a
                      download={docx.relativePath.split("/").at(-1)}
                      href={artifactUrl(docx.runId, docx.relativePath)}
                    />
                  }
                  size="sm"
                  variant="outline"
                >
                    Download
                    <Download className="size-3.5" />
                </Button>
              ) : null
            }
            artifact={docx}
            icon={<Download className="size-5" />}
            title="Word Document"
          />
        </div>

        <section aria-labelledby="deep-research-file-tree-heading" className="space-y-2">
          <div>
            <h3 className="text-sm font-semibold text-foreground" id="deep-research-file-tree-heading">
              Inspectable Run Files
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Inspect the intermediate plan, evidence, quality, editorial, and publication artifacts.
            </p>
          </div>
          <FileTree
            defaultExpanded={defaultExpanded}
            onSelect={openArtifact}
          >
            {tree.map((node) => (
              <ArtifactTreeNode key={node.path} node={node} />
            ))}
          </FileTree>
        </section>

        {!presentation.delivered ? (
          <AutomationNotice>
            This view updates from durable workflow state while provenance checks,
            Markdown publication, and DOCX generation finish automatically.
          </AutomationNotice>
        ) : null}
      </StageShell>

      <ArtifactPreviewSheet
        onOpenArtifact={setPreview}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
        open={preview !== null}
        target={preview}
      />
    </>
  );
}

function StageShell({
  children,
  description,
  eyebrow,
  icon,
  status,
  subheading,
  title,
  tone = "default",
}: {
  children: ReactNode;
  description: string;
  eyebrow: string;
  icon: ReactNode;
  status?: string;
  subheading?: string;
  title: string;
  tone?: "default" | "warning";
}) {
  return (
    <section className="h-full overflow-y-auto" data-testid={`deep-research-stage-${title.toLowerCase().replaceAll(" ", "-")}`}>
      <div className="mx-auto w-full max-w-5xl space-y-5 p-4 sm:p-6">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 pb-5">
          <div className="min-w-0 max-w-3xl">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-text">
              {eyebrow}
            </div>
            <h2 className="mt-2 flex items-center gap-2 text-lg font-semibold text-foreground">
              <span className={tone === "warning" ? "text-amber-600" : "text-primary-text"}>
                {icon}
              </span>
              {title}
            </h2>
            {subheading ? (
              <p className="mt-1 text-xs font-semibold text-foreground/85">
                {subheading}
              </p>
            ) : null}
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          </div>
          {status ? (
            <span
              className={[
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
                tone === "warning"
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                  : "border-primary/25 bg-primary/8 text-primary-text",
              ].join(" ")}
            >
              <span className="size-1.5 rounded-full bg-current" />
              {status}
            </span>
          ) : null}
        </header>
        {children}
      </div>
    </section>
  );
}

function WorkerStatus({
  onClick,
  status,
  taskLabel,
}: {
  onClick: () => void;
  status: DeepResearchJourneyWorkerStatus;
  taskLabel: string;
}) {
  const icon = status === "completed" ? (
    <CheckCircle2 className="size-3" />
  ) : status === "running" ? (
    <Loader2 className="size-3 animate-spin" />
  ) : status === "failed" || status === "blocked" ? (
    <AlertTriangle className="size-3" />
  ) : (
    <Clock3 className="size-3" />
  );
  const tone = status === "running"
    ? "border-orange-500/40 bg-orange-500/10 text-orange-500"
    : status === "failed"
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : "border-transparent bg-muted text-muted-foreground";

  return (
    <Button
      variant="ghost"
      size="xs"
      aria-label={`View research activity for ${taskLabel}: ${status}`}
      className={[
        "ml-auto h-auto gap-1 rounded-full border px-2 py-0.5 capitalize",
        tone,
      ].join(" ")}
      onClick={onClick}
    >
      {icon}
      {status}
    </Button>
  );
}

function QualitySummary({
  snapshot,
}: {
  snapshot: DeepResearchJourneySnapshot;
}) {
  const quality = snapshot.quality;
  if (!quality) return null;
  const blocking = quality.findings.filter((finding) => finding.severity === "blocking").length;
  const warnings = quality.findings.length - blocking;

  return (
    <WorkspaceSurfaceCard className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-primary-text" />
          <h3 className="text-sm font-semibold text-foreground">Quality Audit</h3>
        </div>
        <span className="rounded-full bg-muted px-2 py-1 font-mono text-xs font-semibold text-muted-foreground">
          {quality.decision}
        </span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Wave {quality.correctionWave} · {blocking} blocking · {warnings} warnings · reviewed {formatDateTime(quality.reviewedAt)}
      </p>
      {quality.findings.length ? (
        <div className="mt-3 space-y-2">
          {quality.findings.slice(0, 4).map((finding, index) => (
            <div className="flex gap-2 text-xs" key={`${finding.code}:${index}`}>
              <Circle className="mt-1 size-2.5 shrink-0 fill-current text-muted-foreground" />
              <span className="leading-relaxed text-foreground/90">{finding.message}</span>
            </div>
          ))}
        </div>
      ) : null}
    </WorkspaceSurfaceCard>
  );
}

function EvidenceSources({
  artifacts,
  label = "Inspectable research files",
}: {
  artifacts: readonly JourneyArtifact[];
  label?: string;
}) {
  if (!artifacts.length) return null;
  return (
    <Sources className="rounded-xl border border-border/70 bg-card p-4">
      <SourcesTrigger count={artifacts.length}>
        <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <FileText className="size-4 text-primary-text" />
          {label} ({artifacts.length})
        </span>
      </SourcesTrigger>
      <SourcesContent className="w-full">
        {artifacts.map((artifact) => (
          <Source
            href={artifactUrl(artifact.runId, artifact.relativePath)}
            key={`${artifact.runId}:${artifact.relativePath}`}
            title={artifact.label}
          >
            <FileText className="size-4" />
            <span className="min-w-0 truncate font-medium">{artifact.label}</span>
            <span className="ml-auto truncate font-mono text-xs text-muted-foreground">
              {artifact.relativePath}
            </span>
          </Source>
        ))}
      </SourcesContent>
    </Sources>
  );
}

function AutomationNotice({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-dashed border-border bg-muted/25 p-3 text-xs leading-relaxed text-muted-foreground">
      <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary-text" />
      {children}
    </div>
  );
}

function EditorialTask({
  description,
  label,
  state,
}: {
  description: string;
  label: string;
  state?: string | undefined;
}) {
  return (
    <Task className="rounded-lg border border-border/60 bg-background p-3">
      <TaskTrigger title={label} />
      <TaskContent>
        <TaskItem className="text-xs text-foreground/90">{description}</TaskItem>
        <TaskItemFile className="capitalize">{state ?? "queued"}</TaskItemFile>
      </TaskContent>
    </Task>
  );
}

function Guarantee({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-border/70 bg-card p-3 text-xs leading-relaxed text-foreground/90">
      <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      {children}
    </div>
  );
}

function DeliverableCard({
  action,
  artifact,
  icon,
  title,
}: {
  action: ReactNode;
  artifact?: JourneyArtifact | undefined;
  icon: ReactNode;
  title: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-card p-4 shadow-xs">
      <div className="rounded-lg bg-primary/10 p-2 text-primary-text">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
          {artifact?.relativePath ?? "Not available yet"}
        </div>
      </div>
      {action}
    </div>
  );
}

function deliveryPresentation(
  snapshot: DeepResearchJourneySnapshot | null,
  hasFinalArtifacts: boolean,
): {
  delivered: boolean;
  description: string;
  eyebrow: string;
  status: string;
  tone: "default" | "warning";
} {
  const terminalWorkflow =
    snapshot?.workflow.status === "completed" ||
    snapshot?.workflow.status === "completed_with_warnings";
  const delivered = Boolean(terminalWorkflow && hasFinalArtifacts);
  if (delivered) {
    return {
      delivered: true,
      description:
        "The approved report and its inspectable research trail are ready. Markdown opens in the artifact viewer; DOCX downloads directly.",
      eyebrow: "Final step · published",
      status: "Delivered",
      tone: "default",
    };
  }

  const publishStatus = snapshot?.workflow.steps.find(
    (step) => step.id === "publish",
  )?.status;
  const failureStatus =
    publishStatus === "interrupted"
      ? "Publishing interrupted"
      : publishStatus === "blocked"
        ? "Publication blocked"
        : publishStatus === "failed"
          ? "Publication failed"
          : publishStatus === "cancelled"
            ? "Publication cancelled"
            : terminalWorkflow
              ? "Delivery incomplete"
              : publishStatus === "indeterminate"
                ? "Checking publication"
                : publishStatus === "completed" ||
                    publishStatus === "completed_with_warnings"
                  ? "Finalizing delivery"
                  : "Publishing";
  const warning =
    terminalWorkflow ||
    publishStatus === "interrupted" ||
    publishStatus === "blocked" ||
    publishStatus === "failed" ||
    publishStatus === "cancelled";

  return {
    delivered: false,
    description: warning
      ? "Publication has not produced both final deliverables. Inspect the durable status and available artifacts before retrying or correcting the run."
      : "The audited report is moving through provenance checks, Markdown publication, and DOCX generation. Deliverables appear here as each durable artifact is written.",
    eyebrow: "Final step · publication",
    status: failureStatus,
    tone: warning ? "warning" : "default",
  };
}

interface ArtifactTreeNodeModel {
  artifact?: JourneyArtifact;
  children: ArtifactTreeNodeModel[];
  name: string;
  path: string;
}

function buildArtifactTree(
  artifacts: readonly JourneyArtifact[],
): ArtifactTreeNodeModel[] {
  const roots: ArtifactTreeNodeModel[] = [];
  for (const artifact of artifacts) {
    const parts = artifact.relativePath.split("/").filter(Boolean);
    let siblings = roots;
    let currentPath = "";
    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let node = siblings.find((candidate) => candidate.name === part);
      if (!node) {
        node = { children: [], name: part, path: currentPath };
        siblings.push(node);
      }
      if (index === parts.length - 1) node.artifact = artifact;
      siblings = node.children;
    });
  }
  const sort = (nodes: ArtifactTreeNodeModel[]) => {
    nodes.sort((left, right) => {
      if (Boolean(left.children.length) !== Boolean(right.children.length)) {
        return left.children.length ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
    nodes.forEach((node) => sort(node.children));
  };
  sort(roots);
  return roots;
}

function ArtifactTreeNode({ node }: { node: ArtifactTreeNodeModel }) {
  if (node.children.length > 0) {
    return (
      <FileTreeFolder name={node.name} path={node.path}>
        {node.children.map((child) => (
          <ArtifactTreeNode key={child.path} node={child} />
        ))}
      </FileTreeFolder>
    );
  }
  return <FileTreeFile name={node.name} path={node.path} />;
}

function researchPhaseIndex(snapshot: DeepResearchJourneySnapshot | null): number {
  switch (snapshot?.research?.status) {
    case "synthesizing":
      return 2;
    case "drafting":
      return 1;
    case "reviewing":
      return 3;
    case "correcting":
      return 0;
    case "blocked":
      return 3;
    case "approved":
      return 4;
    case "collecting":
    case "not_started":
    default:
      return 0;
  }
}

function researchSubheading(snapshot: DeepResearchJourneySnapshot | null): string {
  const status = snapshot?.research?.status;
  const wave = snapshot?.research?.correctionWave ?? 0;
  switch (status) {
    case "collecting":
      return wave > 0
        ? `Researchers are applying targeted corrections · Wave ${wave}`
        : "Researchers are collecting and validating evidence";
    case "synthesizing":
      return wave > 0
        ? `Correction evidence is being synthesized · Wave ${wave}`
        : "Validated evidence is being synthesized into the research package";
    case "drafting":
      return wave > 0
        ? `Corrected section dossiers are being drafted in bounded parallel · Wave ${wave}`
        : "Evidence-bound section dossiers are being drafted in bounded parallel";
    case "reviewing":
      return `The evidence critic is reviewing synthesis and source quality · Wave ${wave}`;
    case "correcting":
      return `The quality audit requested targeted corrections · Wave ${Math.max(1, wave)}`;
    case "blocked":
      return snapshot?.research?.block?.kind === "execution"
        ? "Research stopped because execution could not complete"
        : "Research requires a quality decision";
    case "approved":
      return "The evidence critic approved the research package";
    case "not_started":
    default:
      return "Preparing approved research assignments";
  }
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}
