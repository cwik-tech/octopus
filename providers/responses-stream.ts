/**
 * Streaming reader for the OpenAI Responses API (`/v1/responses`).
 *
 * The protocol is event-typed rather than chunk-shaped: text arrives as
 * `response.output_text.delta`, and the run ends with one typed terminal event
 * carrying the whole response object. That object is the only place `status`,
 * `incomplete_details`, `usage` and `model` appear, so the reader keeps it and
 * hands it back in the shape the non-streaming path already inspects. Every
 * downstream rule — truncation detection, text extraction, usage, cost — then
 * runs on one representation regardless of how the answer arrived.
 *
 * A terminal event is required. Without one the run may have been cut off at
 * any point, and the deltas seen so far are a prefix, not an answer. Where the
 * terminal object and the deltas disagree, the terminal object wins: deltas are
 * a display preview, and the durable reply has to be what the API says it
 * finally produced.
 *
 * The non-streaming body for the same endpoint is validated here too. A
 * response body is external input whichever transport carried it, so
 * `parseOpenAIResponsesBody` constructs a fresh typed value field by field
 * rather than asserting a shape onto whatever `response.json()` returned.
 */

import { extractSseFrames, readSseData } from './sse-stream.js'
import {
  asRecord,
  incompleteProviderStream,
  streamedProviderError,
  whenNumber,
  whenString,
} from './stream-reading.js'
import type { ProviderProtocolEvent } from '../contracts/provider.js'

/** Some deployments append the Chat Completions sentinel. Harmless; ignored. */
const DONE_SENTINEL = '[DONE]'

const TEXT_DELTA_EVENT = 'response.output_text.delta'
const TERMINAL_EVENTS = ['response.completed', 'response.incomplete'] as const
const FAILURE_EVENT = 'response.failed'
const STREAM_ERROR_EVENT = 'error'

export interface OpenAIResponsesContentPart {
  type?: string
  text?: string
}

export interface OpenAIResponsesOutputItem {
  type?: string
  content?: OpenAIResponsesContentPart[]
}

/** The `/v1/responses` body shape, however it arrived. */
export interface OpenAIResponsesBody {
  model?: string
  status?: string
  incomplete_details?: { reason?: string }
  output_text?: string
  output?: OpenAIResponsesOutputItem[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
  }
  error?: { message?: string; type?: string; code?: string }
}

export interface ResponsesStreamResult {
  readonly text: string
  readonly body: OpenAIResponsesBody
}

export interface ResponsesStreamOptions {
  readonly response: Response
  readonly provider: string
  /** Used when the terminal response names no model. */
  readonly fallbackModel: string
  readonly onProtocolEvent?: (event: ProviderProtocolEvent) => void
}

