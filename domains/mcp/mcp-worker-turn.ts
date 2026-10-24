import { BEHAVIOURAL_PROVIDER_OPTION_NAMES } from '../../providers/provider-option-support.js'
import { z } from 'zod'
import {
  agentQuestionContextSchema, agentQuestionWaitSchema, agentQuestionBlockSchema, agentQuestionResultSchema, agentQuestionOutputSchema,
  type AgentQuestionContext, type AgentQuestionOutputSchema,
} from '../../contracts/agent-questions.js'
import type { McpProviderSupport } from './mcp-runtime.js'
import { normalizeMcpAgentPath } from './mcp-settings.js'
import { isValidSessionId } from '../../contracts/sessions.js'
import { isSafePathSegment } from '../../core/path-safety.js'
import { isThinkingLevel } from '../../contracts/thinking-levels.js'
import type {
  GovernedWebEvidenceMode,
  ThinkingLevel,
} from '../../core/types.js'

export const MCP_WORKER_TURN_CONTRACT_VERSION = 6 as const
export const MCP_WORKER_TURN_URL_ENV = 'PIPELINE_MCP_WORKER_TURN_URL'
export const MCP_WORKER_WORKFLOW_STEP_ID_ENV =
  'TEAM_RUNTIME_WORKFLOW_STEP_ID'
export const MCP_WORKER_ACTIVITY_SCOPE_ID_ENV =
  'TEAM_RUNTIME_ACTIVITY_SCOPE_ID'
export const MCP_WORKER_AGENT_DISPLAY_NAME_ENV =
  'TEAM_RUNTIME_AGENT_DISPLAY_NAME'

const MAX_PROVIDER_LENGTH = 256
const MAX_MODEL_LENGTH = 512
const MAX_PROMPT_BYTES = 2 * 1_024 * 1_024

export interface McpWorkerTurnRequest {
  readonly questionContext?: AgentQuestionContext
  readonly questionOutputSchema?: AgentQuestionOutputSchema
  readonly version: typeof MCP_WORKER_TURN_CONTRACT_VERSION
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly activityScopeId?: string
  readonly agentDisplayName?: string
  readonly taskId: string
  readonly processIdentity: string
  readonly workflowId: string
  readonly workflowStepId: string
  readonly agentPath: string
  readonly provider: string
  readonly model: string
  readonly thinking: ThinkingLevel
  readonly governedWebEvidenceMode?: GovernedWebEvidenceMode
  /**
   * The Agent's own behavioural settings, as a closed set of scalars.
   *
   * Deliberately not `providerConfig`. That name carries endpoints, headers,
   * raw request bodies and process permissions, and
   * `domains/mcp/mcp-provider-tool-target.ts:36-44` honours a `base_url` using
   * the *parent's* credentials — so accepting one here would let a child
   * redirect them. Only settings that describe how a model should answer may
   * cross, by name and by value, and which of them the running pair actually
   * applies is still decided in the parent.
   */
  readonly providerOptions?: Readonly<Record<string, string | number | boolean>>
  readonly systemPrompt: string
  readonly userMessage: string
}

export interface McpWorkerTurnUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
}

const questionWorkerResponseBaseSchema = agentQuestionResultSchema.omit({ text: true }).extend({
  version: z.literal(MCP_WORKER_TURN_CONTRACT_VERSION), model: z.string().min(1).max(MAX_MODEL_LENGTH),
  availableToolCount: z.number().int().nonnegative(),
  droppedProviderOptions: z.array(z.string().refine((name) => BEHAVIOURAL_PROVIDER_OPTION_NAMES.has(name))).optional(),
})
const agentQuestionWorkerResponseSchema = z.discriminatedUnion('kind', [
  questionWorkerResponseBaseSchema.extend({ kind: z.literal('awaiting_input'), interruption: agentQuestionWaitSchema }),
  questionWorkerResponseBaseSchema.extend({ kind: z.literal('blocked'), interruption: agentQuestionBlockSchema }),
]).refine((result) => result.executedToolCallCount <= result.toolCallCount &&
  (result.kind === 'blocked' || result.availableToolCount > 0 || result.toolCallCount === 0))

