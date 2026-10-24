import { Loader2, RotateCcw, Square } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { buildPipelineSteps } from '@/components/run/stage-renderers/event-model'
import { ModelSelectionNotice } from '@/components/run/chat/model-selection-notice'
import { hostDefaultNotices } from '@/components/run/tasks/host-default-notices'
import { describeSearchCapabilityStatus } from '@/components/run/tasks/task-run-model'
import { queueHoldDetail } from '@/components/run/queue/queue-overview-model'
import type { RunEvent } from '@/components/run/stage-renderers'
import type { TaskRunEntry, TaskSlotHold } from '@/components/run/tasks/task-strip'
import type { SchedulingQueueHoldReason } from '@/lib/clients/scheduling-queue-client'
import type { WorkflowStageInfo } from '@/lib/models/session-model'
import { cn } from '@/lib/utils/utils'

import {
  formatElapsedDuration,
  getElapsedDurationMs,
} from './task-timing'

const EVIDENCE_ARTIFACT_TYPE = 'observation-receipt'
const MAX_RUN_TITLE_LENGTH = 36

function abbreviateRunTitle(value: string): string {
  const title = value.trim() || 'Run'
  if (title.length <= MAX_RUN_TITLE_LENGTH) return title
  const prefix = title.slice(0, MAX_RUN_TITLE_LENGTH - 1).trimEnd()
  const wordBoundary = prefix.lastIndexOf(' ')
  const abbreviated =
    wordBoundary >= Math.floor(MAX_RUN_TITLE_LENGTH * 0.65)
      ? prefix.slice(0, wordBoundary)
      : prefix
  return `${abbreviated}…`
}

function taskHasWarnings(events: RunEvent[]): boolean {
  return events.some(
    (event) =>
      event.artifactRole === 'final' &&
      Boolean(event.artifactStatus && /warning/i.test(event.artifactStatus)),
  )
}

function getStatusPresentation(
  task: TaskRunEntry,
  events: RunEvent[],
): { dotClassName: string; label: string; valueClassName: string } {
  const hasWarnings = task.mode === 'done' && taskHasWarnings(events)

  switch (task.mode) {
    case 'queued':
      return {
        dotClassName: 'bg-amber-500 ring-amber-500/20',
        label: 'Queued',
        valueClassName: 'text-amber-500',
      }
    case 'running':
      return {
        dotClassName: 'bg-emerald-500 ring-emerald-500/20',
        label: 'Running',
        valueClassName: 'text-emerald-500',
      }
    case 'awaiting_input':
      return {
        dotClassName: 'bg-primary ring-primary/20',
        label: 'Human input required',
        valueClassName: 'text-primary-text',
      }
    case 'awaiting_model_choice':
      return {
        dotClassName: 'bg-warning ring-warning/20',
        label: 'Model choice required',
        valueClassName: 'text-warning',
      }
    case 'interrupted':
      return {
        dotClassName: 'bg-amber-500 ring-amber-500/20',
        label: 'Interrupted',
        valueClassName: 'text-amber-500',
      }
    case 'done':
      return {
        dotClassName: hasWarnings
          ? 'bg-amber-500 ring-amber-500/20'
          : 'bg-emerald-500 ring-emerald-500/20',
        label: hasWarnings
          ? 'Complete with warnings'
          : 'Complete',
        valueClassName: hasWarnings
          ? 'text-amber-500'
          : 'text-emerald-500',
      }
    case 'error':
      return {
        dotClassName: 'bg-destructive ring-destructive/20',
        label: 'Error',
        valueClassName: 'text-destructive',
      }
    case 'blocked':
      return {
        dotClassName: 'bg-amber-500 ring-amber-500/20',
        label: 'Blocked',
        valueClassName: 'text-amber-500',
      }
    case 'cancelled':
      return {
        dotClassName: 'bg-muted-foreground ring-muted-foreground/20',
        label: 'Cancelled',
        valueClassName: 'text-muted-foreground',
      }
    case 'setup':
    default:
      return {
        dotClassName: 'bg-muted-foreground ring-muted-foreground/20',
        label: 'Ready',
        valueClassName: 'text-muted-foreground',
      }
  }
}

