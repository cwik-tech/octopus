import type { CapabilityDispatcherPorts } from '../../contracts/capability-dispatch.js'
import { toMcpJsonObject } from '../../contracts/mcp.js'
import { CapabilityDispatcher } from '../../core/capability-dispatcher.js'
import { PerAuthorityCapabilityExecutionScheduler } from '../../core/capability-execution-scheduler.js'
import { CapabilityInvocationBindings } from '../../core/capability-invocation-bindings.js'
import {
  BrowserCapabilityDispatchGateway,
  type BrowserCapabilityDispatchInput,
  type BrowserCapabilityDispatchInvoker,
} from '../../services/browser-capability-adapter.js'
import {
  BROWSER_TOOL_CONTRACT_VERSION,
  type BrowserToolInput,
  type BrowserToolOutput,
} from '../../domains/browser/browser-types.js'
import type {
  BrowserPreparedCapability,
  BrowserToolService,
} from '../../services/browser-tool-service.js'
import type { McpBrokerRequestContext } from '../../domains/mcp/mcp-runtime.js'

export function createBrowserCapabilityTestInvoker(
  service: BrowserToolService,
  overrides: CapabilityDispatcherPorts = {},
): BrowserCapabilityDispatchInvoker {
  let attempt = 0
  return new BrowserCapabilityDispatchGateway({
    service,
    dispatcher: new CapabilityDispatcher({
      bindings: new CapabilityInvocationBindings({
        maxActivePerScope: 8,
        maxRetainedPerScope: 128,
      }),
      authority: { authorize: async () => ({ kind: 'allow' }) },
      policy: { evaluate: async () => ({ kind: 'allow' }) },
      budget: {
        preflight: async () => ({ kind: 'not-metered' }),
        reserve: async () => ({ reservationId: 'unexpected-test-reservation' }),
        settle: async () => ({ costTracked: false, budgetOverrun: false }),
        release: async () => undefined,
      },
      approval: {
        request: async (input) => {
          const interaction = {
            interactionId: `browser-test-interaction-${attempt + 1}`,
            reused: false,
          }
          await input.onInteraction(interaction)
          return { outcome: 'approved', interaction }
        },
      },
      evidence: { append: async () => undefined },
      scheduler: new PerAuthorityCapabilityExecutionScheduler(),
      clock: { now: Date.now },
      ids: {
        nextAttemptId: () => {
          attempt += 1
          return `browser-test-attempt-${attempt}`
        },
      },
      ...overrides,
    }),
  })
}

export function browserCapabilityTestInvocation(
  context: McpBrokerRequestContext & { readonly activityScopeId?: string },
  toolCallId: string,
  input: BrowserToolInput,
  signal?: AbortSignal,
): BrowserCapabilityDispatchInput {
  return {
    context,
    authority: { kind: 'mcp-lease', leaseId: context.leaseId },
    source: {
      kind: 'builtin',
      id: 'builtin.browser',
      version: String(BROWSER_TOOL_CONTRACT_VERSION),
    },
    toolCallId,
    input: toMcpJsonObject(input),
    ...(signal ? { signal } : {}),
  }
}

/** Exercises domain stages directly; approval-required behavior belongs in dispatcher tests. */
export async function executeBrowserDomainForTest(
  service: BrowserToolService,
  context: McpBrokerRequestContext & { readonly activityScopeId?: string },
  toolCallId: string,
  input: BrowserToolInput,
  signal?: AbortSignal,
): Promise<BrowserToolOutput> {
  const preparation = await service.prepareCapability(
    context,
    toolCallId,
    toMcpJsonObject(input),
  )
  if (preparation.kind === 'rejected') return preparation.output
  const capability = preparation.capability
  if (capability.policyDecision.kind === 'require-approval') {
    throw new Error(
      'Approval-required actions must be exercised through the capability dispatcher.',
    )
  }
  if (capability.policyDecision.kind === 'deny') {
    const projected = await service.projectCapabilityLifecycle(capability, {
      kind: 'terminal',
      status: 'rejected',
      code: capability.policyDecision.code,
      detail: capability.policyDecision.output,
    })
    return projected?.detail ?? capability.policyDecision.output
  }
  const authorization = await service.authorizeCapability(
    capability,
    'before-execute',
  )
  if (authorization.kind === 'deny') {
    const projected = await service.projectCapabilityLifecycle(capability, {
      kind: 'terminal',
      status: 'rejected',
      code: authorization.code,
      detail: authorization.output,
    })
    return projected?.detail ?? authorization.output
  }
  await service.projectCapabilityLifecycle(capability, { kind: 'running' })
  let output: BrowserToolOutput
  try {
    output = await service.executeCapability(capability, signal)
  } catch {
    return projectBrowserDomainFailure(service, capability, 'failed')
  }
  try {
    return await service.acceptCapabilityResult(capability, output)
  } catch {
    return projectBrowserDomainFailure(service, capability, 'indeterminate')
  }
}

async function projectBrowserDomainFailure(
  service: BrowserToolService,
  capability: BrowserPreparedCapability,
  status: 'failed' | 'indeterminate',
): Promise<BrowserToolOutput> {
  const projected = await service.projectCapabilityLifecycle(capability, {
    kind: 'terminal',
    status,
    code: capability.terminalOutput?.error?.code ?? 'internal',
  })
  return projected?.detail ?? capability.terminalOutput ?? {
    ok: false,
    action: capability.input.action,
    error: {
      code: 'internal',
      message: 'Browser action failed.',
      retryable: true,
    },
  }
}
