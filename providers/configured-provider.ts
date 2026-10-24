import {
  extractChatCompletionsText,
  readChatCompletionsBody,
  readChatCompletionsStream,
  type ChatCompletionsBody,
} from "./chat-completions-stream.js";
import {
  PROVIDER_HTTP_REQUEST_TIMEOUT_MS,
  combineAbortSignals,
} from "../core/timeout-manager.js";
import {
  detectProviderTruncation,
  truncatedProviderError,
} from "../domains/provider/provider-truncation.js";
import { whenDefined } from "../core/optional-properties.js"
import {
  CONFIGURED_PROVIDER_BROKER_URL_ENV,
  CONFIGURED_PROVIDERS_ENV,
  configuredProviderName,
  isConfiguredProviderName,
  type RuntimeProviderConnection,
} from "../domains/provider/provider-settings.js";
import {
  ProviderError,
  classifyProviderError,
  isSerializedProviderError,
  parseProviderError,
  type SerializedProviderError,
} from "../domains/provider/provider-error.js";
import type {
  Provider,
  ProviderExecuteOptions,
  ProviderResult,
} from "./types.js";
import {
  logProviderFailure,
  logProviderStart,
  logProviderSuccess,
} from "./telemetry.js";
import {
  effortForTurn,
  openAiEffortValue,
} from "../domains/provider/effort-support.js";

let configuredConnections = new Map<string, RuntimeProviderConnection>();

export function setConfiguredProviderConnections(
  connections: RuntimeProviderConnection[],
): void {
  configuredConnections = new Map(
    connections.map((connection) => [configuredProviderName(connection.id), connection]),
  );
}

export function configuredProviderEnvironment(
  connections: RuntimeProviderConnection[],
  brokerUrl: string | undefined,
): Record<string, string> {
  if (!brokerUrl || connections.length === 0) return {};
  const safeConnections = connections.map(({ apiKey: _apiKey, ...connection }) =>
    connection,
  );
  return {
    [CONFIGURED_PROVIDERS_ENV]: Buffer.from(
      JSON.stringify(safeConnections),
      "utf8",
    ).toString("base64"),
    [CONFIGURED_PROVIDER_BROKER_URL_ENV]: brokerUrl,
  };
}

export function getConfiguredProviderConnection(
  providerName: string,
): RuntimeProviderConnection | undefined {
  hydrateConfiguredProvidersFromEnvironment();
  return configuredConnections.get(providerName);
}

export function createConfiguredProvider(
  providerName: string,
): Provider | undefined {
  if (!isConfiguredProviderName(providerName)) return undefined;
  return {
    name: providerName,
    execute: (options) => executeConfiguredProvider(providerName, options),
  };
}

