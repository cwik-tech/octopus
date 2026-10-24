import * as fs from 'node:fs'
import * as path from 'node:path'

import type { LevelConfig, TeamConfig } from '../../core/types.js'
import {
  resolveExistingPathInside,
  resolveRelativePathInside,
} from '../../core/path-safety.js'
import { deriveEffectiveStageContractsForTeam } from './stage-contracts.js'

interface RuntimeAutostartInputParams {
  assignmentPath: string
  teamConfig: TeamConfig
  level: LevelConfig
  delegatedInputArtifact?: string
}

interface RuntimeAutostartOutputOverrideParams {
  teamConfig: TeamConfig
  level: LevelConfig
  delegatedOutputArtifact: string | undefined
}

/** Accept a process-level output only when the active stage declares it. */
export function resolveRuntimeAutostartOutputOverride(
  params: RuntimeAutostartOutputOverrideParams,
): string | undefined {
  const delegatedOutputArtifact = params.delegatedOutputArtifact?.trim()
  if (!delegatedOutputArtifact) return undefined

  const outputContract = deriveEffectiveStageContractsForTeam(
    params.teamConfig,
    params.level.id,
  ).output
  const activeOutputArtifacts = new Set([
    ...(outputContract.artifacts?.map((artifact) => artifact.path.trim()) ?? []),
    outputContract.completion_artifact?.trim(),
  ].filter((artifact): artifact is string => Boolean(artifact)))

  return activeOutputArtifacts.has(delegatedOutputArtifact)
    ? delegatedOutputArtifact
    : undefined
}

/**
 * Read the artifact that is input to the active level.
 *
 * The process-level delegated input belongs only to the workflow entry. Later
 * levels consume their declared input and the previous level's output, just as
 * the deterministic engines do. Keeping that distinction here prevents a
 * later lead from planning against the original request while its specialists
 * work from a revised artifact.
 */
export function readRuntimeAutostartInput(
  params: RuntimeAutostartInputParams,
): string {
  const entryLevelId = params.teamConfig.workflow?.entry_level
    ?? params.teamConfig.levels[0]?.id
  const contractedArtifacts = deriveEffectiveStageContractsForTeam(
    params.teamConfig,
    params.level.id,
  ).input.artifacts?.map((artifact) => artifact.path) ?? []
  const delegatedArtifact = params.delegatedInputArtifact?.trim()
  const candidates = [
    ...(params.level.id === entryLevelId && delegatedArtifact
      ? [delegatedArtifact]
      : []),
    ...contractedArtifacts,
  ]

  const seen = new Set<string>()
  for (const candidate of candidates) {
    const candidatePath = resolveAssignmentArtifactPath(
      params.assignmentPath,
      candidate,
    )
    if (!candidatePath || seen.has(candidatePath)) continue
    seen.add(candidatePath)
    const existingPath = resolveExistingPathInside(
      params.assignmentPath,
      candidatePath,
    )
    if (!existingPath || !fs.statSync(existingPath).isFile()) continue
    const contents = fs.readFileSync(existingPath, 'utf8')
    if (contents.trim()) return contents
  }
  return ''
}

function resolveAssignmentArtifactPath(
  assignmentPath: string,
  configuredPath: string,
): string | null {
  const assignmentRoot = path.resolve(assignmentPath)
  const relativePath = path.isAbsolute(configuredPath)
    ? path.relative(assignmentRoot, configuredPath)
    : configuredPath
  return resolveRelativePathInside(
    assignmentRoot,
    relativePath.split(path.sep).join('/'),
  )
}
