/**
 * The total request deadline over a streamed final answer (inventory ST-01).
 *
 * `docs/flows/agent-chat-live-answer.md` records the gap: the native chat
 * route streams its answer through the OpenAI Chat Completions tool adapter,
 * and the adapter's total request deadline, 30 seconds by default, also bounds
 * a long streamed answer. The chat service builds the adapter without a
 * deadline of its own (`services/mcp-agent-tool-service.ts`), so every chat
 * turn gets that default. Any answer that takes longer than 30 seconds to
 * stream fails, even while text is still arriving.
 *
 * This pins that behavior as it is; the deadline itself is not changed. The
 * adapter talks to a local fake provider over real HTTP. Only `setTimeout` is
 * mocked, so the adapter's own deadline timer runs on a test clock the test
 * advances explicitly, while the socket, the SSE reader and the abort run for
 * real. Every wait is on an event: a request arriving, a streamed piece
 * reaching the observer, the call settling, or the provider seeing its
 * connection close.
 */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import * as http from 'node:http'
import test from 'node:test'

import { createOpenAIChatCompletionsToolAdapter } from '../../domains/provider/openai-chat-completions-tool-adapter.js'
import { ProviderToolLoopError } from '../../domains/provider/provider-tool-loop.js'

const MODEL = 'fake/streamed-deadline'

/** The chat route's deadline, which the adapter applies when given none. */
const DEFAULT_DEADLINE_MS = 30_000

interface HeldStream {
  /** Sends one piece of the answer as a Chat Completions chunk. */
  send(text: string): void
  /**
   * Settles when the provider's side of the connection closes. It reports
   * whether the provider had ended the response by then; `false` means the
   * client closed it.
   */
  readonly closed: Promise<{ readonly providerEndedResponse: boolean }>
}

interface HeldStreamProvider {
  readonly apiUrl: string
  /** The next streamed request, once it has arrived and its headers are sent. */
  nextStream(): Promise<HeldStream>
  close(): Promise<void>
}

/**
 * A provider that answers every request with an SSE stream it never finishes
 * on its own. The test decides when each piece is sent.
 */
async function startHeldStreamProvider(): Promise<HeldStreamProvider> {
  const waiting: Array<(stream: HeldStream) => void> = []
  const arrived: HeldStream[] = []
  const server = http.createServer((request, response) => {
    // The body is read to its end before answering, as a real provider does.
    request.resume()
    request.on('end', () => {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
      response.flushHeaders()
      // A write after the client has gone reports an error on the response;
      // that is the case under test, not a failure of the fixture.
      response.on('error', () => undefined)
      const closed = once(response, 'close').then(() => ({
        providerEndedResponse: response.writableEnded,
      }))
      const stream: HeldStream = {
        send(text) {
          if (response.destroyed) return
          response.write(`data: ${JSON.stringify({
            id: 'chatcmpl-deadline',
            object: 'chat.completion.chunk',
            model: MODEL,
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
          })}\n\n`)
        },
        closed,
      }
      const waiter = waiting.shift()
      if (waiter) waiter(stream)
      else arrived.push(stream)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('The fake provider is not listening on a TCP port.')
  }
  return {
    apiUrl: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    nextStream() {
      const ready = arrived.shift()
      if (ready) return Promise.resolve(ready)
      return new Promise((resolve) => waiting.push(resolve))
    },
    async close() {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    },
  }
}

/** Every streamed piece, with a way to wait for the next one. */
function streamedPieces(): {
  readonly received: string[]
  readonly observe: (text: string) => void
  /** Settles when the piece after the ones received so far arrives. */
  next(): Promise<string>
} {
  const received: string[] = []
  const waiters: Array<{ readonly index: number, readonly resolve: (text: string) => void }> = []
  return {
    received,
    observe(text) {
      received.push(text)
      for (const waiter of waiters.splice(0)) {
        const piece = received[waiter.index]
        if (piece === undefined) waiters.push(waiter)
        else waiter.resolve(piece)
      }
    },
    next() {
      const index = received.length
      return new Promise((resolve) => waiters.push({ index, resolve }))
    },
  }
}

type Outcome =
  | { readonly settled: 'resolved' }
  | { readonly settled: 'rejected', readonly error: unknown }
  | { readonly settled: 'late piece', readonly text: string }

test(
  'ST-01: the chat route\'s 30-second total request deadline ends a streamed answer that is still arriving, keeps only the pieces shown before it, and closes the connection',
  async (t) => {
    // Before the call, so the adapter's deadline timer is scheduled on the
    // test clock. Nothing else in this test uses `setTimeout`.
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const provider = await startHeldStreamProvider()
    t.after(() => provider.close())

    const pieces = streamedPieces()
    // No `requestTimeoutMs`, exactly as the chat service builds it.
    const adapter = createOpenAIChatCompletionsToolAdapter({
      apiUrl: provider.apiUrl,
      model: MODEL,
      onFinalTextDelta: pieces.observe,
    })
    const completeFinal = adapter.completeFinal
    assert.ok(completeFinal, 'an adapter with a live observer streams its final answer')

    const outcome: Promise<Outcome> = completeFinal({
      messages: [
        { role: 'system', content: 'Answer at length.' },
        { role: 'user', content: 'Tell me everything.' },
      ],
      tools: [],
      signal: new AbortController().signal,
    }).then(
      () => ({ settled: 'resolved' }),
      (error: unknown) => ({ settled: 'rejected', error }),
    )

    const stream = await provider.nextStream()
    const first = pieces.next()
    stream.send('The first part. ')
    assert.equal(await first, 'The first part. ')

    // One millisecond short of the deadline the answer is still arriving:
    // another piece is sent and shown.
    t.mock.timers.tick(DEFAULT_DEADLINE_MS - 1)
    const second = pieces.next()
    stream.send('Still arriving. ')
    assert.equal(await second, 'Still arriving. ')

    // The deadline passes while the stream is live. A piece sent after it is
    // not shown: the call has already failed.
    t.mock.timers.tick(1)
    const late = pieces.next()
    stream.send('Too late. ')
    const settled = await Promise.race<Outcome>([
      outcome,
      late.then((text) => ({ settled: 'late piece', text })),
    ])
    assert.equal(settled.settled, 'rejected', `expected the deadline to fail the call, got ${JSON.stringify(settled)}`)
    assert.ok(settled.settled === 'rejected')
    assert.ok(settled.error instanceof ProviderToolLoopError, `expected a ProviderToolLoopError, got ${String(settled.error)}`)
    assert.equal(settled.error.code, 'timeout')
    assert.equal(settled.error.retryable, true)

    // The client closes the connection; the provider never ended the response,
    // and no later piece is read.
    const after = await Promise.race([
      stream.closed.then((closed) => ({ kind: 'closed' as const, ...closed })),
      late.then((text) => ({ kind: 'late piece' as const, text })),
    ])
    assert.deepEqual(after, { kind: 'closed', providerEndedResponse: false })
    assert.deepEqual(pieces.received, ['The first part. ', 'Still arriving. '])
  },
)
