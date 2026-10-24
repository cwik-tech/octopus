import { CircleAlert, Plus } from "lucide-react";

import { SessionRow } from "@/components/run/sessions/session-row";
import { SidebarEmptyState } from "@/components/run/sessions/sidebar-empty-state";
import { Button } from "@/components/ui/button";
import { PanelHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { SessionSummary } from "@/lib/models/session-model";

export function SessionsSidebar({
  sessions,
  loading,
  error,
  creating,
  selectedId,
  onSelect,
  onCreate,
  onDelete,
}: {
  sessions: SessionSummary[];
  loading: boolean;
  error: string | null;
  creating: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <>
      <PanelHeader
        title="Sessions"
        actions={
        <Button
          size="sm"
          variant="ghost"
          className="gap-1.5"
          onClick={onCreate}
          disabled={creating}
        >
          <Plus className="size-3.5" />
          New
        </Button>
        }
      />
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full rounded-lg" />
            <Skeleton className="h-14 w-full rounded-lg" />
            <Skeleton className="h-14 w-full rounded-lg" />
          </div>
        ) : sessions.length === 0 ? (
          <SidebarEmptyState onCreate={onCreate} creating={creating} />
        ) : (
          <ul className="space-y-1.5">
            {sessions.map((session) => (
              <li key={session.id}>
                <SessionRow
                  session={session}
                  selected={session.id === selectedId}
                  onSelect={() => onSelect(session.id)}
                  onDelete={() => onDelete(session.id)}
                />
              </li>
            ))}
          </ul>
        )}

        {error ? (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}
      </div>
    </>
  );
}
