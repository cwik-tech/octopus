import type {
  ProviderToolAssistantTurn,
  ProviderToolDefinition,
  ProviderToolLoopAdapter,
  ProviderToolLoopAdapterRequest,
  ProviderToolLoopMessage,
  ProviderToolLoopUsage,
  ProviderToolCall,
} from './provider-tool-loop.js'
import {
  ProviderToolLoopError,
  runProviderToolOperationWithDeadline,
  type ProviderFailureIdentity,
} from './provider-tool-loop.js'
import {
  ProviderError,
  boundedProviderCode,
  parseProviderError,
  type ParsedProviderError,
} from './provider-error.js'
import { detectProviderTruncation } from './provider-truncation.js'
import { readChatCompletionsStream } from '../../providers/chat-completions-stream.js'
import { z } from 'zod'

const modelParametersSchema = z.object({
  temperature: z.number().finite().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high']).optional(),
}).strict()

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576
const DEFAULT_MAX_RESPONSE_BYTES = 2_097_152

export interface OpenAIChatCompletionsToolAdapterOptions {
  readonly modelParameters?: unknown
  readonly apiUrl: string
  readonly model: string
  readonly apiKey?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly requestTimeoutMs?: number
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  /**
   * The effort level this turn runs at, already resolved against the pair.
   *
   * A tool-bearing turn is an ordinary turn. Leaving the setting out of this
   * body would mean an agent's chosen depth applied everywhere except the
   * moment it was given tools, which is where the harder thinking usually
   * belongs.
   */
  readonly reasoningEffort?: string
  /**
   * Called once with the whole answer: the text of the round that requested no
   * tools, or, with `onFinalTextDelta`, the complete streamed answer.
   *
   * A tool-requesting round's prose is planning, not the answer. Surfacing it
   * would show the user text the final reply does not contain, so it is
   * suppressed rather than streamed and later retracted (D9).
   */
  readonly onFinalRoundText?: (text: string) => void
  /**
   * Called with each piece of the answer as the provider streams it.
   *
   * Giving it adds `completeFinal`: the answer is asked for again in a
   * tool-free, streamed request once a round decides to answer, and no
   * tool-capable round reports anything. Without it every round is one
   * buffered request, as before.
   */
  readonly onFinalTextDelta?: (text: string) => void
}

interface OpenAIChatCompletionResponse {
  readonly model?: unknown
  readonly choices?: unknown
  readonly usage?: unknown
}

interface ResolvedOpenAIAdapterOptions {
  readonly modelParameters: z.infer<typeof modelParametersSchema>
  readonly apiUrl: string
  readonly model: string
  readonly apiKey?: string
  readonly headers: Readonly<Record<string, string>>
  readonly requestTimeoutMs: number
  readonly maxRequestBytes: number
  readonly maxResponseBytes: number
  readonly reasoningEffort?: string
  readonly onFinalRoundText?: (text: string) => void
  readonly onFinalTextDelta?: (text: string) => void
}

export function createOpenAIChatCompletionsToolAdapter(
  options: OpenAIChatCompletionsToolAdapterOptions,
): ProviderToolLoopAdapter {
  const { onFinalTextDelta, onFinalRoundText, ...buffered } =
    resolveAdapterOptions(options)
  if (!onFinalTextDelta) {
    return {
      complete: (request) => requestOpenAIChatCompletion({
        ...buffered,
        ...whenDefined(onFinalRoundText, (observer) => ({ onFinalRoundText: observer })),
        request,
      }),
    }
  }
  return {
    // Every tool-capable round stays buffered and reports nothing. Its text is
    // planning or a draft the final request replaces.
    complete: (request) => requestOpenAIChatCompletion({ ...buffered, request }),
    completeFinal: (request) => requestStreamedAnswer({
      ...buffered,
      onFinalTextDelta,
      ...whenDefined(onFinalRoundText, (observer) => ({ onFinalRoundText: observer })),
      request,
    }),
  }
}

