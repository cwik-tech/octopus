import { toMcpJsonObject, type McpJsonObject } from '../contracts/mcp.js'
import { hostAuditedParallelReadEffect } from '../contracts/capability-effect.js'
import {
  isAcquisitionAttempt,
  isSupportedSourceObservationReceiptVersion,
} from '../domains/acquisition/acquisition-types.js'
import type {
  CapabilityAdapter,
  CapabilityDispatchResult,
  CapabilityInvocationIdentity,
  CapabilityPolicyDecision,
  CapabilityPreparedExecution,
  CapabilityScopeAuthority,
} from '../contracts/capability-dispatch.js'
import {
  CapabilityDispatchRejection,
  type CapabilityDispatcher,
} from '../core/capability-dispatcher.js'
import { isSafePathSegment } from '../core/path-safety.js'
import type {
  AcquisitionAttempt,
  ResearchWebAction,
  ResearchWebToolOutput,
} from '../domains/acquisition/acquisition-types.js'
import type { McpBrokerRequestContext } from '../domains/mcp/mcp-runtime.js'
import {
  type BuiltinCapabilityContext,
  toBuiltinCapabilityExecutionContext,
} from './builtin-capability-context.js'
import { parseResearchWebToolInput } from './research-web-tool-service.js'

export const RESEARCH_WEB_CAPABILITY_ID = 'research.web'

export interface ResearchWebCapabilityDispatchInput {
  readonly context: BuiltinCapabilityContext
  readonly authority: CapabilityScopeAuthority
  readonly source: CapabilityInvocationIdentity['source']
  readonly toolCallId: string
  readonly input: McpJsonObject
  readonly initialAuthorityEvidence?: unknown
  readonly signal?: AbortSignal
}

export interface ResearchWebCapabilityDispatchInvoker {
  execute(input: ResearchWebCapabilityDispatchInput): Promise<ResearchWebToolOutput>
  releaseAssignment(scope: ResearchWebAssignmentScope): Promise<void>
}

export interface ResearchWebAssignmentScope {
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly activityScopeId?: string
}

export interface ResearchWebCapabilityService {
  isEnabledForAgent(agentPath: string): boolean
  execute(
    context: McpBrokerRequestContext & { readonly activityScopeId?: string },
    toolCallId: string,
    input: McpJsonObject,
    signal?: AbortSignal,
  ): Promise<ResearchWebToolOutput>
  releaseAssignment(scope: ResearchWebAssignmentScope): Promise<void>
}

