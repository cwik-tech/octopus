import { whenDefined } from "../core/optional-properties.js"
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createProviderStallWatchdog } from './provider-stall-watchdog.js';
import { createStderrDiagnosticObserver, readCliDiagnostic } from './cli-diagnostics.js';
import { providerAbortSource } from '../contracts/provider-abort.js';
import type { AgentProgressUpdate } from '../contracts/agent-progress.js';

import { buildCliPath } from "../core/cli-path.js";
import {
  CLI_PROVIDER_MAX_STDERR_BYTES,
  CLI_PROVIDER_MAX_STDOUT_BYTES,
  SIGKILL_GRACE_PERIOD_MS,
} from "../core/constants.js";
import {
  ProviderError,
  classifyProviderError,
  parseProviderError,
} from "../domains/provider/provider-error.js";
import { buildProviderSubprocessEnvironment } from "../domains/provider/provider-subprocess-environment.js";
import {
  logProviderFailure,
  logProviderLifecycle,
  logProviderStart,
  logProviderStall,
  logProviderSuccess,
  previewText,
} from "./telemetry.js";
import type {
  Provider,
  ProviderExecuteOptions,
  ProviderMcpBridge,
  ProviderResult,
} from "./types.js";

const SHARED_CLI_STALL_REPORT_MS = 60_000;
const SHARED_CLI_STALL_ABORT_MS = 300_000;
const SHARED_CLI_STALL_POLL_MS = 15_000;

export interface CliInvocation {
  args: string[];
  stdin?: string;
  cwd?: string;
  environment?: Readonly<Record<string, string>>;
}

export interface ParsedCliResult {
  text: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  cost?: number;
  durationMs?: number;
}

export interface TextCliProviderDefinition {
  name: string;
  command: string;
  installHint: string;
  buildInvocation: (
    options: ProviderExecuteOptions,
    tmpDir: string,
  ) => CliInvocation;
  parseResult?: (stdout: string) => ParsedCliResult;
  /**
   * Opt-in reader for a CLI that writes JSONL. Every complete stdout line is
   * offered to it as it arrives, and the committed answer text it returns —
   * null for a line that carries none — is published as a display event while
   * the turn is still running. A CLI without one is unchanged: its whole
   * stdout is still parsed once, at close, by `parseResult`.
   */
  readAnswerDelta?: (line: string) => string | null;
  readProgress?: (event: unknown) => AgentProgressUpdate | undefined;
  unsetEnvironment?: string[];
}

