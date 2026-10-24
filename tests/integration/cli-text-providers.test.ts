import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { createClaudeProvider } from '../../providers/claude.js'
import { createTextCliProvider } from '../../providers/text-cli.js'
import { createKimiCliProvider } from '../../providers/kimi-cli.js'
import { createQwenProvider } from '../../providers/qwen.js'
import { createGeminiProvider } from '../../providers/gemini.js'
import { createPiProvider } from '../../providers/pi.js'
import { createCodexProvider } from '../../providers/codex.js'
import { createAnthropicProvider } from '../../providers/anthropic.js'
import { createOpenAIProvider } from '../../providers/openai.js'
import { createXAIProvider } from '../../providers/xai.js'
import { createDeepSeekProvider } from '../../providers/deepseek.js'
import { createKimiProvider } from '../../providers/kimi.js'
import { createOpenRouterProvider } from '../../providers/openrouter.js'
import { createLmStudioProvider } from '../../providers/lm-studio.js'
import type { Provider, ProviderMcpBridge } from '../../providers/types.js'
import {
  CLI_PROVIDER_MAX_STDERR_BYTES,
  CLI_PROVIDER_MAX_STDOUT_BYTES,
} from '../../core/constants.js'
import {
  ProviderError,
  formatProviderErrorForUser,
} from '../../domains/provider/provider-error.js'
import {
  LEGACY_BUILTIN_PROVIDER_ID,
  LEGACY_UNRESOLVED_MODEL_ID,
  PROVIDER_CHOSEN_DEFAULT_PROVIDERS,
} from '../../contracts/agent-model-selection.js'
import { PROVIDER_DEFAULT_THINKING } from '../../contracts/thinking-levels.js'
import { KNOWN_AGENT_PROVIDER_NAMES } from '../../domains/provider/provider-preflight.js'
import * as z from 'zod/v4'

test('Claude CLI receives visual content through structured stdin without enabling native tools', async () => {
  // Replace the paid subscription process boundary; the invocation builder stays real.
  await withFakeCli('claude', `
const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => process.stdout.write(JSON.stringify({ result: JSON.stringify({ args: process.argv.slice(2), stdin: Buffer.concat(chunks).toString('utf8') }) })))
`, async (binDir) => withPath(binDir, async () => {
    const result = await createClaudeProvider().execute({ systemPrompt: 'system', userMessage: 'Describe this.', model: 'sonnet', thinking: 'medium',
      images: [{ mimeType: 'image/jpeg', data: '/9j/2Q==' }],
    })
    const payload = z.object({ args: z.array(z.string()), stdin: z.string() }).parse(JSON.parse(result.text))
    assert.equal(payload.args[payload.args.indexOf('--input-format') + 1], 'stream-json')
    assert.equal(payload.args[payload.args.indexOf('--tools') + 1], '')
    assert.deepEqual(JSON.parse(payload.stdin), { type: 'user', message: { role: 'user', content: [
      { type: 'text', text: 'Describe this.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/2Q==' } },
    ] } })
  }))
})

const TEST_MCP_BRIDGE: ProviderMcpBridge = {
  url: 'http://127.0.0.1:43119/turn-bridge',
  tokenEnvironmentVariable: 'PIPELINE_MCP_BRIDGE_TOKEN',
  token: 'test-bridge-token-do-not-persist',
  proxyToolNames: ['search_public_data', 'query_records'],
}

function withFakeCli<T>(
  command: string,
  handlerSource: string,
  fn: (binDir: string) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fake-${command}-bin-`))
  const scriptPath = path.join(dir, command)
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node\n${handlerSource}\n`, {
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

test('Claude CLI provider invokes print JSON mode and parses usage', async () => {
  await withFakeCli(
    'claude',
    `
const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
  const stdin = Buffer.concat(chunks).toString()
  process.stdout.write(JSON.stringify({
    result: 'Claude reply: ' + stdin,
    model: 'claude-sonnet-4-6',
    usage: { input_tokens: 11, output_tokens: 7 },
    total_cost_usd: 0.02,
    duration_ms: 1234,
    args: process.argv.slice(2),
  }))
})

`,
    async (binDir) => withPath(binDir, async () => {
      const provider = createClaudeProvider()
      const result = await provider.execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'sonnet',
        thinking: 'medium',
      })

      assert.equal(result.text, 'Claude reply: hello')
      assert.equal(result.model, 'claude-sonnet-4-6')
      assert.equal(result.inputTokens, 11)
      assert.equal(result.outputTokens, 7)
      assert.equal(result.contextTokens, 18)
      assert.equal(result.cost, 0.02)
      assert.equal(result.durationMs, 1234)
    }),
  )
})

test('Claude CLI provider transports application instructions through a private prompt file', async () => {
  const systemPrompt = `Workflow Architect instructions\n${'constraint\n'.repeat(2_000)}`

  await withFakeCli(
    'claude',
    `
const fs = require('node:fs')
const args = process.argv.slice(2)
const promptFileIndex = args.indexOf('--system-prompt-file')
const promptFile = promptFileIndex < 0 ? null : args[promptFileIndex + 1]
process.stdout.write(JSON.stringify({
  result: JSON.stringify({
    args,
    prompt: promptFile === null ? null : fs.readFileSync(promptFile, 'utf8'),
    mode: promptFile === null ? null : fs.statSync(promptFile).mode & 0o777,
  }),
}))
`,
    async (binDir) => withPath(binDir, async () => {
      const result = await createClaudeProvider().execute({
        systemPrompt,
        userMessage: 'hello',
        model: 'haiku',
        thinking: 'medium',
      })
      const payload = JSON.parse(result.text) as {
        args: string[]
        prompt: string | null
        mode: number | null
      }

      assert.equal(payload.args.includes('--system-prompt'), false)
      assert.notEqual(payload.args.indexOf('--system-prompt-file'), -1)
      const settingsSourcesIndex = payload.args.indexOf('--setting-sources')
      assert.notEqual(settingsSourcesIndex, -1)
      assert.equal(payload.args[settingsSourcesIndex + 1], '')
      assert.equal(payload.prompt, systemPrompt)
      assert.equal(payload.mode, 0o600)
    }),
  )
})

test('Claude CLI provider enforces an output schema and prefers structured_output', async () => {
  const schema = {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
    additionalProperties: false,
  } as const

  await withFakeCli(
    'claude',
    `
const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    result: 'unconstrained prose with a fenced block',
    structured_output: { message: 'structured reply', args: process.argv.slice(2) },
  }))
})
`,
    async (binDir) => withPath(binDir, async () => {
      const result = await createClaudeProvider().execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'haiku',
        thinking: 'medium',
        outputSchema: schema,
      })
      const structured = JSON.parse(result.text) as {
        message: string
        args: string[]
      }
      assert.equal(structured.message, 'structured reply')
      const schemaIndex = structured.args.indexOf('--json-schema')
      assert.notEqual(schemaIndex, -1)
      assert.deepEqual(
        JSON.parse(structured.args[schemaIndex + 1] ?? ''),
        schema,
      )
    }),
  )
})

test('Claude CLI provider omits the output schema flag when none is supplied', async () => {
  await withFakeCli(
    'claude',
    `
const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    result: JSON.stringify({ args: process.argv.slice(2) }),
  }))
})
`,
    async (binDir) => withPath(binDir, async () => {
      const result = await createClaudeProvider().execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'haiku',
        thinking: 'medium',
      })
      const parsed = JSON.parse(result.text) as { args: string[] }
      assert.equal(parsed.args.includes('--json-schema'), false)
    }),
  )
})

test('Claude CLI provider ignores direct API credentials in favor of subscription auth', async () => {
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY
  const originalClaudeKey = process.env.CLAUDE_API_KEY
  process.env.ANTHROPIC_API_KEY = 'direct-anthropic-key'
  process.env.CLAUDE_API_KEY = 'direct-claude-key'
  try {
    await withFakeCli(
      'claude',
      `
process.stdout.write(JSON.stringify({
  result: JSON.stringify({
    anthropic: process.env.ANTHROPIC_API_KEY ?? null,
    claude: process.env.CLAUDE_API_KEY ?? null,
  }),
}))
`,
      async (binDir) => withPath(binDir, async () => {
        const result = await createClaudeProvider().execute({
          systemPrompt: 'system',
          userMessage: 'hello',
          model: 'default',
          thinking: 'low',
        })
        assert.deepEqual(JSON.parse(result.text), {
          anthropic: null,
          claude: null,
        })
      }),
    )
  } finally {
    if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey
    if (originalClaudeKey === undefined) delete process.env.CLAUDE_API_KEY
    else process.env.CLAUDE_API_KEY = originalClaudeKey
  }
})

test('Claude CLI provider normalizes session-limit JSON emitted on stdout', async () => {
  const payload = {
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: 429,
    result: "You've hit your session limit · resets 10:30pm (America/Detroit)",
    session_id: '9140dc75-70aa-4c6a-9549-03a2673a3894',
    usage: { input_tokens: 0, output_tokens: 0 },
  }

  await withFakeCli(
    'claude',
    `
process.stderr.write('subscription limit reached\\n')
process.stdout.write(${JSON.stringify(JSON.stringify(payload))})
process.exit(1)
`,
    async (binDir) => withPath(binDir, async () => {
      await assert.rejects(
        createClaudeProvider().execute({
          systemPrompt: 'system',
          userMessage: 'hello',
          model: 'sonnet',
          thinking: 'low',
        }),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError)
          assert.equal(error.statusCode, 429)
          assert.equal(error.kind, 'session_limit')
          assert.equal(error.retryable, false)
          assert.equal(error.message.includes('session_id'), false)
          assert.equal(
            formatProviderErrorForUser(error),
            "You've hit your session limit. It resets at 10:30 PM (America/Detroit). (Status 429)",
          )
          return true
        },
      )
    }),
  )
})

test('Claude CLI provider does not retry statusless authentication failures', async () => {
  await withFakeCli(
    'claude',
    `
process.stdout.write(JSON.stringify({
  type: 'error',
  message: 'Invalid API key supplied',
}))
process.exit(1)
`,
    async (binDir) => withPath(binDir, async () => {
      await assert.rejects(
        createClaudeProvider().execute({
          systemPrompt: 'system',
          userMessage: 'hello',
          model: 'sonnet',
          thinking: 'low',
        }),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError)
          assert.equal(error.kind, 'authentication')
          assert.equal(error.retryable, false)
          assert.equal(
            formatProviderErrorForUser(error),
            'Authentication failed. Reconnect the provider and try again.',
          )
          return true
        },
      )
    }),
  )
})

