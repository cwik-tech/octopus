import { useLayoutEffect, useRef, type PropsWithChildren } from 'react'
import { WorkspaceRightSidebarContent } from '@/components/sidebar/workspace-right-sidebar'
import { useWorkspaceRightSidebarRegistration } from '@/components/sidebar/workspace-right-sidebar-controls'
import { CanvasPanel } from './canvas-panel'
import { useCanvas } from './canvas-context'

export function CanvasSplit({ children }: PropsWithChildren) {
  const canvas = useCanvas()
  const registerSidebar = useWorkspaceRightSidebarRegistration()
  const currentCanvas = useRef(canvas)
  useLayoutEffect(() => { currentCanvas.current = canvas }, [canvas])
  const available = canvas !== null
  const visible = available && !canvas.hidden && !canvas.detached && (canvas.workspace.tabs.length > 0 || canvas.requested)
  const expanded = canvas?.expanded ?? false
  useLayoutEffect(() => {
    if (!registerSidebar) return
    registerSidebar(available ? {
      open: visible && !expanded,
      onOpenChange: (open) => {
        const current = currentCanvas.current
        if (open) {
          if (current?.detached) { current.detach(); return }
          if (current?.expanded) current.toggleExpanded()
          current?.show()
        } else current?.hide()
      },
    } : null)
    return () => registerSidebar(null)
  }, [available, expanded, registerSidebar, visible])
  return <div className="relative flex min-h-0 min-w-0 flex-1">
    {children}
    {visible && expanded ? <div className="absolute inset-0 z-20 bg-background"><CanvasPanel /></div> : null}
    <WorkspaceRightSidebarContent active={visible && !expanded}><CanvasPanel /></WorkspaceRightSidebarContent>
  </div>
}
