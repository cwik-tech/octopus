import * as fs from 'node:fs'
import * as path from 'node:path'

export type TaskQueueEventName =
  | 'task_queue.owner_acquired'
  | 'task_queue.owner_conflict'
  | 'task_queue.owner_reclaimed'
  | 'task_queue.index_rebuilt'
  | 'task_queue.enqueued'
  | 'task_queue.granted'
  | 'task_queue.launch_handoff'
  | 'task_queue.released'
  | 'task_queue.reconciled'
  | 'task_queue.limit_updated'
  | 'task_queue.dispatch_blocked'
  | 'task_queue.dispatch_unblocked'
  | 'task_queue.dispatch_failed'
  | 'scheduling_settings.persistence_failed'
  | 'schedules.persistence_failed'
  | 'schedules.fire_failed'

export interface TaskQueueEvent extends Record<string, unknown> {
  event: TaskQueueEventName
  timestamp?: string
}

export const TASK_QUEUE_EVENT_FILENAME = 'events.jsonl'
export const TASK_QUEUE_FALLBACK_EVENT_FILENAME = 'task-queue-events.jsonl'
const TASK_QUEUE_CONTROL_DIRECTORY_NAME = 'task-queue'

/** Best-effort local control-plane telemetry; queue correctness never depends on logging. */
export function emitWorkspaceTaskQueueEvent(
  workspacePath: string,
  event: TaskQueueEvent,
): void {
  emitTaskQueueControlEvent(
    path.join(workspacePath, TASK_QUEUE_CONTROL_DIRECTORY_NAME),
    {
      timestamp: new Date().toISOString(),
      workspace_path: path.resolve(workspacePath),
      ...event,
    },
  )
}

export function emitTaskQueueControlEvent(
  controlDirectory: string,
  event: TaskQueueEvent,
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    ...event,
  }
  try {
    appendPrivateJsonl(
      controlDirectory,
      TASK_QUEUE_EVENT_FILENAME,
      entry,
    )
  } catch {
    try {
      appendPrivateJsonl(
        path.join(path.dirname(controlDirectory), 'logs'),
        TASK_QUEUE_FALLBACK_EVENT_FILENAME,
        entry,
      )
    } catch {
      // Observability must not change owner, admission, or settings outcomes.
    }
  }
}

function appendPrivateJsonl(
  directory: string,
  filename: string,
  entry: Record<string, unknown>,
): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.chmodSync(directory, 0o700)
  const eventPath = path.join(directory, filename)
  const fd = fs.openSync(eventPath, 'a', 0o600)
  try {
    fs.writeSync(fd, `${JSON.stringify(entry)}\n`)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.chmodSync(eventPath, 0o600)
}
