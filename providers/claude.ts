import { whenDefined } from '../core/optional-properties.js'
import { anthropicImageBlocks } from './image-content.js'
import { modelImagesSchema } from '../contracts/model-image.js'
import * as fs from "node:fs";
import * as path from "node:path";

import {
  createTextCliProvider,
  requireValidMcpBridge,
  type CliInvocation,
  type ParsedCliResult,
} from "./text-cli.js";
import type { ProviderExecuteOptions } from "./types.js";
import { ProviderError } from "../domains/provider/provider-error.js";
import { effortForTurn } from "../domains/provider/effort-support.js";
import { readClaudeProgress } from './claude-progress.js';

/**
 * Every record type this CLI writes on the stream-json transport. Seeing any
 * one of them proves the turn is speaking the protocol, which is what makes a
 * missing terminal `result` a failure rather than an invitation to read raw
 * stdout as the answer.
 *
 * `control_request` and `control_response` belong to the bidirectional control
 * protocol, which requires `--input-format stream-json`. Image turns use that
 * input format; text-only turns retain plain stdin. A record arriving after a
 * terminal result is still treated as the stream continuing, which fails safe.
 */
const CLAUDE_STREAM_RECORD_TYPES: ReadonlySet<string> = new Set([
  "system",
  "user",
  "assistant",
  "stream_event",
  "result",
  "control_request",
  "control_response",
]);

export function createClaudeProvider() {
  return createTextCliProvider({
    name: "claude",
    command: "claude",
    installHint: "Install Claude Code and run `claude auth login`.",
    unsetEnvironment: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
    buildInvocation: buildClaudeInvocation,
    parseResult: parseClaudeJsonResult,
    readAnswerDelta: readClaudeAnswerDelta,
    readProgress: readClaudeProgress,
  });
}

/**
 * `--effort`, or nothing at all.
 *
 * Claude Code has no flag value meaning "your own default", so an author who
 * asks for that gets a command line with no effort flag on it. A level this
 * binary would refuse never reaches the argument list: `effortForTurn` throws
 * first, which is what keeps a rejected choice from becoming a spawned process
 * and a confusing CLI error.
 */
function effortArgs(options: ProviderExecuteOptions): string[] {
  const effort = effortForTurn({
    provider: "claude",
    model: options.model,
    requested: options.thinking,
  });
  return effort ? ["--effort", effort] : [];
}

function buildClaudeInvocation(
  options: ProviderExecuteOptions,
  tmpDir: string,
): CliInvocation {
  const images = modelImagesSchema.parse(options.images ?? [])
  const stdin = images.length > 0
    ? `${JSON.stringify({ type: 'user', message: { role: 'user', content: anthropicImageBlocks(options.userMessage, images) } })}\n`
    : options.userMessage
  const systemPromptPath = path.join(tmpDir, "system-prompt.md");
  fs.writeFileSync(systemPromptPath, options.systemPrompt, {
    encoding: "utf8",
    mode: 0o600,
  });
  const args = [
    "-p",
    ...(images.length > 0 ? ['--input-format', 'stream-json'] : []),
    // Partial messages only exist on the stream-json format, and Claude Code
    // refuses --print with stream-json unless --verbose is also passed. The
    // turn still ends with the same terminal `result` object the `json`
    // format prints on its own, which is what the stored result is built from.
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--no-session-persistence",
    // The host application owns this turn's instructions. Loading a user's or
    // repository's Claude settings and discovered instruction files on top of
    // them can exceed Haiku's Claude Code prompt budget before the user's
    // message is considered. Explicit MCP configuration is added below when
    // this turn needs tools, so no ambient setting source is required.
    "--setting-sources",
    "",
    ...(options.model && options.model !== "default"
      ? ["--model", options.model]
      : []),
    // Omitted entirely when the author asked for Claude Code's own default,
    // because there is no flag value that means "decide for yourself" — the
    // absence is the request. A level this binary does not parse never reaches
    // here: `effortForTurn` refuses the turn first.
    ...effortArgs(options),
    // Claude Code supports file-backed system prompts. Keep large application
    // instructions out of the process argument itself and in the private,
    // per-turn directory that the shared runner removes after exit.
    "--system-prompt-file",
    systemPromptPath,
    "--tools",
    "",
    ...(options.outputSchema
      ? ["--json-schema", JSON.stringify(options.outputSchema)]
      : []),
  ];

  if (!options.mcpBridge) {
    // Disabling native tools is only half of the isolation. Claude Code still
    // discovers every MCP server configured on the machine unless it is told
    // that `--mcp-config` is the complete set, so a turn the Pipeline granted
    // nothing can otherwise reach whatever integrations the operator happens
    // to have connected. An empty runtime-owned configuration under strict
    // mode is what makes "no bridge" mean no tools at all.
    args.push(
      "--strict-mcp-config",
      "--mcp-config",
      writeMcpConfig(tmpDir, {}),
    );
    return { args, stdin, ...whenDefined(options.cwd, (cwd) => ({ cwd })) };
  }

  const bridge = requireValidMcpBridge(options.mcpBridge, "claude");
  const allowedTools = bridge.proxyToolNames.map(
    (name) => `mcp__pipeline__${name}`,
  );
  args.splice(args.indexOf("--tools") + 1, 1, "ToolSearch");
  const mcpConfigPath = writeMcpConfig(tmpDir, {
    pipeline: {
      type: "http",
      url: bridge.url,
      headers: {
        Authorization: `Bearer ${bridge.token}`,
      },
    },
  });

  args.push(
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath,
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    "ToolSearch",
    ...allowedTools,
  );

  return {
    args,
    stdin,
    ...whenDefined(options.cwd, (cwd) => ({ cwd })),
  };
}

