import { randomUUID } from 'node:crypto'

import type {
  CapabilityAdapter,
  CapabilityApprovalPort,
  CapabilityAuthorizationPhase,
  CapabilityCompletionFence,
  CapabilityDispatchRequest,
  CapabilityDispatchResult,
  CapabilityDispatcherPorts,
  CapabilityEvidencePort,
  CapabilityInvocationBindingPort,
  CapabilityPolicyDecision,
  CapabilityPreparedExecution,
} from '../../contracts/capability-dispatch.js'
import { CapabilityDispatcher } from '../../core/capability-dispatcher.js'
import { mcpBrokerError } from './mcp-broker-policy.js'
import {
  MCP_SANITIZED_ERROR_CODES,
  MCP_RUNTIME_CONTRACT_VERSION,
  type McpBrokerCallRequest,
  type McpBrokerCallResult,
  type McpNamespacedTool,
  type McpSanitizedError,
  type McpSanitizedErrorCode,
} from './mcp-runtime.js'

export interface McpPreparedCapabilityExecution {
  readonly tool: McpNamespacedTool
  authorize(
    phase: CapabilityAuthorizationPhase,
  ): Promise<McpSanitizedError | null>
  execute(signal: AbortSignal): Promise<unknown>
  beginCompletion(): Promise<CapabilityCompletionFence>
  acceptResult(value: unknown): Promise<McpBrokerCallResult>
  release?(): void | Promise<void>
}

export interface McpCapabilityAdapterOptions {
  readonly request: McpBrokerCallRequest
  prepare(): Promise<McpPreparedCapabilityExecution>
}

export interface McpCapabilityDispatcherOptions {
  readonly approval: CapabilityApprovalPort
  readonly evidence?: CapabilityEvidencePort
  readonly durable?: CapabilityDispatcherPorts['durable']
  readonly teardown?: CapabilityDispatcherPorts['teardown']
  readonly now: () => Date
}

export class McpCapabilityStageError extends Error {
  constructor(
    readonly brokerError: McpSanitizedError,
    readonly brokerResult?: McpBrokerCallResult,
  ) {
    super('MCP capability stage failed.')
    this.name = 'McpCapabilityStageError'
  }
}

/**
 * Adapts one already-admitted MCP leader to the common capability stage
 * machine. BrokerCallRecord remains the collision, coalescing, and capacity
 * authority; this adapter intentionally owns no second admission record.
 */
export class McpCapabilityAdapter implements CapabilityAdapter {
  readonly capabilityId: string
  private exactResult: McpBrokerCallResult | undefined
  private exactError: McpSanitizedError | undefined

  constructor(private readonly options: McpCapabilityAdapterOptions) {
    this.capabilityId = options.request.namespacedToolName
  }

  async prepare(): Promise<CapabilityPreparedExecution> {
    let prepared: McpPreparedCapabilityExecution
    try {
      prepared = await this.options.prepare()
    } catch (error) {
      this.captureStageError(error)
      throw error
    }
    const requiresApproval = prepared.tool.requiresApproval
    return {
      effect: prepared.tool.effect,
      risk: prepared.tool.risk,
      argumentNames: Object.keys(this.options.request.arguments).sort(),
      policyDecision: requiresApproval
        ? {
            kind: 'require-approval',
            reason: 'MCP tool policy requires approval.',
          }
        : { kind: 'allow' },
      ...(requiresApproval
        ? {
            approval: {
              serverId: prepared.tool.serverId,
              namespacedToolName: prepared.tool.namespacedName,
              title: `Approve ${prepared.tool.serverName} tool`,
              description: prepared.tool.namespacedName,
            },
          }
        : {}),
      authorize: async ({ phase }) => {
        try {
          const error = await prepared.authorize(phase)
          if (!error) return { kind: 'allow' }
          this.exactError = error
          return denyDecision(error)
        } catch (error) {
          this.captureStageError(error)
          throw error
        }
      },
      execute: async ({ signal }) => {
        try {
          return await prepared.execute(signal)
        } catch (error) {
          this.captureStageError(error)
          throw error
        }
      },
      beginCompletion: async () => {
        try {
          return await prepared.beginCompletion()
        } catch (error) {
          this.captureStageError(error)
          throw error
        }
      },
      acceptResult: async ({ value }) => {
        try {
          const result = await prepared.acceptResult(value)
          this.exactResult = result
          if (result.isError) {
            const error = result.error ?? mcpBrokerError(
              'internal',
              true,
              this.options.request.context.requestId,
            )
            this.exactError = error
            throw new McpCapabilityStageError(error, result)
          }
          return { value: result }
        } catch (error) {
          this.captureStageError(error)
          throw error
        }
      },
      ...(prepared.release
        ? { release: () => prepared.release?.() }
        : {}),
    }
  }

  captureError(error: McpSanitizedError): void {
    this.exactError = error
  }

  toBrokerResult(dispatchResult: CapabilityDispatchResult): McpBrokerCallResult {
    if (
      this.exactResult &&
      (this.exactResult.isError || dispatchResult.status === 'completed')
    ) {
      return this.exactResult
    }
    const error =
      this.exactError ??
      errorFromDispatchResult(dispatchResult, this.options.request.context.requestId)
    return brokerFailure(this.options.request, error)
  }

  private captureStageError(error: unknown): void {
    if (!(error instanceof McpCapabilityStageError)) return
    this.exactError = error.brokerError
    if (error.brokerResult) this.exactResult = error.brokerResult
  }
}

