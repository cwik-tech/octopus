import { Trash2 } from "lucide-react";

import { formatRelativeTime } from "@/components/run/sessions/format-relative-time";
import { PanelItem } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { SessionSummary } from "@/lib/models/session-model";

export function SessionRow({
  session,
  selected,
  onSelect,
  onDelete,
}: {
  session: SessionSummary;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <PanelItem
      selected={selected}
      className={[
        "group flex items-start gap-2",
        selected ? "" : "hover:bg-muted/55",
      ].join(" ")}
    >
      <Button
        variant="ghost"
        onClick={onSelect}
        className="h-auto min-w-0 flex-1 flex-col items-start gap-0 px-0 py-0 text-left font-normal hover:bg-transparent"
      >
        <div className="line-clamp-1 w-full text-sm font-medium text-foreground">
          {session.title}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {formatRelativeTime(session.updatedAt)}
        </div>
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
        aria-label={`Delete ${session.title}`}
      >
        <Trash2 className="text-muted-foreground hover:text-destructive" />
      </Button>
    </PanelItem>
  );
}
