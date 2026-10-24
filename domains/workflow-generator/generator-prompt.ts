/**
 * Runtime prompt rendering for the workflow architect.
 *
 * The static agent prompt and model configuration are loaded by the provider
 * configuration seam. This module owns the request-time registry rendering.
 */

import type { WorkflowGeneratorRegistry } from './workflow-draft.js'

/**
 * Build the runtime-injected registry block. Appended to the static system
 * prompt by `runGeneratorTurn`.
 */
export function renderRegistryBlock(registry: WorkflowGeneratorRegistry): string {
  const lines: string[] = []
  lines.push('## Available teams (use these and only these)')
  if (registry.teams.length === 0) {
    lines.push('')
    lines.push('(No teams are registered.)')
    return lines.join('\n')
  }
  for (const team of registry.teams) {
    lines.push('')
    lines.push(`- **${team.id}**${team.description ? ` — ${team.description}` : ''}`)
    if (team.default_input_artifact || team.default_output_artifact) {
      lines.push(
        `    default_input_artifact: ${team.default_input_artifact ?? '(unset)'}`,
      )
      lines.push(
        `    default_output_artifact: ${team.default_output_artifact ?? '(unset)'}`,
      )
    }
    if (team.level_ids.length > 0) {
      lines.push(`    level_ids: ${team.level_ids.join(', ')}`)
    }
    if (team.levels && team.levels.length > 0) {
      lines.push('    levels:')
      for (const level of team.levels) {
        const name = level.name ? ` (${level.name})` : ''
        lines.push(`      - ${level.id}${name}`)
        lines.push(`          stage_type: ${level.stage_type}`)
        if (level.coordinator) {
          lines.push(`          coordinator: ${level.coordinator}`)
        }
        if (level.participants && level.participants.length > 0) {
          lines.push(`          participants: ${level.participants.join(', ')}`)
        }
        if (level.sequence && level.sequence.length > 0) {
          lines.push(`          sequence: ${level.sequence.join(' -> ')}`)
        }
        if (level.producer) {
          lines.push(`          producer: ${level.producer}`)
        }
        if (level.reviewer) {
          lines.push(`          reviewer: ${level.reviewer}`)
        }
        const settings = [
          numberSetting('min_rounds', level.min_rounds),
          numberSetting('max_rounds', level.max_rounds),
          numberSetting('min_successful_participants', level.min_successful_participants),
          numberSetting('max_iterations', level.max_iterations),
        ].filter(Boolean)
        if (settings.length > 0) {
          lines.push(`          settings: ${settings.join(', ')}`)
        }
        if (level.output_format) {
          lines.push(`          output_format: ${level.output_format}`)
        }
      }
    }
    lines.push(
      `    has_discussion_level: ${team.has_discussion_level ? 'yes' : 'no'}`,
    )
    lines.push(
      `    has_review_level: ${team.has_review_level ? 'yes' : 'no'}`,
    )
    if (team.agents.length === 0) {
      lines.push('    agents: (none registered)')
    } else {
      lines.push('    agents:')
      for (const agent of team.agents) {
        lines.push(`      - ${agent.name} — ${agent.role || '(no role)'}`)
      }
    }
  }
  if (registry.workflow_templates && registry.workflow_templates.length > 0) {
    lines.push('')
    lines.push('## Available saved workflow templates (reference only)')
    lines.push('Use these as starting points when they match the user request; otherwise compose a new flow from teams.')
    for (const template of registry.workflow_templates) {
      lines.push('')
      lines.push(`- **${template.id}**${template.description ? ` — ${template.description}` : ''}`)
      if (template.tags && template.tags.length > 0) {
        lines.push(`    tags: ${template.tags.join(', ')}`)
      }
      if (template.capabilities && template.capabilities.length > 0) {
        lines.push(`    capabilities: ${template.capabilities.join(', ')}`)
      }
      if (template.mcp_requirements && template.mcp_requirements.length > 0) {
        lines.push('    mcp_requirements:')
        for (const requirement of template.mcp_requirements) {
          lines.push(`      - ${formatMcpRequirement(requirement)}`)
        }
      }
      if (template.template_path) {
        lines.push(`    template_path: ${template.template_path}`)
      }
      if (template.input_artifact) {
        lines.push(`    input: ${template.input_artifact}`)
      }
      if (template.steps && template.steps.length > 0) {
        lines.push('    steps:')
        for (const [index, step] of template.steps.entries()) {
          const result = step.result_artifact ? ` -> ${step.result_artifact}` : ''
          const target = step.type === 'human-in-the-loop'
            ? 'human feedback'
            : step.type === 'agent'
              ? `agent=${step.agent} (team=${step.team})`
              : `team=${step.team}`
          const stage = step.stage_type ? ` stage=${step.stage_type}` : ''
          lines.push(`      ${index + 1}. ${step.id}: ${target}${stage}${result}`)
          if (step.requested_result_type) {
            lines.push(`          requested_result_type: ${step.requested_result_type}`)
          }
          if (step.prompt) {
            lines.push(`          prompt: ${step.prompt}`)
          }
          if (step.mcp_requirements && step.mcp_requirements.length > 0) {
            lines.push('          mcp_requirements:')
            for (const requirement of step.mcp_requirements) {
              lines.push(`            - ${formatMcpRequirement(requirement)}`)
            }
          }
          if (step.handoff) {
            lines.push(`          handoff: ${step.handoff}`)
          }
        }
      }
      if (template.output) {
        lines.push(`    output: ${template.output}`)
      }
    }
  }
  return lines.join('\n')
}

function numberSetting(label: string, value: number | undefined): string | null {
  return value === undefined ? null : `${label}: ${value}`
}

function formatMcpRequirement(requirement: {
  capability: string
  access: string
  necessity: string
  rationale?: string
}): string {
  const rationale = requirement.rationale ? `; rationale=${requirement.rationale}` : ''
  return `capability=${requirement.capability}; access=${requirement.access}; necessity=${requirement.necessity}${rationale}`
}
