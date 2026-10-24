import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PanelEmptyState } from "@/components/ui/card";

export function SidebarEmptyState({
  onCreate,
  creating,
}: {
  onCreate: () => void;
  creating: boolean;
}) {
  return (
    <PanelEmptyState>
      <div className="text-sm font-medium text-foreground">No sessions yet</div>
      <div className="mt-1.5 text-xs text-muted-foreground">
        Start your first session and ask the General Agent anything.
      </div>
      <Button
        size="sm"
        variant="outline"
        className="mt-3 gap-1.5"
        onClick={onCreate}
        disabled={creating}
      >
        <Plus className="size-3.5" />
        New session
      </Button>
    </PanelEmptyState>
  );
}
