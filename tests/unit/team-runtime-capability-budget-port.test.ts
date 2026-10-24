import assert from 'node:assert/strict'
import test from 'node:test'

import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import type {
  CapabilityAdapter,
  CapabilityBudgetPort,
  CapabilityBudgetReservation,
  CapabilityExecutionContext,
  CapabilityInvocationIdentity,
} from '../../contracts/capability-dispatch.js'
import { BudgetLedger } from '../../core/budget-ledger.js'
import { TeamRuntimeCapabilityBudgetPort } from '../../team-runtime/capability-budget-port.js'
import { createCapabilityTestDispatcher } from '../support/capability-dispatcher.js'

const CONTEXT: CapabilityExecutionContext = {
  contractVersion: 1,
  requestId: 'request-budget-port-1',
  sessionId: 'session-budget-port-1',
  runId: 'run-budget-port-1',
  assignmentId: 'assignment-budget-port-1',
  taskId: 'task-budget-port-1',
  agentPath: 'agents/coordinator',
  authority: {
    kind: 'runtime-assignment',
    processIdentity: 'process-budget-port-1',
  },
}

test('Team Runtime budget reservations expose one adoption to the raw delegation', async () => {
  const ledger = new BudgetLedger({ capUsd: 10, policy: 'halt' })
  const port = new TeamRuntimeCapabilityBudgetPort({
    ledger,
    readTotalCostUsd: () => 3,
    isMetered: (capabilityId) => capabilityId === 'team-runtime.engine.spawn_team',
  })
  const invocation = makeInvocation('spawn-call-1')
  const preflight = await port.preflight(makePreflight(invocation))
  assert.equal(preflight.kind, 'metered')
  if (preflight.kind !== 'metered') assert.fail('expected metered preflight')

  const reservation = await port.reserve({
    context: CONTEXT,
    invocation,
    preflight,
  })

  assert.equal(port.adopt('spawn-call-1'), undefined)
  const adoption = await port.runWithAdoptionScope({
    context: CONTEXT,
    invocation,
    operation: async () => ({
      first: port.adopt('spawn-call-1'),
      second: port.adopt('spawn-call-1'),
    }),
  })
  assert.equal(adoption.first?.remainingBudget, 7)
  assert.equal(typeof adoption.first?.runChildDispatch, 'function')
  assert.equal(adoption.second, undefined)
  await port.release(reservation)
  assert.equal(ledger.reservedUsd, 0)
})

test('one adopted engine budget lease serializes every nested hard-budget child dispatch', async () => {
  const ledger = new BudgetLedger({ capUsd: 10, policy: 'halt' })
  const port = new TeamRuntimeCapabilityBudgetPort({
    ledger,
    readTotalCostUsd: () => 2,
    isMetered: () => true,
  })
  const invocation = makeInvocation('multi-child-engine-call')
  const preflight = await port.preflight(makePreflight(invocation))
  if (preflight.kind !== 'metered') assert.fail('expected metered preflight')
  const reservation = await port.reserve({
    context: CONTEXT,
    invocation,
    preflight,
  })
  const admission = await port.runWithAdoptionScope({
    context: CONTEXT,
    invocation,
    operation: async () => port.adopt('multi-child-engine-call'),
  })

  assert.ok(isNestedDispatchAdmission(admission))
  if (!isNestedDispatchAdmission(admission)) return

  const firstEntered = deferred<void>()
  const releaseFirst = deferred<void>()
  const order: string[] = []
  const first = admission.runChildDispatch({
    operation: async () => {
      order.push('first-entered')
      firstEntered.resolve()
      await releaseFirst.promise
      order.push('first-finished')
      return 'first'
    },
  })
  await firstEntered.promise
  const second = admission.runChildDispatch({
    operation: async () => {
      order.push('second-entered')
      return 'second'
    },
  })
  await Promise.resolve()
  assert.deepEqual(order, ['first-entered'])

  releaseFirst.resolve()
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second'])
  assert.deepEqual(order, [
    'first-entered',
    'first-finished',
    'second-entered',
  ])
  await port.release(reservation)
})

