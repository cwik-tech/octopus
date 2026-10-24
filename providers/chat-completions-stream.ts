/**
 * The OpenAI-compatible Chat Completions protocol: its body shape, and the
 * streaming reader that rebuilds that shape from an SSE response.
 *
 * Five callers speak it — OpenRouter, DeepSeek, xAI, Kimi, and any configured
 * OpenAI-compatible connection — and each already has non-streaming code that
 * extracts text, detects truncation, reads usage and prices the turn. Rather
 * than duplicate those rules per provider in a streaming flavour, the reader
 * rebuilds the **same shape** the JSON path produces, so every downstream rule
 * keeps running on one representation and truncation evidence cannot be lost in
 * translation.
 *
 * Both paths are validated here for the same reason. A response body is
 * external input whichever transport carried it, so `parseChatCompletionsBody`
 * constructs a fresh typed value field by field rather than asserting a shape
 * onto whatever `response.json()` returned.
 *
 * The reader is deliberately intolerant of an incomplete stream. A display
 * stream has already shown the user the partial text, so quietly returning it
 * as a finished answer is the worst available outcome: it is indistinguishable
 * from a real reply. Four ways a stream can come up short all raise instead —
 * a payload that cannot be parsed, a body that ends before the `[DONE]`
 * terminator, a run with no terminal `finish_reason`, and an error frame
 * delivered under HTTP 200.
 */

import { extractSseFrames, readSseData } from './sse-stream.js'
import {
  asRecord,
  incompleteProviderStream,
  streamedProviderError,
  whenNumber,
  whenString,
} from './stream-reading.js'
import {
  isSafeDiagnosticToken,
  normalizeTokenUsage,
  type NormalizedTokenUsage,
} from '../contracts/model-diagnostics.js'
import type { ProviderProtocolEvent } from '../contracts/provider.js'

/** The documented terminator. Not JSON, so it arrives as a raw payload. */
const DONE_SENTINEL = '[DONE]'

export interface ChatCompletionsContentPart {
  type?: string
  text?: string
}

/** Assistant content: a plain string, structured parts, or an explicit null. */
export type ChatCompletionsContent = string | ChatCompletionsContentPart[] | null

export interface ChatCompletionsChoice {
  message?: { content?: ChatCompletionsContent }
  finish_reason?: string
}

export interface ChatCompletionsUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  /** OpenRouter's own billed cost, reported only when the request asks for it. */
  cost?: number
}

export interface ChatCompletionsError {
  message?: string
  type?: string
  code?: string
}

/** The response shape, however it arrived. */
export interface ChatCompletionsBody {
  id?: string
  model?: string
  choices?: ChatCompletionsChoice[]
  usage?: ChatCompletionsUsage
  error?: ChatCompletionsError
}

export interface ChatCompletionsStreamResult {
  readonly text: string
  readonly body: ChatCompletionsBody
  /**
   * Whether any chunk carried `tool_calls`.
   *
   * The calls themselves are not rebuilt: no caller of this reader runs tools.
   * A caller that asked for an answer with tools forbidden needs to know the
   * provider called one anyway, whatever `finish_reason` it then reported.
   */
  readonly requestedToolCalls: boolean
}

export interface ChatCompletionsStreamOptions {
  readonly response: Response
  readonly provider: string
  /** Used when no chunk names a model, matching the JSON path's fallback. */
  readonly fallbackModel: string
  readonly onProtocolEvent?: (event: ProviderProtocolEvent) => void
}

