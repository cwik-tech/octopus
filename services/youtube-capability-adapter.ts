import { toMcpJsonObject, type McpJsonObject } from '../contracts/mcp.js'
import type {
  CapabilityAdapter,
  CapabilityInvocationIdentity,
  CapabilityPreparedExecution,
  CapabilityScopeAuthority,
} from '../contracts/capability-dispatch.js'
import {
  CapabilityDispatchRejection,
  type CapabilityDispatcher,
} from '../core/capability-dispatcher.js'
import {
  YOUTUBE_SERVER_ID,
  YOUTUBE_TOOL_CONTRACT_VERSION,
  youtubeApprovalToolName,
  type YoutubeAction,
  type YoutubeToolOutput,
} from '../domains/youtube/youtube-types.js'
import {
  type BuiltinCapabilityContext,
  toBuiltinCapabilityExecutionContext,
} from './builtin-capability-context.js'
import type {
  YoutubeCapabilityAuthorization,
  YoutubeCapabilityPolicyDecision,
  YoutubeToolService,
} from './youtube-tool-service.js'

export const YOUTUBE_CAPABILITY_ID = 'youtube.extract'

export type YoutubeCapabilityService = Pick<
  YoutubeToolService,
  | 'tool'
  | 'isEnabledForAgent'
  | 'prepareCapability'
  | 'authorizeCapability'
  | 'executeCapability'
  | 'acceptCapabilityResult'
  | 'projectCapabilityLifecycle'
>

export interface YoutubeCapabilityDispatchInput {
  readonly context: BuiltinCapabilityContext
  readonly authority: CapabilityScopeAuthority
  readonly source: CapabilityInvocationIdentity['source']
  readonly toolCallId: string
  readonly input: McpJsonObject
  readonly initialAuthorityEvidence?: unknown
  readonly signal?: AbortSignal
}

export interface YoutubeCapabilityDispatchInvoker {
  execute(input: YoutubeCapabilityDispatchInput): Promise<YoutubeToolOutput>
}

