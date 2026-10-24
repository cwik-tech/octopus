import { canonicalizeJson } from '../../contracts/canonical-json.js'
import { normalizeCanonicalJsonObject } from '../../core/canonical-json-hash.js'
import {
  MCP_RUNTIME_CONTRACT_VERSION,
  doesMcpRunLeaseAllowAgent,
  type McpBrokerCallRequest,
  type McpBrokerRequestContext,
  type McpJsonObject,
  type McpJsonValue,
  type McpRunLeaseClaims,
  type McpSanitizedError,
  type McpSanitizedErrorCode,
} from './mcp-runtime.js'
import { normalizeMcpAgentPath } from './mcp-settings.js'

const MAX_IDENTIFIER_LENGTH = 512

export interface McpBrokerLimits {
  readonly perCallTimeoutMs: number
  readonly maxInputBytes: number
  readonly maxOutputBytes: number
  readonly maxCallsPerRun: number
  readonly maxConcurrentCallsPerRun: number
  readonly maxOutputBytesPerRun: number
  readonly maxTrackedRuns: number
  readonly maxSchemaBytes: number
}

export const DEFAULT_MCP_BROKER_LIMITS: McpBrokerLimits = {
  perCallTimeoutMs: 30_000,
  maxInputBytes: 64 * 1_024,
  maxOutputBytes: 1 * 1_024 * 1_024,
  maxCallsPerRun: 100,
  maxConcurrentCallsPerRun: 4,
  maxOutputBytesPerRun: 16 * 1_024 * 1_024,
  maxTrackedRuns: 256,
  maxSchemaBytes: 256 * 1_024,
}

export type McpBrokerPolicyResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: McpSanitizedError }

export interface ValidatedMcpBrokerCall {
  readonly request: McpBrokerCallRequest
  readonly canonicalArguments: string
  readonly inputBytes: number
}

export function normalizeMcpBrokerLimits(
  input: Partial<McpBrokerLimits> = {},
): McpBrokerLimits {
  return {
    perCallTimeoutMs: positiveInteger(
      input.perCallTimeoutMs,
      DEFAULT_MCP_BROKER_LIMITS.perCallTimeoutMs,
    ),
    maxInputBytes: positiveInteger(
      input.maxInputBytes,
      DEFAULT_MCP_BROKER_LIMITS.maxInputBytes,
    ),
    maxOutputBytes: positiveInteger(
      input.maxOutputBytes,
      DEFAULT_MCP_BROKER_LIMITS.maxOutputBytes,
    ),
    maxCallsPerRun: positiveInteger(
      input.maxCallsPerRun,
      DEFAULT_MCP_BROKER_LIMITS.maxCallsPerRun,
    ),
    maxConcurrentCallsPerRun: positiveInteger(
      input.maxConcurrentCallsPerRun,
      DEFAULT_MCP_BROKER_LIMITS.maxConcurrentCallsPerRun,
    ),
    maxOutputBytesPerRun: positiveInteger(
      input.maxOutputBytesPerRun,
      DEFAULT_MCP_BROKER_LIMITS.maxOutputBytesPerRun,
    ),
    maxTrackedRuns: positiveInteger(
      input.maxTrackedRuns,
      DEFAULT_MCP_BROKER_LIMITS.maxTrackedRuns,
    ),
    maxSchemaBytes: positiveInteger(
      input.maxSchemaBytes,
      DEFAULT_MCP_BROKER_LIMITS.maxSchemaBytes,
    ),
  }
}

export function validateMcpBrokerContext(
  input: unknown,
): McpBrokerPolicyResult<McpBrokerRequestContext> {
  const record = asRecord(input)
  if (
    !record ||
    record.contractVersion !== MCP_RUNTIME_CONTRACT_VERSION ||
    !isIdentifier(record.requestId) ||
    !isIdentifier(record.leaseId) ||
    !isIdentifier(record.sessionId) ||
    !isIdentifier(record.runId) ||
    !isIdentifier(record.assignmentId)
  ) {
    return policyFailure('invalid_request')
  }
  const agentPath = typeof record.agentPath === 'string'
    ? normalizeMcpAgentPath(record.agentPath)
    : null
  if (
    !agentPath ||
    !isOptionalIdentifier(record.workflowId) ||
    !isOptionalIdentifier(record.workflowStepId) ||
    !isOptionalIdentifier(record.agentId) ||
    !isOptionalIdentifier(record.agentDisplayName) ||
    !isOptionalIdentifier(record.activityScopeId)
  ) {
    return policyFailure('invalid_request')
  }
  return {
    ok: true,
    value: {
      contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
      requestId: record.requestId as string,
      leaseId: record.leaseId as string,
      sessionId: record.sessionId as string,
      runId: record.runId as string,
      assignmentId: record.assignmentId as string,
      ...(typeof record.workflowId === 'string'
        ? { workflowId: record.workflowId }
        : {}),
      ...(typeof record.workflowStepId === 'string'
        ? { workflowStepId: record.workflowStepId }
        : {}),
      agentPath,
      ...(typeof record.agentId === 'string'
        ? { agentId: record.agentId }
        : {}),
      ...(typeof record.agentDisplayName === 'string'
        ? { agentDisplayName: record.agentDisplayName }
        : {}),
      ...(typeof record.activityScopeId === 'string'
        ? { activityScopeId: record.activityScopeId }
        : {}),
    },
  }
}

