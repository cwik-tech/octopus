/**
 * Reading a model's effort range out of what a provider already answers.
 *
 * The shapes here are the ones this application receives today: the `reasoning`
 * block an OpenAI-compatible `/models` listing carries (verified against
 * `https://openrouter.ai/api/v1/models`, where 315 of 447 entries carried one),
 * and the levels `codex debug models` publishes.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { readPublishedEffort } from '../../domains/provider/effort-metadata.js'

test('a models listing that publishes a range is read in the order given', () => {
  assert.deepEqual(
    readPublishedEffort({
      id: 'vendor/model',
      reasoning: {
        mandatory: false,
        default_enabled: true,
        supported_efforts: ['xhigh', 'medium'],
        default_effort: 'xhigh',
      },
    }),
    { levels: ['xhigh', 'medium'], defaultLevel: 'xhigh' },
  )
})

test("a provider's name for thinking-off becomes ours", () => {
  assert.deepEqual(
    readPublishedEffort({
      id: 'vendor/model',
      reasoning: { supported_efforts: ['none', 'low', 'high'], default_effort: 'none' },
    }),
    { levels: ['off', 'low', 'high'], defaultLevel: 'off' },
  )
})

test('a model that may not stop thinking does not offer off', () => {
  const published = readPublishedEffort({
    id: 'vendor/model',
    reasoning: { mandatory: true, supported_efforts: ['none', 'low', 'high'] },
  })
  assert.deepEqual(published.levels, ['low', 'high'])
})

test('taking the parameter is not the same as publishing a range', () => {
  assert.deepEqual(
    readPublishedEffort({
      id: 'vendor/model',
      supported_parameters: ['reasoning', 'reasoning_effort', 'temperature'],
    }),
    {},
  )
})

test('a listing that says nothing about reasoning publishes nothing', () => {
  assert.deepEqual(readPublishedEffort({ id: 'vendor/model' }), {})
})
