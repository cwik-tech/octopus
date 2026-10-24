/** Provider-agnostic bounded tool-loop protocol and execution. */

import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { agentQuestionInterruptionSchema, MAX_PROVIDER_ROUNDS, MAX_TOOL_CALLS, type AgentQuestionInterruption } from '../../contracts/agent-questions.js'
import type {
  JsonSchemaType,
  JsonSchemaValidator,
} from '@modelcontextprotocol/sdk/validation'

import type {
  McpJsonObject,
  McpJsonSchema,
  McpJsonValue,
} from '../../contracts/mcp.js'
import {
  canonicalizeCapabilityEffect,
  mayRunConcurrently,
  type CapabilityEffect,
} from '../../contracts/capability-effect.js'

const DEFAULT_MAX_ROUNDS = MAX_PROVIDER_ROUNDS
const DEFAULT_MAX_TOOL_CALLS = MAX_TOOL_CALLS
const DEFAULT_TOOL_TIMEOUT_MS = 30_000
const DEFAULT_MAX_TOOL_RESULT_BYTES = 524_288
const DEFAULT_MAX_CONCURRENT_TOOL_CALLS = 4
/**
 * Smallest per-scope capability admission bound in production
 * (`team-runtime/index.ts`, `maxActivePerScope`). Every call in one turn shares
 * a scope key (`core/capability-dispatcher.ts`, `scopeKey`), so a fan-out
 * occupies that many leader slots at once.
 */
const SMALLEST_DISPATCH_ADMISSION_BOUND = 8
/**
 * Strictly below the admission bound (`activeLeaders >= maxActivePerScope`
 * refuses in `core/capability-invocation-bindings.ts`), so a saturated fan-out
 * always leaves one slot and can never be the reason a dispatch on the same
 * scope is refused.
 */
export const MAX_CONCURRENT_TOOL_CALLS_CEILING =
  SMALLEST_DISPATCH_ADMISSION_BOUND - 1
const MAX_TOOL_DEFINITIONS = 256
const MAX_TOOL_DESCRIPTION_LENGTH = 16_384
const MAX_TOOL_SCHEMA_BYTES = 262_144
const MAX_TOOL_NAME_LENGTH = 256
const MAX_TOOL_CALL_ID_LENGTH = 256

export const PROVIDER_TOOL_LOOP_ERROR_CODES = [
  'invalid_configuration',
  'provider_request_failed',
  'invalid_provider_response',
  'invalid_tool_call',
  'tool_not_found',
  'tool_execution_failed',
  'limit_exceeded',
  'request_too_large',
  'response_too_large',
  'tool_result_too_large',
  'timeout',
  'cancelled',
  'provider_truncated',
] as const

export type ProviderToolLoopErrorCode =
  (typeof PROVIDER_TOOL_LOOP_ERROR_CODES)[number]

/**
 * What a refused provider request says about itself, kept for diagnostics.
 *
 * Both fields come from vocabularies rather than prose: `providerKind` is the
 * runtime's normalized taxonomy, and `providerCode` is the short symbolic code
 * a provider returns beside its message. The message itself, the response
 * body, and every header are deliberately absent — an agent-turn journal
 * records identity, not provider text (journal ADR).
 */
export interface ProviderFailureIdentity {
  readonly providerKind?: string
  readonly providerCode?: string
}

export class ProviderToolLoopError extends Error {
  constructor(
    readonly code: ProviderToolLoopErrorCode,
    readonly retryable: boolean,
    readonly statusCode?: number,
    /** Present only where the provider stated something recognizable. */
    readonly providerIdentity?: ProviderFailureIdentity,
  ) {
    super(PROVIDER_TOOL_LOOP_ERROR_MESSAGES[code])
    this.name = 'ProviderToolLoopError'
  }
}

export interface ProviderToolDefinition {
  readonly name: string
  readonly description?: string
  readonly inputSchema: McpJsonSchema
  readonly effect: CapabilityEffect
}

export interface ProviderToolCall {
  /** Gemini requires this opaque value on the following tool round. */
  readonly thoughtSignature?: string
  readonly id: string
  readonly name: string
  readonly arguments: McpJsonObject
}

export interface ProviderToolExecutionResult {
  readonly interruption?: AgentQuestionInterruption
  readonly content: string
  readonly isError?: boolean
  readonly images?: readonly ProviderToolImage[]
}

export interface ProviderToolImage {
  readonly data: string
  readonly mimeType: string
}

