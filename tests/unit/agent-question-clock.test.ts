import assert from 'node:assert/strict'
import test from 'node:test'
import { resumeAgentQuestionClock, resumeAgentQuestionDiscussionClock, remainingAgentQuestionBudget } from '../../core/agent-question-clock.js'
import type { DiscussionState } from '../../core/types.js'

test('resuming excludes human waiting time while retaining elapsed execution', () => {
  assert.equal(resumeAgentQuestionClock({ startTime: 1_000, questionPausedAt: 6_000 }, 3_606_000), 3_601_000)
})

test('ordinary recovery does not reset the execution clock', () => {
  assert.equal(resumeAgentQuestionClock({ startTime: 1_000 }, 3_606_000), 1_000)
})

test('a continued agent keeps only its remaining time and tool-loop budget', () => {
  assert.deepEqual(remainingAgentQuestionBudget(60_000, { activeDurationMs: 15_000, providerRounds: 2, toolCalls: 3 }),
    { timeoutMs: 45_000, providerRounds: 6, toolCalls: 29 })
  assert.deepEqual(remainingAgentQuestionBudget(60_000, { activeDurationMs: 65_000, providerRounds: 8, toolCalls: 32 }),
    { timeoutMs: 0, providerRounds: 0, toolCalls: 0 })
})

test('a clock that moves backwards never refunds execution time', () => {
  assert.equal(resumeAgentQuestionClock({ startTime: 1_000, questionPausedAt: 6_000 }, 5_000), 1_000)
})

test('a discussion preserves its pass and remaining active budget while a human is answering', () => {
  const discussion: DiscussionState = {
    type: 'discussion', round: 1, messages: [], outputPath: 'assignment', activationStartedAtMs: 1_000,
    continuation: { phase: 'awaiting_lead_decision', startedAtMs: 2_000 },
  }
  const resumed = resumeAgentQuestionDiscussionClock(discussion, 3_600_000)
  assert.equal(resumed.activationStartedAtMs, 3_601_000)
  assert.equal(resumed.continuation?.startedAtMs, 3_602_000)
  assert.equal(resumed.continuation?.phase, 'awaiting_lead_decision')
  assert.equal(resumed.round, 1)
  assert.equal(discussion.continuation?.startedAtMs, 2_000, 'Restoration must not mutate the saved checkpoint.')
})
