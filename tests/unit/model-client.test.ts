import test from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'

import { callModel } from '../../domains/provider/model-client.js'
import type { ModelCallDiagnostics } from '../../contracts/model-diagnostics.js'
import { initProviders } from '../../providers/index.js'
import { registerProvider } from '../../providers/registry.js'
import type { ProviderExecuteOptions } from '../../providers/types.js'

test('OpenAI-compatible helper calls send images as visual user content', async () => {
  // The paid model is replaced only at its HTTP boundary.
  const loopback = await startModelServer({ choices: [{ message: { content: 'visible' } }] })
  const previousUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = loopback.url
  try {
    const result = await callModel('fixture', { provider: 'openai', model: 'fixture', systemPrompt: 'system',
      messages: [{ role: 'user', content: 'Describe this.', images: [{ mimeType: 'image/jpeg', data: '/9j/2Q==' }] }],
    })
    assert.ok(result.ok)
    assert.deepEqual(loopback.capturedRequest().body.messages, [
      { role: 'system', content: 'system' },
      { role: 'user', content: [{ type: 'text', text: 'Describe this.' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/2Q==' } }] },
    ])
  } finally { restoreEnv('WORKFLOW_GENERATOR_OPENAI_API_URL', previousUrl); await closeServer(loopback.server) }
})

test('Anthropic helper calls send images as base64 image blocks', async () => {
  // The paid model is replaced only at its HTTP boundary.
  const loopback = await startModelServer({ content: [{ type: 'text', text: 'visible' }], stop_reason: 'end_turn' })
  const previousUrl = process.env.WORKFLOW_GENERATOR_API_URL
  process.env.WORKFLOW_GENERATOR_API_URL = loopback.url
  try {
    const result = await callModel('fixture', { provider: 'anthropic', model: 'fixture', systemPrompt: 'system',
      messages: [{ role: 'user', content: 'Describe this.', images: [{ mimeType: 'image/jpeg', data: '/9j/2Q==' }] }],
    })
    assert.ok(result.ok)
    assert.deepEqual(loopback.capturedRequest().body.messages, [
      { role: 'user', content: [{ type: 'text', text: 'Describe this.' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/2Q==' } }] },
    ])
  } finally { restoreEnv('WORKFLOW_GENERATOR_API_URL', previousUrl); await closeServer(loopback.server) }
})

interface CapturedRequest {
  method: string | undefined
  authorization: string | undefined
  contentType: string | undefined
  body: Record<string, unknown>
}

async function startModelServer(responseBody: Record<string, unknown>): Promise<{
  server: http.Server
  url: string
  capturedRequest: () => CapturedRequest
}> {
  let captured: CapturedRequest | undefined
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      captured = {
        method: request.method,
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(responseBody))
    })
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })

  const address = server.address() as AddressInfo
  return {
    server,
    url: `http://127.0.0.1:${address.port}/chat/completions`,
    capturedRequest: () => {
      assert.ok(captured, 'expected the loopback server to receive a request')
      return captured
    },
  }
}

/**
 * The Anthropic messages endpoint, which answers a stream rather than one JSON
 * body and carries its version in a header.
 */
async function startAnthropicServer(): Promise<{
  server: http.Server
  url: string
  capturedRequest: () => {
    body: Record<string, unknown>
    anthropicVersion: string | undefined
  }
}> {
  let captured:
    | { body: Record<string, unknown>; anthropicVersion: string | undefined }
    | undefined
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      captured = {
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        anthropicVersion: request.headers['anthropic-version'] as string | undefined,
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(
        'event: content_block_delta\ndata: ' +
          JSON.stringify({
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: '{"ok":true}' },
          }) +
          '\n\n',
      )
      response.write(
        'event: message_stop\ndata: ' +
          JSON.stringify({ type: 'message_stop' }) +
          '\n\n',
      )
      response.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return {
    server,
    url: `http://127.0.0.1:${address.port}/v1/messages`,
    capturedRequest: () => {
      assert.ok(captured, 'expected the loopback server to receive a request')
      return captured
    },
  }
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

test('OpenAI model transport uses max_completion_tokens', async () => {
  const originalMaxTokens = process.env.WORKFLOW_GENERATOR_MAX_TOKENS
  const originalApiUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
  const loopback = await startModelServer({
    model: 'gpt-5.5',
    choices: [{ message: { content: '```json\n{"ok":true}\n```' } }],
  })

  process.env.WORKFLOW_GENERATOR_MAX_TOKENS = '1234'
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = loopback.url

  try {
    const result = await callModel('test-key', {
      provider: 'openai',
      model: 'gpt-5.5',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hello' }],
    })

    assert.equal(result.ok, true)
    const request = loopback.capturedRequest()
    assert.equal(request.method, 'POST')
    assert.equal(request.authorization, 'Bearer test-key')
    assert.equal(request.contentType, 'application/json')
    const body = request.body
    assert.equal(body.model, 'gpt-5.5')
    assert.equal(body.max_completion_tokens, 1234)
    assert.equal(body.max_tokens, undefined)
  } finally {
    restoreEnv('WORKFLOW_GENERATOR_MAX_TOKENS', originalMaxTokens)
    restoreEnv('WORKFLOW_GENERATOR_OPENAI_API_URL', originalApiUrl)
    await closeServer(loopback.server)
  }
})

test('OpenAI-compatible model transports keep max_tokens', async () => {
  const originalMaxTokens = process.env.WORKFLOW_GENERATOR_MAX_TOKENS
  const originalApiUrl = process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL
  const loopback = await startModelServer({
    model: 'deepseek-v4-flash',
    choices: [{ message: { content: '```json\n{"ok":true}\n```' } }],
  })

  process.env.WORKFLOW_GENERATOR_MAX_TOKENS = '4321'
  process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL = loopback.url

  try {
    const result = await callModel('test-key', {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hello' }],
    })

    assert.equal(result.ok, true)
    const request = loopback.capturedRequest()
    assert.equal(request.method, 'POST')
    assert.equal(request.authorization, 'Bearer test-key')
    assert.equal(request.contentType, 'application/json')
    const body = request.body
    assert.equal(body.model, 'deepseek-v4-flash')
    assert.equal(body.max_tokens, 4321)
    assert.equal(body.max_completion_tokens, undefined)
  } finally {
    restoreEnv('WORKFLOW_GENERATOR_MAX_TOKENS', originalMaxTokens)
    restoreEnv('WORKFLOW_GENERATOR_DEEPSEEK_API_URL', originalApiUrl)
    await closeServer(loopback.server)
  }
})

test("a non-OpenAI Chat Completions transport carries an Agent's token limit under its own name", async () => {
  // Deciding the field name from "not Anthropic" sent DeepSeek, Kimi and every
  // configured connection a `max_completion_tokens` they do not read, on top of
  // the `max_tokens` they do. The name comes from the endpoint, not the family.
  const originalApiUrl = process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL
  const loopback = await startModelServer({
    model: 'deepseek-v4-flash',
    choices: [{ message: { content: '```json\n{"ok":true}\n```' } }],
  })
  process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL = loopback.url

  try {
    await callModel('test-key', {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hello' }],
      providerOptions: { max_tokens: 777, temperature: 0.3 },
    })

    const body = loopback.capturedRequest().body
    assert.equal(body.max_tokens, 777)
    assert.equal(body.max_completion_tokens, undefined)
    assert.equal(body.temperature, 0.3)
  } finally {
    restoreEnv('WORKFLOW_GENERATOR_DEEPSEEK_API_URL', originalApiUrl)
    await closeServer(loopback.server)
  }
})

test("the Anthropic transport applies the settings the mapper says it applies", async () => {
  // The mapper approving a setting is worth nothing if the transport drops it.
  // Anthropic carries its thinking budget in the body and its version in a
  // header, so both are asserted on the wire.
  const originalApiUrl = process.env.WORKFLOW_GENERATOR_API_URL
  const loopback = await startAnthropicServer()
  process.env.WORKFLOW_GENERATOR_API_URL = loopback.url

  try {
    await callModel('test-key', {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hello' }],
      providerOptions: {
        max_tokens: 4096,
        thinking_budget: 2048,
        api_version: '2099-01-01',
      },
    })

    const request = loopback.capturedRequest()
    assert.equal(request.body.max_tokens, 4096)
    assert.deepEqual(request.body.thinking, {
      type: 'enabled',
      budget_tokens: 2048,
    })
    assert.equal(request.anthropicVersion, '2099-01-01')
  } finally {
    restoreEnv('WORKFLOW_GENERATOR_API_URL', originalApiUrl)
    await closeServer(loopback.server)
  }
})

test("a thinking budget the provider would reject is refused by name", async () => {
  // The provider requires a budget of at least 1024 and strictly below the
  // answer's own limit. Sending an impossible pair would come back as a
  // provider error whose text says nothing about the Agent file that caused it,
  // so the bounds are checked where the setting can still be named.
  const originalApiUrl = process.env.WORKFLOW_GENERATOR_API_URL
  const loopback = await startAnthropicServer()
  process.env.WORKFLOW_GENERATOR_API_URL = loopback.url

  try {
    for (const [options, expected] of [
      [{ max_tokens: 4096, thinking_budget: 512 }, /at least 1024/],
      [{ max_tokens: 2048, thinking_budget: 2048 }, /fewer tokens than max_tokens/],
    ] as const) {
      const result = await callModel('test-key', {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'hello' }],
        providerOptions: options,
      })

      assert.equal(result.ok, false)
      assert.match(result.ok ? '' : result.reason, expected)
    }
    assert.throws(
      () => loopback.capturedRequest(),
      /expected the loopback server to receive a request/,
      'nothing was sent',
    )
  } finally {
    restoreEnv('WORKFLOW_GENERATOR_API_URL', originalApiUrl)
    await closeServer(loopback.server)
  }
})

test('a setting no transport can carry fails the call instead of being dropped', async () => {
  // The refusal belongs at the shared boundary, not in one caller. Spreading an
  // empty object on a failed mapping sends the request anyway, so a caller that
  // had not written its own check — the Workflow Architect, for instance —
  // would silently lose every setting it declared.
  const originalApiUrl = process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL
  const loopback = await startModelServer({
    model: 'deepseek-v4-flash',
    choices: [{ message: { content: '```json\n{"ok":true}\n```' } }],
  })
  process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL = loopback.url

  try {
    for (const [options, expected] of [
      [{ invented_setting: 3 }, /invented_setting/],
      [{ max_tokens: false }, /max_tokens/],
    ] as const) {
      const result = await callModel('test-key', {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'hello' }],
        providerOptions: options,
      })

      assert.equal(result.ok, false)
      assert.match(result.ok ? '' : result.reason, expected)
    }
    assert.throws(
      () => loopback.capturedRequest(),
      /expected the loopback server to receive a request/,
      'nothing was sent',
    )
  } finally {
    restoreEnv('WORKFLOW_GENERATOR_DEEPSEEK_API_URL', originalApiUrl)
    await closeServer(loopback.server)
  }
})

