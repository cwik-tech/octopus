/**
 * Keeping an internal control marker out of the live preview.
 *
 * The Agent Architect ends an approval reply with a marker line the
 * client acts on and the saved message never contains. Streaming raw suffixes
 * puts that marker on screen for a moment and then takes it away, which shows
 * the user machinery they are not meant to see and makes the preview disagree
 * with what is saved.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createTrailingMarkerSuppressor } from '../../domains/provider/streaming-trailing-marker.js'

const MARKER = '[[proposal-requested]]'

/** Feed a reply in pieces and collect what a reader would have seen. */
function stream(marker: string, chunks: readonly string[]): string {
  const suppress = createTrailingMarkerSuppressor(marker)
  return chunks.map((chunk) => suppress.push(chunk)).join('')
}

test('an ordinary reply passes through unchanged', () => {
  assert.equal(
    stream(MARKER, ['Sure — I can ', 'design that for you.']),
    'Sure — I can design that for you.',
  )
})

test('the marker never reaches the reader, even split across chunks', () => {
  const seen = stream(MARKER, [
    'Ready when you are.\n',
    '[[proposal-',
    'requested]]',
  ])

  assert.equal(seen.includes('proposal-requested'), false)
  assert.equal(seen.includes('[['), false)
  assert.equal(seen.trimEnd(), 'Ready when you are.')
})

test('text that merely starts like the marker is still shown', () => {
  // Held back while it might have become the marker, released once it cannot.
  assert.equal(
    stream(MARKER, ['Use [[', 'double brackets]] in the brief.']),
    'Use [[double brackets]] in the brief.',
  )
})

test('a marker in the middle of a reply is left alone', () => {
  // Only a trailing marker is the control signal; the parser itself refuses
  // one anywhere else, so the preview must not silently remove it either.
  const seen = stream(MARKER, [`Quoting ${MARKER} here.`])

  assert.equal(seen, `Quoting ${MARKER} here.`)
})

/** Stream a reply and then end it, the way a completed turn does. */
function streamToEnd(marker: string, chunks: readonly string[]): string {
  const suppress = createTrailingMarkerSuppressor(marker)
  const streamed = chunks.map((chunk) => suppress.push(chunk)).join('')
  return streamed + suppress.finish()
}

test('a reply that simply ends on a marker prefix still shows those characters', () => {
  // Held back only because it might have grown into the marker. Once the reply
  // is over it cannot, and swallowing it would lose real text.
  assert.equal(streamToEnd(MARKER, ['Pick option [']), 'Pick option [')
  assert.equal(streamToEnd(MARKER, ['Nested brackets [[']), 'Nested brackets [[')
  assert.equal(
    streamToEnd(MARKER, ['See [[proposal-']),
    'See [[proposal-',
  )
})

test('a completed trailing marker stays suppressed through the end', () => {
  assert.equal(
    streamToEnd(MARKER, ['Ready when you are.\n', MARKER]).trimEnd(),
    'Ready when you are.',
  )
})

test('ending twice releases nothing further', () => {
  const suppress = createTrailingMarkerSuppressor(MARKER)
  suppress.push('Pick option [')

  assert.equal(suppress.finish(), '[')
  assert.equal(suppress.finish(), '')
})