export type ProviderToolExecutor = (
  call: ProviderToolCall,
  context: ProviderToolExecutionContext,
) => Promise<ProviderToolExecutionResult>

/**
 * Per-call execution context. `ordinal` is the call's position in the
 * provider's own tool-call order for this turn, counted across every round.
 * Parallel-eligible calls overlap in time, so anything that must reconstruct
 * the model's intended order — persisted activity, traces — has to carry this
 * rather than infer order from when execution happened to start.
 */
export interface ProviderToolExecutionContext {
  readonly signal: AbortSignal
  readonly ordinal: number
}

export interface ProviderToolLoopPromptMessage {
  readonly role: 'system' | 'user'
  readonly content: string
}

export interface ProviderToolLoopAssistantMessage {
  readonly role: 'assistant'
  readonly content: string | null
  readonly toolCalls: readonly ProviderToolCall[]
}

export interface ProviderToolLoopToolMessage {
  readonly role: 'tool'
  readonly toolCallId: string
  readonly name: string
  readonly content: string
  readonly isError: boolean
  readonly images?: readonly ProviderToolImage[]
}

export type ProviderToolLoopMessage =
  | ProviderToolLoopPromptMessage
  | ProviderToolLoopAssistantMessage
  | ProviderToolLoopToolMessage

export interface ProviderToolLoopUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
}

export interface ProviderToolAssistantTurn {
  readonly content: string | null
  readonly toolCalls: readonly ProviderToolCall[]
  readonly model?: string
  readonly usage?: ProviderToolLoopUsage
}

export interface ProviderToolLoopAdapterRequest {
  readonly messages: readonly ProviderToolLoopMessage[]
  readonly tools: readonly ProviderToolDefinition[]
  readonly signal: AbortSignal
}

export interface ProviderToolLoopAdapter {
  complete(request: ProviderToolLoopAdapterRequest): Promise<ProviderToolAssistantTurn>
  /**
   * The answer, asked for in a request that cannot call tools.
   *
   * Offered by an adapter that shows the answer while it arrives. A
   * tool-capable round cannot be shown as it streams: its text may turn out to
   * be planning once tool calls follow it (D9). So when a round decides to
   * answer, its own text is dropped, and the answer comes from this request,
   * sent with the same messages that round was sent.
   *
   * It is a provider round like any other, so it reserves the last slot of
   * `maxRounds`: tool-capable rounds get at most `maxRounds - 1` requests, and
   * the turn never sends more than `maxRounds`.
   */
  completeFinal?(request: ProviderToolLoopAdapterRequest): Promise<ProviderToolAssistantTurn>
}

export interface ProviderToolLoopOptions {
  /** Host policy may stop a prohibited tool call without advertising it. */
  readonly interceptToolCall?: (call: ProviderToolCall) => AgentQuestionInterruption | undefined
  readonly messages: readonly ProviderToolLoopPromptMessage[]
  readonly tools: readonly ProviderToolDefinition[]
  readonly adapter: ProviderToolLoopAdapter
  readonly executeTool: ProviderToolExecutor
  readonly signal?: AbortSignal
  readonly maxRounds?: number
  readonly maxToolCalls?: number
  readonly maxConcurrentToolCalls?: number
  readonly toolTimeoutMs?: number
  readonly maxToolResultBytes?: number
}

export interface ProviderToolLoopResult {
  readonly interruption?: AgentQuestionInterruption
  readonly text: string
  readonly model?: string
  readonly messages: readonly ProviderToolLoopMessage[]
  readonly rounds: number
  readonly toolCallCount: number
  readonly executedToolCallCount: number
  readonly cachedToolCallCount: number
  readonly usage: ProviderToolLoopUsage
}

interface CompiledTool {
  readonly definition: ProviderToolDefinition
  readonly validate: JsonSchemaValidator<McpJsonObject>
}

interface CachedToolResult {
  readonly fingerprint: string
  readonly result: ProviderToolExecutionResult
}

interface ResolvedToolLoopLimits {
  readonly maxRounds: number
  readonly maxToolCalls: number
  readonly maxConcurrentToolCalls: number
  readonly toolTimeoutMs: number
  readonly maxToolResultBytes: number
}

interface ResolvedToolCall {
  readonly call: ProviderToolCall
  readonly tool: CompiledTool
  readonly ordinal: number
}

type ToolCallSegment =
  | { readonly eligible: true; readonly entries: readonly ResolvedToolCall[] }
  | { readonly eligible: false; readonly entry: ResolvedToolCall }

