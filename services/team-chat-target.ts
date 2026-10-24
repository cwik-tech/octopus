/**
 * Materializes a chat-selected team as an internal one-step workflow, so a team
 * can be launched through the ordinary task path without a team-specific run API.
 *
 * Unlike `scheduled-agent-target.ts`, the team itself already exists and is
 * registered — only the workflow wrapper is generated here.
 */

import { whenDefined } from '../core/optional-properties.js'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type {
  RegistryEntry,
  TeamConfig,
  TeamRegistryEntry,
  WorkflowTemplateConfig,
} from '../core/types.js'
import { withFileMutationLock, writeFileAtomic } from '../core/file-mutation.js'
import { parseTeamConfig } from '../parsers/team-config.js'
import { parseTeamRegistry } from '../parsers/team-registry.js'
import { deriveEffectiveWorkflowTemplateContracts } from '../domains/stage/stage-contracts.js'
import {
  parseWorkflowRegistry,
  parseWorkflowTemplate,
  parseWorkflowTemplateYaml,
} from '../workflows/loader.js'
import { validateWorkflowTemplate } from '../workflows/validation.js'
import {
  CHAT_GENERATED_TAG,
  extractTopLevelBlock,
  readTextIfExists,
  relativeYamlPath,
  replaceTopLevelBlock,
  sanitizeWrapperSegment,
  yamlQuoted,
} from './generated-target-registry.js'

const FALLBACK_INPUT_ARTIFACT = 'incoming-brief.md'
const FALLBACK_RESULT_ARTIFACT = 'final-result.md'

export type TeamChatTargetErrorCode =
  | 'unknown_team'
  | 'team_not_user_invocable'
  | 'materialization_failed'

export class TeamChatTargetError extends Error {
  constructor(
    readonly code: TeamChatTargetErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'TeamChatTargetError'
  }
}

export interface TeamChatTargetOptions {
  readonly repoRootPath: string
  readonly workflowsRegistryPath?: string
  /** Observability hook for durable publication boundaries. */
  readonly onPersistenceBoundary?: (
    boundary: TeamChatTargetPersistenceBoundary,
  ) => void | Promise<void>
}

export type TeamChatTargetPersistenceBoundary =
  | 'after_template_written'
  | 'after_registry_published'

export interface TeamChatTargetRequest {
  readonly teamId: string
}

export type TeamChatTargetResolver = (
  request: TeamChatTargetRequest,
) => Promise<{ workflowId: string }>

export function createTeamChatTargetResolver(
  options: TeamChatTargetOptions,
): TeamChatTargetResolver {
  return (request) => ensureTeamChatTarget(request, options)
}

