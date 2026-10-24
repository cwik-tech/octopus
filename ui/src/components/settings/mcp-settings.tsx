import {
  CheckCircle2,
  CircleAlert,
  Globe2,
  Pencil,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { McpConnectionEditor } from "@/components/settings/mcp-connection-editor";
import {
  mcpServerDraftFromServer,
  mcpServerInputFromDraft,
  newMcpServerDraft,
  validateMcpServerDraft,
  type McpServerDraft,
} from "@/components/settings/mcp-connection-draft";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  createMcpServer,
  deleteMcpServer,
  fetchMcpServers,
  McpSettingsClientError,
  reconnectMcpServer,
  setMcpServerEnabled,
  updateMcpServer,
  validateMcpServer,
  type McpServerView,
} from "@/lib/clients/mcp-settings-client";
import { cn } from "@/lib/utils/utils";

export function McpSettings() {
  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [draft, setDraft] = useState<McpServerDraft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchMcpServers()
      .then((nextServers) => {
        if (!active) return;
        setServers(nextServers);
        setError(null);
      })
      .catch((loadError) => {
        if (!active) return;
        setError(errorMessage(loadError));
      });
    return () => {
      active = false;
    };
  }, []);

  async function refreshServers(): Promise<void> {
    setServers(await fetchMcpServers());
  }

  function openDraft(nextDraft: McpServerDraft): void {
    setDraft(nextDraft);
    setError(null);
    setNotice(null);
    setConfirmDeleteId(null);
  }

  async function handleSaveAndValidate(): Promise<void> {
    if (!draft) return;
    const validationError = validateMcpServerDraft(draft);
    if (validationError) {
      setError(validationError);
      setNotice(null);
      return;
    }

    setBusy("save");
    setError(null);
    setNotice(null);
    let saved: McpServerView | null = null;
    try {
      const input = mcpServerInputFromDraft(draft);
      saved = draft.id
        ? await updateMcpServer(draft.id, input)
        : await createMcpServer(input);

      // Closing the editor immediately ensures submitted secret values cannot
      // reappear while validation is running or after it fails.
      setDraft(null);
      const validated = await validateMcpServer(saved.id, {
        ...(draft.transportType === "stdio"
          ? { stdioTrustAcknowledged: draft.stdioTrustAcknowledged }
          : {}),
      });
      const status = displayStatus(validated);
      if (status === "connected") {
        setNotice(`${validated.name} saved and connected.`);
      } else if (status === "authorization-required") {
        setNotice(`${validated.name} saved. Authorization is required.`);
      } else {
        setError(validated.statusMessage || `${validated.name} could not connect.`);
      }
      await refreshServers();
    } catch (saveError) {
      if (saved) setDraft(null);
      const failedServer = serverFromError(saveError);
      if (failedServer && displayStatus(failedServer) === "authorization-required") {
        setError(null);
        setNotice(`${failedServer.name} saved. Authorization is required.`);
      } else {
        setNotice(null);
        setError(errorMessage(saveError));
      }
      await refreshServers().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  }

  async function handleConnectionAction(server: McpServerView): Promise<void> {
    const reconnecting = server.status === "connected";
    setBusy(`${reconnecting ? "reconnect" : "validate"}:${server.id}`);
    setError(null);
    setNotice(null);
    try {
      const result = reconnecting
        ? await reconnectMcpServer(server.id)
        : await validateMcpServer(server.id);
      const status = displayStatus(result);
      if (status === "connected") {
        setNotice(`${result.name} connected.`);
      } else if (status === "authorization-required") {
        setNotice(`${result.name} requires authorization.`);
      } else {
        setError(result.statusMessage || `${result.name} could not connect.`);
      }
      await refreshServers();
    } catch (actionError) {
      const failedServer = serverFromError(actionError);
      if (failedServer && displayStatus(failedServer) === "authorization-required") {
        setError(null);
        setNotice(`${failedServer.name} requires authorization.`);
      } else {
        setNotice(null);
        setError(errorMessage(actionError));
      }
      await refreshServers().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  }

  async function handleToggle(server: McpServerView, enabled: boolean): Promise<void> {
    setBusy(`toggle:${server.id}`);
    setError(null);
    setNotice(null);
    try {
      if (!enabled) {
        await setMcpServerEnabled(server.id, false);
        setNotice(`${server.name} disabled.`);
      } else {
        const validated = await setMcpServerEnabled(server.id, true);
        const status = displayStatus(validated);
        if (status === "connected") {
          setNotice(`${validated.name} enabled and connected.`);
        } else if (status === "authorization-required") {
          setNotice(`${validated.name} enabled. Authorization is required.`);
        } else {
          setError(validated.statusMessage || `${validated.name} could not connect.`);
        }
      }
      await refreshServers();
    } catch (toggleError) {
      const failedServer = serverFromError(toggleError);
      if (failedServer && displayStatus(failedServer) === "authorization-required") {
        setError(null);
        setNotice(`${failedServer.name} enabled. Authorization is required.`);
      } else {
        setNotice(null);
        setError(errorMessage(toggleError));
      }
      await refreshServers().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete(server: McpServerView): Promise<void> {
    setBusy(`delete:${server.id}`);
    setError(null);
    setNotice(null);
    try {
      await deleteMcpServer(server.id);
      setConfirmDeleteId(null);
      setNotice(`${server.name} deleted.`);
      await refreshServers();
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      setBusy(null);
    }
  }

  const activeCount = servers?.filter(
    (server) => server.enabled && displayStatus(server) === "connected",
  ).length ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-5 text-sm text-muted-foreground">
          <span>{servers?.length ?? 0} connections</span>
          <span>{activeCount} connected</span>
        </div>
        <Button
          type="button"
          onClick={() => openDraft(newMcpServerDraft())}
          disabled={busy !== null}
        >
          <Plus />
          Add connection
        </Button>
      </div>

      {error ? (
        <StatusMessage tone="error" onDismiss={() => setError(null)}>
          {error}
        </StatusMessage>
      ) : null}
      {notice ? (
        <StatusMessage tone="success" onDismiss={() => setNotice(null)}>
          {notice}
        </StatusMessage>
      ) : null}

      {draft ? (
        <McpConnectionEditor
          draft={draft}
          busy={busy === "save"}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSubmit={() => void handleSaveAndValidate()}
        />
      ) : null}

      <section aria-labelledby="mcp-connections-heading" className="space-y-3">
        <div>
          <h3 id="mcp-connections-heading" className="text-lg font-semibold">
            Connections
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            MCP servers are available to agents only after validation and while globally enabled.
          </p>
        </div>

        <div className="overflow-hidden rounded-xl border border-border/70">
          {!servers ? (
            <div className="p-5 text-sm text-muted-foreground">Loading MCP connections...</div>
          ) : servers.length === 0 ? (
            <div className="p-5 text-sm text-muted-foreground">
              No MCP connections configured.
            </div>
          ) : (
            servers.map((server) => {
              const status = displayStatus(server);
              const actionBusy = busy?.endsWith(`:${server.id}`) ?? false;
              const checked = server.enabled;
              return (
                <article
                  key={server.id}
                  className="border-b border-border/70 p-4 last:border-b-0"
                  data-mcp-server={server.id}
                >
                  <div className="flex flex-wrap items-start gap-4">
                    <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                      {server.transport.type === "stdio"
                        ? <Terminal className="size-4" />
                        : <Globe2 className="size-4" />}
                    </div>
                    <div className="min-w-48 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="font-medium">{server.name}</h4>
                        <StatusBadge status={status} />
                      </div>
                      <p className="mt-1 break-all text-xs text-muted-foreground">
                        {transportSummary(server)}
                      </p>
                      {server.statusMessage ? (
                        <p className="mt-2 text-xs text-destructive">{server.statusMessage}</p>
                      ) : null}
                      <p className="mt-2 text-xs text-muted-foreground">
                        {capabilitySummary(server)}
                      </p>
                    </div>

                    <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                      {confirmDeleteId === server.id ? (
                        <>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            disabled={actionBusy}
                            onClick={() => void handleDelete(server)}
                          >
                            Confirm delete
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={actionBusy}
                            onClick={() => void handleConnectionAction(server)}
                          >
                            <RefreshCw className={cn(actionBusy && "animate-spin")} />
                            {server.status === "connected" ? "Reconnect" : "Validate"}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Edit ${server.name}`}
                            disabled={busy !== null}
                            onClick={() => openDraft(mcpServerDraftFromServer(server))}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="icon-sm"
                            aria-label={`Delete ${server.name}`}
                            disabled={busy !== null}
                            onClick={() => setConfirmDeleteId(server.id)}
                          >
                            <Trash2 />
                          </Button>
                        </>
                      )}
                      <Switch
                        checked={checked}
                        disabled={actionBusy || confirmDeleteId === server.id}
                        aria-label={`Enable ${server.name}`}
                        onCheckedChange={(enabled) => void handleToggle(server, enabled)}
                      />
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}

function StatusMessage({
  tone,
  onDismiss,
  children,
}: {
  tone: "error" | "success";
  onDismiss: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-lg border p-3 text-sm",
        tone === "error"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      )}
    >
      {tone === "error"
        ? <XCircle className="mt-0.5 size-4 shrink-0" />
        : <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}
      <span className="flex-1">{children}</span>
      <Button type="button" variant="ghost" size="icon-xs" aria-label="Dismiss message" onClick={onDismiss}>
        <X />
      </Button>
    </div>
  );
}

type DisplayStatus =
  | "unvalidated"
  | "connected"
  | "error"
  | "disabled"
  | "authorization-required"
  | "connecting"
  | "disconnected";

function StatusBadge({ status }: { status: DisplayStatus }) {
  const labels: Record<DisplayStatus, string> = {
    unvalidated: "Unvalidated",
    connected: "Connected",
    error: "Error",
    disabled: "Disabled",
    "authorization-required": "Authorization required",
    connecting: "Connecting",
    disconnected: "Disconnected",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        status === "connected" && "border-emerald-500/30 text-emerald-600",
        status === "error" && "border-destructive/30 text-destructive",
        status === "authorization-required" && "border-amber-500/40 text-amber-600",
        (status === "unvalidated" || status === "disabled" || status === "disconnected") &&
          "text-muted-foreground",
      )}
    >
      {status === "error" || status === "authorization-required"
        ? <CircleAlert className="size-3" />
        : null}
      {labels[status]}
    </span>
  );
}

function displayStatus(server: McpServerView): DisplayStatus {
  if (!server.enabled || server.status === "disabled" || server.status === "revoked") {
    return "disabled";
  }
  if (
    server.transport.type === "streamable-http" &&
    server.transport.authentication.type === "oauth" &&
    server.transport.authentication.status === "authorization-required"
  ) {
    return "authorization-required";
  }
  if (server.status === "connected") return "connected";
  if (server.status === "error") return "error";
  if (server.status === "connecting") return "connecting";
  if (server.status === "disconnected") return "disconnected";
  return "unvalidated";
}

function transportSummary(server: McpServerView): string {
  if (server.transport.type === "stdio") {
    return [server.transport.command, ...server.transport.args].join(" ");
  }
  return server.transport.url;
}

function capabilitySummary(server: McpServerView): string {
  const capabilities = [
    server.capabilities.tools ? "tools" : null,
    server.capabilities.resources ? "resources" : null,
    server.capabilities.prompts ? "prompts" : null,
  ].filter(Boolean);
  if (capabilities.length === 0) return "Capabilities available after validation.";
  return `Capabilities: ${capabilities.join(", ")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serverFromError(error: unknown): McpServerView | undefined {
  return error instanceof McpSettingsClientError ? error.server : undefined;
}