function resolveAdapterOptions(
  options: OpenAIChatCompletionsToolAdapterOptions,
): ResolvedOpenAIAdapterOptions {
  if (!options || typeof options !== 'object') {
    throw adapterError('invalid_configuration')
  }
  const apiUrl = normalizeProviderUrl(options.apiUrl)
  const model = normalizeRequiredString(options.model)
  const apiKey = normalizeOptionalSecret(options.apiKey)
  const requestTimeoutMs = positiveInteger(
    options.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
  )
  const maxRequestBytes = positiveInteger(
    options.maxRequestBytes,
    DEFAULT_MAX_REQUEST_BYTES,
  )
  const maxResponseBytes = positiveInteger(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
  )
  const headers = normalizeHeaders(options.headers)

  return {
    modelParameters: modelParametersSchema.parse(options.modelParameters ?? {}),
    ...(typeof options.onFinalRoundText === 'function'
      ? { onFinalRoundText: options.onFinalRoundText }
      : {}),
    ...(typeof options.onFinalTextDelta === 'function'
      ? { onFinalTextDelta: options.onFinalTextDelta }
      : {}),
    apiUrl,
    model,
    ...whenDefined(apiKey, (presentApiKey) => ({ apiKey: presentApiKey })),
    headers,
    requestTimeoutMs,
    maxRequestBytes,
    maxResponseBytes,
    ...whenDefined(
      normalizeOptionalEffort(options.reasoningEffort),
      (effort) => ({ reasoningEffort: effort }),
    ),
  }
}

