import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { getEventListeners } from 'node:events'

import { createPiProvider } from '../../providers/pi.js'
import { PI_CLI_PATH_ENV } from '../../core/pi-runtime.js'
import { ProviderError } from '../../domains/provider/provider-error.js'
import {
  CLI_PROVIDER_MAX_STDERR_BYTES,
  CLI_PROVIDER_MAX_STDOUT_BYTES,
} from '../../core/constants.js'

/**
 * The local CLI fixtures reproduce Pi's JSONL event contract. They were first
 * checked against 0.84.1; the installed 1.3.0 serializer still supplies the
 * text deltas and final assistant message that this provider consumes.
 * These fixtures replace the CLI boundary; real managed-host compatibility is
 * exercised by team-runtime-print-mode-handover.test.ts.
 *
 * In 1.3.0, dist/modes/json-event.js toJsonEvent() removes the cumulative
 * message from message_update, retaining usage and assistantMessageEvent;
 * toJsonAssistantMessageEvent() removes partial. Final message_end events
 * retain their message, the authority for what the turn stores.
 *
 * Only text_delta belongs in the visible answer. Thinking and tool-call deltas
 * contain other content, while text_end repeats the complete text and would
 * duplicate the answer. Legacy cumulative events remain separate fixtures.
 */
const SESSION_HEADER_LINE: unknown = {
  type: 'session',
  version: 1,
  id: 'fake-session',
  timestamp: '2026-01-01T00:00:00.000Z',
  cwd: '/tmp/fake-pi-cwd',
}

const ANSWER_USAGE = {
  input: 11,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 13,
  cost: { input: 0.2, output: 0.05, cacheRead: 0, cacheWrite: 0, total: 0.25 },
}

function makeAssistantMessage(fields: {
  readonly content: readonly unknown[]
  readonly stopReason: string
  readonly usage?: unknown
}): unknown {
  return {
    role: 'assistant',
    content: fields.content,
    api: 'anthropic-messages',
    provider: 'fake',
    model: 'pi-fake-1',
    usage: fields.usage ?? ANSWER_USAGE,
    stopReason: fields.stopReason,
    timestamp: 1767225600000,
  }
}

function makeMessageUpdate(assistantMessageEvent: unknown): unknown {
  return { type: 'message_update', assistantMessageEvent }
}

const ANSWER_STREAM_LINES: readonly unknown[] = [
  SESSION_HEADER_LINE,
  {
    type: 'message_start',
    message: makeAssistantMessage({ content: [], stopReason: 'pending' }),
  },
  makeMessageUpdate({ type: 'start' }),
  makeMessageUpdate({
    type: 'thinking_delta',
    contentIndex: 0,
    delta: 'private reasoning the user must never see',
  }),
  makeMessageUpdate({ type: 'text_start', contentIndex: 1 }),
  makeMessageUpdate({ type: 'text_delta', contentIndex: 1, delta: 'Hello ' }),
  makeMessageUpdate({ type: 'text_delta', contentIndex: 1, delta: 'world' }),
  makeMessageUpdate({
    type: 'toolcall_delta',
    contentIndex: 2,
    delta: '{"command":"planning prose that is not the answer"}',
  }),
  makeMessageUpdate({ type: 'text_end', contentIndex: 1, content: 'Hello world' }),
]

const ANSWER_MESSAGE_END: unknown = {
  type: 'message_end',
  message: makeAssistantMessage({
    content: [
      { type: 'thinking', thinking: 'private reasoning the user must never see' },
      { type: 'text', text: 'Hello world' },
    ],
    stopReason: 'stop',
  }),
}

/**
 * A failure-safety deadline, not an acceptance criterion.
 *
 * The handshake tests below make delivery a precondition of the turn
 * finishing, so a regression that withheld the events would leave the fake CLI
 * waiting forever and the test would hang rather than fail. This bound turns
 * that hang into a reported failure, and `t.signal` fires with it so the
 * provider tears its child down instead of orphaning it.
 *
 * Sized against the repository's integration budget of under two seconds per
 * test rather than against how long a stall might last: these tests spawn one
 * short-lived child and finish in tens to low hundreds of milliseconds, so
 * 1500 ms is roughly an order of magnitude of headroom on the passing path
 * while still returning control quickly when the behaviour regresses. Nothing
 * on the passing path consults it, and no assertion mentions elapsed time.
 */
const HANDSHAKE_FAILSAFE_TIMEOUT_MS = 1_500