test('a cancelled adopted child keeps later children behind the active child', async () => {
  const ledger = new BudgetLedger({ capUsd: 10, policy: 'halt' })
  const port = new TeamRuntimeCapabilityBudgetPort({
    ledger,
    readTotalCostUsd: () => 2,
    isMetered: () => true,
  })
  const invocation = makeInvocation('cancelled-child-engine-call')
  const preflight = await port.preflight(makePreflight(invocation))
  if (preflight.kind !== 'metered') assert.fail('expected metered preflight')
  const reservation = await port.reserve({
    context: CONTEXT,
    invocation,
    preflight,
  })
  const admission = await port.runWithAdoptionScope({
    context: CONTEXT,
    invocation,
    operation: async () => port.adopt('cancelled-child-engine-call'),
  })
  if (!admission) assert.fail('expected an adopted budget admission')

  const firstEntered = deferred<void>()
  const releaseFirst = deferred<void>()
  const thirdEntered = deferred<void>()
  const first = admission.runChildDispatch({
    operation: async () => {
      firstEntered.resolve()
      await releaseFirst.promise
    },
  })
  await firstEntered.promise
  const controller = new AbortController()
  const second = admission.runChildDispatch({
    signal: controller.signal,
    operation: async () => assert.fail('cancelled child must not execute'),
  })
  const third = admission.runChildDispatch({
    operation: async () => thirdEntered.resolve(),
  })
  controller.abort(new DOMException('Cancelled while queued.', 'AbortError'))
  await assert.rejects(second, /Cancelled while queued/)

  let thirdRan = false
  void thirdEntered.promise.then(() => {
    thirdRan = true
  })
  await Promise.resolve()
  assert.equal(thirdRan, false)

  releaseFirst.resolve()
  await Promise.all([first, third])
  assert.equal(thirdRan, true)
  await port.release(reservation)
})

test('an adopted engine admission rejects stale child work after dispatcher release', async () => {
  const ledger = new BudgetLedger({ capUsd: 10, policy: 'halt' })
  const port = new TeamRuntimeCapabilityBudgetPort({
    ledger,
    readTotalCostUsd: () => 2,
    isMetered: () => true,
  })
  const invocation = makeInvocation('released-engine-call')
  const preflight = await port.preflight(makePreflight(invocation))
  if (preflight.kind !== 'metered') assert.fail('expected metered preflight')
  const reservation = await port.reserve({
    context: CONTEXT,
    invocation,
    preflight,
  })
  const admission = await port.runWithAdoptionScope({
    context: CONTEXT,
    invocation,
    operation: async () => port.adopt('released-engine-call'),
  })
  if (!admission) assert.fail('expected an adopted budget admission')
  await port.release(reservation)

  let executed = false
  await assert.rejects(
    admission.runChildDispatch({
      operation: async () => {
        executed = true
      },
    }),
    /budget admission is no longer active/,
  )
  assert.equal(executed, false)
})

test('Team Runtime budget adoption separates agents that reuse a tool-call ID', async () => {
  const ledger = new BudgetLedger({ capUsd: 10, policy: 'warn' })
  const port = new TeamRuntimeCapabilityBudgetPort({
    ledger,
    readTotalCostUsd: () => 2,
    isMetered: () => true,
  })
  const invocation = makeInvocation('shared-spawn-call')
  const alphaContext = { ...CONTEXT, agentPath: 'agents/alpha' }
  const betaContext = { ...CONTEXT, agentPath: 'agents/beta' }
  const preflight = await port.preflight(makePreflight(invocation))
  if (preflight.kind !== 'metered') assert.fail('expected metered preflight')
  const alphaReservation = await port.reserve({
    context: alphaContext,
    invocation,
    preflight,
  })
  const betaReservation = await port.reserve({
    context: betaContext,
    invocation,
    preflight,
  })

  const alpha = await port.runWithAdoptionScope({
    context: alphaContext,
    invocation,
    operation: async () => port.adopt('shared-spawn-call'),
  })
  const beta = await port.runWithAdoptionScope({
    context: betaContext,
    invocation,
    operation: async () => port.adopt('shared-spawn-call'),
  })

  assert.equal(alpha?.remainingBudget, 8)
  assert.equal(beta?.remainingBudget, 8)
  assert.equal(typeof alpha?.runChildDispatch, 'function')
  assert.equal(typeof beta?.runChildDispatch, 'function')
  await port.release(alphaReservation)
  await port.release(betaReservation)
})

