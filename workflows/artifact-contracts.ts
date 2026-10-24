import * as path from 'node:path'

import { artifactMediaTypeForExtension } from '../core/artifact-media.js'
import type {
  WorkflowOutputArtifact,
  WorkflowStep,
  WorkflowTemplate,
} from './types.js'

export const BUILTIN_TRANSFORM_EXECUTOR = 'builtin-transform'

export function workflowStepResultArtifacts(
  step: Pick<WorkflowStep, 'result_artifact' | 'result_artifacts'>,
): string[] {
  return Array.from(new Set([
    step.result_artifact,
    ...(step.result_artifacts ?? []),
  ].filter(Boolean)))
}

export function workflowOutputArtifacts(
  template: WorkflowTemplate,
): Array<Required<Pick<WorkflowOutputArtifact, 'from_step' | 'artifact'>> & Omit<WorkflowOutputArtifact, 'from_step' | 'artifact'> & { role: 'primary' | 'secondary' }> {
  return [
    {
      from_step: template.output.from_step,
      artifact: template.output.artifact,
      role: 'primary' as const,
    },
    ...(template.output.secondary_artifacts ?? []).map((artifact) => ({
      ...artifact,
      from_step: artifact.from_step ?? template.output.from_step,
      role: 'secondary' as const,
    })),
  ]
}

export function artifactMediaType(artifactPath: string): string | undefined {
  return artifactMediaTypeForExtension(path.extname(artifactPath))
}