export async function readResponsesStream(
  options: ResponsesStreamOptions,
): Promise<ResponsesStreamResult> {
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
  let terminal: Record<string, unknown> | undefined

  try {
    while (!terminal) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const frames = extractSseFrames(buffer)
      buffer = frames.remainder

      for (const frame of frames.events) {
        const data = readSseData(frame)
        if (data.kind === 'absent') continue
        if (data.kind === 'malformed') {
          if (data.raw === DONE_SENTINEL) continue
          throw incompleteProviderStream(
            options.provider,
            'a streamed frame carried a payload that could not be parsed, so ' +
              'part of the answer is missing',
          )
        }

        const record = asRecord(data.value)
        if (!record || typeof record.type !== 'string') continue
        const eventType = record.type

        // The stream's own failure channel: a well-formed error under HTTP 200.
        if (eventType === STREAM_ERROR_EVENT) {
          throw streamedProviderError(options.provider, record)
        }
        if (eventType === FAILURE_EVENT) {
          const failed = asRecord(record.response)
          throw streamedProviderError(
            options.provider,
            asRecord(failed?.error) ?? { message: 'the response failed' },
          )
        }

        if (isTerminalEvent(eventType)) {
          const response = asRecord(record.response)
          if (!response) {
            throw incompleteProviderStream(
              options.provider,
              `the ${eventType} event carried no response object`,
            )
          }
          terminal = response
          break
        }

        // Only committed answer text is displayed. Reasoning summaries,
        // refusals and tool-call arguments each have their own delta events and
        // are deliberately not shown as the reply.
        if (eventType === TEXT_DELTA_EVENT && typeof record.delta === 'string') {
          const delta = record.delta
          if (delta.length === 0) continue
          text += delta
          options.onProtocolEvent?.({
            kind: 'text',
            provider: options.provider,
            timestamp: new Date().toISOString(),
            // The new suffix only, never the running total.
            text: delta,
            rawType: eventType,
          })
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  if (!terminal) {
    throw incompleteProviderStream(
      options.provider,
      'the stream ended before a response.completed or response.incomplete ' +
        'event arrived, so the answer is incomplete',
    )
  }

  return { text, body: buildBody(terminal, text, options.fallbackModel) }
}

function isTerminalEvent(eventType: string): boolean {
  for (const candidate of TERMINAL_EVENTS) {
    if (candidate === eventType) return true
  }
  return false
}

/**
 * Rebuild the terminal response as a validated value.
 *
 * The terminal object is the authority on what the model produced. The
 * accumulated deltas fill `output_text` only when the terminal object carries
 * no text of its own — neither an `output_text` nor an output item with text —
 * which reconstructs a field some deployments omit without ever overriding what
 * the API actually reported. The deltas are the API's own
 * `response.output_text.delta` stream, so that reconstruction excludes the
 * reasoning and refusal channels by construction.
 */
function buildBody(
  terminal: Record<string, unknown>,
  streamedText: string,
  fallbackModel: string,
): OpenAIResponsesBody {
  const parsed = parseOpenAIResponsesBody(terminal) ?? {}
  const terminalHasText =
    parsed.output_text !== undefined || (parsed.output ?? []).some(itemHasText)
  return {
    ...parsed,
    model: parsed.model !== undefined && parsed.model.length > 0
      ? parsed.model
      : fallbackModel,
    ...(terminalHasText || streamedText.length === 0
      ? {}
      : { output_text: streamedText }),
  }
}

function itemHasText(item: OpenAIResponsesOutputItem): boolean {
  return (item.content ?? []).some(
    (part) => typeof part.text === 'string' && part.text.length > 0,
  )
}

/**
 * Read a non-streaming `/v1/responses` body.
 *
 * Returns `null` when the body is absent or is not a JSON object — which the
 * caller treats as "this response carried no answer", not as an empty answer.
 */
export async function readOpenAIResponsesBody(
  response: Response,
): Promise<OpenAIResponsesBody | null> {
  const parsed: unknown = await response.json().catch(() => null)
  return parseOpenAIResponsesBody(parsed)
}

/** Construct a validated body from an untrusted value. */
export function parseOpenAIResponsesBody(
  value: unknown,
): OpenAIResponsesBody | null {
  const record = asRecord(value)
  if (!record) return null
  const details = asRecord(record.incomplete_details)
  const usage = asRecord(record.usage)
  const error = asRecord(record.error)
  return {
    ...whenString(record.model, (model) => ({ model })),
    ...whenString(record.status, (status) => ({ status })),
    ...(details
      ? {
          incomplete_details: {
            ...whenString(details.reason, (reason) => ({ reason })),
          },
        }
      : {}),
    ...whenString(record.output_text, (output_text) => ({ output_text })),
    ...(Array.isArray(record.output)
      ? { output: record.output.map(buildOutputItem) }
      : {}),
    ...(usage
      ? {
          usage: {
            ...whenNumber(usage.input_tokens, (value_) => ({ input_tokens: value_ })),
            ...whenNumber(usage.output_tokens, (value_) => ({ output_tokens: value_ })),
            ...whenNumber(usage.total_tokens, (value_) => ({ total_tokens: value_ })),
          },
        }
      : {}),
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
 * Flatten a Responses body to text.
 *
 * `output_text` wins when present, matching the shape the SDK synthesizes;
 * otherwise the text parts of every output item are concatenated.
 */
export function extractOpenAIResponsesText(
  body: OpenAIResponsesBody | null,
): string {
  if (!body) return ''
  if (typeof body.output_text === 'string') return body.output_text
  if (!Array.isArray(body.output)) return ''
  return body.output
    .flatMap((item) => item.content ?? [])
    .filter((part) => typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('')
}

function buildOutputItem(item: unknown): OpenAIResponsesOutputItem {
  const record = asRecord(item)
  if (!record) return {}
  return {
    ...whenString(record.type, (value) => ({ type: value })),
    ...(Array.isArray(record.content)
      ? { content: record.content.map(buildContentPart) }
      : {}),
  }
}

function buildContentPart(part: unknown): OpenAIResponsesContentPart {
  const record = asRecord(part)
  if (!record) return {}
  return {
    ...whenString(record.type, (value) => ({ type: value })),
    ...whenString(record.text, (value) => ({ text: value })),
  }
}