test("a CLI turn carries the Agent's own settings to the adapter that reads them", async () => {
  // A CLI turn has no request body, but the adapters already read settings from
  // `providerConfig` — kimi turns `max_steps_per_turn` into
  // `--max-steps-per-turn`. Refusing them because there is no HTTP body would
  // take away a capability that exists today.
  const captured: ProviderExecuteOptions[] = []
  initProviders()
  // Replacing the shipped adapter: this asserts what the transport hands over,
  // not what kimi's own binary does with it.
  registerProvider(
    {
      name: 'kimi-cli',
    async execute(options) {
      captured.push(options)
      return {
        text: 'response',
        cost: 0,
        durationMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        contextTokens: 0,
        model: options.model,
      }
      },
    },
    { source: 'test:kimi-cli', trustClass: 'unknown' },
    { replaceExisting: true },
  )

  await callModel('unused', {
    provider: 'kimi-cli',
    model: 'default',
    systemPrompt: 'system',
    messages: [{ role: 'user', content: 'hello' }],
    providerOptions: { max_steps_per_turn: 12 },
  })

  assert.equal(captured.length, 1)
  assert.deepEqual(captured[0]?.providerConfig, { max_steps_per_turn: 12 })
})

test('CLI model transport honors per-call thinking while preserving medium by default', async () => {
  const captured: ProviderExecuteOptions[] = []
  initProviders()
  registerProvider(
    {
      name: 'codex',
      async execute(options) {
        captured.push(options)
        return {
          text: 'response',
          cost: 0,
          durationMs: 1,
          inputTokens: 0,
          outputTokens: 0,
          contextTokens: 0,
          model: options.model,
        }
      },
      async *stream(options) {
        captured.push(options)
        options.onProcessStarted?.()
        options.onProtocolEvent?.({
          kind: 'lifecycle',
          provider: 'codex',
          rawType: 'thread.started',
        })
        yield {
          kind: 'lifecycle' as const,
          provider: 'codex',
          timestamp: new Date().toISOString(),
          rawType: 'request.start',
        }
        yield {
          kind: 'text' as const,
          provider: 'codex',
          timestamp: new Date().toISOString(),
          text: 'response',
        }
        options.onProtocolEvent?.({
          kind: 'text',
          provider: 'codex',
          rawType: 'item.completed',
          text: 'response',
        })
      },
    },
    {
      source: 'tests/unit/model-client.test.ts',
      trustClass: 'test',
    },
    { replaceExisting: true },
  )

  const lowResult = await callModel('local', {
    provider: 'codex',
    model: 'default',
    systemPrompt: 'system',
    messages: [{ role: 'user', content: 'hello' }],
    thinking: 'low',
  } as Parameters<typeof callModel>[1])
  await callModel('local', {
    provider: 'codex',
    model: 'default',
    systemPrompt: 'system',
    messages: [{ role: 'user', content: 'hello again' }],
  })

  assert.deepEqual(captured.map((options) => options.thinking), ['low', 'medium'])
  assert.equal(lowResult.ok, true)
  assert.equal(typeof lowResult.timing.processSpawnMs, 'number')
  assert.notEqual(lowResult.timing.firstProviderEventMs, null)
  const firstTextMs = lowResult.timing.firstTextMs
  assert.notEqual(firstTextMs, null)
  assert.ok(firstTextMs! >= lowResult.timing.firstProviderEventMs!)
  assert.ok(lowResult.timing.providerDurationMs >= firstTextMs!)
})