export type McpWorkerTurnResponse =
  | z.infer<typeof agentQuestionWorkerResponseSchema>
  | {
      readonly version: typeof MCP_WORKER_TURN_CONTRACT_VERSION
      readonly kind: 'completed'
      readonly provider?: string
      readonly text: string
      readonly model: string
      readonly usage: McpWorkerTurnUsage
      readonly availableToolCount: number
      readonly toolCallCount: number
      readonly executedToolCallCount: number
      /**
       * Agent settings this turn's lane does not apply, by name.
       *
       * Reported back so the child can record it. The parent decides which
       * settings apply, and a setting that quietly stopped applying is
       * otherwise indistinguishable to a reader from a provider that ignored
       * it.
       */
      readonly droppedProviderOptions?: readonly string[]
    }
  | {
      readonly version: typeof MCP_WORKER_TURN_CONTRACT_VERSION
      readonly kind: 'no-tools' | 'provider-unsupported'
      readonly providerSupport: McpProviderSupport
    }

/**
 * Reads the closed behavioural-settings map, or refuses the whole request.
 *
 * Refused whole rather than in part, and by name rather than by shape: a key
 * outside the vocabulary is a request to do something this field is not for,
 * and quietly ignoring it would let a child keep asking. Values are checked to
 * be scalars here; whether a *particular* provider will use one is decided in
 * the parent, against the pair that actually runs.
 */
/** The names a turn reports as not applying, refused whole if malformed. */
function parseDroppedProviderOptions(
  value: unknown,
): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) fail()
  for (const entry of value) {
    if (typeof entry !== 'string' || !BEHAVIOURAL_PROVIDER_OPTION_NAMES.has(entry)) {
      fail()
    }
  }
  return value.length > 0 ? [...(value as string[])] : undefined
}

function parseBehaviouralProviderOptions(
  value: unknown,
): Readonly<Record<string, string | number | boolean>> | undefined {
  if (value === undefined) return undefined
  const record = requireRecord(value)
  const options: Record<string, string | number | boolean> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (!BEHAVIOURAL_PROVIDER_OPTION_NAMES.has(key)) fail()
    if (
      typeof entry !== 'string' &&
      typeof entry !== 'number' &&
      typeof entry !== 'boolean'
    ) {
      fail()
    }
    options[key] = entry as string | number | boolean
  }
  return Object.keys(options).length > 0 ? options : undefined
}

export class McpWorkerTurnContractError extends Error {
  constructor() {
    super('MCP worker turn request is invalid.')
    this.name = 'McpWorkerTurnContractError'
  }
}

export function parseMcpWorkerTurnResponse(
  value: unknown,
): McpWorkerTurnResponse {
  const record = requireRecord(value)
  if (record.kind === 'awaiting_input' || record.kind === 'blocked') {
    const parsed = agentQuestionWorkerResponseSchema.safeParse(record)
    if (!parsed.success) fail()
    return parsed.data
  }
  if (
    record.version !== MCP_WORKER_TURN_CONTRACT_VERSION ||
    (record.kind !== 'completed' &&
      record.kind !== 'no-tools' &&
      record.kind !== 'provider-unsupported')
  ) {
    fail()
  }
  if (record.kind !== 'completed') {
    requireExactKeys(record, ['version', 'kind', 'providerSupport'])
    return {
      version: MCP_WORKER_TURN_CONTRACT_VERSION,
      kind: record.kind,
      providerSupport: parseProviderSupport(record.providerSupport),
    }
  }
  requireExactKeys(record, [
    'version',
    'kind',
    'text',
    'model',
    'usage',
    'availableToolCount',
    'toolCallCount',
    'executedToolCallCount',
  ], ['droppedProviderOptions', 'provider'])
  const usage = requireExactRecord(record.usage, [
    'inputTokens',
    'outputTokens',
    'totalTokens',
  ])
  const inputTokens = nonNegativeSafeInteger(usage.inputTokens)
  const outputTokens = nonNegativeSafeInteger(usage.outputTokens)
  const totalTokens = nonNegativeSafeInteger(usage.totalTokens)
  const availableToolCount = nonNegativeSafeInteger(record.availableToolCount)
  const toolCallCount = nonNegativeSafeInteger(record.toolCallCount)
  const executedToolCallCount = nonNegativeSafeInteger(
    record.executedToolCallCount,
  )
  if (
    totalTokens !== inputTokens + outputTokens ||
    executedToolCallCount > toolCallCount ||
    (availableToolCount === 0 && toolCallCount > 0)
  ) {
    fail()
  }
  const droppedProviderOptions = parseDroppedProviderOptions(
    record.droppedProviderOptions,
  )
  return {
    version: MCP_WORKER_TURN_CONTRACT_VERSION,
    kind: 'completed',
    ...(record.provider === undefined ? {} : { provider: boundedString(record.provider, MAX_PROVIDER_LENGTH) }),
    ...(droppedProviderOptions ? { droppedProviderOptions } : {}),
    text: boundedResponseText(record.text),
    model: boundedString(record.model, MAX_MODEL_LENGTH),
    usage: { inputTokens, outputTokens, totalTokens },
    availableToolCount,
    toolCallCount,
    executedToolCallCount,
  }
}

