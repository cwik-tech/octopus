import { afterEach, expect, test, vi } from 'vitest'
import type { AgentDialogueEvent, AgentDialogueRecord } from '@contracts/agent-dialogue'

import { getAgentDialogue, interjectAgentDialogue, listAgentDialogues, openAgentDialogueEvents, pauseAgentDialogue, resumeAgentDialogue, startAgentDialogue, stopAgentDialogue } from '../agent-dialogue-client'

const sessionId = '11111111-1111-4111-8111-111111111111'
const dialogueId = '22222222-2222-4222-8222-222222222222'

function makeDialogue(): AgentDialogueRecord {
  return {
    schemaVersion: 1, dialogueId, sessionId, topic: 'Compare the proposal',
    participants: [
      { id: 'reviewer', label: 'Reviewer', consecutiveFailures: 0, active: true },
      { id: 'builder', label: 'Builder', consecutiveFailures: 0, active: true },
    ],
    delivery: 'text', limits: { maxTurns: 12, runningMs: 0 }, status: 'running',
    nextSlot: 0, replyCount: 0, passStreak: 0, nextSpeaker: 0, epoch: 0,
    ownerLaunchId: '33333333-3333-4333-8333-333333333333',
    createdAt: '2026-10-09T12:00:00.000Z', updatedAt: '2026-10-09T12:00:00.000Z',
    stopRequested: false, events: [],
  }
}

afterEach(() => { vi.unstubAllGlobals() })

// Replace the renderer's HTTP boundary because no desktop API is running in
// jsdom. The Electron journey pairs this with the real local API and stores.
test('starting a text dialogue sends the selected Agents and returns its validated record', async () => {
  const record = makeDialogue()
  const fetchBoundary = vi.fn<typeof fetch>().mockResolvedValue(Response.json(record, { status: 202 }))
  vi.stubGlobal('fetch', fetchBoundary)

  expect(await startAgentDialogue(sessionId, {
    agents: ['reviewer', 'builder'], topic: record.topic, delivery: 'text', maxTurns: 12,
  })).toEqual(record)
  const request = fetchBoundary.mock.calls[0]
  expect(request?.[0]).toBe(`/api/sessions/${sessionId}/dialogues`)
  expect(request?.[1]?.method).toBe('POST')
  expect(request?.[1]?.body).toBe(JSON.stringify({ agents: ['reviewer', 'builder'], topic: record.topic, delivery: 'text', maxTurns: 12 }))
  expect(request?.[1]?.signal).toBeInstanceOf(AbortSignal)
})

test('lists dialogue records and refuses a record belonging to another session', async () => {
  const record = makeDialogue()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ dialogues: [record] })))
  expect(await listAgentDialogues(sessionId)).toEqual([record])

  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...record, sessionId: '44444444-4444-4444-8444-444444444444' })))
  await expect(getAgentDialogue(sessionId, dialogueId)).rejects.toThrow('another session')
})

test('rejects malformed dialogue records at the HTTP boundary', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...makeDialogue(), replyCount: -1 })))
  await expect(getAgentDialogue(sessionId, dialogueId)).rejects.toThrow('Invalid API response')
})