/**
 * Every wait below is bounded. A transport that never streams must fail this
 * suite on an assertion within a second or two, not sit on a socket: the
 * deadline exists only so a missing behaviour is reported instead of hanging.
 */
const STREAM_ASSERTION_DEADLINE_MS = 5_000

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolveFn) => {
    resolve = resolveFn
  })
  assert.ok(resolve, 'expected the executor to run synchronously')
  return { promise, resolve }
}

function withDeadline<T>(
  promise: Promise<T>,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Unref'd and cleared on both exits, so a passing test never keeps the
    // process alive waiting for a timer it no longer needs.
    const timer = setTimeout(() => {
      reject(new Error(`${message} (within ${STREAM_ASSERTION_DEADLINE_MS}ms)`))
    }, STREAM_ASSERTION_DEADLINE_MS)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

interface StreamingLoopback {
  readonly server: http.Server
  readonly url: string
  /** Resolves with the parsed request body once the transport has posted. */
  readonly requestBody: Promise<Record<string, unknown>>
  /** Ends the response. Idempotent, so `finally` can always call it. */
  readonly releaseTrailer: () => void
}

/**
 * A loopback endpoint answering `text/event-stream`. The answer frames are
 * written as soon as the request arrives; only the terminal frame is withheld,
 * so the test controls when the call may complete without ever depending on
 * the transport to make progress first.
 */
async function startStreamingModelServer(options: {
  readonly frames: readonly string[]
  readonly trailer: string
}): Promise<StreamingLoopback> {
  const body = deferred<Record<string, unknown>>()
  const trailerReleased = deferred<void>()
  let released = false

  const server = http.createServer((request, response) => {
    const received: Buffer[] = []
    request.on('data', (chunk: Buffer) => received.push(chunk))
    request.on('end', () => {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
      })
      for (const frame of options.frames) response.write(frame)
      body.resolve(
        JSON.parse(Buffer.concat(received).toString('utf8')) as Record<
          string,
          unknown
        >,
      )
      void trailerReleased.promise.then(() => response.end(options.trailer))
    })
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })

  const address = server.address() as AddressInfo
  return {
    server,
    url: `http://127.0.0.1:${address.port}/chat/completions`,
    requestBody: body.promise,
    releaseTrailer: () => {
      if (released) return
      released = true
      trailerReleased.resolve()
    },
  }
}

