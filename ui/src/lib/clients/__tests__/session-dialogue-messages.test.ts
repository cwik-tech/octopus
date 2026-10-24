import { afterEach, expect, test, vi } from 'vitest'

import { listChatMessages } from '../session-client'

const dialogueId = '22222222-2222-4222-8222-222222222222'
function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: `${dialogueId}:assistant:0`, role: 'assistant', text: 'A short reply.',
    createdAt: '2026-10-09T12:00:00.000Z', schemaVersion: 2, kind: 'chat',
    source: { kind: 'agent-dialogue', dialogueId, slot: 0 }, turnId: 'dialogue-turn-0',
    speaker: { type: 'agent', id: 'reviewer', name: 'Reviewer' },
    ...overrides,
  }
}

function respondWith(message: unknown) {
  // Intercept only HTTP. The saved-message shape is also exercised through
  // the real API and filesystem by the Electron dialogue journey.
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ messages: [message] })))
}
afterEach(() => vi.unstubAllGlobals())

test('keeps a saved dialogue reply and its provenance without a conversation pointer', async () => {
  const message = makeMessage()
  respondWith(message)
  expect((await listChatMessages('session-1')).messages).toEqual([message])
})

test('keeps a dialogue interjection without an Agent speaker', async () => {
  const message = makeMessage({ role: 'user', id: 'interjection-1', text: 'Consider cost.', speaker: undefined })
  respondWith(message)
  expect((await listChatMessages('session-1')).messages).toEqual([message])
})

test.each([
  { kind: 'agent-dialogue', dialogueId: 'invalid', slot: 0 },
  { kind: 'agent-dialogue', dialogueId, slot: -1 },
  { kind: 'agent-dialogue', dialogueId, slot: 0.5 },
  { kind: 'agent-dialogue', dialogueId },
])('refuses an invalid dialogue source %j', async (source) => {
  respondWith(makeMessage({ source }))
  await expect(listChatMessages('session-1')).rejects.toThrow(/ChatMessage\.source/)
})

test('refuses a dialogue line carrying an unrelated conversation pointer', async () => {
  respondWith(makeMessage({ conversationId: 'session-1', conversation: { conversationId: 'session-1', activityId: 'turn-1', turnId: 'turn-1' } }))
  await expect(listChatMessages('session-1')).rejects.toThrow(/ChatMessage\.conversation/)
})

test('keeps the heard-length marker on an interrupted dialogue reply', async () => {
  const message = makeMessage({ cutOff: { heardChars: 14 } })
  respondWith(message)
  expect((await listChatMessages('session-1')).messages).toEqual([message])
})

test.each([
  makeMessage({ cutOff: { heardChars: -1 } }),
  makeMessage({ cutOff: { heardChars: 1.5 } }),
  makeMessage({ role: 'user', speaker: undefined, cutOff: { heardChars: 2 } }),
])('refuses an invalid heard-length marker %j', async (message) => {
  respondWith(message)
  await expect(listChatMessages('session-1')).rejects.toThrow(/ChatMessage\.cutOff/)
})
