import type { ElementRef, ReactNode, RefObject } from "react";

import { WorkspaceSidebar } from "@/components/sidebar/workspace-sidebar";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  MAX_RIGHT_SIDEBAR_SIZE,
  MIN_RIGHT_SIDEBAR_SIZE,
} from "@/hooks/use-right-sidebar";

const MIN_WORKSPACE_SIZE = 48;

export function AppResizableWorkspace({
  children,
  header,
  handleOpenChange,
  handleResize,
  initialSize,
  isOpen,
  panelRef,
  setTarget,
}: {
  children: ReactNode;
  header: ReactNode;
  handleOpenChange: (open: boolean) => void;
  handleResize: (size: number) => void;
  initialSize: number;
  isOpen: boolean;
  panelRef: RefObject<ElementRef<typeof ResizablePanel> | null>;
  setTarget: (target: HTMLDivElement | null) => void;
}) {
  return (
    <ResizablePanelGroup direction="horizontal" className="min-w-0 flex-1">
      <ResizablePanel
        defaultSize={
          isOpen ? 100 - initialSize : 100
        }
        minSize={MIN_WORKSPACE_SIZE}
        order={1}
      >
        <div className="flex h-full min-w-0 flex-col">
          {header}
          {children}
        </div>
      </ResizablePanel>
      <ResizableHandle
        aria-label="Resize right sidebar"
        disabled={!isOpen}
        withHandle
        className={[
          "z-40 bg-transparent after:bg-transparent hover:after:bg-transparent transition-[width,opacity,background-color,margin-left,margin-right] duration-300 ease-out",
          isOpen
            ? "-mx-2 w-4 opacity-100 data-[resize-handle-state=drag]:bg-primary/10"
            : "pointer-events-none mx-0 w-0 overflow-hidden opacity-0",
        ].join(" ")}
      />
      <ResizablePanel
        ref={panelRef}
        collapsible
        collapsedSize={0}
        defaultSize={
          isOpen ? initialSize : 0
        }
        minSize={MIN_RIGHT_SIDEBAR_SIZE}
        maxSize={MAX_RIGHT_SIDEBAR_SIZE}
        order={2}
        onCollapse={() => handleOpenChange(false)}
        onResize={handleResize}
        className="transition-[flex] duration-300 ease-out"
      >
        <WorkspaceSidebar
          aria-label="Context sidebar"
          open={isOpen}
          side="right"
          bodyClassName="desktop-sidebar-scroll overflow-y-auto px-2 pt-3 pb-2"
          bodyRef={setTarget}
        >
          {null}
        </WorkspaceSidebar>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
