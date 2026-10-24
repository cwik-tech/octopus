/**
 * When the queue should look at a parked question again.
 *
 * A question the person has not answered yet has nothing new to say, so reading
 * it on every scheduling pass is pure cost: a run left overnight was read tens
 * of thousands of times. Each fruitless read therefore waits longer than the
 * last, to a ceiling.
 *
 * The watch never expires. Someone may answer hours later, and a run whose
 * watch had been given up on would never be admitted at all — so this returns a
 * later time, never a decision to stop watching.
 */
export const AGENT_QUESTION_READ_BACKOFF_MS = 1_000
export const AGENT_QUESTION_READ_BACKOFF_CEILING_MS = 60_000

export interface AgentQuestionReadSchedule {
  readonly misses: number
  readonly dueAtMs: number
}

export function nextAgentQuestionRead(input: {
  readonly misses: number
  readonly nowMs: number
}): AgentQuestionReadSchedule {
  const misses = input.misses + 1
  const doubled = AGENT_QUESTION_READ_BACKOFF_MS * 2 ** Math.min(misses - 1, 32)
  return {
    misses,
    dueAtMs: input.nowMs + Math.min(AGENT_QUESTION_READ_BACKOFF_CEILING_MS, doubled),
  }
}
