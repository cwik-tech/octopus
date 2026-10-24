import { whenDefined } from '../../core/optional-properties.js'
import type { ProviderModelInfo } from "./provider-settings.js";
import type { EffortLevel } from "../../core/types.js";
import { effortLevel, effortLevelList } from "./effort-metadata.js";

export const DEFAULT_CLI_MODEL_ID = "default";

const DEFAULT_MODEL: ProviderModelInfo = {
  id: DEFAULT_CLI_MODEL_ID,
  name: "Default model",
  enabled: true,
  capabilities: ["chat"],
};

const STABLE_CLI_ALIASES: Readonly<Record<string, readonly ProviderModelInfo[]>> = {
  claude: [
    {
      id: "opus",
      name: "Claude Opus 4.8 (1M context)",
      enabled: false,
      capabilities: ["chat"],
      contextLength: 1_000_000,
    },
    {
      id: "fable",
      name: "Claude Fable 5",
      enabled: false,
      capabilities: ["chat"],
    },
    {
      id: "sonnet",
      name: "Claude Sonnet 5",
      enabled: false,
      capabilities: ["chat"],
      contextLength: 1_000_000,
    },
    {
      id: "haiku",
      name: "Claude Haiku 4.5",
      enabled: false,
      capabilities: ["chat"],
    },
  ],
  gemini: [
    { id: "auto", name: "Auto", enabled: false, capabilities: ["chat"] },
    { id: "pro", name: "Pro", enabled: false, capabilities: ["chat"] },
    { id: "flash", name: "Flash", enabled: false, capabilities: ["chat"] },
    { id: "flash-lite", name: "Flash Lite", enabled: false, capabilities: ["chat"] },
  ],
};

export function fallbackCliModels(agentId: string): ProviderModelInfo[] {
  return [DEFAULT_MODEL, ...(STABLE_CLI_ALIASES[agentId] ?? [])].map(cloneModel);
}

/**
 * `supported_reasoning_levels` from `codex debug models`, in the order given.
 *
 * Returns nothing when the field is absent, because "published no range" and
 * "published an empty range" are different claims and only the second would
 * justify refusing every level.
 */
function readCodexReasoningLevels(value: unknown): EffortLevel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return effortLevelList(value.map((entry) => asRecord(entry)?.effort));
}

export function parseCodexModelCatalog(payload: string): ProviderModelInfo[] {
  try {
    const parsed = JSON.parse(payload) as { models?: unknown };
    if (!Array.isArray(parsed.models)) return [];
    return parsed.models
      .map((value): ProviderModelInfo | null => {
        const model = asRecord(value);
        const id = stringValue(model?.slug);
        if (!id || model?.visibility !== "list") return null;
        const efforts = readCodexReasoningLevels(model?.supported_reasoning_levels);
        const defaultEffort = effortLevel(model?.default_reasoning_level);
        return {
          id,
          name: stringValue(model?.display_name) ?? id,
          enabled: false,
          capabilities: ["chat"],
          icon: "openai",
          ...whenDefined(positiveNumber(model?.context_window), (contextLength) => ({ contextLength: contextLength })),
          ...whenDefined(efforts, (levels) => ({ supportedEfforts: levels })),
          ...whenDefined(defaultEffort, (level) => ({ defaultEffort: level })),
        };
      })
      .filter((model): model is ProviderModelInfo => Boolean(model));
  } catch {
    return [];
  }
}

/**
 * The `models` list from Claude Code's reply to the SDK `initialize` control
 * request, which is the same list its interactive `/model` picker shows.
 */
export function parseClaudeModelCatalog(response: unknown): ProviderModelInfo[] {
  const models = asRecord(response)?.models;
  if (!Array.isArray(models)) return [];
  return models
    .map((value): ProviderModelInfo | null => {
      const model = asRecord(value);
      const id = stringValue(model?.value);
      if (!id) return null;
      const efforts = effortLevelList(model?.supportedEffortLevels);
      return {
        id,
        name: stringValue(model?.displayName) ?? id,
        enabled: false,
        capabilities: ["chat"],
        ...whenDefined(efforts, (levels) => ({ supportedEfforts: levels })),
      };
    })
    .filter((model): model is ProviderModelInfo => Boolean(model));
}

