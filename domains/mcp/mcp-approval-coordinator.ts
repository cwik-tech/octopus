import { whenDefined } from '../../core/optional-properties.js'
import { createHash } from 'node:crypto'

import {
  McpApprovalError,
  hashMcpApprovalArguments,
  type McpApprovalAssignmentScope,
  type McpApprovalExactBinding,
  type McpApprovalScope,
  type McpApprovalView,
} from './mcp-approval.js'
import { McpApprovalStore } from './mcp-approval-store.js'
import type {
  McpBrokerRequestContext,
  McpJsonObject,
  McpToolRisk,
} from './mcp-runtime.js'

export const DEFAULT_MCP_APPROVAL_WAIT_TIMEOUT_MS = 5 * 60 * 1_000
const DEFAULT_POLL_INTERVAL_MS = 1_000
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000

export type McpApprovalCoordinatorScope = McpApprovalAssignmentScope

export interface McpApprovalCoordinatorRequest {
  readonly context: McpBrokerRequestContext
  readonly serverId: string
  readonly namespacedToolName: string
  readonly toolCallId: string
  readonly toolRisk: McpToolRisk
  /** Ephemeral only. Values are hashed before any asynchronous wait begins. */
  readonly arguments: McpJsonObject
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly onInteraction?: (
    interaction: McpApprovalView,
  ) => void | Promise<void>
}

export interface McpApprovalCoordinatorResponse {
  readonly interactionId: string
  readonly responseId: string
  readonly decision: 'approve' | 'deny'
  readonly scope?: McpApprovalScope
}

export type McpApprovalCoordinatorOutcome =
  | 'approved'
  | 'denied'
  | 'cancelled'
  | 'expired'
  | 'interrupted'

export interface McpApprovalCoordinatorDecision {
  readonly outcome: McpApprovalCoordinatorOutcome
  readonly interaction: McpApprovalView
  readonly reused: boolean
}

export type McpApprovalStoreFactory = (
  scope: McpApprovalCoordinatorScope,
) => McpApprovalStore

export interface McpApprovalCoordinatorOptions {
  readonly workspacePath: string
  readonly now?: () => number
  readonly waitTimeoutMs?: number
  readonly pollIntervalMs?: number
  readonly storeFactory?: McpApprovalStoreFactory
}

interface StoreEntry {
  readonly store: McpApprovalStore
  readonly recovered: readonly McpApprovalView[]
  recoveryReported: boolean
}

/**
 * Parent-owned bridge between redacted interaction APIs and the store's exact
 * digest binding. Raw argument values are never retained on the coordinator.
 */
export class McpApprovalCoordinator {
  readonly waitTimeoutMs: number
  private readonly pollIntervalMs: number
  private readonly storeFactory: McpApprovalStoreFactory
  private readonly stores = new Map<string, Promise<StoreEntry>>()
  private readonly bindings = new Map<string, McpApprovalExactBinding>()
  private readonly waiters = new Map<string, Set<() => void>>()
  private readonly notificationVersions = new Map<string, number>()

  constructor(options: McpApprovalCoordinatorOptions) {
    if (!options || typeof options.workspacePath !== 'string') {
      throw new McpApprovalError('invalid_request')
    }
    this.waitTimeoutMs = boundedDuration(
      options.waitTimeoutMs,
      DEFAULT_MCP_APPROVAL_WAIT_TIMEOUT_MS,
      MAX_WAIT_TIMEOUT_MS,
    )
    this.pollIntervalMs = boundedDuration(
      options.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
      1_000,
    )
    this.storeFactory = options.storeFactory ?? ((scope) =>
      new McpApprovalStore({
        workspacePath: options.workspacePath,
        ...scope,
        ...(options.now ? { now: options.now } : {}),
      }))
  }

