import { whenDefined } from '../../core/optional-properties.js'
import { Agent, fetch } from 'undici'
import { z } from 'zod'

import type { AgentRunOptions } from '../../core/types.js'
import {
  MCP_WORKER_TURN_CONTRACT_VERSION,
  MCP_WORKER_ACTIVITY_SCOPE_ID_ENV,
  MCP_WORKER_AGENT_DISPLAY_NAME_ENV,
  MCP_WORKER_TURN_URL_ENV,
  MCP_WORKER_WORKFLOW_STEP_ID_ENV,
  parseMcpWorkerTurnRequest,
  parseMcpWorkerTurnResponse,
  type McpWorkerTurnResponse,
} from './mcp-worker-turn.js'
import {
  RUNTIME_ASSIGNMENT_ID_ENV,
  RUNTIME_RUN_ID_ENV,
  RUNTIME_SESSION_ID_ENV,
} from '../runtime/runtime-paths.js'
import { ProviderError } from '../provider/provider-error.js'
import { PROVIDER_TRUNCATED_CODE } from '../provider/provider-truncation.js'
import { PROVIDER_STALLED_CODE } from '../../providers/codex.js'
import { BEHAVIOURAL_PROVIDER_OPTION_NAMES } from '../../providers/provider-option-support.js'
import {
  PROVIDER_ERROR_KINDS,
  PROVIDER_FAILURE_USER_MESSAGES,
} from '../../contracts/provider.js'
import {
  WORKER_TURN_TRANSPORT_CODES,
  type WorkerTurnFailure,
  type WorkerTurnTransportCode,
} from '../../contracts/worker-turn-failure.js'
import { MCP_SANITIZED_ERROR_CODES } from './mcp-runtime.js'

const MAX_WORKER_RESPONSE_BYTES = 4 * 1_024 * 1_024
const DEFAULT_WORKER_TURN_TIMEOUT_MS = 30 * 60_000
const WORKER_TURN_TIMEOUT_GRACE_MS = 30_000
const workerFailureCodeSchema = z.enum([
  'unauthorized',
  'inactive_task',
  'resolution_invalid',
  'execution_failed',
  'cancelled',
])
const workerProviderFailureCodeSchema = z.enum([
  ...MCP_SANITIZED_ERROR_CODES,
  'provider_failed',
  'provider_usage_limit',
  PROVIDER_STALLED_CODE,
  PROVIDER_TRUNCATED_CODE,
])
const workerProviderKindSchema = z.enum(PROVIDER_ERROR_KINDS)
/**
 * When an exhausted quota resets, as the parent rendered it.
 *
 * The one free-standing value this boundary accepts, so it is held to the
 * exact shape the parent produces: a date and a clock time, and nothing a
 * provider could have written into it.
 */
const workerUsageLimitResetSchema = z
  .string()
  .regex(/^[A-Z][a-z]{2} [0-9]{1,2}(?:, [0-9]{4})? at [0-9]{1,2}:[0-9]{2} (?:AM|PM)$/)

/**
 * The same reset as an instant, which is what a clock can be compared against.
 *
 * Validated by round-tripping rather than by shape: what crosses must already
 * be exactly an instant, because the receiving process cannot re-interpret a
 * near-miss without the zone and the clock that produced it.
 */
const workerUsageLimitResetInstantSchema = z
  .string()
  .refine((value) => {
    const parsed = new Date(value)
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
  })