export function parseMcpWorkerTurnRequest(value: unknown): McpWorkerTurnRequest {
  const record = requireExactRecord(value, [
    'version',
    'sessionId',
    'runId',
    'assignmentId',
    'activityScopeId',
    'agentDisplayName',
    'taskId',
    'processIdentity',
    'workflowId',
    'workflowStepId',
    'agentPath',
    'provider',
    'model',
    'thinking',
    'governedWebEvidenceMode',
    'providerOptions',
    'systemPrompt',
    'userMessage',
    'questionContext',
    'questionOutputSchema',
  ])
  if (record.version !== MCP_WORKER_TURN_CONTRACT_VERSION) fail()

  const sessionId = requiredString(record.sessionId)
  const runId = requiredSafeSegment(record.runId)
  const assignmentId = requiredSafeSegment(record.assignmentId)
  const activityScopeId = record.activityScopeId === undefined
    ? undefined
    : requiredSafeSegment(record.activityScopeId)
  const agentDisplayName = record.agentDisplayName === undefined
    ? undefined
    : boundedString(record.agentDisplayName, 256)
  const taskId = requiredSafeSegment(record.taskId)
  const processIdentity = requiredSafeSegment(record.processIdentity)
  const workflowId = requiredSafeSegment(record.workflowId)
  const workflowStepId = requiredSafeSegment(record.workflowStepId)
  const agentPath = typeof record.agentPath === 'string'
    ? normalizeMcpAgentPath(record.agentPath)
    : null
  const provider = boundedString(record.provider, MAX_PROVIDER_LENGTH)
  const model = boundedString(record.model, MAX_MODEL_LENGTH)
  const thinking = parseThinkingLevel(record.thinking)
  const governedWebEvidenceMode = parseGovernedWebEvidenceMode(
    record.governedWebEvidenceMode,
  )
  const providerOptions = parseBehaviouralProviderOptions(
    record.providerOptions,
  )
  const systemPrompt = boundedPrompt(record.systemPrompt)
  const userMessage = boundedPrompt(record.userMessage)
  const questionContext = record.questionContext === undefined
    ? undefined : agentQuestionContextSchema.safeParse(record.questionContext)
  if (questionContext && !questionContext.success) fail()
  const questionSchema = record.questionOutputSchema === undefined
    ? undefined : agentQuestionOutputSchema.safeParse(record.questionOutputSchema)
  if (questionSchema && (!questionSchema.success || !questionContext?.success)) fail()

  if (!isValidSessionId(sessionId) || !agentPath) fail()

  return {
    version: MCP_WORKER_TURN_CONTRACT_VERSION,
    sessionId,
    runId,
    assignmentId,
    ...(activityScopeId ? { activityScopeId } : {}),
    ...(agentDisplayName ? { agentDisplayName } : {}),
    taskId,
    processIdentity,
    workflowId,
    workflowStepId,
    agentPath,
    provider,
    model,
    thinking,
    ...(providerOptions ? { providerOptions } : {}),
    ...(governedWebEvidenceMode
      ? { governedWebEvidenceMode }
      : {}),
    systemPrompt,
    userMessage,
    ...(questionContext?.success ? { questionContext: questionContext.data } : {}),
    ...(questionSchema?.success ? { questionOutputSchema: questionSchema.data } : {}),
  }
}

