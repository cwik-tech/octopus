/**
 * BudgetLedger — stateless budget enforcement for the pipeline runtime.
 *
 * The ledger does NOT maintain its own cost counter. All methods receive
 * `currentTotalCost` from `state.totalCost` (single source of truth).
 */

export type BudgetPolicy = 'halt' | 'warn'

export interface BudgetLedgerConfig {
  capUsd: number
  policy: BudgetPolicy
}

/**
 * Dispatcher-owned admission reused by every child model dispatch inside one
 * governed engine envelope. Hard-budget implementations serialize children so
 * each observes the total committed by its predecessor.
 */
export interface BudgetDispatchAdmission {
  readonly remainingBudget: number | undefined
  runChildDispatch<T>(input: {
    readonly signal?: AbortSignal
    readonly operation: () => Promise<T>
  }): Promise<T>
}

export function adoptBudgetDispatchAdmission(input: {
  readonly ledger: BudgetLedger | undefined
  readonly adopt: ((toolCallId: string) =>
    BudgetDispatchAdmission | undefined) | undefined
  readonly toolCallId: string
}): BudgetDispatchAdmission | undefined {
  if (!input.ledger) return undefined
  if (!input.adopt) return undefined
  const admission = input.adopt(input.toolCallId)
  if (!admission) {
    throw new Error(
      'The governed engine could not adopt its dispatcher-owned budget reservation.',
    )
  }
  return admission
}

/** Keep accumulated USD values stable at micro-dollar precision. */
export function roundUsd(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : value
}

function isValidBudgetTotal(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

// ---------------------------------------------------------------------------
// BudgetExceededError
// ---------------------------------------------------------------------------

export class BudgetExceededError extends Error {
  readonly budgetCapUsd: number
  readonly totalSpent: number
  readonly policy: BudgetPolicy

  constructor(budgetCapUsd: number, totalSpent: number, policy: BudgetPolicy) {
    super(
      `Budget exceeded: $${totalSpent.toFixed(2)} >= $${budgetCapUsd.toFixed(2)} (policy: ${policy})`,
    )
    // Set name explicitly so instanceof checks work across module boundaries
    // (e.g., when the class is imported from a different realm or bundled).
    this.name = 'BudgetExceededError'
    this.budgetCapUsd = budgetCapUsd
    this.totalSpent = totalSpent
    this.policy = policy
  }
}

// ---------------------------------------------------------------------------
// BudgetLedger
// ---------------------------------------------------------------------------

export class BudgetLedger {
  private readonly _config: BudgetLedgerConfig
  private _reservedUsd = 0
  private _nextReservationId = 1
  private readonly _reservations = new Map<number, number>()
  private _dispatchTail: Promise<void> = Promise.resolve()

  constructor(config: BudgetLedgerConfig) {
    this._config = config
  }

  // ── Getters ───────────────────────────────────────────────────────────────

  get capUsd(): number {
    return this._config.capUsd
  }

  get policy(): BudgetPolicy {
    return this._config.policy
  }

  get reservedUsd(): number {
    return this._reservedUsd
  }

  // ── Methods ───────────────────────────────────────────────────────────────

  /**
   * Returns whether a new dispatch is allowed given the current total spend.
   * When `currentTotalCost >= capUsd`, the budget is considered exceeded.
   */
  canDispatch(currentTotalCost: number): { allowed: boolean; remaining: number; reason?: string } {
    if (!isValidBudgetTotal(currentTotalCost)) {
      return { allowed: false, remaining: 0, reason: 'Invalid budget total' }
    }
    const remaining = Math.max(0, this._config.capUsd - currentTotalCost)
    if (currentTotalCost >= this._config.capUsd) {
      return { allowed: false, remaining: 0, reason: 'Budget exceeded' }
    }
    return { allowed: true, remaining }
  }

  /**
   * Hard-budget dispatches reserve all currently remaining capacity. This
   * serializes unknown-cost parallel calls so they cannot all pass the same
   * stale pre-dispatch total. The reservation is released after the call and
   * the next caller observes the updated runtime total.
   */
  reserveRemaining(currentTotalCost: number): number | null {
    if (!isValidBudgetTotal(currentTotalCost) || !Number.isFinite(this._reservedUsd)) {
      return null
    }
    const available = Math.max(
      0,
      roundUsd(this._config.capUsd - currentTotalCost - this._reservedUsd),
    )
    if (available <= 0) return null
    const id = this._nextReservationId++
    this._reservations.set(id, available)
    this._reservedUsd = roundUsd(this._reservedUsd + available)
    return id
  }

  releaseReservation(id: number): void {
    const amount = this._reservations.get(id)
    if (amount === undefined) return
    this._reservations.delete(id)
    this._reservedUsd = Math.max(0, roundUsd(this._reservedUsd - amount))
  }

  /** Acquire a cancellation-aware FIFO slot used by hard-budget execution. */
  async acquireDispatchSlot(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortReason(signal)
    const previous = this._dispatchTail
    let resolveSlot!: () => void
    let released = false
    const slot = new Promise<void>((resolve) => {
      resolveSlot = resolve
    })
    const release = () => {
      if (released) return
      released = true
      resolveSlot()
    }
    this._dispatchTail = slot
    try {
      await waitForDispatchTurn(previous, signal)
      if (signal?.aborted) throw abortReason(signal)
    } catch (error) {
      // Preserve FIFO ordering while removing this cancelled node. Successors
      // advance only after the current owner releases `previous`.
      void previous.then(release, release)
      throw error
    }
    return release
  }

  /**
   * Checks whether a stage's accumulated spend is still within its per-stage limit.
   */
  checkStageBudget(
    stageCostSoFar: number,
    stageLimit: number,
  ): { allowed: boolean; remaining: number } {
    if (!isValidBudgetTotal(stageCostSoFar) || !Number.isFinite(stageLimit) || stageLimit < 0) {
      return { allowed: false, remaining: 0 }
    }
    const remaining = Math.max(0, stageLimit - stageCostSoFar)
    if (stageCostSoFar >= stageLimit) {
      return { allowed: false, remaining: 0 }
    }
    return { allowed: true, remaining }
  }

  /**
   * Enforces the configured policy when the total spend meets or exceeds the cap.
   * - `'halt'`: throws `BudgetExceededError`
   * - `'warn'`: logs to `console.error` (non-fatal)
   */
  applyPolicy(currentTotalCost: number): void {
    if (!isValidBudgetTotal(currentTotalCost)) {
      throw new BudgetExceededError(this._config.capUsd, currentTotalCost, this._config.policy)
    }
    if (currentTotalCost < this._config.capUsd) return

    if (this._config.policy === 'halt') {
      throw new BudgetExceededError(this._config.capUsd, currentTotalCost, this._config.policy)
    }

    // policy === 'warn'
    console.error(
      `[BudgetLedger] WARNING: Budget cap reached. ` +
        `$${currentTotalCost.toFixed(2)} >= $${this._config.capUsd.toFixed(2)}. ` +
        `Continuing (policy: warn).`,
    )
  }
}

function waitForDispatchTurn(
  previous: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return previous
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void previous.then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
    )
  })
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException('Budget dispatch was cancelled.', 'AbortError')
}
