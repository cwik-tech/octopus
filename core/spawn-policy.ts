import type { BudgetLedger } from './budget-ledger.js'
import { DEFAULT_MAX_SPAWN_DEPTH } from './constants.js'
import type { RuntimeState, TeamConfig } from './types.js'

export interface SpawnPolicyInput {
  state: RuntimeState
  teamConfig: TeamConfig
  activeSpawnCountRef: { count: number }
  budgetLedger?: BudgetLedger
  /** Dispatcher-owned budget lease adopted by a governed delegation call. */
  budgetAdmission?: SpawnBudgetAdmission
  subject: 'team' | 'workflow'
}

export interface SpawnBudgetAdmission {
  readonly remainingBudget: number | undefined
}

export interface SpawnPolicyLease {
  remainingBudget: number | undefined
  release(): void
}

/** Validate shared child-process limits before any delegation side effects. */
export function enforceSpawnPolicy(input: SpawnPolicyInput): number | undefined {
  const spawnLimits = input.teamConfig.composition?.spawn_limits
  const maxDepth = spawnLimits?.maxDepth ?? DEFAULT_MAX_SPAWN_DEPTH
  if (input.state.spawnDepth >= maxDepth) {
    throw new Error(
      `Cannot spawn another ${input.subject}: max spawn depth ${maxDepth} reached ` +
        `(current depth ${input.state.spawnDepth}).`,
    )
  }

  const maxConcurrent = spawnLimits?.maxConcurrent
  if (maxConcurrent != null && input.activeSpawnCountRef.count >= maxConcurrent) {
    throw new Error(
      `Cannot spawn another ${input.subject}: max concurrent child work ${maxConcurrent} reached.`,
    )
  }

  if (input.budgetAdmission) {
    const remaining = input.budgetAdmission.remainingBudget
    if (
      remaining !== undefined &&
      (!Number.isFinite(remaining) || remaining < 0)
    ) {
      throw new Error(
        `Cannot spawn another ${input.subject}: dispatcher budget admission is invalid.`,
      )
    }
    return remaining
  }

  if (!input.budgetLedger) return undefined
  const budgetCheck = input.budgetLedger.canDispatch(input.state.totalCost)
  if (!budgetCheck.allowed) {
    if (input.budgetLedger.policy === 'warn') {
      input.budgetLedger.applyPolicy(input.state.totalCost)
      return 0
    }
    throw new Error(
      `Cannot spawn another ${input.subject}: budget exceeded ` +
        `(${budgetCheck.reason ?? 'budget cap reached'}).`,
    )
  }
  return budgetCheck.remaining
}

/**
 * Serialize hard-budget child dispatches so concurrent tools cannot all observe
 * the same stale remaining balance. Warn-only budgets remain non-blocking.
 */
export async function acquireSpawnPolicy(
  input: SpawnPolicyInput,
): Promise<SpawnPolicyLease> {
  const initialRemaining = enforceSpawnPolicy(input)
  input.activeSpawnCountRef.count += 1

  if (
    input.budgetAdmission ||
    !input.budgetLedger ||
    input.budgetLedger.policy !== 'halt'
  ) {
    let released = false
    return {
      remainingBudget: initialRemaining,
      release() {
        if (released) return
        released = true
        input.activeSpawnCountRef.count = Math.max(
          0,
          input.activeSpawnCountRef.count - 1,
        )
      },
    }
  }

  let releaseSlot: (() => void) | undefined
  let reservation: number | null | undefined
  try {
    releaseSlot = await input.budgetLedger.acquireDispatchSlot()
    const budgetCheck = input.budgetLedger.canDispatch(input.state.totalCost)
    if (!budgetCheck.allowed) {
      throw new Error(
        `Cannot spawn another ${input.subject}: budget exceeded ` +
          `(${budgetCheck.reason ?? 'budget cap reached'}).`,
      )
    }
    reservation = input.budgetLedger.reserveRemaining(input.state.totalCost)
    if (reservation === null) {
      throw new Error(
        `Cannot spawn another ${input.subject}: budget capacity is already reserved.`,
      )
    }
    let released = false
    return {
      remainingBudget: budgetCheck.remaining,
      release() {
        if (released) return
        released = true
        if (typeof reservation === 'number') {
          input.budgetLedger?.releaseReservation(reservation)
        }
        input.activeSpawnCountRef.count = Math.max(
          0,
          input.activeSpawnCountRef.count - 1,
        )
        releaseSlot?.()
      },
    }
  } catch (error) {
    if (typeof reservation === 'number') {
      input.budgetLedger.releaseReservation(reservation)
    }
    input.activeSpawnCountRef.count = Math.max(
      0,
      input.activeSpawnCountRef.count - 1,
    )
    releaseSlot?.()
    throw error
  }
}
