import { MAX_PROVIDER_ROUNDS, MAX_TOOL_CALLS, type AgentQuestionClock } from '../contracts/agent-questions.js'
import type { DiscussionState } from './types.js'

export function remainingAgentQuestionBudget(timeoutMs: number, used: { activeDurationMs: number; providerRounds: number; toolCalls: number }) {
  return { timeoutMs: Math.max(0, timeoutMs - used.activeDurationMs), providerRounds: Math.max(0, MAX_PROVIDER_ROUNDS - used.providerRounds), toolCalls: Math.max(0, MAX_TOOL_CALLS - used.toolCalls) }
}

export function resumeAgentQuestionDiscussionClock(discussion: DiscussionState, waitingMs: number): DiscussionState {
  if (waitingMs <= 0) return discussion
  return {
    ...discussion,
    ...(discussion.activationStartedAtMs === undefined ? {} : { activationStartedAtMs: discussion.activationStartedAtMs + waitingMs }),
    ...(discussion.continuation ? { continuation: { ...discussion.continuation, startedAtMs: discussion.continuation.startedAtMs + waitingMs } } : {}),
  }
}

export function resumeAgentQuestionClock(clock: AgentQuestionClock, now: number): number {
  if (clock.questionPausedAt === undefined) return clock.startTime
  const waitingMs = Math.max(0, now - clock.questionPausedAt)
  return clock.startTime + waitingMs
}
