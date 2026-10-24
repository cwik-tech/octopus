import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  fetchArtifact,
  fetchExcelWorkbookPreview,
  fetchRunEventsSnapshot,
  fetchRunDiagnostics,
  fetchRunTeamFlow,
  openRunEventStream,
} from '@/lib/clients/runtime-client'
import type { EngineEventEnvelope } from '@/lib/models/runtime-model'

afterEach(() => {
  vi.restoreAllMocks()
})

test('fetchArtifact encodes run id and nested artifact path segments', async () => {
  const fetchMock = vi.fn(async () => new Response('artifact-body', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)

  await expect(fetchArtifact('run/a?', 'output/report #1.md')).resolves.toBe('artifact-body')

  expect(fetchMock).toHaveBeenCalledWith('/api/runs/run%2Fa%3F/assignments/output/report%20%231.md')
})

test('fetchArtifact preserves a JSON API error message', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ error: 'Artifact access denied' }),
    {
      headers: { 'content-type': 'application/json' },
      status: 403,
      statusText: 'Forbidden',
    },
  )))

  await expect(fetchArtifact('run-a', 'output.md')).rejects.toThrow(
    'Artifact access denied',
  )
})

test('fetchExcelWorkbookPreview requests the encoded workbook preview endpoint', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    hiddenSheetCount: 0,
    schemaVersion: 1,
    sheets: [],
    totalVisibleSheetCount: 0,
    truncated: false,
  }), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  }))
  vi.stubGlobal('fetch', fetchMock)

  await expect(
    fetchExcelWorkbookPreview('run/a?', 'output/risk #1.xlsx'),
  ).resolves.toMatchObject({ schemaVersion: 1, sheets: [] })

  expect(fetchMock).toHaveBeenCalledWith(
    '/api/runs/run%2Fa%3F/assignments/output/risk%20%231.xlsx?preview=workbook',
  )
})

test('fetchRunTeamFlow encodes the run id in the flow endpoint', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    entryLevelId: 'brief-and-draft',
    levels: [],
    runId: 'run/a?',
    team: 'writing-team',
    transitions: [],
  }), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  }))
  vi.stubGlobal('fetch', fetchMock)

  await expect(fetchRunTeamFlow('run/a?')).resolves.toMatchObject({
    runId: 'run/a?',
    team: 'writing-team',
  })

  expect(fetchMock).toHaveBeenCalledWith('/api/runs/run%2Fa%3F/flow')
})

test('fetchRunDiagnostics encodes the run id in the diagnostics endpoint', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    bashRisks: [],
    delegations: { lifecycle: [], state: {} },
    mcp: { audit: [], toolResults: [] },
    transcript: { canonical: [], raw: [] },
  }), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  }))
  vi.stubGlobal('fetch', fetchMock)

  await expect(fetchRunDiagnostics('run/a?')).resolves.toMatchObject({
    bashRisks: [],
    transcript: { canonical: [], raw: [] },
  })

  expect(fetchMock).toHaveBeenCalledWith('/api/runs/run%2Fa%3F/diagnostics')
})

test('openRunEventStream reads event-stream messages and reports live status', async () => {
  const event: EngineEventEnvelope = {
    schema_version: 1,
    timestamp: '2026-05-01T12:00:00.000Z',
    tenant_id: 'local',
    category: 'artifact',
    type: 'artifact.written',
    run_id: 'run-a',
    payload: {
      path: 'output/report.md',
    },
  }
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`: connected\n\nid: 2\nevent: artifact.written\ndata: ${JSON.stringify(event)}\n\n`))
      controller.close()
    },
  })
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(stream, {
    headers: { 'content-type': 'text/event-stream' },
    status: 200,
  }))
  vi.stubGlobal('fetch', fetchMock)

  const statuses: string[] = []
  const events: EngineEventEnvelope[] = []
  const controller = new AbortController()
  await openRunEventStream({
    runId: 'run-a',
    signal: controller.signal,
    onStatus: (status) => statuses.push(status),
    onEvent: (_id, nextEvent) => {
      events.push(nextEvent)
      controller.abort()
    },
  })

  const call = fetchMock.mock.lastCall
  expect(call?.[0]).toBe('/api/runs/run-a/events')
  const { signal, ...init } = call?.[1] ?? {}
  expect(init).toEqual({ headers: { accept: 'text/event-stream' } })
  expect(signal).toBeInstanceOf(AbortSignal)
  expect(statuses).toEqual(['connecting', 'live'])
  expect(events).toEqual([event])
})

