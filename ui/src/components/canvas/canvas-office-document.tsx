import { useEffect, useState } from 'react'
import type { CanvasTab } from '@contracts/canvas-workspace'
import type { OfficeDocument, OfficePreview } from '@contracts/office-documents'
import { fetchOfficePreview } from '@/lib/clients/office-document-client'
import { CanvasHtmlPreview } from './canvas-html-preview'

export function CanvasOfficeDocument({ sessionId, target, reload, document }: { sessionId: string; target: CanvasTab; reload: number; document?: Pick<OfficeDocument, 'id' | 'revision'> }) {
  const [preview, setPreview] = useState<OfficePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    // A refresh failure keeps the last successfully rendered document.
    void fetchOfficePreview(sessionId, document ? { documentId: document.id, revision: document.revision } : target, controller.signal).then((result) => {
      if (!controller.signal.aborted) { setPreview(result); setError(null) }
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Office preview unavailable.')
    })
    return () => controller.abort()
  }, [sessionId, target, reload, document])
  return <div className="flex h-full min-h-0 flex-col gap-2">
    {error ? <p role="alert" className="text-sm text-destructive">{preview ? 'Showing the last loaded preview. ' : ''}{error}</p> : null}
    {preview ? <><p className="text-xs text-muted-foreground">{preview.notices.join(' ')}</p><CanvasHtmlPreview content={preview.html} showSource={false} /></> : <p className="text-sm text-muted-foreground">{error ? 'Download this file or refresh to try again.' : 'Preparing Office preview…'}</p>}
  </div>
}
