import { describe, expect, it } from "vitest";

import {
  buildSchedulesOverviewStats,
  partitionSchedules,
  scheduleLastStatusLabel,
} from "@/components/schedule/schedules-overview-model";
import type { Schedule } from "@/lib/clients/schedules-client";

describe("schedules overview model", () => {
  it("counts enabled schedules and every in-flight queued overlap", () => {
    const schedules = [
      schedule({
        id: "first",
        runtime: {
          nextFireAt: "2026-07-20T12:00:00.000Z",
          activeFires: [
            { sessionId: "s1", taskId: "t1", firedAt: "2026-07-19T10:00:00.000Z" },
            { sessionId: "s2", taskId: "t2", firedAt: "2026-07-19T11:00:00.000Z" },
          ],
        },
      }),
      schedule({
        id: "paused",
        enabled: false,
        runtime: {},
      }),
    ];
    expect(buildSchedulesOverviewStats(schedules)).toEqual({
      activeSchedules: 1,
      pausedSchedules: 1,
      runningRuns: 2,
      nextFireAt: "2026-07-20T12:00:00.000Z",
    });
  });

  it("partitions active and paused rows and maps terminal labels", () => {
    const active = schedule({ id: "active", name: "B" });
    const paused = schedule({ id: "paused", name: "A", enabled: false });
    expect(partitionSchedules([paused, active])).toEqual({
      active: [active],
      paused: [paused],
    });
    expect(scheduleLastStatusLabel("skipped_overlap")).toBe("Skipped overlap");
    expect(scheduleLastStatusLabel(undefined)).toBe("Never run");
  });
});

function schedule(overrides: Partial<Schedule>): Schedule {
  return {
    id: "schedule",
    name: "Schedule",
    kind: "workflow",
    target: "workflow",
    prompt: "Produce a useful test report.",
    cron: "0 9 * * *",
    timezone: "UTC",
    scheduleLabel: "Every day at 09:00",
    overlap: "skip",
    notifyOnFailure: false,
    enabled: true,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    runtime: {},
    ...overrides,
  };
}
