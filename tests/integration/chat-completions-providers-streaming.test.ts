import test from 'node:test'
import assert from 'node:assert/strict'

import { createOpenRouterProvider } from '../../providers/openrouter.js'
import { createDeepSeekProvider } from '../../providers/deepseek.js'
import { createXAIProvider } from '../../providers/xai.js'
import { createKimiProvider } from '../../providers/kimi.js'
import { ProviderError } from '../../domains/provider/provider-error.js'
import { PROVIDER_TRUNCATED_CODE } from '../../domains/provider/provider-truncation.js'
import type { Provider, ProviderProtocolEvent } from '../../providers/types.js'

/**
 * The four providers that speak OpenAI-compatible Chat Completions.
 *
 * They share one streaming reader, so they are exercised together: what matters
 * per provider is that the reader is wired in, that `stream: true` is actually
 * requested and cannot be turned off from configuration, and that every
 * non-streaming rule — truncation, usage, cost, model — still runs on the
 * rebuilt body. Parser-level tests live in
 * `tests/unit/chat-completions-stream.test.ts`; these prove the call sites.
 */
const PROVIDERS: ReadonlyArray<{
  readonly name: string
  readonly create: () => Provider
  readonly env: Readonly<Record<string, string>>
  readonly model: string
  /** True where the provider reads `extra_body` from provider config. */
  readonly honoursExtraBody: boolean
  /** True where the provider must ask for usage explicitly. */
  readonly requestsIncludeUsage: boolean
}> = [
  {
    name: 'openrouter',
    create: createOpenRouterProvider,
    env: { OPENROUTER_API_KEY: 'test-key' },
    model: 'openai/gpt-4o-mini',
    honoursExtraBody: false,
    requestsIncludeUsage: false,
  },
  {
    name: 'deepseek',
    create: createDeepSeekProvider,
    env: { DEEPSEEK_API_KEY: 'test-key' },
    model: 'deepseek-chat',
    honoursExtraBody: true,
    requestsIncludeUsage: true,
  },
  {
    name: 'xai',
    create: createXAIProvider,
    env: { XAI_API_KEY: 'test-key' },
    model: 'grok-4',
    honoursExtraBody: false,
    requestsIncludeUsage: true,
  },
  {
    name: 'kimi',
    create: createKimiProvider,
    env: { MOONSHOT_API_KEY: 'test-key' },
    model: 'kimi-k2',
    honoursExtraBody: true,
    requestsIncludeUsage: false,
  },
]

// ─── Request capture ────────────────────────────────────────────────────────
//
// The posted body is external JSON as far as the test is concerned, so it is
// narrowed into a constructed value rather than asserted into a shape.

interface CapturedRequest {
  readonly stream: unknown
  readonly model: unknown
  readonly streamOptions: Record<string, unknown> | undefined
  readonly usage: Record<string, unknown> | undefined
  readonly signal: AbortSignal | undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  return { ...value }
}

function describeRequest(init: RequestInit | undefined): CapturedRequest {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(init?.body ?? '{}'))
  } catch {
    parsed = undefined
  }
  const body = asRecord(parsed) ?? {}
  return {
    stream: body.stream,
    model: body.model,
    streamOptions: asRecord(body.stream_options),
    usage: asRecord(body.usage),
    signal: init?.signal ?? undefined,
  }
}

function withEnv<T>(
  env: Readonly<Record<string, string>>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  return run().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function chunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** Replace `fetch` with one that records the request and answers `respond`. */
function stubFetch(
  captured: CapturedRequest[],
  respond: () => Response,
): () => void {
  const originalFetch = globalThis.fetch
  const fake = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    captured.push(describeRequest(init))
    return respond()
  }
  globalThis.fetch = fake as unknown as typeof globalThis.fetch
  return () => {
    globalThis.fetch = originalFetch
  }
}

const COMPLETE_STREAM = [
  chunk({ model: 'vendor/actual', choices: [{ index: 0, delta: { content: 'Hel' } }] }),
  chunk({ choices: [{ index: 0, delta: { content: 'lo ' } }] }),
  chunk({ choices: [{ index: 0, delta: { content: 'world' } }] }),
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  // Usage arrives last, in its own chunk with no choices, exactly as
  // `stream_options: { include_usage: true }` delivers it.
  chunk({
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  }),
  'data: [DONE]\n\n',
]

