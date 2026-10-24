import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseMarkdownArtifact } from '../domains/runtime/artifacts.js'
import type {
  WorkflowArtifactHandoff,
  WorkflowExecutionStepResult,
  WorkflowProvenanceHandoff,
  WorkflowStep,
} from './types.js'

function readArtifactText(artifactPath: string): string {
  const raw = fs.readFileSync(artifactPath, 'utf8')
  if (path.extname(artifactPath).toLowerCase() === '.md') {
    const parsed = parseMarkdownArtifact(raw)
    return parsed.body.trim() || raw
  }
  return raw
}

function resolveArtifactWithinAssignment(assignmentPath: string, artifactRef: string): string {
  const root = path.resolve(assignmentPath)
  const candidate = path.resolve(root, artifactRef)
  const relative = path.relative(root, candidate)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Artifact reference '${artifactRef}' escapes its assignment directory.`)
  }
  return candidate
}

export function resolveWorkflowArtifactText(params: {
  consumerStepId: string
  source: WorkflowProvenanceHandoff
  priorResults: WorkflowExecutionStepResult[]
  purpose?: 'handoff' | 'provenance handoff'
}): string {
  return readArtifactText(resolveWorkflowArtifactPath(params))
}

export function resolveWorkflowArtifactPath(params: {
  consumerStepId: string
  source: Pick<
    WorkflowProvenanceHandoff | WorkflowArtifactHandoff,
    'from_step' | 'from_artifact'
  >
  priorResults: WorkflowExecutionStepResult[]
  purpose?: 'handoff' | 'provenance handoff' | 'context handoff'
}): string {
  const purpose = params.purpose ?? 'handoff'
  const source = params.priorResults.find(
    (result) => result.stepId === params.source.from_step,
  )
  if (!source?.assignmentPath) {
    throw new Error(
      `Workflow ${purpose} failed for step '${params.consumerStepId}': missing artifact from step '${params.source.from_step}'.`,
    )
  }

  const sourceArtifactPath = resolveArtifactWithinAssignment(
    source.assignmentPath,
    params.source.from_artifact,
  )
  if (!fs.existsSync(sourceArtifactPath) || !fs.statSync(sourceArtifactPath).isFile()) {
    throw new Error(
      `Workflow ${purpose} failed for step '${params.consumerStepId}': expected artifact ` +
      `'${params.source.from_artifact}' from step '${params.source.from_step}' was not produced.`,
    )
  }

  const assignmentRealPath = fs.realpathSync(source.assignmentPath)
  const artifactRealPath = fs.realpathSync(sourceArtifactPath)
  const realRelative = path.relative(assignmentRealPath, artifactRealPath)
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error(
      `Workflow ${purpose} failed for step '${params.consumerStepId}': artifact ` +
      `'${params.source.from_artifact}' resolves outside its assignment directory.`,
    )
  }

  return artifactRealPath
}

export function resolveWorkflowStepBrief(params: {
  step: WorkflowStep
  initialBrief: string
  priorResults: WorkflowExecutionStepResult[]
}): string {
  const sections: string[] = []
  if (params.step.brief_prefix?.trim()) {
    sections.push(params.step.brief_prefix.trim())
  }

  if (!params.step.handoff) {
    sections.push(params.initialBrief.trim())
    if (params.step.brief_suffix?.trim()) {
      sections.push(params.step.brief_suffix.trim())
    }
    return sections.filter(Boolean).join('\n\n')
  }

  sections.push(resolveWorkflowArtifactText({
    consumerStepId: params.step.id,
    source: params.step.handoff,
    priorResults: params.priorResults,
  }))

  if (params.step.include_initial_brief) {
    sections.push(['## Original Request', '', params.initialBrief.trim()].join('\n'))
  }

  if (params.step.brief_suffix?.trim()) {
    sections.push(params.step.brief_suffix.trim())
  }

  return sections.filter(Boolean).join('\n\n')
}
