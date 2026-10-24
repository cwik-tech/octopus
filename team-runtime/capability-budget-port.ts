import { AsyncLocalStorage } from 'node:async_hooks'

import type {
  CapabilityBudgetPort,
  CapabilityBudgetPreflight,
  CapabilityBudgetReservation,
  CapabilityBudgetSettlement,
  CapabilityExecutionContext,
  CapabilityInvocationIdentity,
} from '../contracts/capability-dispatch.js'
import {
  BudgetLedger,
  roundUsd,
  type BudgetDispatchAdmission,
} from '../core/budget-ledger.js'
import { ENGINE_TOOL_CAPABILITY_IDS } from '../services/engine-capability-adapter.js'

const TEAM_RUNTIME_METERED_ENGINE_CAPABILITIES: ReadonlySet<string> = new Set(
  Object.values(ENGINE_TOOL_CAPABILITY_IDS),
)

/** Production metering boundary for Team Runtime engine capabilities. */
export function isTeamRuntimeEngineCapabilityMetered(
  capabilityId: string,
): boolean {
  return TEAM_RUNTIME_METERED_ENGINE_CAPABILITIES.has(capabilityId)
}

export interface TeamRuntimeCapabilityBudgetPortOptions {
  readonly ledger: BudgetLedger | undefined
  readonly readTotalCostUsd: () => number
  readonly isMetered: (capabilityId: string) => boolean
}

export interface AdoptedCapabilityBudget extends BudgetDispatchAdmission {}

interface ActiveBudgetReservation {
  readonly reservationId: string
  readonly toolCallId: string
  readonly invocationKey: string
  readonly initialTotalCostUsd: number
  readonly remainingBudget: number | undefined
  readonly ledgerReservationId?: number
  readonly releaseSlot?: () => void
  childDispatchTail: Promise<void>
  adopted: boolean
}

/**
 * Single owner for a governed Team Runtime call's BudgetLedger FIFO and
 * reservation. Raw delegation code may adopt, but never release, this lease.
 */
export class TeamRuntimeCapabilityBudgetPort implements CapabilityBudgetPort {
  private readonly reservations = new Map<string, ActiveBudgetReservation>()
  private readonly reservationsByInvocationKey = new Map<
    string,
    ActiveBudgetReservation
  >()
  private readonly adoptionScope = new AsyncLocalStorage<ActiveBudgetReservation>()
  private nextReservationId = 1
  private settlementUncertain = false

  constructor(private readonly options: TeamRuntimeCapabilityBudgetPortOptions) {}

  async preflight(
    input: Parameters<CapabilityBudgetPort['preflight']>[0],
  ): Promise<CapabilityBudgetPreflight> {
    const ledger = this.options.ledger
    if (!ledger || !this.options.isMetered(input.invocation.capabilityId)) {
      return { kind: 'not-metered' }
    }
    if (this.settlementUncertain && ledger.policy === 'halt') {
      return {
        kind: 'rejected',
        code: 'budget_settlement_uncertain',
        reason: 'A prior metered Team Runtime cost could not be settled.',
      }
    }
    const totalCostUsd = this.options.readTotalCostUsd()
    if (!isValidCost(totalCostUsd)) {
      return {
        kind: 'rejected',
        code: 'budget_total_invalid',
        reason: 'The Team Runtime budget total is invalid.',
      }
    }
    const check = ledger.canDispatch(totalCostUsd)
    if (!check.allowed && ledger.policy === 'halt') {
      return {
        kind: 'rejected',
        code: 'budget_exceeded',
        reason: check.reason ?? 'The Team Runtime budget is exhausted.',
      }
    }
    if (!check.allowed) ledger.applyPolicy(totalCostUsd)
    return { kind: 'metered', estimateUsd: check.remaining }
  }

  async reserve(
    input: Parameters<CapabilityBudgetPort['reserve']>[0],
  ): Promise<CapabilityBudgetReservation> {
    const ledger = this.options.ledger
    if (!ledger || !this.options.isMetered(input.invocation.capabilityId)) {
      throw new Error('A non-metered Team Runtime capability cannot reserve budget.')
    }
    const invocationKey = makeInvocationKey(input.context, input.invocation)
    if (this.reservationsByInvocationKey.has(invocationKey)) {
      throw new Error('The Team Runtime invocation already owns a budget reservation.')
    }

    let releaseSlot: (() => void) | undefined
    let ledgerReservationId: number | undefined
    try {
      if (ledger.policy === 'halt') {
        releaseSlot = await ledger.acquireDispatchSlot(input.signal)
      }
      if (this.settlementUncertain && ledger.policy === 'halt') {
        throw new Error('A prior metered Team Runtime cost could not be settled.')
      }
      const totalCostUsd = this.options.readTotalCostUsd()
      if (!isValidCost(totalCostUsd)) {
        throw new Error('The Team Runtime budget total is invalid.')
      }
      const check = ledger.canDispatch(totalCostUsd)
      if (!check.allowed && ledger.policy === 'halt') {
        throw new Error(check.reason ?? 'The Team Runtime budget is exhausted.')
      }
      if (!check.allowed) ledger.applyPolicy(totalCostUsd)
      if (ledger.policy === 'halt') {
        const reserved = ledger.reserveRemaining(totalCostUsd)
        if (reserved === null) {
          throw new Error('The Team Runtime budget capacity is already reserved.')
        }
        ledgerReservationId = reserved
      }

      const reservationId = `team-runtime-budget-${this.nextReservationId++}`
      const reservation: ActiveBudgetReservation = {
        reservationId,
        toolCallId: input.invocation.toolCallId,
        invocationKey,
        initialTotalCostUsd: totalCostUsd,
        remainingBudget: check.remaining,
        ...(ledgerReservationId === undefined ? {} : { ledgerReservationId }),
        ...(releaseSlot ? { releaseSlot } : {}),
        childDispatchTail: Promise.resolve(),
        adopted: false,
      }
      this.reservations.set(reservationId, reservation)
      this.reservationsByInvocationKey.set(invocationKey, reservation)
      return { reservationId }
    } catch (error) {
      if (ledgerReservationId !== undefined) {
        ledger.releaseReservation(ledgerReservationId)
      }
      releaseSlot?.()
      throw error
    }
  }