/**
 * Write this turn's complete MCP server set into its private directory and
 * return the path. The shared runner removes the directory after exit, so the
 * file — which may carry a bearer token — never outlives the process.
 */
function writeMcpConfig(
  tmpDir: string,
  mcpServers: Readonly<Record<string, unknown>>,
): string {
  const mcpConfigPath = path.join(tmpDir, "mcp.json");
  fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  return mcpConfigPath;
}

/**
 * The stream's **last** recognised record, or null when the output never spoke
 * the protocol at all.
 *
 * "Last recognised" rather than "last one of type `result`" is the whole
 * point: a result the stream then continued past is not the line the CLI ended
 * on, and reading it as one would store an answer the CLI had not finished
 * revising.
 */
function readClaudeLastStreamRecord(
  stdout: string,
): Record<string, unknown> | null {
  let lastRecord: Record<string, unknown> | null = null;
  for (const line of stdout.split("\n")) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(trimmedLine);
    } catch {
      continue;
    }
    if (!isRecord(parsedLine)) continue;
    if (
      typeof parsedLine.type === "string" &&
      CLAUDE_STREAM_RECORD_TYPES.has(parsedLine.type)
    ) {
      lastRecord = parsedLine;
    }
  }
  return lastRecord;
}

/**
 * The visible answer carried by one stdout line, or null when it carries none.
 *
 * Claude Code wraps each partial message as `{ type: 'stream_event', event }`
 * where `event` is the raw Anthropic Messages stream event. Only a
 * `content_block_delta` whose delta is a `text_delta` is committed answer
 * text: a `thinking_delta` rides the same envelope and is private, and the
 * whole `assistant` message that follows repeats what the deltas just
 * delivered.
 */
function readClaudeAnswerDelta(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== "stream_event") return null;
  const event = parsed.event;
  if (!isRecord(event) || event.type !== "content_block_delta") return null;
  const delta = event.delta;
  if (!isRecord(delta) || delta.type !== "text_delta") return null;
  if (typeof delta.text !== "string" || delta.text.length === 0) return null;
  return delta.text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A finite, non-negative number, or undefined for anything else the CLI put in
 * the field. Every value read through this is a token count, an elapsed
 * duration or a cost, and none of those can be below zero: a negative one is a
 * mis-shaped field rather than a small one, and storing it would put nonsense
 * in a budget ledger.
 */
function readNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value >= 0 ? value : undefined;
}

/**
 * A token count: finite, non-negative and **whole**.
 *
 * Separate from the reader above because the two measure different things. A
 * cost and a duration are legitimately fractional; a count of tokens is not,
 * and accepting `1.5` would put a number in a budget ledger that no meter ever
 * produced.
 */
function readTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value >= 0 ? value : undefined;
}

/** A string of any length, or undefined. */
function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A non-empty string, or undefined. */
function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * What the turn stores, decided by the terminal `result` object and nothing
 * else. The deltas are a preview and never contribute to it.
 */