function getStageProgress(
  task: TaskRunEntry,
  declaredStages: WorkflowStageInfo[],
  events: RunEvent[],
): { completed: number; total: number } {
  const steps = buildPipelineSteps(events)
  const eventTotal =
    steps.length === 0
      ? 0
      : Math.max(...steps.map((step) => step.stepIndex)) + 1
  const total = Math.max(declaredStages.length, eventTotal)
  const completed =
    task.mode === 'done'
      ? total
      : steps.filter((step) => step.status === 'done').length

  return { completed: Math.min(completed, total), total }
}

function countSavedEvidence(events: RunEvent[]): number {
  return new Set(
    events
      .filter(
        (event) =>
          event.type === 'artifact.written' &&
          event.artifactType === EVIDENCE_ARTIFACT_TYPE &&
          event.artifactPath,
      )
      .map((event) => `${event.runId ?? ''}:${event.artifactPath}`),
  ).size
}

interface SourceIssueSummary {
  blocked: number
  failed: number
  limited: number
  rateLimited: number
  recovered: number
  total: number
}

function summarizeSourceIssues(events: RunEvent[]): SourceIssueSummary {
  const sourceStates = new Map<string, {
    hadIssue: boolean
    hadUsable: boolean
    latestIssue?: Exclude<
      RunEvent['acquisitionIssueKind'],
      'none' | 'recovered' | 'ignored' | undefined
    >
    latestIssueAt: number
  }>()

  for (const event of events) {
    if (
      event.type !== 'research.acquisition.completed' ||
      !event.acquisitionSourceKey ||
      !event.acquisitionIssueKind
    ) {
      continue
    }
    const current = sourceStates.get(event.acquisitionSourceKey) ?? {
      hadIssue: false,
      hadUsable: false,
      latestIssueAt: Number.NEGATIVE_INFINITY,
    }
    if (event.acquisitionUsable) current.hadUsable = true
    if (
      event.acquisitionIssueKind === 'recovered' ||
      (
        event.acquisitionIssueKind !== 'none' &&
        event.acquisitionIssueKind !== 'ignored'
      )
    ) {
      current.hadIssue = true
    }
    if (
      event.acquisitionIssueKind !== 'none' &&
      event.acquisitionIssueKind !== 'recovered' &&
      event.acquisitionIssueKind !== 'ignored' &&
      event.ts >= current.latestIssueAt
    ) {
      current.latestIssue = event.acquisitionIssueKind
      current.latestIssueAt = event.ts
    }
    sourceStates.set(event.acquisitionSourceKey, current)
  }

  const summary: SourceIssueSummary = {
    blocked: 0,
    failed: 0,
    limited: 0,
    rateLimited: 0,
    recovered: 0,
    total: 0,
  }
  for (const state of sourceStates.values()) {
    if (!state.hadIssue) continue
    summary.total += 1
    if (state.hadUsable) {
      summary.recovered += 1
      continue
    }
    switch (state.latestIssue) {
      case 'blocked':
        summary.blocked += 1
        break
      case 'rate-limited':
        summary.rateLimited += 1
        break
      case 'limited':
        summary.limited += 1
        break
      case 'failed':
        summary.failed += 1
        break
      case undefined:
        summary.failed += 1
        break
    }
  }
  return summary
}

function SourceIssuesMetric({
  evidenceSaved,
  summary,
}: {
  evidenceSaved: number
  summary: SourceIssueSummary
}) {
  const details = [
    summary.blocked > 0 ? `${summary.blocked} blocked` : null,
    summary.rateLimited > 0
      ? `${summary.rateLimited} rate-limited`
      : null,
    summary.limited > 0 ? `${summary.limited} limited` : null,
    summary.failed > 0 ? `${summary.failed} unavailable or failed` : null,
    summary.recovered > 0
      ? `${summary.recovered} recovered by fallback`
      : null,
  ].filter((detail): detail is string => Boolean(detail))

  return (
    <SummaryMetric
      label="Source issues"
      valueClassName={summary.total > 0 ? 'text-amber-500' : undefined}
    >
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="link"
                aria-label={`Source issues details: ${summary.total} ${
                  summary.total === 1 ? 'issue' : 'issues'
                }`}
                className="h-auto cursor-help p-0 font-normal text-inherit underline decoration-dotted underline-offset-4"
              />
            }
          >
            {summary.total}
          </TooltipTrigger>
          <TooltipContent
            align="start"
            className="max-w-64 flex-col items-start gap-1 whitespace-normal"
            side="top"
          >
            {details.length > 0 ? (
              details.map((detail) => <span key={detail}>{detail}</span>)
            ) : (
              <span>No source issues recorded</span>
            )}
            <span>
              {evidenceSaved} usable{' '}
              {evidenceSaved === 1 ? 'source' : 'sources'} saved
            </span>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </SummaryMetric>
  )
}

