/**
 * LM Studio Provider
 *
 * Dispatches agent runs to LM Studio's local REST API using streaming SSE on
 * `POST /api/v1/chat`. This gives explicit request / model-load / prompt-
 * processing / generation lifecycle events that we log into provider-events.jsonl.
 */

import { whenDefined } from "../core/optional-properties.js"
import type {
  Provider,
  ProviderExecuteOptions,
  ProviderResult,
} from "./types.js";
import { logProviderLifecycle } from "./telemetry.js";
import {
  ProviderError,
  classifyProviderError,
} from "../domains/provider/provider-error.js";
import { extractSseFrames, parseSseData } from "./sse-stream.js";
import { effortForTurn } from "../domains/provider/effort-support.js";
import { isUnknownArray } from "../core/unknown-array.js";

const DEFAULT_BASE_URL = "http://localhost:1234";
const DEFAULT_CHAT_PATH = "/api/v1/chat";

type LmStudioStreamEvent = {
  type?: string;
  model_instance_id?: string;
  progress?: number;
  content?: string;
  result?: {
    model_instance_id?: string;
    response_id?: string;
    output?: Array<{ type?: string; content?: string }>;
    stats?: {
      input_tokens?: number;
      total_output_tokens?: number;
    };
  };
  error?: {
    type?: string;
    message?: string;
    code?: string;
    param?: string;
  };
  [key: string]: unknown;
};

