import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SchedulesOverview } from "@/components/schedule/schedules-overview";
import type { SchedulesState } from "@/components/schedule/use-schedules";
import type { Schedule } from "@/lib/clients/schedules-client";

describe("SchedulesOverview", () => {
  it("opens the admitted session after Run now succeeds", async () => {
    const onOpenSession = vi.fn();
    render(
      <SchedulesOverview
        onEdit={() => undefined}
        onNew={() => undefined}
        onOpenSession={onOpenSession}
        state={stateWith([schedule()])}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run now" }));

    await waitFor(() => {
      expect(onOpenSession).toHaveBeenCalledWith("scheduled-session");
    });
  });

  it("opens the persisted session for a completed schedule result", () => {
    const onOpenSession = vi.fn();
    render(
      <SchedulesOverview
        onEdit={() => undefined}
        onNew={() => undefined}
        onOpenSession={onOpenSession}
        state={stateWith([
          schedule({
            runtime: {
              lastFireAt: "2026-07-20T01:17:37.000Z",
              lastSessionId: "scheduled-session",
              lastStatus: "completed",
            },
          }),
        ])}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "View result" }));

    expect(onOpenSession).toHaveBeenCalledWith("scheduled-session");
  });

  it("says a stored model override is ignored rather than showing it as the pair", () => {
    // A schedule saved before the setting was retired still carries one, and
    // the row printed it as `provider/model` beside the target and timezone —
    // which are operative. So the row said this schedule runs on that pair, and
    // it does not: `scheduled-agent-target.ts` ignores it and the Agent runs
    // with its own pair or the application default.
    render(
      <SchedulesOverview
        onEdit={() => undefined}
        onNew={() => undefined}
        onOpenSession={() => undefined}
        state={stateWith([
          schedule({
            modelOverride: { provider: "anthropic", model: "claude-sonnet-4-6" },
          }),
        ])}
      />,
    );

    // Still visible — it is in the file, and hiding it would leave a person
    // unable to see why an old schedule reads oddly.
    const ignored = screen.getByText(/anthropic\/claude-sonnet-4-6/);
    expect(ignored).toBeInTheDocument();
    // But named as retired, not as the pair this schedule uses.
    expect(ignored).toHaveTextContent(/ignored/i);
    expect(ignored).toHaveAccessibleDescription(/no longer|ignored/i);
  });

  it("shows no model line at all for a schedule that carries no override", () => {
    render(
      <SchedulesOverview
        onEdit={() => undefined}
        onNew={() => undefined}
        onOpenSession={() => undefined}
        state={stateWith([schedule()])}
      />,
    );

    expect(screen.queryByText(/ignored/i)).toBeNull();
    expect(screen.getByText(/America\/Detroit/)).toBeInTheDocument();
  });
});

function stateWith(schedules: Schedule[]): SchedulesState {
  return {
    schedules,
    loading: false,
    error: null,
    refresh: async () => undefined,
    create: async () => schedules[0]!,
    update: async () => schedules[0]!,
    remove: async () => undefined,
    runNow: async () => ({ sessionId: "scheduled-session", taskId: "scheduled-task" }),
  };
}

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "schedule",
    name: "Daily brief",
    kind: "agent",
    target: "web-researcher",
    prompt: "Research today's top news.",
    cron: "0 9 * * *",
    timezone: "America/Detroit",
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