interface SegmentFailure {
  readonly index: number
  readonly error: unknown
}

interface ToolLoopState {
  interruption?: AgentQuestionInterruption
  readonly messages: ProviderToolLoopMessage[]
  readonly cache: Map<string, CachedToolResult>
  readonly usage: { inputTokens: number; outputTokens: number; totalTokens: number }
  model?: string
  toolCallCount: number
  executedToolCallCount: number
  cachedToolCallCount: number
  nextToolCallOrdinal: number
}

interface ToolLoopRuntime {
  readonly options: ProviderToolLoopOptions
  readonly limits: ResolvedToolLoopLimits
  readonly compiledTools: readonly CompiledTool[]
  readonly toolByName: ReadonlyMap<string, CompiledTool>
  readonly signal: AbortSignal
  readonly state: ToolLoopState
}

interface TimeoutGuard {
  readonly signal: AbortSignal
  readonly rejection: Promise<never>
  dispose(): void
}

interface CancellationGuard {
  readonly rejection: Promise<never>
  dispose(): void
}

const PROVIDER_TOOL_LOOP_ERROR_MESSAGES: Record<
  ProviderToolLoopErrorCode,
  string
> = {
  invalid_configuration: 'Provider tool-loop configuration is invalid.',
  provider_request_failed: 'Provider request failed.',
  invalid_provider_response: 'Provider response is invalid.',
  invalid_tool_call: 'Provider tool call is invalid.',
  tool_not_found: 'Provider requested an unavailable tool.',
  tool_execution_failed: 'Tool execution failed.',
  limit_exceeded: 'Provider tool-loop limit was exceeded.',
  request_too_large: 'Provider request body is too large.',
  response_too_large: 'Provider response body is too large.',
  tool_result_too_large: 'Tool result is too large.',
  timeout: 'Provider tool-loop operation timed out.',
  cancelled: 'Provider tool-loop operation was cancelled.',
  provider_truncated: 'Provider response was truncated at its token limit.',
}

export async function runProviderToolLoop(
  options: ProviderToolLoopOptions,
): Promise<ProviderToolLoopResult> {
  const runtime = createToolLoopRuntime(options)
  const completeFinal = options.adapter.completeFinal?.bind(options.adapter)
  // Reserved finalization: with a final request, its slot is the last one.
  const toolRounds = runtime.limits.maxRounds - (completeFinal ? 1 : 0)
  for (let round = 1; round <= toolRounds; round += 1) {
    const turn = await requestNextTurn(runtime)
    recordTurnMetadata(runtime.state, turn)
    if (turn.toolCalls.length === 0) {
      return completeFinal
        ? finalizeToolLoop(runtime, completeFinal, round + 1)
        : completeToolLoop(runtime.state, turn, round)
    }
    const intercepted = turn.toolCalls.map((call) => options.interceptToolCall?.(call)).find((outcome) => outcome !== undefined)
    if (intercepted) {
      runtime.state.toolCallCount += turn.toolCalls.length
      return { ...toolLoopSnapshot(runtime.state, round), text: '', interruption: intercepted }
    }
    await applyToolTurn(runtime, turn)
    if (runtime.state.interruption) {
      return {
        ...toolLoopSnapshot(runtime.state, round),
        text: '', interruption: runtime.state.interruption,
      }
    }
  }
  if (completeFinal) {
    return finalizeToolLoop(runtime, completeFinal, runtime.limits.maxRounds)
  }
  throw toolLoopError('limit_exceeded')
}

/**
 * Send the tool-free final request and complete the turn with its answer.
 *
 * Tool calls in its reply fail the turn. The request forbade them, and its
 * text may already be on screen, so running them now would show an answer and
 * then act after it.
 */
async function finalizeToolLoop(
  runtime: ToolLoopRuntime,
  completeFinal: (request: ProviderToolLoopAdapterRequest) => Promise<ProviderToolAssistantTurn>,
  round: number,
): Promise<ProviderToolLoopResult> {
  throwIfCancelled(runtime.signal)
  const turn = normalizeAssistantTurn(
    await requestAssistantTurn(
      completeFinal,
      runtime.state.messages,
      runtime.compiledTools,
      runtime.signal,
    ),
  )
  recordTurnMetadata(runtime.state, turn)
  if (turn.toolCalls.length > 0) throw toolLoopError('invalid_provider_response')
  return completeToolLoop(runtime.state, turn, round)
}

