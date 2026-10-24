import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { createOpenRouterProvider } from '../../providers/openrouter.js'
import { ProviderError } from '../../domains/provider/provider-error.js'
import { getAssignmentLogPath } from '../../domains/runtime/logger.js'

test('OpenRouter provider: name is "openrouter"', () => {
  const provider = createOpenRouterProvider()
  assert.equal(provider.name, 'openrouter')
})

test('OpenRouter provider: requires OPENROUTER_API_KEY', async () => {
  const provider = createOpenRouterProvider()
  const originalKey = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY

  try {
    await assert.rejects(
      provider.execute({
        systemPrompt: 'sys',
        userMessage: 'user',
        model: 'openai/gpt-4o-mini',
        thinking: 'low',
      }),
      /OPENROUTER_API_KEY/,
    )
  } finally {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = originalKey
  }
})

test('OpenRouter provider: posts to chat completions API and normalizes response', async () => {
  const provider = createOpenRouterProvider()
  const originalKey = process.env.OPENROUTER_API_KEY
  const originalFetch = globalThis.fetch
  process.env.OPENROUTER_API_KEY = 'test-key'

  let capturedUrl = ''
  let capturedInit: RequestInit | undefined

  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input)
    capturedInit = init
    return new Response(JSON.stringify({
      id: 'gen-123',
      model: 'openai/gpt-4o-mini',
      choices: [
        {
          message: {
            content: 'Microsoft report body',
          },
        },
      ],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 22,
        total_tokens: 33,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    const result = await provider.execute({
      systemPrompt: 'system prompt',
      userMessage: 'user prompt',
      model: 'openai/gpt-4o-mini',
      thinking: 'medium',
      providerConfig: {
        site_url: 'https://example.com',
        site_name: 'Pipeline Template',
        temperature: 0.2,
        max_tokens: 500,
      },
    })

    assert.equal(capturedUrl, 'https://openrouter.ai/api/v1/chat/completions')
    assert.equal(result.text, 'Microsoft report body')
    assert.equal(result.inputTokens, 11)
    assert.equal(result.outputTokens, 22)
    assert.equal(result.contextTokens, 33)
    assert.equal(result.model, 'openai/gpt-4o-mini')

    assert.equal((capturedInit?.headers as Record<string, string>)['Authorization'], 'Bearer test-key')
    assert.equal((capturedInit?.headers as Record<string, string>)['HTTP-Referer'], 'https://example.com')
    assert.equal((capturedInit?.headers as Record<string, string>)['X-OpenRouter-Title'], 'Pipeline Template')

    const body = JSON.parse(String(capturedInit?.body))
    assert.equal(body.model, 'openai/gpt-4o-mini')
    assert.equal(body.messages[0].role, 'system')
    assert.equal(body.messages[0].content, 'system prompt')
    assert.equal(body.messages[1].role, 'user')
    assert.equal(body.messages[1].content, 'user prompt')
    assert.equal(body.temperature, 0.2)
    assert.equal(body.max_tokens, 500)
  } finally {
    globalThis.fetch = originalFetch
    process.env.OPENROUTER_API_KEY = originalKey
  }
})

test('OpenRouter provider: supports array content responses', async () => {
  const provider = createOpenRouterProvider()
  const originalKey = process.env.OPENROUTER_API_KEY
  const originalFetch = globalThis.fetch
  process.env.OPENROUTER_API_KEY = 'test-key'

  globalThis.fetch = async () => new Response(JSON.stringify({
    model: 'openai/gpt-4o-mini',
    choices: [
      {
        message: {
          content: [
            { type: 'text', text: 'Microsoft ' },
            { type: 'text', text: 'summary' },
          ],
        },
      },
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 2,
      total_tokens: 3,
    },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

  try {
    const result = await provider.execute({
      systemPrompt: 'sys',
      userMessage: 'user',
      model: 'openai/gpt-4o-mini',
      thinking: 'low',
    })

    assert.equal(result.text, 'Microsoft summary')
  } finally {
    globalThis.fetch = originalFetch
    process.env.OPENROUTER_API_KEY = originalKey
  }
})

test('OpenRouter provider: surfaces API errors', async () => {
  const provider = createOpenRouterProvider()
  const originalKey = process.env.OPENROUTER_API_KEY
  const originalFetch = globalThis.fetch
  process.env.OPENROUTER_API_KEY = 'test-key'

  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: 'rate limit' },
  }), {
    status: 429,
    headers: { 'content-type': 'application/json' },
  })

  try {
    await assert.rejects(
      provider.execute({
        systemPrompt: 'sys',
        userMessage: 'user',
        model: 'openai/gpt-4o-mini',
        thinking: 'low',
      }),
      /rate limit/,
    )
  } finally {
    globalThis.fetch = originalFetch
    process.env.OPENROUTER_API_KEY = originalKey
  }
})