async function executeConfiguredProvider(
  providerName: string,
  options: ProviderExecuteOptions,
): Promise<ProviderResult> {
  const connection = getConfiguredProviderConnection(providerName);
  if (!connection) {
    throw new ProviderError({
      provider: providerName,
      message: `Configured provider '${providerName}' is unavailable. Revalidate it in Settings.`,
      // A connection that is gone is a configuration problem, and typing it is
      // what lets a policy tell "this selection cannot run" from "the request
      // failed".
      kind: "configuration",
      retryable: false,
      // Resolved before the request is built: nothing was sent.
      dispatched: false,
    });
  }

  // Before the broker hop as well as before the request, so a level this
  // connection cannot honour is refused in the process that made the choice
  // rather than in one that only relays it.
  const effort = effortForTurn({
    provider: providerName,
    model: options.model,
    requested: options.thinking,
  });

  const startedAt = Date.now();
  const brokerUrl = process.env[CONFIGURED_PROVIDER_BROKER_URL_ENV]?.trim();
  if (brokerUrl) {
    return executeThroughBroker(brokerUrl, providerName, options, startedAt);
  }
  const apiUrl = chatCompletionsUrl(connection);
  logProviderStart(options, providerName, `POST ${apiUrl}`);

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(connection.apiKey
          ? { Authorization: `Bearer ${connection.apiKey}` }
          : {}),
        ...(connection.kind === "openrouter"
          ? { "HTTP-Referer": "https://pipeline.local", "X-Title": "Pipeline" }
          : {}),
      },
      body: JSON.stringify({
        model: options.model,
        // Stream so partial text can reach the display channel. This is the
        // only provider a user can actually select from the chat catalog, so
        // it is the path that has to stream for the feature to be visible.
        stream: true,
        messages: [
          { role: "system", content: options.systemPrompt },
          { role: "user", content: options.userMessage },
        ],
        ...(numberConfig(options.providerConfig?.max_tokens) !== undefined
          ? { max_tokens: numberConfig(options.providerConfig?.max_tokens) }
          : {}),
        ...(numberConfig(options.providerConfig?.temperature) !== undefined
          ? { temperature: numberConfig(options.providerConfig?.temperature) }
          : {}),
        // The catalogue a user actually picks from is served by this adapter,
        // so a selector that did not reach this body would not reach the
        // provider most people are using. Which levels the model accepts comes
        // from the connection's own `/models` listing; a level it does not
        // publish is refused before the request is built.
        ...(effort ? { reasoning_effort: openAiEffortValue(effort) } : {}),
      }),
      signal: combineAbortSignals(
        AbortSignal.timeout(PROVIDER_HTTP_REQUEST_TIMEOUT_MS),
        options.signal,
      ),
    });
    if (!response.ok) {
      throw normalizedConfiguredProviderError({
        providerName,
        payload: await readChatCompletionsBody(response),
        fallbackMessage: `${connection.name} request failed with status ${response.status}`,
        ...whenDefined(response.status, (definedValue) => ({ statusCode: definedValue })),
        retryAfterHeader: response.headers.get("retry-after"),
      });
    }

    // `stream: true` is a request, not a guarantee. Plenty of OpenAI-compatible
    // endpoints ignore it and answer with an ordinary completion, so the
    // response's own content type decides how to read it. Forcing the SSE path
    // would break every endpoint that does not implement streaming.
    //
    // The streaming branch uses the same reader as the four built-in Chat
    // Completions providers. This is the only provider a user can select, so a
    // laxer reader here would mean the reachable path was the one that could
    // still return half an answer as though it were whole.
    const streamed = (response.headers.get("content-type") ?? "").includes(
      "text/event-stream",
    )
      ? await readChatCompletionsStream({
          response,
          provider: providerName,
          fallbackModel: options.model,
          ...whenDefined(options.onProtocolEvent, (definedValue) => ({
            onProtocolEvent: definedValue,
          })),
        })
      : undefined;
    // Both branches now produce one validated `ChatCompletionsBody`, so the
    // rules below — error, truncation, text, usage, model — read the same
    // representation whichever transport carried the answer.
    const legacy: ChatCompletionsBody | null = streamed
      ? null
      : await readChatCompletionsBody(response);
    if (legacy?.error) {
      throw normalizedConfiguredProviderError({
        providerName,
        payload: legacy,
        fallbackMessage: `${connection.name} request failed`,
        retryAfterHeader: response.headers.get("retry-after"),
      });
    }

    if (!streamed && !legacy) {
      throw new ProviderError({
        provider: providerName,
        message: `${connection.name} returned a response body that could not be read as JSON.`,
        retryable: true,
      });
    }

    // A body that arrived with HTTP 200 can still be a response the model never
    // finished. Checked before any result is built, so partial text cannot
    // become a finished answer.
    const body = streamed ? streamed.body : legacy;
    const truncation = detectProviderTruncation(body);
    if (truncation !== undefined) {
      logProviderFailure(options, providerName, truncation);
      throw truncatedProviderError(providerName, truncation);
    }

    const text = streamed
      ? streamed.text
      : extractChatCompletionsText(legacy?.choices?.[0]?.message?.content);
    if (!text.trim()) {
      throw new ProviderError({
        provider: providerName,
        message: `${connection.name} returned an empty response.`,
        retryable: false,
      });
    }

    const usage = body?.usage;
    const inputTokens = usage?.prompt_tokens ?? 0;
    const outputTokens = usage?.completion_tokens ?? 0;
    const result: ProviderResult = {
      text,
      cost: 0,
      durationMs: Date.now() - startedAt,
      inputTokens,
      outputTokens,
      contextTokens: usage?.total_tokens ?? inputTokens + outputTokens,
      model: body?.model || options.model,
    };
    logProviderSuccess(options, providerName, result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logProviderFailure(options, providerName, message);
    if (error instanceof ProviderError) throw error;
    throw new ProviderError({ provider: providerName, message, retryable: true });
  }
}

