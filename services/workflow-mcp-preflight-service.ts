import type { WorkflowModelSelection } from '../contracts/workflow-model-selection.js'
import { whenDefined } from '../core/optional-properties.js'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { loadAgent } from '../parsers/load-agent.js'
import { parseTeamRegistry } from '../parsers/team-registry.js'
import { parseWorkflowTemplateYaml } from '../workflows/loader.js'
import type { WorkflowStep } from '../workflows/types.js'
import { resolveChildTeamContract } from '../domains/delegation/delegation-contracts.js'
import { BROWSER_TOOL_NAME } from '../domains/browser/browser-types.js'
import {
  evaluateMcpWorkflowPreflight,
  type McpWorkflowPreflightResult,
  type McpWorkflowScheduledAgent,
} from '../domains/mcp/mcp-workflow-preflight.js'
import {
  createMcpProviderSupportResolver,
  mcpProviderSupportReason,
  type McpProviderResolution,
  type McpProviderSupportResolver,
} from '../domains/mcp/mcp-provider-support.js'
import { normalizeMcpAgentPath } from '../domains/mcp/mcp-settings.js'
import { resolveExistingPathInside } from '../core/path-safety.js'
import { getCoordinatorName, getParticipantNames } from '../core/stage-helpers.js'
import { applyTeamRuntimeOverrides } from '../core/team-runtime-overrides.js'
import type {
  AgentRosterEntry,
  RegistryEntry,
  TeamConfig,
  TeamRegistryEntry,
} from '../core/types.js'
import type { McpSettingsService } from './mcp-settings-service.js'

export const MAX_MCP_WORKFLOW_TEAM_RECURSION_DEPTH = 8 as const

interface WorkflowScheduledAgentTarget
  extends Omit<McpWorkflowScheduledAgent, 'supportState'> {
  readonly requiredProviderTools: readonly string[]
}

export class WorkflowMcpPreflightServiceError extends Error {
  constructor(
    readonly code: 'invalid_workflow',
    message: string,
  ) {
    super(message)
    this.name = 'WorkflowMcpPreflightServiceError'
  }
}

export interface WorkflowMcpPreflightServiceOptions {
  readonly repoRootPath: string
  readonly settingsService: Pick<
    McpSettingsService,
    'listServers' | 'listAgentGrants' | 'getBrokerClientManager'
  >
  readonly providerSupportResolver?: McpProviderSupportResolver
  readonly now?: () => Date
}

export interface WorkflowMcpPreflightResolveInput {
  readonly workflowId: string
  readonly workflowYaml: string
  readonly workerModel?: WorkflowModelSelection
}

export class WorkflowMcpPreflightService {
  private readonly repoRootPath: string
  private readonly providerSupportResolver: McpProviderSupportResolver
  private readonly now: () => Date

  constructor(private readonly options: WorkflowMcpPreflightServiceOptions) {
    this.repoRootPath = path.resolve(options.repoRootPath)
    this.providerSupportResolver =
      options.providerSupportResolver ?? createMcpProviderSupportResolver()
    this.now = options.now ?? (() => new Date())
  }

  async resolve(
    input: WorkflowMcpPreflightResolveInput,
  ): Promise<McpWorkflowPreflightResult> {
    const parsed = parseWorkflowTemplateYaml(
      input.workflowYaml,
      `workflow:${input.workflowId}`,
    )
    if (!parsed.template) {
      throw invalidWorkflow('Workflow MCP requirements could not be parsed.')
    }

    const registry = parseTeamRegistry(path.join(this.repoRootPath, 'teams.yaml'))
    if (registry.errors.length > 0) {
      throw invalidWorkflow('Workflow teams could not be resolved for MCP preflight.')
    }
    const teamRegistry = new Map(
      registry.entries.map((entry) => [entry.name, entry]),
    )

    const scheduledSteps = parsed.template.steps.flatMap((step) => {
      if (step.type === 'transform' || step.type === 'human-in-the-loop') {
        if ((step.mcp_requirements?.length ?? 0) > 0) {
          throw invalidWorkflow(
            `Workflow transform '${step.id}' cannot declare MCP requirements.`,
          )
        }
        return []
      }
      return [{
        step,
        agents: this.resolveStepAgents(step, teamRegistry).map((agent) => ({
          ...agent,
          ...input.workerModel,
        })),
      }]
    })
    const uniqueProviderTargets = new Map<
      string,
      WorkflowScheduledAgentTarget
    >()
    for (const scheduled of scheduledSteps) {
      for (const agent of scheduled.agents) {
        uniqueProviderTargets.set(providerTargetKey(agent), agent)
      }
    }
    const providerResolutions = new Map<string, McpProviderResolution>()
    await Promise.all(
      [...uniqueProviderTargets.entries()].map(async ([key, target]) => {
        const support = await this.providerSupportResolver({
          provider: target.provider,
          model: target.model,
        })
        providerResolutions.set(key, support)
      }),
    )

    const [servers, grants] = await Promise.all([
      this.options.settingsService.listServers(),
      this.options.settingsService.listAgentGrants(),
    ])
    const liveManager = this.options.settingsService.getBrokerClientManager()

    return evaluateMcpWorkflowPreflight({
      workflowId: input.workflowId,
      generatedAt: this.now().toISOString(),
      workflowRequirements: parsed.template.mcp_requirements ?? [],
      steps: scheduledSteps.map(({ step, agents }) => ({
        stepId: step.id,
        requirements: step.mcp_requirements ?? [],
        scheduledAgents: agents.map((agent) => {
          const resolution = providerResolutions.get(providerTargetKey(agent))
          return {
            ...agent,
            model: resolution?.resolvedModel ?? agent.model,
            supportState: resolution?.state ?? 'unknown',
            ...(resolution?.reasonCode
              ? { providerSupportReasonCode: resolution.reasonCode }
              : {}),
            ...(resolution
              ? { ...whenDefined(mcpProviderSupportReason(resolution), (providerSupportMessage) => ({ providerSupportMessage })) }
              : {}),
          }
        }),
      })),
      servers: servers.map((server) => ({
        serverId: server.id,
        serverName: server.name,
        enabled: server.enabled,
        status: server.status,
        live: liveManager.getSnapshot(server.id)?.serverId === server.id,
        capabilityAliases: server.capabilityAliases,
      })),
      grants,
    })
  }