test('fetchRunEventsSnapshot rejects a malformed SSE envelope', async () => {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(
        'event: artifact.written\ndata: {"schema_version":1,"category":"artifact","type":"artifact.written","payload":{}}\n\n',
      ))
      controller.close()
    },
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, {
    headers: { 'content-type': 'text/event-stream' },
    status: 200,
  })))

  await expect(fetchRunEventsSnapshot('run-a')).rejects.toThrow(
    'Invalid API response: expected EngineEventEnvelope',
  )
})

test('openRunEventStream treats a malformed envelope as a fatal contract error', async () => {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(
        'id: 1\nevent: runtime.started\ndata: {"schema_version":1,"timestamp":"2026-05-01T12:00:00.000Z","tenant_id":"local","category":"invalid","type":"runtime.started","payload":{}}\n\n',
      ))
      controller.close()
    },
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, {
    headers: { 'content-type': 'text/event-stream' },
    status: 200,
  })))

  await expect(openRunEventStream({
    runId: 'run-a',
    signal: new AbortController().signal,
    onStatus: () => {},
    onEvent: () => {},
  })).rejects.toThrow('Invalid API response: expected EngineEventEnvelope')
})

test('fetchRunEventsSnapshot rejects malformed JSON snapshots', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ events: [{ type: 'runtime.started' }] }),
    {
      headers: { 'content-type': 'application/json' },
      status: 200,
    },
  )))

  await expect(fetchRunEventsSnapshot('run-a')).rejects.toThrow(
    'Invalid API response: expected RunEventsSnapshotResponse',
  )
})

