/**
 * DeepSeek Provider
 *
 * Dispatches agent runs directly to DeepSeek's OpenAI-compatible chat
 * completions API using DEEPSEEK_API_KEY from the environment.
 */

import {
  extractChatCompletionsText,
  readChatCompletionsBody,
  readChatCompletionsStream,
  type ChatCompletionsBody,
} from "./chat-completions-stream.js";
import { whenDefined } from "../core/optional-properties.js"
import {
  PROVIDER_HTTP_REQUEST_TIMEOUT_MS,
  combineAbortSignals,
} from "../core/timeout-manager.js";
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
  ProviderError,
  classifyProviderError,
} from "../domains/provider/provider-error.js";
import {
  detectProviderTruncation,
  truncatedProviderError,
} from "../domains/provider/provider-truncation.js";
import { assertProviderBaseUrl } from "../domains/provider/provider-base-url.js";
import { calculateUsageCost } from "./cost.js";
import { effortForTurn } from "../domains/provider/effort-support.js";

const DEFAULT_API_URL = "https://api.deepseek.com/chat/completions";

export function createDeepSeekProvider(): Provider {
  return {
    name: "deepseek",

    async execute(options: ProviderExecuteOptions): Promise<ProviderResult> {
      const apiKey = stringConfig(process.env.DEEPSEEK_API_KEY);
      if (!apiKey) {
        const message =
          "Provider 'deepseek' requires DEEPSEEK_API_KEY in the environment.";
        logProviderFailure(options, "deepseek", message);
        throw new ProviderError({
          provider: "deepseek",
          message,
          kind: "authentication",
          retryable: false,
          // Checked before the request is built: nothing was sent.
          dispatched: false,
        });
      }

      // This adapter has nowhere to put an effort setting. The three levels that
      // have always run here still run, and a level that cannot travel stops the
      // turn instead of disappearing from it — a dropped setting and an honoured
      // one look exactly alike afterwards.
      effortForTurn({
        provider: "deepseek",
        model: options.model,
        requested: options.thinking,
      });

      const startedAt = Date.now();
      const providerConfig = options.providerConfig ?? {};
      const configuredBaseUrl = stringConfig(providerConfig.base_url);
      const apiUrl = resolveChatCompletionsUrl(
        configuredBaseUrl
          ? assertProviderBaseUrl(configuredBaseUrl, { providerName: "deepseek" })
          : DEFAULT_API_URL,
      );
      const temperature = numberConfig(providerConfig.temperature);
      const maxTokens =
        numberConfig(providerConfig.max_tokens) ??
        numberConfig(providerConfig.max_output_tokens);
      const extraBody = recordConfig(providerConfig.extra_body);

      const body: Record<string, unknown> = {
        // Spread first so nothing in a user-supplied `extra_body` can displace
        // a field this provider is responsible for. It used to be spread last,
        // where `extra_body: { stream: true }` produced an SSE body that was
        // then handed to `response.json()` and silently returned nothing —
        // and where `stream: false` would now switch the display stream off.
        ...(extraBody ?? {}),
        model: options.model,
        // Streamed so partial text can reach the display channel. The
        // response's own content type still decides how it is read, because
        // `stream: true` is a request and not every endpoint honours it.
        stream: true,
        // Without this a streamed OpenAI-compatible response carries no usage
        // at all, so the turn would be recorded as costing zero tokens.
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: options.systemPrompt },
          { role: "user", content: options.userMessage },
        ],
      };

      if (temperature !== undefined) body.temperature = temperature;
      if (maxTokens !== undefined) body.max_tokens = maxTokens;

      logProviderStart(options, "deepseek", `POST ${apiUrl}`);

      try {
        const response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          // A streamed body outlives the response headers, so the bound has to
          // cover the whole read, and it has to compose with the caller's
          // signal rather than replace it: cancelling a turn must still cancel
          // the request.
          signal: combineAbortSignals(
            AbortSignal.timeout(PROVIDER_HTTP_REQUEST_TIMEOUT_MS),
            options.signal,
          ),
        });

        const streamed =
          response.ok &&
          (response.headers.get("content-type") ?? "").includes(
            "text/event-stream",
          )
            ? await readChatCompletionsStream({
                response,
                provider: "deepseek",
                fallbackModel: options.model,
                ...whenDefined(options.onProtocolEvent, (definedValue) => ({
                  onProtocolEvent: definedValue,
                })),
              })
            : undefined;
        const json: ChatCompletionsBody | null = streamed
          ? streamed.body
          : await readChatCompletionsBody(response);
        if (!response.ok) {
          const message =
            json?.error?.message ||
            `DeepSeek API request failed with status ${response.status}`;
          logProviderFailure(options, "deepseek", message, {
            http_status: response.status,
            api_url: apiUrl,
          });
          const code = json?.error?.code ?? json?.error?.type;
          const classification = classifyProviderError({
            provider: "deepseek",
            statusCode: response.status,
            ...whenDefined(typeof code === "string" ? code : undefined, (definedValue) => ({ code: definedValue })),
            message,
            retryAfterHeader: response.headers.get("retry-after"),
          });
          throw new ProviderError({
            provider: "deepseek",
            message,
            statusCode: response.status,
            ...whenDefined(typeof code === "string" ? code : undefined, (definedValue) => ({ code: definedValue })),
            retryable: classification.retryable,
            ...whenDefined(classification.retryAfterMs, (definedValue) => ({ retryAfterMs: definedValue })),
          });
        }

        // A body nobody could parse is a different operational problem from a
        // reply that came back empty, and the two need different fixes, so they
        // are reported apart rather than collapsed into one message.
        if (!json) {
          const unreadable =
            "DeepSeek returned a response body that could not be read as JSON.";
          logProviderFailure(options, "deepseek", unreadable, {
            http_status: response.status,
          });
          throw new ProviderError({
            provider: "deepseek",
            message: unreadable,
            retryable: true,
          });
        }

        // A body that arrived with HTTP 200 can still be a response the model
        // never finished. Checked before any result is built, so partial text
        // cannot become a handoff artifact.
        const truncation = detectProviderTruncation(json);
        if (truncation !== undefined) {
          logProviderFailure(options, "deepseek", truncation, { http_status: response.status });
          throw truncatedProviderError("deepseek", truncation);
        }

        const text = extractChatCompletionsText(
          json?.choices?.[0]?.message?.content,
        );
        // The body parsed, but nothing in it is an answer: a mis-shaped
        // choices array, or content made only of refusal or image parts. That
        // is not an empty answer, it is a response nobody can use, and it used
        // to reach the transcript as an empty assistant message.
        if (!text.trim()) {
          const emptyMessage =
            "DeepSeek returned a response with no assistant text.";
          logProviderFailure(options, "deepseek", emptyMessage, {
            http_status: response.status,
          });
          throw new ProviderError({
            provider: "deepseek",
            message: emptyMessage,
            retryable: true,
          });
        }
        const usage = json?.usage ?? {};
        const inputTokens = usage.prompt_tokens ?? 0;
        const outputTokens = usage.completion_tokens ?? 0;
        const contextTokens = usage.total_tokens ?? inputTokens + outputTokens;
        const billedModel = json?.model || options.model;
        const usageCost = calculateUsageCost({
          provider: "deepseek",
          model: billedModel,
          inputTokens,
          outputTokens,
          providerConfig,
        });

        const result: ProviderResult = {
          text,
          cost: usageCost.cost,
          durationMs: Date.now() - startedAt,
          inputTokens,
          outputTokens,
          contextTokens,
          model: billedModel,
          costTracked: usageCost.tracked,
          costSource: usageCost.source,
        };
        logProviderSuccess(
          options,
          "deepseek",
          result,
          `HTTP ${response.status}`,
        );
        return result;
      } catch (err) {
        if (err instanceof ProviderError) {
          throw err;
        }
        if (
          err instanceof Error &&
          !err.message.startsWith("Provider 'deepseek' failed:")
        ) {
          logProviderFailure(options, "deepseek", err.message, {
            api_url: apiUrl,
          });
        }
        throw new ProviderError({
          provider: "deepseek",
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
        });
      }
    },
  };
}

function resolveChatCompletionsUrl(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions")
    ? trimmed
    : `${trimmed}/chat/completions`;
}

function stringConfig(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberConfig(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function recordConfig(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
