import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { AgentDialogueEvent, AgentDialogueRecord } from '@contracts/agent-dialogue'

import { useAgentDialogue } from '../use-agent-dialogue'

const sessionId = '11111111-1111-4111-8111-111111111111'
const dialogueId = '22222222-2222-4222-8222-222222222222'
function makeDialogue(): AgentDialogueRecord {
  return {
    schemaVersion: 1, sessionId, dialogueId, topic: 'Compare the proposal',
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
function makeLifecycle() {
  const encoder = new TextEncoder()
  let push: (event: AgentDialogueEvent) => void = () => { throw new Error('Stream not open') }
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    push = (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
  } })
  return { response: new Response(body), emit: (event: AgentDialogueEvent) => push(event) }
}
function makeTextStream() {
  const encoder = new TextEncoder()
  let push: (text: string) => void = () => { throw new Error('Text stream not open') }
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    push = (text) => controller.enqueue(encoder.encode(text))
  } })
  return { response: new Response(body), emit: (text: string) => push(text) }
}
afterEach(() => vi.unstubAllGlobals())

// The hook uses the real HTTP clients. Only fetch is intercepted because
// jsdom has no desktop API; Electron covers the same journey through the API.
test('starts only on Send, shows live replies and reloads the saved dialogue end state', async () => {
  let record = makeDialogue()
  const lifecycle = makeLifecycle()
  const textStream = makeTextStream()
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.includes('/agent-chat/stream?')) return textStream.response
    if (url.endsWith('/events?from=0')) return lifecycle.response
    if (url.endsWith(`/dialogues/${dialogueId}`)) return Response.json(record)
    if (init?.method === 'POST') return Response.json(record, { status: 202 })
    return Response.json({ dialogues: [] })
  }))
  const onMessagesChanged = vi.fn()
  const { result } = renderHook(() => useAgentDialogue({ sessionId, isDraft: false, onMessagesChanged }))
  await waitFor(() => expect(requests).toContain(`GET /api/sessions/${sessionId}/dialogues`))
  expect(requests.filter((request) => request.startsWith('POST'))).toEqual([])

  await act(async () => { expect(await result.current.start(['reviewer', 'builder'], record.topic)).toBe(true) })
  expect(result.current.active).toBe(true)

  const channelId = '55555555-5555-4555-8555-555555555555'
  await act(async () => lifecycle.emit({ sequence: 0, type: 'turn_started', createdAt: record.updatedAt, channelId, replyId: 'reviewer:0', slot: 0,
    speaker: { id: 'reviewer', label: 'Reviewer', consecutiveFailures: 0, active: true } }))
  await waitFor(() => expect(requests).toContain(`GET /api/sessions/${sessionId}/agent-chat/stream?channelId=${channelId}&from=0`))
  await act(async () => textStream.emit(`id: 0\ndata: ${JSON.stringify({ type: 'delta', channelId, cursor: 0, replyId: 'reviewer:0', channel: 'text', text: 'Start with a pilot.' })}\n\n`))
  await waitFor(() => expect(result.current.streamedTurn.replies[0]?.text).toBe('Start with a pilot.'))

  record = { ...record, replyCount: 1, nextSlot: 1 }
  await act(async () => lifecycle.emit({ sequence: 1, type: 'turn_saved', createdAt: record.updatedAt, slot: 0, messageId: 'reply-1' }))
  await waitFor(() => expect(result.current.record?.replyCount).toBe(1))
  expect(onMessagesChanged).toHaveBeenCalled()

  record = { ...record, status: 'ended', endReason: 'passes' }
  await act(async () => lifecycle.emit({ sequence: 2, type: 'ended', createdAt: record.updatedAt, status: 'ended', endReason: 'passes' }))
  await waitFor(() => expect(result.current.active).toBe(false))
  expect(result.current.record?.endReason).toBe('passes')
})