export class YoutubeCapabilityDispatchGateway
  implements YoutubeCapabilityDispatchInvoker {
  constructor(private readonly options: {
    readonly dispatcher: Pick<CapabilityDispatcher, 'dispatch'>
    readonly service: YoutubeCapabilityService
  }) {}

  async execute(input: YoutubeCapabilityDispatchInput): Promise<YoutubeToolOutput> {
    const action = youtubeAction(input.input.action)
    const result = await this.options.dispatcher.dispatch({
      context: toBuiltinCapabilityExecutionContext(input.context, input.authority),
      invocation: {
        capabilityId: YOUTUBE_CAPABILITY_ID,
        source: input.source,
        toolCallId: input.toolCallId,
        input: input.input,
      },
      adapter: new YoutubeCapabilityAdapter({
        service: this.options.service,
        context: input.context,
      }),
      ...(input.initialAuthorityEvidence === undefined
        ? {}
        : { initialAuthorityEvidence: input.initialAuthorityEvidence }),
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (result.status === 'completed') {
      return readYoutubeOutput(result.value, action) ?? youtubeFailure(
        action,
        'internal',
        'YouTube capability returned an invalid result.',
      )
    }
    const projected = readYoutubeOutput(result.detail, action)
    if (projected) return projected
    if (result.status === 'cancelled') {
      return youtubeFailure(action, 'cancelled', 'YouTube extraction was cancelled.')
    }
    return youtubeFailure(
      action,
      'internal',
      result.status === 'indeterminate'
        ? 'YouTube extraction outcome is indeterminate.'
        : 'YouTube extraction failed. No credential or cookie details were retained.',
      action === 'capture' || action === 'resume',
    )
  }
}

class YoutubeCapabilityAdapter implements CapabilityAdapter {
  readonly capabilityId = YOUTUBE_CAPABILITY_ID

  constructor(private readonly options: {
    readonly service: YoutubeCapabilityService
    readonly context: BuiltinCapabilityContext
  }) {}

  async prepare(
    input: Parameters<CapabilityAdapter['prepare']>[0],
  ): Promise<CapabilityPreparedExecution> {
    const preparation = await this.options.service.prepareCapability(
      this.options.context,
      input.invocation.toolCallId,
      toMcpJsonObject(input.arguments),
    )
    if (preparation.kind === 'rejected') {
      throw new CapabilityDispatchRejection(
        preparation.code,
        preparation.output,
      )
    }
    const capability = preparation.capability
    return {
      effect: capability.effect,
      risk: capability.risk,
      argumentNames: capability.argumentNames,
      policyDecision: toDispatchPolicy(capability.policyDecision),
      ...(capability.policyDecision.kind === 'require-approval'
        ? {
            approval: {
              title: 'Authenticated YouTube capture',
              description: 'Allow authenticated YouTube transcript capture?',
              serverId: YOUTUBE_SERVER_ID,
              namespacedToolName: youtubeApprovalToolName(),
            },
          }
        : {}),
      projectLifecycle: async (transition) => {
        if (transition.kind !== 'terminal') {
          return this.options.service.projectCapabilityLifecycle(
            capability,
            transition,
          )
        }
        return this.options.service.projectCapabilityLifecycle(capability, {
          kind: 'terminal',
          status: transition.result.status,
          ...(transition.result.status === 'completed'
            ? {}
            : {
                code: transition.result.code,
                ...(transition.result.detail === undefined
                  ? {}
                  : { detail: transition.result.detail }),
              }),
        })
      },
      authorize: async ({ phase }) => toDispatchAuthorization(
        await this.options.service.authorizeCapability(capability, phase),
      ),
      execute: ({ signal }) =>
        this.options.service.executeCapability(capability, signal),
      acceptResult: async ({ value }) => ({
        value: await this.options.service.acceptCapabilityResult(
          capability,
          value,
        ),
      }),
    }
  }
}

function toDispatchPolicy(
  decision: YoutubeCapabilityPolicyDecision,
): YoutubeCapabilityPolicyDecision {
  return decision
}

function toDispatchAuthorization(decision: YoutubeCapabilityAuthorization) {
  return decision.kind === 'allow'
    ? decision
    : {
        kind: 'deny' as const,
        code: decision.code,
        reason: decision.reason,
        detail: decision.output,
      }
}

function readYoutubeOutput(
  value: unknown,
  expectedAction: YoutubeAction,
): YoutubeToolOutput | null {
  return isYoutubeOutput(value) && value.action === expectedAction
    ? value
    : null
}

function isYoutubeOutput(value: unknown): value is YoutubeToolOutput {
  if (!isRecord(value) || !hasOnlyKeys(value, YOUTUBE_OUTPUT_KEYS)) return false
  if (typeof value.ok !== 'boolean' || !isYoutubeAction(value.action)) return false
  if (!optionalStrings(value, YOUTUBE_STRING_FIELDS)) return false
  if (!optionalNonNegativeIntegers(value, YOUTUBE_INTEGER_FIELDS)) return false
  if (!optionalBooleans(value, ['reused', 'confirmationRequired'])) return false
  if (value.source !== undefined && !isYoutubeSource(value.source)) return false
  if (value.videos !== undefined && !isArrayOf(value.videos, isYoutubeVideo)) return false
  if (value.chunk !== undefined && !isYoutubeChunk(value.chunk)) return false
  if (value.diskPreflight !== undefined && !isDiskPreflight(value.diskPreflight)) {
    return false
  }
  if (value.providerUsage !== undefined && !isProviderUsage(value.providerUsage)) {
    return false
  }
  if (
    value.analysisMode !== undefined &&
    value.analysisMode !== 'gemini' &&
    value.analysisMode !== 'transcript'
  ) return false
  if (value.costEstimate !== undefined && !isCostEstimate(value.costEstimate)) {
    return false
  }
  if (value.notices !== undefined && !isArrayOf(value.notices, isYoutubeNotice)) {
    return false
  }
  return value.error === undefined || isYoutubeError(value.error)
}

function youtubeAction(value: unknown): YoutubeAction {
  return isYoutubeAction(value) ? value : 'inspect'
}

function isYoutubeAction(value: unknown): value is YoutubeAction {
  return typeof value === 'string' && YOUTUBE_ACTIONS.has(value)
}

function youtubeFailure(
  action: YoutubeAction,
  code: NonNullable<YoutubeToolOutput['error']>['code'],
  message: string,
  retryable = false,
): YoutubeToolOutput {
  return { ok: false, action, error: { code, message, retryable } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isYoutubeSource(value: unknown): boolean {
  return isRecord(value) &&
    hasOnlyKeys(value, ['type', 'id', 'url', 'title']) &&
    (value.type === 'video' || value.type === 'playlist' || value.type === 'channel') &&
    typeof value.id === 'string' &&
    typeof value.url === 'string' &&
    (value.title === undefined || typeof value.title === 'string')
}

function isYoutubeVideo(value: unknown): boolean {
  return isRecord(value) &&
    hasOnlyKeys(value, YOUTUBE_VIDEO_KEYS) &&
    typeof value.videoId === 'string' &&
    typeof value.url === 'string' &&
    optionalStrings(value, [
      'title',
      'channelName',
      'publishedAt',
      'availableAt',
      'transcriptJson',
      'transcriptMarkdown',
      'language',
    ]) &&
    (value.durationSeconds === undefined || isNonNegativeNumber(value.durationSeconds)) &&
    isYoutubeVideoStatus(value.status) &&
    (value.captureMethod === undefined || isYoutubeCaptureMethod(value.captureMethod))
}

function isYoutubeChunk(value: unknown): boolean {
  return isRecord(value) &&
    hasOnlyKeys(value, ['videoId', 'chunkIndex', 'chunkCount', 'text']) &&
    typeof value.videoId === 'string' &&
    isNonNegativeInteger(value.chunkIndex) &&
    isNonNegativeInteger(value.chunkCount) &&
    typeof value.text === 'string'
}

function isDiskPreflight(value: unknown): boolean {
  return isRecord(value) &&
    hasOnlyKeys(value, ['status', 'availableBytes', 'requiredBytes']) &&
    (value.status === 'partial' || value.status === 'complete' || value.status === 'failed') &&
    (value.availableBytes === undefined || isNonNegativeNumber(value.availableBytes)) &&
    (value.requiredBytes === undefined || isNonNegativeNumber(value.requiredBytes))
}

function isProviderUsage(value: unknown): boolean {
  return isRecord(value) &&
    hasOnlyKeys(value, ['inputTokens', 'outputTokens']) &&
    optionalNonNegativeIntegers(value, ['inputTokens', 'outputTokens'])
}

function isCostEstimate(value: unknown): boolean {
  return isRecord(value) &&
    hasOnlyKeys(value, [
      'available',
      'currency',
      'estimatedCost',
      'estimatedInputTokens',
      'estimatedOutputTokens',
    ]) &&
    typeof value.available === 'boolean' &&
    (value.currency === undefined || value.currency === 'USD') &&
    (value.estimatedCost === undefined || isNonNegativeNumber(value.estimatedCost)) &&
    optionalNonNegativeIntegers(value, [
      'estimatedInputTokens',
      'estimatedOutputTokens',
    ])
}

function isYoutubeNotice(value: unknown): boolean {
  return isRecord(value) &&
    hasOnlyKeys(value, ['code', 'severity', 'message']) &&
    typeof value.code === 'string' &&
    YOUTUBE_NOTICE_CODES.has(value.code) &&
    (value.severity === 'info' || value.severity === 'warning' || value.severity === 'error') &&
    typeof value.message === 'string'
}

function isYoutubeError(value: unknown): boolean {
  return isRecord(value) &&
    hasOnlyKeys(value, ['code', 'message', 'retryable']) &&
    typeof value.code === 'string' &&
    YOUTUBE_ERROR_CODES.has(value.code) &&
    typeof value.message === 'string' &&
    typeof value.retryable === 'boolean'
}

function isYoutubeVideoStatus(value: unknown): boolean {
  return typeof value === 'string' && YOUTUBE_VIDEO_STATUSES.has(value)
}

function isYoutubeCaptureMethod(value: unknown): boolean {
  return typeof value === 'string' && YOUTUBE_CAPTURE_METHODS.has(value)
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function optionalStrings(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => value[key] === undefined || typeof value[key] === 'string')
}

function optionalBooleans(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => value[key] === undefined || typeof value[key] === 'boolean')
}

function optionalNonNegativeIntegers(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => value[key] === undefined || isNonNegativeInteger(value[key]))
}

function isArrayOf(
  value: unknown,
  predicate: (item: unknown) => boolean,
): boolean {
  return Array.isArray(value) && value.every(predicate)
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isNonNegativeNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

const YOUTUBE_ACTIONS: ReadonlySet<string> = new Set([
  'inspect',
  'capture',
  'resume',
  'capture_authenticated',
  'read_transcript',
  'write_methodology',
  'write_consolidation',
  'prepare_manual',
  'write_manual_plan',
  'build_manual',
])

const YOUTUBE_OUTPUT_KEYS = [
  'ok',
  'action',
  'source',
  'manifestPath',
  'artifactPath',
  'itemCount',
  'completed',
  'failed',
  'unavailable',
  'pending',
  'authenticatedFallbackRequired',
  'premierePending',
  'videos',
  'chunk',
  'manualRunId',
  'manualPlanPath',
  'manualMarkdownPath',
  'manualZipPath',
  'manualDocxPath',
  'manualBundlePath',
  'sourceVideoPath',
  'previewPath',
  'frameCount',
  'reused',
  'generationStatus',
  'diskPreflight',
  'providerUsage',
  'analysisMode',
  'confirmationRequired',
  'costEstimate',
  'notices',
  'error',
] as const

const YOUTUBE_STRING_FIELDS = [
  'manifestPath',
  'artifactPath',
  'manualRunId',
  'manualPlanPath',
  'manualMarkdownPath',
  'manualZipPath',
  'manualDocxPath',
  'manualBundlePath',
  'sourceVideoPath',
  'previewPath',
  'generationStatus',
] as const

const YOUTUBE_INTEGER_FIELDS = [
  'itemCount',
  'completed',
  'failed',
  'unavailable',
  'pending',
  'authenticatedFallbackRequired',
  'premierePending',
  'frameCount',
] as const

const YOUTUBE_VIDEO_KEYS = [
  'videoId',
  'url',
  'title',
  'durationSeconds',
  'channelName',
  'publishedAt',
  'availableAt',
  'status',
  'captureMethod',
  'transcriptJson',
  'transcriptMarkdown',
  'language',
] as const

const YOUTUBE_VIDEO_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'success',
  'premiere_pending',
  'auth_required',
  'no_transcript',
  'failed',
])

const YOUTUBE_CAPTURE_METHODS: ReadonlySet<string> = new Set([
  'direct',
  'webshare',
  'authenticated',
  'browser',
])

const YOUTUBE_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_request',
  'source_unavailable',
  'proxy_unavailable',
  'authentication_required',
  'premiere_pending',
  'approval_denied',
  'approval_expired',
  'browser_unavailable',
  'transcript_unavailable',
  'cancelled',
  'disk_space_insufficient',
  'internal',
])

const YOUTUBE_NOTICE_CODES: ReadonlySet<string> = new Set([
  'gemini_key_missing',
  'gemini_auth_failed',
  'gemini_rate_limited',
  'gemini_invalid_response',
  'gemini_unavailable',
  'gemini_pricing_stale',
  'gemini_cost_confirmation_required',
  'disk_space_insufficient',
  'media_download_failed',
  'media_download_fallback',
  'media_tools_unavailable',
  'frame_extraction_failed',
  'browser_capture_failed',
  'video_unavailable',
  'run_cancelled',
  'cleanup_warning',
])

export const YOUTUBE_BUILTIN_SOURCE = Object.freeze({
  kind: 'builtin' as const,
  id: YOUTUBE_SERVER_ID,
  version: String(YOUTUBE_TOOL_CONTRACT_VERSION),
})
