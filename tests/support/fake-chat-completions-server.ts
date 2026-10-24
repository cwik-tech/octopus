import * as http from 'node:http'

export interface FakeChatCompletionsServer {
  readonly url: string
  /** One entry per received request, in arrival order. */
  readonly requests: readonly FakeChatCompletionsRequest[]
  /**
   * Whether the client closed the connection of request `index` (its position
   * in `requests`) while this server still held that response open.
   *
   * Only a response this server never ended can be closed by the client, so
   * this is how a test tells an abandoned stream from a closed one. Recorded
   * when the socket reports the client's FIN or reset, which the server reads
   * before any request that client sends afterwards on a new connection.
   */
  closedByClient(index: number): boolean
  close(): Promise<void>
}

export interface FakeChatCompletionsRequest {
  readonly model: string | undefined
  readonly stream: boolean
  readonly systemPrompt: string | undefined
  readonly userMessage: string | undefined
  readonly toolCount: number
  /**
   * The request body as it arrived.
   *
   * The named fields above describe a turn; this is for questions about what
   * the *provider* was actually asked to do — whether a setting reached it, and
   * whether one that should not have did. Those cannot be answered from a
   * summary that only keeps what it expected to find.
   */
  readonly body: Record<string, unknown>
}

/** What the server should answer for one request. */
export interface FakeChatCompletionsTurn {
  /** Streamed suffixes, used when the request asked for `stream: true`. */
  readonly deltas?: readonly string[]
  /** Held before the delta at the matching index, to observe growth stepwise. */
  readonly deltaGates?: readonly Promise<void>[]
  /** Held before the terminal chunk, a non-streaming answer, or a failure status. */
  readonly gate?: Promise<void>
  /** Whole answer; also the fallback text when deltas are streamed. */
  readonly content?: string
  /** Answer with this status instead, to exercise a provider failure. */
  readonly failStatus?: number
  /**
   * Function calls the assistant makes in this round.
   *
   * Non-streaming, they sit beside `content` in one message. Streamed, they
   * follow every content delta as separate `tool_calls` chunks, with each
   * call's arguments split across fragments, the way a provider sends a round
   * whose prose arrives before it decides to call a tool.
   */
  readonly toolCalls?: readonly FakeChatCompletionsToolCall[]
  /** Usage this answer reports. Absent keeps the default counts. */
  readonly usage?: FakeChatCompletionsUsage
  /**
   * The answer's `finish_reason`, streamed or not. Absent keeps `tool_calls`
   * for a round with calls and `stop` otherwise.
   */
  readonly finishReason?: string
  /**
   * Streamed only: raw SSE bytes sent after the deltas in place of the
   * terminal chunk, the way a provider fails part-way through an HTTP 200
   * response. `hold` then keeps the response open, as a provider may, so only
   * the client can close the connection; `end` closes it from this side.
   */
  readonly streamFailure?: {
    readonly bytes: string
    readonly then: 'hold' | 'end'
  }
  /**
   * Claim this turn only for requests the predicate accepts.
   *
   * Ordering alone is fragile: one logical reply can produce more than one
   * request (a tool-loop attempt that finds no tools, then the real call), so a
   * per-speaker claim keyed on position would silently answer the wrong one.
   */
  readonly match?: (request: FakeChatCompletionsRequest) => boolean
}

export interface FakeChatCompletionsToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: Readonly<Record<string, unknown>>
}

export interface FakeChatCompletionsUsage {
  readonly promptTokens: number
  readonly completionTokens: number
}

export interface FakeChatCompletionsOptions {
  /**
   * Answers for incoming requests.
   *
   * A turn carrying `match` claims the first request its predicate accepts, in
   * script order, and is then spent. Turns without `match` are positional and
   * the last such turn is reused once they run out — so a caller can describe
   * the requests it cares about and let everything else fall through.
   */
  readonly script: readonly FakeChatCompletionsTurn[]
  /**
   * Model ids listed at `GET …/models`, so a configured connection can be
   * validated against this server. Absent keeps that path a 404.
   */
  readonly models?: readonly string[]
}

