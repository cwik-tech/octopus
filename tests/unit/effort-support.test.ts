/**
 * Which effort level a provider/model pair accepts, and what happens when it
 * does not accept the one that was chosen.
 *
 * The rule this file exists to hold: a level is sent, or the turn is refused.
 * It is never exchanged for a different level. `off` in particular is a state
 * and not the bottom of a scale — the Pi runtime we execute rounds an
 * unsupported `off` *upward* into enabled thinking
 * (`@earendil-works/pi-ai/dist/models.js` `clampThinkingLevel`), so the
 * application has to refuse that pair before it spawns anything rather than
 * let the runtime decide.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  offerableEffortLevels,
  resolveEffort,
  setRuntimeEffortSupport,
  clearRuntimeEffortSupport,
} from '../../domains/provider/effort-support.js'

function withPublished(
  entries: Parameters<typeof setRuntimeEffortSupport>[0],
  run: () => void,
): void {
  setRuntimeEffortSupport(entries)
  try {
    run()
  } finally {
    clearRuntimeEffortSupport()
  }
}

test('an explicit provider default sends nothing at all', () => {
  const decision = resolveEffort({
    provider: 'claude',
    model: 'opus',
    requested: 'provider-default',
  })
  assert.deepEqual(decision, { kind: 'omit', because: 'provider-default' })
})

test('a level the pair publishes is sent as chosen', () => {
  withPublished(
    [{ provider: 'codex', model: 'gpt-6-astra', levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }],
    () => {
      assert.deepEqual(
        resolveEffort({ provider: 'codex', model: 'gpt-6-astra', requested: 'ultra' }),
        { kind: 'send', level: 'ultra' },
      )
    },
  )
})

test('a level the pair does not publish refuses the turn and names what it accepts', () => {
  withPublished(
    [{ provider: 'codex', model: 'gpt-5.5', levels: ['low', 'medium', 'high', 'xhigh'] }],
    () => {
      const decision = resolveEffort({
        provider: 'codex',
        model: 'gpt-5.5',
        requested: 'ultra',
      })
      assert.equal(decision.kind, 'refuse')
      assert.match(decision.kind === 'refuse' ? decision.message : '', /ultra/u)
      assert.match(decision.kind === 'refuse' ? decision.message : '', /xhigh/u)
    },
  )
})

test('off against a model that cannot stop thinking is refused, never raised', () => {
  withPublished(
    [{ provider: 'pi', model: 'anthropic/claude-fable-5', levels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }],
    () => {
      const decision = resolveEffort({
        provider: 'pi',
        model: 'anthropic/claude-fable-5',
        requested: 'off',
      })
      assert.equal(decision.kind, 'refuse')
      // The failure this guards against is a silent upgrade, so the message has
      // to be about `off` rather than about some level we chose instead.
      assert.match(decision.kind === 'refuse' ? decision.message : '', /off/u)
    },
  )
})

test('a provider whose adapter cannot carry the setting still runs the levels it always ran', () => {
  for (const requested of ['low', 'medium', 'high'] as const) {
    assert.deepEqual(
      resolveEffort({ provider: 'gemini', model: 'pro', requested }),
      { kind: 'omit', because: 'not-carried' },
    )
  }
})

test('a provider whose adapter cannot carry the setting refuses a level it never could have run', () => {
  const decision = resolveEffort({ provider: 'gemini', model: 'pro', requested: 'xhigh' })
  assert.equal(decision.kind, 'refuse')
})

test('with nothing published, the three levels agent files already use still run', () => {
  for (const provider of ['claude', 'codex', 'pi', 'anthropic', 'openai', 'kimi-cli']) {
    for (const requested of ['low', 'medium', 'high'] as const) {
      assert.deepEqual(
        resolveEffort({ provider, model: 'default', requested }),
        { kind: 'send', level: requested },
        `${provider} at ${requested}`,
      )
    }
  }
})

test('with nothing published, a level the binary can express is still sent', () => {
  // Refusing here would be the wrong kind of caution. `codex debug models` is
  // what publishes a per-model range, and a process that never built the
  // catalogue has learned nothing about the model — while the CLI grammar is
  // known either way. If the model does refuse the level, Codex says so, which
  // is a visible error rather than the silent substitution this module exists
  // to prevent.
  assert.deepEqual(
    resolveEffort({ provider: 'codex', model: 'default', requested: 'xhigh' }),
    { kind: 'send', level: 'xhigh' },
  )
})

test('with nothing published, a level the binary cannot express is refused', () => {
  // `codex debug models` has never published `off` or `minimal`, and the flag
  // is a free-form configuration value, so sending one would reach the vendor
  // as a malformed request rather than as a choice.
  for (const requested of ['off', 'minimal'] as const) {
    assert.equal(
      resolveEffort({ provider: 'codex', model: 'default', requested }).kind,
      'refuse',
    )
  }
  assert.equal(
    resolveEffort({ provider: 'pi', model: 'default', requested: 'ultra' }).kind,
    'refuse',
  )
})

test("Claude Code's own range is expressible without anything published", () => {
  for (const requested of ['xhigh', 'max'] as const) {
    assert.deepEqual(
      resolveEffort({ provider: 'claude', model: 'opus', requested }),
      { kind: 'send', level: requested },
    )
  }
})

test('the Anthropic adapter keeps its own narrower range while its migration is pending', () => {
  assert.deepEqual(
    resolveEffort({ provider: 'anthropic', model: 'claude-opus-5', requested: 'off' }),
    { kind: 'send', level: 'off' },
  )
  const decision = resolveEffort({
    provider: 'anthropic',
    model: 'claude-opus-5',
    requested: 'xhigh',
  })
  assert.equal(decision.kind, 'refuse')
})

test('a menu offers what the vendor documents when the provider publishes nothing', () => {
  // Claude Code prints no per-model list and the OpenAI API describes none over
  // the wire, so these two pairs had a documented range and an empty menu.
  clearRuntimeEffortSupport()
  assert.deepEqual(offerableEffortLevels({ provider: 'claude', model: 'opus' }), [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ])
  assert.deepEqual(
    offerableEffortLevels({ provider: 'openai', model: 'gpt-5.6-sol' }),
    ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  )
})

test('a published range still wins over the documented one', () => {
  // What a provider says about itself now beats what its documentation said
  // when this table was written.
  setRuntimeEffortSupport([
    { provider: 'claude', model: 'opus', levels: ['low', 'high'] },
  ])
  try {
    assert.deepEqual(offerableEffortLevels({ provider: 'claude', model: 'opus' }), [
      'low',
      'high',
    ])
  } finally {
    clearRuntimeEffortSupport()
  }
})

test('a pair nobody documents or publishes still offers no levels', () => {
  clearRuntimeEffortSupport()
  assert.deepEqual(offerableEffortLevels({ provider: 'claude', model: 'haiku' }), [])
  assert.deepEqual(offerableEffortLevels({ provider: 'openai', model: 'gpt-made-up' }), [])
})

test('what dispatch accepts stays wider than what a menu offers', () => {
  // An Agent file written before any of this names `high` on models the vendor
  // never listed, and those turns keep running. The menu simply does not invite
  // a new choice there.
  clearRuntimeEffortSupport()
  assert.deepEqual(
    resolveEffort({ provider: 'claude', model: 'haiku', requested: 'high' }),
    { kind: 'send', level: 'high' },
  )
})
