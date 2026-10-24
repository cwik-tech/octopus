/**
 * Integration tests for the Gemini CLI provider.
 *
 * Uses a fake `gemini` binary (Node.js script on PATH) to simulate the
 * Gemini CLI without requiring a real installation or Google account.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createGeminiProvider } from '../../providers/gemini.js'
import { getAssignmentLogPath } from '../../domains/runtime/logger.js'
import {
  CLI_PROVIDER_MAX_STDERR_BYTES,
  CLI_PROVIDER_MAX_STDOUT_BYTES,
} from '../../core/constants.js'
import { ProviderError } from '../../domains/provider/provider-error.js'

/**
 * Create a temporary `gemini` binary from the given Node.js handler source,
 * prepend its directory to PATH, run the test callback, then clean up.
 */
function withFakeGemini<T>(
  handlerSource: string,
  fn: (binDir: string) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gemini-bin-'))
  const scriptPath = path.join(dir, 'gemini')
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node\n${handlerSource}\n`, { mode: 0o755 })

  return fn(dir).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
}

// ── Basic text capture ─────────────────────────────────────────────────────

test('Gemini provider: captures full stdout as response text', async () => {
  await withFakeGemini(
    `
// Emit plain text response
process.stdout.write('Hello from Gemini!\\nThis is a multi-line response.\\n')
`,
    async (binDir) => {
      const originalPath = process.env.PATH
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
      try {
        const provider = createGeminiProvider()
        const result = await provider.execute({
          systemPrompt: 'You are a helpful assistant.',
          userMessage: 'Say hello.',
          model: 'gemini-2.5-pro',
          thinking: 'medium',
        })

        assert.equal(result.text, 'Hello from Gemini!\nThis is a multi-line response.\n')
        assert.equal(result.model, 'gemini-2.5-pro')
      } finally {
        process.env.PATH = originalPath
      }
    },
  )
})

// ── All metrics are zero ───────────────────────────────────────────────────

test('Gemini provider: all usage metrics are 0', async () => {
  await withFakeGemini(
    `process.stdout.write('Some response text')`,
    async (binDir) => {
      const originalPath = process.env.PATH
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
      try {
        const provider = createGeminiProvider()
        const result = await provider.execute({
          systemPrompt: 'System prompt.',
          userMessage: 'User message.',
          model: 'gemini-2.5-flash',
          thinking: 'low',
        })

        assert.equal(result.cost, 0)
        assert.equal(result.inputTokens, 0)
        assert.equal(result.outputTokens, 0)
        assert.equal(result.contextTokens, 0)
      } finally {
        process.env.PATH = originalPath
      }
    },
  )
})

// ── durationMs is a positive number ───────────────────────────────────────

test('Gemini provider: durationMs is populated', async () => {
  await withFakeGemini(
    `process.stdout.write('quick response')`,
    async (binDir) => {
      const originalPath = process.env.PATH
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
      try {
        const provider = createGeminiProvider()
        const result = await provider.execute({
          systemPrompt: 'sys',
          userMessage: 'msg',
          model: 'gemini-2.5-pro',
          thinking: 'high',
        })

        assert.ok(result.durationMs >= 0, 'durationMs should be >= 0')
        assert.equal(typeof result.durationMs, 'number')
      } finally {
        process.env.PATH = originalPath
      }
    },
  )
})

// ── Prompt is passed through headless prompt mode ──────────────────────────

test('Gemini provider: passes combined prompt through --prompt', async () => {
  await withFakeGemini(
    `process.stdout.write(JSON.stringify(process.argv.slice(2)))`,
    async (binDir) => {
      const originalPath = process.env.PATH
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
      try {
        const provider = createGeminiProvider()
        const result = await provider.execute({
          systemPrompt: 'You are a test assistant.',
          userMessage: 'Test user input.',
          model: 'gemini-2.5-pro',
          thinking: 'low',
        })

        const args: string[] = JSON.parse(result.text)
        const promptIndex = args.indexOf('--prompt')
        assert.ok(promptIndex >= 0)
        assert.ok(
          args[promptIndex + 1]?.includes('You are a test assistant.'),
          'System prompt should be in the headless prompt',
        )
        assert.ok(
          args[promptIndex + 1]?.includes('Test user input.'),
          'User message should be in the headless prompt',
        )
      } finally {
        process.env.PATH = originalPath
      }
    },
  )
})

// ── Unsupported thinking budget args are omitted ──────────────────────────

test('Gemini provider: omits unsupported --thinking-budget args', async () => {
  await withFakeGemini(
    `
// Echo back process argv so test can inspect CLI args
process.stdout.write(JSON.stringify(process.argv.slice(2)))
`,
    async (binDir) => {
      const originalPath = process.env.PATH
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
      try {
        const provider = createGeminiProvider()

        const result = await provider.execute({
          systemPrompt: 'sys',
          userMessage: 'msg',
          model: 'gemini-2.5-pro',
          thinking: 'high',
          providerConfig: { thinking_budget: 32768 },
        })
        const args: string[] = JSON.parse(result.text)
        assert.ok(!args.includes('--thinking-budget'))
        assert.ok(!args.includes('32768'))
      } finally {
        process.env.PATH = originalPath
      }
    },
  )
})

// ── Headless runs are read-only rather than YOLO ───────────────────────────

test('Gemini provider: uses plan approval mode without YOLO', async () => {
  await withFakeGemini(
    `process.stdout.write(JSON.stringify(process.argv.slice(2)))`,
    async (binDir) => {
      const originalPath = process.env.PATH
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
      try {
        const provider = createGeminiProvider()
        const result = await provider.execute({
          systemPrompt: 'sys',
          userMessage: 'msg',
          model: 'gemini-2.5-pro',
          thinking: 'medium',
        })
        const args: string[] = JSON.parse(result.text)
        assert.ok(!args.includes('-y'), 'Should not enable YOLO mode')
        assert.ok(args.includes('--approval-mode'))
        assert.ok(args.includes('plan'))
        assert.equal(
          args[args.indexOf('--output-format') + 1],
          'stream-json',
          'the answer is only reported incrementally on this format',
        )
        assert.ok(args.includes('--model'), 'Should include --model flag')
        assert.ok(args.includes('gemini-2.5-pro'), 'Should include the model name')
      } finally {
        process.env.PATH = originalPath
      }
    },
  )
})

// ── ENOENT: missing binary ─────────────────────────────────────────────────

test('Gemini provider: throws helpful error when gemini binary is missing', async () => {
  // Use an empty temp directory as the ONLY PATH entry so 'gemini' is definitely not found.
  // We must NOT include the original PATH because gemini is installed on this system and
  // would be found otherwise.
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-bin-'))
  const originalPath = process.env.PATH
  const originalFallback = process.env.PIPELINE_CLI_PATH_FALLBACK
  process.env.PATH = emptyDir  // only empty dir — no gemini binary here
  process.env.PIPELINE_CLI_PATH_FALLBACK = '0'

  try {
    const provider = createGeminiProvider()
    await assert.rejects(
      () =>
        provider.execute({
          systemPrompt: 'sys',
          userMessage: 'msg',
          model: 'gemini-2.5-pro',
          thinking: 'low',
        }),
      (err: Error) => {
        assert.ok(
          err.message.includes("Provider 'gemini' requires 'gemini' CLI"),
          `Expected helpful install message, got: ${err.message}`,
        )
        assert.ok(
          err.message.includes('npm i -g @google/gemini-cli'),
          `Expected install command, got: ${err.message}`,
        )
        // The two fields the model-choice offer is built from. Without them a
        // Team deferred past an uninstalled gemini would fail later with
        // nothing the user could act on, which is worse than refusing to boot.
        assert.ok(err instanceof ProviderError, `expected a ProviderError, got ${String(err)}`)
        assert.equal(err.kind, 'configuration')
        assert.equal(err.dispatched, false)
        assert.equal(err.retryable, false)
        return true
      },
    )
  } finally {
    process.env.PATH = originalPath
    if (originalFallback === undefined) delete process.env.PIPELINE_CLI_PATH_FALLBACK
    else process.env.PIPELINE_CLI_PATH_FALLBACK = originalFallback
    fs.rmSync(emptyDir, { recursive: true, force: true })
  }
})

// ── Abort signal kills subprocess ──────────────────────────────────────────

test('Gemini provider: abort signal terminates the subprocess', async () => {
  await withFakeGemini(
    `
// Sleep for a long time to simulate a slow response
setTimeout(() => {
  process.stdout.write('late response')
}, 30000)
`,
    async (binDir) => {
      const originalPath = process.env.PATH
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
      try {
        const provider = createGeminiProvider()
        const controller = new AbortController()

        // Abort after 50ms
        setTimeout(() => controller.abort(), 50)

        const start = Date.now()
        await assert.rejects(
          () =>
            provider.execute({
              systemPrompt: 'sys',
              userMessage: 'msg',
              model: 'gemini-2.5-pro',
              thinking: 'low',
              signal: controller.signal,
            }),
          (err: Error) => {
            const elapsed = Date.now() - start
            assert.ok(elapsed < 5000, `Should have been killed quickly, took ${elapsed}ms`)
            // A caller that withdrew is told the turn was cancelled, not how
            // the child happened to die — this provider sent that SIGTERM
            // itself, so naming it would report the symptom over the cause.
            assert.match(err.message, /cancelled/i)
            return true
          },
        )
      } finally {
        process.env.PATH = originalPath
      }
    },
  )
})

// ── provider.name ──────────────────────────────────────────────────────────

test('Gemini provider: name is "gemini"', () => {
  const provider = createGeminiProvider()
  assert.equal(provider.name, 'gemini')
})

test('Gemini provider: rejects when the gemini CLI exits non-zero', async () => {
  await withFakeGemini(
    `
process.stderr.write('bad auth token')
process.exit(9)
`,
    async (binDir) => {
      const originalPath = process.env.PATH
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
      try {
        const provider = createGeminiProvider()
        await assert.rejects(
          () =>
            provider.execute({
              systemPrompt: 'sys',
              userMessage: 'msg',
              model: 'gemini-2.5-pro',
              thinking: 'medium',
            }),
          (err: Error) => {
            assert.ok(err.message.includes("Provider 'gemini' exited with code 9"))
            assert.ok(err.message.includes('bad auth token'))
            return true
          },
        )
      } finally {
        process.env.PATH = originalPath
      }
    },
  )
})

test('Gemini provider: logs provider lifecycle events', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-provider-logs-'))
  await withFakeGemini(
    `process.stdout.write('telemetry ok')`,
    async (binDir) => {
      const originalPath = process.env.PATH
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
      try {
        const provider = createGeminiProvider()
        await provider.execute({
          systemPrompt: 'sys',
          userMessage: 'msg',
          model: 'gemini-2.5-pro',
          thinking: 'medium',
          outputPath: outputDir,
          sessionId: 'gemini-session',
          rootSessionId: 'gemini-root',
          agentName: 'receptionist',
        })

        const entries = readJsonl(getAssignmentLogPath(outputDir, 'provider-events.jsonl'))
        assert.equal(entries[0]?.event, 'request.start')
        assert.ok(entries.some((entry) => entry.event === 'stdout.captured'))
        assert.equal(entries.at(-1)?.event, 'request.end')
      } finally {
        process.env.PATH = originalPath
      }
    },
  )
  fs.rmSync(outputDir, { recursive: true, force: true })
})

function readJsonl(filePath: string): Array<Record<string, unknown>> {
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

// ─── stream-json streaming ─────────────────────────────────────────────────

/**
 * Verified against the installed Gemini CLI 0.38.2 bundle:
 *
 * - `packages/core/src/output/types.ts` defines `JsonStreamEventType` as
 *   `init`, `message`, `tool_use`, `tool_result`, `error`, `result`, and
 *   `StreamJsonFormatter.formatEvent` writes `JSON.stringify(event) + "\n"`,
 *   so the transport is JSONL.
 * - An answer fragment is emitted as `{ type: 'message', role: 'assistant',
 *   content, delta: true }`. All four discriminants are load-bearing: the same
 *   `message` type is also emitted with `role: 'user'` and **no** `delta` when
 *   the CLI echoes the prompt, so a rule that checked only `type` would store
 *   the question as part of the answer.
 * - The turn ends with `{ type: 'result', status: 'success', stats }`, where
 *   `convertToStreamStats` builds `{ total_tokens, input_tokens,
 *   output_tokens, cached, input, duration_ms, tool_calls, models }`. That
 *   object carries **no answer text**, which is why the fragments — and only
 *   the fragments — are what the turn stores.
 */
const HANDSHAKE_FAILSAFE_TIMEOUT_MS = 1_500

interface StreamingGeminiCli {
  readonly binDirectory: string
  readonly releaseMarkerPath: string
  readonly argvPath: string
}

function writeStreamingGeminiCli(options: {
  readonly beforeTerminal: readonly unknown[]
  readonly terminal: unknown
}): StreamingGeminiCli {
  const binDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gemini-stream-'))
  const handshakeDirectory = path.join(binDirectory, 'handshake')
  fs.mkdirSync(handshakeDirectory)
  const releaseMarkerPath = path.join(handshakeDirectory, 'release')
  const argvPath = path.join(binDirectory, 'argv.json')

  const script = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs')",
    `fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)))`,
    'const write = (line) => process.stdout.write(JSON.stringify(line) + "\\n")',
    `const terminal = ${JSON.stringify(options.terminal)}`,
    `const releaseMarkerPath = ${JSON.stringify(releaseMarkerPath)}`,
    `const releaseDirectory = ${JSON.stringify(handshakeDirectory)}`,
    // Armed before the first fragment is written, so the release cannot be
    // missed however quickly the parent reacts to one.
    'const watcher = fs.watch(releaseDirectory, () => {',
    '  if (!fs.existsSync(releaseMarkerPath)) return',
    '  watcher.close()',
    '  write(terminal)',
    '})',
    ...options.beforeTerminal.map((line) => `write(${JSON.stringify(line)})`),
    // One check, after the lines are out, so a caller that released the CLI
    // before it started still gets its terminal line.
    'if (fs.existsSync(releaseMarkerPath)) { watcher.close(); write(terminal) }',
    '',
  ].join('\n')

  fs.writeFileSync(path.join(binDirectory, 'gemini'), script, { mode: 0o755 })
  return { binDirectory, releaseMarkerPath, argvPath }
}

const GEMINI_STREAM_LINES: readonly unknown[] = [
  { type: 'init', timestamp: '2026-01-01T00:00:00.000Z', session_id: 'fake-session' },
  // The CLI echoes the prompt as a `message` with no `delta`.
  { type: 'message', timestamp: '2026-01-01T00:00:01.000Z', role: 'user', content: 'Say hello.' },
  {
    type: 'message',
    timestamp: '2026-01-01T00:00:02.000Z',
    role: 'assistant',
    content: 'Hello ',
    delta: true,
  },
  {
    type: 'message',
    timestamp: '2026-01-01T00:00:03.000Z',
    role: 'assistant',
    content: 'world',
    delta: true,
  },
  // Right discriminants, wrong content type. An external field is a claim
  // until it is checked, and a non-string here must be ignored rather than
  // stringified into the answer.
  {
    type: 'message',
    timestamp: '2026-01-01T00:00:03.500Z',
    role: 'assistant',
    content: { text: 'an object is not answer text' },
    delta: true,
  },
  { type: 'tool_use', timestamp: '2026-01-01T00:00:04.000Z', name: 'read_file', content: 'planning prose that is not the answer' },
  { type: 'tool_result', timestamp: '2026-01-01T00:00:05.000Z', content: 'file contents that are not the answer' },
  // A whole assistant message with no `delta`: forwarding it would repeat the
  // answer the fragments just delivered.
  {
    type: 'message',
    timestamp: '2026-01-01T00:00:06.000Z',
    role: 'assistant',
    content: 'Hello world',
  },
]

const GEMINI_TERMINAL_RESULT: unknown = {
  type: 'result',
  timestamp: '2026-01-01T00:00:07.000Z',
  status: 'success',
  stats: {
    total_tokens: 18,
    input_tokens: 11,
    output_tokens: 7,
    cached: 0,
    input: 11,
    duration_ms: 1234,
    tool_calls: 1,
    models: {},
  },
}

test('Gemini provider: streams committed answer fragments before the turn resolves', { timeout: HANDSHAKE_FAILSAFE_TIMEOUT_MS }, async (t) => {
  const cli = writeStreamingGeminiCli({
    beforeTerminal: GEMINI_STREAM_LINES,
    terminal: GEMINI_TERMINAL_RESULT,
  })
  const originalPath = process.env.PATH
  process.env.PATH = `${cli.binDirectory}${path.delimiter}${originalPath ?? ''}`

  try {
    const fragments: string[] = []

    // The fake CLI cannot write its terminal line, and so cannot exit, until
    // the release marker exists. Only this observer creates it, and only after
    // a second fragment. A provider that produced its text after the child
    // closed would never release it, so this turn would not finish.
    const result = await createGeminiProvider().execute({
      systemPrompt: 'You are a helpful assistant.',
      userMessage: 'Say hello.',
      model: 'gemini-2.5-pro',
      thinking: 'medium',
      signal: t.signal,
      onProtocolEvent: (event) => {
        if (event.kind !== 'text' || event.text === undefined) return
        fragments.push(event.text)
        if (fragments.length === 2) fs.writeFileSync(cli.releaseMarkerPath, '')
      },
    })

    assert.deepEqual(
      fragments,
      ['Hello ', 'world'],
      'one text event per assistant delta; the echoed user message, the tool ' +
        'lines and the whole non-delta assistant message are all excluded',
    )
    assert.equal(
      result.text,
      fragments.join(''),
      'what the turn stores is exactly the fragments that were shown',
    )
    assert.equal(result.text, 'Hello world')
    assert.equal(result.inputTokens, 11, 'usage comes from the terminal result stats')
    assert.equal(result.outputTokens, 7)
    assert.equal(result.contextTokens, 18)
    assert.equal(result.durationMs, 1234)

    const argv: unknown = JSON.parse(fs.readFileSync(cli.argvPath, 'utf8'))
    assert.ok(Array.isArray(argv))
    const args: string[] = argv.filter((value): value is string => typeof value === 'string')
    assert.equal(
      args[args.indexOf('--output-format') + 1],
      'stream-json',
      'incremental answer fragments are only available on the stream-json format',
    )
  } finally {
    process.env.PATH = originalPath
    fs.rmSync(cli.binDirectory, { recursive: true, force: true })
  }
})

// ─── stream-json terminal discipline ───────────────────────────────────────

/**
 * Writes a fake gemini that emits the given lines and exits, with no handshake.
 * These cases are about what the turn concludes from a finished stream, not
 * about when text became visible.
 */
function withStreamingGemini<T>(
  lines: readonly unknown[],
  fn: () => Promise<T>,
): Promise<T> {
  const source = lines
    .map((line) => `process.stdout.write(${JSON.stringify(JSON.stringify(line) + '\n')})`)
    .join('\n')
  return withFakeGemini(source, async (binDir) => {
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
    try {
      return await fn()
    } finally {
      process.env.PATH = originalPath
    }
  })
}

const GEMINI_TWO_FRAGMENTS: readonly unknown[] = [
  { type: 'init', session_id: 'fake-session' },
  { type: 'message', role: 'assistant', content: 'Hello ', delta: true },
  { type: 'message', role: 'assistant', content: 'world', delta: true },
]

function executeGemini(overrides: { signal?: AbortSignal } = {}) {
  return createGeminiProvider().execute({
    systemPrompt: 'sys',
    userMessage: 'msg',
    model: 'gemini-2.5-pro',
    thinking: 'medium',
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  })
}

test('Gemini provider: a stream that ends before its terminal result is a failure, not an answer', async () => {
  // The dangerous outcome is not an error, it is a plausible one: falling back
  // to raw stdout here would store the JSONL transport itself as the reply.
  await withStreamingGemini(GEMINI_TWO_FRAGMENTS, async () => {
    await assert.rejects(
      () => executeGemini(),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /gemini/)
        assert.doesNotMatch(
          error.message,
          /"type":"message"/,
          'the failure must not carry the raw JSONL as if it were text',
        )
        return true
      },
    )
  })
})

test('Gemini provider: a cancelled turn fails even when the child ignores SIGTERM and exits zero', async () => {
  // Both fragments share one write, so the second is already in the same chunk
  // as the one whose observer cancels; and the child traps SIGTERM, so the
  // provider cannot rely on it dying politely.
  const wholeTurn = [
    JSON.stringify({ type: 'message', role: 'assistant', content: 'first ', delta: true }),
    JSON.stringify({ type: 'message', role: 'assistant', content: 'second ', delta: true }),
    JSON.stringify({ type: 'result', status: 'success', stats: { total_tokens: 3 } }),
    '',
  ].join('\n')

  await withFakeGemini(
    [
      "process.on('SIGTERM', () => {})",
      `process.stdout.write(${JSON.stringify(wholeTurn)})`,
    ].join('\n'),
    async (binDir) => {
      const originalPath = process.env.PATH
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
      try {
        const controller = new AbortController()
        const fragments: string[] = []

        await assert.rejects(
          () =>
            createGeminiProvider().execute({
              systemPrompt: 'sys',
              userMessage: 'msg',
              model: 'gemini-2.5-pro',
              thinking: 'medium',
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
            assert.equal(error.provider, 'gemini')
            assert.match(error.message, /cancelled/i)
            return true
          },
        )

        assert.deepEqual(
          fragments,
          ['first '],
          'nothing may be published after the caller cancelled, including a ' +
            'fragment that had already arrived in the same chunk',
        )
      } finally {
        process.env.PATH = originalPath
      }
    },
  )
})

test('Gemini provider: a successful stream with no answer fragments is a failure, not a placeholder', async () => {
  // Gemini's terminal line carries no text of its own, so a success with no
  // fragments has nothing to store. `[No response. stderr: …]` is this
  // codebase's own prose, and resolving with it hands a caller a string it
  // stores as the agent's reply.
  await withStreamingGemini(
    [
      { type: 'init', session_id: 'fake-session' },
      { type: 'result', status: 'success', stats: { total_tokens: 3 } },
    ],
    async () => {
      await assert.rejects(
        () => executeGemini(),
        (error: unknown) => {
          assert.ok(
            error instanceof ProviderError,
            `expected a ProviderError, got ${String(error)}`,
          )
          assert.equal(error.provider, 'gemini')
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

test('Gemini provider: does not accept a result that the stream continued past', async () => {
  // A `result` followed by further protocol records is not this turn's ending.
  // Accepting it would also append the fragments that came after it, storing
  // an answer the CLI had not finished revising.
  await withStreamingGemini(
    [
      ...GEMINI_TWO_FRAGMENTS,
      { type: 'result', status: 'success', stats: { total_tokens: 3 } },
      { type: 'message', role: 'assistant', content: ' and then more', delta: true },
    ],
    async () => {
      await assert.rejects(() => executeGemini(), /gemini/)
    },
  )
})

test('Gemini provider: a terminal result that did not succeed is a failure even on exit code 0', async () => {
  await withStreamingGemini(
    [...GEMINI_TWO_FRAGMENTS, { type: 'result', status: 'error', stats: {} }],
    async () => {
      await assert.rejects(() => executeGemini(), /gemini/)
    },
  )
})

test('Gemini provider: negative token counts and durations are not stats', async () => {
  await withStreamingGemini(
    [
      ...GEMINI_TWO_FRAGMENTS,
      {
        type: 'result',
        status: 'success',
        stats: {
          total_tokens: -6,
          input_tokens: -5,
          output_tokens: -1,
          duration_ms: -100,
        },
      },
    ],
    async () => {
      const result = await executeGemini()
      assert.equal(result.text, 'Hello world')
      assert.equal(result.inputTokens, 0, 'a negative token count is not a count')
      assert.equal(result.outputTokens, 0)
      assert.equal(result.contextTokens, 0)
      assert.ok(
        result.durationMs >= 0,
        `a negative duration is not a duration; got ${String(result.durationMs)}`,
      )
    },
  )
})

test('Gemini provider: fractional token counts are not counts, but a fractional duration is a duration', async () => {
  // Tokens are counted, not measured: no meter emits 12.5 of them, so a
  // fractional figure is a mis-shaped field and putting it in a budget ledger
  // makes every downstream total wrong in a way nothing flags. An elapsed
  // duration is genuinely continuous, so the same rule must not be applied to
  // `duration_ms` — which is why both are asserted from one fixture.
  await withStreamingGemini(
    [
      ...GEMINI_TWO_FRAGMENTS,
      {
        type: 'result',
        status: 'success',
        stats: {
          total_tokens: 15.75,
          input_tokens: 12.5,
          output_tokens: 3.25,
          duration_ms: 1234.5,
        },
      },
    ],
    async () => {
      const result = await executeGemini()
      assert.equal(result.text, 'Hello world')
      assert.equal(result.inputTokens, 0, 'a fractional token count is not a count')
      assert.equal(result.outputTokens, 0, 'a fractional token count is not a count')
      assert.equal(result.contextTokens, 0, 'a fractional total is not a total')
      assert.equal(
        result.durationMs,
        1234.5,
        'an elapsed duration is continuous and keeps its fraction',
      )
    },
  )
})

test('Gemini provider: a turn whose signal is already aborted never starts the CLI', async () => {
  // Rejecting after a spawn-then-SIGTERM would also satisfy "does not return
  // an answer", and it is not the same thing: the CLI would already have run,
  // with whatever cost and side effects that carries. The marker is written by
  // the fake CLI's first statement, so its absence is proof the process was
  // never started.
  const binDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gemini-preabort-'))
  const spawnMarkerPath = path.join(binDirectory, 'spawned')
  fs.writeFileSync(
    path.join(binDirectory, 'gemini'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs')",
      `fs.writeFileSync(${JSON.stringify(spawnMarkerPath)}, '')`,
      'process.stdout.write(JSON.stringify({ type: "message", role: "assistant", content: "answer", delta: true }) + "\\n")',
      'process.stdout.write(JSON.stringify({ type: "result", status: "success", stats: {} }) + "\\n")',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )

  const originalPath = process.env.PATH
  process.env.PATH = `${binDirectory}${path.delimiter}${originalPath ?? ''}`
  try {
    await assert.rejects(
      () => executeGemini({ signal: AbortSignal.abort() }),
      /cancelled/i,
    )
    assert.equal(
      fs.existsSync(spawnMarkerPath),
      false,
      'the CLI must not be started at all for a turn that was already cancelled',
    )
  } finally {
    process.env.PATH = originalPath
    fs.rmSync(binDirectory, { recursive: true, force: true })
  }
})

test('Gemini provider: a turn aborted while in flight is terminated', async () => {
  await withStreamingGemini(GEMINI_TWO_FRAGMENTS, async () => {
    const controller = new AbortController()
    const pending = executeGemini({ signal: controller.signal })
    controller.abort()
    await assert.rejects(() => pending, /gemini/)
  })
})

// ─── Gemini's own decoding and output bounds ───────────────────────────────

/**
 * These two cover logic Gemini owns rather than inherits. It runs its own
 * spawn loop instead of the shared `text-cli` runner, so the chunk-boundary
 * decoding and the output caps proved for that runner say nothing about this
 * provider.
 */
test('Gemini provider: a multi-byte character split across stdout chunks survives into both the preview and the stored answer', { timeout: HANDSHAKE_FAILSAFE_TIMEOUT_MS }, async (t) => {
  // '✅' is U+2705: the three bytes E2 9C 85. The fake CLI puts E2 at the end
  // of one write and 9C 85 at the start of the next, and cannot make the
  // second write until the parent has finished handling the first — the
  // release marker is created from inside the observer that the completed
  // line in that first write fires. So the character is guaranteed to straddle
  // two stdout chunks, with no sleep and no assumption about pipe buffering.
  const binDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gemini-split-'))
  const handshakeDirectory = path.join(binDirectory, 'handshake')
  fs.mkdirSync(handshakeDirectory)
  const releaseMarkerPath = path.join(handshakeDirectory, 'release')

  const firstFragment = { type: 'message', role: 'assistant', content: 'go ', delta: true }
  // The second fragment's line is cut inside the '✅' that ends its content.
  const secondFragmentHead = '{"type":"message","role":"assistant","delta":true,"content":"done '
  const terminalLine = { type: 'result', status: 'success', stats: { total_tokens: 4 } }

  fs.writeFileSync(
    path.join(binDirectory, 'gemini'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs')",
      `const releaseMarkerPath = ${JSON.stringify(releaseMarkerPath)}`,
      `const releaseDirectory = ${JSON.stringify(handshakeDirectory)}`,
      `const tail = ${JSON.stringify('"}\n' + JSON.stringify(terminalLine) + '\n')}`,
      'const watcher = fs.watch(releaseDirectory, () => {',
      '  if (!fs.existsSync(releaseMarkerPath)) return',
      '  watcher.close()',
      '  process.stdout.write(Buffer.concat([Buffer.from([0x9c, 0x85]), Buffer.from(tail, "utf8")]))',
      '})',
      // One write, so the completed first line and the lone leading byte of
      // the character are handed to the parent together.
      `const head = ${JSON.stringify(JSON.stringify(firstFragment) + '\n' + secondFragmentHead)}`,
      'process.stdout.write(Buffer.concat([Buffer.from(head, "utf8"), Buffer.from([0xe2])]))',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )

  const originalPath = process.env.PATH
  process.env.PATH = `${binDirectory}${path.delimiter}${originalPath ?? ''}`
  try {
    const fragments: string[] = []
    const result = await createGeminiProvider().execute({
      systemPrompt: 'sys',
      userMessage: 'msg',
      model: 'gemini-2.5-pro',
      thinking: 'medium',
      signal: t.signal,
      onProtocolEvent: (event) => {
        if (event.kind !== 'text' || event.text === undefined) return
        fragments.push(event.text)
        if (fragments.length === 1) fs.writeFileSync(releaseMarkerPath, '')
      },
    })

    assert.deepEqual(
      fragments,
      ['go ', 'done ✅'],
      'the character split across two chunks must reach the preview intact',
    )
    assert.equal(
      result.text,
      'go done ✅',
      'and the stored answer is the same fragments, joined',
    )
    assert.equal(
      result.text.includes('\uFFFD'),
      false,
      'no half of the character may be replaced with U+FFFD',
    )
  } finally {
    process.env.PATH = originalPath
    fs.rmSync(binDirectory, { recursive: true, force: true })
  }
})

test('Gemini provider: oversized stdout is rejected and the child is terminated', { timeout: HANDSHAKE_FAILSAFE_TIMEOUT_MS }, async (t) => {
  // The fake CLI below stays alive on purpose, so the provider has to be what
  // ends it. That makes a regression in the kill path a hang rather than a
  // failure, which the bound and the signal turn back into a reported failure
  // with the child torn down. The assertion itself is causal: it names the
  // error, never an elapsed time.
  await withFakeGemini(
    // Write far past the cap, then stay alive: the provider has to be what
    // ends this process, not the script running out of things to say.
    `process.stdout.write(Buffer.alloc(${CLI_PROVIDER_MAX_STDOUT_BYTES + 1}, 120))
