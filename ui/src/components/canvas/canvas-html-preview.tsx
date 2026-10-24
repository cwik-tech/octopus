import { useCallback, useEffect, useRef } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export function CanvasHtmlPreview({ content, showSource = true }: { content: string; showSource?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const sendContent = useCallback(() => {
    // The wrapper has an opaque sandbox origin, so '*' is required. Its only
    // receiver validates the message source and shape before rendering content.
    frame.current?.contentWindow?.postMessage({ kind: 'canvas-html-preview', content }, '*')
  }, [content])
  useEffect(sendContent, [sendContent])
  if (typeof window.pipeline?.openWindow !== 'function') return <div className="flex min-h-0 flex-col gap-3">
    <p className="text-sm text-muted-foreground">Interactive HTML previews are available in the desktop app.</p>
    {showSource ? <pre aria-label="HTML source" className="whitespace-pre-wrap break-words text-sm">{content}</pre> : null}
  </div>
  const preview = <iframe ref={frame} title="HTML preview" sandbox="allow-scripts" referrerPolicy="no-referrer" src={new URL('./canvas-preview.html', window.location.href).href} onLoad={sendContent} className="h-full min-h-80 w-full border-0 bg-background" />
  if (!showSource) return preview
  return <Tabs defaultValue="preview" className="h-full min-h-0 gap-2">
    <TabsList aria-label="HTML view" className="shrink-0">
      <TabsTrigger value="preview">Preview</TabsTrigger>
      <TabsTrigger value="source">Source</TabsTrigger>
    </TabsList>
    <TabsContent value="preview" keepMounted className="min-h-0 overflow-hidden">
      {preview}
    </TabsContent>
    <TabsContent value="source" keepMounted className="min-h-0 overflow-auto">
      <pre aria-label="HTML source" className="whitespace-pre-wrap break-words text-sm">{content}</pre>
    </TabsContent>
  </Tabs>
}