  private resolveStepAgents(
    step: WorkflowStep,
    teamRegistry: ReadonlyMap<string, RegistryEntry>,
  ): WorkflowScheduledAgentTarget[] {
    if (step.type === 'transform' || step.type === 'human-in-the-loop' || !step.team) {
      return []
    }
    const entry = teamRegistry.get(step.team)
    if (!entry || entry.type !== 'team') {
      throw invalidWorkflow(
        `Workflow step '${step.id}' does not resolve to a callable team.`,
      )
    }
    const contract = this.resolveTeamContract(entry, step.id)
    if (step.type === 'agent') {
      const rosterEntry = contract.teamConfig.agents.find(
        (candidate) => candidate.type === 'agent' && candidate.name === step.agent,
      )
      if (!rosterEntry) {
        throw invalidWorkflow(
          `Workflow step '${step.id}' does not resolve to a callable agent.`,
        )
      }
      const agentPath = this.resolveAgentPath(rosterEntry)
      const loaded = loadAgent(rosterEntry, contract.teamConfig, 0)
      if (!agentPath || !loaded) {
        throw invalidWorkflow(
          `Workflow step '${step.id}' schedules an unavailable repository agent.`,
        )
      }
      return [{
        agentPath,
        provider: loaded.provider,
        model: loaded.model,
        requiredProviderTools: requiredProviderTools(loaded.tools),
      }]
    }
    const overrideErrors = applyTeamRuntimeOverrides(
      contract.teamConfig,
      {
        ...step.runtime_overrides,
        ...whenDefined(step.stage_type, (definedValue) => ({ stage_type: definedValue })),
      },
    )
    if (overrideErrors.length > 0) {
      throw invalidWorkflow(
        `Workflow step '${step.id}' has invalid team runtime overrides.`,
      )
    }
    return this.collectScheduledAgents({
      teamConfig: contract.teamConfig,
      teamPath: entry.team_path,
      stepId: step.id,
      depth: 0,
      ancestry: new Set<string>(),
    })
  }

