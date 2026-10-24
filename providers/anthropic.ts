/**
 * Anthropic Provider
 *
 * Dispatches agent runs directly to Anthropic's Messages API using API-key
 * auth from ANTHROPIC_API_KEY, avoiding subscription/OAuth-based CLI flows.
 */

import {
  extractAnthropicMessagesText,
  readAnthropicMessagesBody,
  readMessagesStream,
  type AnthropicMessagesBody,
} from "./messages-stream.js";
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
import {
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_THINKING_BUDGETS,
} from "./anthropic-thinking-defaults.js";

const DEFAULT_API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_API_VERSION = "2023-06-01";

// Shared with the setting-compatibility check, which must not disagree with
// what this adapter actually sends.
const THINKING_BUDGETS = ANTHROPIC_THINKING_BUDGETS;
const DEFAULT_MAX_TOKENS = ANTHROPIC_DEFAULT_MAX_TOKENS;

export function createAnthropicProvider(): Provider {
  return {
    name: "anthropic",

    async execute(options: ProviderExecuteOptions): Promise<ProviderResult> {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        const message =
          "Provider 'anthropic' requires ANTHROPIC_API_KEY in the environment.";
        logProviderFailure(options, "anthropic", message);
        throw new ProviderError({
          provider: "anthropic",
          message,
          // Typed, because the taxonomy is what later decides whether the
          // selection itself is the problem and whether anything could have
          // run before this point. Nothing was sent.
          kind: "authentication",
          retryable: false,
          // Nothing was sent: this is checked before the request is built.
          dispatched: false,
        });
      }

      const startedAt = Date.now();
      const providerConfig = options.providerConfig ?? {};
      const configuredBaseUrl = stringConfig(providerConfig.base_url);
      const apiUrl = configuredBaseUrl
        ? assertProviderBaseUrl(configuredBaseUrl, { providerName: "anthropic" })
        : DEFAULT_API_URL;
      const apiVersion =
        stringConfig(providerConfig.api_version) || DEFAULT_API_VERSION;
      // The selected id is sent unchanged. A vendor alias the user chose
      // stays an alias; nothing here rewrites it to another model.
      const model = options.model;
      // The level this pair will accept, or nothing when the author asked for
      // the vendor's own default. This adapter still expresses depth as a
      // thinking budget rather than as `output_config.effort`, so the levels it
      // can honour are the ones that table names; anything else is refused
      // rather than silently dropped. Moving this adapter onto the effort
      // parameter is a separate migration.
      const effort = effortForTurn({
        provider: "anthropic",
        model: options.model,
        requested: options.thinking,
      });
      // An explicit `off` wins over a `thinking_budget` written earlier. Both
      // express depth on this provider, and the level is the newer and more
      // specific instruction: honouring the older field would answer the
      // opposite of what the file now asks for, with nothing on screen to say
      // so. `provider-default` leaves the written budget alone, because that
      // setting is the vendor default this agent chose for itself.
      const thinkingBudget =
        effort === "off"
          ? 0
          : numberConfig(providerConfig.thinking_budget) ??
            (effort === undefined ? 0 : THINKING_BUDGETS[effort]);
      const maxTokens =
        numberConfig(providerConfig.max_tokens) ??
        DEFAULT_MAX_TOKENS[effort && effort !== "off" ? effort : "medium"];
      const temperature = numberConfig(providerConfig.temperature);

      const body: Record<string, unknown> = {
        model,
        // Streamed so partial text can reach the display channel. The
        // response's own content type still decides how it is read, because
        // `stream: true` is a request and not every endpoint honours it.
        stream: true,
        system: options.systemPrompt,
        max_tokens: maxTokens,
        messages: [
          {
            role: "user",
            content: options.userMessage,
          },
        ],
      };

      if (temperature !== undefined) {
        body.temperature = temperature;
      }

      if (thinkingBudget && thinkingBudget > 0) {
        body.thinking = {
          type: "enabled",
          budget_tokens: thinkingBudget,
        };
      }

      logProviderStart(options, "anthropic", `POST ${apiUrl}`);

      try {
        const response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": apiVersion,
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
            ? await readMessagesStream({
                response,
                provider: "anthropic",
                fallbackModel: model,
                ...whenDefined(options.onProtocolEvent, (definedValue) => ({
                  onProtocolEvent: definedValue,
                })),
              })
            : undefined;
        const json: AnthropicMessagesBody | null = streamed
          ? streamed.body
          : await readAnthropicMessagesBody(response);
        if (!response.ok) {
          const message =
            json?.error?.message ||
            `Anthropic API request failed with status ${response.status}`;
          logProviderFailure(options, "anthropic", message, {
            http_status: response.status,
            api_url: apiUrl,
          });
          const code = json?.error?.code ?? json?.error?.type;
          const classification = classifyProviderError({
            provider: "anthropic",
            statusCode: response.status,
            ...whenDefined(typeof code === "string" ? code : undefined, (definedValue) => ({ code: definedValue })),
            message,
            retryAfterHeader: response.headers.get("retry-after"),
          });
          throw new ProviderError({
            provider: "anthropic",
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
            "Anthropic returned a response body that could not be read as JSON.";
          logProviderFailure(options, "anthropic", unreadable, {
            http_status: response.status,
          });
          throw new ProviderError({
            provider: "anthropic",
            message: unreadable,
            retryable: true,
          });
        }

        // A body that arrived with HTTP 200 can still be a response the model
        // never finished. Checked before any result is built, so partial text
        // cannot become a handoff artifact.
        const truncation = detectProviderTruncation(json);
        if (truncation !== undefined) {
          logProviderFailure(options, "anthropic", truncation, { http_status: response.status });
          throw truncatedProviderError("anthropic", truncation);
        }

        const text = extractAnthropicMessagesText(json);
        // The body parsed, but nothing in it is an answer: a mis-shaped
        // content array, or blocks that are all thinking and tool use. That is
        // not an empty answer, it is a response nobody can use, and it used to
        // reach the transcript as an empty assistant message.
        if (!text.trim()) {
          const emptyMessage =
            "Anthropic returned a response with no text content.";
          logProviderFailure(options, "anthropic", emptyMessage, {
            http_status: response.status,
          });
          throw new ProviderError({
            provider: "anthropic",
            message: emptyMessage,
            retryable: true,
          });
        }

        const usage = json?.usage ?? {};
        const inputTokens = usage.input_tokens ?? 0;
        const outputTokens = usage.output_tokens ?? 0;
        const contextTokens =
          inputTokens +
          outputTokens +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0);
        const billedModel = json?.model || model;
        const usageCost = calculateUsageCost({
          provider: "anthropic",
          model: billedModel,
          inputTokens:
            inputTokens +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0),
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
          "anthropic",
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
          !err.message.startsWith("Provider 'anthropic' failed:")
        ) {
          logProviderFailure(options, "anthropic", err.message, {
            api_url: apiUrl,
          });
        }
        throw new ProviderError({
          provider: "anthropic",
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
