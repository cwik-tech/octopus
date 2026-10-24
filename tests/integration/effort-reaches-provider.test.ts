/**
 * The chosen effort level, as the provider actually receives it.
 *
 * Asserted against the captured argv or the captured request body rather than
 * against anything this application stores about the turn. A record saying
 * `xhigh` proves only that a record says `xhigh`; the failure worth catching is
 * a level that is chosen, displayed, saved, and then dropped on the way out.
 *
 * Three outcomes are possible for any pair, and each is checked here: the level
 * is sent, no level is sent because the author asked for the provider's own
 * default, or the turn is refused before anything is dispatched. Nothing
 * substitutes one level for another.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { createClaudeProvider } from '../../providers/claude.js'
import { createCodexProvider } from '../../providers/codex.js'
import { createKimiCliProvider } from '../../providers/kimi-cli.js'
import { createOpenAIProvider } from '../../providers/openai.js'
import { createPiProvider } from '../../providers/pi.js'
import { createAnthropicProvider } from '../../providers/anthropic.js'
import { createOpenRouterProvider } from '../../providers/openrouter.js'
import { createGeminiProvider } from '../../providers/gemini.js'
import { PI_CLI_PATH_ENV } from '../../core/pi-runtime.js'
import { createOpenAIChatCompletionsToolAdapter } from '../../domains/provider/openai-chat-completions-tool-adapter.js'
import { setConfiguredProviderConnections } from '../../providers/configured-provider.js'
import { getProvider } from '../../providers/registry.js'
import { configuredProviderName } from '../../domains/provider/provider-settings.js'
import {
  setRuntimeEffortSupport,
  clearRuntimeEffortSupport,
} from '../../domains/provider/effort-support.js'

function withFakeCli<T>(
  command: string,
  handlerSource: string,
  fn: (binDir: string) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fake-${command}-bin-`))
  fs.writeFileSync(path.join(dir, command), `#!/usr/bin/env node\n${handlerSource}\n`, {
    mode: 0o755,
  })
  return fn(dir).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
}

async function withPath<T>(binDir: string, fn: () => Promise<T>): Promise<T> {
  const originalPath = process.env.PATH
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
  try {
    return await fn()
  } finally {
    process.env.PATH = originalPath
  }
}

const ECHO_ARGS_CLAUDE = `
const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    result: JSON.stringify(process.argv.slice(2)),
    model: 'claude-sonnet-4-6',
    usage: { input_tokens: 1, output_tokens: 1 },
  }))
})
`

const ECHO_ARGS_KIMI = `
const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ args: process.argv.slice(2) }))
})
`

async function claudeArgs(thinking: string): Promise<string[]> {
  return withFakeCli('claude', ECHO_ARGS_CLAUDE, async (binDir) =>
    withPath(binDir, async () => {
      const result = await createClaudeProvider().execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'sonnet',
        thinking: thinking as never,
      })
      return JSON.parse(result.text) as string[]
    }),
  )
}

test('Claude Code receives the level above the three this application used to allow', async () => {
  const args = await claudeArgs('xhigh')
  assert.equal(args[args.indexOf('--effort') + 1], 'xhigh')
})

test('Claude Code receives no effort flag when the author asked for its own default', async () => {
  const args = await claudeArgs('provider-default')
  assert.equal(args.includes('--effort'), false)
})

test('a level Claude Code cannot parse is refused before the process starts', async () => {
  let spawned = false
  await withFakeCli('claude', ECHO_ARGS_CLAUDE, async (binDir) =>
    withPath(binDir, async () => {
      await assert.rejects(
        createClaudeProvider().execute({
          systemPrompt: 'system',
          userMessage: 'hello',
          model: 'sonnet',
          thinking: 'ultra' as never,
          onProcessStarted: () => {
            spawned = true
          },
        }),
        /ultra/u,
      )
    }),
  )
  assert.equal(spawned, false, 'nothing may be dispatched for a refused level')
})

test('Codex receives the level as the reasoning effort it configures', async () => {
  const args = await withFakeCli(
    'codex',
    `
const lines = [
  JSON.stringify({ type: 'thread.started', thread_id: 'thread-effort' }),
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: JSON.stringify(process.argv.slice(2)) } }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }),
]
process.stdout.write(lines.join('\\n') + '\\n')
`,
    async (binDir) =>
      withPath(binDir, async () => {
        const result = await createCodexProvider().execute({
          systemPrompt: 'system',
          userMessage: 'hello',
          model: 'gpt-6-astra',
          thinking: 'xhigh' as never,
        })
        return JSON.parse(result.text) as string[]
      }),
  )
  assert.ok(args.includes('model_reasoning_effort=xhigh'), args.join(' '))
})

test('Kimi Code CLI turns an explicit off into its own negation', async () => {
  const args = await withFakeCli('kimi', ECHO_ARGS_KIMI, async (binDir) =>
    withPath(binDir, async () => {
      const result = await createKimiCliProvider().execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'kimi-k2.6',
        thinking: 'off' as never,
      })
      return (JSON.parse(result.text) as { args: string[] }).args
    }),
  )
  assert.ok(args.includes('--no-thinking'), args.join(' '))
})

test('the OpenAI request carries the level, and the vendor spelling of off', async () => {
  const originalKey = process.env.OPENAI_API_KEY
  const originalFetch = globalThis.fetch
  process.env.OPENAI_API_KEY = 'test-key'
  const bodies: Record<string, unknown>[] = []
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(
      JSON.stringify({ model: 'gpt-5.5', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    for (const thinking of ['xhigh', 'off', 'provider-default']) {
      await createOpenAIProvider().execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'gpt-5.5',
        thinking: thinking as never,
      })
    }
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalKey
  }

  assert.deepEqual(bodies[0]?.reasoning, { effort: 'xhigh' })
  assert.deepEqual(bodies[1]?.reasoning, { effort: 'none' })
  assert.equal(bodies[2]?.reasoning, undefined)
})

test('a model that publishes no off is refused rather than quietly raised', async () => {
  setRuntimeEffortSupport([
    {
      provider: 'openai',
      model: 'gpt-5.5',
      levels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    },
  ])
  const originalKey = process.env.OPENAI_API_KEY
  const originalFetch = globalThis.fetch
  process.env.OPENAI_API_KEY = 'test-key'
  let requested = false
  globalThis.fetch = async () => {
    requested = true
    return new Response('{}', { status: 200 })
  }
  try {
    await assert.rejects(
      createOpenAIProvider().execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'gpt-5.5',
        thinking: 'off' as never,
      }),
      /off/u,
    )
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalKey
    clearRuntimeEffortSupport()
  }
  assert.equal(requested, false, 'a refused level must not reach the vendor')
})

const ECHO_ARGS_PI = `
const payload = {
  type: 'message_end',
  message: {
    role: 'assistant',
    model: 'fake-pi-model',
    usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
    content: [{ type: 'text', text: JSON.stringify(process.argv.slice(2)) }]
  }
}
process.stdout.write(JSON.stringify(payload) + '\\n')
process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n')
`

test('Pi receives a level its own runtime reports', async () => {
  // Established from the runtime rather than assumed: a Pi whose capabilities
  // this application cannot read offers only the three levels every agent file
  // already carries, which is the subject of its own test below.
  setRuntimeEffortSupport([
    {
      provider: 'pi',
      model: 'anthropic/claude-opus-4-7',
      levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
  ])
  try {
    const args = await withFakeCli('pi', ECHO_ARGS_PI, async (binDir) =>
      withPath(binDir, async () => {
        const result = await createPiProvider().execute({
          systemPrompt: 'system',
          userMessage: 'hello',
          model: 'anthropic/claude-opus-4-7',
          thinking: 'xhigh' as never,
        })
        return JSON.parse(result.text) as string[]
      }),
    )
    assert.equal(args[args.indexOf('--thinking') + 1], 'xhigh')
  } finally {
    clearRuntimeEffortSupport()
  }
})

test('Pi is never asked for an off its own runtime would round upward', async () => {
  // `claude-fable-5` maps thinking-off to null in the Pi runtime's model data,
  // so `clampThinkingLevel` would answer `minimal` — thinking, when the author
  // asked for none. The refusal happens here instead, before a process exists.
  setRuntimeEffortSupport([
    {
      provider: 'pi',
      model: 'anthropic/claude-fable-5',
      levels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    },
  ])
  let spawned = false
  try {
    await withFakeCli('pi', ECHO_ARGS_PI, async (binDir) =>
      withPath(binDir, async () => {
        await assert.rejects(
          createPiProvider().execute({
            systemPrompt: 'system',
            userMessage: 'hello',
            model: 'anthropic/claude-fable-5',
            thinking: 'off' as never,
            onProcessStarted: () => {
              spawned = true
            },
          }),
          /off/u,
        )
      }),
    )
  } finally {
    clearRuntimeEffortSupport()
  }
  assert.equal(spawned, false)
})

test('the Anthropic request omits its thinking block for an explicit off', async () => {
  const originalKey = process.env.ANTHROPIC_API_KEY
  const originalFetch = globalThis.fetch
  process.env.ANTHROPIC_API_KEY = 'test-key'
  const bodies: Record<string, unknown>[] = []
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(
      JSON.stringify({
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    for (const thinking of ['off', 'high']) {
      await createAnthropicProvider().execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'claude-opus-5',
        thinking: thinking as never,
      })
    }
    await assert.rejects(
      createAnthropicProvider().execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'claude-opus-5',
        thinking: 'xhigh' as never,
      }),
      /xhigh/u,
    )
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = originalKey
  }
  assert.equal(bodies[0]?.thinking, undefined, 'off must not ask for thinking')
  assert.ok(bodies[1]?.thinking, 'high still budgets thinking as it always has')
  assert.equal(bodies.length, 2, 'the refused level never reached the vendor')
})

test('a configured connection carries the level a user picked from the catalogue', async () => {
  setConfiguredProviderConnections([
    {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      kind: 'openrouter',
      name: 'Fixture',
      baseUrl: 'https://fixture.invalid/api/v1',
      apiKey: 'test-key',
    },
  ])
  const providerName = configuredProviderName('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  setRuntimeEffortSupport([
    { provider: providerName, model: 'vendor/model', levels: ['low', 'high', 'xhigh'] },
  ])
  const originalFetch = globalThis.fetch
  const bodies: Record<string, unknown>[] = []
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(
      JSON.stringify({
        model: 'vendor/model',
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    for (const thinking of ['xhigh', 'provider-default']) {
      await getProvider(providerName).execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'vendor/model',
        thinking: thinking as never,
      })
    }
    await assert.rejects(
      getProvider(providerName).execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'vendor/model',
        thinking: 'max' as never,
      }),
      /max/u,
    )
  } finally {
    globalThis.fetch = originalFetch
    clearRuntimeEffortSupport()
    setConfiguredProviderConnections([])
  }
  assert.equal(bodies[0]?.reasoning_effort, 'xhigh')
  assert.equal(bodies[1]?.reasoning_effort, undefined)
  assert.equal(bodies.length, 2)
})

test('a turn that carries tools still carries the level', async () => {
  // The tool loop builds its own request rather than going through a
  // `providers/*.ts` adapter, so a level that reaches every other route can
  // still be missing from this one. An agent with tools is the ordinary case,
  // not an exotic one.
  const bodies: Record<string, unknown>[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(
      JSON.stringify({
        model: 'vendor/model',
        choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    const adapter = createOpenAIChatCompletionsToolAdapter({
      apiUrl: 'https://fixture.invalid/v1/chat/completions',
      model: 'vendor/model',
      reasoningEffort: 'xhigh',
    })
    await adapter.complete({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      signal: AbortSignal.timeout(5_000),
    })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(bodies[0]?.reasoning_effort, 'xhigh')
})

test('the OpenRouter provider carries the level too', async () => {
  const originalKey = process.env.OPENROUTER_API_KEY
  const originalFetch = globalThis.fetch
  process.env.OPENROUTER_API_KEY = 'test-key'
  const bodies: Record<string, unknown>[] = []
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(
      JSON.stringify({
        model: 'vendor/model',
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    await createOpenRouterProvider().execute({
      systemPrompt: 'system',
      userMessage: 'hello',
      model: 'vendor/model',
      thinking: 'xhigh' as never,
    })
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = originalKey
  }
  assert.equal(bodies[0]?.reasoning_effort, 'xhigh')
})

/**
 * A Pi package laid out the way the bundled runtime is, with a working fake
 * CLI at the path `core/pi-runtime.ts` would execute.
 */
