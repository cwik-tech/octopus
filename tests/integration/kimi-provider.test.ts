import test from 'node:test'
import assert from 'node:assert/strict'

import { createKimiProvider } from '../../providers/kimi.js'
import { ProviderError } from '../../domains/provider/provider-error.js'

test('Kimi provider: name is "kimi"', () => {
  const provider = createKimiProvider()
  assert.equal(provider.name, 'kimi')
})

test('Kimi provider: requires MOONSHOT_API_KEY or KIMI_API_KEY', async () => {
  const provider = createKimiProvider()
  const originalMoonshotKey = process.env.MOONSHOT_API_KEY
  const originalKimiKey = process.env.KIMI_API_KEY
  delete process.env.MOONSHOT_API_KEY
  delete process.env.KIMI_API_KEY

  try {
    await assert.rejects(
      provider.execute({
        systemPrompt: 'sys',
        userMessage: 'user',
        model: 'kimi-k2.6',
        thinking: 'low',
      }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError, `expected a ProviderError, got ${String(error)}`)
        assert.match(error.message, /MOONSHOT_API_KEY or KIMI_API_KEY/)
        // Checked before the request is built, so this refusal can become an
        // offer rather than a Team that refuses to start.
        assert.equal(error.kind, 'authentication')
        assert.equal(error.dispatched, false)
        assert.equal(error.retryable, false)
        return true
      },
    )
  } finally {
    if (originalMoonshotKey === undefined) delete process.env.MOONSHOT_API_KEY
    else process.env.MOONSHOT_API_KEY = originalMoonshotKey
    if (originalKimiKey === undefined) delete process.env.KIMI_API_KEY
    else process.env.KIMI_API_KEY = originalKimiKey
  }
})

test('Kimi provider: posts to chat completions API and normalizes response', async () => {
  const provider = createKimiProvider()
  const originalMoonshotKey = process.env.MOONSHOT_API_KEY
  const originalKimiKey = process.env.KIMI_API_KEY
  const originalFetch = globalThis.fetch
  process.env.MOONSHOT_API_KEY = 'test-key'
  delete process.env.KIMI_API_KEY

  let capturedUrl = ''
  let capturedInit: RequestInit | undefined

  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input)
    capturedInit = init
    return new Response(JSON.stringify({
      id: 'chatcmpl-123',
      model: 'kimi-k2.6',
      choices: [
        {
          message: {
            content: 'Kimi report body',
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
      model: 'kimi-k2.6',
      thinking: 'medium',
      providerConfig: {
        temperature: 0.2,
        max_tokens: 500,
        extra_body: { thinking: { type: 'enabled' } },
      },
    })

    assert.equal(capturedUrl, 'https://api.moonshot.ai/v1/chat/completions')
    assert.equal(result.text, 'Kimi report body')
    assert.equal(result.inputTokens, 10)
    assert.equal(result.outputTokens, 20)
    assert.equal(result.contextTokens, 30)
    assert.equal(result.model, 'kimi-k2.6')

    assert.equal((capturedInit?.headers as Record<string, string>)['Authorization'], 'Bearer test-key')

    const body = JSON.parse(String(capturedInit?.body))
    assert.equal(body.model, 'kimi-k2.6')
    assert.equal(body.messages[0].role, 'system')
    assert.equal(body.messages[0].content, 'system prompt')
    assert.equal(body.messages[1].role, 'user')
    assert.equal(body.messages[1].content, 'user prompt')
    assert.equal(body.temperature, 0.2)
    assert.equal(body.max_tokens, 500)
    assert.deepEqual(body.thinking, { type: 'enabled' })
  } finally {
    globalThis.fetch = originalFetch
    if (originalMoonshotKey === undefined) delete process.env.MOONSHOT_API_KEY
    else process.env.MOONSHOT_API_KEY = originalMoonshotKey
    if (originalKimiKey === undefined) delete process.env.KIMI_API_KEY
    else process.env.KIMI_API_KEY = originalKimiKey
  }
})

test('Kimi provider: accepts KIMI_API_KEY alias and base_url without suffix', async () => {
  const provider = createKimiProvider()
  const originalMoonshotKey = process.env.MOONSHOT_API_KEY
  const originalKimiKey = process.env.KIMI_API_KEY
  const originalFetch = globalThis.fetch
  delete process.env.MOONSHOT_API_KEY
  process.env.KIMI_API_KEY = 'test-kimi-key'

  let capturedUrl = ''
  let capturedAuth = ''
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input)
    capturedAuth = String((init?.headers as Record<string, string>)['Authorization'])
    return new Response(JSON.stringify({
      model: 'kimi-k2.6',
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    await provider.execute({
      systemPrompt: 'sys',
      userMessage: 'user',
      model: 'kimi-k2.6',
      thinking: 'low',
      providerConfig: { base_url: 'https://api.moonshot.ai/v1' },
    })

    assert.equal(capturedUrl, 'https://api.moonshot.ai/v1/chat/completions')
    assert.equal(capturedAuth, 'Bearer test-kimi-key')
  } finally {
    globalThis.fetch = originalFetch
    if (originalMoonshotKey === undefined) delete process.env.MOONSHOT_API_KEY
    else process.env.MOONSHOT_API_KEY = originalMoonshotKey
    if (originalKimiKey === undefined) delete process.env.KIMI_API_KEY
    else process.env.KIMI_API_KEY = originalKimiKey
  }
})

test('Kimi provider: surfaces API errors', async () => {
  const provider = createKimiProvider()
  const originalMoonshotKey = process.env.MOONSHOT_API_KEY
  const originalKimiKey = process.env.KIMI_API_KEY
  const originalFetch = globalThis.fetch
  process.env.MOONSHOT_API_KEY = 'test-key'

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
        model: 'kimi-k2.6',
        thinking: 'low',
      }),
      /rate limit/,
    )
  } finally {
    globalThis.fetch = originalFetch
    if (originalMoonshotKey === undefined) delete process.env.MOONSHOT_API_KEY
    else process.env.MOONSHOT_API_KEY = originalMoonshotKey
    if (originalKimiKey === undefined) delete process.env.KIMI_API_KEY
    else process.env.KIMI_API_KEY = originalKimiKey
  }
})


/**
 * A response cut off at the token ceiling is a failure, not a short answer.
 *
 * Without this, the partial text becomes the handoff artifact and the next
 * agent consumes it with nothing in the logs to explain the truncation. For
 * this provider an OpenAI-compatible chat completion reports truncation as
 * `finish_reason: 'length'`.
 */
test('kimi provider: a response truncated at the token ceiling is a failure, not a result', async () => {
  const provider = createKimiProvider()
  const originalKey = process.env.MOONSHOT_API_KEY
  const originalFetch = globalThis.fetch
  process.env.MOONSHOT_API_KEY = 'test-key'

  // The network boundary is replaced rather than called: a real request to this
  // provider is credentialed and billed, and the behaviour under test is how a
  // well-formed truncated response body is classified.
  globalThis.fetch = async () => new Response(JSON.stringify({
      model: 'kimi-k2.6',
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
        model: 'kimi-k2.6',
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
    if (originalKey === undefined) delete process.env.MOONSHOT_API_KEY
    else process.env.MOONSHOT_API_KEY = originalKey
  }
})
