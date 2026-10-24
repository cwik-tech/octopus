import type {
  CapabilityExecutionContext,
  CapabilityScopeAuthority,
} from '../contracts/capability-dispatch.js'
import type { McpBrokerRequestContext } from '../domains/mcp/mcp-runtime.js'

export type BuiltinCapabilityContext = McpBrokerRequestContext & {
  readonly taskId?: string
}

export type BuiltinCapabilityExecutionContextInput = Omit<
  BuiltinCapabilityContext,
  'leaseId'
> & {
  readonly leaseId?: string
}

export function toBuiltinCapabilityExecutionContext(
  context: BuiltinCapabilityExecutionContextInput,
  authority: CapabilityScopeAuthority,
): CapabilityExecutionContext {
  return {
    contractVersion: 1,
    requestId: context.requestId,
    sessionId: context.sessionId,
    runId: context.runId,
    assignmentId: context.assignmentId,
    ...(context.taskId ? { taskId: context.taskId } : {}),
    agentPath: context.agentPath,
    authority,
    ...(context.workflowId ? { workflowId: context.workflowId } : {}),
    ...(context.workflowStepId
      ? { workflowStepId: context.workflowStepId }
      : {}),
    ...(context.agentId ? { agentId: context.agentId } : {}),
    ...(context.agentDisplayName
      ? { agentDisplayName: context.agentDisplayName }
      : {}),
    ...(context.activityScopeId
      ? { activityScopeId: context.activityScopeId }
      : {}),
    ...(context.providerCallOrdinal === undefined
      ? {}
      : { providerCallOrdinal: context.providerCallOrdinal }),
  }
}