export async function ensureTeamChatTarget(
  request: TeamChatTargetRequest,
  options: TeamChatTargetOptions,
): Promise<{ workflowId: string }> {
  const workflowsRegistryPath = options.workflowsRegistryPath ??
    path.join(options.repoRootPath, 'workflows', 'registry.yaml')
  const teamsRegistryPath = path.join(options.repoRootPath, 'teams.yaml')

  const teamRegistry = parseTeamRegistry(teamsRegistryPath)
  if (teamRegistry.errors.length > 0) {
    throw new TeamChatTargetError(
      'materialization_failed',
      `Team registry is invalid: ${teamRegistry.errors.join('; ')}`,
    )
  }
  const teamEntry = teamRegistry.entries.find(
    (entry): entry is TeamRegistryEntry =>
      entry.type === 'team' && entry.name === request.teamId,
  )
  if (!teamEntry) {
    throw new TeamChatTargetError(
      'unknown_team',
      `Team '${request.teamId}' is not registered.`,
    )
  }

  const segment = sanitizeWrapperSegment(request.teamId)
  if (!segment) {
    throw new TeamChatTargetError(
      'unknown_team',
      `Team name '${request.teamId}' cannot be used in a wrapper identifier.`,
    )
  }
  const wrapperId = teamChatWrapperIdentifier(request.teamId, segment)
  const templatePath = path.join(
    path.dirname(workflowsRegistryPath),
    'user-generated',
    `${wrapperId}.yaml`,
  )

  // The team's own declarations are the authority: a caller-only team expects
  // another team to prepare its inputs, so chat must not launch it even if a
  // client asks. Enforced here, not only in the picker.
  const teamPath = path.resolve(path.dirname(teamsRegistryPath), teamEntry.team_path)
  const parsedTeam = parseTeamConfig(path.join(teamPath, 'team.yaml'))
  if (!parsedTeam.config) {
    throw new TeamChatTargetError(
      'materialization_failed',
      `Team '${request.teamId}' has invalid configuration: ${parsedTeam.errors.join('; ')}`,
    )
  }
  // A team whose build has not finished is a shell: no roster, and a completion
  // gate it cannot satisfy. Chat materializes its own wrapper and reads the
  // config itself, so the shared delegated-launch guard never sees it — and
  // without this, chat wrote a wrapper for a team that fails the moment it runs.
  if (parsedTeam.config.team?.building === true) {
    throw new TeamChatTargetError(
      'team_not_user_invocable',
      `Team '${request.teamId}' is still being built and cannot be run yet. ` +
        `Wait for its build to finish.`,
    )
  }
  if (!isUserInvocable(parsedTeam.config.workflow)) {
    throw new TeamChatTargetError(
      'team_not_user_invocable',
      `Team '${request.teamId}' does not declare itself invocable by a user.`,
    )
  }

  const workflowRegistry = parseWorkflowRegistry(workflowsRegistryPath)
  if (workflowRegistry.errors.length > 0) {
    throw new TeamChatTargetError(
      'materialization_failed',
      `Workflow registry is invalid: ${workflowRegistry.errors.join('; ')}`,
    )
  }

  const contracts = readTeamArtifactContracts(parsedTeam.config, teamEntry)
  const artifacts = {
    workflowYaml: renderWorkflowTemplate({
      teamId: request.teamId,
      wrapperId,
      segment,
      ...contracts,
    }),
    workflowRegistryBlock: renderWorkflowRegistryEntry({
      teamId: request.teamId,
      wrapperId,
      templatePath: relativeYamlPath(
        path.dirname(workflowsRegistryPath),
        templatePath,
      ),
    }),
  }
  validateRenderedWorkflow(artifacts.workflowYaml, teamRegistry.entries)

  try {
    if (
      await targetMatches({
        wrapperId,
        templatePath,
        teamsRegistryPath,
        workflowsRegistryPath,
        artifacts,
      })
    ) {
      return { workflowId: wrapperId }
    }

    await publishTeamChatTarget({
      templatePath,
      registryPath: workflowsRegistryPath,
      wrapperId,
      teamsRegistryPath,
      workflowsRegistryPath,
      artifacts,
      ...whenDefined(
        options.onPersistenceBoundary,
        (onPersistenceBoundary) => ({ onPersistenceBoundary }),
      ),
    })
  } catch (error) {
    if (error instanceof TeamChatTargetError) throw error
    throw new TeamChatTargetError(
      'materialization_failed',
      `Chat target for team '${request.teamId}' could not be materialized.`,
      { cause: error },
    )
  }

  return { workflowId: wrapperId }
}

function validateRenderedWorkflow(
  workflowYaml: string,
  teamEntries: readonly RegistryEntry[],
): void {
  const parsed = parseWorkflowTemplateYaml(workflowYaml)
  if (!parsed.template || parsed.errors.length > 0) {
    throw new TeamChatTargetError(
      'materialization_failed',
      parsed.errors.join('; ') || 'Generated workflow is invalid.',
    )
  }
  const validationErrors = validateWorkflowTemplate(
    parsed.template,
    new Map(teamEntries.map((entry) => [entry.name, entry])),
  )
  if (validationErrors.length > 0) {
    throw new TeamChatTargetError(
      'materialization_failed',
      validationErrors.join('; '),
    )
  }
}

function teamChatWrapperIdentifier(teamId: string, segment: string): string {
  const identityHash = crypto
    .createHash('sha256')
    .update(teamId)
    .digest('hex')
    .slice(0, 12)
  return `team-chat-${segment}-${identityHash}`
}

