import { z } from 'zod'
import { agentQuestionRequestSchema, agentQuestionOutputSchema, type AgentQuestionRequest, type AgentQuestionOutputSchema } from '../../contracts/agent-questions.js'

export function withoutAgentQuestionDecision(schema: AgentQuestionOutputSchema): AgentQuestionOutputSchema {
  const properties = z.record(z.string(), z.json()).parse(schema.properties)
  const decision = z.object({ enum: z.array(z.string()).min(1) }).passthrough().parse(properties.decision)
  return agentQuestionOutputSchema.parse({
    ...schema, properties: { ...properties, decision: { ...decision, enum: decision.enum.filter((value) => value !== 'needs_input') } },
  })
}

export function parseAgentQuestionDecision(text: string): AgentQuestionRequest | undefined {
  let value: unknown
  try {
    value = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1'))
  } catch {
    // The lead's normal parser owns malformed/non-question decisions.
    return undefined
  }
  const envelope = z.object({ decision: z.literal('needs_input') }).passthrough().safeParse(value)
  if (!envelope.success) return undefined
  return agentQuestionRequestSchema.parse({ progress: envelope.data.progress, questions: envelope.data.questions })
}
