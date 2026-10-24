import assert from 'node:assert/strict'
import test from 'node:test'

import { openingSentences } from '../../server/voice-control/tool-support.js'

test('the spoken opening is the first two sentences', () => {
  assert.equal(
    openingSentences('# Report\n\nOat milk grew. Prices held. Details follow.'),
    'Oat milk grew. Prices held.',
  )
})

test('only the opening of a long text is considered, so the spoken part stays short', () => {
  // A report that never ends a sentence in its first pages must not be read
  // aloud whole, and must not be scanned whole either.
  const text = `${'word '.repeat(2_000)}. Ending.`
  const spoken = openingSentences(text)
  assert.ok(spoken.length <= 300, `spoken ${spoken.length} characters`)
  assert.doesNotMatch(spoken, /Ending/)
})