/** A non-empty level name, or nothing. An empty string is not a choice. */
function normalizeOptionalEffort(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

interface OpenAIChatCompletionRequestParams {
  modelParameters: z.infer<typeof modelParametersSchema>
  apiUrl: string
  model: string
  apiKey?: string
  headers: Readonly<Record<string, string>>
  request: ProviderToolLoopAdapterRequest
  requestTimeoutMs: number
  maxRequestBytes: number
  maxResponseBytes: number
  reasoningEffort?: string
  onFinalRoundText?: (text: string) => void
}

async function requestOpenAIChatCompletion(
  params: OpenAIChatCompletionRequestParams,
): Promise<ProviderToolAssistantTurn> {
  const requestBody = buildRequestBody(params, 'tool-capable')
  return runBoundedRequest(
    params,
    requestBody,
    (signal) => executeRequest(params, requestBody, signal),
  )
}

/**
 * The tool-free final request, streamed.
 *
 * Same model, messages, tools, model parameters, reasoning effort and headers
 * as a tool-capable round, with `tool_choice: "none"` and `stream: true`. The
 * deadline, the caller's cancellation and both byte bounds apply as for any
 * other round; the response bound covers the whole streamed body, not only one
 * frame.
 */
async function requestStreamedAnswer(
  params: OpenAIChatCompletionRequestParams & {
    readonly onFinalTextDelta: (text: string) => void
  },
): Promise<ProviderToolAssistantTurn> {
  const requestBody = buildRequestBody(params, 'final')
  return runBoundedRequest(
    params,
    requestBody,
    (signal) => executeStreamedAnswer(params, requestBody, signal),
  )
}

async function runBoundedRequest(
  params: Pick<OpenAIChatCompletionRequestParams, 'request' | 'requestTimeoutMs' | 'maxRequestBytes'>,
  requestBody: string,
  execute: (signal: AbortSignal) => Promise<ProviderToolAssistantTurn>,
): Promise<ProviderToolAssistantTurn> {
  if (Buffer.byteLength(requestBody, 'utf8') > params.maxRequestBytes) {
    throw adapterError('request_too_large')
  }

  try {
    return await runProviderToolOperationWithDeadline(
      params.request.signal,
      params.requestTimeoutMs,
      execute,
    )
  } catch (error) {
    if (error instanceof ProviderToolLoopError) throw error
    throw adapterError('provider_request_failed', true)
  }
}

function buildRequestBody(
  params: Pick<
    OpenAIChatCompletionRequestParams,
    'model' | 'request' | 'modelParameters' | 'reasoningEffort'
  >,
  kind: 'tool-capable' | 'final',
): string {
  const final = kind === 'final'
  return JSON.stringify({
    ...params.modelParameters,
    model: params.model,
    messages: params.request.messages.flatMap(toOpenAIMessages),
    tools: params.request.tools.map(toOpenAITool),
    // The final request keeps the tools so the history's tool calls still
    // read against their definitions, and forbids calling any of them.
    tool_choice: final ? 'none' : 'auto',
    stream: final,
    // A streamed response reports usage only when asked to, and the final
    // request counts toward the turn's usage like any other round.
    ...(final ? { stream_options: { include_usage: true } } : {}),
    ...(params.reasoningEffort ? { reasoning_effort: params.reasoningEffort } : {}),
  })
}

async function executeStreamedAnswer(
  params: {
    apiUrl: string
    apiKey?: string
    headers: Readonly<Record<string, string>>
    model: string
    maxResponseBytes: number
    onFinalTextDelta: (text: string) => void
    onFinalRoundText?: (text: string) => void
  },
  requestBody: string,
  signal: AbortSignal,
): Promise<ProviderToolAssistantTurn> {
  // Aborted on any failure below. The SSE reader stops at the first bad frame
  // and only releases its lock, so without this the provider's connection
  // stays open for as long as the provider keeps it open.
  const connection = new AbortController()
  const response = await postRequest(
    params,
    requestBody,
    AbortSignal.any([signal, connection.signal]),
  )
  try {
    // `stream: true` is a request, not a guarantee: an endpoint that ignores
    // it answers with one JSON completion, which is shown whole.
    const streamed = (response.headers.get('content-type') ?? '').includes(
      'text/event-stream',
    )
    const answer = streamed
      ? await readStreamedAnswer(params, response, signal)
      : parseOpenAIChatCompletion(
          await readBoundedResponseBody(response, params.maxResponseBytes),
        )
    // The request forbade tools. Tool calls in the reply fail the turn rather
    // than being run after text that may already be on screen.
    if (answer.toolCalls.length > 0) throw adapterError('invalid_provider_response')
    const text = answer.content ?? ''
    if (text.trim()) {
      if (!streamed) observe(params.onFinalTextDelta, text)
      observe(params.onFinalRoundText, text)
    }
    return answer
  } catch (error) {
    connection.abort()
    throw error instanceof ProviderError ? streamedProviderFailure(error) : error
  }
}

async function readStreamedAnswer(
  params: {
    model: string
    maxResponseBytes: number
    onFinalTextDelta: (text: string) => void
  },
  response: Response,
  signal: AbortSignal,
): Promise<ProviderToolAssistantTurn> {
  const result = await readChatCompletionsStream({
    response: boundedResponse(response, params.maxResponseBytes),
    provider: 'mcp-native',
    fallbackModel: params.model,
    onProtocolEvent: (event) => {
      if (event.kind !== 'text' || !event.text || signal.aborted) return
      observe(params.onFinalTextDelta, event.text)
    },
  })
  if (detectProviderTruncation(result.body) !== undefined) {
    throw adapterError('provider_truncated')
  }
  if (result.requestedToolCalls) throw adapterError('invalid_provider_response')
  return {
    content: result.text,
    toolCalls: [],
    ...(result.body.model?.trim() ? { model: result.body.model } : {}),
    ...(result.body.usage ? { usage: parseOpenAIUsage(result.body.usage) } : {}),
  }
}

/**
 * The same response, failing once its body passes `maxBytes` in total.
 *
 * The SSE reader bounds nothing across frames, so an answer of many small
 * frames would otherwise be read without limit.
 */
function boundedResponse(response: Response, maxBytes: number): Response {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    void response.body?.cancel().catch(() => undefined)
    throw adapterError('response_too_large')
  }
  if (!response.body) return response
  let totalBytes = 0
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        totalBytes += chunk.byteLength
        if (totalBytes > maxBytes) {
          controller.error(adapterError('response_too_large'))
          return
        }
        controller.enqueue(chunk)
      },
    }),
  )
  return new Response(body, { status: response.status, headers: response.headers })
}

