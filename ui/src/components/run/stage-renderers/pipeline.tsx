import { useMemo } from 'react'
import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react'

import type { ArtifactPreviewTarget, StageRendererProps } from './index'
import { buildPipelineSteps, type PipelineStep, type StepStatus } from './event-model'
import { Button } from "@/components/ui/button";

// ── Sub-components ────────────────────────────────────────────────────────

function StepStatusIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case 'done':
      return (
        <CheckCircle2
          className="size-4 text-emerald-500"
          aria-label="Done"
        />
      )
    case 'running':
      return (
        <Loader2
          className="size-4 animate-spin text-primary-text"
          aria-label="Running"
        />
      )
    case 'error':
      return (
        <XCircle
          className="size-4 text-destructive"
          aria-label="Failed"
        />
      )
    case 'pending':
    default:
      return (
        <Circle
          className="size-4 text-muted-foreground/50"
          aria-label="Pending"
        />
      )
  }
}

function ArtifactBadge({
  label,
  onOpenArtifact,
  runId,
  value,
}: {
  label: 'In' | 'Out'
  onOpenArtifact?: ((target: ArtifactPreviewTarget) => void) | undefined
  runId?: string | undefined
  value: string
}) {
  const isOut = label === 'Out'
  return (
    <Button
      variant="ghost"
      size="xs"
      className={[
        'h-auto gap-1 rounded-full border px-2 py-0.5 disabled:opacity-100',
        isOut
          ? 'border-emerald-500/20 bg-emerald-500/8 text-emerald-700 hover:bg-emerald-500/12 dark:text-emerald-400'
          : 'border-primary/20 bg-primary/8 text-primary-text hover:bg-primary/12',
        runId ? '' : 'cursor-default',
      ].join(' ')}
      disabled={!runId}
      onClick={() => {
        if (!runId) return
        onOpenArtifact?.({ artifactPath: value, runId })
      }}
    >
      <span className="font-bold">{label}</span>
      {value}
    </Button>
  )
}

function PipelineStepRow({
  onOpenArtifact,
  runId,
  step,
  isLast,
}: {
  onOpenArtifact?: ((target: ArtifactPreviewTarget) => void) | undefined
  runId?: string | undefined
  step: PipelineStep
  isLast: boolean
}) {
  // Step artifacts live in the child run's directory (once the step has
  // delegated). Prefer that run id so the badge fetches the right file;
  // fall back to the parent run id before a child is known.
  const artifactRunId = step.childRunId ?? runId
  return (
    <div className="flex gap-3">
      {/* Left column: step number badge + vertical connector */}
      <div className="flex flex-col items-center">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/60 text-xs font-semibold tabular-nums text-muted-foreground">
          {step.stepIndex + 1}
        </div>
        {!isLast && <div className="my-1 w-px flex-1 bg-border/40" />}
      </div>

      {/* Right column: step content */}
      <div
        className={[
          'flex min-w-0 flex-1 flex-col gap-1.5',
          isLast ? 'pb-0' : 'pb-4',
        ].join(' ')}
      >
        {/* Step header row: status icon + name */}
        <div className="flex items-center gap-2">
          <StepStatusIcon status={step.status} />
          <span className="text-sm font-medium text-foreground">
            {step.stepName ?? `Step ${step.stepIndex + 1}`}
          </span>
        </div>

        {/* Artifact In / Out badges */}
        {(step.artifactIn ?? step.artifactOut) ? (
          <div className="flex flex-wrap gap-1.5">
            {step.artifactIn && (
              <ArtifactBadge
                label="In"
                onOpenArtifact={onOpenArtifact}
                runId={artifactRunId}
                value={step.artifactIn}
              />
            )}
            {step.artifactOut && (
              <ArtifactBadge
                label="Out"
                onOpenArtifact={onOpenArtifact}
                runId={artifactRunId}
                value={step.artifactOut}
              />
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ── PipelineRenderer ──────────────────────────────────────────────────────

/**
 * Renders a pipeline-type stage as an ordered step list.
 *
 * Features:
 * - Groups events by `stepIndex`; each group becomes one step row.
 * - Each row shows: step number, step name, status indicator
 *   (running spinner / done checkmark), and artifact In / Out labels.
 * - The currently active step (highest index with events) shows a spinner;
 *   all previous steps show a checkmark.
 * - If no events carry a `stepIndex`, falls back to a "No pipeline steps yet"
 *   placeholder rather than an empty screen.
 */
export function PipelineRenderer({ events, onOpenArtifact, runId }: StageRendererProps) {
  const steps = useMemo(() => buildPipelineSteps(events), [events])

  if (events.length === 0) {
    return (
      <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
        No events yet
      </div>
    )
  }

  if (steps.length === 0) {
    // Events exist but none have stepIndex — not yet a pipeline step stream.
    return (
      <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
        No pipeline steps yet
      </div>
    )
  }

  return (
    <div className="p-4">
      {steps.map((step, i) => (
        <PipelineStepRow
          key={step.stepIndex}
          step={step}
          isLast={i === steps.length - 1}
          onOpenArtifact={onOpenArtifact}
          runId={runId}
        />
      ))}
    </div>
  )
}
