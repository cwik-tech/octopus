import { whenDefined } from '../core/optional-properties.js'
import * as crypto from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import { promisify } from "node:util";

import {
  configuredProviderEnvironment,
  setConfiguredProviderConnections,
} from "../providers/configured-provider.js";
import { executeProvider } from "../providers/protocol.js";
import { getProvider } from "../providers/registry.js";
import type { ProviderExecuteOptions, ProviderResult } from "../providers/types.js";
import {
  CONFIGURED_PROVIDER_PREFIX,
  type CliMcpBridgeReadiness,
  configuredProviderName,
  providerConnectionDefaults,
  providerConnectionDefaultMaxConcurrency,
  providerIconSlug,
  type LocalCliAgentView,
  type ProviderCatalogGroup,
  type ProviderConnectionInput,
  type ProviderConnectionKind,
  type ProviderConnectionStatus,
  type ProviderConnectionView,
  type ProviderModelInfo,
  type ProviderModelSelection,
  type ModelEffortCapability,
  type ProviderSettingsSnapshot,
  type RuntimeProviderConnection,
} from "../domains/provider/provider-settings.js";
import { buildCliPath, cliPathEntries } from "../core/cli-path.js";
import {
  defaultModelStateEnvironment,
  setRuntimeDefaultModelState,
} from "../domains/provider/default-model-selection.js";
import type { AppDefaultModelState } from "../contracts/agent-model-selection.js";
import { buildProviderSubprocessEnvironment } from "../domains/provider/provider-subprocess-environment.js";
import {
  DEFAULT_CLI_MODEL_ID,
  fallbackCliModels,
  mergeCliModels,
  parseClaudeModelCatalog,
  parseCodexModelCatalog,
  parseKimiModelCatalog,
  parsePiModelCatalog,
  parseQwenModelCatalog,
} from "../domains/provider/cli-models.js";
import type { ProviderToolLoopTarget } from "../domains/mcp/mcp-provider-tool-target.js";
import { readPublishedEffort } from "../domains/provider/effort-metadata.js";
import {
  defaultEffortEnvironment,
  setRuntimeDefaultEffort,
} from "../domains/provider/default-effort-selection.js";
import { DEFAULT_THINKING } from "../core/constants.js";
import { isThinkingLevel, type ThinkingLevel } from "../core/types.js";
import {
  documentedEffortCapabilities,
  documentedEffortLevels,
  documentedVendorForBaseUrl,
} from "../domains/provider/documented-effort-support.js";
import {
  readPiModelEffortSupport,
  resolveExecutedPiPath,
} from "../domains/provider/pi-model-effort.js";
import {
  offerableEffortLevels,
  setRuntimeEffortSupport,
  type ModelEffortSupport,
} from "../domains/provider/effort-support.js";
import { readCliDiscoveryCache, writeCliDiscoveryCache } from "./cli-discovery-cache.js";
import { isUnknownArray } from "../core/unknown-array.js";

const execFileAsync = promisify(execFile);
const STORE_VERSION = 3;
const CLI_CACHE_TTL_MS = 30_000;
const DEFAULT_MODEL_CACHE_TTL_MS = 5 * 60_000;

interface PersistedProviderConnection {
  id: string;
  kind: ProviderConnectionKind;
  name: string;
  baseUrl: string;
  encryptedApiKey?: string;
  enabled: boolean;
  status: ProviderConnectionStatus;
  error?: string;
  lastCheckedAt?: string;
  models: ProviderModelInfo[];
  maxConcurrentRequests?: number;
}

interface ProviderSettingsFile {
  version: number;
  connections: PersistedProviderConnection[];
  cliEnabled: Record<string, boolean>;
  cliModelEnabled: Record<string, Record<string, boolean>>;
  defaultModel?: ProviderModelSelection;
  /** Absent on installations that predate the setting, which means `medium`. */
  defaultEffort?: ThinkingLevel;
}

export interface ProviderSecretCodec {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export interface ProviderSettingsServiceOptions {
  storagePath?: string;
  secretCodec?: ProviderSecretCodec;
}

export type { ProviderToolLoopTarget } from "../domains/mcp/mcp-provider-tool-target.js";

interface KnownCliAgent {
  id: string;
  name: string;
  command: string;
}

const KNOWN_CLI_AGENTS: readonly KnownCliAgent[] = [
  { id: "codex", name: "Codex CLI", command: "codex" },
  { id: "claude", name: "Claude Code", command: "claude" },
  { id: "gemini", name: "Gemini CLI", command: "gemini" },
  { id: "kimi-cli", name: "Kimi Code CLI", command: "kimi" },
  { id: "qwen", name: "Qwen Code", command: "qwen" },
  { id: "pi", name: "Pi", command: "pi" },
];

export class ProviderSettingsService {
  private state: ProviderSettingsFile | null = null;
  /** Connection id to kind, for the sync lookup prompt assembly needs. */
  private connectionKinds = new Map<string, ProviderConnectionKind>();
  private writeQueue: Promise<void> = Promise.resolve();
  private cliCache: { checkedAt: number; agents: LocalCliAgentView[] } | null = null;
  private cliDiscoveryInFlight: Promise<LocalCliAgentView[]> | null = null;
  private brokerUrl: string | undefined;

  constructor(private readonly options: ProviderSettingsServiceOptions = {}) {}

  async snapshot(refreshCli = false): Promise<ProviderSettingsSnapshot> {
    const [connections, cliAgents] = await Promise.all([
      this.listConnections(),
      this.listCliAgents(refreshCli),
    ]);
    const snapshot = await this.buildSnapshot(connections, cliAgents);
    this.resolvedDefaultCache = {
      checkedAt: Date.now(),
      state: snapshot.defaultModelState,
    };
    setRuntimeDefaultModelState(snapshot.defaultModelState);
    return snapshot;
  }

