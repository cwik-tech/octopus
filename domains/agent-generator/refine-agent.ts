/**
 * LLM call for refining an already-generated persona.
 *
 * Used after an agent has been created — the user types something like "make
 * it terser" or "remove Tension Partners" into the chat. The LLM is given
 * the current persona MD, the chat history (with the latest user turn as the
 * refinement directive), and is asked to return an updated persona.
 *
 * Skills are not touched. Only the top-level `<agent-name>.md` is rewritten.
 */

import { whenDefined } from '../../core/optional-properties.js'
import {
  loadArchitectConfig,
  WorkflowArchitectNotConfiguredError,
} from '../provider/architect-model-config.js'
import { CHAT_VISUALIZATION_POLICY } from '../../core/chat-visualization-policy.js'
import { callModel, readApiKey, type ModelMessage } from '../provider/model-client.js'
import { renderAgentLibraryContextBlock } from './agent-context.js'
import { buildAgentArchitectSystemPrompt } from './agent-prompt.js'
import type { ChatTurn, RefineAgentRequest, RefineAgentResult } from './types.js'

export interface RunRefineAgentInput extends RefineAgentRequest {
  repoRoot: string
  signal?: AbortSignal
}

export async function runRefineAgent(
  input: RunRefineAgentInput,
): Promise<RefineAgentResult> {
  throwIfAborted(input.signal)

  let config
  try {
    config = loadArchitectConfig(input.repoRoot)
  } catch (error) {
    if (error instanceof WorkflowArchitectNotConfiguredError) {
      return fallback(input, error.message)
    }
    return fallback(
      input,
      error instanceof Error ? error.message : String(error),
    )
  }

  const provider = input.provider?.trim() || config.provider
  const model = input.model?.trim() || config.model

  const keyResult = readApiKey(provider)
  if (keyResult.apiKey == null) {
    return fallback(input, `${keyResult.envVar} is not set`)
  }

  const systemPrompt = [
    buildAgentArchitectSystemPrompt(input.repoRoot).trim(),
    CHAT_VISUALIZATION_POLICY,
    renderAgentLibraryContextBlock({
      repoRoot: input.repoRoot,
      focusAgentName: input.agentName,
    }),
    `## Refinement mode\n\nYou are refining an existing agent's package. The user's latest message describes the change they want. Preserve the agent's name (\`suggestedName\` must equal "${input.agentName}") and rewrite only the persona markdown unless the user explicitly asks about package context. Use the selected agent's skills, templates, references, scripts, knowledge, experience, and other package files above as context for the answer. Return the same JSON shape as for creation.\n`,
  ].join("\n\n")

  const messages = buildMessages(input.agentName, input.currentPersona, input.chatHistory)

  throwIfAborted(input.signal)
  const firstAttempt = await callModel(keyResult.apiKey, {
    provider,
    model,
    systemPrompt,
    messages,
    ...whenDefined(input.signal, (definedValue) => ({ signal: definedValue })),
  })
  throwIfAborted(input.signal)
  if (!firstAttempt.ok) {
    return fallback(input, firstAttempt.reason)
  }

  const parsed = tryParseRefinement(firstAttempt.text)
  if (parsed.ok) {
    return {
      personaMarkdown: parsed.value.personaMarkdown,
      message: parsed.value.message,
      meta: { model: firstAttempt.model, fallback: false },
    }
  }

  const repairMessages: ModelMessage[] = [
    ...messages,
    { role: 'assistant', content: firstAttempt.text },
    {
      role: 'user',
      content:
        'Your previous reply was not valid JSON in the required shape. Resend a single JSON object wrapped in ```json ... ``` with fields "message" and "personaMarkdown" at minimum.',
    },
  ]
  const second = await callModel(keyResult.apiKey, {
    provider,
    model,
    systemPrompt,
    messages: repairMessages,
    ...whenDefined(input.signal, (definedValue) => ({ signal: definedValue })),
  })
  throwIfAborted(input.signal)
  if (!second.ok) return fallback(input, second.reason)
  const parsed2 = tryParseRefinement(second.text)
  if (parsed2.ok) {
    return {
      personaMarkdown: parsed2.value.personaMarkdown,
      message: parsed2.value.message,
      meta: { model: second.model, fallback: false },
    }
  }

  return fallback(
    input,
    `Architect returned non-JSON output twice. Last text: ${second.text.slice(0, 200)}`,
  )
}

function buildMessages(
  agentName: string,
  currentPersona: string,
  history: ChatTurn[],
): ModelMessage[] {
  const messages: ModelMessage[] = [
    {
      role: 'user',
      content: `(Current persona for agent \`${agentName}\` — for your reference only; the user has not just sent this:)\n\n\`\`\`md\n${currentPersona.trim()}\n\`\`\``,
    },
    {
      role: 'assistant',
      content: 'Understood. I will refine this persona based on what you ask.',
    },
  ]
  for (const turn of history) {
    messages.push({ role: turn.role, content: turn.text })
  }
  if (history.length === 0) {
    messages.push({
      role: 'user',
      content:
        '(No refinement instructions yet — please ask the user what they want to change.)',
    })
  }
  return messages
}

interface ParsedRefinement {
  message: string
  personaMarkdown: string
}

interface ParseOk {
  ok: true
  value: ParsedRefinement
}
interface ParseErr {
  ok: false
  reason: string
}

function tryParseRefinement(text: string): ParseOk | ParseErr {
  const json = extractJsonBlock(text)
  if (!json) return { ok: false, reason: 'no JSON object found in reply' }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    return {
      ok: false,
      reason: `JSON parse failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'top-level value is not an object' }
  }
  const obj = parsed as Record<string, unknown>
  const message =
    typeof obj.message === 'string'
      ? obj.message
      : '(architect returned no message)'
  const personaMarkdown =
    typeof obj.personaMarkdown === 'string' ? obj.personaMarkdown : ''
  if (!personaMarkdown.trim()) {
    return { ok: false, reason: 'missing personaMarkdown' }
  }
  return { ok: true, value: { message, personaMarkdown } }
}

function extractJsonBlock(text: string): string | null {
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i)
  const fencedJson = fenceMatch?.[1]
  if (fencedJson) return fencedJson.trim()
  const firstBrace = text.indexOf('{')
  if (firstBrace < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\') {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(firstBrace, i + 1)
    }
  }
  return null
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  const error = new Error('Agent refinement cancelled')
  error.name = 'AbortError'
  throw error
}

function fallback(
  input: RunRefineAgentInput,
  reason: string,
): RefineAgentResult {
  return {
    personaMarkdown: input.currentPersona,
    message: `(Agent architect offline — ${reason}.) Refinement not applied; the persona is unchanged.`,
    meta: { model: 'fallback', fallback: true, reason },
  }
}