test('restores an active dialogue from the session records without starting it again', async () => {
  const record = makeDialogue()
  const lifecycle = makeLifecycle()
  const fetchBoundary = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input).includes('/events?')
    ? lifecycle.response : Response.json({ dialogues: [record] }))
  vi.stubGlobal('fetch', fetchBoundary)
  const onActiveChange = vi.fn()
  const { result } = renderHook(() => useAgentDialogue({ sessionId, isDraft: false, onMessagesChanged: vi.fn(), onActiveChange }))

  await waitFor(() => expect(result.current.active).toBe(true))
  expect(result.current.record?.dialogueId).toBe(dialogueId)
  expect(onActiveChange).toHaveBeenCalledWith(sessionId, ['reviewer', 'builder'])
  expect(fetchBoundary.mock.calls.map(([, init]) => init?.method ?? 'GET')).not.toContain('POST')
})

test('refresh discovers a dialogue that started after this session was opened', async () => {
  const record = makeDialogue()
  let records: AgentDialogueRecord[] = []
  const lifecycle = makeLifecycle()
  const fetchBoundary = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input).includes('/events?')
    ? lifecycle.response : Response.json({ dialogues: records }))
  vi.stubGlobal('fetch', fetchBoundary)
  const onMessagesChanged = vi.fn()
  const { result } = renderHook(() => useAgentDialogue({ sessionId, isDraft: false, onMessagesChanged }))
  await waitFor(() => expect(fetchBoundary).toHaveBeenCalledTimes(1))
  expect(result.current.active).toBe(false)

  records = [record]
  act(() => result.current.refresh())

  await waitFor(() => expect(result.current.record?.dialogueId).toBe(dialogueId))
  expect(result.current.active).toBe(true)
  expect(onMessagesChanged).toHaveBeenCalled()
  expect(fetchBoundary.mock.calls.map(([, init]) => init?.method ?? 'GET')).not.toContain('POST')
})

test('refresh of the same active dialogue preserves the reply already playing', async () => {
  const record = makeDialogue()
  const lifecycle = makeLifecycle()
  const textStream = makeTextStream()
  let listReads = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/agent-chat/stream?')) return textStream.response
    if (url.includes('/events?')) return lifecycle.response
    listReads += 1
    return Response.json({ dialogues: [record] })
  }))
  const { result } = renderHook(() => useAgentDialogue({ sessionId, isDraft: false, onMessagesChanged: vi.fn() }))
  await waitFor(() => expect(result.current.active).toBe(true))
  const channelId = '55555555-5555-4555-8555-555555555555'
  await act(async () => lifecycle.emit({ sequence: 0, type: 'turn_started', createdAt: record.updatedAt, channelId, replyId: 'reviewer:0', slot: 0,
    speaker: { id: 'reviewer', label: 'Reviewer', consecutiveFailures: 0, active: true } }))
  await act(async () => textStream.emit(`id: 0\ndata: ${JSON.stringify({ type: 'delta', channelId, cursor: 0, replyId: 'reviewer:0', channel: 'text', text: 'The reply already playing.' })}\n\n`))
  await waitFor(() => expect(result.current.streamedTurn.replies[0]?.text).toBe('The reply already playing.'))

  act(() => result.current.refresh())

  await waitFor(() => expect(listReads).toBe(2))
  expect(result.current.currentTurn?.channelId).toBe(channelId)
  expect(result.current.streamedTurn.replies[0]?.text).toBe('The reply already playing.')
})