test('OpenRouter provider: logs provider failure events', async () => {
  const provider = createOpenRouterProvider()
  const originalKey = process.env.OPENROUTER_API_KEY
  const originalFetch = globalThis.fetch
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openrouter-provider-'))
  process.env.OPENROUTER_API_KEY = 'test-key'

  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: 'telemetry rate limit' },
  }), {
    status: 429,
    headers: { 'content-type': 'application/json' },
  })

  try {
    await assert.rejects(
      provider.execute({
        systemPrompt: 'sys',
        userMessage: 'user',
        model: 'openai/gpt-4o-mini',
        thinking: 'low',
        outputPath: outputDir,
        sessionId: 'openrouter-session',
        rootSessionId: 'openrouter-root',
        agentName: 'router',
      }),
      /telemetry rate limit/,
    )

    const entries = readJsonl(getAssignmentLogPath(outputDir, 'provider-events.jsonl'))
    assert.equal(entries[0]?.event, 'request.start')
    assert.equal(entries.at(-1)?.event, 'request.fail')
    assert.equal(entries.at(-1)?.status, 'failed')
    assert.match(String(entries.at(-1)?.detail), /telemetry rate limit/)
  } finally {
    globalThis.fetch = originalFetch
    process.env.OPENROUTER_API_KEY = originalKey
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})

function readJsonl(filePath: string): Array<Record<string, unknown>> {
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}


/**
 * A response cut off at the token ceiling is a failure, not a short answer.
 *
 * Without this, the partial text becomes the handoff artifact and the next
 * agent consumes it with nothing in the logs to explain the truncation. For
 * this provider an OpenAI-compatible chat completion reports truncation as
 * `finish_reason: 'length'`.
 */
test('openrouter provider: a response truncated at the token ceiling is a failure, not a result', async () => {
  const provider = createOpenRouterProvider()
  const originalKey = process.env.OPENROUTER_API_KEY
  const originalFetch = globalThis.fetch
  process.env.OPENROUTER_API_KEY = 'test-key'

  // The network boundary is replaced rather than called: a real request to this
  // provider is credentialed and billed, and the behaviour under test is how a
  // well-formed truncated response body is classified.
  globalThis.fetch = async () => new Response(JSON.stringify({
      model: 'openai/gpt-4o-mini',
      choices: [{ finish_reason: 'length', message: { content: 'A partial ans' } }],
      usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
    }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

  try {
    await assert.rejects(
      provider.execute({
        systemPrompt: 'sys',
        userMessage: 'user',
        model: 'openai/gpt-4o-mini',
        thinking: 'low',
      }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError)
        assert.equal(error.code, 'provider_truncated')
        // Retrying an identical request against an identical ceiling reproduces
        // the truncation, so the attempt loop must not spend a turn on it.
        assert.equal(error.retryable, false)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
    // Assigning `undefined` would set the literal string "undefined".
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = originalKey
  }
})
