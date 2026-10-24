import { toMcpJsonObject, type McpJsonObject } from '../contracts/mcp.js'
import {
  type CapabilityAdapter,
  type CapabilityInvocationIdentity,
  type CapabilityPreparedExecution,
  type CapabilityScopeAuthority,
} from '../contracts/capability-dispatch.js'
import type { CapabilityDispatcher } from '../core/capability-dispatcher.js'
import { CapabilityDispatchRejection } from '../core/capability-dispatcher.js'
import {
  BROWSER_SERVER_ID,
  browserApprovalToolName,
  type BrowserAction,
  type BrowserToolOutput,
} from '../domains/browser/browser-types.js'
import type { McpBrokerRequestContext } from '../domains/mcp/mcp-runtime.js'
import {
  BrowserToolService,
  type BrowserCapabilityAuthorization,
  type BrowserCapabilityPolicyDecision,
} from './browser-tool-service.js'

export const BROWSER_CAPABILITY_ID = 'browser.interact'

export interface BrowserCapabilityDispatchInput {
  readonly context: McpBrokerRequestContext & {
    readonly activityScopeId?: string
    readonly taskId?: string
  }
  readonly authority: CapabilityScopeAuthority
  readonly source: CapabilityInvocationIdentity['source']
  readonly toolCallId: string
  readonly input: McpJsonObject
  readonly initialAuthorityEvidence?: unknown
  readonly signal?: AbortSignal
}

export interface BrowserCapabilityDispatchInvoker {
  execute(input: BrowserCapabilityDispatchInput): Promise<BrowserToolOutput>
  releaseAssignment(scope: {
    readonly sessionId: string
    readonly runId: string
    readonly assignmentId: string
    readonly activityScopeId?: string
  }): Promise<void>
}

export interface BrowserCapabilityDispatchGatewayOptions {
  readonly dispatcher: Pick<CapabilityDispatcher, 'dispatch'>
  readonly service: BrowserToolService
}

