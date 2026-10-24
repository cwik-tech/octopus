/**
 * Gemini CLI Provider
 *
 * Dispatches agent runs via the `gemini` CLI tool (Google Gemini CLI).
 * Authentication is handled by the user's Google account via `gemini` OAuth.
 * No API key required — uses Google account subscription.
 *
 * Output: the turn runs on `--output-format stream-json`, whose JSONL
 * transport reports the answer as it is written. Usage arrives on the terminal
 * `result` line; cost is still not reported, so it stays 0.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  Provider,
  ProviderExecuteOptions,
  ProviderResult,
} from "./types.js";
import { buildCliPath } from "../core/cli-path.js";
import {
  CLI_PROVIDER_MAX_STDERR_BYTES,
  CLI_PROVIDER_MAX_STDOUT_BYTES,
  SIGKILL_GRACE_PERIOD_MS,
} from "../core/constants.js";
import {
  logProviderFailure,
  logProviderLifecycle,
  logProviderStart,
  logProviderSuccess,
  previewText,
} from "./telemetry.js";
import { ProviderError } from "../domains/provider/provider-error.js";
import { buildProviderSubprocessEnvironment } from "../domains/provider/provider-subprocess-environment.js";
import { cancelledProviderError } from "./text-cli.js";
import { effortForTurn } from "../domains/provider/effort-support.js";

/**
 * Create and return the Gemini CLI provider.
 *
 * The provider passes the combined prompt (system + user message) through
 * Gemini's non-interactive `--prompt` mode.
 */
