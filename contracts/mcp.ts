export const MCP_RUNTIME_CONTRACT_VERSION = 1 as const

export type McpJsonPrimitive = string | number | boolean | null
export type McpJsonValue =
  | McpJsonPrimitive
  | readonly McpJsonValue[]
  | { readonly [key: string]: McpJsonValue }
export type McpJsonObject = Readonly<Record<string, McpJsonValue>>
export type McpJsonSchema = Readonly<Record<string, unknown>>

export function toMcpJsonObject(value: unknown): McpJsonObject {
  if (!isRecord(value)) {
    throw new TypeError('MCP input must be a JSON-compatible object.')
  }
  return toMcpJsonRecord(value)
}

function toMcpJsonValue(value: unknown): McpJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(toMcpJsonValue)
  if (isRecord(value)) return toMcpJsonRecord(value)
  throw new TypeError('MCP input must be a JSON-compatible object.')
}

function toMcpJsonRecord(value: Record<string, unknown>): McpJsonObject {
  const result: Record<string, McpJsonValue> = {}
  for (const [key, entry] of Object.entries(value)) {
    result[key] = toMcpJsonValue(entry)
  }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export interface McpBrokerRequestContext {
  readonly contractVersion: typeof MCP_RUNTIME_CONTRACT_VERSION
  readonly requestId: string
  readonly leaseId: string
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly workflowId?: string
  readonly workflowStepId?: string
  readonly agentPath: string
  /** Unique causal actor for observability; a research lane id when present. */
  readonly agentId?: string
  /** Approved user-facing role for the causal actor. */
  readonly agentDisplayName?: string
  /** Runtime activity scope used to correlate service-emitted events. */
  readonly activityScopeId?: string
  /**
   * Position of this call in the provider's own tool-call order for the turn.
   * Parallel-eligible calls overlap, so a service that persists an ordered
   * record must key on this rather than on when it happened to be reached.
   */
  readonly providerCallOrdinal?: number
}

export type McpCapabilityAccess = 'read' | 'write' | 'any'
export type McpToolRisk = 'read-only' | 'mutating' | 'destructive' | 'unknown'

export interface McpWorkflowCapabilityRequirement {
  readonly capability: string
  readonly access: McpCapabilityAccess
  readonly necessity: 'required' | 'optional'
  readonly rationale?: string
}

export function normalizeMcpCapabilityName(value: string): string | null {
  const capability = value.trim().toLowerCase()
  if (!capability || /^[a-z][a-z0-9+.-]*:\/\//i.test(capability)) return null
  return /^[a-z0-9][a-z0-9._-]*$/.test(capability) ? capability : null
}

export function normalizeMcpCapabilityRequirement(
  requirement: McpWorkflowCapabilityRequirement,
): McpWorkflowCapabilityRequirement | null {
  const capability = normalizeMcpCapabilityName(requirement.capability)
  if (!capability) return null
  return {
    capability,
    access: requirement.access,
    necessity: requirement.necessity,
    ...(requirement.rationale?.trim()
      ? { rationale: requirement.rationale.trim() }
      : {}),
  }
}

export interface McpWorkflowRequirementDiagnostic {
  readonly code: 'mcp_requirement_unmet'
  readonly retryable: true
  readonly stepId: string
  readonly capability: string
  readonly access: readonly McpCapabilityAccess[]
  readonly necessity: 'required' | 'optional'
  readonly eligibleAgentPaths: readonly string[]
  readonly message: string
  readonly agentPath?: never
  readonly provider?: never
  readonly model?: never
  readonly tool?: never
  readonly reasonCode?: never
}

export interface McpWorkflowProviderToolDiagnostic {
  readonly code: 'provider_tool_bridge_unavailable'
  readonly retryable: true
  readonly stepId: string
  readonly agentPath: string
  readonly provider: string
  readonly model: string
  readonly tool: string
  readonly reasonCode?: string
  readonly message: string
  readonly capability?: never
  readonly access?: never
  readonly necessity?: never
  readonly eligibleAgentPaths?: never
}

export type McpWorkflowPreflightDiagnostic =
  | McpWorkflowRequirementDiagnostic
  | McpWorkflowProviderToolDiagnostic

export interface McpContentHash {
  readonly algorithm: 'sha256'
  readonly value: string
}

export interface McpImmutableSnapshotProvenance {
  readonly kind: 'immutable-mcp-snapshot'
  readonly immutable: true
  readonly snapshotId: string
  readonly serverId: string
  readonly resourceUri: string
  readonly capturedAt: string
  readonly contentHash: McpContentHash
  readonly toolCallId?: string
  readonly serverRevision?: string
}

export interface McpEvidenceRecord {
  readonly evidenceId: string
  readonly kind: 'tool-result' | 'resource-snapshot'
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly workflowId?: string
  readonly workflowStepId?: string
  readonly agentPath: string
  readonly serverId: string
  readonly recordedAt: string
  readonly toolCallId?: string
  readonly namespacedToolName?: string
  readonly attachmentId?: string
  readonly summary?: string
  readonly provenance?: McpImmutableSnapshotProvenance
}

export interface McpAuditEventView {
  readonly version: 1
  readonly eventId: string
  readonly type:
    | 'mcp.tool.requested'
    | 'mcp.approval.requested'
    | 'mcp.approval.resolved'
    | 'mcp.elicitation.requested'
    | 'mcp.elicitation.resolved'
    | 'mcp.tool.started'
    | 'mcp.tool.completed'
    | 'mcp.tool.failed'
    | 'mcp.tool.cancelled'
    | 'mcp.resource.imported'
  readonly status: string
  readonly timestamp: string
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly workflowId?: string
  readonly workflowStepId?: string
  readonly agentPath: string
  readonly serverId: string
  readonly toolCallId?: string
  readonly namespacedToolName?: string
  readonly toolRisk?: McpToolRisk
  readonly argumentNames?: readonly string[]
  readonly argumentsHash?: McpContentHash
  readonly interactionId?: string
  readonly approvalStatus?: string
  readonly elicitationMode?: 'form' | 'url'
  readonly elicitationStatus?: string
  readonly elicitationAction?: 'accept' | 'decline' | 'cancel'
  readonly durationMs?: number
  readonly resultByteCount?: number
  readonly resultHash?: McpContentHash
  readonly errorCode?: string
  readonly snapshotId?: string
}

export interface McpToolResultEvidenceContentView {
  readonly index: number
  readonly type: 'text' | 'json'
  readonly mimeType: 'text/plain' | 'application/json'
  readonly byteLength: number
  readonly sha256: string
  readonly storedPath: string
}

export interface McpToolResultDiagnosticsView {
  readonly record: McpEvidenceRecord
  readonly totalBytes: number
  readonly aggregateHash: McpContentHash
  readonly contents: readonly McpToolResultEvidenceContentView[]
}

export interface McpRunDiagnosticsSnapshot {
  readonly audit: readonly McpAuditEventView[]
  readonly toolResults: readonly McpToolResultDiagnosticsView[]
}

export type McpRunMcpDiagnosticsSnapshot = McpRunDiagnosticsSnapshot