  async requestApproval(
    input: McpApprovalCoordinatorRequest,
  ): Promise<McpApprovalCoordinatorDecision> {
    const timeoutMs = boundedDuration(
      input.timeoutMs,
      this.waitTimeoutMs,
      MAX_WAIT_TIMEOUT_MS,
    )
    const scope = scopeFromContext(input.context)
    const entry = await this.storeEntry(scope)
    const argumentSummary = hashMcpApprovalArguments(input.arguments)
    const reusable = await entry.store.findReusableRunApproval({
      ...scope,
      agentPath: input.context.agentPath,
      serverId: input.serverId,
      namespacedToolName: input.namespacedToolName,
      toolRisk: input.toolRisk,
    })
    const reusableBinding = reusable
      ? this.bindings.get(coordinatorBindingKey(scope, reusable.interactionId))
      : undefined
    if (
      reusable &&
      reusableBinding?.argumentsHash.algorithm ===
        argumentSummary.argumentsHash.algorithm &&
      reusableBinding.argumentsHash.value === argumentSummary.argumentsHash.value
    ) {
      await input.onInteraction?.(reusable)
      return { outcome: 'approved', interaction: reusable, reused: true }
    }

    const exactBinding: McpApprovalExactBinding = {
      ...scope,
      agentPath: input.context.agentPath,
      serverId: input.serverId,
      namespacedToolName: input.namespacedToolName,
      toolCallId: input.toolCallId,
      toolRisk: input.toolRisk,
      argumentsHash: { ...argumentSummary.argumentsHash },
    }
    const interactionId = stableInteractionId(exactBinding)
    const bindingKey = coordinatorBindingKey(scope, interactionId)
    this.bindings.set(bindingKey, exactBinding)

    const interaction = await entry.store.createRequest({
      interactionId,
      ...scope,
      agentPath: input.context.agentPath,
      serverId: input.serverId,
      namespacedToolName: input.namespacedToolName,
      toolCallId: input.toolCallId,
      toolRisk: input.toolRisk,
      arguments: input.arguments,
      ttlMs: timeoutMs,
    })
    try {
      await input.onInteraction?.(interaction)
    } catch (error) {
      await this.cancelExact(entry.store, exactBinding, interactionId)
      throw error
    }
    const terminal = terminalDecision(interaction, false)
    if (terminal) return terminal
    return this.waitForDecision({
      store: entry.store,
      exactBinding,
      interactionId,
      timeoutMs,
      ...whenDefined(input.signal, (definedValue) => ({ signal: definedValue })),
    })
  }

  async list(
    scope: McpApprovalCoordinatorScope,
  ): Promise<readonly McpApprovalView[]> {
    return (await this.storeEntry(scope)).store.list()
  }

  async get(
    scope: McpApprovalCoordinatorScope,
    interactionId: string,
  ): Promise<McpApprovalView | null> {
    return (await this.storeEntry(scope)).store.get(interactionId)
  }

  async respond(
    scope: McpApprovalCoordinatorScope,
    response: McpApprovalCoordinatorResponse,
  ): Promise<McpApprovalView> {
    const entry = await this.storeEntry(scope)
    const binding = this.requireBinding(scope, response.interactionId)
    if (response.decision === 'approve') {
      if (response.scope !== 'once' && response.scope !== 'run') {
        throw new McpApprovalError('invalid_request')
      }
      const resolved = await entry.store.respond({
        ...binding,
        interactionId: response.interactionId,
        responseId: response.responseId,
        decision: 'approve',
        scope: response.scope,
      })
      this.notify(scope, response.interactionId)
      return resolved
    }
    if (response.decision !== 'deny' || response.scope !== undefined) {
      throw new McpApprovalError('invalid_request')
    }
    const resolved = await entry.store.respond({
      ...binding,
      interactionId: response.interactionId,
      responseId: response.responseId,
      decision: 'deny',
    })
    this.notify(scope, response.interactionId)
    return resolved
  }

  async cancel(
    scope: McpApprovalCoordinatorScope,
    interactionId: string,
  ): Promise<McpApprovalView> {
    const entry = await this.storeEntry(scope)
    const binding = this.requireBinding(scope, interactionId)
    const cancelled = await entry.store.cancel({ ...binding, interactionId })
    this.notify(scope, interactionId)
    return cancelled
  }

  async recoverPendingAfterRestart(
    scope: McpApprovalCoordinatorScope,
  ): Promise<readonly McpApprovalView[]> {
    const entry = await this.storeEntry(scope)
    if (entry.recoveryReported) return []
    entry.recoveryReported = true
    return entry.recovered
  }

  private async waitForDecision(params: {
    readonly store: McpApprovalStore
    readonly exactBinding: McpApprovalExactBinding
    readonly interactionId: string
    readonly timeoutMs: number
    readonly signal?: AbortSignal
  }): Promise<McpApprovalCoordinatorDecision> {
    const timeoutSignal = AbortSignal.timeout(params.timeoutMs)
    const signal = params.signal
      ? AbortSignal.any([params.signal, timeoutSignal])
      : timeoutSignal
    const bindingKey = coordinatorBindingKey(
      {
        sessionId: params.exactBinding.sessionId,
        runId: params.exactBinding.runId,
        assignmentId: params.exactBinding.assignmentId,
      },
      params.interactionId,
    )
    while (true) {
      const notificationVersion = this.notificationVersions.get(bindingKey) ?? 0
      const current = await params.store.get(params.interactionId)
      if (!current) throw new McpApprovalError('not_found')
      const terminal = terminalDecision(current, false)
      if (terminal) return terminal
      if (signal.aborted) {
        if (params.signal?.aborted) {
          const cancelled = await this.cancelExact(
            params.store,
            params.exactBinding,
            params.interactionId,
          )
          return terminalDecision(cancelled, false) ?? {
            outcome: 'cancelled',
            interaction: cancelled,
            reused: false,
          }
        }
        await params.store.expirePending()
        const expired = await params.store.get(params.interactionId)
        if (!expired) throw new McpApprovalError('not_found')
        const expiredDecision = terminalDecision(expired, false)
        if (expiredDecision) return expiredDecision
        const cancelled = await this.cancelExact(
          params.store,
          params.exactBinding,
          params.interactionId,
        )
        return {
          outcome: 'expired',
          interaction: cancelled,
          reused: false,
        }
      }
      await this.waitForChange(
        bindingKey,
        signal,
        notificationVersion,
      )
    }
  }

