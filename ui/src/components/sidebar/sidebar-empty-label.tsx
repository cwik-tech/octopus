import type { ReactNode } from "react";

export function SidebarEmptyLabel({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg px-2.5 py-3 text-sm text-sidebar-foreground/60">
      {children}
    </div>
  );
}
