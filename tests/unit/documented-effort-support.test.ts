/**
 * Effort ranges for the pairs a vendor documents but does not publish.
 *
 * Two of the three sources this application has are live: `codex debug models`
 * answers per model, and an OpenAI-compatible `/models` listing carries a
 * `reasoning` block. The other two do not answer at all. Claude Code prints no
 * per-model list, and the OpenAI API does not describe its own models' effort
 * support over the wire — so an Agent on `claude`/`opus` or on
 * `openai`/`gpt-5.6-sol` had a fully documented range and an empty menu.
 *
 * The table these tests cover is that documentation, transcribed with its
 * source. It is not a guess about an adapter's flag syntax: a model the vendor
 * does not list still offers nothing.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  documentedEffortCapabilities,
  documentedEffortLevels,
} from '../../domains/provider/documented-effort-support.js'

test('Claude Code offers Opus 4.8 the five levels its own documentation lists', () => {
  assert.deepEqual(documentedEffortLevels('claude', 'opus'), [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ])
})

test('the Claude Code aliases resolve to the model they actually name', () => {
  // `opus` is Claude Opus 4.8 and `sonnet` is Claude Sonnet 5 in this
  // application's own alias table, so the range has to follow the alias rather
  // than the word.
  assert.deepEqual(
    documentedEffortLevels('claude', 'sonnet'),
    ['low', 'medium', 'high', 'xhigh', 'max'],
  )
  assert.deepEqual(
    documentedEffortLevels('claude', 'claude-opus-4-6'),
    ['low', 'medium', 'high', 'max'],
  )
})

test('a Claude Code model the documentation does not list offers nothing', () => {
  // "Models not listed in the table above do not support effort levels." An
  // empty answer is the honest one; the CLI parsing a flag is not the same as
  // a model accepting a level.
  assert.deepEqual(documentedEffortLevels('claude', 'haiku'), [])
  assert.deepEqual(documentedEffortLevels('claude', 'default'), [])
})

test('the native OpenAI API offers what its model page lists, including none', () => {
  assert.deepEqual(documentedEffortLevels('openai', 'gpt-5.6-sol'), [
    'off',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ])
})

test('a native OpenAI model without none does not gain it', () => {
  // GPT-6 Astra's page lists the five levels and not `none`, and Codex's own
  // payload for that model is about the Codex route rather than this one.
  assert.deepEqual(documentedEffortLevels('openai', 'gpt-6-astra'), [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ])
})

test('Codex identity is kept separate from the native API', () => {
  // `ultra` exists on the Codex route and is published there per model. It must
  // not leak into the direct API's menu on the strength of a shared model name.
  assert.equal(documentedEffortLevels('openai', 'gpt-6-astra').includes('ultra'), false)
  assert.deepEqual(documentedEffortLevels('codex', 'gpt-6-astra'), [])
})

test('a model nobody has described offers nothing', () => {
  assert.deepEqual(documentedEffortLevels('openai', 'gpt-made-up'), [])
  assert.deepEqual(documentedEffortLevels('unknown-provider', 'whatever'), [])
})

test('a native alias the vendor documents resolves to the model it routes to', () => {
  // The GPT-5.6 Sol page states that `gpt-5.6` routes to Sol, so a persona
  // naming the family gets the family's range rather than nothing.
  assert.deepEqual(documentedEffortLevels('openai', 'gpt-5.6'), [
    'off',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ])
})

test('every id this table answers for is an id it also publishes', () => {
  // The editor matches the capability list by exact id. Anything the lookup
  // recognises but the list omits is a range that never reaches a persona, so
  // the two have to agree rather than being related by a normalisation rule
  // one of them applies and the other does not.
  const published = new Set(
    documentedEffortCapabilities().map((entry) => `${entry.provider}\u0000${entry.model}`),
  )
  for (const provider of ['claude', 'openai']) {
    for (const model of ['opus', 'sonnet', 'gpt-5.6', 'gpt-5.6-sol', 'claude-opus-4-6']) {
      const levels = documentedEffortLevels(provider, model)
      if (levels.length === 0) continue
      assert.ok(
        published.has(`${provider}\u0000${model}`),
        `${provider}/${model} is answered for but never published`,
      )
    }
  }
})

test('a dated id nobody has verified is not assumed to be a real model', () => {
  assert.deepEqual(documentedEffortLevels('openai', 'gpt-5.6-sol-20260101'), [])
})
