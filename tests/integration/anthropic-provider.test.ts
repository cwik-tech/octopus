import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { createAnthropicProvider } from '../../providers/anthropic.js'
import { ProviderError } from '../../domains/provider/provider-error.js'
import { getAssignmentLogPath } from '../../domains/runtime/logger.js'

test('Anthropic provider: name is "anthropic"', () => {
  const provider = createAnthropicProvider()
  assert.equal(provider.name, 'anthropic')
})

test('Anthropic provider: requires ANTHROPIC_API_KEY', async () => {
  const provider = createAnthropicProvider()
  const originalKey = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY

  try {
    await assert.rejects(
      provider.execute({
        systemPrompt: 'sys',
        userMessage: 'user',
        model: 'claude-sonnet-4-0',
        thinking: 'low',
      }),
      /ANTHROPIC_API_KEY/,
    )
  } finally {
    process.env.ANTHROPIC_API_KEY = originalKey
  }
})

test('Anthropic provider: posts to Messages API and normalizes response', async () => {
  const provider = createAnthropicProvider()
  const originalKey = process.env.ANTHROPIC_API_KEY
  const originalFetch = globalThis.fetch
  process.env.ANTHROPIC_API_KEY = 'test-key'

  let capturedUrl = ''
  let capturedInit: RequestInit | undefined

  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input)
    capturedInit = init
    return new Response(JSON.stringify({
      model: 'claude-sonnet-4-6',
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world' },
      ],
      usage: {
        input_tokens: 12,
        output_tokens: 34,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 6,
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
      model: 'claude-sonnet-4-6',
      thinking: 'medium',
    })

    assert.equal(capturedUrl, 'https://api.anthropic.com/v1/messages')
    assert.equal(result.text, 'Hello world')
    assert.equal(result.inputTokens, 12)
    assert.equal(result.outputTokens, 34)
    assert.equal(result.contextTokens, 57)
    assert.equal(result.model, 'claude-sonnet-4-6')

    const body = JSON.parse(String(capturedInit?.body))
    assert.equal(body.model, 'claude-sonnet-4-6')
    assert.equal(body.system, 'system prompt')
    assert.equal(body.messages[0].content, 'user prompt')
    assert.equal(body.thinking.type, 'enabled')
  } finally {
    globalThis.fetch = originalFetch
    process.env.ANTHROPIC_API_KEY = originalKey
  }
})