function parseGovernedWebEvidenceMode(
  value: unknown,
): GovernedWebEvidenceMode | undefined {
  if (value === undefined) return undefined
  if (value !== 'acquire' && value !== 'reuse-existing') fail()
  return value
}

function parseThinkingLevel(value: unknown): ThinkingLevel {
  // The shared vocabulary, not a copy of part of it: a level this boundary
  // refused was a level a question could not be asked or resumed at.
  if (!isThinkingLevel(value)) fail()
  return value
}

function requireExactRecord(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const record = value as Record<string, unknown>
  const allowed = new Set(allowedKeys)
  if (Object.keys(record).some((key) => !allowed.has(key))) fail()
  return record
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const record = value as Record<string, unknown>
  if (Reflect.ownKeys(record).some((key) => typeof key !== 'string')) fail()
  return record
}

/**
 * Every key present must be one of these, and every required one must be here.
 *
 * `optional` exists because an additive field has to be genuinely additive: a
 * response written before the field existed, or by a turn that has nothing to
 * report, omits it — and treating absence as invalid would break every one of
 * them. The closed boundary is unchanged in the direction that matters: a key
 * outside this list is still refused, so nothing can be smuggled in.
 */
function requireExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...keys, ...optional])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail()
  }
  for (const key of keys) {
    // Own properties only. This parser reads unknown input, so an object that
    // carries none of these fields but inherits them all describes nothing that
    // was sent, and `in` would accept it.
    if (!Object.prototype.hasOwnProperty.call(record, key)) fail()
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value || !value) fail()
  return value
}

function requiredSafeSegment(value: unknown): string {
  const normalized = requiredString(value)
  if (normalized.length > 512 || !isSafePathSegment(normalized)) fail()
  return normalized
}

function boundedString(value: unknown, maxLength: number): string {
  const normalized = requiredString(value)
  if (normalized.length > maxLength || /[\0-\x1f\x7f]/.test(normalized)) fail()
  return normalized
}

function boundedResponseText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > MAX_PROMPT_BYTES
  ) {
    fail()
  }
  return value
}

function nonNegativeSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    fail()
  }
  return value
}

function parseProviderSupport(value: unknown): McpProviderSupport {
  const record = requireRecord(value)
  const hasMode = record.mode !== undefined
  const hasReasonCode = record.reasonCode !== undefined
  requireExactKeys(record, [
    'provider',
    'state',
    ...(hasMode ? ['mode'] : []),
    ...(hasReasonCode ? ['reasonCode'] : []),
  ])
  const provider = boundedString(record.provider, MAX_PROVIDER_LENGTH)
  if (
    record.state !== 'supported' &&
    record.state !== 'experimental' &&
    record.state !== 'unsupported' &&
    record.state !== 'unknown'
  ) {
    fail()
  }
  if (
    record.mode !== undefined &&
    record.mode !== 'native-tool-loop' &&
    record.mode !== 'host-tool-bridge'
  ) {
    fail()
  }
  const reasonCode = record.reasonCode === undefined
    ? undefined
    : boundedString(record.reasonCode, 256)
  return {
    provider,
    state: record.state,
    ...(record.mode ? { mode: record.mode } : {}),
    ...(reasonCode ? { reasonCode } : {}),
  }
}

function boundedPrompt(value: unknown): string {
  if (typeof value !== 'string') fail()
  if (Buffer.byteLength(value, 'utf8') > MAX_PROMPT_BYTES) fail()
  return value
}

function fail(): never {
  throw new McpWorkerTurnContractError()
}