function withFakePiRuntime<T>(
  models: Record<string, Record<string, unknown>>,
  fn: (cliPath: string) => Promise<T>,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-runtime-'))
  const packageRoot = path.join(
    root,
    'node_modules',
    '@earendil-works',
    'pi-coding-agent',
  )
  const dataDir = path.join(
    packageRoot,
    'node_modules',
    '@earendil-works',
    'pi-ai',
    'dist',
    'providers',
    'data',
  )
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(
    path.join(dataDir, 'vendor.json'),
    JSON.stringify({ 'vendor-api': models }),
  )
  const cliDir = path.join(packageRoot, 'dist')
  fs.mkdirSync(cliDir, { recursive: true })
  const cliPath = path.join(cliDir, 'cli.js')
  fs.writeFileSync(cliPath, ECHO_ARGS_PI)
  return fn(cliPath).finally(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })
}

test('a cold process still refuses an off the executed Pi runtime would round upward', async () => {
  // The registry is filled when the provider catalogue is built. A worker
  // process that never built one knows nothing — and "knows nothing" must not
  // become "off is fine", because Pi answers an unsupported `off` with the next
  // level up rather than with an error. The runtime's own data ships beside the
  // executable, so the adapter can read it without the catalogue.
  clearRuntimeEffortSupport()
  await withFakePiRuntime(
    {
      'fable-like': {
        id: 'fable-like',
        provider: 'vendor',
        reasoning: true,
        thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' },
      },
    },
    async (cliPath) => {
      const originalPath = process.env[PI_CLI_PATH_ENV]
      process.env[PI_CLI_PATH_ENV] = cliPath
      try {
        await assert.rejects(
          createPiProvider().execute({
            systemPrompt: 'system',
            userMessage: 'hello',
            model: 'vendor/fable-like',
            thinking: 'off' as never,
          }),
          /off/u,
        )
        // The same runtime accepts the levels it does map, so this is a
        // refusal about one level and not a Pi turn that stopped working.
        const result = await createPiProvider().execute({
          systemPrompt: 'system',
          userMessage: 'hello',
          model: 'vendor/fable-like',
          thinking: 'max' as never,
        })
        const args = JSON.parse(result.text) as string[]
        assert.equal(args[args.indexOf('--thinking') + 1], 'max')
      } finally {
        if (originalPath === undefined) delete process.env[PI_CLI_PATH_ENV]
        else process.env[PI_CLI_PATH_ENV] = originalPath
      }
    },
  )
})

