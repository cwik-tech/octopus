import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { McpApprovalCoordinator } from '../domains/mcp/mcp-approval-coordinator.js'
import { canonicalizeMcpJson } from '../domains/mcp/mcp-broker-policy.js'
import {
  McpApprovalError,
  type McpApprovalScope,
  type McpApprovalView,
} from '../domains/mcp/mcp-approval.js'
import type {
  McpClientElicitationHandler,
  McpClientElicitationHandlerInput,
} from '../domains/mcp/mcp-client-manager.js'
import { McpElicitationCoordinator } from '../domains/mcp/mcp-elicitation-coordinator.js'
import {
  McpElicitationError,
  type McpElicitationFormSchema,
  type McpElicitationView,
} from '../domains/mcp/mcp-elicitation.js'
import { McpEvidenceStore } from '../domains/mcp/mcp-evidence-store.js'
import { isSafePathSegment, resolveExistingPathInside } from '../core/path-safety.js'
import {
  buildSessionRunAssignmentLocation,
  type SessionRunAssignmentLocation,
} from '../domains/run/run-location.js'

const DEFAULT_MAX_INTERACTIONS = 200
const MAX_INTERACTIONS = 1_000
const MAX_ASSIGNMENTS = 4_096

export type McpPublicInteractionView =
  | McpPublicApprovalInteraction
  | McpPublicElicitationInteraction

export interface McpPublicApprovalInteraction {
  readonly kind: 'approval'
  readonly interactionId: string
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly agentPath: string
  readonly serverId: string
  readonly toolCallId: string
  readonly namespacedToolName: string
  readonly toolRisk: McpApprovalView['toolRisk']
  readonly argumentNames: readonly string[]
  readonly status: McpApprovalView['status']
  readonly createdAt: string
  readonly expiresAt: string
  readonly resolvedAt?: string
  readonly decision?: 'approve' | 'deny'
  readonly approvalScope?: McpApprovalScope
}

interface McpPublicElicitationBase {
  readonly kind: 'elicitation'
  readonly interactionId: string
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly agentPath: string
  readonly serverId: string
  readonly toolCallId: string
  readonly namespacedToolName: string
  readonly message: string
  readonly status: McpElicitationView['status']
  readonly createdAt: string
  readonly expiresAt: string
  readonly resolvedAt?: string
  readonly action?: 'accept' | 'decline' | 'cancel'
}

export type McpPublicElicitationInteraction =
  | (McpPublicElicitationBase & {
      readonly mode: 'form'
      readonly schema: McpElicitationFormSchema
    })
  | (McpPublicElicitationBase & {
      readonly mode: 'url'
      readonly url: string
      readonly elicitationId: string
    })

export type McpInteractionResponse =
  | {
      readonly kind: 'approval'
      readonly decision: 'approve'
      readonly scope: McpApprovalScope
    }
  | {
      readonly kind: 'approval'
      readonly decision: 'deny'
    }
  | {
      readonly kind: 'elicitation'
      readonly action: 'accept'
      readonly values?: unknown
    }
  | {
      readonly kind: 'elicitation'
      readonly action: 'decline' | 'cancel'
    }

export interface McpInteractionListResult {
  readonly interactions: readonly McpPublicInteractionView[]
  readonly truncated: boolean
}

export type McpInteractionServiceErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'capacity_exceeded'
  | 'storage_invalid'

export class McpInteractionServiceError extends Error {
  constructor(readonly code: McpInteractionServiceErrorCode) {
    super(interactionServiceErrorMessage(code))
    this.name = 'McpInteractionServiceError'
  }
}

export interface McpInteractionServiceOptions {
  readonly workspacePath: string
  readonly approvalCoordinator?: McpApprovalCoordinator
  readonly elicitationCoordinator?: McpElicitationCoordinator
  readonly approvalWaitTimeoutMs?: number
  readonly elicitationWaitTimeoutMs?: number
}