export async function readChatCompletionsStream(
  options: ChatCompletionsStreamOptions,
): Promise<ChatCompletionsStreamResult> {
  if (!options.response.body) {
    throw incompleteProviderStream(
      options.provider,
      'the streaming response carried no body',
    )
  }

  const reader = options.response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let model: string | undefined
  let finishReason: string | undefined
  let usage: ChatCompletionsUsage | undefined
  let sawDone = false
  let requestedToolCalls = false

  try {
    while (!sawDone) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const frames = extractSseFrames(buffer)
      buffer = frames.remainder

      for (const frame of frames.events) {
        const data = readSseData(frame)
        // A comment (`: keep-alive`) or a bare `event:` line. Routine traffic.
        if (data.kind === 'absent') continue
        if (data.kind === 'malformed') {
          if (data.raw === DONE_SENTINEL) {
            // Nothing after the terminator belongs to the answer.
            sawDone = true
            break
          }
          throw incompleteProviderStream(
            options.provider,
            'a streamed frame carried a payload that could not be parsed, so ' +
              'part of the answer is missing',
          )
        }

        const record = asRecord(data.value)
        if (!record) continue

        // An error can arrive mid-stream under HTTP 200. Raising here is what
        // stops the text already accumulated from being returned as an answer.
        const frameError = asRecord(record.error)
        if (frameError) throw streamedProviderError(options.provider, frameError)

        if (typeof record.model === 'string') model = record.model
        const frameUsage = asRecord(record.usage)
        if (frameUsage) {
          // Usage arrives in its own trailing chunk when `include_usage` is
          // requested — `choices` is empty there, so this is read before any
          // choice handling and never behind a `continue`.
          usage = buildUsage(frameUsage)
        }

        const first = asRecord(
          Array.isArray(record.choices) ? record.choices[0] : undefined,
        )
        if (!first) continue
        if (typeof first.finish_reason === 'string') {
          finishReason = first.finish_reason
        }

        const delta = asRecord(first.delta)
        const toolCalls = delta?.tool_calls
        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
          requestedToolCalls = true
        }
        const content = delta?.content
        if (typeof content === 'string' && content.length > 0) {
          text += content
          options.onProtocolEvent?.({
            kind: 'text',
            provider: options.provider,
            timestamp: new Date().toISOString(),
            ...whenString(model, (value) => ({ model: value })),
            // The new suffix only. Sending the running total would make each
            // event cost O(answer length).
            text: content,
            rawType: 'chat.completion.chunk',
          })
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  // `[DONE]` is the protocol's own statement that nothing further is coming.
  // Without it the socket closed on its own terms, and the text collected is a
  // prefix of an answer rather than the answer — including the deceptive case
  // where a `finish_reason` already arrived and only the trailing usage chunk
  // was lost, which leaves no dangling bytes to give the truncation away.
  if (!sawDone) {
    throw incompleteProviderStream(
      options.provider,
      buffer.trim().length > 0
        ? 'the stream ended before the frame it was writing was complete'
        : 'the stream ended before its [DONE] terminator, so the endpoint had ' +
          'more to send',
    )
  }
  if (finishReason === undefined) {
    throw incompleteProviderStream(
      options.provider,
      'the stream ended before a terminal chunk arrived (no finish_reason was ' +
        'received), so the answer is incomplete',
    )
  }

  return {
    text,
    requestedToolCalls,
    body: {
      model: model ?? options.fallbackModel,
      choices: [
        {
          message: { content: text },
          finish_reason: finishReason,
        },
      ],
      ...(usage ? { usage } : {}),
    },
  }
}

/**
 * Read a non-streaming Chat Completions body.
 *
 * Returns `null` when the body is absent or is not a JSON object — which the
 * callers treat as "this response carried no answer", not as an empty answer.
 */
export async function readChatCompletionsBody(
  response: Response,
): Promise<ChatCompletionsBody | null> {
  const parsed: unknown = await response.json().catch(() => null)
  return parseChatCompletionsBody(parsed)
}

/** Construct a validated body from an untrusted value. */
export function parseChatCompletionsBody(
  value: unknown,
): ChatCompletionsBody | null {
  const record = asRecord(value)
  if (!record) return null
  const usage = asRecord(record.usage)
  const error = asRecord(record.error)
  return {
    ...whenString(record.id, (id) => ({ id })),
    ...whenString(record.model, (model) => ({ model })),
    ...(Array.isArray(record.choices)
      ? { choices: record.choices.map(buildChoice) }
      : {}),
    ...(usage ? { usage: buildUsage(usage) } : {}),
    ...(error
      ? {
          error: {
            ...whenString(error.message, (message) => ({ message })),
            ...whenString(error.type, (type) => ({ type })),
            // A non-string code is dropped rather than coerced; every caller
            // already required a string here and fell back to `type`.
            ...whenString(error.code, (code) => ({ code })),
          },
        }
      : {}),
  }
}

/**
 * Flatten assistant content to text.
 *
 * Structured parts are filtered by `type === 'text'`, so a refusal or an image
 * part cannot be read as the answer.
 */
export function extractChatCompletionsText(
  content: ChatCompletionsContent | undefined,
): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('')
}

function buildUsage(usage: Record<string, unknown>): ChatCompletionsUsage {
  return {
    ...whenNumber(usage.prompt_tokens, (value) => ({ prompt_tokens: value })),
    ...whenNumber(usage.completion_tokens, (value) => ({ completion_tokens: value })),
    ...whenNumber(usage.total_tokens, (value) => ({ total_tokens: value })),
    ...whenNumber(usage.cost, (value) => ({ cost: value })),
  }
}

function buildChoice(value: unknown): ChatCompletionsChoice {
  const record = asRecord(value)
  if (!record) return {}
  const message = asRecord(record.message)
  return {
    ...(message ? { message: buildContent(message.content) } : {}),
    ...whenString(record.finish_reason, (finish_reason) => ({ finish_reason })),
  }
}

function buildContent(value: unknown): { content?: ChatCompletionsContent } {
  if (typeof value === 'string') return { content: value }
  // An explicit null is a real wire value and is kept apart from an absent
  // field, so a tool-call-only reply is not confused with a malformed one.
  if (value === null) return { content: null }
  if (!Array.isArray(value)) return {}
  return { content: value.map(buildContentPart) }
}

function buildContentPart(value: unknown): ChatCompletionsContentPart {
  const record = asRecord(value)
  if (!record) return {}
  return {
    ...whenString(record.type, (type) => ({ type })),
    ...whenString(record.text, (text) => ({ text })),
  }
}

/**
 * Reported usage, in the one shape every provider's counts are reduced to.
 *
 * The protocol's own field names stop here: a durable record that kept
 * `prompt_tokens` for one provider and `input_tokens` for another would make
 * every reader learn both.
 */
export function normalizeChatCompletionsUsage(
  usage: ChatCompletionsUsage | undefined,
): NormalizedTokenUsage | undefined {
  if (!usage) return undefined
  return normalizeTokenUsage({
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    ...(usage.total_tokens === undefined
      ? {}
      : { totalTokens: usage.total_tokens }),
  })
}

/**
 * What a non-success body is allowed to contribute to a durable record.
 *
 * The body itself is display material: its message can quote the request, and
 * a provider may put anything in any field. A short code is the one part worth
 * keeping, and it is kept only when it really is a code — `code` first, then
 * `type`, which is what every caller here already fell back to.
 */
export function readChatCompletionsErrorIdentity(
  body: string,
): { providerCode?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return {}
  }
  const error = asRecord(asRecord(parsed)?.error)
  if (!error) return {}
  const code = isSafeDiagnosticToken(error.code)
    ? error.code
    : isSafeDiagnosticToken(error.type)
      ? error.type
      : undefined
  return code === undefined ? {} : { providerCode: code }
}