export class McpWorkerTurnClientError extends Error {
  constructor(
    cause?: unknown,
    /** The worker service's failure category, when the endpoint reported one. */
    readonly code?: z.infer<typeof workerFailureCodeSchema>,
    /** The agent-tool code behind an `execution_failed` turn. */
    readonly providerCode?: z.infer<typeof workerProviderFailureCodeSchema>,
    /** The worker service's retry verdict, when the endpoint reported one. */
    readonly retryable?: boolean,
    /** Why the provider refused, when the endpoint could say. */
    readonly providerKind?: z.infer<typeof workerProviderKindSchema>,
    /** When a usage-limited provider's quota resets, when the parent knew. */
    readonly resetsAt?: string,
    /**
     * The same reset as an instant, for anything that compares it to a clock.
     *
     * Beside the sentence rather than instead of it: the sentence is what a
     * person reads in the transcript, and it states neither a year nor a zone,
     * so it cannot be turned back into a moment on this side of the boundary.
     */
    readonly resetsAtInstant?: string,
    /**
     * Whether the parent's adapter had sent anything when it refused.
     *
     * `false` is a positive claim and the only value this boundary accepts;
     * everything else is unknown. A tool-enabled `codex`, `claude` or
     * `kimi-cli` agent runs its turn in the parent, so without this field a
     * refusal the parent's adapter proved was never sent reaches the child as
     * unknown — and unknown refuses the model-choice offer that refusal had
     * earned.
     */
    readonly dispatched?: boolean,
    /**
     * Where the turn failed, when the parent reported no category of its own.
     *
     * A closed stage with only a Node error code or a status beside it, so a
     * failure record can keep it without keeping anything the network or the
     * parent wrote. The sentence a person reads does not change.
     */
    readonly failureDetail?: WorkerTurnFailure,
  ) {
    // Built-in Browser and Research Web calls travel this historically
    // MCP-named transport. Naming MCP here sends readers hunting for an
    // external server the run may never have configured.
    super(workerFailureMessage(code, providerCode, providerKind, resetsAt), { cause })
    this.name = 'McpWorkerTurnClientError'
  }
}

// Display only the diagnostic codes validated at the HTTP boundary. Transport
// faults without a reported category retain the generic failure message.
//
// A reported kind leads: it is the half of the failure a person can act on, and
// it is this build's own sentence rather than the provider's, so it is safe on
// any surface the codes already reach. The codes stay, in parentheses, because
// they are what an operator greps for.
function workerFailureMessage(
  code: McpWorkerTurnClientError['code'],
  providerCode: McpWorkerTurnClientError['providerCode'],
  providerKind?: McpWorkerTurnClientError['providerKind'],
  resetsAt?: McpWorkerTurnClientError['resetsAt'],
): string {
  if (providerCode === 'provider_usage_limit') {
    // The one provider failure the user can act on precisely, so it is said
    // in their terms. This text becomes the step's failure status, which is
    // what the transcript shows.
    return resetsAt
      ? `You've hit your provider usage limit. It resets on ${resetsAt}.`
      : "You've hit your provider usage limit. Try again after it resets."
  }
  const diagnosis = !code
    ? 'Parent worker turn failed.'
    : providerCode
      ? `Parent worker turn failed: ${code} (${providerCode}).`
      : `Parent worker turn failed: ${code}.`
  return providerKind
    ? `${PROVIDER_FAILURE_USER_MESSAGES[providerKind]} ${diagnosis}`
    : diagnosis
}

/**
 * Rebuild a typed provider failure from a worker bridge error, when the worker
 * reported one.
 *
 * The attempt loop classifies on `ProviderError`; anything else defaults to
 * retryable. A truncated turn that arrives as an opaque bridge error is
 * therefore retried against the same ceiling, and a stalled one loses the
 * diagnosis the stall watchdog produced.
 */
