import { normalizeCanonicalJsonObject } from '../../core/canonical-json-hash.js'
import type { McpToolRisk } from './mcp-runtime.js'

export const MCP_APPROVAL_STATE_VERSION = 1 as const

export type McpApprovalStatus =
  | 'pending'
  | 'approved-once'
  | 'approved-run'
  | 'denied'
  | 'cancelled'
  | 'expired'
  | 'interrupted'

export type McpApprovalScope = 'once' | 'run'

export interface McpApprovalAssignmentScope {
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
}

export interface McpApprovalContext extends McpApprovalAssignmentScope {
  readonly agentPath: string
}

export interface McpApprovalToolScope {
  readonly serverId: string
  readonly namespacedToolName: string
  readonly toolRisk: McpToolRisk
}

export interface McpApprovalArgumentsHash {
  readonly algorithm: 'sha256'
  readonly value: string
}

export interface McpApprovalExactBinding
  extends McpApprovalContext,
    McpApprovalToolScope {
  readonly toolCallId: string
  readonly argumentsHash: McpApprovalArgumentsHash
}

export interface McpApprovalRequestInput
  extends McpApprovalContext,
    McpApprovalToolScope {
  readonly interactionId: string
  readonly toolCallId: string
  /** Ephemeral input. The store hashes it and never retains or persists its values. */
  readonly arguments: unknown
  readonly ttlMs?: number
}

export type McpApprovalResponseInput = McpApprovalExactBinding &
  (
    | {
        readonly interactionId: string
        readonly responseId: string
        readonly decision: 'approve'
        readonly scope: McpApprovalScope
      }
    | {
        readonly interactionId: string
        readonly responseId: string
        readonly decision: 'deny'
      }
  )

export interface McpApprovalCancelInput extends McpApprovalExactBinding {
  readonly interactionId: string
}

export interface McpReusableRunApprovalQuery
  extends McpApprovalContext,
    McpApprovalToolScope {}

/** Redacted contract safe for API and renderer use. */
export interface McpApprovalView
  extends McpApprovalContext,
    McpApprovalToolScope {
  readonly interactionId: string
  readonly kind: 'approval'
  readonly toolCallId: string
  readonly argumentNames: readonly string[]
  readonly status: McpApprovalStatus
  readonly createdAt: string
  readonly expiresAt: string
  readonly resolvedAt?: string
  readonly decision?: 'approve' | 'deny'
  readonly approvalScope?: McpApprovalScope
}

export type McpApprovalErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'binding_mismatch'
  | 'already_resolved'
  | 'expired'
  | 'capacity_exceeded'
  | 'storage_invalid'

export class McpApprovalError extends Error {
  readonly code: McpApprovalErrorCode

  constructor(code: McpApprovalErrorCode) {
    super(approvalErrorMessage(code))
    this.name = 'McpApprovalError'
    this.code = code
  }
}

export interface McpApprovalArgumentSummary {
  readonly argumentNames: readonly string[]
  readonly argumentsHash: McpApprovalArgumentsHash
}

/**
 * Canonicalize and hash a strict JSON object without returning its values.
 * Accessors, sparse arrays, symbols, cycles, non-finite numbers, and
 * prototype-pollution keys are rejected before hashing.
 */
export function hashMcpApprovalArguments(
  value: unknown,
): McpApprovalArgumentSummary {
  try {
    const normalized = normalizeCanonicalJsonObject(value)
    return {
      argumentNames: Object.keys(normalized.value).sort(),
      argumentsHash: { ...normalized.hash },
    }
  } catch (error) {
    if (error instanceof McpApprovalError) throw error
    throw new McpApprovalError('invalid_request')
  }
}

export function isMcpApprovalArgumentsHash(
  value: unknown,
): value is McpApprovalArgumentsHash {
  if (!isPlainObject(value)) return false
  const algorithm = Object.getOwnPropertyDescriptor(value, 'algorithm')
  const hashValue = Object.getOwnPropertyDescriptor(value, 'value')
  return (
    hasExactKeys(value, ['algorithm', 'value']) &&
    isEnumerableDataDescriptor(algorithm) &&
    isEnumerableDataDescriptor(hashValue) &&
    algorithm.value === 'sha256' &&
    typeof hashValue.value === 'string' &&
    /^[a-f0-9]{64}$/.test(hashValue.value)
  )
}

export function isMcpApprovalStatus(
  value: unknown,
): value is McpApprovalStatus {
  return (
    value === 'pending' ||
    value === 'approved-once' ||
    value === 'approved-run' ||
    value === 'denied' ||
    value === 'cancelled' ||
    value === 'expired' ||
    value === 'interrupted'
  )
}

export function isMcpApprovalToolRisk(value: unknown): value is McpToolRisk {
  return (
    value === 'read-only' ||
    value === 'mutating' ||
    value === 'destructive' ||
    value === 'unknown'
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isEnumerableDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { readonly value: unknown } {
  return Boolean(
    descriptor &&
      descriptor.enumerable &&
      Object.prototype.hasOwnProperty.call(descriptor, 'value'),
  )
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some((key) => typeof key !== 'string')) return false
  const keys = (ownKeys as string[]).sort()
  const sortedExpected = [...expected].sort()
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  )
}

function approvalErrorMessage(code: McpApprovalErrorCode): string {
  switch (code) {
    case 'invalid_request':
      return 'MCP approval request is invalid.'
    case 'not_found':
      return 'MCP approval request was not found.'
    case 'binding_mismatch':
      return 'MCP approval binding does not match.'
    case 'already_resolved':
      return 'MCP approval request is already resolved.'
    case 'expired':
      return 'MCP approval request has expired.'
    case 'capacity_exceeded':
      return 'MCP approval store capacity was exceeded.'
    case 'storage_invalid':
      return 'MCP approval storage is invalid.'
  }
}