setInterval(() => {}, 1000)`,
    async (binDir) => {
      const originalPath = process.env.PATH
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
      try {
        await assert.rejects(
          () => executeGemini({ signal: t.signal }),
          /stdout output limit/i,
        )
      } finally {
        process.env.PATH = originalPath
      }
    },
  )
})

test('Gemini provider: oversized stderr is rejected and the child is terminated', { timeout: HANDSHAKE_FAILSAFE_TIMEOUT_MS }, async (t) => {
  // The symmetric half of the test above. The two streams are counted by
  // separate handlers against separate caps, so proving one says nothing about
  // the other — a diagnostic flood on stderr is exactly as capable of
  // exhausting this process's memory as a runaway answer on stdout.
  //
  // Shaped the same way for the same reason: the fake CLI stays alive on
  // purpose, so the provider has to be what ends it, and a regression in the
  // kill path becomes a hang that the bound and the signal turn back into a
  // reported failure with the child torn down. The assertion names the error
  // and never an elapsed time.
  await withFakeGemini(
    `process.stderr.write(Buffer.alloc(${CLI_PROVIDER_MAX_STDERR_BYTES + 1}, 120))
setInterval(() => {}, 1000)`,
    async (binDir) => {
      const originalPath = process.env.PATH
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
      try {
        await assert.rejects(
          () => executeGemini({ signal: t.signal }),
          /stderr output limit/i,
        )
      } finally {
        process.env.PATH = originalPath
      }
    },
  )
})