export function providerErrorFromWorkerFailure(
  error: McpWorkerTurnClientError,
  provider: string,
): ProviderError | undefined {
  const providerCode = error.providerCode
  if (providerCode === PROVIDER_TRUNCATED_CODE || providerCode === PROVIDER_STALLED_CODE) {
    const truncated = providerCode === PROVIDER_TRUNCATED_CODE
    return new ProviderError({
      provider,
      message: truncated
        ? 'returned a truncated response on a worker turn; the partial text was discarded.'
        : 'produced no protocol event on a worker turn and the silent turn was aborted.',
      kind: truncated ? 'process_failed' : 'timeout',
      code: providerCode,
      // The worker already decided this, and its verdict is the one the attempt
      // loop must honour.
      retryable: error.retryable ?? false,
    })
  }
  if (error.providerKind) {
    // The worker classified the provider's refusal, so the attempt loop can be
    // told what kind of failure it is. Without this branch every classified
    // refusal — an exhausted quota, a signed-out CLI, a model the account
    // cannot reach — falls into the permissive default and is retried against
    // the identical request, which cannot succeed and spends the run's budget
    // proving it.
    return new ProviderError({
      provider,
      message: PROVIDER_FAILURE_USER_MESSAGES[error.providerKind],
      kind: error.providerKind,
      retryable: error.retryable ?? false,
      // The generic copy below replaces the parent's sentence, so the moment
      // has to travel as a field or it is simply lost here.
      ...(error.resetsAtInstant === undefined
        ? {}
        : { resetsAt: error.resetsAtInstant }),
      // The parent's adapter is the only thing that could know, and it is on
      // the other side of this boundary. Carried only as a positive `false`,
      // which is what `deriveExecutionToolEffectEvidence` needs before it will
      // call a repeat safe.
      ...(error.dispatched === false ? { dispatched: false } : {}),
    })
  }
  // A transport fault is not a model fault. Leaving it untyped keeps the
  // attempt loop's existing handling rather than misclassifying it.
  return undefined
}

/** A failure the parent reported no category for, and where it happened. */
function uncodedFailure(
  failureDetail: WorkerTurnFailure,
  cause?: unknown,
): McpWorkerTurnClientError {
  return new McpWorkerTurnClientError(
    cause,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    failureDetail,
  )
}

/**
 * The Node error code behind a failed connection, from the closed list.
 *
 * `fetch` reports "fetch failed" and keeps the socket's error as its cause, so
 * the chain is walked, a few links deep. Only a listed code is kept; anything
 * else, including a code that is not a string, is `other`.
 */
function transportCodeOf(error: unknown): WorkerTurnTransportCode {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = 'code' in current ? current.code : undefined
    const known = WORKER_TURN_TRANSPORT_CODES.find(
      (candidate) => candidate !== 'other' && candidate === code,
    )
    if (known) return known
    current = current.cause
  }
  return 'other'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the failure identity out of a non-OK worker response.
 *
 * Validate each diagnostic independently so a malformed provider code cannot
 * hide a valid service failure or copy arbitrary response text into a run log.
 */
async function readWorkerFailure(
  response: Awaited<ReturnType<typeof fetch>>,
): Promise<
  Pick<
    McpWorkerTurnClientError,
    | 'code'
    | 'providerCode'
    | 'retryable'
    | 'providerKind'
    | 'resetsAt'
    | 'resetsAtInstant'
    | 'dispatched'
  >