export function createGeminiProvider(): Provider {
  return {
    name: "gemini",

    execute(options: ProviderExecuteOptions): Promise<ProviderResult> {
      return new Promise((resolve, reject) => {
        // Before any side effect. A turn cancelled before it started must not
        // create a temporary directory, write a telemetry line, or run the
        // CLI: rejecting after a spawn-then-SIGTERM would still have paid for
        // the turn.
        if (options.signal?.aborted) {
          reject(cancelledProviderError("gemini"));
          return;
        }
        // This adapter has nowhere to put an effort setting. The three levels that
        // have always run here still run, and a level that cannot travel stops the
        // turn instead of disappearing from it — a dropped setting and an honoured
        // one look exactly alike afterwards.
        effortForTurn({
          provider: "gemini",
          model: options.model,
          requested: options.thinking,
        });

        const startedAt = Date.now();
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-gemini-"));

        // Combined prompt: system instructions + blank line + user message
        const combinedPrompt = `${options.systemPrompt}\n\n${options.userMessage}`;
        logProviderStart(options, "gemini", `cwd=${options.cwd ?? tmpDir}`);

        // ── Build CLI args ─────────────────────────────────────────────────
        const args: string[] = [
          // The answer is only reported incrementally on this format. Its
          // terminal `result` line carries usage but no text, so the
          // fragments below are what the turn stores.
          "--output-format",
          "stream-json",
          "--approval-mode",
          "plan",
          "--prompt",
          combinedPrompt,
        ];
        if (options.model && options.model !== "default") {
          args.unshift("--model", options.model);
        }

        // ── Spawn ──────────────────────────────────────────────────────────
        const proc = spawn("gemini", args, {
          cwd: options.cwd ?? tmpDir,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...buildProviderSubprocessEnvironment(),
            PATH: buildCliPath(),
          },
        });

        // ── Abort / kill handling ─────────────────────────────────────────
        let sigkillHandle: ReturnType<typeof setTimeout> | null = null;
        let killStarted = false;
        /**
         * Tracked apart from the output-limit kill: that one is this provider
         * refusing a runaway child, this one is the caller withdrawing. They
         * produce different failures, and cancellation wins over whatever the
         * child does next — including exiting zero with a valid terminal after
         * trapping SIGTERM.
         *
         * Declared here rather than with the output state below because
         * `onCallerAbort` can run during registration, before that point.
         */
        let callerAborted = false;

        // Idempotent: an abort and an output-limit kill can arrive together,
        // and a second call must not strand a first SIGKILL timer that nothing
        // will clear.
        const killProc = () => {
          if (killStarted) return;
          killStarted = true;
          try {
            proc.kill("SIGTERM");
          } catch {
            /* process may already be gone */
          }
          sigkillHandle = setTimeout(() => {
            try {
              proc.kill("SIGKILL");
            } catch {
              /* process may already be gone */
            }
          }, SIGKILL_GRACE_PERIOD_MS);
        };

        const onCallerAbort = () => {
          callerAborted = true;
          killProc();
        };
        if (options.signal) {
          options.signal.addEventListener("abort", onCallerAbort, { once: true });
          // An abort that landed between the check above and this line fires
          // no event, because the listener was attached after the fact.
          if (options.signal.aborted) onCallerAbort();
        }

        // ── Output collection ─────────────────────────────────────────────
        let stdout = "";
        let stderr = "";
        let spawnError: Error | null = null;
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let outputLimitExceeded: "stdout" | "stderr" | null = null;
        // A chunk boundary can fall inside a multi-byte character. Decoding
        // each chunk on its own would replace both halves with U+FFFD and put
        // that corruption in the answer, so the decoder holds an incomplete
        // sequence until the rest of it arrives.
        const stdoutDecoder = new StringDecoder("utf8");
        const stderrDecoder = new StringDecoder("utf8");
        let pendingStdoutLine = "";
        /**
         * The answer, in order. Each fragment is appended here and published
         * in the same statement, so what the user was shown and what the turn
         * stores cannot drift apart.
         */
        const answerFragments: string[] = [];
        let sawStreamProtocol = false;
        /**
         * The `type` of the stream's most recent recognised record. The turn's
         * terminal is the *last* record, not merely the last one of type
         * `result`: a result the stream continued past is not this turn's
         * ending, and reading it as one would store an answer the CLI had not
         * finished revising.
         */
        let lastRecognizedType: string | null = null;
        let terminalStatus: string | null = null;
        let terminalStats: GeminiStreamStats | null = null;

        const consumeStdoutLine = (line: string): void => {
          if (!line.trim()) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            // Not JSONL — the format fallback in the close handler covers it.
            return;
          }
          if (!isRecord(parsed)) return;
          if (
            typeof parsed.type === "string" &&
            GEMINI_STREAM_EVENT_TYPES.has(parsed.type)
          ) {
            sawStreamProtocol = true;
            lastRecognizedType = parsed.type;
          }

          const fragment = readGeminiAnswerFragment(parsed);
          // Nothing reaches a caller that has already given up on the turn,
          // including a fragment that arrived in the same chunk as the one
          // whose observer cancelled.
          if (fragment !== null && !callerAborted) {
            answerFragments.push(fragment);
            options.onProtocolEvent?.({
              kind: "text",
              provider: "gemini",
              timestamp: new Date().toISOString(),
              model: options.model,
              text: fragment,
              rawType: "message",
            });
            return;
          }

          if (parsed.type !== "result") return;
          terminalStatus = typeof parsed.status === "string" ? parsed.status : null;
          if (terminalStatus === "success" && isRecord(parsed.stats)) {
            terminalStats = readGeminiStreamStats(parsed.stats);
          }
        };

        const consumeStdoutText = (text: string): void => {
          if (!text) return;
          stdout += text;
          pendingStdoutLine += text;
          const lines = pendingStdoutLine.split("\n");
          pendingStdoutLine = lines.pop() ?? "";
          for (const line of lines) consumeStdoutLine(line);
        };

        proc.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") {
            spawnError = new ProviderError({
              provider: "gemini",
              message:
                "Provider 'gemini' requires 'gemini' CLI but it was not found on PATH. Install it with: npm i -g @google/gemini-cli",
              // A missing binary is a configuration problem, and the taxonomy
              // is what a later policy reads to decide the selection is what
              // cannot run.
              kind: "configuration",
              retryable: false,
              // ENOENT from spawn: no process, so nothing was sent.
              dispatched: false,
            });
          } else {
            spawnError = err;
          }
        });

        proc.stdout.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.byteLength;
          if (stdoutBytes > CLI_PROVIDER_MAX_STDOUT_BYTES) {
            outputLimitExceeded = "stdout";
            killProc();
            return;
          }
          consumeStdoutText(stdoutDecoder.write(chunk));
        });

        proc.stderr.on("data", (chunk: Buffer) => {
          stderrBytes += chunk.byteLength;
          if (stderrBytes > CLI_PROVIDER_MAX_STDERR_BYTES) {
            outputLimitExceeded = "stderr";
            killProc();
            return;
          }
          stderr += stderrDecoder.write(chunk);
        });

        // ── Resolution ────────────────────────────────────────────────────
        proc.on("close", (code, signal) => {
          if (sigkillHandle) clearTimeout(sigkillHandle);
          consumeStdoutText(stdoutDecoder.end());
          stderr += stderrDecoder.end();
          if (pendingStdoutLine) {
            consumeStdoutLine(pendingStdoutLine);
            pendingStdoutLine = "";
          }

          if (options.signal) {
            options.signal.removeEventListener("abort", onCallerAbort);
          }

          try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          } catch {
            /* ignore cleanup errors */
          }

          if (spawnError) {
            logProviderFailure(options, "gemini", spawnError.message);
            reject(spawnError);
            return;
          }

          if (outputLimitExceeded) {
            const message = `Provider 'gemini' exceeded the ${outputLimitExceeded} output limit.`;
            logProviderFailure(options, "gemini", message);
            reject(
              new ProviderError({
                provider: "gemini",
                message,
                retryable: false,
              }),
            );
            return;
          }

          // After the output-limit check, so that failure keeps its own
          // identity, but before the signal and exit-code branches: this
          // provider sent that SIGTERM itself, so reporting it would name the
          // symptom and hide the cause. A caller that withdrew gets a
          // cancellation whatever the child did next.
          if (callerAborted) {
            const cancelled = cancelledProviderError("gemini");
            logProviderFailure(options, "gemini", cancelled.message, {
              stderr: previewText(stderr),
            });
            reject(cancelled);
            return;
          }

          if (signal) {
            const message = `Provider 'gemini' terminated by signal ${signal}: ${stderr.slice(0, 200)}`;
            logProviderFailure(options, "gemini", message, {
              signal,
              stderr: previewText(stderr),
            });
            reject(
              new ProviderError({
                provider: "gemini",
                message,
                retryable: false,
              }),
            );
            return;
          }

          if (code !== 0) {
            const message = `Provider 'gemini' exited with code ${code}: ${stderr.slice(0, 200)}`;
            logProviderFailure(options, "gemini", message, {
              exit_code: code,
              stderr: previewText(stderr),
            });
            reject(
              new ProviderError({
                provider: "gemini",
                message,
                retryable: false,
              }),
            );
            return;
          }

          // Once a single recognised stream-json line has been seen, this
          // turn is speaking the protocol and its terminal line is the only
          // thing that can end it. Falling back to raw stdout here would store
          // the JSONL transport itself as the reply — a wrong answer that
          // looks like a real one, which is worse than a reported failure.
          if (sawStreamProtocol && lastRecognizedType !== "result") {
            const message =
              "Provider 'gemini' did not end on a terminal result line; the answer is incomplete.";
            logProviderFailure(options, "gemini", message, {
              stderr: previewText(stderr),
            });
            reject(
              new ProviderError({
                provider: "gemini",
                message,
                retryable: true,
              }),
            );
            return;
          }

          if (sawStreamProtocol && terminalStatus !== "success") {
            const message =
              `Provider 'gemini' reported a terminal status of ` +
              `'${terminalStatus ?? "unknown"}' rather than success.`;
            logProviderFailure(options, "gemini", message, {
              stderr: previewText(stderr),
            });
            reject(
              new ProviderError({
                provider: "gemini",
                message,
                retryable: false,
              }),
            );
            return;
          }

          // The answer is the fragments: the terminal line carries no text of
          // its own. Only a turn that never spoke the protocol at all falls
          // back to whole stdout, as it did before this provider asked for
          // JSONL.
          const answerText = sawStreamProtocol
            ? answerFragments.join("")
            : stdout;

          // A turn that spoke the protocol, reached a successful terminal and
          // produced no fragments has nothing to store. The placeholder below
          // is this codebase's own prose, and a caller stores whatever it is
          // given as the agent's reply. Output that never spoke the protocol
          // keeps its legacy whole-stdout fallback, including the placeholder,
          // because an old CLI printing nothing is a different situation.
          if (sawStreamProtocol && !answerText.trim()) {
            const message = "Provider 'gemini' completed without any answer text.";
            logProviderFailure(options, "gemini", message, {
              stderr: previewText(stderr),
            });
            reject(
              new ProviderError({
                provider: "gemini",
                message,
                retryable: false,
              }),
            );
            return;
          }
          logProviderLifecycle(options, "gemini", {
            event: "stdout.captured",
            status: "streaming",
            detail:
              `stdout_length=${stdout.length}; ` +
              `answer_fragments=${answerFragments.length}; ` +
              `last_record=${lastRecognizedType ?? "none"}`,
          });
          const stats: GeminiStreamStats | null = terminalStats;
          const result: ProviderResult = {
            text: answerText || `[No response. stderr: ${stderr.slice(0, 200)}]`,
            cost: 0,
            durationMs: stats?.durationMs ?? Date.now() - startedAt,
            inputTokens: stats?.inputTokens ?? 0,
            outputTokens: stats?.outputTokens ?? 0,
            contextTokens: stats?.totalTokens ?? 0,
            model: options.model,
          };
          if (!answerText.trim()) {
            logProviderFailure(
              options,
              "gemini",
              "Provider 'gemini' completed without stdout text",
              {
                stderr: previewText(stderr),
              },
            );
          } else {
            logProviderSuccess(options, "gemini", result);
          }
          resolve(result);
        });
      });
    },
  };
}

