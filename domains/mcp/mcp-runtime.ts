import {
  MCP_RUNTIME_CONTRACT_VERSION,
  normalizeMcpCapabilityName,
  normalizeMcpCapabilityRequirement,
  type McpBrokerRequestContext,
  type McpEvidenceRecord,
  type McpImmutableSnapshotProvenance,
  type McpJsonObject,
  type McpJsonPrimitive,
  type McpJsonSchema,
  type McpJsonValue,
  type McpToolRisk,
  type McpWorkflowCapabilityRequirement,
} from '../../contracts/mcp.js'
import {
  serialCapabilityEffect,
  type CapabilityEffect,
} from '../../contracts/capability-effect.js'
import {
  MCP_SETTINGS_SCHEMA_VERSION,
  normalizeMcpAgentPath,
  type McpCapabilityAlias,
  type McpConnectionStatus,
} from './mcp-settings.js'

export const MCP_TOOL_NAMESPACE_PREFIX = 'mcp__' as const
export const DEFAULT_MCP_APPROVAL_POLICY = 'unsafe-only' as const

export {
  MCP_RUNTIME_CONTRACT_VERSION,
  normalizeMcpCapabilityRequirement,
}
export type {
  McpBrokerRequestContext,
  McpEvidenceRecord,
  McpImmutableSnapshotProvenance,
  McpJsonObject,
  McpJsonPrimitive,
  McpJsonSchema,
  McpJsonValue,
  McpToolRisk,
  McpWorkflowCapabilityRequirement,
}

export type McpProviderSupportState =
  | 'supported'
  | 'experimental'
  | 'unsupported'
  | 'unknown'

export type McpProviderSupportMode =
  | 'native-tool-loop'
  | 'host-tool-bridge'

export interface McpProviderSupport {
  readonly provider: string
  readonly state: McpProviderSupportState
  readonly mode?: McpProviderSupportMode
  readonly reasonCode?: string
}

export type McpApprovalPolicy = 'always' | 'unsafe-only'

export interface McpToolAnnotations {
  readonly readOnlyHint?: boolean
  readonly destructiveHint?: boolean
  readonly idempotentHint?: boolean
  readonly openWorldHint?: boolean
}

export interface McpNamespacedTool {
  readonly serverId: string
  readonly serverName: string
  readonly toolName: string
  readonly namespacedName: string
  readonly description?: string
  readonly inputSchema: McpJsonSchema
  readonly outputSchema?: McpJsonSchema
  readonly annotations: McpToolAnnotations
  readonly risk: McpToolRisk
  readonly effect: CapabilityEffect
  readonly requiresApproval: boolean
}

export interface McpRunLeaseClaims {
  readonly contractVersion: typeof MCP_RUNTIME_CONTRACT_VERSION
  readonly audience: 'mcp-broker'
  readonly leaseId: string
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly taskId?: string
  readonly issuedAtMs: number
  readonly expiresAtMs: number
  readonly allowedAgentPaths: readonly string[]
}

export interface McpBrokerListRequest {
  readonly context: McpBrokerRequestContext
}

export interface McpBrokerCallRequest {
  readonly context: McpBrokerRequestContext
  readonly toolCallId: string
  readonly namespacedToolName: string
  readonly arguments: McpJsonObject
}

export interface McpBrokerPreflightRequest {
  readonly context: McpBrokerRequestContext
  readonly provider: string
  readonly model?: string
  readonly requirements?: readonly McpWorkflowCapabilityRequirement[]
}

export interface McpBrokerListResult {
  readonly contractVersion: typeof MCP_RUNTIME_CONTRACT_VERSION
  readonly requestId: string
  readonly generatedAt: string
  readonly authorizedServerCount: number
  readonly tools: readonly McpNamespacedTool[]
  readonly errors: readonly McpSanitizedError[]
}

export interface McpBrokerPreflightResult {
  readonly contractVersion: typeof MCP_RUNTIME_CONTRACT_VERSION
  readonly requestId: string
  readonly providerSupport: McpProviderSupport
  readonly authorizedServerCount: number
  readonly authorizedToolCount: number
  readonly unmetCapabilities: readonly string[]
  readonly warnings: readonly string[]
  readonly errors: readonly McpSanitizedError[]
}

export type McpToolResultContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'json'; readonly value: McpJsonValue }