/** Observability only: a throwing observer must not fail the turn. */
function observe(observer: ((text: string) => void) | undefined, text: string): void {
  try {
    observer?.(text)
  } catch {
    // Intentionally swallowed.
  }
}

async function executeRequest(
  params: {
    apiUrl: string
    apiKey?: string
    headers: Readonly<Record<string, string>>
    maxResponseBytes: number
    onFinalRoundText?: (text: string) => void
  },
  requestBody: string,
  signal: AbortSignal,
): Promise<ProviderToolAssistantTurn> {
  const response = await postRequest(params, requestBody, signal)
  const responseBody = await readBoundedResponseBody(
    response,
    params.maxResponseBytes,
  )
  return parseOpenAIChatCompletion(responseBody, params.onFinalRoundText)
}

/** POST the body; a refusal becomes a sanitized provider failure. */
async function postRequest(
  params: {
    apiUrl: string
    apiKey?: string
    headers: Readonly<Record<string, string>>
  },
  requestBody: string,
  signal: AbortSignal,
): Promise<Response> {
  const response = await fetch(params.apiUrl, {
    method: 'POST',
    headers: {
      ...params.headers,
      'content-type': 'application/json',
      ...(params.apiKey ? { authorization: `Bearer ${params.apiKey}` } : {}),
    },
    body: requestBody,
    signal,
  })
  if (!response.ok) {
    // Read a bounded prefix of the refusal, extract only the recognized kind
    // and code from it, and drop the rest. Cancelling outright was cheaper but
    // left nothing an operator could act on; keeping the body would put
    // provider prose — and whatever a provider chose to echo back — into a
    // durable journal.
    const identity = await readProviderFailureIdentity(response)
    throw adapterError(
      'provider_request_failed',
      response.status === 429 || response.status >= 500,
      response.status,
      identity,
    )
  }
  return response
}

function toOpenAIMessages(message: ProviderToolLoopMessage): object[] {
  if (message.role === 'system' || message.role === 'user') {
    return [{ role: message.role, content: message.content }]
  }
  if (message.role === 'assistant') {
    return [{
      role: 'assistant',
      content: message.content,
      ...(message.toolCalls.length > 0
        ? { tool_calls: message.toolCalls.map(toOpenAIToolCall) }
        : {}),
    }]
  }
  if (message.role === 'tool') {
    const toolMessage = {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.content,
    }
    if (!message.images?.length) return [toolMessage]
    return [
      toolMessage,
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Browser screenshot returned by the preceding tool call.' },
          ...message.images.map((image) => ({
            type: 'image_url',
            image_url: { url: `data:${image.mimeType};base64,${image.data}` },
          })),
        ],
      },
    ]
  }
  throw adapterError('invalid_configuration')
}

function toOpenAIToolCall(call: ProviderToolCall): object {
  return {
    id: call.id,
    ...(call.thoughtSignature ? { extra_content: { google: { thought_signature: call.thoughtSignature } } } : {}),
    type: 'function',
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    },
  }
}

function toOpenAITool(tool: ProviderToolDefinition): object {
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.inputSchema,
    },
  }
}

