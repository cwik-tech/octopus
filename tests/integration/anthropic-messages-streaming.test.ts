import test from 'node:test'
import assert from 'node:assert/strict'

import { createAnthropicProvider } from '../../providers/anthropic.js'
import {
  normalizeAnthropicMessagesUsage,
  readAnthropicMessagesErrorIdentity,
} from '../../providers/messages-stream.js'
import { ProviderError } from '../../domains/provider/provider-error.js'
import { PROVIDER_TRUNCATED_CODE } from '../../domains/provider/provider-truncation.js'
import type { ProviderProtocolEvent } from '../../providers/types.js'

/**
 * Anthropic speaks the Messages API, whose stream differs from the other two in
 * ways that matter for a display channel. Text is one of several delta kinds on
 * the same event, so thinking, tool input and signatures have to be excluded by
 * name rather than by position. Usage arrives twice — input at the start, a
 * cumulative output count at the end — and has to be merged. And the run is
 * only over when a `stop_reason` and a `message_stop` have both arrived.
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
  const previous = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'test-key'
  return run().finally(() => {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previous
  })
}

const MESSAGE_START = event('message_start', {
  message: {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content: [],
    stop_reason: null,
    usage: {
      input_tokens: 12,
      output_tokens: 1,
      cache_creation_input_tokens: 4,
      cache_read_input_tokens: 2,
    },
  },
})

const TEXT_DELTAS = [
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  event('ping', {}),
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'lo ' } }),
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'world' } }),
  event('content_block_stop', { index: 0 }),
]

function messageDelta(stopReason: string, outputTokens = 3): string {
  return event('message_delta', {
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  })
}

const MESSAGE_STOP = event('message_stop', {})

const BASE = {
  systemPrompt: 'system',
  userMessage: 'user',
  model: 'claude-sonnet-4-5',
  thinking: 'low',
} as const

test('anthropic: requests a stream and emits ordered text events', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () =>
    sseResponse([MESSAGE_START, ...TEXT_DELTAS, messageDelta('end_turn'), MESSAGE_STOP]),
  )
  const observed: string[] = []
  let settled = false
  try {
    await withKey(async () => {
      const result = await createAnthropicProvider().execute({
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

test('anthropic: thinking, tool input and signature deltas are excluded from the answer', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () =>
    sseResponse([
      MESSAGE_START,
      event('content_block_start', {
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      }),
      event('content_block_delta', {
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'privately reasoning' },
      }),
      event('content_block_delta', {
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig-abc' },
      }),
      event('content_block_stop', { index: 0 }),
      event('content_block_start', {
        index: 1,
        content_block: { type: 'tool_use', id: 't1', name: 'search', input: {} },
      }),
      event('content_block_delta', {
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' },
      }),
      event('content_block_stop', { index: 1 }),
      event('content_block_start', { index: 2, content_block: { type: 'text', text: '' } }),
      event('content_block_delta', {
        index: 2,
        delta: { type: 'text_delta', text: 'the answer' },
      }),
      event('content_block_stop', { index: 2 }),
      messageDelta('end_turn'),
      MESSAGE_STOP,
    ]),
  )
  const observed: string[] = []
  try {
    await withKey(async () => {
      const result = await createAnthropicProvider().execute({
        ...BASE,
        onProtocolEvent: (providerEvent) => {
          if (providerEvent.kind === 'text' && providerEvent.text) {
            observed.push(providerEvent.text)
          }
        },
      })
      assert.deepEqual(observed, ['the answer'])
      assert.equal(result.text, 'the answer')
    })
  } finally {
    restore()
  }
})

test('anthropic: merges message_start usage with the cumulative message_delta count', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () =>
    sseResponse([
      MESSAGE_START,
      ...TEXT_DELTAS,
      // Anthropic reports output tokens cumulatively, so the last count wins
      // rather than being added to the earlier one.
      messageDelta('end_turn', 2),
      messageDelta('end_turn', 9),
      MESSAGE_STOP,
    ]),
  )
  try {
    await withKey(async () => {
      const result = await createAnthropicProvider().execute(BASE)
      assert.equal(result.model, 'claude-sonnet-4-5')
      assert.equal(result.inputTokens, 12)
      assert.equal(result.outputTokens, 9)
      // input + output + cache creation + cache reads, as the JSON path counts.
      assert.equal(result.contextTokens, 12 + 9 + 4 + 2)
    })
  } finally {
    restore()
  }
})

test('anthropic: a stop_reason of max_tokens is a typed truncation', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () =>
    sseResponse([MESSAGE_START, ...TEXT_DELTAS, messageDelta('max_tokens'), MESSAGE_STOP]),
  )
  try {
    await withKey(async () => {
      await assert.rejects(
        createAnthropicProvider().execute(BASE),
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

test('anthropic: a midstream error event fails the turn instead of returning the partial text', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () =>
    sseResponse([
      MESSAGE_START,
      ...TEXT_DELTAS,
      event('error', {
        error: { type: 'overloaded_error', message: 'the service is overloaded' },
      }),
    ]),
  )
  try {
    await withKey(async () => {
      await assert.rejects(
        createAnthropicProvider().execute(BASE),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError)
          assert.match(error.message, /the service is overloaded/)
          return true
        },
      )
    })
  } finally {
    restore()
  }
})

test('anthropic: a stream ending without message_stop fails instead of returning a prefix', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () =>
    sseResponse([MESSAGE_START, ...TEXT_DELTAS, messageDelta('end_turn')]),
  )
  try {
    await withKey(async () => {
      await assert.rejects(
        createAnthropicProvider().execute(BASE),
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

test('anthropic: a message_stop with no stop_reason fails instead of returning a prefix', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () =>
    sseResponse([MESSAGE_START, ...TEXT_DELTAS, MESSAGE_STOP]),
  )
  try {
    await withKey(async () => {
      await assert.rejects(
        createAnthropicProvider().execute(BASE),
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

test('anthropic: unknown event types are ignored rather than failing the turn', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () =>
    sseResponse([
      MESSAGE_START,
      event('some_future_event', { anything: true }),
      ': keep-alive\n\n',
      ...TEXT_DELTAS,
      messageDelta('end_turn'),
      MESSAGE_STOP,
    ]),
  )
  try {
    await withKey(async () => {
      const result = await createAnthropicProvider().execute(BASE)
      assert.equal(result.text, 'Hello world')
    })
  } finally {
    restore()
  }
})

test('anthropic: a frame whose payload cannot be parsed fails the turn', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () =>
    sseResponse([
      MESSAGE_START,
      'event: content_block_delta\ndata: {"type":"content_block_de\n\n',
      ...TEXT_DELTAS,
      messageDelta('end_turn'),
      MESSAGE_STOP,
    ]),
  )
  try {
    await withKey(async () => {
      await assert.rejects(
        createAnthropicProvider().execute(BASE),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError)
          assert.match(error.message, /could not be parsed/i)
          return true
        },
      )
    })
  } finally {
    restore()
  }
})

test('anthropic: an endpoint that ignores stream:true still returns its answer', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(
    captured,
    () =>
      new Response(
        JSON.stringify({
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'Hello world' }],
          usage: { input_tokens: 12, output_tokens: 3 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  )
  const observed: string[] = []
  try {
    await withKey(async () => {
      const result = await createAnthropicProvider().execute({
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

test('anthropic: a JSON fallback body that is not valid JSON fails the turn', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () => jsonResponse('{"content": [ nope'))
  try {
    await withKey(async () => {
      await assert.rejects(
        createAnthropicProvider().execute(BASE),
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

test('anthropic: a JSON fallback body that is not an object fails the turn', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () => jsonResponse('[1, 2, 3]'))
  try {
    await withKey(async () => {
      await assert.rejects(
        createAnthropicProvider().execute(BASE),
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

test('anthropic: a JSON fallback body carrying only non-text blocks fails the turn', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () =>
    jsonResponse(
      JSON.stringify({
        model: 'claude-sonnet-4-5',
        // Thinking is not the answer, and a tool_use block is not prose. The
        // JSON path excludes them by block type exactly as the stream excludes
        // them by delta type.
        content: [
          { type: 'thinking', thinking: 'privately reasoning' },
          { type: 'tool_use', id: 't1', name: 'search', input: {} },
          // Carries `text`, but redacted thinking is not the answer. Selecting
          // blocks by presence of `text` rather than by `type` would put this
          // in the transcript as the model's reply.
          { type: 'redacted_thinking', text: 'internal reasoning' },
        ],
        usage: { input_tokens: 12, output_tokens: 3 },
      }),
    ),
  )
  try {
    await withKey(async () => {
      await assert.rejects(
        createAnthropicProvider().execute(BASE),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError)
          assert.match(error.message, /no text content/i)
          return true
        },
      )
    })
  } finally {
    restore()
  }
})

test('anthropic: mis-shaped fields in a JSON fallback body are dropped, not coerced', async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () =>
    jsonResponse(
      JSON.stringify({
        model: 7,
        content: [{ type: 'text', text: 'Hello world' }, 'not a block'],
        usage: {
          input_tokens: '12',
          output_tokens: null,
          cache_read_input_tokens: {},
        },
      }),
    ),
  )
  try {
    await withKey(async () => {
      const result = await createAnthropicProvider().execute(BASE)
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

test("anthropic: bounds the request with a timeout composed with the caller's signal", async () => {
  const captured: CapturedRequest[] = []
  const restore = stubFetch(captured, () =>
    sseResponse([MESSAGE_START, ...TEXT_DELTAS, messageDelta('end_turn'), MESSAGE_STOP]),
  )
  try {
    await withKey(async () => {
      await createAnthropicProvider().execute(BASE)
      assert.ok(captured[0]?.signal instanceof AbortSignal)

      const controller = new AbortController()
      await createAnthropicProvider().execute({ ...BASE, signal: controller.signal })
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

/**
 * The Messages protocol reports usage in its own vocabulary and never states a
 * total. Normalizing it here rather than at each call site is what lets one
 * durable usage record mean the same thing whichever provider produced it.
 */
