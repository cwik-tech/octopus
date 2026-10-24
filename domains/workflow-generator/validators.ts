/**
 * Validation for `WorkflowDraft` against the live registry of teams + agents.
 *
 * Returns two lists:
 *  - `errors`: blocking issues (used by the save endpoint to refuse a write)
 *  - `warnings`: non-blocking advisories (surfaced in chat for iteration)
 */

import type {
  WorkflowDraft,
  WorkflowGeneratorRegistry,
} from './workflow-draft.js'
import { normalizeMcpWorkflowRequirements } from '../../contracts/mcp-workflow-capabilities.js'
import { STAGE_TYPE } from '../../core/constants.js'

const WORKFLOW_STAGE_TYPES = new Set<string>(Object.values(STAGE_TYPE))

export interface DraftValidationResult {
  errors: string[]
  warnings: string[]
}

export function validateDraft(
  draft: WorkflowDraft | null | undefined,
  registry: WorkflowGeneratorRegistry,
): DraftValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (!draft) {
    return { errors, warnings }
  }

  const requireString = (value: unknown, label: string): boolean => {
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`${label} is required`)
      return false
    }
    return true
  }

  requireString(draft.id, 'workflow.id')
  requireString(draft.description, 'workflow.description')
  if (!draft.input || !requireString(draft.input.artifact, 'workflow.input.artifact')) {
    // continue
  }
  if (!Array.isArray(draft.steps) || draft.steps.length === 0) {
    errors.push('workflow.steps must contain at least one step')
  }
  errors.push(
    ...normalizeMcpWorkflowRequirements(
      draft.mcp_requirements,
      'workflow.mcp_requirements',
    ).errors,
  )

  const teamIndex = new Map(registry.teams.map((team) => [team.id, team]))
  const stepIndex = new Map<string, number>()
  if (Array.isArray(draft.steps)) {
    draft.steps.forEach((step, index) => {
      if (typeof step.id === 'string' && step.id) stepIndex.set(step.id, index)
    })

    draft.steps.forEach((step, index) => {
      const where = `steps[${index}]${step.id ? ` ('${step.id}')` : ''}`
      if (!requireString(step.id, `${where}.id`)) return
      if (
        step.type !== 'team' &&
        step.type !== 'agent' &&
        step.type !== 'human-in-the-loop'
      ) {
        errors.push(`${where}.type must be 'team', 'agent', or 'human-in-the-loop'`)
      }
      requireString(step.input_artifact, `${where}.input_artifact`)
      const hasResultArtifact = requireString(
        step.result_artifact,
        `${where}.result_artifact`,
      )
      errors.push(
        ...normalizeMcpWorkflowRequirements(
          step.mcp_requirements,
          `${where}.mcp_requirements`,
        ).errors,
      )
      if (
        step.recovery_policy &&
        !['safe_retry', 'idempotent', 'manual', 'never_retry'].includes(
          step.recovery_policy,
        )
      ) {
        errors.push(`${where}.recovery_policy is not supported`)
      }

      if (step.type === 'human-in-the-loop') {
        if (index === 0) {
          errors.push(`${where}: human-in-the-loop step cannot be the first step`)
        }
        if (index === draft.steps.length - 1) {
          errors.push(`${where}: human-in-the-loop step cannot be the final step`)
        }
        const successor = draft.steps[index + 1]
        if (
          successor &&
          successor.type !== 'team' &&
          successor.type !== 'agent'
        ) {
          errors.push(`${where}: human-in-the-loop step must be followed by a team or agent step`)
        }
        if (!step.handoff) {
          errors.push(`${where}: human-in-the-loop step requires a handoff`)
        }
        if (hasResultArtifact && !step.result_artifact.toLowerCase().endsWith('.json')) {
          errors.push(`${where}.result_artifact must be JSON for a human-in-the-loop step`)
        }
        for (const [field, value] of [
          ['team', step.team],
          ['agent', step.agent],
          ['stage_type', step.stage_type],
          ['mcp_requirements', step.mcp_requirements],
          ['runtime_overrides', step.runtime_overrides],
          ['recovery_policy', step.recovery_policy],
        ] as const) {
          if (value !== undefined) {
            errors.push(`${where}: human-in-the-loop step must not declare ${field}`)
          }
        }
      }

      if (step.type === 'human-in-the-loop') {
        validateHandoff(step, index, where, stepIndex, requireString, errors, warnings)
        return
      }

      if (!requireString(step.team, `${where}.team`)) return
      const team = step.team === undefined ? undefined : teamIndex.get(step.team)
      if (!team) {
        errors.push(
          `${where}: team '${step.team}' is not in the registry. Available: ${
            Array.from(teamIndex.keys()).join(', ') || '(none)'
          }`,
        )
        return
      }

      if (step.stage_type && !WORKFLOW_STAGE_TYPES.has(step.stage_type)) {
        errors.push(`${where}.stage_type '${step.stage_type}' is not supported`)
      }
      const selectedLevel = step.type === 'team' && step.stage_type
        ? team.levels?.find((level) => level.stage_type === step.stage_type)
        : undefined
      if (step.type === 'team' && step.stage_type && !selectedLevel) {
        errors.push(
          `${where}: team '${step.team}' does not provide a '${step.stage_type}' stage`,
        )
      }
      if (step.type === 'team' && step.agent) {
        errors.push(`${where}: team steps must not declare agent`)
      }
      if (step.type === 'agent') {
        if (!requireString(step.agent, `${where}.agent`)) return
        if (!step.stage_type) {
          errors.push(`${where}.stage_type is required for agent steps`)
        }
        if (!team.agents.some((agent) => agent.name === step.agent)) {
          errors.push(
            `${where}: agent '${step.agent}' is not on team '${step.team}'. Available: ${
              team.agents.map((agent) => agent.name).join(', ') || '(none)'
            }`,
          )
        }
      }
      const selectedOutput = selectedLevel?.output_format
      if (step.type === 'team' && selectedOutput && step.result_artifact !== selectedOutput) {
        errors.push(
          `${where}.result_artifact '${step.result_artifact}' must match selected stage output '${selectedOutput}'`,
        )
      }

      const overrides = step.runtime_overrides?.levels
      if (overrides) {
        const agentNames = new Set(team.agents.map((agent) => agent.name))
        for (const [levelId, level] of Object.entries(overrides)) {
          const teamLevel = team.levels?.find((candidate) => candidate.id === levelId)
          if (team.level_ids.length > 0 && !team.level_ids.includes(levelId)) {
            warnings.push(
              `${where}: runtime_overrides references unknown level '${levelId}' on team '${step.team}'. Known levels: ${team.level_ids.join(', ')}`,
            )
          }
          if (level.discussion && teamLevel && teamLevel.stage_type !== 'discussion') {
            errors.push(
              `${where}: runtime_overrides level '${levelId}' declares discussion settings, but team '${step.team}' level is type '${teamLevel.stage_type}'`,
            )
          }
          if (level.review && teamLevel && teamLevel.stage_type !== 'review') {
            errors.push(
              `${where}: runtime_overrides level '${levelId}' declares review settings, but team '${step.team}' level is type '${teamLevel.stage_type}'`,
            )
          }
          const participants = level.discussion?.participants
          if (participants) {
            for (const participant of participants) {
              if (!agentNames.has(participant)) {
                errors.push(
                  `${where}: discussion participant '${participant}' is not an agent of team '${step.team}'. Available: ${
                    Array.from(agentNames).join(', ') || '(none)'
                  }`,
                )
              }
            }
          }
        }
      }

      validateHandoff(step, index, where, stepIndex, requireString, errors, warnings)
    })
  }

  if (draft.output) {
    if (requireString(draft.output.from_step, 'workflow.output.from_step')) {
      if (!stepIndex.has(draft.output.from_step)) {
        errors.push(
          `workflow.output.from_step '${draft.output.from_step}' does not match any step id`,
        )
      }
    }
    requireString(draft.output.artifact, 'workflow.output.artifact')
  } else {
    errors.push('workflow.output is required')
  }

  if (draft.on_blocked !== 'stop' && draft.on_blocked !== 'escalate_to_user') {
    errors.push(`workflow.on_blocked must be 'stop' or 'escalate_to_user'`)
  }
  if (draft.on_failed !== 'stop' && draft.on_failed !== 'escalate_to_user') {
    errors.push(`workflow.on_failed must be 'stop' or 'escalate_to_user'`)
  }

  return { errors, warnings }
}

function validateHandoff(
  step: WorkflowDraft['steps'][number],
  index: number,
  where: string,
  stepIndex: ReadonlyMap<string, number>,
  requireString: (value: unknown, label: string) => boolean,
  errors: string[],
  warnings: string[],
): void {
  if (step.handoff) {
    const fromIdx = stepIndex.get(step.handoff.from_step)
    if (fromIdx === undefined) {
      errors.push(`${where}: handoff.from_step '${step.handoff.from_step}' does not exist`)
    } else if (fromIdx >= index) {
      errors.push(`${where}: handoff.from_step '${step.handoff.from_step}' must be an earlier step`)
    }
    requireString(step.handoff.from_artifact, `${where}.handoff.from_artifact`)
    requireString(step.handoff.to_artifact, `${where}.handoff.to_artifact`)
  } else if (index > 0) {
    warnings.push(
      `${where}: chained step has no handoff block — input may not be wired from any previous step`,
    )
  }
}
