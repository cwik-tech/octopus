import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RunSessionsSidebar } from "@/components/sidebar/run-sessions-sidebar";
import type { BatchesState } from "@/components/batch/use-batches";
import type { SchedulesState } from "@/components/schedule/use-schedules";

describe("RunSessionsSidebar Batch summary", () => {
  it("labels the shared destination and summarizes active Schedules and Batches", () => {
    render(<RunSessionsSidebar
      sessions={[]} loading={false} error={null} selectedSessionId={null} deletingSidebarItem={null}
      queueError={null} queueLoading={false} queueSnapshot={null} runWorkspaceView="schedule"
      schedulesState={scheduleState()} batchesState={batchState()}
      onSelect={vi.fn()} onDelete={vi.fn()} onQueueSelect={vi.fn()} onSchedulesSelect={vi.fn()}
    />);
    expect(screen.getByRole("button", { name: /Schedule & Batches/ })).toBeInTheDocument();
    expect(screen.getByText("1 schedule active · 1 Batch active")).toBeInTheDocument();
  });
});

function scheduleState(): SchedulesState {
  return { schedules: [{ id: "s", enabled: true } as never], loading: false, error: null, refresh: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), runNow: vi.fn() };
}

function batchState(): BatchesState {
  return { batches: [{ id: "b", activeExecution: { id: "e" } } as never], executionDetails: {}, loading: false, error: null, refresh: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), preflight: vi.fn(), runNow: vi.fn(), cancel: vi.fn(), clearResults: vi.fn(), loadExecution: vi.fn(), loadMoreItems: vi.fn() };
}
