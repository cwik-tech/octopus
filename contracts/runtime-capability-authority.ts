import type { McpBrokerRequestContext } from './mcp.js'

export const RUNTIME_TASK_ID_ENV = 'TEAM_RUNTIME_TASK_ID'
export const RUNTIME_PROCESS_IDENTITY_ENV = 'TEAM_RUNTIME_PROCESS_IDENTITY'

export interface RuntimeCapabilityAuthorityClaims {
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly taskId: string
  readonly processIdentity: string
  readonly workflowId?: string
}

export interface RuntimeCapabilityRequestContext
  extends McpBrokerRequestContext, RuntimeCapabilityAuthorityClaims {}

export interface RuntimeCapabilityAuthorityResolution {
  readonly taskId: string
  readonly workflowId: string
  readonly runPath: string
  readonly assignmentPath: string
  readonly mcpResolutionPath?: string
}

export interface RuntimeCapabilityAuthorityPort {
  authorize(
    claims: RuntimeCapabilityAuthorityClaims,
    verification?: RuntimeCapabilityAuthorityVerification,
  ): Promise<RuntimeCapabilityAuthorityResolution>
}

/**
 * A route may issue one same-call evidence object and let the dispatcher consume
 * it for its initial check. Production resolvers authenticate evidence by
 * object identity; callers cannot manufacture or replay it.
 */
export type RuntimeCapabilityAuthorityVerification =
  | { readonly kind: 'issue-evidence' }
  | { readonly kind: 'reuse-evidence'; readonly evidence: unknown }

export function readRuntimeCapabilityWireAuthority(
  value: unknown,
): Pick<RuntimeCapabilityAuthorityClaims, 'taskId' | 'processIdentity'> | null {
  if (!isRecord(value)) return null
  if (!isIdentifier(value.taskId) || !isIdentifier(value.processIdentity)) {
    return null
  }
  return {
    taskId: value.taskId,
    processIdentity: value.processIdentity,
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\0-\x1f\x7f]/u.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
