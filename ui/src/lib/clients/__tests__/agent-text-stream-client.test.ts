import { afterEach, expect, test, vi } from 'vitest'

import { openAgentTextStream } from '@/lib/clients/session-client'
import { openAgentTextStreamAt } from '@/lib/clients/agent-text-stream-client'
import type { AgentTextStreamDelivery } from '@contracts/agent-text-stream'

afterEach(() => {
  vi.restoreAllMocks()
  // `restoreAllMocks` does not undo `stubGlobal`. Without this the stubbed
  // `fetch` survives into the next test, which then spies on the stub and sees
  // its call count carried over.
  vi.unstubAllGlobals()
})

/** A channel that finished, marked the way the route marks one. */
function completedSseResponse(blocks: readonly string[]): Response {
  return sseResponse([...blocks, ': channel-complete\n\n'])
}

function sseResponse(blocks: readonly string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(block))
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function frame(id: number | undefined, delivery: AgentTextStreamDelivery): string {
  const idLine = id === undefined ? '' : `id: ${id}\n`
  return `${idLine}event: ${delivery.type}\ndata: ${JSON.stringify(delivery)}\n\n`
}

function delta(cursor: number, text: string): AgentTextStreamDelivery {
  return {
    type: 'delta',
    channelId: 'channel-1',
    cursor,
    replyId: 'speaker-a:0',
    channel: 'text',
    text,
  }
}

test('delivers each frame to the caller in order', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      completedSseResponse([
        ': connected\n\n',
        frame(0, delta(0, 'Hel')),
        frame(1, delta(1, 'lo')),
        frame(2, {
          type: 'final',
          channelId: 'channel-1',
          cursor: 2,
          replyId: 'speaker-a:0',
          reason: 'completed',
        }),
      ]),
    ),
  )

  const received: AgentTextStreamDelivery[] = []
  await openAgentTextStream({
    sessionId: 'session-1',
    channelId: 'channel-1',
    signal: new AbortController().signal,
    onDelivery: (delivery) => received.push(delivery),
  })

  expect(received.map((entry) => entry.type)).toEqual(['delta', 'delta', 'final'])
  expect(received.filter((entry) => entry.type === 'delta').map((entry) => 'text' in entry ? entry.text : '')).toEqual(['Hel', 'lo'])
})

test('resumes from the cursor after the last framed delivery', async () => {
  const urls: string[] = []
  let call = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input))
      call += 1
      if (call === 1) {
        // Ends without a terminal frame, as a dropped connection would.
        return sseResponse([frame(0, delta(0, 'Hel')), frame(1, delta(1, 'lo'))])
      }
      return completedSseResponse([
        frame(2, {
          type: 'final',
          channelId: 'channel-1',
          cursor: 2,
          replyId: 'speaker-a:0',
          reason: 'completed',
        }),
      ])
    }),
  )

  const received: AgentTextStreamDelivery[] = []
  await openAgentTextStream({
    sessionId: 'session-1',
    channelId: 'channel-1',
    signal: new AbortController().signal,
    onDelivery: (delivery) => received.push(delivery),
  })

  expect(urls[0]).toContain('from=0')
  expect(urls[1]).toContain('from=2')
  expect(received.at(-1)?.type).toBe('final')
})

test('a caller that has already heard part of a channel resumes where it left off', async () => {
  // A subscriber that reconnects after hearing some of a channel must not be
  // sent what it already showed. Asking from zero replays every retained frame,
  // and a reply that had streamed one suffix renders it twice.
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return completedSseResponse([
        frame(5, {
          type: 'final',
          channelId: 'channel-1',
          cursor: 5,
          replyId: 'speaker-a:0',
          reason: 'completed',
        }),
      ])
    }),
  )

  await openAgentTextStreamAt({
    path: '/create/resource-architect/turn',
    channelId: 'channel-1',
    signal: new AbortController().signal,
    onDelivery: () => undefined,
    fromCursor: 5,
  })

  expect(urls[0]).toContain('from=5')
  expect(urls[0]).not.toContain('from=0')
})