interface FakePiCliSpec {
  /** Lines the CLI writes before it is willing to finish the turn. */
  readonly beforeFinal: readonly unknown[]
  /** The `message_end` line that ends the turn. */
  readonly final: unknown
  /**
   * Written verbatim in place of `final`, for shapes `JSON.stringify` cannot
   * produce. `1e999` is valid JSON that parses to `Infinity`, and a provider
   * reading external numbers has to survive it.
   */
  readonly finalRawJson?: string
  /**
   * Whether the run reaches its protocol terminal. A real run always does, so
   * this defaults to true and every fixture gets an `agent_settled` line after
   * its final message; only a test about a run that did not settle sets it
   * false.
   */
  readonly settles?: boolean
  /**
   * When set, the CLI arms `fs.watch` on the marker's directory before it
   * writes a single line, and then refuses to write `final` — and so refuses
   * to exit — until that marker file exists. That makes the parent's delivery
   * of a mid-turn event a precondition of the turn finishing at all, with no
   * sleep, poll, or elapsed-time threshold anywhere in the handshake.
   */
  readonly releaseMarkerPath?: string
}

function writeFakePiCli(cliPath: string, spec: FakePiCliSpec): void {
  const writeCalls = spec.beforeFinal.map((line) => `write(${JSON.stringify(line)})`)
  const body =
    spec.releaseMarkerPath === undefined
      ? [...writeCalls, 'writeFinal()']
      : [
          `const releaseMarkerPath = ${JSON.stringify(spec.releaseMarkerPath)}`,
          `const releaseDirectory = ${JSON.stringify(path.dirname(spec.releaseMarkerPath))}`,
          // Armed before the first delta leaves this process, so the release
          // cannot be missed however quickly the parent reacts to a delta.
          'const watcher = fs.watch(releaseDirectory, () => {',
          '  if (!fs.existsSync(releaseMarkerPath)) return',
          '  watcher.close()',
          '  writeFinal()',
          '})',
          ...writeCalls,
        ]

  fs.writeFileSync(
    cliPath,
    [
      "const fs = require('node:fs')",
      'const write = (line) => process.stdout.write(JSON.stringify(line) + "\\n")',
      `const final = ${JSON.stringify(spec.final)}`,
      spec.finalRawJson === undefined
        ? 'const writeFinalLine = () => write(final)'
        : `const writeFinalLine = () => process.stdout.write(${JSON.stringify(spec.finalRawJson)} + "\\n")`,
      // A real run always settles, and `agent_settled` — not `message_end` —
      // is what says Pi will not auto-retry or run a queued follow-up.
      spec.settles === false
        ? 'const writeFinal = () => { writeFinalLine() }'
        : 'const writeFinal = () => { writeFinalLine(); write({ type: "agent_settled" }) }',
      ...body,
      '',
    ].join('\n'),
    { encoding: 'utf8' },
  )
}

