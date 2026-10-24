import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeChatCompletionsUsage,
  readChatCompletionsErrorIdentity,
  readChatCompletionsStream,
} from '../../providers/chat-completions-stream.js'
import { ProviderError } from '../../domains/provider/provider-error.js'
import type { ProviderProtocolEvent } from '../../contracts/provider.js'

function sseBody(frames: readonly string[]): Response {
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

function delta(content: string): string {
  return chunk({
    model: 'vendor/model',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })
}

/** The terminal chunk every well-formed stream has to carry. */
function finish(reason = 'stop', extra: Record<string, unknown> = {}): string {
  return chunk({
    model: 'vendor/model',
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    ...extra,
  })
}

const DONE = 'data: [DONE]\n\n'

test('accumulates deltas and emits one ordered text event per delta', async () => {
  const observed: string[] = []
  const result = await readChatCompletionsStream({
    response: sseBody([delta('Hel'), delta('lo '), delta('world'), finish(), DONE]),
    provider: 'openrouter',
    fallbackModel: 'requested/model',
    onProtocolEvent: (event: ProviderProtocolEvent) => {
      if (event.kind === 'text' && event.text) observed.push(event.text)
    },
  })

  assert.deepEqual(observed, ['Hel', 'lo ', 'world'])
  assert.equal(result.text, 'Hello world')
})

test('rebuilds a body the non-streaming rules can inspect unchanged', async () => {
  const result = await readChatCompletionsStream({
    response: sseBody([
      delta('answer'),
      finish('stop', {
        usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
      }),
      DONE,
    ]),
    provider: 'openrouter',
    fallbackModel: 'requested/model',
  })

  // The same shape the JSON path produces, so truncation, text extraction,
  // usage and cost all keep running on one representation.
  assert.equal(result.body.model, 'vendor/model')
  assert.equal(result.body.choices?.[0]?.message?.content, 'answer')
  assert.equal(result.body.choices?.[0]?.finish_reason, 'stop')
  assert.equal(result.body.usage?.prompt_tokens, 11)
  assert.equal(result.body.usage?.completion_tokens, 2)
  assert.equal(result.body.usage?.total_tokens, 13)
})

test('carries a length finish_reason through so truncation is still detected', async () => {
  const result = await readChatCompletionsStream({
    response: sseBody([delta('half an ans'), finish('length'), DONE]),
    provider: 'deepseek',
    fallbackModel: 'requested/model',
  })

  assert.equal(result.body.choices?.[0]?.finish_reason, 'length')
})

test('falls back to the requested model when no chunk names one', async () => {
  const result = await readChatCompletionsStream({
    response: sseBody([
      chunk({ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }] }),
      DONE,
    ]),
    provider: 'xai',
    fallbackModel: 'requested/model',
  })
  assert.equal(result.body.model, 'requested/model')
})

test('stops at [DONE] and ignores anything written after it', async () => {
  const observed: string[] = []
  const result = await readChatCompletionsStream({
    response: sseBody([delta('before'), finish(), DONE, delta(' after')]),
    provider: 'openrouter',
    fallbackModel: 'requested/model',
    onProtocolEvent: (event: ProviderProtocolEvent) => {
      if (event.kind === 'text' && event.text) observed.push(event.text)
    },
  })

  assert.deepEqual(observed, ['before'])
  assert.equal(result.text, 'before')
})

test('ignores a non-string content field rather than trusting it', async () => {
  const result = await readChatCompletionsStream({
    response: sseBody([
      chunk({ choices: [{ index: 0, delta: { content: { evil: true } } }] }),
      delta('clean'),
      finish(),
      DONE,
    ]),
    provider: 'openrouter',
    fallbackModel: 'requested/model',
  })
  assert.equal(result.text, 'clean')
})