export function createTextCliProvider(
  definition: TextCliProviderDefinition,
): Provider {
  return {
    name: definition.name,
    execute(options: ProviderExecuteOptions): Promise<ProviderResult> {
      return new Promise((resolve, reject) => {
        if (options.signal?.aborted) {
          reject(cancelledProviderError(definition.name));
          return;
        }
        const startedAt = Date.now();
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `team-${definition.name}-`));
        let invocation: CliInvocation;
        try {
          invocation = definition.buildInvocation(options, tmpDir);
        } catch (error) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          reject(error);
          return;
        }
        const cwd = invocation.cwd ?? options.cwd ?? tmpDir;

        logProviderStart(options, definition.name, `cwd=${cwd}`);

        const environment: NodeJS.ProcessEnv = {
          ...buildProviderSubprocessEnvironment({
            ...process.env,
            ...invocation.environment,
          }, Object.keys(invocation.environment ?? {})),
          PATH: buildCliPath(process.env.PATH),
        };
        for (const key of definition.unsetEnvironment ?? []) {
          delete environment[key];
        }

        const proc = spawn(definition.command, invocation.args, {
          cwd,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          env: environment,
        });

        let stdout = "";
        let stderr = "";
        // A chunk boundary can fall inside a multi-byte character. Decoding
        // each chunk on its own would replace both halves with U+FFFD and put
        // that corruption in the answer the turn stores, so the decoder holds
        // the incomplete sequence until the rest of it arrives.
        const stdoutDecoder = new StringDecoder("utf8");
        const stderrDecoder = new StringDecoder("utf8");
        const stderrDiagnostics = createStderrDiagnosticObserver(options.turnDiagnostics);
        let pendingStdoutLine = "";
        let protocolSequence = 0;
        let lastEventType: string | undefined;
        const readAnswerDelta = definition.readAnswerDelta;
        // The bridge token is a live credential the model can see, so it can
        // echo it. Storage was already redacted; the display stream was not.
        const answerRedactor = createStreamingRedactor(options.mcpBridge?.token);
        const publishText = (text: string): void => {
          // Nothing reaches a caller that has already given up on the turn,
          // including a delta that arrived in the same chunk as the one whose
          // observer cancelled.
          if (callerAborted || !text) return;
          options.onProtocolEvent?.({
            kind: "text",
            provider: definition.name,
            timestamp: new Date().toISOString(),
            model: options.model,
            text,
          });
        };
        const publishAnswerDelta =
          readAnswerDelta === undefined || options.onProtocolEvent === undefined
            ? undefined
            : (line: string): void => {
                if (!line.trim()) return;
                const delta = readAnswerDelta(line);
                if (delta === null) return;
                publishText(answerRedactor.push(delta));
              };
        const consumeStdoutText = (text: string): void => {
          if (!text) return;
          stdout += text;
          stallWatchdog.observe(Date.now());
          pendingStdoutLine += text;
          const lines = pendingStdoutLine.split("\n");
          pendingStdoutLine = lines.pop() ?? "";
          for (const line of lines) {
            recordProtocolLine(line);
            publishAnswerDelta?.(line);
          }
        };
        const recordProtocolLine = (line: string): void => {
          let event: unknown;
          try { event = JSON.parse(line); } catch { return; }
          if (typeof event !== 'object' || event === null || !('type' in event) || typeof event.type !== 'string') return;
          const eventType = redactMcpBridgeToken(event.type, options.mcpBridge);
          lastEventType = eventType;
          protocolSequence += 1;
          options.turnDiagnostics?.record({ kind: 'provider-protocol-event', eventType, sequence: protocolSequence });
          const diagnostic = readCliDiagnostic(event, 'stdout');
          if (diagnostic) options.turnDiagnostics?.record(diagnostic);
          const progress = definition.readProgress?.(event);
          if (progress && !callerAborted) options.onProtocolEvent?.({ kind: 'progress', provider: definition.name, progress });
        };
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let outputLimitExceeded: "stdout" | "stderr" | null = null;
        let spawnError: Error | null = null;
        /**
         * Tracked apart from the output-limit kill, because the two mean
         * different things and must produce different failures: this one is
         * the caller withdrawing, and it wins over whatever the child does
         * next — including exiting zero with a valid terminal after trapping
         * SIGTERM.
         */
        let callerAborted = false;
        let killStarted = false;
        let sigkillHandle: ReturnType<typeof setTimeout> | null = null;

        const killProc = () => {
          if (killStarted) return;
          killStarted = true;
          try {
            proc.kill("SIGTERM");
          } catch {
            // Process may already be gone.
          }
          sigkillHandle = setTimeout(() => {
            try {
              proc.kill("SIGKILL");
            } catch {
              // Process may already be gone.
            }
          }, SIGKILL_GRACE_PERIOD_MS);
        };

        let stallAbortIdleMs: number | undefined;
        const stallWatchdog = createProviderStallWatchdog({
          idleMs: options.stallWatchdog?.idleMs ?? SHARED_CLI_STALL_REPORT_MS,
          abortIdleMs: options.stallWatchdog?.abortIdleMs ?? SHARED_CLI_STALL_ABORT_MS,
          onStall: ({ idleMs }) => {
            options.turnDiagnostics?.record({ kind: 'provider-stalled', idleMs, aborted: false });
            logProviderStall(options, definition.name, 'stalled', idleMs);
          },
          onResume: ({ idleMs }) => logProviderStall(options, definition.name, 'resumed', idleMs),
          onAbort: ({ idleMs }) => {
            if (callerAborted || killStarted) return;
            stallAbortIdleMs = idleMs;
            options.turnDiagnostics?.record({ kind: 'provider-stalled', idleMs, aborted: true });
            logProviderStall(options, definition.name, 'aborted', idleMs);
            killProc();
          },
        });
        stallWatchdog.observe(Date.now());
        const stallTimer = setInterval(() => stallWatchdog.check(Date.now()), options.stallWatchdog?.pollMs ?? SHARED_CLI_STALL_POLL_MS);
        stallTimer.unref?.();
        proc.once('spawn', () => {
          options.onProcessStarted?.();
          options.turnDiagnostics?.record({ kind: 'provider-process-started', provider: definition.name, model: options.model });
        });

        proc.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") {
            spawnError = new ProviderError({
              provider: definition.name,
              message: `Provider '${definition.name}' requires '${definition.command}' CLI but it was not found on PATH. ${definition.installHint}`,
              // The binary is absent, which is a configuration problem and not
              // a rejected credential. Typed because a policy deciding whether
              // the *selection* is what cannot run reads the taxonomy, never
              // the prose.
              kind: "configuration",
              code: "executable_unavailable",
              retryable: false,
              // ENOENT from spawn: the process never existed, so nothing was
              // sent and nothing could have run. This is the only place that
              // can state it.
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
          const text = stderrDecoder.write(chunk);
          stderr += text;
          stderrDiagnostics.write(text);
        });

        const onCallerAbort = () => {
          callerAborted = true;
          options.turnDiagnostics?.record({ kind: 'provider-cancellation', source: providerAbortSource(options.signal?.reason), phase: 'process' });
          killProc();
        };
        if (options.signal) {
          options.signal.addEventListener("abort", onCallerAbort, { once: true });
          if (options.signal.aborted) onCallerAbort();
        }

        proc.stdin.on("error", () => {
          // The CLI may exit before reading stdin after an auth/config error.
        });
        proc.stdin.end(invocation.stdin ?? "");

        proc.on("close", (code, signal) => {
          clearInterval(stallTimer);
          if (sigkillHandle) clearTimeout(sigkillHandle);
          consumeStdoutText(stdoutDecoder.end());
          const stderrTail = stderrDecoder.end();
          stderr += stderrTail;
          stderrDiagnostics.write(stderrTail);
          stderrDiagnostics.end();
          if (pendingStdoutLine) {
            recordProtocolLine(pendingStdoutLine);
            publishAnswerDelta?.(pendingStdoutLine);
          }
          pendingStdoutLine = "";
          options.turnDiagnostics?.record({ kind: 'provider-process-exited',
            ...whenDefined(code ?? undefined, (exitCode) => ({ exitCode })),
            ...whenDefined(signal ?? undefined, (signal) => ({ signal })),
            ...whenDefined(lastEventType, (lastEventType) => ({ lastEventType })),
          });
          if (options.signal) {
            options.signal.removeEventListener("abort", onCallerAbort);
          }

          try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          } catch {
            // Ignore cleanup errors.
          }

          if (spawnError) {
            logProviderFailure(options, definition.name, spawnError.message);
            reject(spawnError);
            return;
          }

          if (outputLimitExceeded) {
            const message = `Provider '${definition.name}' exceeded the ${outputLimitExceeded} output limit.`;
            logProviderFailure(options, definition.name, message);
            reject(
              new ProviderError({
                provider: definition.name,
                message,
                retryable: false,
              }),
            );
            return;
          }

          // After the output-limit check, so that failure keeps its own
          // identity, but before everything else: a caller that withdrew gets
          // a cancellation, not a report about how the child happened to end.
          // A child can trap SIGTERM, finish its answer and exit zero, and
          // none of that revives a turn nobody is waiting for.
          if (callerAborted) {
            const cancelled = cancelledProviderError(definition.name);
            logProviderFailure(options, definition.name, cancelled.message);
            reject(cancelled);
            return;
          }

          if (stallAbortIdleMs !== undefined) {
            const failure = new ProviderError({ provider: definition.name,
              message: `Provider '${definition.name}' emitted no output for ${Math.round(stallAbortIdleMs / 1000)}s and the silent turn was aborted.`,
              kind: 'timeout', code: 'provider_stalled', retryable: true,
            });
            logProviderFailure(options, definition.name, failure.message);
            reject(failure);
            return;
          }

          if (signal) {
            const message = redactMcpBridgeToken(
              `Provider '${definition.name}' terminated by signal ${signal}`,
              options.mcpBridge,
            );
            logProviderFailure(options, definition.name, message, {
              signal,
              stderr: previewText(redactMcpBridgeToken(stderr, options.mcpBridge)),
            });
            reject(
              new ProviderError({
                provider: definition.name,
                message,
                retryable: false,
              }),
            );
            return;
          }

          if (code !== 0) {
            const failureOutput = stderr.trim() ? stderr : stdout;
            const diagnosticMessage = redactMcpBridgeToken(
              `Provider '${definition.name}' exited with code ${code}: ${failureOutput.slice(0, 500)}`,
              options.mcpBridge,
            );
            const parsedFailure = [stdout, stderr]
              .map((output) => parseProviderError(
                redactMcpBridgeToken(output, options.mcpBridge),
              ))
              .find((parsed) => parsed.hasStructuredPayload);
            const classification = parsedFailure
              ? classifyProviderError({
                  provider: definition.name,
                  ...whenDefined(parsedFailure.statusCode, (definedValue) => ({ statusCode: definedValue })),
                  ...whenDefined(parsedFailure.code, (definedValue) => ({ code: definedValue })),
                  kind: parsedFailure.kind,
                  message: parsedFailure.message,
                })
              : { retryable: false as const };
            logProviderFailure(options, definition.name, diagnosticMessage, {
              exit_code: code ?? undefined,
              stderr: previewText(redactMcpBridgeToken(stderr, options.mcpBridge)),
              stdout: previewText(redactMcpBridgeToken(stdout, options.mcpBridge)),
            });
            reject(
              new ProviderError({
                provider: definition.name,
                message: parsedFailure?.message || diagnosticMessage,
                ...whenDefined(parsedFailure?.kind, (definedValue) => ({ kind: definedValue })),
                ...whenDefined(parsedFailure?.statusCode, (definedValue) => ({ statusCode: definedValue })),
                ...whenDefined(parsedFailure?.code, (definedValue) => ({ code: definedValue })),
                retryable:
                  parsedFailure?.kind === "session_limit"
                    ? false
                    : classification.retryable,
                ...whenDefined(classification.retryAfterMs, (definedValue) => ({ retryAfterMs: definedValue })),
              }),
            );
            return;
          }

          logProviderLifecycle(options, definition.name, {
            event: "stdout.captured",
            status: "streaming",
            detail: `stdout_length=${stdout.length}`,
          });

          // A reader may refuse the output rather than describe it: a stream
          // that stopped before its protocol's terminal signal has no answer
          // to return, and inventing one from raw stdout would store the
          // transport as the reply. Its refusal has to become this turn's
          // rejection — thrown from inside a close handler it would otherwise
          // be an uncaught exception rather than a failed turn.
          let parsed: ParsedCliResult;
          try {
            parsed = definition.parseResult?.(stdout) ?? { text: stdout };
          } catch (error) {
            // A reader refuses by describing what it found, and what it found
            // is this CLI's own output — so a field the model controls can end
            // up quoted in the message, which is then logged and handed to the
            // caller. Redacted here rather than at each reader, because the
            // bridge is this runner's secret to keep.
            const failure = redactProviderError(
              error instanceof ProviderError
                ? error
                : new ProviderError({
                    provider: definition.name,
                    message:
                      error instanceof Error
                        ? error.message
                        : `Provider '${definition.name}' produced unreadable output.`,
                    retryable: false,
                  }),
              options.mcpBridge,
            );
            logProviderFailure(options, definition.name, failure.message, {
              stderr: previewText(redactMcpBridgeToken(stderr, options.mcpBridge)),
            });
            reject(failure);
            return;
          }
          const responseText = redactMcpBridgeToken(
            parsed.text ||
              `[No response. stderr: ${redactMcpBridgeToken(stderr, options.mcpBridge).slice(0, 200)}]`,
            options.mcpBridge,
          );
          const result: ProviderResult = {
            text: responseText,
            cost: parsed.cost ?? 0,
            durationMs: parsed.durationMs ?? Date.now() - startedAt,
            inputTokens: parsed.inputTokens ?? 0,
            outputTokens: parsed.outputTokens ?? 0,
            contextTokens: parsed.contextTokens ?? 0,
            // Redacted for the same reason the answer is: the model that chose
            // this string can see its own bearer token, and this field travels
            // into the stored result and into every lifecycle event built from
            // it. The requested model is this process's own value and needs no
            // redaction, but running it through the same call keeps one rule
            // rather than two.
            model: redactMcpBridgeToken(
              parsed.model ?? options.model,
              options.mcpBridge,
            ),
          };

          // Text held back because it could still have become the credential
          // is safe to release once the turn has spawned cleanly, stayed
          // inside its output limits, exited zero, and produced a terminal its
          // reader accepted — every one of those checks is above. Flushing
          // during failure cleanup would publish a credential fragment on the
          // way out of a turn that has no answer to complete.
          if (publishAnswerDelta) publishText(answerRedactor.flush());

          // The flush is the one publication that happens after the abort
          // listener was removed, so an observer cancelling *there* sets no
          // flag. Asking the signal directly is what stops that cancellation
          // being swallowed — and it has to come before the success log, so a
          // turn nobody wants is never recorded as one that worked.
          if (options.signal?.aborted) {
            const cancelled = cancelledProviderError(definition.name);
            logProviderFailure(options, definition.name, cancelled.message);
            reject(cancelled);
            return;
          }

          if (!result.text.trim()) {
            logProviderFailure(
              options,
              definition.name,
              `Provider '${definition.name}' completed without stdout text`,
              { stderr: previewText(stderr) },
            );
          } else {
            logProviderSuccess(options, definition.name, result);
          }

          resolve(result);
        });
      });
    },
  };
}

