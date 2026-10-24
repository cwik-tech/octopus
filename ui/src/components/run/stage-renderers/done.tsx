import { CheckCircle2 } from 'lucide-react'

import { ArtifactMarkdownContent } from '@/components/run/pickers/artifact-markdown-content'
import type { ArtifactPreviewTarget } from './index'

export interface DoneViewProps {
  /** Retained for the renderer contract; the run id owns artifact reads. */
  taskId: string
  runId: string
  artifactPath: string
  onOpenArtifact?: (target: ArtifactPreviewTarget) => void
}

/** Right-pane completion view retained for callers that need a full banner. */
export function DoneView({ runId, artifactPath, onOpenArtifact }: DoneViewProps) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-green-500/8 px-4 py-3">
        <CheckCircle2 className="size-4 shrink-0 text-green-600 dark:text-green-500" />
        <span className="text-sm font-medium text-foreground">Task complete</span>
      </div>

      <ArtifactMarkdownContent
        artifactPath={artifactPath}
        className="flex-1 overflow-y-auto p-4"
        onOpenArtifact={onOpenArtifact}
        runId={runId}
      />
    </div>
  )
}

export default DoneView
