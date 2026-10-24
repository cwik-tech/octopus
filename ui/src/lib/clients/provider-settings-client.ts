import {
  isThinkingLevel,
  type ThinkingLevel,
} from "@contracts/thinking-levels";

/** What an installation that predates this setting has always run at. */
const DEFAULT_EFFORT: ThinkingLevel = "medium";
import type { AppDefaultModelState } from "@contracts/agent-model-selection";
import { getApiBaseUrl } from "@/lib/utils/desktop";

const API_BASE = getApiBaseUrl();

export type ProviderConnectionKind =
  | "openrouter"
  | "openai-compatible"
  | "ollama"
  | "lm-studio";

export interface ProviderModelInfo {
  id: string;
  name: string;
  enabled: boolean;
  contextLength?: number;
  free?: boolean;
  icon?: string;
  capabilities?: Array<"chat" | "pdf">;
  /**
   * The effort levels this pair is known to accept, in the provider's order.
   *
   * Empty when nothing is known about the pair, which is why it is a list and
   * not a flag: an empty menu of levels is a fact worth showing, and it is not
   * the same as a pair that only accepts `low`.
   */
  supportedEfforts?: ThinkingLevel[];
}

export interface ProviderModelSelection {
  provider: string;
  model: string;
}

export interface ProviderConnection {
  id: string;
  kind: ProviderConnectionKind;
  name: string;
  baseUrl: string;
  enabled: boolean;
  status: "unknown" | "connected" | "error";
  error?: string;
  lastCheckedAt?: string;
  hasApiKey: boolean;
  apiKeyPreview?: string;
  models: ProviderModelInfo[];
  maxConcurrentRequests: number;
}

export interface LocalCliAgent {
  id: string;
  name: string;
  command: string;
  available: boolean;
  enabled: boolean;
  path?: string;
  version?: string;
  error?: string;
  models: ProviderModelInfo[];
}

export interface ProviderCatalogGroup {
  provider: string;
  name: string;
  icon: string;
  source: "connection" | "cli";
  models: ProviderModelInfo[];
}

export interface ProviderSettingsSnapshot {
  connections: ProviderConnection[];
  cliAgents: LocalCliAgent[];
  catalog: ProviderCatalogGroup[];
  /** The default's pair when it can run, otherwise `null`. */
  defaultModel: ProviderModelSelection | null;
  /** The deliberate choice and its readiness, kept apart. */
  defaultModelState: AppDefaultModelState;
  /** The level an Agent that names none runs at. */
  defaultEffort: ThinkingLevel;
}

export interface ProviderConnectionInput {
  id?: string | undefined;
  kind: ProviderConnectionKind;
  name: string;
  baseUrl: string;
  apiKey?: string;
  enabled: boolean;
  maxConcurrentRequests?: number | undefined;
}

export async function fetchProviderSettings(
  refresh = false,
  signal?: AbortSignal,
): Promise<ProviderSettingsSnapshot> {
  const snapshot = await request<ProviderSettingsSnapshot>(
    `/settings/providers${refresh ? "?refresh=1" : ""}`,
    { signal: providerReadSignal(signal) },
  );
  return { ...snapshot, defaultEffort: readDefaultEffort(snapshot.defaultEffort) };
}

/**
 * The application default effort, checked rather than trusted.
 *
 * Absent means an installation that predates the setting, and that has always
 * run at `medium`, so the fallback is stated here rather than left to whichever
 * reader looks first. A value this build cannot express is treated the same
 * way: it is a newer installation's word reaching an older screen, not a level
 * this screen can offer.
 */
function readDefaultEffort(value: unknown): ThinkingLevel {
  return isThinkingLevel(value) ? value : DEFAULT_EFFORT;
}

export interface ModelEffortCapability {
  provider: string;
  model: string;
  levels: ThinkingLevel[];
}

export async function fetchProviderCatalog(refresh = false, signal?: AbortSignal): Promise<{
  catalog: ProviderCatalogGroup[];
  effortCapabilities: ModelEffortCapability[];
  defaultEffort: ThinkingLevel;
  defaultModel: ProviderModelSelection | null;
  defaultModelState: AppDefaultModelState;
}> {
  const response = await request<{
    catalog: ProviderCatalogGroup[];
    effortCapabilities?: unknown;
    defaultEffort?: unknown;
    defaultModel: ProviderModelSelection | null;
    defaultModelState: AppDefaultModelState;
  }>(
    `/settings/model-catalog${refresh ? "?refresh=1" : ""}`,
    { signal: providerReadSignal(signal) },
  );
  return {
    ...response,
    effortCapabilities: readEffortCapabilities(response.effortCapabilities),
    defaultEffort: readDefaultEffort(response.defaultEffort),
  };
}

