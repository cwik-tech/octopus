import { z } from 'zod'

import {
  agentQuestionRequestSchema,
  type AgentQuestionInterruption,
  type AgentQuestionRequest,
  type AgentQuestionContinuationEvidence,
} from '../../contracts/agent-questions.js'
import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import type { BuiltinAgentToolAdapter } from './builtin-agent-tool-adapter.js'

export interface AgentQuestionCapture {
  /** Resolves only after the host has durably accepted the request. */
  capture(request: AgentQuestionRequest, signal: AbortSignal, evidence?: AgentQuestionContinuationEvidence): Promise<AgentQuestionInterruption>
}

export function createAgentQuestionToolAdapter(capture: AgentQuestionCapture): BuiltinAgentToolAdapter {
  return {
    name: 'request_human_input',
    tool: {
      serverId: 'agent-questions', serverName: 'Human input',
      toolName: 'request_human_input', namespacedName: 'request_human_input',
      description: 'Ask the human for information required to finish this assignment. Batch necessary questions into one request. This pauses your turn until the human answers. Do not use it for optional preferences.',
      inputSchema: z.toJSONSchema(agentQuestionRequestSchema),
      annotations: { readOnlyHint: false, destructiveHint: false },
      risk: 'mutating', effect: serialCapabilityEffect('mutating'), requiresApproval: false,
    },
    // The turn's trusted host context, not an agent tool grant, enables this adapter.
    isEnabledForAgent: () => true,
    async execute(input) {
      const request = agentQuestionRequestSchema.parse(input.input)
      const interruption = await capture.capture(request, input.signal ?? new AbortController().signal)
      return {
        output: interruption, content: 'Waiting for the human answer.', isError: false,
        interruption,
      }
    },
  }
}
