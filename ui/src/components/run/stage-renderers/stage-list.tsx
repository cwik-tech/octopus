import { useMemo } from 'react'
import { Check, Lock, XCircle } from 'lucide-react'

import type { WorkflowStageInfo } from '@/lib/models/session-model'
import { formatDisplayName } from '@/lib/utils/display-name'
import { buildPipelineSteps, type PipelineStep } from './event-model'
import type { ArtifactPreviewTarget, RunEvent } from './index'
import { Button } from "@/components/ui/button";

// ── Types ─────────────────────────────────────────────────────────────────

type StageStatus = 'done' | 'active' | 'pending' | 'error'

interface StageRow {
  key: string
  index: number
  name: string
  team: string | undefined
  status: StageStatus
  artifactIn: string | undefined
  artifactOut: string | undefined
  /** Run id to fetch this stage's artifacts from (the child run). */
  artifactRunId: string | undefined
}

function isTerminalRunEvent(event: RunEvent): boolean {
  return (
    event.type === 'run.completed' ||
    event.type === 'run.failed' ||
    event.type === 'run.blocked' ||
    event.type === 'run.cancelled'
  )
}

function isTerminalEventForRootRun(event: RunEvent, rootRunId: string | undefined): boolean {
  if (!isTerminalRunEvent(event)) return false

  // Child run events share the workflow root id, so `root_run_id` alone cannot
  // identify terminal workflow state. When both ids are available, use the
  // source run id; retain legacy behavior for old fixtures/events that omit it.
  return !rootRunId || !event.runId || event.runId === rootRunId
}

// ── Row builder ─────────────────────────────────────────────────────────────

/**
 * Merges the workflow's *declared* stages with *live* status from the event
 * stream. The declared list is shown in full from the moment the run starts —
 * stages that have not begun yet render as `pending`. When declared stages are
 * unavailable (e.g. the fetch failed), it falls back to the live steps alone.
 */
function buildStageRows(
  declaredStages: WorkflowStageInfo[],
  events: RunEvent[],
  rootRunId: string | undefined,
  fallback: { taskCompleted?: boolean; taskFailed?: boolean } = {},
): StageRow[] {
  // Child terminal events are kept in the full event stream for activity, but
  // they must not make a workflow stage look complete before the root run
  // decides its own lifecycle outcome.
  const stageEvents = events.filter(
    (event) => !isTerminalRunEvent(event) || isTerminalEventForRootRun(event, rootRunId),
  )
  const liveSteps = buildPipelineSteps(stageEvents)
  const liveByIndex = new Map<number, PipelineStep>()
  for (const step of liveSteps) liveByIndex.set(step.stepIndex, step)

  // Primary signal: terminal events on the event stream for the root run.
  // Fallback: when the task store has already transitioned the task to a
  // terminal state but the SSE stream missed the terminal event (e.g. closed
  // prematurely), trust the task status so the stage list does not blink
  // indefinitely on a finished run.
  const runFinished =
    events.some(
      (event) => event.type === 'run.completed' && isTerminalEventForRootRun(event, rootRunId),
    ) || Boolean(fallback.taskCompleted)
  const runStopped =
    events.some(
      (event) =>
        (event.type === 'run.failed' ||
          event.type === 'run.blocked' ||
          event.type === 'run.cancelled') &&
        isTerminalEventForRootRun(event, rootRunId),
    ) || Boolean(fallback.taskFailed)

  const resolveStatus = (live: PipelineStep | undefined): StageStatus => {
    if (!live) {
      // A run that has already finished must not leave declared stages
      // looking pending — they ran (or were skipped) and the workflow
      // returned. Surface them as done unless the run failed.
      return runStopped ? 'error' : runFinished ? 'done' : 'pending'
    }
    if (live.status === 'error') return 'error'
    if (live.status === 'done') return 'done'
    // 'running' — but if the whole run has finished, treat it as done.
    return runStopped ? 'error' : runFinished ? 'done' : 'active'
  }

  if (declaredStages.length > 0) {
    return declaredStages.map((stage, index) => {
      const live = liveByIndex.get(index)
      return {
        key: `${index}:${stage.id}`,
        index,
        name: stage.id,
        team: stage.team,
        status: resolveStatus(live),
        artifactIn: live?.artifactIn ?? stage.inputArtifact,
        artifactOut: live?.artifactOut ?? stage.resultArtifact,
        artifactRunId: live?.childRunId,
      }
    })
  }

  // Fallback: no declared stages — surface whatever the events reveal.
  return liveSteps.map((live) => ({
    key: `${live.stepIndex}:${live.stepName ?? 'step'}`,
    index: live.stepIndex,
    name: live.stepName ?? `Step ${live.stepIndex + 1}`,
    team: undefined,
    status: resolveStatus(live),
    artifactIn: live.artifactIn,
    artifactOut: live.artifactOut,
    artifactRunId: live.childRunId,
  }))
}

// ── Sub-components ────────────────────────────────────────────────────────

function StageStatusIcon({ status }: { status: StageStatus }) {
  switch (status) {
    case 'done':
      return <Check className="size-4 text-emerald-500" aria-label="Done" />
    case 'active':
      // A pulsing orange dot marks the stage currently executing.
      return (
        <span
          className="flex size-4 items-center justify-center"
          aria-label="Active"
          role="img"
        >
          <span className="size-2.5 animate-pulse rounded-full bg-orange-500" />
        </span>
      )
    case 'error':
      return <XCircle className="size-4 text-destructive" aria-label="Failed" />
    case 'pending':
    default:
      return (
        <Lock className="size-3.5 text-muted-foreground/40" aria-label="Pending" />
      )
  }
}

