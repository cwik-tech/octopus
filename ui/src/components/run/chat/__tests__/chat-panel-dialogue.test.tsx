import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import type { AgentDialogueRecord } from '@contracts/agent-dialogue'
import type { ChatMessage, SessionSummary } from '@/lib/models/session-model'

import ChatPanel from '../chat-panel'

const sessionId = '11111111-1111-4111-8111-111111111111'
const projectId = '77777777-7777-4777-8777-777777777777'
function makeSession(): SessionSummary {
  return { id: sessionId, projectId, title: 'Project discussion', status: 'active', activityType: 'chat',
    createdAt: '2026-10-09T12:00:00.000Z', updatedAt: '2026-10-09T12:00:00.000Z' }
}
function makeDialogue(): AgentDialogueRecord {
  return {
    schemaVersion: 1, sessionId, dialogueId: '22222222-2222-4222-8222-222222222222', topic: 'Use these references',
    participants: [{ id: 'reviewer', label: 'Reviewer', consecutiveFailures: 0, active: true },
      { id: 'builder', label: 'Builder', consecutiveFailures: 0, active: true }],
    delivery: 'text', limits: { maxTurns: 12, runningMs: 0 }, status: 'ended', endReason: 'passes',
    nextSlot: 2, replyCount: 0, passStreak: 2, nextSpeaker: 0, epoch: 0,
    ownerLaunchId: '33333333-3333-4333-8333-333333333333', stopRequested: false, events: [],
    createdAt: '2026-10-09T12:00:00.000Z', updatedAt: '2026-10-09T12:00:00.000Z',
  }
}

function installSavedDialogue(record: AgentDialogueRecord, messages: ChatMessage[] = []) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/messages')) return Response.json({ messages })
    if (url.endsWith('/dialogues')) return Response.json({ dialogues: [record] })
    if (url.includes('/events?')) return new Response(new ReadableStream())
    if (url.includes('/create/agents')) return Response.json({ agents: [] })
    if (url.endsWith('/create/chat-defaults')) return Response.json({
      agent: { provider: 'fixture', model: 'fixture' }, run: { provider: 'fixture', model: 'fixture' },
      team: { provider: 'fixture', model: 'fixture' }, workflow: { provider: 'fixture', model: 'fixture' },
    })
    if (url.endsWith('/files')) return Response.json({ files: [] })
    if (url.endsWith('/folders')) return Response.json({ folders: [] })
    if (url.includes('/mcp-interactions')) return Response.json({ interactions: [], truncated: false })
    if (url.includes('/research-activity')) return Response.json({ activities: [] })
    return Response.json({ error: 'Unexpected fixture request' }, { status: 503 })
  }))
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

// Use every real hook and HTTP client. Only the HTTP boundary is replaced
// because jsdom has no desktop API; Electron exercises the same dialogue path.
test('Talk to each other sends the project references chosen in its composer', async () => {
  const posted: Array<BodyInit | null | undefined> = []
  const unexpected: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/dialogues') && init?.method === 'POST') { posted.push(init.body); return Response.json(makeDialogue(), { status: 202 }) }
    if (url.includes('/create/agents')) return Response.json({ agents: [] })
    if (url.endsWith('/create/chat-defaults')) return Response.json({
      agent: { provider: 'fixture', model: 'fixture' }, run: { provider: 'fixture', model: 'fixture' },
      team: { provider: 'fixture', model: 'fixture' }, workflow: { provider: 'fixture', model: 'fixture' },
    })
    if (url.endsWith('/brief')) return Response.json({ content: 'The project brief.', updatedAt: '2026-10-09T12:00:00.000Z' })
    if (url.endsWith('/files')) return Response.json({ files: [{ name: 'facts.md', size: 10, uploadedAt: '2026-10-09T12:00:00.000Z', parseStatus: 'parsed' }] })
    unexpected.push(url)
    return Response.json({ error: 'Unexpected fixture request' }, { status: 503 })
  }))
  const user = userEvent.setup()
  render(<ChatPanel session={makeSession()} isDraft ensureSession={async () => sessionId}
    target={{ kind: 'agents', agentNames: ['reviewer', 'builder'] }} agentChatMode="dialogue" />)
  await user.click(screen.getByRole('button', { name: 'Add project context' }))
  await user.click(await screen.findByRole('checkbox', { name: 'Project brief' }))
  await user.click(screen.getByRole('checkbox', { name: 'facts.md' }))
  await user.click(screen.getByRole('button', { name: 'Apply project context' }))

  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Use these references' } })
  await user.click(screen.getByRole('button', { name: 'Send message' }))

  await waitFor(() => expect(posted).toHaveLength(1))
  expect(posted[0]).toBe(JSON.stringify({ agents: ['reviewer', 'builder'], topic: 'Use these references', delivery: 'text', maxTurns: 12,
    projectContext: { projectId, includeBrief: true, fileNames: ['facts.md'] } }))
  expect(unexpected).toEqual([])
})