  /** Display-only snapshot: filesystem reads never wait for a CLI subprocess. */
  async cachedSnapshot(): Promise<ProviderSettingsSnapshot> {
    const state = await this.ensureLoaded();
    const connections = await this.listConnections();
    if (this.cliCache) {
      return this.buildSnapshot(
        connections,
        this.applyCliPreferences(this.cliCache.agents, state),
      );
    }
    const saved = await readCliDiscoveryCache(this.options.storagePath);
    const agents = await Promise.all(
      KNOWN_CLI_AGENTS.map(async (definition): Promise<LocalCliAgentView> => {
        const executablePath = await commandPath(definition.command);
        const metadata = saved.find(
          agent => agent.id === definition.id && agent.path === executablePath,
        );
        return {
          ...definition,
          available: Boolean(executablePath),
          enabled: state.cliEnabled[definition.id] ?? Boolean(executablePath),
          ...whenDefined(executablePath, value => ({ path: value })),
          ...whenDefined(metadata?.version, version => ({ version })),
          models: this.cliAgentModels(definition.id, state, metadata?.models ?? []),
          mcpBridge: unsupportedCliMcpBridge("cli_mcp_bridge_unavailable"),
        };
      }),
    );
    return this.buildSnapshot(connections, agents);
  }

  private async buildSnapshot(
    connections: ProviderConnectionView[],
    cliAgents: LocalCliAgentView[],
  ): Promise<ProviderSettingsSnapshot> {
    const catalog = await this.getCatalog(connections, cliAgents);
    const state = await this.ensureLoaded();
    const defaultModelState = resolveDefaultModelState(
      state.defaultModel,
      catalog,
    );
    return {
      connections,
      cliAgents,
      catalog,
      effortCapabilities: effortCapabilitiesFor(catalog, connections),
      defaultEffort: state.defaultEffort ?? DEFAULT_THINKING,
      defaultModel:
        defaultModelState.status === "available"
          ? {
              provider: defaultModelState.provider,
              model: defaultModelState.model,
            }
          : null,
      defaultModelState,
    };
  }

  async listConnections(): Promise<ProviderConnectionView[]> {
    const state = await this.ensureLoaded();
    this.rememberConnectionKinds(state.connections);
    return state.connections.map((connection) => this.toView(connection));
  }

  /**
   * The kind of connection a `connection:<id>` provider routes to, synchronously.
   *
   * Prompt assembly runs inside a turn and cannot await, but it has to know
   * whether a speaker is an LM Studio box or a hosted endpoint: without this,
   * every connection-routed speaker is budgeted against the generic window,
   * which is roughly four times what a local model actually holds.
   *
   * Seeded at boot by `hydrateRuntime` and refreshed whenever connections are
   * listed or written, so the answer is available from the first turn.
   *
   * `undefined` means the kind is not known, and the resolver treats that as
   * the smallest window any connection kind claims rather than the generic
   * one. An earlier version of this comment called `undefined` conservative
   * while the resolver mapped it to a 128k row — four times what an LM Studio
   * or Ollama connection actually holds, which is exactly the over-promise
   * this lookup exists to prevent.
   */
  connectionKindFor(provider: string): string | undefined {
    if (!provider.startsWith(CONFIGURED_PROVIDER_PREFIX)) return undefined;
    const id = provider.slice(CONFIGURED_PROVIDER_PREFIX.length);
    return this.connectionKinds.get(id);
  }

  private rememberConnectionKinds(
    connections: readonly PersistedProviderConnection[],
  ): void {
    this.connectionKinds = new Map(
      connections.map((connection) => [connection.id, connection.kind]),
    );
  }

  async saveConnection(
    input: ProviderConnectionInput,
  ): Promise<ProviderConnectionView> {
    const result = await this.enqueueWrite(async () => {
      const state = await this.ensureLoaded();
      const existing = input.id
        ? state.connections.find((connection) => connection.id === input.id)
        : undefined;
      const defaults = providerConnectionDefaults(input.kind);
      const baseUrl = normalizeBaseUrl(input.baseUrl || defaults.baseUrl);
      if (!baseUrl) throw new Error("Base URL is required.");

      let encryptedApiKey = existing?.encryptedApiKey;
      if (input.apiKey !== undefined) {
        const apiKey = input.apiKey.trim();
        encryptedApiKey = apiKey ? this.encryptSecret(apiKey) : undefined;
      }

      const connectionChanged =
        !existing ||
        existing.kind !== input.kind ||
        existing.baseUrl !== baseUrl ||
        input.apiKey !== undefined;
      const next: PersistedProviderConnection = {
        id: existing?.id ?? crypto.randomUUID(),
        kind: input.kind,
        name: input.name.trim() || defaults.name,
        baseUrl,
        ...whenDefined(encryptedApiKey, (presentEncryptedApiKey) => ({
          encryptedApiKey: presentEncryptedApiKey,
        })),
        enabled: input.enabled,
        status: connectionChanged ? "unknown" : existing.status,
        ...whenDefined(connectionChanged ? undefined : existing.error, (error) => ({ error })),
        ...whenDefined(connectionChanged ? undefined : existing.lastCheckedAt, (lastCheckedAt) => ({ lastCheckedAt })),
        models: connectionChanged ? [] : existing.models,
        maxConcurrentRequests:
          input.maxConcurrentRequests ??
          existing?.maxConcurrentRequests ??
          providerConnectionDefaultMaxConcurrency(input.kind),
      };

      state.connections = existing
        ? state.connections.map((connection) =>
            connection.id === existing.id ? next : connection,
          )
        : [...state.connections, next];
      await this.persist();
      this.syncRuntimeConnections();
      return this.toView(next);
    });
    await this.refreshRuntimeDefaultModel();
    return result;
  }