> {
  try {
    const body: unknown = await response.json()
    if (!isRecord(body)) return {}
    const code = workerFailureCodeSchema.safeParse(body.code)
    const providerCode = workerProviderFailureCodeSchema.safeParse(body.providerCode)
    const providerKind = workerProviderKindSchema.safeParse(body.providerKind)
    const resetsAt = workerUsageLimitResetSchema.safeParse(body.resetsAt)
    const resetsAtInstant = workerUsageLimitResetInstantSchema.safeParse(
      body.resetsAtInstant,
    )
    return {
      ...(code.success ? { code: code.data } : {}),
      ...(providerCode.success ? { providerCode: providerCode.data } : {}),
      ...(providerKind.success ? { providerKind: providerKind.data } : {}),
      ...(typeof body.retryable === 'boolean'
        ? { retryable: body.retryable }
        : {}),
      ...(resetsAt.success ? { resetsAt: resetsAt.data } : {}),
      ...(resetsAtInstant.success
        ? { resetsAtInstant: resetsAtInstant.data }
        : {}),
      // Exactly `false` or nothing. A truthy, string-shaped or missing value
      // all mean the same thing here — the parent did not prove absence — and
      // treating any of them as proof would offer a retry on a guess.
      ...(body.dispatched === false ? { dispatched: false } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * Keep the loopback transport alive for the complete approved agent turn.
 * AgentRunner's AbortSignal remains the authoritative deadline; this small
 * grace period prevents the HTTP client from racing that cancellation.
 */
function resolveMcpWorkerTransportTimeoutMs(
  timeoutMinutes: number | undefined,
): number {
  if (
    timeoutMinutes === undefined ||
    !Number.isFinite(timeoutMinutes) ||
    timeoutMinutes <= 0
  ) {
    return DEFAULT_WORKER_TURN_TIMEOUT_MS
  }
  return Math.ceil(timeoutMinutes * 60_000) + WORKER_TURN_TIMEOUT_GRACE_MS
}

/**
 * Execute one scheduled agent turn through the parent when the Run
 * Orchestrator injected a worker endpoint. Internal runtime LLM calls have no
 * agent identity and intentionally continue through their normal provider.
 */
export async function runMcpWorkerTurn(params: {
  readonly options: AgentRunOptions
  readonly provider: string
  readonly signal?: AbortSignal
  readonly environment?: NodeJS.ProcessEnv
}): Promise<McpWorkerTurnResponse | null> {
  const environment = params.environment ?? process.env
  const configuredUrl = environment[MCP_WORKER_TURN_URL_ENV]?.trim()
  if (!configuredUrl || !params.options.agentName) return null
  const request = buildWorkerTurnRequest(params, environment)
  return requestWorkerTurn({
    url: requireLoopbackWorkerUrl(configuredUrl),
    request,
    ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
    ...whenDefined(params.options.timeoutMinutes, (definedValue) => ({ timeoutMinutes: definedValue })),
  })
}

/**
 * The Agent's settings, narrowed to what may cross this boundary.
 *
 * Narrowed *here*, in the child, because the request is exact-field validated:
 * an unrecognised name is refused outright, so sending an Agent's whole
 * `providerConfig` would turn every ordinary Agent that names a `base_url` into
 * a failed turn. And it must be narrowed at all because the parent signs the
 * request with its own credentials — an endpoint, a header or a sandbox
 * permission is not the child's to name. Which of the settings that do travel
 * the turn will actually apply is decided in the parent, where the lane is
 * known.
 */
function behaviouralOptions(
  providerConfig: Readonly<Record<string, unknown>> | undefined,
): Record<string, string | number | boolean> | undefined {
  if (!providerConfig) return undefined
  const options: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(providerConfig)) {
    if (!BEHAVIOURAL_PROVIDER_OPTION_NAMES.has(key)) continue
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      options[key] = value
    }
  }
  return Object.keys(options).length > 0 ? options : undefined
}

function buildWorkerTurnRequest(
  params: {
    readonly options: AgentRunOptions
    readonly provider: string
  },
  environment: NodeJS.ProcessEnv,
): ReturnType<typeof parseMcpWorkerTurnRequest> {
  const activityScopeId = environment[MCP_WORKER_ACTIVITY_SCOPE_ID_ENV]?.trim()
  const agentDisplayName = environment[MCP_WORKER_AGENT_DISPLAY_NAME_ENV]?.trim()
  try {
    return parseMcpWorkerTurnRequest({
      version: MCP_WORKER_TURN_CONTRACT_VERSION,
      sessionId: environment[RUNTIME_SESSION_ID_ENV],
      runId: environment[RUNTIME_RUN_ID_ENV],
      assignmentId: environment[RUNTIME_ASSIGNMENT_ID_ENV],
      ...(activityScopeId ? { activityScopeId } : {}),
      ...(agentDisplayName ? { agentDisplayName } : {}),
      taskId: environment.TEAM_RUNTIME_TASK_ID,
      processIdentity: environment.TEAM_RUNTIME_PROCESS_IDENTITY,
      workflowId: environment.TEAM_RUNTIME_WORKFLOW_ID,
      workflowStepId: environment[MCP_WORKER_WORKFLOW_STEP_ID_ENV],
      agentPath: `agents/${params.options.agentName}`,
      provider: params.provider,
      model: params.options.model,
      thinking: params.options.thinking,
      ...whenDefined(
        params.options.governedWebEvidenceMode,
        (governedWebEvidenceMode) => ({ governedWebEvidenceMode }),
      ),
      ...whenDefined(
        behaviouralOptions(params.options.providerConfig),
        (providerOptions) => ({ providerOptions }),
      ),
      systemPrompt: params.options.systemPrompt,
      userMessage: params.options.userMessage,
      ...whenDefined(params.options.questionContext, (questionContext) => ({ questionContext })),
      ...(params.options.questionContext && params.options.outputSchema
        ? { questionOutputSchema: params.options.outputSchema } : {}),
    })
  } catch (error) {
    throw uncodedFailure({ stage: 'request_invalid' }, error)
  }
}

async function requestWorkerTurn(params: {
  readonly url: string
  readonly request: ReturnType<typeof parseMcpWorkerTurnRequest>
  readonly signal?: AbortSignal
  readonly timeoutMinutes?: number
}): Promise<McpWorkerTurnResponse> {
  const transportTimeoutMs = resolveMcpWorkerTransportTimeoutMs(
    params.timeoutMinutes,
  )
  const dispatcher = new Agent({
    connections: 1,
    pipelining: 1,
    headersTimeout: transportTimeoutMs,
    bodyTimeout: transportTimeoutMs,
  })
  try {
    const response = await postWorkerTurn({ ...params, dispatcher })
    return await parseWorkerTurnResponse(response)
  } finally {
    await dispatcher.close().catch(() => undefined)
  }
}

async function postWorkerTurn(params: {
  readonly url: string
  readonly request: ReturnType<typeof parseMcpWorkerTurnRequest>
  readonly signal?: AbortSignal
  readonly dispatcher: Agent
}): Promise<Awaited<ReturnType<typeof fetch>>> {
  let response
  try {
    response = await fetch(params.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params.request),
      redirect: 'error',
      ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
      dispatcher: params.dispatcher,
    })
  } catch (error) {
    if (params.signal?.aborted) throw error
    throw uncodedFailure(
      { stage: 'transport', transportCode: transportCodeOf(error) },
      error,
    )
  }
  if (response.ok) return response
  const failure = await readWorkerFailure(response)
  await response.body?.cancel().catch(() => undefined)
  throw new McpWorkerTurnClientError(
    new Error(`Worker endpoint returned HTTP ${response.status}.`),
    failure.code,
    failure.providerCode,
    failure.retryable,
    failure.providerKind,
    failure.resetsAt,
    failure.resetsAtInstant,
    failure.dispatched,
    // A reported category says what failed; only an answer without one needs
    // the status to say where.
    failure.code === undefined
      ? { stage: 'http_status_without_code', httpStatus: response.status }
      : undefined,
  )
}

