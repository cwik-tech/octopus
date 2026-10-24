import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { createOpenAIProvider } from '../../providers/openai.js'
import { getAssignmentLogPath } from '../../domains/runtime/logger.js'
import {
  ProviderError,
  formatProviderErrorForUser,
} from '../../domains/provider/provider-error.js'

test('OpenAI provider: name is "openai"', () => {
  const provider = createOpenAIProvider()
  assert.equal(provider.name, 'openai')
})

test('OpenAI provider: requires OPENAI_API_KEY', async () => {
  const provider = createOpenAIProvider()
  const originalKey = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY

  try {
    await assert.rejects(
      provider.execute({
        systemPrompt: 'sys',
        userMessage: 'user',
        model: 'gpt-5.4-mini',
        thinking: 'low',
      }),
      /OPENAI_API_KEY/,
    )
  } finally {
    process.env.OPENAI_API_KEY = originalKey
  }
})

test('OpenAI provider: posts to Responses API and normalizes output', async () => {
  const provider = createOpenAIProvider()
  const originalKey = process.env.OPENAI_API_KEY
  const originalFetch = globalThis.fetch
  process.env.OPENAI_API_KEY = 'test-key'

  let capturedUrl = ''
  let capturedInit: RequestInit | undefined

  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input)
    capturedInit = init
    return new Response(JSON.stringify({
      model: 'gpt-5.4-mini',
      output: [
        {
          type: 'message',
          content: [
            { type: 'output_text', text: 'Hello ' },
            { type: 'output_text', text: 'world' },
          ],
        },
      ],
      usage: {
        input_tokens: 12,
        output_tokens: 34,
        total_tokens: 46,
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
      model: 'gpt-5.4-mini',
      thinking: 'medium',
    })

    assert.equal(capturedUrl, 'https://api.openai.com/v1/responses')
    assert.equal(result.text, 'Hello world')
    assert.equal(result.inputTokens, 12)
    assert.equal(result.outputTokens, 34)
    assert.equal(result.contextTokens, 46)
    assert.equal(result.model, 'gpt-5.4-mini')

    const body = JSON.parse(String(capturedInit?.body))
    assert.equal(body.model, 'gpt-5.4-mini')
    assert.equal(body.input[0].role, 'system')
    assert.equal(body.input[0].content[0].text, 'system prompt')
    assert.equal(body.input[1].role, 'user')
    assert.equal(body.input[1].content[0].text, 'user prompt')
    assert.equal(body.reasoning.effort, 'medium')
  } finally {
    globalThis.fetch = originalFetch
    process.env.OPENAI_API_KEY = originalKey
  }
})

test('OpenAI provider: omits reasoning when providerConfig.reasoning is false', async () => {
  const provider = createOpenAIProvider()
  const originalKey = process.env.OPENAI_API_KEY
  const originalFetch = globalThis.fetch
  process.env.OPENAI_API_KEY = 'test-key'

  let capturedInit: RequestInit | undefined

  globalThis.fetch = async (_input, init) => {
    capturedInit = init
    return new Response(JSON.stringify({
      model: 'gpt-5.4-mini',
      output_text: 'No reasoning payload',
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        total_tokens: 3,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    await provider.execute({
      systemPrompt: 'system prompt',
      userMessage: 'user prompt',
      model: 'gpt-5.4-mini',
      thinking: 'high',
      providerConfig: { reasoning: false },
    })

    const body = JSON.parse(String(capturedInit?.body))
    assert.equal('reasoning' in body, false)
  } finally {
    globalThis.fetch = originalFetch
    process.env.OPENAI_API_KEY = originalKey
  }
})

test('OpenAI provider: surfaces API errors', async () => {
  const provider = createOpenAIProvider()
  const originalKey = process.env.OPENAI_API_KEY
  const originalFetch = globalThis.fetch
  process.env.OPENAI_API_KEY = 'test-key'

  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: 'invalid model' },
  }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  })

  try {
    await assert.rejects(
      provider.execute({
        systemPrompt: 'sys',
        userMessage: 'user',
        model: 'bad-model',
        thinking: 'low',
      }),
      /invalid model/,
    )
  } finally {
    globalThis.fetch = originalFetch
    process.env.OPENAI_API_KEY = originalKey
  }
})

test('OpenAI provider: preserves a specific error code over its generic type', async () => {
  const provider = createOpenAIProvider()
  const originalKey = process.env.OPENAI_API_KEY
  const originalFetch = globalThis.fetch
  process.env.OPENAI_API_KEY = 'test-key'

  globalThis.fetch = async () => new Response(JSON.stringify({
    error: {
      message: 'Maximum context length exceeded.',
      type: 'invalid_request_error',
      code: 'context_length_exceeded',
    },
  }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  })

  try {
    await assert.rejects(
      provider.execute({
        systemPrompt: 'sys',
        userMessage: 'user',
        model: 'gpt-5.4-mini',
        thinking: 'low',
      }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError)
        assert.equal(error.code, 'context_length_exceeded')
        assert.equal(
          formatProviderErrorForUser(error),
          'This conversation is too long for the selected model. Shorten it or start a new chat. (Status 400)',
        )
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
    process.env.OPENAI_API_KEY = originalKey
  }
})

test('OpenAI provider: logs provider lifecycle events', async () => {
  const provider = createOpenAIProvider()
  const originalKey = process.env.OPENAI_API_KEY
  const originalFetch = globalThis.fetch
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-provider-'))
  process.env.OPENAI_API_KEY = 'test-key'

  globalThis.fetch = async () => new Response(JSON.stringify({
    model: 'gpt-5.4-mini',
    output_text: 'Logged response',
    usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

  try {
    await provider.execute({
      systemPrompt: 'sys',
      userMessage: 'user',
      model: 'gpt-5.4-mini',
      thinking: 'low',
      outputPath: outputDir,
      sessionId: 'openai-session',
      rootSessionId: 'openai-root',
      agentName: 'researcher',
    })

    const entries = readJsonl(getAssignmentLogPath(outputDir, 'provider-events.jsonl'))
    assert.equal(entries[0]?.provider, 'openai')
    assert.equal(entries[0]?.event, 'request.start')
    assert.equal(entries.at(-1)?.event, 'request.end')
    assert.equal(entries.at(-1)?.status, 'completed')
  } finally {
    globalThis.fetch = originalFetch
    process.env.OPENAI_API_KEY = originalKey
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
 * this provider the Responses API reports truncation as `status: 'incomplete'` with an
 * `incomplete_details.reason`, not as a chat-completions `finish_reason`.
 */
test('openai provider: a response truncated at the token ceiling is a failure, not a result', async () => {
  const provider = createOpenAIProvider()
  const originalKey = process.env.OPENAI_API_KEY
  const originalFetch = globalThis.fetch
  process.env.OPENAI_API_KEY = 'test-key'

  // The network boundary is replaced rather than called: a real request to this
  // provider is credentialed and billed, and the behaviour under test is how a
  // well-formed truncated response body is classified.
  globalThis.fetch = async () => new Response(JSON.stringify({
      model: 'gpt-5.4-mini',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'A partial ans' }] }],
      usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 },
    }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

  try {
    await assert.rejects(
      provider.execute({
        systemPrompt: 'sys',
        userMessage: 'user',
        model: 'gpt-5.4-mini',
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
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalKey
  }
})