test('Anthropic provider: sends the selected model id unchanged', async () => {
  // A deliberately chosen model id — including a vendor alias — is the user's
  // decision. Rewriting it application-side would send a model nobody picked
  // and report a different one than the agent was configured with.
  const selectedModelIds = [
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-0',
  ]

  const provider = createAnthropicProvider()
  const originalKey = process.env.ANTHROPIC_API_KEY
  const originalFetch = globalThis.fetch
  process.env.ANTHROPIC_API_KEY = 'test-key'

  try {
    for (const selected of selectedModelIds) {
      let capturedInit: RequestInit | undefined
      globalThis.fetch = async (_input, init) => {
        capturedInit = init
        return new Response(
          JSON.stringify({
            model: selected,
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      const result = await provider.execute({
        systemPrompt: 'system prompt',
        userMessage: 'user prompt',
        model: selected,
        thinking: 'medium',
      })

      const body = JSON.parse(String(capturedInit?.body)) as { model: string }
      assert.equal(body.model, selected, `outbound model id for ${selected}`)
      assert.equal(result.model, selected, `reported model id for ${selected}`)
    }
  } finally {
    globalThis.fetch = originalFetch
    process.env.ANTHROPIC_API_KEY = originalKey
  }
})

test('Anthropic provider: surfaces API errors', async () => {
  const provider = createAnthropicProvider()
  const originalKey = process.env.ANTHROPIC_API_KEY
  const originalFetch = globalThis.fetch
  process.env.ANTHROPIC_API_KEY = 'test-key'

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
    process.env.ANTHROPIC_API_KEY = originalKey
  }
})

test('Anthropic provider: logs provider lifecycle events', async () => {
  const provider = createAnthropicProvider()
  const originalKey = process.env.ANTHROPIC_API_KEY
  const originalFetch = globalThis.fetch
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anthropic-provider-'))
  process.env.ANTHROPIC_API_KEY = 'test-key'

  globalThis.fetch = async () => new Response(JSON.stringify({
    model: 'claude-sonnet-4-0',
    content: [{ type: 'text', text: 'Logged response' }],
    usage: { input_tokens: 3, output_tokens: 4 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

  try {
    await provider.execute({
      systemPrompt: 'sys',
      userMessage: 'user',
      model: 'claude-sonnet-4-0',
      thinking: 'low',
      outputPath: outputDir,
      sessionId: 'anthropic-session',
      rootSessionId: 'anthropic-root',
      agentName: 'researcher',
    })

    const entries = readJsonl(getAssignmentLogPath(outputDir, 'provider-events.jsonl'))
    assert.equal(entries[0]?.provider, 'anthropic')
    assert.equal(entries[0]?.event, 'request.start')
    assert.equal(entries.at(-1)?.event, 'request.end')
    assert.equal(entries.at(-1)?.status, 'completed')
  } finally {
    globalThis.fetch = originalFetch
    process.env.ANTHROPIC_API_KEY = originalKey
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
 * this provider the Messages API reports truncation as `stop_reason: 'max_tokens'`.
 */
test('anthropic provider: a response truncated at the token ceiling is a failure, not a result', async () => {
  const provider = createAnthropicProvider()
  const originalKey = process.env.ANTHROPIC_API_KEY
  const originalFetch = globalThis.fetch
  process.env.ANTHROPIC_API_KEY = 'test-key'

  // The network boundary is replaced rather than called: a real request to this
  // provider is credentialed and billed, and the behaviour under test is how a
  // well-formed truncated response body is classified.
  globalThis.fetch = async () => new Response(JSON.stringify({
      model: 'claude-sonnet-4-0',
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: 'A partial ans' }],
      usage: { input_tokens: 12, output_tokens: 34 },
    }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

  try {
    await assert.rejects(
      provider.execute({
        systemPrompt: 'sys',
        userMessage: 'user',
        model: 'claude-sonnet-4-0',
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
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = originalKey
  }
})

test('Anthropic provider: a missing credential is typed as an authentication failure', async () => {
  // The taxonomy is what later decides whether a failure is the model's fault
  // and whether anything could have run. "Unknown" would make a credential
  // problem indistinguishable from a transport one.
  const provider = createAnthropicProvider()
  const originalKey = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY

  try {
    await assert.rejects(
      provider.execute({
        systemPrompt: 'sys',
        userMessage: 'user',
        model: 'claude-sonnet-4-6',
        thinking: 'low',
      }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError)
        assert.equal(error.kind, 'authentication')
        assert.equal(error.retryable, false)
        return true
      },
    )
  } finally {
    process.env.ANTHROPIC_API_KEY = originalKey
  }
})

test('Anthropic provider: a thinking budget of zero sends no thinking block', async () => {
  // Zero is a setting, not an absence. The adapter resolves the budget with
  // `??`, so a written 0 stays 0 rather than being replaced by the level's
  // default, and the request then carries no thinking block at all — which is
  // how an Agent turns extended thinking off on this provider.
  //
  // This is why the settings compatibility check keeps a written zero rather
  // than treating it as below the vendor's floor: dropping it would turn
  // thinking back on, the opposite of what was asked for. Asserted against the
  // request the adapter actually builds, because that is the only place the
  // difference exists — and through the same narrow `fetch` interception the
  // tests above use, so nothing about endpoint handling is altered to observe
  // it.
  const provider = createAnthropicProvider()
  const originalKey = process.env.ANTHROPIC_API_KEY
  const originalFetch = globalThis.fetch
  process.env.ANTHROPIC_API_KEY = 'test-key'

  const bodies: Record<string, unknown>[] = []
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(JSON.stringify({
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'Answered.' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  try {
    await provider.execute({
      systemPrompt: 'system prompt',
      userMessage: 'user prompt',
      model: 'claude-sonnet-4-6',
      thinking: 'medium',
      providerConfig: { thinking_budget: 0, max_tokens: 8192 },
    })
    assert.equal(bodies[0]?.thinking, undefined, 'thinking is off')
    assert.equal(bodies[0]?.max_tokens, 8192)

    // The control: without the setting, this thinking level does send one.
    await provider.execute({
      systemPrompt: 'system prompt',
      userMessage: 'user prompt',
      model: 'claude-sonnet-4-6',
      thinking: 'medium',
      providerConfig: { max_tokens: 8192 },
    })
    assert.deepEqual(bodies[1]?.thinking, {
      type: 'enabled',
      budget_tokens: 4096,
    })
  } finally {
    globalThis.fetch = originalFetch
    // Deleted rather than assigned: an absent variable and one holding the
    // string 'undefined' are different things to every later reader.
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = originalKey
  }
})