export interface McpResourceAttachment {
  readonly attachmentId: string
  readonly name: string
  readonly mimeType?: string
  readonly content:
    | { readonly encoding: 'utf8'; readonly text: string }
    | { readonly encoding: 'base64'; readonly data: string }
  readonly provenance: McpImmutableSnapshotProvenance
}

export type McpEvidenceKind = McpEvidenceRecord['kind']

export interface McpBrokerCallResult {
  readonly contractVersion: typeof MCP_RUNTIME_CONTRACT_VERSION
  readonly requestId: string
  readonly toolCallId: string
  readonly isError: boolean
  readonly content: readonly McpToolResultContent[]
  readonly attachments: readonly McpResourceAttachment[]
  readonly evidence: readonly McpEvidenceRecord[]
  readonly error?: McpSanitizedError
}

export type McpInteractionStatus =
  | 'pending'
  | 'resolved'
  | 'denied'
  | 'cancelled'
  | 'expired'
  | 'interrupted'

interface McpInteractionBase {
  readonly interactionId: string
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly workflowId?: string
  readonly workflowStepId?: string
  readonly agentPath: string
  readonly serverId: string
  readonly status: McpInteractionStatus
  readonly createdAt: string
  readonly expiresAt?: string
  readonly resolvedAt?: string
}

export interface McpApprovalInteraction extends McpInteractionBase {
  readonly kind: 'approval'
  readonly toolCallId: string
  readonly namespacedToolName: string
  readonly toolRisk: McpToolRisk
  /** Argument names are safe to display; argument values are intentionally absent. */
  readonly argumentNames: readonly string[]
  readonly argumentsHash: {
    readonly algorithm: 'sha256'
    readonly value: string
  }
  readonly decision?: 'approve' | 'deny'
}

export interface McpElicitationInteraction extends McpInteractionBase {
  readonly kind: 'elicitation'
  readonly message: string
  readonly request:
    | {
        readonly mode: 'form'
        readonly schema: McpJsonSchema
        readonly sensitive: false
      }
    | {
        readonly mode: 'url'
        readonly url: string
        readonly elicitationId: string
      }
}

export type McpInteraction =
  | McpApprovalInteraction
  | McpElicitationInteraction

export type McpApprovalResolution =
  | {
      readonly interactionId: string
      readonly decision: 'approve'
      readonly scope: 'once' | 'run'
    }
  | {
      readonly interactionId: string
      readonly decision: 'deny'
    }

/** Form values are an ephemeral broker input and must never be persisted in an interaction view. */
export interface McpElicitationResolution {
  readonly interactionId: string
  readonly action: 'accept' | 'decline' | 'cancel'
  readonly values?: McpJsonObject
}

export const MCP_SANITIZED_ERROR_CODES = [
  'invalid_request',
  'configuration_invalid',
  'not_found',
  'unauthorized',
  'grant_required',
  'lease_invalid',
  'lease_expired',
  'server_disabled',
  'server_revoked',
  'provider_unsupported',
  'connection_failed',
  'protocol_error',
  'tool_not_found',
  'tool_failed',
  'approval_required',
  'approval_denied',
  'elicitation_cancelled',
  'cancelled',
  'timeout',
  'result_too_large',
  'internal',
] as const

export type McpSanitizedErrorCode = (typeof MCP_SANITIZED_ERROR_CODES)[number]

export interface McpSanitizedError {
  readonly code: McpSanitizedErrorCode
  readonly message: string
  readonly retryable: boolean
  readonly correlationId?: string
}

export const MCP_RUNTIME_EVENT_TYPES = [
  'mcp.connection.opened',
  'mcp.connection.closed',
  'mcp.connection.failed',
  'mcp.server.enabled',
  'mcp.server.disabled',
  'mcp.server.revoked',
  'mcp.tools.changed',
  'mcp.tool.started',
  'mcp.tool.progress',
  'mcp.tool.completed',
  'mcp.tool.failed',
  'mcp.tool.cancelled',
  'mcp.resource.attached',
  'mcp.resource.snapshot.created',
  'mcp.evidence.recorded',
  'mcp.approval.requested',
  'mcp.approval.resolved',
  'mcp.elicitation.requested',
  'mcp.elicitation.resolved',
  'mcp.lease.issued',
  'mcp.lease.revoked',
  'mcp.lease.expired',
] as const