/** Session-facing interaction registry; all exact bindings remain parent-only. */
export class McpInteractionService {
  readonly approvalCoordinator: McpApprovalCoordinator
  readonly elicitationCoordinator: McpElicitationCoordinator
  readonly handleElicitation: McpClientElicitationHandler
  private readonly workspacePath: string

  constructor(options: McpInteractionServiceOptions) {
    if (!options || typeof options.workspacePath !== 'string') {
      throw new McpInteractionServiceError('invalid_request')
    }
    this.workspacePath = path.resolve(options.workspacePath)
    this.approvalCoordinator = options.approvalCoordinator ??
      new McpApprovalCoordinator({
        workspacePath: this.workspacePath,
        ...(options.approvalWaitTimeoutMs !== undefined
          ? { waitTimeoutMs: options.approvalWaitTimeoutMs }
          : {}),
      })
    this.elicitationCoordinator = options.elicitationCoordinator ??
      new McpElicitationCoordinator({
        workspacePath: this.workspacePath,
        ...(options.elicitationWaitTimeoutMs !== undefined
          ? { waitTimeoutMs: options.elicitationWaitTimeoutMs }
          : {}),
        onInteractionCreated: (interaction) =>
          this.appendElicitationAudit(interaction, 'requested'),
        onInteractionResolved: (interaction) =>
          this.appendElicitationAudit(interaction, 'resolved'),
      })
    this.handleElicitation = (input: McpClientElicitationHandlerInput) =>
      this.elicitationCoordinator.requestElicitation(input)
  }

  async listSession(
    sessionId: string,
    options: { readonly includeResolved?: boolean; readonly limit?: number } = {},
  ): Promise<McpInteractionListResult> {
    const limit = normalizeLimit(options.limit)
    const scopes = await this.listAssignmentScopes(sessionId)
    const interactions: McpPublicInteractionView[] = []
    for (const scope of scopes) {
      const [approvals, elicitations] = await Promise.all([
        this.approvalCoordinator.list(scope),
        this.elicitationCoordinator.list(scope),
      ])
      interactions.push(
        ...approvals.map(publicApprovalView),
        ...elicitations.map(publicElicitationView),
      )
    }
    const filtered = options.includeResolved
      ? interactions
      : interactions.filter((interaction) => interaction.status === 'pending')
    filtered.sort(compareInteractions)
    return {
      interactions: filtered.slice(0, limit),
      truncated: filtered.length > limit,
    }
  }

  async respond(
    sessionId: string,
    interactionId: string,
    response: McpInteractionResponse,
  ): Promise<McpPublicInteractionView> {
    const match = await this.findInteraction(sessionId, interactionId)
    const responseId = stableResponseId(interactionId, response)
    try {
      if (match.kind === 'approval') {
        if (response.kind !== 'approval') {
          throw new McpInteractionServiceError('conflict')
        }
        const resolved = response.decision === 'approve'
          ? await this.approvalCoordinator.respond(match.scope, {
              interactionId,
              responseId,
              decision: 'approve',
              scope: response.scope,
            })
          : await this.approvalCoordinator.respond(match.scope, {
              interactionId,
              responseId,
              decision: 'deny',
            })
        return publicApprovalView(resolved)
      }

      if (response.kind !== 'elicitation') {
        throw new McpInteractionServiceError('conflict')
      }
      const resolved = await this.elicitationCoordinator.respond(match.scope, {
        interactionId,
        responseId,
        action: response.action,
        ...(response.action === 'accept' && 'values' in response
          ? { values: response.values }
          : {}),
      })
      return publicElicitationView(resolved)
    } catch (error) {
      throw normalizeInteractionError(error)
    }
  }