test('a discarded speech slot clears its live reply while the dialogue stays paused', async () => {
  const record = makeDialogue()
  const discarded: AgentDialogueEvent = { sequence: 1, type: 'turn_discarded', createdAt: record.updatedAt, slot: 0 }
  const paused: AgentDialogueRecord = { ...record, delivery: 'voice', status: 'paused', pauseReason: 'speech_interrupted', events: [discarded] }
  const lifecycle = makeLifecycle()
  const textStream = makeTextStream()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/agent-chat/stream?')) return textStream.response
    if (url.includes('/events?')) return lifecycle.response
    if (url.endsWith(`/dialogues/${dialogueId}`)) return Response.json(paused)
    return Response.json({ dialogues: [record] })
  }))
  const { result } = renderHook(() => useAgentDialogue({ sessionId, isDraft: false, onMessagesChanged: vi.fn() }))
  await waitFor(() => expect(result.current.active).toBe(true))
  const channelId = '55555555-5555-4555-8555-555555555555'
  await act(async () => lifecycle.emit({ sequence: 0, type: 'turn_started', createdAt: record.updatedAt, channelId, replyId: 'reviewer:0', slot: 0,
    speaker: { id: 'reviewer', label: 'Reviewer', consecutiveFailures: 0, active: true } }))
  await act(async () => textStream.emit(`id: 0\ndata: ${JSON.stringify({ type: 'delta', channelId, cursor: 0, replyId: 'reviewer:0', channel: 'text', text: 'The unaccepted speech reply.' })}\n\n`))
  await waitFor(() => expect(result.current.streamedTurn.replies[0]?.text).toBe('The unaccepted speech reply.'))

  await act(async () => lifecycle.emit(discarded))

  await waitFor(() => expect(result.current.record?.status).toBe('paused'))
  expect(result.current.currentTurn).toBeNull()
  expect(result.current.streamedTurn.replies).toEqual([])
})

test('a late refresh cannot reactivate a dialogue that ended while its list was loading', async () => {
  const running = makeDialogue()
  const ended: AgentDialogueEvent = { sequence: 0, type: 'ended', createdAt: running.updatedAt, status: 'ended', endReason: 'passes' }
  const terminal: AgentDialogueRecord = { ...running, status: 'ended', endReason: 'passes', events: [ended] }
  const lifecycle = makeLifecycle()
  let finishList: (response: Response) => void = () => { throw new Error('Refresh not requested') }
  const heldList = new Promise<Response>((resolve) => { finishList = resolve })
  let listReads = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/events?')) return lifecycle.response
    if (url.endsWith(`/dialogues/${dialogueId}`)) return Response.json(terminal)
    listReads += 1
    return listReads === 1 ? Response.json({ dialogues: [running] }) : heldList
  }))
  const { result } = renderHook(() => useAgentDialogue({ sessionId, isDraft: false, onMessagesChanged: vi.fn() }))
  await waitFor(() => expect(result.current.active).toBe(true))
  act(() => result.current.refresh())
  await waitFor(() => expect(listReads).toBe(2))
  await act(async () => lifecycle.emit(ended))
  await waitFor(() => expect(result.current.record?.status).toBe('ended'))

  await act(async () => { finishList(Response.json({ dialogues: [running] })); await heldList })

  expect(result.current.active).toBe(false)
  expect(result.current.record?.status).toBe('ended')
})

test('a refresh callback retained from the previous session does not reload the new session', async () => {
  const otherSessionId = '44444444-4444-4444-8444-444444444444'
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    requests.push(String(input))
    return Response.json({ dialogues: [] })
  }))
  const { result, rerender } = renderHook(({ owner }: { owner: string }) => useAgentDialogue({
    sessionId: owner, isDraft: false, onMessagesChanged: vi.fn(),
  }), { initialProps: { owner: sessionId } })
  await waitFor(() => expect(requests).toEqual([`/api/sessions/${sessionId}/dialogues`]))
  const previousRefresh = result.current.refresh
  rerender({ owner: otherSessionId })
  await waitFor(() => expect(requests).toHaveLength(2))

  act(previousRefresh)

  expect(requests).toEqual([`/api/sessions/${sessionId}/dialogues`, `/api/sessions/${otherSessionId}/dialogues`])
})

test('an already ended start response leaves the mode unlocked', async () => {
  const record: AgentDialogueRecord = { ...makeDialogue(), status: 'ended', endReason: 'passes' }
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json(record, { status: 202 }) : Response.json({ dialogues: [] })))
  const onActiveChange = vi.fn()
  const { result } = renderHook(() => useAgentDialogue({ sessionId, isDraft: false, onMessagesChanged: vi.fn(), onActiveChange }))

  await act(async () => { expect(await result.current.start(['reviewer', 'builder'], record.topic)).toBe(true) })

  expect(result.current.active).toBe(false)
  expect(onActiveChange).toHaveBeenLastCalledWith(sessionId, null)
})

