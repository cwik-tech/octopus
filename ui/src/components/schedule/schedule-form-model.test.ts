import { describe, expect, it } from "vitest";

import {
  availableTimezones,
  agentTargetLabel,
  agentWebAccessLabel,
  compileSchedulePreset,
  inferSchedulePreset,
  sortAgentsByWebAccess,
} from "@/components/schedule/schedule-form-model";

describe("schedule form model", () => {
  it("compiles human presets to five-field cron and labels", () => {
    expect(compileSchedulePreset("weekdays", "17:30", "")).toEqual({
      cron: "30 17 * * 1-5",
      label: "Every weekday at 17:30",
    });
    expect(compileSchedulePreset("monthly", "09:05", "")).toEqual({
      cron: "5 9 1 * *",
      label: "On the first day of each month at 09:05",
    });
    expect(compileSchedulePreset("custom", "09:00", "  0  8 * * 1 ")).toEqual({
      cron: "0 8 * * 1",
      label: "Cron 0 8 * * 1",
    });
  });

  it("round-trips supported cron shapes and treats other expressions as custom", () => {
    expect(inferSchedulePreset("30 17 * * 1-5")).toEqual({
      preset: "weekdays",
      time: "17:30",
    });
    expect(inferSchedulePreset("*/10 * * * *")).toEqual({
      preset: "custom",
      time: "09:00",
    });
  });

  it("always offers UTC and the browser timezone", () => {
    const values = availableTimezones();
    expect(values).toContain("UTC");
    expect(values).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("puts browser-capable agents first, alphabetical within each group", () => {
    const sorted = sortAgentsByWebAccess([
      { name: "client-lens" },
      { name: "youtube-extractor", browserEnabled: true },
      { name: "architect-lead", browserEnabled: false },
      { name: "quick-scout", browserEnabled: true },
    ]);
    expect(sorted.map((agent) => agent.name)).toEqual([
      "quick-scout",
      "youtube-extractor",
      "architect-lead",
      "client-lens",
    ]);
  });

  it("leaves the caller's array untouched when sorting", () => {
    const agents = [{ name: "client-lens" }, { name: "quick-scout", browserEnabled: true }];
    sortAgentsByWebAccess(agents);
    expect(agents.map((agent) => agent.name)).toEqual(["client-lens", "quick-scout"]);
  });

  it("names agent targets without claiming anything about web access", () => {
    expect(agentTargetLabel({ name: "web-researcher", browserEnabled: true })).toBe(
      "Web Researcher",
    );
    expect(agentTargetLabel({ name: "client-lens" })).toBe("Client Lens");
  });

  it("describes the globe from the managed Browser tool", () => {
    expect(agentWebAccessLabel({ browserEnabled: true })).toBe(
      "Agent can browse internet",
    );
    expect(agentWebAccessLabel({ browserEnabled: false })).toBe(
      "Agent cannot browse internet",
    );
    expect(agentWebAccessLabel({})).toBe("Agent cannot browse internet");
  });
});