test('a failed dialogue start in an old session leaves the new session draft intact', async () => {
  let settle: (response: Response) => void = () => { throw new Error('Start not requested') }
  const heldResponse = new Promise<Response>((resolve) => { settle = resolve })
  const posted: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/dialogues') && init?.method === 'POST') { posted.push(url); return heldResponse }
    if (url.includes('/create/agents')) return Response.json({ agents: [] })
    if (url.endsWith('/create/chat-defaults')) return Response.json({
      agent: { provider: 'fixture', model: 'fixture' }, run: { provider: 'fixture', model: 'fixture' },
      team: { provider: 'fixture', model: 'fixture' }, workflow: { provider: 'fixture', model: 'fixture' },
    })
    return Response.json({ error: 'Unexpected fixture request' }, { status: 503 })
  }))
  const user = userEvent.setup()
  const { rerender } = render(<ChatPanel session={makeSession()} isDraft ensureSession={async () => sessionId}
    target={{ kind: 'agents', agentNames: ['reviewer', 'builder'] }} agentChatMode="dialogue" />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Old topic' } })
  await user.click(screen.getByRole('button', { name: 'Send message' }))
  await waitFor(() => expect(posted).toHaveLength(1))
  const otherSessionId = '44444444-4444-4444-8444-444444444444'

  rerender(<ChatPanel session={{ ...makeSession(), id: otherSessionId }} isDraft ensureSession={async () => otherSessionId}
    target={{ kind: 'agents', agentNames: ['reviewer', 'builder'] }} agentChatMode="dialogue" />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My new draft' } })
  await act(async () => { settle(Response.json({ error: 'Failed start' }, { status: 503 })); await heldResponse })

  expect(screen.getByRole('textbox')).toHaveValue('My new draft')
})

test('a saved interrupted voice reply keeps its heard text and identifies that it was cut off', async () => {
  const record: AgentDialogueRecord = { ...makeDialogue(), status: 'paused', delivery: 'voice' }
  const message: ChatMessage = { id: `${record.dialogueId}:reply:0`, role: 'assistant', text: 'The pilot needs real customers',
    createdAt: record.createdAt, schemaVersion: 2, kind: 'chat', turnId: 'voice-turn-0',
    speaker: { type: 'agent', id: 'reviewer', name: 'Reviewer' },
    source: { kind: 'agent-dialogue', dialogueId: record.dialogueId, slot: 0 }, cutOff: { heardChars: 30 } }
  installSavedDialogue(record, [message])
  render(<ChatPanel session={makeSession()} target={{ kind: 'agents', agentNames: ['reviewer', 'builder'] }} agentChatMode="dialogue" />)

  expect(await screen.findByText('The pilot needs real customers')).toBeVisible()
  expect(screen.getByRole('status', { name: 'Reply cut off' })).toHaveTextContent('Cut off')
})

test.each<[NonNullable<AgentDialogueRecord['pauseReason']>, string]>([
  ['speech_interrupted', 'Speech interrupted. Send an interjection or resume.'],
  ['voice_unavailable', 'Voice layer unavailable. Reconnect and resume.'],
  ['voice_refused', 'The voice layer refused this reply. Check voice access and resume.'],
  ['speech_dropped', 'This reply was not played. Resume when the voice layer is ready.'],
])('a voice dialogue paused for %s explains why and retains its controls', async (pauseReason, explanation) => {
  installSavedDialogue({ ...makeDialogue(), status: 'paused', delivery: 'voice', pauseReason })
  render(<ChatPanel session={makeSession()} target={{ kind: 'agents', agentNames: ['reviewer', 'builder'] }} agentChatMode="dialogue" />)

  expect(await screen.findByRole('status', { name: 'Dialogue pause reason' })).toHaveTextContent(explanation)
  expect(screen.getByRole('button', { name: 'Resume dialogue' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Stop dialogue' })).toBeEnabled()
  expect(screen.getByRole('textbox')).toBeEnabled()
})
