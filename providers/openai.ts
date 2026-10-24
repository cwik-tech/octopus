/**
 * OpenAI Provider
 *
 * Dispatches agent runs directly to OpenAI's Responses API using
 * OPENAI_API_KEY from the environment.
 */

import {
  extractOpenAIResponsesText,
  readOpenAIResponsesBody,
  readResponsesStream,
  type OpenAIResponsesBody,
} from "./responses-stream.js";
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
import {
  effortForTurn,
  effortUnderReasoningSuppressor,
  openAiEffortValue,
  suppressedEffortConflictMessage,
} from "../domains/provider/effort-support.js";

const DEFAULT_API_URL = "https://api.openai.com/v1/responses";
const OPENAI_BASE_URL_ENV = "OPENAI_BASE_URL";

export function createOpenAIProvider(): Provider {
  return {
    name: "openai",

    async execute(options: ProviderExecuteOptions): Promise<ProviderResult> {
      const apiKey = stringConfig(process.env.OPENAI_API_KEY);
      if (!apiKey) {
        const message =
          "Provider 'openai' requires OPENAI_API_KEY in the environment.";
        logProviderFailure(options, "openai", message);
        throw new ProviderError({
          provider: "openai",
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
      const envBaseUrl = stringConfig(process.env[OPENAI_BASE_URL_ENV]);
      const apiUrl = resolveResponsesUrl(
        configuredBaseUrl
          ? assertProviderBaseUrl(configuredBaseUrl, { providerName: "openai" })
          : undefined,
        envBaseUrl
          ? assertProviderBaseUrl(envBaseUrl, {
              providerName: "openai",
              allowUnlistedHttpsHost: true,
            })
          : undefined,
      );
      const includeReasoning = providerConfig.reasoning !== false;
      const maxOutputTokens =
        numberConfig(providerConfig.max_output_tokens) ??
        numberConfig(providerConfig.max_tokens);

      const body: Record<string, unknown> = {
        model: options.model,
        // Streamed so partial text can reach the display channel. The
        // response's own content type still decides how it is read, because
        // `stream: true` is a request and not every endpoint honours it.
        stream: true,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: options.systemPrompt }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: options.userMessage }],
          },
        ],
      };

      // Asked first, and asked whatever `reasoning: false` says. That setting
      // suppresses the field; it does not answer whether the level was one
      // this pair accepts, and letting it skip the question would turn a
      // refused choice into an ordinary turn with nothing dropped visibly.
      //
      // `reasoning` is omitted entirely when the author asked for the model's
      // own default, because this API has no value that means that — and the
      // default differs by model, so choosing one here would be this
      // application inventing a policy the vendor already has.
      const effort = effortForTurn({
        provider: "openai",
        model: options.model,
        requested: options.thinking,
      });
      if (effort) {
        const outcome = includeReasoning
          ? "send"
          : effortUnderReasoningSuppressor(effort);
        if (outcome === "conflict") {
          throw new ProviderError({
            provider: "openai",
            message: suppressedEffortConflictMessage("openai", effort),
            kind: "configuration",
            retryable: false,
            dispatched: false,
          });
        }
        if (outcome === "send") {
          body.reasoning = { effort: openAiEffortValue(effort) };
        }
      }
      if (maxOutputTokens !== undefined) {
        body.max_output_tokens = maxOutputTokens;
      }

      logProviderStart(options, "openai", `POST ${apiUrl}`);

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
            ? await readResponsesStream({
                response,
                provider: "openai",
                fallbackModel: options.model,
                ...whenDefined(options.onProtocolEvent, (definedValue) => ({
                  onProtocolEvent: definedValue,
                })),
              })
            : undefined;
        const json: OpenAIResponsesBody | null = streamed
          ? streamed.body
          : await readOpenAIResponsesBody(response);
        if (!response.ok) {
          const message =
            json?.error?.message ||
            `OpenAI API request failed with status ${response.status}`;
          logProviderFailure(options, "openai", message, {
            http_status: response.status,
            api_url: apiUrl,
          });
          const code = json?.error?.code ?? json?.error?.type;
          const classification = classifyProviderError({
            provider: "openai",
            statusCode: response.status,
            ...whenDefined(typeof code === "string" ? code : undefined, (definedValue) => ({ code: definedValue })),
            message,
            retryAfterHeader: response.headers.get("retry-after"),
          });
          throw new ProviderError({
            provider: "openai",
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
            "OpenAI returned a response body that could not be read as JSON.";
          logProviderFailure(options, "openai", unreadable, {
            http_status: response.status,
          });
          throw new ProviderError({
            provider: "openai",
            message: unreadable,
            retryable: true,
          });
        }

        // A body that arrived with HTTP 200 can still be a response the model
        // never finished. Checked before any result is built, so partial text
        // cannot become a handoff artifact.
        const truncation = detectProviderTruncation(json);
        if (truncation !== undefined) {
          logProviderFailure(options, "openai", truncation, { http_status: response.status });
          throw truncatedProviderError("openai", truncation);
        }

        const text = extractOpenAIResponsesText(json);
        // The body parsed, but nothing in it is an answer: a mis-shaped
        // output array, or items carrying no text at all. That is not an empty
        // answer, it is a response nobody can use, and it used to reach the
        // transcript as an empty assistant message.
        if (!text.trim()) {
          const emptyMessage = "OpenAI returned a response with no output text.";
          logProviderFailure(options, "openai", emptyMessage, {
            http_status: response.status,
          });
          throw new ProviderError({
            provider: "openai",
            message: emptyMessage,
            retryable: true,
          });
        }
        const usage = json?.usage ?? {};
        const inputTokens = usage.input_tokens ?? 0;
        const outputTokens = usage.output_tokens ?? 0;
        const contextTokens = usage.total_tokens ?? inputTokens + outputTokens;
        const billedModel = json?.model || options.model;
        const usageCost = calculateUsageCost({
          provider: "openai",
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
          "openai",
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
          !err.message.startsWith("Provider 'openai' failed:")
        ) {
          logProviderFailure(options, "openai", err.message, {
            api_url: apiUrl,
          });
        }
        throw new ProviderError({
          provider: "openai",
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
        });
      }
    },
  };
}

function resolveResponsesUrl(
  configuredUrl: string | undefined,
  environmentBaseUrl: string | undefined,
): string {
  if (configuredUrl) return configuredUrl;
  if (!environmentBaseUrl) return DEFAULT_API_URL;

  const normalized = environmentBaseUrl.endsWith("/")
    ? environmentBaseUrl
    : `${environmentBaseUrl}/`;
  return new URL("responses", normalized).toString();
}

function stringConfig(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberConfig(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