  async deleteConnection(connectionId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = await this.ensureLoaded();
      state.connections = state.connections.filter(
        (connection) => connection.id !== connectionId,
      );
      // The deliberate default is kept. Deleting its connection changes the
      // selection's readiness, not the user's decision, and the snapshot
      // reports it as unavailable so the reason is visible.
      await this.persist();
      this.syncRuntimeConnections();
    });
    await this.refreshRuntimeDefaultModel();
  }

  async validateConnection(
    connectionId: string,
  ): Promise<ProviderConnectionView> {
    const state = await this.ensureLoaded();
    const current = state.connections.find((item) => item.id === connectionId);
    if (!current) throw new Error("Provider connection not found.");

    let discovered: ProviderModelInfo[] | undefined;
    let validationError: string | undefined;
    try {
      const apiKey = this.decryptSecret(current.encryptedApiKey);
      const defaults = providerConnectionDefaults(current.kind);
      if (defaults.requiresApiKey && !apiKey) {
        throw new Error("API key is required.");
      }
      await validateProviderCredential(current, apiKey);
      discovered = await discoverProviderModels(current, apiKey);
      if (discovered.length === 0) {
        throw new Error("The provider returned no selectable text models.");
      }
    } catch (error) {
      validationError = error instanceof Error ? error.message : String(error);
    }

    const result = await this.enqueueWrite(async () => {
      const connection = await this.requireConnection(connectionId);
      const checkedAt = new Date().toISOString();
      if (discovered) {
        const previousEnabled = new Map(
          connection.models.map((model) => [model.id, model.enabled]),
        );
        connection.models = discovered.map((model) => ({
          ...model,
          enabled: previousEnabled.get(model.id) ?? false,
          ...whenDefined(modelCapabilities(current, model), (capabilities) => ({
            capabilities,
          })),
        }));
        connection.status = "connected";
        delete connection.error;
      } else {
        connection.status = "error";
        connection.error = validationError ?? "Provider validation failed.";
      }
      connection.lastCheckedAt = checkedAt;
      await this.persist();
      this.syncRuntimeConnections();
      return this.toView(connection);
    });
    await this.refreshRuntimeDefaultModel();
    return result;
  }
  async setConnectionEnabled(
    connectionId: string,
    enabled: boolean,
  ): Promise<ProviderConnectionView> {
    const result = await this.enqueueWrite(async () => {
      const connection = await this.requireConnection(connectionId);
      connection.enabled = enabled;
      await this.persist();
      this.syncRuntimeConnections();
      return this.toView(connection);
    });
    await this.refreshRuntimeDefaultModel();
    return result;
  }

  async setModelEnabled(
    connectionId: string,
    modelId: string,
    enabled: boolean,
  ): Promise<ProviderConnectionView> {
    const result = await this.enqueueWrite(async () => {
      const connection = await this.requireConnection(connectionId);
      const model = connection.models.find((item) => item.id === modelId);
      if (!model) throw new Error("Provider model not found.");
      model.enabled = enabled;
      await this.persist();
      return this.toView(connection);
    });
    await this.refreshRuntimeDefaultModel();
    return result;
  }

  async listCliAgents(forceRefresh = false): Promise<LocalCliAgentView[]> {
    const state = await this.ensureLoaded();
    if (
      !forceRefresh &&
      this.cliCache &&
      Date.now() - this.cliCache.checkedAt < CLI_CACHE_TTL_MS
    ) {
      return this.applyCliPreferences(this.cliCache.agents, state);
    }
    if (this.cliDiscoveryInFlight) return this.cliDiscoveryInFlight;
    this.cliDiscoveryInFlight = this.discoverCliAgents().finally(() => {
      this.cliDiscoveryInFlight = null;
    });
    return this.cliDiscoveryInFlight;
  }

  private async discoverCliAgents(): Promise<LocalCliAgentView[]> {
    const state = await this.ensureLoaded();
    const agents = await Promise.all(
      KNOWN_CLI_AGENTS.map(async (definition): Promise<LocalCliAgentView> => {
        try {
          const executablePath = await commandPath(definition.command);
          const version = executablePath
            ? await commandVersion(executablePath)
            : undefined;
          const available = Boolean(executablePath);
          const discoveredModels = executablePath
            ? await discoverCliModels(definition.id, executablePath)
            : [];
          const mcpBridge = executablePath
            ? await probeCliMcpBridgeReadiness(definition.id, executablePath)
            : unsupportedCliMcpBridge("cli_unavailable");
          return {
            ...definition,
            available,
            enabled: state.cliEnabled[definition.id] ?? available,
            ...whenDefined(executablePath, (presentPath) => ({ path: presentPath })),
            ...whenDefined(version, (presentVersion) => ({ version: presentVersion })),
            models: this.cliAgentModels(
              definition.id,
              state,
              discoveredModels,
            ),
            mcpBridge,
            ...(available ? {} : { error: `Command not found: ${definition.command}` }),
          };
        } catch (error) {
          return {
            ...definition,
            available: false,
            enabled: false,
            models: this.cliAgentModels(definition.id, state, []),
            mcpBridge: unsupportedCliMcpBridge("cli_mcp_bridge_unavailable"),
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    const currentAgents = this.applyCliPreferences(agents, state);
    this.cliCache = { checkedAt: Date.now(), agents: currentAgents };
    await writeCliDiscoveryCache(this.options.storagePath, currentAgents);
    return currentAgents;
  }

  private applyCliPreferences(
    agents: readonly LocalCliAgentView[],
    state: ProviderSettingsFile,
  ): LocalCliAgentView[] {
    return agents.map(agent => ({
      ...agent,
      enabled: state.cliEnabled[agent.id] ?? agent.available,
      models: this.cliAgentModels(agent.id, state, agent.models),
    }));
  }

  async setCliEnabled(id: string, enabled: boolean): Promise<LocalCliAgentView[]> {
    if (!KNOWN_CLI_AGENTS.some((agent) => agent.id === id)) {
      throw new Error("CLI agent not found.");
    }
    await this.enqueueWrite(async () => {
      const state = await this.ensureLoaded();
      state.cliEnabled[id] = enabled;
      await this.persist();
      this.cliCache = null;
    });
    await this.refreshRuntimeDefaultModel();
    return this.listCliAgents(true);
  }

  async setCliModelEnabled(
    id: string,
    modelId: string,
    enabled: boolean,
  ): Promise<LocalCliAgentView[]> {
    const agents = await this.listCliAgents(false);
    const known = agents
      .find((agent) => agent.id === id)
      ?.models.some((model) => model.id === modelId);
    if (!known) throw new Error("CLI model not found.");
    await this.enqueueWrite(async () => {
      const state = await this.ensureLoaded();
      const modelMap = state.cliModelEnabled[id] ?? {};
      modelMap[modelId] = enabled;
      state.cliModelEnabled[id] = modelMap;
      await this.persist();
      this.cliCache = null;
    });
    await this.refreshRuntimeDefaultModel();
    return this.listCliAgents(true);
  }

  async hydrateRuntime(): Promise<void> {
    const state = await this.ensureLoaded();
    // Seeded at boot, not only when something lists connections. Otherwise the
    // first turn after startup against a local connection is budgeted before
    // anyone has asked what kind it is.
    this.rememberConnectionKinds(state.connections);
    this.syncRuntimeConnections();
    // The effort default travels the same way as the model default, and for
    // the same reason: a turn composed here may run in a child process.
    setRuntimeDefaultEffort(state.defaultEffort ?? DEFAULT_THINKING);
    // Cheap best-effort seed: prefer the last catalog-resolved selection,
    // falling back to the persisted one. Full catalog resolution happens in
    // `resolvedRuntimeDefaultModel` so startup never blocks on CLI probes.
    setRuntimeDefaultModelState(
      this.resolvedDefaultCache?.state ??
        (state.defaultModel
          ? {
              status: "available",
              provider: state.defaultModel.provider,
              model: state.defaultModel.model,
            }
          : { status: "unset" }),
    );
  }

  async runtimeEnvironment(): Promise<Record<string, string>> {
    await this.hydrateRuntime();
    const state = await this.resolvedRuntimeDefaultModel();
    return {
      ...configuredProviderEnvironment(
        this.runtimeConnections(),
        this.brokerUrl,
      ),
      ...defaultModelStateEnvironment(state),
      ...defaultEffortEnvironment(
        (await this.ensureLoaded()).defaultEffort ?? DEFAULT_THINKING,
      ),
    };
  }

  private resolvedDefaultCache: {
    checkedAt: number;
    state: AppDefaultModelState;
  } | null = null;

  /**
   * Resolves the effective default model against the catalog, cached because
   * catalog resolution may probe local CLIs. Mutations that can invalidate
   * the selection refresh it explicitly via `refreshRuntimeDefaultModel`, so
   * the TTL only guards against external changes (CLI installs/removals).
   */
  private async resolvedRuntimeDefaultModel(): Promise<AppDefaultModelState> {
    if (
      this.resolvedDefaultCache &&
      Date.now() - this.resolvedDefaultCache.checkedAt <
        DEFAULT_MODEL_CACHE_TTL_MS
    ) {
      return this.resolvedDefaultCache.state;
    }
    return this.refreshRuntimeDefaultModel();
  }

  private async refreshRuntimeDefaultModel(): Promise<AppDefaultModelState> {
    return (await this.snapshot(false)).defaultModelState;
  }

  setBrokerUrl(url: string): void {
    this.brokerUrl = url.trim() || undefined;
  }

  /**
   * Choose the level an Agent that names none runs at.
   *
   * Refused rather than coerced when it is not one this application can
   * express: a stored level nothing can send would be a setting that silently
   * does nothing, which is the failure this whole area exists to remove.
   */
  async setDefaultEffort(level: ThinkingLevel): Promise<ThinkingLevel> {
    if (!isThinkingLevel(level)) {
      throw new Error("Default effort must be a level this application supports.");
    }
    return this.enqueueWrite(async () => {
      const state = await this.ensureLoaded();
      state.defaultEffort = level;
      await this.persist();
      setRuntimeDefaultEffort(level);
      return level;
    });
  }

  async setDefaultModel(
    selection: ProviderModelSelection,
  ): Promise<ProviderModelSelection> {
    const snapshot = await this.snapshot(false);
    if (!catalogHasSelection(snapshot.catalog, selection)) {
      throw new Error("Default model must be enabled and available.");
    }
    return this.enqueueWrite(async () => {
      const state = await this.ensureLoaded();
      state.defaultModel = {
        provider: selection.provider.trim(),
        model: selection.model.trim(),
      };
      await this.persist();
      const resolved: AppDefaultModelState = {
        status: "available",
        provider: state.defaultModel.provider,
        model: state.defaultModel.model,
      };
      this.resolvedDefaultCache = { checkedAt: Date.now(), state: resolved };
      setRuntimeDefaultModelState(resolved);
      return state.defaultModel;
    });
  }

  async executeConfiguredProvider(
    provider: string,
    options: ProviderExecuteOptions,
  ): Promise<ProviderResult> {
    if (!provider.startsWith("connection:")) {
      throw new Error("Provider broker only accepts configured connections.");
    }
    await this.hydrateRuntime();
    return executeProvider(getProvider(provider), options);
  }

  async resolveConfiguredToolLoopTarget(
    provider: string,
    model: string,
  ): Promise<ProviderToolLoopTarget> {
    if (!provider.startsWith(CONFIGURED_PROVIDER_PREFIX)) {
      throw new Error("Provider tool loop requires a configured connection.");
    }
    const state = await this.ensureLoaded();
    const connectionId = provider.slice(CONFIGURED_PROVIDER_PREFIX.length);
    const connection = state.connections.find(
      (candidate) => candidate.id === connectionId,
    );
    if (!connection || !connection.enabled || connection.status !== "connected") {
      throw new Error("Configured provider is unavailable for MCP tools.");
    }
    if (
      !connection.models.some(
        (candidate) => candidate.id === model && candidate.enabled,
      )
    ) {
      throw new Error("Configured provider model is unavailable for MCP tools.");
    }
    const apiKey = this.decryptSecret(connection.encryptedApiKey);
    if (providerConnectionDefaults(connection.kind).requiresApiKey && !apiKey) {
      throw new Error("Configured provider credentials are unavailable.");
    }
    return {
      apiUrl: providerToolCompletionsUrl(connection.baseUrl),
      connectionKind: connection.kind,
      ...(apiKey ? { apiKey } : {}),
      ...(connection.kind === "openrouter"
        ? {
            headers: {
              "HTTP-Referer": "https://pipeline.local",
              "X-Title": "Pipeline",
            },
          }
        : {}),
    };
  }

  private async getCatalog(
    connections: ProviderConnectionView[],
    cliAgents: LocalCliAgentView[],
  ): Promise<ProviderCatalogGroup[]> {
    const connectionGroups = connections
      .filter(
        (connection) => connection.enabled && connection.status === "connected",
      )
      .map((connection): ProviderCatalogGroup => ({
        provider: configuredProviderName(connection.id),
        name: connection.name,
        icon: providerIconSlug(connection.kind),
        source: "connection",
        models: connection.models.filter((model) => model.enabled),
      }))
      .filter((group) => group.models.length > 0);

    const cliGroups = cliAgents
      .filter((agent) => agent.available && agent.enabled)
      .map((agent): ProviderCatalogGroup => ({
        provider: agent.id,
        name: agent.name,
        icon: agent.id,
        source: "cli",
        models: agent.models.filter((model) => model.enabled),
      }))
      .filter((group) => group.models.length > 0);

    const catalog = [...cliGroups, ...connectionGroups];
    // Published ranges first, because the fill below reads them. What reaches
    // the editor is the *offerable* list, which is narrower than the list
    // dispatch will accept: an agent file may already name a level on a pair
    // nobody has described, and that keeps running, but a menu that offered
    // the same level would be inviting a choice nothing has established. An
    // empty list means the editor offers the two defaults and no levels.
    publishEffortSupport(catalog);
    return catalog.map((group) => ({
      ...group,
      models: group.models.map((model) => ({
        ...model,
        supportedEfforts: [
          ...offerableEffortLevels({ provider: group.provider, model: model.id }),
        ],
      })),
    }));
  }

  private async ensureLoaded(): Promise<ProviderSettingsFile> {
    if (this.state) return this.state;
    if (!this.options.storagePath) {
      this.state = emptySettings();
      return this.state;
    }
    try {
      const raw = await fsp.readFile(this.options.storagePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ProviderSettingsFile>;
      const loaded: ProviderSettingsFile = {
        version: STORE_VERSION,
        connections: Array.isArray(parsed.connections) ? parsed.connections : [],
        cliEnabled:
          parsed.cliEnabled && typeof parsed.cliEnabled === "object"
            ? parsed.cliEnabled
            : {},
        cliModelEnabled:
          parsed.cliModelEnabled && typeof parsed.cliModelEnabled === "object"
            ? parsed.cliModelEnabled
            : {},
        ...whenDefined(parseModelSelection(parsed.defaultModel), (defaultModel) => ({
          defaultModel,
        })),
        // Read back through the same check that guards the writer. A file
        // hand-edited to a level this build cannot express is an installation
        // that has chosen nothing, not one that runs at a word nobody honours.
        ...(isThinkingLevel(parsed.defaultEffort)
          ? { defaultEffort: parsed.defaultEffort }
          : {}),
      };
      this.state = loaded;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = emptySettings();
    }
    if (!this.state) this.state = emptySettings();
    return this.state;
  }

  private async requireConnection(
    connectionId: string,
  ): Promise<PersistedProviderConnection> {
    const state = await this.ensureLoaded();
    const connection = state.connections.find((item) => item.id === connectionId);
    if (!connection) throw new Error("Provider connection not found.");
    return connection;
  }

  private cliAgentModels(
    agentId: string,
    state: ProviderSettingsFile,
    discovered: readonly ProviderModelInfo[],
  ): ProviderModelInfo[] {
    const known = mergeCliModels(agentId, discovered);
    const persisted = state.cliModelEnabled[agentId] ?? {};
    return known.map((model) => ({
      ...model,
      enabled:
        persisted[model.id] ?? model.id === DEFAULT_CLI_MODEL_ID,
    }));
  }

  private toView(connection: PersistedProviderConnection): ProviderConnectionView {
    const apiKey = this.decryptSecret(connection.encryptedApiKey);
    return {
      id: connection.id,
      kind: connection.kind,
      name: connection.name,
      baseUrl: connection.baseUrl,
      enabled: connection.enabled,
      status: connection.status,
      ...whenDefined(connection.error, (error) => ({ error })),
      ...whenDefined(connection.lastCheckedAt, (lastCheckedAt) => ({ lastCheckedAt })),
      hasApiKey: Boolean(apiKey),
      ...whenDefined(maskApiKey(apiKey), (apiKeyPreview) => ({ apiKeyPreview })),
      models: connection.models,
      maxConcurrentRequests:
        connection.maxConcurrentRequests ??
        providerConnectionDefaultMaxConcurrency(connection.kind),
    };
  }

  private encryptSecret(value: string): string {
    if (!this.options.secretCodec) {
      throw new Error(
        "Secure credential storage is unavailable outside the desktop app.",
      );
    }
    return this.options.secretCodec.encrypt(value);
  }

  private decryptSecret(value?: string): string {
    if (!value || !this.options.secretCodec) return "";
    try {
      return this.options.secretCodec.decrypt(value);
    } catch {
      return "";
    }
  }

  private syncRuntimeConnections(): void {
    if (!this.state) return;
    setConfiguredProviderConnections(this.runtimeConnections());
  }

  private runtimeConnections(): RuntimeProviderConnection[] {
    if (!this.state) return [];
    return this.state.connections
      .filter(
        (connection) => connection.enabled && connection.status === "connected",
      )
      .map((connection) => {
        const apiKey = this.decryptSecret(connection.encryptedApiKey);
        return {
          id: connection.id,
          kind: connection.kind,
          name: connection.name,
          baseUrl: connection.baseUrl,
          maxConcurrentRequests:
            connection.maxConcurrentRequests ??
            providerConnectionDefaultMaxConcurrency(connection.kind),
          ...(apiKey ? { apiKey } : {}),
        };
      });
  }

  private async persist(): Promise<void> {
    if (!this.options.storagePath || !this.state) return;
    await fsp.mkdir(path.dirname(this.options.storagePath), { recursive: true });
    const temporaryPath = `${this.options.storagePath}.tmp`;
    await fsp.writeFile(temporaryPath, JSON.stringify(this.state, null, 2), {
      mode: 0o600,
    });
    await fsp.rename(temporaryPath, this.options.storagePath);
  }

  private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        resolveResult(await operation());
      } catch (error) {
        rejectResult(error);
      }
    });
    await this.writeQueue;
    return result;
  }
}

function emptySettings(): ProviderSettingsFile {
  return {
    version: STORE_VERSION,
    connections: [],
    cliEnabled: {},
    cliModelEnabled: {},
  };
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function providerToolCompletionsUrl(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function maskApiKey(apiKey: string): string | undefined {
  if (!apiKey) return undefined;
  if (apiKey.length <= 8) return "••••••••";
  return `${apiKey.slice(0, 4)}••••${apiKey.slice(-4)}`;
}

async function discoverProviderModels(
  connection: PersistedProviderConnection,
  apiKey: string,
): Promise<ProviderModelInfo[]> {
  if (connection.kind === "ollama") {
    try {
      const payload = await fetchProviderJson(
        `${connection.baseUrl}/api/tags`,
        "",
      );
      return parseOllamaModels(payload);
    } catch {
      // Some Ollama-compatible servers only expose the OpenAI model endpoint.
    }
  }

  let lastError: unknown;
  for (const url of modelEndpointCandidates(connection.baseUrl)) {
    try {
      const payload = await fetchProviderJson(url, apiKey);
      return parseProviderModels(payload, connection.kind);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Unable to retrieve provider models.");
}

async function validateProviderCredential(
  connection: PersistedProviderConnection,
  apiKey: string,
): Promise<void> {
  if (connection.kind !== "openrouter") return;
  await fetchProviderJson(`${normalizeBaseUrl(connection.baseUrl)}/key`, apiKey);
}

async function fetchProviderJson(url: string, apiKey: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}${text ? `: ${text.slice(0, 180)}` : ""}`,
    );
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error("Provider returned invalid JSON.");
  }
}

/**
 * Hand the catalogue's effort ranges to the layers that cannot ask a provider.
 *
 * The adapters decide whether a chosen level can be sent, and they sit several
 * layers below this service. This is the same shape
 * `domains/provider/default-model-selection.ts` uses for the application
 * default: state it once where it is known, read it below without reaching up.
 */
/**
 * Every effort range this installation knows, from both of its sources.
 *
 * The catalogue's own models first, because a provider that answered for itself
 * outranks anything written down here; then the pairs a vendor documents but
 * never publishes, so an Agent naming one of those has a menu at all. A pair in
 * neither is absent rather than empty: absent means nobody has described it,
 * and the editor shows the two defaults and no levels.
 */
function effortCapabilitiesFor(
  catalog: readonly ProviderCatalogGroup[],
  connections: readonly ProviderConnectionView[],
): ModelEffortCapability[] {
  const capabilities = new Map<string, ModelEffortCapability>();
  const key = (provider: string, model: string) => `${provider}\u0000${model}`;
  for (const entry of documentedEffortCapabilities()) {
    capabilities.set(key(entry.provider, entry.model), {
      provider: entry.provider,
      model: entry.model,
      levels: [...entry.levels],
    });
  }

  // A connection carries its own identity, so nothing about `connection:<uuid>`
  // says whose models it serves. Its endpoint does: one pointed at a vendor's
  // official API host is that vendor, and the documented ranges are as true
  // there as on the built-in adapter. Anything else stays undescribed.
  const vendorByProvider = new Map<string, string>();
  for (const connection of connections) {
    const vendor = documentedVendorForBaseUrl(connection.baseUrl);
    if (vendor) {
      vendorByProvider.set(configuredProviderName(connection.id), vendor);
    }
  }

  for (const group of catalog) {
    const vendor = vendorByProvider.get(group.provider);
    for (const model of group.models) {
      if (model.supportedEfforts && model.supportedEfforts.length > 0) {
        // What the connection published about itself, which outranks anything
        // written down here.
        capabilities.set(key(group.provider, model.id), {
          provider: group.provider,
          model: model.id,
          levels: [...model.supportedEfforts],
        });
        continue;
      }
      if (!vendor) continue;
      const documented = documentedEffortLevels(vendor, model.id);
      if (documented.length === 0) continue;
      capabilities.set(key(group.provider, model.id), {
        provider: group.provider,
        model: model.id,
        levels: [...documented],
      });
    }
  }
  return [...capabilities.values()];
}

function publishEffortSupport(catalog: readonly ProviderCatalogGroup[]): void {
  const entries: ModelEffortSupport[] = [];
  for (const group of catalog) {
    for (const model of group.models) {
      if (!model.supportedEfforts || model.supportedEfforts.length === 0) continue;
      entries.push({
        provider: group.provider,
        model: model.id,
        levels: model.supportedEfforts,
        ...(model.defaultEffort ? { defaultLevel: model.defaultEffort } : {}),
      });
    }
  }
  setRuntimeEffortSupport(entries);
}

function modelEndpointCandidates(baseUrl: string): string[] {
  const base = normalizeBaseUrl(baseUrl);
  return /\/v1$/i.test(base)
    ? [`${base}/models`]
    : [`${base}/models`, `${base}/v1/models`];
}

function parseProviderModels(
  payload: unknown,
  kind: ProviderConnectionKind,
): ProviderModelInfo[] {
  const record = asRecord(payload);
  const data: readonly unknown[] = isUnknownArray(record?.data)
    ? record.data
    : isUnknownArray(record?.models)
      ? record.models
      : [];
  return data
    .map((value): ProviderModelInfo | null => {
      const model = asRecord(value);
      if (!model) return null;
      const id = stringValue(model.id) || stringValue(model.key);
      if (!id) return null;
      const name =
        stringValue(model.name) ||
        stringValue(model.display_name) ||
        id;
      if (!isLikelyChatModel(model, `${id} ${name}`)) return null;
      const pricing = asRecord(model.pricing);
      const promptPrice = numberString(pricing?.prompt);
      const completionPrice = numberString(pricing?.completion);
      const free =
        promptPrice !== undefined &&
        completionPrice !== undefined &&
        promptPrice === 0 &&
        completionPrice === 0;
      const effort = readPublishedEffort(model);
      return {
        id,
        name,
        enabled: false,
        capabilities: ["chat"],
        ...whenDefined(
          numberValue(model.context_length) ||
          numberValue(model.max_context_length),
          (contextLength) => ({ contextLength }),
        ),
        ...whenDefined(effort.levels, (levels) => ({ supportedEfforts: levels })),
        ...whenDefined(effort.defaultLevel, (level) => ({ defaultEffort: level })),
        ...(pricing ? { free } : {}),
        icon: (
          kind === "openrouter" && id.includes("/")
            ? id.split("/", 1)[0]
            : undefined
        ) ?? providerIconSlug(kind),
      };
    })
    .filter((model): model is ProviderModelInfo => Boolean(model));
}

function parseOllamaModels(payload: unknown): ProviderModelInfo[] {
  const models = asRecord(payload)?.models;
  if (!Array.isArray(models)) return [];
  return models
    .map((value): ProviderModelInfo | null => {
      const model = asRecord(value);
      const id = stringValue(model?.name) || stringValue(model?.model);
      return id
        ? {
            id,
            name: id,
            enabled: false,
            icon: "ollama",
            capabilities: ["chat"],
          }
        : null;
    })
    .filter((model): model is ProviderModelInfo => Boolean(model));
}

async function commandPath(command: string): Promise<string | undefined> {
  for (const directory of cliPathEntries()) {
    const candidate = path.join(directory, command);
    try {
      await fsp.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep scanning PATH entries.
    }
  }
  return undefined;
}

async function commandVersion(executablePath: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, ["--version"], {
      env: { ...buildProviderSubprocessEnvironment(), PATH: buildCliPath() },
      timeout: 5_000,
    });
    return (stdout || stderr).trim().split("\n")[0]?.slice(0, 120);
  } catch {
    return undefined;
  }
}

async function probeCliMcpBridgeReadiness(
  agentId: string,
  executablePath: string,
): Promise<CliMcpBridgeReadiness> {
  if (agentId === "codex") {
    const [execHelp, mcpHelp] = await Promise.all([
      commandHelp(executablePath, ["exec", "--help"]),
      commandHelp(executablePath, ["mcp", "add", "--help"]),
    ]);
    if (!execHelp || !mcpHelp) {
      return unsupportedCliMcpBridge("cli_mcp_bridge_unavailable");
    }
    if (
      !hasAllHelpFlags(execHelp, [
        "--config",
        "--disable",
        "--ephemeral",
        "--ignore-rules",
        "--strict-config",
      ]) ||
      !hasAllHelpFlags(mcpHelp, ["--url", "--bearer-token-env-var"])
    ) {
      return unsupportedCliMcpBridge("cli_mcp_config_unsupported");
    }
    if (!hasAllHelpFlags(execHelp, ["--ignore-user-config"])) {
      return unsupportedCliMcpBridge("cli_tool_isolation_unsupported");
    }
    return { supported: true };
  }

  if (agentId === "claude") {
    const help = await commandHelp(executablePath, ["--help"]);
    if (!help) {
      return unsupportedCliMcpBridge("cli_mcp_bridge_unavailable");
    }
    if (!hasAllHelpFlags(help, ["--mcp-config"])) {
      return unsupportedCliMcpBridge("cli_mcp_config_unsupported");
    }
    if (
      !hasAllHelpFlags(help, [
        "--setting-sources",
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--tools",
        "--allowedTools",
        "--permission-mode",
      ])
    ) {
      return unsupportedCliMcpBridge("cli_tool_isolation_unsupported");
    }
    return { supported: true };
  }

  if (agentId === "kimi-cli") {
    const help = await commandHelp(executablePath, ["--help"]);
    if (!help) {
      return unsupportedCliMcpBridge("cli_mcp_bridge_unavailable");
    }
    if (!hasAllHelpFlags(help, ["--mcp-config-file"])) {
      return unsupportedCliMcpBridge("cli_mcp_config_unsupported");
    }
    if (!hasAllHelpFlags(help, ["--agent-file"])) {
      return unsupportedCliMcpBridge("cli_tool_isolation_unsupported");
    }
    return { supported: true };
  }

  return unsupportedCliMcpBridge("cli_mcp_bridge_unsupported");
}

async function commandHelp(
  executablePath: string,
  args: readonly string[],
): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, [...args], {
      env: {
        ...buildProviderSubprocessEnvironment(),
        PATH: buildCliPath(),
        COLUMNS: "240",
        NO_COLOR: "1",
      },
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    const output = `${stdout}\n${stderr}`.trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

function hasAllHelpFlags(help: string, flags: readonly string[]): boolean {
  return flags.every((flag) => help.includes(flag));
}

function unsupportedCliMcpBridge(
  reasonCode: NonNullable<CliMcpBridgeReadiness["reasonCode"]>,
): CliMcpBridgeReadiness {
  return { supported: false, reasonCode };
}

async function discoverCliModels(
  agentId: string,
  executablePath: string,
): Promise<ProviderModelInfo[]> {
  try {
    if (agentId === "codex") {
      const { stdout } = await execFileAsync(executablePath, ["debug", "models"], {
        env: { ...buildProviderSubprocessEnvironment(), PATH: buildCliPath() },
        timeout: 10_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return parseCodexModelCatalog(stdout);
    }
    if (agentId === "claude") {
      return parseClaudeModelCatalog(
        await requestCliControl(executablePath, CLAUDE_CONTROL_ARGS, ["initialize"]),
      );
    }
    if (agentId === "qwen") {
      return parseQwenModelCatalog(
        await requestCliControl(executablePath, QWEN_CONTROL_ARGS, [
          "initialize",
          "get_available_models",
        ]),
      );
    }
    if (agentId === "kimi-cli") {
      const { stdout } = await execFileAsync(executablePath, ["provider", "list", "--json"], {
        env: { ...buildProviderSubprocessEnvironment(), PATH: buildCliPath() },
        timeout: 10_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return parseKimiModelCatalog(stdout);
    }
    if (agentId === "pi") {
      const { stdout } = await execFileAsync(executablePath, ["--list-models"], {
        env: { ...buildProviderSubprocessEnvironment(), PATH: buildCliPath() },
        timeout: 10_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      // The range comes from the runtime that will actually run the turn: the
      // bundled CLI whenever `core/pi-runtime.ts` has been pointed at one, and
      // otherwise whatever `PATH` resolves, followed to the package tree it
      // really lives in. The adapter resolves it the same way, so the
      // catalogue and the dispatch decision describe one program.
      const effort = readPiModelEffortSupport(resolveExecutedPiPath());
      return parsePiModelCatalog(stdout).map((model) => {
        const levels = effort.get(model.id);
        return levels && levels.length > 0
          ? { ...model, supportedEfforts: levels }
          : model;
      });
    }
  } catch {
    // Installed CLIs still retain their safe default/alias fallback entries.
  }
  return [];
}

/**
 * Claude Code's flags for asking it about itself. They match how
 * `providers/claude.ts` runs a turn, so the reported list describes what a
 * turn can use. They also keep the request from running the user's hooks or
 * leaving a saved session behind each time the list is refreshed.
 */
const CLAUDE_CONTROL_ARGS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--setting-sources",
  "",
  "--settings",
  JSON.stringify({ disableAllHooks: true }),
];

const QWEN_CONTROL_ARGS = ["--input-format", "stream-json", "--output-format", "stream-json"];

const CONTROL_REQUEST_ID_PREFIX = "pipeline-model-discovery";

/**
 * The reply to the last of `subtypes`, sent as SDK control requests to a CLI
 * running in its stream-json mode. Each request waits for the previous reply,
 * because these CLIs accept nothing before `initialize` has been answered.
 * None of these requests makes a model call.
 */
function requestCliControl(
  executablePath: string,
  args: readonly string[],
  subtypes: readonly string[],
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, [...args], {
      env: { ...buildProviderSubprocessEnvironment(), PATH: buildCliPath() },
      stdio: ["pipe", "pipe", "ignore"],
      // Its own process group, so everything it starts can be stopped with it.
      detached: process.platform !== "win32",
    });
    const lines = readline.createInterface({ input: child.stdout });
    let settled = false;
    let closed = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      if (!closed) stopControlCli(child);
      outcome();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`${executablePath} did not answer in time.`))),
      15_000,
    );
    let index = 0;
    const send = () => {
      child.stdin.write(
        `${JSON.stringify({
          type: "control_request",
          request_id: `${CONTROL_REQUEST_ID_PREFIX}-${index}`,
          request: { subtype: subtypes[index] },
        })}\n`,
      );
    };
    lines.on("line", (line) => {
      const reply = readControlReply(line, `${CONTROL_REQUEST_ID_PREFIX}-${index}`);
      if (!reply) return;
      if (reply.subtype !== "success") {
        finish(() => reject(new Error(`${executablePath} refused ${subtypes[index]}.`)));
        return;
      }
      index += 1;
      if (index < subtypes.length) send();
      else finish(() => resolve(reply.response));
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", () => {
      closed = true;
      finish(() => reject(new Error(`${executablePath} exited before answering.`)));
    });
    child.stdin.on("error", () => {
      // The close handler reports a CLI that exits before reading a request.
    });
    send();
  });
}

/**
 * Stops a control-request CLI and every process it started.
 *
 * Some CLIs run behind a launcher: the installed Qwen's launcher starts the CLI
 * in a child that shares the launcher's pipes and ignores SIGTERM. Stopping
 * only the launcher left that child running with the pipe open, two orphaned
 * Qwen processes per refresh, and a caller that could not exit. The CLI was
 * started in its own process group, and the pipe is still open (`close` has
 * not fired), so the group still has members and its id is this CLI's.
 */
function stopControlCli(child: ChildProcess): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The group has already gone.
    }
  }
  child.kill();
}

/** The control response to `requestId`, or nothing for any other line. */
function readControlReply(
  line: string,
  requestId: string,
): Record<string, unknown> | undefined {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return undefined;
  }
  const record = asRecord(message);
  if (record?.type !== "control_response") return undefined;
  const reply = asRecord(record.response);
  return reply?.request_id === requestId ? reply : undefined;
}

function modelCapabilities(
  connection: PersistedProviderConnection,
  model: ProviderModelInfo,
): ProviderModelInfo["capabilities"] {
  const capabilities = new Set<"chat" | "pdf">(
    model.capabilities ?? ["chat"],
  );
  if (supportsOpenAiPdfInput(connection)) capabilities.add("pdf");
  return [...capabilities];
}

function supportsOpenAiPdfInput(
  connection: Pick<PersistedProviderConnection, "kind" | "baseUrl">,
): boolean {
  if (connection.kind !== "openai-compatible") return false;
  try {
    return new URL(connection.baseUrl).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

function isLikelyChatModel(
  model: Record<string, unknown>,
  searchableText: string,
): boolean {
  const type = stringValue(model.type)?.toLowerCase() ?? "";
  const excludedType = /embed|image|audio|speech|transcri|rerank|moderation|tts/;
  if (excludedType.test(type)) return false;
  return !excludedType.test(searchableText.toLowerCase());
}

function parseModelSelection(value: unknown): ProviderModelSelection | undefined {
  const record = asRecord(value);
  const provider = stringValue(record?.provider);
  const model = stringValue(record?.model);
  return provider && model ? { provider, model } : undefined;
}

/**
 * The deliberate default and whether it can run right now.
 *
 * Catalog order is never consulted. A workspace with models available but no
 * chosen default has no default; a chosen default whose model has been
 * disabled or removed stays named so the user can be told what broke.
 */
function resolveDefaultModelState(
  stored: ProviderModelSelection | undefined,
  catalog: readonly ProviderCatalogGroup[],
): AppDefaultModelState {
  if (!stored) return { status: "unset" };
  const entry = catalogEntryFor(catalog, stored);
  if (!entry) {
    return {
      status: "unavailable",
      provider: stored.provider,
      model: stored.model,
      detail: "the selected model is not enabled or no longer available",
    };
  }
  const capabilities = entry.capabilities;
  return {
    status: "available",
    provider: stored.provider,
    model: stored.model,
    ...(capabilities ? { capabilities } : {}),
  };
}

function catalogEntryFor(
  catalog: readonly ProviderCatalogGroup[],
  selection: ProviderModelSelection,
): ProviderModelInfo | undefined {
  return catalog
    .find((group) => group.provider === selection.provider)
    ?.models.find(
      (model) =>
        model.id === selection.model &&
        (model.capabilities?.includes("chat") ?? true),
    );
}

function catalogHasSelection(
  catalog: readonly ProviderCatalogGroup[],
  selection: ProviderModelSelection,
): boolean {
  return catalog.some(
    (group) =>
      group.provider === selection.provider &&
      group.models.some(
        (model) =>
          model.id === selection.model &&
          (model.capabilities?.includes("chat") ?? true),
      ),
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberString(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}