test('Claude CLI provider starts an ungranted turn with no ambient MCP integrations', async () => {
  // Without --strict-mcp-config the installed CLI still discovers every MCP
  // server configured on the machine, so an application turn that was granted
  // no Pipeline bridge can still reach Monday, Vercel, or any other connected
  // integration. Verified against Claude Code 2.1.251: the same invocation
  // without the flag lists `mcp__claude_ai_monday_com__*` in its init record.
  await withFakeCli(
    'claude',
    `
const fs = require('node:fs')
const args = process.argv.slice(2)
const configIndex = args.indexOf('--mcp-config')
const configPath = configIndex === -1 ? null : args[configIndex + 1]
process.stdout.write(JSON.stringify({
  result: JSON.stringify({
    args,
    mcpConfigText: configPath ? fs.readFileSync(configPath, 'utf8') : null,
    mcpConfigMode: configPath ? (fs.statSync(configPath).mode & 0o777) : null,
  }),
}))
`,
    async (binDir) => withPath(binDir, async () => {
      const result = await createClaudeProvider().execute({
        systemPrompt: 'Draft one section from the supplied evidence.',
        userMessage: 'Draft it.',
        model: 'sonnet',
        thinking: 'medium',
      })
      const payload = JSON.parse(result.text) as {
        args: string[]
        mcpConfigText: string | null
        mcpConfigMode: number | null
      }

      assert.ok(
        payload.args.includes('--strict-mcp-config'),
        'an ungranted Claude turn still loads ambient MCP configurations',
      )
      assert.ok(payload.mcpConfigText, 'no runtime-owned MCP configuration was written')
      assert.deepEqual(
        JSON.parse(payload.mcpConfigText ?? 'null'),
        { mcpServers: {} },
        'the ungranted turn was given MCP servers it was not granted',
      )
      assert.equal(payload.mcpConfigMode, 0o600)
      assert.equal(payload.args[payload.args.indexOf('--tools') + 1], '')
      assert.equal(
        payload.args.includes('--allowedTools'),
        false,
        'an ungranted turn must not allow-list any tool',
      )
    }),
  )
})

test('Claude CLI provider loads only the ephemeral MCP bridge with exact tool grants', async () => {
  await withFakeCli(
    'claude',
    `
const fs = require('node:fs')
const args = process.argv.slice(2)
const configPath = args[args.indexOf('--mcp-config') + 1]
const configText = fs.readFileSync(configPath, 'utf8')
const config = JSON.parse(configText)
const pipelineMcp = config.mcpServers.pipeline
const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    result: JSON.stringify({
      args,
      mcpServerType: pipelineMcp.type,
      mcpServerUrl: pipelineMcp.url,
      authorizationMatches: pipelineMcp.headers.Authorization === 'Bearer ' + ${JSON.stringify(TEST_MCP_BRIDGE.token)},
      configTextContainsToken: configText.includes(${JSON.stringify(TEST_MCP_BRIDGE.token)}),
      configMode: fs.statSync(configPath).mode & 0o777,
      tokenPresent: process.env.PIPELINE_MCP_BRIDGE_TOKEN === ${JSON.stringify(TEST_MCP_BRIDGE.token)},
      stdin: Buffer.concat(chunks).toString(),
    }),
  }))
})
`,
    async (binDir) => withPath(binDir, async () => {
      const result = await createClaudeProvider().execute({
        systemPrompt: 'MCP-only system prompt',
        userMessage: 'Use the granted data tool.',
        model: 'sonnet',
        thinking: 'medium',
        mcpBridge: TEST_MCP_BRIDGE,
      })
      const payload = JSON.parse(result.text) as {
        args: string[]
        mcpServerType: string
        mcpServerUrl: string
        authorizationMatches: boolean
        configTextContainsToken: boolean
        configMode: number
        tokenPresent: boolean
        stdin: string
      }

      assert.ok(payload.args.includes('--setting-sources'))
      assert.equal(payload.args[payload.args.indexOf('--setting-sources') + 1], '')
      assert.ok(payload.args.includes('--disable-slash-commands'))
      assert.ok(payload.args.includes('--strict-mcp-config'))
      assert.deepEqual(
        payload.args.slice(payload.args.indexOf('--allowedTools') + 1),
        [
          'ToolSearch',
          ...TEST_MCP_BRIDGE.proxyToolNames.map((name) => `mcp__pipeline__${name}`),
        ],
      )
      assert.equal(payload.args[payload.args.indexOf('--tools') + 1], 'ToolSearch')
      assert.equal(
        payload.args[payload.args.indexOf('--permission-mode') + 1],
        'dontAsk',
      )
      assert.equal(payload.mcpServerType, 'http')
      assert.equal(payload.mcpServerUrl, TEST_MCP_BRIDGE.url)
      assert.equal(payload.authorizationMatches, true)
      assert.equal(payload.configTextContainsToken, true)
      assert.equal(payload.configMode, 0o600)
      assert.equal(payload.tokenPresent, false)
      assert.equal(payload.stdin, 'Use the granted data tool.')
    }),
  )
})

test('CLI provider redacts the MCP bridge token from process failures', async () => {
  await withFakeCli(
    'claude',
    `
const fs = require('node:fs')
const args = process.argv.slice(2)
const configPath = args[args.indexOf('--mcp-config') + 1]
process.stderr.write(fs.readFileSync(configPath, 'utf8'))
process.exit(7)
`,
    async (binDir) => withPath(binDir, async () => {
      await assert.rejects(
        () => createClaudeProvider().execute({
          systemPrompt: 'system',
          userMessage: 'hello',
          model: 'sonnet',
          thinking: 'low',
          mcpBridge: TEST_MCP_BRIDGE,
        }),
        (error: Error) => {
          assert.equal(error.message.includes(TEST_MCP_BRIDGE.token), false)
          assert.ok(error.message.includes('[REDACTED]'))
          return true
        },
      )
    }),
  )
})

test('CLI provider redacts the MCP bridge token from a terminal model name', async () => {
  // The answer text is redacted, but the model name travels beside it into the
  // stored `ProviderResult` and into every lifecycle event built from it. A
  // model that can see its own bearer token can put it in any field, so the
  // one that reaches storage untouched is the one that leaks.
  const stdout =
    [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'A good answer.',
        model: `claude-${TEST_MCP_BRIDGE.token}`,
      }),
    ].join('\n') + '\n'

  await withFakeCli(
    'claude',
    `process.stdout.write(${JSON.stringify(stdout)})`,
    async (binDir) => withPath(binDir, async () => {
      const result = await createClaudeProvider().execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'sonnet',
        thinking: 'low',
        mcpBridge: TEST_MCP_BRIDGE,
      })

      assert.equal(result.text, 'A good answer.', 'a good answer still comes back')
      assert.equal(
        result.model.includes(TEST_MCP_BRIDGE.token),
        false,
        `the stored model still carries the bridge credential: ${result.model}`,
      )
      assert.equal(result.model, 'claude-[REDACTED]')
    }),
  )
})

test('CLI provider redacts the MCP bridge token from a reader refusal', async () => {
  // A reader refuses by describing what it found, and what it found is CLI
  // output — so a field the model controls ends up quoted in the error
  // message, which is logged and handed to the caller. Rebuilding the error
  // has to keep everything else it carries: a redacted failure that lost its
  // retry policy would change how the attempt loop behaves.
  const stdout =
    JSON.stringify({
      type: 'result',
      subtype: TEST_MCP_BRIDGE.token,
      is_error: false,
    }) + '\n'

  await withFakeCli(
    'claude',
    `process.stdout.write(${JSON.stringify(stdout)})`,
    async (binDir) => withPath(binDir, async () => {
      await assert.rejects(
        () => createClaudeProvider().execute({
          systemPrompt: 'system',
          userMessage: 'hello',
          model: 'sonnet',
          thinking: 'low',
          mcpBridge: TEST_MCP_BRIDGE,
        }),
        (error: unknown) => {
          assert.ok(
            error instanceof ProviderError,
            `expected a ProviderError, got ${String(error)}`,
          )
          assert.equal(
            error.message.includes(TEST_MCP_BRIDGE.token),
            false,
            `the refusal still quotes the bridge credential: ${error.message}`,
          )
          assert.ok(error.message.includes('[REDACTED]'))
          assert.equal(error.provider, 'claude')
          assert.equal(
            error.retryable,
            false,
            'a terminal that did not succeed stays non-retryable through redaction',
          )
          return true
        },
      )
    }),
  )
})

test('Kimi CLI provider invokes non-interactive final-message text mode', async () => {
  await withFakeCli(
    'kimi',
    `
const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    args: process.argv.slice(2),
    stdin: Buffer.concat(chunks).toString(),
  }))
})
`,
    async (binDir) => withPath(binDir, async () => {
      const provider = createKimiCliProvider()
      const result = await provider.execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'kimi-k2.6',
        thinking: 'high',
      })
      const payload = JSON.parse(result.text) as { args: string[]; stdin: string }

      assert.ok(payload.args.includes('--print'))
      assert.ok(payload.args.includes('--final-message-only'))
      assert.ok(payload.args.includes('--input-format'))
      assert.ok(payload.args.includes('kimi-k2.6'))
      assert.ok(payload.args.includes('--thinking'))
      assert.ok(payload.stdin.includes('<system-instructions>'))
      assert.ok(payload.stdin.includes('system'))
      assert.ok(payload.stdin.includes('hello'))
    }),
  )
})