test('rejects a response with no body rather than returning empty text', async () => {
  await assert.rejects(
    readChatCompletionsStream({
      response: new Response(null, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
      provider: 'openrouter',
      fallbackModel: 'requested/model',
    }),
  )
})

// ─── Incompleteness must be loud ────────────────────────────────────────────
//
// Every case below used to return quietly: a half-received answer came back
// looking exactly like a whole one, which is the single failure mode a display
// stream makes most dangerous — the user has already read the partial text.

test('rejects a data frame whose JSON is malformed rather than losing answer text', async () => {
  await assert.rejects(
    readChatCompletionsStream({
      response: sseBody(['data: {not json\n\n', delta('survived'), finish(), DONE]),
      provider: 'openrouter',
      fallbackModel: 'requested/model',
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.match(error.message, /could not be parsed|malformed/i)
      return true
    },
  )
})

test('rejects a stream that ends before its terminal chunk', async () => {
  await assert.rejects(
    readChatCompletionsStream({
      response: sseBody([delta('half an ans')]),
      provider: 'deepseek',
      fallbackModel: 'requested/model',
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.match(error.message, /ended before/i)
      return true
    },
  )
})

test('rejects a stream that reaches [DONE] with no finish_reason anywhere', async () => {
  await assert.rejects(
    readChatCompletionsStream({
      response: sseBody([delta('half an ans'), DONE]),
      provider: 'kimi',
      fallbackModel: 'requested/model',
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.match(error.message, /ended before/i)
      return true
    },
  )
})

test('rejects a stream that ends mid-frame', async () => {
  await assert.rejects(
    readChatCompletionsStream({
      response: sseBody([delta('half'), 'data: {"choices":[{"delta":{"con']),
      provider: 'xai',
      fallbackModel: 'requested/model',
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.match(error.message, /ended before/i)
      return true
    },
  )
})

test('rejects a stream that ends cleanly after its terminal chunk but never sends [DONE]', async () => {
  // The most deceptive shape of all: a well-formed finish_reason, a clean
  // socket close, and no dangling bytes to give it away. Chat Completions
  // documents `[DONE]` as the terminator, so its absence is the only evidence
  // that the endpoint had more to send — a trailing usage chunk at minimum.
  await assert.rejects(
    readChatCompletionsStream({
      response: sseBody([delta('whole answer'), finish()]),
      provider: 'openrouter',
      fallbackModel: 'requested/model',
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.match(error.message, /\[DONE\]/)
      return true
    },
  )
})

test('rejects a stream cut off mid-frame after its terminal chunk', async () => {
  // The answer itself finished, so the premature-EOF check above is satisfied.
  // What is lost here is the trailing usage chunk, and a half-written frame is
  // the evidence that the connection dropped rather than closed.
  await assert.rejects(
    readChatCompletionsStream({
      response: sseBody([
        delta('whole answer'),
        finish(),
        'data: {"choices":[],"usage":{"prompt_to',
      ]),
      provider: 'openrouter',
      fallbackModel: 'requested/model',
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.match(error.message, /ended before the frame/i)
      return true
    },
  )
})

test('throws on a streamed error frame and never returns the partial text', async () => {
  const observed: string[] = []
  await assert.rejects(
    readChatCompletionsStream({
      response: sseBody([
        delta('partial'),
        chunk({ error: { message: 'upstream exploded', type: 'server_error' } }),
      ]),
      provider: 'kimi',
      fallbackModel: 'requested/model',
      onProtocolEvent: (event: ProviderProtocolEvent) => {
        if (event.kind === 'text' && event.text) observed.push(event.text)
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.match(error.message, /upstream exploded/)
      return true
    },
  )
  // The delta was displayed before the failure arrived; what must not happen is
  // that same text coming back as a finished answer.
  assert.deepEqual(observed, ['partial'])
})

// ─── Terminal usage ─────────────────────────────────────────────────────────

test('keeps usage from a trailing usage-only chunk that carries no choices', async () => {
  const result = await readChatCompletionsStream({
    response: sseBody([
      delta('answer'),
      finish(),
      // The shape `stream_options: { include_usage: true }` produces: usage
      // arrives after the finish_reason, in a chunk with an empty choices array.
      chunk({
        choices: [],
        usage: { prompt_tokens: 31, completion_tokens: 4, total_tokens: 35 },
      }),
      DONE,
    ]),
    provider: 'deepseek',
    fallbackModel: 'requested/model',
  })

  assert.equal(result.body.usage?.prompt_tokens, 31)
  assert.equal(result.body.usage?.completion_tokens, 4)
  assert.equal(result.body.usage?.total_tokens, 35)
  assert.equal(result.body.choices?.[0]?.finish_reason, 'stop')
})

test('keeps an OpenRouter reported cost from the terminal usage chunk', async () => {
  const result = await readChatCompletionsStream({
    response: sseBody([
      delta('answer'),
      finish(),
      chunk({
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
          cost: 0.000123,
        },
      }),
      DONE,
    ]),
    provider: 'openrouter',
    fallbackModel: 'requested/model',
  })

  assert.equal(result.body.usage?.cost, 0.000123)
})

test('ignores frames that carry no data line, such as comments and pings', async () => {
  const result = await readChatCompletionsStream({
    response: sseBody([
      ': OPENROUTER PROCESSING\n\n',
      'event: ping\n\n',
      delta('answer'),
      finish(),
      DONE,
    ]),
    provider: 'openrouter',
    fallbackModel: 'requested/model',
  })
  assert.equal(result.text, 'answer')
})

/**
 * Usage normalization: what a provider reported, only when it is believable.
 *
 * A token count is kept in a durable record and used to price a turn, so the
 * question is not "what did the provider send" but "what can be vouched for".
 * A negative count, a fractional one, a missing half, and a stated total that
 * disagrees with its own parts are all unusable — and an omitted usage record
 * is a better answer than an invented one, because an operator can see that
 * nothing was reported and a fabricated number looks exactly like a real one.
 */
test('reported chat-completions usage is normalized to validated token counts', () => {
  assert.deepEqual(
    normalizeChatCompletionsUsage({
      prompt_tokens: 12,
      completion_tokens: 30,
      total_tokens: 42,
    }),
    { inputTokens: 12, outputTokens: 30, totalTokens: 42 },
  )
})

test('a chat-completions total that disagrees with its parts omits usage entirely', () => {
  assert.equal(
    normalizeChatCompletionsUsage({
      prompt_tokens: 12,
      completion_tokens: 30,
      // Providers do this when a cached-token count is folded into one side and
      // not the other. Keeping both halves of a contradiction is worse than
      // keeping neither.
      total_tokens: 99,
    }),
    undefined,
  )
})

test('a chat-completions total the provider did not state is the sum of its parts', () => {
  assert.deepEqual(
    normalizeChatCompletionsUsage({ prompt_tokens: 4, completion_tokens: 6 }),
    { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
  )
})

test('chat-completions usage that is negative, fractional, or half-reported is omitted', () => {
  assert.equal(
    normalizeChatCompletionsUsage({ prompt_tokens: -1, completion_tokens: 5 }),
    undefined,
  )
  assert.equal(
    normalizeChatCompletionsUsage({ prompt_tokens: 1.5, completion_tokens: 5 }),
    undefined,
  )
  assert.equal(normalizeChatCompletionsUsage({ completion_tokens: 5 }), undefined)
  assert.equal(normalizeChatCompletionsUsage(undefined), undefined)
})

/**
 * A non-success response is external input in the same way a body is. What a
 * durable record may keep from it is a short code, and only when it really is
 * one: the message beside it is prose, and a provider is free to put anything
 * in either field.
 */
test('a chat-completions error body yields a bounded code and never its message', () => {
  assert.deepEqual(
    readChatCompletionsErrorIdentity(
      JSON.stringify({
        error: {
          message: 'you are sending requests too quickly, slow down please',
          type: 'rate_limit_error',
          code: 'rate_limit_exceeded',
        },
      }),
    ),
    { providerCode: 'rate_limit_exceeded' },
  )
})

test('a chat-completions error that names only a type falls back to the type', () => {
  assert.deepEqual(
    readChatCompletionsErrorIdentity(
      JSON.stringify({ error: { message: 'nope', type: 'invalid_request_error' } }),
    ),
    { providerCode: 'invalid_request_error' },
  )
})

test('a chat-completions error code that is really prose is dropped', () => {
  assert.deepEqual(
    readChatCompletionsErrorIdentity(
      JSON.stringify({
        error: { code: 'the model refused because the prompt said secret-value' },
      }),
    ),
    {},
  )
  assert.deepEqual(readChatCompletionsErrorIdentity('<html>502 Bad Gateway</html>'), {})
  assert.deepEqual(readChatCompletionsErrorIdentity(''), {})
})
