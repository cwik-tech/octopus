import test from 'node:test'
import assert from 'node:assert/strict'

import { createOpenAIProvider } from '../../providers/openai.js'
import { ProviderError } from '../../domains/provider/provider-error.js'
import { PROVIDER_TRUNCATED_CODE } from '../../domains/provider/provider-truncation.js'
import type { ProviderProtocolEvent } from '../../providers/types.js'

/**
 * OpenAI speaks the Responses API, not Chat Completions: `/v1/responses`,
 * `response.output_text.delta` for text, and a typed terminal event carrying
 * the whole response object. That object is the only place `status`,
 * `incomplete_details`, `usage` and `model` arrive, so the reader has to keep
 * it — every non-streaming rule downstream still reads it.
 */

interface CapturedRequest {
  readonly stream: unknown
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
  return { stream: body.stream, signal: init?.signal ?? undefined }
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

/** One Responses-API SSE frame: named event plus its typed JSON payload. */
function event(name: string, payload: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify({ type: name, ...payload })}\n\n`
}

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

function withKey<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'test-key'
  return run().finally(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previous
  })
}

const TEXT_DELTAS = [
  event('response.created', { response: { id: 'resp_1', status: 'in_progress' } }),
  event('response.output_text.delta', { delta: 'Hel' }),
  event('response.output_text.delta', { delta: 'lo ' }),
  event('response.output_text.delta', { delta: 'world' }),
]

function completed(extra: Record<string, unknown> = {}): string {
  return event('response.completed', {
    response: {
      id: 'resp_1',
      status: 'completed',
      model: 'gpt-5.4-mini',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Hello world' }] },
      ],
      usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
      ...extra,
    },
  })
}

function incomplete(reason: string): string {
  return event('response.incomplete', {
    response: {
      id: 'resp_1',
      status: 'incomplete',
      model: 'gpt-5.4-mini',
      incomplete_details: { reason },
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'half an ans' }] },
      ],
      usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
    },
  })
}

const BASE = {
  systemPrompt: 'system',
  userMessage: 'user',
  model: 'gpt-5.4-mini',
  thinking: 'low',
} as const

test('openai: requests a stream and emits ordered text events', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () =>
    sseResponse([...TEXT_DELTAS, completed()]),
  )
  const observed: string[] = []
  let settled = false
  try {
    await withKey(async () => {
      const result = await createOpenAIProvider().execute({
        ...BASE,
        onProtocolEvent: (providerEvent: ProviderProtocolEvent) => {
          assert.equal(settled, false, 'events arrive while the turn runs')
          if (providerEvent.kind === 'text' && providerEvent.text) {
            observed.push(providerEvent.text)
          }
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

test('openai: keeps model and usage from the terminal response object', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () =>
    sseResponse([...TEXT_DELTAS, completed()]),
  )
  try {
    await withKey(async () => {
      const result = await createOpenAIProvider().execute(BASE)
      assert.equal(result.model, 'gpt-5.4-mini')
      assert.equal(result.inputTokens, 12)
      assert.equal(result.outputTokens, 3)
      assert.equal(result.contextTokens, 15)
    })
  } finally {
    restore()
  }
})

test('openai: the terminal response object is the answer, not the deltas', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () =>
    sseResponse([
      ...TEXT_DELTAS,
      // The terminal object disagrees with what was streamed. It is the
      // authority: deltas are a display preview, and the durable reply has to
      // be what the API says it finally produced.
      event('response.completed', {
        response: {
          id: 'resp_1',
          status: 'completed',
          model: 'gpt-5.4-mini',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'Hello, world! (revised)' }],
            },
          ],
          usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
        },
      }),
    ]),
  )
  const observed: string[] = []
  try {
    await withKey(async () => {
      const result = await createOpenAIProvider().execute({
        ...BASE,
        onProtocolEvent: (providerEvent) => {
          if (providerEvent.kind === 'text' && providerEvent.text) {
            observed.push(providerEvent.text)
          }
        },
      })
      assert.deepEqual(observed, ['Hel', 'lo ', 'world'])
      assert.equal(result.text, 'Hello, world! (revised)')
    })
  } finally {
    restore()
  }
})

test('openai: reasoning and refusal deltas never reach the display stream', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () =>
    sseResponse([
      event('response.created', { response: { id: 'resp_1' } }),
      event('response.reasoning_summary_text.delta', { delta: 'let me think' }),
      event('response.output_text.delta', { delta: 'Hello world' }),
      event('response.function_call_arguments.delta', { delta: '{"a":1}' }),
      event('response.output_text.done', { text: 'Hello world' }),
      completed(),
    ]),
  )
  const observed: string[] = []
  try {
    await withKey(async () => {
      await createOpenAIProvider().execute({
        ...BASE,
        onProtocolEvent: (providerEvent) => {
          if (providerEvent.kind === 'text' && providerEvent.text) {
            observed.push(providerEvent.text)
          }
        },
      })
      assert.deepEqual(observed, ['Hello world'])
    })
  } finally {
    restore()
  }
})

for (const reason of ['max_output_tokens', 'max_tokens']) {
  test(`openai: a stream ending incomplete for ${reason} is a typed truncation`, async () => {
    const captured: CapturedRequest[] = []
    const restore = stubFetch(captured, () =>
      sseResponse([...TEXT_DELTAS, incomplete(reason)]),
    )
    try {
      await withKey(async () => {
        await assert.rejects(
          createOpenAIProvider().execute(BASE),
          (error: unknown) => {
            assert.ok(error instanceof ProviderError)
            assert.equal(error.code, PROVIDER_TRUNCATED_CODE)
            return true
          },
        )
      })
    } finally {
      restore()
    }
  })
}

test('openai: a response.failed terminal event fails the turn', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () =>
    sseResponse([
      ...TEXT_DELTAS,
      event('response.failed', {
        response: {
          id: 'resp_1',
          status: 'failed',
          error: { code: 'server_error', message: 'the model gave up' },
        },
      }),
    ]),
  )
  try {
    await withKey(async () => {
      await assert.rejects(createOpenAIProvider().execute(BASE), (error: unknown) => {
        assert.ok(error instanceof ProviderError)
        assert.match(error.message, /the model gave up/)
        return true
      })
    })
  } finally {
    restore()
  }
})

test('openai: a stream-level error event fails the turn', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () =>
    sseResponse([
      ...TEXT_DELTAS,
      event('error', { code: 'server_error', message: 'upstream exploded' }),
    ]),
  )
  try {
    await withKey(async () => {
      await assert.rejects(createOpenAIProvider().execute(BASE), (error: unknown) => {
        assert.ok(error instanceof ProviderError)
        assert.match(error.message, /upstream exploded/)
        return true
      })
    })
  } finally {
    restore()
  }
})

test('openai: a stream with no terminal event fails instead of returning a prefix', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () => sseResponse(TEXT_DELTAS))
  try {
    await withKey(async () => {
      await assert.rejects(createOpenAIProvider().execute(BASE), (error: unknown) => {
        assert.ok(error instanceof ProviderError)
        assert.match(error.message, /incomplete/i)
        return true
      })
    })
  } finally {
    restore()
  }
})

test('openai: a frame whose payload cannot be parsed fails the turn', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () =>
    sseResponse([
      event('response.created', { response: { id: 'resp_1' } }),
      event('response.output_text.delta', { delta: 'Hel' }),
      // Answer text was in this frame and is now unrecoverable, so the reply
      // would silently be missing a piece if the stream carried on.
      'event: response.output_text.delta\ndata: {"type":"response.out\n\n',
      event('response.output_text.delta', { delta: 'lo' }),
      completed(),
    ]),
  )
  try {
    await withKey(async () => {
      await assert.rejects(createOpenAIProvider().execute(BASE), (error: unknown) => {
        assert.ok(error instanceof ProviderError)
        assert.match(error.message, /could not be parsed/i)
        return true
      })
    })
  } finally {
    restore()
  }
})

test('openai: an endpoint that ignores stream:true still returns its answer', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(
    captured,
    () =>
      new Response(
        JSON.stringify({
          model: 'gpt-5.4-mini',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: 'Hello world' }] },
          ],
          usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  )
  const observed: string[] = []
  try {
    await withKey(async () => {
      const result = await createOpenAIProvider().execute({
        ...BASE,
        onProtocolEvent: (providerEvent) => {
          if (providerEvent.kind === 'text' && providerEvent.text) {
            observed.push(providerEvent.text)
          }
        },
      })
      assert.equal(result.text, 'Hello world')
      assert.equal(result.inputTokens, 12)
      assert.deepEqual(observed, [])
    })
  } finally {
    restore()
  }
})

// ─── The JSON fallback is a boundary too ────────────────────────────────────

function jsonResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('openai: a JSON fallback body that is not valid JSON fails the turn', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () => jsonResponse('{"output": [ nope'))
  try {
    await withKey(async () => {
      await assert.rejects(createOpenAIProvider().execute(BASE), (error: unknown) => {
        assert.ok(error instanceof ProviderError)
        assert.match(error.message, /could not be read as JSON/i)
        return true
      })
    })
  } finally {
    restore()
  }
})

test('openai: a JSON fallback body that is not an object fails the turn', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () => jsonResponse('"just a string"'))
  try {
    await withKey(async () => {
      await assert.rejects(createOpenAIProvider().execute(BASE), (error: unknown) => {
        assert.ok(error instanceof ProviderError)
        assert.match(error.message, /could not be read as JSON/i)
        return true
      })
    })
  } finally {
    restore()
  }
})

test('openai: mis-shaped fields in a JSON fallback body are dropped, not coerced', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () =>
    jsonResponse(
      JSON.stringify({
        // Every field here has the wrong type except the one output item that
        // actually carries text. None of the rest may reach the result.
        model: 7,
        output_text: 42,
        output: [
          'not an item',
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Hello world' }, 'not a part'],
          },
        ],
        usage: { input_tokens: '12', output_tokens: null, total_tokens: {} },
      }),
    ),
  )
  try {
    await withKey(async () => {
      const result = await createOpenAIProvider().execute(BASE)
      assert.equal(result.text, 'Hello world')
      assert.equal(result.model, BASE.model, 'a numeric model is not a model')
      assert.equal(result.inputTokens, 0)
      assert.equal(result.outputTokens, 0)
      assert.equal(result.contextTokens, 0)
    })
  } finally {
    restore()
  }
})

test("openai: bounds the request with a timeout composed with the caller's signal", async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () =>
    sseResponse([...TEXT_DELTAS, completed()]),
  )
  try {
    await withKey(async () => {
      await createOpenAIProvider().execute(BASE)
      assert.ok(captured[0]?.signal instanceof AbortSignal)

      const controller = new AbortController()
      await createOpenAIProvider().execute({ ...BASE, signal: controller.signal })
      const composed = captured[1]?.signal
      assert.ok(composed instanceof AbortSignal)
      assert.equal(composed.aborted, false)
      controller.abort(new Error('caller cancelled'))
      assert.equal(composed.aborted, true)
    })
  } finally {
    restore()
  }
})