test('Kimi CLI provider isolates authentication from tools and loads only the MCP bridge', async () => {
  const sourceShareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-source-home-'))
  fs.mkdirSync(path.join(sourceShareDir, 'credentials'), { mode: 0o700 })
  fs.mkdirSync(path.join(sourceShareDir, 'plugins', 'untrusted'), { recursive: true })
  fs.writeFileSync(
    path.join(sourceShareDir, 'config.toml'),
    [
      'default_model = "kimi"',
      'default_yolo = true',
      'hooks = ["unsafe-hook"]',
      'merge_all_available_skills = true',
      'extra_skill_dirs = ["/unsafe-skills"]',
      'telemetry = true',
      '',
    ].join('\n'),
  )
  fs.writeFileSync(path.join(sourceShareDir, 'credentials', 'kimi-code.json'), '{"token":"auth"}')
  fs.writeFileSync(path.join(sourceShareDir, 'mcp.json'), '{"mcpServers":{"other":{}}}')
  fs.writeFileSync(path.join(sourceShareDir, 'plugins', 'untrusted', 'plugin.json'), '{}')
  const originalKimiShareDir = process.env.KIMI_SHARE_DIR
  process.env.KIMI_SHARE_DIR = sourceShareDir

  try {
    await withFakeCli(
      'kimi',
      `
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const agentPath = args[args.indexOf('--agent-file') + 1]
const mcpPath = args[args.indexOf('--mcp-config-file') + 1]
const skillsPath = args[args.indexOf('--skills-dir') + 1]
const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
  const agent = JSON.parse(fs.readFileSync(agentPath, 'utf8'))
  const mcpText = fs.readFileSync(mcpPath, 'utf8')
  const mcp = JSON.parse(mcpText)
  const pipelineMcp = mcp.mcpServers.pipeline
  process.stdout.write(JSON.stringify({
    args,
    agent,
    mcpServerUrl: pipelineMcp.url,
    mcpTransport: pipelineMcp.transport,
    authorizationMatches: pipelineMcp.headers.Authorization === 'Bearer ' + ${JSON.stringify(TEST_MCP_BRIDGE.token)},
    mcpTextContainsToken: mcpText.includes(${JSON.stringify(TEST_MCP_BRIDGE.token)}),
    systemPrompt: fs.readFileSync(path.join(path.dirname(agentPath), agent.agent.system_prompt_path), 'utf8'),
    agentMode: fs.statSync(agentPath).mode & 0o777,
    mcpMode: fs.statSync(mcpPath).mode & 0o777,
    isolatedHome: process.env.KIMI_SHARE_DIR,
    homesMatch: process.env.KIMI_SHARE_DIR === process.env.KIMI_CODE_HOME,
    configCopied: fs.existsSync(path.join(process.env.KIMI_SHARE_DIR, 'config.toml')),
    copiedConfigText: fs.readFileSync(path.join(process.env.KIMI_SHARE_DIR, 'config.toml'), 'utf8'),
    credentialsCopied: fs.existsSync(path.join(process.env.KIMI_SHARE_DIR, 'credentials', 'kimi-code.json')),
    pluginCopied: fs.existsSync(path.join(process.env.KIMI_SHARE_DIR, 'plugins')),
    globalMcpCopied: fs.existsSync(path.join(process.env.KIMI_SHARE_DIR, 'mcp.json')),
    skills: fs.readdirSync(skillsPath),
    tokenPresent: process.env.PIPELINE_MCP_BRIDGE_TOKEN === ${JSON.stringify(TEST_MCP_BRIDGE.token)},
    stdin: Buffer.concat(chunks).toString(),
  }))
})
`,
      async (binDir) => withPath(binDir, async () => {
        const result = await createKimiCliProvider().execute({
          systemPrompt: 'MCP-only Kimi system prompt',
          userMessage: 'Use the granted data tool.',
          model: 'kimi-k2.6',
          thinking: 'high',
          mcpBridge: TEST_MCP_BRIDGE,
        })
        const payload = JSON.parse(result.text) as {
          args: string[]
          agent: { agent: { tools: unknown[]; subagents: Record<string, unknown> } }
          mcpServerUrl: string
          mcpTransport: string
          authorizationMatches: boolean
          mcpTextContainsToken: boolean
          systemPrompt: string
          agentMode: number
          mcpMode: number
          isolatedHome: string
          homesMatch: boolean
          configCopied: boolean
          copiedConfigText: string
          credentialsCopied: boolean
          pluginCopied: boolean
          globalMcpCopied: boolean
          skills: string[]
          tokenPresent: boolean
          stdin: string
        }

        assert.ok(payload.args.includes('--agent-file'))
        assert.ok(payload.args.includes('--mcp-config-file'))
        assert.ok(payload.args.includes('--skills-dir'))
        assert.equal(payload.args.includes('--yolo'), false)
        assert.equal(payload.args.includes('--afk'), false)
        assert.equal(payload.args.includes('--auto-approve'), false)
        assert.deepEqual(payload.agent.agent.tools, [])
        assert.deepEqual(payload.agent.agent.subagents, {})
        assert.equal(payload.mcpServerUrl, TEST_MCP_BRIDGE.url)
        assert.equal(payload.mcpTransport, 'http')
        assert.equal(payload.authorizationMatches, true)
        assert.equal(payload.mcpTextContainsToken, true)
        assert.equal(payload.systemPrompt, 'MCP-only Kimi system prompt')
        assert.equal(payload.agentMode, 0o600)
        assert.equal(payload.mcpMode, 0o600)
        assert.notEqual(payload.isolatedHome, sourceShareDir)
        assert.equal(payload.homesMatch, true)
        assert.equal(payload.configCopied, true)
        assert.equal(payload.credentialsCopied, true)
        assert.equal(payload.pluginCopied, false)
        assert.equal(payload.globalMcpCopied, false)
        assert.deepEqual(payload.skills, [])
        for (const expected of [
          'default_yolo = false',
          'default_plan_mode = false',
          'skip_afk_prompt_injection = true',
          'hooks = []',
          'merge_all_available_skills = false',
          'extra_skill_dirs = []',
          'telemetry = false',
        ]) {
          assert.ok(payload.copiedConfigText.includes(expected), expected)
        }
        assert.equal(payload.copiedConfigText.includes('unsafe-hook'), false)
        assert.equal(payload.copiedConfigText.includes('/unsafe-skills'), false)
        assert.equal(payload.tokenPresent, false)
        assert.equal(payload.stdin, 'Use the granted data tool.')
      }),
    )
  } finally {
    if (originalKimiShareDir === undefined) delete process.env.KIMI_SHARE_DIR
    else process.env.KIMI_SHARE_DIR = originalKimiShareDir
    fs.rmSync(sourceShareDir, { recursive: true, force: true })
  }
})

test('CLI MCP bridges reject non-loopback endpoints before spawning a provider', async () => {
  await assert.rejects(
    () => createClaudeProvider().execute({
      systemPrompt: 'system',
      userMessage: 'hello',
      model: 'sonnet',
      thinking: 'low',
      mcpBridge: {
        ...TEST_MCP_BRIDGE,
        url: 'https://mcp.example.com/bridge',
      },
    }),
    /MCP bridge configuration is invalid/,
  )
})

test('text CLI providers do not spawn for an already-cancelled turn', async () => {
  const markerPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cancelled-cli-marker-')),
    'spawned',
  )
  const controller = new AbortController()
  controller.abort()
  try {
    await withFakeCli(
      'claude',
      `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'spawned')`,
      async (binDir) => withPath(binDir, async () => {
        await assert.rejects(
          createClaudeProvider().execute({
            systemPrompt: 'system',
            userMessage: 'hello',
            model: 'default',
            thinking: 'low',
            signal: controller.signal,
          }),
          /cancelled/i,
        )
      }),
    )
    assert.equal(fs.existsSync(markerPath), false)
  } finally {
    fs.rmSync(path.dirname(markerPath), { recursive: true, force: true })
  }
})

test('text CLI providers terminate oversized stdout and stderr', async () => {
  await withFakeCli(
    'claude',
    `process.stdout.write(Buffer.alloc(${CLI_PROVIDER_MAX_STDOUT_BYTES + 1}, 120))`,
    async (binDir) => withPath(binDir, async () => {
      await assert.rejects(
        createClaudeProvider().execute({
          systemPrompt: 'system',
          userMessage: 'hello',
          model: 'default',
          thinking: 'low',
        }),
        /stdout output limit/i,
      )
    }),
  )

  await withFakeCli(
    'kimi',
    `process.stderr.write(Buffer.alloc(${CLI_PROVIDER_MAX_STDERR_BYTES + 1}, 120))`,
    async (binDir) => withPath(binDir, async () => {
      await assert.rejects(
        createKimiCliProvider().execute({
          systemPrompt: 'system',
          userMessage: 'hello',
          model: 'default',
          thinking: 'low',
        }),
        /stderr output limit/i,
      )
    }),
  )
})

test('Qwen CLI provider invokes headless prompt mode with plan approvals', async () => {
  await withFakeCli(
    'qwen',
    `
process.stdout.write(JSON.stringify({ args: process.argv.slice(2) }))
`,
    async (binDir) => withPath(binDir, async () => {
      const provider = createQwenProvider()
      const result = await provider.execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'qwen3-coder-plus',
        thinking: 'low',
      })
      const payload = JSON.parse(result.text) as { args: string[] }

      assert.ok(payload.args.includes('--model'))
      assert.ok(payload.args.includes('qwen3-coder-plus'))
      assert.equal(
        payload.args[payload.args.indexOf('--output-format') + 1],
        'stream-json',
        'partial assistant messages exist only on this format',
      )
      assert.ok(payload.args.includes('--include-partial-messages'))
      assert.ok(payload.args.includes('--approval-mode'))
      assert.ok(payload.args.includes('plan'))
      assert.ok(payload.args.includes('--system-prompt'))
      assert.ok(payload.args.includes('system'))
      assert.ok(payload.args.includes('--prompt'))
      assert.ok(payload.args.includes('hello'))
    }),
  )
})

// ─── Claude Code streaming ─────────────────────────────────────────────────

/**
 * Verified against the installed Claude Code 2.1.241:
 *
 * - `--output-format stream-json` and `--include-partial-messages` both exist
 *   and both say "only works with --print", which this provider already passes.
 * - The bundle refuses the combination without `--verbose`: "Error: When using
 *   --print, --output-format=stream-json requires --verbose".
 * - Partial messages are yielded as `{ type: 'stream_event', event }`, where
 *   `event` is the raw Anthropic Messages stream event. So a visible token is
 *   a `content_block_delta` whose `delta.type` is `text_delta`; a
 *   `thinking_delta` rides the same envelope and is not the answer.
 * - The turn still ends with the same terminal object `--output-format json`
 *   prints on its own: `{ type: 'result', subtype: 'success', result,
 *   total_cost_usd, duration_ms, usage, ... }`. That object stays the
 *   authority for everything the turn stores.
 */
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

interface StreamingClaudeCli {
  readonly binDirectory: string
  readonly releaseMarkerPath: string
  readonly argvPath: string
}

function writeStreamingClaudeCli(options: {
  readonly beforeTerminal: readonly unknown[]
  readonly terminal: unknown
}): StreamingClaudeCli {
  const binDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-stream-'))
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
    // Armed before the first delta is written, so the release cannot be
    // missed however quickly the parent reacts to one.
    'const watcher = fs.watch(releaseDirectory, () => {',
    '  if (!fs.existsSync(releaseMarkerPath)) return',
    '  watcher.close()',
    '  write(terminal)',
    '})',
    ...options.beforeTerminal.map((line) => `write(${JSON.stringify(line)})`),
    // One check, after the deltas are out: a caller that released the CLI
    // before it started still gets its terminal line, and a marker created
    // between arming and this point cannot be missed.
    'if (fs.existsSync(releaseMarkerPath)) { watcher.close(); write(terminal) }',
    '',
  ].join('\n')

  fs.writeFileSync(path.join(binDirectory, 'claude'), script, { mode: 0o755 })
  return { binDirectory, releaseMarkerPath, argvPath }
}

function makeClaudeStreamEvent(event: unknown): unknown {
  return { type: 'stream_event', event }
}

