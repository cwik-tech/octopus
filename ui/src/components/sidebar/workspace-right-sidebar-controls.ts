import { createContext, useContext } from 'react'

export interface WorkspaceRightSidebarControls {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export const WorkspaceRightSidebarRegistrationContext = createContext<((controls: WorkspaceRightSidebarControls | null) => void) | null>(null)

export function useWorkspaceRightSidebarRegistration() {
  return useContext(WorkspaceRightSidebarRegistrationContext)
}
