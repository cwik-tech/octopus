import test from 'node:test'
import assert from 'node:assert/strict'

import { fitContext, type ContextItem } from '../../core/context-fit.js'
import { estimateContextTokens } from '../../core/context-tokens.js'

const item = (
  id: string,
  itemClass: ContextItem['itemClass'],
  bytes: number,
  rank?: number,
): ContextItem => ({
  id,
  itemClass,
  text: 'x'.repeat(bytes),
  ...(rank === undefined ? {} : { rank }),
})

test('a turn that fits is sent whole, in the order it was given', () => {
  const items = [
    item('persona', 'pinned', 400),
    item('h1', 'history', 400),
    item('f1', 'reference', 400),
  ]
  const fitted = fitContext({ items, windowTokens: 1_000_000 })

  assert.equal(fitted.refused, false)
  assert.deepEqual(fitted.cuts, [])
  assert.deepEqual(fitted.kept.map((k) => k.id), ['persona', 'h1', 'f1'])
})

test('a large window really does carry more than a small one', () => {
  // The whole point. The same session against a 1M-token model and a 32k model
  // must not produce the same prompt, which is what every fixed character cap
  // in the system does today.
  const items = Array.from({ length: 200 }, (_, index) =>
    item(`h${index}`, 'history', 2_000, index))

  const large = fitContext({ items, windowTokens: 1_000_000 })
  const small = fitContext({ items, windowTokens: 32_000 })

  assert.ok(
    large.kept.length > small.kept.length,
    `large kept ${large.kept.length}, small kept ${small.kept.length}`,
  )
})

test('pinned content is never cut, and if it alone overflows the turn is refused', () => {
  // Refusing is the honest answer when the persona and the question together
  // exceed the window: there is no prompt to send, and trimming the question
  // would answer something the user did not ask.
  const huge = item('persona', 'pinned', 400_000)
  const fitted = fitContext({ items: [huge], windowTokens: 8_000 })

  assert.equal(fitted.refused, true)
  assert.deepEqual(fitted.kept.map((k) => k.id), ['persona'])
  assert.ok(fitted.refusalReason && fitted.refusalReason.includes('pinned'))
})

test('when a class overflows, its oldest items go first and each cut is recorded', () => {
  const items = [
    item('persona', 'pinned', 200),
    item('oldest', 'history', 60_000, 0),
    item('middle', 'history', 60_000, 1),
    item('newest', 'history', 60_000, 2),
  ]
  const fitted = fitContext({ items, windowTokens: 32_000 })

  const keptHistory = fitted.kept.filter((k) => k.itemClass === 'history').map((k) => k.id)
  assert.ok(!keptHistory.includes('oldest'), 'the oldest history should go first')
  assert.ok(keptHistory.includes('newest'), 'the newest history should survive')
  assert.ok(fitted.cuts.length > 0, 'every cut must be recorded')
  for (const cut of fitted.cuts) {
    assert.ok(cut.droppedTokens > 0, `${cut.id} recorded a cut of no size`)
    assert.ok(cut.reason.length > 0)
  }
})

test('room a class does not use is offered to the others', () => {
  // Shares are ceilings, not allocations. A turn with no attached files must be
  // able to spend that room on its transcript rather than leave it empty.
  //
  // Asserted with a strict > rather than >=. The >= form passes on equality,
  // which is exactly what a hard per-class cap produces, so it would have
  // certified the bug it was written to catch.
  // Sized so history genuinely wants more than the budget holds. If it fits
  // whole in both cases the comparison proves nothing, which is the other way
  // this test can be vacuous.
  const history = Array.from({ length: 400 }, (_, index) =>
    item(`h${index}`, 'history', 4_000, index))
  const withReference = [...history, item('f1', 'reference', 400_000, 0)]

  const shared = fitContext({ items: withReference, windowTokens: 1_000_000 })
  const alone = fitContext({ items: history, windowTokens: 1_000_000 })

  const keptWhenShared = shared.kept.filter((k) => k.itemClass === 'history').length
  const keptWhenAlone = alone.kept.filter((k) => k.itemClass === 'history').length
  assert.ok(
    keptWhenAlone > keptWhenShared,
    `history kept ${keptWhenAlone} alone and ${keptWhenShared} when sharing; ` +
      'unused room is not being offered to it',
  )
})

test('a big window spends a real share of itself, not a fixed slice of one class', () => {
  // The failure this guards: each class capped at its own share forever, so a
  // 1M-token window spent 87k tokens on a transcript that wanted all of it —
  // possibly less than the forty-message window this replaced.
  const history = Array.from({ length: 400 }, (_, index) =>
    item(`h${index}`, 'history', 4_000, index))
  const fitted = fitContext({ items: history, windowTokens: 1_000_000 })

  assert.ok(
    fitted.estimatedInputTokens > fitted.admissibleTokens * 0.4,
    `spent ${fitted.estimatedInputTokens} of ${fitted.admissibleTokens} admissible`,
  )
})

