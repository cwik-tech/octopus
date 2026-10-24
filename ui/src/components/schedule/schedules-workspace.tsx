import { useState } from "react";
import { toast } from "sonner";

import { BatchForm } from "@/components/batch/batch-form";
import { BatchOverview } from "@/components/batch/batch-overview";
import type { BatchesState } from "@/components/batch/use-batches";
import type { OverviewHeaderTabs } from "@/components/overview/overview-panel";
import { ScheduleForm } from "@/components/schedule/schedule-form";
import { SchedulesOverview } from "@/components/schedule/schedules-overview";
import type { SchedulesState } from "@/components/schedule/use-schedules";
import type { Schedule, ScheduleInput } from "@/lib/clients/schedules-client";
import type { BatchDefinitionInput, BatchView } from "@contracts/batches";

type WorkspaceTab = "schedules" | "batches";

export function SchedulesWorkspace({
  onOpenSession,
  batchesState,
  state,
}: {
  onOpenSession?: ((sessionId: string) => void) | undefined;
  batchesState?: BatchesState | undefined;
  state: SchedulesState;
}) {
  const [editing, setEditing] = useState<{ kind: "schedule" | "batch"; id: "new" | string } | null>(null);
  const [tab, setTab] = useState<WorkspaceTab>("schedules");
  const schedule = editing?.kind === "schedule" && editing.id !== "new"
    ? state.schedules.find((entry) => entry.id === editing.id)
    : undefined;
  const batch = editing?.kind === "batch" && editing.id !== "new"
    ? batchesState?.batches.find((entry) => entry.id === editing.id)
    : undefined;
  // Batches share the panel with Schedules as a second tab. Without them there
  // is nothing to switch between, so the panel keeps its plain heading.
  const tabs: OverviewHeaderTabs | undefined = batchesState
    ? {
        activeId: tab,
        ariaLabel: "Schedules and Batches",
        items: [
          { id: "schedules", label: "Schedules" },
          { id: "batches", label: "Batches" },
        ],
        onSelect: (id: string) => setTab(id === "batches" ? "batches" : "schedules"),
      }
    : undefined;
  const overview = <div className="h-full min-h-0">
    {batchesState && tab === "batches" ? (
      <BatchOverview state={batchesState} tabs={tabs} onNew={() => setEditing({ kind: "batch", id: "new" })} onEdit={(target: BatchView) => setEditing({ kind: "batch", id: target.id })} onOpenSession={onOpenSession} />
    ) : (
      <SchedulesOverview state={state} tabs={tabs} onNew={() => setEditing({ kind: "schedule", id: "new" })} onEdit={(target: Schedule) => setEditing({ kind: "schedule", id: target.id })} onOpenSession={onOpenSession} />
    )}
  </div>;

  // A schedule may disappear during polling while its editor is open. Never
  // turn that stale edit into an accidental create.
  if (editing?.kind === "schedule" && editing.id !== "new" && !schedule) return overview;
  if (editing?.kind === "batch" && editing.id !== "new" && !batch) return overview;

  if (editing?.kind === "schedule") {
    return (
      <ScheduleForm
        key={editing.id}
        schedule={schedule}
        onCancel={() => setEditing(null)}
        onSave={async (input: ScheduleInput) => {
          if (schedule) {
            await state.update(schedule.id, {
              ...input,
              modelOverride: input.modelOverride ?? null,
            });
            toast.success("Schedule updated");
          } else {
            await state.create(input);
            toast.success("Schedule created");
          }
          setEditing(null);
        }}
      />
    );
  }

  if (editing?.kind === "batch" && batchesState) {
    return <BatchForm
      key={editing.id}
      batch={batch}
      onCancel={() => setEditing(null)}
      onSave={async (input: BatchDefinitionInput) => {
        if (batch) {
          await batchesState.update(batch.id, input);
          toast.success("Batch updated");
        } else {
          await batchesState.create(input);
          toast.success("Batch created");
        }
        setEditing(null);
      }}
    />;
  }

  return overview;
}