/**
 * Redacts a secret from a stream of fragments, safely across their boundaries.
 *
 * Redacting each fragment on its own is not enough: a token split over two of
 * them contains no full match in either half, so both pass through and the
 * viewer reassembles the credential. This holds back the longest suffix that
 * could still turn out to be the start of the token, releases everything else
 * immediately, and flushes the remainder once nothing more is coming.
 *
 * With no token there is nothing to hold, so fragments pass through untouched
 * and unbuffered — a provider without a bridge behaves exactly as before.
 */
function createStreamingRedactor(token: string | undefined): {
  push(text: string): string;
  flush(): string;
} {
  if (!token) {
    return { push: (text: string) => text, flush: () => "" };
  }

  let carry = "";
  return {
    push(text: string): string {
      const replaced = (carry + text).replaceAll(token, "[REDACTED]");
      let heldLength = 0;
      const longestPossibleHold = Math.min(token.length - 1, replaced.length);
      for (let length = longestPossibleHold; length > 0; length -= 1) {
        if (token.startsWith(replaced.slice(replaced.length - length))) {
          heldLength = length;
          break;
        }
      }
      carry = heldLength === 0 ? "" : replaced.slice(replaced.length - heldLength);
      return heldLength === 0
        ? replaced
        : replaced.slice(0, replaced.length - heldLength);
    },
    flush(): string {
      const remaining = carry;
      carry = "";
      return remaining;
    },
  };
}

