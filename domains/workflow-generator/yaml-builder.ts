/**
 * Dedicated YAML emitter for `WorkflowDraft`.
 *
 * The repo doesn't have a direct `yaml` dependency (only an in-tree parser at
 * core/yaml-parser.ts which doesn't emit). This emitter handles only what
 * the draft schema needs: scalars, quoted strings (with `>` folded blocks for
 * multi-line description/brief_*), nested objects, and string arrays.
 *
 * Output is intended to round-trip cleanly through
 * `workflows/loader.ts:parseWorkflowTemplate`.
 */

import type {
  StepDraft,
  WorkflowDraft,
} from './workflow-draft.js'
import type { McpWorkflowCapabilityRequirement } from '../../contracts/mcp.js'
import { requireValidMcpWorkflowRequirements } from '../../contracts/mcp-workflow-capabilities.js'

export function buildWorkflowYaml(draft: WorkflowDraft): string {
  const lines: string[] = []
  lines.push('workflow:')
  lines.push(...indent(emitScalar('id', draft.id), 2))
  lines.push(...indent(emitFoldedString('description', draft.description), 2))

  if (draft.matches && draft.matches.length > 0) {
    lines.push('  matches:')
    for (const match of draft.matches) {
      lines.push(`    - ${quoteIfNeeded(match)}`)
    }
  }

  lines.push(...indent(emitMcpRequirements(
    requireValidMcpWorkflowRequirements(
      draft.mcp_requirements,
      'workflow.mcp_requirements',
    ),
  ), 2))

  lines.push('  input:')
  lines.push(`    artifact: ${quoteIfNeeded(draft.input.artifact)}`)

  lines.push('  steps:')
  for (const step of draft.steps) {
    lines.push(...indent(emitStep(step), 4))
  }

  lines.push('  output:')
  lines.push(`    from_step: ${quoteIfNeeded(draft.output.from_step)}`)
  lines.push(`    artifact: ${quoteIfNeeded(draft.output.artifact)}`)

  lines.push(`  on_blocked: ${draft.on_blocked}`)
  lines.push(`  on_failed: ${draft.on_failed}`)

  return lines.join('\n') + '\n'
}

function emitStep(step: StepDraft): string[] {
  const lines: string[] = []
  lines.push(`- id: ${quoteIfNeeded(step.id)}`)
  lines.push(`  type: ${step.type}`)
  if (step.team) {
    lines.push(`  team: ${quoteIfNeeded(step.team)}`)
  }
  if (step.agent) {
    lines.push(`  agent: ${quoteIfNeeded(step.agent)}`)
  }
  if (step.prompt) {
    lines.push(...indent(emitFoldedString('prompt', step.prompt), 2))
  }
  if (step.stage_type) {
    lines.push(`  stage_type: ${step.stage_type}`)
  }
  lines.push(...indent(emitMcpRequirements(
    requireValidMcpWorkflowRequirements(
      step.mcp_requirements,
      `workflow step '${step.id}' mcp_requirements`,
    ),
  ), 2))
  lines.push(`  input_artifact: ${quoteIfNeeded(step.input_artifact)}`)
  lines.push(`  result_artifact: ${quoteIfNeeded(step.result_artifact)}`)

  if (step.requested_result_type) {
    lines.push(`  requested_result_type: ${quoteIfNeeded(step.requested_result_type)}`)
  }
  if (step.brief_prefix !== undefined && step.brief_prefix !== '') {
    lines.push(...indent(emitLiteralString('brief_prefix', step.brief_prefix), 2))
  }
  if (step.brief_suffix !== undefined && step.brief_suffix !== '') {
    lines.push(...indent(emitLiteralString('brief_suffix', step.brief_suffix), 2))
  }
  if (step.include_initial_brief !== undefined) {
    lines.push(`  include_initial_brief: ${step.include_initial_brief ? 'true' : 'false'}`)
  }
  if (step.recovery_policy) {
    lines.push(`  recovery_policy: ${step.recovery_policy}`)
  }

  const overrides = step.runtime_overrides
  if (overrides && overrides.levels && Object.keys(overrides.levels).length > 0) {
    lines.push('  runtime_overrides:')
    lines.push('    levels:')
    for (const [levelId, level] of Object.entries(overrides.levels)) {
      lines.push(`      ${quoteIfNeeded(levelId)}:`)
      if (level.discussion) {
        lines.push('        discussion:')
        if (level.discussion.participants && level.discussion.participants.length > 0) {
          lines.push('          participants:')
          for (const p of level.discussion.participants) {
            lines.push(`            - ${quoteIfNeeded(p)}`)
          }
        }
        if (level.discussion.min_rounds !== undefined) {
          lines.push(`          min_rounds: ${level.discussion.min_rounds}`)
        }
        if (level.discussion.max_rounds !== undefined) {
          lines.push(`          max_rounds: ${level.discussion.max_rounds}`)
        }
        if (level.discussion.min_successful_participants !== undefined) {
          lines.push(`          min_successful_participants: ${level.discussion.min_successful_participants}`)
        }
      }
      if (level.review) {
        lines.push('        review:')
        if (level.review.max_iterations !== undefined) {
          lines.push(`          max_iterations: ${level.review.max_iterations}`)
        }
      }
    }
  }

  if (step.handoff) {
    lines.push('  handoff:')
    lines.push(`    from_step: ${quoteIfNeeded(step.handoff.from_step)}`)
    lines.push(`    from_artifact: ${quoteIfNeeded(step.handoff.from_artifact)}`)
    lines.push(`    to_artifact: ${quoteIfNeeded(step.handoff.to_artifact)}`)
  }

  return lines
}