test('publishing a draft keeps the accepted dialogue in that same session', async () => {
  let settle: (response: Response) => void = () => { throw new Error('Start not requested') }
  const heldStart = new Promise<Response>((resolve) => { settle = resolve })
  const lifecycle = makeLifecycle()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return heldStart
    if (String(input).includes('/events?')) return lifecycle.response
    return Response.json({ dialogues: [] })
  }))
  const { result, rerender } = renderHook(({ draft }: { draft: boolean }) => useAgentDialogue({ sessionId, isDraft: draft, onMessagesChanged: vi.fn() }), { initialProps: { draft: true } })
  let started: Promise<boolean> = Promise.resolve(false)
  act(() => { started = result.current.start(['reviewer', 'builder'], 'Compare') })

  rerender({ draft: false })
  await act(async () => { settle(Response.json(makeDialogue(), { status: 202 })); expect(await started).toBe(true) })

  expect(result.current.record?.dialogueId).toBe(dialogueId)
  expect(result.current.active).toBe(true)
})

test('a start accepted after switching sessions never paints its old dialogue in the new session', async () => {
  let settle: (response: Response) => void = () => { throw new Error('Start not requested') }
  const heldStart = new Promise<Response>((resolve) => { settle = resolve })
  const secondSessionId = '44444444-4444-4444-8444-444444444444'
  const secondRecord = { ...makeDialogue(), sessionId: secondSessionId, dialogueId: '66666666-6666-4666-8666-666666666666' }
  const secondLifecycle = makeLifecycle()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return heldStart
    if (String(input).includes('/events?')) return secondLifecycle.response
    return Response.json({ dialogues: String(input).includes(secondSessionId) ? [secondRecord] : [] })
  }))
  const { result, rerender } = renderHook(({ owner }: { owner: string }) => useAgentDialogue({ sessionId: owner, isDraft: false, onMessagesChanged: vi.fn() }), { initialProps: { owner: sessionId } })
  let started: Promise<boolean> = Promise.resolve(false)
  act(() => { started = result.current.start(['reviewer', 'builder'], 'Compare') })

  rerender({ owner: secondSessionId })
  await waitFor(() => expect(result.current.record?.dialogueId).toBe(secondRecord.dialogueId))
  await act(async () => { settle(Response.json(makeDialogue(), { status: 202 })); expect(await started).toBe(true) })

  expect(result.current.record?.dialogueId).toBe(secondRecord.dialogueId)
  expect(result.current.active).toBe(true)
  expect(result.current.pending).toBe(false)
})

test('a submit prepared for an old session cannot start or replace the new session dialogue', async () => {
  const otherSessionId = '44444444-4444-4444-8444-444444444444'
  const otherRecord = { ...makeDialogue(), sessionId: otherSessionId, dialogueId: '66666666-6666-4666-8666-666666666666' }
  const lifecycle = makeLifecycle()
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') { posts.push(url); return Response.json(makeDialogue(), { status: 202 }) }
    if (url.includes('/events?')) return lifecycle.response
    return Response.json({ dialogues: url.includes(otherSessionId) ? [otherRecord] : [] })
  }))
  const { result, rerender } = renderHook(({ owner }: { owner: string }) => useAgentDialogue({ sessionId: owner, isDraft: false, onMessagesChanged: vi.fn() }), { initialProps: { owner: sessionId } })
  const preparedSubmit = result.current.start

  rerender({ owner: otherSessionId })
  await waitFor(() => expect(result.current.record?.dialogueId).toBe(otherRecord.dialogueId))
  await act(async () => { expect(await preparedSubmit(['reviewer', 'builder'], 'Old topic')).toBe(false) })

  expect(posts).toEqual([])
  expect(result.current.record?.dialogueId).toBe(otherRecord.dialogueId)
  expect(result.current.active).toBe(true)
})


