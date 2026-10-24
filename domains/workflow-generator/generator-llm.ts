/**
 * LLM call for the workflow architect.
 *
 * Orchestration only: builds the message history, asks for strict JSON via
 * a fenced code block, parses it, runs a single repair retry on failure,
 * and falls back gracefully if the architect is not configured.
 *
 * All provider/model wire details (API URLs, version headers, max-tokens,
 * env var names, and the actual fetch call) live in
 * `domains/provider/model-client.ts`.
 */

import {
  toModelSelectionRecord,
  userChoiceSelectionRecord,
  type ModelSelectionRecord,
} from '../../contracts/agent-model-selection.js'
import { whenDefined } from '../../core/optional-properties.js'
import type { ThinkingLevel } from '../../core/types.js'
import type {
  ChatTurn,
  GeneratorTurnResponse,
  WorkflowDraft,
  WorkflowGeneratorRegistry,
} from './workflow-draft.js'
import { renderRegistryBlock } from './generator-prompt.js'
import { CHAT_VISUALIZATION_POLICY } from '../../core/chat-visualization-policy.js'
import {
  loadArchitectConfig,
  WorkflowArchitectNotConfiguredError,
} from '../provider/architect-model-config.js'
import {
  callModel,
  helperProviderOptionTransport,
  mapHelperProviderOptions,
  readApiKey,
  type ModelMessage,
} from '../provider/model-client.js'
import { createStreamingJsonFieldReader } from '../provider/streaming-json-field.js'

/** The one field of the architect's JSON envelope that is prose. */
const GENERATOR_MESSAGE_FIELD = 'message'

export interface RunGeneratorTurnInput {
  history: ChatTurn[]
  currentDraft: WorkflowDraft | null
  repoRoot: string
  registry: WorkflowGeneratorRegistry
  /** Optional per-turn model override; falls back to the architect config. */
  provider?: string
  model?: string
  signal?: AbortSignal
  /**
   * Display-only observer for the reply's prose.
   *
   * The architect answers with one JSON object, so the raw stream is a growing
   * JSON blob. Only the decoded `message` field is reported, and only from the
   * first attempt: a repair attempt replaces what the first one said rather
   * than continuing it.
   */
  onTextDelta?: (text: string) => void
  /**
   * Reported once, as soon as the turn knows which pair it will run on and
   * before anything is sent.
   */
  onSelectionResolved?: (selection: ModelSelectionRecord) => Promise<void>
}

export interface RunGeneratorTurnResult {
  response: GeneratorTurnResponse
  model: string
  fallback: boolean
  reason?: string
  /** How this turn's model was decided, when it got far enough to decide. */
  selection?: ModelSelectionRecord
}

