/**
 * Mermaid diagram emitter for `WorkflowDraft`.
 *
 * Produces a left-to-right flowchart where each step is a labeled node and
 * edges follow the explicit handoff chain (or fall back to step order).
 */

import type { WorkflowDraft } from './workflow-draft.js'

export function buildWorkflowMermaid(draft: WorkflowDraft): string {
  const lines: string[] = []
  lines.push('flowchart LR')
  lines.push(`  start(["${escapeLabel(draft.input.artifact || 'incoming-request.md')}"]):::startEnd`)

  for (const step of draft.steps) {
    const id = sanitizeId(step.id)
    const target = step.type === 'human-in-the-loop'
      ? 'Human feedback'
      : step.type === 'agent' && step.agent
        ? `${step.agent} (${step.team})`
        : step.team || '?'
    const stage = step.stage_type
      ? `<br/>${escapeLabel(step.stage_type)}`
      : ''
    const label = `${escapeLabel(target)}${stage}<br/><i>${escapeLabel(step.id)}</i>`
    lines.push(`  ${id}["${label}"]`)
  }

  const firstStep = draft.steps[0]
  if (firstStep) {
    const firstId = sanitizeId(firstStep.id)
    lines.push(`  start --> ${firstId}`)
  }

  let previousStep: WorkflowDraft['steps'][number] | undefined
  for (const step of draft.steps) {
    const id = sanitizeId(step.id)
    if (step.handoff) {
      const fromId = sanitizeId(step.handoff.from_step)
      const artifact = step.handoff.from_artifact || step.input_artifact
      lines.push(`  ${fromId} -->|${escapeLabel(artifact)}| ${id}`)
    } else if (previousStep) {
      const fromId = sanitizeId(previousStep.id)
      const artifact = previousStep.result_artifact
      lines.push(`  ${fromId} -->|${escapeLabel(artifact)}| ${id}`)
    }
    previousStep = step
  }

  if (draft.steps.length > 0 && draft.output.from_step) {
    const finalId = sanitizeId(draft.output.from_step)
    lines.push(`  done(["${escapeLabel(draft.output.artifact || 'final')}"]):::startEnd`)
    lines.push(`  ${finalId} --> done`)
  }

  lines.push('  classDef startEnd fill:#f3f4f6,stroke:#6b7280,stroke-dasharray: 4 2')
  return lines.join('\n')
}

export function emptyDiagram(): string {
  return [
    'flowchart LR',
    '  start(["incoming request"]):::placeholder',
    '  draft["draft<br/><i>(awaiting design)</i>"]',
    '  done(["final artifact"]):::placeholder',
    '  start -.-> draft -.-> done',
    '  classDef placeholder fill:#f9fafb,stroke:#9ca3af,stroke-dasharray:4 2,color:#9ca3af',
  ].join('\n')
}

function sanitizeId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_]/g, '_')
  if (cleaned === '' || /^\d/.test(cleaned)) return `s_${cleaned || 'x'}`
  return cleaned
}

function escapeLabel(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '&#124;')
}
