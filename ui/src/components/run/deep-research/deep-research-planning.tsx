import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileSearch,
  Loader2,
  Sparkles,
  Users,
} from "lucide-react";
import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Message,
  MessageContent,
} from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { AgentIdentity } from "@/components/run/shared/agent-identity";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ResizableRightSheetContent } from "@/components/ui/resizable-right-sheet";
import { DeepResearchExecutionPolicy } from "@/components/run/deep-research/deep-research-execution-policy";
import { DeepResearchPlanningProgress } from "@/components/run/deep-research/deep-research-planning-progress";
import { ResearchAgentPrompt } from "@/components/run/deep-research/research-agent-prompt";
import {
  approveSessionResearchPlan,
  cancelSessionResearchPlanAttempt,
  generateSessionResearchPlan,
  getSessionResearchPlanAttempt,
  getSessionRunPlan,
  openSessionResearchPlanAttemptStream,
  startSessionTask,
} from "@/lib/clients/session-client";
import type {
  DeepResearchPlanDiff,
  DeepResearchPlanningAttemptSnapshot,
  ResearchPlan,
  ResearchTask,
  ResearchWorkerSpec,
  RunPlan,
  SessionTask,
  WorkspaceProjectContextSelection,
} from "@/lib/models/session-model";
import { diffResearchPlans } from "@contracts/deep-research-planning";

const DEEP_RESEARCH_WORKFLOW_ID = "deep-research-report";

type PlanningOperation = "launch" | null;

interface TaskAssignment {
  task: ResearchTask;
  taskNumber: number;
  worker: ResearchWorkerSpec | null;
}

