import { z } from 'zod/v4'
import { AGENT_DIALOGUE_MAX_AGENTS, startAgentDialogueRequestSchema, type AgentDialogueRecord, type StartAgentDialogueRequest } from '../contracts/agent-dialogue.js'
import { serialCapabilityEffect } from '../contracts/capability-effect.js'
import { hashCanonicalJson } from '../core/canonical-json-hash.js'
import type { BuiltinAgentToolAdapter } from '../domains/mcp/builtin-agent-tool-adapter.js'
import { SessionActivityConflictError } from '../domains/sessions/session-activity-claims.js'
import type { AgentDialogueService } from './agent-dialogue-service.js'
import type { SessionChatActivity } from './session-activity-service.js'
import { ServiceError } from './service-errors.js'

const dialogueToolRequestSchema = startAgentDialogueRequestSchema.extend({
  agents: z.array(z.string().trim().min(1).max(200)).min(1).max(AGENT_DIALOGUE_MAX_AGENTS),
})
const dialogueClarificationGuidance = 'If the request is ambiguous about starting a dialogue, its topic, or the named Agents, ask for clarification before calling start_dialogue. Do not choose unnamed Agents.'

export const AGENT_DIALOGUE_ACTIVATION_PROMPT = [
  'Agent dialogue activation:',
  '- When the human explicitly asks you to discuss with named peer Agents, use start_dialogue in this chat.',
  `- ${dialogueClarificationGuidance}`,
  '- After start_dialogue confirms a reservation, you may report that Agent dialogue is queued. It begins after your current answer is saved.',
  '- An ordinary question does not activate Agent dialogue.',
].join('\n')

export function createAgentDialogueToolAdapter(options: {
  sessionId: string
  currentAgentId: string
  activity: SessionChatActivity
  service: Pick<AgentDialogueService, 'start'>
  context: Pick<StartAgentDialogueRequest, 'projectContext' | 'contextResultIds'>
}): BuiltinAgentToolAdapter {
  let reserved: { fingerprint: string; record: Promise<AgentDialogueRecord> } | undefined
  return {
    name: 'start_dialogue',
    tool: {
      serverId: 'agent-dialogue', serverName: 'Agent dialogue',
      toolName: 'start_dialogue', namespacedName: 'start_dialogue',
      description: `Start an alternating Agent dialogue in this chat when the human asks you to discuss or talk to each other. Name the peer Agents in agents; you are included automatically. ${dialogueClarificationGuidance} Text is the default. The discussion begins after your current answer is saved. Ordinary questions do not require this tool.`,
      inputSchema: z.toJSONSchema(dialogueToolRequestSchema, { io: 'input' }),
      annotations: { readOnlyHint: false, destructiveHint: false },
      risk: 'mutating', effect: serialCapabilityEffect('mutating'), requiresApproval: false,
    },
    isEnabledForAgent: () => true,
    async execute(input) {
      input.signal?.throwIfAborted()
      const parsed = dialogueToolRequestSchema.safeParse(input.input)
      if (!parsed.success) return refusal('bad_request', parsed.error.issues[0]?.message ?? 'Invalid dialogue request')
      const request = startAgentDialogueRequestSchema.safeParse({
        ...options.context, ...parsed.data,
        agents: [...new Set([options.currentAgentId, ...parsed.data.agents])],
      })
      if (!request.success) return refusal('bad_request', request.error.issues[0]?.message ?? 'Name at least one distinct peer Agent')
      const fingerprint = hashCanonicalJson(request.data).value
      if (reserved && reserved.fingerprint !== fingerprint) return refusal('dialogue_active', 'This chat has already reserved an Agent dialogue')
      const reservation = reserved ?? { fingerprint, record: options.service.start(options.sessionId, request.data, options.activity, options.currentAgentId) }
      reserved = reservation
      try {
        const record = await reservation.record
        return { output: record, content: JSON.stringify(record), isError: false }
      } catch (error) {
        // Allow corrections after failure; the durable claim still decides admission.
        if (reserved === reservation) reserved = undefined
        if (error instanceof SessionActivityConflictError) return refusal(error.code, error.message)
        if (error instanceof ServiceError) return refusal(error.code, error.message)
        throw error
      }
    },
  }
}

function refusal(code: string, message: string) {
  const output = { code, error: message }
  return { output, content: JSON.stringify(output), isError: true }
}
