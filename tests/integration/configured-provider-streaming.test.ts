import assert from 'node:assert/strict'
import test from 'node:test'
import * as http from 'node:http'

import { getProvider } from '../../providers/index.js'
import { ProviderError } from '../../domains/provider/provider-error.js'
import { PROVIDER_TRUNCATED_CODE } from '../../domains/provider/provider-truncation.js'
import { initProviders } from '../../providers/index.js'
import { setConfiguredProviderConnections } from '../../providers/configured-provider.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import type { ProviderProtocolEvent } from '../../contracts/provider.js'

initProviders()

/**
 * The reachable path.
 *
 * The chat model catalog is built from CLI agents and configured connections
 * only, and a connection resolves to `connection:<id>` — the OpenAI-compatible
 * transport. So this, not the built-in `lm-studio` provider, is what a user can
 * actually select, and therefore what has to stream for the feature to be
 * visible at all.
 */
async function withConfiguredConnection(
  run: (providerName: string) => Promise<void>,
  options: {
    deltas?: readonly string[]
    failStatus?: number
  } = {},
): Promise<void> {
  const server = await startFakeChatCompletionsServer({
    script: [
      {
        deltas: options.deltas ?? ['Hel', 'lo ', 'world'],
        ...(options.failStatus === undefined ? {} : { failStatus: options.failStatus }),
      },
    ],
  })
  const previousBroker = process.env.PIPELINE_CONFIGURED_PROVIDER_BROKER_URL
  delete process.env.PIPELINE_CONFIGURED_PROVIDER_BROKER_URL

  const connectionId = '11111111-2222-3333-4444-555555555555'
  setConfiguredProviderConnections([
    {
      id: connectionId,
      kind: 'openai-compatible',
      name: 'Fake streaming provider',
      baseUrl: `${server.url}/v1`,
      apiKey: 'fake-key',
    },
  ])

  try {
    await run(`connection:${connectionId}`)
  } finally {
    setConfiguredProviderConnections([])
    if (previousBroker !== undefined) {
      process.env.PIPELINE_CONFIGURED_PROVIDER_BROKER_URL = previousBroker
    }
    await server.close()
  }
}

test('an endpoint that ignores stream:true still returns its answer', async () => {
  await withLegacyJsonConnection(
    async (providerName) => {
      const observed: string[] = []
      const result = await getProvider(providerName).execute({
        systemPrompt: 'system',
        userMessage: 'user',
        model: 'fake/model',
        thinking: 'low',
        onProtocolEvent: (event) => {
          if (event.kind === 'text' && event.text) observed.push(event.text)
        },
      })

      assert.equal(
        result.text,
        'Hello world',
        'a non-streaming OpenAI-compatible endpoint keeps working',
      )
      assert.equal(result.inputTokens, 7)
      assert.deepEqual(
        observed,
        [],
        'and emits no text events, because nothing arrived incrementally',
      )
    },
  )
})

test('a configured connection emits ordered text events before the promise resolves', async () => {
  await withConfiguredConnection(async (providerName) => {
    const observed: string[] = []
    let settled = false

    const result = await getProvider(providerName).execute({
      systemPrompt: 'system',
      userMessage: 'user',
      model: 'fake/model',
      thinking: 'low',
      onProtocolEvent: (event: ProviderProtocolEvent) => {
        assert.equal(settled, false, 'events arrive while the turn is running')
        if (event.kind === 'text' && event.text) observed.push(event.text)
      },
    })
    settled = true

    assert.deepEqual(
      observed,
      ['Hel', 'lo ', 'world'],
      'one ordered event per upstream delta, each carrying only its suffix',
    )
    assert.equal(result.text, 'Hello world')
  })
})

test('nothing after [DONE] is processed', async () => {
  const server = await startTrailingChunkServer()
  const previousBroker = process.env.PIPELINE_CONFIGURED_PROVIDER_BROKER_URL
  delete process.env.PIPELINE_CONFIGURED_PROVIDER_BROKER_URL
  const connectionId = '33333333-4444-5555-6666-777777777777'
  setConfiguredProviderConnections([
    {
      id: connectionId,
      kind: 'openai-compatible',
      name: 'Trailing chunk provider',
      baseUrl: `${server.url}/v1`,
      apiKey: 'fake-key',
    },
  ])

  try {
    const observed: string[] = []
    const result = await getProvider(`connection:${connectionId}`).execute({
      systemPrompt: 'system',
      userMessage: 'user',
      model: 'fake/model',
      thinking: 'low',
      onProtocolEvent: (event) => {
        if (event.kind === 'text' && event.text) observed.push(event.text)
      },
    })

    // `[DONE]` is the documented terminator. A chunk after it is not part of
    // the answer, and treating it as one would append text the provider
    // already declared finished.
    assert.deepEqual(observed, ['before'])
    assert.equal(result.text, 'before')
  } finally {
    setConfiguredProviderConnections([])
    if (previousBroker !== undefined) {
      process.env.PIPELINE_CONFIGURED_PROVIDER_BROKER_URL = previousBroker
    }
    await server.close()
  }
})