export function cancelledProviderError(provider: string): ProviderError {
  return new ProviderError({
    provider,
    message: `Provider '${provider}' execution was cancelled.`,
    retryable: false,
  });
}

export function requireValidMcpBridge(
  bridge: ProviderMcpBridge | undefined,
  provider: string,
): ProviderMcpBridge {
  if (!bridge) {
    throw new ProviderError({
      provider,
      message: `Provider '${provider}' MCP bridge configuration is unavailable.`,
      retryable: false,
    });
  }

  let url: URL;
  try {
    url = new URL(bridge.url);
  } catch {
    throwInvalidMcpBridge(provider);
  }
  const isLoopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  if (
    !isLoopback ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  ) {
    throwInvalidMcpBridge(provider);
  }

  if (
    !/^PIPELINE_MCP_[A-Z0-9_]*$/.test(bridge.tokenEnvironmentVariable) ||
    bridge.tokenEnvironmentVariable.length > 128 ||
    !bridge.token ||
    bridge.token.length > 8_192 ||
    bridge.proxyToolNames.length === 0 ||
    new Set(bridge.proxyToolNames).size !== bridge.proxyToolNames.length ||
    bridge.proxyToolNames.some(
      (name) =>
        typeof name !== "string" ||
        !name.trim() ||
        name.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(name),
    )
  ) {
    throwInvalidMcpBridge(provider);
  }

  return bridge;
}

