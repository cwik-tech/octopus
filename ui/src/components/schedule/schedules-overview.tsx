import {
  Bot,
  CircleAlert,
  FileText,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Workflow,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import {
  OverviewPanel,
  OverviewRow,
  OverviewSection,
  OverviewStat,
  OverviewStats,
  type OverviewHeaderTabs,
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
import { Switch } from "@/components/ui/switch";
import type { SchedulesState } from "@/components/schedule/use-schedules";
import { PanelEmptyState } from "@/components/ui/card";
import {
  buildSchedulesOverviewStats,
  formatScheduleTime,
  partitionSchedules,
  scheduleLastStatusLabel,
} from "@/components/schedule/schedules-overview-model";
import { formatDisplayName } from "@/lib/utils/display-name";
import type { Schedule } from "@/lib/clients/schedules-client";

export function SchedulesOverview({
  onEdit,
  onNew,
  onOpenSession,
  state,
  tabs,
}: {
  onEdit: (schedule: Schedule) => void;
  onNew: () => void;
  onOpenSession?: ((sessionId: string) => void) | undefined;
  state: SchedulesState;
  tabs?: OverviewHeaderTabs | undefined;
}) {
  const [deleteTarget, setDeleteTarget] = useState<Schedule | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const stats = useMemo(
    () => buildSchedulesOverviewStats(state.schedules),
    [state.schedules],
  );
  const groups = useMemo(
    () => partitionSchedules(state.schedules),
    [state.schedules],
  );

  async function toggle(schedule: Schedule, enabled: boolean): Promise<void> {
    setBusyKey(`toggle:${schedule.id}`);
    try {
      await state.update(schedule.id, { enabled });
      toast.success(enabled ? "Schedule resumed" : "Schedule paused");
    } catch (error) {
      toast.error("Schedule could not be updated", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyKey(null);
    }
  }

  async function runNow(schedule: Schedule): Promise<void> {
    setBusyKey(`run:${schedule.id}`);
    try {
      const result = await state.runNow(schedule.id);
      toast.success("Scheduled run queued");
      onOpenSession?.(result.sessionId);
    } catch (error) {
      toast.error("Schedule could not run", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyKey(null);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget) return;
    setBusyKey(`delete:${deleteTarget.id}`);
    try {
      await state.remove(deleteTarget.id);
      toast.success("Schedule deleted");
      setDeleteTarget(null);
    } catch (error) {
      toast.error("Schedule could not be deleted", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <>
      <OverviewPanel
        title="Schedules"
        description="Recurring agent calls and workflow runs admitted through the durable task queue."
        tabs={tabs}
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void state.refresh()}
              disabled={state.loading}
            >
              <RefreshCw className={state.loading ? "size-4 animate-spin" : "size-4"} />
              Refresh
            </Button>
            <Button size="sm" onClick={onNew}>
              <Plus className="size-4" />
              New schedule
            </Button>
          </>
        }
      >
        <OverviewStats columns={4}>
          <OverviewStat label="Active" value={stats.activeSchedules} />
          <OverviewStat label="Paused" value={stats.pausedSchedules} />
          <OverviewStat label="Runs in flight" value={stats.runningRuns} />
          <OverviewStat
            label="Next fire"
            value={
              <span className="text-base">
                {formatScheduleTime(stats.nextFireAt)}
              </span>
            }
          />
        </OverviewStats>

        {state.error ? (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-sm text-destructive" role="alert">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            {state.error}
          </div>
        ) : null}

        {state.loading && state.schedules.length === 0 ? (
          <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            Loading schedules…
          </div>
        ) : state.schedules.length === 0 ? (
          <PanelEmptyState className="mt-6 flex min-h-48 flex-col items-center justify-center bg-transparent">
            <p className="font-medium">No schedules yet</p>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              Schedule one agent call or an entire workflow. Every fire respects the workspace concurrency limit.
            </p>
            <Button className="mt-4" size="sm" onClick={onNew}>
              <Plus className="size-4" />
              Create schedule
            </Button>
          </PanelEmptyState>
        ) : (
          <>
            <ScheduleSection
              title="Active"
              schedules={groups.active}
              busyKey={busyKey}
              onDelete={setDeleteTarget}
              onEdit={onEdit}
              onOpenSession={onOpenSession}
              onRunNow={(schedule) => void runNow(schedule)}
              onToggle={(schedule, enabled) => void toggle(schedule, enabled)}
            />
            <ScheduleSection
              title="Paused"
              schedules={groups.paused}
              busyKey={busyKey}
              onDelete={setDeleteTarget}
              onEdit={onEdit}
              onOpenSession={onOpenSession}
              onRunNow={(schedule) => void runNow(schedule)}
              onToggle={(schedule, enabled) => void toggle(schedule, enabled)}
            />
          </>
        )}
      </OverviewPanel>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !busyKey?.startsWith("delete:")) setDeleteTarget(null);
        }}
      >
        <DialogContent showCloseButton={!busyKey?.startsWith("delete:")}>
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.name}?</DialogTitle>
            <DialogDescription>
              Active runs will be cancelled first. Completed sessions and their results remain available.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busyKey?.startsWith("delete:")} />}>
              Keep schedule
            </DialogClose>
            <Button
              variant="destructive"
              disabled={busyKey?.startsWith("delete:")}
              onClick={() => void confirmDelete()}
            >
              {busyKey?.startsWith("delete:") ? "Deleting…" : "Delete schedule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ScheduleSection({
  busyKey,
  onDelete,
  onEdit,
  onOpenSession,
  onRunNow,
  onToggle,
  schedules,
  title,
}: {
  busyKey: string | null;
  onDelete: (schedule: Schedule) => void;
  onEdit: (schedule: Schedule) => void;
  onOpenSession?: ((sessionId: string) => void) | undefined;
  onRunNow: (schedule: Schedule) => void;
  onToggle: (schedule: Schedule, enabled: boolean) => void;
  schedules: Schedule[];
  title: string;
}) {
  if (schedules.length === 0) return null;
  return (
    <OverviewSection title={title} count={schedules.length}>
      {schedules.map((schedule) => {
        const running = (schedule.runtime.activeFires?.length ?? 0) > 0;
        const busy = Boolean(busyKey?.endsWith(`:${schedule.id}`));
        const lastSessionId = schedule.runtime.lastSessionId;
        return (
          <OverviewRow
            key={schedule.id}
            status={running ? "running" : schedule.enabled ? "waiting" : undefined}
            actions={
              <>
                <Switch
                  checked={schedule.enabled}
                  onCheckedChange={(enabled) => onToggle(schedule, enabled)}
                  disabled={busy}
                  aria-label={`${schedule.enabled ? "Pause" : "Resume"} ${formatDisplayName(schedule.name)}`}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onRunNow(schedule)}
                  disabled={busy}
                >
                  {busyKey === `run:${schedule.id}` ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Play className="size-4" />
                  )}
                  Run now
                </Button>
                {lastSessionId && onOpenSession ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onOpenSession(lastSessionId)}
                    disabled={busy}
                  >
                    <FileText className="size-4" />
                    {schedule.runtime.lastStatus === "completed" ? "View result" : "View run"}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Edit ${formatDisplayName(schedule.name)}`}
                  onClick={() => onEdit(schedule)}
                  disabled={busy}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Delete ${formatDisplayName(schedule.name)}`}
                  onClick={() => onDelete(schedule)}
                  disabled={busy}
                >
                  <Trash2 className="size-4" />
                </Button>
              </>
            }
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <div className="truncate font-medium">
                {formatDisplayName(schedule.name)}
              </div>
              <Badge variant="outline" className="gap-1">
                {schedule.kind === "agent" ? <Bot /> : <Workflow />}
                {schedule.kind === "agent" ? "Agent" : "Workflow"}
              </Badge>
              {running ? <Badge className="bg-emerald-600">Running</Badge> : null}
              {!running && schedule.runtime.lastStatus ? (
                <ScheduleStatusBadge schedule={schedule} />
              ) : null}
            </div>
            <div className="mt-1 truncate text-xs text-muted-foreground">
              {schedule.scheduleLabel} · {schedule.timezone} ·{" "}
              {formatDisplayName(schedule.target)}
              {schedule.modelOverride ? (
                <>
                  {" · "}
                  {/*
                    A setting this schedule saved before it was retired. Shown,
                    because it is in the file and a person who sees it there
                    deserves to know why it reads oddly — but named as ignored,
                    because the row's other parts are operative and printing a
                    bare pair beside them said this schedule runs on it. It does
                    not: `services/scheduled-agent-target.ts` leaves it out of
                    the wrapper Team, so the Agent runs with its own pair or
                    with the application default.
                  */}
                  <span
                    className="italic"
                    title="This setting is no longer used. The agent runs with its own provider and model, or with the application default from Settings."
                  >
                    {`${schedule.modelOverride.provider}/${schedule.modelOverride.model} (ignored)`}
                  </span>
                </>
              ) : null}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>Next: {schedule.enabled ? formatScheduleTime(schedule.runtime.nextFireAt) : "Paused"}</span>
              <span>Last: {formatScheduleTime(schedule.runtime.lastFireAt)}</span>
              {schedule.runtime.lastError ? (
                <span className="max-w-xl truncate text-destructive" title={schedule.runtime.lastError}>
                  {schedule.runtime.lastError}
                </span>
              ) : null}
            </div>
          </OverviewRow>
        );
      })}
    </OverviewSection>
  );
}

function ScheduleStatusBadge({ schedule }: { schedule: Schedule }) {
  const status = schedule.runtime.lastStatus;
  const destructive = status === "failed" || status === "error";
  return (
    <Badge variant={destructive ? "destructive" : "secondary"}>
      {scheduleLastStatusLabel(status)}
    </Badge>
  );
}
