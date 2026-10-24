import * as http from 'node:http'

/**
 * One scripted assistant turn. A `toolName` turn makes the model call that
 * tool; a `text` turn is a plain reply. Turns are served in order and the
 * server falls back to generic text once the script is exhausted, so a run
 * that takes more turns than scripted degrades instead of hanging.
 */
export type DeterministicTurn =
  | {
      readonly text: string
      /**
       * Deliver the answer as these suffixes rather than in one delta, with
       * everything after the first held until `releaseHeldChunks()`.
       *
       * A single delta cannot show growth: the whole reply arrives in one
       * frame, so a renderer that only paints finished text is
       * indistinguishable from one that streams. Holding the tail is what
       * makes "the text grew while the turn was still running" observable
       * rather than a race against the run finishing.
       */
      readonly chunks?: readonly string[]
    }
  | { readonly toolName: string; readonly arguments?: unknown; readonly followingTools?: readonly { readonly name: string; readonly arguments: unknown }[] }

/**
 * A turn chosen by what the request actually asks for rather than by its
 * position in the queue.
 *
 * A run's request order includes model probes and coordinator turns, so an
 * index-based script cannot name a specific agent's answer without encoding
 * that ordering into the test. Matching on a fragment of the dispatched system
 * prompt lets a test state "this is what line-one says" and stay true when the
 * number of surrounding requests changes.
 */
export interface DeterministicAnswerMatcher {
  /** Literal fragment that must appear in the request body. */
  readonly match: string
  readonly text: string
  /** Optional streamed suffixes, with the tail controlled by the chunk gates. */
  readonly chunks?: readonly string[]
}

export interface DeterministicOpenAiServerOptions {
  /** Select a boundary response by the real request rather than request order. */
  readonly resolveTurn?: (requestBody: string) => DeterministicTurn | undefined
  readonly script?: readonly DeterministicTurn[]
  /** Consulted before the ordered script and never consuming a scripted turn. */
  readonly matchers?: readonly DeterministicAnswerMatcher[]
  readonly blockResponsesStartingAt?: number
  /**
   * Hold every request whose body contains one of these fragments until
   * `releaseBlockedResponses()`.
   *
   * Names the answers to withhold rather than the position they arrive in. A
   * run also issues model probes and a session-title request, and their order
   * around the coordinator's tool turns is not fixed, so an ordinal gate holds
   * whichever request lands in that slot — including one with its own timeout.
   */
  readonly blockRequestsMatching?: readonly string[]
}

/**
 * What a Chat Completions request body says about itself.
 *
 * An Agent turn on a connection is a buffered round that may offer tools,
 * then, once a round answers without tools, the same messages again with
 * `stream: true` and `tool_choice: "none"`: the answer that is shown. A script
 * that claims turns by this, and by the persona its system message carries,
 * does not depend on how many probes or rounds arrive first. A body that is
 * not a Chat Completions request describes as neither.
 */
export function describeChatCompletionsRequest(requestBody: string): {
  readonly systemPrompt: string | undefined
  /** The streamed, tool-free request whose text is shown. */
  readonly streamedAnswer: boolean
  /** A buffered round; its text is planning or a draft the answer replaces. */
  readonly bufferedRound: boolean
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(requestBody)
  } catch {
    return { systemPrompt: undefined, streamedAnswer: false, bufferedRound: false }
  }
  if (typeof parsed !== 'object' || parsed === null || !('messages' in parsed) || !Array.isArray(parsed.messages)) {
    return { systemPrompt: undefined, streamedAnswer: false, bufferedRound: false }
  }
  const system: unknown = parsed.messages.find(
    (message: unknown) => typeof message === 'object' && message !== null && 'role' in message && message.role === 'system',
  )
  const content: unknown = typeof system === 'object' && system !== null && 'content' in system ? system.content : undefined
  const systemPrompt = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part: unknown) => (typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string' ? part.text : '')).join('')
      : undefined
  const streams = 'stream' in parsed && parsed.stream === true
  const toolFree = 'tool_choice' in parsed && parsed.tool_choice === 'none'
  return {
    systemPrompt,
    streamedAnswer: streams && toolFree,
    bufferedRound: !streams,
  }
}