test('reads split lifecycle frames in order and stops on the final event', async () => {
  const events: AgentDialogueEvent[] = [
    { sequence: 0, type: 'started', createdAt: '2026-10-09T12:00:00.000Z' },
    { sequence: 1, type: 'turn_saved', createdAt: '2026-10-09T12:00:01.000Z', messageId: 'reply-1', slot: 0 },
    { sequence: 2, type: 'ended', createdAt: '2026-10-09T12:00:02.000Z', status: 'ended', endReason: 'passes' },
  ]
  const wire = events.map((event) => `id: ${event.sequence}\r\nevent: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join('')
  const encoder = new TextEncoder()
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(encoder.encode(wire.slice(0, 73)))
    controller.enqueue(encoder.encode(wire.slice(73)))
    controller.close()
  } }))
  const fetchBoundary = vi.fn<typeof fetch>().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchBoundary)
  const received: AgentDialogueEvent[] = []

  await openAgentDialogueEvents({ sessionId, dialogueId, signal: new AbortController().signal, onEvent: (event) => received.push(event) })

  expect(received).toEqual(events)
  expect(fetchBoundary).toHaveBeenCalledExactlyOnceWith(`/api/sessions/${sessionId}/dialogues/${dialogueId}/events?from=0`, expect.anything())
  expect(fetchBoundary.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
})

test('resumes a dropped lifecycle stream after the last event without replaying it', async () => {
  const first: AgentDialogueEvent = { sequence: 0, type: 'started', createdAt: '2026-10-09T12:00:00.000Z' }
  const end: AgentDialogueEvent = { sequence: 1, type: 'ended', createdAt: '2026-10-09T12:00:01.000Z', status: 'ended', endReason: 'passes' }
  const fetchBoundary = vi.fn()
    .mockResolvedValueOnce(new Response(`data: ${JSON.stringify(first)}\n\n`))
    .mockResolvedValueOnce(new Response(`data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(end)}\n\n`))
  vi.stubGlobal('fetch', fetchBoundary)
  const received: AgentDialogueEvent[] = []

  await openAgentDialogueEvents({ sessionId, dialogueId, signal: new AbortController().signal, onEvent: (event) => received.push(event) })

  expect(received).toEqual([first, end])
  expect(fetchBoundary).toHaveBeenNthCalledWith(2, `/api/sessions/${sessionId}/dialogues/${dialogueId}/events?from=1`, expect.anything())
})

test.each([
  { label: 'connection timeout', fault: new DOMException('Connection expired', 'TimeoutError') },
  { label: 'network reset', fault: new TypeError('Network connection reset') },
])('resumes lifecycle delivery after a $label without replaying the saved cursor', async ({ fault }) => {
  const first: AgentDialogueEvent = { sequence: 0, type: 'started', createdAt: '2026-10-09T12:00:00.000Z' }
  const end: AgentDialogueEvent = { sequence: 1, type: 'ended', createdAt: '2026-10-09T12:00:01.000Z', status: 'ended', endReason: 'passes' }
  const encoder = new TextEncoder()
  let pulls = 0
  const interrupted = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (pulls++ === 0) controller.enqueue(encoder.encode(`data: ${JSON.stringify(first)}\n\n`))
    else controller.error(fault)
  } }))
  const fetchBoundary = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(interrupted)
    .mockResolvedValueOnce(new Response(`data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(end)}\n\n`))
  vi.stubGlobal('fetch', fetchBoundary)
  const received: AgentDialogueEvent[] = []

  await openAgentDialogueEvents({ sessionId, dialogueId, signal: new AbortController().signal, onEvent: (event) => received.push(event) })

  expect(received).toEqual([first, end])
  expect(fetchBoundary).toHaveBeenNthCalledWith(2, `/api/sessions/${sessionId}/dialogues/${dialogueId}/events?from=1`, expect.anything())
})

test.each(['TimeoutError', 'AbortError'])('connection rotation reported as %s during a long pause does not exhaust the network retry budget', async (errorName) => {
  const end: AgentDialogueEvent = { sequence: 0, type: 'ended', createdAt: '2026-10-09T12:00:01.000Z', status: 'ended', endReason: 'passes' }
  const fetchBoundary = vi.fn<typeof fetch>()
  const timeout = new DOMException('Connection expired', errorName)
  // Seven expected connection rotations exceed the five genuine-drop retries.
  fetchBoundary.mockRejectedValueOnce(timeout).mockRejectedValueOnce(timeout).mockRejectedValueOnce(timeout)
    .mockRejectedValueOnce(timeout).mockRejectedValueOnce(timeout).mockRejectedValueOnce(timeout).mockRejectedValueOnce(timeout)
    .mockResolvedValueOnce(new Response(`data: ${JSON.stringify(end)}\n\n`))
  vi.stubGlobal('fetch', fetchBoundary)
  const received: AgentDialogueEvent[] = []

  await openAgentDialogueEvents({ sessionId, dialogueId, signal: new AbortController().signal, onEvent: (event) => received.push(event) })

  expect(received).toEqual([end])
  expect(fetchBoundary).toHaveBeenCalledTimes(8)
})

test('a persistent network failure reports disconnection after bounded retries', async () => {
  const fault = new TypeError('Network unreachable')
  const fetchBoundary = vi.fn<typeof fetch>().mockRejectedValue(fault)
  vi.stubGlobal('fetch', fetchBoundary)

  await expect(openAgentDialogueEvents({ sessionId, dialogueId, signal: new AbortController().signal, onEvent: () => undefined }))
    .rejects.toThrow('Dialogue event stream disconnected')
  expect(fetchBoundary).toHaveBeenCalledTimes(6)
})

test('cancelling lifecycle delivery never reconnects the cancelled view', async () => {
  const controller = new AbortController()
  const fetchBoundary = vi.fn<typeof fetch>().mockImplementation(async () => {
    controller.abort()
    throw new DOMException('View closed', 'AbortError')
  })
  vi.stubGlobal('fetch', fetchBoundary)

  await openAgentDialogueEvents({ sessionId, dialogueId, signal: controller.signal, onEvent: () => undefined })

  expect(fetchBoundary).toHaveBeenCalledTimes(1)
})

test('a consumer callback failure is propagated instead of being mistaken for a network retry', async () => {
  const event: AgentDialogueEvent = { sequence: 0, type: 'started', createdAt: '2026-10-09T12:00:00.000Z' }
  const fetchBoundary = vi.fn<typeof fetch>().mockResolvedValue(new Response(`data: ${JSON.stringify(event)}\n\n`))
  vi.stubGlobal('fetch', fetchBoundary)
  const fault = new TypeError('Consumer failed')

  await expect(openAgentDialogueEvents({ sessionId, dialogueId, signal: new AbortController().signal, onEvent: () => { throw fault } })).rejects.toBe(fault)
  expect(fetchBoundary).toHaveBeenCalledTimes(1)
})

test('refuses an unreadable lifecycle event instead of presenting an invalid state', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"sequence":-1,"type":"ended"}\n\n')))
  await expect(openAgentDialogueEvents({ sessionId, dialogueId, signal: new AbortController().signal, onEvent: () => undefined })).rejects.toThrow('Invalid API response')
})

test('reports a session claim refusal from the API', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'dialogue_active' }, { status: 409 })))
  await expect(startAgentDialogue(sessionId, { agents: ['reviewer', 'builder'], topic: 'Compare', delivery: 'text', maxTurns: 12 })).rejects.toThrow('dialogue_active')
})


test('Stop addresses the exact dialogue and validates its stopped record', async () => {
  const stopped: AgentDialogueRecord = { ...makeDialogue(), status: 'stopped', endReason: 'stopped', stopRequested: true }
  const fetchBoundary = vi.fn<typeof fetch>().mockResolvedValue(Response.json(stopped))
  vi.stubGlobal('fetch', fetchBoundary)

  expect(await stopAgentDialogue(sessionId, dialogueId)).toEqual(stopped)

  const request = fetchBoundary.mock.calls[0]
  expect(request?.[0]).toBe(`/api/sessions/${sessionId}/dialogues/${dialogueId}/stop`)
  expect(request?.[1]?.method).toBe('POST')
  expect(request?.[1]?.signal).toBeInstanceOf(AbortSignal)
})

test('an interjection sends its replay identity and text to the exact dialogue', async () => {
  const record = makeDialogue()
  const fetchBoundary = vi.fn<typeof fetch>().mockResolvedValue(Response.json(record))
  vi.stubGlobal('fetch', fetchBoundary)

  expect(await interjectAgentDialogue(sessionId, dialogueId, { messageId: 'message-1', text: 'Compare the costs.' })).toEqual(record)

  const request = fetchBoundary.mock.calls[0]
  expect(request?.[0]).toBe(`/api/sessions/${sessionId}/dialogues/${dialogueId}/interjections`)
  expect(request?.[1]?.method).toBe('POST')
  expect(request?.[1]?.body).toBe(JSON.stringify({ messageId: 'message-1', text: 'Compare the costs.' }))
  expect(request?.[1]?.signal).toBeInstanceOf(AbortSignal)
})

test('refuses an interjection with no words before sending it', async () => {
  const fetchBoundary = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetchBoundary)

  await expect(interjectAgentDialogue(sessionId, dialogueId, { messageId: 'message-1', text: '  ' })).rejects.toThrow()
  expect(fetchBoundary).not.toHaveBeenCalled()
})

test('a control response for another dialogue cannot replace this one', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...makeDialogue(), dialogueId: '44444444-4444-4444-8444-444444444444' })))

  await expect(stopAgentDialogue(sessionId, dialogueId)).rejects.toThrow('another dialogue')
})


test.each([
  { action: 'pause', run: pauseAgentDialogue, status: 'paused' as const },
  { action: 'resume', run: resumeAgentDialogue, status: 'running' as const },
])('$action addresses the exact dialogue and validates its updated status', async ({ action, run, status }) => {
  const record: AgentDialogueRecord = { ...makeDialogue(), status }
  const fetchBoundary = vi.fn<typeof fetch>().mockResolvedValue(Response.json(record))
  vi.stubGlobal('fetch', fetchBoundary)

  expect(await run(sessionId, dialogueId)).toEqual(record)

  const request = fetchBoundary.mock.calls[0]
  expect(request?.[0]).toBe(`/api/sessions/${sessionId}/dialogues/${dialogueId}/${action}`)
  expect(request?.[1]?.method).toBe('POST')
  expect(request?.[1]?.signal).toBeInstanceOf(AbortSignal)
})
