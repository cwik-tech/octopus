import { AlarmClock, CalendarClock } from "lucide-react";
import { useCallback, useState } from "react";

import { OverviewSidebarItem } from "@/components/overview/overview-sidebar-item";
import { SessionActionsMenu } from "@/components/sidebar/session-actions-menu";
import type { RunWorkspaceView } from "@/components/run/run-panel";
import {
  buildQueueSessionSummaries,
  queueStateLabel,
} from "@/components/run/queue/queue-overview-model";
import type { SchedulesState } from "@/components/schedule/use-schedules";
import type { BatchesState } from "@/components/batch/use-batches";
import type { PendingSidebarDelete } from "@/components/sidebar/desktop-sidebar";
import { QueueStateDot } from "@/components/sidebar/queue-state-dot";
import { SidebarEmptyLabel } from "@/components/sidebar/sidebar-empty-label";
import { SidebarError } from "@/components/sidebar/sidebar-error";
import { SidebarGroupLabel } from "@/components/sidebar/sidebar-group-label";
import { SidebarItemButton } from "@/components/sidebar/sidebar-item-button";
import { SidebarSectionHeader } from "@/components/sidebar/sidebar-section-header";
import { SidebarSkeleton } from "@/components/sidebar/sidebar-skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { isRunSidebarTab, useRunSidebar } from "@/hooks/use-run-sidebar";
import { workflowsEnabled } from "@/lib/utils/workflows-enabled";
import type { SchedulingQueueSnapshot } from "@/lib/clients/scheduling-queue-client";
import type { SessionSummary } from "@/lib/models/session-model";
import { filterSidebarItems } from "@/lib/utils/sidebar-utils";

