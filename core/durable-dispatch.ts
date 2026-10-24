import type {
  CapabilityRecoveryPolicy,
  DurableDispatchReduction,
  DurableDispatchState,
  DurableDispatchStreamEvent,
  DurableRecoveryDecision,
} from '../contracts/durable-dispatch.js'

export type { DurableDispatchStreamEvent } from '../contracts/durable-dispatch.js'

export const DURABLE_DISPATCH_STREAM_KIND = 'capability.dispatch'

/**
 * Pure durable dispatch state machine (Phase 8 ADR §6-7). `sequence` order
 * comes from the canonical journal; this reducer only validates transitions.
 */

const PRE_EXECUTION_STATES: ReadonlySet<DurableDispatchState> = new Set([
  'requested',
  'prepared',
])

const TERMINAL_STATES: ReadonlySet<DurableDispatchState> = new Set([
  'accepted',
  'rejected',
  'cancelled',
  'failed',
])

/**
 * Reduce one dispatch stream to its current state. A stream may hold several
 * attempts: a crash before the effect leaves a retriable attempt behind, and
 * the replacement attempt opens a new `requested` segment. Each attempt is
 * reduced on its own, and an attempt may only follow one whose outcome was
 * itself admissible for retry — a new attempt after an unproven or settled
 * outcome fails closed rather than risking a duplicated effect.
 */
export function reduceDurableDispatchState(
  events: readonly DurableDispatchStreamEvent[],
): DurableDispatchReduction {
  if (events.length === 0) {
    return { kind: 'invalid', reason: 'durable_dispatch_stream_empty' }
  }
  let state: DurableDispatchState | undefined
  let attemptId: string | undefined
  for (const event of events) {
    if (event.type === 'requested' && state !== undefined) {
      const priorAttempt = resolveAttemptState(state)
      if (resolveDurableRecovery(priorAttempt).kind !== 'retriable') {
        return {
          kind: 'invalid',
          reason: `durable_dispatch_retry_not_admissible:${priorAttempt}`,
        }
      }
      state = undefined
      attemptId = undefined
    }
    if (attemptId === undefined) {
      attemptId = event.attemptId
    } else if (event.attemptId !== attemptId) {
      return {
        kind: 'invalid',
        reason: `durable_dispatch_attempt_identity_mixed:${attemptId}:${event.attemptId}`,
      }
    }
    const next = transition(state, event)
    if (!next) {
      return {
        kind: 'invalid',
        reason: `durable_dispatch_transition_forbidden:${state ?? 'none'}:${event.type}`,
      }
    }
    state = next
  }
  return { kind: 'valid', state: resolveAttemptState(state) }
}

/**
 * A crash between the started barrier and any terminal record leaves the
 * outcome unproven; recovery must treat it as indeterminate.
 */
function resolveAttemptState(
  state: DurableDispatchState | undefined,
): DurableDispatchState {
  if (state === undefined || state === 'started') return 'indeterminate'
  return state
}

function transition(
  current: DurableDispatchState | undefined,
  event: DurableDispatchStreamEvent,
): DurableDispatchState | undefined {
  if (current === undefined) {
    return event.type === 'requested' ? 'requested' : undefined
  }
  switch (current) {
    case 'requested':
      switch (event.type) {
        case 'prepared':
        case 'rejected':
        case 'cancelled':
        case 'failed':
          return event.type
        default:
          return undefined
      }
    case 'prepared':
      switch (event.type) {
        case 'started':
          return 'started'
        case 'rejected':
        case 'cancelled':
        case 'failed':
          return event.type
        default:
          return undefined
      }
    case 'started':
      switch (event.type) {
        case 'committed':
          return 'committed'
        case 'accepted':
          // Acceptance without an explicit commit record is permitted for
          // inline results where the commit and accept facts are sealed in
          // one durability window.
          return 'accepted'
        case 'failed':
          return event.effectCommitted === false ? 'failed' : 'indeterminate'
        case 'cancelled':
        case 'rejected':
        case 'indeterminate':
          return 'indeterminate'
        default:
          return resolutionTransition(event.type)
      }
    case 'committed':
      switch (event.type) {
        case 'accepted':
          return 'accepted'
        case 'indeterminate':
          return 'indeterminate'
        // An operator may confirm or abandon a recorded commit, but never
        // deny it: the commit is durable evidence and the assertion is not.
        case 'resolved_committed':
        case 'resolved_abandoned':
          return resolutionTransition(event.type)
        default:
          return undefined
      }
    case 'indeterminate':
      switch (event.type) {
        case 'committed':
          return 'committed'
        case 'failed':
          return event.effectCommitted === false ? 'failed' : undefined
        default:
          return resolutionTransition(event.type)
      }
    case 'accepted':
    case 'rejected':
    case 'cancelled':
    case 'failed':
      return undefined
  }
}