function searchCapabilityBlocker(events: RunEvent[]): RunEvent | undefined {
  return events.find((event) => event.searchCapabilityBlocked)
}

function SearchCapabilityMetric({ blocker }: { blocker: RunEvent }) {
  const { searchCapabilityCause: cause, searchCapabilityRemediation: remediation } =
    blocker
  const failureCodes = blocker.searchCapabilityFailureCodes
  const status = describeSearchCapabilityStatus(failureCodes)
  return (
    <SummaryMetric label="Search capability" valueClassName="text-amber-500">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="link"
                aria-label={
                  cause
                    ? `Search capability details: ${status}. ${cause}`
                    : `Search capability details: ${status}`
                }
                className="h-auto cursor-help p-0 font-normal text-inherit underline decoration-dotted underline-offset-4"
              />
            }
          >
            {status}
          </TooltipTrigger>
          <TooltipContent
            align="start"
            className="max-w-64 flex-col items-start gap-1 whitespace-normal"
            side="top"
          >
            <span>
              {cause ??
                'This run recorded a search-capability blocker. The event predates the recorded cause fields, so it carries no cause.'}
            </span>
            <span>
              {remediation ??
                'Restore the managed browser, or clear the recorded discovery failure, then re-run the research.'}
            </span>
            <span>This is an operator action, not a source problem.</span>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </SummaryMetric>
  )
}

function SummaryMetric({
  children,
  label,
  valueClassName,
}: {
  children: ReactNode
  label: string
  valueClassName?: string | undefined
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          'mt-0.5 truncate text-base font-medium tabular-nums text-foreground',
          valueClassName,
        )}
      >
        {children}
      </div>
    </div>
  )
}

const SLOT_HOLD_SENTENCES: Record<SchedulingQueueHoldReason, string> = {
  unverified_live_process:
    "Its slot is still in use: its recorded worker is still running but cannot be confirmed as this task's, so it is not stopped automatically.",
  ambiguous_marker:
    "Its slot is still in use: more than one running process group carries this task's identity, so none of them is stopped automatically.",
  owned_processes_unverified:
    'Its slot is still in use: processes this task started may still be running.',
  descendants_unverified_without_scope:
    'Its slot is still in use: processes this task started may still be running.',
}

/**
 * Says that a task still holds its worker slot, and why when the queue has
 * said, with the pid or group count as detail after it. Adds to the card and
 * changes nothing else on it.
 */
export function SlotHoldNotice({ slotHold }: { slotHold: TaskSlotHold }) {
  const detail = queueHoldDetail(slotHold)
  return (
    <div
      aria-label="Slot still in use"
      className="rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-xs text-warning"
      role="status"
    >
      <p>
        {slotHold.reason
          ? SLOT_HOLD_SENTENCES[slotHold.reason]
          : 'Its slot is still in use while its worker is checked.'}
      </p>
      {detail ? <p className="mt-1 text-muted-foreground">{detail}</p> : null}
    </div>
  )
}