test('Team Runtime budget port owns one hard-budget FIFO until dispatcher release', async () => {
  const ledger = new BudgetLedger({ capUsd: 10, policy: 'halt' })
  const port = new TeamRuntimeCapabilityBudgetPort({
    ledger,
    readTotalCostUsd: () => 1,
    isMetered: () => true,
  })
  const firstInvocation = makeInvocation('spawn-call-1')
  const secondInvocation = makeInvocation('spawn-call-2')
  const firstPreflight = await port.preflight(makePreflight(firstInvocation))
  const secondPreflight = await port.preflight(makePreflight(secondInvocation))
  if (firstPreflight.kind !== 'metered' || secondPreflight.kind !== 'metered') {
    assert.fail('expected metered preflights')
  }
  const first = await port.reserve({
    context: CONTEXT,
    invocation: firstInvocation,
    preflight: firstPreflight,
  })
  let secondResolved = false
  const secondPromise = port.reserve({
    context: CONTEXT,
    invocation: secondInvocation,
    preflight: secondPreflight,
  }).then((reservation) => {
    secondResolved = true
    return reservation
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(secondResolved, false)

  await port.release(first)
  const second = await secondPromise
  assert.equal(secondResolved, true)
  await port.release(second)
})

test('a cancelled dispatch leaves the hard-budget FIFO before the active dispatch releases it', async () => {
  const firstExecutionStarted = deferred<void>()
  const releaseFirstExecution = deferred<void>()
  const secondReserveEntered = deferred<void>()
  const successfulReservations: string[] = []
  const executions: string[] = []
  const ledger = new BudgetLedger({ capUsd: 10, policy: 'halt' })
  class ObservedBudgetPort extends TeamRuntimeCapabilityBudgetPort {
    override async reserve(
      input: Parameters<CapabilityBudgetPort['reserve']>[0],
    ): Promise<CapabilityBudgetReservation> {
      if (input.invocation.toolCallId === 'queued-call') {
        secondReserveEntered.resolve()
      }
      const reservation = await super.reserve(input)
      successfulReservations.push(input.invocation.toolCallId)
      return reservation
    }
  }
  const port = new ObservedBudgetPort({
    ledger,
    readTotalCostUsd: () => 1,
    isMetered: () => true,
  })
  const dispatcher = createCapabilityTestDispatcher([], { budget: port })
  const first = dispatcher.dispatch({
    context: CONTEXT,
    invocation: {
      ...makeInvocation('active-call'),
      input: {},
    },
    adapter: makeDispatchAdapter(async () => {
      executions.push('active-call')
      firstExecutionStarted.resolve()
      await releaseFirstExecution.promise
      return { completed: 'active-call' }
    }),
  })
  await firstExecutionStarted.promise

  const cancellation = new AbortController()
  const second = dispatcher.dispatch({
    context: {
      ...CONTEXT,
      requestId: 'request-budget-port-2',
      assignmentId: 'assignment-budget-port-2',
      taskId: 'task-budget-port-2',
      authority: {
        kind: 'runtime-assignment',
        processIdentity: 'process-budget-port-2',
      },
    },
    invocation: {
      ...makeInvocation('queued-call'),
      input: {},
    },
    adapter: makeDispatchAdapter(async () => {
      executions.push('queued-call')
      return { completed: 'queued-call' }
    }),
    signal: cancellation.signal,
  })
  await secondReserveEntered.promise
  assert.deepEqual(successfulReservations, ['active-call'])
  assert.equal(ledger.reservedUsd, 9)

  cancellation.abort(new DOMException('Queued dispatch cancelled.', 'AbortError'))
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const promptResult = await Promise.race([
    second,
    new Promise<'still-waiting'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('still-waiting'), 150)
    }),
  ])
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)

  releaseFirstExecution.resolve()
  const [firstResult, secondResult] = await Promise.all([first, second])

  assert.notEqual(promptResult, 'still-waiting')
  assert.equal(firstResult.status, 'completed')
  assert.equal(secondResult.status, 'cancelled')
  assert.deepEqual(successfulReservations, ['active-call'])
  assert.deepEqual(executions, ['active-call'])
  assert.equal(ledger.reservedUsd, 0)
})