async function withFakePiCli<T>(
  makeSpec: (releaseMarkerPath: string) => FakePiCliSpec,
  run: (releaseMarkerPath: string) => Promise<T>,
): Promise<T> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-streaming-'))
  const releaseDirectory = path.join(directory, 'handshake')
  fs.mkdirSync(releaseDirectory)
  const releaseMarkerPath = path.join(releaseDirectory, 'release')
  const cliPath = path.join(directory, 'fake-pi-cli.cjs')
  writeFakePiCli(cliPath, makeSpec(releaseMarkerPath))

  const previousCliPath = process.env[PI_CLI_PATH_ENV]
  process.env[PI_CLI_PATH_ENV] = cliPath
  try {
    return await run(releaseMarkerPath)
  } finally {
    if (previousCliPath === undefined) delete process.env[PI_CLI_PATH_ENV]
    else process.env[PI_CLI_PATH_ENV] = previousCliPath
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('Pi provider: the observer sees each text_delta while the CLI turn is still running', { timeout: HANDSHAKE_FAILSAFE_TIMEOUT_MS }, async (t) => {
  const provider = createPiProvider()

  await withFakePiCli(
    (releaseMarkerPath) => ({
      beforeFinal: ANSWER_STREAM_LINES,
      final: ANSWER_MESSAGE_END,
      releaseMarkerPath,
    }),
    async (releaseMarkerPath) => {
      const deltas: string[] = []

      // The only path to a resolved turn runs
      //   text_delta -> this observer -> release marker -> message_end ->
      //   child exit -> resolve.
      // A provider that buffered the deltas and replayed them from its close
      // handler would never create the marker, so the child would never write
      // message_end and this turn would never finish.
      const result = await provider.execute({
        systemPrompt: 'system',
        userMessage: 'user',
        model: 'default',
        thinking: 'low',
        // The handshake has no deadline of its own: a regression that withheld
        // the deltas would leave the child waiting forever. Handing the turn
        // this test's cancellation signal means an outer runner deadline, or a
        // cancelled run, tears the child down and surfaces the stall instead of
        // orphaning a blocked process. Nothing on the passing path consults it.
        signal: t.signal,
        onProtocolEvent: (event) => {
          if (event.kind !== 'text' || event.text === undefined) return
          deltas.push(event.text)
          if (deltas.length === 2) fs.writeFileSync(releaseMarkerPath, '')
        },
      })

      assert.deepEqual(
        deltas,
        ['Hello ', 'world'],
        'one ordered text event per text_delta, carrying only the new suffix; ' +
          'thinking, toolcall and text_end updates are excluded',
      )

      assert.equal(result.text, 'Hello world')
      assert.equal(result.model, 'pi-fake-1')
      assert.equal(result.inputTokens, 11)
      assert.equal(result.outputTokens, 2)
      assert.equal(result.contextTokens, 13)
      assert.equal(result.cost, 0.25)
      assert.equal(result.costTracked, true)
    },
  )
})

test('Pi provider: the final result is built from message_end alone, with no observer registered', async () => {
  const provider = createPiProvider()

  await withFakePiCli(
    () => ({ beforeFinal: ANSWER_STREAM_LINES, final: ANSWER_MESSAGE_END }),
    async () => {
      const result = await provider.execute({
        systemPrompt: 'system',
        userMessage: 'user',
        model: 'default',
        thinking: 'low',
      })

      assert.deepEqual(
        {
          text: result.text,
          model: result.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          contextTokens: result.contextTokens,
          cost: result.cost,
          costTracked: result.costTracked,
          costSource: result.costSource,
        },
        {
          text: 'Hello world',
          model: 'pi-fake-1',
          inputTokens: 11,
          outputTokens: 2,
          contextTokens: 13,
          cost: 0.25,
          costTracked: true,
          costSource: 'reported',
        },
        'streaming observation must not change what the turn stores, and the ' +
          'thinking block in the final message stays out of the stored answer',
      )
    },
  )
})

test('Pi provider: when deltas disagree with message_end, the durable message_end text wins', async () => {
  const provider = createPiProvider()

  const divergentLines: readonly unknown[] = [
    makeMessageUpdate({ type: 'text_delta', contentIndex: 0, delta: 'draft ' }),
    makeMessageUpdate({ type: 'text_delta', contentIndex: 0, delta: 'text' }),
  ]
  const divergentMessageEnd: unknown = {
    type: 'message_end',
    message: makeAssistantMessage({
      content: [{ type: 'text', text: 'final answer' }],
      stopReason: 'stop',
      usage: {
        input: 3,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 5,
        cost: { input: 0.2, output: 0.05, cacheRead: 0, cacheWrite: 0, total: 0.25 },
      },
    }),
  }

  await withFakePiCli(
    () => ({ beforeFinal: divergentLines, final: divergentMessageEnd }),
    async () => {
      const deltas: string[] = []
      const result = await provider.execute({
        systemPrompt: 'system',
        userMessage: 'user',
        model: 'default',
        thinking: 'low',
        onProtocolEvent: (event) => {
          if (event.kind === 'text' && event.text) deltas.push(event.text)
        },
      })

      assert.deepEqual(deltas, ['draft ', 'text'])
      assert.equal(result.text, 'final answer')
    },
  )
})

// ─── message_end really is the authority ───────────────────────────────────

/**
 * The provider's contract says `message_end` is the durable authority. That
 * has to cut both ways: if no valid assistant `message_end` ever arrives, the
 * turn has no authority to read and must fail, rather than resolve with a
 * placeholder that a caller would store as the agent's reply.
 */
function executePi() {
  return createPiProvider().execute({
    systemPrompt: 'system',
    userMessage: 'user',
    model: 'default',
    thinking: 'low',
  })
}

async function assertPiRejects(spec: FakePiCliSpec): Promise<void> {
  await withFakePiCli(
    () => spec,
    async () => {
      await assert.rejects(
        () => executePi(),
        (error: unknown) => {
          // A provider boundary fails with the provider's own error type, so
          // the runtime can see whose failure it is and whether to retry.
          assert.ok(
            error instanceof ProviderError,
            `expected a ProviderError, got ${String(error)}`,
          )
          assert.equal(error.provider, 'pi')
          assert.equal(
            error.retryable,
            true,
            'a cut stream may well complete on a second attempt',
          )
          assert.match(error.message, /Provider 'pi'/)
          assert.doesNotMatch(
            error.message,
            /"type":"message_update"|"role":"user"/,
            'the failure must not carry raw JSON as if it were text',
          )
          return true
        },
      )
    },
  )
}

/**
 * `message_end` says what a message contained; `agent_settled` says the run is
 * over. Both installed versions document the difference in the same words
 * (`docs/extensions.md`, 0.84.1 and 0.80.6): "`agent_end` fires when that run
 * ends, but Pi may still auto-retry, auto-compact and retry, or continue with
 * queued follow-up messages. Use `agent_settled` for status integrations that
 * need to know Pi will not continue running automatically." 0.80.6's own
 * diagram labels it "no retry/compaction/follow-up left".
 *
 * Treating an assistant `message_end` as the terminal therefore reads an
 * intermediate attempt as the outcome — either accepting a stream that was cut
 * before the run settled, or reporting a failed attempt that Pi went on to
 * retry successfully.
 */
test('Pi provider: an assistant message_end without agent_settled is not a finished run', async () => {
  await assertPiRejects({
    beforeFinal: [],
    final: {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        model: 'pi-fake-1',
        content: [{ type: 'text', text: 'an answer Pi had not settled on' }],
      },
    },
    settles: false,
  })
})