  private async findInteraction(
    sessionId: string,
    interactionId: string,
  ): Promise<
    | {
        readonly kind: 'approval'
        readonly scope: InteractionScope
      }
    | {
        readonly kind: 'elicitation'
        readonly scope: InteractionScope
      }
  > {
    if (!isIdentifier(interactionId)) {
      throw new McpInteractionServiceError('invalid_request')
    }
    const matches: Array<{
      readonly kind: 'approval' | 'elicitation'
      readonly scope: InteractionScope
    }> = []
    for (const scope of await this.listAssignmentScopes(sessionId)) {
      const [approval, elicitation] = await Promise.all([
        this.approvalCoordinator.get(scope, interactionId),
        this.elicitationCoordinator.get(scope, interactionId),
      ])
      if (approval) matches.push({ kind: 'approval', scope })
      if (elicitation) matches.push({ kind: 'elicitation', scope })
      if (matches.length > 1) {
        throw new McpInteractionServiceError('conflict')
      }
    }
    const match = matches[0]
    if (!match) throw new McpInteractionServiceError('not_found')
    return match
  }

  private async appendElicitationAudit(
    interaction: McpElicitationView,
    phase: 'requested' | 'resolved',
  ): Promise<void> {
    const store = new McpEvidenceStore({
      workspacePath: this.workspacePath,
      sessionId: interaction.sessionId,
      runId: interaction.runId,
      assignmentId: interaction.assignmentId,
    })
    const base = {
      timestamp: phase === 'resolved'
        ? interaction.resolvedAt ?? new Date().toISOString()
        : interaction.createdAt,
      sessionId: interaction.sessionId,
      runId: interaction.runId,
      assignmentId: interaction.assignmentId,
      agentPath: interaction.agentPath,
      serverId: interaction.serverId,
      requestId: interaction.parentRequestId,
      toolCallId: interaction.toolCallId,
      namespacedToolName: interaction.namespacedToolName,
      interactionId: interaction.interactionId,
      elicitationMode: interaction.mode,
    } as const
    if (phase === 'requested') {
      await store.appendAuditEvent({
        ...base,
        type: 'mcp.elicitation.requested',
      })
      return
    }
    if (interaction.status === 'pending') return
    await store.appendAuditEvent({
      ...base,
      type: 'mcp.elicitation.resolved',
      elicitationStatus: interaction.status,
      ...(interaction.action
        ? { elicitationAction: interaction.action }
        : {}),
    })
  }

  private async listAssignmentScopes(
    sessionId: string,
  ): Promise<InteractionScope[]> {
    if (!isSafePathSegment(sessionId)) {
      throw new McpInteractionServiceError('invalid_request')
    }
    const sessionPath = path.join(this.workspacePath, 'sessions', sessionId)
    const runsPath = path.join(sessionPath, 'runs')
    const runsStat = await fs.lstat(runsPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!runsStat) return []
    if (
      !runsStat.isDirectory() ||
      runsStat.isSymbolicLink() ||
      !resolveExistingPathInside(sessionPath, runsPath)
    ) {
      throw new McpInteractionServiceError('storage_invalid')
    }

    const scopes: InteractionScope[] = []
    const runEntries = await fs.readdir(runsPath, { withFileTypes: true })
    for (const runEntry of runEntries) {
      if (!runEntry.isDirectory() || !isSafePathSegment(runEntry.name)) continue
      const assignmentsPath = path.join(runsPath, runEntry.name, 'assignments')
      const assignmentEntries = await fs.readdir(assignmentsPath, {
        withFileTypes: true,
      }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      })
      for (const assignmentEntry of assignmentEntries) {
        if (
          !assignmentEntry.isDirectory() ||
          !isSafePathSegment(assignmentEntry.name)
        ) {
          continue
        }
        const location = buildSessionRunAssignmentLocation(this.workspacePath, {
          sessionId,
          runId: runEntry.name,
          assignmentId: assignmentEntry.name,
        })
        if (!location || !isCanonicalAssignment(location)) continue
        scopes.push({
          sessionId,
          runId: runEntry.name,
          assignmentId: assignmentEntry.name,
        })
        if (scopes.length > MAX_ASSIGNMENTS) {
          throw new McpInteractionServiceError('capacity_exceeded')
        }
      }
    }
    return scopes.sort((left, right) => scopeKey(left).localeCompare(scopeKey(right)))
  }
}

type InteractionScope = {
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
}

