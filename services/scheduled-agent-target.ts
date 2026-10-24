import { whenDefined } from '../core/optional-properties.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { parseAgentFrontmatter } from '../parsers/load-agent.js'
import { parseTeamConfig } from '../parsers/team-config.js'
import { parseTeamRegistry } from '../parsers/team-registry.js'
import { parseWorkflowRegistry, parseWorkflowTemplate } from '../workflows/loader.js'
import { validateWorkflowTemplate } from '../workflows/validation.js'
import { listAgents } from '../domains/agent-generator/list-agents.js'
import { isSelectableAgent } from '../contracts/agent-generator.js'
import { withFileMutationLock, writeFileAtomic } from '../core/file-mutation.js'
import {
  extractTopLevelBlock,
  readTextIfExists,
  relativeYamlPath,
  sanitizeWrapperSegment as sanitizeSegment,
  upsertRegistryBlock,
  yamlQuoted,
} from './generated-target-registry.js'
import {
  SCHEDULER_GENERATED_TAG,
  type ScheduleModelOverride,
} from '../domains/scheduling/schedule-types.js'
import { parseToolList } from '../core/tool-policy.js'

/**
 * Materializes a single-agent execution profile as an internal one-step
 * workflow. The wrapper carries the agent reference and nothing about its
 * model: the agent runs with its own pair or the one application default,
 * whether it was started by a schedule or by a person.
 */

export type ScheduledAgentTargetErrorCode =
  | 'unknown_agent'
  | 'materialization_failed'

export class ScheduledAgentTargetError extends Error {
  constructor(
    readonly code: ScheduledAgentTargetErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ScheduledAgentTargetError'
  }
}

export interface ScheduledAgentTargetOptions {
  readonly repoRootPath: string
  readonly workflowsRegistryPath?: string
}

export interface ScheduledAgentTargetRequest {
  readonly agentName: string
  /**
   * A retired schedule setting, still accepted from stored schedules so old
   * records load. It no longer affects the target: the agent runs with its own
   * provider/model, or with the application default.
   */
  readonly modelOverride?: ScheduleModelOverride
}

export type ScheduledAgentTargetResolver = (
  request: ScheduledAgentTargetRequest,
) => Promise<{ workflowId: string }>

const SCHEDULED_ARTIFACT_FILENAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,63})\.md$/
const REQUIRED_SCHEDULED_AGENT_TOOLS: Readonly<Record<string, readonly string[]>> = {
  'web-researcher': ['browser'],
}

export function createScheduledAgentTargetResolver(
  options: ScheduledAgentTargetOptions,
): ScheduledAgentTargetResolver {
  return (request) => ensureScheduledAgentTarget(request, options)
}

/**
 * Render the sealed per-fire workflow snapshot for a generated agent target.
 * The durable shared wrapper remains stable while each scheduled task receives
 * its own user-facing result filename.
 */
export function renderScheduledAgentWorkflowSnapshot(params: {
  agentName: string
  workflowId: string
  resultArtifact: string
}): string {
  if (!SCHEDULED_ARTIFACT_FILENAME_PATTERN.test(params.resultArtifact)) {
    throw new ScheduledAgentTargetError(
      'materialization_failed',
      `Scheduled result artifact '${params.resultArtifact}' is not a safe Markdown filename.`,
    )
  }
  return renderWorkflowTemplate(
    params.agentName,
    params.workflowId,
    params.resultArtifact,
  )
}