const CLAUDE_TERMINAL_RESULT: unknown = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 1,
  duration_ms: 1234,
  duration_api_ms: 1100,
  result: 'Hello world',
  model: 'claude-sonnet-4-6',
  stop_reason: null,
  total_cost_usd: 0.02,
  usage: { input_tokens: 11, output_tokens: 7 },
  session_id: 'fake-session',
}

const CLAUDE_STREAM_LINES: readonly unknown[] = [
  { type: 'system', subtype: 'init', session_id: 'fake-session', model: 'claude-sonnet-4-6' },
  makeClaudeStreamEvent({
    type: 'message_start',
    message: { id: 'msg_1', role: 'assistant', model: 'claude-sonnet-4-6', content: [] },
  }),
  makeClaudeStreamEvent({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'thinking', thinking: '' },
  }),
  makeClaudeStreamEvent({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'private reasoning the user must never see' },
  }),
  makeClaudeStreamEvent({ type: 'content_block_stop', index: 0 }),
  makeClaudeStreamEvent({
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'text', text: '' },
  }),
  makeClaudeStreamEvent({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'text_delta', text: 'Hello ' },
  }),
  makeClaudeStreamEvent({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'text_delta', text: 'world' },
  }),
  makeClaudeStreamEvent({ type: 'content_block_stop', index: 1 }),
  // The whole assistant message, repeated. Forwarding it would show the answer
  // a second time immediately after it finished arriving token by token.
  {
    type: 'assistant',
    message: {
      id: 'msg_1',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [
        { type: 'thinking', thinking: 'private reasoning the user must never see' },
        { type: 'text', text: 'Hello world' },
      ],
    },
  },
]

test('Claude CLI provider streams committed answer text before the turn resolves', { timeout: HANDSHAKE_FAILSAFE_TIMEOUT_MS }, async (t) => {
  const cli = writeStreamingClaudeCli({
    beforeTerminal: CLAUDE_STREAM_LINES,
    terminal: CLAUDE_TERMINAL_RESULT,
  })

  try {
    await withPath(cli.binDirectory, async () => {
      const deltas: string[] = []

      // The fake CLI cannot write its terminal `result` line, and so cannot
      // exit, until the release marker exists. Only this observer creates it,
      // and only after a second delta. A provider that produced its text after
      // the child closed would never release it, so this turn would not finish.
      const result = await createClaudeProvider().execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'sonnet',
        thinking: 'medium',
        signal: t.signal,
        onProtocolEvent: (event) => {
          if (event.kind !== 'text' || event.text === undefined) return
          deltas.push(event.text)
          if (deltas.length === 2) fs.writeFileSync(cli.releaseMarkerPath, '')
        },
      })

      assert.deepEqual(
        deltas,
        ['Hello ', 'world'],
        'one text event per committed text_delta; the thinking_delta and the ' +
          'repeated whole assistant message are excluded',
      )

      assert.deepEqual(
        {
          text: result.text,
          model: result.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          contextTokens: result.contextTokens,
          cost: result.cost,
          durationMs: result.durationMs,
        },
        {
          text: 'Hello world',
          model: 'claude-sonnet-4-6',
          inputTokens: 11,
          outputTokens: 7,
          contextTokens: 18,
          cost: 0.02,
          durationMs: 1234,
        },
        'the terminal result object stays the authority for what the turn stores',
      )

      const argv: unknown = JSON.parse(fs.readFileSync(cli.argvPath, 'utf8'))
      assert.ok(Array.isArray(argv))
      const args: string[] = argv.filter((value): value is string => typeof value === 'string')
      assert.equal(
        args[args.indexOf('--output-format') + 1],
        'stream-json',
        'partial messages are only available on the stream-json output format',
      )
      assert.ok(
        args.includes('--include-partial-messages'),
        'without this flag the CLI reports only whole messages',
      )
      assert.ok(
        args.includes('--verbose'),
        'the CLI refuses --print with stream-json unless --verbose is passed',
      )
    })
  } finally {
    fs.rmSync(cli.binDirectory, { recursive: true, force: true })
  }
})

test('Claude CLI provider stores the terminal result even when the deltas disagree', async () => {
  const cli = writeStreamingClaudeCli({
    beforeTerminal: [
      makeClaudeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'draft ' },
      }),
      makeClaudeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'answer' },
      }),
    ],
    terminal: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'the answer the turn actually kept',
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 3, output_tokens: 2 },
      total_cost_usd: 0.01,
      duration_ms: 42,
    },
  })

  // Nothing waits on a handshake here: the point is what survives to the end,
  // not when it was shown, so the CLI writes the terminal line straight away.
  fs.writeFileSync(cli.releaseMarkerPath, '')

  try {
    await withPath(cli.binDirectory, async () => {
      const deltas: string[] = []
      const result = await createClaudeProvider().execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'sonnet',
        thinking: 'medium',
        onProtocolEvent: (event) => {
          if (event.kind === 'text' && event.text !== undefined) deltas.push(event.text)
        },
      })

      assert.deepEqual(deltas, ['draft ', 'answer'])
      assert.equal(
        result.text,
        'the answer the turn actually kept',
        'the preview is display only; the terminal result object decides what is stored',
      )
      assert.equal(result.cost, 0.01)
      assert.equal(result.durationMs, 42)
    })
  } finally {
    fs.rmSync(cli.binDirectory, { recursive: true, force: true })
  }
})

/**
 * The terminal object is an external CLI's output, so every field it claims is
 * a claim until checked. A build that changed a type, or a line that is a
 * `result` in name only, must not put a string where a number belongs or a
 * structure where text belongs — and must not fail the turn either, because
 * the answer itself may be perfectly good.
 */
test('Claude CLI provider ignores mis-typed terminal fields instead of trusting them', async () => {
  const cli = writeStreamingClaudeCli({
    beforeTerminal: [
      makeClaudeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'A good answer.' },
      }),
    ],
    terminal: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'A good answer.',
      // Every one of these is the wrong shape for its field.
      model: { name: 'claude-sonnet-4-6' },
      total_cost_usd: '0.02',
      duration_ms: 'quite a while',
      usage: { input_tokens: '11', output_tokens: null },
    },
  })
  fs.writeFileSync(cli.releaseMarkerPath, '')

  try {
    await withPath(cli.binDirectory, async () => {
      const result = await createClaudeProvider().execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'sonnet-requested',
        thinking: 'medium',
      })

      assert.equal(result.text, 'A good answer.', 'a good answer still comes back')
      assert.equal(
        result.model,
        'sonnet-requested',
        'a non-string model falls back to the model that was asked for',
      )
      assert.equal(result.cost, 0, 'a string cost is not a cost')
      assert.equal(result.inputTokens, 0)
      assert.equal(result.outputTokens, 0)
      assert.equal(result.contextTokens, 0)
      assert.ok(
        Number.isFinite(result.durationMs) && result.durationMs >= 0,
        `a non-numeric duration falls back to measured elapsed time; got ${String(result.durationMs)}`,
      )
    })
  } finally {
    fs.rmSync(cli.binDirectory, { recursive: true, force: true })
  }
})

test('Claude CLI provider keeps a structured_output object as the answer', async () => {
  const cli = writeStreamingClaudeCli({
    beforeTerminal: [],
    terminal: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'unconstrained prose the schema was meant to replace',
      structured_output: { message: 'structured reply' },
    },
  })
  fs.writeFileSync(cli.releaseMarkerPath, '')

  try {
    await withPath(cli.binDirectory, async () => {
      const result = await createClaudeProvider().execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'sonnet',
        thinking: 'medium',
        outputSchema: { type: 'object', properties: { message: { type: 'string' } } },
      })
      assert.deepEqual(JSON.parse(result.text), { message: 'structured reply' })
    })
  } finally {
    fs.rmSync(cli.binDirectory, { recursive: true, force: true })
  }
})

// ─── the bridge credential never reaches the display stream ────────────────

/**
 * Storage has always been redacted, but the display stream was not: fragments
 * were published verbatim and only the final result went through
 * `redactMcpBridgeToken`. A model that echoes its bearer token — which it can
 * see, because the bridge config hands it over — therefore leaked a live
 * credential into the UI while the turn was still running.
 *
 * Redacting each fragment on its own is not enough, and that is the whole
 * point of this test: a token split across two deltas contains no full match
 * in either half, so per-fragment `replaceAll` passes both through and the
 * viewer reassembles the credential.
 */
test('Claude CLI provider never publishes the bridge token, even split across two deltas', async () => {
  const token = TEST_MCP_BRIDGE.token
  const splitAt = Math.floor(token.length / 2)
  const firstHalf = token.slice(0, splitAt)
  const secondHalf = token.slice(splitAt)
  assert.ok(firstHalf.length > 0 && secondHalf.length > 0, 'the halves must be real')

  // The answer ends with a harmless proper prefix of the token. The redactor
  // must hold that back while it could still become the token, then release it
  // once the turn is over — so this doubles as the flush case, and it stops an
  // implementation that simply drops suspicious text from passing.
  const expectedAnswer = `the token is [REDACTED] and that is all and suffix ${firstHalf}`

  const cli = writeStreamingClaudeCli({
    beforeTerminal: [
      makeClaudeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: `the token is ${firstHalf}` },
      }),
      makeClaudeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: `${secondHalf} and that is all and suffix ${firstHalf}`,
        },
      }),
    ],
    terminal: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: `the token is ${token} and that is all and suffix ${firstHalf}`,
      usage: { input_tokens: 3, output_tokens: 2 },
    },
  })
  fs.writeFileSync(cli.releaseMarkerPath, '')

  try {
    await withPath(cli.binDirectory, async () => {
      const fragments: string[] = []
      const result = await createClaudeProvider().execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'sonnet',
        thinking: 'medium',
        mcpBridge: TEST_MCP_BRIDGE,
        onProtocolEvent: (event) => {
          if (event.kind === 'text' && event.text !== undefined) fragments.push(event.text)
        },
      })

      for (const fragment of fragments) {
        assert.equal(
          fragment.includes(token),
          false,
          `a published fragment carried the whole token: ${JSON.stringify(fragment)}`,
        )
      }

      // What a viewer actually sees is the fragments joined, so halves that
      // pass individually still leak. Compared against an exact expected
      // string rather than a "does not contain" check, which an implementation
      // that dropped the surrounding text would also satisfy.
      assert.equal(
        fragments.join(''),
        expectedAnswer,
        'the display must read as the answer with the credential replaced, and ' +
          'must still end with the held-back prefix once the turn flushed it',
      )
      assert.equal(
        result.text,
        expectedAnswer,
        'and what is stored must say exactly the same thing',
      )
    })
  } finally {
    fs.rmSync(cli.binDirectory, { recursive: true, force: true })
  }
})

