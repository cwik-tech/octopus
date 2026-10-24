import type { CapabilityAssignmentScope } from './capability-dispatch.js'
import type { DurableTeardownRegistry } from './durable-dispatch.js'

/** Refusal reasons are typed so callers map them without string matching. */
export type CapabilityDispatchLifecycleRefusalCode =
  | 'lifecycle_shutting_down'
  | 'assignment_released'

export type CapabilityDispatchLifecycleRunOutcome<T> =
  | { readonly kind: 'ran'; readonly result: T }
  | {
      readonly kind: 'refused'
      readonly code: CapabilityDispatchLifecycleRefusalCode
    }

/**
 * The one admission/drain/finalization authority shared by every dispatch
 * participant in the process. Participants never track themselves: `run`
 * checks the barriers, registers the operation, and only then lets it start.
 */
export interface CapabilityDispatchLifecycle {
  run<T>(input: {
    readonly scope: CapabilityAssignmentScope
    readonly operation: (signal: AbortSignal) => Promise<T>
  }): Promise<CapabilityDispatchLifecycleRunOutcome<T>>
  readonly teardown: DurableTeardownRegistry
  /** Refuse new operations without disturbing work already running (AC18). */
  beginShutdown(): void
  /** Drain until the absolute deadline, finalize what is left, then return. */
  close(options?: { readonly deadlineMs?: number }): Promise<void>
  /** Bar the assignment, drain and finalize its operations. */
  releaseAssignment(scope: CapabilityAssignmentScope): Promise<void>
}