export function createMcpCapabilityDispatcher(
  options: McpCapabilityDispatcherOptions,
): CapabilityDispatcher {
  return new CapabilityDispatcher({
    bindings: PRE_ADMITTED_BINDINGS,
    authority: {
      authorize: async () => ({ kind: 'allow' }),
    },
    policy: {
      evaluate: async () => ({ kind: 'allow' }),
    },
    budget: {
      preflight: async () => ({ kind: 'not-metered' }),
      reserve: async () => ({ reservationId: 'mcp-not-metered' }),
      settle: async () => ({ costTracked: false, budgetOverrun: false }),
      release: () => undefined,
    },
    approval: options.approval,
    evidence: options.evidence ?? NO_OP_EVIDENCE,
    scheduler: {
      run: async ({ signal, operation }) => {
        if (signal.aborted) throw abortReason(signal)
        return operation()
      },
    },
    clock: { now: () => options.now().getTime() },
    ids: { nextAttemptId: () => `mcp-attempt-${randomUUID()}` },
    ...(options.durable ? { durable: options.durable } : {}),
    ...(options.teardown ? { teardown: options.teardown } : {}),
  })
}

export function mcpCapabilityDispatchRequest(input: {
  readonly request: McpBrokerCallRequest
  readonly adapter: McpCapabilityAdapter
  readonly signal?: AbortSignal
}): CapabilityDispatchRequest {
  return {
    context: {
      contractVersion: 1,
      requestId: input.request.context.requestId,
      sessionId: input.request.context.sessionId,
      runId: input.request.context.runId,
      assignmentId: input.request.context.assignmentId,
      agentPath: input.request.context.agentPath,
      authority: {
        kind: 'mcp-lease',
        leaseId: input.request.context.leaseId,
      },
      ...(input.request.context.workflowId
        ? { workflowId: input.request.context.workflowId }
        : {}),
      ...(input.request.context.workflowStepId
        ? { workflowStepId: input.request.context.workflowStepId }
        : {}),
      ...(input.request.context.agentId
        ? { agentId: input.request.context.agentId }
        : {}),
      ...(input.request.context.agentDisplayName
        ? { agentDisplayName: input.request.context.agentDisplayName }
        : {}),
      ...(input.request.context.activityScopeId
        ? { activityScopeId: input.request.context.activityScopeId }
        : {}),
      ...(input.request.context.providerCallOrdinal === undefined
        ? {}
        : {
            providerCallOrdinal:
              input.request.context.providerCallOrdinal,
          }),
    },
    invocation: {
      capabilityId: input.request.namespacedToolName,
      source: { kind: 'mcp', id: 'mcp-parent-broker' },
      toolCallId: input.request.toolCallId,
      input: input.request.arguments,
    },
    adapter: input.adapter,
    ...(input.signal ? { signal: input.signal } : {}),
  }
}

const PRE_ADMITTED_BINDINGS: CapabilityInvocationBindingPort = {
  marker: 'capability-invocation-binding-port',
  acquire: () => ({
    kind: 'leader',
    complete: () => undefined,
    abandon: () => undefined,
  }),
  releaseScope: () => undefined,
}

const NO_OP_EVIDENCE: CapabilityEvidencePort = {
  append: () => undefined,
}

const MCP_ERROR_CODES = new Set<string>(MCP_SANITIZED_ERROR_CODES)

function denyDecision(error: McpSanitizedError): CapabilityPolicyDecision {
  return {
    kind: 'deny',
    code: error.code,
    reason: error.message,
    detail: error,
  }
}

function errorFromDispatchResult(
  result: CapabilityDispatchResult,
  requestId: string,
): McpSanitizedError {
  if (result.status === 'rejected' && isMcpSanitizedError(result.detail)) {
    return result.detail
  }
  if (result.status !== 'completed') {
    switch (result.code) {
      case 'approval_unavailable':
      case 'approval_required':
        return mcpBrokerError('approval_required', false, requestId)
      case 'approval_denied':
        return mcpBrokerError('approval_denied', false, requestId)
      case 'approval_expired':
      case 'deadline_exceeded':
        return mcpBrokerError('timeout', true, requestId)
      case 'approval_cancelled':
      case 'approval_interrupted':
      case 'caller_cancelled':
        return mcpBrokerError('cancelled', false, requestId)
      default:
        if (MCP_ERROR_CODES.has(result.code)) {
          return mcpBrokerError(
            mcpErrorCode(result.code),
            result.code === 'timeout',
            requestId,
          )
        }
    }
  }
  return mcpBrokerError('internal', true, requestId)
}

function isMcpSanitizedError(value: unknown): value is McpSanitizedError {
  if (!value || typeof value !== 'object') return false
  const code: unknown = Reflect.get(value, 'code')
  const message: unknown = Reflect.get(value, 'message')
  const retryable: unknown = Reflect.get(value, 'retryable')
  return (
    typeof code === 'string' &&
    MCP_ERROR_CODES.has(code) &&
    typeof message === 'string' &&
    typeof retryable === 'boolean'
  )
}

function mcpErrorCode(value: string): McpSanitizedErrorCode {
  for (const code of MCP_SANITIZED_ERROR_CODES) {
    if (code === value) return code
  }
  return 'internal'
}

function brokerFailure(
  request: McpBrokerCallRequest,
  error: McpSanitizedError,
): McpBrokerCallResult {
  return {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: request.context.requestId,
    toolCallId: request.toolCallId,
    isError: true,
    content: [],
    attachments: [],
    evidence: [],
    error,
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('MCP capability dispatch was cancelled.', 'AbortError')
}
