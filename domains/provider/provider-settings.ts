/** Provider connection, model, and broker contracts. */

import type { AppDefaultModelState } from "../../contracts/agent-model-selection.js";
import type { EffortLevel, ThinkingLevel } from '../../core/types.js';

export type ProviderConnectionKind =
  | "openrouter"
  | "openai-compatible"
  | "ollama"
  | "lm-studio";

export type ProviderConnectionStatus = "unknown" | "connected" | "error";

export type ProviderModelCapability = "chat" | "pdf";

export interface ProviderModelSelection {
  provider: string;
  model: string;
}

export interface ProviderModelInfo {
  id: string;
  name: string;
  enabled: boolean;
  contextLength?: number;
  free?: boolean;
  icon?: string;
  capabilities?: ProviderModelCapability[];
  /**
   * The effort levels this model reports, in the provider's own order.
   *
   * Absent means the provider published nothing, which is a different fact
   * from "this model has no levels" and is treated differently: an absent
   * range leaves the choice at what the adapter has always been able to send,
   * while an empty one would claim the model refuses everything.
   */
  supportedEfforts?: EffortLevel[];
  /** The level the provider says it uses when a request names none. */
  defaultEffort?: EffortLevel;
}

export interface ProviderConnectionView {
  id: string;
  kind: ProviderConnectionKind;
  name: string;
  baseUrl: string;
  enabled: boolean;
  status: ProviderConnectionStatus;
  error?: string;
  lastCheckedAt?: string;
  hasApiKey: boolean;
  apiKeyPreview?: string;
  models: ProviderModelInfo[];
  maxConcurrentRequests?: number;
}

export interface ProviderConnectionInput {
  id?: string;
  kind: ProviderConnectionKind;
  name: string;
  baseUrl: string;
  apiKey?: string;
  enabled: boolean;
  maxConcurrentRequests?: number;
}

export type CliMcpBridgeReasonCode =
  | "cli_unavailable"
  | "cli_mcp_bridge_unsupported"
  | "cli_mcp_bridge_unavailable"
  | "cli_mcp_config_unsupported"
  | "cli_tool_isolation_unsupported";

export interface CliMcpBridgeReadiness {
  supported: boolean;
  reasonCode?: CliMcpBridgeReasonCode;
}

export interface LocalCliAgentView {
  id: string;
  name: string;
  command: string;
  available: boolean;
  enabled: boolean;
  path?: string;
  version?: string;
  error?: string;
  models: ProviderModelInfo[];
  mcpBridge: CliMcpBridgeReadiness;
}

export interface ProviderCatalogGroup {
  provider: string;
  name: string;
  icon: string;
  source: "connection" | "cli";
  models: ProviderModelInfo[];
}

/** The effort levels one provider and model pair is known to accept. */
export interface ModelEffortCapability {
  provider: string;
  model: string;
  levels: EffortLevel[];
}

export interface ProviderSettingsSnapshot {
  connections: ProviderConnectionView[];
  cliAgents: LocalCliAgentView[];
  catalog: ProviderCatalogGroup[];
  /**
   * Effort ranges, for every pair one is known for.
   *
   * Separate from `catalog` because the catalogue describes what a person may
   * *choose* — local CLIs and configured connections — while an Agent file may
   * name a built-in API provider that appears in no group at all. An effort
   * range carried only inside the catalogue could never reach such an Agent,
   * which is exactly how `openai`/`gpt-5.6-sol` ended up with an empty menu.
   */
  effortCapabilities: ModelEffortCapability[];
  /**
   * The level an Agent that names none runs at.
   *
   * Always present: an installation that has never chosen one reports the
   * historical `medium` rather than nothing, so a reader never has to know that
   * this setting is newer than the installation.
   */
  defaultEffort: ThinkingLevel;
  /** The default's pair when it can run, otherwise `null`. */
  defaultModel: ProviderModelSelection | null;
  /**
   * The deliberate choice and its readiness, kept apart so a default that is
   * currently unavailable can be named instead of silently replaced.
   */
  defaultModelState: AppDefaultModelState;
}

export interface RuntimeProviderConnection {
  id: string;
  kind: ProviderConnectionKind;
  name: string;
  baseUrl: string;
  apiKey?: string;
  maxConcurrentRequests?: number;
}

export const CONFIGURED_PROVIDER_PREFIX = "connection:";
export const CONFIGURED_PROVIDERS_ENV = "PIPELINE_CONFIGURED_PROVIDERS";
export const CONFIGURED_PROVIDER_BROKER_URL_ENV =
  "PIPELINE_CONFIGURED_PROVIDER_BROKER_URL";
export const DEFAULT_MODEL_SELECTION_ENV = "PIPELINE_DEFAULT_MODEL_SELECTION";

export function configuredProviderName(connectionId: string): string {
  return `${CONFIGURED_PROVIDER_PREFIX}${connectionId}`;
}

export function isConfiguredProviderName(provider: string): boolean {
  return provider.startsWith(CONFIGURED_PROVIDER_PREFIX);
}

export function providerConnectionDefaults(
  kind: ProviderConnectionKind,
): { name: string; baseUrl: string; requiresApiKey: boolean } {
  switch (kind) {
    case "openrouter":
      return {
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        requiresApiKey: true,
      };
    case "ollama":
      return {
        name: "Ollama",
        baseUrl: "http://127.0.0.1:11434",
        requiresApiKey: false,
      };
    case "lm-studio":
      return {
        name: "LM Studio",
        baseUrl: "http://127.0.0.1:1234/v1",
        requiresApiKey: false,
      };
    case "openai-compatible":
      return { name: "OpenAI Compatible", baseUrl: "", requiresApiKey: true };
  }
}

export function providerConnectionDefaultMaxConcurrency(
  kind: ProviderConnectionKind,
): number {
  return kind === "openrouter" ? 3 : 1;
}

export function providerIconSlug(kind: ProviderConnectionKind): string {
  if (kind === "lm-studio") return "lmstudio";
  if (kind === "openai-compatible") return "api";
  return kind;
}