test('Stop ends the active dialogue and reloads the saved messages', async () => {
  const record = makeDialogue()
  const stopped: AgentDialogueRecord = { ...record, status: 'stopped', endReason: 'stopped', stopRequested: true }
  const lifecycle = makeLifecycle()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/stop')) return Response.json(stopped)
    if (url.includes('/events?')) return lifecycle.response
    return Response.json({ dialogues: [record] })
  }))
  const onMessagesChanged = vi.fn()
  const onActiveChange = vi.fn()
  const { result } = renderHook(() => useAgentDialogue({ sessionId, isDraft: false, onMessagesChanged, onActiveChange }))
  await waitFor(() => expect(result.current.active).toBe(true))

  await act(async () => { expect(await result.current.stop()).toBe(true) })

  expect(result.current.record?.status).toBe('stopped')
  expect(result.current.active).toBe(false)
  expect(onMessagesChanged).toHaveBeenCalled()
  expect(onActiveChange).toHaveBeenLastCalledWith(sessionId, null)
})

test('a failed interjection keeps the active dialogue and its retry uses the same message identity', async () => {
  const record = makeDialogue()
  const lifecycle = makeLifecycle()
  const bodies: Array<BodyInit | null | undefined> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/interjections')) {
      bodies.push(init?.body)
      return bodies.length === 1 ? Response.json({ error: 'Try again' }, { status: 503 }) : Response.json(record)
    }
    if (url.includes('/events?')) return lifecycle.response
    return Response.json({ dialogues: [record] })
  }))
  const onMessagesChanged = vi.fn()
  const { result } = renderHook(() => useAgentDialogue({ sessionId, isDraft: false, onMessagesChanged }))
  await waitFor(() => expect(result.current.active).toBe(true))

  await act(async () => { expect(await result.current.interject('Compare the costs.')).toBe(false) })
  expect(result.current.active).toBe(true)
  expect(result.current.error).toBe('Try again')
  await act(async () => { expect(await result.current.interject('Compare the costs.')).toBe(true) })

  expect(bodies).toHaveLength(2)
  expect(bodies[0]).toContain('Compare the costs.')
  expect(bodies[0]).toContain('messageId')
  expect(bodies[1]).toBe(bodies[0])
  expect(result.current.error).toBe(null)
  expect(onMessagesChanged).toHaveBeenCalled()
})


test('a late interjection response cannot make an ended dialogue active again', async () => {
  const started: AgentDialogueEvent = { sequence: 0, type: 'started', createdAt: '2026-10-09T12:00:00.000Z' }
  const ended: AgentDialogueEvent = { sequence: 1, type: 'ended', createdAt: '2026-10-09T12:00:01.000Z', status: 'stopped', endReason: 'stopped' }
  const record: AgentDialogueRecord = { ...makeDialogue(), events: [started] }
  const stopped: AgentDialogueRecord = { ...record, status: 'stopped', endReason: 'stopped', stopRequested: true, events: [started, ended] }
  const lifecycle = makeLifecycle()
  let settle: (response: Response) => void = () => { throw new Error('Interjection not requested') }
  const heldResponse = new Promise<Response>((resolve) => { settle = resolve })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/interjections')) return heldResponse
    if (url.includes('/events?')) return lifecycle.response
    if (url.endsWith(`/dialogues/${dialogueId}`)) return Response.json(stopped)
    return Response.json({ dialogues: [record] })
  }))
  const onActiveChange = vi.fn()
  const { result } = renderHook(() => useAgentDialogue({ sessionId, isDraft: false, onMessagesChanged: vi.fn(), onActiveChange }))
  await waitFor(() => expect(result.current.active).toBe(true))
  let submitted = Promise.resolve(false)
  act(() => { submitted = result.current.interject('Compare the costs.') })

  await act(async () => lifecycle.emit(ended))
  await waitFor(() => expect(result.current.record?.status).toBe('stopped'))
  await act(async () => { settle(Response.json(record)); expect(await submitted).toBe(true) })

  expect(result.current.active).toBe(false)
  expect(result.current.record?.status).toBe('stopped')
  expect(onActiveChange).toHaveBeenLastCalledWith(sessionId, null)
})


