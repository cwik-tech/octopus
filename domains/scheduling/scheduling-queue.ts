import type { ProcessCleanupHoldReason, TaskAdmissionSource } from '../../contracts/sessions.js'

export const SCHEDULING_QUEUE_SNAPSHOT_VERSION = 1 as const

export type SchedulingQueueStatus = 'ready' | 'recovering' | 'blocked'

export type SchedulingQueueItemState =
  | 'waiting'
  | 'starting'
  | 'running'
  | 'finishing'

export type SchedulingQueueItemSource = TaskAdmissionSource | 'legacy'

/**
 * Why a task holds its slot. The first two are its root: a live recorded
 * worker that does not carry the task's identity, or an identity that more
 * than one process group carries. The last two are its descendants, as
 * recorded on the task (`processCleanupHold`).
 */
export type SchedulingQueueHoldReason =
  | 'unverified_live_process'
  | 'ambiguous_marker'
  | ProcessCleanupHoldReason

export interface SchedulingQueueHold {
  readonly reason: SchedulingQueueHoldReason
  /** True for the two root reasons: nothing new is dispatched in the workspace while it stands. */
  readonly blocksDispatch: boolean
  /** `unverified_live_process`: the recorded worker's pid. Diagnostic detail. */
  readonly processId?: number
  /** `ambiguous_marker`: how many process groups carry the task's identity. Diagnostic detail. */
  readonly processGroupCount?: number
  /** Descendant reasons: when the hold was recorded. */
  readonly since?: string
}

export interface SchedulingQueueItem {
  readonly sessionId: string
  readonly taskId: string
  readonly runId: string
  readonly workflowId: string
  readonly state: SchedulingQueueItemState
  readonly executionKind: 'initial' | 'recovery' | 'continuation'
  readonly source: SchedulingQueueItemSource
  readonly requestedAt: string
  readonly startedAt?: string
  /**
   * Present while the task holds its slot for a reason the queue found on its
   * last pass. While the queue is ready and open, the snapshot's status is
   * `blocked` exactly when some item's hold blocks dispatch.
   */
  readonly hold?: SchedulingQueueHold
}

export interface SchedulingQueueSnapshot {
  readonly version: typeof SCHEDULING_QUEUE_SNAPSHOT_VERSION
  readonly status: SchedulingQueueStatus
  readonly maximumConcurrentTasks: number
  readonly slotsInUse: number
  readonly availableSlots: number
  readonly waitingCount: number
  readonly observedAt: string
  readonly items: readonly SchedulingQueueItem[]
}
