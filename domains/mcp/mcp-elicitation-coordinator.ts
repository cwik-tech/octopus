import { createHash } from 'node:crypto'

import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js'

import {
  McpElicitationError,
  normalizeMcpElicitationFormSchema,
  normalizeMcpElicitationMessage,
  normalizeMcpElicitationUrl,
  type McpElicitationAssignmentScope,
  type McpElicitationExactBinding,
  type McpElicitationFormValues,
  type McpElicitationResponseResult,
  type McpElicitationView,
} from './mcp-elicitation.js'
import { McpElicitationStore } from './mcp-elicitation-store.js'
import type { McpClientElicitationHandlerInput } from './mcp-client-manager.js'

export const DEFAULT_MCP_ELICITATION_WAIT_TIMEOUT_MS = 5 * 60 * 1_000
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000

export type McpElicitationCoordinatorScope = McpElicitationAssignmentScope

export interface McpElicitationCoordinatorResponse {
  readonly interactionId: string
  readonly responseId: string
  readonly action: 'accept' | 'decline' | 'cancel'
  readonly values?: unknown
}

export interface McpElicitationCoordinatorOptions {
  readonly workspacePath: string
  readonly now?: () => number
  readonly waitTimeoutMs?: number
  readonly storeFactory?: (
    scope: McpElicitationCoordinatorScope,
  ) => McpElicitationStore
  readonly onInteractionCreated?: (
    interaction: McpElicitationView,
  ) => void | Promise<void>
  readonly onInteractionResolved?: (
    interaction: McpElicitationView,
  ) => void | Promise<void>
}

interface StoreEntry {
  readonly store: McpElicitationStore
  readonly recovered: readonly McpElicitationView[]
  recoveryReported: boolean
}

interface PendingResolution {
  readonly promise: Promise<McpElicitationResponseResult>
  resolve(result: McpElicitationResponseResult): void
}

/** Parent-owned bridge from MCP protocol requests to redacted user interactions. */
export class McpElicitationCoordinator {
  readonly waitTimeoutMs: number
  private readonly storeFactory: (
    scope: McpElicitationCoordinatorScope,
  ) => McpElicitationStore
  private readonly stores = new Map<string, Promise<StoreEntry>>()
  private readonly bindings = new Map<string, McpElicitationExactBinding>()
  private readonly pending = new Map<string, PendingResolution>()

  constructor(private readonly options: McpElicitationCoordinatorOptions) {
    if (!options || typeof options.workspacePath !== 'string') {
      throw new McpElicitationError('invalid_request')
    }
    this.waitTimeoutMs = boundedDuration(
      options.waitTimeoutMs,
      DEFAULT_MCP_ELICITATION_WAIT_TIMEOUT_MS,
    )
    this.storeFactory = options.storeFactory ?? ((scope) =>
      new McpElicitationStore({
        workspacePath: options.workspacePath,
        ...scope,
        ...(options.now ? { now: options.now } : {}),
      }))
  }