function publicApprovalView(view: McpApprovalView): McpPublicApprovalInteraction {
  return {
    kind: 'approval',
    interactionId: view.interactionId,
    sessionId: view.sessionId,
    runId: view.runId,
    assignmentId: view.assignmentId,
    agentPath: view.agentPath,
    serverId: view.serverId,
    toolCallId: view.toolCallId,
    namespacedToolName: view.namespacedToolName,
    toolRisk: view.toolRisk,
    argumentNames: [...view.argumentNames],
    status: view.status,
    createdAt: view.createdAt,
    expiresAt: view.expiresAt,
    ...(view.resolvedAt ? { resolvedAt: view.resolvedAt } : {}),
    ...(view.decision ? { decision: view.decision } : {}),
    ...(view.approvalScope ? { approvalScope: view.approvalScope } : {}),
  }
}

function publicElicitationView(
  view: McpElicitationView,
): McpPublicElicitationInteraction {
  const base: McpPublicElicitationBase = {
    kind: 'elicitation',
    interactionId: view.interactionId,
    sessionId: view.sessionId,
    runId: view.runId,
    assignmentId: view.assignmentId,
    agentPath: view.agentPath,
    serverId: view.serverId,
    toolCallId: view.toolCallId,
    namespacedToolName: view.namespacedToolName,
    message: view.message,
    status: view.status,
    createdAt: view.createdAt,
    expiresAt: view.expiresAt,
    ...(view.resolvedAt ? { resolvedAt: view.resolvedAt } : {}),
    ...(view.action ? { action: view.action } : {}),
  }
  return view.mode === 'form'
    ? { ...base, mode: 'form', schema: view.schema }
    : {
        ...base,
        mode: 'url',
        url: view.url,
        elicitationId: view.elicitationId,
      }
}

function stableResponseId(
  interactionId: string,
  response: McpInteractionResponse,
): string {
  let encoded: string
  try {
    encoded = canonicalizeMcpJson(response)
  } catch {
    throw new McpInteractionServiceError('invalid_request')
  }
  return `mcp_response_${createHash('sha256')
    .update(interactionId, 'utf8')
    .update('\0')
    .update(encoded, 'utf8')
    .digest('hex')}`
}

function compareInteractions(
  left: McpPublicInteractionView,
  right: McpPublicInteractionView,
): number {
  return right.createdAt.localeCompare(left.createdAt) ||
    right.interactionId.localeCompare(left.interactionId)
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_INTERACTIONS
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_INTERACTIONS) {
    throw new McpInteractionServiceError('invalid_request')
  }
  return value
}

function isCanonicalAssignment(
  location: SessionRunAssignmentLocation,
): boolean {
  return Boolean(
    resolveExistingPathInside(location.runPath, location.assignmentPath),
  )
}

function isIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !/[\0-\x1f\x7f]/.test(value)
  )
}

function scopeKey(scope: InteractionScope): string {
  return `${scope.sessionId}\0${scope.runId}\0${scope.assignmentId}`
}

function normalizeInteractionError(error: unknown): McpInteractionServiceError {
  if (error instanceof McpInteractionServiceError) return error
  if (error instanceof McpApprovalError || error instanceof McpElicitationError) {
    switch (error.code) {
      case 'invalid_request':
        return new McpInteractionServiceError('invalid_request')
      case 'not_found':
        return new McpInteractionServiceError('not_found')
      case 'capacity_exceeded':
        return new McpInteractionServiceError('capacity_exceeded')
      case 'storage_invalid':
        return new McpInteractionServiceError('storage_invalid')
      default:
        return new McpInteractionServiceError('conflict')
    }
  }
  return new McpInteractionServiceError('storage_invalid')
}

function interactionServiceErrorMessage(
  code: McpInteractionServiceErrorCode,
): string {
  switch (code) {
    case 'invalid_request':
      return 'The MCP interaction request is invalid.'
    case 'not_found':
      return 'The MCP interaction was not found.'
    case 'conflict':
      return 'The MCP interaction has already changed.'
    case 'capacity_exceeded':
      return 'Too many MCP interactions are stored for this session.'
    default:
      return 'MCP interaction storage is unavailable.'
  }
}