test('shared CLI runner: cancelling on the flushed suffix still cancels the turn', async () => {
  // The last visible suffix is a proper prefix of the bridge token, so the
  // redactor holds it until the terminal flush. That flush happens after the
  // abort listener has been removed, so an observer cancelling *there* set no
  // flag and the turn resolved success — a cancellation swallowed by the one
  // publication that happens after cleanup has begun.
  const token = TEST_MCP_BRIDGE.token
  const heldPrefix = token.slice(0, Math.floor(token.length / 2))

  const cli = writeStreamingClaudeCli({
    beforeTerminal: [
      makeClaudeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: `the answer ends with ${heldPrefix}` },
      }),
    ],
    terminal: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: `the answer ends with ${heldPrefix}`,
      usage: { input_tokens: 3, output_tokens: 2 },
    },
  })
  fs.writeFileSync(cli.releaseMarkerPath, '')

  try {
    await withPath(cli.binDirectory, async () => {
      const controller = new AbortController()
      const fragments: string[] = []

      await assert.rejects(
        () =>
          createClaudeProvider().execute({
            systemPrompt: 'system',
            userMessage: 'hello',
            model: 'sonnet',
            thinking: 'medium',
            mcpBridge: TEST_MCP_BRIDGE,
            signal: controller.signal,
            onProtocolEvent: (event) => {
              if (event.kind !== 'text' || event.text === undefined) return
              fragments.push(event.text)
              // Cancel only when the held suffix is finally released.
              if (event.text.includes(heldPrefix)) controller.abort()
            },
          }),
        (error: unknown) => {
          assert.ok(
            error instanceof ProviderError,
            `expected a ProviderError, got ${String(error)}`,
          )
          assert.equal(error.provider, 'claude')
          assert.match(error.message, /cancelled/i)
          return true
        },
      )

      assert.ok(
        fragments.some((fragment) => fragment.includes(heldPrefix)),
        'the held suffix must actually have been flushed for this to be the race',
      )
    })
  } finally {
    fs.rmSync(cli.binDirectory, { recursive: true, force: true })
  }
})

test('Claude CLI provider does not release held credential text when the turn fails', async () => {
  // The held-back text is only safe to release because the turn ended
  // successfully. On a failure there is no answer to complete, and flushing
  // during cleanup would publish a live credential fragment on the way out.
  const token = TEST_MCP_BRIDGE.token
  const firstHalf = token.slice(0, Math.floor(token.length / 2))

  const cli = writeStreamingClaudeCli({
    beforeTerminal: [
      makeClaudeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: `here it comes ${firstHalf}` },
      }),
    ],
    terminal: {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: [{ message: 'the turn failed' }],
    },
  })
  fs.writeFileSync(cli.releaseMarkerPath, '')

  try {
    await withPath(cli.binDirectory, async () => {
      const fragments: string[] = []
      await assert.rejects(() =>
        createClaudeProvider().execute({
          systemPrompt: 'system',
          userMessage: 'hello',
          model: 'sonnet',
          thinking: 'medium',
          mcpBridge: TEST_MCP_BRIDGE,
          onProtocolEvent: (event) => {
            if (event.kind === 'text' && event.text !== undefined) fragments.push(event.text)
          },
        }),
      )

      assert.equal(
        fragments.join(''),
        'here it comes ',
        'the held prefix of the credential must not be released on a failed turn',
      )
    })
  } finally {
    fs.rmSync(cli.binDirectory, { recursive: true, force: true })
  }
})

// ─── caller cancellation wins ──────────────────────────────────────────────

/**
 * Cancelling a turn only ever sent SIGTERM. A child that traps it, finishes
 * its thought and exits zero therefore produced a perfectly valid terminal,
 * and the provider resolved success for a turn the caller had abandoned.
 *
 * The second half is subtler and is why the fixture puts both deltas in a
 * single write: the runner splits a chunk into lines and publishes them in a
 * loop, so an observer that aborts on the first line is still handed the
 * second one from the same chunk.
 */
test('shared CLI runner: a cancelled turn fails even when the child ignores SIGTERM and exits zero', async () => {
  const deltaLine = (text: string) =>
    JSON.stringify(
      makeClaudeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      }),
    )
  const terminalLine = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'a complete answer nobody is waiting for',
    usage: { input_tokens: 3, output_tokens: 2 },
  })
  // One write: both deltas and the terminal reach the parent in one chunk.
  const wholeTurn = `${deltaLine('first ')}\n${deltaLine('second ')}\n${terminalLine}\n`

  await withFakeCli(
    'claude',
    [
      // Trap it. The provider must not depend on the child dying politely.
      "process.on('SIGTERM', () => {})",
      `process.stdout.write(${JSON.stringify(wholeTurn)})`,
    ].join('\n'),
    (binDir) =>
      withPath(binDir, async () => {
        const controller = new AbortController()
        const fragments: string[] = []

        await assert.rejects(
          () =>
            createClaudeProvider().execute({
              systemPrompt: 'system',
              userMessage: 'hello',
              model: 'sonnet',
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
            assert.equal(error.provider, 'claude')
            assert.match(error.message, /cancelled/i)
            return true
          },
        )

        assert.deepEqual(
          fragments,
          ['first '],
          'nothing may be published after the caller cancelled, including a ' +
            'delta that had already arrived in the same chunk',
        )
      }),
  )
})

// ─── stdout decoding across chunk boundaries ───────────────────────────────

test('text CLI providers keep a multi-byte character split across stdout chunks intact', { timeout: HANDSHAKE_FAILSAFE_TIMEOUT_MS }, async (t) => {
  // '✅' is U+2705: the three bytes E2 9C 85. The fake CLI puts E2 at the end
  // of one write and 9C 85 at the start of the next, and cannot make the
  // second write until the parent has finished handling the first — the
  // release marker is created from inside the observer that the completed
  // line in that first write fires. So the character is guaranteed to straddle
  // two stdout chunks, with no sleep and no assumption about pipe buffering.
  const binDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-split-cli-'))
  const handshakeDirectory = path.join(binDirectory, 'handshake')
  fs.mkdirSync(handshakeDirectory)
  const releaseMarkerPath = path.join(handshakeDirectory, 'release')

  fs.writeFileSync(
    path.join(binDirectory, 'split-probe'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs')",
      `const releaseMarkerPath = ${JSON.stringify(releaseMarkerPath)}`,
      `const releaseDirectory = ${JSON.stringify(handshakeDirectory)}`,
      'const watcher = fs.watch(releaseDirectory, () => {',
      '  if (!fs.existsSync(releaseMarkerPath)) return',
      '  watcher.close()',
      "  process.stdout.write(Buffer.from([0x9c, 0x85, 0x0a]))",
      '})',
      // One write, so the completed line and the lone leading byte of the
      // character are handed to the parent together.
      'const firstLine = JSON.stringify({ delta: "go" }) + "\\n"',
      'process.stdout.write(Buffer.concat([',
      '  Buffer.from(firstLine, "utf8"),',
      '  Buffer.from([0xe2]),',
      ']))',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )

  const provider = createTextCliProvider({
    name: 'split-probe',
    command: 'split-probe',
    installHint: 'Test-only probe.',
    buildInvocation: () => ({ args: [] }),
    parseResult: (stdout) => ({ text: stdout }),
    readAnswerDelta: (line) => {
      try {
        const parsed: unknown = JSON.parse(line)
        if (typeof parsed !== 'object' || parsed === null) return null
        const delta = (parsed as { delta?: unknown }).delta
        return typeof delta === 'string' ? delta : null
      } catch {
        return null
      }
    },
  })

  try {
    await withPath(binDirectory, async () => {
      const result = await provider.execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'probe-model',
        thinking: 'low',
        signal: t.signal,
        onProtocolEvent: (event) => {
          if (event.kind !== 'text') return
          fs.writeFileSync(releaseMarkerPath, '')
        },
      })

      assert.ok(
        result.text.includes('✅'),
        `the character split across chunks must survive; got ${JSON.stringify(result.text)}`,
      )
      assert.equal(
        result.text.includes('\uFFFD'),
        false,
        'no half of the character may be replaced with U+FFFD',
      )
    })
  } finally {
    fs.rmSync(binDirectory, { recursive: true, force: true })
  }
})

// ─── Qwen streaming ────────────────────────────────────────────────────────

/**
 * Verified against the **effective** Qwen Code 0.22.0. `/opt/homebrew/bin/qwen`
 * is a 0.21.12 bootstrap whose `cli-entry.js` reads the managed active install
 * recorded in `~/.qwen/updates/npm/<hash>/active.json`, which selects
 * `versions/0.22.0`; that is the source read here.
 *
 * - `--include-partial-messages` is a real option, registered in
 *   `chunk-6QSA4JHL.js` as "Include partial assistant messages when using
 *   stream-json output" with `default: false`. It is omitted from the
 *   abbreviated `--help` listing, which is why reading help alone is not
 *   enough. There is no `--verbose` requirement; that one is Claude Code's.
 * - `chunk-KIVGVFMM.js` emits partials as
 *   `{ type: 'stream_event', uuid, session_id, parent_tool_use_id, event }`,
 *   and `onTextAppended` builds
 *   `{ type: 'content_block_delta', index, delta: { type: 'text_delta', text } }`.
 *   `parentToolUseId` is threaded through every emit, so a subagent's text
 *   arrives on the same shape with a **non-null** `parent_tool_use_id` — it is
 *   not the main agent's answer and must not be shown as one.
 * - The whole assistant message follows as
 *   `{ type: 'assistant', ..., message: { content: [...] } }`, repeating what
 *   the deltas already delivered.
 * - The turn ends with `{ type: 'result', subtype: 'success', is_error: false,
 *   duration_ms, result, usage }`, and that object is what the turn stores.
 */
interface StreamingQwenCli {
  readonly binDirectory: string
  readonly releaseMarkerPath: string
  readonly argvPath: string
}

function writeStreamingQwenCli(options: {
  readonly beforeTerminal: readonly unknown[]
  readonly terminal: unknown
}): StreamingQwenCli {
  const binDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-qwen-stream-'))
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
    'const watcher = fs.watch(releaseDirectory, () => {',
    '  if (!fs.existsSync(releaseMarkerPath)) return',
    '  watcher.close()',
    '  write(terminal)',
    '})',
    ...options.beforeTerminal.map((line) => `write(${JSON.stringify(line)})`),
    'if (fs.existsSync(releaseMarkerPath)) { watcher.close(); write(terminal) }',
    '',
  ].join('\n')

  fs.writeFileSync(path.join(binDirectory, 'qwen'), script, { mode: 0o755 })
  return { binDirectory, releaseMarkerPath, argvPath }
}

function makeQwenStreamEvent(event: unknown, parentToolUseId: string | null = null): unknown {
  return {
    type: 'stream_event',
    uuid: 'evt-uuid',
    session_id: 'fake-session',
    parent_tool_use_id: parentToolUseId,
    event,
  }
}