export async function ensureScheduledAgentTarget(
  request: ScheduledAgentTargetRequest,
  options: ScheduledAgentTargetOptions,
): Promise<{ workflowId: string }> {
  const agent = listAgents(options.repoRootPath).find(
    (entry) => entry.name === request.agentName && isSelectableAgent(entry),
  )
  if (!agent) {
    throw new ScheduledAgentTargetError(
      'unknown_agent',
      `Agent '${request.agentName}' is not available for scheduling.`,
    )
  }

  const wrapperId = wrapperIdentifier(agent.name)
  const workflowsRegistryPath = options.workflowsRegistryPath ??
    path.join(options.repoRootPath, 'workflows', 'registry.yaml')
  const teamsRegistryPath = path.join(options.repoRootPath, 'teams.yaml')
  const teamDir = path.join(options.repoRootPath, 'teams', wrapperId)
  const teamYamlPath = path.join(teamDir, 'team.yaml')
  const templatePath = path.join(
    path.dirname(workflowsRegistryPath),
    'user-generated',
    `${wrapperId}.yaml`,
  )
  const agentFilePath = path.join(
    options.repoRootPath,
    'agents',
    agent.name,
    `${agent.name}.md`,
  )
  const tools = readDeclaredAgentTools(agentFilePath)
  assertRequiredScheduledAgentTools(agent.name, tools)

  const artifacts = {
    teamYaml: renderTeamYaml({
      agentName: agent.name,
      wrapperId,
      agentFile: relativeYamlPath(teamDir, agentFilePath),
      ...whenDefined(tools, (definedValue) => ({ tools: definedValue })),
    }),
    workflowYaml: renderWorkflowTemplate(agent.name, wrapperId),
    teamRegistryBlock: renderTeamRegistryEntry({
      agentName: agent.name,
      wrapperId,
      teamPath: relativeYamlPath(path.dirname(teamsRegistryPath), teamDir),
    }),
    workflowRegistryBlock: renderWorkflowRegistryEntry({
      agentName: agent.name,
      wrapperId,
      templatePath: relativeYamlPath(
        path.dirname(workflowsRegistryPath),
        templatePath,
      ),
    }),
  }

  const mutationKey = path.join(options.repoRootPath, '.scheduled-agent-targets')
  try {
    await withFileMutationLock(mutationKey, async () => {
      if (await targetMatches({
        wrapperId,
        teamYamlPath,
        templatePath,
        teamsRegistryPath,
        workflowsRegistryPath,
        artifacts,
      })) {
        return
      }

      await fs.mkdir(teamDir, { recursive: true })
      await writeFileAtomic(teamYamlPath, artifacts.teamYaml)
      await fs.mkdir(path.dirname(templatePath), { recursive: true })
      await writeFileAtomic(templatePath, artifacts.workflowYaml)

      // Files are durable before their registry entries become discoverable.
      await upsertRegistryBlock({
        registryPath: teamsRegistryPath,
        key: wrapperId,
        block: artifacts.teamRegistryBlock,
      })
      await upsertRegistryBlock({
        registryPath: workflowsRegistryPath,
        key: wrapperId,
        block: artifacts.workflowRegistryBlock,
      })

      validateMaterializedTarget({
        wrapperId,
        teamYamlPath,
        teamsRegistryPath,
        workflowsRegistryPath,
      })
    })
  } catch (error) {
    if (error instanceof ScheduledAgentTargetError) throw error
    throw new ScheduledAgentTargetError(
      'materialization_failed',
      `Scheduled-agent target for '${request.agentName}' could not be materialized.`,
      { cause: error },
    )
  }

  return { workflowId: wrapperId }
}

/**
 * One wrapper per agent.
 *
 * A schedule no longer varies the model, so there is nothing left to
 * distinguish two wrappers for the same agent, and a per-profile hash would
 * only leave orphaned wrappers behind.
 */
function wrapperIdentifier(agentName: string): string {
  return `scheduled-agent-${sanitizeWrapperSegment(agentName)}`
}

function readDeclaredAgentTools(agentFilePath: string): string[] | undefined {
  return parseToolList(parseAgentFrontmatter(agentFilePath).frontmatter.tools)
}

function assertRequiredScheduledAgentTools(
  agentName: string,
  tools: readonly string[] | undefined,
): void {
  const requiredTools = REQUIRED_SCHEDULED_AGENT_TOOLS[agentName] ?? []
  const missingTools = requiredTools.filter((tool) => !tools?.includes(tool))
  if (missingTools.length === 0) return

  throw new ScheduledAgentTargetError(
    'materialization_failed',
    `Agent '${agentName}' cannot be scheduled because its persona is missing required tool permission${missingTools.length === 1 ? '' : 's'}: ${missingTools.join(', ')}.`,
  )
}

async function targetMatches(params: {
  wrapperId: string
  teamYamlPath: string
  templatePath: string
  teamsRegistryPath: string
  workflowsRegistryPath: string
  artifacts: {
    teamYaml: string
    workflowYaml: string
    teamRegistryBlock: string
    workflowRegistryBlock: string
  }
}): Promise<boolean> {
  const [teamYaml, workflowYaml, teamsRegistry, workflowsRegistry] =
    await Promise.all([
      readTextIfExists(params.teamYamlPath),
      readTextIfExists(params.templatePath),
      readTextIfExists(params.teamsRegistryPath),
      readTextIfExists(params.workflowsRegistryPath),
    ])
  if (
    teamYaml !== params.artifacts.teamYaml ||
    workflowYaml !== params.artifacts.workflowYaml ||
    extractTopLevelBlock(teamsRegistry ?? '', params.wrapperId).trim() !==
      params.artifacts.teamRegistryBlock.trim() ||
    extractTopLevelBlock(workflowsRegistry ?? '', params.wrapperId).trim() !==
      params.artifacts.workflowRegistryBlock.trim()
  ) {
    return false
  }
  try {
    validateMaterializedTarget(params)
    return true
  } catch {
    return false
  }
}

