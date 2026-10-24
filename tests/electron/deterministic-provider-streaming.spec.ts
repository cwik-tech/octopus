/**
 * The deterministic provider's streamed Chat Completions answer.
 *
 * An Agent or Team turn on a connection asks for its answering request with
 * `stream: true` on `/chat/completions`. The Team streaming journeys have to
 * observe that answer growing while the turn is still open, so the fixture
 * holds everything after the first suffix until `releaseHeldChunks()`, and the
 * frames that end the answer until `releaseTerminal()`. As in the blocking
 * spec, "still held" is observed against full round trips on the same server,
 * not against a delay.
 */
import { expect, test } from '@playwright/test'

import { startDeterministicOpenAiServer } from './support/deterministic-openai-server.js'

const OPENING = 'The first tradeoff'
const REST = ' is portability.'

interface FrameStream {
  readonly frames: readonly string[]
  /** Resolves once the frames read so far satisfy `predicate`. */
  readonly until: (predicate: (frames: readonly string[]) => boolean) => Promise<void>
  /** Resolves when the response body ends. */
  readonly ended: Promise<void>
}

function readFrames(body: ReadableStream<Uint8Array>): FrameStream {
  const frames: string[] = []
  const waiters = new Set<{
    readonly predicate: (frames: readonly string[]) => boolean
    readonly resolve: () => void
    readonly reject: (error: Error) => void
  }>()
  const settleWaiters = (ended: boolean): void => {
    for (const waiter of [...waiters]) {
      if (waiter.predicate(frames)) {
        waiters.delete(waiter)
        waiter.resolve()
      } else if (ended) {
        waiters.delete(waiter)
        waiter.reject(new Error(`The stream ended without the awaited frames: ${JSON.stringify(frames)}`))
      }
    }
  }
  const ended = (async () => {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        frames.push(buffer.slice(0, boundary).replace(/^data: /, ''))
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
      }
      settleWaiters(false)
    }
    settleWaiters(true)
  })()
  return {
    frames,
    until: (predicate) =>
      predicate(frames)
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            waiters.add({ predicate, resolve, reject })
          }),
    ended,
  }
}

interface ChunkChoice {
  readonly delta?: { readonly content?: string }
  readonly finish_reason?: string | null
}

function choices(frames: readonly string[]): ChunkChoice[] {
  return frames
    .filter((frame) => frame !== '[DONE]')
    .flatMap((frame) => {
      const parsed: unknown = JSON.parse(frame)
      if (typeof parsed !== 'object' || parsed === null || !('choices' in parsed)) return []
      const list: unknown = parsed.choices
      return Array.isArray(list) ? list.filter((item): item is ChunkChoice => typeof item === 'object' && item !== null) : []
    })
}

function content(frames: readonly string[]): string {
  return choices(frames).map((choice) => choice.delta?.content ?? '').join('')
}

function finishReasons(frames: readonly string[]): string[] {
  return choices(frames).flatMap((choice) => (choice.finish_reason ? [choice.finish_reason] : []))
}

/** A whole request and response on the same server, used as the observation point. */
async function roundTrip(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4-mini',
      messages: [{ role: 'user', content: 'Name this session from its brief.' }],
    }),
  })
  const payload: unknown = await response.json()
  const [choice] = choices([JSON.stringify(payload)])
  return (choice && 'message' in choice && typeof choice.message === 'object' && choice.message !== null && 'content' in choice.message && typeof choice.message.content === 'string')
    ? choice.message.content
    : ''
}

test('a streamed Chat Completions answer stops at its held suffix and at its held terminal until each is released', async () => {
  const provider = await startDeterministicOpenAiServer({
    matchers: [
      { match: 'You are line-one', text: `${OPENING}${REST}`, chunks: [OPENING, REST] },
      { match: 'Name this session', text: 'Tradeoffs' },
    ],
  })
  try {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        stream: true,
        tool_choice: 'none',
        messages: [
          { role: 'system', content: 'You are line-one. Complete your assigned step.' },
          { role: 'user', content: 'summarize these tradeoffs' },
        ],
      }),
    })
    expect(response.status).toBe(200)
    if (!response.body) throw new Error('The streamed answer has no body.')
    const stream = readFrames(response.body)

    // The opening suffix arrives, and nothing after it while held.
    await stream.until((frames) => content(frames).includes(OPENING))
    expect(await roundTrip(provider.baseUrl)).toBe('Tradeoffs')
    expect(content(stream.frames)).toBe(OPENING)
    expect(finishReasons(stream.frames)).toEqual([])

    // Released, the rest of the answer arrives, but the answer is still open.
    provider.releaseHeldChunks()
    await stream.until((frames) => content(frames) === `${OPENING}${REST}`)
    expect(await roundTrip(provider.baseUrl)).toBe('Tradeoffs')
    expect(finishReasons(stream.frames)).toEqual([])
    expect(stream.frames).not.toContain('[DONE]')

    // Released, the terminal frames end it.
    provider.releaseTerminal()
    await stream.ended
    expect(content(stream.frames)).toBe(`${OPENING}${REST}`)
    expect(finishReasons(stream.frames)).toEqual(['stop'])
    expect(stream.frames.at(-1)).toBe('[DONE]')
  } finally {
    await provider.close()
  }
})