const QWEN_STREAM_LINES: readonly unknown[] = [
  { type: 'system', subtype: 'session_start', session_id: 'fake-session', model: 'qwen3-coder-plus' },
  makeQwenStreamEvent({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'private reasoning the user must never see' },
  }),
  makeQwenStreamEvent({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'text_delta', text: 'Hello ' },
  }),
  makeQwenStreamEvent({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'text_delta', text: 'world' },
  }),
  // A subagent's answer text. Same shape, non-null parent — not this turn's answer.
  makeQwenStreamEvent(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'subagent chatter that is not the answer' },
    },
    'toolu_subagent_1',
  ),
  makeQwenStreamEvent({
    type: 'content_block_delta',
    index: 2,
    delta: { type: 'input_json_delta', partial_json: '{"path":"/etc/' },
  }),
  makeQwenStreamEvent({ type: 'goal_state', goal_state: { status: 'in_progress' } }),
  // The whole assistant message, repeating what the deltas delivered.
  {
    type: 'assistant',
    uuid: 'msg-uuid',
    session_id: 'fake-session',
    parent_tool_use_id: null,
    message: {
      id: 'msg-uuid',
      type: 'message',
      role: 'assistant',
      model: 'qwen3-coder-plus',
      content: [{ type: 'text', text: 'Hello world' }],
    },
  },
]

const QWEN_TERMINAL_RESULT: unknown = {
  type: 'result',
  subtype: 'success',
  uuid: 'result-uuid',
  session_id: 'fake-session',
  is_error: false,
  duration_ms: 1234,
  // Deliberately not the fragments joined. If the two agreed, this fixture
  // could not tell a turn that stored the terminal object from one that stored
  // its own preview.
  result: 'Hello world — revised after the last fragment.',
  usage: { input_tokens: 11, output_tokens: 7 },
}

test('Qwen CLI provider streams the main agent answer before the turn resolves', { timeout: HANDSHAKE_FAILSAFE_TIMEOUT_MS }, async (t) => {
  const cli = writeStreamingQwenCli({
    beforeTerminal: QWEN_STREAM_LINES,
    terminal: QWEN_TERMINAL_RESULT,
  })

  try {
    await withPath(cli.binDirectory, async () => {
      const deltas: string[] = []

      const result = await createQwenProvider().execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'qwen3-coder-plus',
        thinking: 'low',
        signal: t.signal,
        onProtocolEvent: (event) => {
          if (event.kind !== 'text' || event.text === undefined) return
          deltas.push(event.text)
          if (deltas.length === 2) fs.writeFileSync(cli.releaseMarkerPath, '')
        },
      })

      assert.deepEqual(
        deltas,
        ['Hello ', 'world'],
        'only the main agent’s committed text_delta fragments; thinking, ' +
          'input_json, goal_state, the whole assistant message and a subagent’s ' +
          'text under a non-null parent_tool_use_id are all excluded',
      )

      assert.deepEqual(
        {
          text: result.text,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          durationMs: result.durationMs,
        },
        {
          text: 'Hello world — revised after the last fragment.',
          inputTokens: 11,
          outputTokens: 7,
          durationMs: 1234,
        },
        'the terminal result object is what the turn stores, even though the ' +
          'preview fragments joined to something else',
      )

      const argv: unknown = JSON.parse(fs.readFileSync(cli.argvPath, 'utf8'))
      assert.ok(Array.isArray(argv))
      const args: string[] = argv.filter((value): value is string => typeof value === 'string')
      assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json')
      assert.ok(
        args.includes('--include-partial-messages'),
        'without this flag the CLI reports only whole messages',
      )
      assert.equal(
        args.includes('--verbose'),
        false,
        'the --verbose requirement is Claude Code’s, not this CLI’s',
      )
    })
  } finally {
    fs.rmSync(cli.binDirectory, { recursive: true, force: true })
  }
})

/** Runs a fake qwen that emits the given lines and exits, with no handshake. */
function withStreamingQwen<T>(lines: readonly unknown[], fn: () => Promise<T>): Promise<T> {
  const source = lines
    .map((line) => `process.stdout.write(${JSON.stringify(JSON.stringify(line) + '\n')})`)
    .join('\n')
  return withFakeCli('qwen', source, (binDir) => withPath(binDir, fn))
}

function executeQwen() {
  return createQwenProvider().execute({
    systemPrompt: 'system',
    userMessage: 'hello',
    model: 'qwen3-coder-plus',
    thinking: 'low',
  })
}

const QWEN_TWO_DELTAS: readonly unknown[] = [
  { type: 'system', subtype: 'session_start', session_id: 'fake-session' },
  makeQwenStreamEvent({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'draft ' },
  }),
  makeQwenStreamEvent({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'answer' },
  }),
]

test('Qwen CLI provider stores the terminal result even when the deltas disagree', async () => {
  await withStreamingQwen(
    [
      ...QWEN_TWO_DELTAS,
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 42,
        result: 'the answer the turn actually kept',
        usage: { input_tokens: 3, output_tokens: 2 },
      },
    ],
    async () => {
      const deltas: string[] = []
      const result = await createQwenProvider().execute({
        systemPrompt: 'system',
        userMessage: 'hello',
        model: 'qwen3-coder-plus',
        thinking: 'low',
        onProtocolEvent: (event) => {
          if (event.kind === 'text' && event.text !== undefined) deltas.push(event.text)
        },
      })

      assert.deepEqual(deltas, ['draft ', 'answer'])
      assert.equal(
        result.text,
        'the answer the turn actually kept',
        'the preview is display only; the terminal result decides what is stored',
      )
      assert.equal(result.durationMs, 42)
    },
  )
})

test('Qwen CLI provider treats a stream that ends before its terminal result as a failure', async () => {
  // Falling back to raw stdout here would store the JSONL transport itself as
  // the reply — a wrong answer that reads like a real one.
  await withStreamingQwen(QWEN_TWO_DELTAS, async () => {
    await assert.rejects(
      () => executeQwen(),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /qwen/)
        assert.doesNotMatch(
          error.message,
          /"type":"stream_event"/,
          'the failure must not carry the raw JSONL as if it were text',
        )
        return true
      },
    )
  })
})

test('Qwen CLI provider treats a terminal result that did not succeed as a failure', async () => {
  await withStreamingQwen(
    [
      ...QWEN_TWO_DELTAS,
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: '' },
    ],
    async () => {
      await assert.rejects(() => executeQwen(), /qwen/)
    },
  )
})

for (const [label, resultField] of [
  ['missing', undefined],
  ['object-valued', { text: 'not a string' }],
  ['whitespace-only', '   \n  '],
] as const) {
  test(`Qwen CLI provider refuses a success terminal whose result is ${label}`, async () => {
    await withStreamingQwen(
      [
        ...QWEN_TWO_DELTAS,
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          ...(resultField === undefined ? {} : { result: resultField }),
          usage: { input_tokens: 3, output_tokens: 2 },
        },
      ],
      async () => {
        await assert.rejects(
          () => executeQwen(),
          (error: unknown) => {
            assert.ok(
              error instanceof ProviderError,
              `expected a ProviderError, got ${String(error)}`,
            )
            assert.equal(error.provider, 'qwen')
            assert.equal(error.retryable, false)
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
}

test('Qwen CLI provider ignores negative token counts and durations', async () => {
  await withStreamingQwen(
    [
      ...QWEN_TWO_DELTAS,
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: -100,
        result: 'kept',
        usage: { input_tokens: -5, output_tokens: -1, total_tokens: -6 },
      },
    ],
    async () => {
      const result = await executeQwen()
      assert.equal(result.text, 'kept')
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

test('Qwen CLI provider still reads output that never spoke the stream protocol', async () => {
  // A CLI build that ignores the format flag prints plain text. That is the
  // one case where whole stdout is still the answer.
  await withFakeCli(
    'qwen',
    `process.stdout.write('a plain text answer')`,
    (binDir) =>
      withPath(binDir, async () => {
        const result = await executeQwen()
        assert.equal(result.text, 'a plain text answer')
      }),
  )
})

test('Qwen CLI provider does not accept a success whose is_error field is missing', async () => {
  // The effective 0.22.0 success schema always emits `is_error: false`. A line
  // that omits it is not a success record with a default; it is a record of an
  // unknown shape, and treating it as success would accept anything that
  // happened to carry the right subtype.
  await withStreamingQwen(
    [
      ...QWEN_TWO_DELTAS,
      { type: 'result', subtype: 'success', result: 'looks fine, proves nothing' },
    ],
    async () => {
      await assert.rejects(() => executeQwen(), /qwen/)
    },
  )
})

test('Qwen CLI provider does not accept a result that the stream continued past', async () => {
  // A `result` followed by further protocol records is not this turn's ending.
  // Reading it as one would store an answer the CLI had not finished revising.
  await withStreamingQwen(
    [
      ...QWEN_TWO_DELTAS,
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'a result the stream continued past',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      makeQwenStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ' and then more' },
      }),
    ],
    async () => {
      await assert.rejects(() => executeQwen(), /qwen/)
    },
  )
})

test('Qwen CLI provider ignores mis-typed usage and duration fields', async () => {
  await withStreamingQwen(
    [
      ...QWEN_TWO_DELTAS,
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 'quite a while',
        result: 'kept',
        usage: { input_tokens: '11', output_tokens: null, total_tokens: {} },
      },
    ],
    async () => {
      const result = await executeQwen()
      assert.equal(result.text, 'kept')
      assert.equal(result.inputTokens, 0)
      assert.equal(result.outputTokens, 0)
      assert.equal(result.contextTokens, 0)
      assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0)
    },
  )
})

// ─── Claude Code terminal discipline ───────────────────────────────────────

/**
 * Verified against the installed Claude Code 2.1.241 bundle. Its stream-json
 * output records are `system`, `assistant`, `user`, `stream_event` and
 * `result`; `control_request` / `control_response` belong to the bidirectional
 * control protocol, which needs `--input-format stream-json` and so cannot
 * appear on this provider's invocation. `result` has exactly two subtypes:
 * `success` carrying `is_error: false`, and `error_during_execution` carrying
 * `is_error: true`.
 *
 * What these pin is the contract the provider already claimed in prose — the
 * terminal object is the authority, and it is the line the CLI *ended* on.
 */
function withStreamingClaude<T>(lines: readonly unknown[], fn: () => Promise<T>): Promise<T> {
  const source = lines
    .map((line) => `process.stdout.write(${JSON.stringify(JSON.stringify(line) + '\n')})`)
    .join('\n')
  return withFakeCli('claude', source, (binDir) => withPath(binDir, fn))
}

function executeClaude() {
  return createClaudeProvider().execute({
    systemPrompt: 'system',
    userMessage: 'hello',
    model: 'sonnet',
    thinking: 'medium',
  })
}

const CLAUDE_TWO_DELTAS: readonly unknown[] = [
  { type: 'system', subtype: 'init', session_id: 'fake-session', model: 'claude-sonnet-4-6' },
  makeClaudeStreamEvent({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Hello ' },
  }),
  makeClaudeStreamEvent({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'world' },
  }),
]

const CLAUDE_SUCCESS_RESULT: unknown = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 12,
  result: 'Hello world',
  total_cost_usd: 0.01,
  usage: { input_tokens: 3, output_tokens: 2 },
}

test('Claude CLI provider treats a stream that ends before its terminal result as a failure', async () => {
  // The dangerous outcome here is not an error, it is a plausible one: the
  // multi-line body fails `JSON.parse`, and falling back to raw stdout stores
  // the JSONL transport itself as the durable answer.
  await withStreamingClaude(CLAUDE_TWO_DELTAS, async () => {
    await assert.rejects(
      () => executeClaude(),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /claude/)
        assert.doesNotMatch(
          error.message,
          /"type":"stream_event"/,
          'the failure must not carry the raw JSONL as if it were text',
        )
        return true
      },
    )
  })
})