test('OpenAI-compatible model transport reports a streamed suffix before the call resolves', async () => {
  const originalApiUrl = process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL
  const loopback = await startStreamingModelServer({
    frames: [
      `data: ${JSON.stringify({ model: 'deepseek-v4-flash', choices: [{ delta: { content: 'Kestrel' } }] })}\n\n`,
    ],
    trailer:
      `data: ${JSON.stringify({ choices: [{ delta: { content: ' and Marlin' }, finish_reason: 'stop' }] })}\n\n` +
      'data: [DONE]\n\n',
  })
  process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL = loopback.url

  const observed: string[] = []
  const firstDelta = deferred<string>()
  const call = callModel('test-key', {
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    systemPrompt: 'system',
    messages: [{ role: 'user', content: 'hello' }],
    onTextDelta: (text: string) => {
      observed.push(text)
      if (observed.length === 1) firstDelta.resolve(text)
    },
  })
  // Attached immediately so a rejection is never unhandled while the
  // assertions below run.
  call.catch(() => undefined)

  try {
    const requestBody = await withDeadline(
      loopback.requestBody,
      'the transport never posted a request',
    )
    assert.equal(requestBody.stream, true)

    const first = await withDeadline(
      firstDelta.promise,
      'no answer suffix was reported while the response was still open',
    )
    assert.equal(first, 'Kestrel')
    assert.equal(observed.length, 1, 'the terminal frame was still withheld')

    loopback.releaseTrailer()
    const result = await withDeadline(call, 'the call never resolved')
    assert.deepEqual(observed, ['Kestrel', ' and Marlin'])
    assert.equal(result.ok, true)
    assert.equal(result.ok && result.text, 'Kestrel and Marlin')
    assert.equal(result.ok && result.model, 'deepseek-v4-flash')
    assert.notEqual(result.timing.firstTextMs, null)
  } finally {
    loopback.releaseTrailer()
    await call.catch(() => undefined)
    restoreEnv('WORKFLOW_GENERATOR_DEEPSEEK_API_URL', originalApiUrl)
    await closeServer(loopback.server)
  }
})

