import type { HTMLAttributes, ReactNode, Ref } from "react";

import { cn } from "@/lib/utils/utils";

interface WorkspaceSidebarProps extends HTMLAttributes<HTMLElement> {
  bodyClassName?: string;
  bodyRef?: Ref<HTMLDivElement>;
  children: ReactNode;
  open: boolean;
  side: "left" | "right";
}

export function WorkspaceSidebar({
  bodyClassName,
  bodyRef,
  children,
  className,
  open,
  side,
  ...props
}: WorkspaceSidebarProps) {
  return (
    <aside
      {...props}
      aria-hidden={!open}
      className={cn(
        "flex h-full min-w-0 flex-col overflow-hidden bg-sidebar text-sidebar-foreground",
        open &&
          (side === "left"
            ? "border-r border-border/70"
            : "border-l border-border/70"),
        className,
      )}
      data-side={side}
      data-slot="workspace-sidebar"
      inert={!open}
    >
      <div className="desktop-titlebar h-11 shrink-0" />
      <div ref={bodyRef} className={cn("min-h-0 flex-1", bodyClassName)}>
        {children}
      </div>
    </aside>
  );
}
