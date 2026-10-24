import { formatDisplayName } from "@/lib/utils/display-name";

export type SchedulePreset =
  | "every_30_minutes"
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "custom";

export interface CompiledSchedule {
  cron: string;
  label: string;
}

export interface ScheduleAgentWebCapability {
  browserEnabled?: boolean | undefined;
  name: string;
}

/**
 * What the globe beside an agent claims.
 *
 * Deliberately narrow: the only thing the agent list actually knows is whether
 * the persona declares the managed Browser tool. It says nothing about whether
 * the chosen provider can reach the web by its own means, so the wording must
 * not promise that either.
 */
export function agentWebAccessLabel(
  agent: Pick<ScheduleAgentWebCapability, "browserEnabled">,
): "Agent can browse internet" | "Agent cannot browse internet" {
  return agent.browserEnabled === true
    ? "Agent can browse internet"
    : "Agent cannot browse internet";
}

export function agentTargetLabel(agent: ScheduleAgentWebCapability): string {
  return formatDisplayName(agent.name);
}

/**
 * Browser-capable agents first, then everything else, alphabetical within each
 * group. The picker is long enough that the handful of agents which can open a
 * website should not have to be hunted for.
 */
export function sortAgentsByWebAccess<T extends ScheduleAgentWebCapability>(
  agents: readonly T[],
): T[] {
  return [...agents].sort((left, right) => {
    const leftRank = left.browserEnabled === true ? 0 : 1;
    const rightRank = right.browserEnabled === true ? 0 : 1;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return formatDisplayName(left.name).localeCompare(formatDisplayName(right.name));
  });
}

export const SCHEDULE_PRESETS: Array<{ value: SchedulePreset; label: string }> = [
  { value: "every_30_minutes", label: "Every 30 minutes" },
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Every Monday" },
  { value: "monthly", label: "First day of each month" },
  { value: "custom", label: "Custom cron" },
];

export function compileSchedulePreset(
  preset: SchedulePreset,
  time: string,
  customCron: string,
): CompiledSchedule {
  if (preset === "every_30_minutes") {
    return { cron: "*/30 * * * *", label: "Every 30 minutes" };
  }
  if (preset === "hourly") {
    return { cron: "5 * * * *", label: "Every hour at minute 5" };
  }
  if (preset === "custom") {
    const cron = customCron.trim().replace(/\s+/g, " ");
    return { cron, label: cron ? `Cron ${cron}` : "Custom cron" };
  }

  const [hour, minute] = parseTime(time);
  const clock = formatClock(hour, minute);
  switch (preset) {
    case "daily":
      return { cron: `${minute} ${hour} * * *`, label: `Every day at ${clock}` };
    case "weekdays":
      return {
        cron: `${minute} ${hour} * * 1-5`,
        label: `Every weekday at ${clock}`,
      };
    case "weekly":
      return {
        cron: `${minute} ${hour} * * 1`,
        label: `Every Monday at ${clock}`,
      };
    case "monthly":
      return {
        cron: `${minute} ${hour} 1 * *`,
        label: `On the first day of each month at ${clock}`,
      };
    default:
      return assertNever(preset);
  }
}

export function inferSchedulePreset(cron: string): {
  preset: SchedulePreset;
  time: string;
} {
  const normalized = cron.trim().replace(/\s+/g, " ");
  if (normalized === "*/30 * * * *") {
    return { preset: "every_30_minutes", time: "09:00" };
  }
  if (normalized === "5 * * * *") {
    return { preset: "hourly", time: "09:00" };
  }
  const match = /^(\d{1,2}) (\d{1,2}) (\*|1) \* (\*|1-5|1)$/.exec(normalized);
  if (!match) return { preset: "custom", time: "09:00" };
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) return { preset: "custom", time: "09:00" };
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (match[3] === "1") return { preset: "monthly", time };
  if (match[4] === "1-5") return { preset: "weekdays", time };
  if (match[4] === "1") return { preset: "weekly", time };
  return { preset: "daily", time };
}

export function availableTimezones(): string[] {
  const current = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const supportedValuesOf = (
    Intl as typeof Intl & {
      supportedValuesOf?: (key: "timeZone") => string[];
    }
  ).supportedValuesOf;
  const values = supportedValuesOf
    ? supportedValuesOf("timeZone")
    : [
        "UTC",
        "America/Detroit",
        "America/New_York",
        "America/Chicago",
        "America/Denver",
        "America/Los_Angeles",
        "Europe/London",
        "Europe/Warsaw",
        "Asia/Tokyo",
      ];
  return Array.from(new Set([current, "UTC", ...values]));
}

function parseTime(value: string): [number, number] {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Choose a valid time.");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("Choose a valid time.");
  return [hour, minute];
}

function formatClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported schedule preset: ${String(value)}`);
}