async function parseWorkerTurnResponse(
  response: Awaited<ReturnType<typeof fetch>>,
): Promise<McpWorkerTurnResponse> {
  try {
    const body = await readBoundedResponse(response)
    return parseMcpWorkerTurnResponse(JSON.parse(body) as unknown)
  } catch (error) {
    if (error instanceof McpWorkerTurnClientError) throw error
    throw uncodedFailure({ stage: 'response_invalid' }, error)
  }
}

function requireLoopbackWorkerUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw uncodedFailure({ stage: 'endpoint_invalid' })
  }
  if (
    url.protocol !== 'http:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname === '/'
  ) {
    throw uncodedFailure({ stage: 'endpoint_invalid' })
  }
  return url.href
}

async function readBoundedResponse(
  response: Awaited<ReturnType<typeof fetch>>,
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_WORKER_RESPONSE_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined)
    throw uncodedFailure({ stage: 'response_invalid' })
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      // undici types body chunks as `any`; they are bytes, checked here.
      const chunk: unknown = next.value
      if (!(chunk instanceof Uint8Array)) {
        await reader.cancel().catch(() => undefined)
        throw uncodedFailure({ stage: 'response_invalid' })
      }
      size += chunk.byteLength
      if (size > MAX_WORKER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw uncodedFailure({ stage: 'response_invalid' })
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    'utf8',
  )
}
