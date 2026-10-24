import { useState, type PropsWithChildren, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { WorkspaceRightSidebarContent } from "@/components/sidebar/workspace-right-sidebar";
import {
  RunSidebarContext,
  useRunSidebar,
  type RunSidebarTab,
} from "@/hooks/use-run-sidebar";

export function WorkspaceRunSidebarProvider({
  children,
  targetsAvailable,
  unavailableReason,
}: PropsWithChildren<{
  targetsAvailable: boolean;
  unavailableReason?: string | undefined;
}>) {
  const [tab, setTab] = useState<RunSidebarTab>("sessions");
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<HTMLDivElement | null>(null);

  return (
    <RunSidebarContext.Provider
      value={{
        tab: targetsAvailable ? tab : "sessions",
        setTab,
        query,
        setQuery,
        target,
        setTarget,
        targetsAvailable,
        unavailableReason,
      }}
    >
      {children}
    </RunSidebarContext.Provider>
  );
}

export function WorkspaceRunSidebarContent({ active, children }: {
  active: boolean;
  children: ReactNode;
}) {
  const navigation = useRunSidebar();
  // Standalone RunPanel consumers retain their existing inspector boundary.
  if (!navigation) {
    return <WorkspaceRightSidebarContent active={active}>{children}</WorkspaceRightSidebarContent>;
  }
  if (!active || !navigation.target) return null;
  return createPortal(children, navigation.target);
}
