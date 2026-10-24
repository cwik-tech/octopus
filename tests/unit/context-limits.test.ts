import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CONTEXT_LIMITS,
  contextLimit,
  contextLimitNames,
  type ContextLimitName,
} from '../../core/context-limits.js'
import { estimateContextTokens } from '../../core/context-tokens.js'

test('the registry is a handful, not a catalogue', () => {
  // The point of the registry is that a person can hold it in their head. If it
  // grows past this, something that is not a context policy has been filed here
  // — most likely an I/O safety ceiling, which must never scale with a window.
  assert.ok(
    contextLimitNames().length <= 15,
    `expected at most 15 context limits, found ${contextLimitNames().length}`,
  )
})

test('every limit records why it holds that value and what would change it', () => {
  // A number with no reason is how the previous 248 happened. The reason is the
  // part that makes the next person able to change it correctly, so it is
  // required by the type and asserted here rather than left to review.
  for (const name of contextLimitNames()) {
    const definition = CONTEXT_LIMITS[name]
    assert.ok(definition.reason.length > 40, `${name} needs a real reason`)
    assert.ok(definition.changeWhen.length > 20, `${name} needs a change condition`)
    assert.ok(Number.isFinite(definition.value), `${name} must have a numeric value`)
  }
})

test('fractions are fractions and counts are whole', () => {
  for (const name of contextLimitNames()) {
    const definition = CONTEXT_LIMITS[name]
    if (definition.kind === 'fraction') {
      assert.ok(
        definition.value > 0 && definition.value <= 1,
        `${name} is a fraction but its value is ${definition.value}`,
      )
    }
    if (definition.kind === 'count' || definition.kind === 'tokens' || definition.kind === 'bytes') {
      assert.ok(
        Number.isInteger(definition.value) && definition.value > 0,
        `${name} is a ${definition.kind} but its value is ${definition.value}`,
      )
    }
  }
})

test('the shares cannot promise more of the budget than exists', () => {
  // Shares are ceilings rather than allocations, so they may overlap — but if
  // even the ceilings sum below 1 the budget can never be spent, and if they
  // sum far above it the word "share" stops meaning anything.
  const shares = contextLimitNames().filter((name) => name.startsWith('share.'))
  const total = shares.reduce((sum, name) => sum + contextLimit(name), 0)
  assert.ok(total >= 1, `shares sum to ${total}, so the budget can never be filled`)
  assert.ok(total <= 2, `shares sum to ${total}, which is not a meaningful ceiling`)
})

test('reading a known limit gives its value', () => {
  // The "unknown name is a compile error" half of the contract is enforced by
  // the ContextLimitName type and checked by `tsc`, not by this assertion. The
  // test used to claim it asserted that; it never could.
  const name: ContextLimitName = 'estimator.bytesPerToken'
  assert.equal(contextLimit(name), CONTEXT_LIMITS[name].value)
})

test('the estimator is conservative: it never under-counts English prose', () => {
  // Admission must not be the optimistic party. A real tokenizer averages about
  // four bytes per token on English; estimating at 3.5 means the estimate runs
  // high, which refuses a request that would have just fit rather than
  // readmitting the overflow the boundary exists to prevent.
  const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(40)
  const realistic = Math.ceil(Buffer.byteLength(prose, 'utf8') / 4)
  assert.ok(
    estimateContextTokens(prose) >= realistic,
    'the estimate must not fall below a four-bytes-per-token reading',
  )
})

test('the estimator counts bytes, so non-ASCII is not under-counted', () => {
  // The compressor's own estimator divides `text.length`, which counts UTF-16
  // code units and so reads a CJK string as far smaller than it is on the wire.
  // Measuring bytes is what keeps the estimate honest across scripts.
  const ascii = 'a'.repeat(300)
  const cjk = '匹'.repeat(300)
  assert.ok(
    estimateContextTokens(cjk) > estimateContextTokens(ascii),
    'a 300-character CJK string costs more than 300 ASCII characters',
  )
})

test('an empty string costs nothing', () => {
  assert.equal(estimateContextTokens(''), 0)
})