export type McpRuntimeEventType = (typeof MCP_RUNTIME_EVENT_TYPES)[number]
export type McpEventMetadataValue = string | number | boolean | null

export interface McpRuntimeEvent {
  readonly contractVersion: typeof MCP_RUNTIME_CONTRACT_VERSION
  readonly eventId: string
  readonly type: McpRuntimeEventType
  readonly timestamp: string
  readonly runId?: string
  readonly agentPath?: string
  readonly serverId?: string
  readonly toolCallId?: string
  readonly interactionId?: string
  readonly connectionStatus?: McpConnectionStatus
  readonly progress?: { readonly current: number; readonly total?: number; readonly message?: string }
  readonly error?: McpSanitizedError
  /** Metadata is restricted to already-redacted scalar values. */
  readonly metadata?: Readonly<Record<string, McpEventMetadataValue>>
}

export function namespaceMcpToolName(serverId: string, toolName: string): string {
  return `${MCP_TOOL_NAMESPACE_PREFIX}${namespaceSegment(serverId)}__${namespaceSegment(toolName)}`
}

export function classifyMcpToolRisk(
  annotations: McpToolAnnotations,
): McpToolRisk {
  if (annotations.destructiveHint === true) return 'destructive'
  if (annotations.readOnlyHint === true) return 'read-only'
  if (annotations.readOnlyHint === false) return 'mutating'
  return 'unknown'
}

export function resolveMcpCapabilityEffect(input: unknown): CapabilityEffect {
  if (!isRecord(input)) return serialCapabilityEffect('unknown')
  const readOnlyHint = input.readOnlyHint
  const destructiveHint = input.destructiveHint
  if (
    (readOnlyHint !== undefined && typeof readOnlyHint !== 'boolean') ||
    (destructiveHint !== undefined && typeof destructiveHint !== 'boolean')
  ) {
    return serialCapabilityEffect('unknown')
  }
  if (destructiveHint === true && readOnlyHint === true) {
    return serialCapabilityEffect('unknown')
  }
  if (destructiveHint === true) return serialCapabilityEffect('destructive')
  if (readOnlyHint === false) return serialCapabilityEffect('mutating')
  if (readOnlyHint === true) return serialCapabilityEffect('read-only')
  return serialCapabilityEffect('unknown')
}

export function mcpToolRequiresApproval(
  risk: McpToolRisk,
  policy: McpApprovalPolicy = DEFAULT_MCP_APPROVAL_POLICY,
): boolean {
  if (policy === 'always') return true
  return risk !== 'read-only'
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isMcpRunLeaseActive(
  claims: McpRunLeaseClaims,
  nowMs: number,
): boolean {
  return (
    claims.contractVersion === MCP_RUNTIME_CONTRACT_VERSION &&
    claims.audience === 'mcp-broker' &&
    Number.isFinite(claims.issuedAtMs) &&
    Number.isFinite(claims.expiresAtMs) &&
    claims.issuedAtMs <= nowMs &&
    nowMs < claims.expiresAtMs
  )
}

export function doesMcpRunLeaseAllowAgent(
  claims: McpRunLeaseClaims,
  agentPath: string,
): boolean {
  const normalizedAgentPath = normalizeMcpAgentPath(agentPath)
  if (!normalizedAgentPath) return false
  return claims.allowedAgentPaths.some(
    (allowedPath) => normalizeMcpAgentPath(allowedPath) === normalizedAgentPath,
  )
}

export function doMcpCapabilityAliasesSatisfyRequirement(
  aliases: readonly McpCapabilityAlias[],
  requirement: McpWorkflowCapabilityRequirement,
): boolean {
  const normalized = normalizeMcpCapabilityRequirement(requirement)
  if (!normalized) return false
  return aliases.some(
    (alias) =>
      alias.capability === normalized.capability &&
      (normalized.access === 'any' ||
        alias.access === 'any' ||
        alias.access === normalized.access),
  )
}

function namespaceSegment(value: string): string {
  const source = value.trim()
  const sanitized = source.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  if (sanitized && sanitized === source && sanitized.length <= 24) return sanitized
  const prefix = (sanitized || 'unnamed').slice(0, 15)
  return `${prefix}_${stableHash(source)}`
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export const MCP_CONTRACT_VERSIONS = {
  settings: MCP_SETTINGS_SCHEMA_VERSION,
  runtime: MCP_RUNTIME_CONTRACT_VERSION,
} as const