/**
 * Whether a request is the app's own provider health probe.
 *
 * The desktop's Run agent picker and Create sidebar each check the providers
 * their Agents use when they mount (`domains/agent-generator/provider-health.ts`),
 * and an Agent that inherits the app default is checked against that default.
 * In a desktop journey the default is usually this fixture, so the probes land
 * here beside the requests a journey is about. This matches that exact shape
 * and nothing else, so a test that leaves probes out still counts every other
 * request.
 */
export function isProviderHealthProbe(request: FakeChatCompletionsRequest): boolean {
  return request.systemPrompt === 'Health check. Reply with OK only.' && request.userMessage === 'OK' && request.toolCount === 0
}

/**
 * A deterministic OpenAI-compatible Chat Completions endpoint on a random port.
 *
 * Request-aware on purpose. Two different callers reach it: the configured
 * provider asks for `stream: true` and reads SSE, while the MCP tool-loop
 * adapter posts a non-streaming request and parses JSON. A fixture that always
 * answered one way would silently misrepresent one of them. Scripting per
 * request is what lets a multi-speaker turn give each speaker its own answer —
 * replaying one delta array for every request would make any per-speaker claim
 * false.
 */
export async function startFakeChatCompletionsServer(
  options: FakeChatCompletionsOptions,
): Promise<FakeChatCompletionsServer> {
  const requests: FakeChatCompletionsRequest[] = []
  const claimed = new Set<number>()
  const closedByClient = new Set<number>()
  let closing = false

  const server = http.createServer((req, res) => {
    if (
      options.models &&
      req.method === 'GET' &&
      /\/models(?:\?.*)?$/.test(req.url ?? '')
    ) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          object: 'list',
          data: options.models.map((id) => ({ id, object: 'model' })),
        }),
      )
      return
    }
    if (!req.url?.includes('/chat/completions')) {
      res.statusCode = 404
      res.end('{}')
      return
    }

    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const parsed = safeParse(Buffer.concat(chunks).toString('utf8'))
      const described = describeRequest(parsed)
      const index = requests.length
      requests.push(described)
      // The socket's own events, not the response's `close`: a FIN or a reset
      // is read the moment it arrives, while `close` waits for the server's
      // half of the shutdown.
      const socket = req.socket
      const markClosed = (): void => {
        if (!closing && !res.writableEnded) closedByClient.add(index)
      }
      const events = ['end', 'error', 'close'] as const
      for (const event of events) socket.once(event, markClosed)
      res.once('finish', () => {
        for (const event of events) socket.off(event, markClosed)
      })
      const turn = selectTurn(options.script, described, claimed, index)
      void respond(res, turn, described.stream)
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Fake provider failed to bind')
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    closedByClient: (index) => closedByClient.has(index),
    close: () =>
      new Promise<void>((resolve) => {
        closing = true
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

async function respond(
  res: http.ServerResponse,
  turn: FakeChatCompletionsTurn,
  streaming: boolean,
): Promise<void> {
  if (turn.failStatus !== undefined) {
    if (turn.gate) await turn.gate
    res.writeHead(turn.failStatus, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'fake upstream failure' } }))
    return
  }

  const deltas = turn.deltas ?? (turn.content === undefined ? [] : [turn.content])
  const whole = turn.content ?? deltas.join('')
  const toolCalls = turn.toolCalls ?? []
  const finishReason = turn.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop')
  const usage = turn.usage
    ? usageBody(turn.usage)
    : streaming
      ? {
          prompt_tokens: 7,
          completion_tokens: deltas.length,
          total_tokens: 7 + deltas.length,
        }
      : {
          prompt_tokens: 7,
          completion_tokens: deltas.length || 1,
          total_tokens: 8,
        }

  // The request decides the shape of the answer, not the fixture's preference.
  if (!streaming) {
    if (turn.gate) await turn.gate
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        model: 'fake/model',
        choices: [
          {
            message:
              toolCalls.length > 0
                ? {
                    role: 'assistant',
                    content: whole === '' ? null : whole,
                    tool_calls: toolCalls.map((call) => ({
                      id: call.id,
                      type: 'function',
                      function: {
                        name: call.name,
                        arguments: JSON.stringify(call.arguments),
                      },
                    })),
                  }
                : { role: 'assistant', content: whole },
            finish_reason: finishReason,
          },
        ],
        usage,
      }),
    )
    return
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })

  // A client that stopped reading (a byte bound, a cancellation) closes the
  // socket; the rest of the script is then written nowhere rather than into a
  // destroyed stream.
  const write = (data: string): void => {
    if (!res.destroyed) res.write(data)
  }

  const chunk = (delta: Record<string, unknown>): string =>
    `data: ${JSON.stringify({
      id: 'fake-1',
      object: 'chat.completion.chunk',
      model: 'fake/model',
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`

  for (const [index, text] of deltas.entries()) {
    const deltaGate = turn.deltaGates?.[index]
    if (deltaGate) await deltaGate
    write(chunk({ content: text }))
  }
  for (const [index, call] of toolCalls.entries()) {
    write(
      chunk({
        tool_calls: [
          {
            index,
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: '' },
          },
        ],
      }),
    )
    const encoded = JSON.stringify(call.arguments)
    const middle = Math.ceil(encoded.length / 2)
    for (const fragment of [encoded.slice(0, middle), encoded.slice(middle)]) {
      write(chunk({ tool_calls: [{ index, function: { arguments: fragment } }] }))
    }
  }
  if (turn.gate) await turn.gate
  if (res.destroyed) return

  if (turn.streamFailure) {
    write(turn.streamFailure.bytes)
    if (turn.streamFailure.then === 'end') res.end()
    return
  }

  write(
    `data: ${JSON.stringify({
      id: 'fake-1',
      object: 'chat.completion.chunk',
      model: 'fake/model',
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage,
    })}\n\n`,
  )
  write('data: [DONE]\n\n')
  res.end()
}