/**
 * Simplified token counts from a terminal `result` line.
 *
 * The CLI's `convertToStreamStats` reports more than this; only the fields a
 * `ProviderResult` carries are read, and each is read as a finite number or
 * not at all.
 */
interface GeminiStreamStats {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly durationMs?: number;
}

/**
 * Every `JsonStreamEventType` the installed CLI declares. Seeing any one of
 * them is what proves this turn is speaking stream-json, which in turn is what
 * makes the absence of a terminal `result` line a failure rather than an
 * invitation to read raw stdout.
 */
const GEMINI_STREAM_EVENT_TYPES: ReadonlySet<string> = new Set([
  "init",
  "message",
  "tool_use",
  "tool_result",
  "error",
  "result",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A finite, non-negative number, or undefined for anything else the CLI put in
 * the field. Every stat read through this is an elapsed duration, which cannot
 * be below zero: a negative one is a mis-shaped field, not a small one, and
 * storing it would put nonsense in the run's timings.
 */
function readNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value >= 0 ? value : undefined;
}

/**
 * A token count: finite, non-negative and **whole**.
 *
 * Separate from the reader above because the two measure different things. An
 * elapsed duration is continuous, but tokens are counted, so `12.5` is a
 * mis-shaped field rather than a small one, and storing it silently corrupts
 * every total downstream. `Number.isInteger` also rejects `Infinity` and
 * `NaN`, so no separate finiteness check is needed.
 */
function readTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value >= 0 ? value : undefined;
}

/**
 * One committed answer fragment, or null when the line carries none.
 *
 * All four discriminants matter. The CLI emits `type: 'message'` for the
 * prompt it echoes back as well, with `role: 'user'` and no `delta`, and it
 * emits a whole assistant message with no `delta` alongside the fragments —
 * so a rule checking fewer fields would store the question, or repeat the
 * answer, or both. `tool_use`, `tool_result`, `init` and `error` lines
 * carry text of their own and are not the answer either.
 */
function readGeminiAnswerFragment(line: Record<string, unknown>): string | null {
  if (line.type !== "message") return null;
  if (line.role !== "assistant") return null;
  if (line.delta !== true) return null;
  if (typeof line.content !== "string" || line.content.length === 0) return null;
  return line.content;
}

function readGeminiStreamStats(stats: Record<string, unknown>): GeminiStreamStats {
  const inputTokens = readTokenCount(stats.input_tokens);
  const outputTokens = readTokenCount(stats.output_tokens);
  const totalTokens = readTokenCount(stats.total_tokens);
  const durationMs = readNonNegativeNumber(stats.duration_ms);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}
