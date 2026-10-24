import test from 'node:test'
import assert from 'node:assert/strict'

import { extractSseFrames, parseSseData } from '../../providers/sse-stream.js'

test('extractSseFrames splits complete frames and keeps the partial remainder', () => {
  const result = extractSseFrames('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"')
  assert.deepEqual(result.events, ['data: {"a":1}', 'data: {"b":2}'])
  assert.equal(result.remainder, 'data: {"c"')
})

test('extractSseFrames normalizes CRLF line endings', () => {
  const result = extractSseFrames('data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n')
  assert.deepEqual(result.events, ['data: {"a":1}', 'data: {"b":2}'])
  assert.equal(result.remainder, '')
})

test('extractSseFrames returns everything as remainder when no frame is complete', () => {
  const result = extractSseFrames('data: {"partial"')
  assert.deepEqual(result.events, [])
  assert.equal(result.remainder, 'data: {"partial"')
})

test('extractSseFrames drops blank frames', () => {
  const result = extractSseFrames('data: {"a":1}\n\n\n\ndata: {"b":2}\n\n')
  assert.deepEqual(result.events, ['data: {"a":1}', 'data: {"b":2}'])
})

test('extractSseFrames handles an empty buffer', () => {
  const result = extractSseFrames('')
  assert.deepEqual(result.events, [])
  assert.equal(result.remainder, '')
})

test('parseSseData returns the decoded JSON payload', () => {
  assert.deepEqual(parseSseData('data: {"type":"message.delta"}'), {
    type: 'message.delta',
  })
})

test('parseSseData joins multi-line data fields', () => {
  assert.deepEqual(parseSseData('data: {"a":\ndata: 1}'), { a: 1 })
})

test('parseSseData ignores non-data lines such as event and id', () => {
  assert.deepEqual(
    parseSseData('event: message\nid: 4\ndata: {"ok":true}'),
    { ok: true },
  )
})

test('parseSseData returns undefined when a frame has no data line', () => {
  assert.equal(parseSseData('event: ping'), undefined)
})

test('parseSseData returns undefined for malformed JSON rather than throwing', () => {
  assert.equal(parseSseData('data: {not json'), undefined)
})

test('parseSseData returns unknown, so callers must narrow rather than cast', () => {
  const parsed: unknown = parseSseData('data: {"type":"x"}')
  assert.equal(typeof parsed, 'object')
})