function parseOpenAIChatCompletion(
  responseBody: string,
  onFinalRoundText?: (text: string) => void,
): ProviderToolAssistantTurn {
  const parsed = parseResponseObject(responseBody)
  // The MCP native tool-loop mode is a separate HTTP client: it never calls the
  // provider adapters in providers/, so their truncation check does not run
  // here. Without this, a turn cut off at its token ceiling is accepted as a
  // finished assistant turn on that path.
  const truncation = detectProviderTruncation(parsed)
  if (truncation !== undefined) {
    throw adapterError('provider_truncated')
  }
  if (!Array.isArray(parsed.choices)) {
    throw adapterError('invalid_provider_response')
  }
  const firstChoice: unknown = parsed.choices[0]
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throw adapterError('invalid_provider_response')
  }
  const message = firstChoice.message
  if (message.role !== 'assistant') {
    throw adapterError('invalid_provider_response')
  }
  const content = parseAssistantContent(message.content)
  const rawCalls = message.tool_calls
  if (rawCalls !== undefined && !Array.isArray(rawCalls)) {
    throw adapterError('invalid_provider_response')
  }
  const toolCalls = (rawCalls ?? []).map(parseOpenAIToolCall)
  if (toolCalls.length === 0 && (content ?? '').trim()) {
    // Observability only: a throwing observer must not fail the turn.
    try {
      onFinalRoundText?.(content ?? '')
    } catch {
      // Intentionally swallowed.
    }
  }
  return {
    content,
    toolCalls,
    ...(typeof parsed.model === 'string' && parsed.model.trim()
      ? { model: parsed.model }
      : {}),
    ...(parsed.usage ? { usage: parseOpenAIUsage(parsed.usage) } : {}),
  }
}

function parseResponseObject(responseBody: string): OpenAIChatCompletionResponse {
  try {
    const parsed = JSON.parse(responseBody) as unknown
    if (isRecord(parsed)) return parsed
  } catch {
    // Mapped to the same sanitized response error below.
  }
  throw adapterError('invalid_provider_response')
}

function parseAssistantContent(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  throw adapterError('invalid_provider_response')
}

function parseOpenAIToolCall(value: unknown): ProviderToolCall {
  if (!isRecord(value) || value.type !== 'function' || !isRecord(value.function)) {
    throw adapterError('invalid_tool_call')
  }
  const id = value.id
  const name = value.function.name
  const encodedArguments = value.function.arguments
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof encodedArguments !== 'string'
  ) {
    throw adapterError('invalid_tool_call')
  }
  const argumentsValue = parseToolArguments(encodedArguments)
  const signature = z.object({ google: z.object({ thought_signature: z.string().min(1).max(1_048_576).optional() }).optional() }).safeParse(value.extra_content ?? {})
  if (!signature.success) throw adapterError('invalid_tool_call')
  const thoughtSignature = signature.data.google?.thought_signature
  return { id, name, arguments: argumentsValue, ...(thoughtSignature ? { thoughtSignature } : {}) }
}

function parseToolArguments(encodedArguments: string): ProviderToolCall['arguments'] {
  try {
    const parsed = JSON.parse(encodedArguments) as unknown
    if (isJsonObject(parsed)) return parsed
  } catch {
    // Mapped to the same sanitized tool-call error below.
  }
  throw adapterError('invalid_tool_call')
}

function parseOpenAIUsage(value: unknown): ProviderToolLoopUsage {
  if (!isRecord(value)) throw adapterError('invalid_provider_response')
  const inputTokens = optionalNonNegativeNumber(value.prompt_tokens)
  const outputTokens = optionalNonNegativeNumber(value.completion_tokens)
  const reportedTotal = value.total_tokens === undefined
    ? inputTokens === null || outputTokens === null
      ? null
      : inputTokens + outputTokens
    : nonNegativeNumber(value.total_tokens)
  if (
    inputTokens === null ||
    outputTokens === null ||
    reportedTotal === null
  ) {
    throw adapterError('invalid_provider_response')
  }
  return { inputTokens, outputTokens, totalTokens: reportedTotal }
}

async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw adapterError('response_too_large')
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let totalBytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw adapterError('response_too_large')
      }
      chunks.push(Buffer.from(chunk.value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

function normalizeProviderUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw adapterError('invalid_configuration')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw adapterError('invalid_configuration')
  }
  return url.toString()
}

function normalizeHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  if (!headers) return {}
  const normalized: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.trim().toLowerCase()
    if (
      !lowerName ||
      typeof value !== 'string' ||
      ['connection', 'content-length', 'host', 'transfer-encoding'].includes(
        lowerName,
      ) ||
      /[\r\n\0]/.test(name) ||
      /[\r\n\0]/.test(value)
    ) {
      throw adapterError('invalid_configuration')
    }
    normalized[lowerName] = value
  }
  return normalized
}