test('Anthropic model transport reports a streamed suffix before the call resolves', async () => {
  const originalApiUrl = process.env.WORKFLOW_GENERATOR_API_URL
  const loopback = await startStreamingModelServer({
    frames: [
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-4-6-sonnet' } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Quokka' } })}\n\n`,
    ],
    trailer:
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: ' and Tapir' } })}\n\n` +
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}\n\n` +
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  })
  process.env.WORKFLOW_GENERATOR_API_URL = loopback.url

  const observed: string[] = []
  const firstDelta = deferred<string>()
  const call = callModel('test-key', {
    provider: 'anthropic',
    model: 'claude-4-6-sonnet',
    systemPrompt: 'system',
    messages: [{ role: 'user', content: 'hello' }],
    onTextDelta: (text: string) => {
      observed.push(text)
      if (observed.length === 1) firstDelta.resolve(text)
    },
  })
  call.catch(() => undefined)

  try {
    const requestBody = await withDeadline(
      loopback.requestBody,
      'the transport never posted a request',
    )
    assert.equal(requestBody.stream, true)

    const first = await withDeadline(
      firstDelta.promise,
      'no answer suffix was reported while the response was still open',
    )
    assert.equal(first, 'Quokka')

    loopback.releaseTrailer()
    const result = await withDeadline(call, 'the call never resolved')
    assert.deepEqual(observed, ['Quokka', ' and Tapir'])
    assert.equal(result.ok, true)
    assert.equal(result.ok && result.text, 'Quokka and Tapir')
    assert.equal(result.ok && result.model, 'claude-4-6-sonnet')
  } finally {
    loopback.releaseTrailer()
    await call.catch(() => undefined)
    restoreEnv('WORKFLOW_GENERATOR_API_URL', originalApiUrl)
    await closeServer(loopback.server)
  }
})

test('a CLI provider that reports answer text passes it to the caller', async () => {
  // Codex and lm-studio report answer text through `onProtocolEvent`. Mapping
  // those events to timing alone silently drops the only preview a
  // CLI-backed model can offer. This is whole-message delivery, not token
  // growth — the adapters emit a completed message — but showing it beats
  // showing nothing.
  initProviders()
  registerProvider(
    {
      name: 'codex',
      async execute(options) {
        options.onProtocolEvent?.({
          kind: 'text',
          provider: 'codex',
          rawType: 'item.completed',
          text: 'the whole answer',
        })
        return {
          text: 'the whole answer',
          cost: 0,
          durationMs: 1,
          inputTokens: 0,
          outputTokens: 0,
          contextTokens: 0,
          model: options.model,
        }
      },
    },
    { source: 'tests/unit/model-client.test.ts', trustClass: 'test' },
    { replaceExisting: true },
  )

  const observed: string[] = []
  const result = await callModel('local', {
    provider: 'codex',
    model: 'default',
    systemPrompt: 'system',
    messages: [{ role: 'user', content: 'hello' }],
    onTextDelta: (text: string) => observed.push(text),
  })

  assert.deepEqual(observed, ['the whole answer'])
  assert.equal(result.ok, true)
})

/**
 * Diagnostics: what the transport can say about a call without saying what was
 * said.
 *
 * A display result answers "what do I show the user". These answer "what
 * happened", and they are the half a durable record may keep: identities,
 * a route, an outcome, an allowlisted failure shape, timings and validated
 * counts. The provider's own prose — its reason, its response body, its
 * headers — is display only and must never appear here.
 */
const DIAGNOSTIC_BODY_SENTINEL = 'zzq-model-client-body-sentinel-a41d90'
const DIAGNOSTIC_HEADER_SENTINEL = 'zzq-model-client-header-sentinel-6cf2e1'

interface ScriptedLoopback {
  readonly url: string
  readonly close: () => Promise<void>
  readonly waitForRequest: () => Promise<void>
}

/** A loopback endpoint that answers once, however the test tells it to. */
async function startScriptedLoopback(
  answer:
    | { readonly kind: 'json'; readonly status: number; readonly body: unknown }
    | { readonly kind: 'hang' },
): Promise<ScriptedLoopback> {
  const arrived = deferred<void>()
  const held = new Set<http.ServerResponse>()
  const server = http.createServer((request, response) => {
    request.on('data', () => undefined)
    request.on('end', () => {
      arrived.resolve()
      if (answer.kind === 'hang') {
        held.add(response)
        response.once('close', () => held.delete(response))
        return
      }
      response.writeHead(answer.status, {
        'content-type': 'application/json',
        'x-provider-trace': DIAGNOSTIC_HEADER_SENTINEL,
      })
      response.end(JSON.stringify(answer.body))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}/chat/completions`,
    waitForRequest: () => arrived.promise,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const response of held) response.destroy()
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}

