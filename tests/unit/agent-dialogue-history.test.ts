import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatMessage } from '../../contracts/sessions.js'
import { assembleSpeakerPrompt } from '../../services/agent-chat-history.js'

function makeHistory(): ChatMessage[] {
  return [
    { id: 'user', role: 'user', text: 'Consider a pilot.', createdAt: '2026-10-09T10:00:00.000Z' },
    { id: 'mine', role: 'assistant', text: 'Test willingness to pay.', createdAt: '2026-10-09T10:00:01.000Z', speaker: { type: 'agent', id: 'analyst-one', name: 'Analyst' } },
    { id: 'colleague', role: 'assistant', text: 'Also recruit people who declined.', createdAt: '2026-10-09T10:00:02.000Z', speaker: { type: 'agent', id: 'analyst-two', name: 'Analyst' } },
  ]
}

test('dialogue history identifies my earlier replies by Agent ID even when a colleague has the same display name', () => {
  const prompt = assembleSpeakerPrompt({
    speakerName: 'Analyst', ownSpeakerId: 'analyst-one',
    latestUserText: 'Continue the pricing discussion.',
    history: makeHistory(), windowTokens: 128_000,
  })

  assert.match(prompt, /User: Consider a pilot\./)
  assert.match(prompt, /Analyst \(you\): Test willingness to pay\./)
  assert.match(prompt, /Analyst: Also recruit people who declined\./)
  assert.doesNotMatch(prompt, /Analyst \(you\): Also recruit/)
})

test('ordinary chat history keeps its existing speaker labels', () => {
  const prompt = assembleSpeakerPrompt({
    speakerName: 'Analyst', latestUserText: 'What next?',
    history: makeHistory(), windowTokens: 128_000,
  })

  assert.match(prompt, /Analyst: Test willingness to pay\./)
  assert.match(prompt, /Analyst: Also recruit people who declined\./)
  assert.doesNotMatch(prompt, /\(you\)/)
})

test('the next speaker sees a cut-off marker beside only the persisted heard prefix', () => {
  const prompt = assembleSpeakerPrompt({
    speakerName: 'Builder', ownSpeakerId: 'builder',
    latestUserText: 'Respond to the concern.', windowTokens: 128_000,
    history: [{ id: 'heard', role: 'assistant', text: 'Test willingness',
      createdAt: '2026-10-09T10:00:01.000Z',
      speaker: { type: 'agent', id: 'analyst', name: 'Analyst' },
      cutOff: { heardChars: 16 } }],
  })

  assert.match(prompt, /Analyst: Test willingness \[cut off\]/)
  assert.doesNotMatch(prompt, /Test willingness to pay/)
})