test('Claude CLI provider does not accept a result that the stream continued past', async () => {
  // A `result` followed by further protocol records is not this turn's ending.
  // Reading it as one would store an answer the CLI had not finished revising.
  await withStreamingClaude(
    [
      ...CLAUDE_TWO_DELTAS,
      CLAUDE_SUCCESS_RESULT,
      makeClaudeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ' and then more' },
      }),
    ],
    async () => {
      await assert.rejects(() => executeClaude(), /claude/)
    },
  )
})

test('Claude CLI provider rejects a terminal result that reports an error', async () => {
  await withStreamingClaude(
    [
      ...CLAUDE_TWO_DELTAS,
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: [{ message: 'the turn failed' }],
      },
    ],
    async () => {
      await assert.rejects(() => executeClaude(), /claude/)
    },
  )
})

test('Claude CLI provider does not accept a success whose is_error field is missing', async () => {
  // 2.1.241 always emits `is_error` on a result, so a record that omits it is
  // of an unknown shape rather than a success with a default.
  await withStreamingClaude(
    [...CLAUDE_TWO_DELTAS, { type: 'result', subtype: 'success', result: 'looks fine' }],
    async () => {
      await assert.rejects(() => executeClaude(), /claude/)
    },
  )
})

/**
 * A success terminal that carries no readable answer used to resolve as the
 * shared runner's `[No response. stderr: …]` placeholder. That string is not
 * an answer — it is this codebase's own prose — and a caller stores it as the
 * agent's reply. A turn that reached a recognised terminal and still has
 * nothing visible to show has failed, and should say so.
 */
