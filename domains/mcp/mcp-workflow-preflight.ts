import { whenDefined } from '../../core/optional-properties.js'
import type {
  McpWorkflowPreflightDiagnostic,
  McpWorkflowProviderToolDiagnostic,
  McpWorkflowRequirementDiagnostic,
} from '../../contracts/mcp.js'
import type {
  McpProviderSupportState,
  McpWorkflowCapabilityRequirement,
} from './mcp-runtime.js'
import type {
  McpAgentGrant,
  McpCapabilityAccess,
  McpCapabilityAlias,
  McpConnectionStatus,
} from './mcp-settings.js'

export type {
  McpWorkflowPreflightDiagnostic,
  McpWorkflowProviderToolDiagnostic,
  McpWorkflowRequirementDiagnostic,
}

export const MCP_WORKFLOW_RESOLUTION_VERSION = 1 as const
export const MAX_MCP_WORKFLOW_SCHEDULED_AGENT_PATHS = 256 as const

export class McpWorkflowPreflightValidationError extends Error {
  constructor(
    readonly code: 'scheduled_agent_limit_exceeded',
    message: string,
  ) {
    super(message)
    this.name = 'McpWorkflowPreflightValidationError'
  }
}

export interface EffectiveMcpWorkflowRequirement {
  readonly capability: string
  readonly access: readonly McpCapabilityAccess[]
  readonly necessity: 'required' | 'optional'
}

export interface EffectiveMcpWorkflowStepRequirements {
  readonly stepId: string
  readonly effectiveRequirements: readonly EffectiveMcpWorkflowRequirement[]
}

export interface EffectiveMcpWorkflowRequirements {
  readonly workflowRequirements: readonly EffectiveMcpWorkflowRequirement[]
  readonly steps: readonly EffectiveMcpWorkflowStepRequirements[]
}

export interface McpWorkflowScheduledAgent {
  readonly agentPath: string
  readonly provider: string
  readonly model: string
  readonly supportState: McpProviderSupportState
}

export interface McpWorkflowPreflightAgent
  extends McpWorkflowScheduledAgent {
  /** Parent-owned tools that cannot safely fall back to a raw provider turn. */
  readonly requiredProviderTools?: readonly string[]
  readonly providerSupportReasonCode?: string
  readonly providerSupportMessage?: string
}

export interface McpWorkflowLiveServer {
  readonly serverId: string
  readonly serverName: string
  readonly enabled: boolean
  readonly status: McpConnectionStatus
  readonly live: boolean
  readonly capabilityAliases: readonly McpCapabilityAlias[]
}

export interface McpWorkflowMatchedCandidate {
  readonly serverId: string
  readonly serverName: string
  readonly agentPath: string
  readonly provider: string
  readonly state: 'supported' | 'experimental'
}

export interface McpWorkflowRequirementOwner {
  readonly agentPath: string
  readonly provider: string
}

export interface McpWorkflowRequirementMatch
  extends EffectiveMcpWorkflowRequirement {
  readonly candidates: readonly McpWorkflowMatchedCandidate[]
  /** Deterministic runtime owner for a required capability; optional matches have no owner. */
  readonly owner: McpWorkflowRequirementOwner | null
}

export interface McpWorkflowStepResolution {
  readonly stepId: string
  readonly scheduledAgentPaths: readonly string[]
  readonly scheduledAgents: readonly McpWorkflowScheduledAgent[]
  readonly effectiveRequirements: readonly EffectiveMcpWorkflowRequirement[]
  readonly matches: readonly McpWorkflowRequirementMatch[]
}

export interface McpWorkflowResolutionSnapshot {
  readonly version: typeof MCP_WORKFLOW_RESOLUTION_VERSION
  readonly generatedAt: string
  readonly workflowId: string
  readonly scheduledAgentPaths: readonly string[]
  readonly scheduledAgents: readonly McpWorkflowScheduledAgent[]
  readonly authorization: {
    readonly state: 'non-authoritative'
    readonly brokerRechecksAtCallTime: true
  }
  readonly workflowRequirements: readonly EffectiveMcpWorkflowRequirement[]
  readonly steps: readonly McpWorkflowStepResolution[]
  readonly warnings: readonly McpWorkflowPreflightDiagnostic[]
}

export interface McpWorkflowPreflightResult {
  readonly ok: boolean
  readonly scheduledAgentPaths: readonly string[]
  readonly scheduledAgents: readonly McpWorkflowScheduledAgent[]
  readonly errors: readonly McpWorkflowPreflightDiagnostic[]
  readonly warnings: readonly McpWorkflowPreflightDiagnostic[]
  readonly snapshot: McpWorkflowResolutionSnapshot
}

