import { CheckCircle2, CircleAlert, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModelSelect } from "@/components/ui/model-select";
import { Switch } from "@/components/ui/switch";
import { FieldHelp } from "@/components/ui/field-help";
import type { ProviderCatalogGroup } from "@/lib/clients/provider-settings-client";
import {
  fetchYoutubeGeminiModels,
  fetchYoutubeSettings,
  saveYoutubeSettings,
  validateYoutubeGemini,
  type YoutubeSettingsSnapshot,
  type YoutubeGeminiModelOption,
} from "@/lib/clients/youtube-settings-client";

interface Draft {
  apiKey: string;
  clearApiKey: boolean;
  model: string;
  dailyLimit: string;
  confirmationThreshold: string;
}

export function YoutubeVideoAnalysisSettings() {
  const [snapshot, setSnapshot] = useState<YoutubeSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<"load" | "save" | "retention" | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [models, setModels] = useState<YoutubeGeminiModelOption[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchYoutubeSettings()
      .then((next) => {
        if (!active) return;
        setSnapshot(next);
        setDraft(draftFrom(next));
      })
      .catch((loadError: unknown) => {
        if (active) setError(messageFrom(loadError));
      })
      .finally(() => {
        if (active) setBusy(null);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!snapshot?.geminiApiKeyConfigured) return;
    let active = true;
    void fetchYoutubeGeminiModels()
      .then((result) => {
        if (active) {
          setModels(Array.isArray(result.models) ? result.models : []);
          setModelsError(null);
        }
      })
      .catch(() => {
        if (active) setModelsError("Available models could not be loaded. The current selection is still available.");
      })
    return () => { active = false; };
  }, [snapshot?.geminiApiKeyConfigured]);

  const readOnly = snapshot?.geminiSource === "environment";
  const dailyLimit = Number(draft?.dailyLimit);
  const threshold = Number(draft?.confirmationThreshold);
  const invalidDailyLimit = !Number.isSafeInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 100_000;
  const invalidThreshold = !Number.isSafeInteger(threshold) || threshold < 1 || threshold > 100_000;
  const disabled = Boolean(busy || !draft || !snapshot || readOnly);
  const geminiModelGroups = toGeminiModelGroups(models, draft?.model);

  function update(values: Partial<Draft>): void {
    setDraft((current) => current ? { ...current, ...values } : current);
    setSaved(false);
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!snapshot || !draft || disabled || invalidDailyLimit || invalidThreshold) return;
    setBusy("save");
    setSaved(false);
    setError(null);
    try {
      if (draft.apiKey) {
        await validateYoutubeGemini({ apiKey: draft.apiKey, model: draft.model });
      }
      const next = await saveYoutubeSettings({
        proxyEnabled: snapshot.proxyEnabled,
        credentialMode: snapshot.credentialMode,
        proxyHost: snapshot.proxyHost,
        proxyPort: snapshot.proxyPort,
        countries: snapshot.countries,
        username: snapshot.username,
        ...(draft.apiKey ? { geminiApiKey: draft.apiKey } : {}),
        ...(draft.clearApiKey ? { clearGeminiApiKey: true } : {}),
        geminiModel: draft.model,
        geminiDailyVideoMinutesLimit: dailyLimit,
        geminiConfirmationThresholdMinutes: threshold,
      });
      const validated = next.geminiApiKeyConfigured
        ? await validateYoutubeGemini() as YoutubeSettingsSnapshot
        : next;
      setSnapshot(validated);
      setDraft(draftFrom(validated));
      setSaved(true);
      if (validated.geminiStatus === "error") {
        setError(validated.geminiError ?? "Gemini API key validation failed.");
      }
    } catch (saveError) {
      setError(messageFrom(saveError));
    } finally {
      setBusy(null);
    }
  }

  async function handleRetentionChange(deleteVideosAfterInfoExtraction: boolean): Promise<void> {
    if (!snapshot || busy) return;
    setBusy("retention");
    setError(null);
    setSaved(false);
    try {
      const next = await saveYoutubeSettings({
        proxyEnabled: snapshot.proxyEnabled,
        credentialMode: snapshot.credentialMode,
        proxyHost: snapshot.proxyHost,
        proxyPort: snapshot.proxyPort,
        countries: snapshot.countries,
        username: snapshot.username,
        deleteVideosAfterInfoExtraction,
      });
      setSnapshot(next);
      setSaved(true);
    } catch (saveError) {
      setError(messageFrom(saveError));
    } finally {
      setBusy(null);
    }
  }

  if (!draft && busy === "load") {
    return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading YouTube video analysis settings…</p>;
  }

  if (!draft || !snapshot) {
    return <p role="alert" className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><CircleAlert className="size-4" />{error ?? "YouTube video analysis settings could not be loaded."}</p>;
  }

  return (
    <section className="space-y-5 rounded-xl border border-border/70 bg-muted/20 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">YouTube video analysis</h3>
          <p className="mt-1 text-sm text-muted-foreground">Gemini analyzes public YouTube videos for important steps and timestamps. Transcript-based analysis remains the fallback.</p>
        </div>
        <Badge variant="secondary">{statusLabel(snapshot)}</Badge>
      </div>

      {error ? <p role="alert" className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><CircleAlert className="size-4" />{error}</p> : null}

      <form className="space-y-5" onSubmit={(event) => void handleSubmit(event)}>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="youtube-gemini-api-key">Google AI Studio API key</label>
          <Input
            id="youtube-gemini-api-key"
            type="password"
            autoComplete="new-password"
            value={draft.apiKey}
            disabled={disabled}
            placeholder={draft.clearApiKey ? "Saved key will be cleared" : snapshot.geminiApiKeyConfigured ? "Saved; leave blank to keep" : "Paste your Gemini API key"}
            onChange={(event) => update({ apiKey: event.target.value, clearApiKey: false })}
          />
          {readOnly ? <p className="text-xs text-muted-foreground">The key comes from GEMINI_API_KEY. The saved model and limits remain active and all Gemini controls are read-only here.</p> : null}
        </div>

        <div data-testid="youtube-gemini-controls" className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="youtube-gemini-model">Gemini model</label>
            <ModelSelect
              id="youtube-gemini-model"
              aria-label="Gemini model"
              provider="youtube-gemini"
              model={draft.model}
              groups={geminiModelGroups}
              disabled={disabled}
              placeholder="Select Gemini model"
              dialogTitle="Select Gemini model"
              dialogDescription="Search stable Gemini models suitable for YouTube video understanding."
              searchPlaceholder="Search Gemini models..."
              emptyMessage="No compatible Gemini video-analysis models are available."
              onChange={(choice) => update({ model: choice.model })}
            />
            {modelsError ? <p className="text-xs text-amber-600">{modelsError}</p> : null}
          </div>
          <NumberField
            id="youtube-gemini-daily-limit"
            label="Rolling 24-hour video limit"
            helpLabel="About rolling 24-hour video limit"
            helpText="This is an app confirmation guardrail, not a Google API quota. When analyzed video minutes within the previous rolling 24 hours would exceed this value, the app asks before continuing."
            value={draft.dailyLimit}
            invalid={invalidDailyLimit}
            disabled={disabled}
            onChange={(value) => update({ dailyLimit: value })}
          />
          <NumberField
            id="youtube-gemini-confirmation-threshold"
            label="Long-video confirmation threshold"
            helpLabel="About long-video confirmation threshold"
            helpText="A single video longer than this value requires confirmation before Gemini analysis, so you can review the estimated cost and choose whether to continue."
            value={draft.confirmationThreshold}
            invalid={invalidThreshold}
            disabled={disabled}
            onChange={(value) => update({ confirmationThreshold: value })}
          />
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border border-border/70 p-4">
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="youtube-delete-videos-after-extraction">Delete videos after info extraction</label>
            <p className="text-xs text-muted-foreground">Off by default. Retained audio-and-video files are available as supporting downloads and consume workspace storage.</p>
          </div>
          <Switch
            id="youtube-delete-videos-after-extraction"
            aria-label="Delete videos after info extraction"
            checked={snapshot.deleteVideosAfterInfoExtraction}
            disabled={Boolean(busy)}
            onCheckedChange={(checked) => void handleRetentionChange(checked)}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={disabled || invalidDailyLimit || invalidThreshold}>
            {busy === "save" ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            Save and validate
          </Button>
          {snapshot.geminiApiKeyConfigured && !draft.clearApiKey && !readOnly ? (
            <Button type="button" variant="outline" disabled={disabled} onClick={() => update({ apiKey: "", clearApiKey: true })}><Trash2 />Clear saved key</Button>
          ) : null}
          {draft.clearApiKey ? <span className="text-xs text-muted-foreground">Save to remove the configured key.</span> : null}
          {saved && !error ? <span className="flex items-center gap-1 text-sm text-emerald-600"><CheckCircle2 className="size-4" />Saved</span> : null}
        </div>
      </form>
    </section>
  );
}