function createToolLoopRuntime(options: ProviderToolLoopOptions): ToolLoopRuntime {
  if (
    !options ||
    typeof options !== 'object' ||
    !options.adapter ||
    typeof options.adapter.complete !== 'function' ||
    typeof options.executeTool !== 'function'
  ) {
    throw toolLoopError('invalid_configuration')
  }
  const compiledTools = compileTools(options.tools)
  return {
    options,
    limits: resolveToolLoopLimits(options),
    compiledTools,
    toolByName: new Map(
      compiledTools.map((tool) => [tool.definition.name, tool]),
    ),
    signal: options.signal ?? new AbortController().signal,
    state: {
      messages: normalizePromptMessages(options.messages),
      cache: new Map(),
      usage: mutableEmptyUsage(),
      toolCallCount: 0,
      executedToolCallCount: 0,
      cachedToolCallCount: 0,
      nextToolCallOrdinal: 0,
    },
  }
}

async function requestNextTurn(
  runtime: ToolLoopRuntime,
): Promise<ProviderToolAssistantTurn> {
  throwIfCancelled(runtime.signal)
  const { adapter } = runtime.options
  return normalizeAssistantTurn(
    await requestAssistantTurn(
      (request) => adapter.complete(request),
      runtime.state.messages,
      runtime.compiledTools,
      runtime.signal,
    ),
  )
}

function recordTurnMetadata(
  state: ToolLoopState,
  turn: ProviderToolAssistantTurn,
): void {
  addUsage(state.usage, turn.usage)
  if (turn.model) state.model = turn.model
}

function completeToolLoop(
  state: ToolLoopState,
  turn: ProviderToolAssistantTurn,
  round: number,
): ProviderToolLoopResult {
  if (!turn.content?.trim()) throw toolLoopError('invalid_provider_response')
  state.messages.push({ role: 'assistant', content: turn.content, toolCalls: [] })
  return {
    text: turn.content,
    ...toolLoopSnapshot(state, round),
  }
}

function toolLoopSnapshot(state: ToolLoopState, round: number): Omit<ProviderToolLoopResult, 'text'> {
  return {
    ...(state.model ? { model: state.model } : {}),
    messages: [...state.messages],
    rounds: round,
    toolCallCount: state.toolCallCount,
    executedToolCallCount: state.executedToolCallCount,
    cachedToolCallCount: state.cachedToolCallCount,
    usage: { ...state.usage },
  }
}

async function applyToolTurn(
  runtime: ToolLoopRuntime,
  turn: ProviderToolAssistantTurn,
): Promise<void> {
  assertUniqueTurnCallIds(turn.toolCalls)
  const nextCallCount = runtime.state.toolCallCount + turn.toolCalls.length
  if (nextCallCount > runtime.limits.maxToolCalls) {
    throw toolLoopError('limit_exceeded')
  }
  runtime.state.toolCallCount = nextCallCount
  runtime.state.messages.push({
    role: 'assistant',
    content: turn.content,
    toolCalls: turn.toolCalls,
  })
  const resolvedCalls = turn.toolCalls.map((call) =>
    resolveToolCallEntry(runtime, call),
  )

  for (const segment of planToolCallSegments(resolvedCalls)) {
    if (runtime.state.interruption) return
    if (segment.eligible) {
      runtime.state.messages.push(
        ...(await runEligibleToolSegment(runtime, segment.entries)),
      )
    } else {
      runtime.state.messages.push(
        await resolveToolMessage(runtime, segment.entry, runtime.signal),
      )
    }
  }
}

function resolveToolCallEntry(
  runtime: ToolLoopRuntime,
  call: ProviderToolCall,
): ResolvedToolCall {
  const tool = requireCompiledTool(runtime.toolByName, call)
  validateToolCallArguments(tool, call.arguments)
  const ordinal = runtime.state.nextToolCallOrdinal
  runtime.state.nextToolCallOrdinal += 1
  return { call, tool, ordinal }
}

function planToolCallSegments(
  entries: readonly ResolvedToolCall[],
): ToolCallSegment[] {
  const segments: ToolCallSegment[] = []
  let run: ResolvedToolCall[] = []
  const flushRun = (): void => {
    if (run.length > 0) segments.push({ eligible: true, entries: run })
    run = []
  }
  for (const entry of entries) {
    if (mayRunConcurrently(entry.tool.definition.effect)) {
      run.push(entry)
    } else {
      flushRun()
      segments.push({ eligible: false, entry })
    }
  }
  flushRun()
  return segments
}

