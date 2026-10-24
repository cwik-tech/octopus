import { whenDefined } from '../../core/optional-properties.js'
import * as path from 'node:path'
import { parseTeamConfig } from '../../parsers/team-config.js'
import { deriveEffectiveStageContracts, deriveEffectiveWorkflowTemplateContracts } from '../stage/stage-contracts.js'
import type {
  TeamConfig,
  TeamInvocationContract,
  TeamRegistryEntry,
  TeamResultContract,
} from '../../core/types.js'

export interface ResolvedChildTeamContract {
  teamConfig: TeamConfig
  teamConfigPath: string
  acceptedInvocationModes: Array<'user' | 'external' | 'team'>
  capabilities: string[]
  inputArtifact: string
  completionArtifact: string
  supportedResultArtifacts: string[]
  supportedResultTypes: string[]
}

export interface ResolvedDelegationRequest {
  requestedResultType: string
  requestedArtifact: string
}

export function toArtifactResultType(artifactPath: string): string {
  return `artifact:${artifactPath}`
}

export function parseRequestedResultType(resultType: string): string {
  return resultType.startsWith('artifact:') ? resultType.slice('artifact:'.length) : resultType
}

function looksLikeArtifactPath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value.includes('.')
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

export function resolveChildTeamContract(teamEntry: TeamRegistryEntry): ResolvedChildTeamContract {
  const teamConfigPath = path.join(teamEntry.team_path, 'team.yaml')
  const parsed = parseTeamConfig(teamConfigPath)
  if (!parsed.config || parsed.errors.length > 0) {
    throw new Error(
      `Cannot resolve workflow contract for child team '${teamEntry.name}' from ${teamConfigPath}: ` +
      `${parsed.errors.join('; ') || 'unknown parse error'}`,
    )
  }

  // A team whose build has not finished is not launchable. Filtering the
  // catalogs stops it being offered; it does not stop a launch by id — a
  // workflow step that names it, a `spawn_team` call, a saved chat target — and
  // an unfinished team fails at run time in a way the user did not cause.
  //
  // This resolver is the one place every delegated launch goes through, so the
  // refusal is stated once and reads the same wherever it is met.
  if (parsed.config.team.building === true) {
    throw new Error(
      `Team '${teamEntry.name}' is still being built and cannot be run yet. ` +
        `Wait for its build to finish.`,
    )
  }

  const workflowContracts = deriveEffectiveWorkflowTemplateContracts(parsed.config)
  const inputArtifact = teamEntry.input_artifact ??
    workflowContracts.input.artifacts?.[0]?.path ??
    'incoming-brief.md'
  const completionArtifact = workflowContracts.output.completion_artifact ??
    teamEntry.output_artifact ??
    ''
  if (!completionArtifact) {
    throw new Error(
      `Child team '${teamEntry.name}' does not declare a completion artifact in its workflow contract.`,
    )
  }

  const levels = parsed.config.levels
  const supportedArtifacts = unique([
    completionArtifact,
    teamEntry.output_artifact ?? '',
    ...(workflowContracts.output.artifacts ?? []).map((artifact) => artifact.path),
    ...levels.flatMap((level) => {
      const contracts = deriveEffectiveStageContracts(levels, level.id)
      return [
        contracts.output.completion_artifact ?? '',
        ...(contracts.output.artifacts ?? []).map((artifact) => artifact.path),
      ]
    }),
  ])

  return {
    teamConfig: parsed.config,
    teamConfigPath,
    acceptedInvocationModes: parsed.config.workflow?.invocation_modes ?? ['user'],
    capabilities: parsed.config.workflow?.capabilities ?? [],
    inputArtifact,
    completionArtifact,
    supportedResultArtifacts: supportedArtifacts,
    supportedResultTypes: supportedArtifacts.map((artifactPath) => toArtifactResultType(artifactPath)),
  }
}

export function resolveDelegationRequest(params: {
  teamEntry: TeamRegistryEntry
  requestedResultType?: string
}): ResolvedDelegationRequest & { childContract: ResolvedChildTeamContract } {
  const childContract = resolveChildTeamContract(params.teamEntry)
  const rawRequestedResultType =
    params.requestedResultType ??
    params.teamEntry.output_artifact ??
    childContract.completionArtifact
  const parsedRequestedArtifact = parseRequestedResultType(rawRequestedResultType)
  const requestedArtifact =
    childContract.supportedResultArtifacts.includes(parsedRequestedArtifact)
      ? parsedRequestedArtifact
      : !looksLikeArtifactPath(parsedRequestedArtifact)
        ? childContract.completionArtifact
        : parsedRequestedArtifact

  if (!childContract.supportedResultArtifacts.includes(requestedArtifact)) {
    throw new Error(
      `Child team '${params.teamEntry.name}' does not support requested result '${requestedArtifact}'. ` +
      `Supported child results: ${childContract.supportedResultArtifacts.join(', ')}`,
    )
  }

  if (!childContract.acceptedInvocationModes.includes('team')) {
    throw new Error(
      `Child team '${params.teamEntry.name}' does not accept team-to-team invocation. ` +
      `Accepted modes: ${childContract.acceptedInvocationModes.join(', ') || '(none)'}`,
    )
  }

  return {
    childContract,
    requestedArtifact,
    requestedResultType: toArtifactResultType(requestedArtifact),
  }
}

export function buildDelegationInvocationContract(params: {
  jobId: string
  parentJobId?: string
  rootJobId?: string
  callerTeam: string
  targetTeam: string
  requestedCapability?: string
  requestedResultType: string
  inputPayload: string
  inputArtifactRefs?: string[]
  budgetUsd?: number
  timeoutMinutes?: number
  lineageMetadata?: Record<string, string>
}): TeamInvocationContract {
  return {
    job_id: params.jobId,
    ...whenDefined(params.parentJobId, (definedValue) => ({ parent_job_id: definedValue })),
    ...whenDefined(params.rootJobId, (definedValue) => ({ root_job_id: definedValue })),
    caller_team: params.callerTeam,
    target_team: params.targetTeam,
    ...whenDefined(params.requestedCapability, (definedValue) => ({ requested_capability: definedValue })),
    requested_result_type: params.requestedResultType,
    input_payload: params.inputPayload,
    ...whenDefined(params.inputArtifactRefs, (definedValue) => ({ input_artifact_refs: definedValue })),
    constraints: {
      ...whenDefined(params.budgetUsd, (budget_usd) => ({ budget_usd })),
      ...whenDefined(params.timeoutMinutes, (timeout_minutes) => ({ timeout_minutes })),
    },
    ...whenDefined(params.lineageMetadata, (definedValue) => ({ lineage_metadata: definedValue })),
  }
}

export function buildDelegationResultContract(params: {
  jobId: string
  parentJobId?: string
  rootJobId?: string
  team: string
  resultType: string
  status: TeamResultContract['status']
  primaryArtifact?: string
  diagnostics?: string[]
  lineage?: Record<string, string>
}): TeamResultContract {
  return {
    job_id: params.jobId,
    ...whenDefined(params.parentJobId, (parent_job_id) => ({ parent_job_id })),
    ...whenDefined(params.rootJobId, (root_job_id) => ({ root_job_id })),
    team: params.team,
    result_type: params.resultType,
    status: params.status,
    ...whenDefined(params.primaryArtifact, (primary_artifact) => ({ primary_artifact })),
    ...whenDefined(params.diagnostics, (diagnostics) => ({ diagnostics })),
    ...whenDefined(params.lineage, (lineage) => ({ lineage })),
  }
}
