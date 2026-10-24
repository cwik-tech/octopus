import type { PropsWithChildren } from 'react'
import { CanvasContext } from './canvas-context'
import { useCanvasWorkspace } from './use-canvas-workspace'
import { useCanvasWindow } from './use-canvas-window'

export function CanvasSession({ children, sessionId, standalone = false }: PropsWithChildren<{ sessionId: string | null; standalone?: boolean }>) {
  const workspace = useCanvasWorkspace(sessionId)
  const native = useCanvasWindow(sessionId)
  const controller = { ...workspace, ...native, error: workspace.error ?? native.error, standalone, detach: () => { workspace.dock(); workspace.show(); native.detach() } }
  // Keep this provider mounted while a draft receives its first saved identity.
  return <CanvasContext.Provider value={sessionId ? controller : null}>{children}</CanvasContext.Provider>
}