test('Pi provider: a run that continued past agent_settled has not settled', async () => {
  // Seeing `agent_settled` somewhere is not the same as ending on it. A record
  // after it means the run carried on, and the answer read before it is not
  // the one Pi finished with.
  await assertPiRejects({
    beforeFinal: [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          model: 'pi-fake-1',
          content: [{ type: 'text', text: 'an answer the run continued past' }],
        },
      },
      { type: 'agent_settled' },
    ],
    final: makeMessageUpdate({ type: 'text_delta', contentIndex: 0, delta: ' and then more' }),
    settles: false,
  })
})

test('Pi provider: an automatic retry after a failed attempt settles as the successful answer', async () => {
  await withFakePiCli(
    () => ({
      beforeFinal: [
        // The attempt that failed. Pi does not stop here.
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            stopReason: 'error',
            errorMessage: 'upstream hiccup on the first attempt',
            model: 'pi-fake-1',
            content: [],
          },
        },
        // The automatic retry that succeeded.
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            stopReason: 'stop',
            model: 'pi-fake-1',
            content: [{ type: 'text', text: 'the answer the retry produced' }],
            usage: {
              input: 11,
              output: 7,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 18,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
            },
          },
        },
      ],
      final: { type: 'agent_settled' },
    }),
    async () => {
      const result = await executePi()
      assert.equal(
        result.text,
        'the answer the retry produced',
        'the run settled successfully, so the earlier failed attempt is not the outcome',
      )
      assert.equal(result.model, 'pi-fake-1')
      assert.equal(result.inputTokens, 11)
      assert.equal(result.outputTokens, 7)
    },
  )
})

test('Pi provider: an aborted attempt is a failure, not a partial answer', async () => {
  // The installed `StopReason` union includes `aborted`, and the installed
  // print mode treats it exactly as it treats `error`: it writes the message
  // to stderr and exits 1 (`dist/modes/print-mode.js:115`). Returning the text
  // an aborted attempt managed to produce would present a fragment of a
  // stopped run as the answer.
  await assertPiRejects({
    beforeFinal: [
      makeMessageUpdate({ type: 'text_delta', contentIndex: 0, delta: 'half an ' }),
      makeMessageUpdate({ type: 'text_delta', contentIndex: 0, delta: 'answer' }),
    ],
    final: {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'aborted',
        model: 'pi-fake-1',
        content: [{ type: 'text', text: 'half an answer' }],
      },
    },
  })
})

for (const recordType of [
  'summarization_retry_scheduled',
  'summarization_retry_attempt_start',
  'summarization_retry_finished',
  'bash_execution_update',
] as const) {
  test(`Pi provider: a ${recordType} after agent_settled means the run continued`, async () => {
    // All four are declared in the installed `AgentSessionEvent` union. A
    // record type this provider does not recognise cannot update "what the
    // stream last said", so a run that carried on past its terminal looked
    // settled — the very hole the terminal rule exists to close.
    await assertPiRejects({
      beforeFinal: [
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            stopReason: 'stop',
            model: 'pi-fake-1',
            content: [{ type: 'text', text: 'an answer the run continued past' }],
          },
        },
        { type: 'agent_settled' },
      ],
      final: { type: recordType },
      settles: false,
    })
  })
}