test('a reset carries no id and must not advance the resume cursor', async () => {
  const urls: string[] = []
  let call = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input))
      call += 1
      if (call === 1) {
        return sseResponse([
          frame(undefined, {
            type: 'reset',
            channelId: 'channel-1',
            requestedFromCursor: 0,
            retainedFromCursor: 100,
            reason: 'evicted',
          }),
        ])
      }
      return completedSseResponse([
        frame(100, {
          type: 'final',
          channelId: 'channel-1',
          cursor: 100,
          replyId: 'speaker-a:0',
          reason: 'completed',
        }),
      ])
    }),
  )

  const received: AgentTextStreamDelivery[] = []
  await openAgentTextStream({
    sessionId: 'session-1',
    channelId: 'channel-1',
    signal: new AbortController().signal,
    onDelivery: (delivery) => received.push(delivery),
  })

  expect(received[0]?.type).toBe('reset')
  expect(urls[1]).toContain('from=0')
})

test('a malformed frame is skipped rather than killing the stream', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      completedSseResponse([
        'id: 0\nevent: delta\ndata: {not json\n\n',
        'id: 1\nevent: delta\ndata: {"type":"delta"}\n\n',
        frame(2, delta(2, 'survived')),
        frame(3, {
          type: 'final',
          channelId: 'channel-1',
          cursor: 3,
          replyId: 'speaker-a:0',
          reason: 'completed',
        }),
      ]),
    ),
  )

  const received: AgentTextStreamDelivery[] = []
  await openAgentTextStream({
    sessionId: 'session-1',
    channelId: 'channel-1',
    signal: new AbortController().signal,
    onDelivery: (delivery) => received.push(delivery),
  })

  expect(received.map((entry) => entry.type)).toEqual(['delta', 'final'])
  expect(received[0] && 'text' in received[0] ? received[0].text : '').toBe('survived')
})

test('a 404 ends the stream without retrying', async () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 404 }))
  vi.stubGlobal('fetch', fetchMock)

  await openAgentTextStream({
    sessionId: 'session-1',
    channelId: 'channel-1',
    signal: new AbortController().signal,
    onDelivery: () => {
      throw new Error('nothing should be delivered')
    },
  })

  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('an aborted signal stops the stream', async () => {
  const controller = new AbortController()
  controller.abort()
  const fetchMock = vi.fn(async () => sseResponse([]))
  vi.stubGlobal('fetch', fetchMock)

  await openAgentTextStream({
    sessionId: 'session-1',
    channelId: 'channel-1',
    signal: controller.signal,
    onDelivery: () => {
      throw new Error('nothing should be delivered')
    },
  })

  expect(fetchMock).not.toHaveBeenCalled()
})

test('the session and channel are encoded into the request path', async () => {
  const urls: string[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return new Response('{}', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)

  await openAgentTextStream({
    sessionId: 'session/1',
    channelId: 'channel 1',
    signal: new AbortController().signal,
    onDelivery: () => {},
  })

  expect(urls[0]).toContain('session%2F1')
  expect(urls[0]).toContain('channel%201')
})

test('repeated transport failures stop at the bounded retry limit', async () => {
  // Every attempt fails the way a dropped connection does. Without counting
  // these, the client retries for as long as the tab is open.
  const fetchMock = vi.fn(async () => {
    throw new TypeError('network down')
  })
  vi.stubGlobal('fetch', fetchMock)

  await openAgentTextStream({
    sessionId: 'session-1',
    channelId: 'channel-1',
    signal: new AbortController().signal,
    onDelivery: () => {
      throw new Error('nothing should be delivered')
    },
  })

  // One initial attempt plus the bounded reconnects, and no more.
  expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(6)
  expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
})

test('a transport failure followed by a clean stream still delivers', async () => {
  let call = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      call += 1
      if (call === 1) throw new TypeError('network down')
      return completedSseResponse([
        frame(0, delta(0, 'recovered')),
        frame(1, {
          type: 'final',
          channelId: 'channel-1',
          cursor: 1,
          replyId: 'speaker-a:0',
          reason: 'completed',
        }),
      ])
    }),
  )

  const received: AgentTextStreamDelivery[] = []
  await openAgentTextStream({
    sessionId: 'session-1',
    channelId: 'channel-1',
    signal: new AbortController().signal,
    onDelivery: (d) => received.push(d),
  })

  expect(received.map((entry) => entry.type)).toEqual(['delta', 'final'])
})

