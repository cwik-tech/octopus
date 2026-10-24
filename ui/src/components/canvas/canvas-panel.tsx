import { useEffect, useState } from 'react'
import { Copy, FileText, Download, Maximize2, Minimize2, ExternalLink, X } from 'lucide-react'
import { canvasTabKey, type CanvasTab } from '@contracts/canvas-workspace'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PanelEmptyState } from '@/components/ui/card'
import { fetchCanvasContent } from '@/lib/clients/canvas-client'
import { artifactUrl } from '@/lib/clients/runtime-client'
import { useCanvas } from './canvas-context'
import { CanvasHtmlPreview } from './canvas-html-preview'
import { CanvasMarkdownDocument } from './canvas-markdown-document'
import { CanvasOfficeDocument } from './canvas-office-document'

function CanvasDocument({ target, sessionId }: { target: CanvasTab; sessionId: string }) {
  const canvas = useCanvas()
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [editActionTarget, setEditActionTarget] = useState<HTMLDivElement | null>(null)
  const office = /\.(docx|xlsx|pptx)$/i.test(target.artifactPath)
  useEffect(() => {
    if (office) return
    const controller = new AbortController()
    void fetchCanvasContent(sessionId, target, controller.signal).then((value) => {
      if (!controller.signal.aborted) { setContent(value); setError(null) }
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Preview unavailable')
    })
    return () => controller.abort()
  }, [reload, sessionId, target, office])
  const name = target.artifactPath.split('/').at(-1) ?? target.artifactPath
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 items-center gap-2 border-b p-2">
      <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={office ? undefined : "Original file tools · live origin preview is unverified · editing creates a separate copy"}>{office ? 'Document' : 'Original file'}</p>
      <div ref={setEditActionTarget} className="flex shrink-0 empty:hidden" />
      {!office ? <Button aria-label="Copy original content" size="icon-sm" variant="ghost" disabled={content === null} onClick={() => { if (content !== null) void navigator.clipboard.writeText(content).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Copy failed')) }}><Copy className="size-4" /></Button> : null}
      <Button size="sm" variant="ghost" onClick={() => setReload((value) => value + 1)}>Refresh</Button>
      <Button aria-label={`Download ${name}`} nativeButton={false} size="icon-sm" variant="ghost" render={<a download={name} href={artifactUrl(target.runId, target.artifactPath)} />}><Download className="size-4" /></Button>
    </div>
    {error ? <div role="alert" className="shrink-0 p-3 text-sm text-destructive">{content !== null ? 'Showing the last loaded preview. ' : ''}{error}</div> : null}
    <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
      {office ? <CanvasOfficeDocument key={`${sessionId}:${target.runId}:${target.artifactPath}`} sessionId={sessionId} target={target} reload={reload} /> : /\.(md|markdown)$/i.test(target.artifactPath) ? <CanvasMarkdownDocument sessionId={sessionId} target={target} originContent={content} editActionTarget={editActionTarget} {...(canvas ? { onOpenArtifact: canvas.open } : {})} /> : content === null ? <p className="text-sm text-muted-foreground">{error ? 'Download this file or refresh to try again.' : 'Loading document…'}</p> : /\.(html|htm)$/i.test(target.artifactPath) ? <CanvasHtmlPreview content={content} /> : <pre className="whitespace-pre-wrap break-words text-sm">{content}</pre>}
    </div>
  </div>
}

export function CanvasToggle() {
  const canvas = useCanvas()
  return canvas ? <Button variant="ghost" size="sm" disabled={canvas.opening} onClick={canvas.detached ? canvas.detach : canvas.show}>Canvas{canvas.workspace.tabs.length > 0 ? ` (${canvas.workspace.tabs.length})` : ''}</Button> : null
}
export function CanvasTitle() {
  const canvas = useCanvas()
  const active = canvas?.workspace.tabs.find((tab) => canvasTabKey(tab) === canvas.workspace.activeKey)
  return <h2 className="flex min-w-0 items-center gap-2 text-base font-medium"><FileText className="size-4 shrink-0" /><span className="truncate">{active?.artifactPath.split('/').at(-1) ?? 'Canvas'}</span></h2>
}

export function CanvasActions() {
  const canvas = useCanvas()
  if (!canvas) return null
  return canvas.standalone ? <Button variant="ghost" size="sm" onClick={() => window.close()}>Return to chat pane</Button> : <>
    <Button variant="ghost" size="icon-sm" aria-label={canvas.expanded ? 'Dock Canvas' : 'Expand Canvas'} onClick={canvas.toggleExpanded}>{canvas.expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}</Button>
    {canvas.canDetach ? <Button variant="ghost" size="icon-sm" disabled={canvas.opening} aria-label="Open Canvas in new window" onClick={canvas.detach}><ExternalLink className="size-4" /></Button> : null}
  </>
}

export function CanvasPanel() {
  const canvas = useCanvas()
  if (!canvas) return null
  return <section aria-label="Canvas workspace" className="flex h-full min-h-0 min-w-0 flex-col" role="region">
    <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/80 px-4 py-3">
      <div className="min-w-0 flex-1"><CanvasTitle /></div><CanvasActions />
      {!canvas.standalone ? <Button variant="ghost" size="icon-sm" aria-label="Hide Canvas" onClick={canvas.hide}><X className="size-4" /></Button> : null}
    </div>
    <CanvasContents />
  </section>
}

export function CanvasContents() {
  const canvas = useCanvas()
  if (!canvas) return null
  return <>
    {canvas.error ? <div role="alert" className="p-3 text-sm text-destructive">{canvas.error}</div> : null}
    {canvas.workspace.tabs.length === 0 ? <PanelEmptyState>Open a file from this chat to keep it in Canvas.</PanelEmptyState> : <Tabs value={canvas.workspace.activeKey ?? ''} onValueChange={(key: unknown) => { if (typeof key === 'string') canvas.act({ kind: 'select', key }) }} className="min-h-0 flex-1 gap-0">
      <TabsList aria-label="Canvas documents" variant="line" className="no-scrollbar h-10 max-w-full shrink-0 justify-start overflow-x-auto overflow-y-hidden rounded-none px-2">
        {canvas.workspace.tabs.map((target) => {
          const key = canvasTabKey(target)
          const name = target.artifactPath.split('/').at(-1) ?? target.artifactPath
          return <div key={key} className="flex shrink-0 items-center"><TabsTrigger value={key} title={`${target.runId}/${target.artifactPath}`} className="max-w-60 truncate">{name}</TabsTrigger><Button aria-label={`Close ${name}`} size="icon-sm" variant="ghost" onClick={() => canvas.act({ kind: 'close', key })}><X className="size-3" /></Button></div>
        })}
      </TabsList>
      {canvas.workspace.tabs.map((target) => <TabsContent key={canvasTabKey(target)} value={canvasTabKey(target)} keepMounted className="mt-0 min-h-0 flex-1 overflow-hidden"><CanvasDocument target={target} sessionId={canvas.sessionId} /></TabsContent>)}
    </Tabs>}
  </>
}
