import { CheckCircle2, CircleAlert, Loader2, Save, ShieldCheck } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  fetchYoutubeSettings,
  saveYoutubeSettings,
  validateYoutubeProxy,
  type YoutubeProxyCredentialMode,
  type YoutubeSettingsSnapshot,
} from "@/lib/clients/youtube-settings-client";

interface Draft {
  proxyEnabled: boolean;
  credentialMode: YoutubeProxyCredentialMode;
  proxyHost: string;
  proxyPort: string;
  countries: string;
  username: string;
  apiToken: string;
  password: string;
  clearApiToken: boolean;
  clearPassword: boolean;
}

export function WebshareSettings() {
  const [snapshot, setSnapshot] = useState<YoutubeSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<"load" | "save" | "validate" | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

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

  const readOnly = snapshot?.source === "environment";
  const port = Number(draft?.proxyPort);
  const invalidPort = Boolean(draft && (!Number.isSafeInteger(port) || port < 1 || port > 65_535));
  const disabled = Boolean(busy || !draft || readOnly);
  const dirty = Boolean(draft && snapshot && hasUnsavedChanges(draft, snapshot));

  function update(values: Partial<Draft>): void {
    setDraft((current) => current ? { ...current, ...values } : current);
    setSaved(false);
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!draft || disabled || invalidPort) return;
    setBusy("save");
    setSaved(false);
    setError(null);
    try {
      const next = await saveYoutubeSettings({
        proxyEnabled: draft.proxyEnabled,
        credentialMode: draft.credentialMode,
        proxyHost: draft.proxyHost,
        proxyPort: port,
        countries: draft.countries.split(",").map((value) => value.trim()).filter(Boolean),
        username: draft.username,
        ...(draft.apiToken ? { apiToken: draft.apiToken } : {}),
        ...(draft.password ? { password: draft.password } : {}),
        ...(draft.clearApiToken ? { clearApiToken: true } : {}),
        ...(draft.clearPassword ? { clearPassword: true } : {}),
      });
      setSnapshot(next);
      setDraft(draftFrom(next));
      setSaved(true);
    } catch (saveError) {
      setError(messageFrom(saveError));
    } finally {
      setBusy(null);
    }
  }

  async function handleValidate(): Promise<void> {
    setBusy("validate");
    setError(null);
    try {
      const next = await validateYoutubeProxy();
      setSnapshot(next);
      if (next.proxyStatus === "error") setError(next.error ?? "Webshare validation failed.");
    } catch (validationError) {
      setError(messageFrom(validationError));
    } finally {
      setBusy(null);
    }
  }

  async function handleReload(): Promise<void> {
    setBusy("load");
    setError(null);
    try {
      const next = await fetchYoutubeSettings();
      setSnapshot(next);
      setDraft(draftFrom(next));
    } catch (loadError) {
      setError(messageFrom(loadError));
    } finally {
      setBusy(null);
    }
  }

  if (!draft && busy === "load") {
    return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading Webshare settings…</p>;
  }

  if (!draft) {
    return (
      <div className="space-y-3">
        <p role="alert" className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><CircleAlert className="size-4" />{error ?? "Webshare settings could not be loaded."}</p>
        <Button type="button" variant="outline" onClick={() => void handleReload()}>Retry loading settings</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error ? <p role="alert" className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><CircleAlert className="size-4" />{error}</p> : null}

      <section className="space-y-5 rounded-xl border border-border/70 bg-muted/20 p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold">Webshare residential proxy</h3>
            <p className="mt-1 text-sm text-muted-foreground">Video transcripts and web research both start directly. Webshare is an optional retry when a source denies that first read.</p>
          </div>
          <Badge variant="secondary">{snapshot?.proxyStatus ?? "unverified"}</Badge>
        </div>
        <label className="flex items-center gap-3 text-sm font-medium">
          <Switch checked={draft?.proxyEnabled ?? false} disabled={disabled} onCheckedChange={(proxyEnabled) => update({ proxyEnabled })} />
          Use Webshare proxy
        </label>
        {readOnly ? <p className="text-xs text-muted-foreground">These settings come from environment variables and are read-only here.</p> : null}
      </section>

      <form className="space-y-5 rounded-xl border border-border/70 bg-muted/20 p-5" onSubmit={(event) => void handleSubmit(event)}>
        <div>
          <h3 className="text-lg font-semibold">Webshare connection</h3>
          <p className="mt-1 text-sm text-muted-foreground">Credentials are encrypted by the desktop app and are never passed to agents.</p>
        </div>
        <div className="flex gap-2" role="group" aria-label="Credential mode">
          {(["username-password", "api-token"] as const).map((mode) => (
            <Button key={mode} type="button" variant={draft?.credentialMode === mode ? "default" : "outline"} disabled={disabled} aria-pressed={draft?.credentialMode === mode} onClick={() => update({ credentialMode: mode })}>
              {mode === "username-password" ? "Username and password" : "API token"}
            </Button>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Proxy host" id="webshare-proxy-host"><Input id="webshare-proxy-host" value={draft?.proxyHost ?? ""} disabled={disabled} onChange={(event) => update({ proxyHost: event.target.value })} /></Field>
          <Field label="Proxy port" id="webshare-proxy-port"><Input id="webshare-proxy-port" type="number" min={1} max={65_535} value={draft?.proxyPort ?? ""} disabled={disabled} aria-invalid={invalidPort} onChange={(event) => update({ proxyPort: event.target.value })} /></Field>
          <Field label="Country codes" id="webshare-proxy-countries"><Input id="webshare-proxy-countries" value={draft?.countries ?? ""} disabled={disabled} placeholder="us, gb" onChange={(event) => update({ countries: event.target.value })} /></Field>
          {draft?.credentialMode === "username-password" ? (
            <>
              <Field label="Username" id="webshare-proxy-username"><Input id="webshare-proxy-username" value={draft.username} disabled={disabled} onChange={(event) => update({ username: event.target.value })} /></Field>
              <Field label="Password" id="webshare-proxy-password">
                <div className="space-y-2">
                  <Input id="webshare-proxy-password" type="password" value={draft.password} disabled={disabled} placeholder={draft.clearPassword ? "Saved password will be cleared" : snapshot?.passwordConfigured ? "Saved; leave blank to keep" : "Required when enabled"} autoComplete="new-password" onChange={(event) => update({ password: event.target.value, clearPassword: false })} />
                  {snapshot?.passwordConfigured && !draft.clearPassword ? <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => update({ password: "", clearPassword: true })}>Clear saved password</Button> : null}
                </div>
              </Field>
            </>
          ) : (
            <Field label="API token" id="webshare-proxy-api-token">
              <div className="space-y-2">
                <Input id="webshare-proxy-api-token" type="password" value={draft.apiToken} disabled={disabled} placeholder={draft.clearApiToken ? "Saved token will be cleared" : snapshot?.apiTokenConfigured ? "Saved; leave blank to keep" : "Required when enabled"} autoComplete="new-password" onChange={(event) => update({ apiToken: event.target.value, clearApiToken: false })} />
                {snapshot?.apiTokenConfigured && !draft.clearApiToken ? <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => update({ apiToken: "", clearApiToken: true })}>Clear saved API token</Button> : null}
              </div>
            </Field>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={disabled || invalidPort}>{busy === "save" ? <Loader2 className="animate-spin" /> : <Save />}Save settings</Button>
          <Button type="button" variant="outline" disabled={Boolean(busy) || !snapshot?.proxyEnabled || dirty} title={dirty ? "Save changes before testing the connection." : undefined} onClick={() => void handleValidate()}>{busy === "validate" ? <Loader2 className="animate-spin" /> : <ShieldCheck />}Test connection</Button>
          {dirty && snapshot?.proxyEnabled ? <span className="text-xs text-muted-foreground">Save changes before testing.</span> : null}
          {saved ? <span className="flex items-center gap-1 text-sm text-emerald-600"><CheckCircle2 className="size-4" />Saved</span> : null}
        </div>
      </form>
    </div>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return <div className="space-y-2"><label className="text-sm font-medium" htmlFor={id}>{label}</label>{children}</div>;
}

function draftFrom(snapshot: YoutubeSettingsSnapshot): Draft {
  return {
    proxyEnabled: snapshot.proxyEnabled,
    credentialMode: snapshot.credentialMode,
    proxyHost: snapshot.proxyHost,
    proxyPort: String(snapshot.proxyPort),
    countries: snapshot.countries.join(", "),
    username: snapshot.username,
    apiToken: "",
    password: "",
    clearApiToken: false,
    clearPassword: false,
  };
}

function hasUnsavedChanges(draft: Draft, snapshot: YoutubeSettingsSnapshot): boolean {
  return draft.proxyEnabled !== snapshot.proxyEnabled ||
    draft.credentialMode !== snapshot.credentialMode ||
    draft.proxyHost !== snapshot.proxyHost ||
    Number(draft.proxyPort) !== snapshot.proxyPort ||
    draft.countries.split(",").map((value) => value.trim()).filter(Boolean).join(",") !== snapshot.countries.join(",") ||
    draft.username !== snapshot.username ||
    Boolean(draft.apiToken || draft.password || draft.clearApiToken || draft.clearPassword);
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
