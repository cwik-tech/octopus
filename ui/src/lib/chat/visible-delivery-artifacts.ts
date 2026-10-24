import type { ChatDeliveryArtifact } from '@contracts/sessions'

/** Keep generation sources available to chat without presenting them as files. */
export function visibleDeliveryArtifacts(artifacts: readonly ChatDeliveryArtifact[]): readonly ChatDeliveryArtifact[] {
  return artifacts.filter((artifact) => {
    if (artifact.role !== 'secondary' || !/\.md$/i.test(artifact.path)) return true
    const stem = artifact.path.slice(0, -3)
    return !artifacts.some((document) => document.runId === artifact.runId && /\.(docx|xlsx)$/i.test(document.path) && (document.path.slice(0, -5) === stem || /\bMarkdown source$/i.test(artifact.title ?? '')))
  })
}
