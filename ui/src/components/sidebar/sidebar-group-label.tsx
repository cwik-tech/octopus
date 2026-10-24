import type { ReactNode } from "react";

export function SidebarGroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 px-2.5 text-xs font-medium uppercase tracking-[0.14em] text-sidebar-foreground/40">
      {children}
    </div>
  );
}