export async function startDeterministicOpenAiServer(
  options: DeterministicOpenAiServerOptions = {},
): Promise<{
  readonly baseUrl: string
  readonly requestCount: () => number
  /**
   * Resolves once this many requests have arrived.
   *
   * A waiter rather than a poll: the server is the thing that knows, so it can
   * say so. Polling would only ever be sampling an answer it already had.
   */
  readonly waitForRequest: (count?: number) => Promise<void>
  readonly remainingTurns: () => number
  /**
   * Resolves once a request whose body contains `fragment` is being held by
   * `blockRequestsMatching` or `blockResponses()`: the server knows the moment
   * it starts holding one, so a journey can wait for that rather than infer it.
   */
  readonly waitForBlockedRequest: (fragment: string) => Promise<void>
  /**
   * Whether a request whose body contains `fragment` is held right now, with
   * no response sent and the client still waiting. False once it is released
   * or the client gives up on it.
   */
  readonly isHoldingRequest: (fragment: string) => boolean
  readonly blockResponses: () => void
  readonly releaseBlockedResponses: () => void
  /** Release the withheld answer suffixes, leaving the turn still open. */
  readonly releaseHeldChunks: () => void
  /**
   * Release the frames that end the turn.
   *
   * Separate from the suffixes so a completed answer can be observed while its
   * dispatch is still running. Released together, the last suffix and the
   * dispatch's end reach the renderer in one paint, and the finished text is
   * never on screen by itself.
   */
  readonly releaseTerminal: () => void
  readonly close: () => Promise<void>
}> {
  let requests = 0
  const requestWaiters = new Set<{ count: number; resolve: () => void }>()
  let responsesReleased =
    options.blockResponsesStartingAt === undefined &&
    options.blockRequestsMatching === undefined
  let responsesBlocked = false
  const blockedResponses = new Set<() => void>()
  // The body of each response being withheld, so the server can say which
  // requests it is holding and wake whoever waits for one.
  const heldBodies = new Map<() => void, string>()
  const blockedWaiters = new Set<{ readonly fragment: string; readonly resolve: () => void }>()
  const heldChunks = new Set<() => void>()
  const heldTerminals = new Set<() => void>()
  let chunksReleased = false
  let terminalReleased = false
  const script = [...(options.script ?? [])]
  let scriptIndex = 0

  const nextTurn = (requestNumber: number, requestBody: string): DeterministicTurn => {
    const resolved = options.resolveTurn?.(requestBody)
    if (resolved) return resolved
    const matched = options.matchers?.find(
      (matcher) => requestBody.includes(matcher.match),
    )
    if (matched) {
      return {
        text: matched.text,
        ...(matched.chunks ? { chunks: matched.chunks } : {}),
      }
    }
    const turn = script[scriptIndex]
    if (turn) {
      scriptIndex += 1
      return turn
    }
    return {
      text: `# Batch result ${requestNumber}\n\nDeterministic file processing completed.`,
    }
  }

  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        data: [{ id: 'gpt-5.4-mini', name: 'Deterministic Batch model', context_length: 32_000 }],
      }))
      return
    }
    if (request.method !== 'POST' || (
      request.url !== '/v1/responses' && request.url !== '/v1/chat/completions'
    )) {
      response.writeHead(404).end('not found')
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      requests += 1
      for (const waiter of [...requestWaiters]) {
        if (requests >= waiter.count) {
          requestWaiters.delete(waiter)
          waiter.resolve()
        }
      }
      const requestNumber = requests
      const rawBody = Buffer.concat(chunks).toString('utf8')
      const body = JSON.parse(rawBody) as {
        readonly model?: string
        readonly stream?: boolean
      }
      const sendResponse = () => {
        blockedResponses.delete(sendResponse)
        heldBodies.delete(sendResponse)
        if (response.destroyed || response.writableEnded) return
        const turn = nextTurn(requestNumber, rawBody)
        const toolCall = 'toolName' in turn
          ? {
              id: `call_${requestNumber}`,
              name: turn.toolName,
              arguments: JSON.stringify(turn.arguments ?? {}),
            }
          : null
        const text = toolCall ? '' : 'text' in turn ? turn.text : ''

        // Writes SSE frames in order, holding the frame at `holdIndex` until
        // `releaseHeldChunks()` and the one at `terminalIndex` until
        // `releaseTerminal()`; -1 holds nothing. Shared by both streamed
        // routes so a test can stage growth the same way on either.
        const writeGatedFrames = (
          frames: readonly string[],
          holdIndex: number,
          terminalIndex: number,
        ): void => {
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

        if (request.url === '/v1/chat/completions' && body.stream) {
          // A displayed chat turn on a connection streams its tool-free
          // answering request. Framed as the strict reader requires: content
          // deltas, a terminal chunk with `finish_reason` and usage, then
          // `[DONE]`. A multi-suffix answer is gated exactly as on the
          // Responses route: everything after the first suffix waits for
          // `releaseHeldChunks()`, and the terminal chunk for
          // `releaseTerminal()`.
          const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
            `data: ${JSON.stringify({
              id: `chatcmpl_${requestNumber}`,
              object: 'chat.completion.chunk',
              model: body.model ?? 'gpt-5.4-mini',
              choices: [{ index: 0, delta, finish_reason: finishReason }],
              ...(finishReason ? { usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } } : {}),
            })}\n\n`
          const answerChunks = !toolCall && 'chunks' in turn && turn.chunks?.length
            ? turn.chunks
            : [text]
          const bodyFrames = toolCall
            ? [chunk({
                tool_calls: [{
                  index: 0,
                  id: toolCall.id,
                  type: 'function',
                  function: { name: toolCall.name, arguments: toolCall.arguments },
                }],
              }, null)]
            : answerChunks.map((delta) => chunk({ content: delta }, null))
          const frames = [
            ...bodyFrames,
            chunk({}, toolCall ? 'tool_calls' : 'stop'),
            'data: [DONE]\n\n',
          ]
          const gated = answerChunks.length > 1 && !toolCall
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          })
          writeGatedFrames(frames, gated ? 1 : -1, gated ? bodyFrames.length : -1)
          return
        }

        if (request.url === '/v1/chat/completions') {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({
            id: `chatcmpl_${requestNumber}`,
            object: 'chat.completion',
            model: body.model ?? 'gpt-5.4-mini',
            choices: [{
              index: 0,
              finish_reason: toolCall ? 'tool_calls' : 'stop',
              message: toolCall
                ? {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                      id: toolCall.id,
                      type: 'function',
                      function: {
                        name: toolCall.name,
                        arguments: toolCall.arguments,
                      },
                    }, ...('followingTools' in turn ? (turn.followingTools ?? []).map((call, index) => ({
                      id: `call_${requestNumber}_${index + 1}`, type: 'function',
                      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                    })) : [])],
                  }
                : { role: 'assistant', content: text },
            }],
            usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
          }))
          return
        }

        const responseId = `resp_${requestNumber}`
        const item = toolCall
          ? {
              id: `fc_${requestNumber}`,
              type: 'function_call',
              status: 'completed',
              call_id: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.arguments,
            }
          : {
              id: `msg_${requestNumber}`,
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text, annotations: [] }],
            }

        if (!body.stream) {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({
            id: responseId,
            model: body.model ?? 'gpt-5.4-mini',
            status: 'completed',
            output: [item],
            ...(toolCall ? {} : { output_text: text }),
            usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
          }))
          return
        }

        const answerChunks =
          !toolCall && turn && 'chunks' in turn && turn.chunks?.length
            ? turn.chunks
            : [text]
        const deltaEvents = answerChunks.map((delta) => ({
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          delta,
        }))
        const events = toolCall
          ? [
              { type: 'response.created', response: { id: responseId } },
              {
                type: 'response.output_item.added',
                output_index: 0,
                item: { ...item, arguments: '' },
              },
              {
                type: 'response.function_call_arguments.delta',
                output_index: 0,
                item_id: item.id,
                delta: toolCall.arguments,
              },
              {
                type: 'response.function_call_arguments.done',
                output_index: 0,
                item_id: item.id,
                arguments: toolCall.arguments,
              },
              { type: 'response.output_item.done', output_index: 0, item },
              {
                type: 'response.completed',
                response: {
                  id: responseId,
                  status: 'completed',
                  output: [item],
                  usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
                },
              },
            ]
          : [
              { type: 'response.created', response: { id: responseId } },
              {
                type: 'response.output_item.added',
                output_index: 0,
                item: { ...item, content: [] },
              },
              {
                type: 'response.content_part.added',
                output_index: 0,
                content_index: 0,
                part: { type: 'output_text', text: '', annotations: [] },
              },
              ...deltaEvents,
              { type: 'response.output_item.done', output_index: 0, item },
              {
                type: 'response.completed',
                response: {
                  id: responseId,
                  status: 'completed',
                  output: [item],
                  usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
                },
              },
            ]

        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        })
        const gated = answerChunks.length > 1 && !toolCall
        writeGatedFrames(
          [...events.map((event) => `data: ${JSON.stringify(event)}\n\n`), 'data: [DONE]\n\n'],
          gated
            ? events.findIndex((event) => event.type === 'response.output_text.delta') + 1
            : -1,
          gated
            ? events.findIndex((event) => event.type === 'response.output_item.done')
            : -1,
        )
      }
      const heldByName =
        options.blockRequestsMatching?.some((fragment) =>
          rawBody.includes(fragment),
        ) ?? false
      if (
        responsesBlocked ||
        (!responsesReleased &&
          (heldByName ||
            (options.blockResponsesStartingAt !== undefined &&
              requestNumber >= options.blockResponsesStartingAt)))
      ) {
        blockedResponses.add(sendResponse)
        heldBodies.set(sendResponse, rawBody)
        response.once('close', () => {
          blockedResponses.delete(sendResponse)
          heldBodies.delete(sendResponse)
        })
        for (const waiter of [...blockedWaiters]) {
          if (rawBody.includes(waiter.fragment)) {
            blockedWaiters.delete(waiter)
            waiter.resolve()
          }
        }
        return
      }
      sendResponse()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Could not resolve deterministic OpenAI server address.')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestCount: () => requests,
    waitForRequest: (count = 1) =>
      requests >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            requestWaiters.add({ count, resolve })
          }),
    remainingTurns: () => Math.max(0, script.length - scriptIndex),
    waitForBlockedRequest: (fragment) =>
      [...heldBodies.values()].some((body) => body.includes(fragment))
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            blockedWaiters.add({ fragment, resolve })
          }),
    isHoldingRequest: (fragment) =>
      [...heldBodies.values()].some((body) => body.includes(fragment)),
    blockResponses: () => {
      responsesBlocked = true
    },
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
      responsesBlocked = false
      for (const sendResponse of [...blockedResponses]) sendResponse()
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Flush anything parked by blockResponses, or close() waits forever.
        for (const sendResponse of [...blockedResponses]) sendResponse()
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}
