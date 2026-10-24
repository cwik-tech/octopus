import { whenDefined } from '../core/optional-properties.js'
import * as crypto from 'node:crypto'
import type {
  DurableWorkflowTerminalOutcome,
  DurableWorkflowTerminalStatus,
  WorkflowExecutionResult,
} from './types.js'

/** Stable body used both by the live worker and crash-time reconciliation. */
export function buildWorkflowResultWrapperBody(
  result: {
    workflowId: string
    status: DurableWorkflowTerminalStatus
    primaryArtifact?: string
    artifacts?: Array<{
      relativePath?: string
      artifact?: { relativePath: string }
      role: 'primary' | 'secondary'
      mediaType?: string
      label?: string
    }>
    summary: string
  },
): string {
  const declaredPrimary = result.artifacts?.find((artifact) => artifact.role === 'primary')
  const primaryArtifact = declaredPrimary?.relativePath ?? declaredPrimary?.artifact?.relativePath
    ?? result.primaryArtifact
  const lines = [
    '# Workflow Result',
    '',
    `- Workflow: ${result.workflowId}`,
    `- Status: ${result.status}`,
    `- Primary artifact: ${primaryArtifact || '[none]'}`,
  ]
  if (result.artifacts?.length) {
    lines.push('', '## Published artifacts', '')
    for (const published of result.artifacts) {
      const relativePath = published.relativePath ?? published.artifact?.relativePath ?? '[unknown]'
      const details = [published.role, published.mediaType, published.label]
        .filter(Boolean)
        .join('; ')
      lines.push(`- ${relativePath}${details ? ` (${details})` : ''}`)
    }
  }
  lines.push('', '## Summary', '', result.summary)
  return lines.join('\n')
}

/** Build the only accepted durable terminal publication payload. */
export function buildDurableWorkflowTerminalOutcome(params: {
  workflowId: string
  status: DurableWorkflowTerminalStatus
  summary: string
  requestedResultType: string
  outputStepId: string
  primaryArtifact?: DurableWorkflowTerminalOutcome['primaryArtifact']
  artifacts?: DurableWorkflowTerminalOutcome['artifacts']
  primaryArtifactPath?: string
}): DurableWorkflowTerminalOutcome {
  const rootWrapperBody = buildWorkflowResultWrapperBody({
    workflowId: params.workflowId,
    status: params.status,
    ...whenDefined(params.primaryArtifactPath, (definedValue) => ({ primaryArtifact: definedValue })),
    ...whenDefined(params.artifacts, (definedValue) => ({ artifacts: definedValue })),
    summary: params.summary,
  })
  return {
    status: params.status,
    summary: params.summary,
    requestedResultType: params.requestedResultType,
    outputStepId: params.outputStepId,
    ...whenDefined(params.primaryArtifact, (primaryArtifact) => ({ primaryArtifact })),
    ...whenDefined(params.artifacts, (artifacts) => ({ artifacts })),
    rootWrapperBody,
    rootWrapperSha256: crypto
      .createHash('sha256')
      .update(rootWrapperBody)
      .digest('hex'),
  }
}

export function summarizeWorkflowResult(result: WorkflowExecutionResult): string {
  const terminalStep = result.steps[result.steps.length - 1]
  if (!terminalStep) return `Workflow '${result.workflowId}' finished with status ${result.status}.`
  const terminalSummary = terminalStep.summary.trim() || '[No step summary returned]'
  return [
    `Workflow '${result.workflowId}' finished with status ${result.status} after ${result.steps.length} step(s).`,
    `Terminal step '${terminalStep.stepId}' (${terminalStep.team ?? 'human-in-the-loop'}) status: ${terminalStep.status}.`,
    `Reason: ${terminalSummary}`,
  ].join(' ')
}
