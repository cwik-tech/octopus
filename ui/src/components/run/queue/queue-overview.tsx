import {
  CircleAlert,
  Loader2,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  OverviewPanel,
  OverviewRow,
  OverviewSection,
  OverviewStat,
  OverviewStats,
} from "@/components/overview/overview-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cancelSessionTask } from "@/lib/clients/session-client";
import type { SessionSummary } from "@/lib/models/session-model";
import type {
  SchedulingQueueItem,
  SchedulingQueueItemState,
  SchedulingQueueSnapshot,
} from "@/lib/clients/scheduling-queue-client";
import {
  queueHoldDetail,
  queueHoldSentence,
  queueStateLabel,
} from "@/components/run/queue/queue-overview-model";
import { PanelEmptyState } from "@/components/ui/card";
import { formatDisplayName } from "@/lib/utils/display-name";

const SECTION_ORDER: SchedulingQueueItemState[] = [
  "running",
  "starting",
  "finishing",
  "waiting",
];

export function QueueOverview({
  error,
  loading,
  onOpenSession,
  onOpenSettings,
  onRefresh,
  sessions,
  snapshot,
}: {
  error: string | null;
  loading: boolean;
  onOpenSession: (sessionId: string) => void;
  onOpenSettings: () => void;
  onRefresh: () => Promise<void>;
  sessions: SessionSummary[];
  snapshot: SchedulingQueueSnapshot | null;
}) {
  const [cancelTarget, setCancelTarget] = useState<SchedulingQueueItem | null>(null);
  const [cancellingTaskId, setCancellingTaskId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const sessionTitles = useMemo(
    () => new Map(sessions.map((session) => [session.id, session.title])),
    [sessions],
  );
  const groups = useMemo(() => {
    const grouped = new Map<SchedulingQueueItemState, SchedulingQueueItem[]>(
      SECTION_ORDER.map((state) => [state, []]),
    );
    for (const item of snapshot?.items ?? []) grouped.get(item.state)?.push(item);
    return grouped;
  }, [snapshot]);
  const blockingItems = useMemo(
    () => (snapshot?.items ?? []).filter((item) => item.hold?.blocksDispatch === true),
    [snapshot],
  );

  async function confirmCancellation(): Promise<void> {
    if (!cancelTarget) return;
    setCancellingTaskId(cancelTarget.taskId);
    setCancelError(null);
    try {
      await cancelSessionTask(cancelTarget.sessionId, cancelTarget.taskId);
      setCancelTarget(null);
      await onRefresh();
    } catch (requestError) {
      setCancelError(
        requestError instanceof Error
          ? requestError.message
          : "The workflow could not be cancelled.",
      );
    } finally {
      setCancellingTaskId(null);
    }
  }

  const maximum = snapshot?.maximumConcurrentTasks ?? 0;
  const observedAt = snapshot?.observedAt ?? new Date().toISOString();

  return (
    <>
      <OverviewPanel
        title="Queue overview"
        description="Live top-level workflow capacity and FIFO waiting order for this workspace."
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void onRefresh()}
              disabled={loading}
            >
              <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
              Refresh
            </Button>
            <Button size="sm" variant="outline" onClick={onOpenSettings}>
              <Settings2 className="size-4" />
              Scheduling
            </Button>
          </>
        }
      >
        <OverviewStats>
          <OverviewStat
            label="Slots in use"
            value={snapshot ? `${snapshot.slotsInUse} / ${maximum}` : "—"}
          />
          <OverviewStat
            label="Available slots"
            value={snapshot?.availableSlots ?? "—"}
          />
          <OverviewStat label="Waiting" value={snapshot?.waitingCount ?? "—"} />
        </OverviewStats>

        {error ? (
          <QueueNotice tone="error">{error}</QueueNotice>
        ) : snapshot?.status === "recovering" ? (
          <QueueNotice tone="neutral">
            Task admission is rebuilding its durable queue. This view will update automatically.
          </QueueNotice>
        ) : snapshot?.status === "blocked" ? (
          blockingItems.length > 0 ? (
            <BlockedNotice
              items={blockingItems}
              onOpenSession={onOpenSession}
              sessionTitles={sessionTitles}
            />
          ) : (
            // A server that does not name its holds yet.
            <QueueNotice tone="error">
              Dispatch is blocked because an existing worker cannot be identified safely.
            </QueueNotice>
          )
        ) : null}

        {loading && !snapshot ? (
          <div className="mt-6 flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            Loading live queue…
          </div>
        ) : snapshot && snapshot.items.length === 0 ? (
          <PanelEmptyState className="mt-6 flex min-h-48 flex-col items-center justify-center bg-transparent">
            <p className="font-medium">No active or waiting workflows</p>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              Start work in any session. Concurrent workflows will appear here while they are live.
            </p>
          </PanelEmptyState>
        ) : (
          SECTION_ORDER.map((state) => {
            const items = groups.get(state) ?? [];
            if (items.length === 0) return null;
            return (
              <OverviewSection key={state} title={queueStateLabel(state)} count={items.length}>
                {items.map((item) => {
                  const title = sessionTitles.get(item.sessionId) ?? "Untitled session";
                  return (
                    <OverviewRow
                      key={item.taskId}
                      status={item.state}
                      actions={
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Open ${title}`}
                            onClick={() => onOpenSession(item.sessionId)}
                          >
                            Open
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={`Cancel ${title}`}
                            disabled={cancellingTaskId === item.taskId}
                            onClick={() => {
                              setCancelError(null);
                              setCancelTarget(item);
                            }}
                          >
                            {cancellingTaskId === item.taskId ? "Cancelling…" : "Cancel"}
                          </Button>
                        </>
                      }
                    >
                      <div className="flex min-w-0 items-baseline gap-2">
                        <div className="truncate font-medium">{title}</div>
                        {item.source === "scheduled" ? (
                          <Badge variant="secondary">Scheduled</Badge>
                        ) : null}
                        {item.source === "batch" ? (
                          <Badge variant="secondary">Batch</Badge>
                        ) : null}
                        {item.hold ? (
                          <Badge variant="secondary">Held</Badge>
                        ) : null}
                        <div className="shrink-0 text-xs text-muted-foreground">
                          {formatQueueAge(item, observedAt)}
                        </div>
                      </div>
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {formatDisplayName(item.workflowId)}
                        {item.executionKind === "recovery" ? " · recovery" : ""}
                      </div>
                      {item.hold ? (
                        <div className="mt-1 text-xs text-warning">
                          {queueHoldSentence(item.hold.reason)}
                        </div>
                      ) : null}
                    </OverviewRow>
                  );
                })}
              </OverviewSection>
            );
          })
        )}
      </OverviewPanel>

      <Dialog
        open={cancelTarget !== null}
        onOpenChange={(open) => {
          if (!open && !cancellingTaskId) {
            setCancelTarget(null);
            setCancelError(null);
          }
        }}
      >
        <DialogContent showCloseButton={!cancellingTaskId}>
          <DialogHeader>
            <DialogTitle>Cancel this workflow?</DialogTitle>
            <DialogDescription>
              {cancelTarget?.state === "waiting"
                ? "It will be removed from the FIFO queue and will not start."
                : "Its active worker will be asked to stop and its slot will be released after shutdown."}
            </DialogDescription>
          </DialogHeader>
          {cancelError ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive" role="alert">
              {cancelError}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={Boolean(cancellingTaskId)} />}>
              Keep running
            </DialogClose>
            <Button
              variant="destructive"
              disabled={Boolean(cancellingTaskId)}
              onClick={() => void confirmCancellation()}
            >
              {cancellingTaskId ? "Cancelling…" : "Yes, cancel"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Names each task whose worker cannot be confirmed: the session and workflow
 * first, then why new work waits, then the pid or group count as detail.
 */
function BlockedNotice({
  items,
  onOpenSession,
  sessionTitles,
}: {
  items: SchedulingQueueItem[];
  onOpenSession: (sessionId: string) => void;
  sessionTitles: ReadonlyMap<string, string>;
}) {
  return (
    <div
      className="mt-4 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-sm text-destructive"
      role="alert"
    >
      <div className="flex items-start gap-2">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <p>New work is waiting until these workers are confirmed or stop.</p>
      </div>
      <ul className="mt-2 space-y-2 pl-6">
        {items.map((item) => {
          const title = sessionTitles.get(item.sessionId) ?? "Untitled session";
          const detail = item.hold ? queueHoldDetail(item.hold) : undefined;
          return (
            <li key={item.taskId} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium">
                  {title} · {formatDisplayName(item.workflowId)}
                </p>
                {item.hold ? <p>{queueHoldSentence(item.hold.reason)}</p> : null}
                {detail ? <p className="text-xs opacity-80">{detail}</p> : null}
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Open ${title}`}
                onClick={() => onOpenSession(item.sessionId)}
              >
                Open
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function QueueNotice({
  children,
  tone,
}: {
  children: string;
  tone: "error" | "neutral";
}) {
  return (
    <div
      className={[
        "mt-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
        tone === "error"
          ? "border-destructive/30 bg-destructive/8 text-destructive"
          : "border-border/70 bg-muted/40 text-muted-foreground",
      ].join(" ")}
      role={tone === "error" ? "alert" : "status"}
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      {children}
    </div>
  );
}

function formatQueueAge(item: SchedulingQueueItem, observedAt: string): string {
  const from = Date.parse(item.startedAt ?? item.requestedAt);
  const to = Date.parse(observedAt);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return queueStateLabel(item.state);
  const elapsedSeconds = Math.max(0, Math.floor((to - from) / 1_000));
  const elapsed = elapsedSeconds < 60
    ? `${elapsedSeconds}s`
    : elapsedSeconds < 3_600
      ? `${Math.floor(elapsedSeconds / 60)}m`
      : `${Math.floor(elapsedSeconds / 3_600)}h ${Math.floor((elapsedSeconds % 3_600) / 60)}m`;
  return `${queueStateLabel(item.state)} ${elapsed}`;
}
