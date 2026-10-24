import { CheckCircle2, CircleAlert, Loader2, Save } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  fetchSchedulingSettings,
  saveSchedulingSettings,
  SchedulingSettingsClientError,
  type SchedulingSettingsSnapshot,
} from "@/lib/clients/scheduling-settings-client";

const DEFAULT_MINIMUM = 1;
const DEFAULT_MAXIMUM = 64;
const FIELD_DESCRIPTION_ID = "maximum-concurrent-tasks-description";
const FIELD_ERROR_ID = "maximum-concurrent-tasks-error";
const MANAGED_DESCRIPTION_ID = "maximum-concurrent-tasks-managed";

export function SchedulingQueueSettings({
  onSaved,
}: {
  onSaved?: (() => void | Promise<void>) | undefined;
}) {
  const [snapshot, setSnapshot] =
    useState<SchedulingSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchSchedulingSettings()
      .then((nextSnapshot) => {
        if (!active) return;
        setSnapshot(nextSnapshot);
        setDraft(String(nextSnapshot.maximumConcurrentTasks));
        setError(null);
      })
      .catch((loadError) => {
        if (!active) return;
        setError(schedulingSettingsErrorMessage(loadError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const minimum = snapshot?.constraints.minimum ?? DEFAULT_MINIMUM;
  const maximum = snapshot?.constraints.maximum ?? DEFAULT_MAXIMUM;
  const dirty =
    snapshot !== null && draft !== String(snapshot.maximumConcurrentTasks);
  const validationError =
    snapshot && dirty ? validateMaximumConcurrentTasks(draft, minimum, maximum) : null;
  const managed = snapshot?.editable === false;
  const canSave = Boolean(
    snapshot?.editable && dirty && !validationError && !saving,
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSave) return;

    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const nextSnapshot = await saveSchedulingSettings(Number(draft));
      setSnapshot(nextSnapshot);
      setDraft(String(nextSnapshot.maximumConcurrentTasks));
      setSaved(true);
      void onSaved?.();
    } catch (saveError) {
      setError(schedulingSettingsErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  const describedBy = [
    FIELD_DESCRIPTION_ID,
    ...(validationError ? [FIELD_ERROR_ID] : []),
    ...(managed ? [MANAGED_DESCRIPTION_ID] : []),
  ].join(" ");

  return (
    <section className="space-y-5 rounded-xl border border-border/70 bg-muted/20 p-5">
      <div>
        <h3 className="text-lg font-semibold">Execution capacity</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Control how many top-level tasks or workflows this workspace runs at
          the same time.
        </p>
      </div>

      <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
        <div className="space-y-2">
          <label
            className="text-sm font-medium"
            htmlFor="maximum-concurrent-tasks"
          >
            Maximum concurrent tasks or workflows
          </label>
          <div className="flex max-w-sm items-center gap-3">
            <Input
              id="maximum-concurrent-tasks"
              className="w-28"
              type="number"
              min={minimum}
              max={maximum}
              step={1}
              inputMode="numeric"
              value={draft}
              disabled={loading || saving || !snapshot || managed}
              aria-describedby={describedBy}
              aria-invalid={Boolean(validationError)}
              onChange={(event) => {
                setDraft(event.target.value);
                setSaved(false);
                setError(null);
              }}
            />
            <Button type="submit" disabled={!canSave}>
              {saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
          <p
            id={FIELD_DESCRIPTION_ID}
            className="max-w-2xl text-sm text-muted-foreground"
          >
            Each top-level task or workflow uses one slot. Excess work waits in
            FIFO order. Nested workflow work does not consume another top-level
            slot.
          </p>
        </div>

        {managed ? (
          <p
            id={MANAGED_DESCRIPTION_ID}
            className="max-w-2xl text-sm text-muted-foreground"
          >
            This value is managed by the TEAM_RUNTIME_MAX_CONCURRENT_TASKS
            environment variable. Change that variable and restart the app to
            update the effective limit.
          </p>
        ) : null}

        <div aria-live="polite" className="min-h-5 text-sm">
          {loading ? (
            <p className="flex items-center gap-2 text-muted-foreground" role="status">
              <Loader2 className="size-4 animate-spin" />
              Loading scheduling settings...
            </p>
          ) : validationError ? (
            <p
              id={FIELD_ERROR_ID}
              className="flex items-center gap-2 text-destructive"
              role="alert"
            >
              <CircleAlert className="size-4" />
              {validationError}
            </p>
          ) : error ? (
            <p className="flex items-center gap-2 text-destructive" role="alert">
              <CircleAlert className="size-4" />
              {error}
            </p>
          ) : saving ? (
            <p className="text-muted-foreground" role="status">
              Saving and applying the new limit...
            </p>
          ) : saved ? (
            <p className="flex items-center gap-2 text-emerald-600" role="status">
              <CheckCircle2 className="size-4" />
              Saved. The new limit is active.
            </p>
          ) : dirty ? (
            <p className="text-muted-foreground" role="status">
              Unsaved changes.
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}

function validateMaximumConcurrentTasks(
  value: string,
  minimum: number,
  maximum: number,
): string | null {
  if (!/^\d+$/.test(value) || !Number.isInteger(Number(value))) {
    return `Enter a whole number between ${minimum} and ${maximum}.`;
  }
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    return `Enter a whole number between ${minimum} and ${maximum}.`;
  }
  return null;
}

function schedulingSettingsErrorMessage(error: unknown): string {
  if (error instanceof SchedulingSettingsClientError) {
    switch (error.code) {
      case "invalid_request":
        return "The limit was rejected. Enter a whole number from 1 through 64.";
      case "managed_by_environment":
        return "This limit is managed by TEAM_RUNTIME_MAX_CONCURRENT_TASKS.";
      case "task_admission_recovering":
        return "Task admission is recovering. Try saving again shortly.";
      case "scheduling_unavailable":
        return "Scheduling settings are unavailable in this runtime.";
      case "settings_persistence_failed":
        return "The limit could not be saved. The previous limit is still active.";
      case "method_not_allowed":
      case "request_failed":
        return "Scheduling settings could not be loaded or saved.";
    }
  }
  return error instanceof Error
    ? error.message
    : "Scheduling settings could not be loaded or saved.";
}
