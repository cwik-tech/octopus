/**
 * The incremental reader that lets a JSON-enveloped reply stream as prose.
 *
 * Two architects are required to answer with one JSON object whose visible
 * text sits under `message`. Streaming the raw tokens would put a growing JSON
 * blob on screen, so the reader emits the decoded value of that one field and
 * nothing else — no braces, no key names, and nothing from the structured part
 * of the reply.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createStreamingJsonFieldReader } from '../../domains/provider/streaming-json-field.js'

/** Feed a value in pieces and collect what the reader chose to emit. */
function readAll(field: string, chunks: readonly string[]): string[] {
  const reader = createStreamingJsonFieldReader(field)
  return chunks.map((chunk) => reader.push(chunk)).filter((text) => text !== '')
}

test('the field value streams as decoded prose across chunk boundaries', () => {
  const emitted = readAll('message', [
    '```json\n{"mess',
    'age": "Kestrel',
    ' and Marlin"',
    ', "draft": null}\n```',
  ])

  assert.deepEqual(emitted, ['Kestrel', ' and Marlin'])
})

test('nothing is emitted before the field opens or after it closes', () => {
  const reader = createStreamingJsonFieldReader('message')

  assert.equal(reader.push('{"warnings": [], "mes'), '')
  assert.equal(reader.push('sage": "'), '')
  assert.equal(reader.push('Hello'), 'Hello')
  // The closing quote ends the field. Everything after it is the structured
  // part of the reply and must never reach the screen.
  assert.equal(
    reader.push('", "draft": {"id": "review", "steps": [{"id": "one"}]}}'),
    '',
  )
})

test('escapes are decoded, including one split across two chunks', () => {
  const emitted = readAll('message', [
    '{"message": "line one\\',
    'nline two: \\"quoted\\" and a backslash \\\\"}',
  ])

  assert.deepEqual(emitted, [
    'line one',
    '\nline two: "quoted" and a backslash \\',
  ])
})

test('a unicode escape split across chunks decodes to one character', () => {
  const emitted = readAll('message', [
    '{"message": "caf\\u00',
    'e9 time"}',
  ])

  assert.equal(emitted.join(''), 'café time')
})

test('a surrogate pair split across chunks is emitted as one character, never as a lone half', () => {
  const emitted = readAll('message', [
    '{"message": "wave \\ud83d',
    '\\udc4b done"}',
  ])

  // Each emitted piece must be independently renderable: a lone high surrogate
  // handed to the UI is a broken character, not a preview.
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
  for (const piece of emitted) {
    assert.equal(
      loneSurrogate.test(piece),
      false,
      `lone surrogate in ${JSON.stringify(piece)}`,
    )
  }
  assert.equal(emitted.join(''), 'wave 👋 done')
})

test('a nested field of the same name is not mistaken for the reply', () => {
  const emitted = readAll('message', [
    '{"draft": {"message": "nested and not the reply"}, ',
    '"message": "the real reply"}',
  ])

  assert.deepEqual(emitted, ['the real reply'])
})

test('the field name appearing inside an earlier value is not mistaken for the key', () => {
  const emitted = readAll('message', [
    '{"preamble": "the \\"message\\" key comes later", ',
    '"message": "the real reply"}',
  ])

  assert.deepEqual(emitted, ['the real reply'])
})

test('a reply that never opens the field emits nothing at all', () => {
  const emitted = readAll('message', [
    '{"draft": {"id": "review"}, "warnings": ["none"]}',
  ])

  assert.deepEqual(emitted, [])
})