export interface ResolveEffectiveMcpWorkflowRequirementsInput {
  readonly workflowRequirements?: readonly McpWorkflowCapabilityRequirement[]
  readonly steps: readonly {
    readonly stepId: string
    readonly requirements?: readonly McpWorkflowCapabilityRequirement[]
  }[]
}

export interface EvaluateMcpWorkflowPreflightInput
  extends ResolveEffectiveMcpWorkflowRequirementsInput {
  readonly workflowId: string
  readonly generatedAt: string
  readonly steps: readonly {
    readonly stepId: string
    readonly requirements?: readonly McpWorkflowCapabilityRequirement[]
    readonly scheduledAgents: readonly McpWorkflowPreflightAgent[]
  }[]
  readonly servers: readonly McpWorkflowLiveServer[]
  readonly grants: readonly McpAgentGrant[]
}

export function resolveEffectiveMcpWorkflowRequirements(
  input: ResolveEffectiveMcpWorkflowRequirementsInput,
): EffectiveMcpWorkflowRequirements {
  const workflowRequirements = mergeRequirements(
    input.workflowRequirements ?? [],
  )
  return {
    workflowRequirements,
    steps: input.steps.map((step) => ({
      stepId: step.stepId,
      effectiveRequirements: mergeRequirements([
        ...(input.workflowRequirements ?? []),
        ...(step.requirements ?? []),
      ]),
    })),
  }
}

export function evaluateMcpWorkflowPreflight(
  input: EvaluateMcpWorkflowPreflightInput,
): McpWorkflowPreflightResult {
  const effective = resolveEffectiveMcpWorkflowRequirements(input)
  const scheduledAgentPaths = [
    ...new Set(
      input.steps.flatMap((step) =>
        step.scheduledAgents.map((agent) => agent.agentPath),
      ),
    ),
  ].sort(compareStrings)
  if (scheduledAgentPaths.length > MAX_MCP_WORKFLOW_SCHEDULED_AGENT_PATHS) {
    throw new McpWorkflowPreflightValidationError(
      'scheduled_agent_limit_exceeded',
      `Workflow schedules ${scheduledAgentPaths.length} MCP agent paths; ` +
        `the maximum is ${MAX_MCP_WORKFLOW_SCHEDULED_AGENT_PATHS}.`,
    )
  }
  const scheduledAgents = uniqueScheduledAgents(
    input.steps.flatMap((step) => step.scheduledAgents),
  )
  const errors: McpWorkflowPreflightDiagnostic[] = []
  const warnings: McpWorkflowPreflightDiagnostic[] = []
  const grants = new Set(
    input.grants
      .filter((grant) => grant.enabled)
      .map((grant) => grantKey(grant.agentPath, grant.serverId)),
  )
  const activeServers = input.servers.filter(
    (server) =>
      server.enabled && server.status === 'connected' && server.live,
  )

  const steps = effective.steps.map((step) => {
    const preflightAgents = uniquePreflightAgents(
      input.steps.find((candidate) => candidate.stepId === step.stepId)
        ?.scheduledAgents ?? [],
    )
    const scheduledAgents = uniqueScheduledAgents(preflightAgents)
    const eligibleAgents = scheduledAgents.filter(isProviderEligible)
    const eligibleAgentPaths = [
      ...new Set(eligibleAgents.map((agent) => agent.agentPath)),
    ].sort(compareStrings)

    for (const agent of preflightAgents) {
      if (isProviderEligible(agent)) continue
      for (const tool of normalizeProviderTools(agent.requiredProviderTools)) {
        errors.push(buildProviderToolDiagnostic({
          stepId: step.stepId,
          agent,
          tool,
        }))
      }
    }

    const matches = step.effectiveRequirements.map((requirement) => {
      const candidates: McpWorkflowMatchedCandidate[] = []
      for (const server of activeServers) {
        const alias = server.capabilityAliases.find(
          (candidate) => candidate.capability === requirement.capability,
        )
        if (!alias || !aliasSatisfiesAccess(alias.access, requirement.access)) {
          continue
        }
        for (const agent of eligibleAgents) {
          if (!grants.has(grantKey(agent.agentPath, server.serverId))) continue
          candidates.push({
            serverId: server.serverId,
            serverName: server.serverName,
            agentPath: agent.agentPath,
            provider: agent.provider,
            state: agent.supportState,
          })
        }
      }
      candidates.sort(compareCandidates)

      if (candidates.length === 0) {
        const diagnostic = buildDiagnostic({
          stepId: step.stepId,
          requirement,
          eligibleAgentPaths,
        })
        if (requirement.necessity === 'required') {
          errors.push(diagnostic)
        } else {
          warnings.push(diagnostic)
        }
      }
      return {
        ...requirement,
        candidates,
        owner: requirement.necessity === 'required'
          ? selectMcpWorkflowRequirementOwner(candidates)
          : null,
      }
    })

    return {
      stepId: step.stepId,
      scheduledAgentPaths: [
        ...new Set(scheduledAgents.map((agent) => agent.agentPath)),
      ].sort(compareStrings),
      scheduledAgents,
      effectiveRequirements: step.effectiveRequirements,
      matches,
    }
  })

  errors.sort(compareDiagnostics)
  warnings.sort(compareDiagnostics)
  return {
    ok: errors.length === 0,
    scheduledAgentPaths,
    scheduledAgents,
    errors,
    warnings,
    snapshot: {
      version: MCP_WORKFLOW_RESOLUTION_VERSION,
      generatedAt: input.generatedAt,
      workflowId: input.workflowId,
      scheduledAgentPaths,
      scheduledAgents,
      authorization: {
        state: 'non-authoritative',
        brokerRechecksAtCallTime: true,
      },
      workflowRequirements: effective.workflowRequirements,
      steps,
      warnings,
    },
  }
}