export function TaskRunSummary({
  declaredStages,
  events,
  isResuming,
  onCancel,
  onResume,
  runName,
  task,
}: {
  declaredStages: WorkflowStageInfo[]
  events: RunEvent[]
  isResuming: boolean
  onCancel?: (() => void) | undefined
  onResume?: (() => void) | undefined
  runName?: string | undefined
  task: TaskRunEntry
}) {
  const [now, setNow] = useState(() => Date.now())
  const capabilityBlocker = searchCapabilityBlocker(events)
  // A run waiting on a model choice has stopped without finishing, and the
  // elapsed time is still measured to now, so the view has to keep redrawing or
  // it shows a number frozen at whenever it last happened to render.
  const isTiming =
    task.mode === 'running' || task.mode === 'awaiting_model_choice'

  useEffect(() => {
    if (!isTiming) return

    const intervalId = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(intervalId)
  }, [isTiming, task.taskId])

  const elapsedDurationMs = getElapsedDurationMs({
    completedAt: task.completedAt,
    mode: task.mode,
    now,
    startedAt: task.startedAt,
  })
  const elapsed =
    elapsedDurationMs === null
      ? '—'
      : formatElapsedDuration(elapsedDurationMs)
  const status = getStatusPresentation(task, events)
  const stageProgress = getStageProgress(task, declaredStages, events)
  const evidenceSaved = countSavedEvidence(events)
  const sourceIssues = summarizeSourceIssues(events)
  const canResume = task.recoveryDisposition !== 'not_resumable'
  const canStop =
    task.mode === 'queued' ||
    task.mode === 'running' ||
    task.mode === 'awaiting_model_choice' ||
    task.mode === 'interrupted'
  const stopLabel =
    task.workflowId === 'deep-research-report'
      ? 'Stop research'
      : 'Stop workflow'
  const fullRunTitle = runName ?? task.label
  const runTitle = abbreviateRunTitle(fullRunTitle)
  // Derived from the run's own records, one per host attempt. Placed here
  // rather than in the timeline because the host's model is a fact about the
  // run as a whole, and because this is on screen from the first event —
  // the record is written before the provider is called, so a person sees which
  // pair is being used while it is being used.
  const hostNotices = hostDefaultNotices(events)

  return (
    <Card
      aria-label="Run summary"
      className="mb-3 shrink-0 gap-4 rounded-none bg-transparent py-4 ring-0"
    >
      <CardHeader className="px-4">
        <CardTitle className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <span
            aria-hidden="true"
            className={cn(
              'size-3 shrink-0 rounded-full ring-4',
              status.dotClassName,
            )}
          />
          <span className="truncate" title={fullRunTitle}>
            {runTitle}
          </span>
        </CardTitle>
      </CardHeader>

      {hostNotices.length > 0 ? (
        <div className="px-4">
          <ModelSelectionNotice selections={hostNotices} />
        </div>
      ) : null}

      {task.slotHold ? (
        <div className="px-4">
          <SlotHoldNotice slotHold={task.slotHold} />
        </div>
      ) : null}

      <CardContent className="grid grid-cols-2 gap-x-5 gap-y-3 px-4">
        <SummaryMetric label="Elapsed">{elapsed}</SummaryMetric>
        <SummaryMetric
          label="Status"
          valueClassName={status.valueClassName}
        >
          {status.label}
        </SummaryMetric>
        <SummaryMetric label="Tasks done">
          {stageProgress.completed} / {stageProgress.total}
        </SummaryMetric>
        <SourceIssuesMetric
          evidenceSaved={evidenceSaved}
          summary={sourceIssues}
        />
        {capabilityBlocker ? (
          <SearchCapabilityMetric blocker={capabilityBlocker} />
        ) : null}
      </CardContent>

      {onCancel ? (
        <div className="px-4">
          <Button
            aria-label={stopLabel}
            className="h-8 w-full text-xs"
            disabled={!canStop}
            onClick={onCancel}
            type="button"
            variant="destructive"
          >
            <Square className="size-3.5" aria-hidden="true" />
            {stopLabel}
          </Button>
        </div>
      ) : null}

      {task.mode === 'interrupted' ? (
        <div className="px-4">
          <Button
            className="h-8 w-full text-xs"
            disabled={!canResume || isResuming || !onResume}
            onClick={onResume}
            type="button"
            variant="outline"
          >
            {isResuming ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RotateCcw className="size-3.5" aria-hidden="true" />
            )}
            {isResuming ? 'Resuming…' : 'Resume'}
          </Button>
        </div>
      ) : null}
    </Card>
  )
}