for (const [label, resultField] of [
  ['missing', undefined],
  ['object-valued', { text: 'not a string' }],
  ['whitespace-only', '   \n  '],
] as const) {
  test(`Claude CLI provider refuses a success terminal whose result is ${label}`, async () => {
    await withStreamingClaude(
      [
        ...CLAUDE_TWO_DELTAS,
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          ...(resultField === undefined ? {} : { result: resultField }),
          usage: { input_tokens: 3, output_tokens: 2 },
        },
      ],
      async () => {
        await assert.rejects(
          () => executeClaude(),
          (error: unknown) => {
            assert.ok(
              error instanceof ProviderError,
              `expected a ProviderError, got ${String(error)}`,
            )
            assert.equal(error.provider, 'claude')
            assert.equal(
              error.retryable,
              false,
              'a terminal that carried no answer will not carry one on a retry',
            )
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
}

test('Claude CLI provider accepts a structured_output answer with no result string', async () => {
  // `--json-schema` puts the answer in `structured_output`, and `result` may
  // legitimately be absent or unconstrained prose. That is still an answer.
  await withStreamingClaude(
    [
      ...CLAUDE_TWO_DELTAS,
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        structured_output: { message: 'structured reply' },
        usage: { input_tokens: 3, output_tokens: 2 },
      },
    ],
    async () => {
      const result = await executeClaude()
      assert.deepEqual(JSON.parse(result.text), { message: 'structured reply' })
    },
  )
})

test('Claude CLI provider ignores fractional token counts but keeps fractional cost and duration', async () => {
  // A count is whole. A cost and a duration are not, and must stay readable —
  // the same guard cannot serve both.
  await withStreamingClaude(
    [
      ...CLAUDE_TWO_DELTAS,
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'kept',
        total_cost_usd: 0.0125,
        duration_ms: 12.5,
        usage: { input_tokens: 1.5, output_tokens: 2.25 },
      },
    ],
    async () => {
      const result = await executeClaude()
      assert.equal(result.text, 'kept')
      assert.equal(result.inputTokens, 0, 'a fractional token count is not a count')
      assert.equal(result.outputTokens, 0)
      assert.equal(result.contextTokens, 0)
      assert.equal(result.cost, 0.0125, 'a fractional cost is a perfectly good cost')
      assert.equal(result.durationMs, 12.5, 'and so is a fractional duration')
    },
  )
})

test('Qwen CLI provider ignores fractional token counts but keeps a fractional duration', async () => {
  await withStreamingQwen(
    [
      ...QWEN_TWO_DELTAS,
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 42.5,
        result: 'kept',
        usage: { input_tokens: 1.5, output_tokens: 2.25, total_tokens: 3.75 },
      },
    ],
    async () => {
      const result = await executeQwen()
      assert.equal(result.text, 'kept')
      assert.equal(result.inputTokens, 0, 'a fractional token count is not a count')
      assert.equal(result.outputTokens, 0)
      assert.equal(result.contextTokens, 0)
      assert.equal(result.durationMs, 42.5, 'a fractional duration is still a duration')
    },
  )
})

test('Claude CLI provider ignores negative token counts, durations and costs', async () => {
  await withStreamingClaude(
    [
      ...CLAUDE_TWO_DELTAS,
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: -100,
        result: 'kept',
        total_cost_usd: -0.5,
        usage: { input_tokens: -5, output_tokens: -1 },
      },
    ],
    async () => {
      const result = await executeClaude()
      assert.equal(result.text, 'kept')
      assert.equal(result.inputTokens, 0, 'a negative token count is not a count')
      assert.equal(result.outputTokens, 0)
      assert.equal(result.contextTokens, 0)
      assert.equal(result.cost, 0, 'a negative cost is not a cost')
      assert.ok(result.durationMs >= 0)
    },
  )
})

test('Claude CLI provider still reads a single JSON object from a build that ignores the format flag', async () => {
  // The one case where whole stdout is still the answer: output that never
  // spoke the stream protocol at all.
  await withFakeCli(
    'claude',
    `process.stdout.write(JSON.stringify({
      result: 'a whole-object answer',
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 4, output_tokens: 2 },
      total_cost_usd: 0.03,
    }))`,
    (binDir) =>
      withPath(binDir, async () => {
        const result = await executeClaude()
        assert.equal(result.text, 'a whole-object answer')
        assert.equal(result.inputTokens, 4)
        assert.equal(result.cost, 0.03)
      }),
  )
})

test('a shared-runner CLI that is not installed refuses before it sends anything', async () => {
  // The whole deferral rests on this shape. `validateLoadedAgentProviders` may
  // only let a Team boot past an Agent pinned to a missing CLI if the refusal
  // that follows can become an offer, and the offer is built from two fields
  // this adapter is the only place that can state: a typed `kind`, because the
  // evaluator's `MODEL_SPECIFIC_FAILURES` reads that and nothing else, and
  // `dispatched: false`, because unknown blocks the retry. A message alone is
  // evidence of nothing.
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-cli-bin-'))
  const originalPath = process.env.PATH
  const originalFallback = process.env.PIPELINE_CLI_PATH_FALLBACK
  process.env.PATH = emptyDir
  process.env.PIPELINE_CLI_PATH_FALLBACK = '0'

  try {
    for (const [label, provider] of [
      ['claude', createClaudeProvider()],
      ['kimi-cli', createKimiCliProvider()],
      ['qwen', createQwenProvider()],
    ] as const) {
      await assert.rejects(
        provider.execute({
          systemPrompt: 'system',
          userMessage: 'hello',
          model: 'any-model',
          thinking: 'low',
        }),
        (error: unknown) => {
          assert.ok(
            error instanceof ProviderError,
            `${label}: expected a ProviderError, got ${String(error)}`,
          )
          assert.match(error.message, /was not found on PATH/)
          // The binary is absent: that is a configuration problem, not a
          // rejected credential, and it is the kind the evaluator maps.
          assert.equal(error.kind, 'configuration', `${label}: kind`)
          assert.equal(error.dispatched, false, `${label}: dispatched`)
          assert.equal(error.retryable, false, `${label}: retryable`)
          return true
        },
      )
    }
  } finally {
    process.env.PATH = originalPath
    if (originalFallback === undefined) delete process.env.PIPELINE_CLI_PATH_FALLBACK
    else process.env.PIPELINE_CLI_PATH_FALLBACK = originalFallback
    fs.rmSync(emptyDir, { recursive: true, force: true })
  }
})

test('the MCP-bridge redaction does not lose the undispatched claim', async () => {
  // `redactProviderError` rebuilds the error field by field, so anything it
  // forgets to copy is silently gone. Losing `dispatched` here would turn a
  // provable no-effect refusal into an unknown one on exactly the turns that
  // carry a bridge token.
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-cli-bin-'))
  const originalPath = process.env.PATH
  const originalFallback = process.env.PIPELINE_CLI_PATH_FALLBACK
  process.env.PATH = emptyDir
  process.env.PIPELINE_CLI_PATH_FALLBACK = '0'

  try {
    await assert.rejects(
      createClaudeProvider().execute({
        systemPrompt: `system ${TEST_MCP_BRIDGE.token}`,
        userMessage: 'hello',
        model: 'sonnet',
        thinking: 'low',
        mcpBridge: TEST_MCP_BRIDGE,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError)
        assert.equal(error.kind, 'configuration')
        assert.equal(error.dispatched, false)
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

// ─── Which adapters let the provider choose the model ──────────────────────

/**
 * `PROVIDER_CHOSEN_DEFAULT_PROVIDERS` offers "let the provider choose" only for
 * adapters that send no model at all when the model is `default`. Each known
 * adapter is run with that model and the test reads what it actually sent: the
 * argv a fake CLI received, or the body of the HTTP request. Codex also sends
 * no model, but it stays unlisted because `codex/default` is the historical
 * "nothing chosen" sentinel.
 */

type KnownAgentProvider = (typeof KNOWN_AGENT_PROVIDER_NAMES)[number]

/** One turn with `model`; resolves to the model the adapter sent, or undefined for none. */
type ModelProbe = (model: string) => Promise<string | undefined>

const CONCRETE_PROBE_MODEL = 'probe-model-id'

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Set (or, for undefined, remove) each key, and return the undo for exactly those keys. */
function applyEnvironment(entries: Readonly<Record<string, string | undefined>>): () => void {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return (): void => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function readRecordedArgv(argvPath: string): string[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(argvPath, 'utf8'))
  assert.ok(Array.isArray(parsed), 'the fake CLI must have recorded its argv')
  return parsed.filter((value): value is string => typeof value === 'string')
}

/** The value of the model flag in `argv` (`--model`, `-m` or `--model=`), or undefined when there is none. */
function modelFlagValue(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--model' || argument === '-m') return argv[index + 1] ?? ''
    if (argument?.startsWith('--model=')) return argument.slice('--model='.length)
  }
  return undefined
}

function cliModelProbe(
  command: string,
  createProvider: () => Provider,
  answerSource: string,
  environment: (scratchDirectory: string) => Readonly<Record<string, string | undefined>> = () => ({}),
): ModelProbe {
  return async (model) => {
    const scratchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `model-probe-${command}-`))
    const argvPath = path.join(scratchDirectory, 'argv.json')
    // The child drains stdin before answering, so an adapter that writes the
    // prompt there never meets a closed pipe.
    const source = `
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)))
process.stdin.on('data', () => {})
process.stdin.on('end', () => {
${answerSource}
})
process.stdin.resume()
`
    const restoreEnvironment = applyEnvironment(environment(scratchDirectory))
    try {
      await withFakeCli(command, source, (binDir) => withPath(binDir, () =>
        createProvider().execute({
          systemPrompt: 'system',
          userMessage: 'hello',
          model,
          thinking: PROVIDER_DEFAULT_THINKING,
        })))
      return modelFlagValue(readRecordedArgv(argvPath))
    } finally {
      restoreEnvironment()
      fs.rmSync(scratchDirectory, { recursive: true, force: true })
    }
  }
}

function httpModelProbe(
  createProvider: () => Provider,
  environment: Readonly<Record<string, string | undefined>>,
): ModelProbe {
  return async (model) => {
    const sentBodies: unknown[] = []
    const originalFetch = globalThis.fetch
    // The request is recorded and refused, so no adapter needs a well-formed
    // answer and nothing leaves the process.
    globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (typeof init?.body === 'string') sentBodies.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ error: { message: 'refused by the model probe' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }
    const restoreEnvironment = applyEnvironment(environment)
    try {
      await createProvider()
        .execute({
          systemPrompt: 'system',
          userMessage: 'hello',
          model,
          thinking: PROVIDER_DEFAULT_THINKING,
        })
        .then(() => undefined, () => undefined)
    } finally {
      globalThis.fetch = originalFetch
      restoreEnvironment()
    }
    const body = sentBodies[0]
    assert.ok(isRecordValue(body), 'the adapter must have sent a request')
    return typeof body.model === 'string' ? body.model : undefined
  }
}

const PI_ANSWER = `
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: { role: 'assistant', model: 'fake', content: [{ type: 'text', text: 'ok' }] },
}) + '\\n')
process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n')
`

const CODEX_ANSWER = `
process.stdout.write(JSON.stringify({
  type: 'item.completed',
  item: { id: 'item_0', type: 'agent_message', text: 'ok' },
}) + '\\n')
process.stdout.write(JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 1, output_tokens: 1 },
}) + '\\n')
`

const MODEL_PROBES: Readonly<Record<KnownAgentProvider, ModelProbe>> = {
  claude: cliModelProbe('claude', createClaudeProvider, `process.stdout.write(JSON.stringify({ result: 'ok' }))`),
  gemini: cliModelProbe('gemini', createGeminiProvider, `process.stdout.write('ok')`),
  // Pointed at a directory that does not exist, so no real Kimi login is copied.
  'kimi-cli': cliModelProbe('kimi', createKimiCliProvider, `process.stdout.write('ok')`, (scratch) => ({
    KIMI_SHARE_DIR: path.join(scratch, 'no-kimi-share'),
    KIMI_CODE_HOME: undefined,
  })),
  pi: cliModelProbe('pi', createPiProvider, PI_ANSWER, () => ({
    TEAM_RUNTIME_PI_CLI_PATH: undefined,
  })),
  qwen: cliModelProbe('qwen', createQwenProvider, `process.stdout.write('ok')`),
  codex: cliModelProbe('codex', createCodexProvider, CODEX_ANSWER),
  anthropic: httpModelProbe(createAnthropicProvider, { ANTHROPIC_API_KEY: 'model-probe-key' }),
  openai: httpModelProbe(createOpenAIProvider, {
    OPENAI_API_KEY: 'model-probe-key',
    OPENAI_BASE_URL: undefined,
  }),
  xai: httpModelProbe(createXAIProvider, { XAI_API_KEY: 'model-probe-key' }),
  deepseek: httpModelProbe(createDeepSeekProvider, { DEEPSEEK_API_KEY: 'model-probe-key' }),
  kimi: httpModelProbe(createKimiProvider, { MOONSHOT_API_KEY: 'model-probe-key' }),
  openrouter: httpModelProbe(createOpenRouterProvider, { OPENROUTER_API_KEY: 'model-probe-key' }),
  'lm-studio': httpModelProbe(createLmStudioProvider, {}),
}

test('every provider offered as provider-chosen is a known agent provider with a model probe', () => {
  const known: readonly string[] = KNOWN_AGENT_PROVIDER_NAMES
  for (const provider of PROVIDER_CHOSEN_DEFAULT_PROVIDERS) {
    assert.ok(known.includes(provider), `'${provider}' is offered but no adapter runs under that name`)
  }
})

for (const provider of KNOWN_AGENT_PROVIDER_NAMES) {
  const offered = PROVIDER_CHOSEN_DEFAULT_PROVIDERS.includes(provider)
  const sentinelProvider = provider === LEGACY_BUILTIN_PROVIDER_ID
  const sendsNoModelForDefault = offered || sentinelProvider
  const name = offered
    ? `the ${provider} adapter sends no model for 'default', as its provider-chosen listing promises`
    : sentinelProvider
      ? `the ${provider} adapter sends no model for 'default' yet stays unlisted, since ${provider}/default means nothing was chosen`
      : `the ${provider} adapter sends 'default' as the model id, so it is not offered as provider-chosen`

  test(name, async () => {
    const probe = MODEL_PROBES[provider]
    assert.equal(
      await probe(CONCRETE_PROBE_MODEL),
      CONCRETE_PROBE_MODEL,
      'a concrete model must reach the provider, or the probe is reading the wrong place',
    )
    assert.equal(
      await probe(LEGACY_UNRESOLVED_MODEL_ID),
      sendsNoModelForDefault ? undefined : LEGACY_UNRESOLVED_MODEL_ID,
      offered
        ? `'${provider}' is listed in PROVIDER_CHOSEN_DEFAULT_PROVIDERS, so 'default' must leave the model to the provider`
        : sentinelProvider
          ? `'${provider}/default' is the unresolved sentinel, and its adapter must still leave the model off`
          : `'${provider}' is not listed in PROVIDER_CHOSEN_DEFAULT_PROVIDERS, so its adapter must not quietly treat 'default' as a choice`,
    )
  })
}

test('the shared CLI runner records and aborts provider silence without waiting for the total deadline', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_000_000 })
  const entries: import('../../domains/runtime/provider-turn-diagnostics.js').ProviderTurnDiagnosticEntry[] = []
  let ready = () => {}
  const firstOutput = new Promise<void>((resolve) => { ready = resolve })
  const abort = new AbortController()
  // A real local subprocess replaces the paid CLI; no runner internals are replaced.
  const provider = createTextCliProvider({
    name: 'probe', command: process.execPath, installHint: 'Test fixture',
    buildInvocation: () => ({ args: ['-e', 'process.stdout.write(JSON.stringify({type:"system"})+"\\n"); setInterval(()=>{},60000)'] }),
    readAnswerDelta: () => { ready(); return null },
  })
  const outcome = provider.execute({ systemPrompt: '', userMessage: '', model: 'default', thinking: 'low',
    signal: abort.signal, onProtocolEvent: () => {},
    turnDiagnostics: { record: (entry) => { entries.push(entry) } },
    stallWatchdog: { idleMs: 60_000, abortIdleMs: 300_000, pollMs: 15_000 },
  }).then((result) => ({ result, error: undefined }), (error: unknown) => ({ result: undefined, error }))
  try {
    await firstOutput
    t.mock.timers.tick(300_000)
    assert.ok(entries.some((entry) => entry.kind === 'provider-stalled' && entry.aborted), 'silence must be recorded and end the turn')
    const { error } = await outcome
    assert.ok(error instanceof ProviderError)
    assert.equal(error.code, 'provider_stalled')
    assert.equal(error.retryable, true)
    assert.ok(entries.some((entry) => entry.kind === 'provider-process-started'))
    assert.ok(entries.some((entry) => entry.kind === 'provider-protocol-event' && entry.eventType === 'system'))
    assert.ok(entries.some((entry) => entry.kind === 'provider-process-exited'))
    assert.doesNotMatch(JSON.stringify(entries), /systemPrompt|userMessage|content|text_preview/)
  } finally {
    abort.abort()
    await outcome
    t.mock.timers.reset()
  }
})

test('Claude CLI persists classified stderr and retry details even when it eventually succeeds', async () => {
  const entries: import('../../domains/runtime/provider-turn-diagnostics.js').ProviderTurnDiagnosticEntry[] = []
  // Replace the paid CLI only; real process streams and diagnostic recording remain active.
  await withFakeCli('claude', `
process.stderr.write('API Error: 429 rate limit for private-account@example.test secret-token\\n')
process.stderr.write('Retrying in 2 seconds (attempt 3/10)\\n')
process.stdout.write(JSON.stringify({type:'system',subtype:'api_retry',attempt:4,retry_delay_ms:1500,error_status:503})+'\\n')
process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Recovered',usage:{input_tokens:1,output_tokens:1}}))
`, async (binDir) => withPath(binDir, async () => {
    const result = await createClaudeProvider().execute({ systemPrompt: '', userMessage: '', model: 'default', thinking: 'medium',
      turnDiagnostics: { record: (entry) => { entries.push(entry) } },
    })
    assert.equal(result.text, 'Recovered')
    assert.ok(entries.some((entry) => JSON.stringify(entry).includes('"category":"rate_limit"')), 'the upstream error classification must survive success')
    assert.ok(entries.some((entry) => JSON.stringify(entry).includes('"attempt":3') && JSON.stringify(entry).includes('"retryDelayMs":2000')), 'the retry attempt and delay must be retained')
    assert.ok(entries.some((entry) => JSON.stringify(entry).includes('\"statusCode\":503') && JSON.stringify(entry).includes('\"attempt\":4')), 'structured upstream retries must also be retained')
    assert.doesNotMatch(JSON.stringify(entries), /private-account|secret-token|Recovered|Retrying in/)
  }))
})