function usageBody(usage: FakeChatCompletionsUsage): {
  readonly prompt_tokens: number
  readonly completion_tokens: number
  readonly total_tokens: number
} {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.promptTokens + usage.completionTokens,
  }
}

function safeParse(body: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined
    }
    return { ...parsed }
  } catch {
    return undefined
  }
}

function describeRequest(
  body: Record<string, unknown> | undefined,
): FakeChatCompletionsRequest {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const roleContent = (role: string): string | undefined => {
    for (const entry of messages) {
      if (typeof entry !== 'object' || entry === null) continue
      const record: Record<string, unknown> = { ...entry }
      if (record.role === role && typeof record.content === 'string') {
        return record.content
      }
    }
    return undefined
  }
  return {
    model: typeof body?.model === 'string' ? body.model : undefined,
    stream: body?.stream === true,
    systemPrompt: roleContent('system'),
    userMessage: roleContent('user'),
    toolCount: Array.isArray(body?.tools) ? body.tools.length : 0,
    body: body ?? {},
  }
}

/**
 * Pick the answer for one request: the first unclaimed turn whose predicate
 * accepts it, else the turn at this request's position, else the last one.
 */
function selectTurn(
  script: readonly FakeChatCompletionsTurn[],
  request: FakeChatCompletionsRequest,
  claimed: Set<number>,
  index: number,
): FakeChatCompletionsTurn {
  for (const [position, turn] of script.entries()) {
    if (!turn.match || claimed.has(position)) continue
    if (turn.match(request)) {
      claimed.add(position)
      return turn
    }
  }
  const positional = script[index]
  if (positional && !positional.match) return positional
  return script.filter((turn) => !turn.match).at(-1) ?? {}
}
