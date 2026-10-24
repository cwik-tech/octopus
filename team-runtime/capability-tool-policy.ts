import type {
  CapabilityExecutionContext,
  CapabilityInvocationIdentity,
  CapabilityPolicyDecision,
  CapabilityPolicyPort,
} from '../contracts/capability-dispatch.js'
import type { CapabilityPolicyDenialCode } from '../contracts/capability-policy-denial.js'

/**
 * A refusal this policy may return. Narrowed to the codes the shared contract
 * declares user copy for, so a new refusal cannot reach a reader as a bare
 * identifier: adding one here without its sentence is a type error.
 */
type TeamRuntimeCapabilityDenial =
  Extract<CapabilityPolicyDecision, { readonly kind: 'deny' }>
  & { readonly code: CapabilityPolicyDenialCode }

export interface TeamRuntimePolicyCoordinator {
  readonly name: string
  /** Undefined preserves the existing "all registered tools" meaning. */
  readonly allowedTools?: readonly string[]
}

export interface TeamRuntimeToolPolicySnapshot {
  readonly levelId?: string
  readonly coordinatorRunId: number
  readonly levelAdvancedCoordinatorRunId: number | null
  readonly coordinator?: TeamRuntimePolicyCoordinator
  readonly levelAllowedTools: ReadonlySet<string>
  readonly engineTools: ReadonlySet<string>
  readonly usedLevelToolsThisCoordinatorTurn: Set<string>
}

export interface TeamRuntimeCapabilityRegistration {
  readonly capabilityId: string
  readonly toolName: string
}

export interface TeamRuntimeCapabilityPolicyOptions {
  readonly getSnapshot: () => TeamRuntimeToolPolicySnapshot
  readonly trustedRuntimeSource: CapabilityInvocationIdentity['source']
  onDenied?(input: {
    readonly context: CapabilityExecutionContext
    readonly invocation: CapabilityInvocationIdentity
    readonly toolName: string
    readonly decision: Extract<CapabilityPolicyDecision, { readonly kind: 'deny' }>
  }): void
}

/** Live Team Runtime stage and agent policy evaluated at both dispatch gates. */
export class TeamRuntimeCapabilityPolicy implements CapabilityPolicyPort {
  private readonly registrations = new Map<string, string>()
  private readonly admittedInvocationKeys = new Set<string>()

  constructor(private readonly options: TeamRuntimeCapabilityPolicyOptions) {}

  register(registration: TeamRuntimeCapabilityRegistration): void {
    const current = this.registrations.get(registration.capabilityId)
    if (current !== undefined && current !== registration.toolName) {
      throw new Error('A Team Runtime capability ID maps to multiple tools.')
    }
    this.registrations.set(registration.capabilityId, registration.toolName)
  }

  clearRegistrations(): void {
    this.registrations.clear()
    this.admittedInvocationKeys.clear()
  }

  clearInvocationAdmissions(): void {
    this.admittedInvocationKeys.clear()
  }

