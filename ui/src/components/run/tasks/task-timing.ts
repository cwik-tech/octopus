export type TimedTaskMode =
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

export interface TaskTiming {
  startedAt?: number | undefined
  completedAt?: number | undefined
  mode: TimedTaskMode
}

const TERMINAL_TASK_MODES = new Set<TimedTaskMode>([
  'interrupted',
  'done',
  'error',
  'blocked',
  'cancelled',
])

function isTimestamp(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function parseFirstTimestamp(...values: Array<string | undefined>): number | undefined {
  for (const value of values) {
    if (!value) continue
    const timestamp = Date.parse(value)
    if (!Number.isNaN(timestamp)) return timestamp
  }
  return undefined
}

export function isTerminalTaskMode(mode: TimedTaskMode): boolean {
  return TERMINAL_TASK_MODES.has(mode)
}

/**
 * Uses the persisted completion time for a terminal task, while active tasks
 * measure from their actual execution start through the supplied current time.
 */
export function getElapsedDurationMs({
  startedAt,
  completedAt,
  mode,
  now,
}: TaskTiming & { now: number }): number | null {
  if (mode === 'setup' || mode === 'queued') return null
  if (!isTimestamp(startedAt)) return null

  const endAt =
    isTerminalTaskMode(mode) && isTimestamp(completedAt) ? completedAt : now

  return Math.max(0, endAt - startedAt)
}

export function formatElapsedDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  const minuteAndSecond = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return hours > 0 ? `${hours}:${minuteAndSecond}` : minuteAndSecond
}
