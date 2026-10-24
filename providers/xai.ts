/**
 * xAI Provider
 *
 * Dispatches agent runs directly to xAI's OpenAI-compatible chat completions
 * API using XAI_API_KEY from the environment.
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

const DEFAULT_API_URL = "https://api.x.ai/v1/chat/completions";

export function createXAIProvider(): Provider {
  return {
    name: "xai",

    async execute(options: ProviderExecuteOptions): Promise<ProviderResult> {
      const apiKey = stringConfig(process.env.XAI_API_KEY);
      if (!apiKey) {
        const message =
          "Provider 'xai' requires XAI_API_KEY in the environment.";
        logProviderFailure(options, "xai", message);
        throw new ProviderError({
          provider: "xai",
          message,
          // Typed at the boundary that knows, as anthropic and openrouter
          // already are: a policy deciding whether the selection was the
          // problem cannot infer it from prose.
          kind: "authentication",
          retryable: false,
          // The first statement of `execute()`: the request body does not
          // exist yet, so nothing was sent.
          dispatched: false,
        });
      }

      // This adapter has nowhere to put an effort setting. The three levels that
      // have always run here still run, and a level that cannot travel stops the
      // turn instead of disappearing from it — a dropped setting and an honoured
      // one look exactly alike afterwards.
      effortForTurn({
        provider: "xai",
        model: options.model,
        requested: options.thinking,
      });

      const startedAt = Date.now();
      const providerConfig = options.providerConfig ?? {};
      const configuredBaseUrl = stringConfig(providerConfig.base_url);
      const apiUrl = configuredBaseUrl
        ? assertProviderBaseUrl(configuredBaseUrl, { providerName: "xai" })
        : DEFAULT_API_URL;
      const temperature = numberConfig(providerConfig.temperature);
      const maxTokens = numberConfig(providerConfig.max_tokens);

      const body: Record<string, unknown> = {
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

      logProviderStart(options, "xai", `POST ${apiUrl}`);

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
                provider: "xai",
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
            `xAI API request failed with status ${response.status}`;
          logProviderFailure(options, "xai", message, {
            http_status: response.status,
            api_url: apiUrl,
          });
          const code = json?.error?.code ?? json?.error?.type;
          const classification = classifyProviderError({
            provider: "xai",
            statusCode: response.status,
            ...whenDefined(typeof code === "string" ? code : undefined, (definedValue) => ({ code: definedValue })),
            message,
            retryAfterHeader: response.headers.get("retry-after"),
          });
          throw new ProviderError({
            provider: "xai",
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
            "xAI returned a response body that could not be read as JSON.";
          logProviderFailure(options, "xai", unreadable, {
            http_status: response.status,
          });
          throw new ProviderError({
            provider: "xai",
            message: unreadable,
            retryable: true,
          });
        }

        // A body that arrived with HTTP 200 can still be a response the model
        // never finished. Checked before any result is built, so partial text
        // cannot become a handoff artifact.
        const truncation = detectProviderTruncation(json);
        if (truncation !== undefined) {
          logProviderFailure(options, "xai", truncation, { http_status: response.status });
          throw truncatedProviderError("xai", truncation);
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
            "xAI returned a response with no assistant text.";
          logProviderFailure(options, "xai", emptyMessage, {
            http_status: response.status,
          });
          throw new ProviderError({
            provider: "xai",
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
          provider: "xai",
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
        logProviderSuccess(options, "xai", result, `HTTP ${response.status}`);
        return result;
      } catch (err) {
        if (err instanceof ProviderError) {
          throw err;
        }
        if (
          err instanceof Error &&
          !err.message.startsWith("Provider 'xai' failed:")
        ) {
          logProviderFailure(options, "xai", err.message, {
            api_url: apiUrl,
          });
        }
        throw new ProviderError({
          provider: "xai",
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
        });
      }
    },
  };
}

function stringConfig(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberConfig(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