export class ResearchWebCapabilityDispatchGateway
  implements ResearchWebCapabilityDispatchInvoker {
  constructor(private readonly options: {
    readonly dispatcher: Pick<CapabilityDispatcher, 'dispatch'>
    readonly service: ResearchWebCapabilityService
  }) {}

  async execute(input: ResearchWebCapabilityDispatchInput): Promise<ResearchWebToolOutput> {
    const result = await this.options.dispatcher.dispatch({
      context: toBuiltinCapabilityExecutionContext(
        input.context,
        input.authority,
      ),
      invocation: {
        capabilityId: RESEARCH_WEB_CAPABILITY_ID,
        source: input.source,
        toolCallId: input.toolCallId,
        input: input.input,
      },
      adapter: new ResearchWebCapabilityAdapter({
        service: this.options.service,
        context: input.context,
      }),
      ...(input.initialAuthorityEvidence === undefined
        ? {}
        : { initialAuthorityEvidence: input.initialAuthorityEvidence }),
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (result.status === 'completed' && isResearchWebToolOutput(result.value)) {
      return result.value
    }
    if (result.status !== 'completed' && isResearchWebToolOutput(result.detail)) {
      return result.detail
    }
    return dispatchFailureOutput(safeAction(input.input.action), result)
  }

  releaseAssignment(scope: ResearchWebAssignmentScope): Promise<void> {
    return this.options.service.releaseAssignment(scope)
  }
}

interface ResearchWebCapabilityAdapterOptions {
  readonly service: ResearchWebCapabilityService
  readonly context: McpBrokerRequestContext & { readonly activityScopeId?: string }
}

export class ResearchWebCapabilityAdapter implements CapabilityAdapter {
  readonly capabilityId = RESEARCH_WEB_CAPABILITY_ID

  constructor(private readonly options: ResearchWebCapabilityAdapterOptions) {}

  async prepare(
    input: Parameters<CapabilityAdapter['prepare']>[0],
  ): Promise<CapabilityPreparedExecution> {
    const argumentsObject = toMcpJsonObject(input.arguments)
    const action = safeAction(argumentsObject.action)
    try {
      parseResearchWebToolInput(argumentsObject)
    } catch (error) {
      throw new CapabilityDispatchRejection(
        'invalid_request',
        researchFailure(
          action,
          'invalid_request',
          error instanceof Error
            ? error.message
            : 'Research web input is invalid.',
        ),
      )
    }
    let terminalOutput: ResearchWebToolOutput | undefined
    const enabledDecision = (): CapabilityPolicyDecision =>
      this.options.context.activityScopeId &&
      isSafePathSegment(this.options.context.activityScopeId) &&
      this.options.service.isEnabledForAgent(this.options.context.agentPath)
        ? { kind: 'allow' }
        : {
            kind: 'deny',
            code: 'domain_denied',
            reason: 'This agent is not permitted to use Research Web.',
            detail: researchFailure(
              action,
              'domain_denied',
              'This agent is not permitted to use research web acquisition.',
            ),
          }
    return {
      // Host-audited parallel read, mirroring the service tool effect. Safe
      // because budget counters check-and-increment atomically,
      // BrowserManager joins in-flight per-scope context creation, and
      // per-call acquisition state is isolated; same-URL duplicate work and
      // terminal-host races are accepted as benign. See
      // docs/adr/2026-08-16-Research-Web-Parallel-Execution.md.
      effect: hostAuditedParallelReadEffect(),
      risk: 'read-only',
      argumentNames: Object.keys(argumentsObject).sort(),
      policyDecision: { kind: 'allow' },
      authorize: async () => enabledDecision(),
      execute: async ({ signal }) => {
        const output: unknown = await this.options.service.execute(
          this.options.context,
          input.invocation.toolCallId,
          argumentsObject,
          signal,
        )
        if (!isResearchWebToolOutput(output)) {
          terminalOutput = researchFailure(
            action,
            'internal',
            'Research web acquisition returned an invalid result.',
            true,
          )
          throw new Error('Research Web returned an invalid domain result.')
        }
        terminalOutput = output
        if (!output.ok) {
          throw new Error('Research Web returned a domain failure.')
        }
        return output
      },
      acceptResult: async ({ value }) => {
        if (!isResearchWebToolOutput(value)) {
          throw new Error('Research Web returned an invalid domain result.')
        }
        return { value }
      },
      projectLifecycle: async (transition) => {
        if (
          transition.kind !== 'terminal' ||
          transition.result.status === 'completed'
        ) {
          return undefined
        }
        return terminalOutput ? { detail: terminalOutput } : undefined
      },
    }
  }
}

function dispatchFailureOutput(
  action: ResearchWebAction,
  result: CapabilityDispatchResult,
): ResearchWebToolOutput {
  if (result.status === 'cancelled') {
    return researchFailure(
      action,
      'cancelled',
      'Research web acquisition was cancelled.',
    )
  }
  if (result.status === 'rejected') {
    return researchFailure(
      action,
      'domain_denied',
      'This research capability was denied.',
    )
  }
  return researchFailure(
    action,
    'internal',
    result.status === 'indeterminate'
      ? 'Research web acquisition outcome is indeterminate.'
      : 'Research web acquisition failed.',
    result.status === 'indeterminate',
  )
}

function researchFailure(
  action: ResearchWebAction,
  code: NonNullable<ResearchWebToolOutput['error']>['code'],
  message: string,
  retryable = false,
): ResearchWebToolOutput {
  return { ok: false, action, error: { code, message, retryable } }
}

function isResearchWebToolOutput(value: unknown): value is ResearchWebToolOutput {
  if (!isRecord(value) || typeof value.ok !== 'boolean' || !isAction(value.action)) {
    return false
  }
  if (!optionalStrings(value, [
    'requestedUrl',
    'finalUrl',
    'canonicalUrl',
    'title',
    'mediaType',
    'provider',
    'text',
  ])) {
    return false
  }
  if (value.method !== undefined && !isMethod(value.method)) return false
  if (value.results !== undefined && !isArrayOf(value.results, isSearchResult)) {
    return false
  }
  if (value.content !== undefined && !isContent(value.content)) return false
  if (value.matches !== undefined && !isArrayOf(value.matches, isContentMatch)) {
    return false
  }
  if (
    value.observationReceipt !== undefined &&
    !isObservationReceipt(value.observationReceipt)
  ) {
    return false
  }
  if (value.extraction !== undefined && !isExtraction(value.extraction)) return false
  if (value.attempts !== undefined && !isArrayOf(value.attempts, isAttempt)) {
    return false
  }
  return value.error === undefined || isResearchError(value.error)
}

function isSearchResult(value: unknown): boolean {
  return isRecord(value) &&
    requiredStrings(value, ['title', 'url', 'canonicalUrl', 'provider']) &&
    optionalStrings(value, ['snippet', 'publishedAt']) &&
    isFiniteNumber(value.score)
}

function isContent(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    isNonNegativeInteger(value.sizeBytes) &&
    isNonNegativeInteger(value.chunkCount) &&
    (value.currentChunk === undefined || isNonNegativeInteger(value.currentChunk)) &&
    (value.text === undefined || typeof value.text === 'string')
}

function isContentMatch(value: unknown): boolean {
  return isRecord(value) &&
    isNonNegativeInteger(value.chunkIndex) &&
    typeof value.snippet === 'string'
}

function isObservationReceipt(value: unknown): boolean {
  return isRecord(value) &&
    isSupportedSourceObservationReceiptVersion(value.schemaVersion) &&
    requiredStrings(value, [
      'receiptId',
      'activityId',
      'activityScopeId',
      'relativePath',
      'requestedUrl',
      'finalUrl',
      'canonicalUrl',
      'observedAt',
      'contentRelativePath',
      'contentSha256',
    ]) &&
    optionalStrings(value, [
      'provider',
      'representationsRelativePath',
      'rawSourceRelativePath',
    ]) &&
    isContainedRelativePath(value.relativePath) &&
    isContainedRelativePath(value.contentRelativePath) &&
    (
      value.representationsRelativePath === undefined ||
      isContainedRelativePath(value.representationsRelativePath)
    ) &&
    (
      value.rawSourceRelativePath === undefined ||
      isContainedRelativePath(value.rawSourceRelativePath)
    ) &&
    isSha256(value.contentSha256) &&
    isMethod(value.method) &&
    isNonNegativeInteger(value.contentBytes) &&
    isQualityStatus(value.quality)
}

function isExtraction(value: unknown): boolean {
  return isRecord(value) &&
    requiredStrings(value, [
      'extractionId',
      'resultRelativePath',
      'receiptRelativePath',
    ]) &&
    isContainedRelativePath(value.resultRelativePath) &&
    isContainedRelativePath(value.receiptRelativePath) &&
    typeof value.complete === 'boolean' &&
    typeof value.requirementsMet === 'boolean' &&
    isRecord(value.data) &&
    isArrayOf(value.fields, isExtractedField) &&
    isArrayOf(value.methodsAttempted, isExtractionMethod) &&
    isArrayOf(value.warnings, isString)
}

function isExtractedField(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.path === 'string' &&
    isFieldStatus(value.status) &&
    isArrayOf(value.provenance, isFieldProvenance) &&
    (value.confidence === undefined || isFiniteNumber(value.confidence)) &&
    (value.message === undefined || typeof value.message === 'string')
}

function isFieldProvenance(value: unknown): boolean {
  return isRecord(value) &&
    requiredStrings(value, ['sourceReceiptId', 'representationId']) &&
    optionalStrings(value, ['pointer', 'quote']) &&
    (value.method === 'deterministic' || value.method === 'model')
}

function isAttempt(value: unknown): value is AcquisitionAttempt {
  // The shared domain guard. This boundary and the receipt reader used to keep
  // separate copies that disagreed about how strict a timestamp had to be.
  return isAcquisitionAttempt(value)
}

function isResearchError(value: unknown): boolean {
  return isRecord(value) &&
    isErrorCode(value.code) &&
    typeof value.message === 'string' &&
    typeof value.retryable === 'boolean'
}

function requiredStrings(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => typeof value[key] === 'string')
}

function optionalStrings(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => value[key] === undefined || typeof value[key] === 'string')
}

