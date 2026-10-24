import type { BudgetLedger } from '../core/budget-ledger.js'

interface DirectAgentBudgetAdmission {
  readonly remainingBudget: number | undefined
}

/**
 * The Team budget refused this dispatch before it was made.
 *
 * Typed rather than a bare `Error` because callers need to tell it apart from
 * a provider failure: this one is raised before the operation that reaches the
 * provider, so the call was never sent and nothing was billed. A durable
 * coordinator slot can therefore be retried after a refusal, where an ordinary
 * failure of unknown outcome must not be.
 */
export class DirectAgentBudgetRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DirectAgentBudgetRefusedError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export async function withDirectAgentBudgetAdmission<T>(input: {
  readonly ledger: BudgetLedger | undefined
  readonly totalCost: number
  readonly signal?: AbortSignal
  readonly operation: (admission: DirectAgentBudgetAdmission) => Promise<T>
}): Promise<T> {
  const ledger = input.ledger
  if (!ledger) return input.operation({ remainingBudget: undefined })

  let releaseSlot: (() => void) | undefined
  let reservation: number | undefined
  try {
    if (ledger.policy === 'halt') {
      releaseSlot = await ledger.acquireDispatchSlot(input.signal)
    }
    const check = ledger.canDispatch(input.totalCost)
    if (!check.allowed && ledger.policy === 'halt') {
      throw new DirectAgentBudgetRefusedError(
        `The Team budget is exhausted: $${input.totalCost.toFixed(2)} spent of ` +
          `$${ledger.capUsd.toFixed(2)}.`,
      )
    }
    if (!check.allowed) ledger.applyPolicy(input.totalCost)
    if (ledger.policy === 'halt') {
      const reserved = ledger.reserveRemaining(input.totalCost)
      if (reserved === null) {
        throw new DirectAgentBudgetRefusedError(
          'The remaining Team budget is already reserved.',
        )
      }
      reservation = reserved
    }
    return await input.operation({ remainingBudget: check.remaining })
  } finally {
    if (reservation !== undefined) ledger.releaseReservation(reservation)
    releaseSlot?.()
  }
}
