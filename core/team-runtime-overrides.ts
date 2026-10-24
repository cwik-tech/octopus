import type {
  DiscussionStageConfig,
  ReviewStageConfig,
  TeamConfig,
  TeamRuntimeOverrides,
} from './types.js'
import { STAGE_TYPE } from './constants.js'

function selectedStageOutputArtifact(
  level: TeamConfig['levels'][number],
): string {
  if (level.stage.type === STAGE_TYPE.PIPELINE) {
    return level.stage.config.output_contract?.completion_artifact ?? 'report.md'
  }
  const output = level.stage.config.output
  return output.path ? `${output.path}/${output.format}` : output.format
}

export function applyTeamRuntimeOverrides(
  teamConfig: TeamConfig,
  overrides: TeamRuntimeOverrides | undefined,
): string[] {
  if (!overrides) return []

  const errors: string[] = []

  for (const [levelId, levelOverride] of Object.entries(overrides.levels ?? {})) {
    const level = teamConfig.levels.find((candidate) => candidate.id === levelId)
    if (!level) {
      errors.push(`Runtime override references unknown level '${levelId}'.`)
      continue
    }

    if (levelOverride.discussion) {
      if (level.stage.type !== 'discussion') {
        errors.push(`Runtime override for level '${levelId}' declares discussion settings, but the level is type '${level.stage.type}'.`)
      } else {
        const stage = level.stage as DiscussionStageConfig
        if (levelOverride.discussion.participants) {
          const missing = levelOverride.discussion.participants
            .filter((name) => !teamConfig.agents.some((agent) => agent.name === name))
          if (missing.length > 0) {
            errors.push(`Runtime override for discussion level '${levelId}' references unknown participants: ${missing.join(', ')}`)
          } else {
            stage.participants = [...levelOverride.discussion.participants]
          }
        }
        if (levelOverride.discussion.min_rounds !== undefined) {
          stage.config.min_rounds = Math.max(1, levelOverride.discussion.min_rounds)
        }
        if (levelOverride.discussion.max_rounds !== undefined) {
          stage.config.max_rounds = Math.max(1, levelOverride.discussion.max_rounds)
        }
        if (levelOverride.discussion.min_successful_participants !== undefined) {
          stage.config.min_successful_participants = Math.max(1, levelOverride.discussion.min_successful_participants)
        }
        if (stage.config.min_rounds > stage.config.max_rounds) {
          stage.config.min_rounds = stage.config.max_rounds
        }
      }
    }

    if (levelOverride.review) {
      if (level.stage.type !== 'review') {
        errors.push(`Runtime override for level '${levelId}' declares review settings, but the level is type '${level.stage.type}'.`)
      } else {
        const stage = level.stage as ReviewStageConfig
        if (levelOverride.review.max_iterations !== undefined) {
          stage.config.max_iterations = Math.max(1, levelOverride.review.max_iterations)
        }
      }
    }
  }

  const selectedLevel = overrides.stage_type
    ? teamConfig.levels.find((level) => level.stage.type === overrides.stage_type)
    : undefined
  if (overrides.stage_type && !selectedLevel) {
    errors.push(
      `Runtime override references unavailable stage type '${overrides.stage_type}'.`,
    )
  }

  if (selectedLevel) {
    const outputArtifact = selectedStageOutputArtifact(selectedLevel)
    teamConfig.levels = [selectedLevel]
    teamConfig.gates = [{
      from: selectedLevel.id,
      to: 'done',
      condition: { type: 'artifact_exists', artifact: outputArtifact },
    }]
    teamConfig.workflow = {
      ...teamConfig.workflow,
      entry_level: selectedLevel.id,
      output_contract: {
        artifacts: [{ path: outputArtifact, required: true }],
        completion_artifact: outputArtifact,
      },
    }
  }

  return errors
}
