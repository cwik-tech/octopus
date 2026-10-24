import type { ReactNode } from "react";

import { PanelEmptyState } from "@/components/ui/card";

export function EmptyTab({ children }: { children: ReactNode }) {
  return (
    <PanelEmptyState className="text-xs text-muted-foreground">
      {children}
    </PanelEmptyState>
  );
}