export function createLmStudioProvider(): Provider {
  return {
    name: "lm-studio",

    async execute(options: ProviderExecuteOptions): Promise<ProviderResult> {
      // This adapter has nowhere to put an effort setting. The three levels that
      // have always run here still run, and a level that cannot travel stops the
      // turn instead of disappearing from it — a dropped setting and an honoured
      // one look exactly alike afterwards.
      effortForTurn({
        provider: "lm-studio",
        model: options.model,
        requested: options.thinking,
      });

      const startedAt = Date.now();
      const providerConfig = options.providerConfig ?? {};
      const baseUrl = stringConfig(providerConfig.base_url) || DEFAULT_BASE_URL;
      const chatPath =
        stringConfig(providerConfig.chat_path) || DEFAULT_CHAT_PATH;
      const apiUrl = new URL(chatPath, ensureTrailingSlash(baseUrl)).toString();
      const temperature = numberConfig(providerConfig.temperature);
      const maxTokens = numberConfig(providerConfig.max_tokens);

      const requestBody: Record<string, unknown> = {
        model: options.model,
        system_prompt: options.systemPrompt,
        input: options.userMessage,
        stream: true,
      };
      if (temperature !== undefined) requestBody.temperature = temperature;
      if (maxTokens !== undefined) requestBody.max_tokens = maxTokens;

      logEvent(options, {
        event: "request.start",
        status: "started",
        detail: `POST ${apiUrl}`,
      });

      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
        ...whenDefined(options.signal, (definedValue) => ({ signal: definedValue })),
      });

      if (!response.ok || !response.body) {
        const bodyText = await safeText(response);
        logEvent(options, {
          event: "request.fail",
          status: "failed",
          detail: bodyText || `HTTP ${response.status}`,
        });
        const classification = classifyProviderError({
          provider: "lm-studio",
          statusCode: response.status,
          message: bodyText || `HTTP ${response.status}`,
        });
        throw new ProviderError({
          provider: "lm-studio",
          message: bodyText || `HTTP ${response.status}`,
          statusCode: response.status,
          retryable: classification.retryable,
        });
      }

      logEvent(options, {
        event: "request.accepted",
        status: "streaming",
        detail: `HTTP ${response.status}`,
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let messageText = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let model = options.model;
      let requestId: string | undefined;
      let finalText: string | undefined;
      let streamError: string | undefined;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = extractSseFrames(buffer);
        buffer = frames.remainder;

        for (const frame of frames.events) {
          const raw = parseSseEvent(frame);
          if (!raw) continue;

          const eventType = typeof raw.type === "string" ? raw.type : "unknown";
          if (typeof raw.model_instance_id === "string") {
            model = raw.model_instance_id;
          }
          if (
            eventType === "message.delta" &&
            typeof raw.content === "string"
          ) {
            messageText += raw.content;
            // The suffix only. The caller accumulates; sending the running
            // total would make every frame O(answer length).
            options.onProtocolEvent?.({
              kind: "text",
              provider: "lm-studio",
              timestamp: new Date().toISOString(),
              model,
              text: raw.content,
              rawType: eventType,
            });
          }
          if (eventType === "chat.end" && raw.result) {
            requestId =
              typeof raw.result.response_id === "string"
                ? raw.result.response_id
                : requestId;
            if (typeof raw.result.model_instance_id === "string") {
              model = raw.result.model_instance_id;
            }
            inputTokens = raw.result.stats?.input_tokens ?? inputTokens;
            outputTokens =
              raw.result.stats?.total_output_tokens ?? outputTokens;
            finalText = extractFinalMessage(raw.result.output);
          }
          if (eventType === "error") {
            streamError = raw.error?.message || "LM Studio stream error";
          }

          logEvent(options, {
            event: eventType,
            status: mapStreamStatus(eventType),
            ...whenDefined(requestId, (definedValue) => ({ request_id: definedValue })),
            ...whenDefined(raw.model_instance_id ?? raw.result?.model_instance_id, (definedValue) => ({ model_instance_id: definedValue })),
            ...whenDefined(typeof raw.progress === "number" ? raw.progress : undefined, (definedValue) => ({ progress: definedValue })),
            ...whenDefined(streamEventDetail(raw), (definedValue) => ({ detail: definedValue })),
            raw: { ...raw },
          });
        }
      }

      const trailing = decoder.decode();
      if (trailing) {
        buffer += trailing;
        const raw = parseSseEvent(buffer.trim());
        if (raw) {
          const eventType = typeof raw.type === "string" ? raw.type : "unknown";
          logEvent(options, {
            event: eventType,
            status: mapStreamStatus(eventType),
            ...whenDefined(streamEventDetail(raw), (definedValue) => ({ detail: definedValue })),
            raw: { ...raw },
          });
        }
      }

      if (streamError) {
        logEvent(options, {
          event: "request.fail",
          status: "failed",
          ...whenDefined(requestId, (definedValue) => ({ request_id: definedValue })),
          detail: streamError,
        });
        throw new ProviderError({
          provider: "lm-studio",
          message: streamError,
          retryable: true,
        });
      }

      const text = finalText || messageText;
      // chat.end is the documented final aggregated result, so it wins over the
      // accumulated deltas. Emitting it lets a subscriber reconcile what it
      // rendered against what the store will actually hold; without this the
      // screen can keep text that never became the answer.
      options.onProtocolEvent?.({
        kind: "complete",
        provider: "lm-studio",
        timestamp: new Date().toISOString(),
        model,
        text,
        inputTokens,
        outputTokens,
        contextTokens: inputTokens + outputTokens,
        rawType: "chat.end",
      });
      logEvent(options, {
        event: "request.end",
        status: "completed",
        ...whenDefined(requestId, (definedValue) => ({ request_id: definedValue })),
        detail: "LM Studio stream completed",
      });

      return {
        text,
        cost: 0,
        durationMs: Date.now() - startedAt,
        inputTokens,
        outputTokens,
        contextTokens: inputTokens + outputTokens,
        model,
      };
    },
  };
}