test('a successful model call reports requested and resolved identity, route, timing, and validated usage', async () => {
  const originalUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
  const loopback = await startScriptedLoopback({
    kind: 'json',
    status: 200,
    body: {
      model: 'served-model',
      choices: [{ message: { content: 'the answer' } }],
      usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
    },
  })
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = loopback.url

  try {
    const result = await callModel('test-key', {
      // Mixed case on purpose: what the caller asked for and what the
      // transport resolved are different facts, and a record that keeps only
      // one of them cannot answer which provider actually ran.
      provider: 'OpenAI',
      model: 'requested-model',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hello' }],
    })

    assert.equal(result.ok, true)
    const diagnostics = result.diagnostics
    assert.equal(diagnostics.requestedProvider, 'OpenAI')
    assert.equal(diagnostics.requestedModel, 'requested-model')
    assert.equal(diagnostics.resolvedProvider, 'openai')
    assert.equal(diagnostics.resolvedModel, 'served-model')
    assert.equal(diagnostics.route, 'http')
    assert.equal(diagnostics.outcome, 'success')
    assert.equal(diagnostics.failure, undefined)
    assert.deepEqual(diagnostics.usage, {
      inputTokens: 9,
      outputTokens: 4,
      totalTokens: 13,
    })
    assert.ok(diagnostics.timing.providerDurationMs >= 0)
  } finally {
    restoreEnv('WORKFLOW_GENERATOR_OPENAI_API_URL', originalUrl)
    await loopback.close()
  }
})

