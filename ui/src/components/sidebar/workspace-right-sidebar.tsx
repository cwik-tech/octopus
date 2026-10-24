import {
  createContext,
  useContext,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { WorkspaceRightSidebarRegistrationContext, type WorkspaceRightSidebarControls } from "./workspace-right-sidebar-controls";

import { cn } from "@/lib/utils/utils";

const WorkspaceRightSidebarContext = createContext<HTMLElement | null | undefined>(
  undefined,
);

export function WorkspaceRightSidebarProvider({
  children,
  target,
  onControlsChange,
}: PropsWithChildren<{ target: HTMLElement | null; onControlsChange?: (controls: WorkspaceRightSidebarControls | null) => void }>) {
  return (
    <WorkspaceRightSidebarContext.Provider value={target}>
      <WorkspaceRightSidebarRegistrationContext.Provider value={onControlsChange ?? null}>{children}</WorkspaceRightSidebarRegistrationContext.Provider>
    </WorkspaceRightSidebarContext.Provider>
  );
}

export function WorkspaceRightSidebarContent({
  active = true,
  children,
  className,
}: {
  active?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const target = useContext(WorkspaceRightSidebarContext);
  if (!active) return null;

  const content = (
    <div className={cn("h-full min-h-0 min-w-0", className)}>{children}</div>
  );

  // Feature-level tests render workspace panels without the application shell.
  // Keep their right-side content observable without changing production layout.
  if (target === undefined) return content;
  if (target === null) return null;
  return createPortal(content, target);
}