function providerReadSignal(signal: AbortSignal | undefined): AbortSignal {
  const deadline = AbortSignal.timeout(30_000);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

class ProviderCatalogContractError extends Error {
  constructor(contract: string) {
    super(`Invalid API response: expected ${contract}`);
    this.name = "ProviderCatalogContractError";
  }
}

/**
 * The effort ranges, checked rather than trusted.
 *
 * This field decides what the effort menu offers, so a malformed one would put
 * choices on screen that nothing behind them can honour. Three rules, and each
 * answers a different failure:
 *
 * - **Absent is empty.** A desktop build can be newer than the API it talks to,
 *   and "this server does not send ranges" is not a broken response.
 * - **Wrong shape is refused.** A list that is not a list of pairs is a server
 *   disagreeing with this client about the contract, and pretending otherwise
 *   hides it.
 * - **An unknown level is dropped, and the rest kept.** A server that learns a
 *   level before this build does should not be able to put a word in the menu
 *   that no adapter here can write; the levels this build does understand are
 *   still worth offering.
 */
function readEffortCapabilities(value: unknown): ModelEffortCapability[] {
  if (value === undefined || value === null) return [];
  const contract = "ModelEffortCapability[]";
  if (!Array.isArray(value)) throw new ProviderCatalogContractError(contract);
  return value.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ProviderCatalogContractError(contract);
    }
    const record: Record<string, unknown> = { ...entry };
    if (
      typeof record.provider !== "string" ||
      typeof record.model !== "string" ||
      !Array.isArray(record.levels)
    ) {
      throw new ProviderCatalogContractError(contract);
    }
    return {
      provider: record.provider,
      model: record.model,
      levels: record.levels.filter(isThinkingLevel),
    };
  });
}

export async function setDefaultProviderEffort(
  effort: ThinkingLevel,
): Promise<ThinkingLevel> {
  const result = await request<{ defaultEffort?: unknown }>(
    "/settings/default-effort",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ effort }),
    },
  );
  // Read back through the same guard as every other arrival of this field.
  return readDefaultEffort(result.defaultEffort);
}

export async function setDefaultProviderModel(
  selection: ProviderModelSelection,
): Promise<ProviderModelSelection> {
  const result = await request<{ defaultModel: ProviderModelSelection }>(
    "/settings/default-model",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(selection),
    },
  );
  return result.defaultModel;
}

export function saveProviderConnection(
  input: ProviderConnectionInput,
): Promise<ProviderConnection> {
  return request("/settings/providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function validateProviderConnection(
  connectionId: string,
): Promise<ProviderConnection> {
  return request(`/settings/providers/${encodeURIComponent(connectionId)}/validate`, {
    method: "POST",
  });
}

export function deleteProviderConnection(connectionId: string): Promise<void> {
  return request(`/settings/providers/${encodeURIComponent(connectionId)}`, {
    method: "DELETE",
  });
}

export function setProviderConnectionEnabled(
  connectionId: string,
  enabled: boolean,
): Promise<ProviderConnection> {
  return request(`/settings/providers/${encodeURIComponent(connectionId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

export function setProviderModelEnabled(
  connectionId: string,
  modelId: string,
  enabled: boolean,
): Promise<ProviderConnection> {
  return request(`/settings/providers/${encodeURIComponent(connectionId)}/models`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ modelId, enabled }),
  });
}

export async function refreshCliAgents(): Promise<LocalCliAgent[]> {
  const result = await request<{ cliAgents: LocalCliAgent[] }>(
    "/settings/cli/refresh",
    { method: "POST" },
  );
  return result.cliAgents;
}

export async function setCliAgentEnabled(
  id: string,
  enabled: boolean,
): Promise<LocalCliAgent[]> {
  const result = await request<{ cliAgents: LocalCliAgent[] }>(
    `/settings/cli/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
  return result.cliAgents;
}

export async function setCliModelEnabled(
  id: string,
  modelId: string,
  enabled: boolean,
): Promise<LocalCliAgent[]> {
  const result = await request<{ cliAgents: LocalCliAgent[] }>(
    `/settings/cli/${encodeURIComponent(id)}/models`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId, enabled }),
    },
  );
  return result.cliAgents;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    const fallback = `${response.status} ${response.statusText}`;
    try {
      const payload = (await response.json()) as { error?: string };
      throw new Error(payload.error || fallback);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(fallback, { cause: error });
      throw error;
    }
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