test('an HTTP error becomes an allowlisted failure identity and never the response body or headers', async () => {
  const originalUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
  const loopback = await startScriptedLoopback({
    kind: 'json',
    status: 429,
    body: {
      error: {
        message: `slow down: ${DIAGNOSTIC_BODY_SENTINEL}`,
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
      },
    },
  })
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = loopback.url

  try {
    const result = await callModel('test-key', {
      provider: 'openai',
      model: 'requested-model',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hello' }],
    })

    assert.equal(result.ok, false)
    const diagnostics = result.diagnostics
    assert.equal(diagnostics.outcome, 'provider_failure')
    assert.deepEqual(diagnostics.failure, {
      code: 'http_status',
      phase: 'response',
      providerKind: 'chat-completions',
      providerCode: 'rate_limit_exceeded',
      httpStatus: 429,
      retryable: true,
    })
    assert.equal(diagnostics.usage, undefined)
    const rendered = JSON.stringify(diagnostics)
    assert.equal(
      rendered.includes(DIAGNOSTIC_BODY_SENTINEL),
      false,
      'the response body must stay a display concern',
    )
    assert.equal(
      rendered.includes(DIAGNOSTIC_HEADER_SENTINEL),
      false,
      'response headers must stay a display concern',
    )
  } finally {
    restoreEnv('WORKFLOW_GENERATOR_OPENAI_API_URL', originalUrl)
    await loopback.close()
  }
})