  async evaluate(
    input: Parameters<CapabilityPolicyPort['evaluate']>[0],
  ): Promise<CapabilityPolicyDecision> {
    const toolName = this.registrations.get(input.invocation.capabilityId)
    if (!toolName) {
      return this.deny(input, input.invocation.capabilityId, {
        kind: 'deny',
        code: 'unknown_team_runtime_capability',
        reason: 'The capability is not registered for this Team Runtime level.',
      })
    }
    if (sameSource(input.invocation.source, this.options.trustedRuntimeSource)) {
      return { kind: 'allow' }
    }

    const snapshot = this.options.getSnapshot()
    if (!snapshot.coordinator) {
      // One condition, not two. The resolution this reads collapses "names
      // nobody" and "names an agent the team does not have" into the same
      // undefined (`team-runtime/index.ts:1172-1177`), but only the first can
      // reach a tool call: the second is a boot-time config error that stops
      // the run (`domains/provider/provider-preflight.ts:150`). So this stays
      // one refusal with one sentence.
      return this.deny(input, toolName, {
        kind: 'deny',
        code: 'runtime_owned_tool_denied',
        reason:
          `Tool '${toolName}' is not available to the host in runtime-owned ` +
          `level '${snapshot.levelId ?? 'unknown'}'.`,
      })
    }
    if (
      snapshot.levelAdvancedCoordinatorRunId !== null &&
      snapshot.levelAdvancedCoordinatorRunId === snapshot.coordinatorRunId &&
      snapshot.engineTools.has(toolName)
    ) {
      return this.deny(input, toolName, {
        kind: 'deny',
        code: 'post_advance_tool_denied',
        reason:
          'The level advanced during this coordinator turn; engine tools are closed.',
      })
    }
    if (
      snapshot.engineTools.has(toolName) &&
      !snapshot.levelAllowedTools.has(toolName)
    ) {
      return this.deny(input, toolName, {
        kind: 'deny',
        code: 'tool_not_allowed_in_level',
        reason: `Tool '${toolName}' is not available in the current level.`,
      })
    }
    if (
      snapshot.coordinator.allowedTools !== undefined &&
      !snapshot.coordinator.allowedTools.includes(toolName)
    ) {
      return this.deny(input, toolName, {
        kind: 'deny',
        code: 'tool_not_allowed_for_agent',
        reason:
          `Tool '${toolName}' is not allowed for agent ` +
          `'${snapshot.coordinator.name}'.`,
      })
    }

    const trackLevelTool = snapshot.levelId !== undefined &&
      toolName !== 'handoff' &&
      toolName !== 'submit_for_review' &&
      snapshot.levelAllowedTools.has(toolName)
    if (!trackLevelTool) return { kind: 'allow' }

    const invocationKey = makeInvocationKey(input.context, input.invocation)
    if (this.admittedInvocationKeys.has(invocationKey)) {
      return { kind: 'allow' }
    }
    const levelToolKey = `${snapshot.levelId}:${toolName}`
    if (snapshot.usedLevelToolsThisCoordinatorTurn.has(levelToolKey)) {
      return this.deny(input, toolName, {
        kind: 'deny',
        code: 'duplicate_level_tool',
        reason:
          `Tool '${toolName}' was already used in coordinator turn ` +
          `${snapshot.coordinatorRunId} for level '${snapshot.levelId}'.`,
      })
    }
    snapshot.usedLevelToolsThisCoordinatorTurn.add(levelToolKey)
    this.admittedInvocationKeys.add(invocationKey)
    return { kind: 'allow' }
  }

  private deny(
    input: Parameters<CapabilityPolicyPort['evaluate']>[0],
    toolName: string,
    decision: TeamRuntimeCapabilityDenial,
  ): CapabilityPolicyDecision {
    this.options.onDenied?.({
      context: input.context,
      invocation: input.invocation,
      toolName,
      decision,
    })
    return decision
  }
}

function sameSource(
  actual: CapabilityInvocationIdentity['source'],
  expected: CapabilityInvocationIdentity['source'],
): boolean {
  return actual.kind === expected.kind &&
    actual.id === expected.id &&
    actual.version === expected.version
}

function makeInvocationKey(
  context: CapabilityExecutionContext,
  invocation: CapabilityInvocationIdentity,
): string {
  return [
    context.sessionId,
    context.runId,
    context.assignmentId,
    context.taskId ?? '',
    context.agentPath,
    context.agentId ?? '',
    context.activityScopeId ?? '',
    context.workflowId ?? '',
    context.workflowStepId ?? '',
    authorityBinding(context),
    invocation.source.kind,
    invocation.source.id,
    invocation.source.version ?? '',
    invocation.capabilityId,
    invocation.toolCallId,
  ].join('\0')
}

function authorityBinding(context: CapabilityExecutionContext): string {
  switch (context.authority.kind) {
    case 'mcp-lease':
      return `mcp-lease:${context.authority.leaseId}`
    case 'runtime-assignment':
      return `runtime-assignment:${context.authority.processIdentity}`
    case 'parent-capability':
      return `parent-capability:${context.authority.endpointId}:${context.authority.processIdentity}`
  }
}