test('Pi provider: a settled run with no assistant text is a failure, not a placeholder', async () => {
  // `[No response. stderr: …]` is this codebase's own prose. Resolving with it
  // hands a caller a string it stores as the agent's reply.
  await withFakePiCli(
    () => ({
      beforeFinal: [],
      final: {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          model: 'pi-fake-1',
          content: [],
        },
      },
    }),
    async () => {
      await assert.rejects(
        () => executePi(),
        (error: unknown) => {
          assert.ok(
            error instanceof ProviderError,
            `expected a ProviderError, got ${String(error)}`,
          )
          assert.equal(error.provider, 'pi')
          assert.doesNotMatch(
            error.message,
            /No response/,
            'the failure must not be the fabricated placeholder',
          )
          return true
        },
      )
    },
  )
})

test('Pi provider: a finished turn leaves no abort listener on the caller’s signal', async () => {
  // A caller's signal outlives the turn — node:test aborts its own after every
  // test — so a listener left behind is a live handler holding a reference to
  // a dead child, ready to schedule a kill timer nothing will clear. Counting
  // listeners states that directly, with no reference to elapsed time.
  await withFakePiCli(
    () => ({ beforeFinal: ANSWER_STREAM_LINES, final: ANSWER_MESSAGE_END }),
    async () => {
      const controller = new AbortController()
      const listenersBefore = getEventListeners(controller.signal, 'abort').length

      const result = await createPiProvider().execute({
        systemPrompt: 'system',
        userMessage: 'user',
        model: 'default',
        thinking: 'low',
        signal: controller.signal,
      })

      assert.equal(result.text, 'Hello world')
      assert.equal(
        getEventListeners(controller.signal, 'abort').length,
        listenersBefore,
        'the provider must take its abort listener back off when the turn ends',
      )

      // And an abort that arrives after the turn is over must be inert.
      controller.abort()
      assert.equal(
        getEventListeners(controller.signal, 'abort').length,
        listenersBefore,
      )
    },
  )
})

test('Pi provider: a turn whose signal is already aborted has no side effects at all', async (t) => {
  // Gemini and the shared text-CLI runner both refuse before touching
  // anything; Pi creates its temporary directory, writes the prompt and the
  // message, logs the start and spawns, and only then notices. Rejecting after
  // that would still have paid for the turn.
  //
  // `TMPDIR` is redirected at a private empty directory so "no temporary
  // directory was created" is a fact about this turn rather than a guess about
  // what else is running: `os.tmpdir()` reads it at call time.
  const realTmp = os.tmpdir()
  const privateTmp = fs.mkdtempSync(path.join(realTmp, 'pi-no-side-effects-'))
  const binDirectory = fs.mkdtempSync(path.join(realTmp, 'pi-preabort-bin-'))
  const spawnMarkerPath = path.join(binDirectory, 'spawned')
  const cliPath = path.join(binDirectory, 'fake-pi-cli.cjs')
  fs.writeFileSync(
    cliPath,
    [
      "const fs = require('node:fs')",
      // The very first statement, so its absence proves the process never ran.
      `fs.writeFileSync(${JSON.stringify(spawnMarkerPath)}, '')`,
      'process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }) + "\\n")',
      '',
    ].join('\n'),
    { encoding: 'utf8' },
  )

  const previousCliPath = process.env[PI_CLI_PATH_ENV]
  const previousTmpDir = process.env.TMPDIR
  process.env[PI_CLI_PATH_ENV] = cliPath
  process.env.TMPDIR = privateTmp

  try {
    await assert.rejects(
      () =>
        createPiProvider().execute({
          systemPrompt: 'system',
          userMessage: 'user',
          model: 'default',
          thinking: 'low',
          signal: AbortSignal.abort(),
        }),
      (error: unknown) => {
        assert.ok(
          error instanceof ProviderError,
          `expected a ProviderError, got ${String(error)}`,
        )
        assert.equal(error.provider, 'pi')
        assert.match(error.message, /cancelled/i)
        return true
      },
    )

    assert.equal(
      fs.existsSync(spawnMarkerPath),
      false,
      'a turn cancelled before it started must not run the CLI',
    )
    assert.deepEqual(
      fs.readdirSync(privateTmp),
      [],
      'and must not leave a temporary directory or a prompt file behind',
    )
  } finally {
    if (previousCliPath === undefined) delete process.env[PI_CLI_PATH_ENV]
    else process.env[PI_CLI_PATH_ENV] = previousCliPath
    if (previousTmpDir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmpDir
    fs.rmSync(privateTmp, { recursive: true, force: true })
    fs.rmSync(binDirectory, { recursive: true, force: true })
  }
})

/**
 * Gemini, Codex and the shared text-CLI runner all bound how much a child may
 * print. Pi did not: `buffer`, `stderr` and `textParts` grew for as long as the
 * CLI kept talking, so a runaway child could exhaust this process's memory
 * rather than its own.
 */
function withOversizedPiCli<T>(
  channel: 'stdout' | 'stderr',
  byteCount: number,
  run: () => Promise<T>,
): Promise<T> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-oversized-'))
  const cliPath = path.join(directory, 'fake-pi-cli.cjs')
  const settledTurn = [
    JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        model: 'pi-fake-1',
        content: [{ type: 'text', text: 'an answer nobody should be given' }],
      },
    }),
    JSON.stringify({ type: 'agent_settled' }),
    '',
  ].join('\n')

  // The child exits 0 on its own with a perfectly valid, settled turn. It does
  // not trap a signal and it does not linger, so the only thing that can fail
  // this turn is the provider noticing how much was printed — a test that
  // passed because the child was killed would prove the kill, not the cap.
  fs.writeFileSync(
    cliPath,
    [
      `process.${channel}.write(Buffer.alloc(${byteCount}, 120))`,
      // Terminate the oversized payload so the settled turn below is a line of
      // its own. Glued to the blob it would be invalid JSON, and the turn would
      // then fail for a missing `message_end` — passing the test for the wrong
      // reason and proving nothing about the cap. The newline keeps the byte
      // count above the limit either way.
      `process.${channel}.write("\\n")`,
      `process.stdout.write(${JSON.stringify(settledTurn)})`,
      '',
    ].join('\n'),
    { encoding: 'utf8' },
  )

  const previousCliPath = process.env[PI_CLI_PATH_ENV]
  process.env[PI_CLI_PATH_ENV] = cliPath
  return run().finally(() => {
    if (previousCliPath === undefined) delete process.env[PI_CLI_PATH_ENV]
    else process.env[PI_CLI_PATH_ENV] = previousCliPath
    fs.rmSync(directory, { recursive: true, force: true })
  })
}

