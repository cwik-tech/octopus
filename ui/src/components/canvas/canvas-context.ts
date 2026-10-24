import { createContext, useContext } from 'react'
import type { CanvasAction, CanvasTab, CanvasWorkspace } from '@contracts/canvas-workspace'

export interface CanvasController {
  sessionId: string
  workspace: CanvasWorkspace
  error: string | null
  hidden: boolean
  requested: boolean
  expanded: boolean
  detached: boolean
  standalone: boolean
  opening: boolean
  canDetach: boolean
  detach: () => void
  act: (action: CanvasAction) => void
  open: (target: CanvasTab) => void
  show: () => void
  hide: () => void
  toggleExpanded: () => void
}
export const CanvasContext = createContext<CanvasController | null>(null)
export function useCanvas(): CanvasController | null { return useContext(CanvasContext) }