async function executeThroughBroker(
  brokerUrl: string,
  providerName: string,
  options: ProviderExecuteOptions,
  startedAt: number,
): Promise<ProviderResult> {
  logProviderStart(options, providerName, "configured-provider broker");
  try {
    const response = await fetch(brokerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: providerName,
        systemPrompt: options.systemPrompt,
        userMessage: options.userMessage,
        model: options.model,
        thinking: options.thinking,
        providerConfig: options.providerConfig,
      }),
      ...whenDefined(options.signal, (definedValue) => ({ signal: definedValue })),
    });
    const payload = (await response.json().catch(() => null)) as
      | ProviderResult
      | SerializedProviderError
      | { error?: string }
      | null;
    if (!response.ok || !isProviderResult(payload)) {
      throw normalizedConfiguredProviderError({
        providerName,
        payload,
        fallbackMessage: `Configured provider broker failed with status ${response.status}`,
        ...whenDefined(response.ok ? undefined : response.status, (definedValue) => ({ statusCode: definedValue })),
        retryAfterHeader: response.headers.get("retry-after"),
        preserveSerializedPolicy: true,
      });
    }
    const result = { ...payload, durationMs: payload.durationMs ?? Date.now() - startedAt };
    logProviderSuccess(options, providerName, result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logProviderFailure(options, providerName, message);
    if (error instanceof ProviderError) throw error;
    throw new ProviderError({ provider: providerName, message, retryable: true });
  }
}

function hydrateConfiguredProvidersFromEnvironment(): void {
  if (configuredConnections.size > 0) return;
  const encoded = process.env[CONFIGURED_PROVIDERS_ENV];
  if (!encoded) return;
  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    ) as RuntimeProviderConnection[];
    configuredConnections = new Map(
      parsed.map((connection) => [configuredProviderName(connection.id), connection]),
    );
  } catch {
    configuredConnections = new Map();
  }
}

function chatCompletionsUrl(connection: RuntimeProviderConnection): string {
  const base = connection.baseUrl.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function numberConfig(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizedConfiguredProviderError(params: {
  providerName: string;
  payload: unknown;
  fallbackMessage: string;
  statusCode?: number;
  retryAfterHeader?: string | null;
  preserveSerializedPolicy?: boolean;
}): ProviderError {
  const serialized = params.preserveSerializedPolicy &&
    isSerializedProviderError(params.payload)
    ? params.payload
    : undefined;
  const payloadRecord = asRecord(params.payload);
  const normalizedPayload = {
    ...(payloadRecord ?? {}),
    ...(payloadRecord?.error === undefined
      ? { error: params.fallbackMessage }
      : {}),
    ...(!serialized && params.statusCode !== undefined
      ? { statusCode: params.statusCode }
      : {}),
  };
  const parsed = parseProviderError(normalizedPayload);
  const classification = classifyProviderError({
    provider: params.providerName,
    ...whenDefined(parsed.statusCode, (definedValue) => ({ statusCode: definedValue })),
    ...whenDefined(parsed.code, (definedValue) => ({ code: definedValue })),
    kind: parsed.kind,
    message: parsed.message,
    ...whenDefined(params.retryAfterHeader, (definedValue) => ({ retryAfterHeader: definedValue })),
  });
  return new ProviderError({
    provider: params.providerName,
    message: parsed.message || params.fallbackMessage,
    kind: parsed.kind,
    ...whenDefined(parsed.statusCode, (definedValue) => ({ statusCode: definedValue })),
    ...whenDefined(parsed.code, (definedValue) => ({ code: definedValue })),
    retryable: serialized?.retryable ?? classification.retryable,
    ...whenDefined(serialized?.retryAfterMs ?? classification.retryAfterMs, (definedValue) => ({ retryAfterMs: definedValue })),
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isProviderResult(value: unknown): value is ProviderResult {
  const record = asRecord(value);
  return Boolean(record) &&
    typeof record?.text === "string" &&
    typeof record.cost === "number" &&
    typeof record.durationMs === "number" &&
    typeof record.inputTokens === "number" &&
    typeof record.outputTokens === "number" &&
    typeof record.contextTokens === "number" &&
    typeof record.model === "string";
}
