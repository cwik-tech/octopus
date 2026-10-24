import { whenDefined } from '../core/optional-properties.js'
import { createTextCliProvider, type ParsedCliResult } from "./text-cli.js";
import type { ProviderExecuteOptions } from "./types.js";
import { ProviderError } from "../domains/provider/provider-error.js";
import { effortForTurn } from "../domains/provider/effort-support.js";

/**
 * Every message type the CLI's stream-json writer emits. Seeing any one of
 * them proves this turn is speaking the protocol, which is what makes a
 * missing terminal `result` line a failure rather than an invitation to read
 * raw stdout as the answer.
 */
const QWEN_STREAM_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "system",
  "user",
  "assistant",
  "stream_event",
  "result",
]);

export function createQwenProvider() {
  return createTextCliProvider({
    name: "qwen",
    command: "qwen",
    installHint: "Install Qwen Code and configure authentication with `/auth` in `qwen`.",
    buildInvocation: (options) => ({
      args: buildQwenArgs(options),
      ...whenDefined(options.cwd, (cwd) => ({ cwd })),
    }),
    parseResult: parseQwenStreamJson,
    readAnswerDelta: readQwenAnswerDelta,
  });
}

function buildQwenArgs(options: ProviderExecuteOptions): string[] {
  // This CLI exposes no effort flag. The three levels that have always run
  // here still run; anything else stops the turn rather than being dropped on
  // the way to a command line that has no room for it.
  effortForTurn({
    provider: "qwen",
    model: options.model,
    requested: options.thinking,
  });

  const args = [
    // Partial assistant messages exist only on this format, and the flag that
    // turns them on defaults to false. It is registered by the CLI but omitted
    // from the abbreviated `--help` listing, so its absence there is not
    // evidence that it does not exist.
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--approval-mode",
    "plan",
    "--system-prompt",
    options.systemPrompt,
    "--prompt",
    options.userMessage,
  ];

  if (options.model && options.model !== "default") {
    args.unshift("--model", options.model);
  }

  return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A finite, non-negative number, or undefined for anything else the CLI put in
 * the field. Every value read through this is a token count or an elapsed
 * duration, and neither can be below zero: a negative one is a mis-shaped
 * field rather than a small one, and storing it would put nonsense in a budget
 * ledger.
 */
function readNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value >= 0 ? value : undefined;
}

/**
 * A token count: finite, non-negative and **whole**.
 *
 * Separate from the reader above because the two measure different things. A
 * duration is legitimately fractional; a count of tokens is not, and accepting
 * `1.5` would put a number in a budget ledger that no meter ever produced.
 */
function readTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value >= 0 ? value : undefined;
}

/**
 * One committed fragment of *this* turn's answer, or null for a line carrying
 * none.
 *
 * Five discriminants, each excluding something real that the CLI emits on a
 * neighbouring shape:
 *
 * - `stream_event` — `assistant` carries the whole message afterwards, which
 *   would repeat the answer the fragments just delivered.
 * - `parent_tool_use_id === null` — a subagent's text arrives on exactly this
 *   shape with a non-null parent. It is another agent talking, not this
 *   turn's reply.
 * - `content_block_delta` — `goal_state`, `message_stop` and the
 *   `content_block_start` events ride the same envelope.
 * - `text_delta` — `thinking_delta` is private reasoning and
 *   `input_json_delta` is a tool call being assembled; both are deltas, and
 *   neither is answer text.
 * - a non-empty string — an external field is a claim until it is checked.
 */
function readQwenAnswerDelta(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.type !== "stream_event") return null;
  if (parsed.parent_tool_use_id !== null) return null;
  const event = parsed.event;
  if (!isRecord(event) || event.type !== "content_block_delta") return null;
  const delta = event.delta;
  if (!isRecord(delta) || delta.type !== "text_delta") return null;
  if (typeof delta.text !== "string" || delta.text.length === 0) return null;
  return delta.text;
}

/**
 * What the turn stores, read from the terminal `result` object and nothing
 * else. The deltas are a preview: if the model revised its answer between the
 * last fragment and the terminal line, the terminal line is the one the user
 * keeps.
 *
 * Output that never spoke the protocol at all still falls back to whole
 * stdout, as it did before this provider asked for JSONL. Output that *did*
 * speak it and then stopped short does not: returning raw stdout there would
 * store the transport itself as the reply, which is a wrong answer that looks
 * like a real one.
 */
function parseQwenStreamJson(stdout: string): ParsedCliResult {
  let lastRecognizedRecord: Record<string, unknown> | null = null;

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
      QWEN_STREAM_MESSAGE_TYPES.has(parsedLine.type)
    ) {
      lastRecognizedRecord = parsedLine;
    }
  }

  if (lastRecognizedRecord === null) return { text: stdout };

  // The terminal record is the stream's *last* one, not merely the last one
  // of type `result`. A result the stream then continued past is not this
  // turn's ending, and reading it as one would store an answer the CLI had
  // not finished revising.
  const terminal =
    lastRecognizedRecord.type === "result" ? lastRecognizedRecord : null;

  if (terminal === null) {
    throw new ProviderError({
      provider: "qwen",
      message:
        "Provider 'qwen' did not end on a terminal result line; the answer is incomplete.",
      retryable: true,
    });
  }

  // `is_error` must say false, not merely fail to say true. The effective
  // success schema always emits it, so a record that omits it is of an
  // unknown shape rather than a success with a default.
  if (terminal.subtype !== "success" || terminal.is_error !== false) {
    const subtype =
      typeof terminal.subtype === "string" ? terminal.subtype : "unknown";
    throw new ProviderError({
      provider: "qwen",
      message: `Provider 'qwen' reported a terminal result of '${subtype}' rather than success.`,
      retryable: false,
    });
  }

  // A terminal that reached success and still shows nothing has failed. The
  // shared runner would otherwise substitute its own "[No response...]" prose,
  // and a caller stores that as the agent's reply — this codebase's words
  // presented as the model's.
  if (typeof terminal.result !== "string" || !terminal.result.trim()) {
    throw new ProviderError({
      provider: "qwen",
      message:
        "Provider 'qwen' reported a successful turn with no answer in its terminal result.",
      retryable: false,
    });
  }

  const usage = isRecord(terminal.usage) ? terminal.usage : undefined;
  const inputTokens = readTokenCount(usage?.input_tokens) ?? 0;
  const outputTokens = readTokenCount(usage?.output_tokens) ?? 0;

  return {
    text: terminal.result,
    ...whenDefined(
      typeof terminal.model === "string" && terminal.model.length > 0
        ? terminal.model
        : undefined,
      (model) => ({ model }),
    ),
    inputTokens,
    outputTokens,
    contextTokens:
      readTokenCount(usage?.total_tokens) ?? inputTokens + outputTokens,
    ...whenDefined(readNonNegativeNumber(terminal.duration_ms), (durationMs) => ({
      durationMs,
    })),
  };
}