function parseClaudeJsonResult(stdout: string): ParsedCliResult {
  const lastRecord = readClaudeLastStreamRecord(stdout);

  if (lastRecord === null) {
    // This output never spoke the protocol. A build that ignores the format
    // flag prints one JSON object, and anything else is plain text — the same
    // way the HTTP providers still work against an endpoint that ignores
    // `stream: true`.
    const trimmed = stdout.trim();
    if (!trimmed) return { text: "" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { text: stdout };
    }
    if (!isRecord(parsed)) return { text: stdout };
    return buildClaudeResult(parsed, trimmed);
  }

  // Past this point the turn is speaking stream-json, so its terminal line is
  // the only thing that may end it. Falling back to raw stdout here would
  // store the JSONL transport itself as the reply — a wrong answer that reads
  // like a real one, which is worse than a reported failure.
  if (lastRecord.type !== "result") {
    throw new ProviderError({
      provider: "claude",
      message:
        "Provider 'claude' did not end on a terminal result line; the answer is incomplete.",
      retryable: true,
    });
  }

  // `is_error` must say false, not merely fail to say true: 2.1.241 emits it
  // on every result, so a record that omits it is of an unknown shape.
  if (lastRecord.subtype !== "success" || lastRecord.is_error !== false) {
    const subtype =
      typeof lastRecord.subtype === "string" ? lastRecord.subtype : "unknown";
    throw new ProviderError({
      provider: "claude",
      message: `Provider 'claude' reported a terminal result of '${subtype}' rather than success.`,
      retryable: false,
    });
  }

  // No raw-JSON fallback for the text on this path: a success result carries
  // `result`, and this record is not an answer.
  const parsed = buildClaudeResult(lastRecord, "");

  // A terminal that reached success and still shows nothing has failed. The
  // shared runner would otherwise substitute its own "[No response...]"
  // prose, and a caller stores that as the agent's reply — this codebase's
  // words presented as the model's. A schema-conformed `structured_output` is
  // an answer even when `result` is absent, which is why it is checked here
  // rather than by looking at `result` alone.
  if (
    lastRecord.structured_output === undefined &&
    !parsed.text.trim()
  ) {
    throw new ProviderError({
      provider: "claude",
      message:
        "Provider 'claude' reported a successful turn with no answer in its terminal result.",
      retryable: false,
    });
  }

  return parsed;
}

/**
 * Build the turn's result from the terminal object, checking every field.
 *
 * This is an external CLI's output, so nothing it claims is known until it is
 * looked at: a field of the wrong type must neither be stored as if it were
 * right nor fail a turn whose answer is perfectly good. Each field that cannot
 * be read is simply left out, and `ParsedCliResult`'s own defaults apply — the
 * requested model, a measured duration, zero tokens, zero cost.
 */
function buildClaudeResult(
  parsed: Record<string, unknown>,
  fallbackText: string,
): ParsedCliResult {
  const usage = isRecord(parsed.usage) ? parsed.usage : undefined;
  const inputTokens = readTokenCount(usage?.input_tokens) ?? 0;
  const outputTokens = readTokenCount(usage?.output_tokens) ?? 0;

  // A schema-conformed value beats the free-text field: with --json-schema
  // the CLI guarantees it, while `result` may still carry unconstrained
  // prose on CLI versions that ignore the flag.
  const text =
    parsed.structured_output !== undefined
      ? JSON.stringify(parsed.structured_output)
      // An empty `result` is kept as an empty string rather than skipped, so
      // that it stays distinguishable from an absent one. On the stream-json
      // path the caller refuses a blank answer outright; only the legacy
      // no-protocol path still falls back to whole stdout.
      : readString(parsed.result) ?? readString(parsed.response) ?? fallbackText;

  return {
    text,
    ...whenDefined(readNonEmptyString(parsed.model), (model) => ({ model })),
    inputTokens,
    outputTokens,
    contextTokens: inputTokens + outputTokens,
    cost:
      readNonNegativeNumber(parsed.total_cost_usd) ??
      readNonNegativeNumber(parsed.cost_usd) ??
      0,
    ...whenDefined(readNonNegativeNumber(parsed.duration_ms), (durationMs) => ({
      durationMs,
    })),
  };
}