async function runEligibleToolSegment(
  runtime: ToolLoopRuntime,
  entries: readonly ResolvedToolCall[],
): Promise<ProviderToolLoopToolMessage[]> {
  const messages: ProviderToolLoopToolMessage[] = []
  const failures: SegmentFailure[] = []
  const siblingAbortedIndexes = new Set<number>()
  const activeControllers = new Map<number, AbortController>()
  let firstFailure: SegmentFailure | undefined
  let nextIndex = 0

  const executeEntry = async (
    entry: ResolvedToolCall,
    index: number,
  ): Promise<void> => {
    const controller = new AbortController()
    activeControllers.set(index, controller)
    try {
      messages[index] = await resolveToolMessage(
        runtime,
        entry,
        AbortSignal.any([runtime.signal, controller.signal]),
      )
    } catch (error) {
      const failure: SegmentFailure = { index, error }
      if (firstFailure === undefined) {
        firstFailure = failure
        for (const [activeIndex, activeController] of activeControllers) {
          if (activeIndex !== index) {
            siblingAbortedIndexes.add(activeIndex)
            activeController.abort()
          }
        }
      }
      failures.push(failure)
    } finally {
      activeControllers.delete(index)
    }
  }

  const worker = async (): Promise<void> => {
    while (firstFailure === undefined && nextIndex < entries.length) {
      const index = nextIndex
      const entry = entries[index]
      nextIndex += 1
      if (entry) await executeEntry(entry, index)
    }
  }

  const workerCount = Math.min(
    runtime.limits.maxConcurrentToolCalls,
    entries.length,
  )
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  if (firstFailure !== undefined) {
    throw electSegmentFailure(firstFailure, failures, siblingAbortedIndexes)
  }
  return messages
}

/**
 * Lowest-call-index failure, ignoring siblings that only reported `cancelled`
 * because the first failure aborted them. The first failure is never one of
 * those siblings, so it is always an eligible candidate and the election is
 * total without a fabricated fallback.
 */
function electSegmentFailure(
  firstFailure: SegmentFailure,
  failures: readonly SegmentFailure[],
  siblingAbortedIndexes: ReadonlySet<number>,
): unknown {
  let elected = firstFailure
  for (const failure of failures) {
    if (failure.index >= elected.index) continue
    if (isSiblingAbortCancellation(failure, siblingAbortedIndexes)) continue
    elected = failure
  }
  return elected.error
}

function isSiblingAbortCancellation(
  failure: SegmentFailure,
  siblingAbortedIndexes: ReadonlySet<number>,
): boolean {
  return (
    siblingAbortedIndexes.has(failure.index) &&
    failure.error instanceof ProviderToolLoopError &&
    failure.error.code === 'cancelled'
  )
}

async function resolveToolMessage(
  runtime: ToolLoopRuntime,
  entry: ResolvedToolCall,
  callSignal: AbortSignal,
): Promise<ProviderToolLoopToolMessage> {
  const result = await resolveToolExecution(
    runtime,
    entry.call,
    callSignal,
    entry.ordinal,
  )
  if (result.interruption) runtime.state.interruption = result.interruption
  return {
    role: 'tool',
    toolCallId: entry.call.id,
    name: entry.call.name,
    content: result.content,
    isError: result.isError === true,
    ...(result.images?.length ? { images: result.images } : {}),
  }
}

async function resolveToolExecution(
  runtime: ToolLoopRuntime,
  call: ProviderToolCall,
  callSignal: AbortSignal,
  ordinal: number,
): Promise<ProviderToolExecutionResult> {
  const fingerprint = toolCallFingerprint(call)
  const cached = runtime.state.cache.get(call.id)
  if (cached) {
    if (cached.fingerprint !== fingerprint) {
      throw toolLoopError('invalid_tool_call')
    }
    runtime.state.cachedToolCallCount += 1
    return cached.result
  }
  const result = await executeToolCall({
    call,
    executeTool: runtime.options.executeTool,
    signal: callSignal,
    timeoutMs: runtime.limits.toolTimeoutMs,
    maxResultBytes: runtime.limits.maxToolResultBytes,
    ordinal,
  })
  runtime.state.cache.set(call.id, { fingerprint, result })
  runtime.state.executedToolCallCount += 1
  return result
}