function validateMaterializedTarget(params: {
  wrapperId: string
  teamYamlPath: string
  teamsRegistryPath: string
  workflowsRegistryPath: string
}): void {
  const teamConfig = parseTeamConfig(params.teamYamlPath)
  if (!teamConfig.config || teamConfig.errors.length > 0) {
    throw new Error(teamConfig.errors.join('; ') || 'Generated team is invalid.')
  }
  const teamRegistry = parseTeamRegistry(params.teamsRegistryPath)
  if (teamRegistry.errors.length > 0) {
    throw new Error(teamRegistry.errors.join('; '))
  }
  const teamEntry = teamRegistry.entries.find(
    (entry) => entry.name === params.wrapperId && entry.type === 'team',
  )
  if (!teamEntry) {
    throw new Error(`Generated team '${params.wrapperId}' is not registered.`)
  }

  const workflowRegistry = parseWorkflowRegistry(params.workflowsRegistryPath)
  if (workflowRegistry.errors.length > 0) {
    throw new Error(workflowRegistry.errors.join('; '))
  }
  const workflowEntry = workflowRegistry.entries.find(
    (entry) => entry.name === params.wrapperId,
  )
  if (!workflowEntry) {
    throw new Error(`Generated workflow '${params.wrapperId}' is not registered.`)
  }
  const parsedWorkflow = parseWorkflowTemplate(workflowEntry.template_path)
  if (!parsedWorkflow.template || parsedWorkflow.errors.length > 0) {
    throw new Error(parsedWorkflow.errors.join('; ') || 'Generated workflow is invalid.')
  }
  const validationErrors = validateWorkflowTemplate(
    parsedWorkflow.template,
    new Map(teamRegistry.entries.map((entry) => [entry.name, entry])),
  )
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join('; '))
  }
}

function sanitizeWrapperSegment(name: string): string {
  const safe = sanitizeSegment(name)
  if (!safe) {
    throw new ScheduledAgentTargetError(
      'unknown_agent',
      `Agent name '${name}' cannot be used in a wrapper identifier.`,
    )
  }
  return safe
}

function renderTeamYaml(params: {
  agentName: string
  wrapperId: string
  agentFile: string
  tools?: readonly string[]
}): string {
  const lines = [
    'team:',
    `  name: ${params.wrapperId}`,
    `  description: ${yamlQuoted(`Internal single-agent target for scheduled runs of ${params.agentName}.`)}`,
    "  version: '0.1.0'",
    '',
    'workflow:',
    '  entry_level: run',
    '  invocation_modes:',
    '    - team',
    '  user_facing: false',
    '  output_contract:',
    '    artifacts:',
    '      - path: result.md',
    '        required: true',
    `        description: ${yamlQuoted(`Result produced by ${params.agentName}.`)}`,
    '    completion_artifact: result.md',
    '',
    'agents:',
    `  - name: ${params.agentName}`,
    '    type: agent',
    `    role: ${yamlQuoted(`Standalone scheduled execution of ${params.agentName}.`)}`,
    `    agent_file: ${yamlQuoted(params.agentFile)}`,
  ]
  if (params.tools !== undefined) {
    if (params.tools.length === 0) {
      lines.push('    tools: none')
    } else {
      lines.push(
        '    tools:',
        ...params.tools.map((tool) => `      - ${yamlQuoted(tool)}`),
      )
    }
  }
  lines.push(
    '    produces:',
    '      - path: result.md',
    '',
    'levels:',
    '  - id: run',
    '    name: Run',
    '    order: 0',
    '    stage:',
    '      type: chain',
    '      sequence:',
    `        - ${params.agentName}`,
    '',
  )
  return lines.join('\n')
}

function renderTeamRegistryEntry(params: {
  agentName: string
  wrapperId: string
  teamPath: string
}): string {
  return [
    `${params.wrapperId}:`,
    '  type: team',
    `  description: ${yamlQuoted(`Internal single-agent target for scheduled runs of ${params.agentName}.`)}`,
    `  team_path: ${yamlQuoted(params.teamPath)}`,
    '  input_artifact: incoming-brief.md',
    '  output_artifact: result.md',
    '  tags:',
    '    - internal',
    '',
  ].join('\n')
}

function renderWorkflowTemplate(
  agentName: string,
  wrapperId: string,
  resultArtifact = 'result.md',
): string {
  const stepId = `run-${sanitizeWrapperSegment(agentName)}`
  return [
    'workflow:',
    `  id: ${wrapperId}`,
    `  description: ${yamlQuoted(`Scheduled run of ${agentName}.`)}`,
    '  input:',
    '    artifact: incoming-brief.md',
    '  steps:',
    `    - id: ${stepId}`,
    '      type: agent',
    `      team: ${wrapperId}`,
    `      agent: ${agentName}`,
    '      stage_type: chain',
    '      input_artifact: incoming-brief.md',
    `      result_artifact: ${resultArtifact}`,
    `      requested_result_type: 'artifact:${resultArtifact}'`,
    '  output:',
    `    from_step: ${stepId}`,
    `    artifact: ${resultArtifact}`,
    '  on_blocked: stop',
    '  on_failed: stop',
    '',
  ].join('\n')
}

function renderWorkflowRegistryEntry(params: {
  agentName: string
  wrapperId: string
  templatePath: string
}): string {
  return [
    `${params.wrapperId}:`,
    `  description: ${yamlQuoted(`Scheduled run of ${params.agentName}.`)}`,
    `  template_path: ${yamlQuoted(params.templatePath)}`,
    '  tags:',
    `    - ${SCHEDULER_GENERATED_TAG}`,
    '',
  ].join('\n')
}
