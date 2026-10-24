import { randomUUID } from 'node:crypto'

import {
  MCP_RUNTIME_CONTRACT_VERSION,
  type McpBrokerRequestContext,
  type McpRunLeaseClaims,
} from './mcp-runtime.js'
import { normalizeMcpAgentPath } from './mcp-settings.js'

const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1_000
const MAX_LEASE_TTL_MS = 60 * 60 * 1_000
const DEFAULT_MAX_LEASES = 1_024
const EXPIRED_RETENTION_MS = 5 * 60 * 1_000

export interface McpRunLeaseIssueInput {
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly taskId?: string
  readonly allowedAgentPaths: readonly string[]
  readonly ttlMs?: number
}

export interface McpRunLeaseStoreOptions {
  readonly now?: () => number
  readonly maxLeases?: number
  readonly defaultTtlMs?: number
}

export class McpRunLeaseStore {
  private readonly leases = new Map<string, McpRunLeaseClaims>()
  private readonly now: () => number
  private readonly maxLeases: number
  private readonly defaultTtlMs: number

  constructor(options: McpRunLeaseStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.maxLeases = positiveInteger(options.maxLeases, DEFAULT_MAX_LEASES)
    this.defaultTtlMs = boundedTtl(
      options.defaultTtlMs,
      DEFAULT_LEASE_TTL_MS,
    )
  }

  issue(input: McpRunLeaseIssueInput): McpRunLeaseClaims {
    const issuedAtMs = this.now()
    this.prune(issuedAtMs)
    if (this.leases.size >= this.maxLeases) {
      throw new Error('MCP run lease capacity was exceeded.')
    }
    const sessionId = requireIdentifier(input.sessionId, 'sessionId')
    const runId = requireIdentifier(input.runId, 'runId')
    const assignmentId = requireIdentifier(input.assignmentId, 'assignmentId')
    const taskId = input.taskId
      ? requireIdentifier(input.taskId, 'taskId')
      : undefined
    const allowedAgentPaths = normalizeAgentPaths(input.allowedAgentPaths)
    if (allowedAgentPaths.length === 0) {
      throw new Error('MCP run lease requires at least one agent path.')
    }
    const leaseId = randomUUID()
    const claims: McpRunLeaseClaims = {
      contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
      audience: 'mcp-broker',
      leaseId,
      sessionId,
      runId,
      assignmentId,
      ...(taskId ? { taskId } : {}),
      issuedAtMs,
      expiresAtMs: issuedAtMs + boundedTtl(input.ttlMs, this.defaultTtlMs),
      allowedAgentPaths,
    }
    this.leases.set(leaseId, claims)
    return cloneClaims(claims)
  }

  resolve(context: Pick<McpBrokerRequestContext, 'leaseId'>): McpRunLeaseClaims | null {
    const claims = this.leases.get(context.leaseId)
    return claims ? cloneClaims(claims) : null
  }

  revoke(leaseId: string): boolean {
    return this.leases.delete(leaseId)
  }

  revokeRun(scope: { readonly sessionId: string; readonly runId: string }): number {
    let revoked = 0
    for (const [leaseId, claims] of this.leases) {
      if (claims.sessionId !== scope.sessionId || claims.runId !== scope.runId) continue
      this.leases.delete(leaseId)
      revoked += 1
    }
    return revoked
  }

  clear(): void {
    this.leases.clear()
  }

  get size(): number {
    return this.leases.size
  }

  private prune(nowMs: number): void {
    for (const [leaseId, claims] of this.leases) {
      if (claims.expiresAtMs + EXPIRED_RETENTION_MS <= nowMs) {
        this.leases.delete(leaseId)
      }
    }
  }
}

function normalizeAgentPaths(agentPaths: readonly string[]): string[] {
  if (!Array.isArray(agentPaths) || agentPaths.length > 256) {
    throw new Error('MCP run lease agent paths are invalid.')
  }
  const normalized = agentPaths.map((agentPath: string) => normalizeMcpAgentPath(agentPath))
  if (normalized.some((agentPath) => !agentPath)) {
    throw new Error('MCP run lease agent path is invalid.')
  }
  return [...new Set(normalized as string[])].sort()
}

function requireIdentifier(value: string, field: string): string {
  const normalized = value.trim()
  if (
    normalized.length === 0 ||
    normalized.length > 512 ||
    /[\0-\x1f\x7f]/.test(normalized)
  ) {
    throw new Error(`MCP run lease ${field} is invalid.`)
  }
  return normalized
}

function boundedTtl(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0 || value > MAX_LEASE_TTL_MS) {
    throw new Error('MCP run lease duration is invalid.')
  }
  return Math.floor(value)
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

function cloneClaims(claims: McpRunLeaseClaims): McpRunLeaseClaims {
  return { ...claims, allowedAgentPaths: [...claims.allowedAgentPaths] }
}