  private collectScheduledAgents(params: {
    teamConfig: TeamConfig
    teamPath: string
    stepId: string
    depth: number
    ancestry: ReadonlySet<string>
  }): WorkflowScheduledAgentTarget[] {
    if (params.depth > MAX_MCP_WORKFLOW_TEAM_RECURSION_DEPTH) {
      throw invalidWorkflow(
        `Workflow step '${params.stepId}' exceeds the nested team depth limit.`,
      )
    }
    const canonicalTeamPath = canonicalDirectory(params.teamPath)
    if (!canonicalTeamPath || params.ancestry.has(canonicalTeamPath)) {
      throw invalidWorkflow(
        `Workflow step '${params.stepId}' contains a cyclic or unavailable nested team.`,
      )
    }
    const ancestry = new Set(params.ancestry)
    ancestry.add(canonicalTeamPath)

    const scheduledNames = collectScheduledRosterNames(params.teamConfig)
    const roster = new Map(
      params.teamConfig.agents.map((agent) => [agent.name, agent]),
    )
    const agents: WorkflowScheduledAgentTarget[] = []
    for (const name of scheduledNames) {
      const entry = roster.get(name)
      if (!entry) {
        throw invalidWorkflow(
          `Workflow step '${params.stepId}' schedules an unknown team agent.`,
        )
      }
      if (entry.type === 'team') {
        const nestedEntry = toNestedTeamEntry(entry)
        if (!nestedEntry) {
          throw invalidWorkflow(
            `Workflow step '${params.stepId}' schedules an unavailable nested team.`,
          )
        }
        const nested = this.resolveTeamContract(nestedEntry, params.stepId)
        agents.push(
          ...this.collectScheduledAgents({
            teamConfig: nested.teamConfig,
            teamPath: nestedEntry.team_path,
            stepId: params.stepId,
            depth: params.depth + 1,
            ancestry,
          }),
        )
        continue
      }

      const agentPath = this.resolveAgentPath(entry)
      const loaded = loadAgent(entry, params.teamConfig, 0)
      if (!agentPath || !loaded) {
        throw invalidWorkflow(
          `Workflow step '${params.stepId}' schedules an unavailable repository agent.`,
        )
      }
      agents.push({
        agentPath,
        provider: loaded.provider,
        model: loaded.model,
        requiredProviderTools: requiredProviderTools(loaded.tools),
      })
    }
    return uniqueAgentTargets(agents)
  }

  private resolveAgentPath(entry: AgentRosterEntry): string | null {
    const agentPath = normalizeMcpAgentPath(`agents/${entry.name}`)
    if (!agentPath) return null
    const expectedDirectory = path.join(
      this.repoRootPath,
      'agents',
      entry.name,
    )
    return resolveExistingPathInside(expectedDirectory, entry.agent_file)
      ? agentPath
      : null
  }

  private resolveTeamContract(entry: TeamRegistryEntry, stepId: string) {
    try {
      return resolveChildTeamContract(entry)
    } catch {
      throw invalidWorkflow(
        `Workflow step '${stepId}' has an invalid callable team contract.`,
      )
    }
  }
}

function collectScheduledRosterNames(teamConfig: TeamConfig): string[] {
  const names = new Set<string>()
  for (const level of teamConfig.levels) {
    const coordinator = getCoordinatorName(level)
    if (coordinator) names.add(coordinator)
    for (const participant of getParticipantNames(level)) {
      names.add(participant)
    }
    if (
      level.stage.type === 'pipeline' &&
      level.stage.participants === undefined
    ) {
      for (const agent of teamConfig.agents) {
        if (agent.type === 'agent') names.add(agent.name)
      }
    }
  }
  return [...names].sort(compareStrings)
}

function toNestedTeamEntry(entry: AgentRosterEntry): TeamRegistryEntry | null {
  if (!entry.team_path) return null
  return {
    name: entry.name,
    type: 'team',
    team_path: entry.team_path,
    ...(entry.input_artifact ? { input_artifact: entry.input_artifact } : {}),
    ...(entry.output_artifact ? { output_artifact: entry.output_artifact } : {}),
    ...(entry.mount ? { mount: entry.mount } : {}),
    ...(entry.host_model ? { host_model: entry.host_model } : {}),
    ...(entry.host_provider ? { host_provider: entry.host_provider } : {}),
  }
}

function canonicalDirectory(directoryPath: string): string | null {
  try {
    return fs.realpathSync(directoryPath)
  } catch {
    return null
  }
}

function uniqueAgentTargets(
  agents: readonly WorkflowScheduledAgentTarget[],
): WorkflowScheduledAgentTarget[] {
  const unique = new Map<string, WorkflowScheduledAgentTarget>()
  for (const agent of agents) {
    const key = providerTargetKey(agent)
    const current = unique.get(key)
    unique.set(key, {
      ...agent,
      requiredProviderTools: [
        ...new Set([
          ...(current?.requiredProviderTools ?? []),
          ...agent.requiredProviderTools,
        ]),
      ].sort(compareStrings),
    })
  }
  return [...unique.values()].sort(
    (left, right) =>
      compareStrings(left.agentPath, right.agentPath) ||
      compareStrings(left.provider, right.provider) ||
      compareStrings(left.model, right.model),
  )
}

function providerTargetKey(
  target: Pick<McpWorkflowScheduledAgent, 'agentPath' | 'provider' | 'model'>,
): string {
  return `${target.agentPath}\0${target.provider}\0${target.model}`
}

function requiredProviderTools(tools: readonly string[] | undefined): string[] {
  return tools?.includes(BROWSER_TOOL_NAME) ? [BROWSER_TOOL_NAME] : []
}

function invalidWorkflow(message: string): WorkflowMcpPreflightServiceError {
  return new WorkflowMcpPreflightServiceError('invalid_workflow', message)
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
