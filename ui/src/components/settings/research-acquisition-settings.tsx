import { CheckCircle2, CircleAlert, Loader2, Save } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { AcquisitionSettings } from "@/components/settings/acquisition-settings";
import { BrowserSettings } from "@/components/settings/browser-settings";
import { WebshareSettings } from "@/components/settings/webshare-settings";
import { YoutubeVideoAnalysisSettings } from "@/components/settings/youtube-video-analysis-settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DeepResearchSettingsClientError,
  fetchDeepResearchSettings,
  saveDeepResearchSettings,
  type DeepResearchSettingsSnapshot,
} from "@/lib/clients/deep-research-settings-client";

const DEFAULT_DURATION_MINIMUM = 5;
const DEFAULT_DURATION_MAXIMUM = 120;
const DEFAULT_AGENT_MINIMUM = 1;
const DEFAULT_AGENT_MAXIMUM = 8;
const DURATION_DESCRIPTION_ID = "deep-research-duration-description";
const DURATION_ERROR_ID = "deep-research-duration-error";
const AGENTS_DESCRIPTION_ID = "deep-research-agents-description";
const AGENTS_ERROR_ID = "deep-research-agents-error";
const READ_ONLY_DESCRIPTION_ID = "deep-research-read-only";

export function ResearchAcquisitionSettings() {
  const [snapshot, setSnapshot] =
    useState<DeepResearchSettingsSnapshot | null>(null);
  const [durationDraft, setDurationDraft] = useState("");
  const [agentsDraft, setAgentsDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchDeepResearchSettings()
      .then((nextSnapshot) => {
        if (!active) return;
        setSnapshot(nextSnapshot);
        setDurationDraft(String(nextSnapshot.maxDurationMinutes));
        setAgentsDraft(String(nextSnapshot.maxResearcherAgents));
        setError(null);
      })
      .catch((loadError) => {
        if (!active) return;
        setError(deepResearchSettingsErrorMessage(loadError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const durationMinimum =
    snapshot?.constraints.maxDurationMinutes.minimum ?? DEFAULT_DURATION_MINIMUM;
  const durationMaximum =
    snapshot?.constraints.maxDurationMinutes.maximum ?? DEFAULT_DURATION_MAXIMUM;
  const agentsMinimum =
    snapshot?.constraints.maxResearcherAgents.minimum ?? DEFAULT_AGENT_MINIMUM;
  const agentsMaximum =
    snapshot?.constraints.maxResearcherAgents.maximum ?? DEFAULT_AGENT_MAXIMUM;
  const dirty = Boolean(
    snapshot &&
      (durationDraft !== String(snapshot.maxDurationMinutes) ||
        agentsDraft !== String(snapshot.maxResearcherAgents)),
  );
  const durationValidationError = snapshot
    ? validateWholeNumber(durationDraft, durationMinimum, durationMaximum)
    : null;
  const agentsValidationError = snapshot
    ? validateWholeNumber(agentsDraft, agentsMinimum, agentsMaximum)
    : null;
  const readOnly = snapshot?.editable === false;
  const canSave = Boolean(
    snapshot?.editable &&
      dirty &&
      !durationValidationError &&
      !agentsValidationError &&
      !saving,
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSave) return;

    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const nextSnapshot = await saveDeepResearchSettings({
        maxDurationMinutes: Number(durationDraft),
        maxResearcherAgents: Number(agentsDraft),
      });
      setSnapshot(nextSnapshot);
      setDurationDraft(String(nextSnapshot.maxDurationMinutes));
      setAgentsDraft(String(nextSnapshot.maxResearcherAgents));
      setSaved(true);
    } catch (saveError) {
      setError(deepResearchSettingsErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  const durationDescribedBy = [
    DURATION_DESCRIPTION_ID,
    ...(durationValidationError ? [DURATION_ERROR_ID] : []),
    ...(readOnly ? [READ_ONLY_DESCRIPTION_ID] : []),
  ].join(" ");
  const agentsDescribedBy = [
    AGENTS_DESCRIPTION_ID,
    ...(agentsValidationError ? [AGENTS_ERROR_ID] : []),
    ...(readOnly ? [READ_ONLY_DESCRIPTION_ID] : []),
  ].join(" ");

  return (
    <div
      className="max-w-3xl space-y-6 pb-2"
      data-testid="research-acquisition-settings"
    >
      <section className="space-y-5 rounded-xl border border-border/70 bg-muted/20 p-5">
      <div>
        <h3 className="text-lg font-semibold">Research limits</h3>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Set workspace ceilings for each Deep Research run. The approved plan
          may use fewer researchers, but it cannot exceed these limits.
        </p>
      </div>

      <form className="space-y-5" onSubmit={(event) => void handleSubmit(event)}>
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="deep-research-duration">
              Maximum research duration
            </label>
            <div className="flex items-center gap-3">
              <Input
                id="deep-research-duration"
                className="w-28"
                type="number"
                min={durationMinimum}
                max={durationMaximum}
                step={1}
                inputMode="numeric"
                value={durationDraft}
                disabled={loading || saving || !snapshot || readOnly}
                aria-describedby={durationDescribedBy}
                aria-invalid={Boolean(durationValidationError)}
                onChange={(event) => {
                  setDurationDraft(event.target.value);
                  setSaved(false);
                  setError(null);
                }}
              />
              <span className="text-sm text-muted-foreground">minutes</span>
            </div>
            <p
              id={DURATION_DESCRIPTION_ID}
              className="max-w-md text-sm text-muted-foreground"
            >
              Research acquisition, synthesis, review, and corrections stop at
              this deadline. The default is 20 minutes.
            </p>
            {durationValidationError ? (
              <p
                id={DURATION_ERROR_ID}
                className="flex items-center gap-2 text-sm text-destructive"
                role="alert"
              >
                <CircleAlert className="size-4" />
                {durationValidationError}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="deep-research-agents">
              Maximum researcher agents
            </label>
            <Input
              id="deep-research-agents"
              className="w-28"
              type="number"
              min={agentsMinimum}
              max={agentsMaximum}
              step={1}
              inputMode="numeric"
              value={agentsDraft}
              disabled={loading || saving || !snapshot || readOnly}
              aria-describedby={agentsDescribedBy}
              aria-invalid={Boolean(agentsValidationError)}
              onChange={(event) => {
                setAgentsDraft(event.target.value);
                setSaved(false);
                setError(null);
              }}
            />
            <p
              id={AGENTS_DESCRIPTION_ID}
              className="max-w-md text-sm text-muted-foreground"
            >
              This is the per-run internal researcher ceiling, separate from
              the workspace&apos;s top-level task and workflow capacity.
            </p>
            {agentsValidationError ? (
              <p
                id={AGENTS_ERROR_ID}
                className="flex items-center gap-2 text-sm text-destructive"
                role="alert"
              >
                <CircleAlert className="size-4" />
                {agentsValidationError}
              </p>
            ) : null}
          </div>
        </div>

        {readOnly ? (
          <p
            id={READ_ONLY_DESCRIPTION_ID}
            className="max-w-2xl text-sm text-muted-foreground"
          >
            These values are read-only in the current runtime.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!canSave}>
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            {saving ? "Saving..." : "Save limits"}
          </Button>

          <div aria-live="polite" className="min-h-5 text-sm">
            {loading ? (
              <p className="flex items-center gap-2 text-muted-foreground" role="status">
                <Loader2 className="size-4 animate-spin" />
                Loading Deep Research settings...
              </p>
            ) : error ? (
              <p className="flex items-center gap-2 text-destructive" role="alert">
                <CircleAlert className="size-4" />
                {error}
              </p>
            ) : saving ? (
              <p className="text-muted-foreground" role="status">
                Saving Deep Research limits...
              </p>
            ) : saved ? (
              <p className="flex items-center gap-2 text-emerald-600" role="status">
                <CheckCircle2 className="size-4" />
                Saved. New research runs will use these ceilings.
              </p>
            ) : dirty && !durationValidationError && !agentsValidationError ? (
              <p className="text-muted-foreground" role="status">
                Unsaved changes.
              </p>
            ) : null}
          </div>
        </div>
      </form>
      </section>
      <AcquisitionSettings />
      <YoutubeVideoAnalysisSettings />
      <BrowserSettings />
      <WebshareSettings />
    </div>
  );
}

function validateWholeNumber(
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

function deepResearchSettingsErrorMessage(error: unknown): string {
  if (error instanceof DeepResearchSettingsClientError) {
    switch (error.code) {
      case "invalid_request":
        return "The limits were rejected. Check both allowed ranges.";
      case "deep_research_settings_unavailable":
        return "Deep Research settings are unavailable in this runtime.";
      case "settings_persistence_failed":
        return "The limits could not be saved. The previous limits remain active.";
      case "method_not_allowed":
      case "request_failed":
        return "Deep Research settings could not be loaded or saved.";
    }
  }
  return error instanceof Error
    ? error.message
    : "Deep Research settings could not be loaded or saved.";
}