function NumberField(props: {
  id: string;
  label: string;
  helpLabel: string;
  helpText: string;
  value: string;
  invalid: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return <div className="space-y-2"><div className="flex items-center gap-1"><label className="text-sm font-medium" htmlFor={props.id}>{props.label}</label><FieldHelp label={props.helpLabel}>{props.helpText}</FieldHelp></div><div className="flex items-center gap-2"><Input id={props.id} className="w-28" type="number" min={1} max={100_000} step={1} value={props.value} disabled={props.disabled} aria-invalid={props.invalid} onChange={(event) => props.onChange(event.target.value)} /><span className="text-sm text-muted-foreground">minutes</span></div></div>;
}

function toGeminiModelGroups(
  models: YoutubeGeminiModelOption[],
  currentModel?: string,
): ProviderCatalogGroup[] {
  const availableModels = currentModel && !models.some((model) => model.id === currentModel)
    ? [{ id: currentModel, displayName: currentModel }, ...models]
    : models;
  return [{
    provider: "youtube-gemini",
    name: "Google AI Studio",
    icon: "gemini",
    source: "connection",
    models: availableModels.map((model) => ({
      id: model.id,
      name: model.displayName,
      enabled: true,
      icon: "gemini",
      capabilities: ["chat"],
    })),
  }];
}

function draftFrom(snapshot: YoutubeSettingsSnapshot): Draft {
  return {
    apiKey: "",
    clearApiKey: false,
    model: snapshot.geminiModel,
    dailyLimit: String(snapshot.geminiDailyVideoMinutesLimit),
    confirmationThreshold: String(snapshot.geminiConfirmationThresholdMinutes),
  };
}

function statusLabel(snapshot: YoutubeSettingsSnapshot): string {
  if (snapshot.geminiStatus === "connected") return "Connected";
  if (snapshot.geminiStatus === "error") return "Connection error";
  return snapshot.geminiApiKeyConfigured ? "Configured" : "Not configured";
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
