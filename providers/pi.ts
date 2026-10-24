/**
 * Pi Provider
 *
 * Implements the Provider interface for the Pi CLI tool.
 * Extracted from the original runAgent() in domains/agent-execution/agent-runner.ts.
 *
 * Spawns: pi --mode json -p --no-session --model X --thinking Y
 *              --append-system-prompt <file> @<file>
 *
 * Parses JSONL output looking for message_end events.
 */

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Provider, ProviderExecuteOptions, ProviderResult } from './types.js'
import {
  CLI_PROVIDER_MAX_STDERR_BYTES,
  CLI_PROVIDER_MAX_STDOUT_BYTES,
  SIGKILL_GRACE_PERIOD_MS,
} from '../core/constants.js'
import { roundUsd } from '../core/budget-ledger.js'
import { logProviderFailure, logProviderLifecycle, logProviderStart, logProviderSuccess, previewText } from './telemetry.js'
import { buildPiInvocation } from '../core/pi-runtime.js'
import { buildProviderSubprocessEnvironment } from '../domains/provider/provider-subprocess-environment.js'
import { ProviderError } from '../domains/provider/provider-error.js'
import { cancelledProviderError } from './text-cli.js'
import {
  effortForTurn,
  publishedEffortSupport,
  LEGACY_EFFORT_LEVELS,
} from '../domains/provider/effort-support.js'
import {
  piModelEffortSupport,
  resolveExecutedPiPath,
} from '../domains/provider/pi-model-effort.js'

/**
 * The record the protocol ends on. Both installed versions document that
 * `agent_end` is not one — Pi may still auto-retry, auto-compact and retry, or
 * run a queued follow-up after it.
 */
const PI_AGENT_SETTLED_RECORD_TYPE = 'agent_settled'

/**
 * Every record type Pi's JSON mode writes: the session header, the
 * `AgentEvent` union from `pi-agent-core`, and the session-level events
 * `AgentSessionEvent` adds on top of it. Seeing any of them updates what the
 * stream last said, which is how "ended on `agent_settled`" is distinguished
 * from "mentioned it somewhere".
 */
const PI_STREAM_RECORD_TYPES: ReadonlySet<string> = new Set([
  'session',
  'agent_start',
  'agent_end',
  PI_AGENT_SETTLED_RECORD_TYPE,
  'turn_start',
  'turn_end',
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'queue_update',
  'compaction_start',
  'compaction_end',
  'entry_appended',
  'session_info_changed',
  'thinking_level_changed',
  'auto_retry_start',
  'auto_retry_end',
  // Also declared in the installed `AgentSessionEvent` union. A record type
  // this provider does not recognise cannot update what the stream last said,
  // so a run that carried on past its terminal would look settled.
  'summarization_retry_scheduled',
  'summarization_retry_attempt_start',
  'summarization_retry_finished',
  'bash_execution_update',
])