test('a provider that cannot carry the setting refuses a level it cannot carry', async () => {
  // Gemini's adapter has nowhere to put an effort setting. Running the turn
  // anyway would drop a stored level on the floor, which looks identical to
  // honouring it. The three levels that always ran there still run.
  await withFakeCli(
    'gemini',
    `process.stdout.write(JSON.stringify({ type: 'result', result: 'ok' }) + '\\n')`,
    async (binDir) =>
      withPath(binDir, async () => {
        await assert.rejects(
          createGeminiProvider().execute({
            systemPrompt: 'system',
            userMessage: 'hello',
            model: 'pro',
            thinking: 'xhigh' as never,
          }),
          /xhigh/u,
        )
      }),
  )
})

test('an explicit off is not overridden by a thinking budget written earlier', async () => {
  // `thinking_budget` is how an agent used to express depth on this provider.
  // A file that still carries one and has since been set to `off` is asking
  // for no thinking; honouring the older field would answer the opposite.
  const originalKey = process.env.ANTHROPIC_API_KEY
  const originalFetch = globalThis.fetch
  process.env.ANTHROPIC_API_KEY = 'test-key'
  const bodies: Record<string, unknown>[] = []
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(
      JSON.stringify({
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    await createAnthropicProvider().execute({
      systemPrompt: 'system',
      userMessage: 'hello',
      model: 'claude-opus-5',
      thinking: 'off' as never,
      providerConfig: { thinking_budget: 2048, max_tokens: 4096 },
    })
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = originalKey
  }
  assert.equal(bodies[0]?.thinking, undefined)
})

test('turning reasoning off in settings does not hide a level nobody can honour', async () => {
  // `reasoning: false` suppresses the field. It must not also suppress the
  // question of whether the level was one this pair accepts, or a refused
  // choice would run as an ordinary turn with no sign anything was dropped.
  setRuntimeEffortSupport([
    { provider: 'openai', model: 'gpt-5.5', levels: ['low', 'medium', 'high'] },
  ])
  const originalKey = process.env.OPENAI_API_KEY
  const originalFetch = globalThis.fetch
  process.env.OPENAI_API_KEY = 'test-key'
  const bodies: Record<string, unknown>[] = []
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(
      JSON.stringify({ model: 'gpt-5.5', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    await assert.rejects(
      createOpenAIProvider().execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'gpt-5.5',
        thinking: 'xhigh' as never,
        providerConfig: { reasoning: false },
      }),
      /xhigh/u,
    )
    await createOpenAIProvider().execute({
      systemPrompt: 'system',
      userMessage: 'hello',
      model: 'gpt-5.5',
      thinking: 'high' as never,
      providerConfig: { reasoning: false },
    })
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalKey
    clearRuntimeEffortSupport()
  }
  assert.equal(bodies.length, 1, 'only the supported level was dispatched')
  assert.equal(bodies[0]?.reasoning, undefined, 'reasoning: false still suppresses the field')
})

test('a supported off is honoured even when an older setting suppresses the field', async () => {
  // `reasoning: false` was the only way to say "send no reasoning field"
  // before there was a vocabulary for it. `off` asks for something else: no
  // thinking. Omitting the field does not deliver that — the vendor then picks,
  // and on a reasoning model it picks thinking. So the level is sent, as the
  // only spelling that produces what was asked for.
  setRuntimeEffortSupport([
    {
      provider: 'openai',
      model: 'gpt-5.5',
      // `xhigh` is published here on purpose: the conflict below has to be
      // about the suppressor, not about a level the model does not accept.
      levels: ['off', 'low', 'medium', 'xhigh'],
    },
  ])
  const originalKey = process.env.OPENAI_API_KEY
  const originalFetch = globalThis.fetch
  process.env.OPENAI_API_KEY = 'test-key'
  const bodies: Record<string, unknown>[] = []
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(
      JSON.stringify({ model: 'gpt-5.5', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    await createOpenAIProvider().execute({
      systemPrompt: 'system',
      userMessage: 'hello',
      model: 'gpt-5.5',
      thinking: 'off' as never,
      providerConfig: { reasoning: false },
    })
    // A level from the widened vocabulary disagrees with that setting in a way
    // nothing can resolve for the author, so the turn stops instead.
    await assert.rejects(
      createOpenAIProvider().execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'gpt-5.5',
        thinking: 'xhigh' as never,
        providerConfig: { reasoning: false },
      }),
      /reasoning/u,
    )
    // The three levels agent files already carry keep behaving exactly as they
    // did, because changing them would move agents nobody edited.
    await createOpenAIProvider().execute({
      systemPrompt: 'system',
      userMessage: 'hello',
      model: 'gpt-5.5',
      thinking: 'medium' as never,
      providerConfig: { reasoning: false },
    })
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalKey
    clearRuntimeEffortSupport()
  }
  assert.deepEqual(bodies[0]?.reasoning, { effort: 'none' })
  assert.equal(bodies.length, 2, 'the conflicting configuration never dispatched')
  assert.equal(bodies[1]?.reasoning, undefined)
})

/**
 * A Pi package on `PATH`, reached the way the shell reaches it.
 *
 * `core/pi-runtime.ts` spawns the bare name `pi` when nothing points it at a
 * bundled runtime, so the executable that actually runs is whatever `PATH`
 * resolves — usually a symlink into a package tree somewhere else entirely.
 * Capability has to be read from that tree, not from the symlink's directory.
 */
async function withPiOnPath<T>(
  models: Record<string, Record<string, unknown>> | null,
  fn: () => Promise<T>,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-path-'))
  const binDir = path.join(root, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const link = path.join(binDir, 'pi')

  if (models === null) {
    // An executable with no package layout around it at all.
    fs.writeFileSync(link, `#!/usr/bin/env node\n${ECHO_ARGS_PI}\n`, { mode: 0o755 })
  } else {
    const packageRoot = path.join(
      root,
      'lib',
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
    )
    const dataDir = path.join(
      packageRoot,
      'node_modules',
      '@earendil-works',
      'pi-ai',
      'dist',
      'providers',
      'data',
    )
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(
      path.join(dataDir, 'vendor.json'),
      JSON.stringify({ 'vendor-api': models }),
    )
    const cliDir = path.join(packageRoot, 'dist')
    fs.mkdirSync(cliDir, { recursive: true })
    const cliPath = path.join(cliDir, 'cli.js')
    fs.writeFileSync(cliPath, `#!/usr/bin/env node\n${ECHO_ARGS_PI}\n`, { mode: 0o755 })
    fs.symlinkSync(cliPath, link)
  }

  const originalOverride = process.env[PI_CLI_PATH_ENV]
  delete process.env[PI_CLI_PATH_ENV]
  try {
    return await withPath(binDir, fn)
  } finally {
    if (originalOverride !== undefined) process.env[PI_CLI_PATH_ENV] = originalOverride
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('the Pi on PATH is asked about itself, not assumed to be permissive', async () => {
  clearRuntimeEffortSupport()
  await withPiOnPath(
    {
      'fable-like': {
        id: 'fable-like',
        provider: 'vendor',
        reasoning: true,
        thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' },
      },
    },
    async () => {
      await assert.rejects(
        createPiProvider().execute({
          systemPrompt: 'system',
          userMessage: 'hello',
          model: 'vendor/fable-like',
          thinking: 'off' as never,
        }),
        /off/u,
      )
      const result = await createPiProvider().execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'vendor/fable-like',
        thinking: 'max' as never,
      })
      const args = JSON.parse(result.text) as string[]
      assert.equal(args[args.indexOf('--thinking') + 1], 'max')
    },
  )
})

test('a Pi whose capabilities cannot be read refuses what it cannot establish', async () => {
  // Older installations ship their model data as generated modules rather than
  // as the JSON this reader understands. "We could not find out" must not come
  // out as "off is supported", because the runtime would answer an unsupported
  // off with thinking. The three levels every agent file already carries keep
  // working, which is the whole of the compatibility promise here.
  clearRuntimeEffortSupport()
  await withPiOnPath(null, async () => {
    await assert.rejects(
      createPiProvider().execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'vendor/unknown-model',
        thinking: 'off' as never,
      }),
      /off/u,
    )
    const result = await createPiProvider().execute({
      systemPrompt: 'system',
      userMessage: 'hello',
      model: 'vendor/unknown-model',
      thinking: 'medium' as never,
    })
    const args = JSON.parse(result.text) as string[]
    assert.equal(args[args.indexOf('--thinking') + 1], 'medium')
  })
})

/**
 * Run something that will be refused, with a temporary directory of our own.
 *
 * `os.tmpdir()` reads `TMPDIR` on each call, so pointing it at an empty
 * directory makes every temporary file an adapter creates observable. The
 * assertion is that there are none: a turn refused before it starts has no
 * reason to have written anything.
 */
async function refusedTurnLeavesNoFiles(
  run: () => Promise<unknown>,
): Promise<void> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'effort-refusal-'))
  const originalTmpDir = process.env.TMPDIR
  process.env.TMPDIR = scratch
  try {
    await assert.rejects(run())
  } finally {
    if (originalTmpDir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = originalTmpDir
  }
  try {
    assert.deepEqual(
      fs.readdirSync(scratch),
      [],
      'a refused turn must not leave prompt files behind',
    )
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

test('a refused Pi turn writes no prompt files', async () => {
  clearRuntimeEffortSupport()
  await refusedTurnLeavesNoFiles(() =>
    createPiProvider().execute({
      systemPrompt: 'system',
      userMessage: 'hello',
      model: 'vendor/unestablished-model',
      thinking: 'off' as never,
    }),
  )
})

test('a refused Codex turn writes no instructions file', async () => {
  clearRuntimeEffortSupport()
  await refusedTurnLeavesNoFiles(() =>
    createCodexProvider().execute({
      systemPrompt: 'system',
      userMessage: 'hello',
      model: 'gpt-6-astra',
      // Codex has never published `off`, so this is refused on the grammar
      // alone and needs nothing seeded.
      thinking: 'off' as never,
    }),
  )
})

test('a refused Gemini turn writes nothing, and a refused Claude Code turn cleans up after itself', async () => {
  // Two different mechanisms, both worth holding: the Gemini adapter refuses
  // before it makes a directory, and the shared CLI runner removes the one it
  // already made when an invocation cannot be built. A refusal is new
  // behaviour on both paths, so neither is covered by anything older.
  clearRuntimeEffortSupport()
  await refusedTurnLeavesNoFiles(() =>
    createGeminiProvider().execute({
      systemPrompt: 'system',
      userMessage: 'hello',
      model: 'pro',
      thinking: 'xhigh' as never,
    }),
  )
  await refusedTurnLeavesNoFiles(() =>
    createClaudeProvider().execute({
      systemPrompt: 'system',
      userMessage: 'hello',
      model: 'sonnet',
      thinking: 'ultra' as never,
    }),
  )
})

test('a level chosen for Claude Opus 4.8 reaches the CLI as its own flag', async () => {
  // One of the two pairs whose menu was empty. The menu is fixed elsewhere;
  // this is the other half of that claim, that a level chosen there is a level
  // the turn actually carries.
  clearRuntimeEffortSupport()
  const args = await withFakeCli('claude', ECHO_ARGS_CLAUDE, async (binDir) =>
    withPath(binDir, async () => {
      const result = await createClaudeProvider().execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'opus',
        thinking: 'xhigh' as never,
      })
      return JSON.parse(result.text) as string[]
    }),
  )
  assert.equal(args[args.indexOf('--effort') + 1], 'xhigh')
})

test('a level chosen for a native GPT-5.6 model reaches the request body', async () => {
  // The other empty menu. `off` matters here because this model documents
  // `none`, and omitting the field would let the vendor reason instead.
  clearRuntimeEffortSupport()
  const originalKey = process.env.OPENAI_API_KEY
  const originalFetch = globalThis.fetch
  process.env.OPENAI_API_KEY = 'test-key'
  const bodies: Record<string, unknown>[] = []
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(
      JSON.stringify({ model: 'gpt-5.6-sol', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    for (const thinking of ['xhigh', 'off']) {
      await createOpenAIProvider().execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'gpt-5.6-sol',
        thinking: thinking as never,
      })
    }
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalKey
  }
  assert.deepEqual(bodies[0]?.reasoning, { effort: 'xhigh' })
  assert.deepEqual(bodies[1]?.reasoning, { effort: 'none' })
})
