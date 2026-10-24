/**
 * A refused provider request has to leave an identity behind.
 *
 * The adapter used to cancel the error body and keep only "the request
 * failed", so by the time the chat service turned the exception into safe user
 * text there was nothing left to record. What survives now is exactly the
 * sanitized half — status, retryability, the normalized kind, and the code the
 * provider stated about itself — and never the prose or the credential.
 */
import assert from 'node:assert/strict'
import * as http from 'node:http'
import test from 'node:test'

import { createOpenAIChatCompletionsToolAdapter } from '../../domains/provider/openai-chat-completions-tool-adapter.js'
import { ProviderToolLoopError } from '../../domains/provider/provider-tool-loop.js'
import type { ProviderToolLoopAdapter } from '../../domains/provider/provider-tool-loop.js'

const API_KEY = 'adapter-secret-4f21'

interface RefusingEndpoint {
  readonly url: string
  /** Authorization headers the endpoint actually received. */
  readonly authorizations: readonly (string | undefined)[]
  close(): Promise<void>
}

async function startEndpoint(
  respond: (res: http.ServerResponse) => void,
): Promise<RefusingEndpoint> {
  const authorizations: (string | undefined)[] = []
  const server = http.createServer((req, res) => {
    authorizations.push(req.headers.authorization)
    req.resume()
    req.on('end', () => respond(res))
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Endpoint failed to bind')
  }
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    authorizations,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

function adapterFor(url: string): ProviderToolLoopAdapter {
  return createOpenAIChatCompletionsToolAdapter({
    apiUrl: url,
    model: 'fixture/identity',
    apiKey: API_KEY,
  })
}

async function completionFailure(
  endpoint: RefusingEndpoint,
): Promise<ProviderToolLoopError> {
  try {
    await adapterFor(endpoint.url).complete({
      messages: [{ role: 'user', content: 'anything' }],
      tools: [],
      signal: new AbortController().signal,
    })
  } catch (error) {
    assert.ok(error instanceof ProviderToolLoopError, String(error))
    return error
  }
  throw new Error('The adapter did not fail')
}

test('a 503 with a structured body keeps its status, kind, code, and retryability', async () => {
  const endpoint = await startEndpoint((res) => {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        error: {
          message: 'Capacity for tenant zeta-9 is exhausted; retry later.',
          type: 'service_unavailable',
          code: 'model_overloaded',
        },
      }),
    )
  })
  try {
    const failure = await completionFailure(endpoint)

    assert.equal(failure.code, 'provider_request_failed')
    assert.equal(failure.statusCode, 503)
    assert.equal(failure.retryable, true)
    assert.equal(failure.providerIdentity?.providerKind, 'overloaded')
    assert.equal(failure.providerIdentity?.providerCode, 'model_overloaded')
    assert.equal(
      failure.message.includes('zeta-9'),
      false,
      'the provider prose does not become the exception message',
    )
  } finally {
    await endpoint.close()
  }
})

test('a 429 is a rate limit and stays retryable', async () => {
  const endpoint = await startEndpoint((res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'slow down', code: 'rl_1' } }))
  })
  try {
    const failure = await completionFailure(endpoint)

    assert.equal(failure.statusCode, 429)
    assert.equal(failure.retryable, true)
    assert.equal(failure.providerIdentity?.providerKind, 'rate_limit')
    assert.equal(failure.providerIdentity?.providerCode, 'rl_1')
  } finally {
    await endpoint.close()
  }
})

test('a 401 is not retryable and is identified as authentication', async () => {
  const endpoint = await startEndpoint((res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'bad key' } }))
  })
  try {
    const failure = await completionFailure(endpoint)

    assert.equal(failure.statusCode, 401)
    assert.equal(failure.retryable, false)
    assert.equal(failure.providerIdentity?.providerKind, 'authentication')
    assert.equal(failure.providerIdentity?.providerCode, undefined)
  } finally {
    await endpoint.close()
  }
})

test('a body that is not JSON still yields the status-derived identity', async () => {
  const endpoint = await startEndpoint((res) => {
    res.writeHead(500, { 'content-type': 'text/html' })
    res.end('<html><body>gateway exploded</body></html>')
  })
  try {
    const failure = await completionFailure(endpoint)

    assert.equal(failure.statusCode, 500)
    assert.equal(failure.retryable, true)
    assert.equal(failure.providerIdentity?.providerKind, 'server_error')
    assert.equal(failure.providerIdentity?.providerCode, undefined)
  } finally {
    await endpoint.close()
  }
})

test('an oversized error body is bounded, not read whole', async () => {
  const filler = 'x'.repeat(400_000)
  const endpoint = await startEndpoint((res) => {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: filler, code: 'huge' } }))
  })
  try {
    const failure = await completionFailure(endpoint)

    // The read stops early, so the code inside the truncated tail is gone —
    // the status-derived identity is what remains, and nothing hangs.
    assert.equal(failure.statusCode, 503)
    assert.equal(failure.providerIdentity?.providerKind, 'overloaded')
  } finally {
    await endpoint.close()
  }
})

test('an aborted request fails as cancelled rather than as a provider refusal', async () => {
  const endpoint = await startEndpoint(() => {
    // Never answers; the caller's abort is what ends it.
  })
  const controller = new AbortController()
  try {
    const pending = adapterFor(endpoint.url).complete({
      messages: [{ role: 'user', content: 'anything' }],
      tools: [],
      signal: controller.signal,
    })
    controller.abort()
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof ProviderToolLoopError, String(error))
      assert.equal(error.statusCode, undefined)
      return true
    })
  } finally {
    await endpoint.close()
  }
})

test('the credential never travels with the failure identity', async () => {
  const endpoint = await startEndpoint((res) => {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'nope', code: 'c' } }))
  })
  try {
    const failure = await completionFailure(endpoint)

    assert.equal(
      endpoint.authorizations[0],
      `Bearer ${API_KEY}`,
      'the request really was authenticated',
    )
    assert.equal(JSON.stringify(failure.providerIdentity).includes(API_KEY), false)
    assert.equal(failure.message.includes(API_KEY), false)
  } finally {
    await endpoint.close()
  }
})

test('a code field carrying prose is not a code, and does not travel', async () => {
  const prose =
    'Your key sk-live-77c2 was rejected while processing: "summarise the Q3 board memo"'
  const endpoint = await startEndpoint((res) => {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'nope', code: prose } }))
  })
  try {
    const failure = await completionFailure(endpoint)

    assert.equal(failure.statusCode, 503)
    assert.equal(
      failure.providerIdentity?.providerCode,
      undefined,
      'a provider chooses this string, so an unbounded one is a content channel',
    )
    assert.equal(failure.providerIdentity?.providerKind, 'overloaded')
    assert.equal(JSON.stringify(failure.providerIdentity).includes('sk-live-77c2'), false)
  } finally {
    await endpoint.close()
  }
})