function normalizeRequiredString(value: string): string {
  if (typeof value !== 'string') throw adapterError('invalid_configuration')
  const normalized = value.trim()
  if (!normalized || /[\r\n\0]/.test(normalized)) {
    throw adapterError('invalid_configuration')
  }
  return normalized
}

function normalizeOptionalSecret(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) {
    throw adapterError('invalid_configuration')
  }
  return value.trim() || undefined
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw adapterError('invalid_configuration')
  }
  return resolved
}

function optionalNonNegativeNumber(value: unknown): number | null {
  return value === undefined ? 0 : nonNegativeNumber(value)
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null
}

function isJsonObject(value: unknown): value is ProviderToolCall['arguments'] {
  return isRecord(value) && isJsonCompatible(value)
}

function isJsonCompatible(value: unknown, seen = new WeakSet<object>()): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true
  }
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  const compatible = Array.isArray(value)
    ? value.every((entry) => isJsonCompatible(entry, seen))
    : isRecord(value) && Object.values(value).every((entry) =>
        isJsonCompatible(entry, seen),
      )
  seen.delete(value)
  return compatible
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function adapterError(
  code: ProviderToolLoopError['code'],
  retryable = false,
  statusCode?: number,
  providerIdentity?: ProviderFailureIdentity,
): ProviderToolLoopError {
  return new ProviderToolLoopError(
    code,
    retryable,
    statusCode,
    providerIdentity,
  )
}

/** How much of a refusal body is read before the rest is discarded. */
const MAX_ERROR_BODY_BYTES = 8_192

/**
 * The sanitized half of a provider refusal.
 *
 * Never throws and never returns text: a body that is missing, truncated,
 * unparseable, or simply uninformative degrades to the status-derived
 * identity, because a diagnostic that fails the turn a second time is worse
 * than a thin one.
 */
async function readProviderFailureIdentity(
  response: Response,
): Promise<ProviderFailureIdentity> {
  const body = await readTruncatedBody(response, MAX_ERROR_BODY_BYTES)
  // Everything read off the wire stays `unknown` until the shared provider
  // error guards have narrowed it; only `kind` and `code` are taken from
  // whatever they recognize, and `message` is never read.
  return failureIdentity(parseProviderError(
    isRecord(body) ? { ...body, status: response.status } : { status: response.status },
  ))
}

/**
 * A failure inside the streamed final request, classified the way every
 * other provider failure is.
 *
 * The shared SSE reader raises a `ProviderError` for an error frame sent under
 * HTTP 200 (`streamedProviderError`) and for a stream that comes up short
 * (`incompleteProviderStream`). Its retryability is already decided by
 * `classifyProviderError`, the rule the direct streaming providers follow, so
 * an exhausted quota or a rejected key is final and a rate limit is not. Kept
 * from it: that decision, the recognized kind and a bounded code. The
 * provider's message stays behind, as it does for a refused request.
 */
function streamedProviderFailure(error: ProviderError): ProviderToolLoopError {
  return adapterError(
    'provider_request_failed',
    error.retryable,
    undefined,
    failureIdentity(parseProviderError(error)),
  )
}

function failureIdentity(parsed: ParsedProviderError): ProviderFailureIdentity {
  const providerCode = boundedProviderCode(parsed.code)
  return {
    ...(parsed.kind === 'unknown' ? {} : { providerKind: parsed.kind }),
    ...(providerCode === undefined ? {} : { providerCode }),
  }
}

async function readTruncatedBody(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  if (!response.body) return undefined
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let totalBytes = 0
  try {
    while (totalBytes < maxBytes) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      chunks.push(Buffer.from(chunk.value))
    }
  } catch {
    return undefined
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'),
    )
    return parsed
  } catch {
    return undefined
  }
}
import { whenDefined } from '../../core/optional-properties.js'