async function assertPiOutputLimit(
  channel: 'stdout' | 'stderr',
  byteCount: number,
): Promise<void> {
  await withOversizedPiCli(channel, byteCount, async () => {
    await assert.rejects(
      () =>
        createPiProvider().execute({
          systemPrompt: 'system',
          userMessage: 'user',
          model: 'default',
          thinking: 'low',
        }),
      (error: unknown) => {
        assert.ok(
          error instanceof ProviderError,
          `expected a ProviderError, got ${String(error)}`,
        )
        assert.equal(error.provider, 'pi')
        assert.equal(
          error.retryable,
          false,
          'a child that printed too much will print too much again',
        )
        assert.match(
          error.message,
          new RegExp(`${channel} output limit`, 'i'),
          'the failure must name the channel that overflowed',
        )
        return true
      },
    )
  })
}

test('Pi provider: a turn that printed past the stdout limit is refused', async () => {
  await assertPiOutputLimit('stdout', CLI_PROVIDER_MAX_STDOUT_BYTES + 1)
})

test('Pi provider: a turn that printed past the stderr limit is refused', async () => {
  await assertPiOutputLimit('stderr', CLI_PROVIDER_MAX_STDERR_BYTES + 1)
})

test('Pi provider: a cancelled turn fails even when the child ignores SIGTERM and exits zero', async () => {
  // Cancelling only ever sent SIGTERM. A child that traps it, finishes its
  // thought and exits zero therefore produced a valid settled turn, and the
  // provider resolved success for work the caller had abandoned. The two
  // deltas share one write so the second is already in the same chunk as the
  // one whose observer cancels.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cancel-'))
  const cliPath = path.join(directory, 'fake-pi-cli.cjs')
  const wholeTurn = [
    JSON.stringify(makeMessageUpdate({ type: 'text_delta', contentIndex: 0, delta: 'first ' })),
    JSON.stringify(makeMessageUpdate({ type: 'text_delta', contentIndex: 0, delta: 'second ' })),
    JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        model: 'pi-fake-1',
        content: [{ type: 'text', text: 'a complete answer nobody is waiting for' }],
      },
    }),
    JSON.stringify({ type: 'agent_settled' }),
    '',
  ].join('\n')
  fs.writeFileSync(
    cliPath,
    [
      "process.on('SIGTERM', () => {})",
      `process.stdout.write(${JSON.stringify(wholeTurn)})`,
      '',
    ].join('\n'),
    { encoding: 'utf8' },
  )

  const previousCliPath = process.env[PI_CLI_PATH_ENV]
  process.env[PI_CLI_PATH_ENV] = cliPath
  try {
    const controller = new AbortController()
    const fragments: string[] = []

    await assert.rejects(
      () =>
        createPiProvider().execute({
          systemPrompt: 'system',
          userMessage: 'user',
          model: 'default',
          thinking: 'low',
          signal: controller.signal,
          onProtocolEvent: (event) => {
            if (event.kind !== 'text' || event.text === undefined) return
            fragments.push(event.text)
            controller.abort()
          },
        }),
      (error: unknown) => {
        assert.ok(
          error instanceof ProviderError,
          `expected a ProviderError, got ${String(error)}`,
        )
        assert.equal(error.provider, 'pi')
        assert.match(error.message, /cancelled/i)
        return true
      },
    )

    assert.deepEqual(
      fragments,
      ['first '],
      'nothing may be published after the caller cancelled, including a delta ' +
        'that had already arrived in the same chunk',
    )
  } finally {
    if (previousCliPath === undefined) delete process.env[PI_CLI_PATH_ENV]
    else process.env[PI_CLI_PATH_ENV] = previousCliPath
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('Pi provider: an abort that lands between the pre-check and the listener is not lost', async () => {
  // There is a window between "is this signal already aborted?" and the
  // listener being attached. An abort inside it fires no event — a listener
  // added to an already-aborted signal is never called — so the turn ran to
  // completion and returned an answer nobody was waiting for. Gemini, Codex
  // and the shared runner all re-check after registering; Pi did not.
  //
  // The wrapper below aborts at exactly that moment, deterministically, rather
  // than trying to hit the window by timing.
  const controller = new AbortController()
  const signal = controller.signal
  const registerListener = signal.addEventListener.bind(signal)
  let abortedDuringRegistration = false
  signal.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === 'abort' && !abortedDuringRegistration) {
      abortedDuringRegistration = true
      controller.abort()
    }
    return registerListener(type, listener, options)
  }) as typeof signal.addEventListener

  await withFakePiCli(
    () => ({ beforeFinal: ANSWER_STREAM_LINES, final: ANSWER_MESSAGE_END }),
    async () => {
      await assert.rejects(
        () =>
          createPiProvider().execute({
            systemPrompt: 'system',
            userMessage: 'user',
            model: 'default',
            thinking: 'low',
            signal,
          }),
        (error: unknown) => {
          assert.ok(
            error instanceof ProviderError,
            `expected a ProviderError, got ${String(error)}`,
          )
          assert.equal(error.provider, 'pi')
          assert.match(error.message, /cancelled/i)
          return true
        },
      )
      assert.equal(abortedDuringRegistration, true, 'the window was exercised')
    },
  )
})

