import { CheckCircle2, Circle, CircleAlert, CirclePause, Clock3, Loader2, MinusCircle, Square, X, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import type { SchedulingQueueHoldReason } from '@/lib/clients/scheduling-queue-client'
import type { SessionTask } from '@/lib/models/session-model'

import {
  formatElapsedDuration,
  getElapsedDurationMs,
} from './task-timing'

// ── Types ──────────────────────────────────────────────────────────────────
// Defined locally; mirrors domains/sessions/run-event-types.ts (created by T1).
// T4 can import from shared once that module is accessible in the UI build.

export type TaskMode =
  | 'setup'
  | 'queued'
  | 'running'
  | 'awaiting_input'
  | 'awaiting_model_choice'
  | 'interrupted'
  | 'done'
  | 'error'
  | 'blocked'
  | 'cancelled'

export interface TaskRunEntry {
  taskId: string
  runId: string
  /** Workflow this task runs — used to load the declared stage list. */
  workflowId?: string | undefined
  targetKind?: SessionTask['targetKind']
  teamId?: string
  /** The turn that asked for this task, when it had one. */
  sourceTurn?: SessionTask['sourceTurn']
  /** Legacy schedule identity, retained after task records are projected for display. */
  isScheduled?: boolean
  label: string
  mode: TaskMode
  startedAt?: number | undefined
  completedAt?: number | undefined
  errorMessage?: string | undefined
  executionKind?: 'initial' | 'recovery' | 'continuation' | undefined
  executionAttemptId?: string | undefined
  executionAttemptNumber?: number | undefined
  recoveryCount?: number | undefined
  recoveryDisposition?: 'automatic' | 'manual' | 'not_resumable' | undefined
  recoveryReason?: string | undefined
  /** Present while the task still holds its worker slot; see `TaskSlotHold`. */
  slotHold?: TaskSlotHold | undefined
}

/**
 * Why a task still holds its worker slot. `reason` is absent while only the
 * task record is known: a finished task whose grant the queue has not yet
 * released. The queue snapshot supplies the live root reason and its detail.
 */
export interface TaskSlotHold {
  reason?: SchedulingQueueHoldReason | undefined
  processId?: number | undefined
  processGroupCount?: number | undefined
  since?: string | undefined
}

// ── StatusIcon ─────────────────────────────────────────────────────────────

function StatusIcon({ mode }: { mode: TaskMode }) {
  switch (mode) {
    case 'queued':
      return (
        <Clock3
          className="size-3.5 text-amber-500"
          aria-label="Queued"
        />
      )
    case 'running':
      return (
        <Loader2
          className="size-3.5 animate-spin text-primary-text"
          aria-label="Running"
        />
      )
    case 'awaiting_input':
      return (
        <CirclePause
          className="size-3.5 text-primary-text"
          aria-label="Human input required"
        />
      )
    case 'awaiting_model_choice':
      return (
        <CirclePause
          className="size-3.5 text-warning"
          aria-label="Model choice required"
        />
      )
    case 'interrupted':
      return (
        <CirclePause
          className="size-3.5 text-amber-500"
          aria-label="Interrupted"
        />
      )
    case 'done':
      return (
        <CheckCircle2
          className="size-3.5 text-emerald-500"
          aria-label="Done"
        />
      )
    case 'error':
      return (
        <XCircle
          className="size-3.5 text-destructive"
          aria-label="Error"
        />
      )
    case 'blocked':
      return (
        <CircleAlert
          className="size-3.5 text-amber-500"
          aria-label="Blocked"
        />
      )
    case 'cancelled':
      return (
        <MinusCircle
          className="size-3.5 text-muted-foreground"
          aria-label="Cancelled"
        />
      )
    case 'setup':
    default:
      return (
        <Circle
          className="size-3.5 text-muted-foreground"
          aria-label="Setup"
        />
      )
  }
}

// ── TaskTab ────────────────────────────────────────────────────────────────

interface TaskTabProps {
  entry: TaskRunEntry
  isActive: boolean
  onSelect: () => void
  onCancel: () => void
}

function TaskTab({ entry, isActive, onSelect, onCancel }: TaskTabProps) {
  const isCancellable =
    entry.mode === 'queued' ||
    entry.mode === 'running' ||
    entry.mode === 'awaiting_input' ||
    entry.mode === 'awaiting_model_choice' ||
    entry.mode === 'interrupted'

  return (
    <div
      className={[
        'group flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm transition-colors',
        isActive
          ? 'border-primary/30 bg-primary/8 text-foreground'
          : 'border-border/60 bg-background/60 text-muted-foreground hover:bg-muted/55 hover:text-foreground',
      ].join(' ')}
    >
      {/* Status icon */}
      <StatusIcon mode={entry.mode} />

      {/* Tab label — clickable to select */}
      <Button
        variant="ghost"
        size="xs"
        onClick={onSelect}
        className="h-auto max-w-35 truncate px-0 text-left hover:bg-transparent"
        aria-label={`Select task: ${entry.label}`}
        aria-current={isActive ? 'true' : undefined}
      >
        {entry.label}
      </Button>

      {/* Interrupted tasks remain active until the user resumes or cancels them. */}
      {isCancellable && (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={(event) => {
            event.stopPropagation()
            onCancel()
          }}
          className={[
            'ml-0.5 size-4 text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
            // Show on hover/focus; always show when active (mobile)
            'opacity-60 group-hover:opacity-100 focus-visible:opacity-100',
          ].join(' ')}
          aria-label={`Cancel task: ${entry.label}`}
        >
          <X />
        </Button>
      )}
    </div>
  )
}

// ── TaskElapsedTimer ──────────────────────────────────────────────────────

function TaskElapsedTimer({ entry }: { entry: TaskRunEntry }) {
  const [now, setNow] = useState(() => Date.now())
  // Still moving while the run waits on a model choice: the wait is unfinished
  // time, and `getElapsedDurationMs` measures it to now.
  const isRunning =
    entry.mode === 'running' || entry.mode === 'awaiting_model_choice'

  useEffect(() => {
    if (!isRunning) return

    const intervalId = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(intervalId)
  }, [entry.taskId, isRunning])

  const elapsedDurationMs = getElapsedDurationMs({
    mode: entry.mode,
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
    now,
  })

  if (elapsedDurationMs === null) return null

  const duration = formatElapsedDuration(elapsedDurationMs)
  return (
    <div
      className="flex shrink-0 items-center gap-1.5 px-1 text-xs font-medium tabular-nums text-muted-foreground"
      aria-label={`Elapsed time: ${duration}`}
      title="Elapsed time"
    >
      <Clock3 className="size-3.5" aria-hidden="true" />
      <time dateTime={`PT${Math.floor(elapsedDurationMs / 1_000)}S`}>{duration}</time>
    </div>
  )
}

// ── TaskStrip ──────────────────────────────────────────────────────────────

export interface TaskStripProps {
  tasks: TaskRunEntry[]
  activeTaskId: string | null
  onSelect: (taskId: string) => void
  onCancel: (taskId: string) => void
}

export function TaskStrip({
  tasks,
  activeTaskId,
  onSelect,
  onCancel,
}: TaskStripProps) {
  // Empty array → render nothing
  if (tasks.length === 0) return null
  const activeTask = tasks.find((task) => task.taskId === activeTaskId) ?? null

  return (
    <div
      className="flex items-center gap-2 border-b border-border/60 px-3 py-2"
    >
      <div
        className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto scrollbar-none"
        role="tablist"
        aria-label="Task history"
      >
        {tasks.map((entry) => (
          <TaskTab
            key={entry.taskId}
            entry={entry}
            isActive={entry.taskId === activeTaskId}
            onSelect={() => onSelect(entry.taskId)}
            onCancel={() => onCancel(entry.taskId)}
          />
        ))}
      </div>
      {(activeTask?.mode === 'running' ||
        activeTask?.mode === 'awaiting_input' ||
        activeTask?.mode === 'awaiting_model_choice') && (
        <Button
          aria-label={`Stop workflow: ${activeTask.label}`}
          className="shrink-0"
          size="xs"
          type="button"
          variant="destructive"
          onClick={() => onCancel(activeTask.taskId)}
        >
          <Square className="size-3" aria-hidden="true" />
          Stop
        </Button>
      )}
      {activeTask && <TaskElapsedTimer key={activeTask.taskId} entry={activeTask} />}
    </div>
  )
}

export default TaskStrip