export function RunSessionsSidebar({
  sessions,
  loading,
  error,
  selectedSessionId,
  deletingSidebarItem,
  queueError,
  queueLoading,
  queueSnapshot,
  runWorkspaceView,
  batchesState,
  schedulesState,
  onSelect,
  onDelete,
  onQueueSelect,
  onSchedulesSelect,
  onSessionUpdated = () => undefined,
}: {
  sessions: SessionSummary[];
  loading: boolean;
  error: string | null;
  selectedSessionId: string | null;
  deletingSidebarItem: string | null;
  queueError: string | null;
  queueLoading: boolean;
  queueSnapshot: SchedulingQueueSnapshot | null;
  runWorkspaceView: RunWorkspaceView;
  batchesState?: BatchesState | undefined;
  schedulesState?: SchedulesState | undefined;
  onSelect: (sessionId: string) => void;
  onDelete: (target: PendingSidebarDelete) => void;
  onQueueSelect: () => void;
  onSchedulesSelect: () => void;
  onSessionUpdated?: (session: SessionSummary) => void;
}) {
  const [localQuery, setLocalQuery] = useState("");
  const navigation = useRunSidebar();
  const setTarget = navigation?.setTarget;
  const registerTarget = useCallback(
    (element: HTMLDivElement | null) => setTarget?.(element),
    [setTarget],
  );
  const searchQuery = navigation?.query ?? localQuery;
  const setSearchQuery = navigation?.setQuery ?? setLocalQuery;
  const activeSummaries = buildQueueSessionSummaries(queueSnapshot);
  const activeSessionIds = new Set(
    activeSummaries.map((summary) => summary.sessionId),
  );
  const activeRows = activeSummaries.map((summary) => ({
    summary,
    session: sessions.find((session) => session.id === summary.sessionId) ?? null,
  }));
  const visibleActiveRows = filterSidebarItems(
    activeRows,
    searchQuery,
    ({ session, summary }) => [
      session?.title,
      session?.activityType,
      queueStateLabel(summary.state),
    ],
  );
  const visibleRecentSessions = filterSidebarItems(
    sessions.filter((session) => !activeSessionIds.has(session.id)),
    searchQuery,
    (session) => [session.title, session.status, session.activityType],
  );
  const queueDescription = queueSnapshot
    ? `${queueSnapshot.slotsInUse} of ${queueSnapshot.maximumConcurrentTasks} slots · ${queueSnapshot.waitingCount} waiting`
    : queueLoading
      ? "Loading live queue…"
      : queueError
        ? "Queue unavailable"
        : "No live work";
  const scheduleItems = schedulesState?.schedules ?? [];
  const activeScheduleCount = scheduleItems.filter(
    (schedule) => schedule.enabled,
  ).length;
  const batchItems = batchesState?.batches ?? [];
  const activeBatchCount = batchItems.filter((batch) => Boolean(batch.activeExecution)).length;
  const scheduleDescription = schedulesState?.error || batchesState?.error
    ? "Schedules or Batches unavailable"
    : (schedulesState?.loading || batchesState?.loading) && scheduleItems.length === 0 && batchItems.length === 0
      ? "Loading Schedules and Batches…"
      : `${activeScheduleCount} ${activeScheduleCount === 1 ? "schedule" : "schedules"} active · ${activeBatchCount} ${activeBatchCount === 1 ? "Batch" : "Batches"} active`;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-sidebar">
      {/* Queue, Schedule & Batches and the Sessions header stay pinned; only
          the session rows scroll. */}
      <div className="shrink-0 px-2 pt-3">
        <OverviewSidebarItem
          label="Queue overview"
          description={queueDescription}
          icon={<CalendarClock className="size-4" aria-hidden="true" />}
          badge={queueSnapshot?.items.length}
          selected={runWorkspaceView === "queue"}
          onClick={onQueueSelect}
        />
        <OverviewSidebarItem
          label="Schedule & Batches"
          description={scheduleDescription}
          icon={<AlarmClock className="size-4" aria-hidden="true" />}
          badge={activeScheduleCount + activeBatchCount || undefined}
          selected={runWorkspaceView === "schedule"}
          onClick={onSchedulesSelect}
        />
        {navigation ? (
          <>
            <Tabs
              value={navigation.tab}
              onValueChange={(value) => {
                if (isRunSidebarTab(value)) {
                  navigation.setTab(value);
                }
              }}
              className="mx-1 mt-3 mb-2"
            >
              <TabsList aria-label="Run navigation" className="w-full bg-sidebar-accent/50">
                <TabsTrigger value="sessions" className="text-xs">
                  Sessions
                </TabsTrigger>
                <TabsTrigger
                  value="teams"
                  disabled={!navigation.targetsAvailable}
                  title={navigation.targetsAvailable ? undefined : navigation.unavailableReason}
                  className="text-xs"
                >
                  Teams
                </TabsTrigger>
                <TabsTrigger
                  value="agents"
                  disabled={!navigation.targetsAvailable}
                  title={navigation.targetsAvailable ? undefined : navigation.unavailableReason}
                  className="text-xs"
                >
                  Agents
                </TabsTrigger>
                {workflowsEnabled() ? (
                  <TabsTrigger value="workflows" disabled={!navigation.targetsAvailable} className="text-xs">
                    Workflows
                  </TabsTrigger>
                ) : null}
              </TabsList>
            </Tabs>
            <SidebarSectionHeader
              onSearch={setSearchQuery}
              searchLabel="Run sidebar"
              searchPlaceholder="Search sessions, teams or agents…"
            />
          </>
        ) : (
          <SidebarSectionHeader title="Sessions" onSearch={setSearchQuery} />
        )}
      </div>
      <section hidden={navigation !== undefined && navigation.tab !== "sessions"} className="desktop-sidebar-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {loading ? (
          <SidebarSkeleton />
        ) : visibleActiveRows.length === 0 && visibleRecentSessions.length === 0 ? (
          <SidebarEmptyLabel>No sessions yet.</SidebarEmptyLabel>
        ) : (
          <div className="space-y-3">
            {visibleActiveRows.length > 0 ? (
              <div>
                <SidebarGroupLabel>Active</SidebarGroupLabel>
                <ul className="space-y-1">
                  {visibleActiveRows.map(({ session, summary }) => (
                    <li key={summary.sessionId}>
                      <SidebarItemButton
                        label={session?.title ?? "Untitled session"}
                        meta={`${queueStateLabel(summary.state)} · ${summary.taskCount} ${summary.taskCount === 1 ? "task" : "tasks"}`}
                        metaIcon={<QueueStateDot state={summary.state} />}
                        metaIconLabel={`${queueStateLabel(summary.state)} session`}
                        selected={
                          runWorkspaceView === "session" &&
                          summary.sessionId === selectedSessionId
                        }
                        auxiliaryAction={
                          session ? (
                            <SessionActionsMenu
                              session={session}
                              onSessionUpdated={onSessionUpdated}
                            />
                          ) : undefined
                        }
                        onClick={() => onSelect(summary.sessionId)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {visibleRecentSessions.length > 0 ? (
              <div>
                <ul className="space-y-1">
                  {visibleRecentSessions.map((session) => (
                    <li key={session.id} data-session-id={session.id}>
                      <SidebarItemButton
                        label={session.title}
                        selected={
                          runWorkspaceView === "session" &&
                          session.id === selectedSessionId
                        }
                        auxiliaryAction={
                          <SessionActionsMenu
                            session={session}
                            onSessionUpdated={onSessionUpdated}
                            onDelete={() =>
                              onDelete({
                                id: session.id,
                                kind: "session",
                                label: `session “${session.title}”`,
                                allowSkipConfirmation: true,
                              })
                            }
                            deleting={deletingSidebarItem === session.id}
                          />
                        }
                        onClick={() => onSelect(session.id)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}

        <SidebarError message={error} />
      </section>
      {navigation ? (
        <div
          ref={registerTarget}
          className={navigation.tab === "sessions" ? "hidden" : "min-h-0 flex-1"}
        />
      ) : null}
    </div>
  );
}