test('Team Runtime budget settlement reports actual cost beyond reserved capacity', async () => {
  const ledger = new BudgetLedger({ capUsd: 10, policy: 'halt' })
  const port = new TeamRuntimeCapabilityBudgetPort({
    ledger,
    readTotalCostUsd: () => 4,
    isMetered: () => true,
  })
  const invocation = makeInvocation('spawn-call-overrun')
  const preflight = await port.preflight(makePreflight(invocation))
  if (preflight.kind !== 'metered') assert.fail('expected metered preflight')
  const reservation = await port.reserve({
    context: CONTEXT,
    invocation,
    preflight,
  })

  const settlement = await port.settle({ reservation, actualCostUsd: 7 })

  assert.deepEqual(settlement, {
    costTracked: true,
    budgetOverrun: true,
    actualCostUsd: 7,
  })
  await port.release(reservation)
})

test('an untrackable metered cost closes later hard-budget dispatches', async () => {
  const ledger = new BudgetLedger({ capUsd: 10, policy: 'halt' })
  const port = new TeamRuntimeCapabilityBudgetPort({
    ledger,
    readTotalCostUsd: () => 2,
    isMetered: () => true,
  })
  const firstInvocation = makeInvocation('uncertain-call-1')
  const firstPreflight = await port.preflight(makePreflight(firstInvocation))
  if (firstPreflight.kind !== 'metered') assert.fail('expected metered preflight')
  const reservation = await port.reserve({
    context: CONTEXT,
    invocation: firstInvocation,
    preflight: firstPreflight,
  })
  const settlement = await port.settle({ reservation })
  await port.release(reservation)

  const next = await port.preflight(makePreflight(makeInvocation('uncertain-call-2')))

  assert.deepEqual(settlement, { costTracked: false, budgetOverrun: false })
  assert.equal(next.kind, 'rejected')
  if (next.kind === 'rejected') {
    assert.equal(next.code, 'budget_settlement_uncertain')
  }
})

test('a dispatcher-reported settlement fault closes later hard-budget dispatches', async () => {
  const ledger = new BudgetLedger({ capUsd: 10, policy: 'halt' })
  const port = new TeamRuntimeCapabilityBudgetPort({
    ledger,
    readTotalCostUsd: () => 2,
    isMetered: () => true,
  })
  const budgetPort: CapabilityBudgetPort = port
  const firstInvocation = makeInvocation('faulted-settlement-call-1')
  const firstPreflight = await budgetPort.preflight(
    makePreflight(firstInvocation),
  )
  if (firstPreflight.kind !== 'metered') assert.fail('expected metered preflight')
  const reservation = await budgetPort.reserve({
    context: CONTEXT,
    invocation: firstInvocation,
    preflight: firstPreflight,
  })

  await budgetPort.markSettlementUncertain?.({
    reservation,
    reason: 'settlement_failed',
  })
  await budgetPort.release(reservation)
  const next = await budgetPort.preflight(
    makePreflight(makeInvocation('faulted-settlement-call-2')),
  )

  assert.equal(next.kind, 'rejected')
  if (next.kind === 'rejected') {
    assert.equal(next.code, 'budget_settlement_uncertain')
  }
})

function makeInvocation(toolCallId: string): CapabilityInvocationIdentity {
  return {
    capabilityId: 'team-runtime.engine.spawn_team',
    source: { kind: 'engine', id: 'team-runtime:pi-model', version: '1' },
    toolCallId,
  }
}

function makePreflight(invocation: CapabilityInvocationIdentity) {
  return {
    context: CONTEXT,
    invocation,
    effect: { kind: 'mutating' as const, concurrency: 'serial' as const },
    risk: 'delegation',
  }
}

function makeDispatchAdapter(
  execute: (input: { readonly signal: AbortSignal }) => Promise<unknown>,
): CapabilityAdapter {
  return {
    capabilityId: 'team-runtime.engine.spawn_team',
    prepare: async () => ({
      effect: serialCapabilityEffect('mutating'),
      risk: 'delegation',
      argumentNames: [],
      policyDecision: { kind: 'allow' },
      authorize: async () => ({ kind: 'allow' }),
      execute,
      acceptResult: async ({ value }) => ({ value, actualCostUsd: 1 }),
    }),
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function isNestedDispatchAdmission(value: unknown): value is {
  runChildDispatch<T>(input: {
    readonly signal?: AbortSignal
    readonly operation: () => Promise<T>
  }): Promise<T>
} {
  return value !== null &&
    typeof value === 'object' &&
    'runChildDispatch' in value &&
    typeof value.runChildDispatch === 'function'
}