test('a provider that reports the request timed out is a timeout, not a refusal', async () => {
  const originalUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
  const loopback = await startScriptedLoopback({
    kind: 'json',
    status: 408,
    body: {
      error: {
        message: `gave up waiting: ${DIAGNOSTIC_BODY_SENTINEL}`,
        type: 'timeout_error',
        code: 'request_timeout',
      },
    },
  })
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = loopback.url

  try {
    const result = await callModel('test-key', {
      provider: 'openai',
      model: 'requested-model',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hello' }],
    })

    assert.equal(result.ok, false)
    const diagnostics = result.diagnostics
    // An elapsed wait and a refused request are different operational facts:
    // the first says retry, the second says fix the request. Reporting both as
    // `provider_failure` collapses that distinction.
    assert.equal(diagnostics.outcome, 'timeout')
    assert.deepEqual(diagnostics.failure, {
      code: 'timeout',
      phase: 'response',
      providerKind: 'chat-completions',
      providerCode: 'request_timeout',
      httpStatus: 408,
      retryable: true,
    })
    assert.equal(
      JSON.stringify(diagnostics).includes(DIAGNOSTIC_BODY_SENTINEL),
      false,
      'a timeout body is still a body',
    )
  } finally {
    restoreEnv('WORKFLOW_GENERATOR_OPENAI_API_URL', originalUrl)
    await loopback.close()
  }
})

test('a transport that times out before any response is a timeout in the request phase', async () => {
  // Isolated at the external network boundary rather than by waiting out a
  // real bound: the behaviour under test is how the transport classifies a
  // `TimeoutError`, and the ten-minute bound that produces one is not
  // something a unit test should sit through or reach in and change.
  const originalUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
  const originalFetch = globalThis.fetch
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL =
    'http://127.0.0.1:1/chat/completions'
  globalThis.fetch = (() =>
    Promise.reject(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    )) as typeof globalThis.fetch

  try {
    const result = await callModel('test-key', {
      provider: 'openai',
      model: 'requested-model',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hello' }],
    })

    assert.equal(result.ok, false)
    const diagnostics = result.diagnostics
    assert.equal(diagnostics.outcome, 'timeout')
    assert.deepEqual(diagnostics.failure, {
      code: 'timeout',
      phase: 'request',
      providerKind: 'chat-completions',
      retryable: true,
    })
  } finally {
    globalThis.fetch = originalFetch
    restoreEnv('WORKFLOW_GENERATOR_OPENAI_API_URL', originalUrl)
  }
})

test('a cancelled model call reports its diagnostics before the abort is rethrown', async () => {
  const originalUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
  const loopback = await startScriptedLoopback({ kind: 'hang' })
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = loopback.url
  const abort = new AbortController()
  const observed: ModelCallDiagnostics[] = []

  try {
    const call = callModel('test-key', {
      provider: 'openai',
      model: 'requested-model',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hello' }],
      signal: abort.signal,
      onDiagnostics: (diagnostics) => observed.push(diagnostics),
    })
    await loopback.waitForRequest()
    abort.abort()

    // The abort still escapes: a cancelled turn is decided by the caller's
    // intent, and swallowing it here would publish a failure as an answer.
    await assert.rejects(withDeadline(call, 'the cancelled call to settle'))
    assert.equal(observed.length, 1, 'a cancelled call still reports what it did')
    const diagnostics = observed[0]
    assert.ok(diagnostics)
    assert.equal(diagnostics.outcome, 'cancelled')
    assert.deepEqual(diagnostics.failure, {
      code: 'cancelled',
      phase: 'request',
      providerKind: 'chat-completions',
      retryable: false,
    })
    assert.equal(diagnostics.requestedModel, 'requested-model')
  } finally {
    restoreEnv('WORKFLOW_GENERATOR_OPENAI_API_URL', originalUrl)
    await loopback.close()
  }
})

test('an unsupported provider is reported without a route and without a request', async () => {
  const result = await callModel('test-key', {
    provider: 'not-a-registered-provider',
    model: 'requested-model',
    systemPrompt: 'system',
    messages: [{ role: 'user', content: 'hello' }],
  })

  assert.equal(result.ok, false)
  const diagnostics = result.diagnostics
  assert.equal(diagnostics.route, 'fallback')
  assert.equal(diagnostics.outcome, 'provider_failure')
  assert.deepEqual(diagnostics.failure, {
    code: 'provider_unsupported',
    phase: 'request',
    providerKind: 'unsupported',
    retryable: false,
  })
})