export class BrowserCapabilityDispatchGateway
  implements BrowserCapabilityDispatchInvoker {
  constructor(private readonly options: BrowserCapabilityDispatchGatewayOptions) {}

  async execute(input: BrowserCapabilityDispatchInput): Promise<BrowserToolOutput> {
    const result = await this.options.dispatcher.dispatch({
      context: {
        contractVersion: 1,
        requestId: input.context.requestId,
        sessionId: input.context.sessionId,
        runId: input.context.runId,
        assignmentId: input.context.assignmentId,
        ...(input.context.taskId ? { taskId: input.context.taskId } : {}),
        agentPath: input.context.agentPath,
        authority: input.authority,
        ...(input.context.workflowId
          ? { workflowId: input.context.workflowId }
          : {}),
        ...(input.context.workflowStepId
          ? { workflowStepId: input.context.workflowStepId }
          : {}),
        ...(input.context.agentId ? { agentId: input.context.agentId } : {}),
        ...(input.context.agentDisplayName
          ? { agentDisplayName: input.context.agentDisplayName }
          : {}),
        ...(input.context.activityScopeId
          ? { activityScopeId: input.context.activityScopeId }
          : {}),
      },
      invocation: {
        capabilityId: BROWSER_CAPABILITY_ID,
        source: input.source,
        toolCallId: input.toolCallId,
        input: input.input,
      },
      adapter: new BrowserCapabilityAdapter({
        service: this.options.service,
        context: input.context,
      }),
      ...(input.initialAuthorityEvidence === undefined
        ? {}
        : { initialAuthorityEvidence: input.initialAuthorityEvidence }),
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (result.status === 'completed') {
      return readBrowserOutput(result.value) ?? fallbackFailure(
        safeAction(input.input.action),
        'internal',
        'Browser capability returned an invalid result.',
      )
    }
    const projected = readBrowserOutput(result.detail)
    if (projected) return projected
    if (result.status === 'cancelled') {
      return fallbackFailure(
        safeAction(input.input.action),
        'cancelled',
        'Browser action was cancelled.',
      )
    }
    if (result.status === 'rejected' && result.code === 'domain_denied') {
      return fallbackFailure(
        safeAction(input.input.action),
        'domain_denied',
        'This browser capability was denied.',
      )
    }
    return fallbackFailure(
      safeAction(input.input.action),
      'internal',
      result.status === 'indeterminate'
        ? 'Browser action outcome is indeterminate.'
        : 'Browser action failed.',
      true,
    )
  }

  releaseAssignment(scope: Parameters<BrowserToolService['releaseAssignment']>[0]): Promise<void> {
    return this.options.service.releaseAssignment(scope)
  }
}

export interface BrowserCapabilityAdapterOptions {
  readonly service: BrowserToolService
  readonly context: McpBrokerRequestContext & {
    readonly activityScopeId?: string
  }
}

export class BrowserCapabilityAdapter implements CapabilityAdapter {
  readonly capabilityId = BROWSER_CAPABILITY_ID

  constructor(private readonly options: BrowserCapabilityAdapterOptions) {}

  async prepare(
    input: Parameters<CapabilityAdapter['prepare']>[0],
  ): Promise<CapabilityPreparedExecution> {
    const preparation = await this.options.service.prepareCapability(
      this.options.context,
      input.invocation.toolCallId,
      toMcpJsonObject(input.arguments),
    )
    if (preparation.kind === 'rejected') {
      throw new CapabilityDispatchRejection(
        preparation.code,
        preparation.output,
      )
    }
    const capability = preparation.capability
    return {
      effect: capability.effect,
      risk: capability.risk,
      argumentNames: capability.argumentNames,
      policyDecision: toDispatchPolicy(capability.policyDecision),
      ...(capability.policyDecision.kind === 'require-approval'
        ? {
            approval: {
              title: `Browser ${capability.input.action}`,
              description: `Allow ${browserApprovalToolName(capability.input.action)}?`,
              serverId: BROWSER_SERVER_ID,
              namespacedToolName: browserApprovalToolName(
                capability.input.action,
              ),
            },
          }
        : {}),
      projectLifecycle: async (transition) => {
        if (transition.kind !== 'terminal') {
          return this.options.service.projectCapabilityLifecycle(
            capability,
            transition,
          )
        }
        return this.options.service.projectCapabilityLifecycle(capability, {
          kind: 'terminal',
          status: transition.result.status,
          ...(transition.result.status === 'completed'
            ? {}
            : {
                code: transition.result.code,
                ...(transition.result.detail === undefined
                  ? {}
                  : { detail: transition.result.detail }),
              }),
        })
      },
      authorize: async ({ phase }) =>
        toDispatchAuthorization(
          await this.options.service.authorizeCapability(capability, phase),
        ),
      execute: ({ signal }) =>
        this.options.service.executeCapability(capability, signal),
      acceptResult: async ({ value }) => ({
        value: await this.options.service.acceptCapabilityResult(
          capability,
          value,
        ),
      }),
    }
  }
}

function toDispatchPolicy(decision: BrowserCapabilityPolicyDecision) {
  switch (decision.kind) {
    case 'allow':
      return decision
    case 'require-approval':
      return decision
    case 'deny':
      return {
        kind: 'deny' as const,
        code: decision.code,
        reason: decision.reason,
        detail: decision.output,
      }
  }
}

function toDispatchAuthorization(decision: BrowserCapabilityAuthorization) {
  return decision.kind === 'allow'
    ? decision
    : {
        kind: 'deny' as const,
        code: decision.code,
        reason: decision.reason,
        detail: decision.output,
      }
}

function readBrowserOutput(value: unknown): BrowserToolOutput | null {
  return isBrowserOutput(value) ? value : null
}

function isBrowserOutput(value: unknown): value is BrowserToolOutput {
  if (!isRecord(value)) return false
  if (typeof value.ok !== 'boolean' || !isBrowserAction(value.action)) {
    return false
  }
  if (value.ok) return true
  return isRecord(value.error) &&
    typeof value.error.code === 'string' &&
    typeof value.error.message === 'string' &&
    typeof value.error.retryable === 'boolean'
}

function fallbackFailure(
  action: BrowserAction,
  code: NonNullable<BrowserToolOutput['error']>['code'],
  message: string,
  retryable = false,
): BrowserToolOutput {
  return { ok: false, action, error: { code, message, retryable } }
}

function safeAction(value: unknown): BrowserAction {
  return isBrowserAction(value) ? value : 'observe'
}

function isBrowserAction(value: unknown): value is BrowserAction {
  return typeof value === 'string' && BROWSER_ACTIONS.has(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const BROWSER_ACTIONS: ReadonlySet<string> = new Set([
  'open',
  'observe',
  'navigate',
  'go_back',
  'click',
  'type',
  'select',
  'press',
  'scroll',
  'wait',
  'read_content',
  'search_content',
  'screenshot',
  'download',
  'close',
])
