import { whenDefined } from "../../core/optional-properties.js"
import * as fs from "node:fs";
import * as path from "node:path";
import type { ProviderEvent } from "../../core/types.js";
import { appendJsonl, getAssignmentLogPath } from "./logger.js";
import type {
  ProviderProtocolEvent,
  ProviderProtocolEventKind,
} from "../../contracts/provider.js";

export const RAW_TRANSCRIPT_SCHEMA_VERSION = 1 as const;
export const CANONICAL_TRANSCRIPT_SCHEMA_VERSION = 1 as const;
export const CANONICAL_TRANSCRIPT_PARSER_VERSION = 1 as const;

const RAW_TRANSCRIPT_LOG_FILENAME = "transcript-raw.jsonl";
const CANONICAL_TRANSCRIPT_LOG_FILENAME = "transcript-events.jsonl";

export type CanonicalTranscriptKind = ProviderProtocolEventKind;

export interface RawTranscriptEvent {
  schema_version: typeof RAW_TRANSCRIPT_SCHEMA_VERSION;
  timestamp: string;
  provider: string;
  source: "provider" | "runtime";
  sequence?: number;
  raw_type?: string;
  session_id?: string;
  root_session_id?: string;
  agent_name?: string;
  model?: string;
  raw: Record<string, unknown>;
}

export interface CanonicalTranscriptEvent {
  schema_version: typeof CANONICAL_TRANSCRIPT_SCHEMA_VERSION;
  parser_version: typeof CANONICAL_TRANSCRIPT_PARSER_VERSION;
  timestamp: string;
  kind: CanonicalTranscriptKind;
  provider: string;
  session_id?: string;
  root_session_id?: string;
  agent_name?: string;
  model?: string;
  text?: string;
  raw_type?: string;
  payload: Record<string, unknown>;
}

type ProjectedCanonicalTranscriptEvent = Omit<
  CanonicalTranscriptEvent,
  "schema_version" | "parser_version"
>;

export function getRawTranscriptLogPath(outputDir: string): string {
  return getAssignmentLogPath(outputDir, RAW_TRANSCRIPT_LOG_FILENAME);
}

export function getCanonicalTranscriptLogPath(outputDir: string): string {
  return getAssignmentLogPath(outputDir, CANONICAL_TRANSCRIPT_LOG_FILENAME);
}

export function appendRawTranscriptEvent(
  outputDir: string | undefined,
  event: Omit<RawTranscriptEvent, "schema_version" | "timestamp"> & {
    timestamp?: string;
  },
): RawTranscriptEvent | null {
  if (!outputDir) return null;

  const envelope: RawTranscriptEvent = {
    schema_version: RAW_TRANSCRIPT_SCHEMA_VERSION,
    timestamp: event.timestamp ?? new Date().toISOString(),
    ...event,
  };

  appendJsonl(getRawTranscriptLogPath(outputDir), envelope, { mode: 0o600 });
  for (const canonicalEvent of projectRawTranscriptEvent(envelope)) {
    appendCanonicalTranscriptEvent(outputDir, canonicalEvent);
  }
  return envelope;
}

export function appendCanonicalTranscriptEvent(
  outputDir: string | undefined,
  event: Omit<CanonicalTranscriptEvent, "schema_version" | "parser_version">,
): CanonicalTranscriptEvent | null {
  if (!outputDir) return null;

  const envelope: CanonicalTranscriptEvent = {
    schema_version: CANONICAL_TRANSCRIPT_SCHEMA_VERSION,
    parser_version: CANONICAL_TRANSCRIPT_PARSER_VERSION,
    ...event,
  };

  appendJsonl(getCanonicalTranscriptLogPath(outputDir), envelope, {
    mode: 0o600,
  });
  return envelope;
}

export function appendProviderProtocolTranscriptEvent(
  outputDir: string | undefined,
  event: ProviderProtocolEvent,
  context: {
    sessionId?: string;
    rootSessionId?: string;
    agentName?: string;
    model?: string;
    sequence?: number;
  } = {},
): RawTranscriptEvent | null {
  return appendRawTranscriptEvent(outputDir, {
    ...whenDefined(event.timestamp, (definedValue) => ({ timestamp: definedValue })),
    provider: event.provider,
    source: "provider",
    ...whenDefined(context.sequence, (definedValue) => ({ sequence: definedValue })),
    raw_type: event.rawType ?? event.kind,
    ...whenDefined(context.sessionId, (definedValue) => ({ session_id: definedValue })),
    ...whenDefined(context.rootSessionId, (definedValue) => ({ root_session_id: definedValue })),
    ...whenDefined(context.agentName, (definedValue) => ({ agent_name: definedValue })),
    ...whenDefined(event.model ?? context.model, (definedValue) => ({ model: definedValue })),
    raw: {
      kind: event.kind,
      text: event.text,
      cost: event.cost,
      duration_ms: event.durationMs,
      input_tokens: event.inputTokens,
      output_tokens: event.outputTokens,
      context_tokens: event.contextTokens,
      ...(event.raw ?? {}),
    },
  });
}