export async function runGeneratorTurn(
  input: RunGeneratorTurnInput,
): Promise<RunGeneratorTurnResult> {
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

  // An explicit ad hoc choice for this authoring turn is the caller's own,
  // not the architect Agent's. Only when the caller supplies none does the
  // architect's unresolved selection become the reason this cannot run.
  const provider = input.provider?.trim() || config.provider
  const model = input.model?.trim() || config.model
  if (!provider || !model) {
    return fallback(
      input,
      config.selectionError?.message ??
        'The Workflow Architect has no model selected.',
    )
  }

  // An explicit ad hoc choice for this authoring turn is the caller's own; only
  // when the caller supplies none is the Architect's own selection what ran.
  const selection =
    input.provider?.trim() && input.model?.trim()
      ? userChoiceSelectionRecord(
          { provider: input.provider.trim(), model: input.model.trim() },
          'authoring',
        )
      : config.selection
        ? toModelSelectionRecord(config.selection, 'authoring')
        : undefined
  // Reported before anything is sent, so the disclosure exists while the model
  // is in use rather than once the turn is over.
  if (selection) await input.onSelectionResolved?.(selection)

  // §4.3: the Architect is an Agent and runs on its own settings. An ad hoc
  // choice for one authoring turn is somebody else's choice, so none of the
  // persona's settings follow it — a setting nobody asked for, applied to a
  // model nobody configured it against.
  const callerChose = Boolean(input.provider?.trim() && input.model?.trim())
  // The two kinds of setting part company here, as they do in the Agent
  // loader. A declared *level* is vendor-neutral — it says how much this Agent
  // should think — so `parsers/load-agent.ts:317,370` returns it whatever the
  // selection source, and it travels with the Agent onto whatever pair runs.
  const thinking = callerChose ? undefined : config.thinking
  // A *vendor option* names one vendor's field, so it belongs to the pair that
  // named it. An Agent declaring no pair has chosen none, and the application
  // default may be another vendor whose API these settings do not describe —
  // the rule `load-agent.ts:384-385` and `resource-architect-llm.ts:240-242`
  // both apply, and this caller was the one that did not.
  const ownsPair = !callerChose && config.selection?.source === 'agent'
  const providerOptions = ownsPair ? config.providerOptions : undefined
  // Unconditional, and deliberately not narrowed with either of the above. A
  // file whose settings cannot be read, or that names a credential, is a broken
  // file rather than one whose settings merely do not apply to this pair —
  // which pair runs is a different question, and neither an ad hoc choice nor
  // an inherited default makes an unreadable file readable. The Agent and Team
  // Architect refuses such a file the same way, whatever the caller asked for.
  if (config.providerOptionsError) {
    return fallback(input, config.providerOptionsError)
  }
  // Checked against the transport this pair actually uses, before anything is
  // sent. A setting that silently does nothing cannot be told apart from one
  // the provider ignored, and the turn must not spend a model call to find out.
  const optionsRefusal = describeProviderOptionRefusal(provider, providerOptions, thinking, model)
  if (optionsRefusal) return fallback(input, optionsRefusal)

  const keyResult = readApiKey(provider)
  if (keyResult.apiKey == null) {
    return fallback(input, `${keyResult.envVar} is not set`)
  }

  const systemPrompt = [
    config.systemPrompt.trim(),
    CHAT_VISUALIZATION_POLICY,
    renderRegistryBlock(input.registry),
  ].join('\n\n')
  const messages = buildMessages(input.history, input.currentDraft)

  throwIfAborted(input.signal)
  const messageReader = createStreamingJsonFieldReader(GENERATOR_MESSAGE_FIELD)
  const firstAttempt = await callModel(keyResult.apiKey, {
    provider,
    model,
    systemPrompt,
    messages,
    ...whenDefined(thinking, (level) => ({ thinking: level })),
    ...whenDefined(
      providerOptions && Object.keys(providerOptions).length > 0
        ? providerOptions
        : undefined,
      (options) => ({ providerOptions: options }),
    ),
    ...whenDefined(input.signal, (definedValue) => ({ signal: definedValue })),
    ...whenDefined(input.onTextDelta, (report) => ({
      onTextDelta: (raw: string) => {
        const prose = messageReader.push(raw)
        if (prose !== '') report(prose)
      },
    })),
  })
  throwIfAborted(input.signal)
  if (!firstAttempt.ok) {
    return fallback(input, firstAttempt.reason)
  }

  const parsedFirst = tryParseTurn(firstAttempt.text)
  if (parsedFirst.ok) {
    return {
      response: parsedFirst.value,
      model: firstAttempt.model,
      fallback: false,
      ...whenDefined(selection, (resolved) => ({ selection: resolved })),
    }
  }

  const repairMessages: ModelMessage[] = [
    ...messages,
    { role: 'assistant', content: firstAttempt.text },
    {
      role: 'user',
      content:
        'Your previous reply was not valid JSON. Resend exactly the same content as a single JSON object wrapped in a ```json ... ``` fenced code block, with no other prose.',
    },
  ]
  const second = await callModel(keyResult.apiKey, {
    provider,
    model,
    systemPrompt,
    messages: repairMessages,
    ...whenDefined(thinking, (level) => ({ thinking: level })),
    ...whenDefined(
      providerOptions && Object.keys(providerOptions).length > 0
        ? providerOptions
        : undefined,
      (options) => ({ providerOptions: options }),
    ),
    ...whenDefined(input.signal, (definedValue) => ({ signal: definedValue })),
  })
  throwIfAborted(input.signal)
  if (!second.ok) {
    return fallback(input, second.reason)
  }
  const parsedSecond = tryParseTurn(second.text)
  if (parsedSecond.ok) {
    return {
      response: parsedSecond.value,
      model: second.model,
      fallback: false,
      // The repair is the same turn asking again, so it ran on the same pair.
      // Dropping this left the one attempt that succeeded unable to say
      // whether it used the application default.
      ...whenDefined(selection, (resolved) => ({ selection: resolved })),
    }
  }

  return fallback(
    input,
    `Architect returned non-JSON output twice. Last text: ${second.text.slice(0, 200)}`,
  )
}

