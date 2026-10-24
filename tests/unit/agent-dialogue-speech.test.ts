import assert from 'node:assert/strict'
import test from 'node:test'
import { heardDialoguePrefix } from '../../domains/agent-dialogue/dialogue-speech-policy.js'

test('a heard prefix discards the partially heard word and keeps complete words', () => {
  assert.equal(heardDialoguePrefix('A useful pricing pilot.', 12), 'A useful')
  assert.equal(heardDialoguePrefix('A useful pricing pilot.', 9), 'A useful')
  assert.equal(heardDialoguePrefix('A useful pricing pilot.', 2), 'A')
  assert.equal(heardDialoguePrefix('A useful pricing pilot.', 1), 'A')
})

test('a fully heard reply retains its final word and punctuation', () => {
  assert.equal(heardDialoguePrefix('A useful pricing pilot.', 23), 'A useful pricing pilot.')
  assert.equal(heardDialoguePrefix('A useful pricing pilot.', 200), 'A useful pricing pilot.')
  assert.equal(heardDialoguePrefix('A useful pricing pilot.', 0), '')
})