export function DeepResearchPlanning({
  activeTask,
  onRunPlanUpdated,
  onTaskStarted,
  runPlan,
  sessionId,
  projectContext,
  contextResultIds,
}: {
  activeTask: SessionTask | null;
  onRunPlanUpdated: (plan: RunPlan) => void;
  onTaskStarted: (task: SessionTask) => void;
  runPlan: RunPlan | null;
  sessionId: string;
  projectContext?: WorkspaceProjectContextSelection | undefined;
  /**
   * Completed results this launch carries forward.
   *
   * The composer beside this workspace can show a result as attached, and
   * approving the plan starts the same kind of run as Begin workflow does. It
   * launched with none of them.
   */
  contextResultIds?: readonly string[] | undefined;
}) {
  const [operation, setOperation] = useState<PlanningOperation>(null);
  const [operationError, setOperationError] = useState<{
    kind: "generation" | "final_plan_refresh" | "cancel";
    message: string;
    planId: string;
  } | null>(null);
  const [selectedAssignment, setSelectedAssignment] =
    useState<TaskAssignment | null>(null);
  const [generationAttempt, setGenerationAttempt] = useState(0);
  const [planningAttempt, setPlanningAttempt] =
    useState<DeepResearchPlanningAttemptSnapshot | null>(null);
  const [cancelRequestAttemptId, setCancelRequestAttemptId] =
    useState<string | null>(null);
  const cancelRequestAttemptIdRef = useRef<string | null>(null);
  const planningAttemptRef =
    useRef<DeepResearchPlanningAttemptSnapshot | null>(null);
  const planHeadingRef = useRef<HTMLDivElement>(null);
  const focusedProposalRef = useRef<string | null>(null);
  const onRunPlanUpdatedRef = useRef(onRunPlanUpdated);
  const researchPlan = runPlan?.researchPlan ?? null;
  const approved = isApprovedPlan(runPlan);
  const planId = runPlan?.id ?? null;
  const error = operationError?.planId === planId
    ? operationError.message
    : null;
  const shouldGenerate = Boolean(
    planId &&
      runPlan?.deepResearchIntakeComplete === true &&
      !researchPlan &&
      !activeTask,
  );
  const planningRevision = runPlan?.deepResearchPlanning;
  const amendment = planningRevision?.origin === "user_amendment";
  const sourceProposal = planningRevision?.sourceProposalSnapshot ?? null;
  const focusKey =
    researchPlan && planningRevision
      ? `${planningRevision.planningRevisionId}:${researchPlan.planId}`
      : null;

  useEffect(() => {
    onRunPlanUpdatedRef.current = onRunPlanUpdated;
  }, [onRunPlanUpdated]);

  useEffect(() => {
    if (!researchPlan || planningAttempt?.status !== "succeeded" || !focusKey) {
      return;
    }
    if (focusedProposalRef.current === focusKey) return;
    if (isTypingElement(document.activeElement)) return;
    planHeadingRef.current?.focus();
    if (document.activeElement === planHeadingRef.current) {
      focusedProposalRef.current = focusKey;
    }
  }, [focusKey, planningAttempt?.status, researchPlan]);

  const acceptPlanningSnapshot = useCallback(
    (snapshot: DeepResearchPlanningAttemptSnapshot): boolean => {
      const previous = planningAttemptRef.current;
      if (
        previous?.attemptId === snapshot.attemptId &&
        previous.revision > snapshot.revision
      ) {
        return false;
      }
      planningAttemptRef.current = snapshot;
      setPlanningAttempt(snapshot);
      return true;
    },
    [],
  );

  const applyPlanningSnapshot = useCallback(
    async (snapshot: DeepResearchPlanningAttemptSnapshot) => {
      if (!acceptPlanningSnapshot(snapshot)) return;
      if (snapshot.status !== "succeeded") return;
      try {
        const nextPlan = await getSessionRunPlan(sessionId);
        if (nextPlan && nextPlan.id === snapshot.finalRunPlanId) {
          onRunPlanUpdatedRef.current(nextPlan);
          return;
        }
        throw new Error(
          "The completed research plan is not available yet. Retry loading it.",
        );
      } catch (nextError) {
        setOperationError({
          kind: "final_plan_refresh",
          message: errorMessage(nextError),
          planId: snapshot.expectedPlanId,
        });
      }
    },
    [acceptPlanningSnapshot, sessionId],
  );

  const requestPlanningCancellation = useCallback(
    (attempt: DeepResearchPlanningAttemptSnapshot) => {
      if (
        cancelRequestAttemptIdRef.current === attempt.attemptId ||
        attempt.status === "cancelling"
      ) {
        return;
      }
      cancelRequestAttemptIdRef.current = attempt.attemptId;
      setCancelRequestAttemptId(attempt.attemptId);
      void cancelSessionResearchPlanAttempt(sessionId, attempt.attemptId)
        .then(acceptPlanningSnapshot)
        .catch((nextError: unknown) => {
          setOperationError({
            kind: "cancel",
            message: errorMessage(nextError),
            planId: planId ?? attempt.expectedPlanId,
          });
        })
        .finally(() => {
          if (cancelRequestAttemptIdRef.current === attempt.attemptId) {
            cancelRequestAttemptIdRef.current = null;
          }
          setCancelRequestAttemptId((current) =>
            current === attempt.attemptId ? null : current,
          );
        });
    },
    [
      acceptPlanningSnapshot,
      planId,
      sessionId,
    ],
  );

  useEffect(() => {
    if (!planId || !shouldGenerate || error) return undefined;

    let active = true;
    const streamController = new AbortController();
    const run = async () => {
      const retainedAttempt = planningAttemptRef.current;
      const restoredAttemptId =
        generationAttempt === 0
          ? planningRevision?.latestAttemptId
          : undefined;
      const nextAttempt =
        retainedAttempt?.status === "succeeded" &&
          retainedAttempt.expectedPlanId === planId
          ? retainedAttempt
          : restoredAttemptId
            ? await getSessionResearchPlanAttempt(
                sessionId,
                restoredAttemptId,
              )
            : await generateSessionResearchPlan(sessionId, planId);
      if (!active) return;
      await applyPlanningSnapshot(nextAttempt);
      if (
        nextAttempt.status === "succeeded" ||
        nextAttempt.status === "failed" ||
        nextAttempt.status === "cancelled" ||
        nextAttempt.status === "superseded"
      ) {
        return;
      }
      await openSessionResearchPlanAttemptStream({
        sessionId,
        attemptId: nextAttempt.attemptId,
        signal: streamController.signal,
        onSnapshot: (snapshot) => {
          if (active) void applyPlanningSnapshot(snapshot);
        },
      });
    };
    void run()
      .catch((nextError: unknown) => {
        if (
          active &&
          !(nextError instanceof DOMException &&
            nextError.name === "AbortError")
        ) {
          setOperationError({
            kind: "generation",
            message: errorMessage(nextError),
            planId,
          });
        }
      });

    return () => {
      active = false;
      streamController.abort();
    };
  }, [
    error,
    generationAttempt,
    planId,
    planningRevision?.latestAttemptId,
    sessionId,
    shouldGenerate,
    applyPlanningSnapshot,
  ]);

  if (runPlan?.deepResearchIntakeComplete !== true) {
    return null;
  }

  const approveAndStart = async () => {
    if (!runPlan || !researchPlan || operation || activeTask) return;
    setOperation("launch");
    setOperationError(null);
    let errorPlanId = runPlan.id;
    try {
      let executablePlan = runPlan;
      if (!approved) {
        const proposalHash = runPlan.researchPlanProposalHash;
        if (!proposalHash) {
          throw new Error("The generated research plan has no approval hash.");
        }
        executablePlan = await approveSessionResearchPlan(
          sessionId,
          runPlan.id,
          proposalHash,
        );
        errorPlanId = executablePlan.id;
        onRunPlanUpdated(executablePlan);
      }

      const workflowId =
        executablePlan.selectedWorkflow?.id ?? DEEP_RESEARCH_WORKFLOW_ID;
      const task = await startSessionTask(
        sessionId,
        { workflowId },
        undefined,
        projectContext,
        contextResultIds,
      );
      onTaskStarted(task);
    } catch (nextError) {
      setOperationError({
        kind: "generation",
        message: errorMessage(nextError),
        planId: errorPlanId,
      });
    } finally {
      setOperation(null);
    }
  };

  return (
    <>
      <Message from="assistant" data-testid="deep-research-planning-block">
        <AgentIdentity className="mb-2 text-sm" name="Research Planner" />
        <MessageContent className="w-full max-w-4xl space-y-3 bg-transparent p-0">
          {amendment ? (
            <div className="rounded-lg border border-primary/20 bg-primary/7 px-3 py-2 text-xs text-foreground">
              <span className="font-semibold">
                Updating the plan after your changes.
              </span>{" "}
              The previous proposal is retained for comparison and cannot be
              approved.
            </div>
          ) : null}

          {!researchPlan && sourceProposal ? (
            <PriorPlanSnapshot plan={sourceProposal} />
          ) : null}

          {!researchPlan && shouldGenerate && !error ? (
            <DeepResearchPlanningProgress
              amendment={amendment}
              attempt={planningAttempt}
              cancellationPending={Boolean(
                planningAttempt &&
                  (planningAttempt.status === "cancelling" ||
                    cancelRequestAttemptId === planningAttempt.attemptId),
              )}
              onCancel={
                planningAttempt &&
                !["succeeded", "failed", "cancelled", "superseded"].includes(
                  planningAttempt.status,
                )
                  ? () => {
                      requestPlanningCancellation(planningAttempt);
                    }
                  : undefined
              }
              onRetry={() => {
                if (
                  operationError?.kind === "final_plan_refresh" &&
                  planningAttempt?.status === "succeeded"
                ) {
                  setOperationError(null);
                  return;
                }
                if (
                  operationError?.kind === "cancel" &&
                  planningAttempt
                ) {
                  setOperationError(null);
                  requestPlanningCancellation(planningAttempt);
                  return;
                }
                planningAttemptRef.current = null;
                setPlanningAttempt(null);
                setOperationError(null);
                setGenerationAttempt((attempt) => attempt + 1);
              }}
            />
          ) : null}

          {researchPlan ? (
            <>
              {amendment && sourceProposal ? (
                <PlanChangeSummary
                  current={researchPlan}
                  source={sourceProposal}
                />
              ) : null}
              <BriefPlanCard
                activeTask={activeTask}
                approved={approved}
                onApproveAndStart={() => void approveAndStart()}
                onSelectAssignment={setSelectedAssignment}
                operation={operation}
                plan={researchPlan}
                planHeadingRef={planHeadingRef}
                reviewedAfterChanges={amendment}
              />
              <div className="rounded-xl border border-dashed border-border/70 bg-card px-4 py-3 text-xs leading-relaxed text-muted-foreground">
                Ask the planner in chat to change scope, tasks, or researcher
                roles. The current plan remains the reviewable source of truth.
              </div>
            </>
          ) : null}

          {error ? (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/25 bg-destructive/8 px-3 py-2 text-xs text-destructive"
              role="alert"
            >
              <span>{error}</span>
              {!researchPlan ? (
                <Button
                  onClick={() => {
                    if (
                      operationError?.kind === "final_plan_refresh" &&
                      planningAttempt?.status === "succeeded"
                    ) {
                      setOperationError(null);
                      return;
                    }
                    if (
                      operationError?.kind === "cancel" &&
                      planningAttempt
                    ) {
                      setOperationError(null);
                      requestPlanningCancellation(planningAttempt);
                      return;
                    }
                    planningAttemptRef.current = null;
                    setPlanningAttempt(null);
                    setOperationError(null);
                    setGenerationAttempt((attempt) => attempt + 1);
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Retry
                </Button>
              ) : null}
            </div>
          ) : null}
        </MessageContent>
      </Message>

      <AssignmentDetailsSheet
        assignment={selectedAssignment}
        onOpenChange={(open) => {
          if (!open) setSelectedAssignment(null);
        }}
      />
    </>
  );
}

function PriorPlanSnapshot({ plan }: { plan: ResearchPlan }) {
  return (
    <section className="rounded-xl border border-border/60 bg-muted/25 p-4 opacity-80">
      <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        Previous proposal · superseded
      </div>
      <h3 className="mt-2 text-sm font-semibold text-foreground">
        {plan.request.question}
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        {formatCount(plan.sections.length, "section")} ·{" "}
        {formatCount(plan.tasks.length, "task")} · up to{" "}
        {formatCount(plan.expectedPeakWorkers, "concurrent researcher")}
      </p>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        This hash-verified snapshot is retained for comparison only. It cannot
        be approved or launched.
      </p>
    </section>
  );
}

function PlanChangeSummary({
  current,
  source,
}: {
  current: ResearchPlan;
  source: ResearchPlan;
}) {
  const diff = useMemo(
    () => diffResearchPlans(source, current),
    [current, source],
  );
  const changes = (
    Object.entries(diff) as Array<[keyof DeepResearchPlanDiff, string[]]>
  ).flatMap(([category, entries]) =>
    entries.map((entry: string) => ({ category, entry })),
  );
  return (
    <section className="rounded-xl border border-primary/20 bg-primary/5 p-4">
      <div className="text-xs font-semibold uppercase tracking-[0.12em] text-primary-text">
        Reviewed after your changes
      </div>
      {changes.length ? (
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {changes.map(({ category, entry }) => (
            <li key={`${category}:${entry}`}>
              <span className="font-medium capitalize text-foreground">
                {category}:
              </span>{" "}
              {entry}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Advanced review affirmed the draft without a structural change.
        </p>
      )}
    </section>
  );
}

/**
 * The canonical brief and the proposed research plan live in a single card:
 * brief on top, plan in the middle, execution policy collapsed at the
 * bottom. Task rows are header-only; clicking one opens the assignment
 * sheet with the task and agent details.
 */
function BriefPlanCard({
  activeTask,
  approved,
  onApproveAndStart,
  onSelectAssignment,
  operation,
  plan,
  planHeadingRef,
  reviewedAfterChanges,
}: {
  activeTask: SessionTask | null;
  approved: boolean;
  onApproveAndStart: () => void;
  onSelectAssignment: (assignment: TaskAssignment) => void;
  operation: PlanningOperation;
  plan: ResearchPlan;
  planHeadingRef: RefObject<HTMLDivElement | null>;
  reviewedAfterChanges: boolean;
}) {
  const [policyOpen, setPolicyOpen] = useState(false);
  const request = plan.request;

  return (
    <section
      aria-labelledby="deep-research-brief-heading"
      className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-xs"
    >
      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-primary-text">
              <FileSearch className="size-3.5" />
              Canonical Research Brief
            </div>
            <h3
              className="mt-2 text-sm font-semibold leading-relaxed text-foreground"
              id="deep-research-brief-heading"
            >
              {request.question}
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {request.objective}
            </p>
          </div>
          <span className="shrink-0 rounded-full border border-border bg-muted/50 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Structured
          </span>
        </div>
      </div>

      <div className="border-t border-border/60" />

      <div className="space-y-4 p-4 sm:p-5">
        <div
          className="flex items-center justify-between gap-3"
          ref={planHeadingRef}
          tabIndex={-1}
        >
          <h4 className="text-sm font-semibold text-foreground">
            {reviewedAfterChanges
              ? "Reviewed Research Plan"
              : "Proposed Research Plan"}
          </h4>
          {approved ? (
            <span className="flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="size-3.5" />
              Approved
            </span>
          ) : null}
        </div>

        {plan.sections.map((section, sectionIndex) => (
          <section key={section.id} className="space-y-2">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.12em] text-primary-text">
                {`Step ${stepWord(sectionIndex)}`}
              </div>
              <h5 className="mt-0.5 text-sm font-semibold text-foreground">
                {section.title}
              </h5>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {section.objective}
              </p>
            </div>

            <div className="space-y-2">
              {plan.tasks
                .filter((task) => task.sectionId === section.id)
                .map((task) => {
                  const worker = plan.workerSpecs.find(
                    (candidate) => candidate.id === task.workerSpecId,
                  ) ?? null;
                  const taskNumber =
                    plan.tasks.findIndex(
                      (candidate) => candidate.id === task.id,
                    ) + 1;
                  return (
                    <Button
                      variant="ghost"
                      aria-label={`Task ${taskNumber}. ${task.title}`}
                      className="h-auto w-full justify-start gap-2.5 border border-border/60 bg-background p-3 text-left font-normal hover:border-primary/50 hover:bg-muted/30"
                      key={task.id}
                      onClick={() =>
                        onSelectAssignment({ task, taskNumber, worker })}
                    >
                      <span className="shrink-0 rounded-md border border-border/60 bg-card px-1.5 py-0.5 font-mono text-xs font-semibold text-muted-foreground">
                        {`T${taskNumber}`}
                      </span>
                      <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
                        {task.title}
                      </span>
                      {worker ? (
                        <span className="hidden shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs font-medium text-muted-foreground sm:inline-flex">
                          <Users className="size-3" />
                          {worker.displayRole}
                        </span>
                      ) : null}
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    </Button>
                  );
                })}
            </div>
          </section>
        ))}
      </div>

      {plan.executionPolicy ? (
        <>
          <div className="border-t border-border/60" />
          <div>
            <Button
              variant="ghost"
              aria-expanded={policyOpen}
              className="h-auto w-full justify-between p-4 text-xs font-semibold text-muted-foreground hover:bg-transparent hover:text-foreground sm:px-5"
              onClick={() => setPolicyOpen((open) => !open)}
            >
              Execution policy
              <ChevronDown
                className={`transition-transform ${policyOpen ? "rotate-180" : ""}`}
              />
            </Button>
            {policyOpen ? (
              <div className="px-4 pb-4 sm:px-5">
                <DeepResearchExecutionPolicy policy={plan.executionPolicy} />
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      <div className="border-t border-border/60" />

      <div className="flex flex-wrap justify-end gap-2 p-4 sm:px-5">
        <Button
          data-testid="approve-start-deep-research"
          disabled={operation !== null || Boolean(activeTask)}
          onClick={onApproveAndStart}
          type="button"
        >
          {operation === "launch" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : activeTask ? (
            <CheckCircle2 className="size-4" />
          ) : (
            <Sparkles className="size-4" />
          )}
          {activeTask
            ? "Research launched"
            : approved
              ? "Start research"
              : "Approve & start research"}
        </Button>
      </div>
    </section>
  );
}

function AssignmentDetailsSheet({
  assignment,
  onOpenChange,
}: {
  assignment: TaskAssignment | null;
  onOpenChange: (open: boolean) => void;
}) {
  const worker = assignment?.worker ?? null;

  return (
    <Sheet open={assignment !== null} onOpenChange={onOpenChange}>
      <ResizableRightSheetContent
        open={assignment !== null}
        resizeLabel="Resize research assignment sheet"
      >
        <SheetHeader>
          <SheetTitle>
            {assignment
              ? `Task ${assignment.taskNumber}. ${assignment.task.title}`
              : "Research assignment"}
          </SheetTitle>
          <SheetDescription>
            One reusable web researcher, focused by a task-specific analytical contract.
          </SheetDescription>
        </SheetHeader>
        {assignment ? (
          <div className="space-y-5 overflow-y-auto px-5 pb-5 text-sm">
            <WorkerField label="Task given" values={[assignment.task.question]} />

            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Agent
              </div>
              <div className="mt-1 flex items-center gap-3 rounded-lg border border-border/70 bg-muted/30 p-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background">
                  <Users className="size-4 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <div className="font-medium text-foreground">
                    {worker?.displayRole ?? "Web researcher"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Created for this task
                  </div>
                </div>
              </div>
            </div>

            {worker ? (
              <>
                <ResearchAgentPrompt worker={worker} />
                <WorkerField label="Lens" values={[worker.lens]} />
              </>
            ) : null}
          </div>
        ) : null}
      </ResizableRightSheetContent>
    </Sheet>
  );
}

function WorkerField({ label, values }: { label: string; values: readonly string[] }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 leading-relaxed text-foreground">
        {values.length ? values.join(", ") : "None specified"}
      </div>
    </div>
  );
}

const STEP_WORDS = ["one", "two", "three", "four", "five", "six"] as const;

function stepWord(index: number): string {
  return STEP_WORDS[index] ?? String(index + 1);
}

function formatCount(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function isApprovedPlan(runPlan: RunPlan | null): boolean {
  return Boolean(
    runPlan?.researchPlan?.approvedAt &&
      runPlan.researchPlan.approvalHash &&
      runPlan.researchPlan.approvalHash === runPlan.researchPlanProposalHash,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTypingElement(element: Element | null): boolean {
  return Boolean(
    element &&
      (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element.getAttribute("contenteditable") === "true"
      ),
  );
}