export function selectMcpWorkflowRequirementOwner(
  candidates: readonly McpWorkflowMatchedCandidate[],
): McpWorkflowRequirementOwner | null {
  const owners = new Map<string, McpWorkflowRequirementOwner>()
  for (const candidate of candidates) {
    const owner = {
      agentPath: candidate.agentPath,
      provider: candidate.provider,
    }
    owners.set(`${owner.agentPath}\0${owner.provider}`, owner)
  }
  return [...owners.values()].sort(
    (left, right) =>
      compareStrings(left.agentPath, right.agentPath) ||
      compareStrings(left.provider, right.provider),
  )[0] ?? null
}

function mergeRequirements(
  requirements: readonly McpWorkflowCapabilityRequirement[],
): EffectiveMcpWorkflowRequirement[] {
  const merged = new Map<
    string,
    { access: Set<McpCapabilityAccess>; necessity: 'required' | 'optional' }
  >()
  for (const requirement of requirements) {
    const current = merged.get(requirement.capability) ?? {
      access: new Set<McpCapabilityAccess>(),
      necessity: 'optional' as const,
    }
    current.access.add(requirement.access)
    if (requirement.necessity === 'required') current.necessity = 'required'
    merged.set(requirement.capability, current)
  }

  return [...merged.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([capability, value]) => ({
      capability,
      access: normalizeEffectiveAccess(value.access),
      necessity: value.necessity,
    }))
}

function normalizeEffectiveAccess(
  access: ReadonlySet<McpCapabilityAccess>,
): readonly McpCapabilityAccess[] {
  const strict = (['read', 'write'] as const).filter((value) => access.has(value))
  return strict.length > 0 ? strict : ['any']
}

function aliasSatisfiesAccess(
  aliasAccess: McpCapabilityAccess,
  requiredAccess: readonly McpCapabilityAccess[],
): boolean {
  if (requiredAccess.length === 1 && requiredAccess[0] === 'any') return true
  return requiredAccess.every(
    (access) => aliasAccess === 'any' || aliasAccess === access,
  )
}

function isProviderEligible(
  agent: McpWorkflowScheduledAgent,
): agent is McpWorkflowScheduledAgent & {
  readonly supportState: 'supported' | 'experimental'
} {
  return (
    agent.supportState === 'supported' ||
    agent.supportState === 'experimental'
  )
}

function uniqueScheduledAgents(
  agents: readonly McpWorkflowScheduledAgent[],
): McpWorkflowScheduledAgent[] {
  const unique = new Map<string, McpWorkflowScheduledAgent>()
  for (const agent of agents) {
    const key = [
      agent.agentPath,
      agent.provider,
      agent.model,
      agent.supportState,
    ].join('\0')
    unique.set(key, {
      agentPath: agent.agentPath,
      provider: agent.provider,
      model: agent.model,
      supportState: agent.supportState,
    })
  }
  return [...unique.values()].sort(
    (left, right) =>
      compareStrings(left.agentPath, right.agentPath) ||
      compareStrings(left.provider, right.provider) ||
      compareStrings(left.model, right.model) ||
      compareStrings(left.supportState, right.supportState),
  )
}