function StageNumber({ index, status }: { index: number; status: StageStatus }) {
  const base =
    'flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums'
  const byStatus: Record<StageStatus, string> = {
    done: 'border-emerald-500/60 bg-emerald-500/10 text-emerald-500',
    active:
      'animate-pulse border-orange-500/60 bg-orange-500/10 text-orange-500 ring-2 ring-orange-500/15',
    error: 'border-destructive/40 bg-destructive/10 text-destructive',
    pending: 'border-border/40 bg-muted/30 text-muted-foreground/50',
  }
  return <div className={[base, byStatus[status]].join(' ')}>{index + 1}</div>
}

function StageArtifactBadge({
  label,
  onOpenArtifact,
  runId,
  value,
}: {
  label: 'In' | 'Out'
  onOpenArtifact?: ((target: ArtifactPreviewTarget) => void) | undefined
  runId: string | undefined
  value: string
}) {
  // Only clickable once we know which run holds the file (the child run). Before
  // that the artifact either does not exist yet or is not addressable, so the
  // badge stays inert rather than 404-ing.
  const clickable = Boolean(runId)
  return (
    <Button
      variant="ghost"
      size="xs"
      className={[
        'h-auto gap-1 rounded-full border px-2 py-0.5',
        'border-border/60 bg-muted/40 text-muted-foreground disabled:opacity-100',
        clickable ? 'hover:bg-muted/70 hover:text-foreground' : 'cursor-default',
      ].join(' ')}
      disabled={!clickable}
      onClick={() => {
        if (runId) onOpenArtifact?.({ artifactPath: value, runId })
      }}
    >
      <span className="font-bold">{label}</span>
      {value}
    </Button>
  )
}

function StageRowView({
  onOpenArtifact,
  row,
  isLast,
}: {
  onOpenArtifact?: ((target: ArtifactPreviewTarget) => void) | undefined
  row: StageRow
  isLast: boolean
}) {
  const dimmed = row.status === 'pending'
  return (
    <div className="flex gap-3">
      {/* Left rail: number badge + connector */}
      <div className="flex flex-col items-center">
        <StageNumber index={row.index} status={row.status} />
        {!isLast && <div className="my-1 w-px flex-1 bg-border/40" />}
      </div>

      {/* Content */}
      <div className={['flex min-w-0 flex-1 flex-col gap-1.5', isLast ? 'pb-0' : 'pb-4'].join(' ')}>
        <div className="flex min-w-0 items-center gap-2">
          <StageStatusIcon status={row.status} />
          <div className="min-w-0">
            <span
              className={[
                'block truncate text-sm font-medium',
                dimmed ? 'text-muted-foreground/60' : 'text-foreground',
                row.status === 'active' ? 'font-semibold' : '',
              ].join(' ')}
            >
              {formatDisplayName(row.name)}
            </span>
            {row.team ? (
              <span className="block truncate text-xs text-muted-foreground">
                {formatDisplayName(row.team)}
              </span>
            ) : null}
          </div>
        </div>

        {(row.artifactIn ?? row.artifactOut) ? (
          <div className={['flex flex-wrap gap-1.5', dimmed ? 'opacity-60' : ''].join(' ')}>
            {row.artifactIn && (
              <StageArtifactBadge
                label="In"
                onOpenArtifact={onOpenArtifact}
                runId={row.artifactRunId}
                value={row.artifactIn}
              />
            )}
            {row.artifactOut && (
              <StageArtifactBadge
                label="Out"
                onOpenArtifact={onOpenArtifact}
                runId={row.artifactRunId}
                value={row.artifactOut}
              />
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ── StageList ───────────────────────────────────────────────────────────────

/**
 * The stage view shown at the top of the Live tab. Renders every stage the
 * workflow is expected to run — from the very first moment — and reflects live
 * progress: the active stage blinks orange, completed stages are green, and stages
 * that have not started yet are greyed with a lock icon.
 *
 * `taskCompleted` is a fallback signal sourced from the task record's terminal
 * status. The live event stream is the primary source of truth, but if the SSE
 * stream closes before `run.completed` arrives (network drop, render race, etc.),
 * a task that the store considers done must still render a done stage list
 * instead of blinking forever.
 */
export function StageList({
  declaredStages,
  events,
  onOpenArtifact,
  rootRunId,
  taskCompleted = false,
  taskFailed = false,
}: {
  declaredStages: WorkflowStageInfo[]
  events: RunEvent[]
  onOpenArtifact?: (target: ArtifactPreviewTarget) => void
  /** Workflow task run id; excludes child terminal events from stage state. */
  rootRunId?: string
  /** Task record says the run reached a done state. Fallback for run.completed. */
  taskCompleted?: boolean
  /** Task record says the run failed/was cancelled. Fallback for run.failed. */
  taskFailed?: boolean
}) {
  // Artifact run ids are resolved per-stage from child runs, so no parent
  // runId is needed here.
  const rows = useMemo(
    () => buildStageRows(declaredStages, events, rootRunId, { taskCompleted, taskFailed }),
    [declaredStages, events, rootRunId, taskCompleted, taskFailed],
  )

  if (rows.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-muted-foreground">
        Waiting for the workflow to report its stages…
      </div>
    )
  }

  return (
    <div>
      {rows.map((row, i) => (
        <StageRowView
          key={row.key}
          row={row}
          isLast={i === rows.length - 1}
          onOpenArtifact={onOpenArtifact}
        />
      ))}
    </div>
  )
}

export default StageList