/** Streams a delta, then `[DONE]`, then a further delta that must be ignored. */
async function startTrailingChunkServer(): Promise<{
  url: string
  close: () => Promise<void>
}> {
  const chunk = (content: string): string =>
    `data: ${JSON.stringify({
      model: 'fake/model',
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })}\n\n`

  const server = http.createServer((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    res.write(chunk('before'))
    res.write(
      `data: ${JSON.stringify({
        model: 'fake/model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`,
    )
    res.write('data: [DONE]\n\n')
    res.write(chunk(' after'))
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('bind failed')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

test('a configured connection reports usage from the terminal chunk', async () => {
  await withConfiguredConnection(async (providerName) => {
    const result = await getProvider(providerName).execute({
      systemPrompt: 'system',
      userMessage: 'user',
      model: 'fake/model',
      thinking: 'low',
    })
    assert.equal(result.inputTokens, 7)
    assert.equal(result.outputTokens, 3)
    assert.equal(result.model, 'fake/model')
  })
})

test('a configured connection with no observer behaves exactly as before', async () => {
  await withConfiguredConnection(async (providerName) => {
    const result = await getProvider(providerName).execute({
      systemPrompt: 'system',
      userMessage: 'user',
      model: 'fake/model',
      thinking: 'low',
    })
    assert.equal(result.text, 'Hello world')
  })
})

test('an upstream failure is still a typed provider error, not a partial answer', async () => {
  await withConfiguredConnection(
    async (providerName) => {
      const observed: string[] = []
      await assert.rejects(
        getProvider(providerName).execute({
          systemPrompt: 'system',
          userMessage: 'user',
          model: 'fake/model',
          thinking: 'low',
          onProtocolEvent: (event) => {
            if (event.kind === 'text' && event.text) observed.push(event.text)
          },
        }),
      )
      assert.deepEqual(observed, [], 'a failed request emits no text')
    },
    { failStatus: 502 },
  )
})

/**
 * A server that always answers with JSON, whatever the request asked for —
 * an OpenAI-compatible endpoint that does not implement streaming.
 */
async function withLegacyJsonConnection(
  run: (providerName: string) => Promise<void>,
): Promise<void> {
  const server = await startLegacyJsonServer('Hello world')
  const previousBroker = process.env.PIPELINE_CONFIGURED_PROVIDER_BROKER_URL
  delete process.env.PIPELINE_CONFIGURED_PROVIDER_BROKER_URL
  const connectionId = '22222222-3333-4444-5555-666666666666'
  setConfiguredProviderConnections([
    {
      id: connectionId,
      kind: 'openai-compatible',
      name: 'Legacy provider',
      baseUrl: `${server.url}/v1`,
      apiKey: 'fake-key',
    },
  ])
  try {
    await run(`connection:${connectionId}`)
  } finally {
    setConfiguredProviderConnections([])
    if (previousBroker !== undefined) {
      process.env.PIPELINE_CONFIGURED_PROVIDER_BROKER_URL = previousBroker
    }
    await server.close()
  }
}

async function startLegacyJsonServer(
  content: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        model: 'fake/model',
        choices: [
          { message: { role: 'assistant', content }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('bind failed')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

// ─── An incomplete stream on the reachable path ─────────────────────────────
//
// This is the only provider a user can select, so it is the one where a short
// answer returned as a whole one would actually be read by someone.

/** A server that writes exactly the frames given, then closes. */
async function startRawStreamServer(
  frames: readonly string[],
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    for (const frame of frames) res.write(frame)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('bind failed')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

async function withRawStream(
  frames: readonly string[],
  run: (providerName: string) => Promise<void>,
): Promise<void> {
  const server = await startRawStreamServer(frames)
  const previousBroker = process.env.PIPELINE_CONFIGURED_PROVIDER_BROKER_URL
  delete process.env.PIPELINE_CONFIGURED_PROVIDER_BROKER_URL
  const connectionId = '99999999-8888-7777-6666-555555555555'
  setConfiguredProviderConnections([
    {
      id: connectionId,
      kind: 'openai-compatible',
      name: 'Fake streaming provider',
      baseUrl: `${server.url}/v1`,
      apiKey: 'fake-key',
    },
  ])
  try {
    await run(`connection:${connectionId}`)
  } finally {
    setConfiguredProviderConnections([])
    if (previousBroker !== undefined) {
      process.env.PIPELINE_CONFIGURED_PROVIDER_BROKER_URL = previousBroker
    }
    await server.close()
  }
}

function deltaFrame(content: string): string {
  return `data: ${JSON.stringify({
    model: 'fake/model',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`
}

function finishFrame(reason: string): string {
  return `data: ${JSON.stringify({
    model: 'fake/model',
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
  })}\n\n`
}

const EXECUTE_BASE = {
  systemPrompt: 'system',
  userMessage: 'user',
  model: 'fake/model',
  thinking: 'low',
} as const

test('a configured connection cut short fails instead of returning a prefix', async () => {
  await withRawStream([deltaFrame('half an ans')], async (providerName) => {
    await assert.rejects(
      getProvider(providerName).execute(EXECUTE_BASE),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError)
        assert.match(error.message, /incomplete/i)
        return true
      },
    )
  })
})

test('a configured connection frame that cannot be parsed fails the turn', async () => {
  await withRawStream(
    [deltaFrame('Hel'), 'data: {"choices":[{"delta":{"con\n\n', deltaFrame('lo'), finishFrame('stop'), 'data: [DONE]\n\n'],
    async (providerName) => {
      await assert.rejects(
        getProvider(providerName).execute(EXECUTE_BASE),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError)
          assert.match(error.message, /could not be parsed/i)
          return true
        },
      )
    },
  )
})

test('a configured connection HTTP-200 error frame fails instead of returning the partial text', async () => {
  await withRawStream(
    [
      deltaFrame('partial'),
      `data: ${JSON.stringify({ error: { message: 'upstream exploded', type: 'server_error' } })}\n\n`,
    ],
    async (providerName) => {
      await assert.rejects(
        getProvider(providerName).execute(EXECUTE_BASE),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError)
          assert.match(error.message, /upstream exploded/)
          return true
        },
      )
    },
  )
})

test('a configured connection that hit its token limit is a typed truncation', async () => {
  await withRawStream(
    [deltaFrame('half an ans'), finishFrame('length'), 'data: [DONE]\n\n'],
    async (providerName) => {
      await assert.rejects(
        getProvider(providerName).execute(EXECUTE_BASE),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError)
          assert.equal(error.code, PROVIDER_TRUNCATED_CODE)
          return true
        },
      )
    },
  )
})

