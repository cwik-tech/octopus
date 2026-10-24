import * as z from 'zod/v4'
import {
  agentDialogueRecordSchema,
  interjectAgentDialogueRequestSchema,
  startAgentDialogueRequestSchema,
} from '../../contracts/agent-dialogue.js'
import { defineAppMcpTool, type AppMcpTool, type AppMcpToolAnnotations, type AppMcpToolResult } from './app-mcp-endpoint.js'
import type { LoopbackRestClient, RestResponse } from './loopback-rest-client.js'
import { discardEmptyCreatedSession, failure, notFound, sessionPath, validateAgentIds } from './tool-support.js'

const sessionIdSchema = z.uuid()
const addressSchema = z.object({ dialogueId: z.uuid(), sessionId: sessionIdSchema.optional() })
const sessionSchema = z.object({ id: sessionIdSchema })
const refusalSchema = z.object({ code: z.string().optional() })
const CONTROL: AppMcpToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const CONTROL_LABELS = { pause: 'Pause', resume: 'Resume', stop: 'Stop' } as const

export interface DialogueMcpToolOptions {
  readonly findDialogueSession?: (dialogueId: string, signal: AbortSignal) => Promise<string | undefined>
  /** Refreshes an already-open chat without navigation or window activation. */
  readonly sessionChanged?: (sessionId: string) => void
}

/** Tools keep admission, persistence and cancellation in the shared REST service. */
export function createDialogueMcpTools(rest: LoopbackRestClient, options: DialogueMcpToolOptions): readonly AppMcpTool<unknown>[] {
  const address = async (input: z.infer<typeof addressSchema>, signal: AbortSignal) => {
    const sessionId = input.sessionId ?? await options.findDialogueSession?.(input.dialogueId, signal)
    return sessionId === undefined ? undefined : sessionPath(sessionId, 'dialogues', input.dialogueId)
  }
  return [
    defineAppMcpTool({
      name: 'start_dialogue', title: 'Start an Agent dialogue',
      description: 'Explicitly start selected Agents talking to each other. If the request is ambiguous about starting a dialogue, its topic, or the named Agents, ask for clarification before calling start_dialogue. Do not choose unnamed Agents. Defaults to text; creates a normal chat if sessionId is omitted. This is separate from ask, workflow, Team and Deep Research tools.',
      annotations: { ...CONTROL, idempotentHint: false },
      input: startAgentDialogueRequestSchema.extend({
        sessionId: sessionIdSchema.optional(),
        agents: startAgentDialogueRequestSchema.shape.agents.describe('Agent IDs returned as names by list_agents; do not use display labels.'),
      }),
      run: async ({ sessionId, ...request }, { signal }) => {
        const refused = await validateAgentIds(rest, request.agents, signal)
        if (refused) return refused
        let target = sessionId
        if (target === undefined) {
          const created = await rest.request('POST', '/sessions', { body: { title: request.topic.slice(0, 128) }, signal })
          const session = sessionSchema.safeParse(created.body)
          if (created.status >= 300 || !session.success) return dialogueRefusal(created, 'create a chat for the dialogue')
          target = session.data.id
        }
        const response = await rest.request('POST', sessionPath(target, 'dialogues'), { body: request, signal })
        if (sessionId === undefined && response.status >= 400 && response.status < 500) {
          await discardEmptyCreatedSession(rest, target, signal)
        }
        const result = dialogueResponse(response, 'start the dialogue')
        if (result.isError !== true) options.sessionChanged?.(target)
        return result
      },
    }),
    defineAppMcpTool({
      name: 'get_dialogue', title: 'Read an Agent dialogue', description: 'Read a dialogue by its durable dialogueId; sessionId is optional.',
      annotations: { ...CONTROL, readOnlyHint: true }, input: addressSchema,
      run: async (input, { signal }) => {
        const path = await address(input, signal)
        if (path === undefined) return notFound('That dialogue could not be found.')
        return dialogueResponse(await rest.request('GET', path, { signal }), 'read the dialogue')
      },
    }),
    defineAppMcpTool({
      name: 'interject_dialogue', title: 'Interject in an Agent dialogue',
      description: 'Add a user message at the next turn boundary. Reuse the same messageId when retrying so the message is saved once.',
      annotations: CONTROL,
      input: addressSchema.extend(interjectAgentDialogueRequestSchema.shape),
      run: async ({ dialogueId, sessionId, messageId, text }, { signal }) => {
        const path = await address({ dialogueId, ...(sessionId === undefined ? {} : { sessionId }) }, signal)
        if (path === undefined) return notFound('That dialogue could not be found.')
        return dialogueResponse(await rest.request('POST', `${path}/interjections`, { body: { messageId, text }, signal }), 'interject in the dialogue')
      },
    }),
    ...(['pause', 'resume', 'stop'] as const).map((control) => defineAppMcpTool({
      name: `${control}_dialogue`, title: `${CONTROL_LABELS[control]} an Agent dialogue`,
      description: control === 'stop' ? 'Stop the dialogue without deleting its chat or saved replies. Repeated stops are safe.' : `${control === 'pause' ? 'Pause' : 'Resume'} the same dialogue; sessionId is optional.`,
      annotations: CONTROL, input: addressSchema,
      run: async (input, { signal }) => {
        const path = await address(input, signal)
        if (path === undefined) return notFound('That dialogue could not be found.')
        return dialogueResponse(await rest.request('POST', `${path}/${control}`, { body: {}, signal }), `${control} the dialogue`)
      },
    })),
  ]
}

function dialogueResponse(response: RestResponse, action: string): AppMcpToolResult {
  const parsed = agentDialogueRecordSchema.safeParse(response.body)
  if (response.status >= 300 || !parsed.success) return dialogueRefusal(response, action)
  return { summary: `The dialogue is ${parsed.data.status}.`, structured: { ...parsed.data } }
}

function dialogueRefusal(response: RestResponse, action: string): AppMcpToolResult {
  const result = failure(response, action)
  const parsed = refusalSchema.safeParse(response.body)
  return { ...result, structured: { ...result.structured, ...(parsed.success && parsed.data.code !== undefined ? { code: parsed.data.code } : {}) } }
}