test('starting a dialogue retains the selected project references at the HTTP boundary', async () => {
  const record: AgentDialogueRecord = { ...makeDialogue(), status: 'ended', endReason: 'passes' }
  let sent: BodyInit | null | undefined
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') { sent = init.body; return Response.json(record, { status: 202 }) }
    return Response.json({ dialogues: [] })
  }))
  const { result } = renderHook(() => useAgentDialogue({ sessionId, isDraft: false, onMessagesChanged: vi.fn() }))
  const projectContext = { projectId: '77777777-7777-4777-8777-777777777777', includeBrief: true, fileNames: ['facts.md'] }

  await act(async () => { expect(await result.current.start(['reviewer', 'builder'], record.topic, { projectContext })).toBe(true) })

  expect(sent).toBe(JSON.stringify({ agents: ['reviewer', 'builder'], topic: record.topic, delivery: 'text', maxTurns: 12, projectContext }))
})

test('Pause and Resume retain the dialogue identity and update its running state', async () => {
  const running = makeDialogue()
  const lifecycle = makeLifecycle()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/pause')) return Response.json({ ...running, status: 'paused' })
    if (url.endsWith('/resume')) return Response.json(running)
    if (url.includes('/events?')) return lifecycle.response
    return Response.json({ dialogues: [running] })
  }))
  const { result } = renderHook(() => useAgentDialogue({ sessionId, isDraft: false, onMessagesChanged: vi.fn() }))
  await waitFor(() => expect(result.current.active).toBe(true))

  await act(async () => { expect(await result.current.pause()).toBe(true) })
  expect(result.current.record?.status).toBe('paused')
  expect(result.current.active).toBe(true)
  await act(async () => { expect(await result.current.resume()).toBe(true) })

  expect(result.current.record?.dialogueId).toBe(dialogueId)
  expect(result.current.record?.status).toBe('running')
})

test('Keep going from an interrupted dialogue preserves its Agents and context under a fresh identity and reply limit', async () => {
  const prior: AgentDialogueRecord = { ...makeDialogue(), status: 'interrupted', endReason: 'interrupted',
    limits: { maxTurns: 4, runningMs: 1200 },
    projectContext: { projectId: '77777777-7777-4777-8777-777777777777', includeBrief: true, fileNames: ['facts.md'] }, contextResultIds: ['earlier-result'] }
  const continued: AgentDialogueRecord = { ...makeDialogue(), dialogueId: '88888888-8888-4888-8888-888888888888', continues: dialogueId }
  const lifecycle = makeLifecycle()
  let sent: BodyInit | null | undefined
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') { sent = init.body; return Response.json(continued, { status: 202 }) }
    if (String(input).includes('/events?')) return lifecycle.response
    return Response.json({ dialogues: [prior] })
  }))
  const { result } = renderHook(() => useAgentDialogue({ sessionId, isDraft: false, onMessagesChanged: vi.fn() }))
  await waitFor(() => expect(result.current.record?.status).toBe('interrupted'))

  await act(async () => { expect(await result.current.keepGoing()).toBe(true) })

  expect(sent).toBe(JSON.stringify({ agents: ['reviewer', 'builder'], topic: 'Keep going.', delivery: 'text', maxTurns: 12,
    continues: dialogueId, projectContext: prior.projectContext, contextResultIds: prior.contextResultIds }))
  expect(result.current.record?.dialogueId).toBe(continued.dialogueId)
  expect(result.current.active).toBe(true)
})

test('starting a dialogue invalidates other views of its saved session', async () => {
  const record = makeDialogue()
  const lifecycle = makeLifecycle()
  const announced: string[] = []
  // Electron is unavailable; replace only its preload boundary and HTTP transport.
  window.pipeline = { selectBatchFolder: async () => null, selectSharedFolder: async () => null,
    announceSessionChanged: (id) => { announced.push(id) } }
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/events?')) return lifecycle.response
    if (init?.method === 'POST') return Response.json(record, { status: 202 })
    return Response.json({ dialogues: [] })
  })
  const { result, unmount } = renderHook(() => useAgentDialogue({ sessionId, isDraft: false, onMessagesChanged: () => {} }))
  try {
    await act(async () => { expect(await result.current.start(['reviewer', 'builder'], record.topic)).toBe(true) })
    expect(announced).toContain(sessionId)
  } finally { unmount(); delete window.pipeline }
})