// ─── What the convergence onto the shared reader has to keep ────────────────

/** Drive the configured provider against a stubbed fetch, capturing signals. */
async function withStubbedFetch(
  respond: () => Response,
  run: (providerName: string, signals: Array<AbortSignal | undefined>) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch
  const previousBroker = process.env.PIPELINE_CONFIGURED_PROVIDER_BROKER_URL
  delete process.env.PIPELINE_CONFIGURED_PROVIDER_BROKER_URL
  const signals: Array<AbortSignal | undefined> = []
  const fake = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    signals.push(init?.signal ?? undefined)
    return respond()
  }
  globalThis.fetch = fake as unknown as typeof globalThis.fetch

  const connectionId = '44444444-3333-2222-1111-000000000000'
  setConfiguredProviderConnections([
    {
      id: connectionId,
      kind: 'openai-compatible',
      name: 'Fake streaming provider',
      baseUrl: 'https://fake.invalid/v1',
      apiKey: 'fake-key',
    },
  ])
  try {
    await run(`connection:${connectionId}`, signals)
  } finally {
    globalThis.fetch = originalFetch
    setConfiguredProviderConnections([])
    if (previousBroker !== undefined) {
      process.env.PIPELINE_CONFIGURED_PROVIDER_BROKER_URL = previousBroker
    }
  }
}

function streamResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

const WHOLE_STREAM = [
  deltaFrame('ok'),
  finishFrame('stop'),
  'data: [DONE]\n\n',
]

test("a configured connection bounds its request with a timeout composed with the caller's signal", async () => {
  await withStubbedFetch(
    () => streamResponse(WHOLE_STREAM),
    async (providerName, signals) => {
      await getProvider(providerName).execute(EXECUTE_BASE)
      assert.ok(
        signals[0] instanceof AbortSignal,
        'a timeout signal is attached even with no caller signal',
      )

      const controller = new AbortController()
      await getProvider(providerName).execute({
        ...EXECUTE_BASE,
        signal: controller.signal,
      })
      const composed = signals[1]
      assert.ok(composed instanceof AbortSignal)
      assert.equal(composed.aborted, false)
      controller.abort(new Error('caller cancelled'))
      assert.equal(
        composed.aborted,
        true,
        "the caller's abort still reaches the request",
      )
    },
  )
})

test('a configured connection JSON body that is not valid JSON fails the turn', async () => {
  await withStubbedFetch(
    () =>
      new Response('{"choices": [ nope', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    async (providerName) => {
      await assert.rejects(
        getProvider(providerName).execute(EXECUTE_BASE),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError)
          assert.match(error.message, /could not be read as JSON/i)
          return true
        },
      )
    },
  )
})

test('mis-shaped fields in a configured connection JSON body are dropped, not coerced', async () => {
  await withStubbedFetch(
    () =>
      new Response(
        JSON.stringify({
          model: 7,
          choices: [
            { message: { content: 'Hello world' }, finish_reason: 'stop' },
            'not a choice',
          ],
          usage: { prompt_tokens: '12', completion_tokens: null },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    async (providerName) => {
      const result = await getProvider(providerName).execute(EXECUTE_BASE)
      assert.equal(result.text, 'Hello world')
      assert.equal(result.model, EXECUTE_BASE.model, 'a numeric model is not a model')
      assert.equal(result.inputTokens, 0)
      assert.equal(result.outputTokens, 0)
    },
  )
})