test('openRunEventStream reconnects after EOF from the next event index', async () => {
  const firstEvent: EngineEventEnvelope = {
    schema_version: 1,
    timestamp: '2026-05-01T12:00:00.000Z',
    tenant_id: 'local',
    category: 'runtime',
    type: 'runtime.started',
    run_id: 'run-a',
    payload: {},
  }
  const secondEvent: EngineEventEnvelope = {
    ...firstEvent,
    timestamp: '2026-05-01T12:00:01.000Z',
    type: 'run.completed',
  }
  const encoder = new TextEncoder()
  const responseFor = (id: number, event: EngineEventEnvelope) => new Response(
    new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(encoder.encode(
          `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        ))
        streamController.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' }, status: 200 },
  )
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(responseFor(2, firstEvent))
    .mockResolvedValueOnce(responseFor(3, secondEvent))
  vi.stubGlobal('fetch', fetchMock)

  const controller = new AbortController()
  const receivedTypes: string[] = []
  const statuses: string[] = []
  await openRunEventStream({
    runId: 'run-a',
    signal: controller.signal,
    onStatus: (status) => statuses.push(status),
    onEvent: (_id, event) => {
      receivedTypes.push(event.type)
      if (event.type === 'run.completed') controller.abort()
    },
  })

  expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/runs/run-a/events?from=3', {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  })
  expect(receivedTypes).toEqual(['runtime.started', 'run.completed'])
  expect(statuses).toEqual(['connecting', 'live', 'reconnecting', 'live'])
})

describe('openRunEventStream reconnect schedule', () => {
  type ScriptedReply = () => Promise<Response>

  const networkFailure: ScriptedReply = async () => {
    throw new TypeError('Failed to fetch')
  }
  const notFound: ScriptedReply = async () => new Response(null, {
    status: 404,
    statusText: 'Not Found',
  })
  const okWithoutBody: ScriptedReply = async () => new Response(null, { status: 200 })
  const eventStreamResponse = (chunks: string[]): Response => new Response(
    new ReadableStream<Uint8Array>({
      start(streamController) {
        for (const chunk of chunks) streamController.enqueue(new TextEncoder().encode(chunk))
        streamController.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' }, status: 200 },
  )
  const streamClosingWithoutEvents: ScriptedReply = async () => eventStreamResponse([])
  const streamDeliveringOneEvent: ScriptedReply = async () => {
    const event: EngineEventEnvelope = {
      schema_version: 1,
      timestamp: '2026-05-01T12:00:00.000Z',
      tenant_id: 'local',
      category: 'runtime',
      type: 'runtime.started',
      run_id: 'run-a',
      payload: {},
    }
    return eventStreamResponse([`id: 1\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`])
  }

  // Answers each fetch with the next scripted reply and records the fake-clock
  // time between consecutive attempts. Once the script runs out, the consumer
  // aborts mid-connect, which ends the stream loop without an error.
  function startStreamAgainst(replies: readonly ScriptedReply[]) {
    const controller = new AbortController()
    const waitsBeforeEachRetryMs: number[] = []
    let previousAttemptAt: number | null = null
    let attempts = 0
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => {
      const now = Date.now()
      if (previousAttemptAt !== null) waitsBeforeEachRetryMs.push(now - previousAttemptAt)
      previousAttemptAt = now
      const reply = replies[attempts]
      attempts += 1
      if (reply === undefined) {
        controller.abort()
        throw new DOMException('Aborted', 'AbortError')
      }
      return reply()
    }))

    const stream = openRunEventStream({
      runId: 'run-a',
      signal: controller.signal,
      onStatus: () => {},
      onEvent: () => {},
    })
    return { stream, waitsBeforeEachRetryMs }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('network failures wait 250, 400, 650, 1000, 1500 and 2500 ms, then 5000 ms for every later retry', async () => {
    const { stream, waitsBeforeEachRetryMs } = startStreamAgainst(
      Array.from({ length: 9 }, () => networkFailure),
    )

    await vi.runAllTimersAsync()
    await stream

    expect(waitsBeforeEachRetryMs).toEqual([250, 400, 650, 1000, 1500, 2500, 5000, 5000, 5000])
  })

  test('a run that is not found yet is retried five times on the schedule, then the 404 is thrown', async () => {
    const { stream, waitsBeforeEachRetryMs } = startStreamAgainst(
      Array.from({ length: 6 }, () => notFound),
    )
    const failure = expect(stream).rejects.toThrow('404 Not Found')

    await vi.runAllTimersAsync()
    await failure

    expect(waitsBeforeEachRetryMs).toEqual([250, 400, 650, 1000, 1500])
  })

  test('a run that goes missing after it connected keeps retrying its 404s past five, holding at the 5000 ms cap', async () => {
    const { stream, waitsBeforeEachRetryMs } = startStreamAgainst([
      streamDeliveringOneEvent,
      ...Array.from({ length: 8 }, () => notFound),
    ])

    await vi.runAllTimersAsync()
    await stream

    expect(waitsBeforeEachRetryMs).toEqual([250, 250, 400, 650, 1000, 1500, 2500, 5000, 5000])
  })

  test('ok responses without a body and network failures advance one shared schedule', async () => {
    const { stream, waitsBeforeEachRetryMs } = startStreamAgainst([
      okWithoutBody,
      networkFailure,
      okWithoutBody,
      networkFailure,
      okWithoutBody,
      networkFailure,
      okWithoutBody,
      networkFailure,
      okWithoutBody,
    ])

    await vi.runAllTimersAsync()
    await stream

    expect(waitsBeforeEachRetryMs).toEqual([250, 400, 650, 1000, 1500, 2500, 5000, 5000, 5000])
  })

  test('a stream that delivered an event restarts the schedule at 250 ms, even from the 5000 ms cap', async () => {
    const { stream, waitsBeforeEachRetryMs } = startStreamAgainst([
      ...Array.from({ length: 7 }, () => networkFailure),
      streamDeliveringOneEvent,
      networkFailure,
      networkFailure,
    ])

    await vi.runAllTimersAsync()
    await stream

    expect(waitsBeforeEachRetryMs).toEqual([250, 400, 650, 1000, 1500, 2500, 5000, 250, 250, 400])
  })

  test('a stream that closes without an event keeps climbing the schedule, starting at 400 ms', async () => {
    const { stream, waitsBeforeEachRetryMs } = startStreamAgainst(
      Array.from({ length: 7 }, () => streamClosingWithoutEvents),
    )

    await vi.runAllTimersAsync()
    await stream

    expect(waitsBeforeEachRetryMs).toEqual([400, 650, 1000, 1500, 2500, 5000, 5000])
  })
})