test('anthropic: reported usage is normalized to validated token counts', () => {
  assert.deepEqual(
    normalizeAnthropicMessagesUsage({ input_tokens: 18, output_tokens: 4 }),
    { inputTokens: 18, outputTokens: 4, totalTokens: 22 },
  )
})

test('anthropic: usage that is negative, fractional, or half-reported is omitted', () => {
  assert.equal(
    normalizeAnthropicMessagesUsage({ input_tokens: -3, output_tokens: 4 }),
    undefined,
  )
  assert.equal(
    normalizeAnthropicMessagesUsage({ input_tokens: 3.5, output_tokens: 4 }),
    undefined,
  )
  assert.equal(normalizeAnthropicMessagesUsage({ output_tokens: 4 }), undefined)
  assert.equal(normalizeAnthropicMessagesUsage(undefined), undefined)
})

test('anthropic: an error body yields a bounded code and never its message', () => {
  assert.deepEqual(
    readAnthropicMessagesErrorIdentity(
      JSON.stringify({
        error: { type: 'overloaded_error', message: 'Overloaded, retry later' },
      }),
    ),
    { providerCode: 'overloaded_error' },
  )
  assert.deepEqual(
    readAnthropicMessagesErrorIdentity(
      JSON.stringify({ error: { message: 'a sentence, not a code' } }),
    ),
    {},
  )
  assert.deepEqual(readAnthropicMessagesErrorIdentity('upstream connect error'), {})
})
