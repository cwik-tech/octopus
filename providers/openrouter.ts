/**
 * OpenRouter Provider
 *
 * Dispatches agent runs directly to OpenRouter's OpenAI-compatible chat
 * completions API using OPENROUTER_API_KEY from the environment.
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
import { effortForTurn, openAiEffortValue } from "../domains/provider/effort-support.js";

const DEFAULT_API_URL = "https://openrouter.ai/api/v1/chat/completions";

export function createOpenRouterProvider(): Provider {
  return {
    name: "openrouter",

    async execute(options: ProviderExecuteOptions): Promise<ProviderResult> {
      const apiKey = stringConfig(process.env.OPENROUTER_API_KEY);
      if (!apiKey) {
        const message =
          "Provider 'openrouter' requires OPENROUTER_API_KEY in the environment.";
        logProviderFailure(options, "openrouter", message);
        throw new ProviderError({
          provider: "openrouter",
          message,
          // Typed at the boundary that knows: a policy deciding whether
          // the *selection* was the problem cannot infer it from prose.
          kind: "authentication",
          retryable: false,
          // Checked before the request is built: nothing was sent.
          dispatched: false,
        });
      }

      const startedAt = Date.now();
      const providerConfig = options.providerConfig ?? {};
      const configuredBaseUrl = stringConfig(providerConfig.base_url);
      const apiUrl = configuredBaseUrl
        ? assertProviderBaseUrl(configuredBaseUrl, { providerName: "openrouter" })
        : DEFAULT_API_URL;
      const temperature = numberConfig(providerConfig.temperature);
      const maxTokens = numberConfig(providerConfig.max_tokens);
      const siteUrl =
        stringConfig(providerConfig.site_url) ||
        stringConfig(providerConfig.http_referer) ||
        stringConfig(process.env.OPENROUTER_SITE_URL);
      const siteTitle =
        stringConfig(providerConfig.site_name) ||
        stringConfig(providerConfig.title) ||
        stringConfig(process.env.OPENROUTER_SITE_NAME);

      const body: Record<string, unknown> = {
        model: options.model,
        // Streamed so partial text can reach the display channel. The
        // response's own content type still decides how it is read, because
        // `stream: true` is a request and not every endpoint honours it.
        stream: true,
        // OpenRouter reports what it actually billed, but only when asked. Left
        // out, the streamed usage chunk carries token counts and no `cost`, and
        // the turn is priced from a local table instead of the real charge.
        usage: { include: true },
        messages: [
          { role: "system", content: options.systemPrompt },
          { role: "user", content: options.userMessage },
        ],
      };

      if (temperature !== undefined) body.temperature = temperature;
      if (maxTokens !== undefined) body.max_tokens = maxTokens;
      // OpenRouter publishes a per-model range in its own `/models` listing,
      // which is what decides whether this level is one this model accepts.
      const effort = effortForTurn({
        provider: "openrouter",
        model: options.model,
        requested: options.thinking,
      });
      if (effort) body.reasoning_effort = openAiEffortValue(effort);

      const headers: Record<string, string> = {
        "content-type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      };

      if (siteUrl) headers["HTTP-Referer"] = siteUrl;
      if (siteTitle) headers["X-OpenRouter-Title"] = siteTitle;

      logProviderStart(options, "openrouter", `POST ${apiUrl}`);

      try {
        const response = await fetch(apiUrl, {
          method: "POST",
          headers,
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
                provider: "openrouter",
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
            `OpenRouter API request failed with status ${response.status}`;
          logProviderFailure(options, "openrouter", message, {
            http_status: response.status,
            api_url: apiUrl,
          });
          const code = json?.error?.code ?? json?.error?.type;
          const classification = classifyProviderError({
            provider: "openrouter",
            statusCode: response.status,
            ...whenDefined(typeof code === "string" ? code : undefined, (definedValue) => ({ code: definedValue })),
            message,
            retryAfterHeader: response.headers.get("retry-after"),
          });
          throw new ProviderError({
            provider: "openrouter",
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
            "OpenRouter returned a response body that could not be read as JSON.";
          logProviderFailure(options, "openrouter", unreadable, {
            http_status: response.status,
          });
          throw new ProviderError({
            provider: "openrouter",
            message: unreadable,
            retryable: true,
          });
        }

        // A body that arrived with HTTP 200 can still be a response the model
        // never finished. Checked before any result is built, so partial text
        // cannot become a handoff artifact.
        const truncation = detectProviderTruncation(json);
        if (truncation !== undefined) {
          logProviderFailure(options, "openrouter", truncation, { http_status: response.status });
          throw truncatedProviderError("openrouter", truncation);
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
            "OpenRouter returned a response with no assistant text.";
          logProviderFailure(options, "openrouter", emptyMessage, {
            http_status: response.status,
          });
          throw new ProviderError({
            provider: "openrouter",
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
          provider: "openrouter",
          model: billedModel,
          inputTokens,
          outputTokens,
          ...whenDefined(usage.cost, (definedValue) => ({ reportedCost: definedValue })),
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
          "openrouter",
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
          !err.message.startsWith("Provider 'openrouter' failed:")
        ) {
          logProviderFailure(options, "openrouter", err.message, {
            api_url: apiUrl,
          });
        }
        throw new ProviderError({
          provider: "openrouter",
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