function uniquePreflightAgents(
  agents: readonly McpWorkflowPreflightAgent[],
): McpWorkflowPreflightAgent[] {
  const unique = new Map<string, McpWorkflowPreflightAgent>()
  for (const agent of agents) {
    const key = [
      agent.agentPath,
      agent.provider,
      agent.model,
      agent.supportState,
    ].join('\0')
    const current = unique.get(key)
    unique.set(key, {
      ...agent,
      requiredProviderTools: normalizeProviderTools([
        ...(current?.requiredProviderTools ?? []),
        ...(agent.requiredProviderTools ?? []),
      ]),
      ...whenDefined(current?.providerSupportReasonCode ?? agent.providerSupportReasonCode, (definedValue) => ({ providerSupportReasonCode: definedValue })),
      ...whenDefined(current?.providerSupportMessage ?? agent.providerSupportMessage, (definedValue) => ({ providerSupportMessage: definedValue })),
    })
  }
  return [...unique.values()].sort(
    (left, right) =>
      compareStrings(left.agentPath, right.agentPath) ||
      compareStrings(left.provider, right.provider) ||
      compareStrings(left.model, right.model) ||
      compareStrings(left.supportState, right.supportState),
  )
}

function normalizeProviderTools(tools: readonly string[] | undefined): string[] {
  return [...new Set(
    (tools ?? []).map((tool) => tool.trim()).filter(Boolean),
  )].sort(compareStrings)
}

function buildDiagnostic(params: {
  stepId: string
  requirement: EffectiveMcpWorkflowRequirement
  eligibleAgentPaths: readonly string[]
}): McpWorkflowPreflightDiagnostic {
  const access = params.requirement.access.join('+')
  const agentPaths =
    params.eligibleAgentPaths.length > 0
      ? params.eligibleAgentPaths.join(', ')
      : '(none)'
  return {
    code: 'mcp_requirement_unmet',
    retryable: true,
    stepId: params.stepId,
    capability: params.requirement.capability,
    access: params.requirement.access,
    necessity: params.requirement.necessity,
    eligibleAgentPaths: params.eligibleAgentPaths,
    message:
      `Step '${params.stepId}' has no eligible scheduled agent with ` +
      `${params.requirement.necessity} ${access} access to MCP capability ` +
      `'${params.requirement.capability}'. Eligible agent paths: ${agentPaths}.`,
  }
}

function buildProviderToolDiagnostic(params: {
  stepId: string
  agent: McpWorkflowPreflightAgent
  tool: string
}): McpWorkflowProviderToolDiagnostic {
  const supportMessage = params.agent.providerSupportMessage?.trim() ||
    'The configured provider cannot use the required parent tool bridge.'
  return {
    code: 'provider_tool_bridge_unavailable',
    retryable: true,
    stepId: params.stepId,
    agentPath: params.agent.agentPath,
    provider: params.agent.provider,
    model: params.agent.model,
    tool: params.tool,
    ...(params.agent.providerSupportReasonCode
      ? { reasonCode: params.agent.providerSupportReasonCode }
      : {}),
    message:
      `Step '${params.stepId}' cannot launch agent ` +
      `'${params.agent.agentPath}' with managed tool '${params.tool}'. ` +
      supportMessage,
  }
}

function grantKey(agentPath: string, serverId: string): string {
  return `${agentPath}\0${serverId}`
}

function compareCandidates(
  left: McpWorkflowMatchedCandidate,
  right: McpWorkflowMatchedCandidate,
): number {
  return (
    compareStrings(left.agentPath, right.agentPath) ||
    compareStrings(left.serverName, right.serverName) ||
    compareStrings(left.serverId, right.serverId) ||
    compareStrings(left.provider, right.provider)
  )
}

function compareDiagnostics(
  left: McpWorkflowPreflightDiagnostic,
  right: McpWorkflowPreflightDiagnostic,
): number {
  return (
    compareStrings(left.stepId, right.stepId) ||
    compareStrings(left.code, right.code) ||
    compareStrings(
      left.code === 'mcp_requirement_unmet' ? left.capability : left.agentPath,
      right.code === 'mcp_requirement_unmet' ? right.capability : right.agentPath,
    ) ||
    compareStrings(
      left.code === 'mcp_requirement_unmet' ? left.access.join('+') : left.tool,
      right.code === 'mcp_requirement_unmet' ? right.access.join('+') : right.tool,
    )
  )
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
