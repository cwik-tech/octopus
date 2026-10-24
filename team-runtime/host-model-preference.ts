/**
 * Puts Pi's host on a desired provider/model pair.
 *
 * It registers the Anthropic API fallback when ANTHROPIC_API_KEY is set and Pi
 * lists built-in anthropic models. For an openai pair it registers the OpenAI
 * Responses fallback when OPENAI_API_KEY is set, and for a codex pair the
 * ChatGPT subscription provider. A missing ChatGPT login throws out of the call
 * before anything is recorded. It then reads Pi's model registry back, selects
 * the pair, and calls `setModel` unless the host is already on it.
 *
 * While an assignment path is available, it writes to `host-events.jsonl`.
 * `host.model_selection.blocked` records a pair missing from the registry.
 * `host.model_selection.already_selected` records that no switch was needed.
 * `host.model_selection.switch` is written before `setModel`, and when the
 * host refuses, a second `blocked` record goes to the assignment path read for
 * the switch record. A blocked outcome sets the config error through the ports,
 * where the extension set it before, and returns false.
 *
 * The environment is read when each provider is registered, not at import. The
 * model registry is read from the host object at each use. The host's model is
 * read once before a switch, and that value goes into the switch record, the
 * warning and the refusal record. Session ids are read through the ports at
 * each record. The assignment path is read through them for the not-found,
 * already-selected and switch records, and the refusal record reuses the path
 * read for the switch record.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { whenDefined } from "../core/optional-properties.js";
import { readCodexSubscriptionAccessToken } from "../core/codex-subscription-auth.js";
import { logHostEvent } from "../domains/runtime/logger.js";
import {
  getAvailableHostModels,
  selectHostModel,
  type HostModelSpec,
} from "../domains/provider/host-model.js";
import {
  HOST_ANTHROPIC_PROVIDER,
  HOST_CODEX_PROVIDER,
  HOST_OPENAI_PROVIDER,
  openAiHostSupportsReasoningEffort,
} from "../domains/provider/provider-preflight.js";

/** The Pi calls host model preference makes. */
export type HostModelPreferencePi = Pick<ExtensionAPI, "registerProvider" | "setModel">;

/** The Pi host state host model preference reads. */
export type HostModelPreferenceHost = Pick<ExtensionContext, "model" | "modelRegistry">;

/** The session ids the runtime state holds when a record is written. */
export interface HostModelSelectionSessionIds {
  readonly sessionId: string;
  readonly rootSessionId: string | undefined;
}

/** The runtime state host model preference reads and writes. */
export interface HostModelPreferencePorts {
  /** The assignment path while a Team session is active, otherwise null. */
  readAssignmentPath(): string | null;
  readSessionIds(): HostModelSelectionSessionIds;
  /** Replaces the runtime's config errors with this one message. */
  setConfigError(message: string): void;
}