  adopt(toolCallId: string): AdoptedCapabilityBudget | undefined {
    const reservation = this.adoptionScope.getStore()
    if (
      !reservation ||
      reservation.toolCallId !== toolCallId ||
      this.reservations.get(reservation.reservationId) !== reservation ||
      reservation.adopted
    ) {
      return undefined
    }
    reservation.adopted = true
    return {
      remainingBudget: reservation.remainingBudget,
      runChildDispatch: (input) =>
        this.runChildDispatch(reservation, input),
    }
  }

  async runWithAdoptionScope<T>(input: {
    readonly context: CapabilityExecutionContext
    readonly invocation: CapabilityInvocationIdentity
    readonly operation: () => Promise<T>
  }): Promise<T> {
    const reservation = this.reservationsByInvocationKey.get(
      makeInvocationKey(input.context, input.invocation),
    )
    return reservation
      ? this.adoptionScope.run(reservation, input.operation)
      : input.operation()
  }

  async settle(
    input: Parameters<CapabilityBudgetPort['settle']>[0],
  ): Promise<CapabilityBudgetSettlement> {
    const reservation = this.requireReservation(input.reservation)
    if (input.actualCostUsd === undefined || !isValidCost(input.actualCostUsd)) {
      this.latchSettlementUncertainty()
      return { costTracked: false, budgetOverrun: false }
    }
    const totalAfterCall = roundUsd(
      reservation.initialTotalCostUsd + input.actualCostUsd,
    )
    const capUsd = this.options.ledger?.capUsd
    return {
      costTracked: true,
      budgetOverrun: capUsd !== undefined && totalAfterCall > capUsd,
      actualCostUsd: input.actualCostUsd,
    }
  }

  markSettlementUncertain(): void {
    this.latchSettlementUncertainty()
  }

  async release(reservation: CapabilityBudgetReservation): Promise<void> {
    const active = this.reservations.get(reservation.reservationId)
    if (!active) return
    this.reservations.delete(active.reservationId)
    if (this.reservationsByInvocationKey.get(active.invocationKey) === active) {
      this.reservationsByInvocationKey.delete(active.invocationKey)
    }
    if (active.ledgerReservationId !== undefined) {
      this.options.ledger?.releaseReservation(active.ledgerReservationId)
    }
    active.releaseSlot?.()
  }

  private requireReservation(
    reservation: CapabilityBudgetReservation,
  ): ActiveBudgetReservation {
    const active = this.reservations.get(reservation.reservationId)
    if (!active) throw new Error('The Team Runtime budget reservation is unknown.')
    return active
  }

  private async runChildDispatch<T>(
    reservation: ActiveBudgetReservation,
    input: {
      readonly signal?: AbortSignal
      readonly operation: () => Promise<T>
    },
  ): Promise<T> {
    if (this.reservations.get(reservation.reservationId) !== reservation) {
      throw new Error('The Team Runtime budget admission is no longer active.')
    }
    if (this.options.ledger?.policy !== 'halt') {
      return input.operation()
    }

    const previous = reservation.childDispatchTail
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
    reservation.childDispatchTail = slot
    let ownsSlot = false

    try {
      await waitForChildDispatchTurn(previous, input.signal)
      ownsSlot = true
      if (input.signal?.aborted) throw abortReason(input.signal)
      if (this.reservations.get(reservation.reservationId) !== reservation) {
        throw new Error('The Team Runtime budget admission is no longer active.')
      }
      return await input.operation()
    } catch (error) {
      if (!ownsSlot) void previous.then(release, release)
      throw error
    } finally {
      if (ownsSlot) release()
    }
  }

  private latchSettlementUncertainty(): void {
    const ledger = this.options.ledger
    if (ledger?.policy === 'halt') {
      this.settlementUncertain = true
    } else if (ledger) {
      console.error(
        '[TeamRuntimeCapabilityBudgetPort] WARNING: metered cost could not be settled; continuing under warn policy.',
      )
    }
  }
}

function waitForChildDispatchTurn(
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
  return new DOMException('Budget child dispatch was cancelled.', 'AbortError')
}

function isValidCost(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

function makeInvocationKey(
  context: CapabilityExecutionContext,
  invocation: CapabilityInvocationIdentity,
): string {
  return [
    context.sessionId,
    context.runId,
    context.assignmentId,
    context.taskId ?? '',
    context.agentPath,
    context.agentId ?? '',
    context.activityScopeId ?? '',
    context.workflowId ?? '',
    context.workflowStepId ?? '',
    authorityBinding(context),
    invocation.source.kind,
    invocation.source.id,
    invocation.source.version ?? '',
    invocation.capabilityId,
    invocation.toolCallId,
  ].join('\0')
}

function authorityBinding(context: CapabilityExecutionContext): string {
  switch (context.authority.kind) {
    case 'mcp-lease':
      return `mcp-lease:${context.authority.leaseId}`
    case 'runtime-assignment':
      return `runtime-assignment:${context.authority.processIdentity}`
    case 'parent-capability':
      return `parent-capability:${context.authority.endpointId}:${context.authority.processIdentity}`
  }
}