  async requestElicitation(
    input: McpClientElicitationHandlerInput,
  ): Promise<ElicitResult> {
    const scope = scopeFromInput(input)
    const entry = await this.storeEntry(scope)
    const normalized = normalizeProtocolRequest(input.request)
    const binding: McpElicitationExactBinding = {
      interactionId: stableInteractionId(input, normalized),
      ...scope,
      agentPath: input.context.agentPath,
      serverId: input.serverId,
      parentRequestId: input.context.requestId,
      toolCallId: input.toolCallId,
      namespacedToolName: input.namespacedToolName,
    }
    const key = interactionKey(scope, binding.interactionId)
    this.bindings.set(key, binding)

    const existingPending = this.pending.get(key)
    if (existingPending) {
      return this.waitForResult(
        entry.store,
        binding,
        existingPending,
        input.signal,
      )
    }
    const pending = createPendingResolution()
    this.pending.set(key, pending)

    try {
      const interaction = await entry.store.createRequest(
        normalized.mode === 'form'
          ? {
              ...binding,
              mode: 'form',
              message: normalized.message,
              schema: normalized.schema,
              ttlMs: this.waitTimeoutMs,
            }
          : {
              ...binding,
              mode: 'url',
              message: normalized.message,
              url: normalized.url,
              elicitationId: normalized.elicitationId,
              ttlMs: this.waitTimeoutMs,
            },
      )
      try {
        await this.options.onInteractionCreated?.(interaction)
      } catch (error) {
        await this.cancelPending(entry.store, binding, 'audit-failed')
        throw error
      }
      if (interaction.status !== 'pending') {
        throw new McpElicitationError('already_resolved')
      }
      return await this.waitForResult(
        entry.store,
        binding,
        pending,
        input.signal,
      )
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key)
    }
  }

  async list(
    scope: McpElicitationCoordinatorScope,
  ): Promise<readonly McpElicitationView[]> {
    return (await this.storeEntry(scope)).store.list()
  }

  async get(
    scope: McpElicitationCoordinatorScope,
    interactionId: string,
  ): Promise<McpElicitationView | null> {
    return (await this.storeEntry(scope)).store.get(interactionId)
  }

  async respond(
    scope: McpElicitationCoordinatorScope,
    response: McpElicitationCoordinatorResponse,
  ): Promise<McpElicitationView> {
    const entry = await this.storeEntry(scope)
    const binding = this.requireBinding(scope, response.interactionId)
    const current = await entry.store.get(response.interactionId)
    if (!current) throw new McpElicitationError('not_found')

    const result = current.mode === 'form'
      ? response.action === 'accept'
        ? await entry.store.respond({
            ...binding,
            responseId: response.responseId,
            mode: 'form',
            action: 'accept',
            values: response.values,
          })
        : await entry.store.respond({
            ...binding,
            responseId: response.responseId,
            mode: 'form',
            action: response.action,
          })
      : await entry.store.respond({
          ...binding,
          responseId: response.responseId,
          mode: 'url',
          elicitationId: current.elicitationId,
          action: response.action,
        })

    this.pending.get(interactionKey(scope, response.interactionId))?.resolve(
      result,
    )
    await this.options.onInteractionResolved?.(result.view)
    return result.view
  }

  async recoverPendingAfterRestart(
    scope: McpElicitationCoordinatorScope,
  ): Promise<readonly McpElicitationView[]> {
    const entry = await this.storeEntry(scope)
    if (entry.recoveryReported) return []
    entry.recoveryReported = true
    return entry.recovered
  }

  private async waitForResult(
    store: McpElicitationStore,
    binding: McpElicitationExactBinding,
    pending: PendingResolution,
    callerSignal: AbortSignal,
  ): Promise<ElicitResult> {
    const timeoutSignal = AbortSignal.timeout(this.waitTimeoutMs)
    const signal = AbortSignal.any([callerSignal, timeoutSignal])
    const timeoutKeepAlive = setTimeout(() => undefined, this.waitTimeoutMs)
    try {
      const result = await Promise.race([
        pending.promise,
        waitForAbort(signal).then(async () => {
          if (callerSignal.aborted) {
            return this.cancelPending(store, binding, 'caller-cancelled')
          }
          await store.expirePending()
          const current = await store.get(binding.interactionId)
          if (current?.status === 'expired') {
            await this.options.onInteractionResolved?.(current)
            return { view: current }
          }
          return this.cancelPending(store, binding, 'interaction-timeout')
        }),
      ])
      return protocolResult(result)
    } finally {
      clearTimeout(timeoutKeepAlive)
    }
  }

  private async cancelPending(
    store: McpElicitationStore,
    binding: McpElicitationExactBinding,
    reason: string,
  ): Promise<McpElicitationResponseResult> {
    const current = await store.get(binding.interactionId)
    if (!current || current.status !== 'pending') {
      if (!current) throw new McpElicitationError('not_found')
      return { view: current }
    }
    const responseId = stableInternalResponseId(binding.interactionId, reason)
    let result: McpElicitationResponseResult
    try {
      result = current.mode === 'form'
        ? await store.respond({
            ...binding,
            responseId,
            mode: 'form',
            action: 'cancel',
          })
        : await store.respond({
            ...binding,
            responseId,
            mode: 'url',
            elicitationId: current.elicitationId,
            action: 'cancel',
          })
    } catch (error) {
      // The TTL can win while cancellation waits for the store lock. Both
      // outcomes map to protocol-level cancellation, so return the now-durable
      // expired record instead of leaking an internal race to the MCP caller.
      if (!(error instanceof McpElicitationError) || error.code !== 'expired') {
        throw error
      }
      const expired = await store.get(binding.interactionId)
      if (!expired || expired.status !== 'expired') throw error
      result = { view: expired }
    }
    await this.options.onInteractionResolved?.(result.view)
    return result
  }

  private requireBinding(
    scope: McpElicitationCoordinatorScope,
    interactionId: string,
  ): McpElicitationExactBinding {
    const binding = this.bindings.get(interactionKey(scope, interactionId))
    if (!binding) throw new McpElicitationError('not_found')
    return binding
  }

  private storeEntry(scope: McpElicitationCoordinatorScope): Promise<StoreEntry> {
    const key = scopeKey(scope)
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

type NormalizedProtocolRequest =
  | {
      readonly mode: 'form'
      readonly message: string
      readonly schema: ReturnType<typeof normalizeMcpElicitationFormSchema>
    }
  | {
      readonly mode: 'url'
      readonly message: string
      readonly url: string
      readonly elicitationId: string
    }

function normalizeProtocolRequest(
  request: ElicitRequest['params'],
): NormalizedProtocolRequest {
  const message = normalizeMcpElicitationMessage(request.message)
  if (request.mode === 'url') {
    return {
      mode: 'url',
      message,
      url: normalizeMcpElicitationUrl(request.url),
      elicitationId: requireIdentifier(request.elicitationId),
    }
  }
  return {
    mode: 'form',
    message,
    schema: normalizeMcpElicitationFormSchema(request.requestedSchema),
  }
}

function scopeFromInput(
  input: McpClientElicitationHandlerInput,
): McpElicitationCoordinatorScope {
  return {
    sessionId: input.context.sessionId,
    runId: input.context.runId,
    assignmentId: input.context.assignmentId,
  }
}

function stableInteractionId(
  input: McpClientElicitationHandlerInput,
  request: NormalizedProtocolRequest,
): string {
  const digest = createHash('sha256')
  for (const value of [
    input.context.sessionId,
    input.context.runId,
    input.context.assignmentId,
    input.context.agentPath,
    input.serverId,
    input.context.requestId,
    input.toolCallId,
    input.namespacedToolName,
    request.mode,
    JSON.stringify(request),
  ]) {
    digest.update(value, 'utf8')
    digest.update('\0')
  }
  return `mcp_elicitation_${digest.digest('hex')}`
}

function stableInternalResponseId(interactionId: string, reason: string): string {
  return `mcp_response_${createHash('sha256')
    .update(interactionId, 'utf8')
    .update('\0')
    .update(reason, 'utf8')
    .digest('hex')}`
}

function protocolResult(result: McpElicitationResponseResult): ElicitResult {
  if (
    result.view.mode === 'form' &&
    result.view.action === 'accept' &&
    'values' in result
  ) {
    return {
      action: 'accept',
      content: result.values as Record<
        string,
        string | number | boolean | string[]
      >,
    }
  }
  if (result.view.action === 'accept') return { action: 'accept' }
  if (result.view.action === 'decline') return { action: 'decline' }
  return { action: 'cancel' }
}

function createPendingResolution(): PendingResolution {
  let resolve!: (result: McpElicitationResponseResult) => void
  const promise = new Promise<McpElicitationResponseResult>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

function boundedDuration(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (
    !Number.isSafeInteger(resolved) ||
    resolved <= 0 ||
    resolved > MAX_WAIT_TIMEOUT_MS
  ) {
    throw new McpElicitationError('invalid_request')
  }
  return resolved
}

function requireIdentifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\0-\x1f\x7f]/.test(value)
  ) {
    throw new McpElicitationError('invalid_request')
  }
  return value
}

function interactionKey(
  scope: McpElicitationCoordinatorScope,
  interactionId: string,
): string {
  return `${scopeKey(scope)}\0${interactionId}`
}

function scopeKey(scope: McpElicitationCoordinatorScope): string {
  return `${scope.sessionId}\0${scope.runId}\0${scope.assignmentId}`
}