/**
 * The models from Qwen's reply to the SDK `get_available_models` control
 * request, one entry per id.
 *
 * Qwen lists a model once for every configured plan that serves it, but
 * `qwen --model` takes only the id and Qwen picks the plan itself. So an id
 * several plans serve is named by itself rather than by one plan's label, and
 * gets the smallest window any of them states: promising the larger one would
 * be wrong whenever Qwen picks the other plan.
 */
export function parseQwenModelCatalog(response: unknown): ProviderModelInfo[] {
  const models = asRecord(response)?.models;
  if (!Array.isArray(models)) return [];
  const byId = new Map<string, { labels: string[]; windows: number[] }>();
  for (const value of models) {
    const model = asRecord(value);
    const id = stringValue(model?.id);
    if (!id) continue;
    const entry = byId.get(id) ?? { labels: [], windows: [] };
    entry.labels.push(stringValue(model?.label) ?? id);
    const window = positiveNumber(model?.contextWindowSize);
    if (window !== undefined) entry.windows.push(window);
    byId.set(id, entry);
  }
  return [...byId].map(([id, { labels, windows }]): ProviderModelInfo => ({
    id,
    name: labels.length === 1 ? labels[0] ?? id : id,
    enabled: false,
    capabilities: ["chat"],
    ...whenDefined(
      windows.length > 0 ? Math.min(...windows) : undefined,
      (contextLength) => ({ contextLength }),
    ),
  }));
}

/**
 * The model aliases from `kimi provider list --json`, which `kimi --model`
 * accepts. Only `models` is read: the same payload carries provider
 * credentials, which never leave this function.
 */
export function parseKimiModelCatalog(payload: string): ProviderModelInfo[] {
  try {
    const models = asRecord(JSON.parse(payload))?.models;
    const entries = asRecord(models);
    if (!entries) return [];
    return Object.entries(entries).map(([id, value]): ProviderModelInfo => {
      const model = asRecord(value);
      return {
        id,
        name: stringValue(model?.displayName) ?? id,
        enabled: false,
        capabilities: ["chat"],
        ...whenDefined(positiveNumber(model?.maxContextSize), (contextLength) => ({ contextLength })),
      };
    });
  } catch {
    return [];
  }
}

export function parsePiModelCatalog(output: string): ProviderModelInfo[] {
  const lines = output.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^provider\s+model\s+/i.test(line.trim()));
  if (headerIndex === -1) return [];

  return lines
    .slice(headerIndex + 1)
    .map((line): ProviderModelInfo | null => {
      const match = line.trim().match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(yes|no)\s+(yes|no)$/i);
      if (!match) return null;
      const [, provider, model, context] = match;
      if (!provider || !model) return null;
      return {
        id: `${provider}/${model}`,
        name: `${formatProvider(provider)} / ${model}`,
        enabled: false,
        capabilities: ["chat"],
        icon: provider,
        ...whenDefined(parseCompactNumber(context), (contextLength) => ({ contextLength: contextLength })),
      };
    })
    .filter((model): model is ProviderModelInfo => Boolean(model));
}

/**
 * What the CLI reported, or the hand-written aliases when it reported nothing.
 *
 * A reported list replaces the aliases rather than extending them: they are a
 * guess about what the CLI offers, and a guess loses to the CLI's own answer.
 * A reported entry also replaces the default one when it shares its id.
 */
export function mergeCliModels(
  agentId: string,
  discovered: readonly ProviderModelInfo[],
): ProviderModelInfo[] {
  if (discovered.length === 0) return fallbackCliModels(agentId);
  const merged = new Map<string, ProviderModelInfo>();
  for (const model of [DEFAULT_MODEL, ...discovered]) {
    merged.set(model.id, cloneModel(model));
  }
  return [...merged.values()];
}

function parseCompactNumber(value: string | undefined): number | undefined {
  const match = value?.match(/^(\d+(?:\.\d+)?)([KMG])?$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const multiplier = { K: 1_000, M: 1_000_000, G: 1_000_000_000 }[
    (match[2] ?? "").toUpperCase()
  ] ?? 1;
  return Number.isFinite(amount) ? Math.round(amount * multiplier) : undefined;
}

function formatProvider(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function cloneModel(model: ProviderModelInfo): ProviderModelInfo {
  return {
    ...model,
    ...whenDefined(model.capabilities ? [...model.capabilities] : undefined, (capabilities) => ({ capabilities })),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}