test('Pi provider: a turn that cannot build its invocation cleans up after itself', async () => {
  // `buildPiInvocation` refuses when the bundled CLI path names a file that is
  // not there — but by then the temp directory, the prompt and the message are
  // already on disk, and nothing removes them. This is a different failure from
  // `spawn('pi')` reporting ENOENT: that one happens after the process exists.
  const realTmp = os.tmpdir()
  const privateTmp = fs.mkdtempSync(path.join(realTmp, 'pi-invocation-throw-'))
  const previousCliPath = process.env[PI_CLI_PATH_ENV]
  const previousTmpDir = process.env.TMPDIR
  process.env[PI_CLI_PATH_ENV] = path.join(realTmp, 'a-bundled-pi-that-is-not-there.js')
  process.env.TMPDIR = privateTmp

  try {
    await assert.rejects(() =>
      createPiProvider().execute({
        systemPrompt: 'system',
        userMessage: 'user',
        model: 'default',
        thinking: 'low',
      }),
    )
    assert.deepEqual(
      fs.readdirSync(privateTmp),
      [],
      'a turn that could not be built must not leave its prompt files behind',
    )
  } finally {
    if (previousCliPath === undefined) delete process.env[PI_CLI_PATH_ENV]
    else process.env[PI_CLI_PATH_ENV] = previousCliPath
    if (previousTmpDir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmpDir
    fs.rmSync(privateTmp, { recursive: true, force: true })
  }
})

test('Pi provider: a turn whose CLI never starts also leaves no abort listener behind', async () => {
  // A failed start used to skip the whole cleanup path, so the leak survived
  // exactly where it is least likely to be noticed.
  // The bundled-CLI path is deliberately *not* used here: pointing it at a
  // missing file throws inside `buildPiInvocation`, before spawn and before
  // the listener exists, which would pass whether or not the leak is fixed.
  // Unsetting it and emptying PATH makes `spawn('pi')` itself fail, so the
  // ENOENT arrives on `proc.on('error')` with the listener already registered.
  const emptyBinDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-empty-path-'))
  const previousCliPath = process.env[PI_CLI_PATH_ENV]
  const previousPath = process.env.PATH
  delete process.env[PI_CLI_PATH_ENV]
  process.env.PATH = emptyBinDirectory
  const controller = new AbortController()
  const listenersBefore = getEventListeners(controller.signal, 'abort').length
  try {
    await assert.rejects(() =>
      createPiProvider().execute({
        systemPrompt: 'system',
        userMessage: 'user',
        model: 'default',
        thinking: 'low',
        signal: controller.signal,
      }),
    )
    assert.equal(
      getEventListeners(controller.signal, 'abort').length,
      listenersBefore,
      'a turn that never started must still return the listener',
    )
  } finally {
    if (previousCliPath === undefined) delete process.env[PI_CLI_PATH_ENV]
    else process.env[PI_CLI_PATH_ENV] = previousCliPath
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    fs.rmSync(emptyBinDirectory, { recursive: true, force: true })
  }
})

test('Pi provider: a stream that ends without any message_end is a failure, not an empty answer', async () => {
  await assertPiRejects({
    beforeFinal: [
      makeMessageUpdate({ type: 'text_delta', contentIndex: 0, delta: 'half an ' }),
      makeMessageUpdate({ type: 'text_delta', contentIndex: 0, delta: 'answer' }),
    ],
    final: { type: 'session_end', reason: 'the process stopped talking' },
  })
})

test('Pi provider: a message_end that is not an assistant message is not a terminal', async () => {
  await assertPiRejects({
    beforeFinal: [],
    final: {
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text: 'the prompt, echoed' }] },
    },
  })
})

