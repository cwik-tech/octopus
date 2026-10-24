import {
  CheckCircle2,
  Eye,
  EyeOff,
  Info,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProviderIcon } from "@/components/ui/provider-icon";
import { ModelSelect } from "@/components/ui/model-select";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useProviderCatalog } from "@/contexts/provider-catalog-context";
import {
  deleteProviderConnection,
  fetchProviderSettings,
  refreshCliAgents,
  saveProviderConnection,
  setCliAgentEnabled,
  setCliModelEnabled,
  setDefaultProviderEffort,
  setDefaultProviderModel,
  setProviderConnectionEnabled,
  setProviderModelEnabled,
  validateProviderConnection,
  type LocalCliAgent,
  type ProviderConnection,
  type ProviderConnectionInput,
  type ProviderConnectionKind,
  type ProviderModelInfo,
  type ProviderSettingsSnapshot,
} from "@/lib/clients/provider-settings-client";
import { invalidateTeamBuilderTeamsCache } from "@/lib/clients/team-builder-client";
import { cn } from "@/lib/utils/utils";
import { DefaultEffortSelect } from "@/components/settings/default-effort-select";

const KIND_DEFAULTS: Record<
  ProviderConnectionKind,
  { name: string; baseUrl: string }
> = {
  openrouter: {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  "openai-compatible": { name: "OpenAI Compatible", baseUrl: "" },
  ollama: { name: "Ollama", baseUrl: "http://127.0.0.1:11434" },
  "lm-studio": {
    name: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
  },
};

interface ProviderDraft extends ProviderConnectionInput {
  storedApiKey?: string | undefined;
}

export function ProviderSettings() {
  const [snapshot, setSnapshot] = useState<ProviderSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [search, setSearch] = useState<Record<string, string>>({});
  const [freeOnly, setFreeOnly] = useState<Record<string, boolean>>({});
  const latestLoad = useRef<AbortController | null>(null);
  const { refresh: refreshCatalog } = useProviderCatalog();

  const load = useCallback(async () => {
    latestLoad.current?.abort();
    const controller = new AbortController();
    latestLoad.current = controller;
    try {
      const saved = await fetchProviderSettings(false, controller.signal);
      if (controller.signal.aborted) return;
      setSnapshot(saved);
      setError(null);
      const discovered = await fetchProviderSettings(true, controller.signal);
      if (controller.signal.aborted) return;
      setSnapshot(discovered);
    } catch (loadError) {
      if (controller.signal.aborted) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  useEffect(() => {
    // Display saved settings before the CLI discovery response arrives.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => latestLoad.current?.abort();
  }, [load]);

  const refreshAll = useCallback(async () => {
    await Promise.all([load(), refreshCatalog()]);
    invalidateTeamBuilderTeamsCache();
  }, [load, refreshCatalog]);

  const enabledModelCount = useMemo(
    () =>
      snapshot?.connections.reduce(
        (total, connection) =>
          total + connection.models.filter((model) => model.enabled).length,
        0,
      ) ?? 0,
    [snapshot],
  );

  const enabledCliModelCount = useMemo(
    () =>
      snapshot?.cliAgents.reduce(
        (total, agent) =>
          total +
          (agent.available && agent.enabled
            ? agent.models.filter((model) => model.enabled).length
            : 0),
        0,
      ) ?? 0,
    [snapshot],
  );

  async function handleSave(validateAfterSave: boolean) {
    if (!draft) return;
    setBusy("save");
    setError(null);
    try {
      const input: ProviderConnectionInput = {
        id: draft.id,
        kind: draft.kind,
        name: draft.name,
        baseUrl: draft.baseUrl,
        enabled: draft.enabled,
        maxConcurrentRequests: draft.maxConcurrentRequests,
        ...(draft.apiKey || !draft.storedApiKey ? { apiKey: draft.apiKey } : {}),
      };
      const saved = await saveProviderConnection(input);
      if (validateAfterSave) await validateProviderConnection(saved.id);
      setDraft(null);
      setShowKey(false);
      await refreshAll();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(null);
    }
  }

  async function runAction(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await action();
      await refreshAll();
    } catch (actionError) {
      setError(
        actionError instanceof Error ? actionError.message : String(actionError),
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
        <span>{snapshot?.connections.length ?? 0} connections</span>
        <span>{enabledModelCount} connection models enabled</span>
        <span>{enabledCliModelCount} CLI models enabled</span>
        <span>
          {snapshot?.cliAgents.filter((agent) => agent.available && agent.enabled)
            .length ?? 0}{" "}
          CLI agents enabled
        </span>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <XCircle className="mt-0.5 size-4 shrink-0" />
          {error}
        </div>
      ) : null}

      <section className="space-y-3 rounded-xl border border-border/70 bg-muted/20 p-4">
        <div>
          <h3 className="text-lg font-semibold">Default Model</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Used by Run and Create whenever a model is not explicitly selected.
          </p>
        </div>
        {/* Side by side while the box is wide enough, and stacked when it is
            not. The effort control is the narrower of the two: it holds one
            word, where the model holds a name. */}
        <div className="flex max-w-3xl flex-wrap items-center gap-3">
          <div className="min-w-64 flex-1 basis-80 space-y-1.5">
            <span className="block text-xs font-medium text-muted-foreground">
              Default model
            </span>
            <ModelSelect
              provider={snapshot?.defaultModel?.provider}
              model={snapshot?.defaultModel?.model}
              groups={snapshot?.catalog ?? []}
              onChange={(selection) =>
                void runAction("default-model", () =>
                  setDefaultProviderModel(selection),
                )
              }
              disabled={!snapshot || busy === "default-model"}
              placeholder="Select a default model"
              emptyMessage="No enabled models. Enable at least one model on a connection or CLI agent below."
              aria-label="Default model"
            />
          </div>
          <div className="min-w-40 flex-1 basis-40 space-y-1.5">
            <label
              htmlFor="default-effort"
              className="text-xs font-medium text-muted-foreground"
            >
              Default effort
            </label>
            <DefaultEffortSelect
              id="default-effort"
              value={snapshot?.defaultEffort}
              disabled={!snapshot || busy === "default-effort"}
              onChange={(effort) =>
                void runAction("default-effort", () =>
                  setDefaultProviderEffort(effort),
                )
              }
            />
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold">Model Connections</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Add OpenRouter, OpenAI-compatible endpoints, Ollama, or LM Studio.
              Expand a connection to enable or disable individual models.
            </p>
          </div>
          <Button onClick={() => setDraft(newDraft("openrouter"))}>
            <Plus className="size-4" />
            Add
          </Button>
        </div>

        {draft ? (
          <ConnectionEditor
            draft={draft}
            busy={busy === "save"}
            showKey={showKey}
            onShowKeyChange={setShowKey}
            onChange={setDraft}
            onCancel={() => setDraft(null)}
            onSave={() => void handleSave(false)}
            onSaveAndValidate={() => void handleSave(true)}
          />
        ) : null}

        <div className="overflow-hidden rounded-xl border border-border/70">
          {!snapshot ? (
            <div className="p-5 text-sm text-muted-foreground">Loading connections...</div>
          ) : snapshot.connections.length === 0 ? (
            <div className="p-5 text-sm text-muted-foreground">
              No API or local model connections configured.
            </div>
          ) : (
            <Accordion multiple className="w-full">
              {snapshot.connections.map((connection) => (
                <ConnectionAccordionItem
                  key={connection.id}
                  connection={connection}
                  busy={busy}
                  search={search[connection.id] ?? ""}
                  freeOnly={freeOnly[connection.id] ?? false}
                  onSearchChange={(value) =>
                    setSearch((current) => ({ ...current, [connection.id]: value }))
                  }
                  onFreeOnlyChange={(value) =>
                    setFreeOnly((current) => ({ ...current, [connection.id]: value }))
                  }
                  onEdit={() => {
                    setDraft(draftFromConnection(connection));
                    setShowKey(false);
                  }}
                  onDelete={() =>
                    void runAction(`delete:${connection.id}`, async () => {
                      if (window.confirm(`Delete ${connection.name}?`)) {
                        await deleteProviderConnection(connection.id);
                      }
                    })
                  }
                  onValidate={() =>
                    void runAction(`validate:${connection.id}`, () =>
                      validateProviderConnection(connection.id),
                    )
                  }
                  onToggle={(enabled) =>
                    void runAction(`toggle:${connection.id}`, () =>
                      setProviderConnectionEnabled(connection.id, enabled),
                    )
                  }
                  onToggleModel={(modelId, enabled) =>
                    void runAction(`model:${connection.id}:${modelId}`, () =>
                      setProviderModelEnabled(connection.id, modelId, enabled),
                    )
                  }
                />
              ))}
            </Accordion>
          )}
        </div>
      </section>

      <section className="space-y-4 border-t border-border/70 pt-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold">Local CLI Agents</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Detected subscription-backed command-line agents available on this Mac.
              Expand an agent to enable or disable individual models.
            </p>
          </div>
          <Button
            variant="outline"
            disabled={busy === "cli-refresh"}
            onClick={() =>
              void runAction("cli-refresh", async () => {
                await refreshCliAgents();
              })
            }
          >
            <RefreshCw className={cn("size-4", busy === "cli-refresh" && "animate-spin")} />
            Refresh
          </Button>
        </div>

        <div className="overflow-hidden rounded-xl border border-border/70">
          {snapshot ? (
            <Accordion multiple className="w-full">
              {snapshot.cliAgents.map((agent) => (
                <CliAgentAccordionItem
                  key={agent.id}
                  agent={agent}
                  busy={busy}
                  onToggle={(enabled) =>
                    void runAction(`cli:${agent.id}`, () =>
                      setCliAgentEnabled(agent.id, enabled),
                    )
                  }
                  onToggleModel={(modelId, enabled) =>
                    void runAction(`cli-model:${agent.id}:${modelId}`, () =>
                      setCliModelEnabled(agent.id, modelId, enabled),
                    )
                  }
                />
              ))}
            </Accordion>
          ) : (
            <div className="p-5 text-sm text-muted-foreground">Loading CLI agents...</div>
          )}
        </div>
      </section>
    </div>
  );
}

function ConnectionEditor({
  draft,
  busy,
  showKey,
  onShowKeyChange,
  onChange,
  onCancel,
  onSave,
  onSaveAndValidate,
}: {
  draft: ProviderDraft;
  busy: boolean;
  showKey: boolean;
  onShowKeyChange: (show: boolean) => void;
  onChange: (draft: ProviderDraft) => void;
  onCancel: () => void;
  onSave: () => void;
  onSaveAndValidate: () => void;
}) {
  function updateKind(kind: ProviderConnectionKind) {
    const defaults = KIND_DEFAULTS[kind];
    onChange({
      ...draft,
      kind,
      name: draft.id ? draft.name : defaults.name,
      baseUrl: draft.id ? draft.baseUrl : defaults.baseUrl,
    });
  }

  return (
    <div className="space-y-4 rounded-xl border border-border/70 bg-muted/20 p-4">
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1.5 text-sm">
          <span className="font-medium">Connection type</span>
          <select
            value={draft.kind}
            onChange={(event) => updateKind(event.target.value as ProviderConnectionKind)}
            className="h-9 w-full rounded-md border border-input bg-background px-3"
          >
            <option value="openrouter">OpenRouter</option>
            <option value="openai-compatible">OpenAI Compatible</option>
            <option value="ollama">Ollama</option>
            <option value="lm-studio">LM Studio</option>
          </select>
        </label>
        <label className="space-y-1.5 text-sm">
          <span className="font-medium">Name</span>
          <Input
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
        </label>
      </div>
      <label className="block space-y-1.5 text-sm">
        <span className="font-medium">Base URL</span>
        <Input
          value={draft.baseUrl}
          placeholder="https://api.example.com/v1"
          onChange={(event) => onChange({ ...draft, baseUrl: event.target.value })}
        />
      </label>
      <label className="block space-y-1.5 text-sm">
        <span className="font-medium">Maximum concurrent requests</span>
        <Input
          type="number"
          min={1}
          max={32}
          value={draft.maxConcurrentRequests ?? ""}
          onChange={(event) => onChange({
            ...draft,
            maxConcurrentRequests: event.target.value === ""
              ? undefined
              : Math.max(1, Math.min(32, Number(event.target.value) || 1)),
          })}
        />
        <span className="block text-xs text-muted-foreground">
          Limits parallel Agent generation for this connection.
        </span>
      </label>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
        <div className="space-y-1.5 text-sm">
          <label htmlFor="provider-api-key" className="block font-medium">
            API key
          </label>
          <div className="relative">
            <Input
              id="provider-api-key"
              type={showKey ? "text" : "password"}
              value={draft.apiKey ?? ""}
              placeholder={draft.storedApiKey ? `Stored: ${draft.storedApiKey}` : "Optional for local servers"}
              className="pr-9 font-mono"
              onChange={(event) => onChange({ ...draft, apiKey: event.target.value })}
            />
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={showKey ? "Hide API key" : "Show API key"}
              onClick={() => onShowKeyChange(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
            >
              {showKey ? <EyeOff /> : <Eye />}
            </Button>
          </div>
        </div>
        <label className="flex h-9 items-center gap-2 text-sm">
          <Switch
            checked={draft.enabled}
            onCheckedChange={(enabled) => onChange({ ...draft, enabled })}
          />
          Enabled
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button variant="outline" onClick={onSave} disabled={busy}>Save</Button>
        <Button onClick={onSaveAndValidate} disabled={busy || !draft.baseUrl.trim()}>
          {busy ? "Validating..." : "Save & Validate"}
        </Button>
      </div>
    </div>
  );
}

function ConnectionAccordionItem({
  connection,
  busy,
  search,
  freeOnly,
  onSearchChange,
  onFreeOnlyChange,
  onEdit,
  onDelete,
  onValidate,
  onToggle,
  onToggleModel,
}: {
  connection: ProviderConnection;
  busy: string | null;
  search: string;
  freeOnly: boolean;
  onSearchChange: (value: string) => void;
  onFreeOnlyChange: (value: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onValidate: () => void;
  onToggle: (enabled: boolean) => void;
  onToggleModel: (modelId: string, enabled: boolean) => void;
}) {
  const filteredModels = connection.models.filter((model) => {
    const query = search.trim().toLowerCase();
    if (query && !`${model.name} ${model.id}`.toLowerCase().includes(query)) return false;
    return !freeOnly || model.free === true;
  });
  const validating = busy === `validate:${connection.id}`;
  const enabledCount = connection.models.filter((model) => model.enabled).length;
  const hasModels = connection.status === "connected" && connection.models.length > 0;
  const needsEnabledModel = hasModels && enabledCount === 0;

  return (
    <AccordionItem value={connection.id} className="w-full border-b border-border/70 last:border-b-0">
      <div className="flex w-full items-center justify-between gap-3 px-4 py-3">
        <AccordionTrigger className="min-w-0 flex-1 justify-start gap-2 py-0 hover:no-underline">
          <ProviderIcon provider={connection.kind} className="size-7" />
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              connection.status === "connected"
                ? "bg-emerald-500"
                : connection.status === "error"
                  ? "bg-destructive"
                  : "bg-muted-foreground/50",
            )}
          />
          <div className="min-w-0 flex-1 text-left">
            <div className="truncate font-medium">{connection.name}</div>
            <div className="truncate text-xs text-muted-foreground">
              {connection.baseUrl}
            </div>
          </div>
        </AccordionTrigger>

        <div className="ml-auto flex shrink-0 items-center justify-end gap-3">
          {connection.hasApiKey ? (
            <span className="hidden shrink-0 rounded-full border px-2 py-1 text-xs text-muted-foreground sm:inline">
              {connection.apiKeyPreview}
            </span>
          ) : null}
          <Button variant="outline" size="sm" disabled={validating} onClick={onValidate}>
            {validating ? <RefreshCw className="animate-spin" /> : <CheckCircle2 />}
            <span className="hidden lg:inline">Validate</span>
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={`Edit ${connection.name}`} onClick={onEdit}>
            <Pencil />
          </Button>
          <Button variant="destructive" size="icon-sm" aria-label={`Delete ${connection.name}`} onClick={onDelete}>
            <Trash2 />
          </Button>
          {hasModels ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              {enabledCount}/{connection.models.length}
            </span>
          ) : null}
          <Switch
            checked={connection.enabled}
            onCheckedChange={onToggle}
            aria-label={`Enable ${connection.name}`}
          />
        </div>
      </div>

      {connection.error ? (
        <p className="px-4 pb-2 text-xs text-destructive">{connection.error}</p>
      ) : null}

      {needsEnabledModel ? (
        <p className="mx-4 mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
          No models are enabled yet. Expand this connection and enable at least
          one model to use it.
        </p>
      ) : null}

      <AccordionContent>
        {hasModels ? (
          <div className="space-y-3 px-4 pb-4">
            <div className="flex items-center gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => onSearchChange(event.target.value)}
                  placeholder="Search models..."
                  className="pl-8"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={freeOnly} onCheckedChange={onFreeOnlyChange} />
                Free only
              </label>
            </div>
            <div className="max-h-72 overflow-y-auto rounded-lg border border-border/70">
              {filteredModels.length === 0 ? (
                <div className="p-4 text-center text-sm text-muted-foreground">No models match.</div>
              ) : (
                filteredModels.map((model) => (
                  <ModelRow
                    key={model.id}
                    model={model}
                    icon={model.icon || connection.kind}
                    disabled={busy === `model:${connection.id}:${model.id}`}
                    onToggle={(enabled) => onToggleModel(model.id, enabled)}
                  />
                ))
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {enabledCount} enabled · {connection.models.length} available
            </div>
          </div>
        ) : connection.status !== "connected" ? (
          <div className="px-4 pb-4 text-sm text-muted-foreground">
            Validate the connection to discover available models.
          </div>
        ) : (
          <div className="px-4 pb-4 text-sm text-muted-foreground">
            No models discovered.
          </div>
        )}
      </AccordionContent>
    </AccordionItem>
  );
}

function CliAgentAccordionItem({
  agent,
  busy,
  onToggle,
  onToggleModel,
}: {
  agent: LocalCliAgent;
  busy: string | null;
  onToggle: (enabled: boolean) => void;
  onToggleModel: (modelId: string, enabled: boolean) => void;
}) {
  const enabledCount = agent.models.filter((model) => model.enabled).length;

  return (
    <AccordionItem
      value={agent.id}
      data-cli-agent={agent.id}
      className="w-full border-b border-border/70 last:border-b-0"
      disabled={!agent.available && agent.models.length === 0}
    >
      <div className="flex w-full items-center justify-between gap-3 px-4 py-3">
        <AccordionTrigger className="min-w-0 flex-1 justify-start gap-2 py-0 hover:no-underline">
          <ProviderIcon provider={agent.id} className="size-7" />
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              agent.available ? "bg-emerald-500" : "bg-destructive",
            )}
          />
          <div className="min-w-0 flex-1 text-left">
            <div className="truncate font-medium">{agent.name}</div>
            <div className="truncate text-xs text-muted-foreground">
              {agent.available ? agent.path : agent.error}
            </div>
          </div>
        </AccordionTrigger>

        <div
          data-cli-agent-controls
          className="ml-auto flex shrink-0 items-center justify-end gap-3"
        >
          {agent.version ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  aria-label={`Show ${agent.name} version`}
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground"
                    />
                  }
                >
                  <Info className="size-4" />
                </TooltipTrigger>
                <TooltipContent side="top">{agent.version}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
          {agent.models.length > 0 ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              {enabledCount}/{agent.models.length}
            </span>
          ) : null}
          <Switch
            checked={agent.enabled}
            disabled={!agent.available || busy === `cli:${agent.id}`}
            onCheckedChange={onToggle}
            aria-label={`Enable ${agent.name}`}
          />
        </div>
      </div>

      <AccordionContent>
        {agent.models.length > 0 ? (
          <div className="space-y-1 px-4 pb-4">
            <div className="max-h-72 overflow-y-auto rounded-lg border border-border/70">
              {agent.models.map((model) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  icon={model.icon || agent.id}
                  disabled={
                    !agent.available ||
                    !agent.enabled ||
                    busy === `cli-model:${agent.id}:${model.id}`
                  }
                  onToggle={(enabled) => onToggleModel(model.id, enabled)}
                />
              ))}
            </div>
            <div className="text-xs text-muted-foreground">
              {enabledCount} enabled · {agent.models.length} available
            </div>
          </div>
        ) : (
          <div className="px-4 pb-4 text-sm text-muted-foreground">
            No known models for this agent.
          </div>
        )}
      </AccordionContent>
    </AccordionItem>
  );
}

function ModelRow({
  model,
  icon,
  disabled,
  onToggle,
}: {
  model: ProviderModelInfo;
  icon: string;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <div className="flex min-h-11 items-center gap-3 border-b border-border/60 px-3 py-2 last:border-b-0 hover:bg-muted/30">
      <ProviderIcon provider={icon} />
      <span className="min-w-0 flex-1 truncate text-sm">{model.name}</span>
      {model.free ? <span className="text-xs text-emerald-600">Free</span> : null}
      {model.contextLength ? (
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {formatContext(model.contextLength)}
        </span>
      ) : null}
      <Switch
        checked={model.enabled}
        disabled={disabled}
        onCheckedChange={onToggle}
        aria-label={`Enable ${model.name}`}
      />
    </div>
  );
}

function newDraft(kind: ProviderConnectionKind): ProviderDraft {
  return {
    kind,
    ...KIND_DEFAULTS[kind],
    apiKey: "",
    enabled: true,
    maxConcurrentRequests: kind === "openrouter" ? 3 : 1,
  };
}

function draftFromConnection(connection: ProviderConnection): ProviderDraft {
  return {
    id: connection.id,
    kind: connection.kind,
    name: connection.name,
    baseUrl: connection.baseUrl,
    apiKey: "",
    enabled: connection.enabled,
    maxConcurrentRequests: connection.maxConcurrentRequests,
    storedApiKey: connection.apiKeyPreview,
  };
}

function formatContext(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}