function resolveToolLoopLimits(
  options: ProviderToolLoopOptions,
): ResolvedToolLoopLimits {
  return {
    maxRounds: positiveInteger(options.maxRounds, DEFAULT_MAX_ROUNDS),
    maxToolCalls: nonNegativeInteger(
      options.maxToolCalls,
      DEFAULT_MAX_TOOL_CALLS,
    ),
    maxConcurrentToolCalls: boundedPositiveInteger(
      options.maxConcurrentToolCalls,
      DEFAULT_MAX_CONCURRENT_TOOL_CALLS,
      MAX_CONCURRENT_TOOL_CALLS_CEILING,
    ),
    toolTimeoutMs: positiveInteger(
      options.toolTimeoutMs,
      DEFAULT_TOOL_TIMEOUT_MS,
    ),
    maxToolResultBytes: positiveInteger(
      options.maxToolResultBytes,
      DEFAULT_MAX_TOOL_RESULT_BYTES,
    ),
  }
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  ceiling: number,
): number {
  const resolved = value ?? fallback
  if (
    !Number.isSafeInteger(resolved) ||
    resolved <= 0 ||
    resolved > ceiling
  ) {
    throw toolLoopError('invalid_configuration')
  }
  return resolved
}

function compileTools(
  tools: readonly ProviderToolDefinition[],
): CompiledTool[] {
  if (!Array.isArray(tools)) throw toolLoopError('invalid_configuration')
  if (tools.length > MAX_TOOL_DEFINITIONS) {
    throw toolLoopError('invalid_configuration')
  }
  const names = new Set<string>()
  return tools.map((tool: ProviderToolDefinition) => {
    const definition = normalizeToolDefinition(tool)
    if (names.has(definition.name)) throw toolLoopError('invalid_configuration')
    names.add(definition.name)
    try {
      return {
        definition,
        validate: new AjvJsonSchemaValidator().getValidator<McpJsonObject>(
          definition.inputSchema as JsonSchemaType,
        ),
      }
    } catch {
      throw toolLoopError('invalid_configuration')
    }
  })
}

function normalizeToolDefinition(
  tool: ProviderToolDefinition,
): ProviderToolDefinition {
  if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string') {
    throw toolLoopError('invalid_configuration')
  }
  const inputSchema = cloneJsonRecord(tool.inputSchema)
  if (inputSchema.type === undefined) inputSchema.type = 'object'
  if (inputSchema.type !== 'object') {
    throw toolLoopError('invalid_configuration')
  }
  const name = normalizeToolName(tool.name)
  const description = normalizeToolDescription(tool.description)
  const effect = canonicalizeCapabilityEffect(tool.effect)
  return {
    name,
    ...(description ? { description } : {}),
    inputSchema,
    effect,
  }
}

function normalizeToolName(value: string): string {
  const name = value.trim()
  if (
    !name ||
    name.length > MAX_TOOL_NAME_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(name)
  ) {
    throw toolLoopError('invalid_configuration')
  }
  return name
}

function normalizeToolDescription(value: string | undefined): string | undefined {
  if (value !== undefined && typeof value !== 'string') {
    throw toolLoopError('invalid_configuration')
  }
  const description = value?.trim()
  if (description && description.length > MAX_TOOL_DESCRIPTION_LENGTH) {
    throw toolLoopError('invalid_configuration')
  }
  return description || undefined
}

function normalizePromptMessages(
  messages: readonly ProviderToolLoopPromptMessage[],
): ProviderToolLoopMessage[] {
  if (!Array.isArray(messages)) throw toolLoopError('invalid_configuration')
  return messages.map((message: ProviderToolLoopPromptMessage) => {
    if (
      !message ||
      typeof message !== 'object' ||
      (message.role !== 'system' && message.role !== 'user') ||
      typeof message.content !== 'string'
    ) {
      throw toolLoopError('invalid_configuration')
    }
    return { role: message.role, content: message.content }
  })
}

async function requestAssistantTurn(
  send: (request: ProviderToolLoopAdapterRequest) => Promise<ProviderToolAssistantTurn>,
  messages: readonly ProviderToolLoopMessage[],
  tools: readonly CompiledTool[],
  signal: AbortSignal,
): Promise<ProviderToolAssistantTurn> {
  try {
    return await send({
      messages: [...messages],
      tools: tools.map((tool) => tool.definition),
      signal,
    })
  } catch (error) {
    if (error instanceof ProviderToolLoopError) throw error
    if (signal.aborted) throw toolLoopError('cancelled')
    throw toolLoopError('provider_request_failed', true)
  }
}