test('Pi provider: a malformed message_end is not a terminal', async () => {
  await assertPiRejects({
    beforeFinal: [],
    final: { type: 'message_end', message: 'this is not a message object' },
  })
})

test('Pi provider: non-finite and negative usage figures are not metrics', async () => {
  // `1e999` is valid JSON that parses to `Infinity`, which is why this fixture
  // is written verbatim rather than through `JSON.stringify`.
  const rawFinal = JSON.stringify({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'stop',
      model: 'pi-fake-1',
      content: [{ type: 'text', text: 'kept' }],
      usage: {
        input: -5,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: -3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: -1 },
      },
    },
  }).replace('"output":0', '"output":1e999')

  await withFakePiCli(
    () => ({ beforeFinal: [], final: {}, finalRawJson: rawFinal }),
    async () => {
      const result = await executePi()
      assert.equal(result.text, 'kept', 'a good answer still comes back')
      assert.equal(result.inputTokens, 0, 'a negative token count is not a count')
      assert.equal(result.outputTokens, 0, 'an infinite token count is not a count')
      assert.equal(result.contextTokens, 0)
      assert.equal(result.cost, 0, 'a negative cost is not a cost')
      assert.equal(
        result.costTracked,
        false,
        'a cost that could not be read is untracked, not zero-and-tracked',
      )
    },
  )
})

test('Pi provider: fractional token counts are not counts, but a fractional cost is a cost', async () => {
  // Tokens are counted, not measured: no meter emits 12.5 of them, so a
  // fractional figure is a mis-shaped field and putting it in a budget ledger
  // makes every downstream total wrong in a way nothing flags. Money is the
  // opposite — a turn really can cost a fraction of a cent — so the same rule
  // must not be applied to `cost`, which is why both live in one test.
  await withFakePiCli(
    () => ({
      beforeFinal: [],
      final: {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          model: 'pi-fake-1',
          content: [{ type: 'text', text: 'kept' }],
          usage: {
            input: 12.5,
            output: 3.25,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15.75,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0.0125,
            },
          },
        },
      },
    }),
    async () => {
      const result = await executePi()
      assert.equal(result.text, 'kept', 'a good answer still comes back')
      assert.equal(result.inputTokens, 0, 'a fractional token count is not a count')
      assert.equal(result.outputTokens, 0, 'a fractional token count is not a count')
      assert.equal(result.contextTokens, 0, 'a fractional total is not a total')
      assert.equal(result.cost, 0.0125, 'a fractional cost is a real cost')
      assert.equal(
        result.costTracked,
        true,
        'the cost was read, so it is tracked rather than merely absent',
      )
    },
  )
})
