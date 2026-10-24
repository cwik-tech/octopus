import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SchedulesWorkspace } from "@/components/schedule/schedules-workspace";
import type { BatchesState } from "@/components/batch/use-batches";
import type { SchedulesState } from "@/components/schedule/use-schedules";

describe("SchedulesWorkspace Batch peer", () => {
  it("offers Schedules and Batches as tabs, starting on Schedules", () => {
    render(<SchedulesWorkspace state={schedulesState()} batchesState={batchesState()} />);
    expect(screen.getByRole("tab", { name: "Schedules" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Batches" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("button", { name: "New schedule" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New Batch" })).not.toBeInTheDocument();
  });

  it("swaps the panel contents when the Batches tab is selected", async () => {
    render(<SchedulesWorkspace state={schedulesState()} batchesState={batchesState()} />);

    await userEvent.click(screen.getByRole("tab", { name: "Batches" }));

    expect(screen.getByRole("tab", { name: "Batches" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "New Batch" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New schedule" })).not.toBeInTheDocument();
  });

  it("keeps the plain Schedules heading when Batches are unavailable", () => {
    render(<SchedulesWorkspace state={schedulesState()} />);
    expect(screen.getByRole("heading", { name: "Schedules" })).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });
});

function schedulesState(): SchedulesState {
  return {
    schedules: [], loading: false, error: null,
    refresh: vi.fn(async () => undefined), create: vi.fn(), update: vi.fn(), remove: vi.fn(), runNow: vi.fn(),
  };
}

function batchesState(): BatchesState {
  return {
    batches: [], executionDetails: {}, loading: false, error: null,
    refresh: vi.fn(async () => undefined), create: vi.fn(), update: vi.fn(), remove: vi.fn(),
    preflight: vi.fn(), runNow: vi.fn(), cancel: vi.fn(), clearResults: vi.fn(),
    loadExecution: vi.fn(), loadMoreItems: vi.fn(),
  };
}