function logEvent(
  options: ProviderExecuteOptions,
  event: Parameters<typeof logProviderLifecycle>[2],
): void {
  logProviderLifecycle(options, "lm-studio", event);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function stringConfig(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberConfig(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * The single boundary guard for untrusted SSE payloads.
 *
 * Returns a fresh plain record, or `undefined` for anything that is not a plain
 * object. Every nested narrowing below goes through here so no branch has to
 * assert a shape onto inbound bytes.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return { ...value };
}

/**
 * Narrow an untrusted SSE payload into a freshly constructed typed event.
 *
 * The parser returns `unknown` on purpose: asserting a shape onto inbound bytes
 * would let a malformed frame reach the accounting fields below as the wrong
 * type. Every known field is validated; anything else is carried through under
 * the index signature so the telemetry log still sees the raw payload.
 */
function toLmStudioStreamEvent(value: unknown): LmStudioStreamEvent | null {
  const record = asRecord(value);
  if (!record) return null;
  const known = new Set([
    "type",
    "model_instance_id",
    "progress",
    "content",
    "result",
    "error",
  ]);

  const event: LmStudioStreamEvent = {};
  for (const [key, entry] of Object.entries(record)) {
    if (!known.has(key)) event[key] = entry;
  }
  if (typeof record.type === "string") event.type = record.type;
  if (typeof record.model_instance_id === "string") {
    event.model_instance_id = record.model_instance_id;
  }
  if (typeof record.progress === "number") event.progress = record.progress;
  if (typeof record.content === "string") event.content = record.content;

  const resultRecord = asRecord(record.result);
  if (resultRecord) {
    const statsRecord = asRecord(resultRecord.stats);
    const output = resultRecord.output;
    event.result = {
      ...whenDefined(
        typeof resultRecord.model_instance_id === "string"
          ? resultRecord.model_instance_id
          : undefined,
        (definedValue) => ({ model_instance_id: definedValue }),
      ),
      ...whenDefined(
        typeof resultRecord.response_id === "string"
          ? resultRecord.response_id
          : undefined,
        (definedValue) => ({ response_id: definedValue }),
      ),
      ...whenDefined(
        isUnknownArray(output) ? toOutputItems(output) : undefined,
        (definedValue) => ({ output: definedValue }),
      ),
      ...whenDefined(
        statsRecord
          ? {
              ...whenDefined(
                typeof statsRecord.input_tokens === "number"
                  ? statsRecord.input_tokens
                  : undefined,
                (definedValue) => ({ input_tokens: definedValue }),
              ),
              ...whenDefined(
                typeof statsRecord.total_output_tokens === "number"
                  ? statsRecord.total_output_tokens
                  : undefined,
                (definedValue) => ({ total_output_tokens: definedValue }),
              ),
            }
          : undefined,
        (definedValue) => ({ stats: definedValue }),
      ),
    };
  }

  const errorRecord = asRecord(record.error);
  if (errorRecord) {
    event.error = {
      ...whenDefined(
        typeof errorRecord.type === "string" ? errorRecord.type : undefined,
        (definedValue) => ({ type: definedValue }),
      ),
      ...whenDefined(
        typeof errorRecord.message === "string"
          ? errorRecord.message
          : undefined,
        (definedValue) => ({ message: definedValue }),
      ),
      ...whenDefined(
        typeof errorRecord.code === "string" ? errorRecord.code : undefined,
        (definedValue) => ({ code: definedValue }),
      ),
      ...whenDefined(
        typeof errorRecord.param === "string" ? errorRecord.param : undefined,
        (definedValue) => ({ param: definedValue }),
      ),
    };
  }

  return event;
}

function toOutputItems(
  output: readonly unknown[],
): Array<{ type?: string; content?: string }> {
  const items: Array<{ type?: string; content?: string }> = [];
  for (const entry of output) {
    const entryRecord = asRecord(entry);
    if (!entryRecord) continue;
    items.push({
      ...whenDefined(
        typeof entryRecord.type === "string" ? entryRecord.type : undefined,
        (definedValue) => ({ type: definedValue }),
      ),
      ...whenDefined(
        typeof entryRecord.content === "string"
          ? entryRecord.content
          : undefined,
        (definedValue) => ({ content: definedValue }),
      ),
    });
  }
  return items;
}

function parseSseEvent(frame: string): LmStudioStreamEvent | null {
  return toLmStudioStreamEvent(parseSseData(frame));
}

function extractFinalMessage(
  output: Array<{ type?: string; content?: string }> | undefined,
): string {
  if (!Array.isArray(output)) return "";
  return output
    .filter(
      (item) => item?.type === "message" && typeof item.content === "string",
    )
    .map((item) => item.content as string)
    .join("");
}

function mapStreamStatus(
  eventType: string,
): "started" | "streaming" | "completed" | "failed" {
  if (eventType === "chat.start" || eventType.endsWith(".start"))
    return "started";
  if (eventType === "chat.end" || eventType.endsWith(".end"))
    return "completed";
  if (eventType === "error" || eventType.endsWith(".failure")) return "failed";
  return "streaming";
}

function streamEventDetail(raw: LmStudioStreamEvent): string | undefined {
  if (typeof raw.content === "string") return raw.content;
  if (typeof raw.error?.message === "string") return raw.error.message;
  if (typeof raw.progress === "number") return `progress=${raw.progress}`;
  if (typeof raw.result?.response_id === "string")
    return `response_id=${raw.result.response_id}`;
  return undefined;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