export function validateMcpBrokerCallRequest(
  input: unknown,
  limits: McpBrokerLimits,
): McpBrokerPolicyResult<ValidatedMcpBrokerCall> {
  const record = asRecord(input)
  const context = validateMcpBrokerContext(record?.context)
  const toolCallId = record?.toolCallId
  const namespacedToolName = record?.namespacedToolName
  if (
    !record ||
    !context.ok ||
    !isIdentifier(toolCallId) ||
    !isNamespacedToolName(namespacedToolName) ||
    !isPlainObject(record.arguments)
  ) {
    return policyFailure('invalid_request', safeRequestId(record?.context))
  }
  let normalizedArguments: ReturnType<typeof normalizeCanonicalJsonObject>
  try {
    normalizedArguments = normalizeCanonicalJsonObject(record.arguments)
  } catch {
    return policyFailure('invalid_request', context.value.requestId)
  }
  const canonicalArguments = normalizedArguments.canonical
  const inputBytes = Buffer.byteLength(canonicalArguments, 'utf8')
  if (inputBytes > limits.maxInputBytes) {
    return policyFailure('result_too_large', context.value.requestId)
  }
  return {
    ok: true,
    value: {
      request: {
        context: context.value,
        toolCallId,
        namespacedToolName,
        arguments: normalizedArguments.value,
      },
      canonicalArguments,
      inputBytes,
    },
  }
}

export function validateMcpRunLease(
  context: McpBrokerRequestContext,
  claims: McpRunLeaseClaims | null,
  nowMs: number,
): McpSanitizedError | null {
  if (!claims || !hasMatchingLeaseIdentity(context, claims)) {
    return mcpBrokerError('lease_invalid', false, context.requestId)
  }
  if (
    !Number.isFinite(claims.issuedAtMs) ||
    !Number.isFinite(claims.expiresAtMs) ||
    claims.expiresAtMs <= claims.issuedAtMs ||
    claims.issuedAtMs > nowMs ||
    !doesMcpRunLeaseAllowAgent(claims, context.agentPath)
  ) {
    return mcpBrokerError('lease_invalid', false, context.requestId)
  }
  if (claims.expiresAtMs <= nowMs) {
    return mcpBrokerError('lease_expired', false, context.requestId)
  }
  return null
}

export function canonicalizeMcpJson(value: unknown): string {
  const wrapped = canonicalizeJson({ value })
  return wrapped.slice('{"value":'.length, -1)
}

export function normalizeMcpJsonValue(value: unknown): McpJsonValue {
  const normalized: unknown = JSON.parse(canonicalizeMcpJson(value))
  if (!isMcpJsonValue(normalized)) throw new Error('Value is not JSON')
  return normalized
}

export function mcpBrokerError(
  code: McpSanitizedErrorCode,
  retryable = false,
  correlationId?: string,
): McpSanitizedError {
  return {
    code,
    message: brokerErrorMessage(code),
    retryable,
    ...(correlationId && isIdentifier(correlationId) ? { correlationId } : {}),
  }
}

export function safeMcpRequestId(context: unknown): string {
  return safeRequestId(context) ?? 'invalid-request'
}

function hasMatchingLeaseIdentity(
  context: McpBrokerRequestContext,
  claims: McpRunLeaseClaims,
): boolean {
  return (
    claims.contractVersion === MCP_RUNTIME_CONTRACT_VERSION &&
    claims.audience === 'mcp-broker' &&
    claims.leaseId === context.leaseId &&
    claims.sessionId === context.sessionId &&
    claims.runId === context.runId &&
    claims.assignmentId === context.assignmentId &&
    Array.isArray(claims.allowedAgentPaths)
  )
}

function policyFailure<T>(
  code: McpSanitizedErrorCode,
  correlationId?: string,
): McpBrokerPolicyResult<T> {
  return { ok: false, error: mcpBrokerError(code, false, correlationId) }
}

function brokerErrorMessage(code: McpSanitizedErrorCode): string {
  switch (code) {
    case 'invalid_request':
      return 'MCP broker request is invalid.'
    case 'lease_invalid':
      return 'MCP run authorization is invalid.'
    case 'lease_expired':
      return 'MCP run authorization has expired.'
    case 'grant_required':
      return 'MCP server access is not granted to this agent.'
    case 'server_disabled':
      return 'MCP server is disabled.'
    case 'connection_failed':
      return 'MCP server is not connected.'
    case 'tool_not_found':
      return 'MCP tool is unavailable.'
    case 'timeout':
      return 'MCP tool call timed out.'
    case 'cancelled':
      return 'MCP tool call was cancelled.'
    case 'result_too_large':
      return 'MCP broker limit was exceeded.'
    case 'protocol_error':
      return 'MCP server protocol response is invalid.'
    case 'tool_failed':
      return 'MCP tool call failed.'
    case 'approval_required':
      return 'MCP tool call requires approval.'
    default:
      return 'MCP broker operation failed.'
  }
}

function isNamespacedToolName(value: unknown): value is string {
  return isIdentifier(value) && value.startsWith('mcp__')
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    !/[\0-\x1f\x7f]/.test(value)
  )
}

function isOptionalIdentifier(value: unknown): boolean {
  return value === undefined || isIdentifier(value)
}

function safeRequestId(context: unknown): string | undefined {
  const record = asRecord(context)
  return isIdentifier(record?.requestId) ? record.requestId : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null
}

function isMcpJsonValue(value: unknown): value is McpJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true
  }
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isMcpJsonValue)
  return isPlainObject(value) && Object.values(value).every(isMcpJsonValue)
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}