test('an item too small to be worth an excerpt is dropped whole, not shredded', () => {
  // The context compressor cut every message to 500 characters and then
  // summarized the wreckage. A fragment the model reads as complete is worse
  // than an honest absence.
  const items = [
    item('persona', 'pinned', 100),
    item('big', 'history', 400_000, 0),
  ]
  const fitted = fitContext({ items, windowTokens: 8_000 })

  for (const kept of fitted.kept) {
    if (kept.itemClass === 'pinned') continue
    assert.ok(
      estimateContextTokens(kept.text) >= 64,
      `${kept.id} survived as a fragment of ${estimateContextTokens(kept.text)} tokens`,
    )
  }
})

test('the answer always keeps room to be written', () => {
  const items = [item('h1', 'history', 400_000, 0)]
  const fitted = fitContext({ items, windowTokens: 100_000 })
  assert.ok(fitted.outputReserveTokens > 0)
  assert.ok(fitted.estimatedInputTokens + fitted.outputReserveTokens <= 100_000)
})

test('a stated output ceiling caps the reserve', () => {
  // A 15% reserve on a large window is room no reply will use, and sending it
  // as max_tokens above what a route accepts is a 400, not a trim.
  const items = [item('h1', 'history', 100)]
  const capped = fitContext({ items, windowTokens: 1_000_000, maxOutputTokens: 8_000 })
  assert.equal(capped.outputReserveTokens, 8_000)
})

test('the receipt adds up: what was kept plus what was cut is what was offered', () => {
  const items = [
    item('persona', 'pinned', 200),
    item('h1', 'history', 60_000, 0),
    item('h2', 'history', 60_000, 1),
    item('f1', 'reference', 60_000, 0),
  ]
  const fitted = fitContext({ items, windowTokens: 32_000 })

  const offered = items.reduce((sum, i) => sum + estimateContextTokens(i.text), 0)
  const kept = fitted.kept.reduce((sum, k) => sum + estimateContextTokens(k.text), 0)
  const cut = fitted.cuts.reduce((sum, c) => sum + c.droppedTokens, 0)
  assert.equal(kept + cut, offered)
})

test('a class that must be cut still spends the budget it was given', () => {
  // The regression this guards is the one that mattered: a standing 50% haircut
  // applied on top of an allowance that was already correct. On a 32k window a
  // 120-message conversation rendered 22 messages and left half the admissible
  // budget unspent — fewer messages than the forty-message window it replaced.
  // Cutting deeper than necessary is not hysteresis; it is waste.
  const history = Array.from({ length: 120 }, (_, index) =>
    item(`h${index}`, 'history', 1_000, index))
  const fitted = fitContext({ items: history, windowTokens: 32_000 })

  assert.ok(
    fitted.estimatedInputTokens > fitted.admissibleTokens * 0.8,
    `spent ${fitted.estimatedInputTokens} of ${fitted.admissibleTokens} admissible`,
  )
})

test('a small window still carries more than the forty-message window it replaced', () => {
  // The floor this work must clear. If the budget carries less than the fixed
  // slice it removed, the change is a regression however principled it is.
  const history = Array.from({ length: 120 }, (_, index) =>
    item(`h${index}`, 'history', 1_000, index))
  const fitted = fitContext({ items: history, windowTokens: 32_000 })
  const kept = fitted.kept.filter((k) => k.itemClass === 'history').length

  assert.ok(kept >= 40, `kept ${kept} messages; the old slice(-40) kept 40`)
})

test('the budget is a ceiling on the whole turn, not on each class separately', () => {
  // The shares sum to 1.15 deliberately, so that room one class leaves can be
  // offered to another. Pass one capped each class at its own share but never
  // at what the budget had left, so with enough classes contending the fitter
  // spent 15% more than it admitted — quietly turning the declared 0.5 fill
  // fraction into 0.575.
  //
  // No previous test used more than two budgeted classes, which is exactly why
  // this shipped.
  const items = [
    ...Array.from({ length: 6 }, (_, i) => item(`c${i}`, 'carry', 28_000, i)),
    ...Array.from({ length: 6 }, (_, i) => item(`r${i}`, 'reference', 28_000, i)),
    ...Array.from({ length: 6 }, (_, i) => item(`h${i}`, 'history', 28_000, i)),
    ...Array.from({ length: 6 }, (_, i) => item(`t${i}`, 'toolResult', 28_000, i)),
  ]
  const fitted = fitContext({ items, windowTokens: 32_000 })

  assert.ok(
    fitted.estimatedInputTokens <= fitted.admissibleTokens,
    `spent ${fitted.estimatedInputTokens} of ${fitted.admissibleTokens} admissible`,
  )
  // And the receipt still adds up.
  const kept = fitted.kept.reduce((sum, k) => sum + estimateContextTokens(k.text), 0)
  assert.equal(kept, fitted.estimatedInputTokens)
})

test('the answer reserve is capped, so a huge window does not hoard it', () => {
  // 15% of a million-token window is 150,000 tokens of reserve no reply will
  // use. The clamp returns that room to the input, and nothing asserted it.
  const fitted = fitContext({ items: [item('h', 'history', 1_000, 0)], windowTokens: 1_000_000 })
  assert.equal(fitted.outputReserveTokens, 32_000)
})
