import { z } from 'zod'
import { agentQuestionViewsSchema, submitAgentInputSchema, type AgentQuestionView } from '@contracts/agent-questions'
import { getApiBaseUrl } from '@/lib/utils/desktop'

function questionsUrl(sessionId: string, taskId: string): string {
  return `${getApiBaseUrl()}/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/agent-questions`
}

export async function listAgentQuestions(sessionId: string, taskId: string, signal: AbortSignal): Promise<AgentQuestionView[]> {
  const response = await fetch(questionsUrl(sessionId, taskId), { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })
  if (!response.ok) throw new Error('Could not load agent questions.')
  const payload: unknown = await response.json()
  return agentQuestionViewsSchema.parse(payload)
}

export async function submitAgentAnswers(input: z.infer<typeof submitAgentInputSchema>, signal: AbortSignal): Promise<void> {
  const payload = submitAgentInputSchema.parse(input)
  const response = await fetch(`${questionsUrl(payload.sessionId, payload.taskId)}/${encodeURIComponent(payload.interactionId)}/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  })
  if (!response.ok) throw new Error(response.status === 409 ? 'The question changed. Refresh this conversation before answering.' : 'Could not submit your answer. Try again.')
}
