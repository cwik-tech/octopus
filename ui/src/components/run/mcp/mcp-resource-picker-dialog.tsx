import { CircleAlert, FileDown, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { PanelEmptyState, PanelItem } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  mcpResourcesClient,
  type McpResourceDescriptor,
  type McpResourceImportResult,
  type McpResourcesClient,
} from "@/lib/clients/mcp-resources-client";

const PAGE_SIZE = 50;

interface McpResourcePickerDialogProps {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: (result: McpResourceImportResult) => void;
  client?: McpResourcesClient;
}

export function McpResourcePickerDialog({
  sessionId,
  open,
  onOpenChange,
  onImported,
  client = mcpResourcesClient,
}: McpResourcePickerDialogProps) {
  const [resources, setResources] = useState<McpResourceDescriptor[]>([]);
  const [serverOptions, setServerOptions] = useState<ServerOption[]>([]);
  const [selectedServerId, setSelectedServerId] = useState("");
  const [nextCursor, setNextCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingServers, setLoadingServers] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [serverListError, setServerListError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importingResourceId, setImportingResourceId] = useState<string | null>(null);
  const [importedResourceIds, setImportedResourceIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const listAbortRef = useRef<AbortController | null>(null);
  const serverListAbortRef = useRef<AbortController | null>(null);
  const importAbortRef = useRef<AbortController | null>(null);

  const loadServers = useCallback(async () => {
    serverListAbortRef.current?.abort();
    const controller = new AbortController();
    serverListAbortRef.current = controller;
    setLoadingServers(true);
    setServerListError(null);
    try {
      const servers = await client.listServers(controller.signal);
      if (controller.signal.aborted) return;
      setServerOptions(servers);
    } catch (error) {
      if (controller.signal.aborted) return;
      setServerListError(errorMessage(error));
    } finally {
      if (serverListAbortRef.current === controller) setLoadingServers(false);
    }
  }, [client]);

  const loadResources = useCallback(async (cursor?: string) => {
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    const appending = Boolean(cursor);
    if (appending) setLoadingMore(true);
    else {
      setLoading(true);
      setImportError(null);
      setConfirmation(null);
    }
    setListError(null);

    try {
      const result = await client.listResources(sessionId, {
        ...(selectedServerId ? { serverId: selectedServerId } : {}),
        ...(cursor ? { cursor } : {}),
        limit: PAGE_SIZE,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setResources((current) => appending
        ? appendUniqueResources(current, result.resources)
        : result.resources);
      setServerOptions((current) => mergeServerOptions(current, result.resources));
      setNextCursor(result.nextCursor);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (!appending) setResources([]);
      setListError(errorMessage(error));
    } finally {
      if (listAbortRef.current === controller) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [client, selectedServerId, sessionId]);

  useEffect(() => {
    if (!open) {
      listAbortRef.current?.abort();
      return;
    }
    const scheduledLoad = window.setTimeout(() => {
      void loadServers();
      void loadResources();
    }, 0);
    return () => {
      window.clearTimeout(scheduledLoad);
      listAbortRef.current?.abort();
      serverListAbortRef.current?.abort();
    };
  }, [loadResources, loadServers, open]);

  useEffect(() => () => {
    listAbortRef.current?.abort();
    serverListAbortRef.current?.abort();
    importAbortRef.current?.abort();
  }, []);

  const visibleServerOptions = useMemo(
    () => [...serverOptions].sort((left, right) => left.name.localeCompare(right.name)),
    [serverOptions],
  );

  const handleImport = useCallback(async (resource: McpResourceDescriptor) => {
    const controller = new AbortController();
    importAbortRef.current?.abort();
    importAbortRef.current = controller;
    setImportingResourceId(resource.id);
    setImportError(null);
    setConfirmation(null);
    try {
      const result = await client.importResource(sessionId, {
        serverId: resource.serverId,
        uri: resource.uri,
      }, controller.signal);
      if (controller.signal.aborted) return;
      setImportedResourceIds((current) => new Set(current).add(resource.id));
      setConfirmation(
        `${resource.name} added as ${result.files.length} session ${result.files.length === 1 ? "file" : "files"}.`,
      );
      onImported?.(result);
    } catch (error) {
      if (controller.signal.aborted) return;
      setImportError(errorMessage(error));
    } finally {
      if (importAbortRef.current === controller) {
        setImportingResourceId(null);
      }
    }
  }, [client, onImported, sessionId]);

  const dialogBusy = importingResourceId !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && dialogBusy) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="desktop-shell flex max-h-[calc(100dvh-3rem)] flex-col sm:max-w-2xl"
        showCloseButton={!dialogBusy}
      >
        <DialogHeader>
          <DialogTitle>Add from MCP</DialogTitle>
          <DialogDescription>
            Import a snapshot from a connected MCP server into this session.
          </DialogDescription>
        </DialogHeader>

        <label className="space-y-1.5 text-xs font-medium text-foreground">
          MCP server
          <select
            aria-label="MCP server"
            className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            value={selectedServerId}
            disabled={loading || loadingServers || dialogBusy}
            onChange={(event) => setSelectedServerId(event.target.value)}
          >
            <option value="">All connected servers</option>
            {visibleServerOptions.map((server) => (
              <option key={server.id} value={server.id}>{server.name}</option>
            ))}
          </select>
        </label>
        {serverListError ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive"
          >
            <span>Server filter unavailable: {serverListError}</span>
            <Button type="button" size="xs" variant="outline" onClick={() => void loadServers()}>
              Retry servers
            </Button>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {loading ? (
            <div className="space-y-2" role="status" aria-label="Loading MCP resources">
              <span className="sr-only">Loading MCP resources…</span>
              <Skeleton className="h-20 w-full rounded-lg" />
              <Skeleton className="h-20 w-full rounded-lg" />
              <Skeleton className="h-20 w-full rounded-lg" />
            </div>
          ) : listError ? (
            <ResourceError
              message={listError}
              retrying={loading}
              onRetry={() => void loadResources()}
            />
          ) : resources.length === 0 ? (
            <PanelEmptyState className="text-sm text-muted-foreground">
              No importable MCP resources were found for this server scope.
            </PanelEmptyState>
          ) : (
            <ul className="space-y-2" aria-label="MCP resources">
              {resources.map((resource) => {
                const supported = isImportable(resource);
                const importing = importingResourceId === resource.id;
                const imported = importedResourceIds.has(resource.id);
                return (
                  <li key={resource.id}>
                    <PanelItem className="flex items-start gap-3 p-3">
                      <FileDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="truncate text-sm font-medium text-foreground" title={resource.name}>
                          {resource.name}
                        </div>
                        {resource.description ? (
                          <p className="line-clamp-2 text-xs text-muted-foreground">
                            {resource.description}
                          </p>
                        ) : null}
                        <p className="truncate font-mono text-xs text-muted-foreground" title={resource.uri}>
                          {resource.uri}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {resource.serverName} · {resource.mimeType ?? "Unknown MIME type"}
                          {!supported ? ` · ${unsupportedReason(resource)}` : ""}
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label={`Import ${resource.name}`}
                        title={supported ? undefined : unsupportedReason(resource)}
                        disabled={!supported || dialogBusy}
                        onClick={() => void handleImport(resource)}
                      >
                        {importing ? <Loader2 className="animate-spin" /> : null}
                        {importing ? "Importing…" : imported ? "Import again" : "Import"}
                      </Button>
                    </PanelItem>
                  </li>
                );
              })}
            </ul>
          )}

          {!loading && !listError && nextCursor ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-3 w-full"
              disabled={loadingMore || dialogBusy}
              onClick={() => void loadResources(nextCursor)}
            >
              {loadingMore ? <Loader2 className="animate-spin" /> : null}
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          ) : null}
        </div>

        {importError ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive"
          >
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>{importError}</span>
          </div>
        ) : null}
        {confirmation ? (
          <p
            role="status"
            className="rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-xs text-foreground"
          >
            {confirmation}
          </p>
        ) : null}

        <DialogFooter>
          <DialogClose
            aria-label="Close MCP resource picker"
            render={<Button variant="outline" disabled={dialogBusy} />}
          >
            Close
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ServerOption {
  id: string;
  name: string;
}

function mergeServerOptions(
  current: ServerOption[],
  resources: McpResourceDescriptor[],
): ServerOption[] {
  const merged = new Map(current.map((server) => [server.id, server]));
  for (const resource of resources) {
    merged.set(resource.serverId, {
      id: resource.serverId,
      name: resource.serverName,
    });
  }
  return [...merged.values()];
}

function appendUniqueResources(
  current: McpResourceDescriptor[],
  incoming: McpResourceDescriptor[],
): McpResourceDescriptor[] {
  const seen = new Set(current.map((resource) => resource.id));
  return [...current, ...incoming.filter((resource) => !seen.has(resource.id))];
}

function isImportable(resource: McpResourceDescriptor): boolean {
  return resource.disposition !== "blocked";
}

function unsupportedReason(resource: McpResourceDescriptor): string {
  return resource.disposition === "blocked"
    ? "Blocked resource type"
    : "Unsupported resource type";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ResourceError({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-3 text-sm text-destructive"
    >
      <div className="flex items-start gap-2">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <span>{message}</span>
      </div>
      <Button type="button" size="sm" variant="outline" disabled={retrying} onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
