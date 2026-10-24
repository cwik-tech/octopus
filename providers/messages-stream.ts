/**
 * Streaming reader for the Anthropic Messages API (`/v1/messages`).
 *
 * Three things make this protocol different from the other two, and each is a
 * way to get a display stream wrong:
 *
 * - Text is one delta kind among several on the same `content_block_delta`
 *   event. Thinking, tool-call input and block signatures ride alongside it, so
 *   text is selected by `delta.type === 'text_delta'` and everything else is
 *   dropped. Anything looser would put private reasoning into the reply.
 * - Usage arrives twice. `message_start` carries the input side, including the
 *   two cache counters, and `message_delta` carries a *cumulative* output
 *   count. The last count replaces the earlier one; adding them would inflate
 *   every billed turn.
 * - The run ends when a `stop_reason` and a `message_stop` have both arrived.
 *   Either alone means the connection dropped partway.
 *
 * The reader rebuilds the non-streaming body shape so truncation detection,
 * text extraction, usage and cost keep running on one representation. That
 * non-streaming body is validated here too: a response body is external input
 * whichever transport carried it, so `parseAnthropicMessagesBody` constructs a
 * fresh typed value field by field rather than asserting a shape onto whatever
 * `response.json()` returned.
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

const TEXT_DELTA_TYPE = 'text_delta'

export interface AnthropicContentBlock {
  type?: string
  text?: string
}

/** The `/v1/messages` body shape, however it arrived. */
export interface AnthropicMessagesBody {
  model?: string
  stop_reason?: string
  content?: AnthropicContentBlock[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  error?: { message?: string; type?: string; code?: string }
}

export interface MessagesStreamResult {
  readonly text: string
  readonly body: AnthropicMessagesBody
}

export interface MessagesStreamOptions {
  readonly response: Response
  readonly provider: string
  /** Used when `message_start` names no model. */
  readonly fallbackModel: string
  readonly onProtocolEvent?: (event: ProviderProtocolEvent) => void
}

type Usage = NonNullable<AnthropicMessagesBody['usage']>

export async function readMessagesStream(
  options: MessagesStreamOptions,
): Promise<MessagesStreamResult> {
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
  let stopReason: string | undefined
  let usage: Usage = {}
  let sawMessageStop = false

  try {
    while (!sawMessageStop) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const frames = extractSseFrames(buffer)
      buffer = frames.remainder

      for (const frame of frames.events) {
        const data = readSseData(frame)
        // A comment line such as the keep-alive Anthropic sends on long turns.
        if (data.kind === 'absent') continue
        if (data.kind === 'malformed') {
          throw incompleteProviderStream(
            options.provider,
            'a streamed frame carried a payload that could not be parsed, so ' +
              'part of the answer is missing',
          )
        }

        const record = asRecord(data.value)
        if (!record || typeof record.type !== 'string') continue

        // `ping` and any event added to the protocol later fall through
        // untouched: an unrecognised event is not evidence of a problem.
        switch (record.type) {
          case 'error':
            throw streamedProviderError(
              options.provider,
              asRecord(record.error) ?? { message: 'the stream reported an error' },
            )

          case 'message_start': {
            const message = asRecord(record.message)
            if (!message) break
            if (typeof message.model === 'string') model = message.model
            usage = mergeUsage(usage, asRecord(message.usage))
            break
          }

          case 'content_block_delta': {
            const delta = asRecord(record.delta)
            if (!delta || delta.type !== TEXT_DELTA_TYPE) break
            if (typeof delta.text !== 'string' || delta.text.length === 0) break
            text += delta.text
            options.onProtocolEvent?.({
              kind: 'text',
              provider: options.provider,
              timestamp: new Date().toISOString(),
              ...whenString(model, (value) => ({ model: value })),
              // The new suffix only, never the running total.
              text: delta.text,
              rawType: TEXT_DELTA_TYPE,
            })
            break
          }

          case 'message_delta': {
            const delta = asRecord(record.delta)
            if (delta && typeof delta.stop_reason === 'string') {
              stopReason = delta.stop_reason
            }
            usage = mergeUsage(usage, asRecord(record.usage))
            break
          }

          case 'message_stop':
            sawMessageStop = true
            break

          default:
            break
        }
        if (sawMessageStop) break
      }
    }
  } finally {
    reader.releaseLock()
  }