function isArrayOf(
  value: unknown,
  predicate: (entry: unknown) => boolean,
): boolean {
  return Array.isArray(value) && value.every(predicate)
}

function safeAction(value: unknown): ResearchWebAction {
  return isAction(value) ? value : 'search'
}

function isAction(value: unknown): value is ResearchWebAction {
  return typeof value === 'string' && RESEARCH_ACTIONS.has(value)
}

function isMethod(value: unknown): boolean {
  return typeof value === 'string' && ACQUISITION_METHODS.has(value)
}

function isAttemptOutcome(value: unknown): boolean {
  return typeof value === 'string' && ATTEMPT_OUTCOMES.has(value)
}

function isQualityStatus(value: unknown): boolean {
  return typeof value === 'string' && QUALITY_STATUSES.has(value)
}

function isFieldStatus(value: unknown): boolean {
  return typeof value === 'string' && FIELD_STATUSES.has(value)
}

function isExtractionMethod(value: unknown): boolean {
  return typeof value === 'string' && EXTRACTION_METHODS.has(value)
}

function isErrorCode(value: unknown): boolean {
  return typeof value === 'string' && ERROR_CODES.has(value)
}

function isString(value: unknown): boolean {
  return typeof value === 'string'
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isSha256(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function isContainedRelativePath(value: unknown): boolean {
  if (typeof value !== 'string' || !value || value.includes('\\')) return false
  if (value.startsWith('/') || /^[a-z]:\//iu.test(value)) return false
  return value
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const RESEARCH_ACTIONS: ReadonlySet<string> = new Set([
  'search',
  'acquire',
  'extract',
  'read_content',
  'search_content',
])
const ACQUISITION_METHODS: ReadonlySet<string> = new Set([
  'direct-http',
  'direct-http-proxied',
  'managed-browser',
  'managed-browser-proxied',
  'managed-reader',
  'cloud-browser',
  'document-parser',
])
const ATTEMPT_OUTCOMES: ReadonlySet<string> = new Set([
  'usable',
  'insufficient',
  'challenge',
  'access-denied',
  'rate-limited',
  'not-found',
  'unsupported',
  'policy-denied',
  'timeout',
  'cancelled',
  'failed',
])
const QUALITY_STATUSES: ReadonlySet<string> = new Set([
  'usable',
  'partial',
  'unusable',
])
const FIELD_STATUSES: ReadonlySet<string> = new Set([
  'present',
  'missing',
  'incompatible',
  'ambiguous',
  'conflicting',
  'unsupported',
  'invalid_evidence',
])
const EXTRACTION_METHODS: ReadonlySet<string> = new Set([
  'deterministic',
  'model',
  'model-repair',
])
const ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_request',
  'not_configured',
  'domain_denied',
  'access_challenge',
  'access_denied',
  'rate_limited',
  'not_found',
  'empty_content',
  'unsupported_content',
  'source_integrity',
  'browser_unavailable',
  'budget_exhausted',
  'timeout',
  'cancelled',
  'internal',
])
