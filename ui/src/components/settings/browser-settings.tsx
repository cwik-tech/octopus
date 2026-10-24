import { CircleAlert, ExternalLink, Loader2, Octagon, Play } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  fetchBrowserSettings,
  openBrowserProfile,
  saveBrowserMode,
  stopManagedBrowser,
  type BrowserMode,
  type BrowserSettingsSnapshot,
} from "@/lib/clients/browser-settings-client";

export function BrowserModeControl({
  mode,
  disabled,
  ariaLabel,
  onModeChange,
}: {
  mode?: BrowserMode | undefined;
  disabled: boolean;
  ariaLabel: string;
  onModeChange: (mode: BrowserMode) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={ariaLabel}>
      {(["headed", "headless"] as const).map((candidate) => (
        <Button
          key={candidate}
          type="button"
          variant={mode === candidate ? "default" : "outline"}
          disabled={disabled}
          aria-pressed={mode === candidate}
          onClick={() => onModeChange(candidate)}
        >
          {candidate === "headed" ? "Headed" : "Headless"}
        </Button>
      ))}
    </div>
  );
}

export function BrowserSettings() {
  const [snapshot, setSnapshot] = useState<BrowserSettingsSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>("load");
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (
    key: string,
    action: () => Promise<BrowserSettingsSnapshot>,
  ) => {
    setBusy(key);
    setError(null);
    try {
      setSnapshot(await action());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchBrowserSettings()
      .then((nextSnapshot) => {
        if (!cancelled) setSnapshot(nextSnapshot);
      })
      .catch((requestError: unknown) => {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : String(requestError));
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!snapshot && busy === "load") {
    return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Detecting Chrome…</p>;
  }

  return (
    <div className="space-y-6">
      {error ? (
        <p role="alert" className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <CircleAlert className="size-4" />{error}
        </p>
      ) : null}
      <section className="space-y-5 rounded-xl border border-border/70 bg-muted/20 p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">Managed Chrome</h3>
            <p className="mt-1 text-sm text-muted-foreground">Public browsing uses isolated sessions. Restricted agents can reuse this optional authenticated profile.</p>
          </div>
          <Badge variant="secondary">{snapshot?.status ?? "unknown"}</Badge>
        </div>
        <dl className="grid gap-2 text-xs sm:grid-cols-[9rem_1fr]">
          <dt className="text-muted-foreground">Chrome</dt><dd className="break-all font-mono">{snapshot?.executablePath ?? "Not detected"}</dd>
          <dt className="text-muted-foreground">Profile</dt><dd className="break-all font-mono">{snapshot?.profilePath ?? "Unavailable"}</dd>
          <dt className="text-muted-foreground">Open pages</dt><dd>{snapshot?.pageCount ?? 0}</dd>
        </dl>
        {snapshot?.error ? <p className="text-xs text-destructive">{snapshot.error}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={Boolean(busy) || snapshot?.status === "unavailable"}
            onClick={() => void run("open", openBrowserProfile)}
          >
            {busy === "open" ? <Loader2 className="animate-spin" /> : snapshot?.status === "running" ? <ExternalLink /> : <Play />}
            Open authenticated profile
          </Button>
          <Button
            variant="outline"
            disabled={Boolean(busy) || snapshot?.status !== "running"}
            onClick={() => void run("stop", stopManagedBrowser)}
          >
            <Octagon />Stop browser
          </Button>
        </div>
      </section>

      <section className="space-y-5 rounded-xl border border-border/70 bg-muted/20 p-5">
        <div>
          <h3 className="text-lg font-semibold">Browser mode</h3>
          <p className="mt-1 text-sm text-muted-foreground">Headed is the default for visible operation. Headless mode uses the same restricted-site profile. Opening the authenticated profile uses a temporary visible window without changing the mode research agents use.</p>
        </div>
        <BrowserModeControl
          mode={snapshot?.mode}
          disabled={Boolean(busy)}
          ariaLabel="Browser mode"
          onModeChange={(mode) => void run(mode, () => saveBrowserMode(mode))}
        />
      </section>

    </div>
  );
}
