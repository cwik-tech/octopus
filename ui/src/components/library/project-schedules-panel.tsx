import { CalendarClock, Loader2 } from "lucide-react";
import { startTransition, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { listSchedules } from "@/lib/clients/schedules-client";
import type { Schedule } from "@contracts/schedules";

export function ProjectSchedulesPanel({
  projectId,
  initialSchedules,
}: {
  projectId: string;
  initialSchedules?: Schedule[];
}) {
  const controlled = initialSchedules !== undefined;
  const [localSchedules, setLocalSchedules] = useState<Schedule[]>(
    () => initialSchedules ?? [],
  );
  const [localLoading, setLocalLoading] = useState(initialSchedules === undefined);
  const [error, setError] = useState<string | null>(null);
  const schedules = initialSchedules ?? localSchedules;
  const loading = controlled ? false : localLoading;

  useEffect(() => {
    if (controlled) return;
    const controller = new AbortController();
    startTransition(() => {
      setLocalSchedules([]);
      setLocalLoading(true);
      setError(null);
    });
    void listSchedules(controller.signal)
      .then((next) => {
        setLocalSchedules(next.filter((schedule) => schedule.projectId === projectId));
      })
      .catch((nextError: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(nextError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLocalLoading(false);
      });
    return () => controller.abort();
  }, [controlled, projectId]);

  return (
    <section className="mt-6 rounded-xl border border-border/70 p-4" aria-labelledby="project-schedules-heading">
      <div className="flex items-center gap-2">
        <CalendarClock className="size-4 text-muted-foreground" aria-hidden="true" />
        <h3 id="project-schedules-heading" className="font-heading text-base font-semibold">
          Project schedules
        </h3>
      </div>
      {loading ? (
        <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading schedules…
        </div>
      ) : schedules.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No schedules target this project.</p>
      ) : (
        <div className="mt-3 divide-y rounded-lg border border-border/60">
          {schedules.map((schedule) => (
            <div key={schedule.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{schedule.name}</p>
                <p className="truncate text-xs text-muted-foreground">{schedule.scheduleLabel}</p>
              </div>
              {schedule.runtime.activeFires?.length ? (
                <Badge variant="default">Running</Badge>
              ) : (
                <Badge variant="secondary">{schedule.enabled ? "Enabled" : "Paused"}</Badge>
              )}
            </div>
          ))}
        </div>
      )}
      {error ? <p className="mt-3 text-sm text-destructive" role="alert">{error}</p> : null}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Schedule request failed";
}
