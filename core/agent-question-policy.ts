import type { AgentQuestionRound, AgentQuestionRoundDecision } from '../contracts/agent-questions.js'

export function agentQuestionDispatchId(invocationId: string, executionAttemptId: string | undefined): string {
  return executionAttemptId ? `${invocationId}@${executionAttemptId}` : invocationId
}

export const AGENT_QUESTION_REQUEST_INSTRUCTION = [
  'Human-input policy: ask only when missing information prevents a correct completed response or would require a consequential unsupported assumption.',
  'If only one fact is required, ask only for that fact. Do not add optional preferences, personal details, memories, or invitations to provide extra context to a blocking question batch.',
  'State reasonable assumptions for nonessential details. Use the managed question tool or structured needs_input decision; a question written in prose cannot pause execution.',
  'You have one question round for this logical run. Batch the necessary questions in that round, then finish your full response after the human answers.',
].join('\n')

export function decideAgentQuestionRound(
  request: Omit<AgentQuestionRound, 'interactionId'>,
  accepted: readonly AgentQuestionRound[],
): AgentQuestionRoundDecision {
  const previous = accepted.find((round) =>
    round.rootRunId === request.rootRunId && round.agentId === request.agentId,
  )
  if (!previous) return { kind: 'allow' }
  if (
    previous.logicalInvocationId === request.logicalInvocationId &&
    previous.requestDigest === request.requestDigest
  ) return { kind: 'replay', interactionId: previous.interactionId }
  return { kind: 'rejected', code: 'question_limit_reached' }
}
