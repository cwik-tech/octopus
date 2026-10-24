import {
  AlertTriangle,
  Check,
  Circle,
  Loader2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type {
  DeepResearchPlanningAttemptSnapshot,
  DeepResearchPlanningPhase,
} from "@/lib/models/session-model";

type PlanningProgressPhase =
  | "accepted"
  | "drafting"
  | "validating_draft"
  | "quality_review";

const PHASES: Array<{
  id: PlanningProgressPhase;
  label: string;
}> = [
  { id: "accepted", label: "Request accepted" },
  { id: "drafting", label: "Drafting the research plan" },
  {
    id: "validating_draft",
    label: "Checking scope, tasks, and limits",
  },
  { id: "quality_review", label: "Quality review" },
];

export function DeepResearchPlanningProgress({
  amendment,
  attempt,
  cancellationPending,
  onCancel,
  onRetry,
}: {
  amendment: boolean;
  attempt: DeepResearchPlanningAttemptSnapshot | null;
  cancellationPending: boolean;
  onCancel?: (() => void) | undefined;
  onRetry: () => void;
}) {
  const [, rerenderElapsed] = useState(0);
  const errorRef = useRef<HTMLDivElement>(null);
  const startedAt = attempt?.createdAt;
  const terminalFailure =
    attempt?.status === "failed" ||
    attempt?.status === "cancelled" ||
    attempt?.status === "superseded";

  useEffect(() => {
    if (!startedAt || terminalFailure || attempt?.status === "succeeded") {
      return undefined;
    }
    const interval = window.setInterval(
      () => rerenderElapsed((value) => value + 1),
      1_000,
    );
    return () => window.clearInterval(interval);
  }, [attempt?.status, startedAt, terminalFailure]);

  useEffect(() => {
    if (terminalFailure) errorRef.current?.focus();
  }, [terminalFailure]);

  const currentPhase = progressPhase(attempt?.phase ?? "accepted");
  const currentIndex = Math.max(
    0,
    PHASES.findIndex((phase) => phase.id === currentPhase),
  );

  if (terminalFailure) {
    return (
      <div
        className="space-y-3 rounded-xl border border-destructive/30 bg-destructive/8 p-4"
        ref={errorRef}
        role="alert"
        tabIndex={-1}
      >
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div>
            <div className="text-sm font-semibold text-foreground">
              Research planning stopped
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {attempt?.error ?? "The plan could not be prepared."}
            </p>
          </div>
        </div>
        {attempt?.retryable ? (
          <Button onClick={onRetry} size="sm" type="button" variant="outline">
            Retry
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <section
      aria-labelledby="deep-research-planning-progress-heading"
      className="rounded-xl border border-border/70 bg-card p-4 shadow-xs"
      data-testid="deep-research-plan-generating"
    >
      <div
        aria-live="polite"
        className="flex items-start justify-between gap-3"
        role="status"
      >
        <h3
          className="text-sm font-semibold text-foreground"
          id="deep-research-planning-progress-heading"
        >
          {amendment
            ? "Updating the plan after your changes"
            : "Preparing your research plan"}
        </h3>
        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <span>{formatElapsed(startedAt)}</span>
          {attempt?.status !== "succeeded" ? (
            <Loader2 className="size-4 animate-spin text-primary-text motion-reduce:animate-none" />
          ) : (
            <Check className="size-4 text-emerald-600" />
          )}
        </div>
      </div>

      <ol className="mt-4 space-y-2">
        {PHASES.map((phase, index) => {
          const completed =
            attempt?.status === "succeeded" || index < currentIndex;
          const active = index === currentIndex && !completed;
          return (
            <li
              className="flex items-center gap-2 text-xs"
              key={phase.id}
            >
              {completed ? (
                <Check className="size-3.5 text-emerald-600" />
              ) : active ? (
                <Loader2 className="size-3.5 animate-spin text-primary-text motion-reduce:animate-none" />
              ) : (
                <Circle className="size-3.5 text-muted-foreground/50" />
              )}
              <span
                className={
                  completed || active
                    ? "text-foreground"
                    : "text-muted-foreground"
                }
              >
                {phase.label}
              </span>
            </li>
          );
        })}
      </ol>

      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        You may continue reading or navigate away. Planning continues on the
        backend and reconnects when you return.
      </p>

      <div className="mt-3 flex items-center justify-between gap-2">
        <PlanningDiagnostics attempt={attempt} />
        {onCancel &&
        attempt &&
        (attempt.status === "queued" ||
          attempt.status === "running" ||
          attempt.status === "cancelling") ? (
          <Button
            disabled={cancellationPending}
            onClick={onCancel}
            size="sm"
            type="button"
            variant="ghost"
          >
            {cancellationPending ? "Cancelling…" : "Cancel"}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function PlanningDiagnostics({
  attempt,
}: {
  attempt: DeepResearchPlanningAttemptSnapshot | null;
}) {
  if (!attempt) return <span />;
  const models = Object.entries(attempt.stages)
    .filter(([, stage]) => Boolean(stage?.model))
    .map(([stageName, stage]) => (
      <li key={stageName}>
        {stageName}: {stage?.provider} / {stage?.model} / {stage?.thinking}
      </li>
    ));
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">Planning diagnostics</summary>
      <ul className="mt-1 space-y-0.5 pl-4">{models}</ul>
    </details>
  );
}

function progressPhase(
  phase: DeepResearchPlanningPhase,
): PlanningProgressPhase {
  switch (phase) {
    case "accepted":
    case "drafting":
    case "validating_draft":
      return phase;
    case "reviewing":
    case "validating_final":
    case "persisting":
    case "ready":
      return "quality_review";
  }
}

function formatElapsed(startedAt: string | undefined): string {
  if (!startedAt) return "starting now";
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return "in progress";
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1_000));
  if (seconds < 60) return `${seconds}s elapsed`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s elapsed`;
}