  private async cancelExact(
    store: McpApprovalStore,
    binding: McpApprovalExactBinding,
    interactionId: string,
  ): Promise<McpApprovalView> {
    try {
      return await store.cancel({ ...binding, interactionId })
    } catch (error) {
      if (
        error instanceof McpApprovalError &&
        (error.code === 'already_resolved' || error.code === 'expired')
      ) {
        const current = await store.get(interactionId)
        if (current) return current
      }
      throw error
    }
  }

  private requireBinding(
    scope: McpApprovalCoordinatorScope,
    interactionId: string,
  ): McpApprovalExactBinding {
    const binding = this.bindings.get(coordinatorBindingKey(scope, interactionId))
    if (!binding) throw new McpApprovalError('not_found')
    return binding
  }

  private notify(
    scope: McpApprovalCoordinatorScope,
    interactionId: string,
  ): void {
    const key = coordinatorBindingKey(scope, interactionId)
    this.notificationVersions.set(
      key,
      (this.notificationVersions.get(key) ?? 0) + 1,
    )
    const waiters = this.waiters.get(key)
    if (!waiters) return
    this.waiters.delete(key)
    for (const wake of waiters) wake()
  }

  private async waitForChange(
    key: string,
    signal: AbortSignal,
    observedVersion: number,
  ): Promise<void> {
    if (signal.aborted) return
    if ((this.notificationVersions.get(key) ?? 0) !== observedVersion) return
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        const waiters = this.waiters.get(key)
        waiters?.delete(finish)
        if (waiters?.size === 0) this.waiters.delete(key)
        resolve()
      }
      const timer = setTimeout(finish, this.pollIntervalMs)
      const waiters = this.waiters.get(key) ?? new Set<() => void>()
      waiters.add(finish)
      this.waiters.set(key, waiters)
      signal.addEventListener('abort', finish, { once: true })
      if (
        signal.aborted ||
        (this.notificationVersions.get(key) ?? 0) !== observedVersion
      ) {
        finish()
      }
    })
  }

  private storeEntry(scope: McpApprovalCoordinatorScope): Promise<StoreEntry> {
    const key = assignmentScopeKey(scope)
    const existing = this.stores.get(key)
    if (existing) return existing
    const created = Promise.resolve().then(async () => {
      const store = this.storeFactory({ ...scope })
      const recovered = await store.recoverPendingAfterRestart()
      return { store, recovered, recoveryReported: false }
    })
    this.stores.set(key, created)
    void created.catch(() => this.stores.delete(key))
    return created
  }
}

function scopeFromContext(
  context: McpBrokerRequestContext,
): McpApprovalCoordinatorScope {
  return {
    sessionId: context.sessionId,
    runId: context.runId,
    assignmentId: context.assignmentId,
  }
}

function stableInteractionId(binding: McpApprovalExactBinding): string {
  const digest = createHash('sha256')
  for (const value of [
    binding.sessionId,
    binding.runId,
    binding.assignmentId,
    binding.agentPath,
    binding.serverId,
    binding.namespacedToolName,
    binding.toolCallId,
    binding.toolRisk,
    binding.argumentsHash.algorithm,
    binding.argumentsHash.value,
  ]) {
    digest.update(value, 'utf8')
    digest.update('\0')
  }
  return `mcp_approval_${digest.digest('hex')}`
}

function terminalDecision(
  interaction: McpApprovalView,
  reused: boolean,
): McpApprovalCoordinatorDecision | null {
  switch (interaction.status) {
    case 'approved-once':
    case 'approved-run':
      return { outcome: 'approved', interaction, reused }
    case 'denied':
      return { outcome: 'denied', interaction, reused }
    case 'cancelled':
      return { outcome: 'cancelled', interaction, reused }
    case 'expired':
      return { outcome: 'expired', interaction, reused }
    case 'interrupted':
      return { outcome: 'interrupted', interaction, reused }
    default:
      return null
  }
}

function coordinatorBindingKey(
  scope: McpApprovalCoordinatorScope,
  interactionId: string,
): string {
  return `${assignmentScopeKey(scope)}\0${interactionId}`
}

function assignmentScopeKey(scope: McpApprovalCoordinatorScope): string {
  return `${scope.sessionId}\0${scope.runId}\0${scope.assignmentId}`
}

function boundedDuration(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new McpApprovalError('invalid_request')
  }
  return resolved
}