export function createPiProvider(): Provider {
  return {
    name: 'pi',

    execute(options: ProviderExecuteOptions): Promise<ProviderResult> {
      return new Promise((resolve, reject) => {
        // Before any side effect. A turn cancelled before it started must not
        // create a temporary directory, write the prompt to disk, emit a
        // start-of-turn log line, or run the CLI: rejecting afterwards would
        // still have paid for the turn.
        if (options.signal?.aborted) {
          reject(cancelledProviderError('pi'))
          return
        }
        // Before the temporary directory as well as before the spawn: a
        // refusal here ends the turn, and a turn that never started should
        // leave no prompt files behind. Asked of the runtime that will run this
        // turn rather than of the provider catalogue. Pi clamps a
        // level it does not support and searches *upward* first, so a request
        // for `off` against a model that cannot stop thinking comes back as
        // thinking rather than as an error. A worker process may never have
        // built a catalogue, and "we have not been told" must not become "off
        // is supported here".
        const runtime = piModelEffortSupport(resolveExecutedPiPath())
        const piSupport =
          runtime.levels.get(options.model) ??
          // Nothing established for this pair. The catalogue may still have
          // published one from the same source; where it has not, the answer is
          // the three levels every agent file already carries, so an old file
          // keeps running and a level nobody can vouch for stops the turn
          // instead of being handed to a runtime that would choose another one.
          (runtime.known || !publishedEffortSupport('pi', options.model)
            ? LEGACY_EFFORT_LEVELS
            : undefined)
        const effort = effortForTurn({
          provider: 'pi',
          model: options.model,
          requested: options.thinking,
          ...(piSupport ? { supported: piSupport } : {}),
        })

        const startedAt = Date.now()
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-agent-'))
        const promptFile = path.join(tmpDir, 'prompt.md')
        fs.writeFileSync(promptFile, options.systemPrompt)

        const messageFile = path.join(tmpDir, 'message.md')
        fs.writeFileSync(messageFile, options.userMessage)
        logProviderStart(options, 'pi', `cwd=${options.cwd ?? tmpDir}`)

        const args = [
          '--mode', 'json',
          '-p',
          '--no-session',
          ...(effort ? ['--thinking', effort] : []),
          '--append-system-prompt', promptFile,
          `@${messageFile}`, // Pi reads file contents via @file syntax
        ]

        if (options.model && options.model !== 'default') {
          // Before the prompt file and the `@message`, which Pi reads
          // positionally. Anchored on the flag rather than on a fixed index,
          // because the thinking pair ahead of it is now conditional.
          args.splice(args.indexOf('--append-system-prompt'), 0, '--model', options.model)
        }

        if (options.tools) {
          if (options.tools.length > 0) args.push('--tools', options.tools.join(','))
          else args.push('--no-tools')
        }

        // Use const so TypeScript infers ChildProcessByStdio<null, Readable, Readable>
        // (stdout and stderr are Readable, not null). ENOENT is handled in proc.on('error').
        //
        // This can refuse before anything is spawned — a bundled CLI path that
        // names a file that is not there is rejected here — and by that point
        // the temp directory and the prompt files already exist. Only the
        // construction is wrapped: a failure to build is not a failure of the
        // turn's output, and widening this would swallow errors that belong to
        // the caller.
        let invocation
        try {
          invocation = buildPiInvocation(
            args,
            buildProviderSubprocessEnvironment(),
          )
        } catch (error) {
          try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
          reject(error)
          return
        }
        const proc = spawn(invocation.command, invocation.args, {
          cwd: options.cwd ?? tmpDir,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'] as const,
          env: invocation.env,
        })

        let stderr = ''
        let enoentRejected = false

        proc.on('error', (err) => {
          if (enoentRejected) return
          enoentRejected = true
          // This is where a failed start settles the turn, so it is where the
          // caller's signal gets its listener back. Waiting for `close` would
          // be a race: the promise resolves first, and on some failures the
          // close event is the one that never comes.
          turnClosed = true
          options.signal?.removeEventListener('abort', onAbort)
          if (sigkillHandleSignal) clearTimeout(sigkillHandleSignal)
          const code = (err as NodeJS.ErrnoException).code
          try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
          if (code === 'ENOENT') {
            const message = "Provider 'pi' requires 'pi' CLI but it was not found on PATH. Install it first."
            logProviderFailure(options, 'pi', message)
            reject(new Error(message))
          } else {
            const message = `Provider 'pi' failed to start: ${err.message}`
            logProviderFailure(options, 'pi', message)
            reject(new Error(message))
          }
        })

        // Handle abort signal — SIGTERM first, then SIGKILL after grace period
        let sigkillHandleSignal: ReturnType<typeof setTimeout> | null = null
        /**
         * Set once the child has closed. A caller's signal usually outlives
         * the turn, and an abort arriving after the child is gone must not
         * schedule a kill timer: nothing would clear it, and it would hold the
         * event loop open for the whole grace period.
         */
        let turnClosed = false
        let stdoutBytes = 0
        let stderrBytes = 0
        let outputLimitExceeded: 'stdout' | 'stderr' | null = null
        /**
         * Tracked apart from the output-limit kill: that one is this provider
         * refusing a runaway child, this one is the caller withdrawing. They
         * produce different failures, and cancellation wins over whatever the
         * child does next — including exiting zero with a settled turn after
         * trapping SIGTERM.
         */
        let callerAborted = false
        /**
         * Terminate the child. Idempotent, because an output-limit kill and a
         * caller's abort can arrive together and a second call must not strand
         * a first SIGKILL timer that nothing will clear.
         */
        let killStarted = false
        const killProc = (): void => {
          if (killStarted || turnClosed) return
          killStarted = true
          try { proc.kill('SIGTERM') } catch { /* process may already be gone */ }
          sigkillHandleSignal = setTimeout(() => {
            try { proc.kill('SIGKILL') } catch { /* process may already be gone */ }
          }, SIGKILL_GRACE_PERIOD_MS)
        }
        // Named, so the close handler can take it back off. An anonymous
        // listener here leaks one live handler per turn onto a signal the
        // caller keeps.
        const onAbort = (): void => {
          callerAborted = true
          killProc()
        }
        if (options.signal) {
          options.signal.addEventListener('abort', onAbort, { once: true })
          // An abort that landed between the pre-check at the top and this
          // line fires no event — a listener attached to an already-aborted
          // signal is never called — so the window has to be closed by asking.
          if (options.signal.aborted) onAbort()
        }

        let buffer = ''
        let totalCost = 0
        let costTracked = false
        let inputTokens = 0
        let outputTokens = 0
        let contextTokens = 0
        let agentModel = options.model
        const textParts: string[] = []
        let messageEndCount = 0
        /**
         * Whether a well-formed assistant `message_end` ever arrived. Without
         * one the turn has no authority to read, so it has nothing to return.
         */
        let sawAssistantMessageEnd = false
        /**
         * The `type` of the stream's most recent recognised record. The run is
         * finished only if this ends up being `agent_settled`: seeing that
         * record somewhere is not the same as ending on it, and anything after
         * it means the run carried on past the answer that was read.
         *
         * `message_end` stays the authority for what a message contained; this
         * is the authority for whether Pi is done producing them.
         */
        let lastRecognizedType: string | null = null
        let assistantError: string | null = null
        const stdoutDecoder = new StringDecoder('utf8')
        const stderrDecoder = new StringDecoder('utf8')

        const processLine = (line: string): void => {
          if (!line.trim()) return
          let parsed: unknown
          try {
            parsed = JSON.parse(line)
          } catch {
            // Not JSON — ignore
            return
          }
          if (!isRecord(parsed)) return
          if (
            typeof parsed.type === 'string' &&
            PI_STREAM_RECORD_TYPES.has(parsed.type)
          ) {
            lastRecognizedType = parsed.type
          }

          if (parsed.type === 'message_update') {
            // Pi's JSON mode reports token growth as `message_update` lines
            // whose `assistantMessageEvent` is the pi-ai stream event. Only a
            // `text_delta` is committed answer text; `thinking_delta` and
            // `toolcall_delta` also carry a `delta` field but are not the
            // answer, and `text_end` repeats content already delivered.
            const delta = readPiTextDelta(parsed.assistantMessageEvent)
            // Nothing reaches a caller that has already given up on the turn,
            // including a delta that arrived in the same chunk as the one
            // whose observer cancelled.
            if (delta !== null && !callerAborted) {
              options.onProtocolEvent?.({
                kind: 'text',
                provider: 'pi',
                timestamp: new Date().toISOString(),
                model: agentModel,
                text: delta,
                rawType: 'message_update',
              })
            }
            return
          }

          // The protocol terminal. Both installed versions document that
          // `agent_end` is *not* one — Pi may still auto-retry, auto-compact
          // and retry, or run a queued follow-up after it — and that
          // `agent_settled` is what says Pi will not continue on its own.
          if (parsed.type === 'agent_settled') return

          if (
            parsed.type !== 'message_end' ||
            parsed.message === undefined ||
            parsed.message === null
          ) return
          messageEndCount += 1
          if (!isRecord(parsed.message)) return
          const msg = parsed.message
          if (msg.role !== 'assistant') return
          // From here this line is the turn's authority: an assistant
          // `message_end`, the only record that carries what the turn stores.
          sawAssistantMessageEnd = true
          // Whether *this* attempt failed. Pi retries automatically, so the
          // outcome is the last attempt's, not the worst one's: a failure here
          // is recorded and then cleared by a later attempt that succeeded.
          // `aborted` counts alongside `error`: the installed `StopReason`
          // union declares both, and the installed print mode treats them
          // identically — message to stderr, exit 1
          // (`dist/modes/print-mode.js:115`). The text an aborted attempt got
          // out is a fragment of a stopped run, not an answer.
          const attemptFailed =
            msg.stopReason === 'error' ||
            msg.stopReason === 'aborted' ||
            typeof msg.errorMessage === 'string'
          if (attemptFailed) {
            assistantError = typeof msg.errorMessage === 'string'
              ? msg.errorMessage
              : "Pi assistant stopped with an error"
          } else {
            assistantError = null
          }

          // A failed attempt's partial text is not part of the answer; the
          // retry that replaces it carries the text that is.
          if (!attemptFailed && Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (
                isRecord(block) &&
                block.type === 'text' &&
                typeof block.text === 'string' &&
                block.text.length > 0
              ) {
                textParts.push(block.text)
              }
            }
          }
          if (isRecord(msg.usage)) {
            const usage = msg.usage
            const costTotal = isRecord(usage.cost)
              ? readNonNegativeNumber(usage.cost.total)
              : undefined
            if (costTotal !== undefined) {
              totalCost = roundUsd(totalCost + costTotal)
              costTracked = true
            }
            inputTokens += readTokenCount(usage.input) ?? 0
            outputTokens += readTokenCount(usage.output) ?? 0
            contextTokens = readTokenCount(usage.totalTokens) ?? contextTokens
          }
          if (typeof msg.model === 'string' && msg.model.length > 0) {
            agentModel = msg.model
          }
        }

        const processStdout = (text: string): void => {
          buffer += text
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) processLine(line)
        }

        // Counted before decoding, so the bound is on what the child actually
        // sent rather than on what it decoded to.
        proc.stdout.on('data', (chunk: Buffer) => {
          stdoutBytes += chunk.byteLength
          if (stdoutBytes > CLI_PROVIDER_MAX_STDOUT_BYTES) {
            outputLimitExceeded = 'stdout'
            killProc()
            return
          }
          processStdout(stdoutDecoder.write(chunk))
        })

        proc.stderr.on('data', (chunk: Buffer) => {
          stderrBytes += chunk.byteLength
          if (stderrBytes > CLI_PROVIDER_MAX_STDERR_BYTES) {
            outputLimitExceeded = 'stderr'
            killProc()
            return
          }
          stderr += stderrDecoder.write(chunk)
        })

        proc.on('close', (code, signal) => {
          // Before the early return below: a turn that failed to spawn still
          // has to give the caller's signal its listener back and cancel any
          // pending kill, or a failed start leaks exactly what a successful
          // one used to.
          turnClosed = true
          options.signal?.removeEventListener('abort', onAbort)
          if (sigkillHandleSignal) clearTimeout(sigkillHandleSignal)
          if (enoentRejected) return // already rejected in proc.on('error')
          processStdout(stdoutDecoder.end())
          processLine(buffer)
          buffer = ''
          stderr += stderrDecoder.end()

          try {
            fs.rmSync(tmpDir, { recursive: true, force: true })
          } catch { /* ignore */ }

          // Before the signal branch: this provider killed the child itself,
          // so reporting "terminated by signal SIGTERM" would name the symptom
          // and hide the cause.
          if (outputLimitExceeded) {
            const message = `Provider 'pi' exceeded the ${outputLimitExceeded} output limit.`
            logProviderFailure(options, 'pi', message, {
              stderr: previewText(stderr),
            })
            reject(
              new ProviderError({
                provider: 'pi',
                message,
                retryable: false,
              }),
            )
            return
          }

          // After the output-limit check, so that failure keeps its own
          // identity, but before everything else: a caller that withdrew gets
          // a cancellation, not a report about how the child happened to end.
          if (callerAborted) {
            const cancelled = cancelledProviderError('pi')
            logProviderFailure(options, 'pi', cancelled.message, {
              stderr: previewText(stderr),
            })
            reject(cancelled)
            return
          }

          if (signal) {
            const message = `Provider 'pi' terminated by signal ${signal}`
            logProviderFailure(options, 'pi', message, {
              signal,
              stderr: previewText(stderr),
            })
            reject(new Error(message))
            return
          }

          if (code !== 0) {
            const message = `Provider 'pi' exited with code ${code}`
            logProviderFailure(options, 'pi', message, {
              exit_code: code,
              stderr: previewText(stderr),
            })
            reject(new Error(message))
            return
          }

          if (assistantError) {
            const message = `Provider 'pi' failed: ${assistantError}`
            logProviderFailure(options, 'pi', message, {
              stderr: previewText(stderr),
              message_end_count: messageEndCount,
            })
            // Typed, so the runtime can see whose failure it is. Retryability
            // is deliberately left where it already was: an untyped error
            // classifies as retryable, and nothing in the installed
            // `stopReason` contract shows these failures are permanent, so
            // narrowing it here would be a policy change dressed up as a
            // refactor.
            reject(
              new ProviderError({
                provider: 'pi',
                message,
                retryable: true,
              }),
            )
            return
          }

          // `message_end` is this provider's stated authority, and that has to
          // cut both ways: with no well-formed assistant `message_end` the
          // turn never reached a terminal, so there is nothing to return.
          // Resolving with a placeholder would hand a caller a string it would
          // store as the agent's reply.
          if (
            !sawAssistantMessageEnd ||
            lastRecognizedType !== PI_AGENT_SETTLED_RECORD_TYPE
          ) {
            const message = !sawAssistantMessageEnd
              ? "Provider 'pi' ended without an assistant message_end; the answer is incomplete."
              : "Provider 'pi' did not end on agent_settled; the answer is incomplete."
            logProviderFailure(options, 'pi', message, {
              stderr: previewText(stderr),
              message_end_count: messageEndCount,
            })
            // A cut stream is a transport failure, not a refusal: the same
            // prompt may well complete on a second attempt.
            reject(
              new ProviderError({
                provider: 'pi',
                message,
                retryable: true,
              }),
            )
            return
          }

          logProviderLifecycle(options, 'pi', {
            event: 'jsonl.parsed',
            status: 'streaming',
            detail: `message_end_count=${messageEndCount}`,
          })
          // A settled run that produced no assistant text has failed, and is
          // reported rather than papered over: a caller stores whatever string
          // it is given as the agent's reply, so substituting this codebase's
          // own prose would publish it as the model's words.
          const assistantAnswer = textParts.join('')
          if (!assistantAnswer.trim()) {
            const message =
              "Provider 'pi' settled without any assistant text."
            logProviderFailure(options, 'pi', message, {
              stderr: previewText(stderr),
              message_end_count: messageEndCount,
            })
            reject(
              new ProviderError({
                provider: 'pi',
                message,
                retryable: false,
              }),
            )
            return
          }

          const result: ProviderResult = {
            text: assistantAnswer,
            cost: totalCost,
            inputTokens,
            outputTokens,
            contextTokens,
            model: agentModel,
            durationMs: Date.now() - startedAt,
            costTracked,
            costSource: costTracked ? 'reported' : 'untracked',
          }
          logProviderSuccess(options, 'pi', result)
          resolve(result)
        })
      })
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A finite, non-negative number, or undefined for anything else the CLI put in
 * the field. Every value read through this is a cost, and a cost cannot be
 * below zero. `Number.isFinite` is not redundant with the type check: `1e999`
 * is valid JSON and parses to `Infinity`, which would otherwise be added
 * straight into a budget ledger.
 */
function readNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value >= 0 ? value : undefined
}

/**
 * A token count: finite, non-negative and **whole**.
 *
 * Separate from the reader above because the two measure different things. A
 * cost is legitimately fractional — a turn can cost a fraction of a cent — but
 * tokens are counted, so `12.5` is a mis-shaped field rather than a small one,
 * and summing it silently corrupts every total downstream. `Number.isInteger`
 * also rejects `Infinity` and `NaN`, so no separate finiteness check is needed.
 */
function readTokenCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  return value >= 0 ? value : undefined
}

function readPiTextDelta(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (value.type !== 'text_delta') return null
  if (typeof value.delta !== 'string' || value.delta.length === 0) return null
  return value.delta
}