/**
 * Where an authorized operator resolution leaves an unproven attempt (ADR §7
 * option 3).
 *
 * Each decision lands on the state the machine already has for that meaning,
 * so recovery, replay and inspection read a resolved dispatch through the
 * paths they already have. The *event* is what records that an operator
 * decided it, and that event is never overwritten.
 *
 * Admissible only from the states an operator is asked about; a resolution
 * arriving anywhere else returns `undefined` and the stream is refused.
 */
function resolutionTransition(
  type: DurableDispatchStreamEvent['type'],
): DurableDispatchState | undefined {
  switch (type) {
    // The operator asserts the effect did not commit, which is exactly what
    // `failed` already means, retriable and all.
    case 'resolved_not_committed':
      return 'failed'
    // The effect committed; the acceptance that follows carries the result.
    case 'resolved_committed':
      return 'committed'
    // Terminal by decision: the dispatch must not proceed, committed or not.
    case 'resolved_abandoned':
      return 'cancelled'
    default:
      return undefined
  }
}

export function resolveDurableRecovery(
  state: DurableDispatchState,
): DurableRecoveryDecision {
  if (PRE_EXECUTION_STATES.has(state)) return { kind: 'retriable' }
  switch (state) {
    case 'accepted':
      return { kind: 'retained' }
    case 'committed':
      return { kind: 'reconcile' }
    case 'rejected':
    case 'cancelled':
      return { kind: 'terminal' }
    case 'failed':
      // A valid `failed` reduction requires proof that no effect committed —
      // either the adapter's, or an authorized operator's assertion recorded
      // in its place.
      return { kind: 'retriable' }
    case 'started':
    case 'indeterminate':
      return { kind: 'blocked' }
    default:
      return { kind: 'blocked' }
  }
}

/**
 * The policy the runtime will actually honour for a recorded value.
 *
 * Unrecognized and absent both fail closed as `unknown` (ADR §7). Exported so
 * the operator report narrows a sealed policy by the same rule the recovery
 * path uses: a report that echoed bytes the runtime would not honour would
 * predict the wrong decision.
 */
export function narrowRecoveryPolicy(value: unknown): CapabilityRecoveryPolicy {
  switch (value) {
    case 'read_only_retryable':
    case 'reconcilable':
    case 'non_retryable':
      return value
    // Including `idempotent_with_key`, which journals written before A-13
    // still carry. It is not special-cased: a policy the runtime cannot act
    // on is unknown, which is exactly how it behaved when it was declared.
    default:
      return 'unknown'
  }
}

export function resolveRecoveryAfterStarted(
  policy: CapabilityRecoveryPolicy,
): 'retry' | 'reconcile' | 'blocked' {
  switch (policy) {
    case 'read_only_retryable':
      return 'retry'
    case 'reconcilable':
      return 'reconcile'
    case 'non_retryable':
    case 'unknown':
      return 'blocked'
  }
}

export function isDurableTerminalState(state: DurableDispatchState): boolean {
  return TERMINAL_STATES.has(state) || state === 'indeterminate'
}
