import { AGENT_STATE } from '../core/constants.js'
import { roundUsd } from '../core/budget-ledger.js'
import type { AgentMetrics } from '../core/types.js'
import { AgentQuestionInterruptionError } from '../core/agent-question-interruption.js'

interface CoordinatorUsage {
  readonly cost: number
  readonly contextTokens: number
  readonly model: string
}

export async function executeCoordinatorAttempt<T>(input: {
  readonly metrics: AgentMetrics | undefined
  readonly startedAt: number
  readonly operation: () => Promise<T>
  readonly onStart: () => void
  readonly onComplete: (result: T) => void
  readonly onFail: (error: unknown) => void
  readonly onWait?: (error: AgentQuestionInterruptionError) => void
  readonly usage?: (result: T) => CoordinatorUsage
}): Promise<T> {
  if (input.metrics) {
    input.metrics.state = AGENT_STATE.ACTIVE
    input.metrics.activeStartedAt = input.startedAt
  }
  try {
    input.onStart()
    const result = await input.operation()
    if (input.metrics) {
      const usage = input.usage?.(result)
      input.metrics.state = AGENT_STATE.DONE
      delete input.metrics.activeStartedAt
      input.metrics.rounds += 1
      if (usage) {
        input.metrics.totalCost = roundUsd(input.metrics.totalCost + usage.cost)
        input.metrics.contextTokens = usage.contextTokens
        input.metrics.model = usage.model
      }
    }
    input.onComplete(result)
    return result
  } catch (error) {
    if (error instanceof AgentQuestionInterruptionError && error.interruption.kind === 'awaiting_input') {
      if (input.metrics) {
        input.metrics.state = AGENT_STATE.IDLE
        delete input.metrics.activeStartedAt
      }
      input.onWait?.(error)
      throw error
    }
    if (input.metrics) {
      input.metrics.state = AGENT_STATE.ERROR
      delete input.metrics.activeStartedAt
      input.metrics.failureCount += 1
      input.metrics.lastError = error instanceof Error
        ? error.stack || error.message
        : String(error)
    }
    try {
      input.onFail(error)
    } catch (observerError) {
      if (error instanceof Error && error.cause === undefined) {
        error.cause = observerError
      }
    }
    throw error
  }
}
