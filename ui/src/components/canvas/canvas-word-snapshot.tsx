import { useEffect, useRef, useState } from 'react'
import type { CanvasTab } from '@contracts/canvas-workspace'
import type { OfficeDocument } from '@contracts/office-documents'
import { fetchWordSnapshot, officeDownloadUrl } from '@/lib/clients/office-document-client'
import { Button } from '@/components/ui/button'
import { CanvasOfficeDocument } from './canvas-office-document'
export function CanvasWordSnapshot({ sessionId, target, revision, disabled }: { sessionId: string; target: CanvasTab; revision: number; disabled: boolean }) {
  const [snapshot, setSnapshot] = useState<{ document: OfficeDocument; stale: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(false)
  const request = useRef<AbortController | null>(null)
  const lookup = useRef<AbortController | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    lookup.current = controller
    // Read-only refresh follows saved Markdown revisions; drafts are excluded.
    void fetchWordSnapshot(sessionId, target, controller.signal).then((result) => { if (!controller.signal.aborted) setSnapshot(result) }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Word snapshot unavailable.') })
    return () => controller.abort()
  }, [sessionId, target, revision])
  useEffect(() => () => request.current?.abort(), [])
  async function generate(): Promise<void> {
    if (disabled || request.current) return
    // A read started before this mutation cannot replace its result.
    lookup.current?.abort()
    const controller = new AbortController()
    request.current = controller; setBusy(true)
    try {
      const result = await fetchWordSnapshot(sessionId, target, controller.signal, revision)
      if (!controller.signal.aborted) {
        lookup.current?.abort()
        setSnapshot(result)
        setError(null)
      }
    }
    catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Word generation failed.') }
    finally {
      if (request.current === controller) {
        request.current = null
        if (!controller.signal.aborted) setBusy(false)
      }
    }
  }
  return <section aria-label="Word snapshot" className="space-y-2 border-t pt-3">
    <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => { void generate() }}>{busy ? 'Generating Word…' : 'Generate Word snapshot'}</Button>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {snapshot ? <>
      <p className="text-xs text-muted-foreground">{snapshot.stale || snapshot.document.source?.revision !== revision ? 'Word snapshot is out of date.' : `Word snapshot uses saved Markdown revision ${snapshot.document.source?.revision ?? 0}.`}{snapshot.document.source?.forked ? ' Binary edits are separate from Markdown.' : ''}</p>
      <Button nativeButton={false} size="sm" variant="ghost" aria-label="Download Word snapshot" render={<a href={officeDownloadUrl(sessionId, snapshot.document)} download />}>Download Word snapshot</Button>
      <Button size="sm" variant="ghost" onClick={() => setPreview((value) => !value)}>{preview ? 'Hide Word preview' : 'Preview Word snapshot'}</Button>
      {preview ? <CanvasOfficeDocument key={`${sessionId}:${target.runId}:${target.artifactPath}`} sessionId={sessionId} target={target} document={snapshot.document} reload={snapshot.document.revision} /> : null}
    </> : null}
  </section>
}