/**
 * One sentence a person can act on, naming the setting that stopped the turn.
 *
 * Silence would be the defect: an option that does nothing is indistinguishable
 * from one the provider ignores. A CLI turn has no request body to map settings
 * into, but its adapter reads settings of its own, so nothing is refused there.
 */
function describeProviderOptionRefusal(
  provider: string,
  options: Record<string, string | number | boolean> | undefined,
  /**
   * The level the Agent declared.
   *
   * Part of this check because a transport that maps the level has to decide
   * whether its budget fits the answer ceiling, and that can fail with no
   * `provider_options` written at all.
   */
  thinking?: ThinkingLevel,
  /** The model that will run: what a transport can carry depends on it. */
  model?: string,
): string | undefined {
  // No early exit on "nothing was written": a transport can refuse the pair
  // itself — a model this endpoint does not serve — with no options in sight.
  const transport = helperProviderOptionTransport(provider, thinking, model)
  if (!transport) return undefined
  const mapped = mapHelperProviderOptions(transport, options)
  if (mapped.ok) return undefined
  if ('conflict' in mapped) return `${mapped.conflict} Nothing was sent.`
  return 'unsupported' in mapped
    ? `'provider_options.${mapped.unsupported}' is not a setting this provider ` +
      'request can carry. Nothing was sent.'
    : `'provider_options.${mapped.invalid}' must be ${mapped.expected}. Nothing was sent.`
}

function buildMessages(
  history: ChatTurn[],
  currentDraft: WorkflowDraft | null,
): ModelMessage[] {
  const messages: ModelMessage[] = []
  if (currentDraft) {
    messages.push({
      role: 'user',
      content: `(Current draft state — for your reference only; the user has not just sent this:)\n\n\`\`\`json\n${JSON.stringify(currentDraft, null, 2)}\n\`\`\``,
    })
    messages.push({
      role: 'assistant',
      content: 'Understood. I will iterate on this draft.',
    })
  }
  for (const turn of history) {
    messages.push({ role: turn.role, content: turn.text })
  }
  if (messages.length === 0) {
    messages.push({
      role: 'user',
      content: '(no message yet — greet briefly and ask what workflow they want to build.)',
    })
  }
  return messages
}

interface ParseOk {
  ok: true
  value: GeneratorTurnResponse
}

interface ParseErr {
  ok: false
  reason: string
}

function tryParseTurn(text: string): ParseOk | ParseErr {
  const json = extractJsonBlock(text)
  if (!json) {
    return { ok: false, reason: 'no JSON object found in reply' }
  }
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
    typeof obj.message === 'string' ? obj.message : '(architect returned no message)'
  const draft = isPlainObject(obj.draft) ? (obj.draft as WorkflowDraft) : null
  const warnings = Array.isArray(obj.warnings)
    ? obj.warnings.filter((item): item is string => typeof item === 'string')
    : undefined
  const handoff = parseHandoff(obj.handoff)

  return {
    ok: true,
    value: {
      message,
      draft,
      ...whenDefined(warnings, (presentWarnings) => ({ warnings: presentWarnings })),
      ...whenDefined(handoff, (presentHandoff) => ({ handoff: presentHandoff })),
    },
  }
}

function parseHandoff(value: unknown): GeneratorTurnResponse['handoff'] {
  if (!isPlainObject(value)) return undefined
  const record = value as Record<string, unknown>
  const targetMode = record.targetMode
  if (
    targetMode !== 'agents' &&
    targetMode !== 'teams' &&
    targetMode !== 'workflows'
  ) {
    return undefined
  }
  if (typeof record.prompt !== 'string' || !record.prompt.trim()) {
    return undefined
  }
  return {
    targetMode,
    prompt: record.prompt.trim(),
    reason: typeof record.reason === 'string' ? record.reason.trim() : '',
  }
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

function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  const error = new Error('Workflow generation cancelled')
  error.name = 'AbortError'
  throw error
}

function fallback(
  input: RunGeneratorTurnInput,
  reason: string,
): RunGeneratorTurnResult {
  const lastUser = [...input.history].reverse().find((turn) => turn.role === 'user')
  const userSnippet = lastUser ? `"${lastUser.text.slice(0, 120)}"` : 'your last message'
  return {
    response: {
      message: `(Workflow architect offline — ${reason}.)\n\nI heard ${userSnippet}. Once the architect is configured I'll respond properly.`,
      draft: input.currentDraft,
    },
    model: 'fallback',
    fallback: true,
    reason,
  }
}
