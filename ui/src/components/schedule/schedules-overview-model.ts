import type { Schedule, ScheduleLastStatus } from "@/lib/clients/schedules-client";

export interface SchedulesOverviewStats {
  activeSchedules: number;
  pausedSchedules: number;
  runningRuns: number;
  nextFireAt?: string;
}

export function buildSchedulesOverviewStats(
  schedules: readonly Schedule[],
): SchedulesOverviewStats {
  const enabled = schedules.filter((schedule) => schedule.enabled);
  const nextFireAt = enabled
    .map((schedule) => schedule.runtime.nextFireAt)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  return {
    activeSchedules: enabled.length,
    pausedSchedules: schedules.length - enabled.length,
    runningRuns: schedules.reduce(
      (total, schedule) => total + (schedule.runtime.activeFires?.length ?? 0),
      0,
    ),
    ...(nextFireAt ? { nextFireAt } : {}),
  };
}

export function partitionSchedules(schedules: readonly Schedule[]): {
  active: Schedule[];
  paused: Schedule[];
} {
  const byNextFire = (left: Schedule, right: Schedule) => {
    const leftTime = Date.parse(left.runtime.nextFireAt ?? "");
    const rightTime = Date.parse(right.runtime.nextFireAt ?? "");
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
      return leftTime - rightTime || left.name.localeCompare(right.name);
    }
    if (Number.isFinite(leftTime)) return -1;
    if (Number.isFinite(rightTime)) return 1;
    return left.name.localeCompare(right.name);
  };
  return {
    active: schedules.filter((schedule) => schedule.enabled).sort(byNextFire),
    paused: schedules.filter((schedule) => !schedule.enabled).sort(byNextFire),
  };
}

export function formatScheduleTime(
  timestamp: string | undefined,
  now = new Date(),
): string {
  if (!timestamp) return "—";
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return "—";
  const differenceSeconds = Math.round((time - now.getTime()) / 1_000);
  const absolute = Math.abs(differenceSeconds);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (absolute < 60) return formatter.format(differenceSeconds, "second");
  if (absolute < 3_600) return formatter.format(Math.round(differenceSeconds / 60), "minute");
  if (absolute < 86_400) return formatter.format(Math.round(differenceSeconds / 3_600), "hour");
  if (absolute < 604_800) return formatter.format(Math.round(differenceSeconds / 86_400), "day");
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(time));
}

export function scheduleLastStatusLabel(status: ScheduleLastStatus | undefined): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "skipped_overlap":
      return "Skipped overlap";
    case "error":
      return "Error";
    default:
      return "Never run";
  }
}
