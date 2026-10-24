import { getConfiguredProviderConnection } from "../../providers/configured-provider.js";

const PROVIDER_DEFAULTS: Readonly<Record<string, number>> = Object.freeze({
  anthropic: 3,
  deepseek: 3,
  kimi: 3,
  openai: 3,
  openrouter: 3,
  xai: 3,
  codex: 1,
  claude: 1,
  gemini: 1,
  "kimi-cli": 1,
  qwen: 1,
  pi: 1,
});

export function resolveProviderMaxConcurrentRequests(params: {
  provider?: string;
  batchSize: number;
  workspaceOverride?: number;
}): number {
  if (!Number.isSafeInteger(params.batchSize) || params.batchSize < 1) {
    throw new Error("batchSize must be a positive integer");
  }
  const configured = params.workspaceOverride;
  if (configured !== undefined) {
    if (!Number.isSafeInteger(configured) || configured < 1) {
      throw new Error("maxConcurrentRequests override must be a positive integer");
    }
    return Math.min(configured, params.batchSize);
  }
  const provider = params.provider?.trim().toLowerCase() ?? "";
  const configuredConnection = provider.startsWith("connection:")
    ? getConfiguredProviderConnection(provider)
    : undefined;
  const providerDefault = configuredConnection?.maxConcurrentRequests ??
    PROVIDER_DEFAULTS[provider] ?? 1;
  return Math.min(providerDefault, params.batchSize);
}
