import * as http from 'node:http'

/** One scripted answer, claimed by the persona its request's `system` carries. */
export interface FakeAnthropicTurn {
  readonly persona: string
  /** The answer's suffixes, streamed as one `text_delta` each. */
  readonly chunks: readonly string[]
  /**
   * Withhold the whole response, headers included, until
   * `releaseBlockedResponses()`, so a journey can observe the turn as
   * dispatched and not yet answering.
   */
  readonly blocked?: boolean
}

export interface FakeAnthropicRequest {
  readonly system: string | undefined
  readonly stream: boolean
  readonly model: string | undefined
  readonly apiKey: string | undefined
}

export interface FakeAnthropicMessagesServer {
  /** The complete Messages endpoint, as an Agent's `provider_options.base_url` names it. */
  readonly messagesUrl: string
  readonly requests: readonly FakeAnthropicRequest[]
  /** Resolves once this many requests have arrived; the server is what knows. */
  readonly waitForRequest: (count: number) => Promise<void>
  /** Send every held suffix after the first. */
  readonly releaseHeldChunks: () => void
  /** Send the frames that end the answer. */
  readonly releaseTerminal: () => void
  /** Start every response withheld by a `blocked` turn. */
  readonly releaseBlockedResponses: () => void
  readonly close: () => Promise<void>
}

/** What an unscripted request is answered with, whole and ungated. */
const FALLBACK_TEXT = 'Noted.'

/**
 * A deterministic Anthropic Messages endpoint on a random loopback port.
 *
 * A streamed answer is framed as the strict reader requires
 * (`providers/messages-stream.ts`): `message_start`, `content_block_start`, one
 * `content_block_delta` per suffix, `content_block_stop`, `message_delta` with
 * a `stop_reason`, then `message_stop`. A multi-suffix answer is staged: the
 * suffixes after the first wait for `releaseHeldChunks()`, and everything after
 * the last suffix waits for `releaseTerminal()`. A request no turn claims gets
 * a whole, ungated reply, streamed or not as it asked.
 */
export async function startFakeAnthropicMessagesServer(options: {
  readonly turns: readonly FakeAnthropicTurn[]
}): Promise<FakeAnthropicMessagesServer> {
  const requests: FakeAnthropicRequest[] = []
  const heldChunks = new Set<() => void>()
  const heldTerminals = new Set<() => void>()
  let chunksReleased = false
  let terminalReleased = false
  let messageCount = 0
  const blockedResponses = new Set<() => void>()
  let responsesReleased = false
  const requestWaiters = new Set<{ readonly count: number; readonly resolve: () => void }>()

  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/messages') {
      response.writeHead(404).end('not found')
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      let body: unknown
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'unreadable body' } }))
        return
      }
      const field = (name: string): unknown =>
        typeof body === 'object' && body !== null && name in body ? Reflect.get(body, name) : undefined
      const systemField = field('system')
      const system = typeof systemField === 'string'
        ? systemField
        : Array.isArray(systemField)
          ? systemField.map((part: unknown) => (typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string' ? part.text : '')).join('')
          : undefined
      const modelField = field('model')
      const model = typeof modelField === 'string' ? modelField : undefined
      const stream = field('stream') === true
      const keyHeader = request.headers['x-api-key']
      requests.push({ system, stream, model, apiKey: typeof keyHeader === 'string' ? keyHeader : undefined })
      for (const waiter of [...requestWaiters]) {
        if (requests.length >= waiter.count) {
          requestWaiters.delete(waiter)
          waiter.resolve()
        }
      }

      const turn = options.turns.find((candidate) => system?.includes(candidate.persona))
      if (turn?.blocked && !responsesReleased) {
        const resume = () => {
          blockedResponses.delete(resume)
          respond(turn, model, stream)
        }
        blockedResponses.add(resume)
        response.once('close', () => blockedResponses.delete(resume))
        return
      }
      respond(turn, model, stream)
    })

    const respond = (
      turn: FakeAnthropicTurn | undefined,
      model: string | undefined,
      stream: boolean,
    ): void => {
      if (response.destroyed || response.writableEnded) return
      messageCount += 1
      const id = `msg_fake_${messageCount}`
      const suffixes = turn ? turn.chunks : [FALLBACK_TEXT]
      const text = suffixes.join('')
      const usage = { input_tokens: 5, output_tokens: 7 }

      if (!stream) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          id, type: 'message', role: 'assistant', model: model ?? 'fake-claude',
          content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage,
        }))
        return
      }

      const frame = (type: string, payload: Record<string, unknown>): string =>
        `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
      const deltas = suffixes.map((suffix) =>
        frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: suffix } }))
      const frames = [
        frame('message_start', {
          message: {
            id, type: 'message', role: 'assistant', model: model ?? 'fake-claude',
            content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 },
          },
        }),
        frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
        ...deltas,
        frame('content_block_stop', { index: 0 }),
        frame('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } }),
        frame('message_stop', {}),
      ]
      const staged = Boolean(turn) && suffixes.length > 1
      // The second suffix, and the first frame after the last suffix.
      const holdIndex = staged ? 3 : -1
      const terminalIndex = staged ? 2 + deltas.length : -1

      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const writeFrom = (start: number): void => {
        for (let index = start; index < frames.length; index += 1) {
          if (index === holdIndex && !chunksReleased) {
            const resume = () => {
              heldChunks.delete(resume)
              writeFrom(index)
            }
            heldChunks.add(resume)
            response.once('close', () => heldChunks.delete(resume))
            return
          }
          if (index === terminalIndex && !terminalReleased) {
            const resume = () => {
              heldTerminals.delete(resume)
              writeFrom(index)
            }
            heldTerminals.add(resume)
            response.once('close', () => heldTerminals.delete(resume))
            return
          }
          response.write(frames[index])
        }
        response.end()
      }
      writeFrom(0)
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fake Anthropic server has no address.')
  return {
    messagesUrl: `http://127.0.0.1:${address.port}/v1/messages`,
    requests,
    waitForRequest: (count) =>
      requests.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            requestWaiters.add({ count, resolve })
          }),
    releaseHeldChunks: () => {
      chunksReleased = true
      for (const resume of [...heldChunks]) resume()
    },
    releaseTerminal: () => {
      terminalReleased = true
      for (const resume of [...heldTerminals]) resume()
    },
    releaseBlockedResponses: () => {
      responsesReleased = true
      for (const resume of [...blockedResponses]) resume()
    },
    close: () => new Promise<void>((resolve) => {
      // A response still withheld would keep its socket open.
      for (const resume of [...blockedResponses]) resume()
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