function normalizeAssistantTurn(
  turn: ProviderToolAssistantTurn,
): ProviderToolAssistantTurn {
  if (!turn || typeof turn !== 'object' || !Array.isArray(turn.toolCalls)) {
    throw toolLoopError('invalid_provider_response')
  }
  if (turn.content !== null && typeof turn.content !== 'string') {
    throw toolLoopError('invalid_provider_response')
  }
  return {
    content: turn.content,
    toolCalls: turn.toolCalls.map(normalizeToolCall),
    ...(typeof turn.model === 'string' && turn.model.trim()
      ? { model: turn.model }
      : {}),
    ...(turn.usage ? { usage: normalizeUsage(turn.usage) } : {}),
  }
}

function normalizeToolCall(call: ProviderToolCall): ProviderToolCall {
  if (!call || typeof call !== 'object') throw toolLoopError('invalid_tool_call')
  const id = call.id
  const name = call.name
  if (
    typeof id !== 'string' ||
    !id ||
    id.length > MAX_TOOL_CALL_ID_LENGTH ||
    /[\s\0]/.test(id)
  ) {
    throw toolLoopError('invalid_tool_call')
  }
  if (typeof name !== 'string' || !name || name.length > MAX_TOOL_NAME_LENGTH) {
    throw toolLoopError('invalid_tool_call')
  }
  if (!isJsonObject(call.arguments)) throw toolLoopError('invalid_tool_call')
  if (call.thoughtSignature !== undefined && (typeof call.thoughtSignature !== 'string' || call.thoughtSignature.length === 0 || call.thoughtSignature.length > 1_048_576)) throw toolLoopError('invalid_tool_call')
  return { id, name, arguments: call.arguments,
    ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
  }
}

function assertUniqueTurnCallIds(calls: readonly ProviderToolCall[]): void {
  const ids = new Set<string>()
  for (const call of calls) {
    if (ids.has(call.id)) throw toolLoopError('invalid_tool_call')
    ids.add(call.id)
  }
}

function requireCompiledTool(
  tools: ReadonlyMap<string, CompiledTool>,
  call: ProviderToolCall,
): CompiledTool {
  const tool = tools.get(call.name)
  if (!tool) throw toolLoopError('tool_not_found')
  return tool
}

function validateToolCallArguments(
  tool: CompiledTool,
  argumentsValue: McpJsonObject,
): void {
  const validation = tool.validate(argumentsValue)
  if (!validation.valid) throw toolLoopError('invalid_tool_call')
}

async function executeToolCall(params: {
  call: ProviderToolCall
  executeTool: ProviderToolExecutor
  signal: AbortSignal
  timeoutMs: number
  maxResultBytes: number
  ordinal: number
}): Promise<ProviderToolExecutionResult> {
  const result = await invokeToolExecutor(params)
  return normalizeToolExecutionResult(result, params.maxResultBytes)
}

async function invokeToolExecutor(params: {
  call: ProviderToolCall
  executeTool: ProviderToolExecutor
  signal: AbortSignal
  timeoutMs: number
  ordinal: number
}): Promise<ProviderToolExecutionResult> {
  try {
    return await runProviderToolOperationWithDeadline(
      params.signal,
      params.timeoutMs,
      (signal) => params.executeTool(params.call, {
        signal,
        ordinal: params.ordinal,
      }),
    )
  } catch (error) {
    if (
      error instanceof ProviderToolLoopError &&
      (error.code === 'cancelled' || error.code === 'timeout')
    ) {
      throw error
    }
    throw toolLoopError('tool_execution_failed')
  }
}

function normalizeToolExecutionResult(
  result: ProviderToolExecutionResult,
  maxResultBytes: number,
): ProviderToolExecutionResult {
  if (!result || typeof result.content !== 'string') {
    throw toolLoopError('tool_execution_failed')
  }
  if (Buffer.byteLength(result.content, 'utf8') > maxResultBytes) {
    throw toolLoopError('tool_result_too_large')
  }
  const images = normalizeToolImages(result.images, maxResultBytes)
  return {
    content: result.content,
    ...(result.interruption ? { interruption: agentQuestionInterruptionSchema.parse(result.interruption) } : {}),
    ...(result.isError === true ? { isError: true } : {}),
    ...(images.length ? { images } : {}),
  }
}