  // Both signals are required. A `message_stop` with no `stop_reason` means the
  // run never said how it ended, and a `stop_reason` with no `message_stop`
  // means the connection dropped before the message closed. Either way the text
  // gathered is a prefix, and returning it would be indistinguishable from a
  // complete reply.
  if (stopReason === undefined || !sawMessageStop) {
    throw incompleteProviderStream(
      options.provider,
      'the stream ended before both a stop_reason and a message_stop arrived, ' +
        'so the answer is incomplete',
    )
  }

  return {
    text,
    body: {
      model: model ?? options.fallbackModel,
      stop_reason: stopReason,
      content: [{ type: 'text', text }],
      usage,
    },
  }
}

/**
 * Fold one usage report into the running total.
 *
 * Every field replaces rather than accumulates, because Anthropic's streamed
 * counts are cumulative: `message_delta` reports the output tokens for the
 * message so far, not the tokens since the previous event.
 */
function mergeUsage(current: Usage, incoming: Record<string, unknown> | undefined): Usage {
  if (!incoming) return current
  return {
    ...current,
    ...whenNumber(incoming.input_tokens, (value) => ({ input_tokens: value })),
    ...whenNumber(incoming.output_tokens, (value) => ({ output_tokens: value })),
    ...whenNumber(incoming.cache_creation_input_tokens, (value) => ({
      cache_creation_input_tokens: value,
    })),
    ...whenNumber(incoming.cache_read_input_tokens, (value) => ({
      cache_read_input_tokens: value,
    })),
  }
}

/**
 * Read a non-streaming `/v1/messages` body.
 *
 * Returns `null` when the body is absent or is not a JSON object — which the
 * caller treats as "this response carried no answer", not as an empty answer.
 */
export async function readAnthropicMessagesBody(
  response: Response,
): Promise<AnthropicMessagesBody | null> {
  const parsed: unknown = await response.json().catch(() => null)
  return parseAnthropicMessagesBody(parsed)
}

/** Construct a validated body from an untrusted value. */
export function parseAnthropicMessagesBody(
  value: unknown,
): AnthropicMessagesBody | null {
  const record = asRecord(value)
  if (!record) return null
  const usage = asRecord(record.usage)
  const error = asRecord(record.error)
  return {
    ...whenString(record.model, (model) => ({ model })),
    ...whenString(record.stop_reason, (stop_reason) => ({ stop_reason })),
    ...(Array.isArray(record.content)
      ? { content: record.content.map(buildContentBlock) }
      : {}),
    ...(usage ? { usage: mergeUsage({}, usage) } : {}),
    ...(error
      ? {
          error: {
            ...whenString(error.message, (message) => ({ message })),
            ...whenString(error.type, (type) => ({ type })),
            ...whenString(error.code, (code) => ({ code })),
          },
        }
      : {}),
  }
}

/**
 * Flatten a Messages body to text.
 *
 * Blocks are filtered by `type === 'text'`, so a thinking block or a tool-use
 * block cannot be read as the answer — the same exclusion the streamed path
 * applies to delta kinds.
 */
export function extractAnthropicMessagesText(
  body: AnthropicMessagesBody | null,
): string {
  return (body?.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('')
}

function buildContentBlock(value: unknown): AnthropicContentBlock {
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
 * The Messages protocol never states a total, so the sum stands in — arithmetic
 * over two validated numbers, not an estimate. The two cache counters are not
 * folded in: they measure something the shared three-field contract does not
 * describe, and quietly adding them to the input side would make one provider's
 * numbers mean something different from every other's.
 */
export function normalizeAnthropicMessagesUsage(
  usage: AnthropicMessagesBody['usage'] | undefined,
): NormalizedTokenUsage | undefined {
  if (!usage) return undefined
  return normalizeTokenUsage({
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  })
}

/**
 * What a non-success body is allowed to contribute to a durable record.
 *
 * Messages errors name their kind in `type` and rarely carry a `code`, but both
 * are read for the same reason and under the same bound: a short identifier is
 * kept, anything longer is prose and is dropped.
 */
export function readAnthropicMessagesErrorIdentity(
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
  const code = isSafeDiagnosticToken(error.type)
    ? error.type
    : isSafeDiagnosticToken(error.code)
      ? error.code
      : undefined
  return code === undefined ? {} : { providerCode: code }
}