for (const entry of PROVIDERS) {
  test(`${entry.name}: requests a stream and emits ordered text events`, async () => {
    const captured: CapturedRequest[] = []
    const restore = stubFetch(captured, () => sseResponse(COMPLETE_STREAM))
    const observed: string[] = []
    let settled = false

    try {
      await withEnv(entry.env, async () => {
        const result = await entry.create().execute({
          systemPrompt: 'system',
          userMessage: 'user',
          model: entry.model,
          thinking: 'low',
          onProtocolEvent: (event: ProviderProtocolEvent) => {
            assert.equal(settled, false, 'events arrive while the turn runs')
            if (event.kind === 'text' && event.text) observed.push(event.text)
          },
        })
        settled = true

        assert.equal(captured[0]?.stream, true, 'the request asked to stream')
        assert.deepEqual(observed, ['Hel', 'lo ', 'world'])
        assert.equal(result.text, 'Hello world')
      })
    } finally {
      restore()
    }
  })

  test(`${entry.name}: preserves model and usage from the streamed terminal chunks`, async () => {
    const captured: CapturedRequest[] = []
    const restore = stubFetch(captured, () => sseResponse(COMPLETE_STREAM))
    try {
      await withEnv(entry.env, async () => {
        const result = await entry.create().execute({
          systemPrompt: 'system',
          userMessage: 'user',
          model: entry.model,
          thinking: 'low',
        })
        assert.equal(result.model, 'vendor/actual')
        assert.equal(result.inputTokens, 12)
        assert.equal(result.outputTokens, 3)
        assert.equal(result.contextTokens, 15)
      })
    } finally {
      restore()
    }
  })

  test(`${entry.name}: a truncated stream is a typed error, not a partial answer`, async () => {
    const captured: CapturedRequest[] = []
    const restore = stubFetch(captured, () =>
      sseResponse([
        chunk({ choices: [{ index: 0, delta: { content: 'half an ans' } }] }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }),
        'data: [DONE]\n\n',
      ]),
    )
    try {
      await withEnv(entry.env, async () => {
        await assert.rejects(
          entry.create().execute({
            systemPrompt: 'system',
            userMessage: 'user',
            model: entry.model,
            thinking: 'low',
          }),
          (error: unknown) => {
            assert.ok(error instanceof ProviderError)
            assert.equal(error.code, PROVIDER_TRUNCATED_CODE)
            assert.match(error.message, /token limit|max_tokens/i)
            return true
          },
        )
      })
    } finally {
      restore()
    }
  })

  test(`${entry.name}: an HTTP-200 error frame fails the turn instead of returning the partial text`, async () => {
    const captured: CapturedRequest[] = []
    const restore = stubFetch(captured, () =>
      sseResponse([
        chunk({ choices: [{ index: 0, delta: { content: 'partial' } }] }),
        chunk({ error: { message: 'upstream exploded', type: 'server_error' } }),
      ]),
    )
    try {
      await withEnv(entry.env, async () => {
        await assert.rejects(
          entry.create().execute({
            systemPrompt: 'system',
            userMessage: 'user',
            model: entry.model,
            thinking: 'low',
          }),
          (error: unknown) => {
            assert.ok(error instanceof ProviderError)
            assert.match(error.message, /upstream exploded/)
            return true
          },
        )
      })
    } finally {
      restore()
    }
  })

  test(`${entry.name}: a stream cut short fails the turn instead of returning a prefix`, async () => {
    const captured: CapturedRequest[] = []
    const restore = stubFetch(captured, () =>
      sseResponse([
        chunk({ choices: [{ index: 0, delta: { content: 'half an ans' } }] }),
      ]),
    )
    try {
      await withEnv(entry.env, async () => {
        await assert.rejects(
          entry.create().execute({
            systemPrompt: 'system',
            userMessage: 'user',
            model: entry.model,
            thinking: 'low',
          }),
          (error: unknown) => {
            assert.ok(error instanceof ProviderError)
            assert.match(error.message, /incomplete/i)
            return true
          },
        )
      })
    } finally {
      restore()
    }
  })

  test(`${entry.name}: an endpoint that ignores stream:true still returns its answer`, async () => {
    const captured: CapturedRequest[] = []
    const restore = stubFetch(
      captured,
      () =>
        new Response(
          JSON.stringify({
            model: 'vendor/actual',
            choices: [
              { message: { content: 'Hello world' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    const observed: string[] = []
    try {
      await withEnv(entry.env, async () => {
        const result = await entry.create().execute({
          systemPrompt: 'system',
          userMessage: 'user',
          model: entry.model,
          thinking: 'low',
          onProtocolEvent: (event) => {
            if (event.kind === 'text' && event.text) observed.push(event.text)
          },
        })
        assert.equal(result.text, 'Hello world')
        assert.equal(result.inputTokens, 12)
        assert.deepEqual(
          observed,
          [],
          'nothing arrived incrementally, so nothing is reported as if it had',
        )
      })
    } finally {
      restore()
    }
  })

  // ─── The JSON fallback is a boundary too ──────────────────────────────────
  //
  // An endpoint that ignores `stream: true` answers with an ordinary body, and
  // that body is external input exactly like a frame is. It is parsed to
  // `unknown` and rebuilt field by field, so a mis-shaped body cannot become a
  // typed value nobody validated.

  test(`${entry.name}: a JSON fallback body that is not valid JSON fails the turn`, async () => {
    const captured: CapturedRequest[] = []
    const restore = stubFetch(
      captured,
      () =>
        new Response('{"choices": [ this is not json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    try {
      await withEnv(entry.env, async () => {
        await assert.rejects(
          entry.create().execute({
            systemPrompt: 'system',
            userMessage: 'user',
            model: entry.model,
            thinking: 'low',
          }),
          (error: unknown) => {
            assert.ok(error instanceof ProviderError)
            assert.match(error.message, /could not be read as JSON/i)
            return true
          },
        )
      })
    } finally {
      restore()
    }
  })

  test(`${entry.name}: a JSON fallback body that is not an object fails the turn`, async () => {
    const captured: CapturedRequest[] = []
    const restore = stubFetch(
      captured,
      () =>
        new Response('[1, 2, 3]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    try {
      await withEnv(entry.env, async () => {
        await assert.rejects(
          entry.create().execute({
            systemPrompt: 'system',
            userMessage: 'user',
            model: entry.model,
            thinking: 'low',
          }),
          (error: unknown) => {
            assert.ok(error instanceof ProviderError)
            assert.match(error.message, /could not be read as JSON/i)
            return true
          },
        )
      })
    } finally {
      restore()
    }
  })

  test(`${entry.name}: mis-shaped fields in a JSON fallback body are dropped, not coerced`, async () => {
    const captured: CapturedRequest[] = []
    const restore = stubFetch(
      captured,
      () =>
        new Response(
          JSON.stringify({
            // Every field here has the wrong type. None of them may reach the
            // result: a numeric model must not become a model name, and a
            // string token count must not become a token count.
            model: 7,
            choices: [
              { message: { content: 'Hello world' }, finish_reason: 'stop' },
              'not a choice',
            ],
            usage: { prompt_tokens: '12', completion_tokens: null, total_tokens: {} },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    try {
      await withEnv(entry.env, async () => {
        const result = await entry.create().execute({
          systemPrompt: 'system',
          userMessage: 'user',
          model: entry.model,
          thinking: 'low',
        })
        assert.equal(result.text, 'Hello world')
        assert.equal(result.model, entry.model, 'a numeric model is not a model')
        assert.equal(result.inputTokens, 0)
        assert.equal(result.outputTokens, 0)
        assert.equal(result.contextTokens, 0)
      })
    } finally {
      restore()
    }
  })

  test(`${entry.name}: a JSON fallback body whose content is not text fails the turn`, async () => {
    const captured: CapturedRequest[] = []
    const restore = stubFetch(
      captured,
      () =>
        new Response(
          JSON.stringify({
            model: 'vendor/actual',
            choices: [
              {
                message: {
                  content: [
                    { type: 'image_url', image_url: { url: 'x' } },
                    // Carries `text`, but a refusal is not the answer. Reading
                    // parts by presence of `text` rather than by `type` would
                    // put this in the transcript as the model's reply.
                    { type: 'refusal', text: 'I cannot help with that.' },
                  ],
                },
                finish_reason: 'stop',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    try {
      await withEnv(entry.env, async () => {
        await assert.rejects(
          entry.create().execute({
            systemPrompt: 'system',
            userMessage: 'user',
            model: entry.model,
            thinking: 'low',
          }),
          (error: unknown) => {
            assert.ok(error instanceof ProviderError)
            assert.match(error.message, /no assistant text/i)
            return true
          },
        )
      })
    } finally {
      restore()
    }
  })

  test(`${entry.name}: bounds the request with a timeout composed with the caller's signal`, async () => {
    const captured: CapturedRequest[] = []
    const restore = stubFetch(captured, () => sseResponse(COMPLETE_STREAM))
    try {
      await withEnv(entry.env, async () => {
        // No caller signal: a signal must still be attached, or the request has
        // no upper bound at all.
        await entry.create().execute({
          systemPrompt: 'system',
          userMessage: 'user',
          model: entry.model,
          thinking: 'low',
        })
        const unbounded = captured[0]?.signal
        assert.ok(
          unbounded instanceof AbortSignal,
          'a timeout signal is attached even with no caller signal',
        )

        // With a caller signal: cancelling the turn must still cancel the
        // request, so the composed signal has to follow the caller's.
        const controller = new AbortController()
        await entry.create().execute({
          systemPrompt: 'system',
          userMessage: 'user',
          model: entry.model,
          thinking: 'low',
          signal: controller.signal,
        })
        const composed = captured[1]?.signal
        assert.ok(composed instanceof AbortSignal)
        assert.equal(composed.aborted, false)
        controller.abort(new Error('caller cancelled'))
        assert.equal(
          composed.aborted,
          true,
          "the caller's abort still reaches the request",
        )
      })
    } finally {
      restore()
    }
  })

  if (entry.requestsIncludeUsage) {
    test(`${entry.name}: asks for usage in the stream, which it otherwise omits`, async () => {
      const captured: CapturedRequest[] = []
      const restore = stubFetch(captured, () => sseResponse(COMPLETE_STREAM))
      try {
        await withEnv(entry.env, async () => {
          await entry.create().execute({
            systemPrompt: 'system',
            userMessage: 'user',
            model: entry.model,
            thinking: 'low',
          })
          assert.equal(captured[0]?.streamOptions?.include_usage, true)
        })
      } finally {
        restore()
      }
    })
  }

  if (entry.honoursExtraBody) {
    test(`${entry.name}: extra_body cannot switch streaming off`, async () => {
      const captured: CapturedRequest[] = []
      const restore = stubFetch(captured, () => sseResponse(COMPLETE_STREAM))
      const observed: string[] = []
      try {
        await withEnv(entry.env, async () => {
          const result = await entry.create().execute({
            systemPrompt: 'system',
            userMessage: 'user',
            model: entry.model,
            thinking: 'low',
            providerConfig: {
              // The live footgun: a user-supplied override that used to win over
              // the provider's own request shape.
              extra_body: { stream: false, model: 'attacker/model' },
            },
            onProtocolEvent: (event) => {
              if (event.kind === 'text' && event.text) observed.push(event.text)
            },
          })
          assert.equal(captured[0]?.stream, true)
          assert.equal(captured[0]?.model, entry.model)
          assert.deepEqual(observed, ['Hel', 'lo ', 'world'])
          assert.equal(result.text, 'Hello world')
        })
      } finally {
        restore()
      }
    })
  }
}

test('openrouter: asks for cost accounting and keeps the reported cost', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () =>
    sseResponse([
      chunk({ model: 'vendor/actual', choices: [{ index: 0, delta: { content: 'hi' } }] }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      chunk({
        choices: [],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 3,
          total_tokens: 15,
          cost: 0.00042,
        },
      }),
      'data: [DONE]\n\n',
    ]),
  )
  try {
    await withEnv({ OPENROUTER_API_KEY: 'test-key' }, async () => {
      const result = await createOpenRouterProvider().execute({
        systemPrompt: 'system',
        userMessage: 'user',
        model: 'openai/gpt-4o-mini',
        thinking: 'low',
      })
      assert.equal(
        captured[0]?.usage?.include,
        true,
        'OpenRouter reports cost only when asked to',
      )
      assert.equal(result.cost, 0.00042)
      assert.equal(result.costSource, 'reported')
      assert.equal(result.costTracked, true)
    })
  } finally {
    restore()
  }
})