function normalizeToolImages(
  images: readonly ProviderToolImage[] | undefined,
  maxResultBytes: number,
): ProviderToolImage[] {
  if (images === undefined) return []
  if (!Array.isArray(images) || images.length > 4) throw toolLoopError('tool_execution_failed')
  let totalBytes = 0
  return images.map((image: ProviderToolImage) => {
    if (
      !image ||
      typeof image.data !== 'string' ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) ||
      typeof image.mimeType !== 'string' ||
      !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType)
    ) {
      throw toolLoopError('tool_execution_failed')
    }
    totalBytes += Buffer.byteLength(image.data, 'base64')
    if (totalBytes > maxResultBytes) throw toolLoopError('tool_result_too_large')
    return { data: image.data, mimeType: image.mimeType }
  })
}

function toolCallFingerprint(call: ProviderToolCall): string {
  return `${call.name}\n${stableJson(call.arguments)}`
}

export async function runProviderToolOperationWithDeadline<T>(
  parentSignal: AbortSignal,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  throwIfCancelled(parentSignal)
  const timeout = createTimeoutGuard(timeoutMs)
  const cancellation = createCancellationGuard(parentSignal)
  const signal = AbortSignal.any([parentSignal, timeout.signal])
  try {
    return await Promise.race([
      operation(signal),
      timeout.rejection,
      cancellation.rejection,
    ])
  } finally {
    timeout.dispose()
    cancellation.dispose()
  }
}

function createTimeoutGuard(timeoutMs: number): TimeoutGuard {
  const controller = new AbortController()
  let timeout: NodeJS.Timeout | undefined
  const rejection = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(toolLoopError('timeout', true))
      controller.abort()
    }, timeoutMs)
  })
  return {
    signal: controller.signal,
    rejection,
    dispose: () => { if (timeout) clearTimeout(timeout) },
  }
}

function createCancellationGuard(signal: AbortSignal): CancellationGuard {
  let removeListener: () => void = () => undefined
  const rejection = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(toolLoopError('cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    removeListener = () => signal.removeEventListener('abort', onAbort)
    if (signal.aborted) onAbort()
  })
  return { rejection, dispose: () => removeListener() }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw toolLoopError('invalid_configuration')
  }
  return resolved
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw toolLoopError('invalid_configuration')
  }
  return resolved
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null
}

function normalizeUsage(usage: ProviderToolLoopUsage): ProviderToolLoopUsage {
  const inputTokens = nonNegativeNumber(usage.inputTokens)
  const outputTokens = nonNegativeNumber(usage.outputTokens)
  const totalTokens = nonNegativeNumber(usage.totalTokens)
  if (
    inputTokens === null ||
    outputTokens === null ||
    totalTokens === null
  ) {
    throw toolLoopError('invalid_provider_response')
  }
  return { inputTokens, outputTokens, totalTokens }
}

function mutableEmptyUsage(): {
  inputTokens: number
  outputTokens: number
  totalTokens: number
} {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
}

function addUsage(
  aggregate: { inputTokens: number; outputTokens: number; totalTokens: number },
  usage: ProviderToolLoopUsage | undefined,
): void {
  if (!usage) return
  aggregate.inputTokens += usage.inputTokens
  aggregate.outputTokens += usage.outputTokens
  aggregate.totalTokens += usage.totalTokens
}

function cloneJsonRecord(value: unknown): Record<string, unknown> {
  if (!isJsonCompatible(value) || !isRecord(value)) {
    throw toolLoopError('invalid_configuration')
  }
  const encoded = JSON.stringify(value)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_TOOL_SCHEMA_BYTES) {
    throw toolLoopError('invalid_configuration')
  }
  const cloned = JSON.parse(encoded) as unknown
  if (!isRecord(cloned)) throw toolLoopError('invalid_configuration')
  return cloned
}

function isJsonObject(value: unknown): value is McpJsonObject {
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
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  let compatible: boolean
  if (Array.isArray(value)) {
    compatible = value.every((entry) => isJsonCompatible(entry, seen))
  } else if (!isRecord(value)) {
    compatible = false
  } else {
    compatible = Object.values(value).every((entry) =>
      isJsonCompatible(entry, seen),
    )
  }
  seen.delete(value)
  return compatible
}

function stableJson(value: McpJsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw toolLoopError('invalid_tool_call')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`
  }
  const objectValue = value as Readonly<Record<string, McpJsonValue>>
  // Same order as the default `sort()` on the keys: UTF-16 code units.
  return `{${Object.entries(objectValue)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(',')}}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw toolLoopError('cancelled')
}

function toolLoopError(
  code: ProviderToolLoopErrorCode,
  retryable = false,
  statusCode?: number,
): ProviderToolLoopError {
  return new ProviderToolLoopError(code, retryable, statusCode)
}