test('the reconnect delay does not accumulate abort listeners', async () => {
  const controller = new AbortController()
  const added: string[] = []
  const removed: string[] = []
  const originalAdd = controller.signal.addEventListener.bind(controller.signal)
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal)
  controller.signal.addEventListener = ((type: string, ...rest: unknown[]) => {
    added.push(type)
    return (originalAdd as (t: string, ...r: unknown[]) => void)(type, ...rest)
  }) as typeof controller.signal.addEventListener
  controller.signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
    removed.push(type)
    return (originalRemove as (t: string, ...r: unknown[]) => void)(type, ...rest)
  }) as typeof controller.signal.removeEventListener

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('network down')
    }),
  )

  await openAgentTextStream({
    sessionId: 'session-1',
    channelId: 'channel-1',
    signal: controller.signal,
    onDelivery: () => {},
  })

  // Each delay that timed out must clean up after itself, or a long-lived
  // stream leaks one listener per retry.
  expect(removed.filter((type) => type === 'abort').length).toBe(
    added.filter((type) => type === 'abort').length,
  )
})

test('a drop after one speaker finishes still resumes the others', async () => {
  // A Team turn carries several replies on one channel. Treating the first
  // reply's `final` as the end of the stream strands every speaker after it:
  // the connection drops, and nothing reconnects because the client believes
  // the turn is over.
  const first = sseResponse([
    frame(0, {
      type: 'delta',
      channelId: 'channel-1',
      cursor: 0,
      replyId: 'speaker-a',
      channel: 'text',
      text: 'from A',
    }),
    frame(1, {
      type: 'final',
      channelId: 'channel-1',
      cursor: 1,
      replyId: 'speaker-a',
      reason: 'completed',
    }),
  ])
  const second = completedSseResponse([
    frame(2, {
      type: 'delta',
      channelId: 'channel-1',
      cursor: 2,
      replyId: 'speaker-b',
      channel: 'text',
      text: 'from B',
    }),
  ])
  const requested: string[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    requested.push(String(input))
    return requested.length === 1 ? first : second
  })

  const delivered: AgentTextStreamDelivery[] = []
  await openAgentTextStream({
    sessionId: 'session-1',
    channelId: 'channel-1',
    signal: new AbortController().signal,
    onDelivery: (delivery) => delivered.push(delivery),
  })

  expect(requested).toHaveLength(2)
  // Resumed from after the last framed delivery, not from the start.
  expect(requested[1]).toContain('from=2')
  expect(
    delivered.some(
      (delivery) => delivery.type === 'delta' && delivery.replyId === 'speaker-b',
    ),
  ).toBe(true)
})

test('a channel that keeps ending without finishing stops at the bounded retry limit', async () => {
  // The counterpart to resuming: a server that closes every connection without
  // ever saying the channel is done must not be retried forever.
  let attempts = 0
  vi.stubGlobal('fetch', async () => {
    attempts += 1
    return sseResponse([frame(0, delta(0, 'partial'))])
  })

  await openAgentTextStream({
    sessionId: 'session-1',
    channelId: 'channel-1',
    signal: new AbortController().signal,
    onDelivery: () => {},
  })

  // One initial attempt plus the bounded retries, and no more.
  expect(attempts).toBe(6)
})