export function redactMcpBridgeToken(
  value: string,
  bridge: ProviderMcpBridge | undefined,
): string {
  return bridge?.token ? value.replaceAll(bridge.token, "[REDACTED]") : value;
}

/**
 * The same failure with the bridge credential taken out of its message.
 *
 * Rebuilt rather than mutated, because `Error.message` is what a logger and a
 * caller both read and the original is not this runner's to edit. Everything
 * the attempt loop and the telemetry decide from — the provider, the kind, the
 * status code, the error code, the retry policy and its delay — is carried
 * across unchanged: a redacted failure that lost its retry policy would change
 * how the run behaves, which is not what redaction is for.
 */
function redactProviderError(
  error: ProviderError,
  bridge: ProviderMcpBridge | undefined,
): ProviderError {
  const redactedMessage = redactMcpBridgeToken(error.providerMessage, bridge);
  if (redactedMessage === error.providerMessage) return error;
  return new ProviderError({
    provider: error.provider,
    message: redactedMessage,
    ...whenDefined(error.kind, (kind) => ({ kind })),
    ...whenDefined(error.statusCode, (statusCode) => ({ statusCode })),
    ...whenDefined(error.code, (code) => ({ code })),
    retryable: error.retryable,
    ...whenDefined(error.retryAfterMs, (retryAfterMs) => ({ retryAfterMs })),
    // Rebuilt field by field, so anything omitted here is silently lost. An
    // undispatched refusal that travelled through redaction would become an
    // unknown one, and unknown refuses the retry it had earned.
    ...whenDefined(error.dispatched, (dispatched) => ({ dispatched })),
  });
}

function throwInvalidMcpBridge(provider: string): never {
  throw new ProviderError({
    provider,
    message: `Provider '${provider}' MCP bridge configuration is invalid.`,
    retryable: false,
  });
}