export function appendProviderLifecycleTranscriptEvent(
  outputDir: string | undefined,
  event: ProviderEvent,
): RawTranscriptEvent | null {
  return appendRawTranscriptEvent(outputDir, {
    timestamp: event.timestamp,
    provider: event.provider,
    source: "provider",
    raw_type: event.event,
    ...whenDefined(event.session_id, (definedValue) => ({ session_id: definedValue })),
    ...whenDefined(event.root_session_id, (definedValue) => ({ root_session_id: definedValue })),
    ...whenDefined(event.agent_name, (definedValue) => ({ agent_name: definedValue })),
    ...whenDefined(event.model, (definedValue) => ({ model: definedValue })),
    raw: { ...event },
  });
}

export function projectRawTranscriptEvent(
  rawEvent: RawTranscriptEvent,
): ProjectedCanonicalTranscriptEvent[] {
  const raw = rawEvent.raw;
  const kindFromRaw = typeof raw.kind === "string" ? raw.kind : undefined;
  const rawType = rawEvent.raw_type ?? kindFromRaw ?? "";
  const base = {
    timestamp: rawEvent.timestamp,
    provider: rawEvent.provider,
    ...whenDefined(rawEvent.session_id, (session_id) => ({ session_id })),
    ...whenDefined(rawEvent.root_session_id, (root_session_id) => ({ root_session_id })),
    ...whenDefined(rawEvent.agent_name, (agent_name) => ({ agent_name })),
    ...whenDefined(rawEvent.model, (model) => ({ model })),
    raw_type: rawType,
  };

  if (kindFromRaw && isCanonicalKind(kindFromRaw)) {
    const text = typeof raw.text === "string" ? raw.text : undefined;
    return [
      {
        ...base,
        kind: kindFromRaw,
        ...whenDefined(text, (definedValue) => ({ text: definedValue })),
        payload: raw,
      },
    ];
  }

  if (rawType === "request.start") {
    return [{ ...base, kind: "lifecycle", payload: raw }];
  }

  if (rawType === "request.fail") {
    return [{ ...base, kind: "error", payload: raw }];
  }

  if (rawType === "request.end") {
    const resultRaw = asRecord(raw.raw);
    const events: ProjectedCanonicalTranscriptEvent[] = [
      {
        ...base,
        kind: "complete",
        ...whenDefined(typeof resultRaw.text_preview === "string"
            ? resultRaw.text_preview
            : undefined, (definedValue) => ({ text: definedValue })),
        payload: raw,
      },
    ];

    if (
      typeof resultRaw.input_tokens === "number" ||
      typeof resultRaw.output_tokens === "number" ||
      typeof resultRaw.context_tokens === "number" ||
      typeof resultRaw.cost === "number"
    ) {
      events.push({
        ...base,
        kind: "usage",
        payload: resultRaw,
      });
    }

    return events;
  }

  if (rawType === "item.completed") {
    const item = asRecord(raw.item);
    const text =
      typeof item.text === "string"
        ? item.text
        : typeof asRecord(item.formatted_text).text === "string"
          ? String(asRecord(item.formatted_text).text)
          : undefined;
    return [{ ...base, kind: text ? "text" : "lifecycle", ...whenDefined(text, (definedValue) => ({ text: definedValue })), payload: raw }];
  }

  if (rawType === "turn.completed") {
    return [{ ...base, kind: "usage", payload: asRecord(raw.usage) }];
  }

  return [{ ...base, kind: "lifecycle", payload: raw }];
}

export function rebuildCanonicalTranscript(
  outputDir: string,
): CanonicalTranscriptEvent[] {
  const rawPath = getRawTranscriptLogPath(outputDir);
  const canonicalPath = getCanonicalTranscriptLogPath(outputDir);
  const rebuilt: CanonicalTranscriptEvent[] = [];

  if (!fs.existsSync(rawPath)) {
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, "");
    return rebuilt;
  }

  const rawEvents = fs
    .readFileSync(rawPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as RawTranscriptEvent;
      } catch {
        return null;
      }
    })
    .filter((event): event is RawTranscriptEvent => Boolean(event));

  fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
  fs.writeFileSync(canonicalPath, "");
  for (const rawEvent of rawEvents) {
    for (const projected of projectRawTranscriptEvent(rawEvent)) {
      const canonical = appendCanonicalTranscriptEvent(outputDir, projected);
      if (canonical) rebuilt.push(canonical);
    }
  }

  return rebuilt;
}

function isCanonicalKind(value: string): value is CanonicalTranscriptKind {
  return [
    "lifecycle",
    "text",
    "reasoning",
    "tool_call",
    "tool_result",
    "usage",
    "error",
    "complete",
  ].includes(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