function dedupeHostModels<T extends { provider: string; id: string }>(
  models: T[],
): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const model of models) {
    const key = `${model.provider}:${model.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(model);
  }
  return deduped;
}

async function ensureHostAnthropicApiProvider(
  pi: HostModelPreferencePi,
  extCtx: HostModelPreferenceHost,
): Promise<
  Array<
    ProviderModelConfig & { provider: string; baseUrl: string; api: string }
  >
> {
  if (!process.env.ANTHROPIC_API_KEY) return [];

  const baseUrl = "https://api.anthropic.com";
  const api = "anthropic-messages";

  const builtInAnthropicModels = getAvailableHostModels(extCtx.modelRegistry)
    .filter((model) => model.provider === "anthropic")
    .map<ProviderModelConfig>((model) => ({
      id: model.id,
      name: model.name,
      api: model.api,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      ...whenDefined(model.compat, (compat) => ({ compat })),
    }));

  if (builtInAnthropicModels.length === 0) return [];

  pi.registerProvider(HOST_ANTHROPIC_PROVIDER, {
    baseUrl,
    apiKey: "$ANTHROPIC_API_KEY",
    api,
    headers: {
      "anthropic-version": "2023-06-01",
    },
    models: builtInAnthropicModels,
  });

  return builtInAnthropicModels.map((model) => ({
    ...model,
    provider: HOST_ANTHROPIC_PROVIDER,
    baseUrl,
    api,
  }));
}

async function ensureHostOpenAIResponsesProvider(
  pi: HostModelPreferencePi,
  desiredModel: string | undefined,
): Promise<
  Array<
    ProviderModelConfig & { provider: string; baseUrl: string; api: string }
  >
> {
  if (!desiredModel || !process.env.OPENAI_API_KEY) return [];

  const baseUrl =
    process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
  const api = "openai-responses";
  const supportsReasoningEffort =
    openAiHostSupportsReasoningEffort(desiredModel);
  const models: ProviderModelConfig[] = [
    {
      id: desiredModel,
      name: desiredModel,
      api,
      reasoning: supportsReasoningEffort,
      input: ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 400000,
      maxTokens: 32768,
      compat: {
        supportsDeveloperRole: true,
        supportsReasoningEffort,
      },
    },
  ];

  pi.registerProvider(HOST_OPENAI_PROVIDER, {
    baseUrl,
    apiKey: "$OPENAI_API_KEY",
    api,
    models,
  });

  return models.map((model) => ({
    ...model,
    provider: HOST_OPENAI_PROVIDER,
    baseUrl,
    api,
  }));
}

function ensureHostCodexSubscriptionProvider(
  pi: HostModelPreferencePi,
  extCtx: HostModelPreferenceHost,
) {
  const accessToken = readCodexSubscriptionAccessToken();
  const subscriptionModels = extCtx.modelRegistry.getAll()
    .filter((model) => model.provider === HOST_CODEX_PROVIDER)
    .map((model) => ({
      ...model,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    }));
  pi.registerProvider(HOST_CODEX_PROVIDER, {
    baseUrl: "https://chatgpt.com/backend-api",
    apiKey: accessToken,
    api: "openai-codex-responses",
    models: subscriptionModels,
  });

  return getAvailableHostModels(extCtx.modelRegistry)
    .filter((model) => model.provider === HOST_CODEX_PROVIDER)
    .map((model) => ({ ...model, provider: HOST_CODEX_PROVIDER }));
}

export async function applyDesiredHostModel(
  pi: HostModelPreferencePi,
  extCtx: HostModelPreferenceHost,
  desired: HostModelSpec,
  ports: HostModelPreferencePorts,
): Promise<boolean> {
  await ensureHostAnthropicApiProvider(pi, extCtx);
  if (
    desired.provider === "openai" ||
    desired.provider === HOST_OPENAI_PROVIDER
  ) {
    await ensureHostOpenAIResponsesProvider(pi, desired.model);
  }
  if (
    desired.provider === "codex" ||
    desired.provider === HOST_CODEX_PROVIDER
  ) {
    ensureHostCodexSubscriptionProvider(pi, extCtx);
  }

  // Provider registration updates the bound model registry synchronously.
  // Read back its normalized runtime models so setModel receives the host's
  // validated Model shape, rather than a registration-time config projection.
  const models = dedupeHostModels(
    getAvailableHostModels(extCtx.modelRegistry),
  );
  const selected = selectHostModel(models, desired);
  if (!selected) {
    const availablePreview = models
      .slice(0, 12)
      .map((model) => `${model.provider}:${model.id}`)
      .join(", ");
    const outputDir = ports.readAssignmentPath();
    if (outputDir) {
      const sessionIds = ports.readSessionIds();
      logHostEvent(outputDir, {
        timestamp: new Date().toISOString(),
        event: "host.model_selection.blocked",
        session_id: sessionIds.sessionId,
        root_session_id: sessionIds.rootSessionId,
        assignment_path: outputDir,
        desired_provider: desired.provider ?? null,
        desired_model: desired.model,
        current_provider: extCtx.model?.provider ?? null,
        current_model: extCtx.model?.id ?? null,
        available_preview: availablePreview,
      });
    }
    const message =
      `Configured host model '${desired.model}'` +
      (desired.provider ? ` on provider '${desired.provider}'` : "") +
      ` was not found in Pi's host model registry. Team execution is blocked.` +
      (availablePreview ? ` Available: ${availablePreview}` : "");
    // Set, not notified, the same as the refusal below. Every caller of the
    // extension's applyHostModelPreference enters config-error mode when it
    // returns false, and that tells the user once. Notifying here as well gave
    // two accounts of one failure.
    ports.setConfigError(message);
    console.error(
      `[team-runtime] Host model selection blocked. desired=${desired.provider ?? "any"}:${desired.model}; ` +
        `current=${extCtx.model?.provider ?? "unknown"}:${extCtx.model?.id ?? "unknown"}; ` +
        `available=${availablePreview || "(none)"}`,
    );
    return false;
  }

  const currentModel = extCtx.model;
  if (
    currentModel?.provider === selected.provider &&
    currentModel.id === selected.id
  ) {
    const outputDir = ports.readAssignmentPath();
    if (outputDir) {
      const sessionIds = ports.readSessionIds();
      logHostEvent(outputDir, {
        timestamp: new Date().toISOString(),
        event: "host.model_selection.already_selected",
        session_id: sessionIds.sessionId,
        root_session_id: sessionIds.rootSessionId,
        assignment_path: outputDir,
        selected_provider: selected.provider,
        selected_model: selected.id,
      });
    }
    return true;
  }

  const outputDir = ports.readAssignmentPath();
  if (outputDir) {
    const sessionIds = ports.readSessionIds();
    logHostEvent(outputDir, {
      timestamp: new Date().toISOString(),
      event: "host.model_selection.switch",
      session_id: sessionIds.sessionId,
      root_session_id: sessionIds.rootSessionId,
      assignment_path: outputDir,
      desired_provider: desired.provider ?? null,
      desired_model: desired.model,
      current_provider: currentModel?.provider ?? null,
      current_model: currentModel?.id ?? null,
      selected_provider: selected.provider,
      selected_model: selected.id,
    });
  }
  console.warn(
    `[team-runtime] Switching host model from ` +
      `${currentModel?.provider ?? "unknown"}:${currentModel?.id ?? "unknown"} ` +
      `to ${selected.provider}:${selected.id}`,
  );
  // Both refusals are the same expected outcome: the host is not on the pair
  // this level requires. Pi returns false when the provider is not in its
  // configured set, and throws when the deeper credential check fails — and it
  // returns false *before* switching, so in either case the host is still on
  // whatever it was. Running on that is running on a pair nobody chose.
  // Classified, never copied. A host error is external text and can quote a
  // request, a header or a credential, so neither its message nor its string
  // form reaches durable data, the UI, or stderr. What the reader needs is
  // which of the two refusals happened, and that is knowable without reading
  // the value at all.
  let switchOutcome: "host_refused_model" | "host_model_switch_failed" =
    "host_refused_model";
  let switched = false;
  try {
    switched = await pi.setModel(selected);
  } catch {
    switchOutcome = "host_model_switch_failed";
  }
  if (switched) return true;

  if (outputDir) {
    const sessionIds = ports.readSessionIds();
    logHostEvent(outputDir, {
      timestamp: new Date().toISOString(),
      event: "host.model_selection.blocked",
      session_id: sessionIds.sessionId,
      root_session_id: sessionIds.rootSessionId,
      assignment_path: outputDir,
      desired_provider: desired.provider ?? null,
      desired_model: desired.model,
      current_provider: currentModel?.provider ?? null,
      current_model: currentModel?.id ?? null,
      selected_provider: selected.provider,
      selected_model: selected.id,
      reason: switchOutcome,
    });
  }
  // Set, not notified: the caller enters config-error mode, which writes the
  // durable record and tells the user once.
  ports.setConfigError(
    `Host model '${selected.id}' on provider '${selected.provider}' was refused ` +
      `by the host (${switchOutcome}). Team execution is blocked.`,
  );
  console.error(
    `[team-runtime] Host model switch refused. ` +
      `selected=${selected.provider}:${selected.id}; reason=${switchOutcome}`,
  );
  return false;
}