function emitMcpRequirements(
  requirements: readonly McpWorkflowCapabilityRequirement[],
): string[] {
  if (requirements.length === 0) return []
  const lines = ['mcp_requirements:']
  for (const requirement of requirements) {
    lines.push(`  - capability: ${quoteIfNeeded(requirement.capability)}`)
    lines.push(`    access: ${requirement.access}`)
    lines.push(`    necessity: ${requirement.necessity}`)
    if (requirement.rationale) {
      lines.push(...indent(emitLiteralString('rationale', requirement.rationale), 4))
    }
  }
  return lines
}

function indent(lines: string[], spaces: number): string[] {
  const pad = ' '.repeat(spaces)
  return lines.map((line) => (line === '' ? line : `${pad}${line}`))
}

function emitScalar(key: string, value: string): string[] {
  return [`${key}: ${quoteIfNeeded(value)}`]
}

function emitFoldedString(key: string, value: string): string[] {
  const text = value.trim()
  if (text === '') return [`${key}: ''`]
  if (!text.includes('\n') && text.length < 100) {
    return [`${key}: ${quoteIfNeeded(text)}`]
  }
  const wrapped = wrapLines(text, 76)
  return [`${key}: >`, ...wrapped.map((line) => `  ${line}`)]
}

function emitLiteralString(key: string, value: string): string[] {
  if (!value.includes('\n')) {
    return [`${key}: ${quoteIfNeeded(value)}`]
  }
  const lines = value.split('\n')
  while (lines.at(-1) === '') lines.pop()
  return [`${key}: |`, ...lines.map((line) => `  ${line}`)]
}

function wrapLines(text: string, maxWidth: number): string[] {
  const paragraphs = text.split(/\n\n+/)
  const out: string[] = []
  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i]
    if (paragraph === undefined) continue
    const collapsed = paragraph.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()
    if (collapsed === '') continue
    out.push(...wrapWords(collapsed, maxWidth))
    if (i < paragraphs.length - 1) out.push('')
  }
  return out
}

function wrapWords(text: string, maxWidth: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (current.length === 0) {
      current = word
    } else if (current.length + 1 + word.length <= maxWidth) {
      current += ' ' + word
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current.length > 0) lines.push(current)
  return lines
}

function quoteIfNeeded(value: string): string {
  if (value === '') return "''"
  if (needsQuoting(value)) {
    return `'${value.replace(/'/g, "''")}'`
  }
  return value
}

function needsQuoting(value: string): boolean {
  if (/^(true|false|null|yes|no|on|off)$/i.test(value)) return true
  if (/^-?\d+(\.\d+)?$/.test(value)) return true
  if (/^[\s]/.test(value) || /[\s]$/.test(value)) return true
  if (/[:#&*!|>'"%@`{}\[\],]/.test(value)) return true
  return false
}
