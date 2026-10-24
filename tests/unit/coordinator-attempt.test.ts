import assert from 'node:assert/strict'
import test from 'node:test'

import { AGENT_STATE } from '../../core/constants.js'
import type { AgentMetrics } from '../../core/types.js'
import { executeCoordinatorAttempt } from '../../team-runtime/coordinator-attempt.js'
import { AgentQuestionInterruptionError } from '../../core/agent-question-interruption.js'

function makeMetrics(): AgentMetrics {
  return {
    state: AGENT_STATE.IDLE,
    rounds: 0,
    totalCost: 0,
    contextTokens: 0,
    model: 'configured-model',
    color: 1,
    failureCount: 0,
  }
}

test('a waiting lead clears its active status without reporting failure or completion', async () => {
  const metrics = makeMetrics()
  const events: string[] = []
  await assert.rejects(executeCoordinatorAttempt({
    metrics, startedAt: 1_000,
    operation: async () => { throw new AgentQuestionInterruptionError({ kind: 'awaiting_input', interactionId: 'recipient' }) },
    onStart: () => events.push('start'), onComplete: () => events.push('complete'),
    onFail: () => events.push('fail'), onWait: () => events.push('waiting'),
  }), AgentQuestionInterruptionError)
  assert.deepEqual(events, ['start', 'waiting'])
  assert.equal(metrics.state, AGENT_STATE.IDLE)
  assert.equal(metrics.failureCount, 0)
  assert.equal(metrics.rounds, 0)
  assert.equal(metrics.activeStartedAt, undefined)
})

test('a failed continuation decision clears active lead state and records one failed attempt', async () => {
  const metrics = makeMetrics()
  const lifecycleEvents: string[] = []

  await assert.rejects(
    executeCoordinatorAttempt({
      metrics,
      startedAt: 1_000,
      operation: async () => {
        throw new Error('invalid continuation decision')
      },
      onStart: () => lifecycleEvents.push('start'),
      onComplete: () => lifecycleEvents.push('complete'),
      onFail: () => lifecycleEvents.push('fail'),
    }),
    /invalid continuation decision/,
  )

  assert.equal(metrics.state, AGENT_STATE.ERROR)
  assert.equal(metrics.activeStartedAt, undefined)
  assert.equal(metrics.failureCount, 1)
  assert.match(metrics.lastError ?? '', /invalid continuation decision/)
  assert.deepEqual(lifecycleEvents, ['start', 'fail'])
})

test('a completed coordinator attempt updates metrics before publishing its end event', async () => {
  const metrics = makeMetrics()
  let stateSeenByEnd: string | undefined

  const result = await executeCoordinatorAttempt({
    metrics,
    startedAt: 1_000,
    operation: async () => ({
      value: 'accepted',
      usage: {
        cost: 0.25,
        contextTokens: 42,
        model: 'resolved-model',
      },
    }),
    onStart: () => {},
    onComplete: () => {
      stateSeenByEnd = metrics.state
    },
    onFail: () => {},
    usage: (output) => output.usage,
  })

  assert.equal(result.value, 'accepted')
  assert.equal(metrics.state, AGENT_STATE.DONE)
  assert.equal(metrics.activeStartedAt, undefined)
  assert.equal(metrics.rounds, 1)
  assert.equal(metrics.totalCost, 0.25)
  assert.equal(metrics.contextTokens, 42)
  assert.equal(metrics.model, 'resolved-model')
  assert.equal(stateSeenByEnd, AGENT_STATE.DONE)
})

test('a start-event failure cannot leave coordinator metrics active', async () => {
  const metrics = makeMetrics()
  let failObserved = false

  await assert.rejects(
    executeCoordinatorAttempt({
      metrics,
      startedAt: 1_000,
      operation: async () => 'not reached',
      onStart: () => {
        throw new Error('start log failed')
      },
      onComplete: () => {},
      onFail: () => {
        failObserved = true
      },
    }),
    /start log failed/,
  )

  assert.equal(metrics.state, AGENT_STATE.ERROR)
  assert.equal(metrics.activeStartedAt, undefined)
  assert.equal(failObserved, true)
})

test('a failure-event logging error does not replace the coordinator failure', async () => {
  const metrics = makeMetrics()

  await assert.rejects(
    executeCoordinatorAttempt({
      metrics,
      startedAt: 1_000,
      operation: async () => {
        throw new Error('provider failed')
      },
      onStart: () => {},
      onComplete: () => {},
      onFail: () => {
        throw new Error('failure log failed')
      },
    }),
    /provider failed/,
  )
})