async function publishTeamChatTarget(params: {
  templatePath: string
  registryPath: string
  wrapperId: string
  teamsRegistryPath: string
  workflowsRegistryPath: string
  artifacts: {
    workflowYaml: string
    workflowRegistryBlock: string
  }
  onPersistenceBoundary?: (
    boundary: TeamChatTargetPersistenceBoundary,
  ) => void | Promise<void>
}): Promise<void> {
  await withFileMutationLock(params.registryPath, async () => {
    const [previousTemplate, previousRegistryText] = await Promise.all([
      readTextIfExists(params.templatePath),
      readTextIfExists(params.registryPath),
    ])
    const previousRegistry = previousRegistryText ?? ''
    const nextRegistry = replaceTopLevelBlock(
      previousRegistry,
      params.wrapperId,
      params.artifacts.workflowRegistryBlock,
    )

    if (
      previousTemplate === params.artifacts.workflowYaml &&
      previousRegistry === nextRegistry
    ) {
      validateMaterializedTarget(params)
      return
    }

    let templateChanged = false
    let registryChanged = false
    try {
      if (previousTemplate !== params.artifacts.workflowYaml) {
        await writeFileAtomic(params.templatePath, params.artifacts.workflowYaml)
        templateChanged = true
      }
      await params.onPersistenceBoundary?.('after_template_written')

      if (previousRegistry !== nextRegistry) {
        await writeFileAtomic(params.registryPath, nextRegistry)
        registryChanged = true
      }
      await params.onPersistenceBoundary?.('after_registry_published')

      validateMaterializedTarget(params)
    } catch (error) {
      const rollbackErrors: unknown[] = []
      if (registryChanged) {
        try {
          await restoreFile(params.registryPath, previousRegistryText)
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
      if (templateChanged) {
        try {
          await restoreFile(params.templatePath, previousTemplate)
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          `Team chat target '${params.wrapperId}' failed and could not be rolled back cleanly.`,
        )
      }
      throw error
    }
  })
}

async function restoreFile(
  filePath: string,
  previousContents: string | undefined,
): Promise<void> {
  if (previousContents === undefined) {
    await fs.rm(filePath, { force: true })
    return
  }
  await writeFileAtomic(filePath, previousContents)
}

async function targetMatches(params: {
  wrapperId: string
  templatePath: string
  teamsRegistryPath: string
  workflowsRegistryPath: string
  artifacts: {
    workflowYaml: string
    workflowRegistryBlock: string
  }
}): Promise<boolean> {
  const [workflowYaml, workflowsRegistry] = await Promise.all([
    readTextIfExists(params.templatePath),
    readTextIfExists(params.workflowsRegistryPath),
  ])
  if (
    workflowYaml !== params.artifacts.workflowYaml ||
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
  teamsRegistryPath: string
  workflowsRegistryPath: string
}): void {
  const teamRegistry = parseTeamRegistry(params.teamsRegistryPath)
  if (teamRegistry.errors.length > 0) {
    throw new Error(teamRegistry.errors.join('; '))
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
    throw new Error(
      parsedWorkflow.errors.join('; ') || 'Generated workflow is invalid.',
    )
  }
  const validationErrors = validateWorkflowTemplate(
    parsedWorkflow.template,
    new Map(teamRegistry.entries.map((entry) => [entry.name, entry])),
  )
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join('; '))
  }
}

/**
 * The wrapper must speak the team's own artifact contract — workflow validation
 * rejects a step whose `result_artifact` differs from the team's completion
 * artifact, and those differ per team (`result.md`, `output/plan.md`, ...).
 */
function readTeamArtifactContracts(
  teamConfig: TeamConfig,
  teamEntry: { input_artifact?: string; output_artifact?: string },
): { inputArtifact: string; resultArtifact: string } {
  const derived = deriveEffectiveWorkflowTemplateContracts(teamConfig)
  return {
    inputArtifact:
      teamEntry.input_artifact ??
      derived?.input.artifacts?.[0]?.path ??
      FALLBACK_INPUT_ARTIFACT,
    resultArtifact:
      derived?.output.completion_artifact ??
      teamEntry.output_artifact ??
      FALLBACK_RESULT_ARTIFACT,
  }
}

function renderWorkflowTemplate(params: {
  teamId: string
  wrapperId: string
  segment: string
  inputArtifact: string
  resultArtifact: string
}): string {
  const stepId = `run-${params.segment}`
  return [
    'workflow:',
    `  id: ${params.wrapperId}`,
    `  description: ${yamlQuoted(`Chat run of ${params.teamId}.`)}`,
    '  input:',
    `    artifact: ${yamlQuoted(params.inputArtifact)}`,
    '  steps:',
    `    - id: ${stepId}`,
    '      type: team',
    `      team: ${yamlQuoted(params.teamId)}`,
    `      input_artifact: ${yamlQuoted(params.inputArtifact)}`,
    `      result_artifact: ${yamlQuoted(params.resultArtifact)}`,
    `      requested_result_type: ${yamlQuoted(`artifact:${params.resultArtifact}`)}`,
    '  output:',
    `    from_step: ${stepId}`,
    `    artifact: ${yamlQuoted(params.resultArtifact)}`,
    '  on_blocked: stop',
    '  on_failed: stop',
    '',
  ].join('\n')
}

function renderWorkflowRegistryEntry(params: {
  teamId: string
  wrapperId: string
  templatePath: string
}): string {
  return [
    `${params.wrapperId}:`,
    `  description: ${yamlQuoted(`Chat run of ${params.teamId}.`)}`,
    `  template_path: ${yamlQuoted(params.templatePath)}`,
    '  tags:',
    `    - ${CHAT_GENERATED_TAG}`,
    '',
  ].join('\n')
}

function isUserInvocable(workflow: WorkflowTemplateConfig | undefined): boolean {
  if (workflow?.user_facing === false) return false
  return workflow?.invocation_modes?.includes('user') ?? true
}
