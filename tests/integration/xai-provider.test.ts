import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { createXAIProvider } from '../../providers/xai.js'
import { ProviderError } from '../../domains/provider/provider-error.js'
import { getAssignmentLogPath } from '../../domains/runtime/logger.js'

test('xAI provider: name is "xai"', () => {
  const provider = createXAIProvider()
  assert.equal(provider.name, 'xai')
})

test('xAI provider: requires XAI_API_KEY', async () => {
  const provider = createXAIProvider()
  const originalKey = process.env.XAI_API_KEY
  delete process.env.XAI_API_KEY

  try {
    await assert.rejects(
      provider.execute({
        systemPrompt: 'sys',
        userMessage: 'user',
        model: 'grok-3-mini',
        thinking: 'low',
      }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError, `expected a ProviderError, got ${String(error)}`)
        assert.match(error.message, /XAI_API_KEY/)
        // Read as the first statement of `execute()`, before the body exists.
        // Team preflight defers an Agent pinned here, so the refusal has to be
        // able to become an offer: the typed kind the eligibility policy reads,
        // and the adapter's own claim that nothing was sent.
        assert.equal(error.kind, 'authentication')
        assert.equal(error.dispatched, false)
        assert.equal(error.retryable, false)
        return true
      },
    )
  } finally {
    if (originalKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = originalKey
  }
})

test('xAI provider: posts to chat completions API and normalizes response', async () => {
  const provider = createXAIProvider()
  const originalKey = process.env.XAI_API_KEY
  const originalFetch = globalThis.fetch
  process.env.XAI_API_KEY = 'test-key'

  let capturedUrl = ''
  let capturedInit: RequestInit | undefined

  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input)
    capturedInit = init
    return new Response(JSON.stringify({
      id: 'chatcmpl-123',
      model: 'grok-3-mini',
      choices: [
        {
          message: {
            content: 'xAI report body',
          },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
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
      model: 'grok-3-mini',
      thinking: 'medium',
      providerConfig: {
        temperature: 0.2,
        max_tokens: 500,
      },
    })

    assert.equal(capturedUrl, 'https://api.x.ai/v1/chat/completions')
    assert.equal(result.text, 'xAI report body')
    assert.equal(result.inputTokens, 10)
    assert.equal(result.outputTokens, 20)
    assert.equal(result.contextTokens, 30)
    assert.equal(result.model, 'grok-3-mini')

    assert.equal((capturedInit?.headers as Record<string, string>)['Authorization'], 'Bearer test-key')

    const body = JSON.parse(String(capturedInit?.body))
    assert.equal(body.model, 'grok-3-mini')
    assert.equal(body.messages[0].role, 'system')
    assert.equal(body.messages[0].content, 'system prompt')
    assert.equal(body.messages[1].role, 'user')
    assert.equal(body.messages[1].content, 'user prompt')
    assert.equal(body.temperature, 0.2)
    assert.equal(body.max_tokens, 500)
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = originalKey
  }
})

test('xAI provider: supports array content responses', async () => {
  const provider = createXAIProvider()
  const originalKey = process.env.XAI_API_KEY
  const originalFetch = globalThis.fetch
  process.env.XAI_API_KEY = 'test-key'

  globalThis.fetch = async () => new Response(JSON.stringify({
    model: 'grok-3-mini',
    choices: [
      {
        message: {
          content: [
            { type: 'text', text: 'xAI ' },
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
      model: 'grok-3-mini',
      thinking: 'low',
    })

    assert.equal(result.text, 'xAI summary')
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = originalKey
  }
})

test('xAI provider: surfaces API errors', async () => {
  const provider = createXAIProvider()
  const originalKey = process.env.XAI_API_KEY
  const originalFetch = globalThis.fetch
  process.env.XAI_API_KEY = 'test-key'

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
        model: 'grok-3-mini',
        thinking: 'low',
      }),
      /rate limit/,
    )
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = originalKey
  }
})

test('xAI provider: logs provider lifecycle events', async () => {
  const provider = createXAIProvider()
  const originalKey = process.env.XAI_API_KEY
  const originalFetch = globalThis.fetch
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xai-provider-'))
  process.env.XAI_API_KEY = 'test-key'

  globalThis.fetch = async () => new Response(JSON.stringify({
    model: 'grok-3-mini',
    choices: [
      {
        message: {
          content: 'Logged response',
        },
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

  try {
    await provider.execute({
      systemPrompt: 'sys',
      userMessage: 'user',
      model: 'grok-3-mini',
      thinking: 'low',
      outputPath: outputDir,
      sessionId: 'xai-session',
      rootSessionId: 'xai-root',
      agentName: 'researcher',
    })

    const entries = readJsonl(getAssignmentLogPath(outputDir, 'provider-events.jsonl'))
    assert.equal(entries[0]?.provider, 'xai')
    assert.equal(entries[0]?.event, 'request.start')
    assert.equal(entries.at(-1)?.event, 'request.end')
    assert.equal(entries.at(-1)?.status, 'completed')
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = originalKey
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
test('xai provider: a response truncated at the token ceiling is a failure, not a result', async () => {
  const provider = createXAIProvider()
  const originalKey = process.env.XAI_API_KEY
  const originalFetch = globalThis.fetch
  process.env.XAI_API_KEY = 'test-key'

  // The network boundary is replaced rather than called: a real request to this
  // provider is credentialed and billed, and the behaviour under test is how a
  // well-formed truncated response body is classified.
  globalThis.fetch = async () => new Response(JSON.stringify({
      model: 'grok-3-mini',
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
        model: 'grok-3-mini',
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
    if (originalKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = originalKey
  }
})
